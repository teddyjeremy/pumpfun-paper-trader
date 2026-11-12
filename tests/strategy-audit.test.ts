import { describe, expect, it } from "vitest";
import { calculateReclaimConfirmation, evaluateStrictStrategyAudit, type StrictStrategyAuditInput } from "../src/paper/strategy-audit.js";

const base: StrictStrategyAuditInput = {
  candidateAgeSeconds: 61,
  profile: null,
  flow: null,
  creatorRiskStatus: null,
  walletClusterRiskStatus: null,
  attributionConfidenceBps: null,
  signalAgeSeconds: null,
  nextObservationConfirmed: null,
  executableQuoteAvailable: false
};

describe("strict strategy audit timing", () => {
  it("allows entry only during the first 60 seconds after verified launch", () => {
    for (const age of [0, 1, 30, 59, 60]) {
      const audit = evaluateStrictStrategyAudit({ ...base, candidateAgeSeconds: age });
      expect(audit.rules.find(rule => rule.rule === "CANDIDATE_AGE")?.status).toBe("PASS");
      expect(audit.rejectionReasons).not.toContain("CANDIDATE_AGE");
    }
    for (const age of [60.001, 61, 180, 600, 899]) {
      const audit = evaluateStrictStrategyAudit({ ...base, candidateAgeSeconds: age });
      expect(audit.rules.find(rule => rule.rule === "CANDIDATE_AGE")?.status).toBe("FAIL");
      expect(audit.rejectionReasons).toContain("CANDIDATE_AGE");
      expect(audit.buyAllowed).toBe(false);
    }
  });


  it("keeps pullback and reclaim volume thresholds unscored until calibrated", () => {
    const audit = evaluateStrictStrategyAudit({
      ...base,
      candidateAgeSeconds: 30,
      profile: {
        impulsePriceChangePct: 25,
        pullbackPct: 16,
        reclaimDetected: true,
        reclaimAbovePreviousFiveSecondHighPct: 1.2,
        pullbackVolumeVsImpulsePct: 95.56,
        reclaimVolumeVsPullbackPct: 55.81,
        dataComplete: true,
        microTradeFilterStatus: "APPLIED"
      },
      flow: {
        dataComplete: true,
        latestThreeWindowFlowPass: true,
        windows: [0, 1, 2].map(start => ({
          buySellRatio: 4, flowWindowPass: true, uniqueBuyers: 3, uniqueSellers: 1
        })),
        distinctBuyersAcrossLatestThree: 5,
        largestBuyerShareAcrossLatestThreeBps: 5_000,
        microTradeFilterStatus: "APPLIED"
      },
      creatorRiskStatus: "PASS_COMPLETE",
      walletClusterRiskStatus: "WATCH",
      attributionConfidenceBps: 8_000,
      signalAgeSeconds: 1,
      nextObservationConfirmed: true
    });
    expect(audit.rules.find(rule => rule.rule === "PULLBACK_VOLUME_CONTRACTION")?.status).toBe("UNKNOWN");
    expect(audit.rules.find(rule => rule.rule === "RECLAIM_VOLUME_EXPANSION")?.status).toBe("UNKNOWN");
    expect(audit.buyAllowed).toBe(false);
  });

  it("keeps a missing or future launch age unknown rather than treating it as fresh", () => {
    for (const age of [null, -1, Number.NaN]) {
      const audit = evaluateStrictStrategyAudit({ ...base, candidateAgeSeconds: age });
      expect(audit.rules.find(rule => rule.rule === "CANDIDATE_AGE")?.status).toBe("UNKNOWN");
    }
  });

  it("requires the immediate next observation to hold above the reclaim threshold", () => {
    const result = calculateReclaimConfirmation({
      reclaimTimeSeconds: 10,
      previousCompletedHigh: 100,
      nowSeconds: 12,
      // Deliberately out of order: the first observation is below 101;
      // a later recovery must not retroactively confirm the reclaim.
      nextObservationPrices: [
        { timestampSeconds: 11.5, price: 102 },
        { timestampSeconds: 11, price: 100.5 }
      ]
    });
    expect(result).toEqual({ signalAgeSeconds: 2, nextObservationConfirmed: false });
  });

  it("confirms when the immediate next observation holds at least 1% above the prior high", () => {
    const result = calculateReclaimConfirmation({
      reclaimTimeSeconds: 10,
      previousCompletedHigh: 100,
      nowSeconds: 12,
      nextObservationPrices: [
        { timestampSeconds: 11.5, price: 102 },
        { timestampSeconds: 11, price: 101.01 }
      ]
    });
    expect(result).toEqual({ signalAgeSeconds: 2, nextObservationConfirmed: true });
  });
  it("does not skip an invalid immediate observation to accept a later recovery", () => {
    const result = calculateReclaimConfirmation({
      reclaimTimeSeconds: 10, previousCompletedHigh: 100, nowSeconds: 12,
      nextObservationPrices: [
        { timestampSeconds: 11.5, price: 102 },
        { timestampSeconds: 11, price: Number.NaN }
      ]
    });
    expect(result.nextObservationConfirmed).toBe(false);
  });

});
