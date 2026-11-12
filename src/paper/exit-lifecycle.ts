import type { PaperPosition } from "./portfolio.js";
import type { OfflinePumpQuote, SolUsdReference, PaperExecutionCostEstimate, ExecutablePaperQuoteWithLatency } from "../ingestion/executable-paper-quote.js";
import { buildExecutablePaperQuote } from "../ingestion/executable-paper-quote.js";
import { canRequestPaperExitQuote, MARKET_EVIDENCE_MAX_AGE_MS, type PumpMarketState } from "./pump-market-state.js";
import { evaluateExit, DYNAMIC_EXIT_CALIBRATION_V1, type DynamicExitConfig, type ExitEvaluation, type ExitWindowObservation } from "../strategy/dynamic-exits.js";

export interface PaperExitQuoteContext {
  solUsd: SolUsdReference;
  costs: PaperExecutionCostEstimate;
}
export interface PaperExitExecutionInput {
  position: PaperPosition;
  marketState: PumpMarketState;
  windows: ExitWindowObservation[];
  emergencyReason?: string | null;
  strategyConfig?: DynamicExitConfig;
  nowMs?: number;
  quoteSell: (input: { mint: string; tokenAmountBaseUnits: string }) => Promise<{
    quote: OfflinePumpQuote; context: PaperExitQuoteContext;
  }>;
  /** Must persist a complete portfolio mark, including every other open position. */
  commitMark: (input: { positionId: string; sellQuote: ExecutablePaperQuoteWithLatency }) => Promise<unknown>;
  commitExit: (input: {
    positionId: string;
    sellQuote: ExecutablePaperQuoteWithLatency;
    exitReason: string;
  }) => Promise<unknown>;
}
export type PaperExitExecutionResult =
  | { status: "BLOCKED"; reason: string }
  | { status: "HOLD"; sellQuoteId: string; currentNetReturnPct: number; evaluations: ExitEvaluation[] }
  | { status: "DUPLICATE"; sellQuoteId: string; reason: string }
  | { status: "EXITED"; sellQuoteId: string; reason: string; commitResult: unknown };

function feeTotal(quote: ExecutablePaperQuoteWithLatency): number {
  return Object.values(quote.feeBreakdownUsd).reduce((sum, amount) => sum + amount, 0);
}
function wholeTokens(position: PaperPosition): number {
  const amount = Number(BigInt(position.tokenAmountBaseUnits)) / Math.pow(10, position.tokenDecimals);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Position token balance cannot be represented safely.");
  return amount;
}
function netReturnPct(netProceedsUsd: number, position: PaperPosition): number {
  if (!Number.isFinite(netProceedsUsd) || netProceedsUsd < 0 ||
      !Number.isFinite(position.stakeUsd) || position.stakeUsd <= 0 ||
      !Number.isFinite(position.buyCostsUsd) || position.buyCostsUsd < 0) {
    throw new Error("Net liquidation value or position accounting is invalid.");
  }
  return ((netProceedsUsd - position.stakeUsd - position.buyCostsUsd) / position.stakeUsd) * 100;
}
function expectedVenue(state: PumpMarketState): "PUMP_CURVE" | "PUMPSWAP" | null {
  if (state.status === "LIVE_CURVE") return "PUMP_CURVE";
  if (state.status === "MIGRATED_POOL_VERIFIED") return "PUMPSWAP";
  return null;
}

/**
 * Quote-gated exit lifecycle. A verified live curve or canonical migrated
 * pool is required before quoting; every sell quote must consume the complete
 * current token balance. Exit windows are evaluated independently at 2/5/10/30
 * seconds, while protective stops use the fresh executable liquidation value.
 */
export async function executePaperExit(input: PaperExitExecutionInput): Promise<PaperExitExecutionResult> {
  const executionNow = () => input.nowMs ?? Date.now();
  const now = executionNow();
  const position = input.position;
  if (!Number.isFinite(now) || !position.positionId.trim() ||
      !position.mint.trim() || position.status !== "OPEN") {
    return { status: "BLOCKED", reason: "Only a valid open paper position can be evaluated for exit." };
  }
  if (input.marketState.mint !== position.mint || !canRequestPaperExitQuote(input.marketState)) {
    return { status: "BLOCKED", reason: "Market is not verified for sell quoting; migration-pending and unverified markets remain blocked." };
  }
  const marketObservedAt = Date.parse(input.marketState.updatedAt);
  if (!Number.isFinite(marketObservedAt) || marketObservedAt > now ||
      now - marketObservedAt > MARKET_EVIDENCE_MAX_AGE_MS) {
    return { status: "BLOCKED", reason: "Verified market evidence is stale or from the future." };
  }
  const venue = expectedVenue(input.marketState);
  const expectedQuoteMint = input.marketState.status === "LIVE_CURVE"
    ? input.marketState.curve?.quoteMint
    : input.marketState.pool?.quoteMint;
  if (!venue || !expectedQuoteMint) {
    return { status: "BLOCKED", reason: "Verified market state is missing its quote mint or venue." };
  }

  try {
    const result = await input.quoteSell({
      mint: position.mint,
      tokenAmountBaseUnits: position.tokenAmountBaseUnits
    });
    const sdkQuote = result.quote;
    const actualVenue = "venue" in sdkQuote ? sdkQuote.venue : "PUMPSWAP";
    const marketSlot = input.marketState.status === "LIVE_CURVE"
      ? input.marketState.curve?.slot
      : input.marketState.pool?.slot;
    if (sdkQuote.side !== "SELL" || sdkQuote.mint !== position.mint ||
        sdkQuote.inputAmountBaseUnits !== position.tokenAmountBaseUnits ||
        sdkQuote.baseDecimals !== position.tokenDecimals ||
        sdkQuote.quoteMint !== expectedQuoteMint || actualVenue !== venue ||
        marketSlot === undefined || sdkQuote.slot < marketSlot) {
      return { status: "BLOCKED", reason: "Sell quote does not match the complete position balance, verified market venue, quote mint or market slot." };
    }
    const afterQuoteNow = executionNow();
    if (marketObservedAt > afterQuoteNow ||
        afterQuoteNow - marketObservedAt > MARKET_EVIDENCE_MAX_AGE_MS) {
      return { status: "BLOCKED", reason: "Verified market evidence expired while obtaining the sell quote." };
    }
    const sellQuote = buildExecutablePaperQuote({
      quote: sdkQuote, solUsd: result.context.solUsd,
      costs: result.context.costs, nowMs: afterQuoteNow
    });
    if (sellQuote.priceImpactPct > 2) {
      return { status: "BLOCKED", reason: "Price impact exceeds the 2% per-side execution limit." };
    }
    const netProceedsUsd = sellQuote.outputUsd - feeTotal(sellQuote);
    if (!Number.isFinite(netProceedsUsd) || netProceedsUsd < 0) {
      return { status: "BLOCKED", reason: "Executable sell quote has invalid net proceeds after all fees." };
    }
    const currentReturn = netReturnPct(netProceedsUsd, position);
    const tokens = wholeTokens(position);
    const currentNetPrice = netProceedsUsd / tokens;
    const highestPrice = Math.max(position.highWaterPriceUsdPerToken, currentNetPrice);
    const highestReturn = netReturnPct(highestPrice * tokens, position);
    const durations = [2, 5, 10, 30] as const;
    const config = input.strategyConfig ?? DYNAMIC_EXIT_CALIBRATION_V1;
    const evaluations = durations.map(windowSeconds => {
      const ordered = input.windows
        .filter(window => window.windowSeconds === windowSeconds &&
          Number.isSafeInteger(window.endedAtMs) && window.endedAtMs <= afterQuoteNow)
        .sort((a, b) => a.endedAtMs - b.endedAtMs);
      const latest = ordered[ordered.length - 1];
      const freshWindows = latest && afterQuoteNow - latest.endedAtMs <= windowSeconds * 1_500
        ? ordered : [];
      return evaluateExit({
        currentNetReturnPct: currentReturn,
        highestCompletedNetReturnPct: highestReturn,
        emergencyReason: input.emergencyReason ?? null,
        freshExecutableSellQuote: true,
        windowsOldestFirst: freshWindows
      }, config);
    });

    const selected = evaluations.find(evaluation => evaluation.action === "sell");
    if (!selected) {
      // The callback must collect any other open-position quotes needed by the
      // portfolio's complete-mark invariant before committing the mark.
      await input.commitMark({ positionId: position.positionId, sellQuote });
      return {
        status: "HOLD", sellQuoteId: sellQuote.quoteId,
        currentNetReturnPct: currentReturn, evaluations
      };
    }
    const reason = selected.reason === "dynamic_exhaustion"
      ? "DYNAMIC_EXHAUSTION"
      : selected.reason === "emergency_risk"
        ? "EMERGENCY_RISK"
        : selected.reason === "hard_stop" ? "HARD_STOP" : "PROTECTIVE_STOP";
    const commitResult = await input.commitExit({
      positionId: position.positionId, sellQuote, exitReason: reason
    });
    if (commitResult && typeof commitResult === "object" &&
        "status" in commitResult && commitResult.status === "DUPLICATE") {
      return { status: "DUPLICATE", sellQuoteId: sellQuote.quoteId, reason };
    }
    return { status: "EXITED", sellQuoteId: sellQuote.quoteId, reason, commitResult };
  } catch (error) {
    return {
      status: "BLOCKED",
      reason: error instanceof Error ? error.message : "Paper exit failed closed."
    };
  }
}
