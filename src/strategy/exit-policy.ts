export type TradingVenue = "bonding_curve" | "pumpswap" | "unknown";

export type ExitWindow = {
  buyVolumeLamports: number;
  sellVolumeLamports: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  priceChangePct: number;
};

export type ExitPolicyInput = {
  entryPrice: number;
  /** Fresh venue-specific executable mark after simulated latency, not a chart-only price. */
  currentPrice: number;
  /** Highest completed executable mark observed since entry. */
  highestCompletedPrice: number;
  venue: TradingVenue;
  migrationDetected: boolean;
  migratedPoolVerified: boolean;
  /** Three completed 5-second windows immediately before the latest three. */
  baselineWindows: ExitWindow[];
  /** Latest three completed 5-second windows, in chronological order. */
  recentWindows: ExitWindow[];
  creatorDistributionDetected?: boolean;
  marketIntegrityFailure?: boolean;
};

export type ExitPolicyConfig = {
  buyVolumeDeclineFraction: number;
  sellToBuyVolumeRatio: number;
  consecutiveSellPressureWindows: number;
};

export type ExitDecision = {
  action: "HOLD" | "SWITCH_VENUE" | "WAIT_FOR_POOL" | "SELL";
  venue: TradingVenue;
  reason: string;
  activeStopPrice: number;
  exitSignal?: "HARD_STOP" | "TRAILING_STOP" | "PROFIT_LOCK" | "SELL_PRESSURE" | "CREATOR_DISTRIBUTION" | "MARKET_INTEGRITY";
  buyVolumeDeclineFraction?: number;
};

export const DEFAULT_EXIT_POLICY: Readonly<ExitPolicyConfig> = Object.freeze({
  // Initial paper-calibration candidate, not a locked strategy threshold.
  buyVolumeDeclineFraction: 0.5,
  sellToBuyVolumeRatio: 1.5,
  consecutiveSellPressureWindows: 3
});

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function stopLevels(entry: number, high: number): { hard: number; trailing: number; profitLock: number; active: number } {
  const hard = entry * 0.95;
  let profitLock = 0;
  if (high >= entry * 3) profitLock = entry * 1.8;          // +200% reached: lock +80%
  else if (high >= entry * 2) profitLock = entry * 1.4;     // +100% reached: lock +40%
  else if (high >= entry * 1.5) profitLock = entry * 1.15;  // +50% reached: lock +15%
  else if (high >= entry * 1.1) profitLock = entry * 1.05;  // +10% reached: lock +5%

  const trailing = high >= entry * 1.1 ? high * 0.6 : 0;
  return { hard, trailing, profitLock, active: Math.max(hard, trailing, profitLock) };
}

function validWindow(window: ExitWindow): boolean {
  return [
    window.buyVolumeLamports,
    window.sellVolumeLamports,
    window.uniqueBuyers,
    window.uniqueSellers,
    window.priceChangePct
  ].every(Number.isFinite)
    && window.buyVolumeLamports >= 0
    && window.sellVolumeLamports >= 0
    && window.uniqueBuyers >= 0
    && window.uniqueSellers >= 0;
}

export function evaluateExitPolicy(
  input: ExitPolicyInput,
  policy: ExitPolicyConfig = DEFAULT_EXIT_POLICY
): ExitDecision {
  const { entryPrice, currentPrice, highestCompletedPrice } = input;
  if (![entryPrice, currentPrice, highestCompletedPrice].every(Number.isFinite)
      || entryPrice <= 0 || currentPrice <= 0 || highestCompletedPrice <= 0) {
    return {
      action: "HOLD",
      venue: input.venue,
      reason: "Invalid or missing executable price observations; no synthetic exit is permitted.",
      activeStopPrice: 0
    };
  }

  const stops = stopLevels(entryPrice, highestCompletedPrice);
  let exitSignal: ExitDecision["exitSignal"];
  if (currentPrice <= stops.hard) exitSignal = "HARD_STOP";
  else if (stops.profitLock > 0 && currentPrice <= stops.profitLock) exitSignal = "PROFIT_LOCK";
  else if (stops.trailing > 0 && currentPrice <= stops.trailing) exitSignal = "TRAILING_STOP";

  if (!exitSignal && input.creatorDistributionDetected) exitSignal = "CREATOR_DISTRIBUTION";
  if (!exitSignal && input.marketIntegrityFailure) exitSignal = "MARKET_INTEGRITY";

  let buyVolumeDeclineFraction: number | undefined;
  const windowsValid = input.baselineWindows.length === 3
    && input.recentWindows.length === 3
    && [...input.baselineWindows, ...input.recentWindows].every(validWindow);

  if (!exitSignal && windowsValid) {
    const baselineBuy = sum(input.baselineWindows.map(window => window.buyVolumeLamports));
    const recentBuy = sum(input.recentWindows.map(window => window.buyVolumeLamports));
    buyVolumeDeclineFraction = baselineBuy > 0 ? Math.max(0, 1 - recentBuy / baselineBuy) : 0;

    const confirmingWindows = input.recentWindows.slice(-policy.consecutiveSellPressureWindows);
    const sustainedSellPressure = confirmingWindows.length === policy.consecutiveSellPressureWindows
      && confirmingWindows.every(window =>
        window.sellVolumeLamports >= window.buyVolumeLamports * policy.sellToBuyVolumeRatio
        && window.uniqueSellers > window.uniqueBuyers
        && window.priceChangePct <= 0
      );

    // Multiple independent bearish signals must persist across completed windows.
    if (buyVolumeDeclineFraction >= policy.buyVolumeDeclineFraction
        && sustainedSellPressure
        && input.recentWindows.length >= policy.consecutiveSellPressureWindows) {
      exitSignal = "SELL_PRESSURE";
    }
  }

  const migrated = input.migrationDetected || input.venue === "pumpswap";
  const activeVenue: TradingVenue = migrated ? "pumpswap" : input.venue;

  // Graduation changes the market venue; it is not an automatic exit.
  // Keep any triggered exit signal pending until the canonical pool is verified.
  if (migrated && !input.migratedPoolVerified) {
    return {
      action: "WAIT_FOR_POOL",
      venue: "pumpswap",
      reason: "Migration detected. Waiting for the canonical PumpSwap pool and a fresh sell quote; migration alone is not a sell signal.",
      activeStopPrice: stops.active,
      ...(exitSignal ? { exitSignal } : {}),
      ...(buyVolumeDeclineFraction !== undefined ? { buyVolumeDeclineFraction } : {})
    };
  }

  if (exitSignal) {
    return {
      action: "SELL",
      venue: activeVenue,
      reason: exitSignal === "SELL_PRESSURE"
        ? "Buying volume contracted while sustained selling pressure and weakening price were confirmed across consecutive completed windows."
        : `Protective or emergency exit condition triggered: ${exitSignal}.`,
      activeStopPrice: stops.active,
      exitSignal,
      ...(buyVolumeDeclineFraction !== undefined ? { buyVolumeDeclineFraction } : {})
    };
  }

  if (migrated && input.venue !== "pumpswap") {
    return {
      action: "SWITCH_VENUE",
      venue: "pumpswap",
      reason: "Canonical PumpSwap pool verified. Continue managing the existing position on PumpSwap; do not sell solely because of graduation.",
      activeStopPrice: stops.active,
      ...(buyVolumeDeclineFraction !== undefined ? { buyVolumeDeclineFraction } : {})
    };
  }

  return {
    action: "HOLD",
    venue: activeVenue,
    reason: "No protective stop or confirmed dynamic sell signal. No maximum holding-time exit is applied.",
    activeStopPrice: stops.active,
    ...(buyVolumeDeclineFraction !== undefined ? { buyVolumeDeclineFraction } : {})
  };
}

/** New entries are bonding-curve-only. Existing positions may continue on PumpSwap. */
export function canEnterNewPosition(curveComplete: boolean, migratedPoolVerified: boolean): boolean {
  return !curveComplete && !migratedPoolVerified;
}
