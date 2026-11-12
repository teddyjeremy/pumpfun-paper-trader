import { createBankrollState, markPaperEquity, replenishPaperBankroll, type BankrollState } from "./session-ledger.js";

export interface ExecutablePaperQuote {
  quoteId: string;
  provider: string;
  mint: string;
  side: "BUY" | "SELL";
  observedAt: string;
  expiresAt: string;
  requestedUsd: number;
  outputAmountBaseUnits: string;
  outputUsd: number;
  priceImpactPct: number;
  taxPct: number;
  networkFeeUsd: number;
  providerFeeUsd: number;
  routeId: string;
  executable: boolean;
}
export interface PaperPosition {
  positionId: string;
  mint: string;
  openedAt: string;
  stakeUsd: number;
  tokenAmountBaseUnits: string;
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
function validPositive(value: number): boolean { return Number.isFinite(value) && value > 0; }
function assertQuote(quote: ExecutablePaperQuote, now: number, side: "BUY"|"SELL", mint: string): void {
  if (!quote.executable || quote.side !== side || quote.mint !== mint ||
      !quote.quoteId || !quote.provider || !quote.routeId) throw new Error("Executable quote identity or status is invalid.");
  const observed = Date.parse(quote.observedAt), expires = Date.parse(quote.expiresAt);
  if (!Number.isFinite(observed) || !Number.isFinite(expires) || observed > now ||
      now - observed > PAPER_PORTFOLIO_POLICY.maxQuoteAgeMs || expires <= now) {
    throw new Error("Executable quote is stale or expired.");
  }
  if (!validPositive(quote.outputUsd) || !/^\d+$/.test(quote.outputAmountBaseUnits) ||
      BigInt(quote.outputAmountBaseUnits) <= 0n || !Number.isFinite(quote.priceImpactPct) ||
      !Number.isFinite(quote.taxPct) || quote.priceImpactPct < 0 || quote.taxPct < 0 ||
      !Number.isFinite(quote.networkFeeUsd) || quote.networkFeeUsd < 0 ||
      !Number.isFinite(quote.providerFeeUsd) || quote.providerFeeUsd < 0) {
    throw new Error("Quote contains invalid amount or cost evidence.");
  }
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
      Math.abs(input.sellQuote.requestedUsd - stake) > 0.00000001) {
    throw new Error("Quotes must be size-specific for the exact planned stake.");
  }
  const roundTripPct = input.buyQuote.priceImpactPct + input.sellQuote.priceImpactPct +
    input.buyQuote.taxPct + input.sellQuote.taxPct +
    ((input.buyQuote.networkFeeUsd + input.buyQuote.providerFeeUsd +
      input.sellQuote.networkFeeUsd + input.sellQuote.providerFeeUsd) / stake) * 100;
  if (input.buyQuote.priceImpactPct > PAPER_PORTFOLIO_POLICY.maxImpactPerSidePct ||
      input.sellQuote.priceImpactPct > PAPER_PORTFOLIO_POLICY.maxImpactPerSidePct ||
      input.buyQuote.taxPct > PAPER_PORTFOLIO_POLICY.maxTaxPerSidePct ||
      input.sellQuote.taxPct > PAPER_PORTFOLIO_POLICY.maxTaxPerSidePct ||
      roundTripPct > PAPER_PORTFOLIO_POLICY.maxRoundTripCostPct) {
    throw new Error("Round-trip execution cost exceeds the paper entry limits.");
  }
  const buyCosts = input.buyQuote.networkFeeUsd + input.buyQuote.providerFeeUsd;
  const tokens = BigInt(input.buyQuote.outputAmountBaseUnits);
  const entryPrice = stake / Number(tokens);
  if (!validPositive(entryPrice)) throw new Error("Buy quote produced an invalid entry price.");
  const position: PaperPosition = {
    positionId: input.positionId, mint: input.mint, openedAt: input.occurredAt,
    stakeUsd: stake, tokenAmountBaseUnits: tokens.toString(), buyQuoteId: input.buyQuote.quoteId,
    entryPriceUsdPerToken: entryPrice, buyCostsUsd: round(buyCosts),
    highWaterPriceUsdPerToken: entryPrice, latestPriceUsdPerToken: entryPrice,
    realizedPnlUsd: null, status: "OPEN", exitReason: null
  };
  const availableCashUsd = round(state.availableCashUsd - stake - buyCosts);
  if (availableCashUsd < 0) throw new Error("Buy fees exceed available paper cash.");
  const positions = [...state.positions, position];
  const equity = round(availableCashUsd + positions.reduce((sum, p) =>
    sum + (p.status === "OPEN" ? p.stakeUsd : 0), 0));
  const bankroll = markPaperEquity(state.bankroll, equity);
  const topped = replenishPaperBankroll(bankroll, input.occurredAt,
    PAPER_PORTFOLIO_POLICY.topUpUsd, PAPER_PORTFOLIO_POLICY.topUpBelowUsd);
  const cashAfterTopUp = round(availableCashUsd + (topped.event ? PAPER_PORTFOLIO_POLICY.topUpUsd : 0));
  const limits = capacityForEquity(Math.max(state.highWaterEquityUsd, topped.state.currentEquityUsd), state.bankroll.initialBankrollUsd);
  return {
    state: { ...state, bankroll: topped.state, availableCashUsd: cashAfterTopUp,
      positions, enteredMints: [...state.enteredMints, input.mint],
      highWaterEquityUsd: Math.max(state.highWaterEquityUsd, topped.state.currentEquityUsd),
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
    ? Number(BigInt(position.tokenAmountBaseUnits)) * position.latestPriceUsdPerToken : 0;
  const equity = round(state.availableCashUsd + positions.reduce((sum, position) => sum + markedValue(position), 0));
  const bankroll = markPaperEquity(state.bankroll, equity);
  const topped = replenishPaperBankroll(bankroll, input.markedAt,
    PAPER_PORTFOLIO_POLICY.topUpUsd, PAPER_PORTFOLIO_POLICY.topUpBelowUsd);
  const limits = capacityForEquity(Math.max(state.highWaterEquityUsd, topped.state.currentEquityUsd), state.bankroll.initialBankrollUsd);
  return { ...state, bankroll: topped.state,
    availableCashUsd: round(state.availableCashUsd + (topped.event ? PAPER_PORTFOLIO_POLICY.topUpUsd : 0)),
    positions, lastMarkedAt: input.markedAt,
    highWaterEquityUsd: Math.max(state.highWaterEquityUsd, topped.state.currentEquityUsd),
    positionSizeUsd: limits.stake, maxConcurrentPositions: limits.slots };
}
export function closePaperPosition(state: PaperPortfolioState, input: {
  positionId: string; sellQuote: ExecutablePaperQuote; exitReason: string; closedAt: string; nowMs?: number;
}): { state: PaperPortfolioState; position: PaperPosition } {
  const index = state.positions.findIndex(position => position.positionId === input.positionId);
  const previous = state.positions[index];
  if (!previous || previous.status !== "OPEN") throw new Error("Open paper position not found.");
  assertQuote(input.sellQuote, input.nowMs ?? Date.now(), "SELL", previous.mint);
  if (BigInt(input.sellQuote.outputAmountBaseUnits) !== BigInt(previous.tokenAmountBaseUnits)) {
    throw new Error("Exit quote must cover the entire remaining token balance.");
  }
  const sellCosts = input.sellQuote.networkFeeUsd + input.sellQuote.providerFeeUsd;
  const netProceeds = input.sellQuote.outputUsd - sellCosts;
  const pnl = round(netProceeds - previous.stakeUsd - previous.buyCostsUsd);
  const position: PaperPosition = { ...previous, latestPriceUsdPerToken: input.sellQuote.outputUsd /
      Number(BigInt(previous.tokenAmountBaseUnits)), realizedPnlUsd: pnl, status: "CLOSED", exitReason: input.exitReason };
  const positions = [...state.positions]; positions[index] = position;
  const availableCashUsd = round(state.availableCashUsd + netProceeds);
  const equity = round(availableCashUsd + positions.filter(p => p.status === "OPEN")
    .reduce((sum, p) => sum + Number(BigInt(p.tokenAmountBaseUnits)) * p.latestPriceUsdPerToken, 0));
  const bankroll = markPaperEquity(state.bankroll, equity);
  const topped = replenishPaperBankroll(bankroll, input.closedAt,
    PAPER_PORTFOLIO_POLICY.topUpUsd, PAPER_PORTFOLIO_POLICY.topUpBelowUsd);
  const limits = capacityForEquity(Math.max(state.highWaterEquityUsd, topped.state.currentEquityUsd),
    topped.state.initialBankrollUsd);
  return {
    state: { ...state, bankroll: topped.state,
      availableCashUsd: round(availableCashUsd + (topped.event ? PAPER_PORTFOLIO_POLICY.topUpUsd : 0)),
      positions, highWaterEquityUsd: Math.max(state.highWaterEquityUsd, topped.state.currentEquityUsd),
      positionSizeUsd: limits.stake, maxConcurrentPositions: limits.slots },
    position
  };
}
