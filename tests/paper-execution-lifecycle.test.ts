import { describe, expect, it, vi } from "vitest";
import { createPaperPortfolio, openPaperPosition } from "../src/paper/portfolio.js";
import { executePaperEntry, type PaperEntryStrategyDecision } from "../src/paper/execution-lifecycle.js";
import type { PumpSdkCurveQuote } from "../src/ingestion/pump-sdk-curve-quote-adapter.js";

const now = Date.parse("2026-11-12T10:00:00.000Z");
const mint = "So11111111111111111111111111111111111111112";
const solUsd = { priceUsd: 100, observedAt: new Date(now - 100).toISOString() };
const costs = { networkFeeLamports: "0", priorityFeeLamports: "0", providerFeeUsd: 0, simulatedLatencyMs: 50 };

function quote(side: "BUY" | "SELL"): PumpSdkCurveQuote {
  return side === "BUY" ? {
    provider: "pump-sdk-4.3.1", venue: "PUMP_CURVE", side, mint,
    quoteMint: "11111111111111111111111111111111", slot: 12,
    observedAt: new Date(now - 100).toISOString(),
    inputAmountBaseUnits: "10000010", outputAmountBaseUnits: "1000000",
    grossQuoteAmountBaseUnits: "10000010", netQuoteAmountBaseUnits: "10000000",
    venueFeeBaseUnits: "10", priceImpactPct: 0.1, baseDecimals: 6, quoteDecimals: 9,
    transferTaxVerifiedZero: true, executionReady: false, blockers: []
  } : {
    provider: "pump-sdk-4.3.1", venue: "PUMP_CURVE", side, mint,
    quoteMint: "11111111111111111111111111111111", slot: 13,
    observedAt: new Date(now - 100).toISOString(),
    inputAmountBaseUnits: "1000000", outputAmountBaseUnits: "9890000",
    grossQuoteAmountBaseUnits: "9900000", netQuoteAmountBaseUnits: "9890000",
    venueFeeBaseUnits: "10000", priceImpactPct: 0.1, baseDecimals: 6, quoteDecimals: 9,
    transferTaxVerifiedZero: true, executionReady: false, blockers: []
  };
}

const approvedRules: PaperEntryStrategyDecision["rules"] = [
  "CANDIDATE_AGE", "IMPULSE", "PULLBACK", "RECLAIM", "THREE_FLOW_WINDOWS",
  "DISTINCT_BUYERS", "BUYER_CONCENTRATION", "CREATOR_SELL_RISK", "WALLET_CLUSTER_RISK",
  "ATTRIBUTION_CONFIDENCE", "PULLBACK_VOLUME_CONTRACTION", "RECLAIM_VOLUME_EXPANSION",
  "SIGNAL_FRESHNESS", "EXECUTABLE_QUOTE", "ROUND_TRIP_COST"
].map(rule => ({ rule, status: "PASS" }));

const approved: PaperEntryStrategyDecision = {
  decision: "BUY", buyAllowed: true, rules: approvedRules
};

describe("paper execution lifecycle", () => {
  it("does not request quotes or enter when strategy is WATCH", async () => {
    const quoteBuy = vi.fn();
    const quoteSell = vi.fn();
    const commitEntry = vi.fn();
    const result = await executePaperEntry({
      mint, positionId: "p1", occurredAt: new Date(now).toISOString(), nowMs: now,
      strategy: { decision: "WATCH", buyAllowed: false, rules: [{ rule: "missing", status: "UNKNOWN" }] },
      portfolio: createPaperPortfolio(), quoteBuy, quoteSell, commitEntry
    });
    expect(result.status).toBe("BLOCKED");
    expect(quoteBuy).not.toHaveBeenCalled();
    expect(quoteSell).not.toHaveBeenCalled();
    expect(commitEntry).not.toHaveBeenCalled();
  });

  it("blocks an apparently approved signal if any mandatory rule is UNKNOWN", async () => {
    const commitEntry = vi.fn();
    const result = await executePaperEntry({
      mint, positionId: "p1", occurredAt: new Date(now).toISOString(), nowMs: now,
      strategy: { ...approved, rules: approvedRules.map(rule =>
        rule.rule === "WALLET_CLUSTER_RISK" ? { ...rule, status: "UNKNOWN" as const } : rule
      ) },
      portfolio: createPaperPortfolio(),
      quoteBuy: vi.fn(), quoteSell: vi.fn(), commitEntry
    });
    expect(result.status).toBe("BLOCKED");
    expect(commitEntry).not.toHaveBeenCalled();
  });

  it("gets a buy quote and exact full-balance sell quote before committing the entry", async () => {
    let committed: ReturnType<typeof openPaperPosition> | null = null;
    const result = await executePaperEntry({
      mint, positionId: "p1", occurredAt: new Date(now).toISOString(), nowMs: now,
      strategy: approved, portfolio: createPaperPortfolio(),
      quoteBuy: async ({ stakeUsd }) => {
        expect(stakeUsd).toBe(1);
        return { quote: quote("BUY"), context: { solUsd, costs } };
      },
      quoteSell: async ({ tokenAmountBaseUnits }) => {
        expect(tokenAmountBaseUnits).toBe("1000000");
        return { quote: quote("SELL"), context: { solUsd, costs } };
      },
      commitEntry: async input => {
        committed = openPaperPosition(createPaperPortfolio(), {
          ...input, occurredAt: new Date(now).toISOString(), nowMs: now
        });
        return { status: "APPLIED" };
      }
    });
    expect(result.status).toBe("ENTERED");
    expect(committed).not.toBeNull();
    expect(committed!.position.tokenAmountBaseUnits).toBe("1000000");
  });

  it("blocks paper entry when either side exceeds the 2% price-impact limit", async () => {
    const commitEntry = vi.fn();
    const result = await executePaperEntry({
      mint, positionId: "p-impact", occurredAt: new Date(now).toISOString(), nowMs: now,
      strategy: approved, portfolio: createPaperPortfolio(),
      quoteBuy: async () => ({ quote: { ...quote("BUY"), priceImpactPct: 2.01 }, context: { solUsd, costs } }),
      quoteSell: async () => ({ quote: quote("SELL"), context: { solUsd, costs } }),
      commitEntry
    });
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/2% per-side/);
    expect(commitEntry).not.toHaveBeenCalled();
  });

  it("blocks paper entry when combined buy and sell fees exceed 4% of stake", async () => {
    const commitEntry = vi.fn();
    const expensiveCosts = { ...costs, providerFeeUsd: 0.03 };
    const result = await executePaperEntry({
      mint, positionId: "p-fees", occurredAt: new Date(now).toISOString(), nowMs: now,
      strategy: approved, portfolio: createPaperPortfolio(),
      quoteBuy: async () => ({ quote: quote("BUY"), context: { solUsd, costs: expensiveCosts } }),
      quoteSell: async () => ({ quote: quote("SELL"), context: { solUsd, costs: expensiveCosts } }),
      commitEntry
    });
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/4% round-trip/);
    expect(commitEntry).not.toHaveBeenCalled();
  });

  it("blocks before commit when the exact-size sell quote is unavailable", async () => {
    const commitEntry = vi.fn();
    const result = await executePaperEntry({
      mint, positionId: "p1", occurredAt: new Date(now).toISOString(), nowMs: now,
      strategy: approved, portfolio: createPaperPortfolio(),
      quoteBuy: async () => ({ quote: quote("BUY"), context: { solUsd, costs } }),
      quoteSell: async () => ({ quote: { ...quote("SELL"), inputAmountBaseUnits: "999999" }, context: { solUsd, costs } }),
      commitEntry
    });
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/exact-size/);
    expect(commitEntry).not.toHaveBeenCalled();
  });

  it("blocks duplicate mints and a full portfolio before fetching quotes", async () => {
    const portfolio = createPaperPortfolio();
    portfolio.enteredMints.push(mint);
    const quoteBuy = vi.fn();
    const result = await executePaperEntry({
      mint, positionId: "p2", occurredAt: new Date(now).toISOString(), nowMs: now,
      strategy: approved, portfolio, quoteBuy, quoteSell: vi.fn(), commitEntry: vi.fn()
    });
    expect(result.status).toBe("BLOCKED");
    expect(quoteBuy).not.toHaveBeenCalled();
  });
});
