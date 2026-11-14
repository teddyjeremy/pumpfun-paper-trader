import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  hydrateArchivedVerifiedTransaction, replayHistoricalCoin
} from "../src/strategy/historical-replay.js";
import { simulateHistoricalProfitability } from "../src/strategy/historical-profitability.js";

function option(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}
function percent(name: string, fallback: number, maximum: number): number {
  const value = Number(option(name, String(fallback)));
  if (!Number.isFinite(value) || value < 0 || value > maximum) {
    throw new Error(`--${name} must be between 0 and ${maximum}.`);
  }
  return value;
}
const date = option("date", "");
const roundTripCostPct = percent("round-trip-cost-pct", 4, 4);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Pass --date=YYYY-MM-DD.");
const artifacts = resolve("artifacts");
const summary = JSON.parse(await readFile(resolve(artifacts, `batch-summary-${date}.json`), "utf8")) as {
  date: string; solUsdReference?: { priceUsd?: number }; selectedLaunchIndexes?: number[];
};
if (summary.date !== date || !Number.isFinite(summary.solUsdReference?.priceUsd) ||
    !Array.isArray(summary.selectedLaunchIndexes)) {
  throw new Error("A matching batch summary with its historical SOL/USD reference is required.");
}
const coinDirectory = resolve(artifacts, "coins");
const dayStart = Math.floor(Date.parse(`${date}T00:00:00+03:00`) / 1_000);
const dayEnd = dayStart + 86_400;
const files = (await readdir(coinDirectory)).filter(name => name.endsWith(".json"));
const results: Array<Record<string, unknown>> = [];
for (const file of files) {
  const raw = JSON.parse(await readFile(resolve(coinDirectory, file), "utf8")) as Record<string, unknown>;
  const mint = String(raw.mint ?? "");
  const launch = raw.launch as Record<string, unknown> | undefined;
  const launchBlockTime = Number(launch?.blockTime ?? raw.launchBlockTime);
  const collection = raw.collection as Record<string, unknown> | undefined;
  if (!summary.selectedLaunchIndexes.includes(Number(raw.index)) || collection?.status !== "COMPLETE" ||
      !Array.isArray(raw.transactions) || !Number.isSafeInteger(launchBlockTime) ||
      launchBlockTime < dayStart || launchBlockTime >= dayEnd) continue;
  // These files are emitted only by the Helius historical collector. Add the archive provenance marker required by the strict hydrator at this trusted artifact boundary.
  const transactions = raw.transactions.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Malformed archived transaction in ${file}.`);
    return hydrateArchivedVerifiedTransaction({ ...(value as Record<string, unknown>), source: "HISTORICAL_BACKFILL" });
  });
  const replay = replayHistoricalCoin({
    mint, transactions, launchBlockTime, horizonSeconds: 600, decodeComplete: true
  }, {
    solUsdPriceUsd: summary.solUsdReference!.priceUsd!, minimumTradeUsd: 0.01, horizonSeconds: 600
  });
  const outcome = replay.outcome;
  const profitability = outcome && replay.firstSetup
    ? simulateHistoricalProfitability({
        mint, transactions, entryAt: outcome.entryAt,
        entryPriceQuotePerToken: outcome.entryPriceQuotePerToken,
        horizonSeconds: 600, roundTripCostPct,
        riskCleared: replay.firstSetup.riskClearedSetupEligible
      })
    : null;
  results.push({
    mint, index: raw.index, replayStatus: replay.status,
    entrySignal: replay.firstSetup ? {
      evaluatedAt: replay.firstSetup.evaluatedAt,
      setupEligible: replay.firstSetup.setupEligible,
      riskClearedSetupEligible: replay.firstSetup.riskClearedSetupEligible,
      creatorSellRiskStatus: replay.firstSetup.creatorSellRiskStatus,
      walletClusterRiskStatus: replay.firstSetup.walletClusterRiskStatus
    } : null,
    profitability
  });
}
const simulations = results.map(row => row.profitability as Record<string, unknown> | null).filter(Boolean) as Record<string, unknown>[];
const closed = simulations.filter(row => row.status === "CLOSED_BY_STRATEGY");
const open = simulations.filter(row => row.status === "OPEN_AT_HORIZON");
const netReturns = simulations.map(row => Number(row.modeledNetReturnPct)).filter(Number.isFinite);
const wins = netReturns.filter(value => value > 0).length;
const losses = netReturns.filter(value => value < 0).length;
const grossWins = netReturns.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
const grossLosses = Math.abs(netReturns.filter(value => value < 0).reduce((sum, value) => sum + value, 0));
const report = {
  date, strategyVersion: "strict-v1-market-pattern-plus-dynamic-exits",
  sourceCoinCount: results.length, simulatedCandidates: simulations.length,
  closedByStrategy: closed.length, openAtHorizon: open.length,
  riskClearedCandidates: simulations.filter(row => row.riskEvidence === "CLEARED").length,
  riskUnverifiedCandidates: simulations.filter(row => row.riskEvidence === "UNVERIFIED").length,
  roundTripCostAssumptionPct: roundTripCostPct,
  modeledNetReturnPct: netReturns.reduce((sum, value) => sum + value, 0),
  winRate: netReturns.length ? wins / netReturns.length : null,
  wins, losses, breakeven: netReturns.length - wins - losses,
  expectancyPctPerCandidate: netReturns.length ? netReturns.reduce((sum, value) => sum + value, 0) / netReturns.length : null,
  profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? null : 0,
  results,
  limitations: [
    "This is a reserve-price path simulation, not a historical executable-quote backtest.",
    "A 4% maximum round-trip cost is modeled as a symmetric haircut; actual per-trade network, priority, provider, rent and venue costs are not present in the historical artifacts.",
    "Wallet/holder evidence is not complete in these artifacts. Risk-unverified candidates are research-only and must not be treated as strategy-approved trades.",
    "Positions still open at the end of the 10-minute observation horizon are marked, not realized exits.",
    "The sample is activity-ranked and is not representative of all launches."
  ]
};
const outputPath = resolve(artifacts, `pump-profitability-backtest-${date}.json`);
await mkdir(artifacts, { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
process.stdout.write(JSON.stringify({
  date, sourceCoinCount: report.sourceCoinCount, simulatedCandidates: report.simulatedCandidates,
  closedByStrategy: report.closedByStrategy, openAtHorizon: report.openAtHorizon,
  riskClearedCandidates: report.riskClearedCandidates,
  riskUnverifiedCandidates: report.riskUnverifiedCandidates,
  winRate: report.winRate, expectancyPctPerCandidate: report.expectancyPctPerCandidate,
  profitFactor: report.profitFactor, artifact: outputPath
}, null, 2) + "\n");
