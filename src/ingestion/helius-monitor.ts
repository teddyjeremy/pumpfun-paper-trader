import type { DiscoveryCandidate } from "./discovery-store.js";

export const MAX_HELIUS_CANDIDATES = 10;
export const MAX_HELIUS_SIGNATURE_QUEUE = 100;
export const MAX_HELIUS_SEEN_SIGNATURES = 5_000;

export interface HeliusCandidateSubscription {
  requestId: number;
  subscriptionId: number | null;
  mint: string;
  bondingCurve: string;
  subscribedAt: string | null;
}

export interface HeliusSignatureWork {
  signature: string;
  mint: string;
  slot: number;
  queuedAt: string;
}

export interface HeliusMonitorState {
  subscriptions: HeliusCandidateSubscription[];
  queue: HeliusSignatureWork[];
  seenSignatures: string[];
  incompleteMints: string[];
  failedTransactions: number;
  droppedSignatures: number;
  duplicateSignatures: number;
  nextRequestId: number;
}

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;

export function emptyHeliusMonitorState(): HeliusMonitorState {
  return {
    subscriptions: [], queue: [], seenSignatures: [], incompleteMints: [],
    failedTransactions: 0, droppedSignatures: 0, duplicateSignatures: 0,
    nextRequestId: 1
  };
}

export function normalizeHeliusMonitorState(value?: Partial<HeliusMonitorState> | null): HeliusMonitorState {
  const empty = emptyHeliusMonitorState();
  if (!value) return empty;
  return {
    ...empty,
    ...value,
    subscriptions: Array.isArray(value.subscriptions) ? value.subscriptions.slice(0, MAX_HELIUS_CANDIDATES) : [],
    queue: Array.isArray(value.queue) ? value.queue.slice(0, MAX_HELIUS_SIGNATURE_QUEUE) : [],
    seenSignatures: Array.isArray(value.seenSignatures) ? value.seenSignatures.slice(-MAX_HELIUS_SEEN_SIGNATURES) : [],
    incompleteMints: Array.isArray(value.incompleteMints) ? [...new Set(value.incompleteMints)].slice(-MAX_HELIUS_CANDIDATES) : []
  };
}

/** Select only active, non-migrated candidates with a valid bonding-curve address. */
export function selectHeliusCandidates(
  candidates: readonly DiscoveryCandidate[],
  limit = MAX_HELIUS_CANDIDATES
): Array<{ mint: string; bondingCurve: string }> {
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_HELIUS_CANDIDATES) {
    throw new Error("Helius candidate limit must be between zero and ten.");
  }
  const selected: Array<{ mint: string; bondingCurve: string }> = [];
  const seen = new Set<string>();
  // This is a monitoring-priority order, not a trading-quality score.
  // The discovery feed does not contain trade flow, wallet concentration,
  // creator sells, liquidity, or executable quotes, so those must not be
  // fabricated here. Prefer candidates with more complete identity evidence,
  // then repeated observations, then freshness. Unknown creator data remains
  // eligible for WATCH/monitoring rather than being treated as a safety pass.
  const priorityOrder = [...candidates].sort((a, b) => {
    const creatorA = a.creator && ADDRESS.test(a.creator) ? 1 : 0;
    const creatorB = b.creator && ADDRESS.test(b.creator) ? 1 : 0;
    if (creatorA !== creatorB) return creatorB - creatorA;
    if (a.observations !== b.observations) return b.observations - a.observations;
    const lastSeenA = Date.parse(a.lastSeenAt);
    const lastSeenB = Date.parse(b.lastSeenAt);
    if (lastSeenA !== lastSeenB) return lastSeenB - lastSeenA;
    return Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt);
  });
  for (const candidate of priorityOrder) {
    if (selected.length >= limit) break;
    if (candidate.status !== "DISCOVERED" || !ADDRESS.test(candidate.mint) ||
        !candidate.bondingCurve || !ADDRESS.test(candidate.bondingCurve) ||
        seen.has(candidate.mint)) continue;
    seen.add(candidate.mint);
    selected.push({ mint: candidate.mint, bondingCurve: candidate.bondingCurve });
  }
  return selected;
}

/** Reconcile durable subscription intent; request IDs are stable across reconnects. */
export function reconcileHeliusSubscriptions(
  state: HeliusMonitorState,
  candidates: readonly DiscoveryCandidate[],
  now = new Date().toISOString()
): HeliusMonitorState {
  const selected = selectHeliusCandidates(candidates);
  const byMint = new Map(state.subscriptions.map(item => [item.mint, item]));
  const subscriptions = selected.map(candidate => {
    const existing = byMint.get(candidate.mint);
    if (existing?.bondingCurve === candidate.bondingCurve) {
      return existing;
    }
    const requestId = state.nextRequestId++;
    return { ...candidate, requestId, subscriptionId: null, subscribedAt: null };
  });
  return { ...state, subscriptions };
}

export function confirmHeliusSubscription(
  state: HeliusMonitorState,
  requestId: number,
  subscriptionId: number,
  now = new Date().toISOString()
): HeliusMonitorState {
  if (!Number.isSafeInteger(subscriptionId) || subscriptionId < 0) return state;
  return {
    ...state,
    subscriptions: state.subscriptions.map(item => item.requestId === requestId
      ? { ...item, subscriptionId, subscribedAt: now }
      : item)
  };
}

/** Failed logs are counted but never fetched; only successful candidate logs enter the queue. */
export function enqueueHeliusNotification(
  state: HeliusMonitorState,
  input: { subscriptionId: number; signature: string; slot: number; err: unknown },
  now = new Date().toISOString()
): { state: HeliusMonitorState; outcome: "QUEUED" | "DUPLICATE" | "FAILED" | "UNKNOWN_SUBSCRIPTION" | "INVALID" | "OVERFLOW" } {
  const subscription = state.subscriptions.find(item => item.subscriptionId === input.subscriptionId);
  if (!subscription) return { state, outcome: "UNKNOWN_SUBSCRIPTION" };
  if (!SIGNATURE.test(input.signature) || !Number.isSafeInteger(input.slot) || input.slot < 0) {
    return { state: { ...state, incompleteMints: [...new Set([...state.incompleteMints, subscription.mint])].slice(-MAX_HELIUS_CANDIDATES) }, outcome: "INVALID" };
  }
  if (input.err !== null) {
    return { state: { ...state, failedTransactions: state.failedTransactions + 1 }, outcome: "FAILED" };
  }
  if (state.seenSignatures.includes(input.signature) || state.queue.some(item => item.signature === input.signature)) {
    return { state: { ...state, duplicateSignatures: state.duplicateSignatures + 1 }, outcome: "DUPLICATE" };
  }
  const seenSignatures = [...state.seenSignatures, input.signature].slice(-MAX_HELIUS_SEEN_SIGNATURES);
  if (state.queue.length >= MAX_HELIUS_SIGNATURE_QUEUE) {
    return {
      state: {
        ...state, seenSignatures,
        droppedSignatures: state.droppedSignatures + 1,
        incompleteMints: [...new Set([...state.incompleteMints, subscription.mint])].slice(-MAX_HELIUS_CANDIDATES)
      },
      outcome: "OVERFLOW"
    };
  }
  return {
    state: {
      ...state, seenSignatures,
      queue: [...state.queue, { signature: input.signature, mint: subscription.mint, slot: input.slot, queuedAt: now }]
    },
    outcome: "QUEUED"
  };
}

export function takeHeliusWork(state: HeliusMonitorState): { state: HeliusMonitorState; work: HeliusSignatureWork | null } {
  if (state.queue.length === 0) return { state, work: null };
  return { state: { ...state, queue: state.queue.slice(1) }, work: state.queue[0] ?? null };
}

/** Drop socket-scoped subscription IDs before reconnecting a new WebSocket. */
export function resetHeliusSubscriptionIds(state: HeliusMonitorState): HeliusMonitorState {
  return {
    ...state,
    subscriptions: state.subscriptions.map(item => ({ ...item, subscriptionId: null, subscribedAt: null }))
  };
}
