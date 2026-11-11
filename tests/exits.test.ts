import { describe, expect, it } from "vitest";
import {
  calculateProtectiveExit,
  evaluateDynamicExhaustionExit,
  transitionPositionMarketState,
  type ExitObservation
} from "../src/strategy/exits.js";

describe("protective exit policy", () => {
  it("keeps the hard stop until trailing/profit protection rises above it", () => {
    const result = calculateProtectiveExit(1, 1.1, 1.1);
    expect(result.trailingStopPrice).toBeCloseTo(0.66);
    expect(result.profitLockPrice).toBeCloseTo(1.05);
    expect(result.activeStopPrice).toBeCloseTo(1.05);
    expect(result.triggered).toBe(false);
  });

  it("locks the highest achieved profit floor and never lowers a prior stop", () => {
    const result = calculateProtectiveExit(1, 2, 2, 1.5);
    expect(result.profitLockPrice).toBeCloseTo(1.4);
    expect(result.activeStopPrice).toBe(1.5);
  });

  it("triggers the hard stop below entry by five percent", () => {
    const result = calculateProtectiveExit(1, 0.94, 1);
    expect(result.activeStopPrice).toBeCloseTo(0.95);
    expect(result.triggered).toBe(true);
  });

  it("does not impose a holding-time expiry", () => {
    // Holding duration is intentionally absent from the protective exit API.
    const result = calculateProtectiveExit(1, 1.02, 1.02);
    expect(result.triggered).toBe(false);
  });
});

describe("dynamic exhaustion exit", () => {
  const thresholds = {
    buySellRatioMax: 1.2,
    buyVolumeDeclinePctMin: 40,
    buyerRateDeclinePctMin: 40,
    sellVolumeIncreasePctMin: 50,
    sellerRateIncreasePctMin: 50,
    liquidityDeclinePctMin: 20,
    priceResponseDeclinePctMin: 40,
    largeHolderSellPctMin: 5,
    confirmationWindows: 2,
    minimumBearishFamiliesPerWindow: 2
  };

  const neutral: ExitObservation = {
    complete: true,
    buySellRatio: 2.5,
    buyVolumeDeclinePct: 5,
    buyerRateDeclinePct: 5,
    netSellFlow: false,
    sellVolumeIncreasePct: 5,
    sellerRateIncreasePct: 5,
    liquidityDeclinePct: 0,
    priceResponseDeclinePct: 0,
    largeHolderSellPct: 0,
    criticalDistributionDetected: false
  };

  const bearish: ExitObservation = {
    ...neutral,
    buySellRatio: 0.8,
    buyVolumeDeclinePct: 50,
    buyerRateDeclinePct: 10,
    netSellFlow: true,
    sellVolumeIncreasePct: 60,
    sellerRateIncreasePct: 10
  };

  it("requires multiple independent bearish families across consecutive complete windows", () => {
    const result = evaluateDynamicExhaustionExit([bearish, bearish], thresholds);
    expect(result.triggered).toBe(true);
    expect(result.immediate).toBe(false);
    expect(result.confirmedWindows).toBe(2);
    expect(result.signalFamilies[0]).toContain("flow_pressure");
    expect(result.signalFamilies[0]).toContain("participation_decay");
    expect(result.reasons).toContain("buy_sell_pressure_weakened");
  });

  it("does not count correlated flow signals as multiple independent reasons", () => {
    const flowOnly: ExitObservation = {
      ...neutral,
      buySellRatio: 0.7,
      netSellFlow: true,
      sellVolumeIncreasePct: 80
    };
    const result = evaluateDynamicExhaustionExit([flowOnly, flowOnly], thresholds);
    expect(result.triggered).toBe(false);
    expect(result.familyCounts).toEqual([1, 1]);
  });

  it("does not count correlated participation signals as multiple independent reasons", () => {
    const participationOnly: ExitObservation = {
      ...neutral,
      buyVolumeDeclinePct: 70,
      buyerRateDeclinePct: 65,
      sellerRateIncreasePct: 80
    };
    const result = evaluateDynamicExhaustionExit([participationOnly, participationOnly], thresholds);
    expect(result.triggered).toBe(false);
    expect(result.familyCounts).toEqual([1, 1]);
  });

  it("supports a sell-volume increase as an order-flow warning", () => {
    const sellPressure: ExitObservation = {
      ...neutral,
      sellVolumeIncreasePct: 70,
      netSellFlow: true
    };
    const result = evaluateDynamicExhaustionExit([sellPressure, sellPressure], thresholds);
    expect(result.signalFamilies[0]).toContain("flow_pressure");
    expect(result.triggered).toBe(false); // one family alone is not enough
  });

  it("exits immediately on verified critical creator/linked-wallet distribution", () => {
    const critical: ExitObservation = {
      ...neutral,
      criticalDistributionDetected: true
    };
    const result = evaluateDynamicExhaustionExit([critical], thresholds);
    expect(result.triggered).toBe(true);
    expect(result.immediate).toBe(true);
    expect(result.reasons).toContain("critical_wallet_distribution");
  });

  it("does not treat missing/incomplete market data as zero buying", () => {
    const result = evaluateDynamicExhaustionExit([
      bearish,
      { ...bearish, complete: false, buySellRatio: null, buyVolumeDeclinePct: null }
    ], thresholds);
    expect(result.triggered).toBe(false);
  });

  it("does not trigger from a single bearish window", () => {
    const result = evaluateDynamicExhaustionExit([bearish], thresholds);
    expect(result.triggered).toBe(false);
  });
});

describe("migration-aware market state", () => {
  it("does not close a position when migration is detected", () => {
    expect(transitionPositionMarketState("open_curve", {
      graduated: true,
      migratedPoolVerified: false,
      freshSellQuoteAvailable: false
    })).toBe("migration_pending");
  });

  it("moves to migrated monitoring only after pool and quote verification", () => {
    expect(transitionPositionMarketState("migration_pending", {
      graduated: true,
      migratedPoolVerified: true,
      freshSellQuoteAvailable: true
    })).toBe("open_migrated");
  });

  it("blocks exit without a fresh quote but keeps the position open", () => {
    expect(transitionPositionMarketState("migration_pending", {
      graduated: true,
      migratedPoolVerified: true,
      freshSellQuoteAvailable: false
    })).toBe("exit_blocked");
  });

  it("keeps migrated positions in the same market-aware lifecycle", () => {
    expect(transitionPositionMarketState("open_migrated", {
      graduated: true,
      migratedPoolVerified: true,
      freshSellQuoteAvailable: true
    })).toBe("open_migrated");
  });
});
