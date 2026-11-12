import { DurableObject } from "cloudflare:workers";
import { createBankrollState, markPaperEquity, replenishPaperBankroll, type BankrollState } from "../../../../src/paper/session-ledger.js";
import { updateCandidatePriceTracker, type CandidatePriceTracker } from "../../../../src/paper/candidate-price-ledger.js";
import { evaluateStrictStrategyAudit, calculateReclaimConfirmation } from "../../../../src/paper/strategy-audit.js";
import { createPaperPortfolio, type PaperPortfolioState } from "../../../../src/paper/portfolio.js";

type AuditKind = "SESSION_STARTED" | "SESSION_STOPPED" | "SESSION_HEARTBEAT" | "WORKER_RESTARTED" | "DISCOVERY" |
  "DISCOVERY_INCOMPLETE" | "DISCOVERY_OVERFLOW" | "CANDIDATE_EXPIRED" | "OBSERVATION" |
  "FEATURE_SNAPSHOT" | "STRATEGY_DECISION" | "RULE_EVALUATION" | "REJECTION_REASON" | "QUOTE_REQUESTED" |
  "QUOTE_RESULT" | "PAPER_ENTRY" | "PAPER_EXIT" | "POSITION_MARK" | "DATA_GAP" |
  "PROVIDER_STATUS" | "ERROR" | "RISK_EVIDENCE" | "BANKROLL_TOP_UP" | "CANDIDATE_OUTCOME";
interface StoredAuditEvent {
  sessionId: string; sequence: number; eventId: string; kind: AuditKind;
  occurredAt: string; mint: string | null; strategyVersion: string; data: unknown;
}
interface AuditSessionMeta {
  sessionId: string; startedAt: string; stoppedAt: string | null;
  strategyVersion: string; eventCount: number; initialBankrollUsd: number;
  topUpAmountUsd: number; topUpThresholdUsd: number; topUpCount: number;
  totalTopUpsUsd: number;
}
const AUDIT_PAGE_SIZE = 100;
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
import { buildCandidateTradeFlows, SOL_QUOTE_MINT } from "../../../../src/ingestion/trade-flow.js";
import { fetchHolderConcentration } from "../../../../src/ingestion/holder-risk.js";
import { buildCandidatePriceVolumeProfiles } from "../../../../src/ingestion/price-volume-profile.js";
import { fetchSolUsdPrice } from "../../../../src/ingestion/sol-usd-price.js";
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
  private activeSessionId: string | null = null;
  private solUsdPriceCache: Awaited<ReturnType<typeof fetchSolUsdPrice>> | null = null;
  private solUsdPriceFetchedAtMs = 0;
  private solUsdPriceRequest: Promise<Awaited<ReturnType<typeof fetchSolUsdPrice>>> | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private auditChain: Promise<void> = Promise.resolve();
  private connectingSinceMs = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.env = env;
  }
  private readonly env: Env;

  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    const [savedStatus, savedDiscovery, enabled, savedWalletLinks, savedWalletHoldings, activeSessionId] = await Promise.all([
      this.ctx.storage.get<CoordinatorStatus>("status"),
      this.ctx.storage.get<DiscoveryStoreState>("discovery_state"),
      this.ctx.storage.get<boolean>("enabled"),
      this.ctx.storage.get<Record<string, WalletFundingEvidenceResult>>("wallet_link_snapshots"),
      this.ctx.storage.get<Record<string, WalletHoldingEvidence[]>>("wallet_holdings_by_mint"),
      this.ctx.storage.get<string>("active_audit_session_id")
    ]);
    if (savedStatus) this.status = { ...INITIAL_STATUS, ...savedStatus };
    this.activeSessionId = activeSessionId ?? null;
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
    if (this.activeSessionId && this.status.enabled) {
      await this.appendAudit("WORKER_RESTARTED", null, {
        discoveryCandidates: this.discovery.candidates.length,
        verifiedTransactionsRetained: this.verifiedTransactions.length,
        heliusCoverage: "GAP_UNTIL_RESUBSCRIBED"
      }, `restart:${crypto.randomUUID()}`);
    }
  }

  async start(): Promise<CoordinatorStatus> {
    await this.hydrate();
    if (!this.status.enabled || this.heliusSocket?.readyState !== WebSocket.OPEN) {
      this.markHeliusCoverageGap();
    }
    if (!this.activeSessionId) {
      // A new session starts from a clean candidate/observation cache. Previous
      // sessions remain intact in their own journal and candidate namespaces.
      this.discovery = emptyDiscoveryStore();
      this.verifiedTransactions = [];
      this.heliusState = emptyHeliusMonitorState();
      this.walletLinkSnapshots = {};
      this.walletHoldingsByMint = {};
      this.status = { ...INITIAL_STATUS };
      const sessionId = crypto.randomUUID();
      const meta: AuditSessionMeta = {
        sessionId, startedAt: new Date().toISOString(), stoppedAt: null, strategyVersion: "strict-v1",
        eventCount: 0, initialBankrollUsd: 2.70, topUpAmountUsd: 2.70,
        topUpThresholdUsd: 1.00, topUpCount: 0, totalTopUpsUsd: 0
      };
      await this.ctx.storage.transaction(async txn => {
        const sessions = await txn.get<string[]>("audit_session_ids") ?? [];
        const firstEvent: StoredAuditEvent = {
          sessionId, sequence: 1, eventId: `session-started:${sessionId}`,
          kind: "SESSION_STARTED", occurredAt: meta.startedAt, mint: null,
          strategyVersion: meta.strategyVersion,
          data: { initialBankrollUsd: 2.70, topUpAmountUsd: 2.70,
            topUpThresholdUsd: 1.00, strategyVersion: "strict-v1" }
        };
        await txn.put(`audit_session:${sessionId}`, { ...meta, eventCount: 1 });
        await txn.put("active_audit_session_id", sessionId);
        await txn.put("audit_session_ids", [...sessions, sessionId]);
        await txn.put("discovery_state", emptyDiscoveryStore());
        await txn.put("helius_monitor_state", emptyHeliusMonitorState());
        await txn.put("verified_transactions", []);
        await txn.put("wallet_link_snapshots", {});
        await txn.put("wallet_holdings_by_mint", {});
        await txn.put(`paper_bankroll:${sessionId}`, createBankrollState(2.70));
        await txn.put(`paper_portfolio:${sessionId}`, createPaperPortfolio(2.70));
        await txn.put(`audit_events:${sessionId}:00000000`, [firstEvent]);
        await txn.put(`audit_event_id:${sessionId}:session-started:${sessionId}`, 1);
      });
      this.activeSessionId = sessionId;
    } else {
      await this.appendAudit("PROVIDER_STATUS", null, { action: "START_REQUESTED" });
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
    // Stop accepting provider messages before draining the audit queue, so no
    // event can be appended after SESSION_STOPPED.
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
    await this.auditChain;
    if (this.activeSessionId) {
      const completedSessionId = this.activeSessionId;
      const stoppedAt = new Date().toISOString();
      await this.ctx.storage.transaction(async txn => {
        const metaKey = `audit_session:${completedSessionId}`;
        const meta = await txn.get<AuditSessionMeta>(metaKey);
        if (!meta) throw new Error("Audit session metadata missing.");
        const sequence = meta.eventCount + 1;
        const pageNumber = Math.floor((sequence - 1) / AUDIT_PAGE_SIZE);
        const pageKey = `audit_events:${completedSessionId}:${String(pageNumber).padStart(8, "0")}`;
        const page = await txn.get<StoredAuditEvent[]>(pageKey) ?? [];
        const eventId = `session-stopped:${completedSessionId}`;
        if (await txn.get<number>(`audit_event_id:${completedSessionId}:${eventId}`) === undefined) {
          page.push({ sessionId: completedSessionId, sequence, eventId, kind: "SESSION_STOPPED",
            occurredAt: stoppedAt, mint: null, strategyVersion: meta.strategyVersion,
            data: { reason: "MANUAL_STOP" } });
          await txn.put(pageKey, page);
          await txn.put(`audit_event_id:${completedSessionId}:${eventId}`, sequence);
          await txn.put(metaKey, { ...meta, eventCount: sequence, stoppedAt });
        } else {
          await txn.put(metaKey, { ...meta, stoppedAt });
        }
        await txn.put("latest_audit_session_id", completedSessionId);
        await txn.delete("active_audit_session_id");
      });
      this.activeSessionId = null;
    }
    await this.persist();
    return this.getStatus();
  }

  async ensureRunning(): Promise<CoordinatorStatus> {
    await this.hydrate();
    if (this.activeSessionId) {
      await this.appendAudit("SESSION_HEARTBEAT", null, {
        enabled: this.status.enabled, pumpPortalConnected: this.status.connected,
        heliusConnected: this.status.heliusConnected, candidates: this.discovery.candidates.length,
        monitoredCandidates: this.heliusState.subscriptions.length,
        queuedSignatures: this.heliusState.queue.length,
        droppedSignatures: this.heliusState.droppedSignatures
      }, `heartbeat:${Math.floor(Date.now() / 60_000)}`);
    }
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
    const previousCandidates = this.discovery.candidates;
    const beforeExpiry = previousCandidates.length;
    this.discovery = pruneExpiredCandidates(this.discovery, new Date().toISOString());
    if (this.discovery.candidates.length !== beforeExpiry) {
      const retainedMints = new Set(this.discovery.candidates.map(candidate => candidate.mint));
      const expiredMints = previousCandidates.filter(candidate => !retainedMints.has(candidate.mint)).map(candidate => candidate.mint);
      await this.appendAudit("CANDIDATE_EXPIRED", null, { expiredMints, count: expiredMints.length });
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

  private auditInBackground(kind: AuditKind, mint: string | null, data: unknown, idempotencyKey?: string): void {
    // Capture the session before asynchronous work: stop() clears the active
    // pointer after its final transaction, but this event still belongs to it.
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    const append = this.auditChain.then(() =>
      this.appendAudit(kind, mint, data, idempotencyKey, sessionId)
    );
    this.auditChain = append.catch(() => {
      this.status.lastError = "Audit journal append failed.";
    });
    this.ctx.waitUntil(this.auditChain);
  }

  private async appendAudit(kind: AuditKind, mint: string | null, data: unknown,
    idempotencyKey?: string, sessionIdOverride?: string): Promise<void> {
    const sessionId = sessionIdOverride ?? this.activeSessionId;
    if (!sessionId) return;
    const eventId = idempotencyKey ?? crypto.randomUUID();
    await this.ctx.storage.transaction(async txn => {
      const metaKey = `audit_session:${sessionId}`;
      const dedupeKey = `audit_event_id:${sessionId}:${eventId}`;
      if (await txn.get<number>(dedupeKey) !== undefined) return;
      const meta = await txn.get<AuditSessionMeta>(metaKey);
      if (!meta) throw new Error("Audit session metadata missing.");
      const sequence = meta.eventCount + 1;
      const pageNumber = Math.floor((sequence - 1) / AUDIT_PAGE_SIZE);
      const pageKey = `audit_events:${sessionId}:${String(pageNumber).padStart(8, "0")}`;
      const page = await txn.get<StoredAuditEvent[]>(pageKey) ?? [];
      page.push({ sessionId, sequence, eventId, kind, occurredAt: new Date().toISOString(),
        mint, strategyVersion: meta.strategyVersion, data: jsonSafe(data) });
      await txn.put(pageKey, page);
      await txn.put(dedupeKey, sequence);
      await txn.put(metaKey, { ...meta, eventCount: sequence });
    });
  }

  async recordPaperEquity(equityUsd: number): Promise<unknown> {
    await this.hydrate();
    if (!this.activeSessionId) throw new Error("No active paper session.");
    if (!Number.isFinite(equityUsd) || equityUsd < 0) throw new Error("Paper equity must be finite and non-negative.");
    const sessionId = this.activeSessionId;
    const occurredAt = new Date().toISOString();
    let output: BankrollState | null = null;
    await this.ctx.storage.transaction(async txn => {
      const key = `paper_bankroll:${sessionId}`;
      const saved = await txn.get<BankrollState>(key) ?? createBankrollState(2.70);
      const marked = markPaperEquity(saved, equityUsd);
      const topped = replenishPaperBankroll(marked, occurredAt, 2.70, 1.00);
      output = topped.state;
      const metaKey = `audit_session:${sessionId}`;
      const meta = await txn.get<AuditSessionMeta>(metaKey);
      if (!meta) throw new Error("Audit session metadata missing.");
      const entries: Array<{kind: AuditKind; eventId: string; data: unknown}> = [{
        kind: "POSITION_MARK", eventId: `equity-mark:${crypto.randomUUID()}`,
        data: { equityUsd: marked.currentEquityUsd, contributedCapitalUsd: marked.totalCapitalContributedUsd }
      }];
      if (topped.event) entries.push({
        kind: "BANKROLL_TOP_UP", eventId: `bankroll-top-up:${topped.state.topUpCount}`, data: topped.event.data
      });
      let count = meta.eventCount;
      let pageNumber = Math.floor(count / AUDIT_PAGE_SIZE);
      let pageKey = `audit_events:${sessionId}:${String(pageNumber).padStart(8, "0")}`;
      let page = await txn.get<StoredAuditEvent[]>(pageKey) ?? [];
      for (const entry of entries) {
        const sequence = ++count;
        pageNumber = Math.floor((sequence - 1) / AUDIT_PAGE_SIZE);
        pageKey = `audit_events:${sessionId}:${String(pageNumber).padStart(8, "0")}`;
        if ((sequence - 1) % AUDIT_PAGE_SIZE === 0) page = await txn.get<StoredAuditEvent[]>(pageKey) ?? [];
        page.push({ sessionId, sequence, eventId: entry.eventId, kind: entry.kind,
          occurredAt, mint: null, strategyVersion: meta.strategyVersion, data: jsonSafe(entry.data) });
        await txn.put(pageKey, page);
        await txn.put(`audit_event_id:${sessionId}:${entry.eventId}`, sequence);
      }
      await txn.put(key, topped.state);
      const portfolioKey = `paper_portfolio:${sessionId}`;
      const portfolio = await txn.get<PaperPortfolioState>(portfolioKey);
      if (portfolio) {
        const openValue = portfolio.positions.filter(position => position.status === "OPEN")
          .reduce((sum, position) => sum + Number(BigInt(position.tokenAmountBaseUnits)) * position.latestPriceUsdPerToken, 0);
        if (openValue > topped.state.currentEquityUsd + 0.00000001) {
          throw new Error("Marked portfolio equity is below the recorded value of its open positions.");
        }
        await txn.put(portfolioKey, {
          ...portfolio, bankroll: topped.state,
          availableCashUsd: Math.round((topped.state.currentEquityUsd - openValue) * 1e8) / 1e8,
          highWaterEquityUsd: Math.max(portfolio.highWaterEquityUsd,
            Math.max(0, topped.state.currentEquityUsd - topped.state.totalTopUpsUsd)),
          lastMarkedAt: occurredAt
        });
      }
      await txn.put(metaKey, { ...meta, eventCount: count, topUpCount: topped.state.topUpCount,
        totalTopUpsUsd: topped.state.totalTopUpsUsd });
    });
    const state = output ?? createBankrollState(2.70);
    return { ...state, netPnlUsd: state.currentEquityUsd - state.totalCapitalContributedUsd };
  }

  async getPaperPortfolio(): Promise<unknown> {
    await this.hydrate();
    const sessionId = this.activeSessionId ?? await this.ctx.storage.get<string>("latest_audit_session_id");
    if (!sessionId) return null;
    return await this.ctx.storage.get<PaperPortfolioState>(`paper_portfolio:${sessionId}`) ?? null;
  }

  async getPaperBankroll(): Promise<unknown> {
    await this.hydrate();
    const sessionId = this.activeSessionId ?? await this.ctx.storage.get<string>("latest_audit_session_id");
    if (!sessionId) return { ...createBankrollState(2.70), netPnlUsd: 0 };
    const state = await this.ctx.storage.get<BankrollState>(`paper_bankroll:${sessionId}`) ?? createBankrollState(2.70);
    return { ...state, netPnlUsd: state.currentEquityUsd - state.totalCapitalContributedUsd };
  }

  async listAuditSessions(): Promise<unknown> {
    await this.hydrate();
    const ids = await this.ctx.storage.get<string[]>("audit_session_ids") ?? [];
    const sessions = await Promise.all(ids.map(id => this.ctx.storage.get<AuditSessionMeta>(`audit_session:${id}`)));
    return sessions.filter((item): item is AuditSessionMeta => item !== undefined);
  }

  private async recordStrategyAudit(triggerSignature: string): Promise<void> {
    const monitoredMints = [...new Set(this.heliusState.subscriptions.map(item => item.mint))];
    if (monitoredMints.length === 0) return;
    const report = await this.listTradeFlows() as {
      solUsdPrice?: Awaited<ReturnType<typeof fetchSolUsdPrice>>;
      flows: Array<{ mint: string; quoteMint: string | null; microTradeFilterStatus: "APPLIED" | "UNAVAILABLE" | "UNSUPPORTED_QUOTE"; dataComplete: boolean; latestThreeWindowFlowPass: boolean; windows: Array<{buySellRatio:number|null;flowWindowPass:boolean;uniqueBuyers:number;uniqueSellers:number}>; distinctBuyersAcrossLatestThree:number; largestBuyerShareAcrossLatestThreeBps:number|null }>;
      priceVolumeProfiles: Array<{ mint:string; quoteMint:string|null; baselinePrice:number|null; reclaimTime:number|null; buckets:Array<{closePrice:number;highPrice:number;endTime:number}>; impulsePriceChangePct:number|null; pullbackPct:number|null; reclaimDetected:boolean; reclaimAbovePreviousFiveSecondHighPct:number|null; pullbackVolumeVsImpulsePct:number|null; reclaimVolumeVsPullbackPct:number|null; dataComplete:boolean; microTradeFilterStatus:"APPLIED"|"UNAVAILABLE"|"UNSUPPORTED_QUOTE" }>;
      creatorSellRisk: Array<{mint:string;status:string}>;
      walletClusterRisk: Array<{mint:string;status:string}>;
    };
    for (const mint of monitoredMints) {
      const candidate = await this.ctx.storage.get<Record<string, unknown>>(
        `candidate_seen:${this.activeSessionId}:${mint}`
      );
      const launchEvent = this.verifiedTransactions.flatMap(tx => tx.createEvents).find(event => event.mint === mint);
      const launchTimestamp = launchEvent ? Number(launchEvent.timestamp) : Number.NaN;
      const ageSeconds = Number.isSafeInteger(launchTimestamp) && launchTimestamp >= 0
        ? Math.max(0, Date.now() / 1000 - launchTimestamp) : null;
      const profile = report.priceVolumeProfiles.find(item => item.mint === mint && item.quoteMint === SOL_QUOTE_MINT) ?? null;
      const flow = report.flows.find(item => item.mint === mint && item.quoteMint === SOL_QUOTE_MINT) ?? null;
      const creatorRisk = report.creatorSellRisk.find(item => item.mint === mint);
      const walletRisk = report.walletClusterRisk.find(item => item.mint === mint);
      const links = this.walletLinkSnapshots[mint]?.links ?? [];
      const confidence = links.reduce((max, link) => Math.max(max, link.confidenceBps), 0);
      const reclaimBucketIndex = profile?.reclaimTime === null || profile?.reclaimTime === undefined
        ? -1 : profile.buckets.findIndex(bucket => bucket.endTime === profile.reclaimTime);
      const previousCompletedHigh = reclaimBucketIndex > 0
        ? profile!.buckets[reclaimBucketIndex - 1]!.highPrice : null;
      const nowSeconds = Date.now() / 1000;
      const nextObservationPrices = this.verifiedTransactions.flatMap(transaction => transaction.tradeEvents)
        .filter(event => event.mint === mint && event.quoteMint === SOL_QUOTE_MINT &&
          Number(event.timestamp) > (profile?.reclaimTime ?? Number.POSITIVE_INFINITY))
        .map(event => {
          const reserves = event.virtualSolReserves;
          const tokens = event.virtualTokenReserves;
          if (reserves <= 0n || tokens <= 0n) return null;
          const scaled = (reserves * 1_000_000_000_000n) / tokens;
          return { timestampSeconds: Number(event.timestamp), price: Number(scaled) / 1_000_000_000_000 };
        }).filter((item): item is {timestampSeconds:number;price:number} => item !== null);
      const freshness = calculateReclaimConfirmation({
        reclaimTimeSeconds: profile?.reclaimTime ?? null,
        previousCompletedHigh, nowSeconds, nextObservationPrices
      });
      const evaluated = evaluateStrictStrategyAudit({
        candidateAgeSeconds: ageSeconds,
        profile: profile ? {
          impulsePriceChangePct: profile.impulsePriceChangePct, pullbackPct: profile.pullbackPct,
          reclaimDetected: profile.reclaimDetected,
          reclaimAbovePreviousFiveSecondHighPct: profile.reclaimAbovePreviousFiveSecondHighPct,
          pullbackVolumeVsImpulsePct: profile.pullbackVolumeVsImpulsePct,
          reclaimVolumeVsPullbackPct: profile.reclaimVolumeVsPullbackPct, dataComplete: profile.dataComplete,
          microTradeFilterStatus: profile.microTradeFilterStatus
        } : null,
        flow: flow ? {
          dataComplete: flow.dataComplete, latestThreeWindowFlowPass: flow.latestThreeWindowFlowPass, windows: flow.windows.map(window => ({...window, flowWindowPass: window.flowWindowPass})),
          distinctBuyersAcrossLatestThree: flow.distinctBuyersAcrossLatestThree,
          largestBuyerShareAcrossLatestThreeBps: flow.largestBuyerShareAcrossLatestThreeBps,
          microTradeFilterStatus: flow.microTradeFilterStatus
        } : null,
        creatorRiskStatus: creatorRisk?.status ?? null,
        walletClusterRiskStatus: walletRisk?.status ?? null,
        attributionConfidenceBps: confidence > 0 ? confidence : null,
        signalAgeSeconds: freshness.signalAgeSeconds, nextObservationConfirmed: freshness.nextObservationConfirmed,
        executableQuoteAvailable: false
      });
      await this.appendAudit("FEATURE_SNAPSHOT", mint, { triggerSignature, profile, flow, solUsdPrice: report.solUsdPrice ?? null },
        `features:${triggerSignature}:${mint}`);
      const decisionPriceQuotePerToken = profile?.buckets.at(-1)?.closePrice ?? null;
      await this.appendAudit("STRATEGY_DECISION", mint, {
        ...evaluated, decisionPriceQuotePerToken,
        discoveryPriceQuotePerToken: profile?.baselinePrice ?? null,
        quoteMint: profile?.quoteMint ?? null
      }, `decision:${triggerSignature}:${mint}`);
      if (profile?.quoteMint) {
        const refKey = `candidate_price_refs:${this.activeSessionId}:${mint}:${profile.quoteMint}`;
        const previousRefs = await this.ctx.storage.get<{
          decisionPriceQuotePerToken: number | null; decisionAt: string | null;
          discoveryPriceQuotePerToken: number | null;
        }>(refKey);
        // WATCH is a real strategy outcome too: preserve the first evaluated
        // decision-time price instead of waiting for a hard REJECT (which may
        // never happen because missing evidence correctly remains WATCH).
        await this.ctx.storage.put(refKey, {
          discoveryPriceQuotePerToken: previousRefs?.discoveryPriceQuotePerToken ??
            (profile.baselinePrice !== null && profile.baselinePrice > 0 ? profile.baselinePrice : null),
          decisionPriceQuotePerToken: previousRefs?.decisionPriceQuotePerToken ??
            (decisionPriceQuotePerToken !== null && decisionPriceQuotePerToken > 0 ? decisionPriceQuotePerToken : null),
          decisionAt: previousRefs?.decisionAt ??
            (decisionPriceQuotePerToken !== null && decisionPriceQuotePerToken > 0 ? evaluated.evaluatedAt : null)
        });
      }
      for (const rule of evaluated.rules) {
        await this.appendAudit("RULE_EVALUATION", mint, { triggerSignature, ...rule },
          `rule:${triggerSignature}:${mint}:${rule.rule}`);
      }
      for (const reason of [...evaluated.rejectionReasons, ...evaluated.watchReasons]) {
        await this.appendAudit("REJECTION_REASON", mint, {
          triggerSignature, reason,
          classification: evaluated.rejectionReasons.includes(reason) ? "REJECT" : "WATCH"
        }, `decision-reason:${triggerSignature}:${mint}:${reason}`);
      }
    }
  }

  private async recordCandidateTradePrice(
    trade: { mint: string; quoteMint: string; quoteAmount: string; tokenAmount: string; timestamp: string; signature: string; isBuy: boolean },
    tradeIndex: number
  ): Promise<void> {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    const processedKey = `processed_trade:${sessionId}:${trade.signature}:${tradeIndex}`;
    await this.ctx.storage.transaction(async txn => {
      if (await txn.get<boolean>(processedKey)) return;
      const trackerKey = `candidate_price:${sessionId}:${trade.mint}:${trade.quoteMint}`;
      const previous = await txn.get<CandidatePriceTracker>(trackerKey) ?? null;
      const refs = await txn.get<{
        decisionPriceQuotePerToken: number | null; decisionAt: string | null;
        discoveryPriceQuotePerToken: number | null;
      }>(`candidate_price_refs:${sessionId}:${trade.mint}:${trade.quoteMint}`);
      const tracker = { ...updateCandidatePriceTracker(previous, {
        ...trade, decisionPriceQuotePerToken: refs?.decisionPriceQuotePerToken ?? null,
        decisionAt: refs?.decisionAt ?? null,
        discoveryPriceQuotePerToken: refs?.discoveryPriceQuotePerToken ?? null
      }), sessionId };
      const metaKey = `audit_session:${sessionId}`;
      const meta = await txn.get<AuditSessionMeta>(metaKey);
      if (!meta) throw new Error("Audit session metadata missing.");
      const sequence = meta.eventCount + 1;
      const pageNumber = Math.floor((sequence - 1) / AUDIT_PAGE_SIZE);
      const pageKey = `audit_events:${sessionId}:${String(pageNumber).padStart(8, "0")}`;
      const page = await txn.get<StoredAuditEvent[]>(pageKey) ?? [];
      const eventId = `candidate-price:${trade.signature}:${tradeIndex}`;
      page.push({ sessionId, sequence, eventId, kind: "CANDIDATE_OUTCOME",
        occurredAt: trade.timestamp, mint: trade.mint,
        strategyVersion: meta.strategyVersion, data: jsonSafe(tracker) });
      await txn.put(pageKey, page);
      await txn.put(`audit_event_id:${sessionId}:${eventId}`, sequence);
      await txn.put(metaKey, { ...meta, eventCount: sequence });
      await txn.put(trackerKey, tracker);
      await txn.put(processedKey, true);
    });
  }

  async listCandidateOutcomes(requestedSessionId?: string, after = 0, limit = 100): Promise<unknown> {
    await this.hydrate();
    const sessionId = requestedSessionId ?? this.activeSessionId ?? await this.ctx.storage.get<string>("latest_audit_session_id");
    if (!sessionId) return { sessionId: null, outcomes: [], nextAfter: null };
    const safeAfter = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 100;
    const [trackers, candidates] = await Promise.all([
      this.ctx.storage.list<CandidatePriceTracker & { sessionId: string }>({ prefix: `candidate_price:${sessionId}:` }),
      this.ctx.storage.list<Record<string, unknown>>({ prefix: `candidate_seen:${sessionId}:` })
    ]);
    const byMint = new Map<string, CandidatePriceTracker[]>();
    for (const tracker of trackers.values()) {
      const items = byMint.get(tracker.mint) ?? [];
      items.push(tracker);
      byMint.set(tracker.mint, items);
    }
    const sortedCandidates = [...candidates.values()].sort((a, b) =>
      String(a.mint).localeCompare(String(b.mint))
    );
    const selected = sortedCandidates.slice(safeAfter, safeAfter + safeLimit);
    const outcomes = await Promise.all(selected.map(async candidate => {
      const mint = String(candidate.mint);
      const observed = byMint.get(mint) ?? [];
      const refs = await this.ctx.storage.get<{
        decisionPriceQuotePerToken: number | null; decisionAt: string | null;
        discoveryPriceQuotePerToken: number | null;
      }>(`candidate_price_refs:${sessionId}:${mint}:${SOL_QUOTE_MINT}`);
      return {
        ...candidate,
        decisionPriceQuotePerToken: refs?.decisionPriceQuotePerToken ?? null,
        decisionAt: refs?.decisionAt ?? null,
        discoveryPriceQuotePerToken: refs?.discoveryPriceQuotePerToken ?? null,
        quoteMint: SOL_QUOTE_MINT,
        followUpStatus: observed.length > 0 ? "PARTIAL" : "MISSING",
        priceTrackers: observed.sort((a, b) => a.quoteMint.localeCompare(b.quoteMint))
      };
    }));
    const next = safeAfter + outcomes.length;
    return { sessionId, outcomes, nextAfter: next < sortedCandidates.length ? next : null,
      total: sortedCandidates.length };
  }

  async listAuditEvents(after = 0, limit = 100, requestedSessionId?: string): Promise<unknown> {
    await this.hydrate();
    const sessionId = requestedSessionId ?? this.activeSessionId ?? await this.ctx.storage.get<string>("latest_audit_session_id");
    if (!sessionId) return { sessionId: null, events: [], nextAfter: null };
    const meta = await this.ctx.storage.get<AuditSessionMeta>(`audit_session:${sessionId}`);
    if (!meta) return { sessionId, events: [], nextAfter: null };
    const safeAfter = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(500, limit)) : 100;
    const firstPage = Math.floor(safeAfter / AUDIT_PAGE_SIZE);
    const lastPage = Math.floor((Math.min(meta.eventCount, safeAfter + safeLimit) - 1) / AUDIT_PAGE_SIZE);
    const events: StoredAuditEvent[] = [];
    if (meta.eventCount > safeAfter) {
      for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber++) {
        const page = await this.ctx.storage.get<StoredAuditEvent[]>(`audit_events:${sessionId}:${String(pageNumber).padStart(8, "0")}`) ?? [];
        events.push(...page.filter(event => event.sequence > safeAfter));
      }
    }
    const result = events.slice(0, safeLimit);
    const last = result.at(-1)?.sequence ?? safeAfter;
    return { session: meta, events: result, nextAfter: last < meta.eventCount ? last : null,
      totalEvents: meta.eventCount, pageSize: AUDIT_PAGE_SIZE };
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
    await this.appendAudit("RISK_EVIDENCE", mint, { evidenceType: "HOLDER_CONCENTRATION", result: jsonSafe(result) });
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
    await this.appendAudit("RISK_EVIDENCE", mint, { evidenceType: "WALLET_CLUSTER", fundingEvidence: jsonSafe(result), risk: jsonSafe(risk) });
    return { ...result, risk };
  }

  private async getSolUsdPrice(): Promise<Awaited<ReturnType<typeof fetchSolUsdPrice>>> {
    const now = Date.now();
    if (this.solUsdPriceCache && now - this.solUsdPriceFetchedAtMs < 1_000) {
      return this.solUsdPriceCache;
    }
    if (this.solUsdPriceRequest) return this.solUsdPriceRequest;
    const request = fetchSolUsdPrice().then(result => {
      this.solUsdPriceCache = result;
      this.solUsdPriceFetchedAtMs = Date.now();
      return result;
    }).finally(() => {
      this.solUsdPriceRequest = null;
    });
    this.solUsdPriceRequest = request;
    return request;
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
    const solUsdPrice = await this.getSolUsdPrice();
    const solUsdPriceUsd = solUsdPrice.status === "AVAILABLE" ? solUsdPrice.observation.priceUsd : undefined;
    const flows = buildCandidateTradeFlows(this.verifiedTransactions, {
      solUsdPriceUsd,
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
      solUsdPriceUsd,
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
      solUsdPrice,
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
    const previousCandidates = this.discovery.candidates;
    const beforeExpiry = previousCandidates.length;
    this.discovery = pruneExpiredCandidates(this.discovery, new Date().toISOString());
    if (this.discovery.candidates.length !== beforeExpiry) {
      const retainedMints = new Set(this.discovery.candidates.map(candidate => candidate.mint));
      const expiredMints = previousCandidates.filter(candidate => !retainedMints.has(candidate.mint)).map(candidate => candidate.mint);
      await this.appendAudit("CANDIDATE_EXPIRED", null, { expiredMints, count: expiredMints.length });
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
        this.auditInBackground("PROVIDER_STATUS", null, { provider: "pumpportal", status: "CONNECTED" });
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

      socket.addEventListener("message", async (message: MessageEvent) => {
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
          await this.appendAudit("DISCOVERY_INCOMPLETE", null, {
            status: parsed.status, rawMessage: typeof message.data === "string" ? message.data.slice(0, 2000) : "NON_TEXT_MESSAGE"
          });
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
        await this.appendAudit(
          result.outcome === "OVERFLOW" ? "DISCOVERY_OVERFLOW" : "DISCOVERY",
          parsed.event.mint,
          { ...parsed.event, outcome: result.outcome,
            candidateStatus: this.discovery.candidates.find(item => item.mint === parsed.event.mint)?.status ?? null },
          parsed.event.signature ? `pumpportal:${parsed.event.signature}:${parsed.event.kind}` : undefined
        );
        const candidateKey = this.activeSessionId ? `candidate_seen:${this.activeSessionId}:${parsed.event.mint}` : `candidate_seen:${parsed.event.mint}`;
        const previousCandidate = await this.ctx.storage.get<Record<string, unknown>>(candidateKey);
        await this.ctx.storage.put(candidateKey, {
          mint: parsed.event.mint,
          creator: parsed.event.creator ?? previousCandidate?.creator ?? null,
          bondingCurve: parsed.event.bondingCurve ?? previousCandidate?.bondingCurve ?? null,
          name: parsed.event.name ?? previousCandidate?.name ?? null,
          symbol: parsed.event.symbol ?? previousCandidate?.symbol ?? null,
          firstSeenAt: previousCandidate?.firstSeenAt ?? parsed.event.receivedAt,
          lastSeenAt: parsed.event.receivedAt,
          latestKind: parsed.event.kind,
          latestSignature: parsed.event.signature ?? previousCandidate?.latestSignature ?? null
        });
        if (result.outcome === "OVERFLOW") await this.appendAudit("DATA_GAP", parsed.event.mint, {
          reason: "DISCOVERY_CANDIDATE_CAP_REACHED", cap: MAX_CANDIDATES
        });
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
        this.auditInBackground("ERROR", null, { subsystem: "PUMPPORTAL_WEBSOCKET", message: this.status.lastError });
        void this.persist().catch(() => undefined);
      });
    } catch {
      this.socket = null;
      this.status.connected = false;
      this.status.subscriptionsSent = false;
      this.connectingSinceMs = 0;
      this.status.lastError = "Unable to create the PumpPortal WebSocket connection.";
      this.auditInBackground("ERROR", null, { subsystem: "PUMPPORTAL_CONNECT", message: this.status.lastError });
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
        this.auditInBackground("PROVIDER_STATUS", null, { provider: "helius", status: "CONNECTED" });
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
            this.auditInBackground("DATA_GAP", failed?.mint ?? null, {
              provider: "helius", reason: "SUBSCRIPTION_REJECTED", requestId: record.id,
              error: jsonSafe(record.error)
            });
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
        if (result.outcome === "OVERFLOW" || result.outcome === "INVALID" ||
            result.outcome === "UNKNOWN_SUBSCRIPTION") this.status.incompleteHeliusTransactions += 1;
        if (result.outcome === "FAILED") this.status.failedHeliusTransactions += 1;
        if (result.outcome !== "QUEUED") {
          const gap = result.outcome === "OVERFLOW" || result.outcome === "INVALID" ||
            result.outcome === "UNKNOWN_SUBSCRIPTION";
          this.auditInBackground(gap ? "DATA_GAP" : "OBSERVATION", this.heliusState.subscriptions
            .find(item => item.subscriptionId === subscriptionId)?.mint ?? null, {
              provider: "helius", notificationOutcome: result.outcome,
              signature: notification.signature, slot: notification.slot,
              subscriptionId, queueLength: this.heliusState.queue.length,
              droppedSignatures: this.heliusState.droppedSignatures,
              duplicateSignatures: this.heliusState.duplicateSignatures,
              reason: gap ? "NOTIFICATION_NOT_QUEUED" : result.outcome
            }, `helius-notification:${notification.signature}:${result.outcome}`);
        }
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
        this.auditInBackground("ERROR", null, { subsystem: "HELIUS_WEBSOCKET", message: this.status.lastError });
        void this.persist().catch(() => undefined);
      });
    } catch {
      this.heliusSocket = null;
      this.status.heliusConnected = false;
      this.heliusConnectedAtMs = 0;
      this.heliusConnectingSinceMs = 0;
      this.status.lastError = "Unable to create the Helius WebSocket connection.";
      this.auditInBackground("ERROR", null, { subsystem: "HELIUS_CONNECT", message: this.status.lastError });
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
          await this.appendAudit("OBSERVATION", work.mint, {
            signature: work.signature, slot: work.slot, transaction: jsonSafe(result.transaction),
            retentionPolicy: "LATEST_2000_TRANSACTION_SNAPSHOT_PLUS_APPEND_ONLY_AUDIT"
          }, `helius:${work.signature}`);
          for (let tradeIndex = 0; tradeIndex < result.transaction.tradeEvents.length; tradeIndex += 1) {
            const trade = result.transaction.tradeEvents[tradeIndex]!;
            const quoteAmount = trade.quoteMint === SOL_QUOTE_MINT
              ? (trade.quoteAmount > 0n ? trade.quoteAmount : trade.solAmount)
              : trade.quoteAmount;
            if (quoteAmount <= 0n || trade.tokenAmount <= 0n) {
              await this.appendAudit("DATA_GAP", work.mint, {
                signature: work.signature, tradeIndex, reason: "TRADE_PRICE_UNAVAILABLE"
              }, `trade-price-missing:${work.signature}:${tradeIndex}`);
              continue;
            }
            await this.recordCandidateTradePrice({
              mint: trade.mint, quoteMint: trade.quoteMint, quoteAmount: quoteAmount.toString(),
              tokenAmount: trade.tokenAmount.toString(), timestamp: new Date(Number(trade.timestamp) * 1000).toISOString(),
              signature: work.signature, isBuy: trade.isBuy
            }, tradeIndex);
          }
          // Strategy evaluation is downstream of raw observation and candidate
          // outcome persistence; an audit-evaluation error must not skip trade tracking.
          await this.recordStrategyAudit(work.signature);
          this.status.verifiedTransactions += 1;
          // Re-rank the six evidence-follow-up slots as verified events arrive.
          // Fresh launches remain protected by the four-slot first-minute reserve.
          this.reconcileHelius();
        } else if (result.status === "FAILED_TRANSACTION") {
          this.status.failedHeliusTransactions += 1;
          await this.appendAudit("OBSERVATION", work.mint, { signature: work.signature, slot: work.slot, status: result.status }, `helius-failed:${work.signature}`);
        } else if (result.status === "DATA_INCOMPLETE") {
          this.status.incompleteHeliusTransactions += 1;
          await this.appendAudit("DATA_GAP", work.mint, { signature: work.signature, slot: work.slot, status: result.status, reason: result.reason }, `helius-incomplete:${work.signature}`);
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
      this.auditInBackground("ERROR", activeWork?.mint ?? null, { subsystem: "HELIUS_QUEUE", message: this.status.lastError });
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
    this.auditInBackground("DATA_GAP", null, { reason: "HELIUS_COVERAGE_INTERRUPTED", affectedMints: newlyIncomplete });
  }

  private markHeliusIncomplete(): void {
    const mint = this.heliusState.queue[0]?.mint;
    this.auditInBackground("DATA_GAP", mint ?? null, { provider: "helius", reason: "INCOMPLETE_NOTIFICATION_OR_QUEUE_ITEM" });
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
    this.auditInBackground("PROVIDER_STATUS", null, {
      provider: "pumpportal", status: "RECONNECT_SCHEDULED",
      attempt: this.status.reconnectAttempts, nextReconnectAt: this.status.nextReconnectAt
    });
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
    if (url.pathname === "/paper-bankroll" && request.method === "GET") {
      return Response.json(await coordinator.getPaperBankroll());
    }
    if (url.pathname === "/paper-portfolio" && request.method === "GET") {
      return Response.json(await coordinator.getPaperPortfolio());
    }
    if (url.pathname === "/paper-equity" && request.method === "POST") {
      let body: unknown;
      try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
      const equityUsd = body && typeof body === "object" ? (body as Record<string, unknown>).equityUsd : null;
      if (typeof equityUsd !== "number" || !Number.isFinite(equityUsd) || equityUsd < 0) return Response.json({ error: "equityUsd must be a finite non-negative number" }, { status: 400 });
      try { return Response.json(await coordinator.recordPaperEquity(equityUsd)); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to record paper equity" }, { status: 409 }); }
    }
    if (url.pathname === "/audit/sessions" && request.method === "GET") {
      return Response.json(await coordinator.listAuditSessions());
    }
    if (url.pathname === "/candidate-outcomes" && request.method === "GET") {
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      const after = Number(url.searchParams.get("after") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "100");
      return Response.json(await coordinator.listCandidateOutcomes(sessionId, after, limit));
    }
    if ((url.pathname === "/audit" || url.pathname === "/audit/export") && request.method === "GET") {
      const after = Number(url.searchParams.get("after") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      const page = await coordinator.listAuditEvents(after, limit, sessionId);
      if (url.pathname === "/audit/export") {
        return new Response(JSON.stringify(page, null, 2) ?? "{}", {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="paper-audit-export-after-${after}.json"`
          }
        });
      }
      return Response.json(page);
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
