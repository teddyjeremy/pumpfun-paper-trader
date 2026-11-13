import { describe, expect, it } from "vitest";
import { canCommitPaperEntry } from "../src/paper/paper-entry-readiness.js";

const ready = {
  sessionEnabled: true,
  workerLeaseHeld: true,
  postgresIngestConfigured: true,
  strategyDecision: "BUY" as const,
  buyAllowed: true,
  executableQuoteAvailable: true,
  hasBuyAndSellQuotes: true
};

describe("paper entry persistence gate", () => {
  it("allows a simulated entry only when strategy, quotes, lease and durable ingestion are ready", () => {
    expect(canCommitPaperEntry(ready)).toBe(true);
  });

  it.each([
    ["disabled session", { sessionEnabled: false }],
    ["missing Worker lease", { workerLeaseHeld: false }],
    ["missing PostgreSQL ingestion", { postgresIngestConfigured: false }],
    ["non-BUY decision", { strategyDecision: "WATCH" as const }],
    ["failed strict strategy audit", { buyAllowed: false }],
    ["stale or unavailable executable quote", { executableQuoteAvailable: false }],
    ["missing quote leg", { hasBuyAndSellQuotes: false }]
  ])("fails closed for %s", (_label, override) => {
    expect(canCommitPaperEntry({ ...ready, ...override })).toBe(false);
  });
});
