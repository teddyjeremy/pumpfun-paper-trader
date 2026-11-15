import { describe, expect, it } from "vitest";
import { evaluateTradingReadiness, type TradingReadinessInput } from "../src/paper/trading-readiness.js";

const ready: TradingReadinessInput = {
  workerPaused: false,
  coordinatorEnabled: true,
  activeSession: true,
  discoveryConnected: true,
  discoverySubscribed: true,
  heliusConnected: true,
  heliusApiKeyConfigured: true,
  fullWalletHistoryEnabled: true,
  reviewedVolumeThresholdsAvailable: true,
  eventIngestConfigured: true,
  persistenceLeaseHeld: true,
  controlTokenConfigured: true,
  pumpProgramConfigured: true,
  quoteSdkModulesAvailable: true
};

describe("system-level paper trading readiness", () => {
  it("never reports ready while the operator pause switch is active", () => {
    const result = evaluateTradingReadiness({ ...ready, workerPaused: true });
    expect(result.tradingReady).toBe(false);
    expect(result.blockers).toContain("Paper Worker is paused by operator configuration.");
  });

  it("reports ready only when every infrastructure prerequisite is present", () => {
    expect(evaluateTradingReadiness(ready)).toEqual({ tradingReady: true, blockers: [] });
  });

  it("remains blocked when the coordinator or either live stream is not ready", () => {
    const result = evaluateTradingReadiness({
      ...ready, coordinatorEnabled: false, activeSession: false,
      discoveryConnected: false, discoverySubscribed: false, heliusConnected: false
    });
    expect(result.tradingReady).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      "Coordinator is stopped.",
      "No active paper session.",
      "PumpPortal discovery stream is not connected and subscribed.",
      "Helius verified transaction stream is not connected."
    ]));
  });

  it("requires complete wallet history and explicitly reviewed chronological calibration", () => {
    const result = evaluateTradingReadiness({
      ...ready, fullWalletHistoryEnabled: false, reviewedVolumeThresholdsAvailable: false
    });
    expect(result.tradingReady).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      "Full wallet transaction-history collection is not enabled.",
      "Reviewed chronological volume calibration is not configured."
    ]));
  });

  it("requires configured event ingestion, a fenced lease, control and program configuration", () => {
    const result = evaluateTradingReadiness({
      ...ready, eventIngestConfigured: false, persistenceLeaseHeld: false,
      controlTokenConfigured: false, pumpProgramConfigured: false, quoteSdkModulesAvailable: false
    });
    expect(result.tradingReady).toBe(false);
    expect(result.blockers).toHaveLength(5);
  });
});
