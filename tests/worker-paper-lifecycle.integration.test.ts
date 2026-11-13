import { describe, expect, it, vi } from "vitest";
import { createPaperPortfolio, type ExecutablePaperQuote } from "../src/paper/portfolio.js";
import { PumpFunCoordinator } from "../infra/cloudflare/worker/src/index.js";

class MemoryDurableStorage {
  private values = new Map<string, unknown>();
  private transactionChain: Promise<void> = Promise.resolve();
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
    const run = this.transactionChain.then(async () => {
      const staged = new Map(this.values);
      const txn = {
        get: async <V>(key: string) => staged.get(key) as V | undefined,
        put: async <V>(key: string, value: V) => { staged.set(key, structuredClone(value)); }
      };
      const result = await closure(txn);
      this.values = staged;
      return result;
    });
    this.transactionChain = run.then(() => undefined, () => undefined);
    return run;
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

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(_data: string): void {}
  close(): void { this.readyState = FakeWebSocket.CLOSED; }
}

describe("Cloudflare Worker paper lifecycle durability", () => {

  it("creates the active session before acquiring its fenced persistence lease", async () => {
    const storage = new MemoryDurableStorage();
    const ctx = context(storage);
    const leaseRequests: Array<{ activeSessionId: string | undefined; body: Record<string, unknown> }> = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as never);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (url.pathname === "/internal/worker-lease") {
        leaseRequests.push({
          activeSessionId: await storage.get<string>("active_audit_session_id"),
          body
        });
        return Response.json({ acquired: true });
      }
      if (url.pathname === "/internal/paper-events") {
        return Response.json({ ok: true, inserted: 1, duplicates: 0, lastSequence: 1 });
      }
      return new Response("not found", { status: 404 });
    }));
    try {
      const worker = new PumpFunCoordinator(ctx as never, {
        PAPER_EVENT_INGEST_URL: "https://paper-api.example.test",
        PAPER_EVENT_INGEST_TOKEN_V2: "v".repeat(64),
        HELIUS_API_KEY: "test-helius-key"
      } as never);
      const status = await worker.start();
      expect(status.enabled).toBe(true);
      expect(leaseRequests).toHaveLength(1);
      expect(leaseRequests[0]?.activeSessionId).toBeTruthy();
      expect(leaseRequests[0]?.body.action).toBe("acquire");
      expect(status.readinessBlockers).not.toContain("Fenced PostgreSQL Worker lease is not held.");
      await Promise.all(ctx.pending);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reacquires the fenced lease after a Durable Object restart before reconnecting", async () => {
    const storage = new MemoryDurableStorage();
    const sessionId = "worker-restart-lease-session";
    const startedAt = new Date().toISOString();
    await storage.put("active_audit_session_id", sessionId);
    await storage.put("enabled", true);
    await storage.put("audit_session_ids", [sessionId]);
    await storage.put(`audit_session:${sessionId}`, {
      sessionId, startedAt, stoppedAt: null, strategyVersion: "strict-v1",
      eventCount: 1, initialBankrollUsd: 2.7, topUpAmountUsd: 2.7,
      topUpThresholdUsd: 1, topUpCount: 0, totalTopUpsUsd: 0
    });
    await storage.put(`audit_events:${sessionId}:00000000`, []);
    const ctx = context(storage);
    let leaseCalls = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket as never);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/internal/worker-lease") {
        leaseCalls += 1;
        return Response.json({ acquired: true });
      }
      return Response.json({ ok: true, inserted: 0, duplicates: 0, lastSequence: 1 });
    }));
    try {
      const worker = new PumpFunCoordinator(ctx as never, {
        PAPER_EVENT_INGEST_URL: "https://paper-api.example.test",
        PAPER_EVENT_INGEST_TOKEN_V2: "v".repeat(64),
        HELIUS_API_KEY: "test-helius-key"
      } as never);
      const status = await worker.ensureRunning();
      expect(leaseCalls).toBe(1);
      expect(status.enabled).toBe(true);
      expect(status.readinessBlockers).not.toContain("Fenced PostgreSQL Worker lease is not held.");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not enable provider streams when the fenced persistence lease is rejected", async () => {
    const storage = new MemoryDurableStorage();
    const ctx = context(storage);
    vi.stubGlobal("WebSocket", FakeWebSocket as never);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/internal/worker-lease") return Response.json({ acquired: false });
      return new Response("not found", { status: 404 });
    }));
    try {
      const worker = new PumpFunCoordinator(ctx as never, {
        PAPER_EVENT_INGEST_URL: "https://paper-api.example.test",
        PAPER_EVENT_INGEST_TOKEN_V2: "v".repeat(64),
        HELIUS_API_KEY: "test-helius-key"
      } as never);
      const status = await worker.start();
      expect(status.enabled).toBe(false);
      expect(status.lastError).toContain("lease was not acquired");
      expect(await storage.get("enabled")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("proves Worker-to-Neon persistence and idempotency without starting market streams", async () => {
    const storage = new MemoryDurableStorage();
    const calls: Array<{ path: string; body: Record<string, unknown>; authorization: string | null }> = [];
    let eventWrites = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ path: url.pathname, body, authorization: new Headers(init?.headers).get("authorization") });
      if (url.pathname === "/internal/worker-lease") {
        if (body.action === "release") return Response.json({ released: true });
        return Response.json({ acquired: true });
      }
      if (url.pathname === "/internal/paper-events") {
        eventWrites += 1;
        return Response.json(eventWrites === 1
          ? { ok: true, inserted: 2, duplicates: 0, lastSequence: 2 }
          : { ok: true, inserted: 0, duplicates: 2, lastSequence: 2 });
      }
      return new Response("not found", { status: 404 });
    }));
    try {
      const worker = new PumpFunCoordinator(context(storage) as never, {
        PAPER_EVENT_INGEST_URL: "https://paper-api.example.test",
        PAPER_EVENT_INGEST_TOKEN: "o".repeat(40),
        PAPER_EVENT_INGEST_TOKEN_V2: "v".repeat(64)
      } as never);
      const result = await worker.smokeIngestion();
      expect(result).toMatchObject({
        ok: true, eventPersisted: true, idempotentReplay: true,
        leaseAcquired: true, leaseHeartbeat: true,
        leaseRetained: false, leaseReleased: true
      });
      expect(result.sessionId).toMatch(/^smoke-test-worker-/);
      expect(await storage.get("enabled")).not.toBe(true);
      expect(calls.filter(call => call.path === "/internal/paper-events")).toHaveLength(2);
      expect(calls.every(call => call.authorization === `Bearer ${"v".repeat(64)}`)).toBe(true);
      const [first, replay] = calls.filter(call => call.path === "/internal/paper-events");
      expect(first?.body).toEqual(replay?.body);
      const events = first?.body.events as Array<{ kind: string; data: { smokeTest?: boolean } }>;
      expect(events.map(event => event.kind)).toEqual(["SESSION_STARTED", "SESSION_STOPPED"]);
      expect(events.every(event => event.data.smokeTest === true)).toBe(true);
      expect(calls.some(call => call.path === "/internal/worker-lease" && call.body.action === "release")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

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

    // Simulate eviction while the position is still open; the recovered
    // instance must retain the full position before it is allowed to exit.
    const openRestartContext = context(storage);
    const openRestartWorker = new PumpFunCoordinator(openRestartContext as never, {} as never);
    const recoveredOpen = await openRestartWorker.getPaperPortfolio() as {
      positions: Array<{ positionId: string; status: string; rentReserveUsd: number }>;
    };
    expect(recoveredOpen.positions).toHaveLength(1);
    expect(recoveredOpen.positions[0]).toMatchObject({
      positionId: "worker-lifecycle-position", status: "OPEN", rentReserveUsd: 0.2
    });

    const exitTime = new Date().toISOString();
    const sellQuote = quote(mint, "SELL", exitTime, "1000000", 1.2);
    const exit = await openRestartWorker.recordPaperExit({
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

  it("serializes concurrent entry/exit retries into one transition per quote", async () => {
    const storage = new MemoryDurableStorage();
    const sessionId = "worker-lifecycle-idempotency-session";
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

    const worker = new PumpFunCoordinator(context(storage) as never, {} as never);
    const mint = "11111111111111111111111111111111";
    const entryAt = new Date().toISOString();
    const buyQuote = quote(mint, "BUY", entryAt);
    const initialSellQuote = quote(mint, "SELL", entryAt, "1000000", 1.05);
    const entryInput = {
      mint, positionId: "worker-idempotent-position",
      buyQuote, sellQuote: initialSellQuote, rentReserveUsd: 0.2
    };
    const entries = await Promise.all([
      worker.recordPaperEntry(entryInput) as Promise<{ status: string }>,
      worker.recordPaperEntry(entryInput) as Promise<{ status: string }>
    ]);
    expect(entries.filter(result => result.status === "APPLIED")).toHaveLength(1);
    expect(entries.filter(result => result.status === "DUPLICATE")).toHaveLength(1);

    const sellQuote = quote(mint, "SELL", new Date().toISOString(), "1000000", 1.2);
    const exitInput = {
      positionId: "worker-idempotent-position", sellQuote, exitReason: "TEST_EXIT"
    };
    const exits = await Promise.all([
      worker.recordPaperExit(exitInput) as Promise<{ status: string }>,
      worker.recordPaperExit(exitInput) as Promise<{ status: string }>
    ]);
    expect(exits.filter(result => result.status === "APPLIED")).toHaveLength(1);
    expect(exits.filter(result => result.status === "DUPLICATE")).toHaveLength(1);

    const portfolio = await worker.getPaperPortfolio() as {
      positions: Array<{ status: string }>;
    };
    expect(portfolio.positions).toHaveLength(1);
    expect(portfolio.positions[0]?.status).toBe("CLOSED");
    const metadata = await storage.get<{ eventCount: number }>(`audit_session:${sessionId}`);
    const auditEvents = await storage.get<Array<{ kind: string }>>(`audit_events:${sessionId}:00000000`);
    expect(metadata?.eventCount).toBe(auditEvents?.length);
    expect(metadata?.eventCount).toBeGreaterThanOrEqual(3);
    expect(auditEvents?.filter(event => event.kind === "PAPER_ENTRY")).toHaveLength(1);
    expect(auditEvents?.filter(event => event.kind === "PAPER_EXIT")).toHaveLength(1);
    expect(auditEvents?.filter(event => event.kind === "PAPER_ENTRY" || event.kind === "PAPER_EXIT"))
      .toHaveLength(2);
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
