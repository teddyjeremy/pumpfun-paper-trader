export interface ProtectiveExitConfig {
  hardStopLossPct: number;
  trailingActivationPct: number;
  trailingDistancePct: number;
  profitLocks: Array<{ activationPct: number; floorPct: number }>;
}

export interface ProtectiveExitResult {
  highWaterPrice: number;
  hardStopPrice: number;
  trailingStopPrice: number | null;
  profitLockPrice: number | null;
  activeStopPrice: number;
  triggered: boolean;
}

export const DEFAULT_PROTECTIVE_EXIT_CONFIG: ProtectiveExitConfig = {
  hardStopLossPct: 5,
  trailingActivationPct: 10,
  trailingDistancePct: 40,
  profitLocks: [
    { activationPct: 10, floorPct: 5 },
    { activationPct: 50, floorPct: 15 },
    { activationPct: 100, floorPct: 40 },
    { activationPct: 200, floorPct: 80 }
  ]
};

function assertPositivePrice(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number`);
  }
}

export function calculateProtectiveExit(
  entryPrice: number,
  currentPrice: number,
  previousHighWaterPrice: number,
  previousStopPrice: number | null = null,
  config: ProtectiveExitConfig = DEFAULT_PROTECTIVE_EXIT_CONFIG
): ProtectiveExitResult {
  assertPositivePrice(entryPrice, "entryPrice");
  assertPositivePrice(currentPrice, "currentPrice");
  assertPositivePrice(previousHighWaterPrice, "previousHighWaterPrice");

  const highWaterPrice = Math.max(previousHighWaterPrice, currentPrice);
  const gainFromEntryPct = ((highWaterPrice / entryPrice) - 1) * 100;
  const hardStopPrice = entryPrice * (1 - config.hardStopLossPct / 100);
  const trailingStopPrice = gainFromEntryPct >= config.trailingActivationPct
    ? highWaterPrice * (1 - config.trailingDistancePct / 100)
    : null;

  const activeLock = [...config.profitLocks]
    .filter(lock => gainFromEntryPct >= lock.activationPct)
    .sort((a, b) => b.activationPct - a.activationPct)[0];
  const profitLockPrice = activeLock
    ? entryPrice * (1 + activeLock.floorPct / 100)
    : null;

  const levels = [
    hardStopPrice,
    trailingStopPrice,
    profitLockPrice,
    previousStopPrice
  ].filter((value): value is number => value !== null && Number.isFinite(value));

  const activeStopPrice = Math.max(...levels);
  return {
    highWaterPrice,
    hardStopPrice,
    trailingStopPrice,
    profitLockPrice,
    activeStopPrice,
    triggered: currentPrice <= activeStopPrice
  };
}

export interface ExitObservation {
  complete: boolean;
  buySellRatio: number | null;
  buyVolumeDeclinePct: number | null;
  buyerRateDeclinePct: number | null;
  netSellFlow: boolean | null;
  sellVolumeIncreasePct: number | null;
  sellerRateIncreasePct: number | null;
  liquidityDeclinePct: number | null;
  priceResponseDeclinePct: number | null;
  largeHolderSellPct: number | null;
  criticalDistributionDetected: boolean;
}

export interface DynamicExitThresholds {
  buySellRatioMax: number;
  buyVolumeDeclinePctMin: number;
  buyerRateDeclinePctMin: number;
  sellVolumeIncreasePctMin: number;
  sellerRateIncreasePctMin: number;
  liquidityDeclinePctMin: number;
  priceResponseDeclinePctMin: number;
  largeHolderSellPctMin: number;
  confirmationWindows: number;
  minimumBearishFamiliesPerWindow: number;
}

export interface DynamicExitResult {
  triggered: boolean;
  immediate: boolean;
  confirmedWindows: number;
  familyCounts: number[];
  signalFamilies: string[][];
  reasons: string[];
}

/**
 * Dynamic exhaustion uses independent evidence families, not raw signal counts.
 * Several correlated flow measurements in one family cannot manufacture a
 * multi-signal exit. Protective hard/trailing/profit stops remain independent
 * immediate exits and are evaluated by calculateProtectiveExit().
 */
export function evaluateDynamicExhaustionExit(
  observations: ExitObservation[],
  thresholds: DynamicExitThresholds
): DynamicExitResult {
  const count = thresholds.confirmationWindows;
  const empty = {
    triggered: false,
    immediate: false,
    confirmedWindows: 0,
    familyCounts: [] as number[],
    signalFamilies: [] as string[][],
    reasons: [] as string[]
  };

  // A verified creator/linked/high-confidence-cluster distribution event is
  // an emergency signal and does not wait for rolling-window confirmation.
  if (observations.some(observation => observation.criticalDistributionDetected)) {
    return {
      ...empty,
      triggered: true,
      immediate: true,
      reasons: ["critical_wallet_distribution"]
    };
  }

  if (count < 1 || observations.length < count) return empty;
  const recent = observations.slice(-count);
  if (recent.some(observation => !observation.complete)) return empty;

  const signalFamilies: string[][] = [];
  const reasons = new Set<string>();

  for (const observation of recent) {
    const families = new Set<string>();

    // Family 1: order-flow balance. These measurements are correlated and
    // deliberately count as one family even if several deteriorate together.
    if (
      (observation.buySellRatio !== null && observation.buySellRatio <= thresholds.buySellRatioMax) ||
      observation.netSellFlow === true ||
      (observation.sellVolumeIncreasePct !== null &&
        observation.sellVolumeIncreasePct >= thresholds.sellVolumeIncreasePctMin)
    ) {
      families.add("flow_pressure");
      if (observation.buySellRatio !== null && observation.buySellRatio <= thresholds.buySellRatioMax) reasons.add("buy_sell_pressure_weakened");
      if (observation.netSellFlow === true) reasons.add("net_sell_flow");
      if (observation.sellVolumeIncreasePct !== null && observation.sellVolumeIncreasePct >= thresholds.sellVolumeIncreasePctMin) reasons.add("sell_volume_increased");
    }

    // Family 2: participation. Falling buyer activity and rising seller
    // participation are one family, not multiple votes for the same event.
    if (
      (observation.buyVolumeDeclinePct !== null &&
        observation.buyVolumeDeclinePct >= thresholds.buyVolumeDeclinePctMin) ||
      (observation.buyerRateDeclinePct !== null &&
        observation.buyerRateDeclinePct >= thresholds.buyerRateDeclinePctMin) ||
      (observation.sellerRateIncreasePct !== null &&
        observation.sellerRateIncreasePct >= thresholds.sellerRateIncreasePctMin)
    ) {
      families.add("participation_decay");
      if (observation.buyVolumeDeclinePct !== null && observation.buyVolumeDeclinePct >= thresholds.buyVolumeDeclinePctMin) reasons.add("buy_volume_declined");
      if (observation.buyerRateDeclinePct !== null && observation.buyerRateDeclinePct >= thresholds.buyerRateDeclinePctMin) reasons.add("buyer_rate_declined");
      if (observation.sellerRateIncreasePct !== null && observation.sellerRateIncreasePct >= thresholds.sellerRateIncreasePctMin) reasons.add("seller_rate_increased");
    }

    // Family 3: liquidity/reserve deterioration.
    if (observation.liquidityDeclinePct !== null &&
      observation.liquidityDeclinePct >= thresholds.liquidityDeclinePctMin) {
      families.add("liquidity_drain");
      reasons.add("liquidity_declined");
    }

    // Family 4: price no longer responds efficiently to incoming buy flow.
    if (observation.priceResponseDeclinePct !== null &&
      observation.priceResponseDeclinePct >= thresholds.priceResponseDeclinePctMin) {
      families.add("price_response_decay");
      reasons.add("price_response_weakened");
    }

    // Family 5: large-holder distribution. Critical creator/linked-wallet
    // events are handled above; this family captures material holder selling.
    if (observation.largeHolderSellPct !== null &&
      observation.largeHolderSellPct >= thresholds.largeHolderSellPctMin) {
      families.add("large_holder_distribution");
      reasons.add("large_holder_distribution");
    }

    signalFamilies.push([...families].sort());
  }

  const familyCounts = signalFamilies.map(families => families.length);
  const triggered = familyCounts.every(
    familyCount => familyCount >= thresholds.minimumBearishFamiliesPerWindow
  );

  return {
    triggered,
    immediate: false,
    confirmedWindows: triggered ? count : 0,
    familyCounts,
    signalFamilies,
    reasons: triggered ? [...reasons].sort() : []
  };
}

export type PositionMarketState =
  | "open_curve"
  | "migration_pending"
  | "open_migrated"
  | "exit_blocked"
  | "closed";

export function transitionPositionMarketState(
  current: PositionMarketState,
  input: { graduated: boolean; migratedPoolVerified: boolean; freshSellQuoteAvailable: boolean }
): PositionMarketState {
  if (current === "closed") return "closed";
  if (current === "open_curve" && input.graduated) return "migration_pending";
  if (current === "migration_pending" || current === "exit_blocked") {
    if (input.migratedPoolVerified && input.freshSellQuoteAvailable) return "open_migrated";
    if (input.migratedPoolVerified && !input.freshSellQuoteAvailable) return "exit_blocked";
    return "migration_pending";
  }
  if (current === "open_migrated") {
    if (!input.migratedPoolVerified || !input.freshSellQuoteAvailable) return "exit_blocked";
    return "open_migrated";
  }
  return current;
}
