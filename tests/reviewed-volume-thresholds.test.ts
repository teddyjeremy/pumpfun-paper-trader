import { describe, expect, it } from "vitest";
import { parseReviewedVolumeThresholds } from "../src/strategy/reviewed-volume-thresholds.js";

const now = Date.parse("2026-11-13T12:00:00.000Z");

function payload(): string {
  return JSON.stringify({
    version: 1,
    approved: true,
    reviewer: "operator",
    reviewedAt: "2026-11-13T11:00:00.000Z",
    sourceSessionId: "historical-session-001",
    calibration: {
      status: "CALIBRATION_CANDIDATE",
      labeledCoins: 50,
      trainingCoins: 35,
      holdoutCoins: 15,
      positiveCoins: 12,
      negativeCoins: 38,
      recommended: {
        maxPullbackVolumeVsImpulsePct: 35,
        minReclaimVolumeVsPullbackPct: 125,
        training: {
          samples: 35, precision: 0.7, recall: 0.65, f1: 0.67, accepted: 12,
          winRate: 0.7, expectancyNetPct: 4, profitFactor: 1.8, maxDrawdownPct: 12
        },
        holdout: {
          samples: 15, precision: 0.6, recall: 0.55, f1: 0.57, accepted: 5,
          winRate: 0.6, expectancyNetPct: 2, profitFactor: 1.3, maxDrawdownPct: 18
        }
      }
    }
  });
}

describe("reviewed volume threshold promotion", () => {
  it("returns no thresholds when the worker setting is missing or malformed", () => {
    expect(parseReviewedVolumeThresholds(undefined, now)).toBeNull();
    expect(parseReviewedVolumeThresholds("not-json", now)).toBeNull();
  });

  it("accepts only an explicitly approved, recent, sufficiently sampled holdout candidate", () => {
    expect(parseReviewedVolumeThresholds(payload(), now)).toEqual({
      maxPullbackVolumeVsImpulsePct: 35,
      minReclaimVolumeVsPullbackPct: 125
    });
  });

  it("rejects candidates that have not passed chronological holdout validation", () => {
    const value = JSON.parse(payload()) as Record<string, any>;
    value.calibration.status = "NO_GENERALIZATION";
    expect(parseReviewedVolumeThresholds(JSON.stringify(value), now)).toBeNull();

    value.calibration.status = "CALIBRATION_CANDIDATE";
    value.calibration.recommended.holdout.precision = 0.49;
    expect(parseReviewedVolumeThresholds(JSON.stringify(value), now)).toBeNull();
  });

  it("rejects insufficient samples and non-profitable holdout results", () => {
    const value = JSON.parse(payload()) as Record<string, any>;
    value.calibration.trainingCoins = 29;
    expect(parseReviewedVolumeThresholds(JSON.stringify(value), now)).toBeNull();

    value.calibration.trainingCoins = 35;
    value.calibration.recommended.holdout.expectancyNetPct = 0;
    expect(parseReviewedVolumeThresholds(JSON.stringify(value), now)).toBeNull();
  });

  it("rejects missing approval metadata, future reviews and reviews older than 30 days", () => {
    const unapproved = JSON.parse(payload()) as Record<string, any>;
    unapproved.approved = false;
    expect(parseReviewedVolumeThresholds(JSON.stringify(unapproved), now)).toBeNull();

    const future = JSON.parse(payload()) as Record<string, any>;
    future.reviewedAt = "2026-11-14T00:00:00.000Z";
    expect(parseReviewedVolumeThresholds(JSON.stringify(future), now)).toBeNull();

    const stale = JSON.parse(payload()) as Record<string, any>;
    stale.reviewedAt = "2026-10-01T00:00:00.000Z";
    expect(parseReviewedVolumeThresholds(JSON.stringify(stale), now)).toBeNull();
  });
});
