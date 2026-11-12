import { describe, expect, it } from "vitest";
import {
  applyHeliusSubscribeAck,
  emptyHeliusMonitorState,
  enqueueHeliusNotification,
  markHeliusMonitorGap,
  reconcileHeliusCandidates,
  takeHeliusPendingSignature,
  MAX_HELIUS_MONITORED_CANDIDATES,
  MAX_HELIUS_PENDING_SIGNATURES
} from "../src/ingestion/helius-monitor.js";
import type { DiscoveryCandidate } from "../src/ingestion/discovery-store.js";

const mint = "So11111111111111111111111111111111111111112";
const curve = "11111111111111111111111111111111";
const signature = "5".repeat(88);

function candidate(index: number): DiscoveryCandidate {
  return {
    kind: "new_token",
    mint: index === 0 ? mint : `So1111111111111111111111111111111111111111${index}`,
    signature: null,
    creator: null,
    bondingCurve: curve,
    name: null,
    symbol: null,
    receivedAt: "2026-11-12T00:00:00.000Z",
    status: "DISCOVERED",
    firstSeenAt: "2026-11-12T00:00:00.000Z",
    lastSeenAt: new Date(Date.parse("2026-11-12T00:00:00.000Z") + index * 1000).toISOString(),
    observations: 1
  };
}

function notification(subscription: number, sig: string, err: unknown = null) {
  return {
    jsonrpc: "2.0",
    method: "logsNotification",
    params: {
      subscription,
      result: {
        context: { slot: 42 },
        value: { signature: sig, err, logs: [] }
      }
    }
  };
}

describe("bounded durable Helius monitor state", () => {
  it("monitors no more than ten candidates and emits one-address subscriptions", () => {
    const candidates = Array.from({ length: 25 }, (_, index) => candidate(index));
    const result = reconcileHeliusCandidates(emptyHeliusMonitorState(), candidates);
    expect(result.state.monitored).toHaveLength(MAX_HELIUS_MONITORED_CANDIDATES);
    expect(result.subscribe).toHaveLength(MAX_HELIUS_MONITORED_CANDIDATES);
    expect(result.subscribe[0]?.request).toMatchObject({
      method: "logsSubscribe",
      params: [{ mentions: [curve] }, { commitment: "confirmed" }]
    });
  });

  it("retains existing subscription IDs and does not resubscribe unchanged curves", () => {
    const first = reconcileHeliusCandidates(emptyHeliusMonitorState(), [candidate(0)]);
    const acked = applyHeliusSubscribeAck(first.state, { id: 1, result: 77 });
    const next = reconcileHeliusCandidates(acked, [candidate(0)]);
    expect(next.subscribe).toHaveLength(0);
    expect(next.state.monitored[0]).toMatchObject({ subscriptionId: 77, status: "SUBSCRIBED" });
  });

  it("queues only successful notifications belonging to a known subscription", () => {
    const first = reconcileHeliusCandidates(emptyHeliusMonitorState(), [candidate(0)]);
    const acked = applyHeliusSubscribeAck(first.state, { id: 1, result: 77 });
    const failed = enqueueHeliusNotification(acked, notification(77, signature, { InstructionError: [0, "Custom"] }));
    expect(failed.outcome).toBe("FAILED");
    expect(failed.state.pending).toHaveLength(0);

    const unknown = enqueueHeliusNotification(acked, notification(999, signature));
    expect(unknown.outcome).toBe("UNKNOWN_SUBSCRIPTION");

    const queued = enqueueHeliusNotification(acked, notification(77, signature));
    expect(queued.outcome).toBe("QUEUED");
    expect(queued.state.pending[0]).toMatchObject({ signature, mint, bondingCurve: curve, slot: 42 });
  });

  it("deduplicates signatures and persists the signature before the fetch is taken", () => {
    const first = reconcileHeliusCandidates(emptyHeliusMonitorState(), [candidate(0)]);
    const acked = applyHeliusSubscribeAck(first.state, { id: 1, result: 77 });
    const queued = enqueueHeliusNotification(acked, notification(77, signature));
    const duplicate = enqueueHeliusNotification(queued.state, notification(77, signature));
    expect(duplicate.outcome).toBe("DUPLICATE");
    const taken = takeHeliusPendingSignature(duplicate.state);
    expect(taken.item?.signature).toBe(signature);
    expect(taken.state.seenSignatures).toContain(signature);
    expect(takeHeliusPendingSignature(taken.state).item).toBeNull();
  });

  it("marks monitored candidates incomplete after a socket gap", () => {
    const first = reconcileHeliusCandidates(emptyHeliusMonitorState(), [candidate(0)]);
    const gap = markHeliusMonitorGap(first.state);
    expect(gap.monitored[0]?.status).toBe("DATA_INCOMPLETE");
    expect(gap.incompleteMints).toContain(mint);
  });

  it("bounds pending signature growth and marks overflow as incomplete", () => {
    const first = reconcileHeliusCandidates(emptyHeliusMonitorState(), [candidate(0)]);
    const acked = applyHeliusSubscribeAck(first.state, { id: 1, result: 77 });
    let state = acked;
    let outcome = "";
    for (let index = 0; index < MAX_HELIUS_PENDING_SIGNATURES + 1; index += 1) {
      const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      const value = index + 1;
      const sig = "5".repeat(86) + alphabet[Math.floor(value / alphabet.length)] + alphabet[value % alphabet.length];
      const result = enqueueHeliusNotification(state, notification(77, sig));
      state = result.state;
      outcome = result.outcome;
    }
    expect(state.pending).toHaveLength(MAX_HELIUS_PENDING_SIGNATURES);
    expect(outcome).toBe("OVERFLOW");
    expect(state.incompleteMints).toContain(mint);
  });
});
