/**
 * Small in-memory Helius RPC budget guard.
 *
 * This is deliberately conservative and process-local. It does not replace
 * provider-side limits or durable scheduling. Callers must mark affected
 * candidates DATA_INCOMPLETE whenever work is dropped or delayed beyond its
 * observation deadline.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillAtMs: number;

  constructor(
    readonly requestsPerSecond: number,
    readonly capacity = Math.max(1, requestsPerSecond),
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0 || requestsPerSecond > 10) {
      throw new Error("Helius Free RPC budget must be between 0 and 10 requests per second.");
    }
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new Error("Token bucket capacity must be at least one.");
    }
    this.tokens = capacity;
    this.lastRefillAtMs = now();
  }

  tryTake(count = 1): boolean {
    if (!Number.isInteger(count) || count < 1) throw new Error("Token count must be a positive integer.");
    if (count > this.capacity) throw new Error("Requested token count exceeds bucket capacity.");
    this.refill();
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }

  get retryAfterMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) * 1000 / this.requestsPerSecond);
  }

  get availableTokens(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const current = this.now();
    const elapsed = Math.max(0, current - this.lastRefillAtMs);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.requestsPerSecond / 1000);
    this.lastRefillAtMs = Math.max(this.lastRefillAtMs, current);
  }
}

export type RpcPriority = "open_position" | "candidate" | "backfill";

export interface RpcWorkItem {
  id: string;
  mint: string;
  priority: RpcPriority;
  deadlineAtMs: number;
}

/**
 * Bounded, stable-priority queue. Evictions are returned to the caller;
 * they must be recorded as DATA_INCOMPLETE and must never be silently ignored.
 */
export class BoundedRpcQueue<T extends RpcWorkItem> {
  private readonly items: T[] = [];
  constructor(readonly maxItems: number) {
    if (!Number.isInteger(maxItems) || maxItems < 1) throw new Error("Queue capacity must be a positive integer.");
  }

  enqueue(item: T): { accepted: boolean; evicted: T | null } {
    const existing = this.items.findIndex(value => value.id === item.id);
    if (existing >= 0) {
      this.items.splice(existing, 1);
      this.items.push(item);
      this.sort();
      return { accepted: true, evicted: null };
    }
    if (this.items.length < this.maxItems) {
      this.items.push(item);
      this.sort();
      return { accepted: true, evicted: null };
    }
    const lowest = this.items[this.items.length - 1];
    if (!lowest || this.rank(item.priority) >= this.rank(lowest.priority)) {
      return { accepted: false, evicted: item };
    }
    this.items.pop();
    this.items.push(item);
    this.sort();
    return { accepted: true, evicted: lowest };
  }

  take(nowMs: number): T | null {
    while (this.items.length > 0) {
      const next = this.items.shift();
      if (next && next.deadlineAtMs >= nowMs) return next;
    }
    return null;
  }

  get size(): number { return this.items.length; }

  private sort(): void {
    this.items.sort((a, b) =>
      this.rank(a.priority) - this.rank(b.priority) ||
      a.deadlineAtMs - b.deadlineAtMs
    );
  }

  private rank(priority: RpcPriority): number {
    return priority === "open_position" ? 0 : priority === "candidate" ? 1 : 2;
  }
}
