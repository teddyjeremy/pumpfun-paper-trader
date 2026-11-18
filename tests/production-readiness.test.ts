import { describe, expect, it } from "vitest";
import {
  evaluateProductionReadiness,
  type PersistentLifecycleSnapshot,
  type WorkerReadinessSnapshot
} from "../src/diagnostics/production-readiness.js";

const readyWorker: WorkerReadinessSnapshot = {
  configured: true,
  controlTokenConfigured: true,
  reachable: true,
  enabled: true,
  paused: false,
  tradingReady: true,
  blockers: []
};

const verifiedLedger: PersistentLifecycleSnapshot = {
  available: true,
  verifiedLifecycleCount: 1,
  reason: null
};

describe("production paper-trading readiness", () => {
  it("requires the deployed Worker to be enabled, unpaused and tradingReady", () => {
    const result = evaluateProductionReadiness({
      worker: { ...readyWorker, paused: true, enabled: false, tradingReady: false,
        blockers: ["Durable Object storage quota is exhausted."] },
      persistence: verifiedLedger
    });
    expect(result.ready).toBe(false);
    expect(result.tradingReady).toBe(false);
    expect(result.workerTradingReady).toBe(false);
    expect(result.blockers).toContain("Cloudflare Worker reports paused=true.");
    expect(result.blockers).toContain("Durable Object storage quota is exhausted.");
  });

  it("fails closed when the Worker cannot be authenticated or reached", () => {
    const result = evaluateProductionReadiness({
      worker: { ...readyWorker, controlTokenConfigured: false, reachable: false },
      persistence: verifiedLedger
    });
    expect(result.ready).toBe(false);
    expect(result.workerConnected).toBe(false);
  });

  it("requires a connected durable ledger", () => {
    const result = evaluateProductionReadiness({
      worker: readyWorker,
      persistence: { available: false, verifiedLifecycleCount: 0, reason: "Migration 0005 is missing." }
    });
    expect(result.ready).toBe(false);
    expect(result.persistenceAvailable).toBe(false);
    expect(result.blockers).toContain("Migration 0005 is missing.");
  });

  it("does not call the system ready before a complete closed entry/exit exists", () => {
    const result = evaluateProductionReadiness({
      worker: readyWorker,
      persistence: { available: true, verifiedLifecycleCount: 0, reason: null }
    });
    expect(result.ready).toBe(false);
    expect(result.lifecycleVerified).toBe(false);
    expect(result.blockers).toContain("No complete closed paper entry/exit lifecycle is verified in the persistent journal.");
  });

  it("reports ready only when Worker readiness and a durable lifecycle are both verified", () => {
    const result = evaluateProductionReadiness({ worker: readyWorker, persistence: verifiedLedger });
    expect(result).toMatchObject({
      ready: true,
      tradingReady: true,
      workerConnected: true,
      workerTradingReady: true,
      persistenceAvailable: true,
      lifecycleVerified: true,
      verifiedLifecycleCount: 1,
      blockers: []
    });
  });
});
