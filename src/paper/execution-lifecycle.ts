import type { PaperPortfolioState } from "./portfolio.js";
import type { OfflinePumpQuote, SolUsdReference, PaperExecutionCostEstimate, ExecutablePaperQuoteWithLatency } from "../ingestion/executable-paper-quote.js";
import { buildExecutablePaperQuote } from "../ingestion/executable-paper-quote.js";

export interface PaperEntryStrategyDecision {
  decision: "BUY" | "WATCH" | "REJECT";
  buyAllowed: boolean;
  rules: Array<{ rule: string; status: "PASS" | "FAIL" | "UNKNOWN" }>;
}
export interface PaperEntryQuoteContext {
  solUsd: SolUsdReference;
  costs: PaperExecutionCostEstimate;
}
export interface PaperEntryExecutionInput {
  mint: string;
  positionId: string;
  occurredAt: string;
  nowMs?: number;
  strategy: PaperEntryStrategyDecision;
  portfolio: PaperPortfolioState;
  quoteBuy: (input: { mint: string; stakeUsd: number }) => Promise<{ quote: OfflinePumpQuote; context: PaperEntryQuoteContext }>;
  quoteSell: (input: { mint: string; tokenAmountBaseUnits: string }) => Promise<{ quote: OfflinePumpQuote; context: PaperEntryQuoteContext }>;
  commitEntry: (input: {
    mint: string;
    positionId: string;
    buyQuote: ExecutablePaperQuoteWithLatency;
    sellQuote: ExecutablePaperQuoteWithLatency;
  }) => Promise<unknown>;
}
const REQUIRED_ENTRY_RULES = Object.freeze([
  "CANDIDATE_AGE",
  "IMPULSE",
  "PULLBACK",
  "RECLAIM",
  "THREE_FLOW_WINDOWS",
  "DISTINCT_BUYERS",
  "BUYER_CONCENTRATION",
  "CREATOR_SELL_RISK",
  "WALLET_CLUSTER_RISK",
  "ATTRIBUTION_CONFIDENCE",
  "PULLBACK_VOLUME_CONTRACTION",
  "RECLAIM_VOLUME_EXPANSION",
  "SIGNAL_FRESHNESS",
  "EXECUTABLE_QUOTE",
  "ROUND_TRIP_COST"
] as const);

export type PaperEntryExecutionResult =
  | { status: "BLOCKED"; reason: string }
  | { status: "DUPLICATE"; buyQuoteId: string; sellQuoteId: string }
  | { status: "ENTERED"; buyQuoteId: string; sellQuoteId: string; commitResult: unknown };

/**
 * Fail-closed bridge from a fully passing strategy signal to a durable paper
 * entry. Quote callbacks must return official-SDK offline quotes from verified
 * account snapshots; commitEntry must use an atomic/idempotent Durable Object
 * portfolio transition. The current strategy remains WATCH/REJECT until its
 * volume thresholds and quote gate are calibrated.
 */
export async function executePaperEntry(input: PaperEntryExecutionInput): Promise<PaperEntryExecutionResult> {
  const executionNow = () => input.nowMs ?? Date.now();
  if (!input.mint.trim() || !input.positionId.trim() ||
      !Number.isFinite(Date.parse(input.occurredAt)) || !Number.isFinite(executionNow())) {
    return { status: "BLOCKED", reason: "Entry identity or execution clock is invalid." };
  }
  if (input.strategy.decision !== "BUY" || input.strategy.buyAllowed !== true) {
    return { status: "BLOCKED", reason: "Strategy has not explicitly authorized a BUY." };
  }
  if (!Array.isArray(input.strategy.rules) || input.strategy.rules.length !== REQUIRED_ENTRY_RULES.length) {
    return { status: "BLOCKED", reason: "The complete mandatory strategy rule set is required; missing or extra rules block entry." };
  }
  const suppliedRules = new Map<string, string>();
  for (const rule of input.strategy.rules) {
    if (!rule || typeof rule.rule !== "string" || suppliedRules.has(rule.rule)) {
      return { status: "BLOCKED", reason: "Strategy rules must have unique, valid rule identifiers." };
    }
    suppliedRules.set(rule.rule, rule.status);
  }
  if (REQUIRED_ENTRY_RULES.some(rule => suppliedRules.get(rule) !== "PASS") ||
      [...suppliedRules.keys()].some(rule => !(REQUIRED_ENTRY_RULES as readonly string[]).includes(rule))) {
    return { status: "BLOCKED", reason: "Every recognized mandatory strategy rule must PASS exactly once; FAIL, UNKNOWN, missing, duplicate and unrecognized rules all block entry." };
  }
  if (input.portfolio.enteredMints.includes(input.mint)) {
    return { status: "BLOCKED", reason: "This mint has already been entered in the paper session." };
  }
  if (input.portfolio.positions.some(position => position.positionId === input.positionId)) {
    return { status: "BLOCKED", reason: "Position ID already exists in the paper session." };
  }
  const openPositions = input.portfolio.positions.filter(position => position.status !== "CLOSED");
  if (openPositions.length >= input.portfolio.maxConcurrentPositions) {
    return { status: "BLOCKED", reason: "Maximum concurrent paper positions reached." };
  }
  const stakeUsd = input.portfolio.positionSizeUsd;
  if (!Number.isFinite(stakeUsd) || stakeUsd <= 0 || input.portfolio.availableCashUsd < stakeUsd) {
    return { status: "BLOCKED", reason: "Paper cash is insufficient for the current position size." };
  }

  try {
    const buy = await input.quoteBuy({ mint: input.mint, stakeUsd });
    if (buy.quote.side !== "BUY" || buy.quote.mint !== input.mint) {
      return { status: "BLOCKED", reason: "Buy adapter returned a quote for the wrong side or mint." };
    }
    const buyQuote = buildExecutablePaperQuote({
      quote: buy.quote, solUsd: buy.context.solUsd, costs: buy.context.costs, nowMs: executionNow()
    });
    if (Math.abs(buyQuote.requestedUsd - stakeUsd) > 0.00000001) {
      return { status: "BLOCKED", reason: "Buy quote does not match the exact planned paper stake." };
    }

    const sell = await input.quoteSell({
      mint: input.mint, tokenAmountBaseUnits: buyQuote.outputAmountBaseUnits
    });
    const buyVenue = "venue" in buy.quote ? buy.quote.venue : "PUMPSWAP";
    const sellVenue = "venue" in sell.quote ? sell.quote.venue : "PUMPSWAP";
    if (sell.quote.side !== "SELL" || sell.quote.mint !== input.mint ||
        sell.quote.inputAmountBaseUnits !== buyQuote.outputAmountBaseUnits ||
        sellVenue !== buyVenue || sell.quote.quoteMint !== buy.quote.quoteMint) {
      return { status: "BLOCKED", reason: "Initial sell quote is not exact-size for the complete purchased token balance on the same venue and quote mint." };
    }
    const sellQuote = buildExecutablePaperQuote({
      quote: sell.quote, solUsd: sell.context.solUsd, costs: sell.context.costs, nowMs: executionNow()
    });

    // These limits are already part of the documented strategy audit. Keep
    // them enforced at the final execution boundary as well: a passing signal
    // must not bypass quote economics.
    if (buyQuote.priceImpactPct > 2 || sellQuote.priceImpactPct > 2) {
      return { status: "BLOCKED", reason: "Price impact exceeds the 2% per-side execution limit." };
    }
    const feeUsd = (quote: ExecutablePaperQuoteWithLatency) =>
      Object.values(quote.feeBreakdownUsd).reduce((sum, amount) => sum + amount, 0);
    const roundTripFeesUsd = feeUsd(buyQuote) + feeUsd(sellQuote);
    const roundTripFeePct = roundTripFeesUsd / stakeUsd * 100;
    if (!Number.isFinite(roundTripFeePct) || roundTripFeePct > 4) {
      return { status: "BLOCKED", reason: "Combined buy/sell fees exceed the 4% round-trip execution-cost limit." };
    }
    const netLiquidationUsd = sellQuote.outputUsd - feeUsd(sellQuote);
    if (!Number.isFinite(netLiquidationUsd) || netLiquidationUsd <= 0) {
      return { status: "BLOCKED", reason: "Exact-size initial sell quote has no positive net liquidation value after fees." };
    }

    const buyObservedAt = Date.parse(buyQuote.observedAt);
    const sellObservedAt = Date.parse(sellQuote.observedAt);
    if (Math.abs(sellObservedAt - buyObservedAt) > 2_000) {
      return { status: "BLOCKED", reason: "Buy and initial sell quotes are not from a coherent two-second market window." };
    }

    const commitResult = await input.commitEntry({
      mint: input.mint, positionId: input.positionId, buyQuote, sellQuote
    });
    if (commitResult && typeof commitResult === "object" &&
        "status" in commitResult && commitResult.status === "DUPLICATE") {
      return { status: "DUPLICATE", buyQuoteId: buyQuote.quoteId, sellQuoteId: sellQuote.quoteId };
    }
    return {
      status: "ENTERED",
      buyQuoteId: buyQuote.quoteId,
      sellQuoteId: sellQuote.quoteId,
      commitResult
    };
  } catch (error) {
    return {
      status: "BLOCKED",
      reason: error instanceof Error ? error.message : "Paper entry failed closed."
    };
  }
}
