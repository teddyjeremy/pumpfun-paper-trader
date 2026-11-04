export type FailureCategory =
  | "provider_connection" | "provider_lag" | "event_decode" | "metadata"
  | "risk_screen" | "quote_missing" | "quote_stale" | "quote_cost"
  | "sellability" | "graduation" | "execution_simulation"
  | "persistence" | "internal";

export interface DiagnosticEvent {
  at: string;
  category: FailureCategory;
  code: string;
  message: string;
  mint?: string;
  retryable: boolean;
  context?: Record<string, string | number | boolean | null>;
}

export interface DiagnosticSnapshot {
  startedAt: string;
  lastEventAt: string | null;
  counters: Record<string, number>;
  failures: DiagnosticEvent[];
  readiness: { ready: boolean; blockers: string[] };
}

const MAX_FAILURES = 500;
const counters = new Map<string, number>();
const failures: DiagnosticEvent[] = [];
const startedAt = new Date().toISOString();
let lastEventAt: string | null = null;
const blockers = new Set<string>([
  "Launch discovery adapter is not configured",
  "Verified Pump.fun bonding-curve quote adapter is not configured",
  "Persistent trade ledger is not configured"
]);

export function increment(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
  lastEventAt = new Date().toISOString();
}

export function recordFailure(event: Omit<DiagnosticEvent, "at">): void {
  const full: DiagnosticEvent = { ...event, at: new Date().toISOString() };
  failures.push(full);
  if (failures.length > MAX_FAILURES) failures.shift();
  increment(`failure.${event.category}`);
}

export function setReadinessBlocker(blocker: string, active: boolean): void {
  if (active) blockers.add(blocker);
  else blockers.delete(blocker);
}

export function snapshot(): DiagnosticSnapshot {
  return {
    startedAt,
    lastEventAt,
    counters: Object.fromEntries(counters),
    failures: [...failures].reverse(),
    readiness: { ready: blockers.size === 0, blockers: [...blockers] }
  };
}

export function diagnose(): {
  status: "healthy" | "degraded" | "not_ready";
  topFailures: Array<{ category: string; count: number; likelyAction: string }>;
  notes: string[];
} {
  const all = Object.fromEntries(counters);
  const categories = Object.entries(all)
    .filter(([key]) => key.startsWith("failure."))
    .map(([key, count]) => ({ category: key.slice(8), count, likelyAction: actionFor(key.slice(8)) }))
    .sort((a, b) => b.count - a.count);
  const readiness = snapshot().readiness;
  const notes: string[] = [];
  if (readiness.blockers.length) notes.push("Live trading simulation is not ready: required adapters or persistence are missing.");
  if ((all["candidate.discovered"] ?? 0) === 0) notes.push("No launches have been ingested in this process. Check provider configuration and stream health before changing strategy filters.");
  if ((all["candidate.rejected"] ?? 0) > 0) notes.push("Review rejection reason counts before relaxing any hard safety gate.");
  if ((all["quote.success"] ?? 0) === 0 && (all["candidate.discovered"] ?? 0) > 0) notes.push("Candidates exist but no successful quote is recorded; investigate quote adapter, curve state and provider latency.");
  return {
    status: !readiness.ready ? "not_ready" : categories.length ? "degraded" : "healthy",
    topFailures: categories.slice(0, 8),
    notes
  };
}

function actionFor(category: string): string {
  const actions: Record<string, string> = {
    provider_connection: "Check Helius secret, endpoint, account limits and network connectivity.",
    provider_lag: "Measure slot/stream lag; inspect reconnects and subscription throughput.",
    event_decode: "Compare program IDs and instruction/account layouts against the current Pump.fun SDK.",
    metadata: "Check metadata URI availability and parsing; reject candidates with missing critical fields.",
    risk_screen: "Inspect risk-rule results and source data completeness; do not weaken hard rejects to increase trade count.",
    quote_missing: "Verify bonding-curve account fetch and official SDK quote inputs; never substitute a DEX quote.",
    quote_stale: "Reduce quote age or refresh immediately before simulated execution.",
    quote_cost: "Inspect protocol/creator/network fees, impact and slippage; skip uneconomic trades.",
    sellability: "Check fresh sell quote, token program constraints and curve state.",
    graduation: "Stop entries near graduation; record unavailable exits without migrating routes.",
    execution_simulation: "Inspect simulated latency, quote refresh and raw-unit calculations.",
    persistence: "Check database connectivity, migrations and transaction boundaries.",
    internal: "Inspect structured logs and stack trace for the associated correlation ID."
  };
  return actions[category] ?? "Inspect the failure event and correlated logs.";
}
