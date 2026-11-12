import type { ExecutablePaperQuote } from "../paper/portfolio.js";
import type { PumpSdkCurveQuote } from "./pump-sdk-curve-quote-adapter.js";
import type { PumpSdkSwapQuote } from "./pump-sdk-quote-adapter.js";

export type OfflinePumpQuote = PumpSdkCurveQuote | PumpSdkSwapQuote;

export interface SolUsdReference {
  priceUsd: number;
  observedAt: string;
}

export interface PaperExecutionCostEstimate {
  /** Solana base units (lamports) for the simulated network fee. */
  networkFeeLamports: string;
  /** Solana base units (lamports) for the simulated priority fee. */
  priorityFeeLamports: string;
  /** Provider charge in USD, if the configured data/quote provider charges one. */
  providerFeeUsd: number;
  /** Deterministic latency sampled from the selected paper execution profile. */
  simulatedLatencyMs: number;
  /** Quote validity is deliberately short and bounded by the verified snapshot age. */
  quoteTtlMs?: number;
}

export interface ExecutablePaperQuoteWithLatency extends ExecutablePaperQuote {
  venue: "PUMP_CURVE" | "PUMPSWAP";
  slot: number;
  quoteMint: string;
  grossQuoteAmountBaseUnits: string;
  netQuoteAmountBaseUnits: string;
  grossTokenAmountBaseUnits: string;
  netTokenAmountBaseUnits: string;
  transferFeeBaseUnits: string;
  transferFeeMint: string;
  transferFeeEpoch: number | null;
  transferFeeBasisPoints: number;
  transferFeeMaximumBaseUnits: string;
  feeBreakdownUsd: {
    protocol: number;
    creator: number;
    pool: number;
    pumpAggregate: number;
    network: number;
    priority: number;
    provider: number;
    transfer: number;
  };
  simulatedLatencyMs: number;
  simulatedFillAt: string;
  executionReady: true;
}

const LAMPORTS_PER_SOL = 1_000_000_000n;
const DEFAULT_QUOTE_TTL_MS = 2_000;
const MAX_QUOTE_TTL_MS = 2_000;
const MAX_SOL_USD_AGE_MS = 10_000;

function assertBaseUnits(value: string, label: string, allowZero = false): bigint {
  if (!/^\d+$/.test(value) || value.length > 20) {
    throw new Error(`${label} must be an unsigned base-unit integer.`);
  }
  const amount = BigInt(value);
  if ((allowZero ? amount < 0n : amount <= 0n) || amount > 18_446_744_073_709_551_615n) {
    throw new Error(`${label} must be a positive u64 amount.`);
  }
  return amount;
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative.`);
  return value;
}

function baseUnitsToNumber(amount: string, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("Quote decimals are outside the supported range.");
  }
  const raw = BigInt(amount);
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = raw % scale;
  const result = Number(whole) + Number(fraction) / Number(scale);
  if (!Number.isFinite(result)) throw new Error("Base-unit conversion is not finite.");
  return result;
}

function solLamportsToUsd(lamports: string, solUsd: number): number {
  const amount = assertBaseUnits(lamports, "SOL fee", true);
  return Number(amount) / Number(LAMPORTS_PER_SOL) * solUsd;
}

function quoteVenue(quote: OfflinePumpQuote): "PUMP_CURVE" | "PUMPSWAP" {
  return "venue" in quote ? quote.venue : "PUMPSWAP";
}

function sdkFees(quote: OfflinePumpQuote): {
  protocol: string; creator: string; pool: string; pumpAggregate: string;
} {
  if ("venueFeeBaseUnits" in quote) {
    return { protocol: "0", creator: "0", pool: "0", pumpAggregate: quote.venueFeeBaseUnits };
  }
  return {
    protocol: quote.fees.protocolBaseUnits,
    creator: quote.fees.creatorBaseUnits,
    pool: quote.fees.lpBaseUnits,
    pumpAggregate: "0"
  };
}

/**
 * Joins an official-SDK offline quote to explicit cost and price evidence.
 * No RPC convenience quote is used here: all market inputs must already have
 * passed the adapter's same-context Helius verification.
 *
 * Token-2022 transfer-fee mints are priced with their verified epoch schedule.
 * Transfer hooks remain fail-closed because their extra-account execution is
 * not simulated. Transfer-fee USD is informational: the withheld token amount
 * is already reflected in the net token quantity/proceeds and is not deducted
 * a second time from the cash-flow fee total.
 */
export function buildExecutablePaperQuote(input: {
  quote: OfflinePumpQuote;
  solUsd: SolUsdReference;
  costs: PaperExecutionCostEstimate;
  nowMs?: number;
}): ExecutablePaperQuoteWithLatency {
  const { quote, solUsd, costs } = input;
  const now = input.nowMs ?? Date.now();
  if (quote.transferFeeVerified !== true) {
    throw new Error("Token transfer fee is not verified; quote cannot be used for a paper fill.");
  }
  if (quote.executionReady !== false) {
    throw new Error("Unexpected SDK quote readiness state.");
  }
  const snapshotAt = Date.parse(quote.observedAt);
  const solUsdAt = Date.parse(solUsd.observedAt);
  if (!Number.isFinite(now) || !Number.isFinite(snapshotAt) || snapshotAt > now ||
      now - snapshotAt > MAX_QUOTE_TTL_MS) {
    throw new Error("Verified market snapshot is stale or from the future.");
  }
  if (!Number.isFinite(solUsdAt) || solUsdAt > now ||
      now - solUsdAt > MAX_SOL_USD_AGE_MS ||
      !Number.isFinite(solUsd.priceUsd) || solUsd.priceUsd <= 0) {
    throw new Error("SOL/USD reference is stale or invalid.");
  }
  const networkFeeUsd = solLamportsToUsd(costs.networkFeeLamports, solUsd.priceUsd);
  const priorityFeeUsd = solLamportsToUsd(costs.priorityFeeLamports, solUsd.priceUsd);
  const providerFeeUsd = nonNegative(costs.providerFeeUsd, "Provider fee");
  if (!Number.isSafeInteger(costs.simulatedLatencyMs) ||
      costs.simulatedLatencyMs < 0 || costs.simulatedLatencyMs > 1_500) {
    throw new Error("Simulated execution latency must be an integer between 0 and 1500 ms.");
  }
  const ttlMs = costs.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 100 || ttlMs > MAX_QUOTE_TTL_MS) {
    throw new Error("Quote TTL must be between 100 and 2000 ms.");
  }
  const expiresAtMs = snapshotAt + ttlMs;
  const simulatedFillAtMs = now + costs.simulatedLatencyMs;
  if (simulatedFillAtMs >= expiresAtMs) {
    throw new Error("Quote would expire before the simulated fill; a fresh market snapshot is required.");
  }

  const venue = quoteVenue(quote);
  const fees = sdkFees(quote);
  const protocolFeeUsd = baseUnitsToNumber(fees.protocol, quote.quoteDecimals) * solUsd.priceUsd;
  const creatorFeeUsd = baseUnitsToNumber(fees.creator, quote.quoteDecimals) * solUsd.priceUsd;
  const poolFeeUsd = baseUnitsToNumber(fees.pool, quote.quoteDecimals) * solUsd.priceUsd;
  const pumpFeeUsd = baseUnitsToNumber(fees.pumpAggregate, quote.quoteDecimals) * solUsd.priceUsd;
  const grossQuoteUsd = baseUnitsToNumber(quote.grossQuoteAmountBaseUnits, quote.quoteDecimals) * solUsd.priceUsd;
  const netQuoteUsd = baseUnitsToNumber(quote.netQuoteAmountBaseUnits, quote.quoteDecimals) * solUsd.priceUsd;
  const outputAmount = assertBaseUnits(quote.outputAmountBaseUnits, "SDK output amount");
  const inputAmount = assertBaseUnits(quote.inputAmountBaseUnits, "SDK input amount");
  const grossTokenAmount = assertBaseUnits(quote.grossTokenAmountBaseUnits, "Gross token amount");
  const netTokenAmount = assertBaseUnits(quote.netTokenAmountBaseUnits, "Net token amount");
  const transferFeeAmount = assertBaseUnits(quote.transferFeeBaseUnits, "Token transfer fee", true);
  const transferFeeMaximum = assertBaseUnits(quote.transferFeeMaximumBaseUnits, "Maximum token transfer fee", true);
  if (grossTokenAmount - transferFeeAmount !== netTokenAmount ||
      transferFeeAmount > transferFeeMaximum ||
      !Number.isInteger(quote.transferFeeBasisPoints) ||
      quote.transferFeeBasisPoints < 0 || quote.transferFeeBasisPoints > 10_000 ||
      (transferFeeAmount > 0n && quote.transferFeeEpoch === null) ||
      quote.transferFeeMint !== quote.mint) {
    throw new Error("Token transfer fee evidence does not reconcile with the quoted mint and amounts.");
  }
  if (quote.side === "BUY" && outputAmount !== netTokenAmount) {
    throw new Error("Buy quote output must equal the net token amount after transfer fees.");
  }
  if (quote.side === "SELL" && inputAmount !== grossTokenAmount) {
    throw new Error("Sell quote input must equal the gross token amount supplied by the paper position.");
  }
  const feeTotal = protocolFeeUsd + creatorFeeUsd + poolFeeUsd + pumpFeeUsd;
  if (quote.side === "BUY" && Math.abs((netQuoteUsd + feeTotal) - grossQuoteUsd) > Math.max(0.00000001, grossQuoteUsd * 0.000001)) {
    throw new Error("SDK buy quote gross/net amounts do not reconcile with its fee breakdown.");
  }
  if (quote.side === "SELL" && netQuoteUsd > grossQuoteUsd + 0.00000001) {
    throw new Error("SDK sell quote net proceeds exceed gross proceeds.");
  }

  const requestedUsd = quote.side === "BUY" ? netQuoteUsd : grossQuoteUsd;
  const outputUsd = quote.side === "BUY" ? netQuoteUsd : grossQuoteUsd;
  const grossTokenUi = baseUnitsToNumber(quote.grossTokenAmountBaseUnits, quote.baseDecimals);
  const netTokenUi = baseUnitsToNumber(quote.netTokenAmountBaseUnits, quote.baseDecimals);
  const transferFeeUi = baseUnitsToNumber(quote.transferFeeBaseUnits, quote.baseDecimals);
  const taxPct = grossTokenUi > 0 ? transferFeeUi / grossTokenUi * 100 : 0;
  const transferFeeUsd = quote.side === "BUY"
    ? (grossTokenUi > 0 ? transferFeeUi / grossTokenUi * netQuoteUsd : 0)
    : (netTokenUi > 0 ? transferFeeUi / netTokenUi * grossQuoteUsd : 0);
  if (!(requestedUsd > 0) || !(outputUsd > 0) || !Number.isFinite(outputUsd)) {
    throw new Error("SDK quote has no positive USD notional.");
  }

  const quoteId = [
    "pump-sdk-4.3.1", venue, quote.side, quote.mint, quote.slot,
    quote.inputAmountBaseUnits, quote.observedAt
  ].join(":");
  const feeBreakdownUsd = {
    protocol: protocolFeeUsd,
    creator: creatorFeeUsd,
    pool: poolFeeUsd,
    pumpAggregate: pumpFeeUsd,
    network: networkFeeUsd,
    priority: priorityFeeUsd,
    provider: providerFeeUsd,
    transfer: 0
  };

  return {
    quoteId,
    provider: quote.provider,
    mint: quote.mint,
    side: quote.side,
    observedAt: quote.observedAt,
    expiresAt: new Date(expiresAtMs).toISOString(),
    requestedUsd,
    inputAmountBaseUnits: inputAmount.toString(),
    outputAmountBaseUnits: outputAmount.toString(),
    tokenDecimals: quote.baseDecimals,
    outputUsd,
    priceImpactPct: nonNegative(quote.priceImpactPct, "Price impact"),
    taxPct,
    networkFeeUsd,
    priorityFeeUsd,
    providerFeeUsd,
    protocolFeeUsd,
    creatorFeeUsd,
    poolFeeUsd,
    ...(pumpFeeUsd > 0 ? { pumpFeeUsd } : {}),
    transferFeeUsd,
    routeId: `${venue}:${quote.quoteMint}:${quote.slot}`,
    executable: true,
    venue,
    slot: quote.slot,
    quoteMint: quote.quoteMint,
    grossQuoteAmountBaseUnits: quote.grossQuoteAmountBaseUnits,
    netQuoteAmountBaseUnits: quote.netQuoteAmountBaseUnits,
    grossTokenAmountBaseUnits: quote.grossTokenAmountBaseUnits,
    netTokenAmountBaseUnits: quote.netTokenAmountBaseUnits,
    transferFeeBaseUnits: quote.transferFeeBaseUnits,
    transferFeeMint: quote.transferFeeMint,
    transferFeeEpoch: quote.transferFeeEpoch,
    transferFeeBasisPoints: quote.transferFeeBasisPoints,
    transferFeeMaximumBaseUnits: quote.transferFeeMaximumBaseUnits,
    feeBreakdownUsd,
    simulatedLatencyMs: costs.simulatedLatencyMs,
    simulatedFillAt: new Date(simulatedFillAtMs).toISOString(),
    executionReady: true
  };
}
