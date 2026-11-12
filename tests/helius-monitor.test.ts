import { describe, expect, it } from "vitest";
import {
  emptyHeliusMonitorState, enqueueHeliusNotification, normalizeHeliusMonitorState,
  reconcileHeliusSubscriptions, selectHeliusCandidates, confirmHeliusSubscription,
  takeHeliusWork, MAX_HELIUS_CANDIDATES
} from "../src/ingestion/helius-monitor.js";
import type { DiscoveryCandidate } from "../src/ingestion/discovery-store.js";

const key = (char: string) => char + "1".repeat(43);
function candidate(index: number, status: "DISCOVERED" | "MIGRATED" = "DISCOVERED"): DiscoveryCandidate {
  return {
    kind: "new_token", mint: key(String(index + 1)), bondingCurve: key(String(index + 2)),
    signature: null, creator: null, name: null, symbol: null,
    receivedAt: "2026-11-12T00:00:00.000Z", firstSeenAt: "2026-11-12T00:00:00.000Z",
    lastSeenAt: "2026-11-12T00:00:00.000Z", observations: 1, status
  };
}
const sig = "3".repeat(64);

describe("bounded Helius candidate monitor", () => {
  it("never selects more than ten active candidates", () => {
    expect(selectHeliusCandidates(Array.from({ length: 20 }, (_, i) => candidate(i)))).toHaveLength(MAX_HELIUS_CANDIDATES);
  });
  it("excludes migrated or invalid candidates", () => {
    const migrated = candidate(1, "MIGRATED");
    const invalid = { ...candidate(2), bondingCurve: null };
    expect(selectHeliusCandidates([migrated, invalid])).toEqual([]);
  });
  it("reconciles subscription intent and clears old socket IDs on reconnect", () => {
    let state = reconcileHeliusSubscriptions(emptyHeliusMonitorState(), [candidate(0)]);
    const requestId = state.subscriptions[0]!.requestId;
    state = confirmHeliusSubscription(state, requestId, 77);
    expect(state.subscriptions[0]!.subscriptionId).toBe(77);
    state = reconcileHeliusSubscriptions(state, [candidate(0)]);
    expect(state.subscriptions[0]!.subscriptionId).toBeNull();
    expect(state.subscriptions[0]!.requestId).toBe(requestId);
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
      state = enqueueHeliusNotification(state, { subscriptionId: 77, signature: String(i + 100).padStart(64, "3"), slot: i, err: null }).state;
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
