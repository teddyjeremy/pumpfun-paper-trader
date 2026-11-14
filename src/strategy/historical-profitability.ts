import type { PumpTradeEvent } from "../ingestion/pump-events.js";
import type { VerifiedPumpTransaction } from "../ingestion/helius.js";
import { isSolQuoteMint } from "../ingestion/trade-flow.js";
import { evaluateExit, DYNAMIC_EXIT_CALIBRATION_V1, type DynamicExitConfig, type ExitWindowObservation } from "./dynamic-exits.js";
import { buildExitWindowObservations, type RawExitWindowSample } from "./exit-window-builder.js";

export interface HistoricalProfitabilityInput {
  mint: string;
  transactions: readonly VerifiedPumpTransaction[];
  entryAt: number;
  entryPriceQuotePerToken: number;
  horizonSeconds?: number;
  roundTripCostPct: number;
  riskCleared: boolean;
  dynamicExitConfig?: DynamicExitConfig;
}

export interface HistoricalProfitabilityResult {
  mint: string;
  status: "CLOSED_BY_STRATEGY" | "OPEN_AT_HORIZON" | "NO_FORWARD_TRADES" | "INVALID_INPUT";
  entryAt: number;
  entryPriceQuotePerToken: number;
  exitAt: number | null;
  exitPriceQuotePerToken: number | null;
  exitReason: string | null;
  grossReturnPct: number | null;
  modeledNetReturnPct: number | null;
  modeledPnlUsdOnOneDollar: number | null;
  maxFavorableExcursionPct: number | null;
  maxAdverseExcursionPct: number | null;
  roundTripCostPct: number;
  riskEvidence: "CLEARED" | "UNVERIFIED";
  executionEvidence: "RESERVE_PRICE_PROXY_NOT_EXECUTABLE";
  dynamicExitEvidence: "RECONSTRUCTED_FROM_VERIFIED_TRADES";
  note: string;
}

const quoteAmount = (event: PumpTradeEvent) =>
  event.quoteAmount > 0n ? event.quoteAmount : event.solAmount;

function priceOf(event: PumpTradeEvent): number | null {
  const quote = isSolQuoteMint(event.quoteMint) ? event.virtualSolReserves : event.virtualQuoteReserves;
  if (quote <= 0n || event.virtualTokenReserves <= 0n) return null;
  const value = Number(quote) / Number(event.virtualTokenReserves);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function reserveLiquidity(event: PumpTradeEvent): string | null {
  const value = isSolQuoteMint(event.quoteMint) ? event.realSolReserves : event.realQuoteReserves;
  return value > 0n ? value.toString() : null;
}

function buildWindows(
  trades: readonly PumpTradeEvent[],
  entryAt: number,
  endAt: number
): ExitWindowObservation[] {
  const durations = [2, 5, 10, 30] as const;
  const samples: RawExitWindowSample[] = [];
  const quoteMint = trades[0]?.quoteMint ?? "";
  for (const duration of durations) {
    for (let windowEnd = entryAt + duration; windowEnd <= endAt; windowEnd += duration) {
      const windowTrades = trades.filter(event => {
        const at = Number(event.timestamp);
        return at > windowEnd - duration && at <= windowEnd;
      });
      let buys = 0n, sells = 0n;
      const buyers = new Set<string>(), sellers = new Set<string>();
      for (const event of windowTrades) {
        const amount = quoteAmount(event);
        if (event.isBuy) { buys += amount; buyers.add(event.user); }
        else { sells += amount; sellers.add(event.user); }
      }
      const first = windowTrades[0], last = windowTrades[windowTrades.length - 1];
      samples.push({
        mint: first?.mint ?? trades[0]?.mint ?? "",
        marketPhase: "bonding_curve",
        venue: "pump_curve",
        quoteMint: first?.quoteMint ?? quoteMint,
        endedAtMs: windowEnd * 1_000,
        windowSeconds: duration,
        complete: true,
        buyQuoteVolumeBaseUnits: buys.toString(),
        sellQuoteVolumeBaseUnits: sells.toString(),
        uniqueBuyers: buyers.size,
        uniqueSellers: sellers.size,
        startPriceQuotePerToken: first ? priceOf(first) : null,
        endPriceQuotePerToken: last ? priceOf(last) : null,
        quoteLiquidityBaseUnits: last ? reserveLiquidity(last) : null,
        largeHolderDistributionDetected: null
      });
    }
  }
  return buildExitWindowObservations(samples);
}

/**
 * Replays the repository's current hard/protective/dynamic exit policy against
 * verified Pump trade reserve prices. This is a price-path proxy, not an
 * executable quote or a claim of realized production fills.
 */
export function simulateHistoricalProfitability(
  input: HistoricalProfitabilityInput
): HistoricalProfitabilityResult {
  const invalid = !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input.mint) ||
    !Number.isSafeInteger(input.entryAt) || input.entryAt < 0 ||
    !Number.isFinite(input.entryPriceQuotePerToken) || input.entryPriceQuotePerToken <= 0 ||
    !Number.isFinite(input.roundTripCostPct) || input.roundTripCostPct < 0 || input.roundTripCostPct > 4;
  const base = {
    mint: input.mint, entryAt: input.entryAt,
    entryPriceQuotePerToken: input.entryPriceQuotePerToken,
    exitAt: null, exitPriceQuotePerToken: null, exitReason: null,
    grossReturnPct: null, modeledNetReturnPct: null,
    modeledPnlUsdOnOneDollar: null, maxFavorableExcursionPct: null,
    maxAdverseExcursionPct: null, roundTripCostPct: input.roundTripCostPct,
    riskEvidence: input.riskCleared ? "CLEARED" as const : "UNVERIFIED" as const,
    executionEvidence: "RESERVE_PRICE_PROXY_NOT_EXECUTABLE" as const,
    dynamicExitEvidence: "RECONSTRUCTED_FROM_VERIFIED_TRADES" as const,
    note: "Reserve-ratio marks are not executable full-size quotes. The modeled round-trip haircut is an assumption; historical network/priority fees, exact SDK slippage, taxes and migrated-pool fills are not proven by this dataset. Risk-unverified candidates are research-only."
  };
  if (invalid) return { ...base, status: "INVALID_INPUT" };
  const horizonSeconds = input.horizonSeconds ?? 600;
  if (!Number.isSafeInteger(horizonSeconds) || horizonSeconds < 60 || horizonSeconds > 1_800) {
    return { ...base, status: "INVALID_INPUT" };
  }
  const endAt = input.entryAt + horizonSeconds;
  const trades = input.transactions.flatMap(tx => tx.tradeEvents)
    .filter(event => event.mint === input.mint && isSolQuoteMint(event.quoteMint))
    .filter(event => {
      const at = Number(event.timestamp);
      return Number.isSafeInteger(at) && at >= input.entryAt && at <= endAt && priceOf(event) !== null;
    })
    .sort((a, b) => Number(a.timestamp - b.timestamp));
  if (trades.length === 0) return { ...base, status: "NO_FORWARD_TRADES" };
  const entryCost = input.roundTripCostPct / 200;
  const exitCost = input.roundTripCostPct / 200;
  const effectiveEntry = input.entryPriceQuotePerToken * (1 + entryCost);
  const windows = buildWindows(trades, input.entryAt, Math.min(endAt, Number(trades.at(-1)!.timestamp)));
  let highWaterPrice = effectiveEntry;
  let exit: { at: number; price: number; reason: string } | null = null;
  let minPrice = input.entryPriceQuotePerToken;
  let maxPrice = input.entryPriceQuotePerToken;
  for (const event of trades) {
    const at = Number(event.timestamp);
    const price = priceOf(event)!;
    minPrice = Math.min(minPrice, price);
    maxPrice = Math.max(maxPrice, price);
    highWaterPrice = Math.max(highWaterPrice, price * (1 - exitCost));
    const currentNetReturnPct = ((price * (1 - exitCost)) / effectiveEntry - 1) * 100;
    const highestCompletedNetReturnPct = (highWaterPrice / effectiveEntry - 1) * 100;
    const availableWindows = windows.filter(window => window.endedAtMs <= at * 1_000);
    const evaluations = ([2, 5, 10, 30] as const).map(duration => evaluateExit({
      currentNetReturnPct,
      highestCompletedNetReturnPct,
      freshExecutableSellQuote: true,
      windowsOldestFirst: availableWindows.filter(window => window.windowSeconds === duration)
    }, input.dynamicExitConfig ?? DYNAMIC_EXIT_CALIBRATION_V1));
    const triggered = evaluations.find(result => result.action === "sell");
    if (triggered) {
      exit = { at, price, reason: triggered.reason };
      break;
    }
  }
  const final = exit ?? { at: Number(trades.at(-1)!.timestamp), price: priceOf(trades.at(-1)!)!, reason: "HORIZON_MARK_ONLY" };
  const grossReturnPct = (final.price / input.entryPriceQuotePerToken - 1) * 100;
  const modeledNetReturnPct = ((final.price * (1 - exitCost)) / effectiveEntry - 1) * 100;
  return {
    ...base,
    status: exit ? "CLOSED_BY_STRATEGY" : "OPEN_AT_HORIZON",
    exitAt: exit?.at ?? null,
    exitPriceQuotePerToken: exit?.price ?? null,
    exitReason: exit?.reason ?? null,
    grossReturnPct,
    modeledNetReturnPct,
    modeledPnlUsdOnOneDollar: modeledNetReturnPct / 100,
    maxFavorableExcursionPct: (maxPrice / input.entryPriceQuotePerToken - 1) * 100,
    maxAdverseExcursionPct: (1 - minPrice / input.entryPriceQuotePerToken) * 100
  };
}
