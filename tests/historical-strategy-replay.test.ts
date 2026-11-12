import { describe, expect, it } from "vitest";
import type { PumpCreateEvent, PumpTradeEvent } from "../src/ingestion/pump-events.js";
import type { VerifiedPumpTransaction } from "../src/ingestion/helius.js";
import { calibrateVolumeThresholds, hydrateArchivedVerifiedTransaction, replayHistoricalCoin } from "../src/strategy/historical-replay.js";

const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const quoteMint = "So11111111111111111111111111111111111111112";
const key = "11111111111111111111111111111111";

function createEvent(): PumpCreateEvent {
  return {
    name: "Replay coin", symbol: "RPLY", uri: "https://example.invalid/metadata",
    mint, bondingCurve: key, user: key, creator: key, timestamp: 0n,
    virtualTokenReserves: 1_000_000_000_000n, virtualSolReserves: 1_000_000_000_000n,
    realTokenReserves: 1_000_000_000_000n, tokenTotalSupply: 1_000_000_000_000n,
    tokenProgram: key, isMayhemMode: false, isCashbackEnabled: false,
    quoteMint, virtualQuoteReserves: 1_000_000_000_000n, creatorFeeBps: 0n,
    isHolderReward: false, depth: 0
  };
}

function trade(timestamp: number, price: number, user: string, isBuy = true): PumpTradeEvent {
  const quoteReserves = BigInt(Math.round(price * 1_000_000_000_000));
  return {
    mint, solAmount: 1_000_000_000n, tokenAmount: 1_000_000n, isBuy, user,
    timestamp: BigInt(timestamp), virtualSolReserves: quoteReserves,
    virtualTokenReserves: 1_000_000_000_000n, realSolReserves: quoteReserves,
    realTokenReserves: 1_000_000_000_000n, feeRecipient: key,
    feeBasisPoints: 0n, fee: 0n, creator: key, creatorFeeBasisPoints: 0n,
    creatorFee: 0n, trackVolume: true, totalUnclaimedTokens: 0n,
    totalClaimedTokens: 0n, currentSolVolume: 0n, lastUpdateTimestamp: BigInt(timestamp),
    ixName: isBuy ? "buy" : "sell", mayhemMode: false,
    cashbackFeeBasisPoints: 0n, cashback: 0n, buybackFeeBasisPoints: 0n,
    buybackFee: 0n, shareholders: [], quoteMint, quoteAmount: 1_000_000_000n,
    virtualQuoteReserves: quoteReserves, realQuoteReserves: quoteReserves,
    holderRewardsBps: 0n, holderRewards: 0n, creatorFeeUnclaimed: 0n
  };
}

function verifiedTransaction(): VerifiedPumpTransaction {
  const trades: PumpTradeEvent[] = [
    trade(0, 1.0, "launch-buyer"),
    trade(5, 1.3, "impulse-buyer-1"),
    trade(5, 1.3, "impulse-buyer-2"),
    trade(5, 1.3, "impulse-buyer-3"),
    trade(10, 1.1, "pullback-buyer"),
    trade(15, 1.25, "reclaim-buyer-1"),
    trade(15, 1.25, "reclaim-buyer-2"),
    trade(15, 1.25, "reclaim-buyer-3"),
    trade(20, 1.3, "entry-confirmation"),
    ...[22, 23, 24].flatMap(second => [
      trade(second, 1.3, `flow-${second}-a`),
      trade(second, 1.3, `flow-${second}-b`),
      trade(second, 1.3, `flow-${second}-c`)
    ]),
    trade(30, 1.6, "later-buyer"),
    trade(35, 1.25, "later-seller", false),
    trade(40, 1.5, "final-buyer")
  ];
  return {
    provider: "helius", commitment: "confirmed", signature: "5".repeat(64),
    slot: 100, blockTime: 0, mint, createEvents: [createEvent()],
    tradeEvents: trades, receivedAt: "2026-11-12T00:00:00.000Z"
  };
}

describe("historical strategy replay", () => {
  it("replays impulse, pullback and reclaim volume before measuring the forward path", () => {
    const result = replayHistoricalCoin({
      mint, transactions: [verifiedTransaction()], launchBlockTime: 0,
      horizonSeconds: 600, decodeComplete: true
    }, {
      solUsdPriceUsd: 100, minimumTradeUsd: 0.01,
      label: { minFavorableExcursionPct: 20, maxAdverseExcursionPct: 15, roundTripCostPct: 4 }
    });

    expect(result.status).toBe("COMPLETE");
    expect(result.firstSetup).toMatchObject({
      setupEligible: true, reclaimDetected: true, dataComplete: true,
      flowConfirmationPass: true, distinctBuyersAcrossLatestThree: 9
    });
    expect(result.firstSetup!.pullbackVolumeVsImpulsePct).toBeGreaterThan(0);
    expect(result.firstSetup!.pullbackVolumeVsImpulsePct).toBeLessThan(100);
    expect(result.firstSetup!.reclaimVolumeVsPullbackPct).toBeGreaterThan(100);
    expect(result.outcome).toMatchObject({ label: "SUCCESS", roundTripCostPct: 4 });
    expect(result.outcome!.netFinalReturnPct).toBeCloseTo(11.3846, 1);
  });

  it("never promotes partial transaction decoding into an eligible setup or labelled outcome", () => {
    const result = replayHistoricalCoin({
      mint, transactions: [verifiedTransaction()], launchBlockTime: 0,
      horizonSeconds: 600, decodeComplete: false,
      decodeReason: "One historical signature exhausted transient retries."
    }, {
      solUsdPriceUsd: 100, minimumTradeUsd: 0.01,
      label: { minFavorableExcursionPct: 20, maxAdverseExcursionPct: 15 }
    });
    expect(result.status).toBe("INCOMPLETE");
    expect(result.decodeReason).toContain("exhausted");
    expect(result.firstSetup).toBeNull();
    expect(result.outcome).toBeNull();
    expect(result.snapshots.every(snapshot => !snapshot.setupEligible)).toBe(true);
  });

  it("refuses to recommend volume thresholds from a small sample", () => {
    const replay = replayHistoricalCoin({
      mint, transactions: [verifiedTransaction()], launchBlockTime: 0,
      decodeComplete: true
    }, {
      solUsdPriceUsd: 100,
      label: { minFavorableExcursionPct: 20, maxAdverseExcursionPct: 15 }
    });
    const calibration = calibrateVolumeThresholds([replay, replay, replay, replay]);
    expect(calibration.status).toBe("INSUFFICIENT_SAMPLE");
    expect(calibration.recommended).toBeNull();
  });
  it("hydrates JSON-safe archived base units back into bigint Pump event values", () => {
    const raw = JSON.parse(JSON.stringify({
      ...verifiedTransaction(), source: "HISTORICAL_BACKFILL"
    }, (_key, value) => typeof value === "bigint" ? value.toString() : value));
    const hydrated = hydrateArchivedVerifiedTransaction(raw);
    expect(hydrated.tradeEvents[0]!.timestamp).toBe(0n);
    expect(hydrated.tradeEvents[0]!.virtualSolReserves).toBe(1_000_000_000_000n);
    expect(hydrated.createEvents[0]!.virtualTokenReserves).toBe(1_000_000_000_000n);
  });

  it("rejects a transaction whose archived Pump event mint differs from its transaction mint", () => {
    const raw = JSON.parse(JSON.stringify({
      ...verifiedTransaction(), source: "HISTORICAL_BACKFILL"
    }, (_key, value) => typeof value === "bigint" ? value.toString() : value));
    raw.tradeEvents[0].mint = key;
    expect(() => hydrateArchivedVerifiedTransaction(raw)).toThrow(/mint does not match/);
  });

});
