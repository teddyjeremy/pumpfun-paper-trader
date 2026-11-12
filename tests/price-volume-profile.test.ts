import { describe, expect, it } from "vitest";
import type { PumpTradeEvent } from "../src/ingestion/pump-events.js";
import type { VerifiedPumpTransaction } from "../src/ingestion/helius.js";
import { buildCandidatePriceVolumeProfiles } from "../src/ingestion/price-volume-profile.js";
import { SOL_QUOTE_MINT } from "../src/ingestion/trade-flow.js";

const mint = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";

function trade(timestamp: bigint, price: bigint, isBuy = true): PumpTradeEvent {
  const tokenAmount = 1_000n;
  return {
    mint, solAmount: price, tokenAmount, isBuy, user: `wallet-${timestamp}`, timestamp,
    virtualSolReserves: 1n, virtualTokenReserves: 1n, realSolReserves: 1n, realTokenReserves: 1n,
    feeRecipient: "fee", feeBasisPoints: 0n, fee: 0n, creator: "creator",
    creatorFeeBasisPoints: 0n, creatorFee: 0n, trackVolume: false,
    totalUnclaimedTokens: 0n, totalClaimedTokens: 0n, currentSolVolume: 0n,
    lastUpdateTimestamp: timestamp, ixName: isBuy ? "buy" : "sell", mayhemMode: false,
    cashbackFeeBasisPoints: 0n, cashback: 0n, buybackFeeBasisPoints: 0n,
    buybackFee: 0n, shareholders: [], quoteMint: SOL_QUOTE_MINT,
    quoteAmount: price, virtualQuoteReserves: 0n, realQuoteReserves: 0n,
    holderRewardsBps: 0n, holderRewards: 0n, creatorFeeUnclaimed: 0n
  };
}

function transaction(tradeEvents: PumpTradeEvent[]): VerifiedPumpTransaction {
  return {
    provider: "helius", commitment: "confirmed", signature: "5".repeat(88),
    slot: 1, mint, createEvents: [], tradeEvents, receivedAt: "2026-11-12T00:00:00.000Z"
  };
}

describe("observed price and stage-volume profile", () => {
  it("reports impulse, pullback, reclaim and quote volume for each stage", () => {
    const [profile] = buildCandidatePriceVolumeProfiles([
      transaction([
        trade(100n, 1_000n),   // baseline 1.00
        trade(105n, 1_250n),   // +25% impulse
        trade(110n, 1_100n),   // 12% pullback
        trade(115n, 1_050n),   // 16% pullback low
        trade(120n, 1_200n)    // reclaim above previous 5s high
      ])
    ], { nowSeconds: 125, horizonSeconds: 60, candidateMints: [mint] });

    expect(profile).toMatchObject({
      mint, quoteUnit: "SOL", profileStatus: "RECLAIM_DETECTED",
      impulsePriceChangePct: 25, reclaimDetected: true,
      entryEligible: false, coverage: "OBSERVED_EVENTS_ONLY",
      coverageStatus: "UNKNOWN", dataComplete: false
    });
    expect(profile?.pullbackPct).toBeCloseTo(16, 6);
    expect(profile?.reclaimAbovePreviousFiveSecondHighPct).toBeGreaterThan(1);
    expect(profile?.impulseVolume.totalQuoteVolume).toBe("2250");
    expect(profile?.pullbackVolume.totalQuoteVolume).toBe("2150");
    expect(profile?.reclaimVolume.totalQuoteVolume).toBe("1200");
    expect(profile?.pullbackVolumeVsImpulsePct).toBe(95.56);
    expect(profile?.reclaimVolumeVsPullbackPct).toBe(55.81);
  });

  it("does not call a greater-than-40% drawdown a valid pullback", () => {
    const [profile] = buildCandidatePriceVolumeProfiles([
      transaction([
        trade(100n, 1_000n), trade(105n, 1_250n),
        trade(110n, 700n), trade(115n, 650n)
      ])
    ], { nowSeconds: 120, horizonSeconds: 60 });
    expect(profile?.profileStatus).toBe("PULLBACK_TOO_DEEP");
    expect(profile?.reclaimDetected).toBe(false);
  });

  it("keeps the profile incomplete when launch coverage is not established", () => {
    const [profile] = buildCandidatePriceVolumeProfiles([
      transaction([trade(100n, 1_000n), trade(105n, 1_250n)])
    ], { nowSeconds: 110, horizonSeconds: 60, coverageStartByMint: { [mint]: 101 } });
    expect(profile?.coverageStatus).toBe("UNKNOWN");
    expect(profile?.dataComplete).toBe(false);
    expect(profile?.entryEligible).toBe(false);
  });

  it("reports a candidate with no verified trades as unobserved, not zero-volume", () => {
    const [profile] = buildCandidatePriceVolumeProfiles([], {
      nowSeconds: 120, horizonSeconds: 60, candidateMints: [mint]
    });
    expect(profile).toMatchObject({
      mint, profileStatus: "NO_VERIFIED_TRADES",
      coverageStatus: "UNKNOWN", dataComplete: false, entryEligible: false
    });
    expect(profile?.buckets).toEqual([]);
    expect(profile?.impulseVolume.totalQuoteVolume).toBe("0");
  });

  it("marks known provider gaps as gapped coverage", () => {
    const [profile] = buildCandidatePriceVolumeProfiles([
      transaction([trade(100n, 1_000n)])
    ], { nowSeconds: 105, horizonSeconds: 60, incompleteMints: [mint] });
    expect(profile?.coverageStatus).toBe("GAPPED");
    expect(profile?.dataComplete).toBe(false);
  });
});
