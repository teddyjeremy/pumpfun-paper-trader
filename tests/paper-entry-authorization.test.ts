import { describe, expect, it } from "vitest";
import { createPaperPortfolio, type ExecutablePaperQuote } from "../src/paper/portfolio.js";
import {
  authorizePaperEntryFromVerifiedPlan
} from "../src/ingestion/paper-entry-authorization.js";
import type { UnsignedInstructionFeeEvidence } from "../src/ingestion/solana-fee-estimator.js";

const now = "2026-11-13T12:00:00.000Z";
const nowMs = Date.parse(now);
const mint = "11111111111111111111111111111111";
const user = "11111111111111111111111111111111";

function quote(side: "BUY" | "SELL"): ExecutablePaperQuote {
  return {
    quoteId: `${side.toLowerCase()}-quote`, provider: "test-adapter",
    mint, side, observedAt: now, expiresAt: "2026-11-13T12:00:02.000Z",
    requestedUsd: 1, inputAmountBaseUnits: side === "BUY" ? "10000000" : "1000000",
    outputAmountBaseUnits: side === "BUY" ? "1000000" : "10000000",
    tokenDecimals: 6, outputUsd: side === "BUY" ? 1 : 0.993,
    priceImpactPct: 0.1, taxPct: 0.1,
    networkFeeUsd: 0.001, priorityFeeUsd: 0.001, providerFeeUsd: 0.001,
    protocolFeeUsd: 0.002, creatorFeeUsd: 0.001, poolFeeUsd: 0.001,
    transferFeeUsd: 0, routeId: "verified-route", executable: true
  };
}

function feeEvidence(side: "BUY" | "SELL", blockers = [
  "VIRTUAL_PAYER_BALANCE_NOT_VERIFIED",
  "PAPER_ENTRY_AUTHORIZATION_NOT_GRANTED",
  "ATA_RENT_RESERVE_NOT_YET_RECORDED_IN_PAPER_PORTFOLIO"
], rentReserveLamports: number | null = 2_000_000): UnsignedInstructionFeeEvidence {
  return {
    status: "AVAILABLE",
    messageSha256: (side === "BUY" ? "a" : "b").repeat(64),
    writableAccountKeys: [user], computeUnitLimit: 1_400_000,
    estimate: {
      provider: "helius-solana-rpc", commitment: "confirmed",
      networkFeeLamports: "5000", priorityFeeLamports: "1000",
      priorityFeeMicroLamportsPerCu: "1", computeUnitLimit: 1_400_000,
      feeMessageSha256: (side === "BUY" ? "a" : "b").repeat(64),
      sampleCount: 10, firstSampleSlot: 1, lastSampleSlot: 10,
      observedSlot: 10, observedAt: now, priorityPercentile: 75
    },
    planEvidence: {
      provider: "pump-sdk-4.3.1", venue: "PUMP_CURVE", side, mint, user,
      requiredAccountAddressesToVerify: [user], rentReserveLamports,
      executionReady: false, paperEntryAuthorized: false, blockers
    }
  };
}

function authorize(overrides: Partial<Parameters<typeof authorizePaperEntryFromVerifiedPlan>[0]> = {}) {
  return authorizePaperEntryFromVerifiedPlan({
    mint, portfolio: createPaperPortfolio(), buyQuote: quote("BUY"),
    sellQuote: quote("SELL"),
    exactFeeEvidence: { buy: feeEvidence("BUY"), sell: feeEvidence("SELL") },
    solUsdPriceUsd: 150, nowMs, ...overrides
  });
}

describe("portfolio-backed unsigned plan authorization", () => {
  it("authorizes only after both exact plans and the full fee/rent budget pass", () => {
    const result = authorize();
    expect(result.authorized).toBe(true);
    if (!result.authorized) return;
    expect(result.rentReserveUsd).toBeCloseTo(0.3, 8);
    expect(result.resolvedBlockers).toContain("VIRTUAL_PAYER_BALANCE_NOT_VERIFIED");
  });

  it("rejects when simulated cash cannot cover stake, both fee legs and refundable rent", () => {
    const portfolio = { ...createPaperPortfolio(), availableCashUsd: 1.01 };
    const result = authorize({ portfolio });
    expect(result.authorized).toBe(false);
    expect(result.reason).toMatch(/simulated payer\/portfolio budget check failed/i);
  });

  it("rejects every account blocker that the portfolio preview cannot resolve", () => {
    const buy = feeEvidence("BUY", ["BUYBACK_FEE_RECIPIENT_ACCOUNT_EXISTENCE_AND_STATE_NOT_VERIFIED"]);
    const result = authorize({
      exactFeeEvidence: { buy, sell: feeEvidence("SELL") }
    });
    expect(result.authorized).toBe(false);
    expect(result.reason).toMatch(/account prerequisites remain blocked/i);
  });

  it("rejects missing exact-message fee evidence", () => {
    const unavailable: UnsignedInstructionFeeEvidence = {
      status: "UNAVAILABLE", reason: "fee lookup failed", computeUnitLimit: 1_400_000
    };
    const result = authorize({
      exactFeeEvidence: { buy: unavailable, sell: feeEvidence("SELL") }
    });
    expect(result.authorized).toBe(false);
    expect(result.reason).toMatch(/both buy and exact-size sell/i);
  });

  it("rejects mismatched BUY and SELL plan identities", () => {
    const sell = feeEvidence("SELL");
    if (sell.status !== "AVAILABLE" || !sell.planEvidence) throw new Error("test fixture invalid");
    sell.planEvidence = { ...sell.planEvidence, venue: "PUMPSWAP" };
    const result = authorize({
      exactFeeEvidence: { buy: feeEvidence("BUY"), sell }
    });
    expect(result.authorized).toBe(false);
    expect(result.reason).toMatch(/plan identities/i);
  });

  it("rejects unknown rent instead of assuming it is free", () => {
    const result = authorize({
      exactFeeEvidence: {
        buy: feeEvidence("BUY", undefined, null),
        sell: feeEvidence("SELL", undefined, null)
      }
    });
    expect(result.authorized).toBe(false);
    expect(result.reason).toMatch(/rent reserve lamports/i);
  });
});
