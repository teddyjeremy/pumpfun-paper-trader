import { describe, expect, it } from "vitest";
import { BoundedRpcQueue, TokenBucket, type RpcWorkItem } from "../src/ingestion/rpc-budget.js";

describe("Helius RPC budget", () => {
  it("rejects a configured rate above the Free-plan ceiling", () => {
    expect(() => new TokenBucket(10.1)).toThrow(/between 0 and 10/);
  });

  it("supports sub-one request rates and rejects impossible batch sizes", () => {
    const bucket = new TokenBucket(0.5);
    expect(() => bucket.tryTake(2)).toThrow(/exceeds bucket capacity/);
  });

  it("limits bursts and refills according to elapsed time", () => {
    let now = 0;
    const bucket = new TokenBucket(2, 2, () => now);
    expect(bucket.tryTake(2)).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    expect(bucket.retryAfterMs).toBe(500);
    now = 500;
    expect(bucket.tryTake()).toBe(true);
  });

  it("does not refill when the clock moves backwards", () => {
    let now = 1000;
    const bucket = new TokenBucket(1, 1, () => now);
    expect(bucket.tryTake()).toBe(true);
    now = 0;
    expect(bucket.tryTake()).toBe(false);
  });
});

describe("bounded prioritized RPC queue", () => {
  const work = (id: string, priority: RpcWorkItem["priority"], deadlineAtMs = 1000): RpcWorkItem =>
    ({ id, mint: id, priority, deadlineAtMs });

  it("prioritizes open positions over new candidates and backfill", () => {
    const queue = new BoundedRpcQueue<RpcWorkItem>(3);
    queue.enqueue(work("history", "backfill"));
    queue.enqueue(work("new", "candidate"));
    queue.enqueue(work("position", "open_position"));
    expect(queue.take(0)?.id).toBe("position");
    expect(queue.take(0)?.id).toBe("new");
    expect(queue.take(0)?.id).toBe("history");
  });

  it("returns an evicted item so the caller can mark its data incomplete", () => {
    const queue = new BoundedRpcQueue<RpcWorkItem>(1);
    queue.enqueue(work("backfill", "backfill"));
    const result = queue.enqueue(work("open", "open_position"));
    expect(result.accepted).toBe(true);
    expect(result.evicted?.mint).toBe("backfill");
  });

  it("rejects low-priority overflow explicitly", () => {
    const queue = new BoundedRpcQueue<RpcWorkItem>(1);
    queue.enqueue(work("open", "open_position"));
    const result = queue.enqueue(work("history", "backfill"));
    expect(result.accepted).toBe(false);
    expect(result.evicted?.mint).toBe("history");
  });

  it("discards expired work rather than processing stale observations", () => {
    const queue = new BoundedRpcQueue<RpcWorkItem>(2);
    queue.enqueue(work("expired", "open_position", 10));
    queue.enqueue(work("fresh", "candidate", 100));
    expect(queue.take(11)?.id).toBe("fresh");
  });
});
