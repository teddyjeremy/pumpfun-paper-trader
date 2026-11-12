import { describe, expect, it } from "vitest";
import { buildExitWindowObservations, type RawExitWindowSample } from "../src/strategy/exit-window-builder.js";
import { DYNAMIC_EXIT_CALIBRATION_V1, evaluateExit } from "../src/strategy/dynamic-exits.js";

const sample = (overrides: Partial<RawExitWindowSample> = {}): RawExitWindowSample => ({
  mint: "mint", marketPhase: "bonding_curve", venue: "pump_curve", quoteMint: "So11111111111111111111111111111111111111112",
  endedAtMs: 2_000, windowSeconds: 2, complete: true,
  buyQuoteVolumeBaseUnits: "1000", sellQuoteVolumeBaseUnits: "40",
  uniqueBuyers: 5, uniqueSellers: 1,
  startPriceQuotePerToken: 1, endPriceQuotePerToken: 1.02,
  quoteLiquidityBaseUnits: "1000", largeHolderDistributionDetected: false,
  ...overrides
});

describe("dynamic exit window builder", () => {
  it("derives independent pressure, participation, price-response and liquidity metrics", () => {
    const windows = buildExitWindowObservations([
      sample({ endedAtMs: 2_000 }),
      sample({
        endedAtMs: 4_000, buyQuoteVolumeBaseUnits: "600", sellQuoteVolumeBaseUnits: "60",
        uniqueBuyers: 3, uniqueSellers: 2,
        startPriceQuotePerToken: 1.02, endPriceQuotePerToken: 1.02612,
        quoteLiquidityBaseUnits: "800"
      })
    ]);
    expect(windows[0]).toMatchObject({
      complete: true, buySellRatio: 25, buyVolumeDeclinePct: null,
      buyerRateDeclinePct: null, sellVolumeExpansionPct: null
    });
    expect(windows[1]).toMatchObject({
      buySellRatio: 10, buyVolumeDeclinePct: 40, buyerRateDeclinePct: 40,
      sellVolumeExpansionPct: 50, priceResponseDeclinePct: 50,
      liquidityChangePct: -20
    });
  });

  it("resets comparison baselines across data gaps, market changes and quote-mint changes", () => {
    const result = buildExitWindowObservations([
      sample({ endedAtMs: 2_000 }),
      sample({ endedAtMs: 6_000, buyQuoteVolumeBaseUnits: "100" }),
      sample({ endedAtMs: 8_000, complete: false }),
      sample({ endedAtMs: 10_000, buyQuoteVolumeBaseUnits: "50" }),
      sample({ endedAtMs: 12_000, quoteMint: "different-quote", buyQuoteVolumeBaseUnits: "20" })
    ]);
    expect(result[1]?.buyVolumeDeclinePct).toBeNull();
    expect(result[3]?.buyVolumeDeclinePct).toBeNull();
    expect(result[4]?.buyVolumeDeclinePct).toBeNull();
  });

  it("leaves unavailable metrics null instead of treating missing data as zero", () => {
    const result = buildExitWindowObservations([
      sample({ endedAtMs: 2_000, sellQuoteVolumeBaseUnits: "0", quoteLiquidityBaseUnits: null }),
      sample({
        endedAtMs: 4_000, sellQuoteVolumeBaseUnits: "0", quoteLiquidityBaseUnits: null,
        startPriceQuotePerToken: null, endPriceQuotePerToken: null
      })
    ]);
    expect(result[1]).toMatchObject({
      buySellRatio: null, sellVolumeExpansionPct: null,
      priceResponseDeclinePct: null, liquidityChangePct: null
    });
  });

  it("produces consecutive bearish windows that the existing exit evaluator can consume", () => {
    const observations = buildExitWindowObservations([
      sample({ endedAtMs: 2_000 }),
      sample({
        endedAtMs: 4_000, buyQuoteVolumeBaseUnits: "600", sellQuoteVolumeBaseUnits: "60",
        uniqueBuyers: 3, startPriceQuotePerToken: 1.02, endPriceQuotePerToken: 1.02612,
        quoteLiquidityBaseUnits: "800"
      }),
      sample({
        endedAtMs: 6_000, buyQuoteVolumeBaseUnits: "300", sellQuoteVolumeBaseUnits: "120",
        uniqueBuyers: 1, startPriceQuotePerToken: 1.02612, endPriceQuotePerToken: 1.02714612,
        quoteLiquidityBaseUnits: "600"
      })
    ]);
    const decision = evaluateExit({
      currentNetReturnPct: 20, highestCompletedNetReturnPct: 25,
      freshExecutableSellQuote: true, windowsOldestFirst: observations.slice(1)
    }, DYNAMIC_EXIT_CALIBRATION_V1);
    expect(decision.action).toBe("sell");
    expect(decision.reason).toBe("dynamic_exhaustion");
  });

  it("does not pass incomplete or malformed windows to the exit evaluator", () => {
    const result = buildExitWindowObservations([
      sample({ endedAtMs: 2_000 }),
      sample({ endedAtMs: 4_000, complete: false, buyQuoteVolumeBaseUnits: "not-a-number" })
    ]);
    expect(result[1]).toMatchObject({
      complete: false, buySellRatio: null, buyVolumeDeclinePct: null,
      buyerRateDeclinePct: null, sellVolumeExpansionPct: null,
      priceResponseDeclinePct: null, liquidityChangePct: null,
      largeHolderDistributionDetected: null
    });
  });
});
