import { describe, expect, it } from "vitest";
import type { PumpTradeEvent } from "../src/ingestion/pump-events.js";
import type { VerifiedPumpTransaction } from "../src/ingestion/helius.js";
import { buildCandidateTradeFlows, SOL_QUOTE_MINT } from "../src/ingestion/trade-flow.js";

const mint = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const trader = (n: number) => `wallet-${n}`;

function trade(timestamp: bigint, user: string, isBuy: boolean, quoteAmount: bigint, quoteMint = SOL_QUOTE_MINT): PumpTradeEvent {
  return {
    mint, solAmount: quoteAmount, tokenAmount: 1n, isBuy, user, timestamp,
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
  it("aggregates three consecutive two-second windows and applies the agreed flow filters", () => {
    const events = [
      trade(100n, trader(1), true, 10n), trade(100n, trader(2), true, 10n),
      trade(100n, trader(3), true, 10n), trade(100n, trader(80), false, 2n),
      trade(102n, trader(2), true, 10n), trade(102n, trader(3), true, 10n),
      trade(102n, trader(4), true, 10n), trade(102n, trader(81), false, 2n),
      trade(104n, trader(3), true, 10n), trade(104n, trader(4), true, 10n),
      trade(104n, trader(5), true, 10n), trade(104n, trader(82), false, 2n)
    ];
    const [flow] = buildCandidateTradeFlows([tx(events)], { nowSeconds: 106, horizonSeconds: 60 });
    expect(flow).toMatchObject({
      mint, quoteUnit: "SOL", latestThreeWindowFlowPass: true,
      distinctBuyersAcrossLatestThree: 5, flowConfirmationPass: true,
      dataComplete: true, entryEligible: false, coverage: "OBSERVED_EVENTS_ONLY"
    });
    expect(flow?.windows).toHaveLength(3);
    expect(flow?.windows[0]).toMatchObject({
      startTime: 100, uniqueBuyers: 3, uniqueSellers: 1,
      buyQuoteVolume: "30", sellQuoteVolume: "2", flowWindowPass: true
    });
  });

  it("does not treat missing two-second windows as zero-volume pass windows", () => {
    const events = [
      trade(100n, trader(1), true, 10n), trade(100n, trader(2), true, 10n), trade(100n, trader(3), true, 10n),
      trade(104n, trader(1), true, 10n), trade(104n, trader(2), true, 10n), trade(104n, trader(3), true, 10n),
      trade(106n, trader(1), true, 10n), trade(106n, trader(2), true, 10n), trade(106n, trader(3), true, 10n)
    ];
    const [flow] = buildCandidateTradeFlows([tx(events)], { nowSeconds: 108, horizonSeconds: 60 });
    expect(flow?.latestThreeWindowFlowPass).toBe(false);
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
    expect(flow?.dataComplete).toBe(false);
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
