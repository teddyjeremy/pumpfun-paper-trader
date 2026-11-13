import { describe, expect, it } from "vitest";
import { calculateReclaimConfirmation, canRequestExecutableQuote, evaluateStrictStrategyAudit, type StrictStrategyAuditInput } from "../src/paper/strategy-audit.js";

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
  it("allows a valid setup to develop after the first minute", () => {
    for (const age of [61, 180, 300, 600, 899]) {
      const audit = evaluateStrictStrategyAudit({ ...base, candidateAgeSeconds: age });
      expect(audit.rules.find(rule => rule.rule === "CANDIDATE_AGE")?.status).toBe("PASS");
      expect(audit.rejectionReasons).not.toContain("CANDIDATE_AGE");
      expect(audit.buyAllowed).toBe(false);
    }
  });



  it("rejects non-overlapping flow windows as evidence for the one-second sampling rule", () => {
    const audit = evaluateStrictStrategyAudit({
      ...base,
      candidateAgeSeconds: 30,
      flow: {
        dataComplete: true,
        latestThreeWindowFlowPass: true,
        sampleIntervalSeconds: 2,
        windows: [0, 2, 4].map(start => ({
          startTime: start, buySellRatio: 4, flowWindowPass: true, uniqueBuyers: 3, uniqueSellers: 1
        })),
        distinctBuyersAcrossLatestThree: 5,
        largestBuyerShareAcrossLatestThreeBps: 5_000,
        microTradeFilterStatus: "APPLIED"
      }
    });
    expect(audit.rules.find(rule => rule.rule === "THREE_FLOW_WINDOWS")?.status).toBe("UNKNOWN");
  });

  it("explains every UNKNOWN rule as a WATCH blocker without authorizing a buy", () => {
    const audit = evaluateStrictStrategyAudit(base);
    expect(audit.decision).toBe("WATCH");
    expect(audit.buyAllowed).toBe(false);
    expect(audit.blockingUnknownRules.length).toBeGreaterThan(0);
    expect(audit.watchReasons).toHaveLength(audit.blockingUnknownRules.length);
    for (const rule of audit.blockingUnknownRules) {
      expect(audit.watchReasons.some(reason => reason.startsWith(`${rule}: `))).toBe(true);
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
        sampleIntervalSeconds: 1,
        windows: [0, 1, 2].map(start => ({
          startTime: start, buySellRatio: 4, flowWindowPass: true, uniqueBuyers: 3, uniqueSellers: 1
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

  it("scores volume ratios only when reviewed thresholds are explicitly supplied", () => {
    const profile = {
      impulsePriceChangePct: 25,
      pullbackPct: 16,
      reclaimDetected: true,
      reclaimAbovePreviousFiveSecondHighPct: 1.2,
      pullbackVolumeVsImpulsePct: 45,
      reclaimVolumeVsPullbackPct: 160,
      dataComplete: true,
      microTradeFilterStatus: "APPLIED" as const
    };
    const calibrated = evaluateStrictStrategyAudit({
      ...base, candidateAgeSeconds: 120, profile,
      volumeThresholds: {
        maxPullbackVolumeVsImpulsePct: 50,
        minReclaimVolumeVsPullbackPct: 150
      },
      roundTripCostPct: 3.5
    });
    expect(calibrated.rules.find(rule => rule.rule === "PULLBACK_VOLUME_CONTRACTION")?.status).toBe("PASS");
    expect(calibrated.rules.find(rule => rule.rule === "RECLAIM_VOLUME_EXPANSION")?.status).toBe("PASS");
    expect(calibrated.rules.find(rule => rule.rule === "ROUND_TRIP_COST")?.status).toBe("PASS");
    const rejected = evaluateStrictStrategyAudit({
      ...base, candidateAgeSeconds: 120, profile,
      volumeThresholds: {
        maxPullbackVolumeVsImpulsePct: 40,
        minReclaimVolumeVsPullbackPct: 170
      },
      roundTripCostPct: 4.1
    });
    expect(rejected.rules.find(rule => rule.rule === "PULLBACK_VOLUME_CONTRACTION")?.status).toBe("FAIL");
    expect(rejected.rules.find(rule => rule.rule === "RECLAIM_VOLUME_EXPANSION")?.status).toBe("FAIL");
    expect(rejected.rules.find(rule => rule.rule === "ROUND_TRIP_COST")?.status).toBe("FAIL");
  });


  it("authorizes BUY only when all 15 mandatory rules explicitly PASS", () => {
    const audit = evaluateStrictStrategyAudit({
      ...base,
      candidateAgeSeconds: 120,
      profile: {
        impulsePriceChangePct: 25,
        pullbackPct: 16,
        reclaimDetected: true,
        reclaimAbovePreviousFiveSecondHighPct: 1.2,
        pullbackVolumeVsImpulsePct: 45,
        reclaimVolumeVsPullbackPct: 160,
        dataComplete: true,
        microTradeFilterStatus: "APPLIED"
      },
      flow: {
        dataComplete: true,
        latestThreeWindowFlowPass: true,
        sampleIntervalSeconds: 1,
        windows: [0, 1, 2].map(startTime => ({
          startTime, buySellRatio: 4, flowWindowPass: true, uniqueBuyers: 3, uniqueSellers: 1
        })),
        distinctBuyersAcrossLatestThree: 5,
        largestBuyerShareAcrossLatestThreeBps: 5_000,
        microTradeFilterStatus: "APPLIED"
      },
      creatorRiskStatus: "PASS_COMPLETE",
      walletClusterRiskStatus: "PASS_COMPLETE",
      attributionConfidenceBps: 8_000,
      signalAgeSeconds: 1,
      nextObservationConfirmed: true,
      executableQuoteAvailable: true,
      volumeThresholds: {
        maxPullbackVolumeVsImpulsePct: 50,
        minReclaimVolumeVsPullbackPct: 150
      },
      roundTripCostPct: 3.5
    });
    expect(audit.rules).toHaveLength(15);
    expect(audit.rules.every(rule => rule.status === "PASS")).toBe(true);
    expect(audit.decision).toBe("BUY");
    expect(audit.buyAllowed).toBe(true);
    expect(audit.watchReasons).toHaveLength(0);
    expect(audit.blockingUnknownRules).toHaveLength(0);
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

describe("automatic quote preflight", () => {
  const readyInput: StrictStrategyAuditInput = {
    ...base,
    candidateAgeSeconds: 120,
    profile: {
      impulsePriceChangePct: 25, pullbackPct: 16, reclaimDetected: true,
      reclaimAbovePreviousFiveSecondHighPct: 1.2, pullbackVolumeVsImpulsePct: 45,
      reclaimVolumeVsPullbackPct: 160, dataComplete: true, microTradeFilterStatus: "APPLIED"
    },
    flow: {
      dataComplete: true, latestThreeWindowFlowPass: true, sampleIntervalSeconds: 1,
      windows: [0, 1, 2].map(startTime => ({
        startTime, buySellRatio: 4, flowWindowPass: true, uniqueBuyers: 3, uniqueSellers: 1
      })),
      distinctBuyersAcrossLatestThree: 5, largestBuyerShareAcrossLatestThreeBps: 7_000,
      microTradeFilterStatus: "APPLIED"
    },
    creatorRiskStatus: "PASS_COMPLETE",
    walletClusterRiskStatus: "PASS_COMPLETE",
    attributionConfidenceBps: 8_000,
    signalAgeSeconds: 1,
    nextObservationConfirmed: true,
    executableQuoteAvailable: false,
    volumeThresholds: {
      maxPullbackVolumeVsImpulsePct: 50,
      minReclaimVolumeVsPullbackPct: 150
    },
    roundTripCostPct: null
  };

  it("requests a quote only after all thirteen pre-quote rules pass", () => {
    const audit = evaluateStrictStrategyAudit(readyInput);
    expect(audit.decision).toBe("WATCH");
    expect(canRequestExecutableQuote(audit)).toBe(true);
  });

  it("does not request a quote while calibration, wallet evidence, or freshness is unknown", () => {
    expect(canRequestExecutableQuote(evaluateStrictStrategyAudit({
      ...readyInput, volumeThresholds: null
    }))).toBe(false);
    expect(canRequestExecutableQuote(evaluateStrictStrategyAudit({
      ...readyInput, walletClusterRiskStatus: "WATCH"
    }))).toBe(false);
    expect(canRequestExecutableQuote(evaluateStrictStrategyAudit({
      ...readyInput, signalAgeSeconds: 3
    }))).toBe(false);
  });

  it("does not re-request a quote after quote evidence exists or its economics fail", () => {
    expect(canRequestExecutableQuote(evaluateStrictStrategyAudit({
      ...readyInput, executableQuoteAvailable: true, roundTripCostPct: 3.5
    }))).toBe(false);
    expect(canRequestExecutableQuote(evaluateStrictStrategyAudit({
      ...readyInput, executableQuoteAvailable: true, roundTripCostPct: 4.1
    }))).toBe(false);
  });

  it("rejects incomplete, duplicate, and unrecognized mandatory rule sets", () => {
    const audit = evaluateStrictStrategyAudit(readyInput);
    expect(canRequestExecutableQuote({ rules: audit.rules.slice(1) })).toBe(false);
    expect(canRequestExecutableQuote({
      rules: [...audit.rules.slice(1), audit.rules[0]!, audit.rules[0]!]
    })).toBe(false);
    expect(canRequestExecutableQuote({
      rules: [...audit.rules.slice(0, -1), { ...audit.rules[0]!, rule: "EXTRA" }]
    })).toBe(false);
  });
});
