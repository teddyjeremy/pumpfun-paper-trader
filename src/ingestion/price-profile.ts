import type { PumpCreateEvent, PumpTradeEvent } from "./pump-events.js";
import type { VerifiedPumpTransaction } from "./helius.js";
import { SOL_QUOTE_MINT } from "./trade-flow.js";

const FIVE_SECONDS = 5n;
const BPS = 10_000n;

interface RationalPrice {
  numerator: bigint;
  denominator: bigint;
}

interface TimedPrice extends RationalPrice {
  timestamp: number;
  event: PumpTradeEvent;
}

export interface CurvePriceProfile {
  mint: string;
  quoteUnit: "SOL";
  source: "PUMP_CURVE_RESERVE_RATIO_NOT_EXECUTABLE_QUOTE";
  baselineAvailable: boolean;
  baselineTimestamp: number | null;
  impulseHighTimestamp: number | null;
  pullbackLowTimestamp: number | null;
  latestTradeTimestamp: number | null;
  impulseChangeBps: number | null;
  pullbackFromImpulseHighBps: number | null;
  reclaimAbovePreviousFiveSecondHighBps: number | null;
  impulsePass: boolean;
  pullbackPass: boolean;
  reclaimPass: boolean;
  priceStructurePass: boolean;
  impulseBuyVolumeLamports: string | null;
  pullbackBuyVolumeLamports: string | null;
  reclaimBuyVolumeLamports: string | null;
  pullbackToImpulseBuyVolumeBps: number | null;
  reclaimToPullbackBuyVolumeBps: number | null;
  volumeProfileThresholdsConfigured: false;
  volumeProfileReady: false;
  signalAgeSeconds: number | null;
  entryEligible: false;
  candles: Array<{
    startTime: number;
    endTime: number;
    tradeCount: number;
    highNumerator: string;
    highDenominator: string;
    lowNumerator: string;
    lowDenominator: string;
  }>;
}

/**
 * Derive a curve-implied price profile from verified reserve snapshots.
 * This is suitable only for price-shape analysis. It is not an executable
 * quote, does not include fees/impact, and can never authorize a paper fill.
 */
export function buildCurvePriceProfiles(
  transactions: readonly VerifiedPumpTransaction[],
  options: { nowSeconds?: number; candidateMints?: readonly string[] } = {}
): CurvePriceProfile[] {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const groups = new Map<string, { create: PumpCreateEvent | null; trades: PumpTradeEvent[] }>();

  for (const transaction of transactions) {
    for (const create of transaction.createEvents) {
      if (create.quoteMint !== SOL_QUOTE_MINT) continue;
      const group = groups.get(create.mint) ?? { create: null, trades: [] };
      group.create = group.create ?? create;
      groups.set(create.mint, group);
    }
    for (const trade of transaction.tradeEvents) {
      if (trade.quoteMint !== SOL_QUOTE_MINT) continue;
      const group = groups.get(trade.mint) ?? { create: null, trades: [] };
      group.trades.push(trade);
      groups.set(trade.mint, group);
    }
  }
  for (const mint of options.candidateMints ?? []) {
    if (!groups.has(mint)) groups.set(mint, { create: null, trades: [] });
  }

  return [...groups.entries()].map(([mint, group]) => buildOneProfile(mint, group.create, group.trades, nowSeconds))
    .sort((a, b) => a.mint.localeCompare(b.mint));
}

function buildOneProfile(
  mint: string,
  create: PumpCreateEvent | null,
  trades: readonly PumpTradeEvent[],
  nowSeconds: number
): CurvePriceProfile {
  const baselineTimestamp = create ? safeSeconds(create.timestamp) : null;
  const baseline = create && create.virtualSolReserves > 0n && create.virtualTokenReserves > 0n
    ? { numerator: create.virtualSolReserves, denominator: create.virtualTokenReserves }
    : null;
  const points: TimedPrice[] = trades
    .map(event => ({
      timestamp: safeSeconds(event.timestamp),
      numerator: event.virtualSolReserves,
      denominator: event.virtualTokenReserves,
      event
    }))
    .filter((point): point is TimedPrice =>
      point.timestamp !== null &&
      point.numerator > 0n &&
      point.denominator > 0n &&
      (baselineTimestamp === null || point.timestamp >= baselineTimestamp)
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  const candles = buildFiveSecondCandles(points);
  const latest = points.at(-1) ?? null;
  let impulseHigh: RationalPrice | null = baseline;
  let impulseHighTimestamp = baselineTimestamp;
  let pullbackLow: RationalPrice | null = null;
  let pullbackLowTimestamp: number | null = null;

  for (const point of points) {
    if (!impulseHigh || comparePrice(point, impulseHigh) > 0) {
      impulseHigh = point;
      impulseHighTimestamp = point.timestamp;
      pullbackLow = null;
      pullbackLowTimestamp = null;
      continue;
    }
    if (impulseHighTimestamp !== null && point.timestamp > impulseHighTimestamp &&
        (!pullbackLow || comparePrice(point, pullbackLow) < 0)) {
      pullbackLow = point;
      pullbackLowTimestamp = point.timestamp;
    }
  }

  const impulseChangeBps = baseline && impulseHigh
    ? priceChangeBps(impulseHigh, baseline)
    : null;
  const pullbackBps = impulseHigh && pullbackLow
    ? priceDropBps(pullbackLow, impulseHigh)
    : null;

  const previousCandleStart = latest
    ? Math.floor(latest.timestamp / Number(FIVE_SECONDS)) * Number(FIVE_SECONDS) - Number(FIVE_SECONDS)
    : null;
  const previousCandle = previousCandleStart === null
    ? null
    : candles.find(candle => candle.startTime === previousCandleStart);
  const reclaimBps = latest && previousCandle
    ? priceChangeBps(latest, previousCandle.high)
    : null;

  const impulsePass = impulseChangeBps !== null && impulseChangeBps >= 2_000;
  const pullbackPass = pullbackBps !== null && pullbackBps >= 1_000 && pullbackBps <= 4_000;
  const reclaimPass = reclaimBps !== null && reclaimBps >= 100;

  const impulseBuyVolume = baselineTimestamp !== null && impulseHighTimestamp !== null
    ? sumBuyVolume(trades, baselineTimestamp, impulseHighTimestamp)
    : null;
  const pullbackBuyVolume = impulseHighTimestamp !== null && pullbackLowTimestamp !== null
    ? sumBuyVolume(trades, impulseHighTimestamp, pullbackLowTimestamp)
    : null;
  const reclaimBuyVolume = pullbackLowTimestamp !== null && latest
    ? sumBuyVolume(trades, pullbackLowTimestamp, latest.timestamp)
    : null;

  const pullbackToImpulseBps = ratioBps(pullbackBuyVolume, impulseBuyVolume);
  const reclaimToPullbackBps = ratioBps(reclaimBuyVolume, pullbackBuyVolume);

  return {
    mint,
    quoteUnit: "SOL",
    source: "PUMP_CURVE_RESERVE_RATIO_NOT_EXECUTABLE_QUOTE",
    baselineAvailable: baseline !== null,
    baselineTimestamp,
    impulseHighTimestamp,
    pullbackLowTimestamp,
    latestTradeTimestamp: latest?.timestamp ?? null,
    impulseChangeBps,
    pullbackFromImpulseHighBps: pullbackBps,
    reclaimAbovePreviousFiveSecondHighBps: reclaimBps,
    impulsePass,
    pullbackPass,
    reclaimPass,
    priceStructurePass: impulsePass && pullbackPass && reclaimPass,
    impulseBuyVolumeLamports: impulseBuyVolume?.toString() ?? null,
    pullbackBuyVolumeLamports: pullbackBuyVolume?.toString() ?? null,
    reclaimBuyVolumeLamports: reclaimBuyVolume?.toString() ?? null,
    pullbackToImpulseBuyVolumeBps: pullbackToImpulseBps,
    reclaimToPullbackBuyVolumeBps: reclaimToPullbackBps,
    volumeProfileThresholdsConfigured: false,
    volumeProfileReady: false,
    signalAgeSeconds: latest ? Math.max(0, nowSeconds - latest.timestamp) : null,
    entryEligible: false,
    candles: candles.map(candle => ({
      startTime: candle.startTime,
      endTime: candle.startTime + Number(FIVE_SECONDS),
      tradeCount: candle.tradeCount,
      highNumerator: candle.high.numerator.toString(),
      highDenominator: candle.high.denominator.toString(),
      lowNumerator: candle.low.numerator.toString(),
      lowDenominator: candle.low.denominator.toString()
    }))
  };
}

function safeSeconds(value: bigint): number | null {
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

function comparePrice(a: RationalPrice, b: RationalPrice): number {
  const left = a.numerator * b.denominator;
  const right = b.numerator * a.denominator;
  return left > right ? 1 : left < right ? -1 : 0;
}

function priceChangeBps(current: RationalPrice, reference: RationalPrice): number | null {
  const base = reference.numerator * current.denominator;
  if (base <= 0n) return null;
  const delta = current.numerator * reference.denominator - base;
  return Number((delta * BPS) / base);
}

function priceDropBps(low: RationalPrice, high: RationalPrice): number | null {
  const highValue = high.numerator * low.denominator;
  if (highValue <= 0n) return null;
  const delta = highValue - low.numerator * high.denominator;
  return Number((delta * BPS) / highValue);
}

function ratioBps(numerator: bigint | null, denominator: bigint | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0n) return null;
  return Number((numerator * BPS) / denominator);
}

function sumBuyVolume(trades: readonly PumpTradeEvent[], from: number, to: number): bigint {
  return trades.reduce((sum, event) => {
    const timestamp = safeSeconds(event.timestamp);
    if (!event.isBuy || timestamp === null || timestamp < from || timestamp > to) return sum;
    return sum + (event.quoteAmount > 0n ? event.quoteAmount : event.solAmount);
  }, 0n);
}

function buildFiveSecondCandles(points: readonly TimedPrice[]) {
  const buckets = new Map<number, TimedPrice[]>();
  for (const point of points) {
    const start = Math.floor(point.timestamp / Number(FIVE_SECONDS)) * Number(FIVE_SECONDS);
    const bucket = buckets.get(start) ?? [];
    bucket.push(point);
    buckets.set(start, bucket);
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([startTime, bucket]) => {
    let high = bucket[0]!;
    let low = bucket[0]!;
    for (const point of bucket.slice(1)) {
      if (comparePrice(point, high) > 0) high = point;
      if (comparePrice(point, low) < 0) low = point;
    }
    return { startTime, tradeCount: bucket.length, high, low };
  });
}
