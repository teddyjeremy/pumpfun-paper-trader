import { DurableObject } from "cloudflare:workers";
import { createBankrollState, markPaperEquity, replenishPaperBankroll, type BankrollState } from "../../../../src/paper/session-ledger.js";
import { updateCandidatePriceTracker, type CandidatePriceTracker } from "../../../../src/paper/candidate-price-ledger.js";
import { evaluateStrictStrategyAudit, calculateReclaimConfirmation, canRequestExecutableQuote } from "../../../../src/paper/strategy-audit.js";
import {
  closePaperPosition, createPaperPortfolio, markPaperPosition, openPaperPosition,
  type ExecutablePaperQuote, type PaperPortfolioState
} from "../../../../src/paper/portfolio.js";
import {
  commitPaperPortfolioTransition, type PaperTransitionEvent
} from "../../../../src/paper/portfolio-session.js";

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
  recordHeliusCoverageGap, recordHeliusNotificationBoundary, markHeliusCoverageGapRecovered,
  retryHeliusSignatureWork,
  type HeliusMonitorState,
  type HeliusSignatureWork,
  type CandidateMonitoringEvidence
} from "../../../../src/ingestion/helius-monitor.js";
import { TokenBucket } from "../../../../src/ingestion/rpc-budget.js";
import { buildCandidateTradeFlows, isSolQuoteMint, SOL_QUOTE_MINT, type CandidateTradeFlow } from "../../../../src/ingestion/trade-flow.js";
import { fetchCompleteHolderConcentration, type HolderConcentrationResult } from "../../../../src/ingestion/holder-risk.js";
import { buildCandidatePriceVolumeProfiles } from "../../../../src/ingestion/price-volume-profile.js";
import { fetchSolUsdPrice } from "../../../../src/ingestion/sol-usd-price.js";
import { officialPumpSdkModulesAvailable } from "../../../../src/ingestion/pump-sdk-runtime.js";
import { fetchPumpSwapSdkQuote } from "../../../../src/ingestion/pump-sdk-quote-adapter.js";
import { fetchPumpCurveSdkQuote } from "../../../../src/ingestion/pump-sdk-curve-quote-adapter.js";
import {
  createHistoricalBackfillState, fetchHeliusAddressSignaturesPage,
  type HistoricalBackfillState
} from "../../../../src/ingestion/helius-backfill.js";
import { assessHistoricalDecodeCoverage } from "../../../../src/ingestion/helius-backfill-coverage.js";
import { assessHeliusGapRecovery } from "../../../../src/ingestion/helius-gap-recovery.js";
import { fetchHeliusGapAddressHistory, type HeliusGapHistoryResume } from "../../../../src/ingestion/helius-gap-history.js";
import { enqueueHistoricalBackfillSignatures } from "../../../../src/ingestion/helius-backfill-queue.js";
import { evaluateCreatorSellRisk } from "../../../../src/ingestion/creator-risk.js";
import { classifyWalletClusterRiskWithCoverage, evaluateWalletClusterRisk, type WalletHoldingEvidence, type WalletLinkEvidence } from "../../../../src/ingestion/wallet-cluster-risk.js";
import { collectCompleteWalletFundingEvidence, type CompleteWalletFundingEvidenceResult } from "../../../../src/ingestion/complete-wallet-history.js";
import { collectCompleteWalletTransactionHistory, type CompleteWalletTransactionHistoryResult } from "../../../../src/ingestion/complete-wallet-transaction-history.js";
import { normalizeFullWalletHistoryMaxPages, selectFullWalletHistoryScope } from "../../../../src/ingestion/full-wallet-history-budget.js";
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
import {
  createPumpCurveOfflineQuoteFetcher, createPumpSwapOfflineQuoteFetcher,
  createPumpUnsignedPlanFeeEvidenceBuilder, fetchExecutableRoundTripQuote
} from "../../../../src/ingestion/executable-quote-service.js";
import { deriveNonSigningVirtualTraderIdentity } from "../../../../src/ingestion/virtual-trader-identity.js";
import { getFreshExecutableQuoteCostPct } from "../../../../src/ingestion/executable-quote-eligibility.js";
import { parseReviewedVolumeThresholds } from "../../../../src/strategy/reviewed-volume-thresholds.js";
import { evaluateTradingReadiness } from "../../../../src/paper/trading-readiness.js";
import {
  executePaperExit
} from "../../../../src/paper/exit-lifecycle.js";
import { createUnverifiedMarketState } from "../../../../src/paper/pump-market-state.js";
import { refreshPumpMarketStateFromHelius } from "../../../../src/ingestion/helius-pump-market.js";
import { buildPumpCurveExitWindowEvidence } from "../../../../src/strategy/pump-curve-exit-window-evidence.js";
import { buildExecutablePaperQuote } from "../../../../src/ingestion/executable-paper-quote.js";
import { canCommitPaperEntry } from "../../../../src/paper/paper-entry-readiness.js";
import { authorizePaperEntryFromVerifiedPlan } from "../../../../src/ingestion/paper-entry-authorization.js";
import type { UnsignedInstructionFeeEvidence } from "../../../../src/ingestion/solana-fee-estimator.js";

interface Env {
  COORDINATOR: DurableObjectNamespace<PumpFunCoordinator>;
  CONTROL_TOKEN: string;
  HELIUS_API_KEY: string;
  PAPER_EVENT_INGEST_URL?: string;
  PAPER_EVENT_INGEST_TOKEN?: string;
  PAPER_EVENT_INGEST_TOKEN_V2?: string;
  FULL_WALLET_HISTORY_ENABLED?: string;
  FULL_WALLET_HISTORY_MAX_PAGES?: string;
  REVIEWED_VOLUME_THRESHOLDS_JSON?: string;
}

interface WalletLinkEvidenceSnapshot {
  provider: "helius";
  mint: string;
  status: "OBSERVED" | "DATA_INCOMPLETE";
  coverage: "FULL_WALLET_HISTORY" | "FULL_SOL_TRANSFER_HISTORY" | "INCOMPLETE";
  dataComplete: boolean;
  walletSetComplete: boolean;
  requestedWallets: string[];
  walletsCovered: string[];
  walletsRequested: number;
  walletsChecked: number;
  transactionsChecked: number;
  pagesScanned: number;
  estimatedCredits: number;
  links: WalletLinkEvidence[];
  warnings: string[];
  observedAt: string;
  fundingEvidence: CompleteWalletFundingEvidenceResult;
  fullWalletHistory: CompleteWalletTransactionHistoryResult | null;
}

interface CoordinatorStatus {
  mode: "paper";
  provider: "pumpportal";
  connected: boolean;
  subscriptionsSent: boolean;
  enabled: boolean;
  tradingReady: boolean;
  readinessBlockers: string[];
  quoteSdkModules: { curve: boolean; pumpSwap: boolean };
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
  readinessBlockers: ["Coordinator is stopped.", "No active paper session."],
  quoteSdkModules: officialPumpSdkModulesAvailable(),
  blocker: "Coordinator is stopped; runtime paper-trading readiness has not been established.",
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
  private verifiedTransactions: Array<VerifiedPumpTransaction & { receivedAt?: string }> = [];
  private walletLinkSnapshots: Record<string, WalletLinkEvidenceSnapshot> = {};
  private walletHoldingsByMint: Record<string, WalletHoldingEvidence[]> = {};
  private holderRiskSnapshots: Record<string, HolderConcentrationResult> = {};
  private riskEvidenceAttemptedAtByMint: Record<string, number> = {};
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
  private postgresFlushInFlight = false;
  private postgresLeaseHeld = false;
  private readonly postgresLeaseOwnerId: string;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.env = env;
    this.postgresLeaseOwnerId = ctx.id?.toString() ?? "paper-coordinator-test";
  }
  private readonly env: Env;


  private get postgresIngestConfigured(): boolean {
    return Boolean(this.env.PAPER_EVENT_INGEST_URL && (this.env.PAPER_EVENT_INGEST_TOKEN_V2 || this.env.PAPER_EVENT_INGEST_TOKEN));
  }

  private async postPostgresIngest(path: string, body: unknown): Promise<Response> {
    const baseUrl = this.env.PAPER_EVENT_INGEST_URL;
    const token = this.env.PAPER_EVENT_INGEST_TOKEN_V2 || this.env.PAPER_EVENT_INGEST_TOKEN;
    if (!baseUrl || !token) throw new Error("PostgreSQL event ingestion is not configured.");
    const url = new URL(path, baseUrl).toString();
    return fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    });
  }

  private async acquirePostgresWorkerLease(): Promise<void> {
    if (!this.env.PAPER_EVENT_INGEST_URL && !(this.env.PAPER_EVENT_INGEST_TOKEN_V2 || this.env.PAPER_EVENT_INGEST_TOKEN)) return;
    if (!this.postgresIngestConfigured) {
      throw new Error("PAPER_EVENT_INGEST_URL and PAPER_EVENT_INGEST_TOKEN must both be configured.");
    }
    const response = await this.postPostgresIngest("/internal/worker-lease", {
      action: "acquire", leaseName: "pumpfun-paper-trader-coordinator",
      ownerId: this.postgresLeaseOwnerId, ttlSeconds: 120
    });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const payload = await response.json() as { error?: unknown; detail?: unknown };
        const message = typeof payload.detail === "string" ? payload.detail :
          typeof payload.error === "string" ? payload.error : "";
        if (message) detail += `: ${message.slice(0, 180)}`;
      } catch {
        // Keep the bounded status-only diagnostic when the API body is not JSON.
      }
      throw new Error(`PostgreSQL worker lease request failed (${detail}).`);
    }
    const result = await response.json() as { acquired?: boolean };
    if (result.acquired !== true) {
      throw new Error("PostgreSQL worker lease was not acquired; another coordinator may hold the unexpired lease.");
    }
    this.postgresLeaseHeld = true;
    await this.ctx.storage.setAlarm(Date.now() + 15_000);
  }

  private async heartbeatPostgresWorkerLease(): Promise<boolean> {
    if (!this.postgresLeaseHeld) return true;
    try {
      const response = await this.postPostgresIngest("/internal/worker-lease", {
        action: "heartbeat", leaseName: "pumpfun-paper-trader-coordinator",
        ownerId: this.postgresLeaseOwnerId, ttlSeconds: 120
      });
      if (!response.ok) {
        this.status.lastError = `PostgreSQL worker lease heartbeat was rejected (HTTP ${response.status}).`;
        return false;
      }
      const result = await response.json() as { acquired?: boolean };
      if (result.acquired !== true) {
        this.status.lastError = "PostgreSQL worker lease heartbeat was not acknowledged by its current owner.";
        return false;
      }
      return true;
    } catch (error) {
      this.status.lastError = error instanceof Error
        ? `PostgreSQL worker lease heartbeat failed: ${error.message.slice(0, 160)}`
        : "PostgreSQL worker lease heartbeat failed due to a network error.";
      return false;
    }
  }

  private async releasePostgresWorkerLease(): Promise<void> {
    if (!this.postgresLeaseHeld) return;
    try {
      const response = await this.postPostgresIngest("/internal/worker-lease", {
        action: "release", leaseName: "pumpfun-paper-trader-coordinator",
        ownerId: this.postgresLeaseOwnerId
      });
      if (!response.ok) throw new Error("PostgreSQL worker lease release was rejected.");
      const result = await response.json() as { released?: boolean };
      if (result.released !== true) throw new Error("PostgreSQL worker lease was not released by its owner.");
    } finally {
      this.postgresLeaseHeld = false;
    }
  }

  private async flushAuditEventsToPostgres(sessionId: string): Promise<void> {
    if (!this.postgresIngestConfigured || this.postgresFlushInFlight) return;
    const retryKey = "postgres_event_flush_retry_at_ms";
    const retryAt = await this.ctx.storage.get<number>(retryKey) ?? 0;
    if (Date.now() < retryAt) return;
    this.postgresFlushInFlight = true;
    try {
      const cursorKey = `postgres_sync_sequence:${sessionId}`;
      const cursor = await this.ctx.storage.get<number>(cursorKey) ?? 0;
      const events: StoredAuditEvent[] = [];
      let pageNumber = Math.floor(cursor / AUDIT_PAGE_SIZE);
      while (events.length < AUDIT_PAGE_SIZE) {
        const pageKey = `audit_events:${sessionId}:${String(pageNumber).padStart(8, "0")}`;
        const page = await this.ctx.storage.get<StoredAuditEvent[]>(pageKey) ?? [];
        const remaining = page.filter(event => event.sequence > cursor)
          .slice(0, AUDIT_PAGE_SIZE - events.length);
        events.push(...remaining);
        if (events.length >= AUDIT_PAGE_SIZE || page.length < AUDIT_PAGE_SIZE || remaining.length === 0) break;
        pageNumber++;
      }
      if (events.length === 0) return;
      // Repair only missing identity metadata from older outbox entries. The
      // deterministic fallback event ID makes retries idempotent.
      const normalizedEvents = events.map(event => ({
        ...event,
        sessionId,
        eventId: typeof event.eventId === "string" && event.eventId.trim()
          ? event.eventId : `recovered:${sessionId}:${event.sequence}`,
        mint: event.mint ?? null,
        strategyVersion: typeof event.strategyVersion === "string" && event.strategyVersion.trim()
          ? event.strategyVersion : "paper-strategy-v1"
      }));
      const response = await this.postPostgresIngest("/internal/paper-events", {
        sessionId, events: normalizedEvents
      });
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const payload = await response.json() as { error?: unknown; detail?: unknown };
          const message = typeof payload.detail === "string" ? payload.detail :
            typeof payload.error === "string" ? payload.error : "";
          if (message) detail += `: ${message.slice(0, 140)}`;
        } catch {
          // Keep a bounded HTTP-only diagnostic for non-JSON responses.
        }
        throw new Error(detail);
      }
      const result = await response.json() as { ok?: boolean; lastSequence?: number };
      const lastEvent = normalizedEvents[normalizedEvents.length - 1];
      if (!lastEvent || result.ok !== true || !Number.isSafeInteger(result.lastSequence) ||
          (result.lastSequence as number) < lastEvent.sequence) {
        throw new Error("PostgreSQL did not acknowledge the complete paper audit batch.");
      }
      await this.ctx.storage.put(cursorKey, lastEvent.sequence);
      await this.ctx.storage.delete(retryKey);
      if (this.status.lastError?.startsWith("Paper event ingestion failed")) {
        this.status.lastError = null;
      }
      const meta = await this.ctx.storage.get<AuditSessionMeta>(`audit_session:${sessionId}`);
      if (meta && meta.eventCount > lastEvent.sequence) {
        await this.ctx.storage.setAlarm(Date.now() + 1_000);
      }
    } catch (error) {
      // The durable audit pages are the outbox. Do not advance the cursor on
      // failure; a retry is safe because PostgreSQL deduplicates event ids.
      const detail = error instanceof Error ? error.message.slice(0, 180) : "unknown persistence error";
      this.status.lastError = `Paper event ingestion failed (${detail}); durable outbox will retry.`;
      const nextRetryAt = Date.now() + 15_000;
      await this.ctx.storage.put(retryKey, nextRetryAt);
      await this.ctx.storage.setAlarm(nextRetryAt).catch(() => undefined);
    } finally {
      this.postgresFlushInFlight = false;
    }
  }

  private async markHistoricalDecodeIncomplete(work: Pick<HeliusSignatureWork, "signature" | "mint">, reason: string): Promise<void> {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    const state = await this.ctx.storage.get<HistoricalBackfillState>(
      `helius_backfill:${sessionId}:${work.mint}`
    );
    if (!state?.signatures.some(item => item.signature === work.signature)) return;
    await this.ctx.storage.put(`helius_backfill_decode_incomplete:${sessionId}:${work.mint}`, {
      signature: work.signature, reason, updatedAt: new Date().toISOString()
    });
  }

  private async recordVerifiedHistoricalSignature(transaction: VerifiedPumpTransaction): Promise<void> {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    const state = await this.ctx.storage.get<HistoricalBackfillState>(
      `helius_backfill:${sessionId}:${transaction.mint}`
    );
    if (!state?.signatures.some(item => item.signature === transaction.signature)) return;
    const transactionKey = `helius_verified_historical_transactions:${sessionId}:${transaction.mint}`;
    const transactions = await this.ctx.storage.get<Record<string, VerifiedPumpTransaction>>(transactionKey) ?? {};
    transactions[transaction.signature] = transaction;
    await this.ctx.storage.put(transactionKey, transactions);
    const key = `helius_verified_historical_signatures:${sessionId}:${transaction.mint}`;
    const signatures = new Set(await this.ctx.storage.get<string[]>(key) ?? []);
    signatures.add(transaction.signature);
    await this.ctx.storage.put(key, [...signatures].slice(-500));
  }

  private async recordFailedHistoricalSignature(work: HeliusSignatureWork): Promise<void> {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    const state = await this.ctx.storage.get<HistoricalBackfillState>(
      `helius_backfill:${sessionId}:${work.mint}`
    );
    if (!state?.signatures.some(item => item.signature === work.signature)) return;
    const key = `helius_failed_historical_signatures:${sessionId}:${work.mint}`;
    const signatures = new Set(await this.ctx.storage.get<string[]>(key) ?? []);
    signatures.add(work.signature);
    await this.ctx.storage.put(key, [...signatures].slice(-500));
  }

  private async getHistoricalDecodeCoverage(
    sessionId: string,
    mint: string,
    state: HistoricalBackfillState
  ): Promise<{ complete: boolean; reason: string | null; verifiedTransactionCount: number }> {
    const cursor = await this.ctx.storage.get<number>(
      `helius_backfill_queue_cursor:${sessionId}:${mint}`
    ) ?? 0;
    const verifiedKey = `helius_verified_historical_signatures:${sessionId}:${mint}`;
    const expectedSignatures = new Set(state.signatures.map(item => item.signature));
    const verified = new Set(await this.ctx.storage.get<string[]>(verifiedKey) ?? []);
    const transactionKey = `helius_verified_historical_transactions:${sessionId}:${mint}`;
    const storedTransactions = await this.ctx.storage.get<Record<string, VerifiedPumpTransaction>>(transactionKey) ?? {};
    for (const signature of Object.keys(storedTransactions)) {
      if (!expectedSignatures.has(signature)) {
        return {
          complete: false,
          reason: "Stored historical transactions contain a signature outside the verified backfill window.",
          verifiedTransactionCount: 0
        };
      }
      verified.add(signature);
    }
    for (const transaction of this.verifiedTransactions) {
      if (transaction.mint === mint && expectedSignatures.has(transaction.signature)) {
        verified.add(transaction.signature);
      }
    }
    if (verified.size > 0) await this.ctx.storage.put(verifiedKey, [...verified].slice(-500));
    const failedKey = `helius_failed_historical_signatures:${sessionId}:${mint}`;
    const failed = new Set(await this.ctx.storage.get<string[]>(failedKey) ?? []);
    const archivedKey = `helius_archived_transaction_signatures:${sessionId}:${mint}`;
    const archived = new Set(await this.ctx.storage.get<string[]>(archivedKey) ?? []);
    const legacyArchived = new Set(await this.ctx.storage.get<string[]>(
      `helius_archived_transaction_signatures:${sessionId}`
    ) ?? []);
    for (const signature of state.signatures) {
      if (legacyArchived.has(signature.signature)) archived.add(signature.signature);
    }
    const failure = await this.ctx.storage.get<{ reason?: string }>(
      `helius_backfill_decode_incomplete:${sessionId}:${mint}`
    );
    const queueSignatures = this.heliusState.queue
      .filter(work => work.mint === mint)
      .map(work => work.signature);
    try {
      return assessHistoricalDecodeCoverage({
        state, queueCursor: cursor, queueSignatures,
        verifiedSignatures: [...verified], failedSignatures: [...failed],
        archivedSignatures: [...archived], incompleteReason: failure?.reason ?? null
      });
    } catch (error) {
      return {
        complete: false,
        reason: error instanceof Error
          ? `Historical decode evidence is inconsistent: ${error.message}`
          : "Historical decode evidence is inconsistent.",
        verifiedTransactionCount: 0
      };
    }
  }

  private async archiveVerifiedHistoricalTransaction(transaction: VerifiedPumpTransaction): Promise<void> {
    const sessionId = this.activeSessionId;
    if (!this.postgresIngestConfigured || !sessionId) return;
    const state = await this.ctx.storage.get<HistoricalBackfillState>(
      `helius_backfill:${sessionId}:${transaction.mint}`
    );
    const historicalSignature = state?.signatures.find(item => item.signature === transaction.signature);
    if (!state) return;
    if (historicalSignature && historicalSignature.slot !== transaction.slot) {
      await this.markHistoricalDecodeIncomplete({
        signature: transaction.signature, mint: transaction.mint
      }, "Verified transaction slot conflicts with historical signature evidence.");
      return;
    }
    const globalKey = `helius_archived_transaction_signatures:${sessionId}`;
    const global = new Set(await this.ctx.storage.get<string[]>(globalKey) ?? []);
    const mintKey = `helius_archived_transaction_signatures:${sessionId}:${transaction.mint}`;
    const mintArchived = new Set(await this.ctx.storage.get<string[]>(mintKey) ?? []);
    if (global.has(transaction.signature) || (historicalSignature && mintArchived.has(transaction.signature))) return;
    try {
      const decodeCoverage = await this.getHistoricalDecodeCoverage(sessionId, transaction.mint, state);
      const response = await this.postPostgresIngest("/internal/helius-backfill", {
        sessionId, mint: transaction.mint, state, decodeCoverage,
        transaction: {
          ...jsonSafe(transaction) as Record<string, unknown>,
          provider: "helius", commitment: "confirmed",
          receivedAt: transaction.receivedAt ?? new Date().toISOString(),
          source: historicalSignature ? "HISTORICAL_BACKFILL" : "LIVE_MONITOR"
        }
      });
      if (!response.ok) throw new Error("Historical transaction archive was not acknowledged.");
      global.add(transaction.signature);
      await this.ctx.storage.put(globalKey, [...global].slice(-5_000));
      if (historicalSignature) {
        mintArchived.add(transaction.signature);
        await this.ctx.storage.put(mintKey, [...mintArchived].slice(-500));
        const verifiedKey = `helius_verified_historical_signatures:${sessionId}:${transaction.mint}`;
        const verified = new Set(await this.ctx.storage.get<string[]>(verifiedKey) ?? []);
        verified.add(transaction.signature);
        await this.ctx.storage.put(verifiedKey, [...verified].slice(-500));
        const transactionKey = `helius_verified_historical_transactions:${sessionId}:${transaction.mint}`;
        const pendingTransactions = await this.ctx.storage.get<Record<string, VerifiedPumpTransaction>>(transactionKey) ?? {};
        delete pendingTransactions[transaction.signature];
        await this.ctx.storage.put(transactionKey, pendingTransactions);
      }
    } catch {
      this.status.lastError = "Verified historical transaction is waiting for PostgreSQL persistence.";
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }

  private async flushHeliusBackfillArchivesToPostgres(sessionId: string | null = this.activeSessionId): Promise<void> {
    if (!this.postgresIngestConfigured || !sessionId) return;
    const listKey = `helius_backfill_mints:${sessionId}`;
    const mints = await this.ctx.storage.get<string[]>(listKey) ?? [];
    for (const mint of mints) {
      const state = await this.ctx.storage.get<HistoricalBackfillState>(`helius_backfill:${sessionId}:${mint}`);
      if (!state) continue;
      try {
        const decodeCoverage = await this.getHistoricalDecodeCoverage(sessionId, mint, state);
        const response = await this.postPostgresIngest("/internal/helius-backfill", {
          sessionId, mint, state, decodeCoverage
        });
        if (!response.ok) throw new Error("Archive checkpoint was not acknowledged.");
      } catch {
        this.status.lastError = "Helius backfill archive is waiting for PostgreSQL persistence.";
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
        return;
      }
    }
    const archivedKey = `helius_archived_transaction_signatures:${sessionId}`;
    const archived = new Set(await this.ctx.storage.get<string[]>(archivedKey) ?? []);
    const transactionsToArchive = new Map<string, VerifiedPumpTransaction & { receivedAt?: string }>();
    for (const mint of mints) {
      const stored = await this.ctx.storage.get<Record<string, VerifiedPumpTransaction>>(
        `helius_verified_historical_transactions:${sessionId}:${mint}`
      ) ?? {};
      for (const transaction of Object.values(stored)) {
        transactionsToArchive.set(transaction.signature, transaction);
      }
    }
    for (const transaction of this.verifiedTransactions) {
      transactionsToArchive.set(transaction.signature, transaction);
    }
    for (const transaction of transactionsToArchive.values()) {
      if (archived.has(transaction.signature)) continue;
      const transactionState = await this.ctx.storage.get<HistoricalBackfillState>(
        `helius_backfill:${sessionId}:${transaction.mint}`
      );
      if (!transactionState) continue;
      await this.archiveVerifiedHistoricalTransaction(transaction);
      const acknowledged = new Set(await this.ctx.storage.get<string[]>(archivedKey) ?? []);
      if (!acknowledged.has(transaction.signature)) {
        // Keep the durable per-mint transaction record for the next alarm.
        return;
      }
      archived.add(transaction.signature);
    }
    for (const mint of mints) {
      const state = await this.ctx.storage.get<HistoricalBackfillState>(`helius_backfill:${sessionId}:${mint}`);
      if (!state) continue;
      try {
        const decodeCoverage = await this.getHistoricalDecodeCoverage(sessionId, mint, state);
        const response = await this.postPostgresIngest("/internal/helius-backfill", {
          sessionId, mint, state, decodeCoverage
        });
        if (!response.ok) throw new Error("Final decode coverage checkpoint was not acknowledged.");
      } catch {
        this.status.lastError = "Helius decode coverage is waiting for PostgreSQL acknowledgement.";
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
        return;
      }
    }
  }

  private async flushAllHeliusBackfillArchivesToPostgres(): Promise<void> {
    // The bounded verifiedTransactions snapshot belongs only to the active
    // session. Older sessions are flushed when stopped; never attribute the
    // current session's transactions to a previous session's backfill job.
    if (!this.activeSessionId) return;
    await this.flushHeliusBackfillArchivesToPostgres(this.activeSessionId);
  }

  private async flushAllAuditSessionsToPostgres(): Promise<void> {
    if (!this.postgresIngestConfigured) return;
    const sessions = await this.ctx.storage.get<string[]>("audit_session_ids") ?? [];
    for (const sessionId of sessions) await this.flushAuditEventsToPostgres(sessionId);
  }

  /**
   * Scheduled, paper-only protective exit pass. Each position is refreshed
   * against authoritative curve/pool accounts and quoted for its full balance.
   * Incomplete market/fee evidence leaves the position open and records a
   * blocker; no signing or transaction submission exists in this path.
   */
  private async runScheduledPaperExitCycle(): Promise<void> {
    const sessionId = this.activeSessionId;
    if (!sessionId || !this.status.enabled || !this.postgresLeaseHeld ||
        !this.env.HELIUS_API_KEY) return;
    const portfolio = await this.getPaperPortfolio() as PaperPortfolioState | null;
    const openPositions = portfolio?.positions.filter(position => position.status !== "CLOSED") ?? [];
    if (openPositions.length === 0) return;
    const flowReport = await this.listTradeFlows() as { flows: CandidateTradeFlow[] };

    const config = { apiKey: this.env.HELIUS_API_KEY, commitment: "confirmed" as const };
    const identity = await deriveNonSigningVirtualTraderIdentity();
    const computeUnitLimit = 1_400_000;
    const buildExactFeeEvidence = createPumpUnsignedPlanFeeEvidenceBuilder({
      identity, config, computeUnitLimit
    });
    const heldSellQuotes = new Map<string, ExecutablePaperQuote>();
    for (const position of openPositions) {
      if (position.status !== "OPEN") {
        await this.appendAudit("ERROR", position.mint, {
          stage: "SCHEDULED_PAPER_EXIT",
          reason: "Position is already EXIT_BLOCKED; manual or explicit recovery is required before quoting."
        }, `paper-exit-status-blocked:${sessionId}:${position.positionId}`);
        continue;
      }
      try {
        // Fetch the slower USD reference first; refresh authoritative market
        // accounts immediately before the short-lived full-balance sell quote.
        const solUsdResult = await fetchSolUsdPrice({ nowMs: Date.now() });
        if (solUsdResult.status !== "AVAILABLE") {
          throw new Error(`SOL/USD reference unavailable: ${solUsdResult.reason}`);
        }
        const marketState = await refreshPumpMarketStateFromHelius({
          state: createUnverifiedMarketState(position.mint),
          config
        });
        await this.ctx.storage.put(`paper_market_state:${sessionId}:${position.mint}`, marketState);
        const marketQuoteMint = marketState.status === "LIVE_CURVE"
          ? marketState.curve?.quoteMint
          : marketState.pool?.quoteMint;
        const flow = flowReport.flows.find(item =>
          item.mint === position.mint && item.quoteMint === marketQuoteMint
        ) ?? null;
        const exitWindows = buildPumpCurveExitWindowEvidence({
          marketState, flow, transactions: this.verifiedTransactions
        });
        if (marketState.status === "MIGRATED_POOL_VERIFIED" && exitWindows.length === 0) {
          // Do not relabel bonding-curve TradeEvents as PumpSwap observations.
          // Until the deployed PumpSwap event layout is independently verified,
          // dynamic exhaustion is unavailable after migration; the fresh
          // full-position quote and hard/protective stops below remain active.
          await this.appendAudit("ERROR", position.mint, {
            stage: "MIGRATED_MARKET_DYNAMIC_EXIT_EVIDENCE",
            reason: "PumpSwap dynamic-exhaustion evidence is unavailable; only executable hard/protective stops can trigger an exit.",
            marketVenue: "PUMPSWAP",
            marketUpdatedAt: marketState.updatedAt
          }, `pumpswap-dynamic-exit-evidence-unavailable:${sessionId}:${position.positionId}`);
        }
        if (marketState.status !== "LIVE_CURVE" &&
            marketState.status !== "MIGRATED_POOL_VERIFIED") {
          await this.appendAudit("ERROR", position.mint, {
            stage: "SCHEDULED_PAPER_EXIT_MARKET_VERIFICATION",
            status: marketState.status, reason: marketState.reason
          }, `paper-exit-market-blocked:${sessionId}:${position.positionId}:${marketState.updatedAt}`);
          continue;
        }

        const quoteFetcher = marketState.status === "LIVE_CURVE"
          ? createPumpCurveOfflineQuoteFetcher({ mint: position.mint, config })
          : createPumpSwapOfflineQuoteFetcher({
              mint: position.mint, poolAddress: marketState.pool!.poolAddress, config
            });
        const result = await executePaperExit({
          position, marketState, windows: exitWindows,
          quoteSell: async ({ tokenAmountBaseUnits }) => {
            const quote = await quoteFetcher({
              side: "SELL", amountBaseUnits: tokenAmountBaseUnits
            });
            const feeEvidence = await buildExactFeeEvidence({ side: "SELL", quote });
            if (feeEvidence.status !== "AVAILABLE") {
              throw new Error(`Exact sell-message fee evidence unavailable: ${feeEvidence.reason}`);
            }
            return {
              quote,
              context: {
                solUsd: solUsdResult.observation,
                costs: {
                  networkFeeLamports: feeEvidence.estimate.networkFeeLamports,
                  priorityFeeLamports: feeEvidence.estimate.priorityFeeLamports,
                  providerFeeUsd: 0,
                  simulatedLatencyMs: 250,
                  quoteTtlMs: 2_000
                }
              }
            };
          },
          // Defer the complete-portfolio mark until every still-open position
          // has a fresh quote. A partial mark is never committed.
          commitMark: async ({ positionId, sellQuote }) => {
            heldSellQuotes.set(positionId, sellQuote);
            return { status: "DEFERRED_UNTIL_COMPLETE_PORTFOLIO_MARK" };
          },
          commitExit: input => this.recordPaperExit(input)
        });
        if (result.status === "BLOCKED") {
          await this.appendAudit("ERROR", position.mint, {
            stage: "SCHEDULED_PAPER_EXIT", status: result.status, reason: result.reason
          }, `paper-exit-blocked:${sessionId}:${position.positionId}:${Date.now()}`);
        }
      } catch (error) {
        await this.appendAudit("ERROR", position.mint, {
          stage: "SCHEDULED_PAPER_EXIT_CYCLE",
          reason: error instanceof Error ? error.message : "Scheduled paper exit failed closed."
        }, `paper-exit-cycle-error:${sessionId}:${position.positionId}:${Date.now()}`);
      }
    }

    const latestPortfolio = await this.getPaperPortfolio() as PaperPortfolioState | null;
    const remainingOpen = latestPortfolio?.positions.filter(position => position.status !== "CLOSED") ?? [];
    if (remainingOpen.length > 0 &&
        remainingOpen.every(position => heldSellQuotes.has(position.positionId))) {
      await this.recordPaperMark({
        sellQuotes: remainingOpen.map(position => heldSellQuotes.get(position.positionId)!)
      });
    }
    this.ctx.waitUntil(this.flushAuditEventsToPostgres(sessionId));
  }

  async alarm(): Promise<void> {
    await this.hydrate();
    // The Durable Object's alarm survives eviction, but in-memory lease state
    // does not. Reacquire the PostgreSQL fencing lease before resuming work.
    if (this.status.enabled && this.postgresIngestConfigured && !this.postgresLeaseHeld) {
      try {
        await this.acquirePostgresWorkerLease();
      } catch {
        this.status.lastError = "PostgreSQL worker lease could not be reacquired after restart; coordinator stopped fail-closed.";
        await this.stop();
        return;
      }
    }
    if (this.status.enabled && this.postgresLeaseHeld) {
      const leaseValid = await this.heartbeatPostgresWorkerLease();
      if (!leaseValid) {
        this.postgresLeaseHeld = false;
        this.status.lastError = this.status.lastError.startsWith("PostgreSQL worker lease heartbeat")
          ? `${this.status.lastError}; coordinator stopped fail-closed.`
          : "PostgreSQL worker lease lost; coordinator stopped fail-closed.";
        await this.stop();
        return;
      }
    }
    if (this.status.enabled && this.postgresLeaseHeld) {
      await this.drainHeliusQueue();
      const leaseAfterDrain = await this.heartbeatPostgresWorkerLease();
      if (!leaseAfterDrain) {
        this.postgresLeaseHeld = false;
        this.status.lastError = this.status.lastError.startsWith("PostgreSQL worker lease heartbeat")
          ? `${this.status.lastError}; coordinator stopped fail-closed.`
          : "PostgreSQL worker lease lost after Helius queue processing; coordinator stopped fail-closed.";
        await this.stop();
        return;
      }
      try {
        await this.runScheduledPaperExitCycle();
      } catch (error) {
        this.status.lastError = error instanceof Error
          ? error.message : "Scheduled paper exit cycle failed.";
        await this.appendAudit("ERROR", null, {
          stage: "SCHEDULED_PAPER_EXIT_CYCLE",
          reason: this.status.lastError
        }, `paper-exit-cycle-failure:${Date.now()}`);
      }
    }
    await this.flushAllAuditSessionsToPostgres();
    await this.flushAllHeliusBackfillArchivesToPostgres();
    if (this.status.enabled && this.postgresLeaseHeld) {
      const leaseAfterPersistence = await this.heartbeatPostgresWorkerLease();
      if (!leaseAfterPersistence) {
        this.postgresLeaseHeld = false;
        this.status.lastError = this.status.lastError.startsWith("PostgreSQL worker lease heartbeat")
          ? `${this.status.lastError}; coordinator stopped fail-closed.`
          : "PostgreSQL worker lease lost after persistence flush; coordinator stopped fail-closed.";
        await this.stop();
        return;
      }
      const now = Date.now();
      const portfolio = await this.getPaperPortfolio() as PaperPortfolioState | null;
      const hasOpenPositions = Boolean(portfolio?.positions.some(position => position.status !== "CLOSED"));
      const hasPendingHeliusQueue = this.heliusState.queue.length > 0;
      const nextCycleDelayMs = hasPendingHeliusQueue || hasOpenPositions ? 5_000 : 15_000;
      const pendingRetryAt = this.heliusState.queue
        .map(item => item.retryAfterAt ? Date.parse(item.retryAfterAt) : Number.NaN)
        .filter(at => Number.isFinite(at) && at > now)
        .reduce((earliest, at) => earliest === null ? at : Math.min(earliest, at), null as number | null);
      await this.ctx.storage.setAlarm(Math.min(now + nextCycleDelayMs, pendingRetryAt ?? Number.POSITIVE_INFINITY));
    }
  }

  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    const [savedStatus, savedDiscovery, enabled, savedWalletLinks, savedWalletHoldings, savedHolderRisk, savedRiskAttempts, activeSessionId] = await Promise.all([
      this.ctx.storage.get<CoordinatorStatus>("status"),
      this.ctx.storage.get<DiscoveryStoreState>("discovery_state"),
      this.ctx.storage.get<boolean>("enabled"),
      this.ctx.storage.get<Record<string, WalletLinkEvidenceSnapshot | CompleteWalletFundingEvidenceResult>>("wallet_link_snapshots"),
      this.ctx.storage.get<Record<string, WalletHoldingEvidence[]>>("wallet_holdings_by_mint"),
      this.ctx.storage.get<Record<string, HolderConcentrationResult>>("holder_risk_snapshots"),
      this.ctx.storage.get<Record<string, number>>("risk_evidence_attempted_at_by_mint"),
      this.ctx.storage.get<string>("active_audit_session_id")
    ]);
    if (savedStatus) this.status = { ...INITIAL_STATUS, ...savedStatus };
    this.activeSessionId = activeSessionId ?? null;
    this.walletLinkSnapshots = Object.fromEntries(Object.entries(savedWalletLinks ?? {}).map(([mint, value]) => {
      if ("fundingEvidence" in value) return [mint, value as WalletLinkEvidenceSnapshot];
      const fundingEvidence = value as CompleteWalletFundingEvidenceResult;
      return [mint, {
        provider: "helius" as const, mint,
        status: "DATA_INCOMPLETE" as const, coverage: "FULL_SOL_TRANSFER_HISTORY" as const,
        dataComplete: false, walletSetComplete: false,
        requestedWallets: fundingEvidence.requestedWallets ?? [],
        walletsCovered: fundingEvidence.walletsCovered ?? [],
        walletsRequested: fundingEvidence.walletsRequested,
        walletsChecked: fundingEvidence.walletsChecked,
        transactionsChecked: 0, pagesScanned: fundingEvidence.pagesScanned,
        estimatedCredits: 0, links: fundingEvidence.links,
        warnings: fundingEvidence.warnings, observedAt: fundingEvidence.observedAt,
        fundingEvidence, fullWalletHistory: null
      }];
    }));
    this.walletHoldingsByMint = savedWalletHoldings ?? {};
    this.holderRiskSnapshots = savedHolderRisk ?? {};
    this.riskEvidenceAttemptedAtByMint = savedRiskAttempts ?? {};
    this.heliusState = normalizeHeliusMonitorState(await this.ctx.storage.get<HeliusMonitorState>("helius_monitor_state"));
    this.verifiedTransactions = (await this.ctx.storage.get<Array<VerifiedPumpTransaction & { receivedAt?: string }>>("verified_transactions")) ?? [];
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

  /**
   * Prove the deployed Worker secret can write an isolated, non-trading
   * audit session to Vercel/Neon. This never starts the market streams or
   * creates a position, quote, fill, or transaction.
   */
  async smokeIngestion(): Promise<{
    ok: true; sessionId: string; eventPersisted: true; idempotentReplay: true;
    leaseAcquired: true; leaseHeartbeat: true; leaseRetained: boolean; leaseReleased: boolean;
  }> {
    await this.hydrate();
    if (!this.postgresIngestConfigured) {
      throw new Error("Worker-to-Neon ingestion is not configured.");
    }
    const keepLease = this.status.enabled;
    let stage = "NEON_LEASE_ACQUIRE";
    try {
      await this.acquirePostgresWorkerLease();
      if (!this.postgresLeaseHeld) throw new Error("Worker could not acquire its Neon lease.");
      stage = "NEON_LEASE_HEARTBEAT";
      const heartbeat = await this.heartbeatPostgresWorkerLease();
      if (!heartbeat) throw new Error("Worker Neon lease heartbeat failed.");
      const sessionId = `smoke-test-worker-${crypto.randomUUID()}`;
      const startedAt = new Date().toISOString();
      const stoppedAt = new Date(Date.parse(startedAt) + 1).toISOString();
      const strategyVersion = "smoke-ingestion-v1";
      const events: StoredAuditEvent[] = [
      {
        sessionId, sequence: 1, eventId: `smoke-started:${sessionId}`,
        kind: "SESSION_STARTED", occurredAt: startedAt, mint: null,
        strategyVersion, data: { smokeTest: true, source: "worker-to-neon-ingestion" }
      },
      {
        sessionId, sequence: 2, eventId: `smoke-stopped:${sessionId}`,
        kind: "SESSION_STOPPED", occurredAt: stoppedAt, mint: null,
        strategyVersion, data: { smokeTest: true, source: "worker-to-neon-ingestion" }
      }
    ];

      stage = "AUDIT_EVENT_PERSISTENCE";
      const firstResponse = await this.postPostgresIngest("/internal/paper-events", { sessionId, events });
      if (!firstResponse.ok) throw new Error(`Worker event ingestion was rejected (HTTP ${firstResponse.status}).`);
      const first = await firstResponse.json() as { ok?: boolean; inserted?: number; lastSequence?: number };
      if (first.ok !== true || first.inserted !== 2 || first.lastSequence !== 2) {
        throw new Error("Worker event ingestion did not acknowledge both persisted events.");
      }

      stage = "AUDIT_EVENT_IDEMPOTENCY";
      const replayResponse = await this.postPostgresIngest("/internal/paper-events", { sessionId, events });
      if (!replayResponse.ok) throw new Error(`Worker idempotent event replay was rejected (HTTP ${replayResponse.status}).`);
      const replay = await replayResponse.json() as {
        ok?: boolean; inserted?: number; duplicates?: number; lastSequence?: number;
      };
      if (replay.ok !== true || replay.inserted !== 0 || replay.duplicates !== 2 || replay.lastSequence !== 2) {
        throw new Error("Worker event replay was not idempotent.");
      }
      return {
        ok: true, sessionId, eventPersisted: true, idempotentReplay: true,
        leaseAcquired: true, leaseHeartbeat: true,
        leaseRetained: keepLease, leaseReleased: !keepLease
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown smoke-test failure.";
      throw new Error(`${stage}: ${detail}`);
    } finally {
      if (!keepLease && this.postgresLeaseHeld) await this.releasePostgresWorkerLease();
    }
  }

  async start(): Promise<CoordinatorStatus> {
    await this.hydrate();
    await this.acquirePostgresWorkerLease();
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
      this.holderRiskSnapshots = {};
      this.riskEvidenceAttemptedAtByMint = {};
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
        await txn.put("holder_risk_snapshots", {});
        await txn.put("risk_evidence_attempted_at_by_mint", {});
        await txn.put(`helius_backfill_mints:${sessionId}`, []);
        await txn.put(`paper_bankroll:${sessionId}`, createBankrollState(2.70));
        await txn.put(`paper_portfolio:${sessionId}`, createPaperPortfolio(2.70));
        await txn.put(`audit_events:${sessionId}:00000000`, [firstEvent]);
        await txn.put(`audit_event_id:${sessionId}:session-started:${sessionId}`, 1);
      });
      this.activeSessionId = sessionId;
      this.ctx.waitUntil(this.flushAuditEventsToPostgres(sessionId));
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
      await this.flushAuditEventsToPostgres(completedSessionId);
      await this.flushHeliusBackfillArchivesToPostgres(completedSessionId);
      this.activeSessionId = null;
    }
    await this.persist();
    await this.releasePostgresWorkerLease();
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
    const readiness = evaluateTradingReadiness({
      coordinatorEnabled: this.status.enabled,
      activeSession: Boolean(this.activeSessionId),
      discoveryConnected: this.status.connected,
      discoverySubscribed: this.status.subscriptionsSent,
      heliusConnected: this.status.heliusConnected,
      heliusApiKeyConfigured: Boolean(this.env.HELIUS_API_KEY),
      fullWalletHistoryEnabled: this.env.FULL_WALLET_HISTORY_ENABLED === "true",
      reviewedVolumeThresholdsAvailable: parseReviewedVolumeThresholds(this.env.REVIEWED_VOLUME_THRESHOLDS_JSON) !== null,
      eventIngestConfigured: this.postgresIngestConfigured,
      persistenceLeaseHeld: this.postgresLeaseHeld,
      controlTokenConfigured: Boolean(this.env.CONTROL_TOKEN),
      pumpProgramConfigured: Boolean(this.env.PUMPFUN_PROGRAM_ID),
      quoteSdkModulesAvailable: this.status.quoteSdkModules.curve && this.status.quoteSdkModules.pumpSwap
    });
    this.status.tradingReady = readiness.tradingReady;
    this.status.readinessBlockers = readiness.blockers;
    this.status.blocker = readiness.blockers[0] ??
      "System prerequisites passed; a persistent simulated entry/exit lifecycle still needs verification.";
    return { ...this.status };
  }

  /** Single authenticated snapshot for the operator dashboard; read-only. */
  async getOperatorDashboardSnapshot(): Promise<unknown> {
    await this.hydrate();
    const [status, portfolio, bankroll] = await Promise.all([
      this.getStatus(), this.getPaperPortfolio(), this.getPaperBankroll()
    ]);
    const sessionId = this.activeSessionId ?? await this.ctx.storage.get<string>("latest_audit_session_id");
    const meta = sessionId ? await this.ctx.storage.get<AuditSessionMeta>(`audit_session:${sessionId}`) : undefined;
    const auditPage = meta && sessionId
      ? await this.listAuditEvents(Math.max(0, meta.eventCount - 100), 100, sessionId) as { events?: StoredAuditEvent[] }
      : { events: [] as StoredAuditEvent[] };
    const recentActivity = (auditPage.events ?? [])
      .filter(event => ["STRATEGY_DECISION", "PAPER_ENTRY", "PAPER_EXIT", "REJECTION_REASON", "QUOTE_RESULT"].includes(event.kind))
      .slice(-50).reverse().map(event => ({ ...event, data: jsonSafe(event.data) }));
    return {
      generatedAt: new Date().toISOString(),
      status,
      sessionId,
      portfolio,
      bankroll,
      candidates: this.discovery.candidates.slice(-30).reverse().map(candidate => ({
        mint: candidate.mint, status: candidate.status, firstSeenAt: candidate.firstSeenAt,
        lastSeenAt: candidate.lastSeenAt, observations: candidate.observations
      })),
      recentActivity
    };
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
    const eventId = typeof idempotencyKey === "string" && idempotencyKey.trim().length > 0
      ? idempotencyKey : crypto.randomUUID();
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
        mint: mint ?? null,
        strategyVersion: typeof meta.strategyVersion === "string" && meta.strategyVersion.trim()
          ? meta.strategyVersion : "paper-strategy-v1",
        data: jsonSafe(data) });
      await txn.put(pageKey, page);
      await txn.put(dedupeKey, sequence);
      await txn.put(metaKey, { ...meta, eventCount: sequence });
    });
    this.ctx.waitUntil(this.flushAuditEventsToPostgres(sessionId));
  }


  async recordPaperEntry(input: {
    mint: string; positionId: string; buyQuote: ExecutablePaperQuote; sellQuote: ExecutablePaperQuote;
    rentReserveUsd: number;
  }): Promise<unknown> {
    await this.hydrate();
    const sessionId = this.activeSessionId;
    if (!sessionId) throw new Error("No active paper session.");
    const occurredAt = new Date().toISOString();
    const idempotencyKey = `paper-entry:${input.mint}:${input.buyQuote.quoteId}`;
    return commitPaperPortfolioTransition(this.ctx.storage, {
      sessionId, idempotencyKey, occurredAt, mint: input.mint,
      apply: portfolio => {
        const opened = openPaperPosition(portfolio, { ...input, occurredAt, nowMs: Date.parse(occurredAt) });
        const events: PaperTransitionEvent[] = [{
          kind: "PAPER_ENTRY",
          data: { position: opened.position, buyQuoteId: input.buyQuote.quoteId,
            initialSellQuoteId: input.sellQuote.quoteId,
            // Persist full normalized quote evidence in the append-only event
            // so PostgreSQL can reconstruct fills after a Worker restart.
            buyQuote: input.buyQuote, initialSellQuote: input.sellQuote }
        }];
        if (opened.state.bankroll.topUpCount > portfolio.bankroll.topUpCount) {
          events.push({
            kind: "BANKROLL_TOP_UP" as const,
            data: { topUpCount: opened.state.bankroll.topUpCount,
              totalTopUpsUsd: opened.state.bankroll.totalTopUpsUsd }
          });
        }
        return { state: opened.state, result: opened.position, events };
      }
    });
  }

  async recordPaperExit(input: {
    positionId: string; sellQuote: ExecutablePaperQuote; exitReason: string;
  }): Promise<unknown> {
    await this.hydrate();
    const sessionId = this.activeSessionId;
    if (!sessionId) throw new Error("No active paper session.");
    const occurredAt = new Date().toISOString();
    const idempotencyKey = `paper-exit:${input.positionId}:${input.sellQuote.quoteId}`;
    return commitPaperPortfolioTransition(this.ctx.storage, {
      sessionId, idempotencyKey, occurredAt,
      apply: portfolio => {
        const closed = closePaperPosition(portfolio, { ...input, closedAt: occurredAt, nowMs: Date.parse(occurredAt) });
        const events: PaperTransitionEvent[] = [{
          kind: "PAPER_EXIT",
          mint: closed.position.mint,
          data: { position: closed.position, sellQuoteId: input.sellQuote.quoteId,
            exitReason: input.exitReason, sellQuote: input.sellQuote }
        }];
        if (closed.state.bankroll.topUpCount > portfolio.bankroll.topUpCount) {
          events.push({
            kind: "BANKROLL_TOP_UP" as const,
            mint: closed.position.mint,
            data: { topUpCount: closed.state.bankroll.topUpCount,
              totalTopUpsUsd: closed.state.bankroll.totalTopUpsUsd }
          });
        }
        return { state: closed.state, result: closed.position, events };
      }
    });
  }

  async recordPaperMark(input: {
    sellQuotes: ExecutablePaperQuote[];
  }): Promise<unknown> {
    await this.hydrate();
    const sessionId = this.activeSessionId;
    if (!sessionId) throw new Error("No active paper session.");
    const markedAt = new Date().toISOString();
    const quoteIds = input.sellQuotes.map(quote => quote.quoteId).sort();
    const idempotencyKey = `paper-mark:${markedAt}:${quoteIds.join(",")}`;
    return commitPaperPortfolioTransition(this.ctx.storage, {
      sessionId, idempotencyKey, occurredAt: markedAt,
      apply: portfolio => {
        const marked = markPaperPosition(portfolio, {
          sellQuotes: input.sellQuotes, markedAt, nowMs: Date.parse(markedAt)
        });
        const openPositions = marked.positions.filter(position => position.status !== "CLOSED");
        const liquidationValueUsd = openPositions.reduce((sum, position) =>
          sum + position.latestLiquidationValueUsd, 0);
        const events: PaperTransitionEvent[] = [{
          kind: "POSITION_MARK",
          data: { markedAt, quoteIds, liquidationValueUsd,
            equityUsd: marked.availableCashUsd + liquidationValueUsd,
            positions: marked.positions.filter(position => position.status !== "CLOSED"),
            sellQuotes: input.sellQuotes }
        }];
        if (marked.bankroll.topUpCount > portfolio.bankroll.topUpCount) {
          events.push({
            kind: "BANKROLL_TOP_UP" as const,
            data: { topUpCount: marked.bankroll.topUpCount,
              totalTopUpsUsd: marked.bankroll.totalTopUpsUsd }
          });
        }
        return { state: marked, result: { liquidationValueUsd, equityUsd: marked.bankroll.currentEquityUsd }, events };
      }
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
      if (!portfolio) throw new Error("Paper portfolio state is missing.");
      if (portfolio.positions.some(position => position.status !== "CLOSED")) {
        throw new Error("Manual equity marks are disabled while positions are open; use exact-size executable sell quotes.");
      }
      await txn.put(portfolioKey, {
        ...portfolio, bankroll: topped.state,
        availableCashUsd: topped.state.currentEquityUsd,
        highWaterEquityUsd: Math.max(portfolio.highWaterEquityUsd,
          Math.max(0, topped.state.currentEquityUsd - topped.state.totalTopUpsUsd)),
        lastMarkedAt: occurredAt
      });
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


  /** Read-only, audited SDK quote. It never opens, marks or closes a position. */
  async requestPumpSwapQuote(input: {
    mint: string; poolAddress: string; side: "BUY" | "SELL"; amountBaseUnits: string;
  }): Promise<unknown> {
    await this.hydrate();
    if (!this.activeSessionId) throw new Error("No active paper session.");
    const requestId = crypto.randomUUID();
    await this.appendAudit("QUOTE_REQUESTED", input.mint, {
      requestId, venue: "pumpswap", side: input.side,
      amountBaseUnits: input.amountBaseUnits, poolAddress: input.poolAddress
    }, `quote-request:${requestId}`);
    try {
      const quote = await fetchPumpSwapSdkQuote({
        ...input,
        config: { apiKey: this.env.HELIUS_API_KEY, commitment: "confirmed" }
      });
      await this.appendAudit("QUOTE_RESULT", input.mint, {
        requestId, status: "QUOTED", quote
      }, `quote-result:${requestId}`);
      return quote;
    } catch (error) {
      const rawReason = error instanceof Error ? error.message : "Quote request failed.";
      const reason = this.env.HELIUS_API_KEY
        ? rawReason.split(this.env.HELIUS_API_KEY).join("[redacted]")
        : rawReason;
      await this.appendAudit("QUOTE_RESULT", input.mint, {
        requestId, status: "BLOCKED", reason
      }, `quote-result:${requestId}`);
      throw error;
    }
  }


  /** Read-only, audited SDK quote for an active Pump bonding curve. */
  async requestPumpCurveQuote(input: {
    mint: string; side: "BUY" | "SELL"; amountBaseUnits: string;
  }): Promise<unknown> {
    await this.hydrate();
    if (!this.activeSessionId) throw new Error("No active paper session.");
    const requestId = crypto.randomUUID();
    await this.appendAudit("QUOTE_REQUESTED", input.mint, {
      requestId, venue: "pump-bonding-curve", side: input.side,
      amountBaseUnits: input.amountBaseUnits
    }, `curve-quote-request:${requestId}`);
    try {
      const quote = await fetchPumpCurveSdkQuote({
        ...input,
        config: { apiKey: this.env.HELIUS_API_KEY, commitment: "confirmed" }
      });
      await this.appendAudit("QUOTE_RESULT", input.mint, {
        requestId, status: "QUOTED", quote
      }, `curve-quote-result:${requestId}`);
      return quote;
    } catch (error) {
      const rawReason = error instanceof Error ? error.message : "Quote request failed.";
      const reason = this.env.HELIUS_API_KEY
        ? rawReason.split(this.env.HELIUS_API_KEY).join("[redacted]")
        : rawReason;
      await this.appendAudit("QUOTE_RESULT", input.mint, {
        requestId, status: "BLOCKED", reason
      }, `curve-quote-result:${requestId}`);
      throw error;
    }
  }


  /**
   * Audited round-trip quote validation for a candidate. It checks a fresh
   * buy, exact-output sellability, and exact unsigned-message fee evidence.
   * It validates quotes only; the later entry gate separately requires an
   * explicitly authorized unsigned plan and durable portfolio prerequisites.
   */
  async requestExecutableRoundTripQuote(input: {
    mint: string;
    venue: "PUMP_CURVE" | "PUMPSWAP";
    buyAmountBaseUnits: string;
    poolAddress?: string;
    precomputedReport?: unknown;
    solUsd?: { source: "binance-spot"; symbol: "SOLUSDT"; priceUsd: number; observedAt: string; ageMs: number };
  }): Promise<unknown> {
    await this.hydrate();
    if (!this.activeSessionId) throw new Error("No active paper session.");
    if (!this.env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY is required.");
    if (input.venue === "PUMPSWAP" &&
        (typeof input.poolAddress !== "string" || !input.poolAddress.trim())) {
      throw new Error("A canonical PumpSwap pool address is required.");
    }
    if (!/^\d+$/.test(input.buyAmountBaseUnits) ||
        input.buyAmountBaseUnits.length > 20 ||
        BigInt(input.buyAmountBaseUnits) <= 0n ||
        BigInt(input.buyAmountBaseUnits) > 18_446_744_073_709_551_615n) {
      throw new Error("Buy amount must be a positive u64 quote-token amount.");
    }

    // Build the expensive candidate feature snapshot before starting the
    // short-lived executable quote window. Reuse it for the final audit so
    // quote validation is followed by evaluation, not another RPC-heavy scan.
    const featureReport = input.precomputedReport ?? await this.listTradeFlows();
    const requestId = crypto.randomUUID();
    const computeUnitLimit = 1_400_000;
    const config = { apiKey: this.env.HELIUS_API_KEY, commitment: "confirmed" as const };
    await this.appendAudit("QUOTE_REQUESTED", input.mint, {
      requestId, venue: input.venue, operation: "ROUND_TRIP_VALIDATION",
      buyAmountBaseUnits: input.buyAmountBaseUnits, computeUnitLimit,
      poolAddress: input.poolAddress ?? null
    }, `round-trip-quote-request:${requestId}`);
    await this.ctx.storage.put(`executable_quote:${this.activeSessionId}:${input.mint}`, {
      status: "PENDING", validatedAt: new Date().toISOString()
    });
    try {
      const identity = await deriveNonSigningVirtualTraderIdentity();
      const fetchQuote = input.venue === "PUMP_CURVE"
        ? createPumpCurveOfflineQuoteFetcher({ mint: input.mint, config })
        : createPumpSwapOfflineQuoteFetcher({
            mint: input.mint, poolAddress: input.poolAddress!, config
          });
      const buildExactFeeEvidence = createPumpUnsignedPlanFeeEvidenceBuilder({
        identity, config, computeUnitLimit
      });
      const result = await fetchExecutableRoundTripQuote({
        fetchQuote, helius: config, buildExactFeeEvidence,
        requireExactMessageFees: true,
        buyAmountBaseUnits: input.buyAmountBaseUnits,
        computeUnitLimit,
        ...(input.solUsd ? { solUsd: input.solUsd } : {}),
        executionDelayMs: 250,
        quoteTtlMs: 2_000,
        maxPriceImpactPct: 2,
        maximumRoundTripCostPct: 4
      });
      const validatedAt = new Date().toISOString();
      await this.ctx.storage.put(`executable_quote:${this.activeSessionId}:${input.mint}`, {
        status: result.status, validatedAt, venue: input.venue, result
      });
      await this.appendAudit("QUOTE_RESULT", input.mint, {
        requestId, status: result.status, venue: input.venue,
        paperEntryAuthorized: false, result
      }, `round-trip-quote-result:${requestId}`);
      // Re-evaluate the candidate with this fresh quote evidence. This only
      // updates audit rules; the quote remains explicitly unauthorized.
      try {
        await this.recordStrategyAudit(`round-trip:${requestId}`, featureReport, input.mint);
      } catch {
        await this.appendAudit("ERROR", input.mint, {
          requestId, stage: "STRATEGY_REEVALUATION_AFTER_QUOTE",
          message: "Quote validation succeeded but strategy audit refresh failed."
        }, `round-trip-audit-error:${requestId}`);
      }
      return result;
    } catch (error) {
      const rawReason = error instanceof Error ? error.message : "Round-trip quote validation failed.";
      const reason = this.env.HELIUS_API_KEY
        ? rawReason.split(this.env.HELIUS_API_KEY).join("[redacted]")
        : rawReason;
      await this.ctx.storage.put(`executable_quote:${this.activeSessionId}:${input.mint}`, {
        status: "BLOCKED", validatedAt: new Date().toISOString(), reason
      });
      await this.appendAudit("QUOTE_RESULT", input.mint, {
        requestId, status: "BLOCKED", paperEntryAuthorized: false, reason
      }, `round-trip-quote-result:${requestId}`);
      throw new Error(reason);
    }
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

  private async recordStrategyAudit(
    triggerSignature: string,
    precomputedReport?: unknown,
    onlyMint?: string
  ): Promise<void> {
    const monitoredMints = [...new Set(this.heliusState.subscriptions.map(item => item.mint))]
      .filter(mint => !onlyMint || mint === onlyMint);
    if (monitoredMints.length === 0) return;
    // Refresh global runtime prerequisites before spending quote RPC credits or
    // committing a simulated fill. Candidate-level rules remain independently
    // evaluated below; this gate prevents stale connection/config state passing.
    const runtimeStatus = await this.getStatus();
    const report = (precomputedReport ?? await this.listTradeFlows()) as {
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
      const nowSeconds = Date.now() / 1000;
      const ageSeconds = Number.isSafeInteger(launchTimestamp) && launchTimestamp >= 0 && launchTimestamp <= nowSeconds
        ? nowSeconds - launchTimestamp : null;
      const profile = report.priceVolumeProfiles.find(item => item.mint === mint && isSolQuoteMint(item.quoteMint)) ?? null;
      const flow = report.flows.find(item => item.mint === mint && isSolQuoteMint(item.quoteMint)) ?? null;
      const creatorRisk = report.creatorSellRisk.find(item => item.mint === mint);
      const walletRisk = report.walletClusterRisk.find(item => item.mint === mint);
      const links = this.walletLinkSnapshots[mint]?.links ?? [];
      const confidence = links.reduce((max, link) => Math.max(max, link.confidenceBps), 0);
      const reclaimBucketIndex = profile?.reclaimTime === null || profile?.reclaimTime === undefined
        ? -1 : profile.buckets.findIndex(bucket => bucket.endTime === profile.reclaimTime);
      const previousCompletedHigh = reclaimBucketIndex > 0
        ? profile!.buckets[reclaimBucketIndex - 1]!.highPrice : null;
      const nextObservationPrices = this.verifiedTransactions.flatMap(transaction => transaction.tradeEvents)
        .filter(event => event.mint === mint && isSolQuoteMint(event.quoteMint) &&
          Number(event.timestamp) > (profile?.reclaimTime ?? Number.POSITIVE_INFINITY))
        .map(event => {
          const reserves = event.virtualSolReserves;
          const tokens = event.virtualTokenReserves;
          if (reserves <= 0n || tokens <= 0n) return { timestampSeconds: Number(event.timestamp), price: Number.NaN };
          const scaled = (reserves * 1_000_000_000_000n) / tokens;
          return { timestampSeconds: Number(event.timestamp), price: Number(scaled) / 1_000_000_000_000 };
        });
      const freshness = calculateReclaimConfirmation({
        reclaimTimeSeconds: profile?.reclaimTime ?? null,
        previousCompletedHigh, nowSeconds, nextObservationPrices
      });
      const cachedQuote = await this.ctx.storage.get<unknown>(
        `executable_quote:${this.activeSessionId}:${mint}`
      );
      const roundTripCostPct = getFreshExecutableQuoteCostPct(cachedQuote, mint);
      const executableQuoteAvailable = roundTripCostPct !== null;
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
          dataComplete: flow.dataComplete, latestThreeWindowFlowPass: flow.latestThreeWindowFlowPass,
          sampleIntervalSeconds: flow.sampleIntervalSeconds,
          windows: flow.windows.map(window => ({...window, flowWindowPass: window.flowWindowPass})),
          distinctBuyersAcrossLatestThree: flow.distinctBuyersAcrossLatestThree,
          largestBuyerShareAcrossLatestThreeBps: flow.largestBuyerShareAcrossLatestThreeBps,
          microTradeFilterStatus: flow.microTradeFilterStatus
        } : null,
        creatorRiskStatus: creatorRisk?.status ?? null,
        walletClusterRiskStatus: walletRisk?.status ?? null,
        attributionConfidenceBps: confidence > 0 ? confidence : null,
        signalAgeSeconds: freshness.signalAgeSeconds, nextObservationConfirmed: freshness.nextObservationConfirmed,
        executableQuoteAvailable,
        volumeThresholds: parseReviewedVolumeThresholds(this.env.REVIEWED_VOLUME_THRESHOLDS_JSON),
        roundTripCostPct
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
      // Start an automatic quote only after all thirteen non-quote rules pass.
      // The durable attempt key is scoped to the reclaim signal so retries,
      // restarts and duplicate observations cannot fan out repeated SDK calls.
      const solUsdObservation = report.solUsdPrice?.status === "AVAILABLE"
        ? report.solUsdPrice.observation : null;
      if (!executableQuoteAvailable && canRequestExecutableQuote(evaluated) &&
          runtimeStatus.tradingReady &&
          this.status.enabled && this.activeSessionId && this.postgresLeaseHeld &&
          this.postgresIngestConfigured && this.env.HELIUS_API_KEY &&
          solUsdObservation && profile?.quoteMint && isSolQuoteMint(profile.quoteMint) &&
          profile.reclaimTime !== null && Number.isFinite(profile.reclaimTime)) {
        const portfolio = await this.getPaperPortfolio() as PaperPortfolioState | null;
        const occupiedSlots = portfolio?.positions.filter(position => position.status !== "CLOSED").length ?? 0;
        const hasFreeSlot = Boolean(portfolio &&
          occupiedSlots < portfolio.maxConcurrentPositions &&
          !portfolio.enteredMints.includes(mint) &&
          Number.isFinite(portfolio.positionSizeUsd) && portfolio.positionSizeUsd > 0 &&
          Number.isFinite(portfolio.availableCashUsd) &&
          portfolio.availableCashUsd >= portfolio.positionSizeUsd);
        if (portfolio && hasFreeSlot) {
          const attemptKey = `automatic_quote_attempt:${this.activeSessionId}:${mint}:${profile.reclaimTime}`;
          const previousAttempt = await this.ctx.storage.get<Record<string, unknown>>(attemptKey);
          if (!previousAttempt) {
            // Claim the reclaim signal before any network call. If the DO is
            // evicted mid-probe, a restart will not fan out another quote.
            await this.ctx.storage.put(attemptKey, {
              status: "VERIFYING_MARKET", reclaimTime: profile.reclaimTime,
              startedAt: new Date().toISOString()
            });
            try {
              const marketState = await refreshPumpMarketStateFromHelius({
                state: createUnverifiedMarketState(mint),
                config: { apiKey: this.env.HELIUS_API_KEY, commitment: "confirmed" as const }
              });
              const venue = marketState.status === "LIVE_CURVE" ? "PUMP_CURVE"
                : marketState.status === "MIGRATED_POOL_VERIFIED" ? "PUMPSWAP" : null;
              const marketQuoteMint = venue === "PUMP_CURVE" ? marketState.curve?.quoteMint
                : venue === "PUMPSWAP" ? marketState.pool?.quoteMint : null;
              const poolAddress = venue === "PUMPSWAP" ? marketState.pool?.poolAddress : undefined;
              if (!venue || marketQuoteMint !== profile.quoteMint ||
                  (venue === "PUMPSWAP" && !poolAddress)) {
                const reason = "A verified live Pump curve or canonical SOL-quoted PumpSwap pool was unavailable for this reclaim signal.";
                await this.ctx.storage.put(attemptKey, {
                  status: "BLOCKED", reclaimTime: profile.reclaimTime,
                  blockedAt: new Date().toISOString(), reason
                });
                await this.appendAudit("ERROR", mint, {
                  triggerSignature, stage: "AUTOMATIC_MARKET_VERIFICATION", reason
                }, `automatic-market-blocked:${this.activeSessionId}:${mint}:${profile.reclaimTime}`);
                continue;
              }

              const rawLamports = portfolio.positionSizeUsd / solUsdObservation.priceUsd * 1_000_000_000;
              const buyAmountLamports = Math.round(rawLamports);
              if (!Number.isSafeInteger(buyAmountLamports) || buyAmountLamports <= 0 ||
                  BigInt(buyAmountLamports) > 18_446_744_073_709_551_615n) {
                const reason = "Exact stake cannot be represented as a safe positive SOL lamport amount.";
                await this.ctx.storage.put(attemptKey, {
                  status: "BLOCKED", reclaimTime: profile.reclaimTime,
                  blockedAt: new Date().toISOString(), reason
                });
                await this.appendAudit("ERROR", mint, {
                  triggerSignature, stage: "AUTOMATIC_QUOTE_SIZE", reason
                }, `automatic-quote-size-blocked:${this.activeSessionId}:${mint}:${profile.reclaimTime}`);
                continue;
              }

              await this.ctx.storage.put(attemptKey, {
                status: "REQUESTED", reclaimTime: profile.reclaimTime,
                stakeUsd: portfolio.positionSizeUsd, buyAmountBaseUnits: String(buyAmountLamports),
                venue, requestedAt: new Date().toISOString()
              });
              try {
                await this.requestExecutableRoundTripQuote({
                  mint, venue, buyAmountBaseUnits: String(buyAmountLamports),
                  ...(poolAddress ? { poolAddress } : {}),
                  precomputedReport: report,
                  solUsd: solUsdObservation
                });
              } catch (error) {
                const rawReason = error instanceof Error ? error.message : "Automatic quote request failed.";
                const reason = this.env.HELIUS_API_KEY
                  ? rawReason.split(this.env.HELIUS_API_KEY).join("[redacted]")
                  : rawReason;
                await this.ctx.storage.put(attemptKey, {
                  status: "FAILED", reclaimTime: profile.reclaimTime,
                  venue, failedAt: new Date().toISOString(), reason
                });
                await this.appendAudit("ERROR", mint, {
                  triggerSignature, stage: "AUTOMATIC_ROUND_TRIP_QUOTE", reason
                }, `automatic-quote-error:${this.activeSessionId}:${mint}:${profile.reclaimTime}`);
              }
            } catch (error) {
              const rawReason = error instanceof Error ? error.message : "Automatic market verification failed.";
              const reason = this.env.HELIUS_API_KEY
                ? rawReason.split(this.env.HELIUS_API_KEY).join("[redacted]")
                : rawReason;
              await this.ctx.storage.put(attemptKey, {
                status: "FAILED", reclaimTime: profile.reclaimTime,
                failedAt: new Date().toISOString(), reason
              });
              await this.appendAudit("ERROR", mint, {
                triggerSignature, stage: "AUTOMATIC_MARKET_VERIFICATION", reason
              }, `automatic-market-error:${this.activeSessionId}:${mint}:${profile.reclaimTime}`);
            }
            // The quote method re-runs this mint's audit with the fresh quote
            // and can commit only after independent plan and durable portfolio
            // authorization gates pass. One attempt is allowed per reclaim.
            continue;
          }
        }
      }

      // The portfolio transition is reachable only after the complete strict
      // strategy audit returns BUY and both exact quote legs remain fresh.
      // This is simulated accounting only; no wallet signing/submission exists.
      const quoteResult = cachedQuote && typeof cachedQuote === "object"
        ? (cachedQuote as {
            result?: {
              buyQuote?: ExecutablePaperQuote;
              initialSellQuote?: ExecutablePaperQuote;
              solUsdPriceUsd?: number;
              exactFeeEvidence?: {
                buy: UnsignedInstructionFeeEvidence;
                sell: UnsignedInstructionFeeEvidence;
              };
            };
          }).result
        : undefined;
      const portfolio = quoteResult?.buyQuote && quoteResult.initialSellQuote
        ? await this.getPaperPortfolio() as PaperPortfolioState | null
        : null;
      const paperAuthorization = evaluated.decision === "BUY" &&
          quoteResult?.buyQuote && quoteResult.initialSellQuote
        ? authorizePaperEntryFromVerifiedPlan({
            mint, portfolio,
            buyQuote: quoteResult.buyQuote,
            sellQuote: quoteResult.initialSellQuote,
            exactFeeEvidence: quoteResult.exactFeeEvidence,
            solUsdPriceUsd: quoteResult.solUsdPriceUsd ?? Number.NaN,
            nowMs: Date.now()
          })
        : null;
      if (evaluated.decision === "BUY" && !paperAuthorization?.authorized) {
        await this.appendAudit("ERROR", mint, {
          triggerSignature, stage: "PAPER_ENTRY_AUTHORIZATION",
          reason: paperAuthorization?.reason ?? "Verified round-trip quote or active portfolio is unavailable."
        }, `paper-entry-authorization-error:${triggerSignature}:${mint}`);
      }
      if (canCommitPaperEntry({
          systemTradingReady: runtimeStatus.tradingReady,
          sessionEnabled: this.status.enabled,
          workerLeaseHeld: this.postgresLeaseHeld,
          postgresIngestConfigured: this.postgresIngestConfigured,
          strategyDecision: evaluated.decision,
          buyAllowed: evaluated.buyAllowed,
          executableQuoteAvailable,
          hasBuyAndSellQuotes: Boolean(quoteResult?.buyQuote && quoteResult.initialSellQuote),
          // The quote itself remains unauthorized. This independent preview
          // verifies every non-portfolio account prerequisite and runs the
          // exact portfolio entry guard against stake, both fee legs and rent.
          unsignedPlanAuthorized: paperAuthorization?.authorized === true
        }) && quoteResult?.buyQuote && quoteResult.initialSellQuote &&
        paperAuthorization?.authorized === true && portfolio &&
        !portfolio.enteredMints.includes(mint)) {
        try {
          await this.recordPaperEntry({
            mint,
            positionId: `paper-entry:${this.activeSessionId}:${mint}:${quoteResult.buyQuote.quoteId}`,
            buyQuote: quoteResult.buyQuote,
            sellQuote: quoteResult.initialSellQuote,
            rentReserveUsd: paperAuthorization.rentReserveUsd
          });
          const committedSessionId = this.activeSessionId;
          if (committedSessionId) {
            this.ctx.waitUntil(this.flushAuditEventsToPostgres(committedSessionId));
          }
        } catch (error) {
          await this.appendAudit("ERROR", mint, {
            triggerSignature, stage: "STRICT_PAPER_ENTRY_TRANSITION",
            reason: error instanceof Error ? error.message : "Paper entry transition failed closed."
          }, `paper-entry-error:${triggerSignature}:${mint}`);
        }
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
      const solTrackers = observed.filter(tracker => isSolQuoteMint(tracker.quoteMint))
        .sort((a, b) => Date.parse(b.firstObservedAt) - Date.parse(a.firstObservedAt));
      const quoteMint = solTrackers[0]?.quoteMint ?? SOL_QUOTE_MINT;
      const refs = await this.ctx.storage.get<{
        decisionPriceQuotePerToken: number | null; decisionAt: string | null;
        discoveryPriceQuotePerToken: number | null;
      }>(`candidate_price_refs:${sessionId}:${mint}:${quoteMint}`);
      return {
        ...candidate,
        decisionPriceQuotePerToken: refs?.decisionPriceQuotePerToken ?? null,
        decisionAt: refs?.decisionAt ?? null,
        discoveryPriceQuotePerToken: refs?.discoveryPriceQuotePerToken ?? null,
        quoteMint,
        followUpStatus: solTrackers.length > 0 ? "PARTIAL" : "MISSING",
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
    const result = await fetchCompleteHolderConcentration(mint, {
      apiKey: this.env.HELIUS_API_KEY,
      fetcher: this.rateLimitedHeliusFetcher()
    });
    this.holderRiskSnapshots[mint] = result;
    if (result.status === "OBSERVED") {
      this.walletHoldingsByMint[mint] = result.snapshot.accounts.map(account => ({
        mint, wallet: account.owner, amount: account.amount
      }));
      this.reconcileHelius();
    } else {
      // Never let an older holder snapshot masquerade as current evidence.
      delete this.walletHoldingsByMint[mint];
    }
    await this.persist();
    await this.appendAudit("RISK_EVIDENCE", mint, {
      evidenceType: "HOLDER_CONCENTRATION", result: jsonSafe(result)
    }, `holder-risk:${mint}:${Math.floor(Date.now() / 60_000)}`);
    return result;
  }

  async collectWalletLinks(mint: string): Promise<unknown> {
    await this.hydrate();
    const sessionId = this.activeSessionId;
    const backfill = sessionId
      ? await this.ctx.storage.get<HistoricalBackfillState>(`helius_backfill:${sessionId}:${mint}`)
      : undefined;
    const decodeCoverage = sessionId && backfill
      ? await this.getHistoricalDecodeCoverage(sessionId, mint, backfill)
      : null;
    const archived = sessionId
      ? await this.ctx.storage.get<Record<string, VerifiedPumpTransaction>>(
          `helius_verified_historical_transactions:${sessionId}:${mint}`)
      : undefined;
    const transactionsBySignature = new Map<string, VerifiedPumpTransaction>();
    for (const transaction of Object.values(archived ?? {})) {
      if (transaction.mint === mint) transactionsBySignature.set(transaction.signature, transaction);
    }
    for (const transaction of this.verifiedTransactions) {
      if (transaction.mint === mint) transactionsBySignature.set(transaction.signature, transaction);
    }
    const candidateTransactions = [...transactionsBySignature.values()];
    const expectedBackfillSignatures = new Set(backfill?.signatures.map(item => item.signature) ?? []);
    const verifiedBackfillTransactionCount = candidateTransactions.filter(tx =>
      expectedBackfillSignatures.has(tx.signature)).length;
    const launch = candidateTransactions.flatMap(tx => tx.createEvents).find(event => event.mint === mint);
    const tradeCoverageComplete = backfill?.status === "COMPLETE" &&
      decodeCoverage?.complete === true && launch !== undefined &&
      verifiedBackfillTransactionCount === decodeCoverage.verifiedTransactionCount;
    const volumes = new Map<string, bigint>();
    for (const transaction of candidateTransactions) for (const trade of transaction.tradeEvents) {
      if (trade.mint !== mint || trade.quoteAmount <= 0n) continue;
      volumes.set(trade.user, (volumes.get(trade.user) ?? 0n) + trade.quoteAmount);
    }
    const rankedWallets = [...volumes.entries()].sort((a, b) =>
      a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1
    ).map(([wallet]) => wallet);
    const wallets = [...new Set([...(launch?.creator ? [launch.creator] : []), ...rankedWallets])];
    const expectedSignaturesByWallet = Object.fromEntries(wallets.map(wallet => [
      wallet,
      candidateTransactions.filter(transaction =>
        transaction.createEvents.some(event => event.mint === mint && event.creator === wallet) ||
        transaction.tradeEvents.some(event => event.mint === mint && event.user === wallet)
      ).map(transaction => transaction.signature)
    ]));
    const fetcher = this.rateLimitedHeliusFetcher();
    const fundingEvidence = await collectCompleteWalletFundingEvidence(mint, wallets, {
      apiKey: this.env.HELIUS_API_KEY,
      walletSetVerifiedComplete: tradeCoverageComplete,
      fetcher
    });
    const fullHistoryEnabled = this.env.FULL_WALLET_HISTORY_ENABLED === "true";
    const fullHistoryScope = selectFullWalletHistoryScope(
      wallets, expectedSignaturesByWallet, tradeCoverageComplete
    );
    const fullWalletHistory = fullHistoryEnabled
      ? await collectCompleteWalletTransactionHistory(mint, fullHistoryScope.wallets, {
          apiKey: this.env.HELIUS_API_KEY,
          walletSetVerifiedComplete: fullHistoryScope.walletSetVerifiedComplete,
          maxPages: normalizeFullWalletHistoryMaxPages(this.env.FULL_WALLET_HISTORY_MAX_PAGES),
          expectedSignaturesByWallet: fullHistoryScope.expectedSignaturesByWallet,
          fetcher
        })
      : null;
    const fullHistoryComplete = fullWalletHistory?.status === "OBSERVED" &&
      fullWalletHistory.dataComplete && fullWalletHistory.walletSetComplete &&
      fullWalletHistory.walletsCovered.length === fullWalletHistory.walletsRequested;
    const linksByEvidence = new Map<string, WalletLinkEvidence>();
    for (const link of [...fundingEvidence.links, ...(fullWalletHistory?.links ?? [])]) {
      const key = [link.walletA, link.walletB].sort().join(":") + ":" + [...link.evidence].sort().join(",");
      linksByEvidence.set(key, link);
    }
    const combined: WalletLinkEvidenceSnapshot = {
      provider: "helius", mint,
      status: fullHistoryComplete ? "OBSERVED" : "DATA_INCOMPLETE",
      coverage: fullHistoryComplete ? "FULL_WALLET_HISTORY" :
        fundingEvidence.dataComplete ? "FULL_SOL_TRANSFER_HISTORY" : "INCOMPLETE",
      dataComplete: fullHistoryComplete,
      walletSetComplete: tradeCoverageComplete && wallets.length <= 16,
      requestedWallets: wallets,
      walletsCovered: fullWalletHistory?.walletsCovered ?? fundingEvidence.walletsCovered,
      walletsRequested: wallets.length,
      walletsChecked: fullWalletHistory?.walletsChecked ?? fundingEvidence.walletsChecked,
      transactionsChecked: fullWalletHistory?.transactionsChecked ?? 0,
      pagesScanned: fundingEvidence.pagesScanned + (fullWalletHistory?.pagesScanned ?? 0),
      estimatedCredits: fullWalletHistory?.estimatedCredits ?? 0,
      links: [...linksByEvidence.values()],
      warnings: [...fundingEvidence.warnings, ...(fullWalletHistory?.warnings ?? [])],
      observedAt: fullWalletHistory?.observedAt ?? fundingEvidence.observedAt,
      fundingEvidence,
      fullWalletHistory
    };
    this.walletLinkSnapshots[mint] = combined;
    this.reconcileHelius();
    await this.persist();
    const risk = evaluateWalletClusterRisk(candidateTransactions, {
      mint,
      creator: launch?.creator ?? null,
      totalSupply: launch?.tokenTotalSupply.toString() ?? null,
      links: combined.links,
      holdings: this.walletHoldingsByMint[mint] ?? []
    });
    await this.appendAudit("RISK_EVIDENCE", mint, {
      evidenceType: "WALLET_CLUSTER",
      fundingEvidence: jsonSafe(fundingEvidence),
      fullWalletHistory: jsonSafe(fullWalletHistory),
      walletClusterEvidence: jsonSafe(combined),
      risk: jsonSafe(risk)
    }, `wallet-links:${mint}:${Math.floor(Date.now() / 60_000)}`);
    return { ...combined, risk };
  }

  /** Collect one bounded holder or wallet-link snapshot on each scheduled tick. */
  async collectNextRiskEvidence(): Promise<unknown> {
    await this.hydrate();
    if (!this.status.enabled || !this.activeSessionId || !this.env.HELIUS_API_KEY) {
      return { status: "IDLE", reason: "No active paper session or Helius API key." };
    }

    const monitoredMints = new Set(this.heliusState.subscriptions.map(item => item.mint));
    const launches = new Set(this.verifiedTransactions.flatMap(tx => tx.createEvents).map(event => event.mint));
    const candidates = this.discovery.candidates
      .filter(candidate => candidate.status === "DISCOVERED" &&
        monitoredMints.has(candidate.mint) && launches.has(candidate.mint))
      .sort((a, b) => Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt));
    const now = Date.now();

    for (const candidate of candidates) {
      const mint = candidate.mint;
      const lastAttempt = this.riskEvidenceAttemptedAtByMint[mint] ?? 0;
      if (now - lastAttempt < 60_000) continue;

      const holder = this.holderRiskSnapshots[mint];
      const walletLinks = this.walletLinkSnapshots[mint];
      const holderObservedAt = holder?.status === "OBSERVED" ? Date.parse(holder.snapshot.observedAt) : Number.NaN;
      const walletLinksObservedAt = walletLinks?.observedAt ? Date.parse(walletLinks.observedAt) : Number.NaN;
      const launch = this.verifiedTransactions.flatMap(tx => tx.createEvents).find(event => event.mint === mint);
      const currentWalletSet = [...new Set([
        ...(launch?.creator ? [launch.creator] : []),
        ...this.verifiedTransactions.flatMap(tx => tx.tradeEvents)
          .filter(trade => trade.mint === mint && trade.quoteAmount > 0n)
          .map(trade => trade.user)
      ])].sort();
      const previouslyRequestedWallets = [...(walletLinks?.requestedWallets ?? [])].sort();
      const walletSetChanged = currentWalletSet.length !== previouslyRequestedWallets.length ||
        currentWalletSet.some((wallet, index) => wallet !== previouslyRequestedWallets[index]);
      const holderNeedsRefresh = !holder || !Number.isFinite(holderObservedAt) ||
        holderObservedAt > now || now - holderObservedAt >= 120_000 ||
        (holder.status !== "OBSERVED" && now - lastAttempt >= 60_000);
      // Parsed full SOL-transfer history costs more than ordinary RPC. Refresh
      // it every ten minutes or when the observed wallet set changes, not every
      // two-minute holder refresh. Incomplete results remain WATCH in between.
      const walletLinksNeedRefresh = !walletLinks || !Number.isFinite(walletLinksObservedAt) ||
        walletLinksObservedAt > now || now - walletLinksObservedAt >= 600_000 || walletSetChanged;

      let evidenceType: "HOLDER_CONCENTRATION" | "WALLET_CLUSTER";
      if (holderNeedsRefresh) {
        evidenceType = "HOLDER_CONCENTRATION";
      } else if (walletLinksNeedRefresh) {
        const distinctTradeWallets = new Set(this.verifiedTransactions.flatMap(tx => tx.tradeEvents)
          .filter(trade => trade.mint === mint && trade.quoteAmount > 0n)
          .map(trade => trade.user)).size;
        if (distinctTradeWallets < 2) continue;
        evidenceType = "WALLET_CLUSTER";
      } else {
        continue;
      }

      this.riskEvidenceAttemptedAtByMint[mint] = now;
      await this.ctx.storage.put("risk_evidence_attempted_at_by_mint", this.riskEvidenceAttemptedAtByMint);
      try {
        const result = evidenceType === "HOLDER_CONCENTRATION"
          ? await this.getHolderRisk(mint)
          : await this.collectWalletLinks(mint);
        const evidenceStatus = result && typeof result === "object" && "status" in result
          ? String(result.status) : "UNKNOWN";
        return {
          status: evidenceStatus === "OBSERVED" ? "COLLECTED" : "DATA_INCOMPLETE",
          mint, evidenceType, evidenceStatus
        };
      } catch (error) {
        await this.appendAudit("DATA_GAP", mint, {
          reason: "AUTOMATED_RISK_EVIDENCE_COLLECTION_FAILED",
          evidenceType,
          message: error instanceof Error ? error.message : "Risk evidence collection failed."
        }, `risk-evidence-failed:${mint}:${Math.floor(now / 60_000)}`);
        return { status: "DATA_INCOMPLETE", mint, evidenceType };
      }
    }

    return { status: "IDLE", reason: "No monitored candidate currently needs a risk snapshot." };
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
    // A clean cluster result is PASS_COMPLETE only when the buyer set was
    // fully backfilled, every wallet transaction history exhausted pagination,
    // and the holder census is a stable full-token-account snapshot.
    const archivedWalletRiskTransactions = new Map<string, VerifiedPumpTransaction[]>();
    if (this.activeSessionId) {
      const completeHistoryMints = candidateMints.filter(mint =>
        this.walletLinkSnapshots[mint]?.coverage === "FULL_WALLET_HISTORY");
      const archivedRows = await Promise.all(completeHistoryMints.map(async mint => ({
        mint,
        rows: await this.ctx.storage.get<Record<string, VerifiedPumpTransaction>>(
          `helius_verified_historical_transactions:${this.activeSessionId}:${mint}`)
      })));
      for (const item of archivedRows) {
        archivedWalletRiskTransactions.set(item.mint, Object.values(item.rows ?? {}));
      }
    }
    const walletClusterRisk = candidateMints.map(mint => {
      const snapshot = this.walletLinkSnapshots[mint];
      const transactionsBySignature = new Map<string, VerifiedPumpTransaction>();
      for (const transaction of archivedWalletRiskTransactions.get(mint) ?? []) {
        if (transaction.mint === mint) transactionsBySignature.set(transaction.signature, transaction);
      }
      for (const transaction of this.verifiedTransactions) {
        if (transaction.mint === mint) transactionsBySignature.set(transaction.signature, transaction);
      }
      const candidateTransactions = [...transactionsBySignature.values()];
      const launch = candidateTransactions.flatMap(tx => tx.createEvents).find(event => event.mint === mint);
      const evaluatedRisk = evaluateWalletClusterRisk(candidateTransactions, {
        mint,
        creator: launch?.creator ?? null,
        totalSupply: launch?.tokenTotalSupply.toString() ?? null,
        links: snapshot?.links ?? [],
        holdings: this.walletHoldingsByMint[mint] ?? []
      });
      const holder = this.holderRiskSnapshots[mint] ?? null;
      const walletHistoryComplete = snapshot?.coverage === "FULL_WALLET_HISTORY" &&
        snapshot.dataComplete && snapshot.walletSetComplete;
      const holderCensusComplete = holder?.status === "OBSERVED" &&
        holder.snapshot.dataComplete === true &&
        holder.snapshot.coverage === "FULL_TOKEN_ACCOUNT_CENSUS_STABLE";
      const status = classifyWalletClusterRiskWithCoverage({
        risk: evaluatedRisk,
        fullWalletTransactionHistoryComplete: walletHistoryComplete,
        fullHolderCensusComplete: holderCensusComplete
      });
      return {
        ...evaluatedRisk, status,
        collection: snapshot ?? null,
        holderConcentration: holder
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
          holderEvidenceStatus: this.holderRiskSnapshots[candidate.mint]?.status ?? "NOT_COLLECTED",
          walletLinkEvidenceStatus: this.walletLinkSnapshots[candidate.mint]?.status ?? "NOT_COLLECTED",
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
        if (parsed.event.kind === "new_token" && parsed.event.signature && result.outcome !== "OVERFLOW") {
          const createWork = enqueueHeliusSignatureWork(this.heliusState, {
            signature: parsed.event.signature, mint: parsed.event.mint, slot: null
          }, parsed.event.receivedAt);
          this.heliusState = createWork.state;
          if (createWork.outcome === "INVALID" || createWork.outcome === "OVERFLOW") {
            await this.appendAudit("DATA_GAP", parsed.event.mint, {
              reason: `CREATE_SIGNATURE_QUEUE_${createWork.outcome}`,
              signature: parsed.event.signature
            });
          } else if (createWork.outcome === "QUEUED") {
            void this.drainHeliusQueue();
          }
        }
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
            this.heliusState = recordHeliusCoverageGap(
              this.heliusState, failed.mint, new Date().toISOString()
            );
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
        this.heliusState = recordHeliusNotificationBoundary(
          this.heliusState, subscriptionId as number,
          notification.signature, notification.slot, new Date().toISOString()
        );
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
        // An error can precede a close event or leave the socket half-open.
        // Invalidate the affected coverage immediately; never wait for close.
        if (this.status.enabled) this.markHeliusCoverageGap();
        this.auditInBackground("ERROR", null, { subsystem: "HELIUS_WEBSOCKET", message: this.status.lastError });
        void this.persist().catch(() => undefined);
        // Force the close path so the coordinator releases this socket and
        // schedules a fresh connection instead of remaining half-open.
        try { socket.close(1011, "Helius transport error"); } catch { /* close is best-effort */ }
      });
    } catch {
      this.heliusSocket = null;
      this.status.heliusConnected = false;
      this.heliusConnectedAtMs = 0;
      this.heliusConnectingSinceMs = 0;
      this.status.lastError = "Unable to create the Helius WebSocket connection.";
      if (this.status.enabled) this.markHeliusCoverageGap();
      this.auditInBackground("ERROR", null, { subsystem: "HELIUS_CONNECT", message: this.status.lastError });
      void this.persist().catch(() => undefined);
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

  private async beginHistoricalBackfill(transaction: VerifiedPumpTransaction): Promise<void> {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    const create = transaction.createEvents.find(event => event.mint === transaction.mint);
    if (!create) return;
    const key = `helius_backfill:${sessionId}:${transaction.mint}`;
    const existing = await this.ctx.storage.get<HistoricalBackfillState>(key);
    let state = existing;
    if (!state) {
      const launchBlockTime = transaction.blockTime ?? null;
      try {
        state = createHistoricalBackfillState({
          mint: transaction.mint,
          bondingCurve: create.bondingCurve,
          createSignature: transaction.signature,
          launchBlockTime,
          horizonSeconds: 600,
          maxSignatures: 120
        });
      } catch (error) {
        await this.appendAudit("DATA_GAP", transaction.mint, {
          reason: "HISTORICAL_BACKFILL_INITIALIZATION_FAILED",
          message: error instanceof Error ? error.message : "Invalid create-event history anchor."
        }, `backfill-init-failed:${transaction.signature}`);
        return;
      }
    }

    // Register the mint before its state. If eviction happens after the list
    // write, replaying the still-queued create transaction can finish setup.
    const listKey = `helius_backfill_mints:${sessionId}`;
    const mints = await this.ctx.storage.get<string[]>(listKey) ?? [];
    if (!mints.includes(transaction.mint)) {
      await this.ctx.storage.put(listKey, [...mints, transaction.mint].slice(-100));
    }
    if (existing) return;

    await this.ctx.storage.put(key, state!);
    if (state!.status === "INCOMPLETE") {
      await this.appendAudit("DATA_GAP", transaction.mint, {
        reason: "HISTORICAL_BACKFILL_LAUNCH_BLOCK_TIME_UNAVAILABLE",
        detail: state!.reason,
        createEventTimestamp: String(create.timestamp)
      }, `backfill-launch-time-missing:${transaction.signature}`);
      return;
    }
    await this.appendAudit("OBSERVATION", transaction.mint, {
      historicalBackfill: "STARTED", horizonSeconds: state!.horizonSeconds,
      maxSignatures: state!.maxSignatures, launchBlockTime: state!.launchBlockTime
    }, `backfill-start:${transaction.signature}`);
  }

  /** Queue a completed launch-window scan from a durable cursor. */
  private async queueCompletedHistoricalBackfill(
    sessionId: string,
    mint: string,
    key: string,
    state: HistoricalBackfillState
  ): Promise<boolean> {
    const cursorKey = `helius_backfill_queue_cursor:${sessionId}:${mint}`;
    const cursor = await this.ctx.storage.get<number>(cursorKey) ?? 0;
    const progress = enqueueHistoricalBackfillSignatures(
      this.heliusState, state, cursor, new Date().toISOString()
    );
    this.heliusState = progress.state;

    // Persist the queue before its cursor. If eviction happens between these
    // writes, replay starts at the old cursor and the queue deduplicates safely.
    await this.ctx.storage.put("helius_monitor_state", this.heliusState);
    await this.ctx.storage.put(cursorKey, progress.cursor);

    if (progress.invalid) {
      const failedState: HistoricalBackfillState = {
        ...state, status: "INCOMPLETE",
        reason: "A validated historical signature could not be added to the work queue."
      };
      await this.ctx.storage.put(key, failedState);
      this.heliusState = {
        ...this.heliusState,
        incompleteMints: [...new Set([...this.heliusState.incompleteMints, mint])].slice(-10)
      };
      await this.ctx.storage.put("helius_monitor_state", this.heliusState);
      await this.appendAudit("DATA_GAP", mint, {
        reason: "HISTORICAL_BACKFILL_QUEUE_INVALID",
        queueCursor: progress.cursor,
        signaturesReturned: state.signatures.length
      }, `backfill-queue-invalid:${sessionId}:${mint}`);
      return this.heliusState.queue.length > 0;
    }

    if (progress.overflow) {
      await this.appendAudit("OBSERVATION", mint, {
        historicalBackfill: "QUEUE_PAUSED",
        pagesScanned: state.pagesScanned,
        signaturesScanned: state.scannedCount,
        signaturesReturned: state.signatures.length,
        queueCursor: progress.cursor,
        queued: progress.queued,
        duplicates: progress.duplicates,
        droppedSignatures: this.heliusState.droppedSignatures
      }, `backfill-queue-paused:${sessionId}:${mint}:${progress.cursor}`);
      return this.heliusState.queue.length > 0;
    }

    if (progress.cursor >= state.signatures.length) {
      await this.appendAudit("OBSERVATION", mint, {
        historicalBackfill: "COMPLETE",
        pagesScanned: state.pagesScanned,
        signaturesScanned: state.scannedCount,
        signaturesReturned: state.signatures.length,
        queued: progress.queued,
        duplicates: progress.duplicates
      }, `backfill-complete:${sessionId}:${mint}`);
    } else {
      await this.appendAudit("OBSERVATION", mint, {
        historicalBackfill: "QUEUE_PROGRESS",
        queueCursor: progress.cursor,
        signaturesReturned: state.signatures.length,
        queued: progress.queued,
        duplicates: progress.duplicates
      }, `backfill-queue-progress:${sessionId}:${mint}:${progress.cursor}`);
    }
    return this.heliusState.queue.length > 0;
  }

  /** Advance one resumable address-history page and enqueue its verified launch-window signatures. */
  private async advanceHistoricalBackfill(): Promise<boolean> {
    const sessionId = this.activeSessionId;
    if (!sessionId) return false;
    const listKey = `helius_backfill_mints:${sessionId}`;
    const mints = await this.ctx.storage.get<string[]>(listKey) ?? [];
    for (const mint of mints) {
      const key = `helius_backfill:${sessionId}:${mint}`;
      const state = await this.ctx.storage.get<HistoricalBackfillState>(key);
      if (!state || state.status === "INCOMPLETE") continue;
      if (state.status === "COMPLETE") {
        const cursorKey = `helius_backfill_queue_cursor:${sessionId}:${mint}`;
        const cursor = await this.ctx.storage.get<number>(cursorKey) ?? 0;
        if (cursor < state.signatures.length) {
          return this.queueCompletedHistoricalBackfill(sessionId, mint, key, state);
        }
        continue;
      }
      while (!this.heliusBucket.tryTake()) {
        await new Promise(resolve => setTimeout(resolve, this.heliusBucket.retryAfterMs));
        if (!this.status.enabled || this.activeSessionId !== sessionId) return false;
      }
      const page = await fetchHeliusAddressSignaturesPage(state, {
        apiKey: this.env.HELIUS_API_KEY,
        commitment: "confirmed"
      });
      await this.ctx.storage.put(key, page.state);
      if (page.status === "INCOMPLETE") {
        this.heliusState = {
          ...this.heliusState,
          incompleteMints: [...new Set([...this.heliusState.incompleteMints, mint])].slice(-10)
        };
        await this.ctx.storage.put("helius_monitor_state", this.heliusState);
        await this.appendAudit("DATA_GAP", mint, {
          reason: "HISTORICAL_BACKFILL_INCOMPLETE",
          detail: page.state.reason,
          pagesScanned: page.state.pagesScanned,
          signaturesScanned: page.state.scannedCount
        }, `backfill-incomplete:${sessionId}:${mint}`);
        continue;
      }
      if (page.status === "CONTINUE") {
        await this.appendAudit("OBSERVATION", mint, {
          historicalBackfill: "PAGING", pagesScanned: page.state.pagesScanned,
          signaturesScanned: page.state.scannedCount, nextBefore: page.state.before
        }, `backfill-page:${sessionId}:${mint}:${page.state.pagesScanned}`);
        return true;
      }
      return this.queueCompletedHistoricalBackfill(sessionId, mint, key, page.state);
    }
    return false;
  }

  private async drainHeliusQueue(): Promise<void> {
    if (this.drainingHelius || !this.status.enabled) return;
    this.drainingHelius = true;
    let activeWork: HeliusSignatureWork | null = null;
    let processedItems = 0;
    const maxItemsPerDrain = 5;
    try {
      while (this.status.enabled && processedItems < maxItemsPerDrain) {
        if (this.heliusState.queue.length === 0) {
          const advancedBackfill = await this.advanceHistoricalBackfill();
          if (!advancedBackfill && this.heliusState.queue.length === 0) break;
          if (advancedBackfill) processedItems += 1;
        }
        if (this.heliusState.queue.length === 0) continue;
        if (!this.heliusBucket.tryTake()) {
          await new Promise(resolve => setTimeout(resolve, this.heliusBucket.retryAfterMs));
          continue;
        }
        const work = this.heliusState.queue[0];
        if (!work) break;
        const retryAt = work.retryAfterAt ? Date.parse(work.retryAfterAt) : null;
        if (retryAt !== null && Number.isFinite(retryAt) && retryAt > Date.now()) {
          const readyBehind = this.heliusState.queue.slice(1).some(item => {
            const at = item.retryAfterAt ? Date.parse(item.retryAfterAt) : null;
            return at === null || !Number.isFinite(at) || at <= Date.now();
          });
          if (readyBehind) {
            this.heliusState = {
              ...this.heliusState,
              queue: [...this.heliusState.queue.slice(1), work]
            };
            await this.ctx.storage.put("helius_monitor_state", this.heliusState);
            continue;
          }
          const nextRetryAt = this.heliusState.queue
            .map(item => item.retryAfterAt ? Date.parse(item.retryAfterAt) : Number.NaN)
            .filter(at => Number.isFinite(at) && at > Date.now())
            .reduce((earliest, at) => Math.min(earliest, at), retryAt);
          await this.ctx.storage.setAlarm(nextRetryAt);
          break;
        }
        activeWork = work;
        let workDequeued = false;
        const result = await fetchAndVerifyPumpTransaction(work.signature, work.mint, {
          apiKey: this.env.HELIUS_API_KEY,
          commitment: "confirmed"
        });
        if (result.status === "VERIFIED") {
          this.verifiedTransactions = [...this.verifiedTransactions, { ...result.transaction, receivedAt: new Date().toISOString() }].slice(-2_000);
          await this.beginHistoricalBackfill(result.transaction);
          await this.recordVerifiedHistoricalSignature(result.transaction);
          await this.archiveVerifiedHistoricalTransaction(result.transaction);
          await this.appendAudit("OBSERVATION", work.mint, {
            signature: work.signature, slot: work.slot, transaction: jsonSafe(result.transaction),
            retentionPolicy: "LATEST_2000_TRANSACTION_SNAPSHOT_PLUS_APPEND_ONLY_AUDIT"
          }, `helius:${work.signature}`);
          for (let tradeIndex = 0; tradeIndex < result.transaction.tradeEvents.length; tradeIndex += 1) {
            const trade = result.transaction.tradeEvents[tradeIndex]!;
            const quoteAmount = isSolQuoteMint(trade.quoteMint)
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
          await this.recordFailedHistoricalSignature(work);
          await this.appendAudit("OBSERVATION", work.mint, { signature: work.signature, slot: work.slot, status: result.status }, `helius-failed:${work.signature}`);
        } else if (result.status === "DATA_INCOMPLETE") {
          this.status.incompleteHeliusTransactions += 1;
          this.heliusState = takeHeliusWork(this.heliusState).state;
          workDequeued = true;
          this.heliusState = {
            ...this.heliusState,
            incompleteMints: [...new Set([...this.heliusState.incompleteMints, work.mint])].slice(-10)
          };
          const retry = retryHeliusSignatureWork(this.heliusState, work, Date.now());
          this.heliusState = retry.state;
          await this.appendAudit("DATA_GAP", work.mint, {
            signature: work.signature, slot: work.slot, status: result.status,
            reason: result.reason, retryAttempt: (work.retryAttempt ?? 0) + 1,
            retryOutcome: retry.outcome, retryAfterAt: retry.retryAfterAt
          }, `helius-incomplete:${work.signature}:attempt:${(work.retryAttempt ?? 0) + 1}`);
          if (retry.outcome === "EXHAUSTED" || retry.outcome === "OVERFLOW") {
            this.heliusState = {
              ...this.heliusState,
              incompleteMints: [...new Set([...this.heliusState.incompleteMints, work.mint])].slice(-10)
            };
            await this.markHistoricalDecodeIncomplete(work, "Historical signature exhausted bounded transient retries.");
          }
        }
        if (!workDequeued) this.heliusState = takeHeliusWork(this.heliusState).state;
        await this.ctx.storage.put({
          helius_monitor_state: this.heliusState,
          verified_transactions: this.verifiedTransactions,
          status: this.status
        });
        activeWork = null;
        processedItems += 1;
      }
      if (this.status.enabled && processedItems >= maxItemsPerDrain) {
        await this.ctx.storage.setAlarm(Date.now() + 5_000);
      }
      await this.scanIndependentHeliusGapHistory().catch(() => undefined);
      await this.decodeIndependentHeliusGapHistory().catch(() => undefined);
      await this.flushIndependentHeliusGapArchives().catch(() => undefined);
      await this.recoverCoveredHeliusGaps().catch(() => undefined);
    } catch {
      this.status.lastError = "Helius queue processing failed; affected candidate data may be incomplete.";
      this.auditInBackground("ERROR", activeWork?.mint ?? null, { subsystem: "HELIUS_QUEUE", message: this.status.lastError });
      // Only remove the item that actually failed. A storage failure after a
      // successful dequeue must never discard the next candidate's work.
      if (activeWork) {
        if (this.heliusState.queue[0]?.signature === activeWork.signature &&
            (this.heliusState.queue[0]?.retryAttempt ?? 0) === (activeWork.retryAttempt ?? 0)) {
          this.heliusState = takeHeliusWork(this.heliusState).state;
        }
        if (!this.heliusState.queue.some(item => item.signature === activeWork.signature)) {
          const retry = retryHeliusSignatureWork(this.heliusState, activeWork, Date.now());
          this.heliusState = retry.state;
          if (retry.retryAfterAt) await this.ctx.storage.setAlarm(Date.parse(retry.retryAfterAt));
          if (retry.outcome !== "RETRY_SCHEDULED") {
            this.heliusState = {
              ...this.heliusState,
              incompleteMints: [...new Set([...this.heliusState.incompleteMints, activeWork.mint])].slice(-10)
            };
            await this.markHistoricalDecodeIncomplete(activeWork, "Historical signature processing failed after bounded retries.");
          }
        } else {
          const nextRetryAt = this.heliusState.queue
            .map(item => item.retryAfterAt ? Date.parse(item.retryAfterAt) : Number.NaN)
            .filter(at => Number.isFinite(at) && at > Date.now())
            .reduce((earliest, at) => earliest === null ? at : Math.min(earliest, at), null as number | null);
          if (nextRetryAt !== null) await this.ctx.storage.setAlarm(nextRetryAt);
        }
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

  /**
   * Independently scan one closed WebSocket interruption per queue cycle.
   * Cursor and accumulated pages live in Durable Object storage, so a Worker
   * restart resumes from the last validated Helius signature boundary.
   *
   * This phase only establishes signature-history coverage. It deliberately
   * does not mark the gap recovered: transaction decoding and Neon archive
   * acknowledgements are separate proof requirements.
   */
  private async scanIndependentHeliusGapHistory(): Promise<void> {
    const sessionId = this.activeSessionId;
    if (!sessionId || !this.status.enabled) return;
    const gaps = this.heliusState.coverageGaps.filter(item =>
      item.endedAt !== null && item.recoveredAt == null
    );
    for (const gap of gaps) {
      const key = `helius_gap_history:${sessionId}:${gap.mint}:${gap.startedAt}`;
      const subscription = this.heliusState.subscriptions.find(item => item.mint === gap.mint);
      const saved = await this.ctx.storage.get<{
        bondingCurve: string;
        status: "SCANNING" | "SCANNED" | "INCOMPLETE";
        resume?: HeliusGapHistoryResume;
        signatures: import("../../../../src/ingestion/helius-backfill.js").AddressSignatureInfo[];
        pagesScanned: number;
        reason: string | null;
        updatedAt: string;
      }>(key);
      // Skip this already-scanned interval and continue to the next one; a
      // completed scan must not starve later interruption intervals.
      if (saved?.status === "SCANNED") continue;
      const bondingCurve = saved?.bondingCurve ?? subscription?.bondingCurve;
      if (!bondingCurve) continue;

      const throttledFetcher: typeof fetch = async (input, init) => {
        while (!this.heliusBucket.tryTake()) {
          await new Promise(resolve => setTimeout(resolve, this.heliusBucket.retryAfterMs));
          if (!this.status.enabled || this.activeSessionId !== sessionId) {
            throw new Error("Helius gap scan paused because the paper session stopped.");
          }
        }
        return fetch(input, init);
      };
      const result = await fetchHeliusGapAddressHistory(
        bondingCurve,
        gap,
        { apiKey: this.env.HELIUS_API_KEY, commitment: "confirmed", fetcher: throttledFetcher },
        throttledFetcher,
        1_000,
        saved?.resume
      );
      const retryFromSavedBoundary = !result.complete && !result.resume && saved?.resume;
      const next = {
        bondingCurve,
        status: result.complete ? "SCANNED" as const : "SCANNING" as const,
        ...(result.resume ? { resume: result.resume } :
          retryFromSavedBoundary ? { resume: saved.resume } : {}),
        signatures: result.complete || result.resume ? result.signatures :
          retryFromSavedBoundary ? saved.signatures : result.signatures,
        pagesScanned: result.pagesScanned,
        reason: result.complete ? null : result.reason,
        updatedAt: new Date().toISOString()
      };
      await this.ctx.storage.put(key, next);
      await this.appendAudit(result.complete ? "OBSERVATION" : "DATA_GAP", gap.mint, {
        provider: "helius",
        independentGapHistory: next.status,
        startedAt: gap.startedAt,
        endedAt: gap.endedAt,
        pagesScanned: result.pagesScanned,
        signaturesScanned: next.signatures.length,
        resumable: Boolean(next.resume),
        reason: next.reason,
        storageKey: key
      }, `helius-gap-history:${sessionId}:${gap.mint}:${gap.startedAt}:${result.pagesScanned}`);
      return; // Bound work to one gap batch per queue cycle.
    }
  }

  /**
   * Decode the signature history for one independently scanned interruption.
   * Each cursor advance is durable and bounded to one transaction per queue
   * cycle. Only explicit failed transactions are terminal failures; unavailable
   * or non-matching transactions remain incomplete and are retried.
   *
   * Successful decoded transactions are retained in Durable Object storage.
   * Neon archival is a separate acknowledgement gate before recovery.
   */
  private async decodeIndependentHeliusGapHistory(): Promise<void> {
    const sessionId = this.activeSessionId;
    if (!sessionId || !this.status.enabled) return;
    for (const gap of this.heliusState.coverageGaps) {
      if (gap.endedAt === null || gap.recoveredAt != null) continue;
      const key = `helius_gap_history:${sessionId}:${gap.mint}:${gap.startedAt}`;
      const scan = await this.ctx.storage.get<{
        bondingCurve: string;
        status: "SCANNING" | "SCANNED" | "INCOMPLETE";
        signatures: import("../../../../src/ingestion/helius-backfill.js").AddressSignatureInfo[];
      }>(key);
      if (scan?.status !== "SCANNED") continue;
      const cursorKey = `${key}:decode_cursor`;
      const cursor = await this.ctx.storage.get<number>(cursorKey) ?? 0;
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > scan.signatures.length) {
        await this.ctx.storage.put(`${key}:decode_error`, {
          reason: "Persisted independent gap decode cursor is invalid.",
          updatedAt: new Date().toISOString()
        });
        return;
      }
      if (cursor >= scan.signatures.length) {
        await this.ctx.storage.put(`${key}:decode_status`, {
          status: "DECODED_PENDING_ARCHIVE",
          decodedAt: new Date().toISOString(),
          signatureCount: scan.signatures.length
        });
        continue;
      }
      const item = scan.signatures[cursor]!;
      while (!this.heliusBucket.tryTake()) {
        await new Promise(resolve => setTimeout(resolve, this.heliusBucket.retryAfterMs));
        if (!this.status.enabled || this.activeSessionId !== sessionId) return;
      }
      const result = await fetchAndVerifyPumpTransaction(item.signature, gap.mint, {
        apiKey: this.env.HELIUS_API_KEY,
        commitment: "confirmed"
      });
      if (result.status === "DATA_INCOMPLETE" || result.status === "NOT_RELEVANT") {
        await this.ctx.storage.put(`${key}:decode_error`, {
          signature: item.signature,
          reason: result.reason,
          cursor,
          updatedAt: new Date().toISOString()
        });
        await this.appendAudit("DATA_GAP", gap.mint, {
          provider: "helius",
          independentGapDecode: "WAITING",
          signature: item.signature,
          cursor,
          reason: result.reason
        }, `helius-gap-decode-wait:${sessionId}:${gap.mint}:${gap.startedAt}:${item.signature}`);
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
        return;
      }
      if (result.status === "VERIFIED") {
        if (result.transaction.slot !== item.slot) {
          await this.ctx.storage.put(`${key}:decode_error`, {
            signature: item.signature,
            reason: "Decoded transaction slot does not match independently scanned signature history.",
            cursor,
            updatedAt: new Date().toISOString()
          });
          return;
        }
        const verifiedKey = `${key}:verified_transactions`;
        const verified = await this.ctx.storage.get<Record<string, VerifiedPumpTransaction>>(verifiedKey) ?? {};
        verified[item.signature] = result.transaction;
        await this.ctx.storage.put(verifiedKey, verified);
        const signaturesKey = `${key}:verified_signatures`;
        const signatures = new Set(await this.ctx.storage.get<string[]>(signaturesKey) ?? []);
        signatures.add(item.signature);
        await this.ctx.storage.put(signaturesKey, [...signatures]);
      } else {
        const failedKey = `${key}:failed_signatures`;
        const failed = new Set(await this.ctx.storage.get<string[]>(failedKey) ?? []);
        failed.add(item.signature);
        await this.ctx.storage.put(failedKey, [...failed]);
      }
      await this.ctx.storage.put(cursorKey, cursor + 1);
      await this.appendAudit("OBSERVATION", gap.mint, {
        provider: "helius",
        independentGapDecode: result.status,
        signature: item.signature,
        slot: item.slot,
        cursor: cursor + 1,
        totalSignatures: scan.signatures.length
      }, `helius-gap-decode:${sessionId}:${gap.mint}:${gap.startedAt}:${item.signature}`);
      return; // One getTransaction request per queue cycle.
    }
  }

  /**
   * Ship independently decoded gap evidence to the dedicated Neon archive.
   * Transactions are sent one at a time and marked locally archived only after
   * the API acknowledges the idempotent database write.
   */
  private async flushIndependentHeliusGapArchives(): Promise<void> {
    const sessionId = this.activeSessionId;
    if (!sessionId || !this.postgresIngestConfigured) return;
    for (const gap of this.heliusState.coverageGaps) {
      if (gap.endedAt === null || gap.recoveredAt != null ||
          !gap.startSignature || gap.startSlot === null ||
          !gap.endSignature || gap.endSlot === null) continue;
      const key = `helius_gap_history:${sessionId}:${gap.mint}:${gap.startedAt}`;
      const archiveStatus = await this.ctx.storage.get<{ status: string }>(`${key}:archive_status`);
      if (archiveStatus?.status === "ARCHIVED") continue;
      const scan = await this.ctx.storage.get<{
        bondingCurve: string;
        status: "SCANNING" | "SCANNED" | "INCOMPLETE";
        signatures: import("../../../../src/ingestion/helius-backfill.js").AddressSignatureInfo[];
        pagesScanned: number;
      }>(key);
      if (scan?.status !== "SCANNED") continue;
      const cursor = await this.ctx.storage.get<number>(`${key}:decode_cursor`) ?? 0;
      const verifiedSignatures = await this.ctx.storage.get<string[]>(`${key}:verified_signatures`) ?? [];
      const failedSignatures = await this.ctx.storage.get<string[]>(`${key}:failed_signatures`) ?? [];
      const transactions = await this.ctx.storage.get<Record<string, VerifiedPumpTransaction>>(
        `${key}:verified_transactions`
      ) ?? {};
      const archivedKey = `${key}:archived_signatures`;
      const archived = new Set(await this.ctx.storage.get<string[]>(archivedKey) ?? []);
      const completeDecode = cursor === scan.signatures.length &&
        verifiedSignatures.length + failedSignatures.length === scan.signatures.length;
      const state = {
        bondingCurve: scan.bondingCurve,
        startedAt: gap.startedAt,
        endedAt: gap.endedAt,
        startSignature: gap.startSignature,
        startSlot: gap.startSlot,
        endSignature: gap.endSignature,
        endSlot: gap.endSlot,
        pagesScanned: scan.pagesScanned,
        signatures: scan.signatures,
        decodeCursor: cursor,
        verifiedSignatures,
        failedSignatures,
        status: completeDecode ? "DECODED" as const : "DECODING" as const
      };
      const checkpoint = await this.postPostgresIngest("/internal/helius-gap-recovery", {
        sessionId, mint: gap.mint, gap: state
      });
      if (!checkpoint.ok) {
        this.status.lastError = "Independent Helius gap checkpoint is waiting for Neon acknowledgement.";
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
        return;
      }
      for (const signature of verifiedSignatures) {
        if (archived.has(signature)) continue;
        const transaction = transactions[signature];
        if (!transaction) {
          this.status.lastError = "Verified Helius gap transaction is missing from durable local storage.";
          await this.ctx.storage.setAlarm(Date.now() + 30_000);
          return;
        }
        const response = await this.postPostgresIngest("/internal/helius-gap-recovery", {
          sessionId, mint: gap.mint, gap: state,
          transaction: {
            ...jsonSafe(transaction) as Record<string, unknown>,
            provider: "helius", commitment: "confirmed",
            receivedAt: transaction.receivedAt ?? new Date().toISOString()
          }
        });
        if (!response.ok) {
          this.status.lastError = "Independent Helius gap transaction is waiting for Neon acknowledgement.";
          await this.ctx.storage.setAlarm(Date.now() + 30_000);
          return;
        }
        archived.add(signature);
        await this.ctx.storage.put(archivedKey, [...archived]);
        return; // Bound Neon transaction writes to one per queue cycle.
      }
      if (completeDecode && archived.size === verifiedSignatures.length) {
        const finalized = await this.postPostgresIngest("/internal/helius-gap-recovery", {
          sessionId, mint: gap.mint, gap: { ...state, status: "ARCHIVED" }
        });
        if (!finalized.ok) {
          this.status.lastError = "Independent Helius gap final archive acknowledgement is pending.";
          await this.ctx.storage.setAlarm(Date.now() + 30_000);
          return;
        }
        await this.ctx.storage.put(`${key}:archive_status`, {
          status: "ARCHIVED",
          archivedAt: new Date().toISOString(),
          archivedSignatureCount: archived.size
        });
      }
    }
  }

  /**
   * Recover only interruptions wholly contained in an already completed,
   * PostgreSQL-acknowledged launch-window backfill. Gaps outside that exact
   * window remain incomplete; reconnects never clear them.
   */
  private async recoverCoveredHeliusGaps(): Promise<void> {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    const gaps = this.heliusState.coverageGaps.filter(gap =>
      gap.endedAt !== null && gap.recoveredAt == null
    );
    for (const gap of gaps) {
      const independentKey = `helius_gap_history:${sessionId}:${gap.mint}:${gap.startedAt}`;
      const independentScan = await this.ctx.storage.get<{
        status: "SCANNING" | "SCANNED" | "INCOMPLETE";
        signatures: import("../../../../src/ingestion/helius-backfill.js").AddressSignatureInfo[];
      }>(independentKey);
      const independentArchive = await this.ctx.storage.get<{ status: string }>(
        `${independentKey}:archive_status`
      );
      if (independentScan?.status === "SCANNED" && independentArchive?.status === "ARCHIVED") {
        const [verifiedSignatures, failedSignatures, archivedSignatures] = await Promise.all([
          this.ctx.storage.get<string[]>(`${independentKey}:verified_signatures`),
          this.ctx.storage.get<string[]>(`${independentKey}:failed_signatures`),
          this.ctx.storage.get<string[]>(`${independentKey}:archived_signatures`)
        ]);
        const proof = assessHeliusGapRecovery({
          gap,
          signatures: independentScan.signatures,
          verifiedSignatures: verifiedSignatures ?? [],
          failedSignatures: failedSignatures ?? [],
          archivedSignatures: archivedSignatures ?? []
        });
        if (proof.recovered) {
          const recovered = markHeliusCoverageGapRecovered(
            this.heliusState, gap.mint, gap.startedAt,
            { recovered: true, recoveredSignatures: proof.recoveredSignatures }
          );
          if (recovered !== this.heliusState) {
            this.heliusState = recovered;
            await this.ctx.storage.put("helius_monitor_state", this.heliusState);
            await this.appendAudit("OBSERVATION", gap.mint, {
              provider: "helius",
              historicalGapRecovery: "RECOVERED",
              startedAt: gap.startedAt,
              endedAt: gap.endedAt,
              recoveredSignatures: proof.recoveredSignatures,
              evidenceSource: "INDEPENDENT_GAP_HISTORY_AND_NEON_ARCHIVE_ACKNOWLEDGEMENTS"
            }, "helius-gap-recovered:" + sessionId + ":" + gap.mint + ":" + gap.startedAt);
          }
          continue;
        }
      }
      const backfill = await this.ctx.storage.get<HistoricalBackfillState>(
        "helius_backfill:" + sessionId + ":" + gap.mint
      );
      if (!backfill || backfill.status !== "COMPLETE") continue;
      const decodeCoverage = await this.getHistoricalDecodeCoverage(sessionId, gap.mint, backfill);
      if (!decodeCoverage.complete) continue;
      const [verifiedSignatures, failedSignatures, archivedSignatures] = await Promise.all([
        this.ctx.storage.get<string[]>("helius_verified_historical_signatures:" + sessionId + ":" + gap.mint),
        this.ctx.storage.get<string[]>("helius_failed_historical_signatures:" + sessionId + ":" + gap.mint),
        this.ctx.storage.get<string[]>("helius_archived_transaction_signatures:" + sessionId + ":" + gap.mint)
      ]);
      const proof = assessHeliusGapRecovery({
        gap,
        signatures: backfill.signatures,
        verifiedSignatures: verifiedSignatures ?? [],
        failedSignatures: failedSignatures ?? [],
        archivedSignatures: archivedSignatures ?? []
      });
      if (!proof.recovered) continue;
      const recovered = markHeliusCoverageGapRecovered(
        this.heliusState, gap.mint, gap.startedAt,
        { recovered: true, recoveredSignatures: proof.recoveredSignatures }
      );
      if (recovered === this.heliusState) continue;
      this.heliusState = recovered;
      await this.ctx.storage.put("helius_monitor_state", this.heliusState);
      await this.appendAudit("OBSERVATION", gap.mint, {
        provider: "helius",
        historicalGapRecovery: "RECOVERED",
        startedAt: gap.startedAt,
        endedAt: gap.endedAt,
        recoveredSignatures: proof.recoveredSignatures,
        evidenceSource: "COMPLETE_LAUNCH_WINDOW_BACKFILL_AND_POSTGRES_ACKNOWLEDGEMENTS"
      }, "helius-gap-recovered:" + sessionId + ":" + gap.mint + ":" + gap.startedAt);
    }
  }
  private markHeliusCoverageGap(): void {
    const now = new Date().toISOString();
    const previouslyIncomplete = new Set(this.heliusState.incompleteMints);
    const affectedMints = [...new Set(this.heliusState.subscriptions.map(item => item.mint))];
    for (const mint of affectedMints) {
      this.heliusState = recordHeliusCoverageGap(this.heliusState, mint, now);
    }
    const newlyIncomplete = affectedMints.filter(mint => !previouslyIncomplete.has(mint));
    if (affectedMints.length === 0) return;
    this.status.incompleteHeliusTransactions += newlyIncomplete.length;
    this.auditInBackground("DATA_GAP", null, {
      reason: "HELIUS_COVERAGE_INTERRUPTED",
      affectedMints,
      intervals: this.heliusState.coverageGaps.filter(gap =>
        affectedMints.includes(gap.mint) && gap.endedAt === null
      )
    });
    void this.ctx.storage.put("helius_monitor_state", this.heliusState).catch(() => undefined);
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
      wallet_holdings_by_mint: this.walletHoldingsByMint,
      holder_risk_snapshots: this.holderRiskSnapshots,
      risk_evidence_attempted_at_by_mint: this.riskEvidenceAttemptedAtByMint
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

async function authorized(request: Request, env: Env): Promise<boolean> {
  const authorization = request.headers.get("authorization") ?? "";
  const expected = env.CONTROL_TOKEN;
  if (!expected || !authorization.startsWith("Bearer ")) return false;

  // Compare the configured secret directly in constant time. A committed
  // fallback hash would keep old credentials valid after token rotation.
  const supplied = new TextEncoder().encode(authorization.slice("Bearer ".length));
  const configured = new TextEncoder().encode(expected);
  if (supplied.length !== configured.length) return false;
  let difference = 0;
  for (let index = 0; index < supplied.length; index += 1) {
    difference |= supplied[index]! ^ configured[index]!;
  }
  return difference === 0;
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
        enabled: status.enabled,
        heliusConnected: status.heliusConnected,
        candidates: status.candidates,
        monitoredCandidates: status.monitoredCandidates,
        verifiedTransactions: status.verifiedTransactions,
        blocker: status.blocker
      }, { headers: { "cache-control": "no-store" } });
    }

    if (!(await authorized(request, env))) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (url.pathname === "/smoke-ingestion" && request.method === "POST") {
      try {
        return Response.json(await coordinator.smokeIngestion());
      } catch (error) {
        // This route is control-token authenticated. Return only the bounded
        // stage/message emitted by the smoke check; never include request
        // headers, environment values or credential material.
        const detail = error instanceof Error ? error.message.slice(0, 240) : "Unknown ingestion failure.";
        return Response.json({
          error: "Worker-to-Vercel/Neon ingestion smoke test failed.",
          detail
        }, { status: 503 });
      }
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
    if (url.pathname === "/dashboard" && request.method === "GET") {
      return Response.json(await coordinator.getOperatorDashboardSnapshot(), {
        headers: { "cache-control": "no-store" }
      });
    }
    if (url.pathname === "/candidates" && request.method === "GET") {
      return Response.json(await coordinator.listCandidates());
    }


    if (url.pathname === "/paper-curve-quote" && request.method === "POST") {
      let body: unknown;
      try { body = await request.json(); } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
      const { mint, side, amountBaseUnits } = value;
      if (typeof mint !== "string" || !mint.trim() ||
          (side !== "BUY" && side !== "SELL") ||
          typeof amountBaseUnits !== "string" || !/^\d+$/.test(amountBaseUnits) ||
          amountBaseUnits.length > 20 || BigInt(amountBaseUnits || "0") <= 0n ||
          BigInt(amountBaseUnits || "0") > 18_446_744_073_709_551_615n) {
        return Response.json({
          error: "mint, side (BUY|SELL), and positive u64 amountBaseUnits are required"
        }, { status: 400 });
      }
      try {
        return Response.json(await coordinator.requestPumpCurveQuote({
          mint, side, amountBaseUnits
        }));
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message : "Unable to create Pump curve quote"
        }, { status: 409 });
      }
    }

    if (url.pathname === "/paper-quote" && request.method === "POST") {
      let body: unknown;
      try { body = await request.json(); } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
      const { mint, poolAddress, side, amountBaseUnits } = value;
      if (typeof mint !== "string" || !mint.trim() ||
          typeof poolAddress !== "string" || !poolAddress.trim() ||
          (side !== "BUY" && side !== "SELL") ||
          typeof amountBaseUnits !== "string" || !/^\d+$/.test(amountBaseUnits) ||
          amountBaseUnits.length > 20 || BigInt(amountBaseUnits || "0") <= 0n ||
          BigInt(amountBaseUnits || "0") > 18_446_744_073_709_551_615n) {
        return Response.json({
          error: "mint, poolAddress, side (BUY|SELL), and positive integer amountBaseUnits are required"
        }, { status: 400 });
      }
      try {
        return Response.json(await coordinator.requestPumpSwapQuote({
          mint, poolAddress, side, amountBaseUnits
        }));
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message : "Unable to create PumpSwap quote"
        }, { status: 409 });
      }
    }


    if (url.pathname === "/executable-round-trip-quote" && request.method === "POST") {
      let body: unknown;
      try { body = await request.json(); } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
      const { mint, venue, buyAmountBaseUnits, poolAddress } = value;
      if (typeof mint !== "string" || !mint.trim() ||
          (venue !== "PUMP_CURVE" && venue !== "PUMPSWAP") ||
          typeof buyAmountBaseUnits !== "string" || !/^\d+$/.test(buyAmountBaseUnits) ||
          buyAmountBaseUnits.length > 20 || BigInt(buyAmountBaseUnits || "0") <= 0n ||
          BigInt(buyAmountBaseUnits || "0") > 18_446_744_073_709_551_615n ||
          (venue === "PUMPSWAP" && (typeof poolAddress !== "string" || !poolAddress.trim()))) {
        return Response.json({
          error: "mint, venue, positive u64 buyAmountBaseUnits, and poolAddress for PUMPSWAP are required"
        }, { status: 400 });
      }
      try {
        const result = await coordinator.requestExecutableRoundTripQuote({
          mint, venue, buyAmountBaseUnits,
          ...(typeof poolAddress === "string" ? { poolAddress } : {})
        });
        return Response.json(jsonSafe(result), { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message : "Unable to validate executable round-trip quote",
          paperEntryAuthorized: false
        }, { status: 409 });
      }
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
    context.waitUntil((async () => {
      await coordinator.ensureRunning();
      await coordinator.collectNextRiskEvidence();
    })());
  }
};
