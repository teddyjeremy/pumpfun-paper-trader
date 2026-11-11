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
  liquidityDeclinePct: number | null;
}

export interface DynamicExitThresholds {
  buySellRatioMax: number;
  buyVolumeDeclinePctMin: number;
  buyerRateDeclinePctMin: number;
  liquidityDeclinePctMin: number;
  confirmationWindows: number;
  minimumBearishSignalsPerWindow: number;
}

export interface DynamicExitResult {
  triggered: boolean;
  confirmedWindows: number;
  signalCounts: number[];
  reasons: string[];
}

export function evaluateDynamicExhaustionExit(
  observations: ExitObservation[],
  thresholds: DynamicExitThresholds
): DynamicExitResult {
  const count = thresholds.confirmationWindows;
  if (count < 1 || observations.length < count) {
    return { triggered: false, confirmedWindows: 0, signalCounts: [], reasons: [] };
  }

  const recent = observations.slice(-count);
  if (recent.some(observation => !observation.complete)) {
    return { triggered: false, confirmedWindows: 0, signalCounts: [], reasons: [] };
  }

  const signalCounts: number[] = [];
  const reasons = new Set<string>();

  for (const observation of recent) {
    let signals = 0;
    if (observation.buySellRatio !== null && observation.buySellRatio <= thresholds.buySellRatioMax) {
      signals += 1;
      reasons.add("buy_sell_pressure_weakened");
    }
    if (observation.buyVolumeDeclinePct !== null && observation.buyVolumeDeclinePct >= thresholds.buyVolumeDeclinePctMin) {
      signals += 1;
      reasons.add("buy_volume_declined");
    }
    if (observation.buyerRateDeclinePct !== null && observation.buyerRateDeclinePct >= thresholds.buyerRateDeclinePctMin) {
      signals += 1;
      reasons.add("buyer_rate_declined");
    }
    if (observation.netSellFlow === true) {
      signals += 1;
      reasons.add("net_sell_flow");
    }
    if (observation.liquidityDeclinePct !== null && observation.liquidityDeclinePct >= thresholds.liquidityDeclinePctMin) {
      signals += 1;
      reasons.add("liquidity_declined");
    }
    signalCounts.push(signals);
  }

  const triggered = signalCounts.every(
    signalCount => signalCount >= thresholds.minimumBearishSignalsPerWindow
  );

  return {
    triggered,
    confirmedWindows: triggered ? count : 0,
    signalCounts,
    reasons: triggered ? [...reasons] : []
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
