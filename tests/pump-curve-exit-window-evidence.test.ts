import { describe, expect, it } from "vitest";
import type { VerifiedPumpTransaction } from "../src/ingestion/helius.js";
import type { PumpTradeEvent } from "../src/ingestion/pump-events.js";
import type { CandidateTradeFlow } from "../src/ingestion/trade-flow.js";
import type { PumpMarketState } from "../src/paper/pump-market-state.js";
import { buildPumpCurveExitWindowEvidence } from "../src/strategy/pump-curve-exit-window-evidence.js";

const MINT = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const QUOTE = "So11111111111111111111111111111111111111112";

function market(status: PumpMarketState["status"] = "LIVE_CURVE"): PumpMarketState {
  return {
    mint: MINT, status, updatedAt: "2026-11-13T08:00:00.000Z",
    curve: {
      source: "verified-pump-curve-account", verified: true, mint: MINT,
      curveAddress: "curve", quoteMint: QUOTE, complete: false, migrated: false,
      tokenReserveBaseUnits: "1000", quoteReserveBaseUnits: "1000",
      virtualTokenReservesBaseUnits: "1000", virtualQuoteReservesBaseUnits: "1000",
      realQuoteReservesBaseUnits: "500", tokenTotalSupplyBaseUnits: "10000",
      creatorFeeBps: "0", creatorFeeBaseUnits: "0", protocolFeesBaseUnits: "0",
      isMayhemMode: false, isCashbackCoin: false, slot: 100, observedAt: "2026-11-13T08:00:00.000Z"
    },
    pool: null, reason: "verified"
  };
}

function flow(overrides: Partial<CandidateTradeFlow> = {}): CandidateTradeFlow {
  return {
    mint: MINT, quoteMint: QUOTE, quoteUnit: "SOL", windowSeconds: 2,
    sampleIntervalSeconds: 1, horizonSeconds: 600,
    windows: [
      { startTime: 100, endTime: 102, tradeCount: 2, uniqueBuyers: 5, uniqueSellers: 1,
        buyQuoteVolume: "100", sellQuoteVolume: "10", largestBuyerShareBps: 4000,
        buySellRatio: 10, hasBuyVolume: true, hasSellVolume: true, flowWindowPass: true },
      { startTime: 101, endTime: 103, tradeCount: 2, uniqueBuyers: 3, uniqueSellers: 2,
        buyQuoteVolume: "60", sellQuoteVolume: "20", largestBuyerShareBps: 5000,
        buySellRatio: 3, hasBuyVolume: true, hasSellVolume: true, flowWindowPass: false },
      { startTime: 102, endTime: 104, tradeCount: 2, uniqueBuyers: 2, uniqueSellers: 3,
        buyQuoteVolume: "30", sellQuoteVolume: "40", largestBuyerShareBps: 6000,
        buySellRatio: 0.75, hasBuyVolume: true, hasSellVolume: true, flowWindowPass: false }
    ],
    observedTradeEvents: 4, latestThreeWindowFlowPass: false,
    distinctBuyersAcrossLatestThree: 5, largestBuyerShareAcrossLatestThreeBps: 6000,
    flowConfirmationPass: false, dataComplete: true, coverage: "OBSERVED_EVENTS_ONLY",
    entryEligible: false, microTradeFilterStatus: "APPLIED",
    ignoredMicroTradeCount: 0, ignoredMicroTradeQuoteVolume: "0",
    ...overrides
  };
}

function transaction(): VerifiedPumpTransaction {
  const events = [100.5, 101.5, 102.5, 103.5].map((timestamp, index) => ({
    mint: MINT, quoteMint: QUOTE, timestamp: BigInt(Math.floor(timestamp)),
    virtualQuoteReserves: BigInt(100 - index * 10),
    virtualTokenReserves: 1000n,
    realQuoteReserves: BigInt(500 - index * 25)
  } as unknown as PumpTradeEvent));
  return {
    provider: "helius", commitment: "confirmed", signature: "verified-signature",
    slot: 100, mint: MINT, createEvents: [], tradeEvents: events,
    receivedAt: "2026-11-13T08:00:00.000Z"
  };
}

describe("Pump curve exit-window evidence", () => {
  it("builds only the latest three complete consecutive 2-second windows", () => {
    const result = buildPumpCurveExitWindowEvidence({
      marketState: market(), flow: flow({ coverage: "VERIFIED_COMPLETE_EVENT_STREAM" }), transactions: [transaction()]
    });
    expect(result).toHaveLength(3);
    expect(result.every(window => window.complete && window.windowSeconds === 2)).toBe(true);
    expect(result[1]?.buyVolumeDeclinePct).toBe(40);
    expect(result[2]?.buyVolumeDeclinePct).toBe(50);
    expect(result[2]?.liquidityChangePct).toBe(-5.55);
  });

  it("does not treat observed-events-only flow as complete dynamic-exit evidence", () => {
    expect(flow().coverage).toBe("OBSERVED_EVENTS_ONLY");
    expect(buildPumpCurveExitWindowEvidence({
      marketState: market(), flow: flow(), transactions: [transaction()]
    })).toEqual([]);
  });

  it("does not reuse Pump curve flow as PumpSwap evidence after migration", () => {
    expect(buildPumpCurveExitWindowEvidence({
      marketState: market("MIGRATED_POOL_VERIFIED"),
      flow: flow(), transactions: [transaction()]
    })).toEqual([]);
  });

  it("keeps incomplete, gapped, or mismatched flow evidence unknown", () => {
    expect(buildPumpCurveExitWindowEvidence({
      marketState: market(), flow: flow({ coverage: "VERIFIED_COMPLETE_EVENT_STREAM", dataComplete: false }),
      transactions: [transaction()]
    })).toEqual([]);
    expect(buildPumpCurveExitWindowEvidence({
      marketState: market(),
      flow: flow({ coverage: "VERIFIED_COMPLETE_EVENT_STREAM", windows: [
        flow().windows[0]!, flow().windows[1]!,
        { ...flow().windows[2]!, startTime: 104, endTime: 106 }
      ] }),
      transactions: [transaction()]
    })).toEqual([]);
    expect(buildPumpCurveExitWindowEvidence({
      marketState: market(), flow: flow({ coverage: "VERIFIED_COMPLETE_EVENT_STREAM", quoteMint: "11111111111111111111111111111111" }),
      transactions: [transaction()]
    })).toEqual([]);
  });
});
