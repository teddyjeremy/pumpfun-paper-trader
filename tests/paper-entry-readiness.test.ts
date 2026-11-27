import { describe, expect, it } from "vitest";
import { canCommitPaperEntry } from "../src/paper/paper-entry-readiness.js";

const ready = {
  systemTradingReady: true,
  sessionEnabled: true,
  workerLeaseHeld: true,
  postgresIngestConfigured: true,
  strategyDecision: "BUY" as const,
  buyAllowed: true,
  executableQuoteAvailable: true,
  hasBuyAndSellQuotes: true,
  unsignedPlanAuthorized: true
};

describe("paper entry persistence gate", () => {
  it("allows a simulated entry only when strategy, quotes, lease and durable ingestion are ready", () => {
    expect(canCommitPaperEntry(ready)).toBe(true);
  });

  it("rejects malformed or missing runtime booleans even when they are truthy", () => {
    const booleanFields = [
      "systemTradingReady", "sessionEnabled", "workerLeaseHeld", "postgresIngestConfigured",
      "buyAllowed", "executableQuoteAvailable", "hasBuyAndSellQuotes", "unsignedPlanAuthorized"
    ] as const;
    for (const field of booleanFields) {
      expect(canCommitPaperEntry({ ...ready, [field]: "false" } as unknown as typeof ready)).toBe(false);
      const missing = { ...ready } as Record<string, unknown>;
      delete missing[field];
      expect(canCommitPaperEntry(missing as unknown as typeof ready)).toBe(false);
    }
    expect(canCommitPaperEntry(null as unknown as typeof ready)).toBe(false);
  });

  it.each([
    ["system readiness prerequisites are incomplete", { systemTradingReady: false }],
    ["disabled session", { sessionEnabled: false }],
    ["missing Worker lease", { workerLeaseHeld: false }],
    ["missing PostgreSQL ingestion", { postgresIngestConfigured: false }],
    ["non-BUY decision", { strategyDecision: "WATCH" as const }],
    ["failed strict strategy audit", { buyAllowed: false }],
    ["stale or unavailable executable quote", { executableQuoteAvailable: false }],
    ["missing quote leg", { hasBuyAndSellQuotes: false }],
    ["unsigned plan not authorized after account, rent and payer checks", { unsignedPlanAuthorized: false }]
  ])("fails closed for %s", (_label, override) => {
    expect(canCommitPaperEntry({ ...ready, ...override })).toBe(false);
  });
});
