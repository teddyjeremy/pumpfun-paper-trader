import { describe, expect, it } from "vitest";
import {
  calculatePaperPortfolioEquity,
  createPaperPortfolio,
  type PaperPosition
} from "../src/paper/portfolio.js";

function position(overrides: Partial<PaperPosition> = {}): PaperPosition {
  return {
    positionId: "position-1",
    mint: "Mint111111111111111111111111111111111111111",
    openedAt: "2026-11-28T10:00:00.000Z",
    stakeUsd: 1,
    tokenAmountBaseUnits: "1000000",
    tokenDecimals: 6,
    buyQuoteId: "buy-quote-1",
    entryPriceUsdPerToken: 1,
    buyCostsUsd: 0.01,
    expectedSellCostsUsd: 0.03,
    rentReserveUsd: 0.10,
    highWaterPriceUsdPerToken: 1,
    latestPriceUsdPerToken: 0.92,
    latestLiquidationValueUsd: 0.92,
    latestSellQuoteId: "sell-quote-1",
    latestSellQuoteAt: "2026-11-28T10:00:01.000Z",
    realizedPnlUsd: null,
    status: "OPEN",
    exitReason: null,
    ...overrides
  };
}

describe("calculatePaperPortfolioEquity", () => {
  it("includes refundable rent and the sell-fee reserve withheld from cash", () => {
    const state = createPaperPortfolio(2.70);
    state.availableCashUsd = 1.37;
    state.reservedAccountRentUsd = 0.10;
    state.positions = [position()];

    expect(calculatePaperPortfolioEquity(state)).toEqual({
      availableCashUsd: 1.37,
      reservedAccountRentUsd: 0.10,
      liquidationValueUsd: 0.92,
      expectedSellCostsUsd: 0.03,
      equityUsd: 2.42
    });
  });

  it("excludes closed positions but keeps EXIT_BLOCKED positions reserved", () => {
    const state = createPaperPortfolio(2.70);
    state.availableCashUsd = 1.37;
    state.reservedAccountRentUsd = 0.10;
    state.positions = [
      position(),
      position({
        positionId: "closed-position",
        mint: "Mint222222222222222222222222222222222222222",
        status: "CLOSED",
        latestLiquidationValueUsd: 99,
        expectedSellCostsUsd: 9
      }),
      position({
        positionId: "blocked-position",
        mint: "Mint333333333333333333333333333333333333333",
        status: "EXIT_BLOCKED",
        latestLiquidationValueUsd: 0.50,
        expectedSellCostsUsd: 0.02
      })
    ];

    expect(calculatePaperPortfolioEquity(state)).toEqual({
      availableCashUsd: 1.37,
      reservedAccountRentUsd: 0.10,
      liquidationValueUsd: 1.42,
      expectedSellCostsUsd: 0.05,
      equityUsd: 2.94
    });
  });

  it("rejects malformed persisted equity components instead of journaling them", () => {
    const state = createPaperPortfolio(2.70);
    state.positions = [position({ latestLiquidationValueUsd: -0.01 })];

    expect(() => calculatePaperPortfolioEquity(state)).toThrow(
      "Paper portfolio equity contains invalid cash, rent, liquidation or sell-cost values."
    );
  });
});
