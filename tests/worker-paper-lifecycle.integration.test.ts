import { describe, expect, it, vi } from "vitest";
import { createPaperPortfolio, type ExecutablePaperQuote } from "../src/paper/portfolio.js";
import { PumpFunCoordinator } from "../infra/cloudflare/worker/src/index.js";

class MemoryDurableStorage {
  private values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async setAlarm(_scheduledTime: number): Promise<void> { return; }
  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
  async transaction<T>(closure: (txn: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T = unknown>(key: string, value: T): Promise<void>;
  }) => Promise<T>): Promise<T> {
    const staged = new Map(this.values);
    const txn = {
      get: async <V>(key: string) => staged.get(key) as V | undefined,
      put: async <V>(key: string, value: V) => { staged.set(key, structuredClone(value)); }
    };
    const result = await closure(txn);
    this.values = staged;
    return result;
  }
}

function context(storage: MemoryDurableStorage) {
  const pending: Promise<unknown>[] = [];
  return {
    id: { toString: () => "test-coordinator-id" },
    storage,
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
    setAlarm: async () => undefined,
    get pending() { return pending; }
  };
}

function quote(
  mint: string, side: "BUY" | "SELL", now: string,
  amount = "1000000", outputUsd = 1
): ExecutablePaperQuote {
  return {
    quoteId: `${side.toLowerCase()}-${mint}-${side === "BUY" ? "entry" : "exit"}`,
    provider: "worker-lifecycle-test", mint, side,
    observedAt: now,
    expiresAt: new Date(Date.parse(now) + 30_000).toISOString(),
    requestedUsd: 1,
    inputAmountBaseUnits: side === "BUY" ? "10000000" : amount,
    outputAmountBaseUnits: side === "BUY" ? amount : "10000000",
    tokenDecimals: 6, outputUsd, priceImpactPct: 0.1, taxPct: 0.1,
    networkFeeUsd: 0.001, priorityFeeUsd: 0.001, providerFeeUsd: 0,
    protocolFeeUsd: 0.002, creatorFeeUsd: 0.001, poolFeeUsd: 0.001,
    transferFeeUsd: 0, routeId: "worker-lifecycle-test", executable: true,
    simulatedLatencyMs: 100,
    simulatedFillAt: new Date(Date.parse(now) + 100).toISOString()
  };
}

describe("Cloudflare Worker paper lifecycle durability", () => {
  it("persists entry and exit transitions across a new coordinator instance", async () => {
    const storage = new MemoryDurableStorage();
    const sessionId = "worker-lifecycle-session";
    const startedAt = new Date().toISOString();
    await storage.put("active_audit_session_id", sessionId);
    await storage.put("enabled", true);
    await storage.put("audit_session_ids", [sessionId]);
    await storage.put(`audit_session:${sessionId}`, {
      sessionId, startedAt, stoppedAt: null, strategyVersion: "strict-v1",
      eventCount: 1, initialBankrollUsd: 2.7, topUpAmountUsd: 2.7,
      topUpThresholdUsd: 1, topUpCount: 0, totalTopUpsUsd: 0
    });
    await storage.put(`audit_events:${sessionId}:00000000`, [{
      sessionId, sequence: 1, eventId: `session-started:${sessionId}`,
      kind: "SESSION_STARTED", occurredAt: startedAt, mint: null,
      strategyVersion: "strict-v1", data: {}
    }]);
    await storage.put(`paper_portfolio:${sessionId}`, createPaperPortfolio(2.7));

    const firstContext = context(storage);
    const firstWorker = new PumpFunCoordinator(firstContext as never, {} as never);
    const mint = "11111111111111111111111111111111";
    const entryTime = new Date().toISOString();
    const buyQuote = quote(mint, "BUY", entryTime);
    const initialSellQuote = quote(mint, "SELL", entryTime, "1000000", 1.05);
    const entry = await firstWorker.recordPaperEntry({
      mint, positionId: "worker-lifecycle-position",
      buyQuote, sellQuote: initialSellQuote, rentReserveUsd: 0.2
    }) as { status: string; state: { positions: Array<{ status: string; rentReserveUsd: number }> } };

    expect(entry.status).toBe("APPLIED");
    expect(entry.state.positions[0]).toMatchObject({ status: "OPEN", rentReserveUsd: 0.2 });

    const exitTime = new Date().toISOString();
    const sellQuote = quote(mint, "SELL", exitTime, "1000000", 1.2);
    const exit = await firstWorker.recordPaperExit({
      positionId: "worker-lifecycle-position", sellQuote, exitReason: "TEST_EXIT"
    }) as { status: string; state: { positions: Array<{ status: string; exitReason: string | null }> } };

    expect(exit.status).toBe("APPLIED");
    expect(exit.state.positions[0]).toMatchObject({ status: "CLOSED", exitReason: "TEST_EXIT" });

    // A new Durable Object class instance over the same durable storage models
    // eviction/restart: it must read the already committed portfolio, not reset it.
    const restartedContext = context(storage);
    const restartedWorker = new PumpFunCoordinator(restartedContext as never, {} as never);
    const recovered = await restartedWorker.getPaperPortfolio() as {
      positions: Array<{ positionId: string; status: string; rentReserveUsd: number }>;
      reservedAccountRentUsd: number;
    };
    expect(recovered.positions).toHaveLength(1);
    expect(recovered.positions[0]).toMatchObject({
      positionId: "worker-lifecycle-position", status: "CLOSED", rentReserveUsd: 0.2
    });
    expect(recovered.reservedAccountRentUsd).toBe(0);
  });

  it("clears a WebSocket gap only when its full launch-window interval is decoded and Neon-acknowledged", async () => {
    const storage = new MemoryDurableStorage();
    const sessionId = "worker-gap-recovery-session";
    const mint = "11111111111111111111111111111111";
    const older = "5".repeat(88);
    const newer = "6".repeat(88);
    const startedAt = "2026-11-13T10:00:00.000Z";
    const endedAt = "2026-11-13T10:00:10.000Z";
    await storage.put("active_audit_session_id", sessionId);
    await storage.put("enabled", false);
    await storage.put(`audit_session:${sessionId}`, {
      sessionId, startedAt, stoppedAt: null, strategyVersion: "strict-v1",
      eventCount: 1, initialBankrollUsd: 2.7, topUpAmountUsd: 2.7,
      topUpThresholdUsd: 1, topUpCount: 0, totalTopUpsUsd: 0
    });
    await storage.put(`audit_events:${sessionId}:00000000`, [{
      sessionId, sequence: 1, eventId: "gap-session-start", kind: "SESSION_STARTED",
      occurredAt: startedAt, mint: null, strategyVersion: "strict-v1", data: {}
    }]);
    await storage.put("helius_monitor_state", {
      subscriptions: [], queue: [], seenSignatures: [], incompleteMints: [mint],
      coverageGaps: [{
        mint, startedAt, endedAt, startSignature: older, startSlot: 1,
        endSignature: newer, endSlot: 2, recoveredAt: null
      }],
      failedTransactions: 0, droppedSignatures: 0, duplicateSignatures: 0, nextRequestId: 1
    });
    await storage.put(`helius_backfill:${sessionId}:${mint}`, {
      mint, bondingCurve: "11111111111111111111111111111111",
      createSignature: older, launchBlockTime: 1, horizonSeconds: 600, maxSignatures: 120,
      signatures: [
        { signature: newer, slot: 2, blockTime: 2, err: null },
        { signature: older, slot: 1, blockTime: 1, err: null }
      ],
      pagesScanned: 1, scannedCount: 2, before: null,
      lastPageSlot: 1, lastPageBlockTime: 1, status: "COMPLETE", reason: null
    });
    await storage.put(`helius_backfill_queue_cursor:${sessionId}:${mint}`, 2);
    await storage.put(`helius_verified_historical_signatures:${sessionId}:${mint}`, [newer, older]);
    await storage.put(`helius_archived_transaction_signatures:${sessionId}:${mint}`, [newer, older]);

    const coordinator = new PumpFunCoordinator(context(storage) as never, {} as never);
    await coordinator.getStatus();
    await (coordinator as unknown as { recoverCoveredHeliusGaps(): Promise<void> })
      .recoverCoveredHeliusGaps();

    const monitor = await storage.get<{ incompleteMints: string[]; coverageGaps: Array<{ recoveredAt: string | null }> }>("helius_monitor_state");
    expect(monitor?.incompleteMints).not.toContain(mint);
    expect(monitor?.coverageGaps[0]?.recoveredAt).toBeTruthy();
  });

  it("does not recover a gap while a successful transaction lacks Neon archive acknowledgement", async () => {
    const storage = new MemoryDurableStorage();
    const sessionId = "worker-gap-unarchived-session";
    const mint = "11111111111111111111111111111111";
    const older = "5".repeat(88);
    const newer = "6".repeat(88);
    const startedAt = "2026-11-13T10:00:00.000Z";
    const endedAt = "2026-11-13T10:00:10.000Z";
    await storage.put("active_audit_session_id", sessionId);
    await storage.put("enabled", false);
    await storage.put(`audit_session:${sessionId}`, {
      sessionId, startedAt, stoppedAt: null, strategyVersion: "strict-v1",
      eventCount: 1, initialBankrollUsd: 2.7, topUpAmountUsd: 2.7,
      topUpThresholdUsd: 1, topUpCount: 0, totalTopUpsUsd: 0
    });
    await storage.put(`audit_events:${sessionId}:00000000`, [{
      sessionId, sequence: 1, eventId: "gap-unarchived-start", kind: "SESSION_STARTED",
      occurredAt: startedAt, mint: null, strategyVersion: "strict-v1", data: {}
    }]);
    await storage.put("helius_monitor_state", {
      subscriptions: [], queue: [], seenSignatures: [], incompleteMints: [mint],
      coverageGaps: [{
        mint, startedAt, endedAt, startSignature: older, startSlot: 1,
        endSignature: newer, endSlot: 2, recoveredAt: null
      }],
      failedTransactions: 0, droppedSignatures: 0, duplicateSignatures: 0, nextRequestId: 1
    });
    await storage.put(`helius_backfill:${sessionId}:${mint}`, {
      mint, bondingCurve: "11111111111111111111111111111111",
      createSignature: older, launchBlockTime: 1, horizonSeconds: 600, maxSignatures: 120,
      signatures: [
        { signature: newer, slot: 2, blockTime: 2, err: null },
        { signature: older, slot: 1, blockTime: 1, err: null }
      ],
      pagesScanned: 1, scannedCount: 2, before: null,
      lastPageSlot: 1, lastPageBlockTime: 1, status: "COMPLETE", reason: null
    });
    await storage.put(`helius_backfill_queue_cursor:${sessionId}:${mint}`, 2);
    await storage.put(`helius_verified_historical_signatures:${sessionId}:${mint}`, [newer, older]);
    await storage.put(`helius_archived_transaction_signatures:${sessionId}:${mint}`, [older]);

    const coordinator = new PumpFunCoordinator(context(storage) as never, {} as never);
    await coordinator.getStatus();
    await (coordinator as unknown as { recoverCoveredHeliusGaps(): Promise<void> })
      .recoverCoveredHeliusGaps();

    const monitor = await storage.get<{ incompleteMints: string[]; coverageGaps: Array<{ recoveredAt: string | null }> }>("helius_monitor_state");
    expect(monitor?.incompleteMints).toContain(mint);
    expect(monitor?.coverageGaps[0]?.recoveredAt).toBeNull();
  });

  it("keeps the Neon outbox cursor behind on ingestion failure and advances only after acknowledgement", async () => {
    const storage = new MemoryDurableStorage();
    const sessionId = "worker-outbox-session";
    const occurredAt = new Date().toISOString();
    await storage.put(`audit_session:${sessionId}`, {
      sessionId, startedAt: occurredAt, stoppedAt: null, strategyVersion: "strict-v1",
      eventCount: 1, initialBankrollUsd: 2.7, topUpAmountUsd: 2.7,
      topUpThresholdUsd: 1, topUpCount: 0, totalTopUpsUsd: 0
    });
    await storage.put(`audit_events:${sessionId}:00000000`, [{
      sessionId, sequence: 1, eventId: "outbox-event-1", kind: "SESSION_STARTED",
      occurredAt, mint: null, strategyVersion: "strict-v1", data: {}
    }]);
    const coordinator = new PumpFunCoordinator(context(storage) as never, {
      PAPER_EVENT_INGEST_URL: "https://paper-api.example.test",
      PAPER_EVENT_INGEST_TOKEN: "t".repeat(40)
    } as never);
    const flush = (coordinator as unknown as {
      flushAuditEventsToPostgres(id: string): Promise<void>;
    }).flushAuditEventsToPostgres.bind(coordinator);
    const status = (coordinator as unknown as { status: { lastError: string | null } }).status;

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    try {
      await flush(sessionId);
      expect(await storage.get(`postgres_sync_sequence:${sessionId}`)).toBeUndefined();
      expect(status.lastError).toBe("Paper event ingestion failed; durable outbox will retry.");

      vi.stubGlobal("fetch", vi.fn(async () => new Response(
        JSON.stringify({ ok: true, lastSequence: 1 }), { status: 200,
          headers: { "content-type": "application/json" } }
      )));
      await flush(sessionId);
      expect(await storage.get(`postgres_sync_sequence:${sessionId}`)).toBe(1);
      expect(status.lastError).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
