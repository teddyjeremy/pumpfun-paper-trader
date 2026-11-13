import { describe, expect, it } from "vitest";
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
});
