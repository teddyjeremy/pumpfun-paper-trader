export interface TradingReadinessInput {
  workerPaused: boolean;
  coordinatorEnabled: boolean;
  activeSession: boolean;
  discoveryConnected: boolean;
  discoverySubscribed: boolean;
  heliusConnected: boolean;
  heliusApiKeyConfigured: boolean;
  fullWalletHistoryEnabled: boolean;
  reviewedVolumeThresholdsAvailable: boolean;
  eventIngestConfigured: boolean;
  persistenceLeaseHeld: boolean;
  controlTokenConfigured: boolean;
  pumpProgramConfigured: boolean;
  quoteSdkModulesAvailable: boolean;
}

export interface TradingReadinessResult {
  tradingReady: boolean;
  blockers: string[];
}

/**
 * The operator must explicitly set PAPER_WORKER_PAUSED="false" to unpause.
 * Missing, empty or malformed values remain paused across status and alarm paths.
 */
export function isPaperWorkerPaused(value: unknown): boolean {
  return value !== "false";
}

/**
 * System-level readiness only. Candidate-specific creator/cluster evidence,
 * exact quote economics and the durable entry/exit lifecycle remain enforced
 * independently at the point of each simulated trade.
 */
export function evaluateTradingReadiness(input: TradingReadinessInput): TradingReadinessResult {
  const blockers: string[] = [];
  if (!input || typeof input !== "object") {
    return { tradingReady: false, blockers: ["Trading readiness evidence is missing or invalid."] };
  }
  // Readiness is an authorization boundary: only exact booleans are evidence.
  // In particular, an unknown pause state is treated as paused.
  if (input.workerPaused !== false) blockers.push("Paper Worker is paused by operator configuration.");
  if (input.coordinatorEnabled !== true) blockers.push("Coordinator is stopped.");
  if (input.activeSession !== true) blockers.push("No active paper session.");
  if (input.discoveryConnected !== true || input.discoverySubscribed !== true) {
    blockers.push("PumpPortal discovery stream is not connected and subscribed.");
  }
  if (input.heliusConnected !== true || input.heliusApiKeyConfigured !== true) {
    blockers.push("Helius verified transaction stream is not connected.");
  }
  if (input.fullWalletHistoryEnabled !== true) {
    blockers.push("Full wallet transaction-history collection is not enabled.");
  }
  if (input.reviewedVolumeThresholdsAvailable !== true) {
    blockers.push("Reviewed chronological volume calibration is not configured.");
  }
  if (input.eventIngestConfigured !== true) blockers.push("PostgreSQL paper-event ingestion is not configured.");
  if (input.persistenceLeaseHeld !== true) blockers.push("Fenced PostgreSQL Worker lease is not held.");
  if (input.controlTokenConfigured !== true) blockers.push("Worker control token is not configured.");
  if (input.pumpProgramConfigured !== true) blockers.push("Pump program ID is not configured.");
  if (input.quoteSdkModulesAvailable !== true) blockers.push("Official Pump SDK quote modules are not available.");

  return { tradingReady: blockers.length === 0, blockers };
}
