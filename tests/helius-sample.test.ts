import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIGHT_SNIPE, parseSampleCsv, simulateSampleToken, summarizeSample } from "../src/strategy/helius-sample.js";

const cost = { solUsd: 73.5, venueFeeBps: 125, slippageFloorBps: 30, feeLamportsPerTx: 15_000, rentLamports: 1_488_440 };

describe("Helius sample backtest", () => {
  const tokens = parseSampleCsv(readFileSync("data/helius/tokens.csv", "utf8"));
  const valid = tokens.filter(token => token.launchDate >= "2026-11-14");
  const train = tokens.filter(token => token.launchDate < "2026-11-14");

  it("keeps the 1-minute snipe positive on the held-out day after fees", () => {
    const trades = valid.flatMap(token => {
      const trade = simulateSampleToken(token, LIGHT_SNIPE, 1, cost);
      return trade ? [trade] : [];
    });
    const stats = summarizeSample(trades);
    expect(tokens.length).toBe(746);
    expect(stats.trades).toBe(77);
    expect(stats.expectancyUsd).toBeGreaterThan(0.05);
    expect(stats.winRate).toBeGreaterThan(0.35);
    expect(stats.winRate).toBeLessThan(0.5);
  });

  it("keeps the candle-path candidate research-only when the expanded risk replay clears no mints", () => {
    const chosen = JSON.parse(readFileSync("data/helius/chosen-strategy.json", "utf8")) as {
      researchOnly?: boolean;
      authorizedForPaperTrading?: boolean;
      profitabilityEvidence?: string;
      riskAudit?: { status?: string; riskClearedCandidates?: number };
      sizing?: Record<string, number>;
    };
    expect(chosen.researchOnly).toBe(true);
    expect(chosen.authorizedForPaperTrading).toBe(false);
    expect(chosen.profitabilityEvidence).toBe("CANDLE_PATH_ONLY_NOT_RISK_CLEARED");
    expect(chosen.riskAudit).toMatchObject({ status: "NO_ELIGIBLE_TRADES", riskClearedCandidates: 0 });
    expect(chosen.sizing).toMatchObject({
      startingEquityUsd: 2.7,
      stakeUsd: 1,
      maxConcurrent: 1,
      initialConcurrentPositions: 1,
      stakeIncreaseMultiplier: 1.5,
      maxStakeUsd: 100
    });
  });

  it("is also positive on the earlier days", () => {
    const trades = train.flatMap(token => {
      const trade = simulateSampleToken(token, LIGHT_SNIPE, 1, cost);
      return trade ? [trade] : [];
    });
    expect(summarizeSample(trades).expectancyUsd).toBeGreaterThan(0.05);
    expect(trades.length).toBe(57);
  });
});
