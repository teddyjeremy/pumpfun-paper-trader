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
  currentPrice: number;
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
  // Initial paper-test values. Tune only from measured live/replay evidence.
  buyVolumeDeclineFraction: 0.5,
  sellToBuyVolumeRatio: 1.5,
  consecutiveSellPressureWindows: 3
});

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function protectiveStop(entry: number, high: number): number {
  const hardStop = entry * 0.95;
  let profitLock = 0;
  if (high >= entry * 3) profitLock = entry * 1.8;       // +200% reached: lock +80%
  else if (high >= entry * 2) profitLock = entry * 1.4;  // +100% reached: lock +40%
  else if (high >= entry * 1.5) profitLock = entry * 1.15; // +50% reached: lock +15%
  else if (high >= entry * 1.1) profitLock = entry * 1.05; // +10% reached: lock +5%

  const trailing = high >= entry * 1.1 ? high * 0.6 : 0;
  return Math.max(hardStop, profitLock, trailing);
}

function validateWindow(window: ExitWindow): boolean {
  return [window.buyVolumeLamports, window.sellVolumeLamports, window.uniqueBuyers,
    window.uniqueSellers, window.priceChangePct].every(Number.isFinite)
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
      reason: "Invalid or missing price observations; no synthetic exit is permitted.",
      activeStopPrice: 0
    };
  }

  const activeStopPrice = protectiveStop(entryPrice, highestCompletedPrice);
  let exitSignal: ExitDecision["exitSignal"];
  if (currentPrice <= entryPrice * 0.95) exitSignal = "HARD_STOP";
  else if (highestCompletedPrice >= entryPrice * 3 && currentPrice <= entryPrice * 1.8) exitSignal = "PROFIT_LOCK";
  else if (highestCompletedPrice >= entryPrice * 2 && currentPrice <= entryPrice * 1.4) exitSignal = "PROFIT_LOCK";
  else if (highestCompletedPrice >= entryPrice * 1.5 && currentPrice <= entryPrice * 1.15) exitSignal = "PROFIT_LOCK";
  else if (highestCompletedPrice >= entryPrice * 1.1 && currentPrice <= entryPrice * 1.05) exitSignal = "PROFIT_LOCK";
  else if (highestCompletedPrice >= entryPrice * 1.1 && currentPrice <= highestCompletedPrice * 0.6) exitSignal = "TRAILING_STOP";

  if (!exitSignal && input.creatorDistributionDetected) exitSignal = "CREATOR_DISTRIBUTION";
  if (!exitSignal && input.marketIntegrityFailure) exitSignal = "MARKET_INTEGRITY";

  let buyVolumeDeclineFraction: number | undefined;
  if (!exitSignal
      && input.baselineWindows.length === 3
      && input.recentWindows.length === 3
      && [...input.baselineWindows, ...input.recentWindows].every(validateWindow)) {
    const baselineBuy = sum(input.baselineWindows.map(window => window.buyVolumeLamports));
    const recentBuy = sum(input.recentWindows.map(window => window.buyVolumeLamports));
    buyVolumeDeclineFraction = baselineBuy > 0 ? Math.max(0, 1 - recentBuy / baselineBuy) : 0;
    const sustainedSellPressure = input.recentWindows.every(window =>
      window.sellVolumeLamports >= window.buyVolumeLamports * policy.sellToBuyVolumeRatio
      && window.uniqueSellers > window.uniqueBuyers
      && window.priceChangePct <= 0
    );
    if (buyVolumeDeclineFraction >= policy.buyVolumeDeclineFraction
        && sustainedSellPressure
        && input.recentWindows.length >= policy.consecutiveSellPressureWindows) {
      exitSignal = "SELL_PRESSURE";
    }
  }

  const migrated = input.migrationDetected || input.venue === "pumpswap";
  const activeVenue: TradingVenue = migrated ? "pumpswap" : input.venue;

  // Graduation changes the market venue; it is not itself an exit condition.
  // If a real PumpSwap pool/quote is not verified yet, preserve the position and
  // pending exit signal. Never invent a fill or route back to the closed curve.
  if (migrated && !input.migratedPoolVerified) {
    return {
      action: "WAIT_FOR_POOL",
      venue: "pumpswap",
      reason: "Migration detected. Waiting for verified PumpSwap pool state and a fresh sell quote; migration alone is not a sell signal.",
      activeStopPrice,
      ...(exitSignal ? { exitSignal } : {}),
      ...(buyVolumeDeclineFraction !== undefined ? { buyVolumeDeclineFraction } : {})
    };
  }

  if (exitSignal) {
    return {
      action: "SELL",
      venue: activeVenue,
      reason: exitSignal === "SELL_PRESSURE"
        ? "Buying volume contracted and sustained sell pressure accompanied weakening price across three completed windows."
        : `Protective or emergency exit condition triggered: ${exitSignal}.`,
      activeStopPrice,
      exitSignal,
      ...(buyVolumeDeclineFraction !== undefined ? { buyVolumeDeclineFraction } : {})
    };
  }

  if (migrated && input.venue !== "pumpswap") {
    return {
      action: "SWITCH_VENUE",
      venue: "pumpswap",
      reason: "Verified PumpSwap pool found. Continue managing the existing position on PumpSwap; do not sell solely because of graduation.",
      activeStopPrice,
      ...(buyVolumeDeclineFraction !== undefined ? { buyVolumeDeclineFraction } : {})
    };
  }

  return {
    action: "HOLD",
    venue: activeVenue,
    reason: "No protective stop or confirmed dynamic sell signal. No maximum holding-time exit is applied.",
    activeStopPrice,
    ...(buyVolumeDeclineFraction !== undefined ? { buyVolumeDeclineFraction } : {})
  };
}

/** New entries are bonding-curve-only. Existing positions may continue on PumpSwap. */
export function canEnterNewPosition(curveComplete: boolean, migratedPoolVerified: boolean): boolean {
  return !curveComplete && !migratedPoolVerified;
}
