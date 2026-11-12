import { describe, expect, it } from "vitest";
import {
  emptyHeliusMonitorState, enqueueHeliusNotification, normalizeHeliusMonitorState,
  reconcileHeliusSubscriptions, selectHeliusCandidates, confirmHeliusSubscription,
  takeHeliusWork, MAX_HELIUS_CANDIDATES, resetHeliusSubscriptionIds
} from "../src/ingestion/helius-monitor.js";
import type { DiscoveryCandidate } from "../src/ingestion/discovery-store.js";

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const key = (index: number) => alphabet[index]! + alphabet[(index + 1) % alphabet.length]!.repeat(42);
const sigFor = (index: number) => "3".repeat(62) + alphabet[Math.floor(index / alphabet.length)]! + alphabet[index % alphabet.length]!;
function candidate(index: number, status: "DISCOVERED" | "MIGRATED" = "DISCOVERED"): DiscoveryCandidate {
  return {
    kind: "new_token", mint: key(index), bondingCurve: key(index + 20),
    signature: null, creator: null, name: null, symbol: null,
    receivedAt: "2026-11-12T00:00:00.000Z",
    firstSeenAt: new Date(Date.parse("2026-11-12T00:00:00.000Z") + index * 1_000).toISOString(),
    lastSeenAt: "2026-11-12T00:00:00.000Z", observations: 1, status
  };
}
const sig = "3".repeat(64);

describe("bounded Helius candidate monitor", () => {
  it("never selects more than ten active candidates", () => {
    const selected = selectHeliusCandidates(Array.from({ length: 20 }, (_, i) => candidate(i)));
    expect(selected).toHaveLength(MAX_HELIUS_CANDIDATES);
    expect(selected[0]?.mint).toBe(candidate(19).mint);
    expect(selected.at(-1)?.mint).toBe(candidate(10).mint);
  });
  it("excludes migrated or invalid candidates", () => {
    const migrated = candidate(1, "MIGRATED");
    const invalid = { ...candidate(2), bondingCurve: null };
    expect(selectHeliusCandidates([migrated, invalid])).toEqual([]);
  });
  it("prioritizes identity completeness and repeated evidence without rejecting unknown creators", () => {
    const newest = candidate(9);
    const observed = { ...candidate(1), creator: key(90), observations: 4 };
    const unknown = candidate(2);
    const selected = selectHeliusCandidates([newest, unknown, observed], 3);
    expect(selected.map(item => item.mint)).toEqual([
      observed.mint, newest.mint, unknown.mint
    ]);
  });
  it("reconciles subscription intent and clears old socket IDs on reconnect", () => {
    let state = reconcileHeliusSubscriptions(emptyHeliusMonitorState(), [candidate(0)]);
    const requestId = state.subscriptions[0]!.requestId;
    state = confirmHeliusSubscription(state, requestId, 77);
    expect(state.subscriptions[0]!.subscriptionId).toBe(77);
    state = resetHeliusSubscriptionIds(state);
    expect(state.subscriptions[0]!.subscriptionId).toBeNull();
    expect(state.subscriptions[0]!.requestId).toBe(requestId);
    state = { ...state, incompleteMints: [candidate(0).mint] };
    state = confirmHeliusSubscription(state, requestId, 78, "2026-11-12T00:01:00.000Z");
    expect(state.incompleteMints).not.toContain(candidate(0).mint);
    expect(state.subscriptions[0]!.subscriptionId).toBe(78);
  });
  it("queues successful logs, ignores failed transactions and deduplicates signatures", () => {
    let state = reconcileHeliusSubscriptions(emptyHeliusMonitorState(), [candidate(0)]);
    state = confirmHeliusSubscription(state, state.subscriptions[0]!.requestId, 77);
    const args = { subscriptionId: 77, signature: sig, slot: 10, err: null };
    let result = enqueueHeliusNotification(state, args);
    expect(result.outcome).toBe("QUEUED");
    state = result.state;
    result = enqueueHeliusNotification(state, args);
    expect(result.outcome).toBe("DUPLICATE");
    result = enqueueHeliusNotification(state, { ...args, signature: "4".repeat(64), err: { InstructionError: [0, "x"] } });
    expect(result.outcome).toBe("FAILED");
    expect(result.state.queue).toHaveLength(1);
  });
  it("marks candidate incomplete when the bounded queue overflows", () => {
    let state = reconcileHeliusSubscriptions(emptyHeliusMonitorState(), [candidate(0)]);
    state = confirmHeliusSubscription(state, state.subscriptions[0]!.requestId, 77);
    for (let i = 0; i < 100; i++) {
      state = enqueueHeliusNotification(state, { subscriptionId: 77, signature: sigFor(i), slot: i, err: null }).state;
    }
    const overflow = enqueueHeliusNotification(state, { subscriptionId: 77, signature: "9".repeat(64), slot: 101, err: null });
    expect(overflow.outcome).toBe("OVERFLOW");
    expect(overflow.state.incompleteMints).toContain(candidate(0).mint);
  });
  it("takes queued work in FIFO order and normalizes persisted bounds", () => {
    let state = reconcileHeliusSubscriptions(emptyHeliusMonitorState(), [candidate(0)]);
    state = confirmHeliusSubscription(state, state.subscriptions[0]!.requestId, 77);
    state = enqueueHeliusNotification(state, { subscriptionId: 77, signature: sig, slot: 1, err: null }).state;
    const taken = takeHeliusWork(state);
    expect(taken.work?.signature).toBe(sig);
    expect(taken.state.queue).toHaveLength(0);
    expect(normalizeHeliusMonitorState({ queue: Array(150).fill({}) }).queue).toHaveLength(100);
  });
});
