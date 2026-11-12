import { DurableObject } from "cloudflare:workers";
import {
  buildCandidateLogsSubscribe, buildHeliusWebSocketUrl, fetchAndVerifyPumpTransaction,
  parseHeliusLogsNotification, type VerifiedPumpTransaction
} from "../../../../src/ingestion/helius.js";
import {
  emptyHeliusMonitorState, enqueueHeliusNotification, normalizeHeliusMonitorState,
  reconcileHeliusSubscriptions, confirmHeliusSubscription, takeHeliusWork, resetHeliusSubscriptionIds,
  type HeliusMonitorState,
  type HeliusSignatureWork,
  type CandidateMonitoringEvidence
} from "../../../../src/ingestion/helius-monitor.js";
import { TokenBucket } from "../../../../src/ingestion/rpc-budget.js";
import { buildCandidateTradeFlows } from "../../../../src/ingestion/trade-flow.js";
import { fetchHolderConcentration } from "../../../../src/ingestion/holder-risk.js";
import { buildCandidatePriceVolumeProfiles } from "../../../../src/ingestion/price-volume-profile.js";
import { evaluateCreatorSellRisk } from "../../../../src/ingestion/creator-risk.js";
import { evaluateWalletClusterRisk, type WalletHoldingEvidence, type WalletLinkEvidence } from "../../../../src/ingestion/wallet-cluster-risk.js";
import { collectWalletFundingEvidence, type WalletFundingEvidenceResult } from "../../../../src/ingestion/wallet-link-collector.js";
import {
  applyDiscoveryEvent,
  emptyDiscoveryStore,
  pruneExpiredCandidates,
  type DiscoveryStoreState
} from "../../../../src/ingestion/discovery-store.js";
import {
  buildPumpPortalDiscoveryUrl,
  parsePumpPortalDiscoveryMessage,
  pumpPortalDiscoverySubscriptions
} from "../../../../src/ingestion/pumpportal.js";

interface Env {
  COORDINATOR: DurableObjectNamespace<PumpFunCoordinator>;
  CONTROL_TOKEN: string;
  HELIUS_API_KEY: string;
}

interface CoordinatorStatus {
  mode: "paper";
  provider: "pumpportal";
  connected: boolean;
  subscriptionsSent: boolean;
  enabled: boolean;
  tradingReady: false;
  blocker: string;
  connectedAt: string | null;
  lastMessageAt: string | null;
  lastSignature: string | null;
  notificationsSinceStart: number;
  candidates: number;
  acceptedCandidates: number;
  duplicateEvents: number;
  migrations: number;
  overflowEvents: number;
  incompleteEvents: number;
  expiredCandidates: number;
  reconnectAttempts: number;
  nextReconnectAt: string | null;
  lastPersistedAt: string | null;
  lastError: string | null;
  heliusConnected: boolean;
  monitoredCandidates: number;
  queuedHeliusSignatures: number;
  verifiedTransactions: number;
  incompleteHeliusTransactions: number;
  failedHeliusTransactions: number;
  droppedHeliusSignatures: number;
  duplicateHeliusSignatures: number;
  incompleteHeliusCandidates: number;
}

const INITIAL_STATUS: CoordinatorStatus = {
  mode: "paper",
  provider: "pumpportal",
  connected: false,
  subscriptionsSent: false,
  enabled: false,
  tradingReady: false,
  blocker: "On-chain verification, selective Helius monitoring, strategy evaluation, executable quotes and paper ledger are not connected.",
  connectedAt: null,
  lastMessageAt: null,
  lastSignature: null,
  notificationsSinceStart: 0,
  candidates: 0,
  acceptedCandidates: 0,
  duplicateEvents: 0,
  migrations: 0,
  overflowEvents: 0,
  incompleteEvents: 0,
  expiredCandidates: 0,
  reconnectAttempts: 0,
  nextReconnectAt: null,
  lastPersistedAt: null,
  lastError: null,
  heliusConnected: false,
  monitoredCandidates: 0,
  queuedHeliusSignatures: 0,
  verifiedTransactions: 0,
  incompleteHeliusTransactions: 0,
  failedHeliusTransactions: 0,
  droppedHeliusSignatures: 0,
  duplicateHeliusSignatures: 0,
  incompleteHeliusCandidates: 0
};

const MAX_CANDIDATES = 100;
const PERSIST_EVERY_EVENTS = 25;

export class PumpFunCoordinator extends DurableObject<Env> {
  private socket: WebSocket | null = null;
  private heliusSocket: WebSocket | null = null;
  private heliusConnectedAtMs = 0;
  private heliusConnectingSinceMs = 0;
  private heliusState: HeliusMonitorState = emptyHeliusMonitorState();
  private heliusBucket = new TokenBucket(2, 2);
  private drainingHelius = false;
  private verifiedTransactions: VerifiedPumpTransaction[] = [];
  private walletLinkSnapshots: Record<string, WalletFundingEvidenceResult> = {};
  private walletHoldingsByMint: Record<string, WalletHoldingEvidence[]> = {};
  private status: CoordinatorStatus = { ...INITIAL_STATUS };
  private discovery: DiscoveryStoreState = emptyDiscoveryStore();
  private hydrated = false;
  private pendingWrites = 0;
  private persistChain: Promise<void> = Promise.resolve();
  private connectingSinceMs = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.env = env;
  }
  private readonly env: Env;

  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    const [savedStatus, savedDiscovery, enabled, savedWalletLinks, savedWalletHoldings] = await Promise.all([
      this.ctx.storage.get<CoordinatorStatus>("status"),
      this.ctx.storage.get<DiscoveryStoreState>("discovery_state"),
      this.ctx.storage.get<boolean>("enabled"),
      this.ctx.storage.get<Record<string, WalletFundingEvidenceResult>>("wallet_link_snapshots"),
      this.ctx.storage.get<Record<string, WalletHoldingEvidence[]>>("wallet_holdings_by_mint")
    ]);
    if (savedStatus) this.status = { ...INITIAL_STATUS, ...savedStatus };
    this.walletLinkSnapshots = savedWalletLinks ?? {};
    this.walletHoldingsByMint = savedWalletHoldings ?? {};
    this.heliusState = normalizeHeliusMonitorState(await this.ctx.storage.get<HeliusMonitorState>("helius_monitor_state"));
    this.verifiedTransactions = (await this.ctx.storage.get<VerifiedPumpTransaction[]>("verified_transactions")) ?? [];
    // A Durable Object restart destroys outbound WebSockets. Without historical
    // backfill, the interrupted interval must be represented as a data gap.
    this.markHeliusCoverageGap();
    this.heliusState = resetHeliusSubscriptionIds(this.heliusState);
    if (savedDiscovery) this.discovery = { ...emptyDiscoveryStore(), ...savedDiscovery, expired: savedDiscovery.expired ?? 0 };
    this.status.enabled = enabled === true;
    // Outbound sockets cannot survive a Durable Object restart.
    this.status.connected = false;
    this.status.subscriptionsSent = false;
    this.status.heliusConnected = false;
    this.syncCounts();
    this.hydrated = true;
  }

  async start(): Promise<CoordinatorStatus> {
    await this.hydrate();
    if (!this.status.enabled || this.heliusSocket?.readyState !== WebSocket.OPEN) {
      this.markHeliusCoverageGap();
    }
    await this.ctx.storage.put("enabled", true);
    this.status.enabled = true;
    this.status.nextReconnectAt = null;
    this.status.reconnectAttempts = 0;
    this.connect();
    this.connectHelius();
    await this.persist();
    return this.getStatus();
  }

  async stop(): Promise<CoordinatorStatus> {
    await this.hydrate();
    this.markHeliusCoverageGap();
    await this.ctx.storage.put("enabled", false);
    this.status.enabled = false;
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.close(1000, "Paper discovery stopped");
    }
    this.status.connected = false;
    this.status.subscriptionsSent = false;
    if (this.heliusSocket) {
      const helius = this.heliusSocket;
      this.heliusSocket = null;
      helius.close(1000, "Paper monitoring stopped");
    }
    this.status.heliusConnected = false;
    this.status.nextReconnectAt = null;
    await this.persist();
    return this.getStatus();
  }

  async ensureRunning(): Promise<CoordinatorStatus> {
    await this.hydrate();
    if (!this.status.enabled) {
      if (this.socket) {
        const socket = this.socket;
        this.socket = null;
        socket.close(1000, "Paper discovery disabled");
      }
      this.status.connected = false;
      this.status.subscriptionsSent = false;
      if (this.heliusSocket) {
        const helius = this.heliusSocket;
        this.heliusSocket = null;
        helius.close(1000, "Coordinator disabled");
      }
      this.status.heliusConnected = false;
      await this.persist();
      return this.getStatus();
    }

    // Expire stale candidates even if the provider is quiet, then flush state.
    const beforeExpiry = this.discovery.candidates.length;
    this.discovery = pruneExpiredCandidates(this.discovery, new Date().toISOString());
    if (this.discovery.candidates.length !== beforeExpiry) {
      this.reconcileHelius();
      this.pendingWrites += 1;
    }
    await this.persist();

    if (this.heliusSocket?.readyState === WebSocket.OPEN &&
        this.heliusConnectedAtMs > 0 && Date.now() - this.heliusConnectedAtMs >= 14 * 60 * 1000) {
      const oldHeliusSocket = this.heliusSocket;
      this.markHeliusCoverageGap();
      this.heliusSocket = null;
      this.status.heliusConnected = false;
      oldHeliusSocket.close(4001, "Scheduled Helius connection rotation");
    }
    if (this.heliusSocket?.readyState === WebSocket.CONNECTING &&
        this.heliusConnectingSinceMs > 0 && Date.now() - this.heliusConnectingSinceMs >= 30_000) {
      const oldHeliusSocket = this.heliusSocket;
      this.markHeliusCoverageGap();
      this.heliusSocket = null;
      oldHeliusSocket.close(4000, "Helius connection attempt timed out");
    }
    if (!this.heliusSocket && this.status.enabled) this.connectHelius();
    if (this.socket?.readyState === WebSocket.OPEN) {
      const connectedAtMs = this.status.connectedAt ? Date.parse(this.status.connectedAt) : 0;
      if (connectedAtMs > 0 && Date.now() - connectedAtMs < 14 * 60 * 1000) {
        return this.getStatus();
      }
      const oldSocket = this.socket;
      this.socket = null;
      this.status.connected = false;
      this.status.subscriptionsSent = false;
      oldSocket.close(4001, "Scheduled connection rotation");
    }

    if (this.socket?.readyState === WebSocket.CONNECTING &&
        Date.now() - this.connectingSinceMs < 30_000) {
      return this.getStatus();
    }
    if (this.socket?.readyState === WebSocket.CONNECTING) {
      const oldSocket = this.socket;
      this.socket = null;
      oldSocket.close(4000, "Connection attempt timed out");
      this.scheduleReconnect();
    }

    const nextReconnectAt = this.status.nextReconnectAt ? Date.parse(this.status.nextReconnectAt) : 0;
    if (nextReconnectAt > Date.now()) return this.getStatus();

    this.connect();
    await this.persist();
    return this.getStatus();
  }

  async getStatus(): Promise<CoordinatorStatus> {
    await this.hydrate();
    this.syncCounts();
    this.status.monitoredCandidates = this.heliusState.subscriptions.length;
    this.status.queuedHeliusSignatures = this.heliusState.queue.length;
    return { ...this.status };
  }

  async listVerifiedTransactions(limit = 100): Promise<unknown[]> {
    await this.hydrate();
    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
    return this.verifiedTransactions.slice(-boundedLimit).map(value => jsonSafe(value));
  }

  private rateLimitedHeliusFetcher(): typeof fetch {
    return async (input, init) => {
      while (!this.heliusBucket.tryTake()) {
        await new Promise(resolve => setTimeout(resolve, this.heliusBucket.retryAfterMs));
      }
      return fetch(input, init);
    };
  }

  async getHolderRisk(mint: string): Promise<unknown> {
    await this.hydrate();
    const result = await fetchHolderConcentration(mint, {
      apiKey: this.env.HELIUS_API_KEY,
      fetcher: this.rateLimitedHeliusFetcher()
    });
    if (result.status === "OBSERVED") {
      this.walletHoldingsByMint[mint] = result.snapshot.accounts.map(account => ({
        mint, wallet: account.owner, amount: account.amount
      }));
      this.reconcileHelius();
      await this.persist();
    }
    return result;
  }

  async collectWalletLinks(mint: string): Promise<unknown> {
    await this.hydrate();
    const launch = this.verifiedTransactions.flatMap(tx => tx.createEvents).find(event => event.mint === mint);
    const volumes = new Map<string, bigint>();
    for (const transaction of this.verifiedTransactions) for (const trade of transaction.tradeEvents) {
      if (trade.mint !== mint || trade.quoteAmount <= 0n) continue;
      volumes.set(trade.user, (volumes.get(trade.user) ?? 0n) + trade.quoteAmount);
    }
    const rankedWallets = [...volumes.entries()].sort((a, b) =>
      a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1
    ).map(([wallet]) => wallet);
    const wallets = [...new Set([...(launch?.creator ? [launch.creator] : []), ...rankedWallets])].slice(0, 8);
    const result = await collectWalletFundingEvidence(mint, wallets, {
      apiKey: this.env.HELIUS_API_KEY,
      fetcher: this.rateLimitedHeliusFetcher()
    });
    this.walletLinkSnapshots[mint] = result;
    this.reconcileHelius();
    await this.persist();
    const risk = evaluateWalletClusterRisk(this.verifiedTransactions, {
      mint,
      creator: launch?.creator ?? null,
      totalSupply: launch?.tokenTotalSupply.toString() ?? null,
      links: result.links,
      holdings: this.walletHoldingsByMint[mint] ?? []
    });
    return { ...result, risk };
  }

  async listTradeFlows(): Promise<unknown> {
    await this.hydrate();
    const retentionMayBeTruncated = this.verifiedTransactions.length >= 2_000;
    const confirmedSubscriptions = this.heliusState.subscriptions.filter(
      item => item.subscriptionId !== null && item.subscribedAt !== null
    );
    const confirmedMints = new Set(confirmedSubscriptions.map(item => item.mint));
    const unmonitoredMints = this.discovery.candidates
      .filter(candidate => candidate.status === "DISCOVERED" && !confirmedMints.has(candidate.mint))
      .map(candidate => candidate.mint);
    const retainedTradeTimestamps = this.verifiedTransactions.flatMap(transaction =>
      transaction.tradeEvents.map(event => Number(event.timestamp))
    ).filter(value => Number.isSafeInteger(value) && value >= 0);
    const retainedTradeStart = retainedTradeTimestamps.length > 0
      ? Math.min(...retainedTradeTimestamps)
      : null;
    const retentionCoverageUnknown = retentionMayBeTruncated && retainedTradeStart === null;
    const incompleteMints = [...new Set([
      ...this.heliusState.incompleteMints,
      ...unmonitoredMints,
      ...(retentionCoverageUnknown ? this.discovery.candidates.map(candidate => candidate.mint) : [])
    ])];
    const retentionWindowStart = retainedTradeStart === null
      ? null
      : Math.ceil(retainedTradeStart / 2) * 2;
    const coverageStartByMint = Object.fromEntries(confirmedSubscriptions.flatMap(item => {
      const parsed = item.subscribedAt ? Date.parse(item.subscribedAt) : Number.NaN;
      if (!Number.isFinite(parsed)) return [];
      const subscriptionWindowStart = Math.ceil((parsed / 1_000) / 2) * 2;
      const start = retentionMayBeTruncated && retentionWindowStart !== null
        ? Math.max(subscriptionWindowStart, retentionWindowStart)
        : subscriptionWindowStart;
      return [[item.mint, start]];
    }));
    const candidateMints = this.discovery.candidates
      .filter(candidate => candidate.status === "DISCOVERED")
      .map(candidate => candidate.mint);
    const flows = buildCandidateTradeFlows(this.verifiedTransactions, {
      incompleteMints,
      coverageStartByMint,
      candidateMints
    });
    const creatorSellRisk = evaluateCreatorSellRisk(this.verifiedTransactions, {
      nowSeconds: Math.floor(Date.now() / 1_000),
      candidateMints,
      incompleteMints,
      coverageStartByMint
    });
    const creatorRiskByMint = new Map(creatorSellRisk.map(item => [item.mint, item]));
    // Missing linkage collection remains WATCH; only the on-demand bounded
    // Helius funding snapshot can contribute explicit >=70% relationship edges.
    const launchByMint = new Map(this.verifiedTransactions.flatMap(tx => tx.createEvents)
      .map(event => [event.mint, event] as const));
    const walletClusterRisk = candidateMints.map(mint => {
      const launch = launchByMint.get(mint);
      const snapshot = this.walletLinkSnapshots[mint];
      return {
        ...evaluateWalletClusterRisk(this.verifiedTransactions, {
          mint,
          creator: launch?.creator ?? null,
          totalSupply: launch?.tokenTotalSupply.toString() ?? null,
          links: snapshot?.links ?? [],
          holdings: this.walletHoldingsByMint[mint] ?? []
        }),
        collection: snapshot ?? null
      };
    });
    const creatorRiskRank = (status: string): number =>
      status === "PASS_COMPLETE" ? 0 :
      status === "PENDING" ? 1 :
      status === "UNKNOWN" ? 2 : 3;
    const rankedFlows = [...flows].map(flow => ({
      ...flow,
      creatorSellStatus: creatorRiskByMint.get(flow.mint)?.status ?? "UNKNOWN"
    })).sort((a, b) =>
      creatorRiskRank(a.creatorSellStatus) - creatorRiskRank(b.creatorSellStatus) ||
      Number(b.dataComplete) - Number(a.dataComplete) ||
      Number(b.flowConfirmationPass) - Number(a.flowConfirmationPass) ||
      Number(b.latestThreeWindowFlowPass) - Number(a.latestThreeWindowFlowPass) ||
      b.distinctBuyersAcrossLatestThree - a.distinctBuyersAcrossLatestThree ||
      (a.largestBuyerShareAcrossLatestThreeBps ?? Number.MAX_SAFE_INTEGER) -
        (b.largestBuyerShareAcrossLatestThreeBps ?? Number.MAX_SAFE_INTEGER)
    );
    const priceVolumeProfiles = buildCandidatePriceVolumeProfiles(this.verifiedTransactions, {
      incompleteMints,
      coverageStartByMint,
      candidateMints: this.discovery.candidates
        .filter(candidate => candidate.status === "DISCOVERED")
        .map(candidate => candidate.mint)
    });
    return {
      provider: "helius",
      mode: "paper",
      generatedAt: new Date().toISOString(),
      retainedVerifiedTransactions: this.verifiedTransactions.length,
      retentionMayBeTruncated,
      knownIncompleteMints: incompleteMints,
      creatorSellRisk,
      walletClusterRisk,
      candidateCoverage: this.discovery.candidates.map(candidate => {
        const subscription = this.heliusState.subscriptions.find(item => item.mint === candidate.mint);
        return {
          mint: candidate.mint,
          status: candidate.status,
          creatorSellStatus: creatorRiskByMint.get(candidate.mint)?.status ?? "UNKNOWN",
          monitoring: subscription?.subscriptionId !== null && subscription?.subscriptionId !== undefined
            ? "SUBSCRIBED"
            : subscription ? "SUBSCRIPTION_PENDING" : "NOT_MONITORED"
        };
      }),
      flows: rankedFlows.map((flow, index) => ({ rank: index + 1, ...flow })),
      priceVolumeProfiles
    };
  }

  async listCandidates(): Promise<DiscoveryStoreState> {
    await this.hydrate();
    const beforeExpiry = this.discovery.candidates.length;
    this.discovery = pruneExpiredCandidates(this.discovery, new Date().toISOString());
    if (this.discovery.candidates.length !== beforeExpiry) {
      this.pendingWrites += 1;
      await this.persist();
    }
    return structuredClone(this.discovery);
  }

  private connect(): void {
    if (this.socket) return;
    try {
      const socket = new WebSocket(buildPumpPortalDiscoveryUrl());
      this.socket = socket;
      this.connectingSinceMs = Date.now();

      socket.addEventListener("open", () => {
        if (this.socket !== socket || !this.status.enabled) {
          socket.close(1000, "Coordinator disabled before connection opened");
          return;
        }
        this.status.connected = true;
        this.status.subscriptionsSent = false;
        this.status.connectedAt = new Date().toISOString();
        this.connectingSinceMs = 0;
        this.status.lastError = null;
        this.status.reconnectAttempts = 0;
        this.status.nextReconnectAt = null;
        try {
          for (const subscription of pumpPortalDiscoverySubscriptions()) {
            socket.send(JSON.stringify(subscription));
          }
          this.status.subscriptionsSent = true;
        } catch {
          this.status.lastError = "PumpPortal subscription send failed.";
          socket.close(1011, "Subscription send failed");
        }
      });

      socket.addEventListener("message", (message: MessageEvent) => {
        if (this.socket !== socket || !this.status.enabled) return;
        this.status.notificationsSinceStart += 1;
        this.status.lastMessageAt = new Date().toISOString();
        const parsed = parsePumpPortalDiscoveryMessage(
          typeof message.data === "string" ? message.data : null,
          this.status.lastMessageAt
        );
        if (parsed.status === "IGNORED") return;
        if (parsed.status === "DATA_INCOMPLETE") {
          this.discovery.incomplete += 1;
          this.pendingWrites += 1;
          this.syncCounts();
          if (this.pendingWrites >= PERSIST_EVERY_EVENTS) void this.persist().catch(() => undefined);
          return;
        }

        this.status.lastSignature = parsed.event.signature ?? this.status.lastSignature;
        const result = applyDiscoveryEvent(this.discovery, {
          kind: parsed.event.kind,
          mint: parsed.event.mint,
          signature: parsed.event.signature,
          creator: parsed.event.creator,
          bondingCurve: parsed.event.bondingCurve,
          name: parsed.event.name,
          symbol: parsed.event.symbol,
          receivedAt: parsed.event.receivedAt
        }, { cap: MAX_CANDIDATES, now: this.status.lastMessageAt });
        this.discovery = result.state;
        this.reconcileHelius();
        this.pendingWrites += 1;
        this.syncCounts();
        if (this.pendingWrites >= PERSIST_EVERY_EVENTS) void this.persist().catch(() => undefined);
      });

      socket.addEventListener("close", () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.status.connected = false;
        this.status.subscriptionsSent = false;
        this.status.connectedAt = null;
        this.connectingSinceMs = 0;
        if (this.status.enabled) this.scheduleReconnect();
        void this.persist().catch(() => undefined);
      });

      socket.addEventListener("error", () => {
        if (this.socket !== socket || !this.status.enabled) return;
        this.status.lastError = "PumpPortal WebSocket transport error.";
        void this.persist().catch(() => undefined);
      });
    } catch {
      this.socket = null;
      this.status.connected = false;
      this.status.subscriptionsSent = false;
      this.connectingSinceMs = 0;
      this.status.lastError = "Unable to create the PumpPortal WebSocket connection.";
      if (this.status.enabled) this.scheduleReconnect();
    }
  }

  private monitoringEvidenceByMint(): Record<string, CandidateMonitoringEvidence> {
    const candidateMints = this.discovery.candidates
      .filter(candidate => candidate.status === "DISCOVERED")
      .map(candidate => candidate.mint);
    const confirmed = this.heliusState.subscriptions.filter(item =>
      item.subscriptionId !== null && item.subscribedAt !== null
    );
    const coverageStartByMint = Object.fromEntries(confirmed.flatMap(item => {
      const timestamp = Date.parse(item.subscribedAt ?? "");
      return Number.isFinite(timestamp) ? [[item.mint, Math.ceil(timestamp / 2_000) * 2]] : [];
    }));
    const flows = buildCandidateTradeFlows(this.verifiedTransactions, {
      incompleteMints: this.heliusState.incompleteMints,
      coverageStartByMint,
      candidateMints
    });
    const creatorRisk = evaluateCreatorSellRisk(this.verifiedTransactions, {
      nowSeconds: Math.floor(Date.now() / 1_000),
      candidateMints,
      incompleteMints: this.heliusState.incompleteMints,
      coverageStartByMint
    });
    const launchByMint = new Map(this.verifiedTransactions.flatMap(tx => tx.createEvents)
      .map(event => [event.mint, event] as const));
    const flowByMint = new Map(flows.map(item => [item.mint, item]));
    const creatorByMint = new Map(creatorRisk.map(item => [item.mint, item]));
    return Object.fromEntries(candidateMints.map(mint => {
      const flow = flowByMint.get(mint);
      const creator = creatorByMint.get(mint);
      const launch = launchByMint.get(mint);
      const clusterRisk = evaluateWalletClusterRisk(this.verifiedTransactions, {
        mint,
        creator: launch?.creator ?? null,
        totalSupply: launch?.tokenTotalSupply.toString() ?? null,
        links: this.walletLinkSnapshots[mint]?.links ?? [],
        holdings: this.walletHoldingsByMint[mint] ?? []
      });
      const dataComplete = Boolean(flow?.dataComplete);
      const flowConfirmed = Boolean(flow?.flowConfirmationPass);
      const creatorClearanceComplete = creator?.status === "PASS_COMPLETE";
      const score =
        (creatorClearanceComplete ? 1_000 : 0) +
        (flowConfirmed ? 500 : 0) +
        (dataComplete ? 250 : 0) +
        (flow?.latestThreeWindowFlowPass ? 100 : 0) +
        Math.min(flow?.distinctBuyersAcrossLatestThree ?? 0, 20) * 2 -
        Math.floor((flow?.largestBuyerShareAcrossLatestThreeBps ?? 10_000) / 100);
      return [mint, {
        score,
        hardRejected: creator?.status === "REJECT_OBSERVED" || clusterRisk.status === "REJECT_OBSERVED",
        creatorClearanceComplete,
        flowConfirmed,
        dataComplete
      }];
    }));
  }

  private reconcileHelius(): void {
    const previous = this.heliusState.subscriptions;
    const evidenceByMint = this.monitoringEvidenceByMint();
    const next = reconcileHeliusSubscriptions(
      this.heliusState, this.discovery.candidates, new Date().toISOString(), evidenceByMint
    );
    const retainedMints = new Set(next.subscriptions.map(item => item.mint));
    const socket = this.heliusSocket;
    if (socket?.readyState === WebSocket.OPEN) {
      for (const removed of previous) {
        if (removed.subscriptionId !== null && !retainedMints.has(removed.mint)) {
          try {
            socket.send(JSON.stringify({
              jsonrpc: "2.0",
              id: next.nextRequestId++,
              method: "logsUnsubscribe",
              params: [removed.subscriptionId]
            }));
          } catch {
            this.status.lastError = "Helius unsubscribe failed; reconnect is required to clear stale subscriptions.";
            socket.close(1011, "Helius unsubscribe failed");
          }
        }
      }
    }
    this.heliusState = next;
    if (socket?.readyState === WebSocket.OPEN) this.sendHeliusSubscriptions();
  }

  private connectHelius(): void {
    if (this.heliusSocket || !this.status.enabled) return;
    try {
      const socket = new WebSocket(buildHeliusWebSocketUrl(this.env.HELIUS_API_KEY));
      this.heliusSocket = socket;
      this.heliusConnectingSinceMs = Date.now();
      socket.addEventListener("open", () => {
        if (this.heliusSocket !== socket || !this.status.enabled) {
          socket.close(1000, "Coordinator disabled before Helius connection opened");
          return;
        }
        this.status.heliusConnected = true;
        this.heliusConnectedAtMs = Date.now();
        this.heliusConnectingSinceMs = 0;
        this.heliusState = resetHeliusSubscriptionIds(this.heliusState);
        this.sendHeliusSubscriptions();
        void this.persist().then(() => this.drainHeliusQueue()).catch(() => undefined);
      });
      socket.addEventListener("message", (message: MessageEvent) => {
        if (this.heliusSocket !== socket || !this.status.enabled || typeof message.data !== "string") return;
        let payload: unknown;
        try { payload = JSON.parse(message.data); } catch { this.markHeliusIncomplete(); return; }
        if (!payload || typeof payload !== "object") return;
        const record = payload as Record<string, unknown>;
        if (Number.isSafeInteger(record.id) && Number.isSafeInteger(record.result)) {
          this.heliusState = confirmHeliusSubscription(this.heliusState, record.id as number, record.result as number);
          void this.persist().catch(() => undefined);
          return;
        }
        if (Number.isSafeInteger(record.id) && record.error) {
          const failed = this.heliusState.subscriptions.find(item => item.requestId === record.id);
          if (failed) {
            this.heliusState = {
              ...this.heliusState,
              incompleteMints: [...new Set([...this.heliusState.incompleteMints, failed.mint])].slice(-10)
            };
            this.status.incompleteHeliusTransactions += 1;
          }
          void this.persist().catch(() => undefined);
          return;
        }
        const notification = parseHeliusLogsNotification(payload);
        if (!notification) return;
        const params = record.params as Record<string, unknown> | undefined;
        const subscriptionId = params?.subscription;
        if (!Number.isSafeInteger(subscriptionId)) { this.markHeliusIncomplete(); return; }
        const result = enqueueHeliusNotification(this.heliusState, {
          subscriptionId: subscriptionId as number,
          signature: notification.signature,
          slot: notification.slot,
          err: notification.err
        });
        this.heliusState = result.state;
        if (result.outcome === "OVERFLOW" || result.outcome === "INVALID") this.status.incompleteHeliusTransactions += 1;
        if (result.outcome === "FAILED") this.status.failedHeliusTransactions += 1;
        void this.persist().then(() => this.drainHeliusQueue()).catch(() => this.markHeliusIncomplete());
      });
      socket.addEventListener("close", () => {
        if (this.heliusSocket !== socket) return;
        this.heliusSocket = null;
        this.status.heliusConnected = false;
        this.heliusConnectedAtMs = 0;
        this.heliusConnectingSinceMs = 0;
        if (this.status.enabled) this.markHeliusCoverageGap();
        void this.persist().catch(() => undefined);
      });
      socket.addEventListener("error", () => {
        if (this.heliusSocket !== socket) return;
        this.status.lastError = "Helius WebSocket transport error.";
        void this.persist().catch(() => undefined);
      });
    } catch {
      this.heliusSocket = null;
      this.status.heliusConnected = false;
      this.heliusConnectedAtMs = 0;
      this.heliusConnectingSinceMs = 0;
      this.status.lastError = "Unable to create the Helius WebSocket connection.";
    }
  }

  private sendHeliusSubscriptions(): void {
    const socket = this.heliusSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    this.heliusState = reconcileHeliusSubscriptions(
      this.heliusState, this.discovery.candidates, new Date().toISOString(), this.monitoringEvidenceByMint()
    );
    try {
      for (const subscription of this.heliusState.subscriptions) {
        if (subscription.subscriptionId !== null) continue;
        socket.send(JSON.stringify(buildCandidateLogsSubscribe(subscription.bondingCurve, subscription.requestId, "confirmed")));
      }
      void this.persist().catch(() => undefined);
    } catch {
      this.status.lastError = "Helius candidate subscription send failed.";
      socket.close(1011, "Helius subscription send failed");
    }
  }

  private async drainHeliusQueue(): Promise<void> {
    if (this.drainingHelius || !this.status.enabled) return;
    this.drainingHelius = true;
    let activeWork: HeliusSignatureWork | null = null;
    try {
      while (this.status.enabled && this.heliusState.queue.length > 0) {
        if (!this.heliusBucket.tryTake()) {
          await new Promise(resolve => setTimeout(resolve, this.heliusBucket.retryAfterMs));
          continue;
        }
        const work = this.heliusState.queue[0];
        if (!work) break;
        activeWork = work;
        const result = await fetchAndVerifyPumpTransaction(work.signature, work.mint, {
          apiKey: this.env.HELIUS_API_KEY,
          commitment: "confirmed"
        });
        if (result.status === "VERIFIED") {
          this.verifiedTransactions = [...this.verifiedTransactions, result.transaction].slice(-2_000);
          this.status.verifiedTransactions += 1;
          // Re-rank the six evidence-follow-up slots as verified events arrive.
          // Fresh launches remain protected by the four-slot first-minute reserve.
          this.reconcileHelius();
        } else if (result.status === "FAILED_TRANSACTION") {
          this.status.failedHeliusTransactions += 1;
        } else if (result.status === "DATA_INCOMPLETE") {
          this.status.incompleteHeliusTransactions += 1;
          this.heliusState = {
            ...this.heliusState,
            incompleteMints: [...new Set([...this.heliusState.incompleteMints, work.mint])].slice(-10)
          };
        }
        this.heliusState = takeHeliusWork(this.heliusState).state;
        await this.ctx.storage.put({
          helius_monitor_state: this.heliusState,
          verified_transactions: this.verifiedTransactions,
          status: this.status
        });
        activeWork = null;
      }
    } catch {
      this.status.lastError = "Helius queue processing failed; affected candidate data may be incomplete.";
      // Only remove the item that actually failed. A storage failure after a
      // successful dequeue must never discard the next candidate's work.
      if (activeWork) {
        if (this.heliusState.queue[0]?.signature === activeWork.signature) {
          this.heliusState = takeHeliusWork(this.heliusState).state;
        }
        this.heliusState = {
          ...this.heliusState,
          incompleteMints: [...new Set([...this.heliusState.incompleteMints, activeWork.mint])].slice(-10)
        };
      }
      this.status.incompleteHeliusTransactions += 1;
      await this.ctx.storage.put({
        helius_monitor_state: this.heliusState,
        verified_transactions: this.verifiedTransactions,
        status: this.status
      }).catch(() => undefined);
    } finally {
      this.drainingHelius = false;
    }
  }

  private markHeliusCoverageGap(): void {
    const previouslyIncomplete = new Set(this.heliusState.incompleteMints);
    const newlyIncomplete = [...new Set(this.heliusState.subscriptions.map(item => item.mint))]
      .filter(mint => !previouslyIncomplete.has(mint));
    if (newlyIncomplete.length === 0) return;
    this.heliusState = {
      ...this.heliusState,
      incompleteMints: [...this.heliusState.incompleteMints, ...newlyIncomplete].slice(-10)
    };
    this.status.incompleteHeliusTransactions += newlyIncomplete.length;
  }

  private markHeliusIncomplete(): void {
    const mint = this.heliusState.queue[0]?.mint;
    if (mint) this.heliusState = {
      ...this.heliusState,
      incompleteMints: [...new Set([...this.heliusState.incompleteMints, mint])].slice(-10)
    };
    this.status.incompleteHeliusTransactions += 1;
    void this.persist().catch(() => undefined);
  }

  private scheduleReconnect(): void {
    this.status.reconnectAttempts += 1;
    const delayMs = Math.min(60_000, 1_000 * (2 ** Math.min(this.status.reconnectAttempts - 1, 6)));
    this.status.nextReconnectAt = new Date(Date.now() + delayMs).toISOString();
  }

  private syncCounts(): void {
    this.status.candidates = this.discovery.candidates.length;
    this.status.acceptedCandidates = this.discovery.accepted;
    this.status.duplicateEvents = this.discovery.duplicates;
    this.status.migrations = this.discovery.migrations;
    this.status.overflowEvents = this.discovery.overflow;
    this.status.incompleteEvents = this.discovery.incomplete;
    this.status.expiredCandidates = this.discovery.expired ?? 0;
    this.status.lastPersistedAt = this.discovery.lastPersistedAt;
    this.status.monitoredCandidates = this.heliusState.subscriptions.length;
    this.status.queuedHeliusSignatures = this.heliusState.queue.length;
    this.status.droppedHeliusSignatures = this.heliusState.droppedSignatures;
    this.status.duplicateHeliusSignatures = this.heliusState.duplicateSignatures;
    this.status.incompleteHeliusCandidates = this.heliusState.incompleteMints.length;
  }

  private async persist(): Promise<void> {
    const pendingAtStart = this.pendingWrites;
    this.pendingWrites = 0;
    const snapshot = structuredClone(this.discovery);
    snapshot.lastPersistedAt = new Date().toISOString();
    this.discovery.lastPersistedAt = snapshot.lastPersistedAt;
    this.syncCounts();
    const statusSnapshot = { ...this.status };
    const write = this.persistChain.then(() => this.ctx.storage.put({
      status: statusSnapshot,
      discovery_state: snapshot,
      helius_monitor_state: this.heliusState,
      verified_transactions: this.verifiedTransactions,
      wallet_link_snapshots: this.walletLinkSnapshots,
      wallet_holdings_by_mint: this.walletHoldingsByMint
    }));
    this.persistChain = write.catch(() => undefined);
    try {
      await write;
    } catch (error) {
      this.pendingWrites += pendingAtStart;
      this.status.lastError = "Unable to persist discovery state; ingestion may be incomplete.";
      throw error;
    }
  }
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(item => jsonSafe(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
}

function authorized(request: Request, env: Env): boolean {
  return Boolean(env.CONTROL_TOKEN) &&
    request.headers.get("authorization") === "Bearer " + env.CONTROL_TOKEN;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const coordinator = env.COORDINATOR.get(env.COORDINATOR.idFromName("primary"));

    if (url.pathname === "/health" && request.method === "GET") {
      const status = await coordinator.getStatus();
      return Response.json({
        service: "pumpfun-paper-worker",
        mode: "paper",
        ready: false,
        provider: "pumpportal",
        connected: status.connected,
        candidates: status.candidates,
        blocker: status.blocker
      });
    }

    if (!authorized(request, env)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (url.pathname === "/start" && request.method === "POST") {
      return Response.json(await coordinator.start());
    }
    if (url.pathname === "/stop" && request.method === "POST") {
      return Response.json(await coordinator.stop());
    }
    if (url.pathname === "/status" && request.method === "GET") {
      return Response.json(await coordinator.getStatus());
    }
    if (url.pathname === "/candidates" && request.method === "GET") {
      return Response.json(await coordinator.listCandidates());
    }
    if (url.pathname === "/observations" && request.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const transactions = await coordinator.listVerifiedTransactions(limit);
      return Response.json({
        provider: "helius",
        mode: "paper",
        count: transactions.length,
        transactions
      });
    }
    if (url.pathname === "/flow" && request.method === "GET") {
      return Response.json(await coordinator.listTradeFlows());
    }
    if (url.pathname === "/holder-risk" && request.method === "GET") {
      const mint = url.searchParams.get("mint") ?? "";
      if (!mint) return Response.json({ error: "mint query parameter is required" }, { status: 400 });
      return Response.json(await coordinator.getHolderRisk(mint));
    }
    if (url.pathname === "/wallet-links" && request.method === "GET") {
      const mint = url.searchParams.get("mint") ?? "";
      if (!mint) return Response.json({ error: "mint query parameter is required" }, { status: 400 });
      return Response.json(await coordinator.collectWalletLinks(mint));
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    context: ExecutionContext
  ): Promise<void> {
    const coordinator = env.COORDINATOR.get(env.COORDINATOR.idFromName("primary"));
    context.waitUntil(coordinator.ensureRunning());
  }
};
