import type { VerifiedPumpTransaction } from "../ingestion/helius.js";
import type { PumpTradeEvent } from "../ingestion/pump-events.js";
import type { CandidateTradeFlow } from "../ingestion/trade-flow.js";
import type { PumpMarketState } from "../paper/pump-market-state.js";
import { buildExitWindowObservations } from "./exit-window-builder.js";
import type { ExitWindowObservation } from "./dynamic-exits.js";

/**
 * Builds only venue-correct, fully covered 2-second Pump curve observations.
 * PumpTradeEvent currently describes the bonding-curve program; it must never
 * be relabelled as PumpSwap flow after migration. Missing evidence stays absent.
 */
export function buildPumpCurveExitWindowEvidence(input: {
  marketState: PumpMarketState;
  flow: CandidateTradeFlow | null;
  transactions: readonly VerifiedPumpTransaction[];
}): ExitWindowObservation[] {
  const { marketState, flow } = input;
  const quoteMint = marketState.curve?.quoteMint;
  if (marketState.status !== "LIVE_CURVE" || !quoteMint || !flow ||
      flow.mint !== marketState.mint || flow.quoteMint !== quoteMint ||
      flow.windowSeconds !== 2 || flow.sampleIntervalSeconds !== 1 ||
      !flow.dataComplete) return [];

  const latest = flow.windows.slice(-3);
  if (latest.length !== 3 ||
      latest.some(window => window.endTime !== window.startTime + 2) ||
      latest[1]!.startTime !== latest[0]!.startTime + 1 ||
      latest[2]!.startTime !== latest[1]!.startTime + 1) return [];

  const allEvents = input.transactions.flatMap(transaction => transaction.tradeEvents)
    .filter(event => event.mint === marketState.mint && event.quoteMint === quoteMint);
  const samples = latest.map(window => {
    const events = allEvents.filter(event => {
      const timestamp = Number(event.timestamp);
      return Number.isSafeInteger(timestamp) &&
        timestamp >= window.startTime && timestamp < window.endTime;
    }).sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    const priceOf = (event: PumpTradeEvent | undefined): number | null => {
      if (!event || event.virtualQuoteReserves <= 0n || event.virtualTokenReserves <= 0n) return null;
      const scaled = (event.virtualQuoteReserves * 1_000_000_000_000n) / event.virtualTokenReserves;
      const price = Number(scaled) / 1_000_000_000_000;
      return Number.isFinite(price) && price > 0 ? price : null;
    };
    const lastEvent = events.at(-1);
    return {
      mint: marketState.mint,
      marketPhase: "bonding_curve" as const,
      venue: "pump_curve" as const,
      quoteMint,
      endedAtMs: window.endTime * 1_000,
      windowSeconds: 2 as const,
      complete: events.length > 0,
      buyQuoteVolumeBaseUnits: window.buyQuoteVolume,
      sellQuoteVolumeBaseUnits: window.sellQuoteVolume,
      uniqueBuyers: window.uniqueBuyers,
      uniqueSellers: window.uniqueSellers,
      startPriceQuotePerToken: priceOf(events[0]),
      endPriceQuotePerToken: priceOf(lastEvent),
      quoteLiquidityBaseUnits: lastEvent && lastEvent.realQuoteReserves > 0n
        ? lastEvent.realQuoteReserves.toString() : null,
      largeHolderDistributionDetected: null
    };
  });
  if (samples.some(sample => !sample.complete)) return [];
  return buildExitWindowObservations(samples);
}
