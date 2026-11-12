import type { DiscoveryCandidate } from "./discovery-store.js";

export const MAX_HELIUS_CANDIDATES = 10;
export const MAX_HELIUS_SIGNATURE_QUEUE = 200;
export const MAX_HELIUS_SEEN_SIGNATURES = 5_000;
export const FRESH_LAUNCH_SLOT_RESERVE = 4;
export const FRESH_LAUNCH_WINDOW_MS = 60_000;

export interface CandidateMonitoringEvidence {
  score: number;
  hardRejected?: boolean;
  creatorClearanceComplete?: boolean;
  flowConfirmed?: boolean;
  dataComplete?: boolean;
}

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
  /** Null when queued from a provider discovery event without a slot. */
  slot: number | null;
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
  limit = MAX_HELIUS_CANDIDATES,
  evidenceByMint: Readonly<Record<string, CandidateMonitoringEvidence>> = {},
  now = Date.now()
): Array<{ mint: string; bondingCurve: string }> {
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_HELIUS_CANDIDATES) {
    throw new Error("Helius candidate limit must be between zero and ten.");
  }
  const selected: Array<{ mint: string; bondingCurve: string }> = [];
  const seen = new Set<string>();
  const eligible = candidates.filter(candidate =>
    candidate.status === "DISCOVERED" && ADDRESS.test(candidate.mint) &&
    Boolean(candidate.bondingCurve && ADDRESS.test(candidate.bondingCurve))
  );
  const fresh = eligible.filter(candidate => {
    const age = now - Date.parse(candidate.firstSeenAt);
    return Number.isFinite(age) && age >= 0 && age <= FRESH_LAUNCH_WINDOW_MS &&
      !evidenceByMint[candidate.mint]?.hardRejected;
  }).sort((a, b) => Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt));
  const followUp = eligible.filter(candidate => !fresh.some(item => item.mint === candidate.mint))
    .filter(candidate => !evidenceByMint[candidate.mint]?.hardRejected)
    .sort((a, b) => {
      const ea = evidenceByMint[a.mint];
      const eb = evidenceByMint[b.mint];
      const scoreA = Number.isFinite(ea?.score) ? ea!.score : 0;
      const scoreB = Number.isFinite(eb?.score) ? eb!.score : 0;
      if (scoreA !== scoreB) return scoreB - scoreA;
      const completeA = Number(Boolean(ea?.dataComplete));
      const completeB = Number(Boolean(eb?.dataComplete));
      if (completeA !== completeB) return completeB - completeA;
      const creatorA = Number(Boolean(ea?.creatorClearanceComplete));
      const creatorB = Number(Boolean(eb?.creatorClearanceComplete));
      if (creatorA !== creatorB) return creatorB - creatorA;
      const flowA = Number(Boolean(ea?.flowConfirmed));
      const flowB = Number(Boolean(eb?.flowConfirmed));
      if (flowA !== flowB) return flowB - flowA;
      if (a.observations !== b.observations) return b.observations - a.observations;
      const lastSeenA = Date.parse(a.lastSeenAt);
      const lastSeenB = Date.parse(b.lastSeenAt);
      if (lastSeenA !== lastSeenB) return lastSeenB - lastSeenA;
      return Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt);
    });

  // Reserve four slots for candidates still inside the initial 60-second
  // observation window. The other six slots follow evidence ranking. If one
  // pool is under-filled, the other pool may use the spare capacity.
  const freshLimit = Math.min(limit, FRESH_LAUNCH_SLOT_RESERVE);
  const add = (candidate: DiscoveryCandidate) => {
    if (selected.length >= limit || seen.has(candidate.mint)) return;
    seen.add(candidate.mint);
    selected.push({ mint: candidate.mint, bondingCurve: candidate.bondingCurve! });
  };
  for (const candidate of fresh.slice(0, freshLimit)) add(candidate);
  for (const candidate of followUp) add(candidate);
  for (const candidate of fresh.slice(freshLimit)) add(candidate);
  return selected;
}

/** Reconcile durable subscription intent; request IDs are stable across reconnects. */
export function reconcileHeliusSubscriptions(
  state: HeliusMonitorState,
  candidates: readonly DiscoveryCandidate[],
  now = new Date().toISOString(),
  evidenceByMint: Readonly<Record<string, CandidateMonitoringEvidence>> = {}
): HeliusMonitorState {
  const selected = selectHeliusCandidates(candidates, MAX_HELIUS_CANDIDATES, evidenceByMint, Date.parse(now));
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
  const confirmed = state.subscriptions.find(item => item.requestId === requestId);
  if (!confirmed) return state;
  return {
    ...state,
    // A new acknowledged subscription establishes a fresh coverage boundary.
    // Old windows remain excluded by subscribedAt; new complete windows may
    // become usable without permanently poisoning this mint after a reconnect.
    incompleteMints: state.incompleteMints.filter(mint => mint !== confirmed.mint),
    subscriptions: state.subscriptions.map(item => item.requestId === requestId
      ? { ...item, subscriptionId, subscribedAt: now }
      : item)
  };
}

/** Queue a provider-supplied create signature even if the logs subscription starts too late to observe it. */
export function enqueueHeliusSignatureWork(
  state: HeliusMonitorState,
  input: { signature: string; mint: string; slot?: number | null },
  now = new Date().toISOString()
): { state: HeliusMonitorState; outcome: "QUEUED" | "DUPLICATE" | "INVALID" | "OVERFLOW" } {
  if (!SIGNATURE.test(input.signature) || !ADDRESS.test(input.mint) ||
      !(input.slot === undefined || input.slot === null ||
        (Number.isSafeInteger(input.slot) && input.slot >= 0)) ||
      !Number.isFinite(Date.parse(now))) {
    return {
      state: { ...state, incompleteMints: [...new Set([...state.incompleteMints, input.mint])]
        .filter(value => ADDRESS.test(value)).slice(-MAX_HELIUS_CANDIDATES) },
      outcome: "INVALID"
    };
  }
  if (state.seenSignatures.includes(input.signature) ||
      state.queue.some(item => item.signature === input.signature)) {
    return { state: { ...state, duplicateSignatures: state.duplicateSignatures + 1 }, outcome: "DUPLICATE" };
  }
  if (state.queue.length >= MAX_HELIUS_SIGNATURE_QUEUE) {
    return {
      state: {
        ...state,
        droppedSignatures: state.droppedSignatures + 1,
        incompleteMints: [...new Set([...state.incompleteMints, input.mint])].slice(-MAX_HELIUS_CANDIDATES)
      },
      outcome: "OVERFLOW"
    };
  }
  const seenSignatures = [...state.seenSignatures, input.signature].slice(-MAX_HELIUS_SEEN_SIGNATURES);
  return {
    state: {
      ...state, seenSignatures,
      queue: [...state.queue, {
        signature: input.signature, mint: input.mint, slot: input.slot ?? null, queuedAt: now
      }]
    },
    outcome: "QUEUED"
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
