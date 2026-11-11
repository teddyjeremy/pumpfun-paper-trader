export type MarketState = "bonding_curve" | "migration_pending" | "migrated_pool" | "exit_blocked";

export type DynamicExitThresholds = {
  /** A ratio below this value is bearish. */
  buySellRatioBelow: number;
  /** Percent decline against the immediately preceding comparable window. */
  buyVolumeDeclinePctAtLeast: number;
  /** Percent decline in unique-buyer rate against the preceding comparable window. */
  buyerRateDeclinePctAtLeast: number;
  /** Number of consecutive observations that must each contain >= 2 bearish signals. */
  consecutiveWindows: number;
};

export type ExitPolicy = {
  hardStopPct: number;
  trailingActivationPct: number;
  trailingDrawdownPct: number;
  profitLocks: Array<{ reachedPct: number; lockPct: number }>;
  dynamic: DynamicExitThresholds | null;
};

export const DEFAULT_EXIT_POLICY: ExitPolicy = {
  hardStopPct: 5,
  trailingActivationPct: 10,
  trailingDrawdownPct: 40,
  profitLocks: [
    { reachedPct: 10, lockPct: 5 },
    { reachedPct: 50, lockPct: 15 },
    { reachedPct: 100, lockPct: 40 },
    { reachedPct: 200, lockPct: 80 }
  ],
  // Deliberately disabled until thresholds are calibrated on reliable live quote-volume data.
  dynamic: null
};

export type PositionExitState = {
  entryPriceUsd: number;
  highWaterPriceUsd: number;
  activeStopPriceUsd: number;
  marketState: MarketState;
  bearishStreak: number;
};

export type ExitObservation = {
  markPriceUsd: number;
  observedMarketState: MarketState;
  migrationDetected?: boolean;
  migratedPoolVerified?: boolean;
  sellQuoteFresh: boolean;
  sellRouteVerified: boolean;
  buySellQuoteVolumeRatio?: number | null;
  buyVolumeDeclinePct?: number | null;
  buyerRateDeclinePct?: number | null;
  creatorOrLinkedSellDetected?: boolean;
  marketInvalid?: boolean;
};

export type ExitDecision = {
  action: "hold" | "migration_pending" | "exit" | "exit_blocked";
  reason: string;
  activeStopPriceUsd: number;
  highWaterPriceUsd: number;
  marketState: MarketState;
  bearishStreak: number;
  bearishSignals: string[];
};

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
}

function getBearishSignals(
  observation: ExitObservation,
  thresholds: DynamicExitThresholds
): string[] {
  const signals: string[] = [];
  if (
    observation.buySellQuoteVolumeRatio !== null &&
    observation.buySellQuoteVolumeRatio !== undefined &&
    observation.buySellQuoteVolumeRatio < thresholds.buySellRatioBelow
  ) signals.push("buy_sell_ratio_deteriorated");

  if (
    observation.buyVolumeDeclinePct !== null &&
    observation.buyVolumeDeclinePct !== undefined &&
    observation.buyVolumeDeclinePct >= thresholds.buyVolumeDeclinePctAtLeast
  ) signals.push("buy_volume_contracting");

  if (
    observation.buyerRateDeclinePct !== null &&
    observation.buyerRateDeclinePct !== undefined &&
    observation.buyerRateDeclinePct >= thresholds.buyerRateDeclinePctAtLeast
  ) signals.push("buyer_rate_contracting");

  return signals;
}

/**
 * Pure, deterministic exit decision. The caller persists the returned state and
 * only records a paper fill when a fresh, verified, position-sized sell quote exists.
 * There is intentionally no maximum holding-time parameter.
 */
export function evaluateExit(
  position: PositionExitState,
  observation: ExitObservation,
  policy: ExitPolicy = DEFAULT_EXIT_POLICY
): ExitDecision {
  assertPositive(position.entryPriceUsd, "entryPriceUsd");
  assertPositive(observation.markPriceUsd, "markPriceUsd");

  let marketState = position.marketState;
  let highWaterPriceUsd = Math.max(position.highWaterPriceUsd, observation.markPriceUsd);
  let activeStopPriceUsd = Math.max(
    position.activeStopPriceUsd,
    position.entryPriceUsd * (1 - policy.hardStopPct / 100)
  );
  let bearishStreak = position.bearishStreak;

  // Graduation changes the market being monitored; it is not itself a sell signal.
  if (observation.migrationDetected && marketState === "bonding_curve") {
    marketState = "migration_pending";
    bearishStreak = 0;
    return {
      action: "migration_pending",
      reason: "migration_detected_waiting_for_verified_migrated_pool",
      activeStopPriceUsd,
      highWaterPriceUsd,
      marketState,
      bearishStreak,
      bearishSignals: []
    };
  }

  if (marketState === "migration_pending") {
    if (observation.observedMarketState !== "migrated_pool" || !observation.migratedPoolVerified) {
      return {
        action: "migration_pending",
        reason: "migrated_pool_not_yet_verified",
        activeStopPriceUsd,
        highWaterPriceUsd,
        marketState,
        bearishStreak,
        bearishSignals: []
      };
    }
    marketState = "migrated_pool";
  } else if (observation.observedMarketState === "migrated_pool" && observation.migratedPoolVerified) {
    marketState = "migrated_pool";
  }

  const quoteUsable = observation.sellQuoteFresh && observation.sellRouteVerified;
  const needsEmergencyExit = !!observation.creatorOrLinkedSellDetected || !!observation.marketInvalid;

  if (!quoteUsable) {
    if (marketState === "migrated_pool") marketState = "exit_blocked";
    return {
      action: "exit_blocked",
      reason: "fresh_verified_position_sized_sell_quote_unavailable",
      activeStopPriceUsd,
      highWaterPriceUsd,
      marketState,
      bearishStreak,
      bearishSignals: []
    };
  }

  if (needsEmergencyExit) {
    return {
      action: "exit",
      reason: observation.marketInvalid ? "market_invalid_emergency_exit" : "creator_or_linked_wallet_sell_emergency_exit",
      activeStopPriceUsd,
      highWaterPriceUsd,
      marketState,
      bearishStreak,
      bearishSignals: ["emergency_risk_event"]
    };
  }

  const peakProfitPct = ((highWaterPriceUsd / position.entryPriceUsd) - 1) * 100;
  if (peakProfitPct >= policy.trailingActivationPct) {
    const trailingStop = highWaterPriceUsd * (1 - policy.trailingDrawdownPct / 100);
    activeStopPriceUsd = Math.max(activeStopPriceUsd, trailingStop);
  }

  for (const lock of policy.profitLocks) {
    if (peakProfitPct >= lock.reachedPct) {
      activeStopPriceUsd = Math.max(
        activeStopPriceUsd,
        position.entryPriceUsd * (1 + lock.lockPct / 100)
      );
    }
  }

  if (observation.markPriceUsd <= activeStopPriceUsd) {
    return {
      action: "exit",
      reason: "protective_stop_hit",
      activeStopPriceUsd,
      highWaterPriceUsd,
      marketState,
      bearishStreak,
      bearishSignals: ["protective_stop"]
    };
  }

  const bearishSignals = policy.dynamic
    ? getBearishSignals(observation, policy.dynamic)
    : [];
  const hasMultipleBearishSignals = bearishSignals.length >= 2;
  bearishStreak = hasMultipleBearishSignals ? bearishStreak + 1 : 0;

  if (policy.dynamic && bearishStreak >= policy.dynamic.consecutiveWindows) {
    return {
      action: "exit",
      reason: "confirmed_market_exhaustion",
      activeStopPriceUsd,
      highWaterPriceUsd,
      marketState,
      bearishStreak,
      bearishSignals
    };
  }

  return {
    action: "hold",
    reason: bearishSignals.length
      ? "bearish_evidence_not_yet_confirmed"
      : "no_exit_condition",
    activeStopPriceUsd,
    highWaterPriceUsd,
    marketState,
    bearishStreak,
    bearishSignals
  };
}
