export interface PaperEntryReadinessInput {
  sessionEnabled: boolean;
  systemTradingReady: boolean;
  workerLeaseHeld: boolean;
  postgresIngestConfigured: boolean;
  strategyDecision: "BUY" | "WATCH" | "REJECT";
  buyAllowed: boolean;
  executableQuoteAvailable: boolean;
  hasBuyAndSellQuotes: boolean;
  unsignedPlanAuthorized: boolean;
}

/**
 * A paper entry must never be committed to ephemeral Durable Object state
 * without the durable Neon event outbox path and an active fenced lease.
 * This is an additional persistence gate, not a replacement for the complete
 * 15-rule strategy audit or account/quote prerequisites.
 */
export function canCommitPaperEntry(input: PaperEntryReadinessInput): boolean {
  if (!input || typeof input !== "object") return false;
  return input.systemTradingReady === true &&
    input.sessionEnabled === true &&
    input.workerLeaseHeld === true &&
    input.postgresIngestConfigured === true &&
    input.strategyDecision === "BUY" &&
    input.buyAllowed === true &&
    input.executableQuoteAvailable === true &&
    input.hasBuyAndSellQuotes === true &&
    input.unsignedPlanAuthorized === true;
}
