export interface DiscoveryInput {
  kind: "new_token" | "migration";
  mint: string;
  signature: string | null;
  creator: string | null;
  bondingCurve: string | null;
  name: string | null;
  symbol: string | null;
  receivedAt: string;
}

export interface DiscoveryCandidate extends DiscoveryInput {
  status: "DISCOVERED" | "MIGRATED";
  firstSeenAt: string;
  lastSeenAt: string;
  observations: number;
}

export interface DiscoveryStoreState {
  candidates: DiscoveryCandidate[];
  accepted: number;
  duplicates: number;
  migrations: number;
  overflow: number;
  overflowMints: string[];
  incomplete: number;
  expired: number;
  lastPersistedAt: string | null;
}

export const DEFAULT_DISCOVERY_CAP = 100;
export const DEFAULT_DISCOVERY_TTL_MS = 15 * 60 * 1000;
const MAX_RECORDED_OVERFLOW_MINTS = 100;

export function emptyDiscoveryStore(): DiscoveryStoreState {
  return {
    candidates: [],
    accepted: 0,
    duplicates: 0,
    migrations: 0,
    overflow: 0,
    overflowMints: [],
    incomplete: 0,
    expired: 0,
    lastPersistedAt: null
  };
}

function validTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Deterministic bounded candidate store. Provider events are hints only;
 * callers must still verify mint, creator, curve and transaction on-chain.
 */
export function applyDiscoveryEvent(
  current: DiscoveryStoreState,
  event: DiscoveryInput,
  options: { now?: string; cap?: number; ttlMs?: number } = {}
): { state: DiscoveryStoreState; outcome: "ADDED" | "UPDATED" | "OVERFLOW" | "INVALID_TIME" } {
  const cap = options.cap ?? DEFAULT_DISCOVERY_CAP;
  const ttlMs = options.ttlMs ?? DEFAULT_DISCOVERY_TTL_MS;
  const now = options.now ?? event.receivedAt;
  const nowMs = validTimestamp(now);
  const receivedMs = validTimestamp(event.receivedAt);
  if (nowMs === null || receivedMs === null || receivedMs > nowMs + 30_000) {
    return { state: { ...current, incomplete: current.incomplete + 1 }, outcome: "INVALID_TIME" };
  }

  const retained = current.candidates.filter((candidate) => {
    const seen = validTimestamp(candidate.lastSeenAt);
    return seen !== null && nowMs - seen <= ttlMs;
  });
  const existingIndex = retained.findIndex((candidate) => candidate.mint === event.mint);

  if (existingIndex >= 0) {
    const previous = retained[existingIndex]!;
    const migrated = event.kind === "migration" || previous.status === "MIGRATED";
    retained[existingIndex] = {
      ...previous,
      kind: event.kind,
      signature: event.signature ?? previous.signature,
      creator: event.creator ?? previous.creator,
      bondingCurve: event.bondingCurve ?? previous.bondingCurve,
      name: event.name ?? previous.name,
      symbol: event.symbol ?? previous.symbol,
      status: migrated ? "MIGRATED" : "DISCOVERED",
      lastSeenAt: event.receivedAt,
      receivedAt: event.receivedAt,
      observations: previous.observations + 1
    };
    return {
      state: {
        ...current,
        candidates: retained,
        duplicates: current.duplicates + 1,
        migrations: current.migrations + (event.kind === "migration" ? 1 : 0)
      },
      outcome: "UPDATED"
    };
  }

  if (retained.length >= cap) {
    const overflowMints = current.overflowMints.includes(event.mint)
      ? current.overflowMints
      : [...current.overflowMints, event.mint].slice(-MAX_RECORDED_OVERFLOW_MINTS);
    return {
      state: {
        ...current,
        candidates: retained,
        overflow: current.overflow + 1,
        overflowMints
      },
      outcome: "OVERFLOW"
    };
  }

  retained.push({
    ...event,
    status: event.kind === "migration" ? "MIGRATED" : "DISCOVERED",
    firstSeenAt: event.receivedAt,
    lastSeenAt: event.receivedAt,
    observations: 1
  });

  return {
    state: {
      ...current,
      candidates: retained,
      accepted: current.accepted + 1,
      migrations: current.migrations + (event.kind === "migration" ? 1 : 0)
    },
    outcome: "ADDED"
  };
}


/** Remove stale candidates during idle periods as well as when new events arrive. */
export function pruneExpiredCandidates(
  current: DiscoveryStoreState,
  now: string,
  ttlMs = DEFAULT_DISCOVERY_TTL_MS
): DiscoveryStoreState {
  const nowMs = validTimestamp(now);
  if (nowMs === null) {
    return { ...current, incomplete: current.incomplete + 1 };
  }
  const candidates = current.candidates.filter((candidate) => {
    const seen = validTimestamp(candidate.lastSeenAt);
    return seen !== null && nowMs - seen <= ttlMs;
  });
  const removed = current.candidates.length - candidates.length;
  if (removed <= 0) return current;
  return {
    ...current,
    candidates,
    expired: (current.expired ?? 0) + removed
  };
}
