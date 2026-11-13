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
import { fetchPumpCurveSdkQuote } from "./pump-sdk-curve-quote-adapter.js";
import { fetchPumpSwapSdkQuote } from "./pump-sdk-quote-adapter.js";
import type { HeliusAccountReadConfig } from "./helius-accounts.js";
import type { UnsignedInstructionFeeEvidence } from "./solana-fee-estimator.js";
import { buildHeliusRpcUrl } from "./helius.js";
import { buildPumpCurveV3UnsignedPlan, buildPumpSwapV2UnsignedPlan } from "./pump-unsigned-plan.js";
import type { NonSigningVirtualTraderIdentity } from "./virtual-trader-identity.js";

export type QuoteSide = "BUY" | "SELL";
export type OfflineQuoteFetcher = (input: {
  side: QuoteSide;
  amountBaseUnits: string;
}) => Promise<OfflinePumpQuote>;

export type ExactUnsignedFeeEvidenceBuilder = (input: {
  side: QuoteSide;
  quote: OfflinePumpQuote;
}) => Promise<UnsignedInstructionFeeEvidence>;

/** Creates a curve quote callback backed by the verified Helius account snapshot adapter. */
export function createPumpCurveOfflineQuoteFetcher(input: {
  mint: string;
  config: HeliusAccountReadConfig;
}): OfflineQuoteFetcher {
  return request => fetchPumpCurveSdkQuote({
    mint: input.mint, side: request.side,
    amountBaseUnits: request.amountBaseUnits, config: input.config
  });
}

/** Creates a PumpSwap quote callback backed by the verified pool/account snapshot adapter. */
export function createPumpSwapOfflineQuoteFetcher(input: {
  mint: string;
  poolAddress: string;
  config: HeliusAccountReadConfig;
}): OfflineQuoteFetcher {
  return request => fetchPumpSwapSdkQuote({
    mint: input.mint, poolAddress: input.poolAddress, side: request.side,
    amountBaseUnits: request.amountBaseUnits, config: input.config
  });
}

export interface ExecutableRoundTripQuote {
  status: "QUOTES_VALIDATED";
  paperEntryAuthorized: false;
  buyQuote: ExecutablePaperQuoteWithLatency;
  initialSellQuote: ExecutablePaperQuoteWithLatency;
  sellability: {
    quoteSellable: true;
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
    buyFeePct: number;
    sellFeePct: number;
    combinedPriceImpactPct: number;
    combinedTransferTaxPct: number;
    roundTripCostPct: number;
    meetsRoundTripCostLimit: boolean;
    maximumRoundTripCostPct: number;
    meetsMinimumNetReturn: boolean;
    minimumNetReturnPct: number;
  };
  networkFeeEstimate: ReturnType<typeof buildPaperNetworkFeeEstimate>;
  exactFeeEvidence?: { buy: UnsignedInstructionFeeEvidence; sell: UnsignedInstructionFeeEvidence };
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
 * quote. This is a read-only quote check; it does not authorize an entry,
 * create a position, record a fill or submit a transaction.
 */
export async function fetchExecutableRoundTripQuote(input: {
  fetchQuote: OfflineQuoteFetcher;
  helius: HeliusRpcConfig;
  buildExactFeeEvidence?: ExactUnsignedFeeEvidenceBuilder;
  requireExactMessageFees?: boolean;
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
  maximumRoundTripCostPct?: number;
  solUsd?: SolUsdReference;
  now?: () => number;
}): Promise<ExecutableRoundTripQuote> {
  const now = input.now ?? Date.now;
  const executionDelayMs = input.executionDelayMs ?? 250;
  const quoteTtlMs = input.quoteTtlMs ?? 2_000;
  const maxPriceImpactPct = input.maxPriceImpactPct ?? 2;
  const minimumNetReturnPct = input.minimumRoundTripNetReturnPct ?? 0;
  const maximumRoundTripCostPct = input.maximumRoundTripCostPct ?? 4;
  const providerFeeUsd = input.providerFeeUsdPerTransaction ?? 0;
  const percentile = input.priorityFeePercentile ?? 75;
  if (!/^\d+$/.test(input.buyAmountBaseUnits) || BigInt(input.buyAmountBaseUnits) <= 0n ||
      BigInt(input.buyAmountBaseUnits) > 18_446_744_073_709_551_615n) {
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
  if (!Number.isFinite(maximumRoundTripCostPct) || maximumRoundTripCostPct < 0 || maximumRoundTripCostPct > 100) {
    throw new Error("Maximum round-trip cost threshold is invalid.");
  }
  if (!Number.isFinite(providerFeeUsd) || providerFeeUsd < 0) {
    throw new Error("Provider fee must be finite and non-negative.");
  }
  if (!Number.isSafeInteger(quoteTtlMs) || quoteTtlMs < 100 || quoteTtlMs > 2_000) {
    throw new Error("Quote TTL must be between 100 and 2000 ms.");
  }
  if (input.requireExactMessageFees && !input.buildExactFeeEvidence) {
    throw new Error("Exact unsigned-message fee evidence is required but no instruction builder was supplied.");
  }
  const startedAt = now();
  const [rawBuy, feeSamples, priceResult] = await Promise.all([
    input.fetchQuote({ side: "BUY", amountBaseUnits: input.buyAmountBaseUnits }),
    fetchHeliusPriorityFeeSamples({
      config: input.helius,
      ...(input.writableAccounts ? { writableAccounts: input.writableAccounts } : {})
    }),
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
    priorityFeePercentile: percentile,
    writableAccountCount: input.writableAccounts?.length ?? 0,
    ...(input.signatureCount === undefined ? {} : { signatureCount: input.signatureCount }),
    ...(input.baseFeeLamportsPerSignature === undefined ? {} : {
      baseFeeLamportsPerSignature: input.baseFeeLamportsPerSignature
    }),
    ...(input.maxPriorityFeeLamports === undefined ? {} : {
      maxPriorityFeeLamports: input.maxPriorityFeeLamports
    })
  });
  const buyExactFeeEvidence = input.buildExactFeeEvidence
    ? await input.buildExactFeeEvidence({ side: "BUY", quote: rawBuy })
    : undefined;
  if (input.requireExactMessageFees && buyExactFeeEvidence?.status !== "AVAILABLE") {
    throw new Error("Exact buy-message fee evidence is unavailable.");
  }
  const buyFeeEstimate = buyExactFeeEvidence?.status === "AVAILABLE"
    ? buyExactFeeEvidence.estimate : null;
  const buyFetchedAt = now();
  const buyLatencyMs = Math.max(0, Math.ceil(buyFetchedAt - startedAt));
  const buyCosts: PaperExecutionCostEstimate = {
    networkFeeLamports: buyFeeEstimate?.networkFeeLamports ?? networkFeeEstimate.networkFeeLamports,
    priorityFeeLamports: buyFeeEstimate?.priorityFeeLamports ?? networkFeeEstimate.priorityFeeLamports,
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
  const sellExactFeeEvidence = input.buildExactFeeEvidence
    ? await input.buildExactFeeEvidence({ side: "SELL", quote: rawSell })
    : undefined;
  if (input.requireExactMessageFees && sellExactFeeEvidence?.status !== "AVAILABLE") {
    throw new Error("Exact sell-message fee evidence is unavailable.");
  }
  const sellFeeEstimate = sellExactFeeEvidence?.status === "AVAILABLE"
    ? sellExactFeeEvidence.estimate : null;
  const sellFetchedAt = now();
  const sellLatencyMs = Math.max(0, Math.ceil(sellFetchedAt - sellStartedAt));
  const sellCosts: PaperExecutionCostEstimate = {
    ...buyCosts,
    networkFeeLamports: sellFeeEstimate?.networkFeeLamports ?? buyCosts.networkFeeLamports,
    priorityFeeLamports: sellFeeEstimate?.priorityFeeLamports ?? buyCosts.priorityFeeLamports,
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
  if (Date.parse(rawSell.observedAt) < Date.parse(rawBuy.observedAt)) {
    throw new Error("Initial sell quote timestamp is older than the buy quote snapshot.");
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
  if (!(entryCashDebitUsd > 0) || !(exitNetProceedsUsd > 0) || !Number.isFinite(exitNetProceedsUsd)) {
    throw new Error("Round-trip quote economics are not finite and positive after all exit costs.");
  }
  const roundTripNetReturnPct = (exitNetProceedsUsd - entryCashDebitUsd) / entryCashDebitUsd * 100;
  if (!Number.isFinite(roundTripNetReturnPct)) {
    throw new Error("Round-trip net return calculation is not finite.");
  }
  const buyFeePct = totalFees(buyQuote) / buyQuote.requestedUsd * 100;
  const sellFeePct = totalFees(initialSellQuote) / buyQuote.requestedUsd * 100;
  const combinedPriceImpactPct = buyQuote.priceImpactPct + initialSellQuote.priceImpactPct;
  const combinedTransferTaxPct = buyQuote.taxPct + initialSellQuote.taxPct;
  const roundTripCostPct = buyFeePct + sellFeePct + combinedPriceImpactPct + combinedTransferTaxPct;
  if (![buyFeePct, sellFeePct, combinedPriceImpactPct, combinedTransferTaxPct, roundTripCostPct]
      .every(Number.isFinite) || roundTripCostPct < 0) {
    throw new Error("Round-trip cost calculation is not finite or non-negative.");
  }
  return {
    status: "QUOTES_VALIDATED",
    paperEntryAuthorized: false,
    buyQuote,
    initialSellQuote,
    sellability: {
      quoteSellable: true,
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
      buyFeePct, sellFeePct, combinedPriceImpactPct, combinedTransferTaxPct,
      roundTripCostPct, meetsRoundTripCostLimit: roundTripCostPct <= maximumRoundTripCostPct,
      maximumRoundTripCostPct,
      meetsMinimumNetReturn: roundTripNetReturnPct >= minimumNetReturnPct,
      minimumNetReturnPct
    },
    networkFeeEstimate,
    ...(buyExactFeeEvidence && sellExactFeeEvidence ? {
      exactFeeEvidence: { buy: buyExactFeeEvidence, sell: sellExactFeeEvidence }
    } : {}),
    assumptions: {
      quoteTtlMs, executionDelayMs, providerFeeUsdPerTransaction: providerFeeUsd,
      priceImpactLimitPct: maxPriceImpactPct, priorityFeePercentile: percentile,
      priorityFeeScope: buyFeeEstimate && sellFeeEstimate ? "ACCOUNT_SPECIFIC" : networkFeeEstimate.priorityFeeScope
    }
  };
}


/**
 * Creates the exact-message fee callback used by fetchExecutableRoundTripQuote.
 * It rebuilds the unsigned venue plan from the same verified account snapshot
 * as the quote, including ATA prerequisites, before estimating fees. The
 * virtual payer is public-only: this helper cannot sign or submit transactions.
 */
export function createPumpUnsignedPlanFeeEvidenceBuilder(input: {
  identity: NonSigningVirtualTraderIdentity;
  config: HeliusAccountReadConfig;
  computeUnitLimit: number;
}): ExactUnsignedFeeEvidenceBuilder {
  return async ({ side, quote }) => {
    const unavailable = (reason: string): UnsignedInstructionFeeEvidence => ({
      status: "UNAVAILABLE", reason, computeUnitLimit: input.computeUnitLimit
    });
    try {
      if (quote.side !== side) {
        return unavailable("Quote side does not match the exact-message fee request.");
      }
      if (!quote.snapshot || quote.snapshot.verified !== true) {
        return unavailable("A verified same-context account snapshot is required for exact-message fee evidence.");
      }
      if (input.identity.kind !== "NON_SIGNING_VIRTUAL_TRADER" ||
          input.identity.canSign !== false || input.identity.canSubmit !== false) {
        return unavailable("A public-only non-signing virtual trader identity is required.");
      }
      const fetcher = input.config.fetcher ?? fetch;
      const blockhashResponse = await fetcher(buildHeliusRpcUrl(input.config.apiKey), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: "paper-exact-message-blockhash",
          method: "getLatestBlockhash",
          params: [{ commitment: input.config.commitment ?? "confirmed" }]
        })
      });
      if (!blockhashResponse.ok) {
        return unavailable(`Recent blockhash RPC returned HTTP ${blockhashResponse.status}.`);
      }
      const envelope = await blockhashResponse.json() as {
        error?: unknown;
        result?: { value?: { blockhash?: unknown } };
      };
      const recentBlockhash = envelope.result?.value?.blockhash;
      if (envelope.error || typeof recentBlockhash !== "string" || !recentBlockhash.trim()) {
        return unavailable("Recent blockhash RPC response is incomplete.");
      }

      const tokenAmountBaseUnits = side === "BUY"
        ? quote.outputAmountBaseUnits : quote.inputAmountBaseUnits;
      const quoteAmountBaseUnits = side === "BUY"
        ? quote.inputAmountBaseUnits : quote.outputAmountBaseUnits;
      const common = {
        identity: input.identity,
        snapshot: quote.snapshot,
        side,
        tokenAmountBaseUnits,
        quoteAmountBaseUnits,
        apiKey: input.config.apiKey,
        recentBlockhash,
        computeUnitLimit: input.computeUnitLimit,
        config: input.config,
        ...(input.config.fetcher ? { fetcher: input.config.fetcher } : {}),
        ...(input.config.now ? { nowMs: input.config.now() } : {})
      };
      const plan = "venue" in quote && quote.venue === "PUMP_CURVE"
        ? await buildPumpCurveV3UnsignedPlan(common)
        : await buildPumpSwapV2UnsignedPlan(common);
      if (plan.side !== side || plan.mint !== quote.mint ||
          plan.venue !== ("venue" in quote ? quote.venue : "PUMPSWAP")) {
        return unavailable("Unsigned plan does not match the exact quote identity.");
      }
      return plan.feeEvidence;
    } catch (error) {
      return unavailable(error instanceof Error
        ? error.message : "Exact unsigned-message fee plan could not be built.");
    }
  };
}
