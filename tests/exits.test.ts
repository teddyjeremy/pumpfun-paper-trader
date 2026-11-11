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
});

describe("dynamic exhaustion exit", () => {
  const thresholds = {
    buySellRatioMax: 1.2,
    buyVolumeDeclinePctMin: 40,
    buyerRateDeclinePctMin: 40,
    liquidityDeclinePctMin: 20,
    confirmationWindows: 2,
    minimumBearishSignalsPerWindow: 2
  };

  const bearish: ExitObservation = {
    complete: true,
    buySellRatio: 0.8,
    buyVolumeDeclinePct: 50,
    buyerRateDeclinePct: 10,
    netSellFlow: true,
    liquidityDeclinePct: 0
  };

  it("requires multiple bearish signals across consecutive complete windows", () => {
    const result = evaluateDynamicExhaustionExit([bearish, bearish], thresholds);
    expect(result.triggered).toBe(true);
    expect(result.confirmedWindows).toBe(2);
    expect(result.reasons).toContain("buy_sell_pressure_weakened");
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
});
