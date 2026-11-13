import { describe, expect, it } from "vitest";
import { createPaperPortfolio } from "../src/paper/portfolio.js";
import {
  commitPaperPortfolioTransition,
  type PaperSessionStorage,
  type PaperSessionTransaction
} from "../src/paper/portfolio-session.js";

class MemoryStorage implements PaperSessionStorage {
  constructor(private values = new Map<string, unknown>()) {}
  reopen(): MemoryStorage { return new MemoryStorage(this.values); }
  async transaction<T>(closure: (txn: PaperSessionTransaction) => Promise<T>): Promise<T> {
    const working = new Map(this.values);
    const txn: PaperSessionTransaction = {
      get: async <V>(key: string) => working.get(key) as V | undefined,
      put: async <V>(key: string, value: V) => { working.set(key, value); }
    };
    const result = await closure(txn);
    this.values = working;
    return result;
  }
  seed(key: string, value: unknown): void { this.values.set(key, value); }
  read<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
}

const sessionId = "session-1";
const occurredAt = "2026-11-12T12:00:00.000Z";
function storage(): MemoryStorage {
  const result = new MemoryStorage();
  result.seed("active_audit_session_id", sessionId);
  result.seed(`paper_portfolio:${sessionId}`, createPaperPortfolio());
  result.seed(`audit_session:${sessionId}`, {
    sessionId, startedAt: occurredAt, stoppedAt: null, strategyVersion: "strict-v1",
    eventCount: 1, initialBankrollUsd: 2.7, topUpAmountUsd: 2.7,
    topUpThresholdUsd: 1, topUpCount: 0, totalTopUpsUsd: 0
  });
  result.seed(`audit_events:${sessionId}:00000000`, []);
  return result;
}

describe("atomic paper portfolio transitions", () => {
  it("commits state, audit events and idempotency marker together", async () => {
    const db = storage();
    const committed = await commitPaperPortfolioTransition(db, {
      sessionId, idempotencyKey: "entry:mint:quote-1", occurredAt, mint: "mint",
      apply: portfolio => ({
        state: { ...portfolio, availableCashUsd: 1.7 },
        result: "position-1",
        events: [{ kind: "PAPER_ENTRY", data: { positionId: "position-1" } }]
      })
    });
    expect(committed.status).toBe("APPLIED");
    expect(db.read<any>(`paper_portfolio:${sessionId}`)?.availableCashUsd).toBe(1.7);
    expect(db.read<any>(`paper_bankroll:${sessionId}`)).toEqual(
      db.read<any>(`paper_portfolio:${sessionId}`)?.bankroll
    );
    expect(db.read<any>(`audit_session:${sessionId}`)?.eventCount).toBe(2);
    expect(db.read<any[]>(`audit_events:${sessionId}:00000000`)).toHaveLength(1);
    expect(db.read<any>(`paper_transition:${sessionId}:entry:mint:quote-1`)?.eventIds).toHaveLength(1);
  });

  it("does not apply or append events a second time for the same idempotency key", async () => {
    const db = storage();
    let applications = 0;
    const input = {
      sessionId, idempotencyKey: "exit:position-1:quote-2", occurredAt,
      apply: (portfolio: ReturnType<typeof createPaperPortfolio>) => {
        applications += 1;
        return { state: portfolio, result: "closed", events: [{ kind: "PAPER_EXIT" as const, data: {} }] };
      }
    };
    const first = await commitPaperPortfolioTransition(db, input);
    const second = await commitPaperPortfolioTransition(db, input);
    expect(first.status).toBe("APPLIED");
    expect(second.status).toBe("DUPLICATE");
    expect(applications).toBe(1);
    expect(db.read<any>(`audit_session:${sessionId}`)?.eventCount).toBe(2);
  });

  it("recovers the committed portfolio and idempotency marker after a storage-backed Worker restart", async () => {
    const beforeRestart = storage();
    const input = {
      sessionId, idempotencyKey: "entry:mint:restart-safe", occurredAt, mint: "mint",
      apply: (portfolio: ReturnType<typeof createPaperPortfolio>) => ({
        state: { ...portfolio, availableCashUsd: 1.686 },
        result: "position-recovered",
        events: [{ kind: "PAPER_ENTRY" as const, data: { positionId: "position-recovered" } }]
      })
    };
    const first = await commitPaperPortfolioTransition(beforeRestart, input);
    expect(first.status).toBe("APPLIED");

    // A new coordinator instance receives the same durable backing storage.
    const afterRestart = beforeRestart.reopen();
    expect(afterRestart.read<any>(`paper_portfolio:${sessionId}`)?.availableCashUsd).toBe(1.686);
    const replay = await commitPaperPortfolioTransition(afterRestart, {
      ...input,
      apply: () => { throw new Error("replayed entry must not be applied"); }
    });
    expect(replay.status).toBe("DUPLICATE");
    expect(afterRestart.read<any>(`audit_session:${sessionId}`)?.eventCount).toBe(2);
    expect(afterRestart.read<any[]>(`audit_events:${sessionId}:00000000`)).toHaveLength(1);
  });

  it("rejects a transition after the session is stopped or replaced", async () => {
    const db = storage();
    db.seed("active_audit_session_id", "another-session");
    await expect(commitPaperPortfolioTransition(db, {
      sessionId, idempotencyKey: "late", occurredAt,
      apply: portfolio => ({ state: portfolio, result: null, events: [{ kind: "PAPER_MARK" as never, data: {} }] })
    })).rejects.toThrow(/active session/);
  });

  it("rolls back all writes when transition calculation fails", async () => {
    const db = storage();
    await expect(commitPaperPortfolioTransition(db, {
      sessionId, idempotencyKey: "bad", occurredAt,
      apply: () => { throw new Error("quote validation failed"); }
    })).rejects.toThrow(/quote validation failed/);
    expect(db.read<any>(`paper_transition:${sessionId}:bad`)).toBeUndefined();
    expect(db.read<any>(`audit_session:${sessionId}`)?.eventCount).toBe(1);
  });
});
