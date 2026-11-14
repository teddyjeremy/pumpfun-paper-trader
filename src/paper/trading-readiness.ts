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
 * System-level readiness only. Candidate-specific creator/cluster evidence,
 * exact quote economics and the durable entry/exit lifecycle remain enforced
 * independently at the point of each simulated trade.
 */
export function evaluateTradingReadiness(input: TradingReadinessInput): TradingReadinessResult {
  const blockers: string[] = [];
  if (input.workerPaused) blockers.push("Paper Worker is paused by operator configuration.");
  if (!input.coordinatorEnabled) blockers.push("Coordinator is stopped.");
  if (!input.activeSession) blockers.push("No active paper session.");
  if (!input.discoveryConnected || !input.discoverySubscribed) {
    blockers.push("PumpPortal discovery stream is not connected and subscribed.");
  }
  if (!input.heliusConnected || !input.heliusApiKeyConfigured) {
    blockers.push("Helius verified transaction stream is not connected.");
  }
  if (!input.fullWalletHistoryEnabled) {
    blockers.push("Full wallet transaction-history collection is not enabled.");
  }
  if (!input.reviewedVolumeThresholdsAvailable) {
    blockers.push("Reviewed chronological volume calibration is not configured.");
  }
  if (!input.eventIngestConfigured) blockers.push("PostgreSQL paper-event ingestion is not configured.");
  if (!input.persistenceLeaseHeld) blockers.push("Fenced PostgreSQL Worker lease is not held.");
  if (!input.controlTokenConfigured) blockers.push("Worker control token is not configured.");
  if (!input.pumpProgramConfigured) blockers.push("Pump program ID is not configured.");
  if (!input.quoteSdkModulesAvailable) blockers.push("Official Pump SDK quote modules are not available.");

  return { tradingReady: blockers.length === 0, blockers };
}
