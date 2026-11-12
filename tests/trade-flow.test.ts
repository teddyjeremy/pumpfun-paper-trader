import { describe, expect, it } from "vitest";
import type { PumpTradeEvent } from "../src/ingestion/pump-events.js";
import type { VerifiedPumpTransaction } from "../src/ingestion/helius.js";
import { buildCandidateTradeFlows, isSolQuoteMint, LEGACY_SOL_QUOTE_MINT, SOL_QUOTE_MINT } from "../src/ingestion/trade-flow.js";

const mint = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const trader = (n: number) => `wallet-${n}`;

function trade(timestamp: bigint, user: string, isBuy: boolean, quoteAmount: bigint, quoteMint = SOL_QUOTE_MINT): PumpTradeEvent {
  return {
    mint, solAmount: isSolQuoteMint(quoteMint) ? quoteAmount : 9_999n, tokenAmount: 1n, isBuy, user, timestamp,
    virtualSolReserves: 1n, virtualTokenReserves: 1n, realSolReserves: 1n, realTokenReserves: 1n,
    feeRecipient: trader(90), feeBasisPoints: 0n, fee: 0n, creator: trader(91),
    creatorFeeBasisPoints: 0n, creatorFee: 0n, trackVolume: false, totalUnclaimedTokens: 0n,
    totalClaimedTokens: 0n, currentSolVolume: 0n, lastUpdateTimestamp: timestamp,
    ixName: isBuy ? "buy" : "sell", mayhemMode: false, cashbackFeeBasisPoints: 0n,
    cashback: 0n, buybackFeeBasisPoints: 0n, buybackFee: 0n, shareholders: [],
    quoteMint, quoteAmount, virtualQuoteReserves: 0n, realQuoteReserves: 0n,
    holderRewardsBps: 0n, holderRewards: 0n, creatorFeeUnclaimed: 0n
  };
}

function tx(events: PumpTradeEvent[]): VerifiedPumpTransaction {
  return {
    provider: "helius", commitment: "confirmed", signature: "5".repeat(88),
    slot: 1, mint, createEvents: [], tradeEvents: events, receivedAt: "2026-11-12T00:00:00.000Z"
  };
}

describe("verified Pump.fun trade-flow windows", () => {
  it("recognizes the canonical wrapped-SOL quote mint", () => {
    expect(SOL_QUOTE_MINT).toBe("So11111111111111111111111111111111111111112");
    expect(LEGACY_SOL_QUOTE_MINT).toBe("11111111111111111111111111111111");
    expect(isSolQuoteMint(LEGACY_SOL_QUOTE_MINT)).toBe(true);
    expect(isSolQuoteMint(SOL_QUOTE_MINT)).toBe(true);
    expect(isSolQuoteMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(false);
  });

  it("applies SOL/USD and micro-trade filtering to legacy default-key SOL quote events", () => {
    const events = [100n, 102n, 104n].flatMap((timestamp, i) => [
      trade(timestamp, trader(i * 3 + 1), true, 100_000_000n, LEGACY_SOL_QUOTE_MINT),
      trade(timestamp, trader(i * 3 + 2), true, 100_000_000n, LEGACY_SOL_QUOTE_MINT),
      trade(timestamp, trader(i * 3 + 3), true, 100_000_000n, LEGACY_SOL_QUOTE_MINT),
      trade(timestamp, trader(80 + i), false, 10_000_000n, LEGACY_SOL_QUOTE_MINT)
    ]);
    const [flow] = buildCandidateTradeFlows([tx(events)], {
      solUsdPriceUsd: 100, minimumTradeUsd: 0.01, nowSeconds: 106, horizonSeconds: 60
    });
    expect(flow).toMatchObject({
      quoteUnit: "SOL", microTradeFilterStatus: "APPLIED",
      latestThreeWindowFlowPass: true, dataComplete: true
    });
  });

  it("aggregates three overlapping two-second windows sampled one second apart", () => {
    const events = [
      trade(100n, trader(1), true, 10n), trade(100n, trader(2), true, 10n),
      trade(100n, trader(3), true, 10n), trade(100n, trader(80), false, 2n),
      trade(102n, trader(2), true, 10n), trade(102n, trader(3), true, 10n),
      trade(102n, trader(4), true, 10n), trade(102n, trader(81), false, 2n),
      trade(104n, trader(3), true, 10n), trade(104n, trader(4), true, 10n),
      trade(104n, trader(5), true, 10n), trade(104n, trader(6), true, 10n),
      trade(104n, trader(82), false, 2n)
    ];
    const [flow] = buildCandidateTradeFlows([tx(events)], { solUsdPriceUsd: 100, minimumTradeUsd: 0, nowSeconds: 106, horizonSeconds: 60 });
    expect(flow).toMatchObject({
      mint, quoteUnit: "SOL", latestThreeWindowFlowPass: true,
      distinctBuyersAcrossLatestThree: 5, flowConfirmationPass: true,
      dataComplete: true, entryEligible: false, coverage: "OBSERVED_EVENTS_ONLY"
    });
    expect(flow?.sampleIntervalSeconds).toBe(1);
    expect(flow?.windows).toHaveLength(6);
    expect(flow?.windows[0]).toMatchObject({
      startTime: 99, uniqueBuyers: 3, uniqueSellers: 1,
      buyQuoteVolume: "30", sellQuoteVolume: "2", flowWindowPass: true
    });
  });

  it("rejects a buy/sell ratio equal to exactly 3:1 because the rule is strict", () => {
    const events = [100n, 102n, 104n].flatMap(timestamp => [
      trade(timestamp, trader(1), true, 10n), trade(timestamp, trader(2), true, 10n),
      trade(timestamp, trader(3), true, 10n), trade(timestamp, trader(80), false, 10n)
    ]);
    const [flow] = buildCandidateTradeFlows([tx(events)], { nowSeconds: 106, horizonSeconds: 60 });
    expect(flow?.latestThreeWindowFlowPass).toBe(false);
    expect(flow?.flowConfirmationPass).toBe(false);
  });

  it("rejects three-window flow when one buyer exceeds 72% of total buy volume", () => {
    const events = [
      trade(100n, trader(1), true, 8n), trade(100n, trader(2), true, 1n),
      trade(100n, trader(3), true, 1n), trade(100n, trader(80), false, 1n),
      trade(102n, trader(1), true, 8n), trade(102n, trader(4), true, 1n),
      trade(102n, trader(5), true, 1n), trade(102n, trader(81), false, 1n),
      trade(104n, trader(1), true, 8n), trade(104n, trader(6), true, 1n),
      trade(104n, trader(7), true, 1n), trade(104n, trader(82), false, 1n)
    ];
    const [flow] = buildCandidateTradeFlows([tx(events)], { nowSeconds: 106, horizonSeconds: 60 });
    expect(flow?.latestThreeWindowFlowPass).toBe(true);
    expect(flow?.distinctBuyersAcrossLatestThree).toBe(5);
    expect(flow?.largestBuyerShareAcrossLatestThreeBps).toBe(8_000);
    expect(flow?.flowConfirmationPass).toBe(false);
  });

  it("does not treat missing two-second windows as zero-volume pass windows", () => {
    const events = [
      trade(100n, trader(1), true, 10n), trade(100n, trader(2), true, 10n), trade(100n, trader(3), true, 10n),
      trade(106n, trader(1), true, 10n), trade(106n, trader(2), true, 10n), trade(106n, trader(3), true, 10n)
    ];
    const [flow] = buildCandidateTradeFlows([tx(events)], { nowSeconds: 108, horizonSeconds: 60 });
    expect(flow?.latestThreeWindowFlowPass).toBe(false);
    expect(flow?.dataComplete).toBe(false);
    expect(flow?.flowConfirmationPass).toBe(false);
  });

  it("does not treat old but consecutive windows as current flow confirmation", () => {
    const events = [
      trade(100n, trader(1), true, 10n), trade(100n, trader(2), true, 10n), trade(100n, trader(3), true, 10n),
      trade(102n, trader(2), true, 10n), trade(102n, trader(3), true, 10n), trade(102n, trader(4), true, 10n),
      trade(104n, trader(3), true, 10n), trade(104n, trader(4), true, 10n), trade(104n, trader(5), true, 10n)
    ];
    const [flow] = buildCandidateTradeFlows([tx(events)], { nowSeconds: 110, horizonSeconds: 60 });
    expect(flow?.latestThreeWindowFlowPass).toBe(true);
    expect(flow?.dataComplete).toBe(false);
    expect(flow?.flowConfirmationPass).toBe(false);
  });

  it("marks a candidate incomplete when its Helius stream has known data gaps", () => {
    const events = [
      trade(100n, trader(1), true, 10n), trade(100n, trader(2), true, 10n), trade(100n, trader(3), true, 10n)
    ];
    const [flow] = buildCandidateTradeFlows([tx(events)], {
      nowSeconds: 102, horizonSeconds: 60, incompleteMints: [mint]
    });
    expect(flow?.dataComplete).toBe(false);
  });

  it("never confirms flow when the candidate has a known data gap", () => {
    const events = [
      trade(100n, trader(1), true, 10n), trade(100n, trader(2), true, 10n), trade(100n, trader(3), true, 10n),
      trade(102n, trader(2), true, 10n), trade(102n, trader(3), true, 10n), trade(102n, trader(4), true, 10n),
      trade(104n, trader(3), true, 10n), trade(104n, trader(4), true, 10n), trade(104n, trader(5), true, 10n)
    ];
    const [flow] = buildCandidateTradeFlows([tx(events)], {
      nowSeconds: 106, horizonSeconds: 60, incompleteMints: [mint]
    });
    expect(flow?.latestThreeWindowFlowPass).toBe(true);
    expect(flow?.dataComplete).toBe(false);
    expect(flow?.flowConfirmationPass).toBe(false);
  });

  it("requires three complete windows to start after subscription confirmation", () => {
    const events = [
      trade(100n, trader(1), true, 10n), trade(100n, trader(2), true, 10n), trade(100n, trader(3), true, 10n),
      trade(102n, trader(2), true, 10n), trade(102n, trader(3), true, 10n), trade(102n, trader(4), true, 10n),
      trade(104n, trader(3), true, 10n), trade(104n, trader(4), true, 10n), trade(104n, trader(5), true, 10n)
    ];
    const [flow] = buildCandidateTradeFlows([tx(events)], {
      nowSeconds: 106, horizonSeconds: 60, coverageStartByMint: { [mint]: 101 }
    });
    expect(flow?.dataComplete).toBe(true);
    expect(flow?.flowConfirmationPass).toBe(true);
  });

  it("reports discovered candidates with no verified trades as unobserved, not zero-flow", () => {
    const [flow] = buildCandidateTradeFlows([], { solUsdPriceUsd: 100, minimumTradeUsd: 0,
      nowSeconds: 108, horizonSeconds: 60, candidateMints: [mint]
    });
    expect(flow).toMatchObject({
      mint, quoteMint: null, quoteUnit: "UNKNOWN", observedTradeEvents: 0, dataComplete: false,
      latestThreeWindowFlowPass: false, flowConfirmationPass: false,
      entryEligible: false
    });
    expect(flow?.windows).toEqual([]);
  });

  it("excludes trades worth one cent or less from flow and unique-buyer counts", () => {
    const events = [100n, 102n, 104n].flatMap((timestamp, window) => [
      trade(timestamp, trader(window * 3 + 1), true, 200_000n),
      trade(timestamp, trader(window * 3 + 2), true, 200_000n),
      trade(timestamp, trader(window * 3 + 3), true, 200_000n),
      trade(timestamp, trader(50 + window), false, 100_000n),
      trade(timestamp, trader(60 + window), true, 1n),
      trade(timestamp, trader(70 + window), false, 1n)
    ]);
    const [flow] = buildCandidateTradeFlows([tx(events)], {
      nowSeconds: 106, horizonSeconds: 60, solUsdPriceUsd: 100, minimumTradeUsd: 0.01
    });
    expect(flow?.microTradeFilterStatus).toBe("APPLIED");
    expect(flow?.ignoredMicroTradeCount).toBe(9);
    expect(flow?.ignoredMicroTradeQuoteVolume).toBe("300006");
    expect(flow?.windows[0]).toMatchObject({
      tradeCount: 3, uniqueBuyers: 3, uniqueSellers: 0,
      buyQuoteVolume: "600000", sellQuoteVolume: "0", flowWindowPass: true
    });
    expect(flow?.flowConfirmationPass).toBe(true);
  });

  it("fails closed when SOL/USD is unavailable for the one-cent spam filter", () => {
    const events = [100n, 102n, 104n].flatMap(timestamp => [
      trade(timestamp, trader(1), true, 200_000n),
      trade(timestamp, trader(2), true, 200_000n),
      trade(timestamp, trader(3), true, 200_000n)
    ]);
    const [flow] = buildCandidateTradeFlows([tx(events)], { nowSeconds: 106, horizonSeconds: 60 });
    expect(flow?.microTradeFilterStatus).toBe("UNAVAILABLE");
    expect(flow?.flowConfirmationPass).toBe(false);
  });

  it("keeps non-SOL quote mint amounts separate and raw", () => {
    const quoteMint = "TokenQuoteMint111111111111111111111111111";
    const events = [
      trade(100n, trader(1), true, 10n, quoteMint),
      trade(100n, trader(2), true, 10n, quoteMint),
      trade(100n, trader(3), true, 10n, quoteMint)
    ];
    const [flow] = buildCandidateTradeFlows([tx(events)], { nowSeconds: 102, horizonSeconds: 60 });
    expect(flow?.quoteUnit).toBe("NON_SOL_RAW");
    expect(flow?.windows[0]?.buyQuoteVolume).toBe("30");
  });
});
