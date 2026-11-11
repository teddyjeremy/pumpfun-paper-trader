import { describe, expect, it } from "vitest";
import { canEnterNewPosition, evaluateExitPolicy, type ExitWindow } from "../src/strategy/exit-policy.js";

const neutral = (): ExitWindow => ({
  buyVolumeLamports: 100,
  sellVolumeLamports: 30,
  uniqueBuyers: 8,
  uniqueSellers: 2,
  priceChangePct: 1
});

describe("migration-aware paper exit policy", () => {
  it("does not sell merely because a coin graduates", () => {
    const result = evaluateExitPolicy({
      entryPrice: 1, currentPrice: 1.4, highestCompletedPrice: 1.5,
      venue: "bonding_curve", migrationDetected: true, migratedPoolVerified: true,
      baselineWindows: [neutral(), neutral(), neutral()],
      recentWindows: [neutral(), neutral(), neutral()]
    });
    expect(result.action).toBe("SWITCH_VENUE");
    expect(result.venue).toBe("pumpswap");
    expect(result.exitSignal).toBeUndefined();
  });

  it("waits for a verified PumpSwap pool after migration without fabricating a sell", () => {
    const result = evaluateExitPolicy({
      entryPrice: 1, currentPrice: 1.2, highestCompletedPrice: 1.3,
      venue: "bonding_curve", migrationDetected: true, migratedPoolVerified: false,
      baselineWindows: [neutral(), neutral(), neutral()],
      recentWindows: [neutral(), neutral(), neutral()]
    });
    expect(result.action).toBe("WAIT_FOR_POOL");
    expect(result.venue).toBe("pumpswap");
  });

  it("retains a triggered protective signal while migration handoff is pending", () => {
    const result = evaluateExitPolicy({
      entryPrice: 1, currentPrice: 0.94, highestCompletedPrice: 1,
      venue: "bonding_curve", migrationDetected: true, migratedPoolVerified: false,
      baselineWindows: [], recentWindows: []
    });
    expect(result.action).toBe("WAIT_FOR_POOL");
    expect(result.exitSignal).toBe("HARD_STOP");
  });

  it("uses the hard stop and original profit-lock ladder", () => {
    const hardStop = evaluateExitPolicy({
      entryPrice: 1, currentPrice: 0.94, highestCompletedPrice: 1,
      venue: "bonding_curve", migrationDetected: false, migratedPoolVerified: false,
      baselineWindows: [], recentWindows: []
    });
    expect(hardStop.exitSignal).toBe("HARD_STOP");

    const lock = evaluateExitPolicy({
      entryPrice: 1, currentPrice: 1.14, highestCompletedPrice: 1.5,
      venue: "bonding_curve", migrationDetected: false, migratedPoolVerified: false,
      baselineWindows: [], recentWindows: []
    });
    expect(lock.exitSignal).toBe("PROFIT_LOCK");
    expect(lock.activeStopPrice).toBeCloseTo(1.15);
  });

  it("requires both buying contraction and sustained sell pressure for a dynamic exit", () => {
    const pressure: ExitWindow = {
      buyVolumeLamports: 20, sellVolumeLamports: 50,
      uniqueBuyers: 2, uniqueSellers: 5, priceChangePct: -1
    };
    const result = evaluateExitPolicy({
      entryPrice: 1, currentPrice: 1.1, highestCompletedPrice: 1.2,
      venue: "bonding_curve", migrationDetected: false, migratedPoolVerified: false,
      baselineWindows: [neutral(), neutral(), neutral()],
      recentWindows: [pressure, pressure, pressure]
    });
    expect(result.action).toBe("SELL");
    expect(result.exitSignal).toBe("SELL_PRESSURE");
    expect(result.buyVolumeDeclineFraction).toBeGreaterThanOrEqual(0.5);
  });

  it("does not sell on a quiet market without sustained sell pressure", () => {
    const quiet: ExitWindow = {
      buyVolumeLamports: 20, sellVolumeLamports: 10,
      uniqueBuyers: 2, uniqueSellers: 1, priceChangePct: 0
    };
    const result = evaluateExitPolicy({
      entryPrice: 1, currentPrice: 1.1, highestCompletedPrice: 1.2,
      venue: "bonding_curve", migrationDetected: false, migratedPoolVerified: false,
      baselineWindows: [neutral(), neutral(), neutral()],
      recentWindows: [quiet, quiet, quiet]
    });
    expect(result.action).toBe("HOLD");
  });

  it("allows new entries only before curve completion", () => {
    expect(canEnterNewPosition(false, false)).toBe(true);
    expect(canEnterNewPosition(true, false)).toBe(false);
    expect(canEnterNewPosition(false, true)).toBe(false);
  });
});
