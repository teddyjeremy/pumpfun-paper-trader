import { describe, expect, it } from "vitest";
import {
  emptyHeliusMonitorState, enqueueHeliusNotification, enqueueHeliusSignatureWork, normalizeHeliusMonitorState,
  reconcileHeliusSubscriptions, selectHeliusCandidates, confirmHeliusSubscription,
  takeHeliusWork, retryHeliusSignatureWork, MAX_HELIUS_CANDIDATES, MAX_HELIUS_SIGNATURE_QUEUE, resetHeliusSubscriptionIds,
  recordHeliusCoverageGap,
  FRESH_LAUNCH_SLOT_RESERVE
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

  it("reserves four slots for fresh launches and ranks the remaining six by evidence", () => {
    const now = Date.parse("2026-11-12T12:00:00.000Z");
    const fresh = Array.from({ length: 6 }, (_, i) => ({
      ...candidate(i), firstSeenAt: new Date(now - (50_000 - i * 5_000)).toISOString(),
      lastSeenAt: new Date(now).toISOString()
    }));
    const older = Array.from({ length: 8 }, (_, i) => ({
      ...candidate(i + 20), firstSeenAt: new Date(now - 120_000 - i * 1_000).toISOString(),
      lastSeenAt: new Date(now).toISOString()
    }));
    const evidence = Object.fromEntries(older.map((item, i) => [item.mint, {
      score: i * 10, dataComplete: true, flowConfirmed: i >= 5,
      creatorClearanceComplete: i >= 6
    }]));
    const selected = selectHeliusCandidates([...fresh, ...older], 10, evidence, now);
    expect(selected.slice(0, FRESH_LAUNCH_SLOT_RESERVE).map(x => x.mint))
      .toEqual(fresh.slice(0, 4).map(x => x.mint));
    expect(selected.slice(4).map(x => x.mint))
      .toEqual(older.slice().reverse().slice(0, 6).map(x => x.mint));
  });
  it("does not admit hard-rejected candidates into monitoring slots", () => {
    const now = Date.parse("2026-11-12T12:00:00.000Z");
    const items = Array.from({ length: 12 }, (_, i) => ({
      ...candidate(i), firstSeenAt: new Date(now - 120_000 - i * 1_000).toISOString()
    }));
    const evidence = Object.fromEntries(items.map((item, i) => [item.mint, {
      score: i, hardRejected: i >= 8
    }]));
    const selected = selectHeliusCandidates(items, 10, evidence, now);
    expect(selected).toHaveLength(8);
    expect(selected.some(item => evidence[item.mint]?.hardRejected)).toBe(false);
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
    expect(state.incompleteMints).toContain(candidate(0).mint);
    expect(state.subscriptions[0]!.subscriptionId).toBe(78);
  });
  it("persists exact Helius interruption intervals and closes them without clearing incompleteness", () => {
    let state = reconcileHeliusSubscriptions(emptyHeliusMonitorState(), [candidate(0)]);
    const requestId = state.subscriptions[0]!.requestId;
    state = confirmHeliusSubscription(state, requestId, 77, "2026-11-13T10:00:00.000Z");
    state = recordHeliusCoverageGap(state, candidate(0).mint, "2026-11-13T10:02:00.000Z");
    expect(state.coverageGaps).toEqual([{
      mint: candidate(0).mint,
      startedAt: "2026-11-13T10:00:00.000Z",
      endedAt: null
    }]);
    state = confirmHeliusSubscription(state, requestId, 78, "2026-11-13T10:03:00.000Z");
    expect(state.coverageGaps[0]?.endedAt).toBe("2026-11-13T10:03:00.000Z");
    expect(state.incompleteMints).toContain(candidate(0).mint);
    state = recordHeliusCoverageGap(state, candidate(0).mint, "2026-11-13T10:04:00.000Z");
    expect(state.coverageGaps).toHaveLength(2);
    expect(state.coverageGaps[1]?.endedAt).toBeNull();
    state = confirmHeliusSubscription(state, requestId, 79, "2026-11-13T10:05:00.000Z");
    expect(state.coverageGaps[1]?.endedAt).toBe("2026-11-13T10:05:00.000Z");
  });
  it("queues provider-discovered create signatures without waiting for a logs subscription", () => {
    const state = emptyHeliusMonitorState();
    const queued = enqueueHeliusSignatureWork(state, {
      signature: sig, mint: candidate(0).mint, slot: null
    }, "2026-11-12T12:00:00.000Z");
    expect(queued.outcome).toBe("QUEUED");
    expect(queued.state.queue[0]).toMatchObject({
      signature: sig, mint: candidate(0).mint, slot: null
    });
    const duplicate = enqueueHeliusSignatureWork(queued.state, {
      signature: sig, mint: candidate(0).mint
    });
    expect(duplicate.outcome).toBe("DUPLICATE");
    expect(duplicate.state.queue).toHaveLength(1);
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
    for (let i = 0; i < MAX_HELIUS_SIGNATURE_QUEUE; i++) {
      state = enqueueHeliusNotification(state, { subscriptionId: 77, signature: sigFor(i), slot: i, err: null }).state;
    }
    const overflow = enqueueHeliusNotification(state, { subscriptionId: 77, signature: "9".repeat(64), slot: 101, err: null });
    expect(overflow.outcome).toBe("OVERFLOW");
    expect(overflow.state.incompleteMints).toContain(candidate(0).mint);
    expect(overflow.state.seenSignatures).not.toContain("9".repeat(64));
  });
  it("takes queued work in FIFO order and normalizes persisted bounds", () => {
    let state = reconcileHeliusSubscriptions(emptyHeliusMonitorState(), [candidate(0)]);
    state = confirmHeliusSubscription(state, state.subscriptions[0]!.requestId, 77);
    state = enqueueHeliusNotification(state, { subscriptionId: 77, signature: sig, slot: 1, err: null }).state;
    const taken = takeHeliusWork(state);
    expect(taken.work?.signature).toBe(sig);
    expect(taken.state.queue).toHaveLength(0);
    expect(normalizeHeliusMonitorState({ queue: Array(250).fill({}) }).queue).toHaveLength(MAX_HELIUS_SIGNATURE_QUEUE);
  });
  it("schedules bounded transient retries with durable backoff and marks exhausted mints", () => {
    const mint = candidate(0).mint;
    const initial = enqueueHeliusSignatureWork(emptyHeliusMonitorState(), {
      signature: sig, mint, slot: 10
    }, "2026-11-12T12:00:00.000Z").state;
    let state = initial;
    const delays = [5_000, 15_000, 60_000];
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      const work = state.queue[0]!;
      state = takeHeliusWork(state).state;
      const now = Date.parse("2026-11-12T12:00:00.000Z") + attempt * 100_000;
      const retry = retryHeliusSignatureWork(state, work, now);
      expect(retry.outcome).toBe("RETRY_SCHEDULED");
      expect(Date.parse(retry.retryAfterAt!)).toBe(now + delays[attempt]!);
      expect(retry.state.queue[0]).toMatchObject({
        signature: sig, mint, retryAttempt: attempt + 1,
        retryAfterAt: new Date(now + delays[attempt]!).toISOString()
      });
      state = retry.state;
    }
    const last = state.queue[0]!;
    state = takeHeliusWork(state).state;
    const exhausted = retryHeliusSignatureWork(state, last, Date.parse("2026-11-12T12:10:00.000Z"));
    expect(exhausted.outcome).toBe("EXHAUSTED");
    expect(exhausted.state.queue).toHaveLength(0);
    expect(exhausted.state.incompleteMints).toContain(mint);
  });

  it("fails closed instead of losing a retry when the bounded queue is full", () => {
    const mint = candidate(0).mint;
    const full = {
      ...emptyHeliusMonitorState(),
      queue: Array.from({ length: MAX_HELIUS_SIGNATURE_QUEUE }, (_, index) => ({
        signature: sigFor(index), mint, slot: index, queuedAt: "2026-11-12T12:00:00.000Z"
      }))
    };
    const work = { signature: sig, mint, slot: 500, queuedAt: "2026-11-12T12:00:00.000Z" };
    const retry = retryHeliusSignatureWork(full, work, Date.parse("2026-11-12T12:00:00.000Z"));
    expect(retry.outcome).toBe("OVERFLOW");
    expect(retry.state.queue).toHaveLength(MAX_HELIUS_SIGNATURE_QUEUE);
    expect(retry.state.incompleteMints).toContain(mint);
    expect(retry.state.droppedSignatures).toBe(1);
  });

});
