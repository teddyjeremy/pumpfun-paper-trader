export interface PaperProjectionQuote {
  quoteId: string;
  mint: string;
  side: "BUY" | "SELL";
  provider: string;
  venue?: string;
  slot?: number;
  observedAt: string;
  expiresAt: string;
  requestedUsd: number;
  inputAmountBaseUnits: string;
  outputAmountBaseUnits: string;
  outputUsd: number;
  priceImpactPct: number;
  simulatedLatencyMs: number;
  simulatedFillAt: string;
  feeBreakdownUsd: Record<string, number>;
  raw: Record<string, unknown>;
}
export interface PaperProjectionPosition {
  positionId: string;
  mint: string;
  status: string;
  openedAt: string;
  closedAt?: string | null;
  stakeUsd: number;
  tokenAmountBaseUnits: string;
  tokenDecimals: number;
  entryPriceUsdPerToken: number;
  buyCostsUsd: number;
  latestLiquidationValueUsd: number;
  realizedPnlUsd?: number | null;
  exitReason?: string | null;
  raw: Record<string, unknown>;
}
export interface PaperProjectionTrade {
  externalTradeId: string;
  positionId: string;
  mint: string;
  side: "buy" | "sell";
  quoteId: string;
  executedAt: string;
  tokenAmountBaseUnits: string;
  quoteAmountBaseUnits: string;
  grossUsd: number;
  totalFeesUsd: number;
  simulatedLatencyMs: number;
  raw: Record<string, unknown>;
}
export interface PaperLedgerProjection {
  positions: PaperProjectionPosition[];
  quotes: PaperProjectionQuote[];
  trades: PaperProjectionTrade[];
}
type AuditEvent = {
  eventId: string;
  sequence: number;
  kind: string;
  occurredAt: string;
  mint: string | null;
  data: unknown;
};
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function finite(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new Error(`Paper projection ${label} is invalid.`);
  }
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Paper projection ${label} is invalid.`);
  return value;
}
function baseUnits(value: unknown, label: string): string {
  const raw = text(value, label);
  if (!/^\d+$/.test(raw) || raw.length > 40 || BigInt(raw) <= 0n) {
    throw new Error(`Paper projection ${label} must be a positive base-unit integer.`);
  }
  return raw;
}
function projectPosition(value: unknown, fallbackClosedAt?: string): PaperProjectionPosition {
  const p = object(value);
  if (!p) throw new Error("Paper projection position payload is missing.");
  const positionId = text(p.positionId, "position id");
  const mint = text(p.mint, "position mint");
  const status = text(p.status, "position status");
  if (!["OPEN", "CLOSED", "EXIT_BLOCKED"].includes(status)) throw new Error("Paper projection position status is unsupported.");
  const openedAt = text(p.openedAt, "position openedAt");
  if (!Number.isFinite(Date.parse(openedAt))) throw new Error("Paper projection position openedAt is invalid.");
  const closedAt = p.closedAt == null ? (fallbackClosedAt ?? null) : text(p.closedAt, "position closedAt");
  if (closedAt !== null && !Number.isFinite(Date.parse(closedAt))) throw new Error("Paper projection position closedAt is invalid.");
  const tokenDecimals = finite(p.tokenDecimals, "token decimals");
  if (!Number.isInteger(tokenDecimals) || tokenDecimals > 18) throw new Error("Paper projection token decimals are invalid.");
  return {
    positionId, mint, status, openedAt, closedAt,
    stakeUsd: finite(p.stakeUsd, "stake USD"),
    tokenAmountBaseUnits: baseUnits(p.tokenAmountBaseUnits, "position token amount"),
    tokenDecimals,
    entryPriceUsdPerToken: finite(p.entryPriceUsdPerToken, "entry price"),
    buyCostsUsd: finite(p.buyCostsUsd, "buy costs"),
    latestLiquidationValueUsd: finite(p.latestLiquidationValueUsd, "liquidation value"),
    realizedPnlUsd: p.realizedPnlUsd == null ? null : finiteSigned(p.realizedPnlUsd, "realized PnL"),
    exitReason: p.exitReason == null ? null : String(p.exitReason),
    raw: p
  };
}
function finiteSigned(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Paper projection ${label} is invalid.`);
  return value;
}
function projectQuote(value: unknown): PaperProjectionQuote {
  const q = object(value);
  if (!q) throw new Error("Paper projection quote payload is missing.");
  const side = q.side;
  if (side !== "BUY" && side !== "SELL") throw new Error("Paper projection quote side is invalid.");
  const fees = object(q.feeBreakdownUsd);
  if (!fees) throw new Error("Paper projection quote fee breakdown is missing.");
  const feeBreakdownUsd: Record<string, number> = {};
  for (const [key, amount] of Object.entries(fees)) feeBreakdownUsd[key] = finite(amount, `fee ${key}`);
  const observedAt = text(q.observedAt, "quote observedAt");
  const expiresAt = text(q.expiresAt, "quote expiresAt");
  const simulatedFillAt = text(q.simulatedFillAt, "quote simulatedFillAt");
  if (![observedAt, expiresAt, simulatedFillAt].every(value => Number.isFinite(Date.parse(value)))) {
    throw new Error("Paper projection quote timestamps are invalid.");
  }
  return {
    quoteId: text(q.quoteId, "quote id"),
    mint: text(q.mint, "quote mint"),
    side,
    provider: text(q.provider, "quote provider"),
    ...(typeof q.venue === "string" ? { venue: q.venue } : {}),
    ...(Number.isSafeInteger(q.slot) ? { slot: q.slot as number } : {}),
    observedAt, expiresAt,
    requestedUsd: finite(q.requestedUsd, "quote requested USD"),
    inputAmountBaseUnits: baseUnits(q.inputAmountBaseUnits, "quote input amount"),
    outputAmountBaseUnits: baseUnits(q.outputAmountBaseUnits, "quote output amount"),
    outputUsd: finite(q.outputUsd, "quote output USD"),
    priceImpactPct: finite(q.priceImpactPct, "quote price impact"),
    simulatedLatencyMs: finite(q.simulatedLatencyMs, "quote latency"),
    simulatedFillAt, feeBreakdownUsd, raw: q
  };
}
function tradeFromQuote(event: AuditEvent, position: PaperProjectionPosition, quote: PaperProjectionQuote): PaperProjectionTrade {
  const totalFeesUsd = Object.values(quote.feeBreakdownUsd).reduce((sum, fee) => sum + fee, 0);
  return {
    externalTradeId: `${event.eventId}:${quote.side.toLowerCase()}`,
    positionId: position.positionId,
    mint: position.mint,
    side: quote.side.toLowerCase() as "buy" | "sell",
    quoteId: quote.quoteId,
    executedAt: quote.simulatedFillAt,
    tokenAmountBaseUnits: quote.side === "BUY" ? quote.outputAmountBaseUnits : quote.inputAmountBaseUnits,
    quoteAmountBaseUnits: quote.side === "BUY" ? quote.inputAmountBaseUnits : quote.outputAmountBaseUnits,
    grossUsd: quote.outputUsd,
    totalFeesUsd,
    simulatedLatencyMs: quote.simulatedLatencyMs,
    raw: quote.raw
  };
}

/** Pure, validated event-to-ledger projection. It is safe to replay inside the same DB transaction as the event insert. */
export function buildPaperLedgerProjection(event: AuditEvent): PaperLedgerProjection {
  const result: PaperLedgerProjection = { positions: [], quotes: [], trades: [] };
  if (!["PAPER_ENTRY", "PAPER_EXIT", "POSITION_MARK"].includes(event.kind)) return result;
  const data = object(event.data);
  if (!data) throw new Error("Paper projection event payload must be an object.");
  if (event.kind === "PAPER_ENTRY") {
    // Older journal events recorded only quote IDs. Keep them durable in the
    // event table but do not fabricate a normalized trade projection.
    if (!data.buyQuote || !data.initialSellQuote) return result;
    const position = projectPosition(data.position);
    const buy = projectQuote(data.buyQuote);
    const initialSell = projectQuote(data.initialSellQuote);
    if (buy.side !== "BUY" || initialSell.side !== "SELL" ||
        buy.mint !== position.mint || initialSell.mint !== position.mint ||
        initialSell.inputAmountBaseUnits !== position.tokenAmountBaseUnits ||
        buy.quoteId !== data.buyQuoteId || initialSell.quoteId !== data.initialSellQuoteId) {
      throw new Error("Paper entry projection quote and position identities do not reconcile.");
    }
    result.positions.push(position);
    result.quotes.push(buy, initialSell);
    result.trades.push(tradeFromQuote(event, position, buy));
  } else if (event.kind === "PAPER_EXIT") {
    const position = projectPosition(data.position);
    const sell = projectQuote(data.sellQuote);
    if (position.status !== "CLOSED" || sell.side !== "SELL" ||
        sell.mint !== position.mint || sell.quoteId !== data.sellQuoteId) {
      throw new Error("Paper exit projection quote and closed position identities do not reconcile.");
    }
    result.positions.push(position);
    result.quotes.push(sell);
    result.trades.push(tradeFromQuote(event, position, sell));
  } else if (event.kind === "POSITION_MARK" && Array.isArray(data.positions)) {
    for (const value of data.positions) result.positions.push(projectPosition(value));
    if (Array.isArray(data.sellQuotes)) {
      for (const value of data.sellQuotes) result.quotes.push(projectQuote(value));
    }
  }
  return result;
}
