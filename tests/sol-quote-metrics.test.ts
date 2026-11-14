import { describe, expect, it } from "vitest";
import { getSolQuoteMetrics } from "../src/ingestion/sol-quote-metrics.js";
import { LEGACY_SOL_QUOTE_MINT, SOL_QUOTE_MINT } from "../src/ingestion/trade-flow.js";

const base = {
  quoteAmount: "2_000_000_000",
  solAmount: "1_000_000_000",
  virtualQuoteReserves: "32_000_000_000",
  virtualSolReserves: "30_000_000_000",
  virtualTokenReserves: "800_000_000_000_000",
  realQuoteReserves: "7_000_000_000",
  realSolReserves: "5_000_000_000"
};

describe("SOL quote metric normalization", () => {
  it("uses quote-side amounts and reserves for wrapped SOL", () => {
    expect(getSolQuoteMetrics({ ...base, quoteMint: SOL_QUOTE_MINT })).toEqual({
      sol: 2, price: 32_000_000_000 / 800_000_000_000_000, liquidity: 7
    });
  });

  it("recognizes legacy native SOL and uses its quote-side fields", () => {
    expect(getSolQuoteMetrics({ ...base, quoteMint: LEGACY_SOL_QUOTE_MINT })).toEqual({
      sol: 2, price: 32_000_000_000 / 800_000_000_000_000, liquidity: 7
    });
  });

  it("falls back to legacy SOL amount and reserve fields when quote-side values are zero", () => {
    expect(getSolQuoteMetrics({
      ...base, quoteMint: LEGACY_SOL_QUOTE_MINT, quoteAmount: "0",
      virtualQuoteReserves: "0", realQuoteReserves: "0"
    })).toEqual({
      sol: 1, price: 30_000_000_000 / 800_000_000_000_000, liquidity: 5
    });
  });

  it("does not compare non-SOL quote assets with SOL thresholds", () => {
    expect(getSolQuoteMetrics({ ...base, quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" })).toBeNull();
  });

  it("returns an unavailable price for zero token reserves without throwing", () => {
    expect(getSolQuoteMetrics({
      ...base, quoteMint: LEGACY_SOL_QUOTE_MINT, virtualTokenReserves: "0"
    })?.price).toBeNull();
  });
});
