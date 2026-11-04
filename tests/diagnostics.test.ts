import { beforeEach, describe, expect, it } from "vitest";
import { diagnose, increment, recordFailure, setReadinessBlocker, snapshot } from "../src/diagnostics/registry.js";

describe("diagnostics registry", () => {
  beforeEach(() => {
    // Registry is process-scoped; tests assert monotonic behavior without resetting production state.
  });

  it("records categorized failures with actionable guidance", () => {
    recordFailure({ category: "quote_missing", code: "NO_CURVE_ACCOUNT", message: "Curve account was not returned", retryable: true });
    const state = snapshot();
    expect(state.counters["failure.quote_missing"]).toBeGreaterThan(0);
    expect(state.failures[0]?.code).toBe("NO_CURVE_ACCOUNT");
    expect(diagnose().topFailures.some(x => x.category === "quote_missing")).toBe(true);
  });

  it("tracks operational counters", () => {
    increment("candidate.discovered");
    expect(snapshot().counters["candidate.discovered"]).toBeGreaterThan(0);
  });

  it("does not report ready while blockers remain", () => {
    setReadinessBlocker("unit test blocker", true);
    expect(snapshot().readiness.ready).toBe(false);
    setReadinessBlocker("unit test blocker", false);
  });
});
