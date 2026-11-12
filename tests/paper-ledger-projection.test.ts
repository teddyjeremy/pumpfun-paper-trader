import { describe, expect, it } from "vitest";
import { buildPaperLedgerProjection } from "../src/persistence/paper-ledger-projection.js";

const mint = "So11111111111111111111111111111111111111112";
const position = {
  positionId: "pos-1", mint, openedAt: "2026-11-12T10:00:00.000Z",
  stakeUsd: 1, tokenAmountBaseUnits: "1000000", tokenDecimals: 6,
  buyQuoteId: "buy-q", entryPriceUsdPerToken: 1,
  buyCostsUsd: 0.000001, highWaterPriceUsdPerToken: 0.989,
  latestPriceUsdPerToken: 0.989, latestLiquidationValueUsd: 0.989,
  latestSellQuoteId: "initial-sell-q", latestSellQuoteAt: "2026-11-12T10:00:00.100Z",
  realizedPnlUsd: null, status: "OPEN", exitReason: null
};
function quote(side: "BUY" | "SELL", quoteId: string) {
  return {
    quoteId, provider: "pump-sdk-4.3.1", mint, side, venue: "PUMP_CURVE",
    slot: 100, observedAt: "2026-11-12T10:00:00.100Z",
    expiresAt: "2026-11-12T10:00:02.100Z",
    requestedUsd: side === "BUY" ? 1 : 0.99,
    inputAmountBaseUnits: side === "BUY" ? "10000010" : "1000000",
    outputAmountBaseUnits: side === "BUY" ? "1000000" : "9890000",
    outputUsd: side === "BUY" ? 1 : 0.99,
    priceImpactPct: 0.1, simulatedLatencyMs: 50,
    simulatedFillAt: "2026-11-12T10:00:00.150Z",
    feeBreakdownUsd: {
      protocol: 0, creator: 0, pool: 0, pumpAggregate: 0.000001,
      network: 0, priority: 0, provider: 0, transfer: 0
    }
  };
}
const event = (kind: string, data: unknown) => ({
  eventId: "event-1", sequence: 1, kind,
  occurredAt: "2026-11-12T10:00:00.200Z", mint, data
});

describe("paper ledger projection", () => {
  it("projects entry position, both quote records and the buy fill", () => {
    const result = buildPaperLedgerProjection(event("PAPER_ENTRY", {
      position, buyQuoteId: "buy-q", initialSellQuoteId: "initial-sell-q",
      buyQuote: quote("BUY", "buy-q"), initialSellQuote: quote("SELL", "initial-sell-q")
    }));
    expect(result.positions).toHaveLength(1);
    expect(result.quotes).toHaveLength(2);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.side).toBe("buy");
    expect(result.trades[0]?.tokenAmountBaseUnits).toBe("1000000");
    expect(result.trades[0]?.quoteAmountBaseUnits).toBe("10000010");
  });

  it("projects a closed position and its sell fill using the exit event timestamp", () => {
    const closed = {
      ...position, status: "CLOSED", latestLiquidationValueUsd: 0,
      realizedPnlUsd: -0.012, exitReason: "DYNAMIC_EXIT"
    };
    const result = buildPaperLedgerProjection(event("PAPER_EXIT", {
      position: closed, sellQuoteId: "exit-q", exitReason: "DYNAMIC_EXIT",
      sellQuote: quote("SELL", "exit-q")
    }));
    expect(result.positions[0]?.status).toBe("CLOSED");
    expect(result.positions[0]?.closedAt).toBe("2026-11-12T10:00:00.200Z");
    expect(result.trades[0]?.side).toBe("sell");
    expect(result.trades[0]?.tokenAmountBaseUnits).toBe("1000000");
  });

  it("projects full-position mark quotes without creating a trade", () => {
    const result = buildPaperLedgerProjection(event("POSITION_MARK", {
      positions: [position], sellQuotes: [quote("SELL", "mark-q")]
    }));
    expect(result.positions).toHaveLength(1);
    expect(result.quotes).toHaveLength(1);
    expect(result.trades).toHaveLength(0);
  });


  it("rejects a buy quote whose output differs from the recorded position balance", () => {
    const buy = { ...quote("BUY", "buy-q"), outputAmountBaseUnits: "999999" };
    expect(() => buildPaperLedgerProjection(event("PAPER_ENTRY", {
      position, buyQuoteId: "buy-q", initialSellQuoteId: "initial-sell-q",
      buyQuote: buy, initialSellQuote: quote("SELL", "initial-sell-q")
    }))).toThrow(/do not reconcile/);
  });

  it("rejects a buy quote whose requested USD differs from the recorded stake", () => {
    const buy = { ...quote("BUY", "buy-q"), requestedUsd: 0.95 };
    expect(() => buildPaperLedgerProjection(event("PAPER_ENTRY", {
      position, buyQuoteId: "buy-q", initialSellQuoteId: "initial-sell-q",
      buyQuote: buy, initialSellQuote: quote("SELL", "initial-sell-q")
    }))).toThrow(/do not reconcile/);
  });

  it("rejects entry quotes from inconsistent venues", () => {
    const initialSell = { ...quote("SELL", "initial-sell-q"), venue: "RAYDIUM" };
    expect(() => buildPaperLedgerProjection(event("PAPER_ENTRY", {
      position, buyQuoteId: "buy-q", initialSellQuoteId: "initial-sell-q",
      buyQuote: quote("BUY", "buy-q"), initialSellQuote: initialSell
    }))).toThrow(/do not reconcile/);
  });

  it("rejects mismatched quote and position identities", () => {
    expect(() => buildPaperLedgerProjection(event("PAPER_ENTRY", {
      position, buyQuoteId: "other", initialSellQuoteId: "initial-sell-q",
      buyQuote: quote("BUY", "buy-q"), initialSellQuote: quote("SELL", "initial-sell-q")
    }))).toThrow(/do not reconcile/);
  });
});
