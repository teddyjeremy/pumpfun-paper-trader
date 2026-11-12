import { describe, expect, it } from "vitest";
import type { PumpCreateEvent, PumpTradeEvent } from "../src/ingestion/pump-events.js";
import type { VerifiedPumpTransaction } from "../src/ingestion/helius.js";
import { evaluateCreatorSellRisk } from "../src/ingestion/creator-risk.js";
import { SOL_QUOTE_MINT } from "../src/ingestion/trade-flow.js";

const mint = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const creator = "wallet-91";

function createEvent(): PumpCreateEvent {
  return {
    name: "Test", symbol: "TST", uri: "https://example.invalid/metadata.json",
    mint, bondingCurve: "curve", user: "wallet-1", creator, timestamp: 100n,
    virtualTokenReserves: 1n, virtualSolReserves: 1n, realTokenReserves: 1n,
    tokenTotalSupply: 1_000_000n, tokenProgram: "token-program",
    isMayhemMode: false, isCashbackEnabled: false, quoteMint: SOL_QUOTE_MINT,
    virtualQuoteReserves: 0n, creatorFeeBps: 0n, isHolderReward: false, depth: 0
  };
}

function trade(user: string, tokenAmount: bigint): PumpTradeEvent {
  return {
    mint, solAmount: 1n, tokenAmount, isBuy: false, user, timestamp: 120n,
    virtualSolReserves: 1n, virtualTokenReserves: 1n, realSolReserves: 1n,
    realTokenReserves: 1n, feeRecipient: "fee", feeBasisPoints: 0n, fee: 0n,
    creator, creatorFeeBasisPoints: 0n, creatorFee: 0n, trackVolume: false,
    totalUnclaimedTokens: 0n, totalClaimedTokens: 0n, currentSolVolume: 0n,
    lastUpdateTimestamp: 120n, ixName: "sell", mayhemMode: false,
    cashbackFeeBasisPoints: 0n, cashback: 0n, buybackFeeBasisPoints: 0n,
    buybackFee: 0n, shareholders: [], quoteMint: SOL_QUOTE_MINT,
    quoteAmount: 1n, virtualQuoteReserves: 0n, realQuoteReserves: 0n,
    holderRewardsBps: 0n, holderRewards: 0n, creatorFeeUnclaimed: 0n
  };
}

function transaction(createEvents: PumpCreateEvent[], tradeEvents: PumpTradeEvent[]): VerifiedPumpTransaction {
  return {
    provider: "helius", commitment: "confirmed", signature: "5".repeat(88),
    slot: 1, mint, createEvents, tradeEvents, receivedAt: "2026-11-12T00:00:00.000Z"
  };
}

describe("direct creator sell screening", () => {
  it("rejects an observed creator sale strictly above 0.05% of supply, even with partial coverage", () => {
    const result = evaluateCreatorSellRisk(
      [transaction([createEvent()], [trade(creator, 501n)])],
      { nowSeconds: 160, incompleteMints: [mint] }
    );
    expect(result[0]).toMatchObject({
      mint, creator, creatorSellTokenAmount: "501",
      status: "REJECT_OBSERVED", rejectThresholdBps: 5
    });
  });

  it("allows exactly 0.05% when the complete first 60 seconds were covered", () => {
    const result = evaluateCreatorSellRisk(
      [transaction([createEvent()], [trade(creator, 500n)])],
      { nowSeconds: 160, coverageStartByMint: { [mint]: 100 } }
    );
    expect(result[0]).toMatchObject({
      creatorSellTokenAmount: "500", creatorSellShareBps: 5,
      status: "PASS_COMPLETE"
    });
  });

  it("does not clear creator risk when monitoring began after launch", () => {
    const result = evaluateCreatorSellRisk(
      [transaction([createEvent()], [])],
      { nowSeconds: 160, coverageStartByMint: { [mint]: 102 } }
    );
    expect(result[0]?.status).toBe("UNKNOWN");
  });

  it("keeps the check pending until the first 60 seconds have elapsed", () => {
    const result = evaluateCreatorSellRisk(
      [transaction([createEvent()], [])],
      { nowSeconds: 159, coverageStartByMint: { [mint]: 100 } }
    );
    expect(result[0]?.status).toBe("PENDING");
  });

  it("excludes a sale exactly at the 60-second boundary", () => {
    const boundarySale = { ...trade(creator, 10_000n), timestamp: 160n };
    const result = evaluateCreatorSellRisk(
      [transaction([createEvent()], [boundarySale])],
      { nowSeconds: 160, coverageStartByMint: { [mint]: 100 } }
    );
    expect(result[0]).toMatchObject({
      creatorSellTokenAmount: "0", status: "PASS_COMPLETE"
    });
  });

  it("does not attribute another wallet's sale to the creator", () => {
    const result = evaluateCreatorSellRisk(
      [transaction([createEvent()], [trade("wallet-2", 10_000n)])],
      { nowSeconds: 160, coverageStartByMint: { [mint]: 100 } }
    );
    expect(result[0]).toMatchObject({
      creatorSellTokenAmount: "0", creatorSellShareBps: 0,
      status: "PASS_COMPLETE"
    });
  });

  it("reports unknown when the verified create event or supply is unavailable", () => {
    const result = evaluateCreatorSellRisk([], {
      nowSeconds: 160, candidateMints: [mint]
    });
    expect(result[0]).toMatchObject({
      mint, creator: null, tokenTotalSupply: null, status: "UNKNOWN"
    });
  });
});
