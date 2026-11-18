import { describe, expect, it } from "vitest";
import { simulateEquityDoublingPortfolio } from "../src/strategy/equity-doubling-portfolio.js";
import type { ClosedTrade } from "../src/strategy/simulate-trade.js";

function trade(mint: string, entryTime: number, exitTime: number, pnlUsd: number): ClosedTrade {
  return {
    mint, family: "test", entryTime, exitTime, entryPrice: 1, exitPrice: 1,
    stakeUsd: 1, pnlUsd, returnPct: pnlUsd * 100, holdMinutes: (exitTime-entryTime)/60,
    exitReason: "max_hold", win: pnlUsd > 0
  };
}

describe("equity-doubling portfolio policy", () => {
  it("starts with one $1 slot and only scales after realized equity doubles", () => {
    const result = simulateEquityDoublingPortfolio([
      trade("A", 100, 200, 2.7),
      trade("B", 210, 300, 0)
    ], { startingEquityUsd: 2.7, initialStakeUsd: 1, initialConcurrentPositions: 1 });
    expect(result.taken).toBe(2);
    expect(result.highestDoublingLevel).toBe(1);
    expect(result.maxConcurrentPositions).toBe(1);
    expect(result.maxConcurrentSlots).toBe(2);
    expect(result.largestStakeUsd).toBe(1.5);
  });

  it("does not reuse an occupied slot and never enters a mint twice", () => {
    const result = simulateEquityDoublingPortfolio([
      trade("A", 100, 300, 0),
      trade("B", 150, 250, 0),
      trade("A", 310, 400, 0)
    ], { startingEquityUsd: 5, initialStakeUsd: 1, initialConcurrentPositions: 1 });
    expect(result.taken).toBe(1);
    expect(result.skippedConcurrency).toBe(1);
    expect(result.skippedDuplicateMint).toBe(1);
    expect(result.maxConcurrentPositions).toBe(1);
    expect(result.maxConcurrentSlots).toBe(1);
  });

  it("uses the extra slot only after a completed equity doubling and reports actual overlap", () => {
    const result = simulateEquityDoublingPortfolio([
      trade("A", 100, 200, 2.7),
      trade("B", 210, 400, 0),
      trade("C", 220, 300, 0)
    ], { startingEquityUsd: 2.7, initialStakeUsd: 1, initialConcurrentPositions: 1 });
    expect(result.highestDoublingLevel).toBe(1);
    expect(result.maxConcurrentSlots).toBe(2);
    expect(result.maxConcurrentPositions).toBe(2);
    expect(result.taken).toBe(3);
  });

  it("stops opening new trades after a 20% loss from the UTC day's starting equity", () => {
    const result = simulateEquityDoublingPortfolio([
      trade("LOSS", 100, 200, -0.7),
      trade("AFTER-LOSS", 210, 300, 2)
    ], {
      startingEquityUsd: 2.7,
      initialStakeUsd: 1,
      initialConcurrentPositions: 1,
      dailyDrawdownKillPct: 20
    }, 0);
    expect(result.taken).toBe(1);
    expect(result.skippedDailyDrawdown).toBe(1);
    expect(result.killedDays).toBe(1);
    expect(result.endingEquityUsd).toBeCloseTo(2);
  });

  it("caps stake at $100", () => {
    const trades: ClosedTrade[] = [];
    let time = 100;
    for (let i = 0; i < 20; i += 1) {
      trades.push(trade(`M${i}`, time, time + 1, 100_000));
      time += 2;
    }
    const result = simulateEquityDoublingPortfolio(trades, {
      startingEquityUsd: 5, initialStakeUsd: 1, initialConcurrentPositions: 1,
      stakeIncreaseMultiplier: 1.5, maxStakeUsd: 100
    });
    expect(result.largestStakeUsd).toBe(100);
  });
});
