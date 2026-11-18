export interface WorkerReadinessSnapshot {
  configured: boolean;
  controlTokenConfigured: boolean;
  reachable: boolean;
  enabled: boolean;
  paused: boolean;
  tradingReady: boolean;
  blockers: string[];
}

export interface PersistentLifecycleSnapshot {
  available: boolean;
  verifiedLifecycleCount: number;
  reason: string | null;
}

export interface ProductionReadiness {
  ready: boolean;
  tradingReady: boolean;
  workerConnected: boolean;
  workerTradingReady: boolean;
  persistenceAvailable: boolean;
  lifecycleVerified: boolean;
  verifiedLifecycleCount: number;
  blockers: string[];
}

/**
 * Dashboard readiness is intentionally stricter than service liveness.
 * It is true only when the deployed Worker itself reports tradingReady=true
 * and the durable ledger contains a complete, closed BUY/SELL lifecycle.
 */
export function evaluateProductionReadiness(input: {
  worker: WorkerReadinessSnapshot;
  persistence: PersistentLifecycleSnapshot;
}): ProductionReadiness {
  const blockers: string[] = [];
  const worker = input.worker;
  const persistence = input.persistence;
  const workerConnected = worker.configured && worker.controlTokenConfigured && worker.reachable;
  const workerTradingReady = workerConnected && worker.enabled && !worker.paused && worker.tradingReady;

  if (!worker.configured) {
    blockers.push("PAPER_WORKER_URL is not configured.");
  } else if (!worker.controlTokenConfigured) {
    blockers.push("A valid PAPER_WORKER_CONTROL_TOKEN is required to verify Worker trading readiness.");
  } else if (!worker.reachable) {
    blockers.push("Cloudflare Worker dashboard status is unreachable.");
  } else {
    if (worker.paused) blockers.push("Cloudflare Worker reports paused=true.");
    if (!worker.enabled) blockers.push("Cloudflare Worker reports enabled=false.");
    if (!worker.tradingReady) blockers.push("Cloudflare Worker reports tradingReady=false.");
    for (const reason of worker.blockers) {
      const normalized = reason.trim();
      if (normalized && !blockers.includes(normalized)) blockers.push(normalized);
    }
  }

  if (!persistence.available) {
    blockers.push(persistence.reason?.trim() || "Persistent paper ledger is unavailable.");
  } else if (persistence.verifiedLifecycleCount < 1) {
    blockers.push("No complete closed paper entry/exit lifecycle is verified in the persistent journal.");
  }

  const lifecycleVerified = persistence.available && persistence.verifiedLifecycleCount > 0;
  const ready = blockers.length === 0 && workerTradingReady && lifecycleVerified;
  return {
    ready,
    tradingReady: ready,
    workerConnected,
    workerTradingReady,
    persistenceAvailable: persistence.available,
    lifecycleVerified,
    verifiedLifecycleCount: persistence.verifiedLifecycleCount,
    blockers
  };
}
