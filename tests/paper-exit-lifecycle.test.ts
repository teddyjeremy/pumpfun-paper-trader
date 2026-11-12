import { describe, expect, it, vi } from "vitest";
import type { PaperPosition } from "../src/paper/portfolio.js";
import { createUnverifiedMarketState, updatePumpMarketState, type VerifiedCurveEvidence } from "../src/paper/pump-market-state.js";
import { executePaperExit } from "../src/paper/exit-lifecycle.js";
import type { PumpSdkCurveQuote } from "../src/ingestion/pump-sdk-curve-quote-adapter.js";

const now = Date.parse("2026-11-12T10:00:00.000Z");
const mint = "So11111111111111111111111111111111111111112";
const quoteMint = "11111111111111111111111111111111";
const solUsd = { priceUsd: 100, observedAt: new Date(now - 100).toISOString() };
const costs = { networkFeeLamports: "0", priorityFeeLamports: "0", providerFeeUsd: 0, simulatedLatencyMs: 50 };
const position: PaperPosition = {
  positionId: "pos-1", mint, openedAt: new Date(now - 30_000).toISOString(),
  stakeUsd: 1, tokenAmountBaseUnits: "1000000", tokenDecimals: 6,
  buyQuoteId: "buy-q", entryPriceUsdPerToken: 1, buyCostsUsd: 0.000001,
  highWaterPriceUsdPerToken: 0.989, latestPriceUsdPerToken: 0.989,
  latestLiquidationValueUsd: 0.989, latestSellQuoteId: "mark-q",
  latestSellQuoteAt: new Date(now - 5_000).toISOString(),
  realizedPnlUsd: null, status: "OPEN", exitReason: null
};
const curveEvidence: VerifiedCurveEvidence = {
  source: "verified-pump-curve-account", verified: true, mint,
  curveAddress: "11111111111111111111111111111111", quoteMint,
  complete: false, migrated: false,
  tokenReserveBaseUnits: "1000000", quoteReserveBaseUnits: "1000000",
  virtualTokenReservesBaseUnits: "2000000", virtualQuoteReservesBaseUnits: "2000000",
  realQuoteReservesBaseUnits: "1000000", tokenTotalSupplyBaseUnits: "10000000",
  creatorFeeBps: "0", creatorFeeBaseUnits: "0", protocolFeesBaseUnits: "0",
  isMayhemMode: false, isCashbackCoin: false, slot: 100,
  observedAt: new Date(now - 100).toISOString()
};
const marketState = updatePumpMarketState(createUnverifiedMarketState(mint, new Date(now - 100).toISOString()), {
  curve: curveEvidence, nowMs: now
});

function sellQuote(): PumpSdkCurveQuote {
  return {
    provider: "pump-sdk-4.3.1", venue: "PUMP_CURVE", side: "SELL", mint,
    quoteMint, slot: 101, observedAt: new Date(now - 50).toISOString(),
    inputAmountBaseUnits: "1000000", outputAmountBaseUnits: "11000000",
    grossQuoteAmountBaseUnits: "11010000", netQuoteAmountBaseUnits: "11000000",
    venueFeeBaseUnits: "10000", priceImpactPct: 0.1,
    baseDecimals: 6, quoteDecimals: 9,
    transferTaxVerifiedZero: true, executionReady: false, blockers: []
  };
}
const bearishWindows = [now - 3_000, now - 1_000].map(endedAtMs => ({
  endedAtMs, windowSeconds: 2 as const, complete: true,
  buySellRatio: 0.5, buyVolumeDeclinePct: 50, buyerRateDeclinePct: 50,
  sellVolumeExpansionPct: 60, priceResponseDeclinePct: 50,
  liquidityChangePct: -25, largeHolderDistributionDetected: false
}));

describe("dynamic paper exit lifecycle", () => {
  it("blocks before requesting a quote when market migration is unverified", async () => {
    const quoteSell = vi.fn();
    const result = await executePaperExit({
      position, marketState: createUnverifiedMarketState(mint, new Date(now).toISOString()),
      windows: [], nowMs: now, quoteSell, commitExit: vi.fn()
    });
    expect(result.status).toBe("BLOCKED");
    expect(quoteSell).not.toHaveBeenCalled();
  });

  it("holds with a fresh full-size sell quote when no exit condition is met", async () => {
    const commitExit = vi.fn();
    const result = await executePaperExit({
      position, marketState, windows: [], nowMs: now,
      quoteSell: async () => ({ quote: sellQuote(), context: { solUsd, costs } }),
      commitExit
    });
    expect(result.status).toBe("HOLD");
    expect(commitExit).not.toHaveBeenCalled();
  });

  it("executes a dynamic exhaustion exit after two consecutive bearish 2-second windows", async () => {
    const commitExit = vi.fn(async () => ({ status: "APPLIED" }));
    const result = await executePaperExit({
      position, marketState, windows: bearishWindows, nowMs: now,
      quoteSell: async ({ tokenAmountBaseUnits }) => {
        expect(tokenAmountBaseUnits).toBe(position.tokenAmountBaseUnits);
        return { quote: sellQuote(), context: { solUsd, costs } };
      },
      commitExit
    });
    expect(result.status).toBe("EXITED");
    expect(result.reason).toBe("DYNAMIC_EXHAUSTION");
    expect(commitExit).toHaveBeenCalledOnce();
  });

  it("rejects a sell quote that does not consume the entire remaining balance", async () => {
    const commitExit = vi.fn();
    const result = await executePaperExit({
      position, marketState, windows: bearishWindows, nowMs: now,
      quoteSell: async () => ({
        quote: { ...sellQuote(), inputAmountBaseUnits: "999999" },
        context: { solUsd, costs }
      }),
      commitExit
    });
    expect(result.status).toBe("BLOCKED");
    expect(commitExit).not.toHaveBeenCalled();
  });

  it("blocks stale market evidence and never uses an old market phase", async () => {
    const staleState = updatePumpMarketState(createUnverifiedMarketState(mint), {
      curve: { ...curveEvidence, observedAt: new Date(now - 2_500).toISOString() },
      nowMs: now
    });
    const quoteSell = vi.fn();
    const result = await executePaperExit({
      position, marketState: staleState, windows: bearishWindows, nowMs: now,
      quoteSell, commitExit: vi.fn()
    });
    expect(result.status).toBe("BLOCKED");
    expect(quoteSell).not.toHaveBeenCalled();
  });
});
