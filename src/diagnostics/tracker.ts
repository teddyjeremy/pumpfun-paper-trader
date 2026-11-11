/**
 * In-process observability for the complete launch-to-exit funnel.
 * Volatile by design until the PostgreSQL event ledger is connected.
 * This module records telemetry only; it cannot execute trades.
 */
export type FunnelStage =
  | "discovered" | "enriched" | "risk_passed" | "quoted"
  | "watchlisted" | "entered" | "exited";

export type DecisionReason =
  | "mint_authority" | "freeze_authority" | "token_extension"
  | "creator_risk" | "holder_concentration" | "wallet_cluster"
  | "insider_snipers" | "insufficient_real_reserves" | "metadata_missing"
  | "no_sell_quote" | "quote_stale" | "fees_too_high" | "price_impact"
  | "round_trip_cost" | "unknown_costs" | "weak_momentum"
  | "insufficient_buyers" | "graduating" | "curve_unavailable"
  | "duplicate_position" | "position_limit" | "buy_in_flight"
  | "cooldown" | "daily_loss_limit" | "kill_switch" | "other";

export interface CandidateRecord {
  mint: string;
  firstSeenAt: string;
  lastUpdatedAt: string;
  stage: FunnelStage;
  decision: "pending" | "watch" | "reject" | "paper_entry" | "paper_exit";
  reasons: DecisionReason[];
  riskScore: number | null;
  momentumScore: number | null;
  strategyVersion: string;
  sourceSlot: number | null;
  quoteAgeMs: number | null;
  buyPriceImpactPct: number | null;
  sellPriceImpactPct: number | null;
  roundTripCostPct: number | null;
  expectedNetProfitPct: number | null;
}

export interface LatencySample { name: string; ms: number; at: string }
export interface PositionTelemetry {
  mint: string;
  state: "buy_pending" | "open" | "migration_pending" | "open_migrated" | "sell_pending" | "exit_blocked" | "closed" | "exit_unexecutable";
  activeVenue?: "bonding_curve" | "pumpswap" | "unknown";
  activeStopPriceUsd?: number | null;
  lastExitSignal?: string | null;
  openedAt: string | null;
  closedAt: string | null;
  entryCostUsd: number | null;
  exitValueUsd: number | null;
  feesUsd: number | null;
  realizedNetPnlUsd: number | null;
  exitReason: string | null;
  tokenBalanceZeroConfirmed: boolean;
}

const MAX_CANDIDATES = 1000;
const MAX_LATENCIES = 5000;
const MAX_POSITIONS = 500;
const counters = new Map<string, number>();
const candidates = new Map<string, CandidateRecord>();
const positions = new Map<string, PositionTelemetry>();
const latencies: LatencySample[] = [];
const rejectionCounts = new Map<DecisionReason, number>();
const costSamples: Array<{ roundTripCostPct: number; at: string }> = [];
const eventSamples: Array<{ type: string; at: string; mint?: string; detail?: string }> = [];

function bump(key: string, by = 1): void { counters.set(key, (counters.get(key) ?? 0) + by); }
function now(): string { return new Date().toISOString(); }

export function trackStage(mint: string, stage: FunnelStage, fields: Partial<Omit<CandidateRecord, "mint" | "firstSeenAt" | "lastUpdatedAt" | "stage">> = {}): CandidateRecord {
  const previous = candidates.get(mint);
  const record: CandidateRecord = {
    mint,
    firstSeenAt: previous?.firstSeenAt ?? now(),
    lastUpdatedAt: now(),
    stage,
    decision: fields.decision ?? previous?.decision ?? "pending",
    reasons: fields.reasons ?? previous?.reasons ?? [],
    riskScore: fields.riskScore ?? previous?.riskScore ?? null,
    momentumScore: fields.momentumScore ?? previous?.momentumScore ?? null,
    strategyVersion: fields.strategyVersion ?? previous?.strategyVersion ?? "unassigned",
    sourceSlot: fields.sourceSlot ?? previous?.sourceSlot ?? null,
    quoteAgeMs: fields.quoteAgeMs ?? previous?.quoteAgeMs ?? null,
    buyPriceImpactPct: fields.buyPriceImpactPct ?? previous?.buyPriceImpactPct ?? null,
    sellPriceImpactPct: fields.sellPriceImpactPct ?? previous?.sellPriceImpactPct ?? null,
    roundTripCostPct: fields.roundTripCostPct ?? previous?.roundTripCostPct ?? null,
    expectedNetProfitPct: fields.expectedNetProfitPct ?? previous?.expectedNetProfitPct ?? null
  };
  candidates.set(mint, record);
  if (previous?.stage !== stage) bump(`funnel.${stage}`);
  pushEvent(`candidate.${stage}`, mint);
  while (candidates.size > MAX_CANDIDATES) candidates.delete(candidates.keys().next().value as string);
  return record;
}

export function trackDecision(mint: string, decision: CandidateRecord["decision"], reasons: DecisionReason[], fields: Partial<CandidateRecord> = {}): void {
  const previous = candidates.get(mint);
  const stage = decision === "paper_entry" ? "entered" : decision === "paper_exit" ? "exited" : previous?.stage ?? "discovered";
  trackStage(mint, stage, {
    decision,
    reasons,
    riskScore: fields.riskScore ?? previous?.riskScore ?? null,
    momentumScore: fields.momentumScore ?? previous?.momentumScore ?? null,
    strategyVersion: fields.strategyVersion ?? previous?.strategyVersion ?? "unassigned",
    sourceSlot: fields.sourceSlot ?? previous?.sourceSlot ?? null,
    quoteAgeMs: fields.quoteAgeMs ?? previous?.quoteAgeMs ?? null,
    buyPriceImpactPct: fields.buyPriceImpactPct ?? previous?.buyPriceImpactPct ?? null,
    sellPriceImpactPct: fields.sellPriceImpactPct ?? previous?.sellPriceImpactPct ?? null,
    roundTripCostPct: fields.roundTripCostPct ?? previous?.roundTripCostPct ?? null,
    expectedNetProfitPct: fields.expectedNetProfitPct ?? previous?.expectedNetProfitPct ?? null
  });
  if (decision === "reject" && previous?.decision !== "reject") {
    bump("candidate.rejected");
    for (const reason of reasons.length ? reasons : ["other" as DecisionReason]) {
      rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + 1);
    }
  }
}

export function trackLatency(name: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  latencies.push({ name, ms, at: now() });
  if (latencies.length > MAX_LATENCIES) latencies.shift();
  bump(`latency.samples.${name}`);
}

export function trackQuote(outcome: "success" | "missing" | "stale" | "cost_rejected" | "sellability_failed", details?: { mint?: string; roundTripCostPct?: number; quoteAgeMs?: number }): void {
  bump(`quote.${outcome}`);
  if (details?.roundTripCostPct !== undefined && Number.isFinite(details.roundTripCostPct)) {
    costSamples.push({ roundTripCostPct: details.roundTripCostPct, at: now() });
    if (costSamples.length > MAX_LATENCIES) costSamples.shift();
  }
  pushEvent(`quote.${outcome}`, details?.mint, details?.quoteAgeMs === undefined ? undefined : `quoteAgeMs=${details.quoteAgeMs}`);
}

export function trackPosition(position: PositionTelemetry): void {
  positions.set(position.mint, position);
  bump(`position.${position.state}`);
  if (position.state === "closed" && !position.tokenBalanceZeroConfirmed) {
    bump("invariant.slot_release_without_zero_balance");
    pushEvent("invariant.violation", position.mint, "Closed position lacks zero-balance confirmation");
  }
  while (positions.size > MAX_POSITIONS) positions.delete(positions.keys().next().value as string);
}

export function trackProvider(state: "connected" | "disconnected" | "reconnected", slotLag?: number): void {
  bump(`provider.${state}`);
  if (slotLag !== undefined) {
    bump("provider.slot_lag.samples");
    counters.set("provider.slot_lag.latest", Math.max(0, Math.floor(slotLag)));
  }
}

export function trackGraduation(mint: string, state: "approaching" | "graduated" | "curve_unavailable"): void {
  bump(`graduation.${state}`);
  pushEvent(`graduation.${state}`, mint);
}

export function trackRisk(mint: string, score: number, hardRejectReasons: DecisionReason[]): void {
  bump("risk.assessed");
  if (hardRejectReasons.length) trackDecision(mint, "reject", hardRejectReasons, { riskScore: score });
  else trackStage(mint, "risk_passed", { riskScore: score });
}

export function trackMomentum(mint: string, score: number, strategyVersion: string): void {
  bump("momentum.scored");
  trackStage(mint, "watchlisted", { momentumScore: score, strategyVersion });
}

export function trackSystemEvent(type: string, detail?: string): void {
  bump(`system.${type}`);
  pushEvent(type, undefined, detail);
}

function pushEvent(type: string, mint?: string, detail?: string): void {
  eventSamples.push({ type, at: now(), ...(mint ? { mint } : {}), ...(detail ? { detail } : {}) });
  if (eventSamples.length > 500) eventSamples.shift();
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? null;
}

function latencySummary(name: string) {
  const values = latencies.filter(x => x.name === name).map(x => x.ms);
  return { samples: values.length, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), maxMs: values.length ? Math.max(...values) : null };
}

export function trackingSnapshot() {
  const all = [...candidates.values()];
  const pos = [...positions.values()];
  const closed = pos.filter(p => p.state === "closed" && p.realizedNetPnlUsd !== null);
  const pnl = closed.reduce((sum, p) => sum + (p.realizedNetPnlUsd ?? 0), 0);
  const reasons = [...rejectionCounts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  const funnel = Object.fromEntries(["discovered", "enriched", "risk_passed", "quoted", "watchlisted", "entered", "exited"].map(stage => [stage, counters.get(`funnel.${stage}`) ?? 0]));
  const open = pos.filter(p => ["buy_pending", "open", "migration_pending", "open_migrated", "sell_pending", "exit_blocked", "exit_unexecutable"].includes(p.state));
  return {
    generatedAt: now(),
    persistence: "in_memory_volatile",
    funnel,
    decisions: {
      pending: all.filter(c => c.decision === "pending").length,
      watch: all.filter(c => c.decision === "watch").length,
      rejected: counters.get("candidate.rejected") ?? 0,
      paperEntries: counters.get("funnel.entered") ?? 0,
      paperExits: counters.get("funnel.exited") ?? 0,
      rejectionReasons: reasons
    },
    quotes: {
      success: counters.get("quote.success") ?? 0,
      missing: counters.get("quote.missing") ?? 0,
      stale: counters.get("quote.stale") ?? 0,
      costRejected: counters.get("quote.cost_rejected") ?? 0,
      sellabilityFailed: counters.get("quote.sellability_failed") ?? 0,
      roundTripCostSamples: costSamples.length,
      averageRoundTripCostPct: costSamples.length ? costSamples.reduce((s, x) => s + x.roundTripCostPct, 0) / costSamples.length : null
    },
    latency: {
      discovery: latencySummary("discovery"),
      enrichment: latencySummary("enrichment"),
      risk: latencySummary("risk"),
      buyQuote: latencySummary("buy_quote"),
      sellQuote: latencySummary("sell_quote"),
      simulatedExecution: latencySummary("simulated_execution")
    },
    provider: {
      connected: counters.get("provider.connected") ?? 0,
      disconnected: counters.get("provider.disconnected") ?? 0,
      reconnects: counters.get("provider.reconnected") ?? 0,
      latestSlotLag: counters.get("provider.slot_lag.latest") ?? null
    },
    graduation: {
      approaching: counters.get("graduation.approaching") ?? 0,
      graduated: counters.get("graduation.graduated") ?? 0,
      curveUnavailable: counters.get("graduation.curve_unavailable") ?? 0
    },
    positions: {
      open: open.length,
      records: pos,
      realizedNetPnlUsd: closed.length ? pnl : null,
      closedWithZeroBalance: closed.filter(p => p.tokenBalanceZeroConfirmed).length,
      invariantViolations: counters.get("invariant.slot_release_without_zero_balance") ?? 0
    },
    candidates: all.slice(-100).reverse(),
    recentEvents: [...eventSamples].reverse()
  };
}
