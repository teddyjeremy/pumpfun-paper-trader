import { describe, expect, it } from "vitest";
import type { PumpTradeEvent } from "../src/ingestion/pump-events.js";
import type { VerifiedPumpTransaction } from "../src/ingestion/helius.js";
import { evaluateWalletClusterRisk } from "../src/ingestion/wallet-cluster-risk.js";

const mint = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const creator = "creator-wallet";
function trade(user: string, isBuy: boolean, quoteAmount: bigint, tokenAmount = 0n): PumpTradeEvent {
  return {
    mint, solAmount: quoteAmount, tokenAmount, isBuy, user, timestamp: 120n,
    virtualSolReserves: 1n, virtualTokenReserves: 1n, realSolReserves: 1n,
    realTokenReserves: 1n, feeRecipient: "fee", feeBasisPoints: 0n, fee: 0n,
    creator, creatorFeeBasisPoints: 0n, creatorFee: 0n, trackVolume: false,
    totalUnclaimedTokens: 0n, totalClaimedTokens: 0n, currentSolVolume: 0n,
    lastUpdateTimestamp: 120n, ixName: isBuy ? "buy" : "sell", mayhemMode: false,
    cashbackFeeBasisPoints: 0n, cashback: 0n, buybackFeeBasisPoints: 0n,
    buybackFee: 0n, shareholders: [], quoteMint: "11111111111111111111111111111111",
    quoteAmount, virtualQuoteReserves: 0n, realQuoteReserves: 0n,
    holderRewardsBps: 0n, holderRewards: 0n, creatorFeeUnclaimed: 0n
  };
}
function tx(tradeEvents: PumpTradeEvent[]): VerifiedPumpTransaction {
  return { provider: "helius", commitment: "confirmed", signature: "5".repeat(88), slot: 1,
    mint, createEvents: [], tradeEvents, receivedAt: "2026-11-12T00:00:00.000Z" };
}
const link = (a: string, b: string, confidenceBps = 7_000) => ({
  mint, walletA: a, walletB: b, confidenceBps,
  evidence: ["COMMON_FUNDER" as const], observedAt: "2026-11-12T00:00:00.000Z"
});

describe("wallet cluster risk", () => {
  it("keeps missing linkage evidence at WATCH, never PASS", () => {
    expect(evaluateWalletClusterRisk([], { mint, creator, totalSupply: "100000" }).status).toBe("WATCH");
  });
  it("does not form clusters from evidence below 70% confidence", () => {
    const result = evaluateWalletClusterRisk([], { mint, creator, totalSupply: "100000", links: [link(creator, "w1", 6_999)] });
    expect(result.attributionStatus).toBe("INVALID_EVIDENCE");
    expect(result.status).toBe("WATCH");
  });
  it("rejects creator-linked wallet sells strictly above 0.25% supply", () => {
    const result = evaluateWalletClusterRisk([tx([trade("w1", false, 1n, 251n)])], {
      mint, creator, totalSupply: "100000", links: [link(creator, "w1")]
    });
    expect(result.status).toBe("REJECT_OBSERVED");
    expect(result.linkedWalletSellShareBps).toBe(26);
  });

  it("rejects any high-confidence linked cluster selling more than 0.25% supply", () => {
    const result = evaluateWalletClusterRisk([tx([trade("w2", false, 1n, 251n)])], {
      mint, creator: "unlinked-creator", totalSupply: "100000",
      links: [link("w1", "w2")]
    });
    expect(result.status).toBe("REJECT_OBSERVED");
    expect(result.largestLinkedClusterSellShareBps).toBe(26);
  });
  it("rejects a linked cluster responsible for more than 35% of buy volume", () => {
    const result = evaluateWalletClusterRisk([tx([
      trade("w1", true, 36n), trade("independent", true, 64n)
    ])], { mint, creator, totalSupply: "100000", links: [link("w1", "w2")] });
    expect(result.status).toBe("REJECT_OBSERVED");
    expect(result.largestClusterBuyVolumeShareBps).toBe(3_600);
  });

  it("does not let large unrelated quote-mint volume hide a cluster's concentrated SOL buys", () => {
    const sol = "So11111111111111111111111111111111111111112";
    const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const solClusterBuy = { ...trade("w1", true, 40n), quoteMint: sol };
    const solOtherBuy = { ...trade("independent-sol", true, 60n), quoteMint: sol };
    const usdcBuy = { ...trade("independent-usdc", true, 10_000n), quoteMint: usdc };
    const result = evaluateWalletClusterRisk([tx([
      solClusterBuy, solOtherBuy, usdcBuy
    ])], { mint, creator, totalSupply: "100000", links: [link("w1", "w2")] });
    expect(result.status).toBe("REJECT_OBSERVED");
    expect(result.largestClusterBuyVolumeShareBps).toBe(4_000);
  });
  it("rejects a linked cluster holding strictly more than 20% supply", () => {
    const result = evaluateWalletClusterRisk([], {
      mint, creator, totalSupply: "100000", links: [link("w1", "w2")],
      holdings: [{ mint, wallet: "w1", amount: "11000" }, { mint, wallet: "w2", amount: "10000" }]
    });
    expect(result.status).toBe("REJECT_OBSERVED");
    expect(result.largestClusterHoldingShareBps).toBe(2_100);
  });

  it("rejects an observed individual wallet above 20% even without cluster links", () => {
    const result = evaluateWalletClusterRisk([], {
      mint, creator, totalSupply: "100000",
      holdings: [{ mint, wallet: "large-holder", amount: "20001" }]
    });
    expect(result.status).toBe("REJECT_OBSERVED");
    expect(result.largestIndividualHolderShareBps).toBe(2_001);
    expect(result.attributionStatus).toBe("NO_HIGH_CONFIDENCE_LINKS");
  });
  it("does not reject exactly 35% buy volume or exactly 20% holdings", () => {
    const result = evaluateWalletClusterRisk([tx([trade("w1", true, 35n), trade("other", true, 65n)])], {
      mint, creator, totalSupply: "100000", links: [link("w1", "w2")],
      holdings: [{ mint, wallet: "w1", amount: "10000" }, { mint, wallet: "w2", amount: "10000" }]
    });
    expect(result.status).toBe("WATCH");
  });
});
