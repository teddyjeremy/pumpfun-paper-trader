import type { PumpTradeEvent } from "./pump-events.js";
import type { VerifiedPumpTransaction } from "./helius.js";
import { SOL_QUOTE_MINT } from "./trade-flow.js";

export const PRICE_VOLUME_BUCKET_SECONDS = 5;
export const PRICE_VOLUME_HORIZON_SECONDS = 10 * 60;
const PRICE_SCALE = 1_000_000_000_000n;

export interface PriceVolumeBucket {
  startTime: number;
  endTime: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  tradeCount: number;
  buyTrades: number;
  sellTrades: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  buyQuoteVolume: string;
  sellQuoteVolume: string;
  totalQuoteVolume: string;
}

export interface StageVolume {
  startTime: number | null;
  endTime: number | null;
  bucketCount: number;
  tradeCount: number;
  buyQuoteVolume: string;
  sellQuoteVolume: string;
  totalQuoteVolume: string;
  averageQuoteVolumePerBucket: string | null;
}

export interface CandidatePriceVolumeProfile {
  mint: string;
  quoteMint: string | null;
  quoteUnit: "SOL" | "NON_SOL_RAW" | "UNKNOWN";
  bucketSeconds: number;
  horizonSeconds: number;
  baselinePrice: number | null;
  impulsePriceChangePct: number | null;
  impulseHighPrice: number | null;
  impulseHighTime: number | null;
  pullbackPct: number | null;
  pullbackLowPrice: number | null;
  pullbackLowTime: number | null;
  reclaimDetected: boolean;
  reclaimTime: number | null;
  reclaimPrice: number | null;
  reclaimAbovePreviousFiveSecondHighPct: number | null;
  impulseVolume: StageVolume;
  pullbackVolume: StageVolume;
  reclaimVolume: StageVolume;
  pullbackVolumeVsImpulsePct: number | null;
  reclaimVolumeVsPullbackPct: number | null;
  buckets: PriceVolumeBucket[];
  profileStatus: "NO_VERIFIED_TRADES" | "NO_IMPULSE" | "IMPULSE_ONLY" | "PULLBACK_TOO_DEEP" | "PULLBACK_IN_PROGRESS" | "RECLAIM_DETECTED";
  coverageStatus: "COMPLETE_FROM_LAUNCH" | "PARTIAL_FROM_LAUNCH" | "GAPPED" | "UNKNOWN";
  dataComplete: boolean;
  coverage: "OBSERVED_EVENTS_ONLY";
  entryEligible: false;
}

interface TimedTrade {
  event: PumpTradeEvent;
  timestamp: number;
  price: number;
  quoteAmount: bigint;
  slot: number;
  signature: string;
}

interface MutableBucket {
  startTime: number;
  events: TimedTrade[];
}

function quoteAmount(event: PumpTradeEvent): bigint {
  if (event.quoteMint === SOL_QUOTE_MINT) {
    return event.quoteAmount > 0n ? event.quoteAmount : event.solAmount;
  }
  return event.quoteAmount;
}

function reservePrice(
  quoteReserves: bigint,
  tokenReserves: bigint
): number | null {
  if (quoteReserves <= 0n || tokenReserves <= 0n) return null;
  const scaled = (quoteReserves * PRICE_SCALE) / tokenReserves;
  const value = Number(scaled) / Number(PRICE_SCALE);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function priceOf(event: PumpTradeEvent): number | null {
  const quoteReserves = event.quoteMint === SOL_QUOTE_MINT
    ? event.virtualSolReserves
    : event.virtualQuoteReserves;
  return reservePrice(quoteReserves, event.virtualTokenReserves);
}

function summarizeBucket(bucket: MutableBucket): PriceVolumeBucket | null {
  const valid = bucket.events.filter(item => item.price > 0 && item.quoteAmount > 0n);
  if (valid.length === 0) return null;
  let buy = 0n;
  let sell = 0n;
  const buyers = new Set<string>();
  const sellers = new Set<string>();
  let buyTrades = 0;
  let sellTrades = 0;
  for (const item of valid) {
    if (item.event.isBuy) {
      buy += item.quoteAmount;
      buyTrades += 1;
      buyers.add(item.event.user);
    } else {
      sell += item.quoteAmount;
      sellTrades += 1;
      sellers.add(item.event.user);
    }
  }
  return {
    startTime: bucket.startTime,
    endTime: bucket.startTime + PRICE_VOLUME_BUCKET_SECONDS,
    openPrice: valid[0]!.price,
    highPrice: Math.max(...valid.map(item => item.price)),
    lowPrice: Math.min(...valid.map(item => item.price)),
    closePrice: valid[valid.length - 1]!.price,
    tradeCount: valid.length,
    buyTrades,
    sellTrades,
    uniqueBuyers: buyers.size,
    uniqueSellers: sellers.size,
    buyQuoteVolume: buy.toString(),
    sellQuoteVolume: sell.toString(),
    totalQuoteVolume: (buy + sell).toString()
  };
}

function volumeRatioPct(part: StageVolume, base: StageVolume): number | null {
  const denominator = BigInt(base.totalQuoteVolume);
  if (denominator <= 0n) return null;
  const numerator = BigInt(part.totalQuoteVolume);
  return Number((numerator * 10_000n + denominator / 2n) / denominator) / 100;
}

function summarizeStage(buckets: readonly PriceVolumeBucket[]): StageVolume {
  let buy = 0n;
  let sell = 0n;
  let trades = 0;
  for (const bucket of buckets) {
    buy += BigInt(bucket.buyQuoteVolume);
    sell += BigInt(bucket.sellQuoteVolume);
    trades += bucket.tradeCount;
  }
  const total = buy + sell;
  return {
    startTime: buckets[0]?.startTime ?? null,
    endTime: buckets[buckets.length - 1]?.endTime ?? null,
    bucketCount: buckets.length,
    tradeCount: trades,
    buyQuoteVolume: buy.toString(),
    sellQuoteVolume: sell.toString(),
    totalQuoteVolume: total.toString(),
    averageQuoteVolumePerBucket: buckets.length > 0
      ? (total / BigInt(buckets.length)).toString()
      : null
  };
}

/**
 * Builds an observed-trade price/volume profile. Price indices use virtual
 * bonding-curve quote/token reserve ratios (and the CreateEvent launch reserves
 * when available). They are not executable quotes or fill estimates.
 * No contraction/expansion threshold is applied to stage volumes because those
 * thresholds have not been agreed.
 */
export function buildCandidatePriceVolumeProfiles(
  transactions: readonly VerifiedPumpTransaction[],
  options: {
    nowSeconds?: number;
    horizonSeconds?: number;
    incompleteMints?: readonly string[];
    coverageStartByMint?: Readonly<Record<string, number>>;
    candidateMints?: readonly string[];
  } = {}
): CandidatePriceVolumeProfile[] {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const horizon = options.horizonSeconds ?? PRICE_VOLUME_HORIZON_SECONDS;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(horizon) ||
      horizon < PRICE_VOLUME_BUCKET_SECONDS) {
    throw new Error("Invalid price-volume profile time range.");
  }
  const lower = now - horizon;
  const groups = new Map<string, {
    mint: string;
    quoteMint: string | null;
    trades: TimedTrade[];
    launchTime: number | null;
    launchPrice: number | null;
  }>();
  const ensure = (mint: string, quoteMint: string | null) => {
    const key = `${mint}:${quoteMint ?? "UNKNOWN"}`;
    let group = groups.get(key);
    if (!group) {
      group = { mint, quoteMint, trades: [], launchTime: null, launchPrice: null };
      groups.set(key, group);
    }
    return group;
  };

  for (const transaction of transactions) {
    for (const created of transaction.createEvents) {
      const timestamp = Number(created.timestamp);
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) continue;
      const group = ensure(created.mint, created.quoteMint);
      if (group.launchTime === null || timestamp < group.launchTime) {
        group.launchTime = timestamp;
        const quoteReserves = created.quoteMint === SOL_QUOTE_MINT
          ? created.virtualSolReserves
          : created.virtualQuoteReserves;
        group.launchPrice = reservePrice(quoteReserves, created.virtualTokenReserves);
      }
    }
    for (const event of transaction.tradeEvents) {
      const timestamp = Number(event.timestamp);
      if (!Number.isSafeInteger(timestamp) || timestamp < lower || timestamp > now) continue;
      const group = ensure(event.mint, event.quoteMint);
      if (group.launchTime !== null && timestamp < group.launchTime) continue;
      const price = priceOf(event);
      const amount = quoteAmount(event);
      if (price === null || amount <= 0n) continue;
      group.trades.push({
        event, timestamp, price, quoteAmount: amount,
        slot: transaction.slot, signature: transaction.signature
      });
    }
  }
  for (const mint of options.candidateMints ?? []) {
    if (![...groups.values()].some(group => group.mint === mint)) ensure(mint, null);
  }

  const incomplete = new Set(options.incompleteMints ?? []);
  const output: CandidatePriceVolumeProfile[] = [];
  for (const group of groups.values()) {
    group.trades.sort((a, b) => a.timestamp - b.timestamp || a.slot - b.slot || a.signature.localeCompare(b.signature));
    const mutable = new Map<number, MutableBucket>();
    for (const item of group.trades) {
      const start = Math.floor(item.timestamp / PRICE_VOLUME_BUCKET_SECONDS) * PRICE_VOLUME_BUCKET_SECONDS;
      if (start + PRICE_VOLUME_BUCKET_SECONDS > now) continue;
      const bucket = mutable.get(start) ?? { startTime: start, events: [] };
      bucket.events.push(item);
      mutable.set(start, bucket);
    }
    const buckets = [...mutable.values()].sort((a, b) => a.startTime - b.startTime)
      .map(summarizeBucket).filter((value): value is PriceVolumeBucket => value !== null);
    const empty = summarizeStage([]);
    // Prefer the verified CreateEvent reserve price. If unavailable, use the
    // first observed trade only as a partial baseline; coverage remains UNKNOWN.
    const baseline = group.launchPrice ?? buckets[0]?.openPrice ?? null;
    const thresholdIndex = baseline === null
      ? -1
      : buckets.findIndex(bucket => bucket.highPrice >= baseline * 1.2);
    let peakIndex = -1;
    let pullbackIndex = -1;
    let pullbackLowIndex = -1;
    let tooDeep = false;
    let peakPrice = 0;
    let lowPrice = Number.POSITIVE_INFINITY;

    if (thresholdIndex >= 0) {
      peakPrice = buckets[thresholdIndex]!.highPrice;
      peakIndex = thresholdIndex;
      for (let i = thresholdIndex; i < buckets.length; i += 1) {
        const bucket = buckets[i]!;
        if (bucket.highPrice > peakPrice) {
          peakPrice = bucket.highPrice;
          peakIndex = i;
        }
        const drawdownPct = ((peakPrice - bucket.lowPrice) / peakPrice) * 100;
        if (drawdownPct >= 10) {
          if (drawdownPct > 40) {
            tooDeep = true;
            pullbackIndex = peakIndex + 1;
            pullbackLowIndex = i;
            lowPrice = bucket.lowPrice;
          } else {
            pullbackIndex = peakIndex + 1;
            pullbackLowIndex = i;
            lowPrice = bucket.lowPrice;
          }
          break;
        }
      }
    }

    let reclaimIndex = -1;
    let reclaimAbovePct: number | null = null;
    if (pullbackIndex >= 0 && pullbackLowIndex >= 0 && !tooDeep) {
      for (let i = pullbackIndex; i < buckets.length; i += 1) {
        const bucket = buckets[i]!;
        // A bucket that makes a new pullback low cannot also confirm reclaim:
        // its intrabucket high/low ordering is not precise enough at 5s resolution.
        if (bucket.lowPrice < lowPrice) {
          lowPrice = bucket.lowPrice;
          pullbackLowIndex = i;
          if (((peakPrice - lowPrice) / peakPrice) * 100 > 40) {
            tooDeep = true;
            break;
          }
          continue;
        }
        if (i > pullbackLowIndex) {
          const previousHigh = buckets[i - 1]!.highPrice;
          const reclaimPct = ((bucket.highPrice / previousHigh) - 1) * 100;
          if (reclaimPct >= 1) {
            reclaimIndex = i;
            reclaimAbovePct = reclaimPct;
            break;
          }
        }
      }
    }

    const pullbackPct = peakPrice > 0 && Number.isFinite(lowPrice)
      ? ((peakPrice - lowPrice) / peakPrice) * 100
      : null;
    const impulseBuckets = peakIndex >= 0 ? buckets.slice(0, peakIndex + 1) : [];
    const pullbackEnd = reclaimIndex >= 0 ? pullbackLowIndex : buckets.length - 1;
    const pullbackBuckets = pullbackIndex >= 0 && pullbackEnd >= pullbackIndex
      ? buckets.slice(pullbackIndex, pullbackEnd + 1)
      : [];
    const reclaimBuckets = reclaimIndex >= 0
      ? buckets.slice(pullbackLowIndex + 1, reclaimIndex + 1)
      : [];
    const impulseVolume = impulseBuckets.length ? summarizeStage(impulseBuckets) : empty;
    const pullbackVolume = pullbackBuckets.length ? summarizeStage(pullbackBuckets) : empty;
    const reclaimVolume = reclaimBuckets.length ? summarizeStage(reclaimBuckets) : empty;
    const coverageStart = options.coverageStartByMint?.[group.mint];
    const coverageStatus = group.launchTime === null || coverageStart === undefined
      ? "UNKNOWN"
      : incomplete.has(group.mint)
        ? "GAPPED"
        : coverageStart <= group.launchTime
          ? "COMPLETE_FROM_LAUNCH"
          : "PARTIAL_FROM_LAUNCH";
    const profileStatus = buckets.length === 0 ? "NO_VERIFIED_TRADES"
      : thresholdIndex < 0 ? "NO_IMPULSE"
      : tooDeep ? "PULLBACK_TOO_DEEP"
      : pullbackIndex < 0 ? "IMPULSE_ONLY"
      : reclaimIndex < 0 ? "PULLBACK_IN_PROGRESS"
      : "RECLAIM_DETECTED";

    output.push({
      mint: group.mint,
      quoteMint: group.quoteMint,
      quoteUnit: group.quoteMint === null ? "UNKNOWN" : group.quoteMint === SOL_QUOTE_MINT ? "SOL" : "NON_SOL_RAW",
      bucketSeconds: PRICE_VOLUME_BUCKET_SECONDS,
      horizonSeconds: horizon,
      baselinePrice: baseline,
      impulsePriceChangePct: baseline !== null && peakPrice > 0 ? ((peakPrice / baseline) - 1) * 100 : null,
      impulseHighPrice: peakIndex >= 0 ? peakPrice : null,
      impulseHighTime: peakIndex >= 0 ? buckets[peakIndex]!.endTime : null,
      pullbackPct,
      pullbackLowPrice: Number.isFinite(lowPrice) ? lowPrice : null,
      pullbackLowTime: pullbackLowIndex >= 0 ? buckets[pullbackLowIndex]!.endTime : null,
      reclaimDetected: reclaimIndex >= 0,
      reclaimTime: reclaimIndex >= 0 ? buckets[reclaimIndex]!.endTime : null,
      reclaimPrice: reclaimIndex >= 0 ? buckets[reclaimIndex]!.highPrice : null,
      reclaimAbovePreviousFiveSecondHighPct: reclaimAbovePct,
      impulseVolume,
      pullbackVolume,
      reclaimVolume,
      pullbackVolumeVsImpulsePct: volumeRatioPct(pullbackVolume, impulseVolume),
      reclaimVolumeVsPullbackPct: volumeRatioPct(reclaimVolume, pullbackVolume),
      buckets,
      profileStatus,
      coverageStatus,
      dataComplete: coverageStatus === "COMPLETE_FROM_LAUNCH" &&
        buckets.at(-1)?.endTime === Math.floor(now / PRICE_VOLUME_BUCKET_SECONDS) * PRICE_VOLUME_BUCKET_SECONDS,
      coverage: "OBSERVED_EVENTS_ONLY",
      entryEligible: false
    });
  }
  return output.sort((a, b) => a.mint.localeCompare(b.mint) ||
    (a.quoteMint ?? "").localeCompare(b.quoteMint ?? ""));
}
