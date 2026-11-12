import { describe, expect, it } from "vitest";
import {
  quotePumpCurveBuy, quotePumpCurveSell, quotePumpSwapBuy, quotePumpSwapSell,
  type PumpCurveQuoteState, type PumpSwapQuoteState
} from "../src/ingestion/pump-quote-math.js";

const curve: PumpCurveQuoteState = {
  virtualTokenReserves: "1000000000000",
  virtualQuoteReserves: "30000000000",
  realTokenReserves: "800000000000",
  complete: false,
  fees: { protocol: 95, creator: 30 }
};
const pool: PumpSwapQuoteState = {
  baseVaultReserves: "1000000000000",
  quoteVaultReserves: "30000000000",
  virtualQuoteReserves: "-100000000",
  protocolFeeBucketsBaseUnits: "5000000",
  creatorFeeBucketsBaseUnits: "3000000",
  fees: { protocol: 50, creator: 30, lp: 20 }
};

describe("Pump exact-input quote math", () => {
  it("quotes a curve buy with protocol and creator fees separated", () => {
    const quote = quotePumpCurveBuy({ quoteInBaseUnits: "1000000000", state: curve });
    expect(BigInt(quote.netQuoteIn) + BigInt(quote.fees.total)).toBeLessThanOrEqual(1_000_000_000n);
    expect(BigInt(quote.tokenOut)).toBeGreaterThan(0n);
    expect(quote.fees.lp).toBe("0");
    expect(BigInt(quote.fees.protocol)).toBeGreaterThan(0n);
    expect(BigInt(quote.fees.creator)).toBeGreaterThan(0n);
  });

  it("quotes a curve sell and deducts separately rounded fees from gross proceeds", () => {
    const quote = quotePumpCurveSell({ tokenInBaseUnits: "10000000000", state: curve });
    expect(BigInt(quote.netQuoteOut) + BigInt(quote.fees.total)).toBe(BigInt(quote.grossQuoteOut));
    expect(BigInt(quote.netQuoteOut)).toBeGreaterThan(0n);
    expect(quote.priceImpactPct).toBeGreaterThanOrEqual(0);
  });

  it("uses the effective PumpSwap quote reserve, including signed virtual reserves", () => {
    const quote = quotePumpSwapBuy({ quoteInBaseUnits: "1000000000", state: pool });
    expect(BigInt(quote.tokenOut)).toBeGreaterThan(0n);
    expect(BigInt(quote.netQuoteIn) + BigInt(quote.fees.total)).toBeLessThanOrEqual(1_000_000_000n);
    expect(quote.fees.lp).not.toBe("0");
  });

  it("quotes PumpSwap sells net of protocol, creator and LP fees", () => {
    const quote = quotePumpSwapSell({ tokenInBaseUnits: "10000000000", state: pool });
    expect(BigInt(quote.netQuoteOut) + BigInt(quote.fees.total)).toBe(BigInt(quote.grossQuoteOut));
    expect(BigInt(quote.netQuoteOut)).toBeGreaterThan(0n);
  });

  it("rejects completed curves, empty reserves, and invalid fee schedules", () => {
    expect(() => quotePumpCurveBuy({
      quoteInBaseUnits: "1000000000", state: { ...curve, complete: true }
    })).toThrow(/completed bonding curve/);
    expect(() => quotePumpSwapBuy({
      quoteInBaseUnits: "1000000000", state: { ...pool, virtualQuoteReserves: "-30000000000" }
    })).toThrow(/empty/);
    expect(() => quotePumpSwapSell({
      tokenInBaseUnits: "1000", state: { ...pool, fees: { protocol: 9000, creator: 2000, lp: 0 } }
    })).toThrow(/exceed 100%/);
  });

  it("caps PumpSwap sells at quote-vault liquidity excluding booked protocol and creator fees", () => {
    expect(() => quotePumpSwapSell({
      tokenInBaseUnits: "100000000000000000000",
      state: { ...pool, quoteVaultReserves: "1000000", virtualQuoteReserves: "0",
        protocolFeeBucketsBaseUnits: "700000", creatorFeeBucketsBaseUnits: "300000" }
    })).toThrow(/fee buckets/);
  });

  it("rejects inputs whose integer rounding produces zero output", () => {
    expect(() => quotePumpCurveBuy({ quoteInBaseUnits: "2", state: curve })).toThrow();
    expect(() => quotePumpSwapSell({ tokenInBaseUnits: "1", state: pool })).toThrow();
  });
});
