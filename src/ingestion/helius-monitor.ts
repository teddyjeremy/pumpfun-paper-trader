import { buildCandidateLogsSubscribe, parseHeliusLogsNotification } from "./helius.js";
import type { DiscoveryCandidate } from "./discovery-store.js";

export const MAX_HELIUS_MONITORED_CANDIDATES = 10;
export const MAX_HELIUS_PENDING_SIGNATURES = 100;
export const MAX_HELIUS_SEEN_SIGNATURES = 5_000;

export interface HeliusMonitoredCandidate {
  mint: string;
  bondingCurve: string;
  requestId: number;
  subscriptionId: number | null;
  status: "SUBSCRIBING" | "SUBSCRIBED" | "DATA_INCOMPLETE";
  updatedAt: string;
}

export interface HeliusPendingSignature {
  signature: string;
  mint: string;
  bondingCurve: string;
  slot: number;
  receivedAt: string;
}

export interface HeliusMonitorState {
  monitored: HeliusMonitoredCandidate[];
  pending: HeliusPendingSignature[];
  seenSignatures: string[];
  nextRequestId: number;
  overflow: number;
  duplicates: number;
  failedNotifications: number;
  incompleteMints: string[];
}

export function emptyHeliusMonitorState(): HeliusMonitorState {
  return {
    monitored: [],
    pending: [],
    seenSignatures: [],
    nextRequestId: 1,
    overflow: 0,
    duplicates: 0,
    failedNotifications: 0,
    incompleteMints: []
  };
}

function validAddress(value: string | null): value is string {
  return value !== null && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

/**
 * Select a bounded, deterministic set of fresh, non-migrated candidates.
 * A single standard logsSubscribe filter is emitted for each bonding curve.
 */
export function reconcileHeliusCandidates(
  current: HeliusMonitorState,
  candidates: readonly DiscoveryCandidate[],
  now = new Date().toISOString()
): { state: HeliusMonitorState; subscribe: Array<{ mint: string; request: Record<string, unknown> }> } {
  const eligible = candidates
    .filter(candidate => candidate.status === "DISCOVERED" && validAddress(candidate.bondingCurve))
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
    .slice(0, MAX_HELIUS_MONITORED_CANDIDATES);

  const selected = new Map(eligible.map(candidate => [candidate.mint, candidate]));
  const retained = current.monitored.filter(item => {
    const candidate = selected.get(item.mint);
    return candidate !== undefined && candidate.bondingCurve === item.bondingCurve;
  });
  const retainedMints = new Set(retained.map(item => item.mint));
  let nextRequestId = current.nextRequestId;
  const subscribe: Array<{ mint: string; request: Record<string, unknown> }> = [];

  for (const candidate of eligible) {
    if (retainedMints.has(candidate.mint)) continue;
    const requestId = nextRequestId++;
    const monitored: HeliusMonitoredCandidate = {
      mint: candidate.mint,
      bondingCurve: candidate.bondingCurve!,
      requestId,
      subscriptionId: null,
      status: "SUBSCRIBING",
      updatedAt: now
    };
    retained.push(monitored);
    subscribe.push({
      mint: candidate.mint,
      request: buildCandidateLogsSubscribe(candidate.bondingCurve!, requestId)
    });
  }

  return {
    state: { ...current, monitored: retained, nextRequestId },
    subscribe
  };
}

/** Map a successful JSON-RPC subscribe acknowledgement to its candidate. */
export function applyHeliusSubscribeAck(
  current: HeliusMonitorState,
  input: unknown,
  now = new Date().toISOString()
): HeliusMonitorState {
  if (!input || typeof input !== "object") return current;
  const message = input as Record<string, unknown>;
  if (!Number.isSafeInteger(message.id) || !Number.isSafeInteger(message.result)) return current;
  const monitored = current.monitored.map(item => item.requestId === message.id
    ? { ...item, subscriptionId: message.result as number, status: "SUBSCRIBED" as const, updatedAt: now }
    : item);
  return { ...current, monitored };
}

/**
 * Accept only successful logs notifications for a known subscription.
 * Failed transactions are counted but never enter the getTransaction queue.
 */
export function enqueueHeliusNotification(
  current: HeliusMonitorState,
  input: unknown,
  now = new Date().toISOString()
): { state: HeliusMonitorState; outcome: "QUEUED" | "DUPLICATE" | "FAILED" | "UNKNOWN_SUBSCRIPTION" | "INVALID" | "OVERFLOW" } {
  if (!input || typeof input !== "object") return { state: current, outcome: "INVALID" };
  const message = input as Record<string, unknown>;
  const params = message.params as Record<string, unknown> | undefined;
  const subscriptionId = params?.subscription;
  if (!Number.isSafeInteger(subscriptionId)) return { state: current, outcome: "INVALID" };
  const monitored = current.monitored.find(item => item.subscriptionId === subscriptionId);
  if (!monitored) return { state: current, outcome: "UNKNOWN_SUBSCRIPTION" };

  const parsed = parseHeliusLogsNotification(input);
  if (!parsed) {
    return {
      state: { ...current, incompleteMints: [...new Set([...current.incompleteMints, monitored.mint])].slice(-MAX_HELIUS_MONITORED_CANDIDATES) },
      outcome: "INVALID"
    };
  }
  if (parsed.err !== null) {
    return { state: { ...current, failedNotifications: current.failedNotifications + 1 }, outcome: "FAILED" };
  }
  if (current.seenSignatures.includes(parsed.signature) ||
      current.pending.some(item => item.signature === parsed.signature)) {
    return { state: { ...current, duplicates: current.duplicates + 1 }, outcome: "DUPLICATE" };
  }
  if (current.pending.length >= MAX_HELIUS_PENDING_SIGNATURES) {
    return {
      state: {
        ...current,
        overflow: current.overflow + 1,
        incompleteMints: [...new Set([...current.incompleteMints, monitored.mint])].slice(-MAX_HELIUS_MONITORED_CANDIDATES)
      },
      outcome: "OVERFLOW"
    };
  }

  return {
    state: {
      ...current,
      pending: [...current.pending, {
        signature: parsed.signature,
        mint: monitored.mint,
        bondingCurve: monitored.bondingCurve,
        slot: parsed.slot,
        receivedAt: now
      }]
    },
    outcome: "QUEUED"
  };
}

/** Persist a signature in the bounded dedup set before starting its RPC fetch. */
export function takeHeliusPendingSignature(
  current: HeliusMonitorState
): { state: HeliusMonitorState; item: HeliusPendingSignature | null } {
  if (current.pending.length === 0) return { state: current, item: null };
  const [item, ...pending] = current.pending;
  if (!item) return { state: current, item: null };
  const seenSignatures = [...current.seenSignatures.filter(signature => signature !== item.signature), item.signature]
    .slice(-MAX_HELIUS_SEEN_SIGNATURES);
  return {
    state: { ...current, pending, seenSignatures },
    item
  };
}

/** Mark every currently monitored candidate incomplete after a socket gap. */
export function markHeliusMonitorGap(current: HeliusMonitorState): HeliusMonitorState {
  return {
    ...current,
    monitored: current.monitored.map(item => ({ ...item, status: "DATA_INCOMPLETE" })),
    incompleteMints: [...new Set([...current.incompleteMints, ...current.monitored.map(item => item.mint)])]
      .slice(-MAX_HELIUS_MONITORED_CANDIDATES)
  };
}
