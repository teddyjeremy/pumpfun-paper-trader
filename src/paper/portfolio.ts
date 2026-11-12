import { createBankrollState, markPaperEquity, replenishPaperBankroll, type BankrollState } from "./session-ledger.js";

export interface ExecutablePaperQuote {
  quoteId: string;
  provider: string;
  mint: string;
  side: "BUY" | "SELL";
  observedAt: string;
  expiresAt: string;
  requestedUsd: number;
  inputAmountBaseUnits: string;
  outputAmountBaseUnits: string;
  /** Number of decimal places on the token side of this quote. */
  tokenDecimals: number;
  /** Gross output value before protocol, creator, pool, transfer and network fees. */
  outputUsd: number;
  priceImpactPct: number;
  taxPct: number;
  networkFeeUsd: number;
  priorityFeeUsd: number;
  providerFeeUsd: number;
  protocolFeeUsd: number;
  creatorFeeUsd: number;
  poolFeeUsd: number;
  transferFeeUsd: number;
  routeId: string;
  executable: boolean;
}
export interface PaperPosition {
  positionId: string;
  mint: string;
  openedAt: string;
  stakeUsd: number;
  tokenAmountBaseUnits: string;
  tokenDecimals: number;
  buyQuoteId: string;
  entryPriceUsdPerToken: number;
  buyCostsUsd: number;
  highWaterPriceUsdPerToken: number;
  latestPriceUsdPerToken: number;
  /** Net liquidation value from the latest exact-size executable sell quote. */
  latestLiquidationValueUsd: number;
  latestSellQuoteId: string;
  latestSellQuoteAt: string;
  realizedPnlUsd: number | null;
  status: "OPEN" | "CLOSED" | "EXIT_BLOCKED";
  exitReason: string | null;
}
export interface PaperPortfolioState {
  bankroll: BankrollState;
  availableCashUsd: number;
  highWaterEquityUsd: number;
  positionSizeUsd: number;
  maxConcurrentPositions: number;
  positions: PaperPosition[];
  enteredMints: string[];
  lastMarkedAt: string | null;
}
export const PAPER_PORTFOLIO_POLICY = Object.freeze({
  initialStakeUsd: 1,
  firstGrowthThresholdUsd: 5,
  maxStakeUsd: 100,
  initialBankrollUsd: 2.70,
  topUpUsd: 2.70,
  topUpBelowUsd: 1,
  maxImpactPerSidePct: 2,
  maxTaxPerSidePct: 2,
  maxRoundTripCostPct: 4,
  maxQuoteAgeMs: 2_000
});
const round = (value: number) => Math.round((value + Number.EPSILON) * 1e8) / 1e8;
function quoteFeesUsd(quote: ExecutablePaperQuote): number {
  return quote.networkFeeUsd + quote.priorityFeeUsd + quote.providerFeeUsd +
    quote.protocolFeeUsd + quote.creatorFeeUsd + quote.poolFeeUsd + quote.transferFeeUsd;
}
function validPositive(value: number): boolean { return Number.isFinite(value) && value > 0; }
function humanTokenAmount(amountBaseUnits: string, decimals: number): number {
  const amount = Number(BigInt(amountBaseUnits)) / Math.pow(10, decimals);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Token amount cannot be represented safely for USD accounting.");
  return amount;
}
function assertQuote(quote: ExecutablePaperQuote, now: number, side: "BUY"|"SELL", mint: string): void {
  if (!Number.isFinite(now)) throw new Error("Quote validation clock is invalid.");
  if (!quote.executable || quote.side !== side || quote.mint !== mint ||
      !quote.quoteId || !quote.provider || !quote.routeId) throw new Error("Executable quote identity or status is invalid.");
  const observed = Date.parse(quote.observedAt), expires = Date.parse(quote.expiresAt);
  if (!Number.isFinite(observed) || !Number.isFinite(expires) || observed > now ||
      now - observed > PAPER_PORTFOLIO_POLICY.maxQuoteAgeMs || expires <= now) {
    throw new Error("Executable quote is stale or expired.");
  }
  if (quote.priceImpactPct > PAPER_PORTFOLIO_POLICY.maxImpactPerSidePct ||
      quote.taxPct > PAPER_PORTFOLIO_POLICY.maxTaxPerSidePct) {
    throw new Error("Quote exceeds the per-side impact or tax limit.");
  }
  if (!validPositive(quote.requestedUsd) || !validPositive(quote.outputUsd) ||
      !Number.isInteger(quote.tokenDecimals) || quote.tokenDecimals < 0 || quote.tokenDecimals > 18 ||
      !/^\\d+$/.test(quote.inputAmountBaseUnits) ||
      !/^\\d+$/.test(quote.outputAmountBaseUnits) || BigInt(quote.inputAmountBaseUnits) <= 0n ||
      BigInt(quote.outputAmountBaseUnits) <= 0n || !Number.isFinite(quote.priceImpactPct) ||
      !Number.isFinite(quote.taxPct) || quote.priceImpactPct < 0 || quote.taxPct < 0 ||
      !Number.isFinite(quote.networkFeeUsd) || quote.networkFeeUsd < 0 ||
      !Number.isFinite(quote.priorityFeeUsd) || quote.priorityFeeUsd < 0 ||
      !Number.isFinite(quote.providerFeeUsd) || quote.providerFeeUsd < 0 ||
      !Number.isFinite(quote.protocolFeeUsd) || quote.protocolFeeUsd < 0 ||
      !Number.isFinite(quote.creatorFeeUsd) || quote.creatorFeeUsd < 0 ||
      !Number.isFinite(quote.poolFeeUsd) || quote.poolFeeUsd < 0 ||
      !Number.isFinite(quote.transferFeeUsd) || quote.transferFeeUsd < 0) {
    throw new Error("Quote contains invalid amount or cost evidence.");
  }
}
function netSellValue(quote: ExecutablePaperQuote): number {
  const value = quote.outputUsd - quoteFeesUsd(quote);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Sell quote has negative net proceeds after all execution fees.");
  }
  return round(value);
}
function growthEquity(state: PaperPortfolioState): number {
  // Replenishments restore simulated cash but are contributions, not trading gains.
  return Math.max(0, round(state.bankroll.currentEquityUsd - state.bankroll.totalTopUpsUsd));
}
function currentOpen(state: PaperPortfolioState): PaperPosition[] {
  return state.positions.filter(position => position.status !== "CLOSED");
}
function applyEquityAndTopUp(state: PaperPortfolioState, equity: number, occurredAt: string) {
  const bankroll = markPaperEquity(state.bankroll, equity);
  const topped = replenishPaperBankroll(bankroll, occurredAt,
    PAPER_PORTFOLIO_POLICY.topUpUsd, PAPER_PORTFOLIO_POLICY.topUpBelowUsd);
  const cash = round(state.availableCashUsd + (topped.event ? PAPER_PORTFOLIO_POLICY.topUpUsd : 0));
  const highWaterEquityUsd = Math.max(state.highWaterEquityUsd,
    growthEquity({ ...state, bankroll: topped.state }));
  const limits = capacityForEquity(highWaterEquityUsd);
  return {
    bankroll: topped.state, availableCashUsd: cash, highWaterEquityUsd,
    positionSizeUsd: limits.stake, maxConcurrentPositions: limits.slots
  };
}
export function createPaperPortfolio(initialBankrollUsd = PAPER_PORTFOLIO_POLICY.initialBankrollUsd): PaperPortfolioState {
  const bankroll = createBankrollState(initialBankrollUsd);
  return {
    bankroll, availableCashUsd: round(initialBankrollUsd),
    highWaterEquityUsd: round(initialBankrollUsd),
    positionSizeUsd: PAPER_PORTFOLIO_POLICY.initialStakeUsd,
    maxConcurrentPositions: 1, positions: [], enteredMints: [], lastMarkedAt: null
  };
}
function capacityForEquity(equity: number): { stake: number; slots: number } {
  const levels = equity < PAPER_PORTFOLIO_POLICY.firstGrowthThresholdUsd
    ? 0
    : 1 + Math.floor(Math.log2(equity / PAPER_PORTFOLIO_POLICY.firstGrowthThresholdUsd));
  return {
    stake: Math.min(PAPER_PORTFOLIO_POLICY.maxStakeUsd, round(PAPER_PORTFOLIO_POLICY.initialStakeUsd * Math.pow(1.5, levels))),
    slots: Math.min(100, 1 + levels)
  };
}
export function openPaperPosition(state: PaperPortfolioState, input: {
  mint: string; positionId: string; occurredAt: string;
  buyQuote: ExecutablePaperQuote; sellQuote: ExecutablePaperQuote; nowMs?: number;
}): { state: PaperPortfolioState; position: PaperPosition } {
  const now = input.nowMs ?? Date.now();
  if (!input.mint || !input.positionId || !Number.isFinite(Date.parse(input.occurredAt))) throw new Error("Position identity or timestamp is invalid.");
  if (state.enteredMints.includes(input.mint)) throw new Error("A mint may only be bought once per paper session.");
  if (state.positions.some(position => position.positionId === input.positionId)) throw new Error("Paper position ID must be unique within the session.");
  const existingOpen = currentOpen(state);
  if (existingOpen.length >= state.maxConcurrentPositions) throw new Error("Maximum concurrent paper positions reached.");
  const stake = state.positionSizeUsd;
  if (state.availableCashUsd < stake) throw new Error("Insufficient available paper cash.");
  assertQuote(input.buyQuote, now, "BUY", input.mint);
  assertQuote(input.sellQuote, now, "SELL", input.mint);
  if (Math.abs(input.buyQuote.requestedUsd - stake) > 0.00000001 ||
      input.buyQuote.tokenDecimals !== input.sellQuote.tokenDecimals ||
      BigInt(input.sellQuote.inputAmountBaseUnits) !== BigInt(input.buyQuote.outputAmountBaseUnits)) {
    throw new Error("Quotes must be size-specific for the exact planned stake and resulting token balance.");
  }
  const roundTripPct = input.buyQuote.priceImpactPct + input.sellQuote.priceImpactPct +
    input.buyQuote.taxPct + input.sellQuote.taxPct +
    ((quoteFeesUsd(input.buyQuote) + quoteFeesUsd(input.sellQuote)) / stake) * 100;
  if (input.buyQuote.priceImpactPct > PAPER_PORTFOLIO_POLICY.maxImpactPerSidePct ||
      input.sellQuote.priceImpactPct > PAPER_PORTFOLIO_POLICY.maxImpactPerSidePct ||
      input.buyQuote.taxPct > PAPER_PORTFOLIO_POLICY.maxTaxPerSidePct ||
      input.sellQuote.taxPct > PAPER_PORTFOLIO_POLICY.maxTaxPerSidePct ||
      roundTripPct > PAPER_PORTFOLIO_POLICY.maxRoundTripCostPct) {
    throw new Error("Round-trip execution cost exceeds the paper entry limits.");
  }
  const buyCosts = quoteFeesUsd(input.buyQuote);
  const tokens = BigInt(input.buyQuote.outputAmountBaseUnits);
  const tokenDecimals = input.buyQuote.tokenDecimals;
  const humanTokens = humanTokenAmount(tokens.toString(), tokenDecimals);
  const entryPrice = input.buyQuote.outputUsd / humanTokens;
  if (!validPositive(entryPrice)) throw new Error("Buy quote produced an invalid entry price.");
  const initialLiquidationValue = netSellValue(input.sellQuote);
  const initialLiquidationPrice = initialLiquidationValue / humanTokens;
  if (!Number.isFinite(initialLiquidationPrice)) throw new Error("Initial sell quote cannot be represented as a finite USD price.");
  const position: PaperPosition = {
    positionId: input.positionId, mint: input.mint, openedAt: input.occurredAt,
    stakeUsd: stake, tokenAmountBaseUnits: tokens.toString(), tokenDecimals, buyQuoteId: input.buyQuote.quoteId,
    entryPriceUsdPerToken: entryPrice, buyCostsUsd: round(buyCosts),
    highWaterPriceUsdPerToken: initialLiquidationPrice, latestPriceUsdPerToken: initialLiquidationPrice,
    latestLiquidationValueUsd: initialLiquidationValue,
    latestSellQuoteId: input.sellQuote.quoteId, latestSellQuoteAt: input.sellQuote.observedAt,
    realizedPnlUsd: null, status: "OPEN", exitReason: null
  };
  const availableCashUsd = round(state.availableCashUsd - stake - buyCosts);
  if (availableCashUsd < 0) throw new Error("Buy fees exceed available paper cash.");
  const positions = [...state.positions, position];

  // Existing positions may have stale sell quotes. Do not use a partial
  // portfolio valuation to trigger top-ups or growth-based scaling.
  if (existingOpen.length > 0) {
    return {
      state: { ...state, availableCashUsd, positions, enteredMints: [...state.enteredMints, input.mint] },
      position
    };
  }

  const equity = round(availableCashUsd + initialLiquidationValue);
  const adjusted = applyEquityAndTopUp({ ...state, availableCashUsd }, equity, input.occurredAt);
  return {
    state: { ...state, ...adjusted, positions, enteredMints: [...state.enteredMints, input.mint] },
    position
  };
}

/**
 * Mark every open position using a fresh, exact-size executable sell quote.
 * A chart price is not a liquidation value and cannot drive portfolio growth,
 * concurrency, or bankroll top-ups.
 */
export function markPaperPosition(state: PaperPortfolioState, input: {
  sellQuotes: ExecutablePaperQuote[]; markedAt: string; nowMs?: number;
}): PaperPortfolioState {
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(now) || !Number.isFinite(Date.parse(input.markedAt))) throw new Error("Invalid paper portfolio mark timestamp.");
  const open = currentOpen(state);
  if (open.length === 0) throw new Error("No open paper positions to mark.");
  if (!Array.isArray(input.sellQuotes) || input.sellQuotes.length !== open.length) {
    throw new Error("A fresh full-position sell quote is required for every open position.");
  }
  const quotesByMint = new Map<string, ExecutablePaperQuote>();
  for (const quote of input.sellQuotes) {
    if (quotesByMint.has(quote.mint)) throw new Error("Duplicate sell quote supplied for a position.");
    quotesByMint.set(quote.mint, quote);
  }
  let oldestQuoteAt = Number.POSITIVE_INFINITY;
  let newestQuoteAt = Number.NEGATIVE_INFINITY;
  const openByMint = new Map(open.map(position => [position.mint, position]));
  const positions = state.positions.map(position => {
    if (position.status === "CLOSED") return position;
    const quote = quotesByMint.get(position.mint);
    if (!quote) throw new Error("Missing fresh sell quote for an open position.");
    assertQuote(quote, now, "SELL", position.mint);
    if (quote.tokenDecimals !== position.tokenDecimals ||
        BigInt(quote.inputAmountBaseUnits) !== BigInt(position.tokenAmountBaseUnits)) {
      throw new Error("Mark quote must consume the exact full remaining token balance.");
    }
    const observedAt = Date.parse(quote.observedAt);
    oldestQuoteAt = Math.min(oldestQuoteAt, observedAt);
    newestQuoteAt = Math.max(newestQuoteAt, observedAt);
    const liquidationValue = netSellValue(quote);
    const tokens = humanTokenAmount(position.tokenAmountBaseUnits, position.tokenDecimals);
    const price = liquidationValue / tokens;
    if (!Number.isFinite(price)) throw new Error("Sell quote cannot be represented as a finite USD mark.");
    return {
      ...position,
      latestPriceUsdPerToken: price,
      highWaterPriceUsdPerToken: Math.max(position.highWaterPriceUsdPerToken, price),
      latestLiquidationValueUsd: liquidationValue,
      latestSellQuoteId: quote.quoteId,
      latestSellQuoteAt: quote.observedAt
    };
  });
  if (newestQuoteAt - oldestQuoteAt > PAPER_PORTFOLIO_POLICY.maxQuoteAgeMs) {
    throw new Error("Position sell quotes are not from a coherent freshness window.");
  }
  if (quotesByMint.size !== openByMint.size || [...quotesByMint.keys()].some(mint => !openByMint.has(mint))) {
    throw new Error("Sell quotes include a mint that is not an open position.");
  }
  const equity = round(state.availableCashUsd + positions.reduce((sum, position) =>
    sum + (position.status === "CLOSED" ? 0 : position.latestLiquidationValueUsd), 0));
  const adjusted = applyEquityAndTopUp({ ...state, positions }, equity, input.markedAt);
  return { ...state, ...adjusted, positions, lastMarkedAt: input.markedAt };
}
export function closePaperPosition(state: PaperPortfolioState, input: {
  positionId: string; sellQuote: ExecutablePaperQuote; exitReason: string; closedAt: string; nowMs?: number;
}): { state: PaperPortfolioState; position: PaperPosition } {
  if (!Number.isFinite(Date.parse(input.closedAt)) || !input.exitReason.trim()) {
    throw new Error("Exit timestamp and reason are required.");
  }
  const index = state.positions.findIndex(position => position.positionId === input.positionId);
  const previous = state.positions[index];
  if (!previous || previous.status !== "OPEN") throw new Error("Open paper position not found.");
  assertQuote(input.sellQuote, input.nowMs ?? Date.now(), "SELL", previous.mint);
  if (input.sellQuote.tokenDecimals !== previous.tokenDecimals ||
      BigInt(input.sellQuote.inputAmountBaseUnits) !== BigInt(previous.tokenAmountBaseUnits)) {
    throw new Error("Exit quote must consume the entire remaining token balance.");
  }
  const netProceeds = netSellValue(input.sellQuote);
  const tokens = humanTokenAmount(previous.tokenAmountBaseUnits, previous.tokenDecimals);
  const pnl = round(netProceeds - previous.stakeUsd - previous.buyCostsUsd);
  const exitPrice = netProceeds / tokens;
  if (!Number.isFinite(exitPrice)) throw new Error("Sell quote cannot be represented as a finite USD exit price.");
  const position: PaperPosition = {
    ...previous,
    latestPriceUsdPerToken: exitPrice,
    latestLiquidationValueUsd: 0,
    latestSellQuoteId: input.sellQuote.quoteId,
    latestSellQuoteAt: input.sellQuote.observedAt,
    realizedPnlUsd: pnl, status: "CLOSED", exitReason: input.exitReason
  };
  const positions = [...state.positions];
  positions[index] = position;
  const availableCashUsd = round(state.availableCashUsd + netProceeds);
  const remainingOpen = positions.some(item => item.status !== "CLOSED");

  // If other positions remain open, their last quotes may be stale. Defer
  // equity, top-up and scaling changes until the next complete portfolio mark.
  if (remainingOpen) {
    return { state: { ...state, availableCashUsd, positions }, position };
  }

  const adjusted = applyEquityAndTopUp({ ...state, availableCashUsd }, availableCashUsd, input.closedAt);
  return { state: { ...state, ...adjusted, positions }, position };
}
