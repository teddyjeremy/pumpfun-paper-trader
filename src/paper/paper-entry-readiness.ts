export interface PaperEntryReadinessInput {
  sessionEnabled: boolean;
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
  return input.sessionEnabled &&
    input.workerLeaseHeld &&
    input.postgresIngestConfigured &&
    input.strategyDecision === "BUY" &&
    input.buyAllowed &&
    input.executableQuoteAvailable &&
    input.hasBuyAndSellQuotes &&
    input.unsignedPlanAuthorized;
}
