import { describe, expect, it } from "vitest";
import {
  trackDecision, trackGraduation, trackLatency, trackPosition,
  trackProvider, trackQuote, trackRisk, trackingSnapshot, trackStage
} from "../src/diagnostics/tracker.js";

describe("end-to-end observability tracker", () => {
  it("tracks candidate funnel and rejection reasons", () => {
    trackStage("MintTestA", "discovered", { strategyVersion: "test-v1" });
    trackRisk("MintTestA", 75, ["creator_risk"]);
    const state = trackingSnapshot();
    expect(state.funnel.discovered).toBeGreaterThan(0);
    expect(state.decisions.rejectionReasons.some(x => x.reason === "creator_risk")).toBe(true);
  });

  it("tracks quote outcomes, provider reconnects and graduation", () => {
    trackQuote("success", { mint: "MintTestB", roundTripCostPct: 3.2, quoteAgeMs: 40 });
    trackQuote("stale", { mint: "MintTestB", quoteAgeMs: 900 });
    trackProvider("reconnected", 2);
    trackGraduation("MintTestB", "curve_unavailable");
    const state = trackingSnapshot();
    expect(state.quotes.success).toBeGreaterThan(0);
    expect(state.quotes.stale).toBeGreaterThan(0);
    expect(state.provider.reconnects).toBeGreaterThan(0);
    expect(state.graduation.curveUnavailable).toBeGreaterThan(0);
  });

  it("reports latency percentiles and flags unsafe slot release", () => {
    trackLatency("buy_quote", 20);
    trackLatency("buy_quote", 50);
    trackPosition({
      mint: "MintTestC", state: "closed", openedAt: new Date().toISOString(),
      closedAt: new Date().toISOString(), entryCostUsd: 1, exitValueUsd: 1.1,
      feesUsd: 0.03, realizedNetPnlUsd: 0.07, exitReason: "test",
      tokenBalanceZeroConfirmed: false
    });
    const state = trackingSnapshot();
    expect(state.latency.buyQuote.samples).toBeGreaterThanOrEqual(2);
    expect(state.positions.invariantViolations).toBeGreaterThan(0);
  });

  it("records paper entry and exit funnel stages", () => {
    trackDecision("MintTestD", "paper_entry", []);
    trackDecision("MintTestD", "paper_exit", []);
    const state = trackingSnapshot();
    expect(state.funnel.entered).toBeGreaterThan(0);
    expect(state.funnel.exited).toBeGreaterThan(0);
  });
});
