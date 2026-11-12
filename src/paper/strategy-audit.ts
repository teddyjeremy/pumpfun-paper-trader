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
  } | null;
  flow: {
    dataComplete: boolean;
    latestThreeWindowFlowPass: boolean;
    windows: Array<{ buySellRatio: number | null; flowWindowPass: boolean; uniqueBuyers: number; uniqueSellers: number }>;
    distinctBuyersAcrossLatestThree: number;
    largestBuyerShareAcrossLatestThreeBps: number | null;
  } | null;
  creatorRiskStatus: string | null;
  walletClusterRiskStatus: string | null;
  attributionConfidenceBps: number | null;
  signalAgeSeconds: number | null;
  nextObservationConfirmed: boolean | null;
  executableQuoteAvailable: boolean;
}
export interface StrictStrategyAudit {
  decision: "REJECT" | "WATCH";
  buyAllowed: false;
  evaluatedAt: string;
  rules: RuleResult[];
  rejectionReasons: string[];
  watchReasons: string[];
  blockingUnknownRules: string[];
}
function result(rule: string, status: RuleStatus, actual: unknown, expected: string, reason: string): RuleResult {
  return { rule, status, actual, expected, reason };
}
export function evaluateStrictStrategyAudit(input: StrictStrategyAuditInput, evaluatedAt = new Date().toISOString()): StrictStrategyAudit {
  const rules: RuleResult[] = [];
  rules.push(input.candidateAgeSeconds === null
    ? result("ENTRY_WINDOW", "UNKNOWN", null, "candidate age <= 60 seconds", "Discovery timestamp is unavailable.")
    : result("ENTRY_WINDOW", input.candidateAgeSeconds <= 60 ? "PASS" : "FAIL", input.candidateAgeSeconds, "<= 60 seconds", "Entry window is limited to the first 60 seconds."));
  const profile = input.profile;
  rules.push(!profile || !profile.dataComplete || profile.impulsePriceChangePct === null
    ? result("IMPULSE", "UNKNOWN", profile?.impulsePriceChangePct ?? null, ">= +20%", "Insufficient verified price history.")
    : result("IMPULSE", profile.impulsePriceChangePct >= 20 ? "PASS" : "FAIL", profile.impulsePriceChangePct, ">= +20%", "Impulse measured from the observed launch baseline."));
  rules.push(!profile || !profile.dataComplete || profile.pullbackPct === null
    ? result("PULLBACK", "UNKNOWN", profile?.pullbackPct ?? null, "10% to 40%", "Pullback has not been established.")
    : result("PULLBACK", profile.pullbackPct >= 10 && profile.pullbackPct <= 40 ? "PASS" : "FAIL", profile.pullbackPct, "10% to 40%", "Pullback depth must remain within the agreed range."));
  rules.push(!profile || !profile.dataComplete || profile.reclaimAbovePreviousFiveSecondHighPct === null
    ? result("RECLAIM", "UNKNOWN", profile?.reclaimAbovePreviousFiveSecondHighPct ?? null, ">= +1% above previous completed 5-second high", "No verified reclaim measurement is available.")
    : result("RECLAIM", profile.reclaimDetected && profile.reclaimAbovePreviousFiveSecondHighPct >= 1 ? "PASS" : "FAIL",
      profile.reclaimAbovePreviousFiveSecondHighPct, ">= +1%", "Reclaim must exceed the previous completed 5-second high."));
  const windows = input.flow?.windows.slice(-3) ?? [];
  const threeWindowsAvailable = windows.length === 3;
  const flowWindowsPass = Boolean(input.flow?.latestThreeWindowFlowPass) && threeWindowsAvailable && windows.every(window =>
    window.flowWindowPass && window.uniqueBuyers >= 3 && window.uniqueSellers <= window.uniqueBuyers / 2
  );
  rules.push(!input.flow || !input.flow.dataComplete || !threeWindowsAvailable
    ? result("THREE_FLOW_WINDOWS", "UNKNOWN", windows, "3 consecutive completed 2-second windows; each >3:1, >=3 buyers, sellers <= half buyers", "Three fully covered consecutive windows are not available.")
    : result("THREE_FLOW_WINDOWS", flowWindowsPass ? "PASS" : "FAIL", windows, "each window >3:1, >=3 buyers, sellers <= half buyers", "Every one of the three latest completed windows must pass."));
  rules.push(!input.flow || !input.flow.dataComplete
    ? result("DISTINCT_BUYERS", "UNKNOWN", input.flow?.distinctBuyersAcrossLatestThree ?? null, ">= 5 distinct buyers", "Buyer coverage is incomplete.")
    : result("DISTINCT_BUYERS", input.flow.distinctBuyersAcrossLatestThree >= 5 ? "PASS" : "FAIL", input.flow.distinctBuyersAcrossLatestThree, ">= 5", "At least five distinct buyers are required across the three windows."));
  rules.push(!input.flow || !input.flow.dataComplete || input.flow.largestBuyerShareAcrossLatestThreeBps === null
    ? result("BUYER_CONCENTRATION", "UNKNOWN", input.flow?.largestBuyerShareAcrossLatestThreeBps ?? null, "<= 72%", "Buyer concentration cannot be established from complete evidence.")
    : result("BUYER_CONCENTRATION", input.flow.largestBuyerShareAcrossLatestThreeBps <= 7_200 ? "PASS" : "FAIL",
      input.flow.largestBuyerShareAcrossLatestThreeBps, "<= 7200 bps", "No single buyer may exceed 72% of buy quote volume."));
  rules.push(input.creatorRiskStatus === "REJECT_OBSERVED"
    ? result("CREATOR_SELL_RISK", "FAIL", input.creatorRiskStatus, "PASS_COMPLETE", "Observed creator-sale threshold breach.")
    : input.creatorRiskStatus === "PASS_COMPLETE"
      ? result("CREATOR_SELL_RISK", "PASS", input.creatorRiskStatus, "PASS_COMPLETE", "Full first-minute creator-sale coverage passed.")
      : result("CREATOR_SELL_RISK", "UNKNOWN", input.creatorRiskStatus, "PASS_COMPLETE", "Creator-sale evidence is not complete."));
  rules.push(input.walletClusterRiskStatus === "REJECT_OBSERVED"
    ? result("WALLET_CLUSTER_RISK", "FAIL", input.walletClusterRiskStatus, "No observed breach with sufficient attribution", "Observed linked-wallet or holder concentration breach.")
    : result("WALLET_CLUSTER_RISK", "UNKNOWN", input.walletClusterRiskStatus, "Risk evidence must be sufficiently complete", "Wallet-cluster evaluator does not clear risk on missing evidence."));
  rules.push(input.attributionConfidenceBps === null || input.attributionConfidenceBps < 7_000
    ? result("ATTRIBUTION_CONFIDENCE", "UNKNOWN", input.attributionConfidenceBps, ">= 7000 bps", "No independently verified wallet link meets the 70% confidence floor.")
    : result("ATTRIBUTION_CONFIDENCE", "PASS", input.attributionConfidenceBps, ">= 7000 bps", "Attribution confidence meets the minimum threshold."));
  rules.push(result("PULLBACK_VOLUME_CONTRACTION", "UNKNOWN", profile?.pullbackVolumeVsImpulsePct ?? null,
    "Numeric threshold not yet agreed", "Volume contraction is recorded but not scored until its threshold is agreed."));
  rules.push(result("RECLAIM_VOLUME_EXPANSION", "UNKNOWN", profile?.reclaimVolumeVsPullbackPct ?? null,
    "Numeric threshold not yet agreed", "Volume expansion is recorded but not scored until its threshold is agreed."));
  rules.push(input.signalAgeSeconds === null || input.nextObservationConfirmed === null
    ? result("SIGNAL_FRESHNESS", "UNKNOWN", { ageSeconds: input.signalAgeSeconds, nextObservationConfirmed: input.nextObservationConfirmed },
      "1-2 seconds and confirmed by next observation", "Signal freshness confirmation is not yet available.")
    : result("SIGNAL_FRESHNESS", input.signalAgeSeconds >= 1 && input.signalAgeSeconds <= 2 && input.nextObservationConfirmed ? "PASS" : "FAIL",
      { ageSeconds: input.signalAgeSeconds, nextObservationConfirmed: input.nextObservationConfirmed },
      "1-2 seconds and confirmed by next observation", "Reclaim signal must be fresh and confirmed by a subsequent observation."));
  rules.push(result("EXECUTABLE_QUOTE", input.executableQuoteAvailable ? "PASS" : "UNKNOWN",
    input.executableQuoteAvailable, "Fresh size-specific executable quote", "No quote adapter is connected; reserve prices are not executable quotes."));
  rules.push(result("ROUND_TRIP_COST", "UNKNOWN", null, "Impact <=2% each side, taxes <=2% each side, total <=4%", "Fees, impact and taxes cannot be verified without executable quotes."));
  const rejectionReasons = rules.filter(rule => rule.status === "FAIL" &&
    ["ENTRY_WINDOW", "CREATOR_SELL_RISK", "WALLET_CLUSTER_RISK"].includes(rule.rule))
    .map(rule => rule.rule);
  const watchReasons = rules.filter(rule => rule.status === "FAIL" &&
    !["ENTRY_WINDOW", "CREATOR_SELL_RISK", "WALLET_CLUSTER_RISK"].includes(rule.rule))
    .map(rule => rule.rule);
  const blockingUnknownRules = rules.filter(rule => rule.status === "UNKNOWN").map(rule => rule.rule);
  return {
    decision: rejectionReasons.length > 0 ? "REJECT" : "WATCH",
    buyAllowed: false, evaluatedAt, rules, rejectionReasons, watchReasons, blockingUnknownRules
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
  const nextObservationConfirmed = input.nextObservationPrices.some(observation =>
    Number.isFinite(observation.timestampSeconds) && observation.timestampSeconds > input.reclaimTimeSeconds! &&
    observation.timestampSeconds <= input.nowSeconds && Number.isFinite(observation.price) &&
    observation.price >= threshold
  );
  return { signalAgeSeconds, nextObservationConfirmed };
}
