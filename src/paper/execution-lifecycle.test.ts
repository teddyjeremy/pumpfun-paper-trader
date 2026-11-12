import { describe, expect, it, vi } from "vitest";
import {
  executePaperEntry,
  type PaperEntryExecutionInput,
  type PaperEntryStrategyDecision
} from "./execution-lifecycle.js";
import type { PaperPortfolioState } from "./portfolio.js";

const completeRules: PaperEntryStrategyDecision["rules"] = [
  "CANDIDATE_AGE", "IMPULSE", "PULLBACK", "RECLAIM", "THREE_FLOW_WINDOWS",
  "DISTINCT_BUYERS", "BUYER_CONCENTRATION", "CREATOR_SELL_RISK", "WALLET_CLUSTER_RISK",
  "ATTRIBUTION_CONFIDENCE", "PULLBACK_VOLUME_CONTRACTION", "RECLAIM_VOLUME_EXPANSION",
  "SIGNAL_FRESHNESS", "EXECUTABLE_QUOTE", "ROUND_TRIP_COST"
].map(rule => ({ rule, status: "PASS" }));

function inputWithRules(rules: PaperEntryStrategyDecision["rules"]): PaperEntryExecutionInput {
  return {
    mint: "mint-under-test",
    positionId: "position-under-test",
    occurredAt: "2026-11-12T00:00:00.000Z",
    nowMs: Date.parse("2026-11-12T00:00:00.000Z"),
    strategy: { decision: "BUY", buyAllowed: true, rules },
    portfolio: {} as PaperPortfolioState,
    quoteBuy: vi.fn(),
    quoteSell: vi.fn(),
    commitEntry: vi.fn()
  };
}

describe("executePaperEntry mandatory rule contract", () => {
  it("blocks a partial list even when every supplied rule passes", async () => {
    const input = inputWithRules([{ rule: "IMPULSE", status: "PASS" }]);
    const result = await executePaperEntry(input);
    expect(result.status).toBe("BLOCKED");
    expect(input.quoteBuy).not.toHaveBeenCalled();
  });

  it("blocks a missing mandatory rule", async () => {
    const input = inputWithRules(completeRules.slice(1));
    const result = await executePaperEntry(input);
    expect(result.status).toBe("BLOCKED");
    expect(input.quoteBuy).not.toHaveBeenCalled();
  });

  it("blocks duplicate and unrecognized rule identifiers", async () => {
    const duplicate = [...completeRules.slice(1), completeRules[0]!, completeRules[0]!];
    const duplicateResult = await executePaperEntry(inputWithRules(duplicate));
    expect(duplicateResult.status).toBe("BLOCKED");

    const unrecognized = [
      ...completeRules.slice(0, -1),
      { rule: "UNRECOGNIZED", status: "PASS" as const }
    ];
    const unrecognizedResult = await executePaperEntry(inputWithRules(unrecognized));
    expect(unrecognizedResult.status).toBe("BLOCKED");
  });

  it("blocks UNKNOWN and FAIL rules", async () => {
    const unknown = completeRules.map(rule =>
      rule.rule === "EXECUTABLE_QUOTE" ? { ...rule, status: "UNKNOWN" as const } : rule
    );
    const failed = completeRules.map(rule =>
      rule.rule === "ROUND_TRIP_COST" ? { ...rule, status: "FAIL" as const } : rule
    );
    expect((await executePaperEntry(inputWithRules(unknown))).status).toBe("BLOCKED");
    expect((await executePaperEntry(inputWithRules(failed))).status).toBe("BLOCKED");
  });
});
