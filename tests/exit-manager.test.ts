import { describe, expect, it } from "vitest";
import { DEFAULT_EXIT_POLICY, evaluateExit, type PositionExitState } from "../src/strategy/exit-manager.js";

const position = (overrides: Partial<PositionExitState> = {}): PositionExitState => ({
  entryPriceUsd: 1,
  highWaterPriceUsd: 1,
  activeStopPriceUsd: 0.95,
  marketState: "bonding_curve",
  bearishStreak: 0,
  ...overrides
});

const observation = (overrides: Partial<Parameters<typeof evaluateExit>[1]> = {}) => ({
  markPriceUsd: 1.05,
  observedMarketState: "bonding_curve" as const,
  sellQuoteFresh: true,
  sellRouteVerified: true,
  ...overrides
});

describe("migration-aware dynamic exit manager", () => {
  it("does not sell merely because the token graduates", () => {
    const result = evaluateExit(position(), observation({ migrationDetected: true }));
    expect(result.action).toBe("migration_pending");
    expect(result.marketState).toBe("migration_pending");
  });

  it("keeps a migrated position open while the migrated pool is unverified", () => {
    const pending = position({ marketState: "migration_pending" });
    const result = evaluateExit(pending, observation({ observedMarketState: "bonding_curve" }));
    expect(result.action).toBe("migration_pending");
    expect(result.reason).toBe("migrated_pool_not_yet_verified");
  });

  it("continues monitoring after a verified migration", () => {
    const pending = position({ marketState: "migration_pending" });
    const result = evaluateExit(pending, observation({
      observedMarketState: "migrated_pool",
      migratedPoolVerified: true
    }));
    expect(result.action).toBe("hold");
    expect(result.marketState).toBe("migrated_pool");
  });

  it("blocks an exit instead of fabricating a fill when the sell quote is unavailable", () => {
    const result = evaluateExit(position(), observation({
      markPriceUsd: 0.90,
      sellQuoteFresh: false
    }));
    expect(result.action).toBe("exit_blocked");
  });

  it("keeps the protective stop monotonic and exits when it is hit", () => {
    const raised = evaluateExit(position(), observation({ markPriceUsd: 1.50 }));
    expect(raised.activeStopPriceUsd).toBeGreaterThan(0.95);
    const next = evaluateExit(position({
      highWaterPriceUsd: raised.highWaterPriceUsd,
      activeStopPriceUsd: raised.activeStopPriceUsd
    }), observation({ markPriceUsd: raised.activeStopPriceUsd - 0.001 }));
    expect(next.action).toBe("exit");
    expect(next.activeStopPriceUsd).toBe(raised.activeStopPriceUsd);
  });

  it("does not apply a holding-time cap", () => {
    const result = evaluateExit(position(), observation({ markPriceUsd: 1.01 }));
    expect(result.action).toBe("hold");
  });

  it("requires multiple bearish signals over consecutive windows when dynamic exits are enabled", () => {
    const policy = {
      ...DEFAULT_EXIT_POLICY,
      dynamic: {
        buySellRatioBelow: 1,
        buyVolumeDeclinePctAtLeast: 40,
        buyerRateDeclinePctAtLeast: 40,
        consecutiveWindows: 2
      }
    };
    const bearish = observation({
      buySellQuoteVolumeRatio: 0.7,
      buyVolumeDeclinePct: 55,
      buyerRateDeclinePct: 45
    });
    const first = evaluateExit(position(), bearish, policy);
    expect(first.action).toBe("hold");
    const second = evaluateExit(position({ bearishStreak: first.bearishStreak }), bearish, policy);
    expect(second.action).toBe("exit");
    expect(second.reason).toBe("confirmed_market_exhaustion");
  });

  it("does not treat one missing volume window as zero buying", () => {
    const policy = {
      ...DEFAULT_EXIT_POLICY,
      dynamic: {
        buySellRatioBelow: 1,
        buyVolumeDeclinePctAtLeast: 40,
        buyerRateDeclinePctAtLeast: 40,
        consecutiveWindows: 2
      }
    };
    const result = evaluateExit(position(), observation({
      buySellQuoteVolumeRatio: null,
      buyVolumeDeclinePct: null,
      buyerRateDeclinePct: null
    }), policy);
    expect(result.action).toBe("hold");
    expect(result.bearishStreak).toBe(0);
  });
});
