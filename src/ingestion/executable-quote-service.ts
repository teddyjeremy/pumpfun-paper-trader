import {
  buildExecutablePaperQuote,
  type ExecutablePaperQuoteWithLatency,
  type OfflinePumpQuote,
  type PaperExecutionCostEstimate,
  type SolUsdReference
} from "./executable-paper-quote.js";
import { fetchHeliusPriorityFeeSamples, buildPaperNetworkFeeEstimate } from "./helius-priority-fee.js";
import type { HeliusRpcConfig } from "./helius.js";
import { fetchSolUsdPrice } from "./sol-usd-price.js";

export type QuoteSide = "BUY" | "SELL";
export type OfflineQuoteFetcher = (input: {
  side: QuoteSide;
  amountBaseUnits: string;
}) => Promise<OfflinePumpQuote>;

export interface ExecutableRoundTripQuote {
  status: "READY";
  buyQuote: ExecutablePaperQuoteWithLatency;
  initialSellQuote: ExecutablePaperQuoteWithLatency;
  sellability: {
    sellable: true;
    mint: string;
    venue: "PUMP_CURVE" | "PUMPSWAP";
    quoteMint: string;
    tokenAmountBaseUnits: string;
    buySlot: number;
    sellSlot: number;
    buySnapshotAgeMs: number;
    sellSnapshotAgeMs: number;
  };
  economics: {
    entryCashDebitUsd: number;
    exitNetProceedsUsd: number;
    roundTripNetReturnPct: number;
    meetsMinimumNetReturn: boolean;
    minimumNetReturnPct: number;
  };
  networkFeeEstimate: ReturnType<typeof buildPaperNetworkFeeEstimate>;
  assumptions: {
    quoteTtlMs: number;
    executionDelayMs: number;
    providerFeeUsdPerTransaction: number;
    priceImpactLimitPct: number;
    priorityFeePercentile: number;
    priorityFeeScope: "ACCOUNT_SPECIFIC" | "CLUSTER_WIDE";
  };
}

/**
 * Produces a fresh exact-size buy quote and an immediate full-output sellability
 * quote. This is a read-only quote check; it does not create a position or fill.
 */
export async function fetchExecutableRoundTripQuote(input: {
  fetchQuote: OfflineQuoteFetcher;
  helius: HeliusRpcConfig;
  buyAmountBaseUnits: string;
  computeUnitLimit: number;
  writableAccounts?: string[];
  signatureCount?: number;
  priorityFeePercentile?: number;
  maxPriorityFeeLamports?: string;
  baseFeeLamportsPerSignature?: number;
  providerFeeUsdPerTransaction?: number;
  executionDelayMs?: number;
  quoteTtlMs?: number;
  maxPriceImpactPct?: number;
  minimumRoundTripNetReturnPct?: number;
  solUsd?: SolUsdReference;
  now?: () => number;
}): Promise<ExecutableRoundTripQuote> {
  const now = input.now ?? Date.now;
  const executionDelayMs = input.executionDelayMs ?? 250;
  const quoteTtlMs = input.quoteTtlMs ?? 2_000;
  const maxPriceImpactPct = input.maxPriceImpactPct ?? 2;
  const minimumNetReturnPct = input.minimumRoundTripNetReturnPct ?? 0;
  const providerFeeUsd = input.providerFeeUsdPerTransaction ?? 0;
  const percentile = input.priorityFeePercentile ?? 75;
  if (!/^\d+$/.test(input.buyAmountBaseUnits) || BigInt(input.buyAmountBaseUnits) <= 0n) {
    throw new Error("Buy quote amount must be a positive unsigned base-unit integer.");
  }
  if (!Number.isSafeInteger(executionDelayMs) || executionDelayMs < 0 || executionDelayMs > 1_000) {
    throw new Error("Paper execution delay must be an integer between 0 and 1000 ms.");
  }
  if (!Number.isFinite(maxPriceImpactPct) || maxPriceImpactPct <= 0 || maxPriceImpactPct > 100) {
    throw new Error("Maximum price impact must be greater than 0 and at most 100 percent.");
  }
  if (!Number.isFinite(minimumNetReturnPct) || minimumNetReturnPct < -100 || minimumNetReturnPct > 10_000) {
    throw new Error("Minimum round-trip net return threshold is invalid.");
  }
  if (!Number.isFinite(providerFeeUsd) || providerFeeUsd < 0) {
    throw new Error("Provider fee must be finite and non-negative.");
  }
  if (!Number.isSafeInteger(quoteTtlMs) || quoteTtlMs < 100 || quoteTtlMs > 2_000) {
    throw new Error("Quote TTL must be between 100 and 2000 ms.");
  }
  const startedAt = now();
  const [rawBuy, feeSamples, priceResult] = await Promise.all([
    input.fetchQuote({ side: "BUY", amountBaseUnits: input.buyAmountBaseUnits }),
    fetchHeliusPriorityFeeSamples({ config: input.helius, writableAccounts: input.writableAccounts }),
    input.solUsd
      ? Promise.resolve({ status: "AVAILABLE" as const, observation: {
          source: "binance-spot" as const, symbol: "SOLUSDT" as const,
          priceUsd: input.solUsd.priceUsd, observedAt: input.solUsd.observedAt,
          ageMs: Math.max(0, startedAt - Date.parse(input.solUsd.observedAt))
        } })
      : fetchSolUsdPrice({ nowMs: startedAt })
  ]);
  if (priceResult.status !== "AVAILABLE") {
    throw new Error(`SOL/USD reference unavailable: ${priceResult.reason}`);
  }
  const networkFeeEstimate = buildPaperNetworkFeeEstimate({
    samples: feeSamples,
    computeUnitLimit: input.computeUnitLimit,
    signatureCount: input.signatureCount,
    priorityFeePercentile: percentile,
    baseFeeLamportsPerSignature: input.baseFeeLamportsPerSignature,
    maxPriorityFeeLamports: input.maxPriorityFeeLamports,
    writableAccountCount: input.writableAccounts?.length ?? 0
  });
  const buyFetchedAt = now();
  const buyLatencyMs = Math.max(0, Math.ceil(buyFetchedAt - startedAt));
  const buyCosts: PaperExecutionCostEstimate = {
    networkFeeLamports: networkFeeEstimate.networkFeeLamports,
    priorityFeeLamports: networkFeeEstimate.priorityFeeLamports,
    providerFeeUsd,
    simulatedLatencyMs: buyLatencyMs + executionDelayMs,
    quoteTtlMs
  };
  if (rawBuy.side !== "BUY") throw new Error("Buy quote adapter returned a non-BUY quote.");
  const buyQuote = buildExecutablePaperQuote({
    quote: rawBuy, solUsd: priceResult.observation, costs: buyCosts, nowMs: buyFetchedAt
  });
  if (buyQuote.priceImpactPct > maxPriceImpactPct) {
    throw new Error("Buy quote exceeds the configured maximum price impact.");
  }

  const sellStartedAt = now();
  const rawSell = await input.fetchQuote({
    side: "SELL", amountBaseUnits: buyQuote.outputAmountBaseUnits
  });
  const sellFetchedAt = now();
  const sellLatencyMs = Math.max(0, Math.ceil(sellFetchedAt - sellStartedAt));
  const sellCosts: PaperExecutionCostEstimate = {
    ...buyCosts,
    simulatedLatencyMs: sellLatencyMs + executionDelayMs
  };
  if (rawSell.side !== "SELL") throw new Error("Sell quote adapter returned a non-SELL quote.");
  const initialSellQuote = buildExecutablePaperQuote({
    quote: rawSell, solUsd: priceResult.observation, costs: sellCosts, nowMs: sellFetchedAt
  });
  if (initialSellQuote.priceImpactPct > maxPriceImpactPct) {
    throw new Error("Exact-size initial sell quote exceeds the configured maximum price impact.");
  }
  if (initialSellQuote.inputAmountBaseUnits !== buyQuote.outputAmountBaseUnits) {
    throw new Error("Initial sell quote is not sized to the exact net token output of the buy quote.");
  }
  if (initialSellQuote.mint !== buyQuote.mint ||
      initialSellQuote.venue !== buyQuote.venue ||
      initialSellQuote.quoteMint !== buyQuote.quoteMint) {
    throw new Error("Buy and initial sell quotes do not describe the same mint, venue and quote mint.");
  }
  if (initialSellQuote.slot < buyQuote.slot) {
    throw new Error("Initial sell quote is older than the buy quote snapshot.");
  }
  const buyAgeMs = Math.max(0, buyFetchedAt - Date.parse(rawBuy.observedAt));
  const sellAgeMs = Math.max(0, sellFetchedAt - Date.parse(rawSell.observedAt));
  if (buyAgeMs > quoteTtlMs || sellAgeMs > quoteTtlMs) {
    throw new Error("Buy or initial sell quote expired before the sellability check completed.");
  }
  const totalFees = (quote: ExecutablePaperQuoteWithLatency): number =>
    quote.feeBreakdownUsd.protocol + quote.feeBreakdownUsd.creator +
    quote.feeBreakdownUsd.pool + quote.feeBreakdownUsd.pumpAggregate +
    quote.feeBreakdownUsd.network + quote.feeBreakdownUsd.priority +
    quote.feeBreakdownUsd.provider;
  const entryCashDebitUsd = buyQuote.requestedUsd + totalFees(buyQuote);
  const exitNetProceedsUsd = initialSellQuote.outputUsd - totalFees(initialSellQuote);
  if (!(entryCashDebitUsd > 0) || !Number.isFinite(exitNetProceedsUsd)) {
    throw new Error("Round-trip quote economics are not finite or positive.");
  }
  const roundTripNetReturnPct = (exitNetProceedsUsd - entryCashDebitUsd) / entryCashDebitUsd * 100;
  if (!Number.isFinite(roundTripNetReturnPct)) {
    throw new Error("Round-trip net return calculation is not finite.");
  }
  return {
    status: "READY",
    buyQuote,
    initialSellQuote,
    sellability: {
      sellable: true,
      mint: buyQuote.mint,
      venue: buyQuote.venue,
      quoteMint: buyQuote.quoteMint,
      tokenAmountBaseUnits: buyQuote.outputAmountBaseUnits,
      buySlot: buyQuote.slot,
      sellSlot: initialSellQuote.slot,
      buySnapshotAgeMs: buyAgeMs,
      sellSnapshotAgeMs: sellAgeMs
    },
    economics: {
      entryCashDebitUsd, exitNetProceedsUsd, roundTripNetReturnPct,
      meetsMinimumNetReturn: roundTripNetReturnPct >= minimumNetReturnPct,
      minimumNetReturnPct
    },
    networkFeeEstimate,
    assumptions: {
      quoteTtlMs, executionDelayMs, providerFeeUsdPerTransaction: providerFeeUsd,
      priceImpactLimitPct: maxPriceImpactPct, priorityFeePercentile: percentile,
      priorityFeeScope: networkFeeEstimate.priorityFeeScope
    }
  };
}
