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

function timestampWithZone(value: unknown): number {
  if (typeof value !== "string" || !/(?:Z|[+-][0-9]{2}:[0-9]{2})$/i.test(value)) {
    return Number.NaN;
  }
  return Date.parse(value);
}

function hasChronologicalWindows(
  calibration: Record<string, unknown> | null,
  reviewedAt: number
): boolean {
  if (!calibration || calibration.splitMethod !== "CHRONOLOGICAL") return false;
  const trainingWindow = record(calibration.trainingWindow);
  const holdoutWindow = record(calibration.holdoutWindow);
  if (!trainingWindow || !holdoutWindow) return false;
  const trainingStart = timestampWithZone(trainingWindow.startAt);
  const trainingEnd = timestampWithZone(trainingWindow.endAt);
  const holdoutStart = timestampWithZone(holdoutWindow.startAt);
  const holdoutEnd = timestampWithZone(holdoutWindow.endAt);
  // Windows are half-open [startAt, endAt): training must finish before
  // holdout begins, and the reviewer must approve only after holdout ends.
  return Number.isFinite(trainingStart) && Number.isFinite(trainingEnd) &&
    Number.isFinite(holdoutStart) && Number.isFinite(holdoutEnd) &&
    trainingStart < trainingEnd && trainingEnd <= holdoutStart &&
    holdoutStart < holdoutEnd && reviewedAt >= holdoutEnd;
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

  const reviewedAt = timestampWithZone(root.reviewedAt);
  const reviewAgeMs = nowMs - reviewedAt;
  if (!Number.isFinite(reviewedAt) || reviewAgeMs < 0 || reviewAgeMs > 30 * 24 * 60 * 60 * 1_000) {
    return null;
  }

  const calibration = record(root.calibration);
  const recommended = record(calibration?.recommended);
  const training = record(recommended?.training);
  const holdout = record(recommended?.holdout);
  if (!calibration || calibration.status !== "CALIBRATION_CANDIDATE" || !recommended ||
      !training || !holdout || !hasChronologicalWindows(calibration, reviewedAt) ||
      !finiteNumber(calibration.labeledCoins) || !Number.isSafeInteger(calibration.labeledCoins) || calibration.labeledCoins < 40 ||
      !finiteNumber(calibration.trainingCoins) || !Number.isSafeInteger(calibration.trainingCoins) || calibration.trainingCoins < 30 ||
      !finiteNumber(calibration.holdoutCoins) || !Number.isSafeInteger(calibration.holdoutCoins) || calibration.holdoutCoins < 10 ||
      !finiteNumber(calibration.positiveCoins) || !Number.isSafeInteger(calibration.positiveCoins) || calibration.positiveCoins < 7 ||
      !finiteNumber(calibration.negativeCoins) || !Number.isSafeInteger(calibration.negativeCoins) || calibration.negativeCoins < 7 ||
      calibration.trainingCoins + calibration.holdoutCoins !== calibration.labeledCoins ||
      calibration.positiveCoins + calibration.negativeCoins !== calibration.labeledCoins ||
      !finiteNumber(recommended.maxPullbackVolumeVsImpulsePct) ||
      recommended.maxPullbackVolumeVsImpulsePct < 0 || recommended.maxPullbackVolumeVsImpulsePct > 10_000 ||
      !finiteNumber(recommended.minReclaimVolumeVsPullbackPct) ||
      recommended.minReclaimVolumeVsPullbackPct < 0 || recommended.minReclaimVolumeVsPullbackPct > 10_000 ||
      !finiteNumber(training.samples) || !Number.isSafeInteger(training.samples) || training.samples < 30 ||
      !finiteNumber(training.accepted) || training.accepted < 5 ||
      !finiteNumber(training.precision) || training.precision < 0 || training.precision > 1 ||
      !finiteNumber(training.recall) || training.recall < 0 || training.recall > 1 ||
      !finiteNumber(training.f1) || training.f1 < 0 || training.f1 > 1 ||
      !finiteNumber(holdout.samples) || !Number.isSafeInteger(holdout.samples) || holdout.samples < 10 ||
      !finiteNumber(holdout.accepted) || holdout.accepted < 2 ||
      !finiteNumber(holdout.precision) || holdout.precision < 0.5 || holdout.precision > 1 ||
      !finiteNumber(holdout.recall) || holdout.recall < 0 || holdout.recall > 1 ||
      !finiteNumber(holdout.f1) || holdout.f1 < 0.5 || holdout.f1 > 1 ||
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
