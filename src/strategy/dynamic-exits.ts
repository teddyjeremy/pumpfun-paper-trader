import { dynamicExitConfig } from "../config.js";

export interface DynamicExitConfig {
  enabled: boolean;
  /** Consecutive windows required for the multi-family confirmation path. */
  confirmationWindows: number;
  /** Distinct evidence families required in each multi-family confirmation window. */
  minBearishSignalsPerWindow: number;
  /** One independent bearish family may trigger after persisting for this many windows. */
  singleFamilyConfirmationWindows: number;
  buySellRatioBelow: number;
  buyVolumeDeclinePct: number;
  buyerRateDeclinePct: number;
  sellVolumeExpansionPct: number;
  priceResponseDeclinePct: number;
  liquidityDropPct: number;
}
export interface ExitWindowObservation {
  endedAtMs: number; windowSeconds: 2 | 5 | 10 | 30; complete: boolean;
  buySellRatio: number | null; buyVolumeDeclinePct: number | null; buyerRateDeclinePct: number | null;
  sellVolumeExpansionPct: number | null; priceResponseDeclinePct: number | null;
  liquidityChangePct: number | null; largeHolderDistributionDetected: boolean | null;
}
export interface ExitEvaluationInput {
  currentNetReturnPct: number; highestCompletedNetReturnPct: number;
  previousActiveStopPct?: number | null; emergencyReason?: string | null;
  freshExecutableSellQuote: boolean; windowsOldestFirst: ExitWindowObservation[];
}
export interface ExitEvaluation {
  action: "hold" | "sell" | "exit_blocked";
  reason: "no_signal" | "hard_stop" | "protective_stop" | "emergency_risk" | "dynamic_exhaustion" | "sell_quote_unavailable";
  triggerReason: string | null; activeStopPct: number; bearishSignalsByWindow: number[]; evidence: string[];
}
type EvidenceFamily = "order_flow_pressure" | "participation_decay" | "liquidity_drain" |
  "weak_price_response" | "large_holder_distribution";
type FamilyEvidence = Partial<Record<EvidenceFamily, string[]>>;

export const PROTECTIVE_EXIT_POLICY = Object.freeze({
  hardStopPct: -5, trailingActivationPct: 10, trailingGivebackPct: 40,
  profitLocks: [{triggerPct:10,floorPct:5},{triggerPct:50,floorPct:15},{triggerPct:100,floorPct:40},{triggerPct:200,floorPct:80}]
});

/** Initial paper-calibration values, not statistically optimized thresholds. */
export const DYNAMIC_EXIT_CALIBRATION_V1: DynamicExitConfig = Object.freeze({
  enabled: true, confirmationWindows: 2, minBearishSignalsPerWindow: 2,
  singleFamilyConfirmationWindows: 3, buySellRatioBelow: 1,
  buyVolumeDeclinePct: 40, buyerRateDeclinePct: 40, sellVolumeExpansionPct: 50,
  priceResponseDeclinePct: 40, liquidityDropPct: 20
});

export function calculateActiveStopPct(highestCompletedNetReturnPct:number, previousActiveStopPct:number|null=null):number {
  const high=Number.isFinite(highestCompletedNetReturnPct)?highestCompletedNetReturnPct:0;
  let lock=Number.NEGATIVE_INFINITY;
  for(const item of PROTECTIVE_EXIT_POLICY.profitLocks) if(high>=item.triggerPct) lock=item.floorPct;
  const trail=high>=10?((1+high/100)*(1-PROTECTIVE_EXIT_POLICY.trailingGivebackPct/100)-1)*100:Number.NEGATIVE_INFINITY;
  return Math.max(PROTECTIVE_EXIT_POLICY.hardStopPct,lock,trail,previousActiveStopPct??Number.NEGATIVE_INFINITY);
}

/**
 * Correlated metrics collapse into one family. A weak buy/sell ratio and
 * expanding sell volume are both order-flow pressure; contracting buy volume
 * and falling buyer rate are both participation decay.
 */
function bearishFamilies(window: ExitWindowObservation, c: DynamicExitConfig): FamilyEvidence {
  if (!window.complete) return {};
  const families: FamilyEvidence = {};
  const add = (family: EvidenceFamily, reason: string) => {
    (families[family] ??= []).push(reason);
  };
  if (window.buySellRatio !== null && Number.isFinite(window.buySellRatio) &&
      window.buySellRatio < c.buySellRatioBelow) {
    add("order_flow_pressure", "buy/sell quote-volume ratio weakened");
  }
  if (window.sellVolumeExpansionPct !== null && Number.isFinite(window.sellVolumeExpansionPct) &&
      window.sellVolumeExpansionPct >= c.sellVolumeExpansionPct) {
    add("order_flow_pressure", "sell quote-volume expanded");
  }
  if (window.buyVolumeDeclinePct !== null && Number.isFinite(window.buyVolumeDeclinePct) &&
      window.buyVolumeDeclinePct >= c.buyVolumeDeclinePct) {
    add("participation_decay", "buy quote-volume contracted");
  }
  if (window.buyerRateDeclinePct !== null && Number.isFinite(window.buyerRateDeclinePct) &&
      window.buyerRateDeclinePct >= c.buyerRateDeclinePct) {
    add("participation_decay", "unique buyer rate declined");
  }
  if (window.liquidityChangePct !== null && Number.isFinite(window.liquidityChangePct) &&
      window.liquidityChangePct <= -c.liquidityDropPct) {
    add("liquidity_drain", "market liquidity deteriorated");
  }
  if (window.priceResponseDeclinePct !== null && Number.isFinite(window.priceResponseDeclinePct) &&
      window.priceResponseDeclinePct >= c.priceResponseDeclinePct) {
    add("weak_price_response", "price response to buying weakened");
  }
  if (window.largeHolderDistributionDetected === true) {
    add("large_holder_distribution", "large-holder distribution detected");
  }
  return families;
}

function consecutiveWindows(
  windows: ExitWindowObservation[], count: number, duration: ExitWindowObservation["windowSeconds"]
): ExitWindowObservation[] | null {
  if (!Number.isSafeInteger(count) || count < 1) return null;
  const recent = windows.filter(w => w.windowSeconds === duration)
    .sort((a, b) => a.endedAtMs - b.endedAtMs).slice(-count);
  if (recent.length !== count || recent.some(w => !w.complete ||
      !Number.isSafeInteger(w.endedAtMs) || w.endedAtMs < 0)) return null;
  for (let i = 1; i < recent.length; i++) {
    const previous = recent[i - 1]!;
    const current = recent[i]!;
    const gap = current.endedAtMs - previous.endedAtMs;
    if (gap <= 0 || gap > duration * 1_500) return null;
  }
  return recent;
}

function exhaustion(windows: ExitWindowObservation[], c: DynamicExitConfig) {
  if (!c.enabled || !Number.isSafeInteger(c.confirmationWindows) ||
      !Number.isSafeInteger(c.singleFamilyConfirmationWindows) ||
      c.confirmationWindows < 1 || c.singleFamilyConfirmationWindows < 2 ||
      !Number.isSafeInteger(c.minBearishSignalsPerWindow) || c.minBearishSignalsPerWindow < 1) {
    return { ok: false, counts: [] as number[], evidence: [] as string[] };
  }

  const durations: ExitWindowObservation["windowSeconds"][] = [2, 5, 10, 30];
  // Path A: at least two independent families in every one of two (or configured)
  // consecutive complete windows.
  for (const duration of durations) {
    const recent = consecutiveWindows(windows, c.confirmationWindows, duration);
    if (!recent) continue;
    const familySets = recent.map(window => bearishFamilies(window, c));
    const counts = familySets.map(families => Object.keys(families).length);
    if (counts.every(count => count >= c.minBearishSignalsPerWindow)) {
      return { ok: true, counts, evidence: [...new Set(familySets.flatMap(f => Object.values(f).flat()))] };
    }
  }

  // Path B: one independent family persisting through three (or configured)
  // consecutive complete windows. Correlated signals still count only once.
  for (const duration of durations) {
    const recent = consecutiveWindows(windows, c.singleFamilyConfirmationWindows, duration);
    if (!recent) continue;
    const familySets = recent.map(window => bearishFamilies(window, c));
    const shared = Object.keys(familySets[0] ?? {}).filter(family =>
      familySets.every(set => Object.hasOwn(set, family))
    ) as EvidenceFamily[];
    if (shared.length > 0) {
      const evidence = shared.flatMap(family =>
        familySets.flatMap(set => set[family] ?? [])
      );
      return { ok: true, counts: familySets.map(set => Object.keys(set).length),
        evidence: [...new Set(evidence)] };
    }
  }
  return { ok: false, counts: [], evidence: [] as string[] };
}

export function evaluateExit(input:ExitEvaluationInput,c:DynamicExitConfig=dynamicExitConfig):ExitEvaluation {
  const stop=calculateActiveStopPct(input.highestCompletedNetReturnPct,input.previousActiveStopPct??null);
  let reason:ExitEvaluation["reason"]="no_signal", evidence:string[]=[], counts:number[]=[];
  if(input.emergencyReason){reason="emergency_risk";evidence=[input.emergencyReason];}
  else if(input.currentNetReturnPct<=-5){reason="hard_stop";evidence=["net return reached the -5% hard stop"];}
  else if(input.currentNetReturnPct<=stop){reason="protective_stop";evidence=["net return crossed the monotonic trailing/profit-lock stop"];}
  else {const d=exhaustion(input.windowsOldestFirst,c);counts=d.counts;if(d.ok){reason="dynamic_exhaustion";evidence=d.evidence;}}
  if(reason==="no_signal")return {action:"hold",reason,triggerReason:null,activeStopPct:stop,bearishSignalsByWindow:counts,evidence:[]};
  if(!input.freshExecutableSellQuote)return {action:"exit_blocked",reason:"sell_quote_unavailable",triggerReason:reason,activeStopPct:stop,bearishSignalsByWindow:counts,evidence:[...evidence,"exit signal exists but no fresh full-position sell quote is verified"]};
  return {action:"sell",reason,triggerReason:reason,activeStopPct:stop,bearishSignalsByWindow:counts,evidence};
}
