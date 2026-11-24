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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function evaluateStrictStrategyAudit(input: StrictStrategyAuditInput, evaluatedAt = new Date().toISOString()): StrictStrategyAudit {
  const rules: RuleResult[] = [];
  rules.push(input.candidateAgeSeconds === null || !Number.isFinite(input.candidateAgeSeconds) || input.candidateAgeSeconds < 0
    ? result("CANDIDATE_AGE", "UNKNOWN", input.candidateAgeSeconds, "verified non-negative launch age; observe candidates for at least 10 minutes", "A valid launch timestamp is unavailable or appears to be in the future.")
    : result("CANDIDATE_AGE", "PASS", input.candidateAgeSeconds,
      "monitor eligible candidates for at least 10 minutes; no 60-second entry cutoff",
      "Candidate age is informational. A valid setup may develop after the first minute."));
  const profile = input.profile;
  rules.push(!profile || profile.dataComplete !== true || profile.microTradeFilterStatus !== "APPLIED" || !isFiniteNumber(profile.impulsePriceChangePct)
    ? result("IMPULSE", "UNKNOWN", profile?.impulsePriceChangePct ?? null, ">= +20%", "Insufficient or invalid verified price history.")
    : result("IMPULSE", profile.impulsePriceChangePct >= 20 ? "PASS" : "FAIL", profile.impulsePriceChangePct, ">= +20%", "Impulse measured from the observed launch baseline."));
  rules.push(!profile || profile.dataComplete !== true || profile.microTradeFilterStatus !== "APPLIED" || !isFiniteNumber(profile.pullbackPct)
    ? result("PULLBACK", "UNKNOWN", profile?.pullbackPct ?? null, "10% to 40%", "Pullback has not been established from finite verified measurements.")
    : result("PULLBACK", profile.pullbackPct >= 10 && profile.pullbackPct <= 40 ? "PASS" : "FAIL", profile.pullbackPct, "10% to 40%", "Pullback depth must remain within the agreed range."));
  rules.push(!profile || profile.dataComplete !== true || profile.microTradeFilterStatus !== "APPLIED" ||
      !isFiniteNumber(profile.reclaimAbovePreviousFiveSecondHighPct) || typeof profile.reclaimDetected !== "boolean"
    ? result("RECLAIM", "UNKNOWN", profile?.reclaimAbovePreviousFiveSecondHighPct ?? null, ">= +1% above previous completed 5-second high", "No valid reclaim measurement and boolean confirmation are available.")
    : result("RECLAIM", profile.reclaimDetected === true && profile.reclaimAbovePreviousFiveSecondHighPct >= 1 ? "PASS" : "FAIL",
      profile.reclaimAbovePreviousFiveSecondHighPct, ">= +1%", "Reclaim must exceed the previous completed 5-second high."));
  const windows = Array.isArray(input.flow?.windows) ? input.flow.windows.slice(-3) : [];
  const validWindowEvidence = windows.length === 3 && windows.every(window =>
    window !== null && typeof window === "object" &&
    isFiniteNumber(window.startTime) &&
    isSafeNonNegativeInteger(window.uniqueBuyers) &&
    isSafeNonNegativeInteger(window.uniqueSellers) &&
    typeof window.flowWindowPass === "boolean"
  );
  const threeWindowsAvailable = validWindowEvidence &&
    input.flow?.sampleIntervalSeconds === 1 &&
    windows[1]!.startTime === windows[0]!.startTime + 1 &&
    windows[2]!.startTime === windows[1]!.startTime + 1;
  const flowWindowsPass = input.flow?.latestThreeWindowFlowPass === true && threeWindowsAvailable && windows.every(window =>
    window.flowWindowPass === true && window.uniqueBuyers >= 3 && window.uniqueSellers <= window.uniqueBuyers / 2
  );
  rules.push(!input.flow || input.flow.dataComplete !== true || !threeWindowsAvailable ||
      typeof input.flow.latestThreeWindowFlowPass !== "boolean" || input.flow.microTradeFilterStatus !== "APPLIED"
    ? result("THREE_FLOW_WINDOWS", "UNKNOWN", windows, "3 consecutive completed 2-second windows sampled 1 second apart; each >3:1, >=3 buyers, sellers <= half buyers", "Three fully covered windows with valid boolean and count evidence are not available.")
    : result("THREE_FLOW_WINDOWS", flowWindowsPass ? "PASS" : "FAIL", windows, "each window >3:1, >=3 buyers, sellers <= half buyers", "Every one of the three latest completed windows must pass."));
  rules.push(!input.flow || input.flow.dataComplete !== true || input.flow.microTradeFilterStatus !== "APPLIED" ||
      !isSafeNonNegativeInteger(input.flow.distinctBuyersAcrossLatestThree)
    ? result("DISTINCT_BUYERS", "UNKNOWN", input.flow?.distinctBuyersAcrossLatestThree ?? null, ">= 5 distinct buyers", "Buyer coverage is incomplete or its count is invalid.")
    : result("DISTINCT_BUYERS", input.flow.distinctBuyersAcrossLatestThree >= 5 ? "PASS" : "FAIL", input.flow.distinctBuyersAcrossLatestThree, ">= 5", "At least five distinct buyers are required across the three windows."));
  const largestBuyerShareBps = input.flow?.largestBuyerShareAcrossLatestThreeBps;
  const validLargestBuyerShare = isSafeNonNegativeInteger(largestBuyerShareBps) && largestBuyerShareBps <= 10_000;
  rules.push(!input.flow || input.flow.dataComplete !== true || input.flow.microTradeFilterStatus !== "APPLIED" || !validLargestBuyerShare
    ? result("BUYER_CONCENTRATION", "UNKNOWN", largestBuyerShareBps ?? null, "integer 0-7200 bps", "Buyer concentration cannot be established from a valid complete measurement.")
    : result("BUYER_CONCENTRATION", largestBuyerShareBps <= 7_200 ? "PASS" : "FAIL",
      largestBuyerShareBps, "<= 7200 bps", "No single buyer may exceed 72% of buy quote volume."));
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
  const attributionConfidenceBps = input.attributionConfidenceBps;
  const validAttributionConfidence = attributionConfidenceBps !== null &&
    Number.isSafeInteger(attributionConfidenceBps) &&
    attributionConfidenceBps >= 7_000 && attributionConfidenceBps <= 10_000;
  rules.push(!validAttributionConfidence
    ? result("ATTRIBUTION_CONFIDENCE", "UNKNOWN", attributionConfidenceBps,
      "integer 7000-10000 bps", "Attribution confidence is missing or outside the valid basis-point range.")
    : result("ATTRIBUTION_CONFIDENCE", "PASS", attributionConfidenceBps,
      "integer 7000-10000 bps", "Attribution confidence meets the minimum threshold and valid basis-point range."));
  const thresholds = input.volumeThresholds ?? null;
  const validVolumeThresholds = thresholds !== null &&
    Number.isFinite(thresholds!.maxPullbackVolumeVsImpulsePct) &&
    thresholds!.maxPullbackVolumeVsImpulsePct >= 0 &&
    Number.isFinite(thresholds!.minReclaimVolumeVsPullbackPct) &&
    thresholds!.minReclaimVolumeVsPullbackPct >= 0;
  rules.push(!profile || profile.dataComplete !== true || !isFiniteNumber(profile.pullbackVolumeVsImpulsePct) ||
      profile.pullbackVolumeVsImpulsePct < 0 || !validVolumeThresholds
    ? result("PULLBACK_VOLUME_CONTRACTION", "UNKNOWN", profile?.pullbackVolumeVsImpulsePct ?? null,
      "Reviewed max pullback/impulse volume ratio required", "Volume contraction is recorded but cannot be scored without complete finite data and an explicitly reviewed calibration.")
    : result("PULLBACK_VOLUME_CONTRACTION",
      profile.pullbackVolumeVsImpulsePct <= thresholds!.maxPullbackVolumeVsImpulsePct ? "PASS" : "FAIL",
      profile.pullbackVolumeVsImpulsePct, `<= ${thresholds!.maxPullbackVolumeVsImpulsePct}%`,
      "Pullback volume is compared with the reviewed training-set threshold."));
  rules.push(!profile || profile.dataComplete !== true || !isFiniteNumber(profile.reclaimVolumeVsPullbackPct) ||
      profile.reclaimVolumeVsPullbackPct < 0 || !validVolumeThresholds
    ? result("RECLAIM_VOLUME_EXPANSION", "UNKNOWN", profile?.reclaimVolumeVsPullbackPct ?? null,
      "Reviewed min reclaim/pullback volume ratio required", "Volume expansion is recorded but cannot be scored without complete finite data and an explicitly reviewed calibration.")
    : result("RECLAIM_VOLUME_EXPANSION",
      profile.reclaimVolumeVsPullbackPct >= thresholds!.minReclaimVolumeVsPullbackPct ? "PASS" : "FAIL",
      profile.reclaimVolumeVsPullbackPct, `>= ${thresholds!.minReclaimVolumeVsPullbackPct}%`,
      "Reclaim volume is compared with the reviewed training-set threshold."));
  rules.push(!isFiniteNumber(input.signalAgeSeconds) || typeof input.nextObservationConfirmed !== "boolean"
    ? result("SIGNAL_FRESHNESS", "UNKNOWN", { ageSeconds: input.signalAgeSeconds, nextObservationConfirmed: input.nextObservationConfirmed },
      "1-2 seconds and confirmed by next observation", "Signal freshness requires a finite age and an explicit boolean next-observation result.")
    : result("SIGNAL_FRESHNESS", input.signalAgeSeconds >= 1 && input.signalAgeSeconds <= 2 && input.nextObservationConfirmed === true ? "PASS" : "FAIL",
      { ageSeconds: input.signalAgeSeconds, nextObservationConfirmed: input.nextObservationConfirmed },
      "1-2 seconds and confirmed by next observation", "Reclaim signal must be fresh and confirmed by a subsequent observation."));
  rules.push(result("EXECUTABLE_QUOTE", input.executableQuoteAvailable === true ? "PASS" : "UNKNOWN",
    input.executableQuoteAvailable, "Fresh size-specific executable quote", "No verified size-specific executable quote is available."));
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
