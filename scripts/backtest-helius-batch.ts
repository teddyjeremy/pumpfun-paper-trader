import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { collectHistoricalLaunchWindow } from "../src/ingestion/helius-launch-window.js";
import { replayHistoricalCoin } from "../src/strategy/historical-replay.js";
import { fetchSolUsdPrice } from "../src/ingestion/sol-usd-price.js";
import type { HistoricalLaunchActivityScreenResult } from "../src/ingestion/helius-launch-screen.js";
import { isSolQuoteMint } from "../src/ingestion/trade-flow.js";

type Launch = {
  signature: string; slot: number; blockTime: number;
  event: { mint: string; bondingCurve: string; timestamp: string };
};
type Discovery = {
  requestedLocalDate: string; status: string; creditsUsed: number;
  legacyPriorCreditsUsed?: number; launches: Launch[];
};
type Screening = { date: string; status: string; creditsUsed: number; nextIndex: number; selectedLaunchIndexes: number[]; results: Array<{ index: number; result: HistoricalLaunchActivityScreenResult }> };
type Checkpoint = {
  schemaVersion: 3; date: string; discoveryLaunchCount: number;
  discoveryCredits: number; screeningCredits: number; legacyPriorCreditsUsed: number; totalCreditCeiling: number;
  selectedLaunchIndexes: number[]; nextCandidateIndex: number;
  completedMints: string[]; incompleteMints: string[];
  marketPatternMints: string[]; noSetupMints: string[];
  cumulativeCreditsUsed: number; updatedAt: string;
};

function option(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}
function integer(name: string, fallback: number, max: number): number {
  const value = Number(option(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`--${name} must be an integer between 1 and ${max}.`);
  }
  return value;
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item, 2) + "\n");
  await rename(temp, path);
}

const date = option("date", "");
const batchSize = integer("batch-size", 20, 20);
const maxCredits = integer("max-credits", 50_000, 50_000);
const apiKey = process.env.HELIUS_API_KEY ?? "";
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !apiKey.trim()) {
  throw new Error("Set HELIUS_API_KEY and pass --date=YYYY-MM-DD.");
}
const directory = resolve("artifacts");
const discoveryPath = resolve(directory, `pump-launch-discovery-${date}.json`);
const checkpointPath = resolve(directory, "checkpoint.json");
const screeningPath = resolve(directory, `pump-launch-screen-${date}.json`);
await mkdir(resolve(directory, "coins"), { recursive: true });
const discovery = JSON.parse(await readFile(discoveryPath, "utf8")) as Discovery;
if (discovery.requestedLocalDate !== date || !(discovery.status === "DAY_EXHAUSTED" || discovery.status === "SAMPLE_COMPLETE") ||
    !Array.isArray(discovery.launches) || !Number.isSafeInteger(discovery.creditsUsed) ||
    discovery.creditsUsed > maxCredits) {
  throw new Error("A complete, budget-compliant full-day discovery artifact is required.");
}
if (new Set(discovery.launches.map(row => row.event.mint)).size !== discovery.launches.length) {
  throw new Error("Discovery contains duplicate mints.");
}

const screening = JSON.parse(await readFile(screeningPath, "utf8")) as Screening;
if (screening.date !== date || screening.status !== "COMPLETE" ||
    !Number.isSafeInteger(screening.creditsUsed) || screening.creditsUsed < 0 || screening.creditsUsed > 500 ||
    screening.nextIndex !== discovery.launches.length ||
    !Array.isArray(screening.results) || screening.results.length !== discovery.launches.length ||
    !Array.isArray(screening.selectedLaunchIndexes) ||
    screening.selectedLaunchIndexes.length > Math.floor(discovery.launches.length * 0.3) ||
    screening.selectedLaunchIndexes.some(index => !Number.isSafeInteger(index) || index < 0 || index >= discovery.launches.length) ||
    new Set(screening.selectedLaunchIndexes).size !== screening.selectedLaunchIndexes.length) {
  throw new Error("A complete, valid activity-screen artifact selecting at most 30% of launches is required.");
}
const selectedLaunchIndexes = screening.selectedLaunchIndexes;
if (selectedLaunchIndexes.length === 0) {
  throw new Error("No launches met the minimum historical activity screen; refusing to spend credits on inactive/uncertain coins.");
}

let checkpoint: Checkpoint;
try {
  checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as Checkpoint;
  if (checkpoint.schemaVersion !== 3 || checkpoint.date !== date ||
      checkpoint.discoveryLaunchCount !== discovery.launches.length ||
      checkpoint.discoveryCredits !== discovery.creditsUsed ||
      checkpoint.screeningCredits !== screening.creditsUsed ||
      checkpoint.legacyPriorCreditsUsed !== (discovery.legacyPriorCreditsUsed ?? 0) ||
      checkpoint.totalCreditCeiling > maxCredits ||
      JSON.stringify(checkpoint.selectedLaunchIndexes) !== JSON.stringify(selectedLaunchIndexes) ||
      checkpoint.nextCandidateIndex < 0 || checkpoint.nextCandidateIndex > selectedLaunchIndexes.length ||
      checkpoint.cumulativeCreditsUsed < (discovery.legacyPriorCreditsUsed ?? 0) + discovery.creditsUsed + screening.creditsUsed ||
      checkpoint.cumulativeCreditsUsed > maxCredits) {
    throw new Error("Checkpoint does not match this discovery artifact/date/credit ceiling.");
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  checkpoint = {
    schemaVersion: 3, date, discoveryLaunchCount: discovery.launches.length,
    discoveryCredits: discovery.creditsUsed, screeningCredits: screening.creditsUsed,
    legacyPriorCreditsUsed: discovery.legacyPriorCreditsUsed ?? 0, totalCreditCeiling: maxCredits,
    selectedLaunchIndexes, nextCandidateIndex: 0, completedMints: [], incompleteMints: [],
    marketPatternMints: [], noSetupMints: [],
    cumulativeCreditsUsed: (discovery.legacyPriorCreditsUsed ?? 0) + discovery.creditsUsed + screening.creditsUsed, updatedAt: new Date().toISOString()
  };
  await atomicJson(checkpointPath, checkpoint);
}
// Old checkpoints counted incomplete coins as completed. Normalize them so
// one higher-cap replay can retry those exact candidates without duplicating
// already complete coins.
checkpoint.completedMints = checkpoint.completedMints.filter(mint => !checkpoint.incompleteMints.includes(mint));
checkpoint.totalCreditCeiling = maxCredits;
const incompleteMintSet = new Set(checkpoint.incompleteMints);
const firstIncompleteCandidate = selectedLaunchIndexes.findIndex(index =>
  incompleteMintSet.has(discovery.launches[index]!.event.mint)
);
if (firstIncompleteCandidate >= 0) {
  checkpoint.nextCandidateIndex = Math.min(checkpoint.nextCandidateIndex, firstIncompleteCandidate);
}
const solUsd = await fetchSolUsdPrice();
if (solUsd.status !== "AVAILABLE") throw new Error("Fresh SOL/USD reference unavailable.");
const startIndex = checkpoint.nextCandidateIndex;
const endIndex = Math.min(startIndex + batchSize, selectedLaunchIndexes.length);
let budgetStopped = false;

for (let candidateIndex = startIndex; candidateIndex < endIndex; candidateIndex += 1) {
  const index = selectedLaunchIndexes[candidateIndex]!;
  const launch = discovery.launches[index]!;
  const remaining = maxCredits - checkpoint.cumulativeCreditsUsed;
  // A coin is an atomic work unit: at most five 100-signature pages plus
  // 500 raw transaction fetches. Reserve the full bound before starting it.
  const maxCreditsPerCoin = 505;
  if (remaining < maxCreditsPerCoin) { budgetStopped = true; break; }
  const collected = await collectHistoricalLaunchWindow({
    mint: launch.event.mint, bondingCurve: launch.event.bondingCurve,
    createSignature: launch.signature, launchBlockTime: launch.blockTime,
    horizonSeconds: 600, maxSignatures: 500
  }, { apiKey, maxCredits: remaining, requestIntervalMs: 250 });
  checkpoint.cumulativeCreditsUsed += collected.creditsUsed;
  const replay = collected.status === "COMPLETE"
    ? replayHistoricalCoin({
        mint: launch.event.mint, transactions: collected.transactions,
        launchBlockTime: launch.blockTime, horizonSeconds: 600, decodeComplete: true
      }, { solUsdPriceUsd: solUsd.observation.priceUsd, minimumTradeUsd: 0.01, horizonSeconds: 600 })
    : null;

  const trades = collected.transactions.flatMap(transaction => transaction.tradeEvents)
    .filter(event => event.mint === launch.event.mint && isSolQuoteMint(event.quoteMint))
    .sort((a, b) => Number(a.timestamp - b.timestamp));
  const buyTrades = trades.filter(event => event.isBuy);
  const sellTrades = trades.filter(event => !event.isBuy);
  const uniqueBuyers = new Set(buyTrades.map(event => event.user)).size;
  const buyQuoteVolumeLamports = buyTrades.reduce((sum, event) => sum + event.quoteAmount, 0n);
  const reservePrices = trades.map(event =>
    Number(event.virtualSolReserves) / Number(event.virtualTokenReserves)
  ).filter(value => Number.isFinite(value) && value > 0);
  const reservePriceMovePct = reservePrices.length > 1
    ? (reservePrices[reservePrices.length - 1]! / reservePrices[0]! - 1) * 100 : null;
  const maximumReserveUpsidePct = reservePrices.length > 1
    ? (Math.max(...reservePrices) / reservePrices[0]! - 1) * 100 : null;

  const record = {
    index, candidateIndex, mint: launch.event.mint, launch,
    activityScreen: screening.results.find(item => item.index === index)?.result ?? null,
    decodedActivity: {
      verifiedTradeCount: trades.length, buyTradeCount: buyTrades.length,
      sellTradeCount: sellTrades.length, uniqueBuyers,
      buyQuoteVolumeLamports: buyQuoteVolumeLamports.toString(),
      reservePriceMovePct, maximumReserveUpsidePct
    },
    marketPatternShortlist: replay?.firstSetup?.setupEligible === true,
    riskClearedShortlist: replay?.firstSetup?.riskClearedSetupEligible === true,
    collection: {
      status: collected.status, signaturesScanned: collected.state.scannedCount,
      signatureCount: collected.state.signatures.length, pagesScanned: collected.state.pagesScanned,
      verifiedTransactions: collected.transactions.length,
      confirmedFailedSignatures: collected.failedSignatures.length,
      ignoredNonMatchingSignatures: collected.ignoredSignatures.length,
      creditsUsed: collected.creditsUsed, reason: collected.reason
    },
    replay: replay ? {
      status: replay.status, verifiedTradeCount: replay.verifiedTradeCount,
      snapshotCount: replay.snapshots.length, firstSetup: replay.firstSetup,
      outcome: replay.outcome,
      note: "Entry-pattern replay only; not a profitability backtest. Historical executable quotes, complete wallet/holder clearance, and verified exit fills are not supplied."
    } : null,
    transactions: collected.transactions
  };
  if (collected.status === "BUDGET_EXHAUSTED") {
    budgetStopped = true;
    break; // Do not publish a partial coin file; the next run retries this coin atomically.
  }
  await atomicJson(resolve(directory, "coins", `${String(index).padStart(4, "0")}-${launch.event.mint}.json`), record);
  checkpoint.completedMints = checkpoint.completedMints.filter(mint => mint !== launch.event.mint);
  checkpoint.incompleteMints = checkpoint.incompleteMints.filter(mint => mint !== launch.event.mint);
  checkpoint.marketPatternMints = checkpoint.marketPatternMints.filter(mint => mint !== launch.event.mint);
  checkpoint.noSetupMints = checkpoint.noSetupMints.filter(mint => mint !== launch.event.mint);
  if (collected.status === "COMPLETE") {
    checkpoint.completedMints.push(launch.event.mint);
    if (replay?.firstSetup?.setupEligible === true) checkpoint.marketPatternMints.push(launch.event.mint);
    else checkpoint.noSetupMints.push(launch.event.mint);
  } else {
    checkpoint.incompleteMints.push(launch.event.mint);
  }
  checkpoint.nextCandidateIndex = candidateIndex + 1;
  checkpoint.updatedAt = new Date().toISOString();
  await atomicJson(checkpointPath, checkpoint);
}

checkpoint.updatedAt = new Date().toISOString();
await atomicJson(checkpointPath, checkpoint);
const summary = {
  date, batchSize, startCandidateIndex: startIndex, endCandidateIndex: checkpoint.nextCandidateIndex,
  discoveredLaunches: discovery.launches.length, selectedLaunches: selectedLaunchIndexes.length,
  selectedLaunchIndexes,
  completedMints: checkpoint.completedMints.length,
  incompleteMints: checkpoint.incompleteMints,
  marketPatternMints: checkpoint.marketPatternMints,
  noSetupMints: checkpoint.noSetupMints,
  cumulativeCreditsUsed: checkpoint.cumulativeCreditsUsed,
  remainingCredits: maxCredits - checkpoint.cumulativeCreditsUsed,
  nextCandidateIndex: checkpoint.nextCandidateIndex, budgetStopped,
  status: budgetStopped ? "PAUSED_BUDGET_OR_MID_COIN"
    : checkpoint.nextCandidateIndex >= selectedLaunchIndexes.length && checkpoint.incompleteMints.length === 0
      ? "ALL_SELECTED_LAUNCHES_COMPLETE"
      : checkpoint.nextCandidateIndex >= selectedLaunchIndexes.length ? "INCOMPLETE_COVERAGE" : "BATCH_COMPLETE",
  solUsdReference: solUsd.observation,
  sampleWarning: "The dataset is the highest activity-ranked 30% of the discovery sample, not a random representative sample. Signature activity is not unique buyers or confirmed buy volume; use for efficient candidate triage only, not population-wide profitability estimates."
};
await atomicJson(resolve(directory, `batch-summary-${date}.json`), summary);
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
if (budgetStopped) process.exitCode = 2;
