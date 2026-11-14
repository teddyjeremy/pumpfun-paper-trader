import { describe, expect, it, vi } from "vitest";
import { PumpFunCoordinator } from "../infra/cloudflare/worker/src/index.js";
import {
  applyAddressSignaturesPage,
  createHistoricalBackfillState
} from "../src/ingestion/helius-backfill.js";
import {
  emptyHeliusMonitorState,
  enqueueHeliusSignatureWork,
  takeHeliusWork,
  type HeliusMonitorState
} from "../src/ingestion/helius-monitor.js";
import { emptyDiscoveryStore } from "../src/ingestion/discovery-store.js";

type Stored = Map<string, unknown>;

class MemoryDurableStorage {
  private values: Stored = new Map();
  private transactionTail: Promise<unknown> = Promise.resolve();
  failNextPut = false;
  lastAlarmAt: number | null = null;
  async setAlarm(timestamp: number): Promise<void> { this.lastAlarmAt = timestamp; }

  seed(key: string, value: unknown): void {
    this.values.set(key, structuredClone(value));
  }
  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }
  async put(keyOrValues: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("simulated storage quota failure");
    }
    if (typeof keyOrValues === "string") this.values.set(keyOrValues, structuredClone(value));
    else for (const [key, item] of Object.entries(keyOrValues)) this.values.set(key, structuredClone(item));
  }
  async transaction<T>(callback: (txn: this) => Promise<T>): Promise<T> {
    const run = this.transactionTail.then(async () => {
      const before = structuredClone(this.values);
      try { return await callback(this); }
      catch (error) { this.values = before; throw error; }
    });
    this.transactionTail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function harness(storage = new MemoryDurableStorage(), env: Record<string, string> = {}) {
  const ctx = {
    storage,
    waitUntil: (_promise: Promise<unknown>) => undefined,
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback()
  };
  const coordinator = new PumpFunCoordinator(ctx as never, env as never);
  return { coordinator, storage };
}
function seedSession(storage: MemoryDurableStorage, enabled = false): void {
  const sessionId = "runtime-test-session";
  storage.seed("active_audit_session_id", sessionId);
  storage.seed("audit_session_ids", [sessionId]);
  storage.seed("latest_audit_session_id", sessionId);
  storage.seed("enabled", enabled);
  storage.seed("status", { enabled, connected: false, subscriptionsSent: false, heliusConnected: false });
  storage.seed(`audit_session:${sessionId}`, {
    sessionId, startedAt: "2026-11-12T12:00:00.000Z", stoppedAt: null,
    strategyVersion: "strict-v1", eventCount: 0, initialBankrollUsd: 2.7,
    topUpAmountUsd: 2.7, topUpThresholdUsd: 1, topUpCount: 0, totalTopUpsUsd: 0
  });
}
function append(coordinator: PumpFunCoordinator) {
  return (coordinator as unknown as {
    appendAudit: (kind: string, mint: string | null, data: unknown, key?: string, sessionId?: string) => Promise<void>
  }).appendAudit.bind(coordinator);
}

describe("operator dashboard snapshot", () => {
  it("returns bounded live candidates and keeps paper execution explicitly disabled", async () => {
    const { coordinator, storage } = harness();
    seedSession(storage);
    storage.seed("discovery_state", {
      ...emptyDiscoveryStore(),
      candidates: [{
        kind: "new_token", mint: "test-mint", signature: "sig", creator: "creator",
        bondingCurve: "curve", name: "Test", symbol: "TST", receivedAt: "2026-11-12T12:00:00.000Z",
        status: "DISCOVERED", firstSeenAt: "2026-11-12T12:00:00.000Z",
        lastSeenAt: "2026-11-12T12:00:01.000Z", observations: 2
      }]
    });
    const snapshot = await coordinator.getOperatorDashboardSnapshot() as {
      status: { tradingReady: false; enabled: boolean };
      candidates: Array<{ mint: string; observations: number }>;
      recentActivity: unknown[];
    };
    expect(snapshot.status.tradingReady).toBe(false);
    expect(snapshot.status.enabled).toBe(false);
    expect(snapshot.candidates).toMatchObject([{ mint: "test-mint", observations: 2 }]);
    expect(snapshot.recentActivity).toEqual([]);
  });
});

describe("Durable Object audit storage contract", () => {
  it("serializes concurrent appends into monotonic sequences and paginates across page boundaries", async () => {
    const { coordinator, storage } = harness();
    seedSession(storage);
    const write = append(coordinator);
    await Promise.all(Array.from({ length: 205 }, (_, index) =>
      write("OBSERVATION", "mint", { index }, `event-${index}`, "runtime-test-session")
    ));
    const first = await coordinator.listAuditEvents(0, 100, "runtime-test-session") as {
      events: Array<{ sequence: number }>; nextAfter: number | null; totalEvents: number
    };
    const second = await coordinator.listAuditEvents(first.nextAfter ?? 0, 100, "runtime-test-session") as {
      events: Array<{ sequence: number }>; nextAfter: number | null; totalEvents: number
    };
    const third = await coordinator.listAuditEvents(second.nextAfter ?? 0, 100, "runtime-test-session") as {
      events: Array<{ sequence: number }>; nextAfter: number | null; totalEvents: number
    };
    expect(first.events.map(event => event.sequence)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(second.events.map(event => event.sequence)).toEqual(Array.from({ length: 100 }, (_, i) => i + 101));
    expect(third.events.map(event => event.sequence)).toEqual([201, 202, 203, 204, 205]);
    expect([first.totalEvents, second.totalEvents, third.totalEvents]).toEqual([205, 205, 205]);
    expect(third.nextAfter).toBeNull();
  });

  it("deduplicates repeated provider event IDs without consuming another sequence", async () => {
    const { coordinator, storage } = harness();
    seedSession(storage);
    const write = append(coordinator);
    await write("OBSERVATION", "mint", { signature: "sig" }, "signature:sig", "runtime-test-session");
    await write("OBSERVATION", "mint", { signature: "sig" }, "signature:sig", "runtime-test-session");
    const page = await coordinator.listAuditEvents(0, 100, "runtime-test-session") as {
      events: Array<{ sequence: number; eventId: string }>; totalEvents: number
    };
    expect(page.totalEvents).toBe(1);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ sequence: 1, eventId: "signature:sig" });
  });

  it("rolls back a failed append and can continue without a sequence gap", async () => {
    const { coordinator, storage } = harness();
    seedSession(storage);
    const write = append(coordinator);
    storage.failNextPut = true;
    await expect(write("OBSERVATION", "mint", { failed: true }, "failed-event", "runtime-test-session"))
      .rejects.toThrow(/quota failure/);
    await write("OBSERVATION", "mint", { recovered: true }, "recovered-event", "runtime-test-session");
    const page = await coordinator.listAuditEvents(0, 100, "runtime-test-session") as {
      events: Array<{ sequence: number; eventId: string }>; totalEvents: number
    };
    expect(page.totalEvents).toBe(1);
    expect(page.events).toEqual([expect.objectContaining({ sequence: 1, eventId: "recovered-event" })]);
  });

  it("records a restart marker while preserving the existing session journal", async () => {
    const storage = new MemoryDurableStorage();
    seedSession(storage, true);
    const first = harness(storage);
    await append(first.coordinator)("OBSERVATION", "mint", { beforeRestart: true }, "before-restart", "runtime-test-session");
    const restarted = harness(storage);
    const page = await restarted.coordinator.listAuditEvents(0, 100, "runtime-test-session") as {
      events: Array<{ kind: string; sequence: number }>; totalEvents: number
    };
    expect(page.events.map(event => event.kind)).toEqual(["OBSERVATION", "WORKER_RESTARTED"]);
    expect(page.events.map(event => event.sequence)).toEqual([1, 2]);
    expect(page.totalEvents).toBe(2);
  });


  it("resumes a completed backfill after a queue overflow and Durable Object restart", async () => {
    const storage = new MemoryDurableStorage();
    seedSession(storage, true);
    const mint = "So11111111111111111111111111111111111111112";
    const createSignature = "5".repeat(64);
    const newerSignature = "6".repeat(64);
    const initial = createHistoricalBackfillState({
      mint, bondingCurve: mint, createSignature, launchBlockTime: 1000
    });
    const completed = applyAddressSignaturesPage(initial, [
      { signature: newerSignature, slot: 12, blockTime: 1060, err: null },
      { signature: createSignature, slot: 10, blockTime: 1000, err: null }
    ]);
    expect(completed.status).toBe("COMPLETE");

    let monitor = emptyHeliusMonitorState();
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    for (let i = 0; i < 199; i += 1) {
      const signature = "1".repeat(62) + alphabet[Math.floor(i / alphabet.length)] + alphabet[i % alphabet.length];
      monitor = enqueueHeliusSignatureWork(monitor, { signature, mint, slot: i + 1 }).state;
    }

    const stateKey = `helius_backfill:runtime-test-session:${mint}`;
    const cursorKey = `helius_backfill_queue_cursor:runtime-test-session:${mint}`;
    storage.seed(`helius_backfill_mints:runtime-test-session`, [mint]);
    storage.seed(stateKey, completed.state);
    storage.seed("helius_monitor_state", monitor);

    const first = harness(storage, { PAPER_ENABLE_HISTORICAL_BACKFILL: "true" }).coordinator as unknown as {
      activeSessionId: string | null;
      heliusState: HeliusMonitorState;
      advanceHistoricalBackfill: () => Promise<boolean>;
    };
    first.activeSessionId = "runtime-test-session";
    first.heliusState = monitor;
    await first.advanceHistoricalBackfill();

    expect(await storage.get<number>(cursorKey)).toBe(1);
    let savedMonitor = await storage.get<HeliusMonitorState>("helius_monitor_state");
    expect(savedMonitor?.queue).toHaveLength(200);
    expect(savedMonitor?.seenSignatures).not.toContain(createSignature);

    // Drain one item, evict the coordinator, and resume from the durable cursor.
    savedMonitor = takeHeliusWork(savedMonitor!).state;
    storage.seed("helius_monitor_state", savedMonitor);
    const restarted = harness(storage, { PAPER_ENABLE_HISTORICAL_BACKFILL: "true" }).coordinator as unknown as {
      activeSessionId: string | null;
      heliusState: HeliusMonitorState;
      advanceHistoricalBackfill: () => Promise<boolean>;
    };
    restarted.activeSessionId = "runtime-test-session";
    restarted.heliusState = savedMonitor;
    await restarted.advanceHistoricalBackfill();

    expect(await storage.get<number>(cursorKey)).toBe(2);
    const resumedMonitor = await storage.get<HeliusMonitorState>("helius_monitor_state");
    expect(resumedMonitor?.queue.some(item => item.signature === createSignature)).toBe(true);
  });


  it("repairs an orphaned backfill state by restoring its session mint index", async () => {
    const storage = new MemoryDurableStorage();
    seedSession(storage, true);
    const mint = "So11111111111111111111111111111111111111112";
    const signature = "5".repeat(64);
    const state = createHistoricalBackfillState({
      mint, bondingCurve: mint, createSignature: signature, launchBlockTime: 1000
    });
    storage.seed(`helius_backfill:runtime-test-session:${mint}`, state);

    const coordinator = harness(storage).coordinator as unknown as {
      activeSessionId: string | null;
      beginHistoricalBackfill: (transaction: unknown) => Promise<void>;
    };
    coordinator.activeSessionId = "runtime-test-session";
    await coordinator.beginHistoricalBackfill({
      signature,
      mint,
      createEvents: [{ mint, bondingCurve: mint, timestamp: "1000" }]
    });

    expect(await storage.get<string[]>(`helius_backfill_mints:runtime-test-session`)).toEqual([mint]);
  });


  it("does not substitute the Pump event timestamp for a missing verified RPC block time", async () => {
    const storage = new MemoryDurableStorage();
    seedSession(storage, true);
    const mint = "So11111111111111111111111111111111111111112";
    const signature = "5".repeat(64);
    const coordinator = harness(storage).coordinator as unknown as {
      activeSessionId: string | null;
      beginHistoricalBackfill: (transaction: unknown) => Promise<void>;
    };
    coordinator.activeSessionId = "runtime-test-session";
    await coordinator.beginHistoricalBackfill({
      signature,
      mint,
      createEvents: [{ mint, bondingCurve: mint, timestamp: "1000" }]
    });

    const state = await storage.get<{
      status: string; launchBlockTime: number | null; reason: string | null
    }>(`helius_backfill:runtime-test-session:${mint}`);
    expect(state).toMatchObject({
      status: "INCOMPLETE",
      launchBlockTime: null,
      reason: "Verified launch block time is unavailable."
    });
  });


  it("automatically collects one holder snapshot for a monitored launched candidate per cron interval", async () => {
    const storage = new MemoryDurableStorage();
    seedSession(storage, true);
    const mint = "So11111111111111111111111111111111111111112";
    const monitor = emptyHeliusMonitorState();
    monitor.subscriptions = [{
      requestId: 1, subscriptionId: null, mint, bondingCurve: mint, subscribedAt: null
    }];
    const discovery = emptyDiscoveryStore();
    discovery.candidates = [{
      kind: "new_token", mint, bondingCurve: mint, signature: null, creator: null,
      name: null, symbol: null, receivedAt: "2026-11-12T12:00:00.000Z",
      firstSeenAt: "2026-11-12T12:00:00.000Z", lastSeenAt: "2026-11-12T12:00:00.000Z",
      observations: 1, status: "DISCOVERED"
    }];
    storage.seed("helius_monitor_state", monitor);
    storage.seed("discovery_state", discovery);
    storage.seed("verified_transactions", [{ createEvents: [{ mint }], tradeEvents: [] }]);
    storage.seed("holder_risk_snapshots", {
      [mint]: { status: "OBSERVED", snapshot: { observedAt: "not-a-date" } }
    });

    const { coordinator } = harness(storage, { HELIUS_API_KEY: "test-key" });
    const holder = vi.spyOn(coordinator, "getHolderRisk").mockResolvedValue({
      status: "DATA_INCOMPLETE", mint, reason: "fixture"
    });
    const links = vi.spyOn(coordinator, "collectWalletLinks").mockResolvedValue({ status: "OBSERVED" });

    const result = await coordinator.collectNextRiskEvidence();
    expect(result).toMatchObject({ status: "DATA_INCOMPLETE", mint, evidenceType: "HOLDER_CONCENTRATION", evidenceStatus: "DATA_INCOMPLETE" });
    expect(holder).toHaveBeenCalledTimes(1);
    expect(links).not.toHaveBeenCalled();

    const retry = await coordinator.collectNextRiskEvidence();
    expect(retry).toMatchObject({ status: "IDLE" });
    expect(holder).toHaveBeenCalledTimes(1);
  });

  it("waits for two distinct trade wallets before spending RPC budget on wallet-link evidence", async () => {
    const storage = new MemoryDurableStorage();
    seedSession(storage, true);
    const mint = "So11111111111111111111111111111111111111112";
    const monitor = emptyHeliusMonitorState();
    monitor.subscriptions = [{
      requestId: 1, subscriptionId: null, mint, bondingCurve: mint, subscribedAt: null
    }];
    const discovery = emptyDiscoveryStore();
    discovery.candidates = [{
      kind: "new_token", mint, bondingCurve: mint, signature: null, creator: null,
      name: null, symbol: null, receivedAt: "2026-11-12T12:00:00.000Z",
      firstSeenAt: "2026-11-12T12:00:00.000Z", lastSeenAt: "2026-11-12T12:00:00.000Z",
      observations: 1, status: "DISCOVERED"
    }];
    storage.seed("helius_monitor_state", monitor);
    storage.seed("discovery_state", discovery);
    storage.seed("holder_risk_snapshots", {
      [mint]: { status: "OBSERVED", snapshot: { observedAt: new Date().toISOString() } }
    });
    storage.seed("verified_transactions", [{
      createEvents: [{ mint }],
      tradeEvents: [{ mint, user: "11111111111111111111111111111111", quoteAmount: 1n }]
    }]);

    const { coordinator } = harness(storage, { HELIUS_API_KEY: "test-key" });
    const links = vi.spyOn(coordinator, "collectWalletLinks").mockResolvedValue({ status: "OBSERVED" });
    const result = await coordinator.collectNextRiskEvidence();
    expect(result).toMatchObject({ status: "IDLE" });
    expect(links).not.toHaveBeenCalled();
  });


  it("collects wallet-link evidence only after two distinct traders are observed", async () => {
    const storage = new MemoryDurableStorage();
    seedSession(storage, true);
    const mint = "So11111111111111111111111111111111111111112";
    const monitor = emptyHeliusMonitorState();
    monitor.subscriptions = [{
      requestId: 1, subscriptionId: null, mint, bondingCurve: mint, subscribedAt: null
    }];
    const discovery = emptyDiscoveryStore();
    discovery.candidates = [{
      kind: "new_token", mint, bondingCurve: mint, signature: null, creator: null,
      name: null, symbol: null, receivedAt: "2026-11-12T12:00:00.000Z",
      firstSeenAt: "2026-11-12T12:00:00.000Z", lastSeenAt: "2026-11-12T12:00:00.000Z",
      observations: 1, status: "DISCOVERED"
    }];
    storage.seed("helius_monitor_state", monitor);
    storage.seed("discovery_state", discovery);
    storage.seed("holder_risk_snapshots", {
      [mint]: { status: "OBSERVED", snapshot: { observedAt: new Date().toISOString() } }
    });
    storage.seed("verified_transactions", [{
      createEvents: [{ mint }],
      tradeEvents: [
        { mint, user: "11111111111111111111111111111111", quoteAmount: 1n },
        { mint, user: "Vote111111111111111111111111111111111111111", quoteAmount: 1n }
      ]
    }]);

    const { coordinator } = harness(storage, { HELIUS_API_KEY: "test-key" });
    const links = vi.spyOn(coordinator, "collectWalletLinks").mockResolvedValue({ status: "OBSERVED" });
    const result = await coordinator.collectNextRiskEvidence();
    expect(result).toMatchObject({ status: "COLLECTED", mint, evidenceType: "WALLET_CLUSTER" });
    expect(links).toHaveBeenCalledTimes(1);
  });

  it("does not reuse stale holder balances when a refresh is incomplete", async () => {
    const storage = new MemoryDurableStorage();
    seedSession(storage, true);
    const mint = "So11111111111111111111111111111111111111112";
    storage.seed("wallet_holdings_by_mint", {
      [mint]: [{ mint, wallet: "11111111111111111111111111111111", amount: "250000" }]
    });
    const { coordinator } = harness(storage, { HELIUS_API_KEY: "test-key" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: -32000 } })));
    try {
      const result = await coordinator.getHolderRisk(mint) as { status: string };
      expect(result.status).toBe("DATA_INCOMPLETE");
      const holdings = await storage.get<Record<string, unknown[]>>("wallet_holdings_by_mint");
      expect(holdings?.[mint]).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps session metadata and event count consistent", async () => {
    const { coordinator, storage } = harness();
    seedSession(storage);
    await append(coordinator)("RISK_EVIDENCE", "mint", { status: "UNKNOWN" }, "risk-1", "runtime-test-session");
    const sessions = await coordinator.listAuditSessions() as Array<{ sessionId: string; eventCount: number }>;
    expect(sessions).toEqual([expect.objectContaining({ sessionId: "runtime-test-session", eventCount: 1 })]);
  });
});
