import { describe, expect, it } from "vitest";
import type { PumpCreateEvent, PumpTradeEvent } from "../src/ingestion/pump-events.js";
import type { VerifiedPumpTransaction } from "../src/ingestion/helius.js";
import { buildCurvePriceProfiles } from "../src/ingestion/price-profile.js";
import { SOL_QUOTE_MINT } from "../src/ingestion/trade-flow.js";

const mint = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const trader = (n: number) => `wallet-${n}`;

function createEvent(): PumpCreateEvent {
  return {
    name: "Test", symbol: "TST", uri: "", mint, bondingCurve: trader(30),
    user: trader(31), creator: trader(32), timestamp: 100n,
    virtualTokenReserves: 100n, virtualSolReserves: 100n,
    realTokenReserves: 1n, tokenTotalSupply: 1n, tokenProgram: trader(33),
    isMayhemMode: false, isCashbackEnabled: false, quoteMint: SOL_QUOTE_MINT,
    virtualQuoteReserves: 0n, creatorFeeBps: 0n, isHolderReward: false, depth: 0
  };
}

function trade(timestamp: bigint, virtualSol: bigint, virtualToken: bigint, isBuy = true): PumpTradeEvent {
  return {
    mint, solAmount: 1_000_000n, tokenAmount: 1n, isBuy, user: trader(Number(timestamp) + (isBuy ? 1 : 80)),
    timestamp, virtualSolReserves: virtualSol, virtualTokenReserves: virtualToken,
    realSolReserves: 1n, realTokenReserves: 1n, feeRecipient: trader(90),
    feeBasisPoints: 0n, fee: 0n, creator: trader(32), creatorFeeBasisPoints: 0n,
    creatorFee: 0n, trackVolume: false, totalUnclaimedTokens: 0n, totalClaimedTokens: 0n,
    currentSolVolume: 0n, lastUpdateTimestamp: timestamp, ixName: isBuy ? "buy" : "sell",
    mayhemMode: false, cashbackFeeBasisPoints: 0n, cashback: 0n,
    buybackFeeBasisPoints: 0n, buybackFee: 0n, shareholders: [], quoteMint: SOL_QUOTE_MINT,
    quoteAmount: 1_000_000n, virtualQuoteReserves: 0n, realQuoteReserves: 0n,
    holderRewardsBps: 0n, holderRewards: 0n, creatorFeeUnclaimed: 0n
  };
}

function transaction(events: PumpTradeEvent[], includeCreate = true): VerifiedPumpTransaction {
  return {
    provider: "helius", commitment: "confirmed", signature: "5".repeat(88),
    slot: 1, mint, createEvents: includeCreate ? [createEvent()] : [],
    tradeEvents: events, receivedAt: "2026-11-12T00:00:00.000Z"
  };
}

describe("Pump.fun curve price profile", () => {
  it("measures impulse, pullback, and reclaim from reserve ratios without treating them as executable quotes", () => {
    const events = [
      trade(101n, 130n, 100n), // +30% impulse from launch ratio 1.0
      trade(102n, 110n, 100n), // 15.38% pullback from 1.3
      trade(105n, 115n, 100n), // previous completed 5-second candle high
      trade(111n, 117n, 100n)  // 1.73% above previous candle high
    ];
    const [profile] = buildCurvePriceProfiles([transaction(events)], { nowSeconds: 112 });
    expect(profile).toMatchObject({
      mint, quoteUnit: "SOL",
      source: "PUMP_CURVE_RESERVE_RATIO_NOT_EXECUTABLE_QUOTE",
      baselineAvailable: true, impulsePass: true, pullbackPass: true, reclaimPass: true,
      priceStructurePass: true, volumeProfileThresholdsConfigured: false,
      volumeProfileReady: false, entryEligible: false
    });
    expect(profile?.impulseChangeBps).toBe(3_000);
    expect(profile?.pullbackFromImpulseHighBps).toBeGreaterThanOrEqual(1_500);
    expect(profile?.pullbackFromImpulseHighBps).toBeLessThanOrEqual(1_600);
    expect(profile?.reclaimAbovePreviousFiveSecondHighBps).toBeGreaterThanOrEqual(100);
    expect(profile?.impulseBuyVolumeLamports).toBe("1000000");
    expect(profile?.pullbackBuyVolumeLamports).toBe("1000000");
    expect(profile?.reclaimBuyVolumeLamports).toBe("2000000");
  });

  it("does not claim price structure without a verified CreateEvent baseline", () => {
    const [profile] = buildCurvePriceProfiles([transaction([trade(101n, 130n, 100n)], false)], { nowSeconds: 102 });
    expect(profile?.baselineAvailable).toBe(false);
    expect(profile?.impulseChangeBps).toBeNull();
    expect(profile?.priceStructurePass).toBe(false);
    expect(profile?.entryEligible).toBe(false);
  });

  it("includes candidates with no verified trade events as missing evidence", () => {
    const [profile] = buildCurvePriceProfiles([], { nowSeconds: 112, candidateMints: [mint] });
    expect(profile).toMatchObject({
      mint, baselineAvailable: false, priceStructurePass: false,
      volumeProfileReady: false, entryEligible: false
    });
    expect(profile?.candles).toEqual([]);
  });
});
