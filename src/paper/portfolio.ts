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
  if (!validPositive(quote.requestedUsd) || !validPositive(quote.outputUsd) || !/^\d+$/.test(quote.inputAmountBaseUnits) ||
      !/^\d+$/.test(quote.outputAmountBaseUnits) || BigInt(quote.inputAmountBaseUnits) <= 0n ||
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
function growthEquity(state: PaperPortfolioState): number {
  // Replenishments restore simulated cash but are contributions, not trading gains.
  return Math.max(0, round(state.bankroll.currentEquityUsd - state.bankroll.totalTopUpsUsd));
}
function currentOpen(state: PaperPortfolioState): PaperPosition[] {
  return state.positions.filter(position => position.status !== "CLOSED");
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
function capacityForEquity(equity: number, initial: number): { stake: number; slots: number } {
  const doublings = Math.max(0, Math.floor(Math.log2(Math.max(1, equity / initial))));
  return {
    stake: Math.min(PAPER_PORTFOLIO_POLICY.maxStakeUsd, round(PAPER_PORTFOLIO_POLICY.initialStakeUsd * Math.pow(1.5, doublings))),
    slots: Math.min(100, 1 + doublings)
  };
}
export function openPaperPosition(state: PaperPortfolioState, input: {
  mint: string; positionId: string; occurredAt: string;
  buyQuote: ExecutablePaperQuote; sellQuote: ExecutablePaperQuote; nowMs?: number;
}): { state: PaperPortfolioState; position: PaperPosition } {
  const now = input.nowMs ?? Date.now();
  if (!input.mint || !input.positionId || !Number.isFinite(Date.parse(input.occurredAt))) throw new Error("Position identity or timestamp is invalid.");
  if (state.enteredMints.includes(input.mint)) throw new Error("A mint may only be bought once per paper session.");
  if (currentOpen(state).length >= state.maxConcurrentPositions) throw new Error("Maximum concurrent paper positions reached.");
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
  // The quote's gross output value captures price impact; do not assume the
  // received tokens are worth the full USD amount spent.
  const entryPrice = input.buyQuote.outputUsd / humanTokens;
  if (!validPositive(entryPrice)) throw new Error("Buy quote produced an invalid entry price.");
  const position: PaperPosition = {
    positionId: input.positionId, mint: input.mint, openedAt: input.occurredAt,
    stakeUsd: stake, tokenAmountBaseUnits: tokens.toString(), tokenDecimals, buyQuoteId: input.buyQuote.quoteId,
    entryPriceUsdPerToken: entryPrice, buyCostsUsd: round(buyCosts),
    highWaterPriceUsdPerToken: entryPrice, latestPriceUsdPerToken: entryPrice,
    realizedPnlUsd: null, status: "OPEN", exitReason: null
  };
  const availableCashUsd = round(state.availableCashUsd - stake - buyCosts);
  if (availableCashUsd < 0) throw new Error("Buy fees exceed available paper cash.");
  const positions = [...state.positions, position];
  const equity = round(availableCashUsd + positions.reduce((sum, p) =>
    sum + (p.status === "OPEN" ? input.buyQuote.outputUsd : 0), 0));
  const bankroll = markPaperEquity(state.bankroll, equity);
  const topped = replenishPaperBankroll(bankroll, input.occurredAt,
    PAPER_PORTFOLIO_POLICY.topUpUsd, PAPER_PORTFOLIO_POLICY.topUpBelowUsd);
  const cashAfterTopUp = round(availableCashUsd + (topped.event ? PAPER_PORTFOLIO_POLICY.topUpUsd : 0));
  const limits = capacityForEquity(Math.max(state.highWaterEquityUsd, growthEquity({ ...state, bankroll: topped.state })), state.bankroll.initialBankrollUsd);
  return {
    state: { ...state, bankroll: topped.state, availableCashUsd: cashAfterTopUp,
      positions, enteredMints: [...state.enteredMints, input.mint],
      highWaterEquityUsd: Math.max(state.highWaterEquityUsd, growthEquity({ ...state, bankroll: topped.state })),
      positionSizeUsd: limits.stake, maxConcurrentPositions: limits.slots },
    position
  };
}
export function markPaperPosition(state: PaperPortfolioState, input: {
  positionId: string; priceUsdPerToken: number; markedAt: string;
}): PaperPortfolioState {
  if (!validPositive(input.priceUsdPerToken) || !Number.isFinite(Date.parse(input.markedAt))) throw new Error("Invalid paper position mark.");
  const index = state.positions.findIndex(position => position.positionId === input.positionId);
  if (index < 0 || state.positions[index]!.status !== "OPEN") throw new Error("Open paper position not found.");
  const positions = [...state.positions];
  const previous = positions[index]!;
  positions[index] = { ...previous, latestPriceUsdPerToken: input.priceUsdPerToken,
    highWaterPriceUsdPerToken: Math.max(previous.highWaterPriceUsdPerToken, input.priceUsdPerToken) };
  const markedValue = (position: PaperPosition) => position.status === "OPEN"
    ? humanTokenAmount(position.tokenAmountBaseUnits, position.tokenDecimals) * position.latestPriceUsdPerToken : 0;
  const equity = round(state.availableCashUsd + positions.reduce((sum, position) => sum + markedValue(position), 0));
  const bankroll = markPaperEquity(state.bankroll, equity);
  const topped = replenishPaperBankroll(bankroll, input.markedAt,
    PAPER_PORTFOLIO_POLICY.topUpUsd, PAPER_PORTFOLIO_POLICY.topUpBelowUsd);
  const limits = capacityForEquity(Math.max(state.highWaterEquityUsd, growthEquity({ ...state, bankroll: topped.state })), state.bankroll.initialBankrollUsd);
  return { ...state, bankroll: topped.state,
    availableCashUsd: round(state.availableCashUsd + (topped.event ? PAPER_PORTFOLIO_POLICY.topUpUsd : 0)),
    positions, lastMarkedAt: input.markedAt,
    highWaterEquityUsd: Math.max(state.highWaterEquityUsd, growthEquity({ ...state, bankroll: topped.state })),
    positionSizeUsd: limits.stake, maxConcurrentPositions: limits.slots };
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
  const sellCosts = quoteFeesUsd(input.sellQuote);
  const netProceeds = input.sellQuote.outputUsd - sellCosts;
  if (!Number.isFinite(netProceeds) || netProceeds < 0) {
    throw new Error("Sell quote has negative net proceeds after all execution fees.");
  }
  const pnl = round(netProceeds - previous.stakeUsd - previous.buyCostsUsd);
  const position: PaperPosition = { ...previous, latestPriceUsdPerToken: input.sellQuote.outputUsd /
      humanTokenAmount(previous.tokenAmountBaseUnits, previous.tokenDecimals), realizedPnlUsd: pnl, status: "CLOSED", exitReason: input.exitReason };
  const positions = [...state.positions]; positions[index] = position;
  const availableCashUsd = round(state.availableCashUsd + netProceeds);
  const equity = round(availableCashUsd + positions.filter(p => p.status === "OPEN")
    .reduce((sum, p) => sum + humanTokenAmount(p.tokenAmountBaseUnits, p.tokenDecimals) * p.latestPriceUsdPerToken, 0));
  const bankroll = markPaperEquity(state.bankroll, equity);
  const topped = replenishPaperBankroll(bankroll, input.closedAt,
    PAPER_PORTFOLIO_POLICY.topUpUsd, PAPER_PORTFOLIO_POLICY.topUpBelowUsd);
  const limits = capacityForEquity(Math.max(state.highWaterEquityUsd, growthEquity({ ...state, bankroll: topped.state })),
    topped.state.initialBankrollUsd);
  return {
    state: { ...state, bankroll: topped.state,
      availableCashUsd: round(availableCashUsd + (topped.event ? PAPER_PORTFOLIO_POLICY.topUpUsd : 0)),
      positions, highWaterEquityUsd: Math.max(state.highWaterEquityUsd, growthEquity({ ...state, bankroll: topped.state })),
      positionSizeUsd: limits.stake, maxConcurrentPositions: limits.slots },
    position
  };
}
