export type RuleStatus = "PASS" | "FAIL" | "UNKNOWN";
export interface RuleResult {
  rule: string;
  status: RuleStatus;
  actual: unknown;
  expected: string;
  reason: string;
}
export interface StrictStrategyAuditInput {
  candidateAgeSeconds: number | null;
  profile: {
    impulsePriceChangePct: number | null;
    pullbackPct: number | null;
    reclaimDetected: boolean;
    reclaimAbovePreviousFiveSecondHighPct: number | null;
    pullbackVolumeVsImpulsePct: number | null;
    reclaimVolumeVsPullbackPct: number | null;
    dataComplete: boolean;
    microTradeFilterStatus?: "APPLIED" | "UNAVAILABLE" | "UNSUPPORTED_QUOTE";
  } | null;
  flow: {
    dataComplete: boolean;
    latestThreeWindowFlowPass: boolean;
    sampleIntervalSeconds: number;
    windows: Array<{ startTime: number; buySellRatio: number | null; flowWindowPass: boolean; uniqueBuyers: number; uniqueSellers: number }>;
    distinctBuyersAcrossLatestThree: number;
    largestBuyerShareAcrossLatestThreeBps: number | null;
    microTradeFilterStatus?: "APPLIED" | "UNAVAILABLE" | "UNSUPPORTED_QUOTE";
  } | null;
  creatorRiskStatus: string | null;
  walletClusterRiskStatus: string | null;
  attributionConfidenceBps: number | null;
  signalAgeSeconds: number | null;
  nextObservationConfirmed: boolean | null;
  executableQuoteAvailable: boolean;
  /** Only populated from a reviewed chronological training-set calibration. */
  volumeThresholds?: {
    maxPullbackVolumeVsImpulsePct: number;
    minReclaimVolumeVsPullbackPct: number;
  } | null;
  /** Combined executable buy + exact-size sell cost as a percentage of stake. */
  roundTripCostPct?: number | null;
}
export interface StrictStrategyAudit {
  decision: "REJECT" | "WATCH" | "BUY";
  buyAllowed: boolean;
  evaluatedAt: string;
  rules: RuleResult[];
  rejectionReasons: string[];
  watchReasons: string[];
  blockingUnknownRules: string[];
}

const REQUIRED_STRATEGY_RULES = Object.freeze([
  "CANDIDATE_AGE", "IMPULSE", "PULLBACK", "RECLAIM", "THREE_FLOW_WINDOWS",
  "DISTINCT_BUYERS", "BUYER_CONCENTRATION", "CREATOR_SELL_RISK", "WALLET_CLUSTER_RISK",
  "ATTRIBUTION_CONFIDENCE", "PULLBACK_VOLUME_CONTRACTION", "RECLAIM_VOLUME_EXPANSION",
  "SIGNAL_FRESHNESS", "EXECUTABLE_QUOTE", "ROUND_TRIP_COST"
] as const);

/** True only when every non-quote rule passes and both quote-dependent rules are still UNKNOWN. */
export function canRequestExecutableQuote(audit: Pick<StrictStrategyAudit, "rules">): boolean {
  if (!Array.isArray(audit.rules) || audit.rules.length !== REQUIRED_STRATEGY_RULES.length) return false;
  const statuses = new Map<string, RuleStatus>();
  for (const rule of audit.rules) {
    if (!rule || !REQUIRED_STRATEGY_RULES.includes(rule.rule as typeof REQUIRED_STRATEGY_RULES[number]) ||
        statuses.has(rule.rule)) return false;
    statuses.set(rule.rule, rule.status);
  }
  if (statuses.size !== REQUIRED_STRATEGY_RULES.length) return false;
  return REQUIRED_STRATEGY_RULES.slice(0, -2).every(rule => statuses.get(rule) === "PASS") &&
    statuses.get("EXECUTABLE_QUOTE") === "UNKNOWN" &&
    statuses.get("ROUND_TRIP_COST") === "UNKNOWN";
}
function result(rule: string, status: RuleStatus, actual: unknown, expected: string, reason: string): RuleResult {
  return { rule, status, actual, expected, reason };
}
export function evaluateStrictStrategyAudit(input: StrictStrategyAuditInput, evaluatedAt = new Date().toISOString()): StrictStrategyAudit {
  const rules: RuleResult[] = [];
  rules.push(input.candidateAgeSeconds === null || !Number.isFinite(input.candidateAgeSeconds) || input.candidateAgeSeconds < 0
    ? result("CANDIDATE_AGE", "UNKNOWN", input.candidateAgeSeconds, "verified non-negative launch age; observe candidates for at least 10 minutes", "A valid launch timestamp is unavailable or appears to be in the future.")
    : result("CANDIDATE_AGE", "PASS", input.candidateAgeSeconds,
      "monitor eligible candidates for at least 10 minutes; no 60-second entry cutoff",
      "Candidate age is informational. A valid setup may develop after the first minute."));
  const profile = input.profile;
  rules.push(!profile || !profile.dataComplete || profile.microTradeFilterStatus !== "APPLIED" || profile.impulsePriceChangePct === null
    ? result("IMPULSE", "UNKNOWN", profile?.impulsePriceChangePct ?? null, ">= +20%", "Insufficient verified price history.")
    : result("IMPULSE", profile.impulsePriceChangePct >= 20 ? "PASS" : "FAIL", profile.impulsePriceChangePct, ">= +20%", "Impulse measured from the observed launch baseline."));
  rules.push(!profile || !profile.dataComplete || profile.microTradeFilterStatus !== "APPLIED" || profile.pullbackPct === null
    ? result("PULLBACK", "UNKNOWN", profile?.pullbackPct ?? null, "10% to 40%", "Pullback has not been established.")
    : result("PULLBACK", profile.pullbackPct >= 10 && profile.pullbackPct <= 40 ? "PASS" : "FAIL", profile.pullbackPct, "10% to 40%", "Pullback depth must remain within the agreed range."));
  rules.push(!profile || !profile.dataComplete || profile.microTradeFilterStatus !== "APPLIED" || profile.reclaimAbovePreviousFiveSecondHighPct === null
    ? result("RECLAIM", "UNKNOWN", profile?.reclaimAbovePreviousFiveSecondHighPct ?? null, ">= +1% above previous completed 5-second high", "No verified reclaim measurement is available.")
    : result("RECLAIM", profile.reclaimDetected && profile.reclaimAbovePreviousFiveSecondHighPct >= 1 ? "PASS" : "FAIL",
      profile.reclaimAbovePreviousFiveSecondHighPct, ">= +1%", "Reclaim must exceed the previous completed 5-second high."));
  const windows = input.flow?.windows.slice(-3) ?? [];
  const threeWindowsAvailable = windows.length === 3 &&
    input.flow?.sampleIntervalSeconds === 1 &&
    windows[1]!.startTime === windows[0]!.startTime + 1 &&
    windows[2]!.startTime === windows[1]!.startTime + 1;
  const flowWindowsPass = Boolean(input.flow?.latestThreeWindowFlowPass) && threeWindowsAvailable && windows.every(window =>
    window.flowWindowPass && window.uniqueBuyers >= 3 && window.uniqueSellers <= window.uniqueBuyers / 2
  );
  rules.push(!input.flow || !input.flow.dataComplete || !threeWindowsAvailable || input.flow.microTradeFilterStatus !== "APPLIED"
    ? result("THREE_FLOW_WINDOWS", "UNKNOWN", windows, "3 consecutive completed 2-second windows sampled 1 second apart; each >3:1, >=3 buyers, sellers <= half buyers", "Three fully covered consecutive windows are not available.")
    : result("THREE_FLOW_WINDOWS", flowWindowsPass ? "PASS" : "FAIL", windows, "each window >3:1, >=3 buyers, sellers <= half buyers", "Every one of the three latest completed windows must pass."));
  rules.push(!input.flow || !input.flow.dataComplete || input.flow.microTradeFilterStatus !== "APPLIED"
    ? result("DISTINCT_BUYERS", "UNKNOWN", input.flow?.distinctBuyersAcrossLatestThree ?? null, ">= 5 distinct buyers", "Buyer coverage is incomplete.")
    : result("DISTINCT_BUYERS", input.flow.distinctBuyersAcrossLatestThree >= 5 ? "PASS" : "FAIL", input.flow.distinctBuyersAcrossLatestThree, ">= 5", "At least five distinct buyers are required across the three windows."));
  rules.push(!input.flow || !input.flow.dataComplete || input.flow.microTradeFilterStatus !== "APPLIED" || input.flow.largestBuyerShareAcrossLatestThreeBps === null
    ? result("BUYER_CONCENTRATION", "UNKNOWN", input.flow?.largestBuyerShareAcrossLatestThreeBps ?? null, "<= 72%", "Buyer concentration cannot be established from complete evidence.")
    : result("BUYER_CONCENTRATION", input.flow.largestBuyerShareAcrossLatestThreeBps <= 7_200 ? "PASS" : "FAIL",
      input.flow.largestBuyerShareAcrossLatestThreeBps, "<= 7200 bps", "No single buyer may exceed 72% of buy quote volume."));
  rules.push(input.creatorRiskStatus === "REJECT_OBSERVED"
    ? result("CREATOR_SELL_RISK", "FAIL", input.creatorRiskStatus, "PASS_COMPLETE", "Observed creator-sale threshold breach.")
    : input.creatorRiskStatus === "PASS_COMPLETE"
      ? result("CREATOR_SELL_RISK", "PASS", input.creatorRiskStatus, "PASS_COMPLETE", "Full first-minute creator-sale coverage passed.")
      : result("CREATOR_SELL_RISK", "UNKNOWN", input.creatorRiskStatus, "PASS_COMPLETE", "Creator-sale evidence is not complete."));
  rules.push(input.walletClusterRiskStatus === "REJECT_OBSERVED"
    ? result("WALLET_CLUSTER_RISK", "FAIL", input.walletClusterRiskStatus, "PASS_COMPLETE", "Observed linked-wallet or holder concentration breach.")
    : input.walletClusterRiskStatus === "PASS_COMPLETE"
      ? result("WALLET_CLUSTER_RISK", "PASS", input.walletClusterRiskStatus, "PASS_COMPLETE", "Complete wallet and holder risk evidence passed.")
      : result("WALLET_CLUSTER_RISK", "UNKNOWN", input.walletClusterRiskStatus, "PASS_COMPLETE", "Wallet-cluster evaluator does not clear risk on missing evidence."));
  rules.push(input.attributionConfidenceBps === null || input.attributionConfidenceBps < 7_000
    ? result("ATTRIBUTION_CONFIDENCE", "UNKNOWN", input.attributionConfidenceBps, ">= 7000 bps", "No independently verified wallet link meets the 70% confidence floor.")
    : result("ATTRIBUTION_CONFIDENCE", "PASS", input.attributionConfidenceBps, ">= 7000 bps", "Attribution confidence meets the minimum threshold."));
  const thresholds = input.volumeThresholds ?? null;
  const validVolumeThresholds = thresholds !== null &&
    Number.isFinite(thresholds!.maxPullbackVolumeVsImpulsePct) &&
    thresholds!.maxPullbackVolumeVsImpulsePct >= 0 &&
    Number.isFinite(thresholds!.minReclaimVolumeVsPullbackPct) &&
    thresholds!.minReclaimVolumeVsPullbackPct >= 0;
  rules.push(!profile || !profile.dataComplete || profile.pullbackVolumeVsImpulsePct === null || !validVolumeThresholds
    ? result("PULLBACK_VOLUME_CONTRACTION", "UNKNOWN", profile?.pullbackVolumeVsImpulsePct ?? null,
      "Reviewed max pullback/impulse volume ratio required", "Volume contraction is recorded but cannot be scored without complete data and an explicitly reviewed calibration.")
    : result("PULLBACK_VOLUME_CONTRACTION",
      profile.pullbackVolumeVsImpulsePct <= thresholds!.maxPullbackVolumeVsImpulsePct ? "PASS" : "FAIL",
      profile.pullbackVolumeVsImpulsePct, `<= ${thresholds!.maxPullbackVolumeVsImpulsePct}%`,
      "Pullback volume is compared with the reviewed training-set threshold."));
  rules.push(!profile || !profile.dataComplete || profile.reclaimVolumeVsPullbackPct === null || !validVolumeThresholds
    ? result("RECLAIM_VOLUME_EXPANSION", "UNKNOWN", profile?.reclaimVolumeVsPullbackPct ?? null,
      "Reviewed min reclaim/pullback volume ratio required", "Volume expansion is recorded but cannot be scored without complete data and an explicitly reviewed calibration.")
    : result("RECLAIM_VOLUME_EXPANSION",
      profile.reclaimVolumeVsPullbackPct >= thresholds!.minReclaimVolumeVsPullbackPct ? "PASS" : "FAIL",
      profile.reclaimVolumeVsPullbackPct, `>= ${thresholds!.minReclaimVolumeVsPullbackPct}%`,
      "Reclaim volume is compared with the reviewed training-set threshold."));
  rules.push(input.signalAgeSeconds === null || input.nextObservationConfirmed === null
    ? result("SIGNAL_FRESHNESS", "UNKNOWN", { ageSeconds: input.signalAgeSeconds, nextObservationConfirmed: input.nextObservationConfirmed },
      "1-2 seconds and confirmed by next observation", "Signal freshness confirmation is not yet available.")
    : result("SIGNAL_FRESHNESS", input.signalAgeSeconds >= 1 && input.signalAgeSeconds <= 2 && input.nextObservationConfirmed ? "PASS" : "FAIL",
      { ageSeconds: input.signalAgeSeconds, nextObservationConfirmed: input.nextObservationConfirmed },
      "1-2 seconds and confirmed by next observation", "Reclaim signal must be fresh and confirmed by a subsequent observation."));
  rules.push(result("EXECUTABLE_QUOTE", input.executableQuoteAvailable ? "PASS" : "UNKNOWN",
    input.executableQuoteAvailable, "Fresh size-specific executable quote", "No quote adapter is connected; reserve prices are not executable quotes."));
  const roundTripCostPct = input.roundTripCostPct;
  rules.push(roundTripCostPct === null || roundTripCostPct === undefined ||
      !Number.isFinite(roundTripCostPct) || roundTripCostPct < 0
    ? result("ROUND_TRIP_COST", "UNKNOWN", roundTripCostPct ?? null,
      "Impact <=2% each side, taxes <=2% each side, total <=4%",
      "Combined executable buy/sell cost is unavailable or invalid.")
    : result("ROUND_TRIP_COST", roundTripCostPct <= 4 ? "PASS" : "FAIL",
      roundTripCostPct, "<= 4%", "Combined executable fees must remain within the agreed round-trip cost limit."));
  // A known failure of any mandatory entry rule rejects the candidate.
  // Missing evidence remains UNKNOWN/WATCH and is never silently treated as a pass.
  const rejectionReasons = rules.filter(rule => rule.status === "FAIL").map(rule => rule.rule);
  // Surface every missing-evidence blocker in the WATCH explanation so the
  // operator can distinguish an ineligible setup from an eligible-but-unproven one.
  const unknownRules = rules.filter(rule => rule.status === "UNKNOWN");
  const watchReasons = unknownRules.map(rule => `${rule.rule}: ${rule.reason}`);
  const blockingUnknownRules = unknownRules.map(rule => rule.rule);
  // A BUY is possible only when every mandatory rule is present exactly once
  // and PASS. The Worker still lacks reviewed volume thresholds and complete
  // wallet-cluster clearance; those unknowns keep candidates on WATCH.
  const allRulesPass = rules.length === 15 && rules.every(rule => rule.status === "PASS");
  const buyAllowed = rejectionReasons.length === 0 && unknownRules.length === 0 && allRulesPass;
  return {
    decision: rejectionReasons.length > 0 ? "REJECT" : buyAllowed ? "BUY" : "WATCH",
    buyAllowed, evaluatedAt, rules, rejectionReasons, watchReasons, blockingUnknownRules
  };
}

export function calculateReclaimConfirmation(input: {
  reclaimTimeSeconds: number | null;
  previousCompletedHigh: number | null;
  nowSeconds: number;
  nextObservationPrices: Array<{ timestampSeconds: number; price: number }>;
}): { signalAgeSeconds: number | null; nextObservationConfirmed: boolean | null } {
  if (input.reclaimTimeSeconds === null || input.previousCompletedHigh === null ||
      !Number.isFinite(input.reclaimTimeSeconds) || !Number.isFinite(input.previousCompletedHigh) ||
      input.previousCompletedHigh <= 0 || !Number.isFinite(input.nowSeconds)) {
    return { signalAgeSeconds: null, nextObservationConfirmed: null };
  }
  const signalAgeSeconds = input.nowSeconds - input.reclaimTimeSeconds;
  if (signalAgeSeconds < 0) return { signalAgeSeconds: null, nextObservationConfirmed: null };
  const threshold = input.previousCompletedHigh * 1.01;
  // Confirmation means the immediate next valid observation holds the reclaim.
  // A later recovery must not erase a failed first observation.
  const nextObservation = input.nextObservationPrices
    .filter(observation => Number.isFinite(observation.timestampSeconds) &&
      observation.timestampSeconds > input.reclaimTimeSeconds! &&
      observation.timestampSeconds <= input.nowSeconds)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds)[0];
  const nextObservationConfirmed = nextObservation !== undefined &&
    Number.isFinite(nextObservation.price) && nextObservation.price > 0 &&
    nextObservation.price >= threshold;
  return { signalAgeSeconds, nextObservationConfirmed };
}
