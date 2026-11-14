import { describe, expect, it } from "vitest";
import type { PumpTradeEvent } from "../src/ingestion/pump-events.js";
import type { VerifiedPumpTransaction } from "../src/ingestion/helius.js";
import { simulateHistoricalProfitability } from "../src/strategy/historical-profitability.js";

const mint = "So11111111111111111111111111111111111111112";
function trade(at: number, price: number): PumpTradeEvent {
  const scale = 1_000_000_000n;
  return {
    mint, solAmount: 10_000_000n, tokenAmount: 10_000_000n,
    isBuy: true, user: `wallet-${at}`, timestamp: BigInt(at),
    virtualSolReserves: BigInt(Math.round(price * 1_000_000_000)) * scale / 1_000_000_000n,
    virtualTokenReserves: scale, realSolReserves: 50n * scale,
    realTokenReserves: scale, feeRecipient: "fee", feeBasisPoints: 100n,
    fee: 1n, creator: "creator", creatorFeeBasisPoints: 100n, creatorFee: 1n,
    trackVolume: true, totalUnclaimedTokens: 0n, totalClaimedTokens: 0n,
    currentSolVolume: 0n, lastUpdateTimestamp: BigInt(at), ixName: "buy",
    mayhemMode: false, cashbackFeeBasisPoints: 0n, cashback: 0n,
    buybackFeeBasisPoints: 0n, buybackFee: 0n, shareholders: [],
    quoteMint: "So11111111111111111111111111111111111111112",
    quoteAmount: 10_000_000n, virtualQuoteReserves: 0n,
    realQuoteReserves: 0n, holderRewardsBps: 0n, holderRewards: 0n,
    creatorFeeUnclaimed: 0n
  };
}
function tx(events: PumpTradeEvent[]): VerifiedPumpTransaction {
  return {
    provider: "helius", commitment: "finalized",
    signature: "1".repeat(64), slot: 1, blockTime: 100,
    mint: events[0]!.mint, createEvents: [], tradeEvents: events,
    receivedAt: "2026-11-14T00:00:00.000Z"
  };
}
describe("historical profitability replay", () => {
  it("applies round-trip costs and exits when the net hard stop is crossed", () => {
    const result = simulateHistoricalProfitability({
      mint, transactions: [tx([trade(100, 1), trade(101, 0.9), trade(102, 0.88)])],
      entryAt: 100, entryPriceQuotePerToken: 1, horizonSeconds: 600,
      roundTripCostPct: 4, riskStatus: "UNKNOWN"
    });
    expect(result.status).toBe("CLOSED_BY_STRATEGY");
    expect(result.exitAt).toBe(101);
    expect(result.exitReason).toBe("hard_stop");
    expect(result.modeledNetReturnPct).toBeLessThan(-5);
    expect(result.modeledPnlUsdOnOneDollar).toBeLessThan(0);
    expect(result.riskEvidence).toBe("UNVERIFIED");
    expect(result.executionEvidence).toBe("RESERVE_PRICE_PROXY_NOT_EXECUTABLE");
  });
  it("keeps a position open when no configured exit is observed by the horizon", () => {
    const result = simulateHistoricalProfitability({
      mint, transactions: [tx([trade(100, 1), trade(101, 1.2), trade(102, 1.15)])],
      entryAt: 100, entryPriceQuotePerToken: 1, horizonSeconds: 60,
      roundTripCostPct: 4, riskStatus: "CLEARED"
    });
    expect(result.status).toBe("OPEN_AT_HORIZON");
    expect(result.exitAt).toBeNull();
    expect(result.modeledNetReturnPct).toBeGreaterThan(0);
  });
  it("rejects a modeled round-trip haircut above the live paper policy ceiling", () => {
    const result = simulateHistoricalProfitability({
      mint, transactions: [tx([trade(100, 1), trade(101, 0.9)])],
      entryAt: 100, entryPriceQuotePerToken: 1, roundTripCostPct: 5,
      riskCleared: true
    });
    expect(result.status).toBe("INVALID_INPUT");
  });
});
