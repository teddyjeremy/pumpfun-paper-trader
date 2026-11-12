import type { ExitWindowObservation } from "./dynamic-exits.js";

export interface RawExitWindowSample {
  mint: string;
  marketPhase: "bonding_curve" | "migrated_market";
  venue: "pump_curve" | "pumpswap";
  quoteMint: string;
  endedAtMs: number;
  windowSeconds: 2 | 5 | 10 | 30;
  complete: boolean;
  buyQuoteVolumeBaseUnits: string;
  sellQuoteVolumeBaseUnits: string;
  uniqueBuyers: number;
  uniqueSellers: number;
  startPriceQuotePerToken: number | null;
  endPriceQuotePerToken: number | null;
  quoteLiquidityBaseUnits: string | null;
  largeHolderDistributionDetected: boolean | null;
}

function validUnits(value: string): boolean {
  return /^\d+$/.test(value);
}
function pctChange(previous: bigint, current: bigint): number | null {
  if (previous <= 0n) return null;
  return Number(((current - previous) * 10_000n) / previous) / 100;
}
function pctDecline(previous: bigint, current: bigint): number | null {
  if (previous <= 0n) return null;
  return Number(((previous - current) * 10_000n) / previous) / 100;
}
function finitePrice(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}
function sameContext(a: RawExitWindowSample, b: RawExitWindowSample): boolean {
  return a.mint === b.mint && a.marketPhase === b.marketPhase &&
    a.venue === b.venue && a.quoteMint === b.quoteMint &&
    a.windowSeconds === b.windowSeconds;
}
function validSample(sample: RawExitWindowSample): boolean {
  return Boolean(sample.mint && sample.quoteMint) &&
    Number.isSafeInteger(sample.endedAtMs) && sample.endedAtMs >= 0 &&
    validUnits(sample.buyQuoteVolumeBaseUnits) && validUnits(sample.sellQuoteVolumeBaseUnits) &&
    Number.isSafeInteger(sample.uniqueBuyers) && sample.uniqueBuyers >= 0 &&
    Number.isSafeInteger(sample.uniqueSellers) && sample.uniqueSellers >= 0 &&
    (sample.quoteLiquidityBaseUnits === null || validUnits(sample.quoteLiquidityBaseUnits)) &&
    (sample.startPriceQuotePerToken === null || finitePrice(sample.startPriceQuotePerToken)) &&
    (sample.endPriceQuotePerToken === null || finitePrice(sample.endPriceQuotePerToken));
}
function ratio(numerator: bigint, denominator: bigint): number | null {
  if (denominator <= 0n) return null;
  return Number((numerator * 1_000_000_000n) / denominator) / 1_000_000_000;
}
function responsePerBuyVolume(sample: RawExitWindowSample): number | null {
  if (!finitePrice(sample.startPriceQuotePerToken) ||
      !finitePrice(sample.endPriceQuotePerToken)) return null;
  const volume = BigInt(sample.buyQuoteVolumeBaseUnits);
  if (volume <= 0n) return null;
  const priceReturnPct = ((sample.endPriceQuotePerToken / sample.startPriceQuotePerToken) - 1) * 100;
  const volumeAsNumber = Number(volume);
  if (!Number.isFinite(priceReturnPct) || !Number.isFinite(volumeAsNumber) || volumeAsNumber <= 0) return null;
  return priceReturnPct / volumeAsNumber;
}

/**
 * Converts complete verified market buckets into independent dynamic-exit
 * measurements. Baselines reset across gaps, venue/phase changes or quote-mint
 * changes; missing data remains null instead of being coerced to zero.
 */
export function buildExitWindowObservations(
  input: RawExitWindowSample[]
): ExitWindowObservation[] {
  const samples = [...input].sort((a, b) => a.endedAtMs - b.endedAtMs);
  const output: ExitWindowObservation[] = [];
  let previous: RawExitWindowSample | null = null;

  for (const sample of samples) {
    if (!validSample(sample)) {
      output.push({
        endedAtMs: Number.isFinite(sample.endedAtMs) ? sample.endedAtMs : 0,
        windowSeconds: sample.windowSeconds,
        complete: false, buySellRatio: null, buyVolumeDeclinePct: null,
        buyerRateDeclinePct: null, sellVolumeExpansionPct: null,
        priceResponseDeclinePct: null, liquidityChangePct: null,
        largeHolderDistributionDetected: null
      });
      previous = null;
      continue;
    }

    const currentBuy = BigInt(sample.buyQuoteVolumeBaseUnits);
    const currentSell = BigInt(sample.sellQuoteVolumeBaseUnits);
    const previousIsContiguous = previous !== null && sameContext(previous, sample) &&
      sample.endedAtMs > previous.endedAtMs &&
      sample.endedAtMs - previous.endedAtMs <= sample.windowSeconds * 1_500;
    const baseline = previousIsContiguous ? previous : null;
    const previousBuy = baseline ? BigInt(baseline.buyQuoteVolumeBaseUnits) : 0n;
    const previousSell = baseline ? BigInt(baseline.sellQuoteVolumeBaseUnits) : 0n;
    const buySellRatio = currentSell > 0n ? ratio(currentBuy, currentSell) : null;
    const buyVolumeDeclinePct = baseline ? pctDecline(previousBuy, currentBuy) : null;
    const buyerRateDeclinePct = baseline && baseline.uniqueBuyers > 0
      ? ((baseline.uniqueBuyers - sample.uniqueBuyers) / baseline.uniqueBuyers) * 100 : null;
    const sellVolumeExpansionPct = baseline ? pctChange(previousSell, currentSell) : null;

    const previousResponse = baseline ? responsePerBuyVolume(baseline) : null;
    const currentResponse = responsePerBuyVolume(sample);
    const priceResponseDeclinePct = previousResponse !== null && previousResponse > 0 && currentResponse !== null
      ? ((previousResponse - currentResponse) / previousResponse) * 100 : null;

    const previousLiquidity = baseline?.quoteLiquidityBaseUnits;
    const currentLiquidity = sample.quoteLiquidityBaseUnits;
    const liquidityChangePct = previousLiquidity && currentLiquidity &&
      BigInt(previousLiquidity) > 0n
      ? pctChange(BigInt(previousLiquidity), BigInt(currentLiquidity)) : null;

    output.push({
      endedAtMs: sample.endedAtMs, windowSeconds: sample.windowSeconds,
      complete: sample.complete,
      buySellRatio: sample.complete ? buySellRatio : null,
      buyVolumeDeclinePct: sample.complete ? buyVolumeDeclinePct : null,
      buyerRateDeclinePct: sample.complete ? buyerRateDeclinePct : null,
      sellVolumeExpansionPct: sample.complete ? sellVolumeExpansionPct : null,
      priceResponseDeclinePct: sample.complete ? priceResponseDeclinePct : null,
      liquidityChangePct: sample.complete ? liquidityChangePct : null,
      largeHolderDistributionDetected: sample.complete ? sample.largeHolderDistributionDetected : null
    });
    previous = sample.complete ? sample : null;
  }
  return output;
}
