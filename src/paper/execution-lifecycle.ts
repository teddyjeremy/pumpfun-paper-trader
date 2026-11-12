import type { PaperPortfolioState } from "./portfolio.js";
import type { OfflinePumpQuote, SolUsdReference, PaperExecutionCostEstimate } from "../ingestion/executable-paper-quote.js";
import { buildExecutablePaperQuote } from "../ingestion/executable-paper-quote.js";
import type { ExecutablePaperQuoteWithLatency } from "../ingestion/executable-paper-quote.js";

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
  quoteBuy: (input: { mint: string; stakeUsd: number }) => Promise<{
    quote: OfflinePumpQuote; context: PaperEntryQuoteContext;
  }>;
  quoteSell: (input: { mint: string; tokenAmountBaseUnits: string }) => Promise<{
    quote: OfflinePumpQuote; context: PaperEntryQuoteContext;
  }>;
  commitEntry: (input: {
    mint: string;
    positionId: string;
    buyQuote: ExecutablePaperQuoteWithLatency;
    sellQuote: ExecutablePaperQuoteWithLatency;
  }) => Promise<unknown>;
}

export type PaperEntryExecutionResult =
  | { status: "BLOCKED"; reason: string }
  | { status: "ENTERED"; buyQuoteId: string; sellQuoteId: string; commitResult: unknown };

/**
 * Fail-closed bridge from a fully passing strategy signal to a durable paper
 * entry. The quote callbacks must return official-SDK offline exact-size
 * quotes from verified account snapshots. The commit callback is expected to
 * use the Durable Object's atomic/idempotent portfolio transition.
 *
 * WATCH/REJECT decisions, unknown rules, unavailable quotes and stale quotes
 * cannot create positions. This is deliberately dormant while the current
 * strategy evaluator keeps buyAllowed=false pending calibration.
 */
export async function executePaperEntry(input: PaperEntryExecutionInput): Promise<PaperEntryExecutionResult> {
  const now = input.nowMs ?? Date.now();
  if (!input.mint.trim() || !input.positionId.trim() ||
      !Number.isFinite(Date.parse(input.occurredAt)) || !Number.isFinite(now)) {
    return { status: "BLOCKED", reason: "Entry identity or execution clock is invalid." };
  }
  if (input.strategy.decision !== "BUY" || input.strategy.buyAllowed !== true) {
    return { status: "BLOCKED", reason: "Strategy has not explicitly authorized a BUY." };
  }
  if (!Array.isArray(input.strategy.rules) || input.strategy.rules.length === 0 ||
      input.strategy.rules.some(rule => rule.status !== "PASS")) {
    return { status: "BLOCKED", reason: "Every mandatory strategy rule must PASS; FAIL and UNKNOWN both block entry." };
  }
  if (input.portfolio.enteredMints.includes(input.mint)) {
    return { status: "BLOCKED", reason: "This mint has already been entered in the paper session." };
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
      quote: buy.quote, solUsd: buy.context.solUsd, costs: buy.context.costs, nowMs: now
    });
    if (Math.abs(buyQuote.requestedUsd - stakeUsd) > 0.00000001) {
      return { status: "BLOCKED", reason: "Buy quote does not match the exact planned paper stake." };
    }

    const sell = await input.quoteSell({
      mint: input.mint, tokenAmountBaseUnits: buyQuote.outputAmountBaseUnits
    });
    if (sell.quote.side !== "SELL" || sell.quote.mint !== input.mint ||
        sell.quote.inputAmountBaseUnits !== buyQuote.outputAmountBaseUnits) {
      return { status: "BLOCKED", reason: "Initial sell quote is not exact-size for the complete purchased token balance." };
    }
    const sellQuote = buildExecutablePaperQuote({
      quote: sell.quote, solUsd: sell.context.solUsd, costs: sell.context.costs, nowMs: now
    });

    const commitResult = await input.commitEntry({
      mint: input.mint, positionId: input.positionId, buyQuote, sellQuote
    });
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
