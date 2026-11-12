import { describe, expect, it, vi } from "vitest";
import { PumpFunCoordinator } from "../infra/cloudflare/worker/src/index.js";

type Stored = Map<string, unknown>;

class MemoryDurableStorage {
  private values: Stored = new Map();
  private transactionTail: Promise<unknown> = Promise.resolve();
  failNextPut = false;
  lastAlarmAt: number | null = null;\n  async setAlarm(timestamp: number): Promise<void> { this.lastAlarmAt = timestamp; }

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

  it("keeps session metadata and event count consistent", async () => {
    const { coordinator, storage } = harness();
    seedSession(storage);
    await append(coordinator)("RISK_EVIDENCE", "mint", { status: "UNKNOWN" }, "risk-1", "runtime-test-session");
    const sessions = await coordinator.listAuditSessions() as Array<{ sessionId: string; eventCount: number }>;
    expect(sessions).toEqual([expect.objectContaining({ sessionId: "runtime-test-session", eventCount: 1 })]);
  });
});
