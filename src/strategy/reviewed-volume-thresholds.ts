export interface ReviewedVolumeThresholds {
  maxPullbackVolumeVsImpulsePct: number;
  minReclaimVolumeVsPullbackPct: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Accepts only a recently reviewed calibration candidate from the historical
 * replay endpoint. A statistically eligible candidate is not promoted by
 * itself: the operator must provide an explicit approval, reviewer, review
 * timestamp and source session. Missing or malformed configuration stays
 * fail-closed and leaves both volume rules UNKNOWN.
 */
export function parseReviewedVolumeThresholds(
  raw: string | undefined,
  nowMs = Date.now()
): ReviewedVolumeThresholds | null {
  if (typeof raw !== "string" || !raw.trim() || !Number.isFinite(nowMs)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const root = record(parsed);
  if (!root || root.version !== 1 || root.approved !== true ||
      typeof root.reviewer !== "string" || !root.reviewer.trim() || root.reviewer.length > 128 ||
      typeof root.sourceSessionId !== "string" || !root.sourceSessionId.trim() || root.sourceSessionId.length > 128 ||
      typeof root.reviewedAt !== "string") {
    return null;
  }

  const reviewedAt = Date.parse(root.reviewedAt);
  const reviewAgeMs = nowMs - reviewedAt;
  if (!Number.isFinite(reviewedAt) || reviewAgeMs < 0 || reviewAgeMs > 30 * 24 * 60 * 60 * 1_000) {
    return null;
  }

  const calibration = record(root.calibration);
  const recommended = record(calibration?.recommended);
  const training = record(recommended?.training);
  const holdout = record(recommended?.holdout);
  if (!calibration || calibration.status !== "CALIBRATION_CANDIDATE" || !recommended ||
      !training || !holdout ||
      !finiteNumber(calibration.labeledCoins) || calibration.labeledCoins < 40 ||
      !finiteNumber(calibration.trainingCoins) || calibration.trainingCoins < 30 ||
      !finiteNumber(calibration.holdoutCoins) || calibration.holdoutCoins < 10 ||
      !finiteNumber(calibration.positiveCoins) || calibration.positiveCoins < 7 ||
      !finiteNumber(calibration.negativeCoins) || calibration.negativeCoins < 7 ||
      !finiteNumber(recommended.maxPullbackVolumeVsImpulsePct) ||
      recommended.maxPullbackVolumeVsImpulsePct < 0 || recommended.maxPullbackVolumeVsImpulsePct > 10_000 ||
      !finiteNumber(recommended.minReclaimVolumeVsPullbackPct) ||
      recommended.minReclaimVolumeVsPullbackPct < 0 || recommended.minReclaimVolumeVsPullbackPct > 10_000 ||
      !finiteNumber(training.samples) || training.samples < 30 ||
      !finiteNumber(training.accepted) || training.accepted < 5 ||
      !finiteNumber(holdout.samples) || holdout.samples < 10 ||
      !finiteNumber(holdout.accepted) || holdout.accepted < 2 ||
      !finiteNumber(holdout.precision) || holdout.precision < 0.5 ||
      !finiteNumber(holdout.f1) || holdout.f1 < 0.5 ||
      !finiteNumber(holdout.expectancyNetPct) || holdout.expectancyNetPct <= 0) {
    return null;
  }

  const holdoutProfitFactor = holdout.profitFactor;
  const holdoutWinRate = holdout.winRate;
  if (holdoutProfitFactor === null) {
    if (holdoutWinRate !== 1) return null;
  } else if (!finiteNumber(holdoutProfitFactor) || holdoutProfitFactor <= 1) {
    return null;
  }

  return {
    maxPullbackVolumeVsImpulsePct: recommended.maxPullbackVolumeVsImpulsePct,
    minReclaimVolumeVsPullbackPct: recommended.minReclaimVolumeVsPullbackPct
  };
}
