import { describe, expect, it } from "vitest";
import {
  buildExecutablePaperQuote,
  type PaperExecutionCostEstimate,
  type SolUsdReference
} from "../src/ingestion/executable-paper-quote.js";
import type { PumpSdkCurveQuote } from "../src/ingestion/pump-sdk-curve-quote-adapter.js";
import type { PumpSdkSwapQuote } from "../src/ingestion/pump-sdk-quote-adapter.js";

const now = Date.parse("2026-11-12T10:00:00.000Z");
const solUsd: SolUsdReference = { priceUsd: 100, observedAt: new Date(now - 100).toISOString() };
const costs: PaperExecutionCostEstimate = {
  networkFeeLamports: "5000",
  priorityFeeLamports: "1000",
  providerFeeUsd: 0.001,
  simulatedLatencyMs: 50
};

function curveQuote(side: "BUY" | "SELL" = "BUY"): PumpSdkCurveQuote {
  return {
    provider: "pump-sdk-4.3.1", venue: "PUMP_CURVE", side,
    mint: "So11111111111111111111111111111111111111112",
    quoteMint: "11111111111111111111111111111111",
    slot: 123, observedAt: new Date(now - 100).toISOString(),
    inputAmountBaseUnits: side === "BUY" ? "1000010" : "1000000",
    outputAmountBaseUnits: side === "BUY" ? "1000000000" : "1999000",
    grossQuoteAmountBaseUnits: side === "BUY" ? "1000010" : "2000000",
    netQuoteAmountBaseUnits: side === "BUY" ? "1000000" : "1999000",
    venueFeeBaseUnits: side === "BUY" ? "10" : "1000",
    priceImpactPct: 0.5, baseDecimals: 6, quoteDecimals: 9,
    transferTaxVerifiedZero: true, executionReady: false,
    blockers: ["network fee and priority fee estimates are not attached"]
  };
}

function swapBuyQuote(): PumpSdkSwapQuote {
  return {
    provider: "pump-sdk-4.3.1", side: "BUY",
    mint: "So11111111111111111111111111111111111111112",
    quoteMint: "So11111111111111111111111111111111111111112",
    slot: 456, observedAt: new Date(now - 100).toISOString(),
    inputAmountBaseUnits: "10000000", outputAmountBaseUnits: "5000000",
    grossQuoteAmountBaseUnits: "10000000", netQuoteAmountBaseUnits: "9990000",
    fees: {
      lpBaseUnits: "5000", protocolBaseUnits: "3000",
      creatorBaseUnits: "2000", totalBaseUnits: "10000"
    },
    unspentQuoteBaseUnits: "0", priceImpactPct: 0.7,
    baseDecimals: 6, quoteDecimals: 9,
    transferTaxVerifiedZero: true, executionReady: false,
    blockers: ["network fee and priority fee estimates are not attached"]
  };
}

describe("executable paper quote adapter", () => {
  it("converts a Pump curve exact-input buy and keeps aggregate Pump fees distinct", () => {
    const quote = buildExecutablePaperQuote({ quote: curveQuote("BUY"), solUsd, costs, nowMs: now });
    expect(quote.executable).toBe(true);
    expect(quote.executionReady).toBe(true);
    expect(quote.venue).toBe("PUMP_CURVE");
    expect(quote.requestedUsd).toBeCloseTo(0.1, 8);
    expect(quote.pumpFeeUsd).toBeCloseTo(0.000001, 10);
    expect(quote.feeBreakdownUsd.protocol).toBe(0);
    expect(quote.feeBreakdownUsd.creator).toBe(0);
    expect(quote.feeBreakdownUsd.pumpAggregate).toBeCloseTo(0.000001, 10);
    expect(quote.networkFeeUsd).toBeCloseTo(0.0005, 10);
    expect(quote.priorityFeeUsd).toBeCloseTo(0.0001, 10);
    expect(quote.simulatedFillAt).toBe(new Date(now + 50).toISOString());
    expect(quote.tokenDecimals).toBe(6);
  });

  it("splits PumpSwap LP, protocol and creator fees without double counting", () => {
    const quote = buildExecutablePaperQuote({ quote: swapBuyQuote(), solUsd, costs, nowMs: now });
    expect(quote.venue).toBe("PUMPSWAP");
    expect(quote.poolFeeUsd).toBeCloseTo(0.0005, 10);
    expect(quote.protocolFeeUsd).toBeCloseTo(0.0003, 10);
    expect(quote.creatorFeeUsd).toBeCloseTo(0.0002, 10);
    expect(quote.pumpFeeUsd).toBeUndefined();
    expect(quote.feeBreakdownUsd.transfer).toBe(0);
  });

  it("prices sell proceeds gross and keeps every fee separate", () => {
    const quote = buildExecutablePaperQuote({ quote: curveQuote("SELL"), solUsd, costs, nowMs: now });
    expect(quote.side).toBe("SELL");
    expect(quote.outputUsd).toBeCloseTo(0.2, 8);
    expect(quote.pumpFeeUsd).toBeCloseTo(0.0001, 10);
  });

  it("rejects stale market and SOL/USD evidence", () => {
    expect(() => buildExecutablePaperQuote({
      quote: { ...curveQuote(), observedAt: new Date(now - 2_001).toISOString() },
      solUsd, costs, nowMs: now
    })).toThrow(/market snapshot is stale/);
    expect(() => buildExecutablePaperQuote({
      quote: curveQuote(),
      solUsd: { ...solUsd, observedAt: new Date(now - 10_001).toISOString() },
      costs, nowMs: now
    })).toThrow(/SOL\/USD reference is stale/);
  });

  it("rejects fills whose simulated latency exceeds the quote validity window", () => {
    expect(() => buildExecutablePaperQuote({
      quote: curveQuote(), solUsd,
      costs: { ...costs, simulatedLatencyMs: 1_500 },
      nowMs: now
    })).toThrow(/expire before the simulated fill/);
  });

  it("rejects unsupported transfer-tax evidence and invalid fee estimates", () => {
    expect(() => buildExecutablePaperQuote({
      quote: { ...curveQuote(), transferTaxVerifiedZero: false } as PumpSdkCurveQuote,
      solUsd, costs, nowMs: now
    })).toThrow(/Transfer tax is not verified/);
    expect(() => buildExecutablePaperQuote({
      quote: curveQuote(), solUsd,
      costs: { ...costs, networkFeeLamports: "-1" },
      nowMs: now
    })).toThrow(/unsigned base-unit integer/);
  });
});
