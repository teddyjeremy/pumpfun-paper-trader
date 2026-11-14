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
        riskStatus: replay.firstSetup.creatorSellRiskStatus === "REJECT_OBSERVED" || replay.firstSetup.walletClusterRiskStatus === "REJECT_OBSERVED"
          ? "REJECTED"
          : replay.firstSetup.riskClearedSetupEligible ? "CLEARED" : "UNKNOWN"
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
const strictEligible = simulations.filter(row => row.riskEvidence === "CLEARED");
const researchOnly = simulations.filter(row => row.riskEvidence !== "CLEARED");
const strictReturns = strictEligible.map(row => Number(row.modeledNetReturnPct)).filter(Number.isFinite);
const researchReturns = researchOnly.map(row => Number(row.modeledNetReturnPct)).filter(Number.isFinite);
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function simulatePortfolio(rows: Array<Record<string, unknown>>) {
  const startingBankrollUsd = 2.70;
  const initialStakeUsd = 1;
  const topUpUsd = 2.70;
  const topUpBelowUsd = 1;
  let cash = startingBankrollUsd;
  let topUps = 0;
  let realizedPnlUsd = 0;
  let highWaterGrowthEquityUsd = startingBankrollUsd;
  let maximumConcurrentSlotsAvailable = 1;
  let maxOpenPositionsObserved = 0;
  let skippedForCapacity = 0;
  let skippedForCash = 0;
  let tradesEntered = 0;
  const open: Array<{ entryAt: number; exitAt: number | null; stakeUsd: number; netReturnPct: number }> = [];
  const equityPoints: number[] = [startingBankrollUsd];
  const ordered = rows.filter(row => row.riskEvidence === "CLEARED")
    .sort((a, b) => Number(a.entryAt) - Number(b.entryAt));
  const markEquity = () => cash + open.reduce((sum, position) =>
    sum + position.stakeUsd * (1 + position.netReturnPct / 100), 0);
  const closeDue = (at: number) => {
    for (let i = open.length - 1; i >= 0; i -= 1) {
      const position = open[i]!;
      if (position.exitAt === null || position.exitAt > at) continue;
      const pnl = position.stakeUsd * position.netReturnPct / 100;
      cash += position.stakeUsd + pnl;
      realizedPnlUsd += pnl;
      open.splice(i, 1);
      equityPoints.push(cash + open.reduce((sum, item) => sum + item.stakeUsd, 0));
    }
  };
  for (const row of ordered) {
    const entryAt = Number(row.entryAt);
    const exitAt = row.exitAt === null ? null : Number(row.exitAt);
    const netReturnPct = Number(row.modeledNetReturnPct);
    if (!Number.isSafeInteger(entryAt) || !Number.isFinite(netReturnPct)) continue;
    closeDue(entryAt);
    const growthEquity = Math.max(0, cash + open.reduce((sum, p) => sum + p.stakeUsd, 0) - topUps);
    highWaterGrowthEquityUsd = Math.max(highWaterGrowthEquityUsd, growthEquity);
    const levels = highWaterGrowthEquityUsd < 5 ? 0
      : 1 + Math.floor(Math.log2(highWaterGrowthEquityUsd / 5));
    const stakeUsd = Math.min(100, initialStakeUsd * Math.pow(1.5, levels));
    const maxPositions = Math.min(100, 1 + levels);
    maximumConcurrentSlotsAvailable = Math.max(maximumConcurrentSlotsAvailable, maxPositions);
    if (open.length >= maxPositions) { skippedForCapacity += 1; continue; }
    const preEntryEquity = cash + open.reduce((sum, item) => sum + item.stakeUsd, 0);
    if (preEntryEquity < topUpBelowUsd) {
      cash += topUpUsd;
      topUps += topUpUsd;
    }
    if (cash < stakeUsd) { skippedForCash += 1; continue; }
    cash -= stakeUsd;
    open.push({ entryAt, exitAt, stakeUsd, netReturnPct });
    tradesEntered += 1;
    maxOpenPositionsObserved = Math.max(maxOpenPositionsObserved, open.length);
    equityPoints.push(cash + open.reduce((sum, item) => sum + item.stakeUsd, 0));
  }
  closeDue(Number.MAX_SAFE_INTEGER);
  const endingEquityUsd = markEquity();
  equityPoints.push(endingEquityUsd);
  const unrealizedPnlUsd = open.reduce((sum, position) =>
    sum + position.stakeUsd * position.netReturnPct / 100, 0);
  let peak = startingBankrollUsd;
  let maxDrawdownPct = 0;
  for (const equity of equityPoints) {
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak * 100);
  }
  return {
    startingBankrollUsd, endingEquityUsd,
    totalCapitalTopUpsUsd: topUps,
    netTradingPnlUsd: realizedPnlUsd + unrealizedPnlUsd,
    realizedPnlUsd, unrealizedPnlUsd,
    tradesEntered,
    openPositionsAtEnd: open.length,
    maxConcurrentSlotsAvailable: maximumConcurrentSlotsAvailable,
    maxOpenPositionsObserved,
    skippedForCapacity, skippedForCash, maxDrawdownPct,
    stakePolicy: "Starts at $1; increases 50% at each doubling from $5 growth equity; maximum $100. Concurrent slots increase by one at each doubling.",
    note: "Only risk-cleared candidate rows are admitted. Open-at-horizon positions are marked, not realized. This portfolio ledger inherits the reserve-price proxy and modeled-cost limitations of each trade."
  };
}

const portfolioCandidates = simulations.map(row => ({
  ...row,
  entryAt: Number(row.entryAt),
  exitAt: row.exitAt === null ? null : Number(row.exitAt)
}));
const portfolioSimulation = simulatePortfolio(portfolioCandidates);
const report = {
  date, strategyVersion: "strict-v1-market-pattern-plus-dynamic-exits",
  strategyParameters: {
    entry: {
      minimumImpulsePct: 20, pullbackRangePct: [10, 40],
      minimumReclaimAbovePreviousFiveSecondHighPct: 1,
      flowWindowSeconds: 2, requiredConsecutiveFlowWindows: 3,
      minimumDistinctBuyersAcrossLatestThreeWindows: 5,
      maximumLargestBuyerSharePct: 72, minimumTradeUsd: 0.01
    },
    risk: {
      creatorSellRiskMustPass: true, completeWalletHistoryRequired: true,
      completeHolderCensusRequired: true,
      historicalExecutableEntryQuoteRequired: true
    },
    exit: {
      hardStopNetReturnPct: -5, trailingActivationNetReturnPct: 10,
      trailingGivebackPct: 40,
      profitLocks: [{ triggerPct: 10, floorPct: 5 }, { triggerPct: 50, floorPct: 15 },
        { triggerPct: 100, floorPct: 40 }, { triggerPct: 200, floorPct: 80 }],
      dynamicConfirmationWindows: 2, minimumBearishSignalsPerWindow: 2,
      buySellRatioBelow: 1, buyVolumeDeclinePct: 40, buyerRateDeclinePct: 40,
      sellVolumeExpansionPct: 50, priceResponseDeclinePct: 40, liquidityDropPct: 20,
      evaluatedWindowSeconds: [2, 5, 10, 30]
    }
  },
  sourceCoinCount: results.length, pricePathCandidates: simulations.length,
  proxyExitTriggers: closed.length, proxyOpenAtHorizon: open.length,
  riskClearedCandidates: strictEligible.length,
  riskRejectedCandidates: simulations.filter(row => row.riskEvidence === "REJECTED").length,
  riskUnverifiedCandidates: simulations.filter(row => row.riskEvidence === "UNVERIFIED").length,
  strictStrategy: {
    status: strictReturns.length === 0 ? "NO_ELIGIBLE_TRADES" : "RESERVE_PRICE_PROXY_ONLY",
    executionGrade: "NOT_ESTABLISHED_WITHOUT_HISTORICAL_FULL_SIZE_QUOTES_AND_FEES",
    trades: strictReturns.length,
    modeledNetReturnPct: sum(strictReturns),
    modeledPnlUsdAtOneDollarStake: sum(strictReturns) / 100,
    winRate: strictReturns.length ? strictReturns.filter(value => value > 0).length / strictReturns.length : null,
    profitFactor: strictReturns.length === 0 ? null : (() => { const wins = sum(strictReturns.filter(value => value > 0)); const losses = Math.abs(sum(strictReturns.filter(value => value < 0))); return losses > 0 ? wins / losses : wins > 0 ? null : 0; })()
  },
  researchOnly: {
    trades: researchReturns.length,
    modeledNetReturnPct: sum(researchReturns),
    modeledPnlUsdAtOneDollarStake: sum(researchReturns) / 100,
    winRate: researchReturns.length ? researchReturns.filter(value => value > 0).length / researchReturns.length : null,
    expectancyPctPerCandidate: researchReturns.length ? sum(researchReturns) / researchReturns.length : null,
    profitFactor: researchReturns.length === 0 ? null : (() => { const wins = sum(researchReturns.filter(value => value > 0)); const losses = Math.abs(sum(researchReturns.filter(value => value < 0))); return losses > 0 ? wins / losses : wins > 0 ? null : 0; })()
  },
  portfolioSimulation,
  roundTripCostAssumptionPct: roundTripCostPct,
  allProxyModeledNetReturnPct: sum(netReturns),
  allProxyWinRate: netReturns.length ? wins / netReturns.length : null,
  allProxyWins: wins, allProxyLosses: losses, allProxyBreakeven: netReturns.length - wins - losses,
  allProxyExpectancyPctPerCandidate: netReturns.length ? sum(netReturns) / netReturns.length : null,
  allProxyProfitFactor: netReturns.length === 0 ? null : grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? null : 0,
  results,
  limitations: [
    "This is a reserve-price path simulation, not a historical executable-quote backtest.",
    "A 4% maximum round-trip cost is modeled as a symmetric haircut; actual per-trade network, priority, provider, rent and venue costs are not present in the historical artifacts.",
    "Wallet/holder evidence is not complete in these artifacts. Observed creator/cluster risk rejects and unknown risk are excluded from strict strategy PnL; their price-path results are research-only.",
    "Positions still open at the end of the 10-minute observation horizon are marked, not realized exits.",
    "The sample is activity-ranked and is not representative of all launches."
  ]
};
const outputPath = resolve(artifacts, `pump-profitability-backtest-${date}.json`);
await mkdir(artifacts, { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
process.stdout.write(JSON.stringify({
  date, sourceCoinCount: report.sourceCoinCount, pricePathCandidates: report.pricePathCandidates,
  proxyExitTriggers: report.proxyExitTriggers, proxyOpenAtHorizon: report.proxyOpenAtHorizon,
  riskClearedCandidates: report.riskClearedCandidates,
  riskUnverifiedCandidates: report.riskUnverifiedCandidates,
  allProxyWinRate: report.allProxyWinRate, allProxyExpectancyPctPerCandidate: report.allProxyExpectancyPctPerCandidate,
  allProxyProfitFactor: report.allProxyProfitFactor, artifact: outputPath
}, null, 2) + "\n");
