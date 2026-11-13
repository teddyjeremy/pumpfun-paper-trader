import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { collectHistoricalLaunchWindow } from "../src/ingestion/helius-launch-window.js";
import { replayHistoricalCoin } from "../src/strategy/historical-replay.js";
import { fetchSolUsdPrice } from "../src/ingestion/sol-usd-price.js";

type Launch = {
  signature: string; slot: number; blockTime: number;
  event: { mint: string; bondingCurve: string; timestamp: string };
};
type Discovery = {
  requestedLocalDate: string; status: string; creditsUsed: number; launches: Launch[];
};
type Checkpoint = {
  schemaVersion: 1; date: string; discoveryLaunchCount: number;
  discoveryCredits: number; totalCreditCeiling: number;
  nextIndex: number; completedMints: string[]; incompleteMints: string[];
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
const maxCredits = integer("max-credits", 100_000, 100_000);
const apiKey = process.env.HELIUS_API_KEY ?? "";
if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date) || !apiKey.trim()) {
  throw new Error("Set HELIUS_API_KEY and pass --date=YYYY-MM-DD.");
}
const directory = resolve("artifacts");
const discoveryPath = resolve(directory, `pump-launch-discovery-${date}.json`);
const checkpointPath = resolve(directory, "checkpoint.json");
await mkdir(resolve(directory, "coins"), { recursive: true });
const discovery = JSON.parse(await readFile(discoveryPath, "utf8")) as Discovery;
if (discovery.requestedLocalDate !== date || discovery.status !== "DAY_EXHAUSTED" ||
    !Array.isArray(discovery.launches) || !Number.isSafeInteger(discovery.creditsUsed) ||
    discovery.creditsUsed > maxCredits) {
  throw new Error("A complete, budget-compliant full-day discovery artifact is required.");
}
if (new Set(discovery.launches.map(row => row.event.mint)).size !== discovery.launches.length) {
  throw new Error("Discovery contains duplicate mints.");
}

let checkpoint: Checkpoint;
try {
  checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as Checkpoint;
  if (checkpoint.schemaVersion !== 1 || checkpoint.date !== date ||
      checkpoint.discoveryLaunchCount !== discovery.launches.length ||
      checkpoint.discoveryCredits !== discovery.creditsUsed ||
      checkpoint.totalCreditCeiling !== maxCredits ||
      checkpoint.nextIndex < 0 || checkpoint.nextIndex > discovery.launches.length ||
      checkpoint.cumulativeCreditsUsed < discovery.creditsUsed ||
      checkpoint.cumulativeCreditsUsed > maxCredits) {
    throw new Error("Checkpoint does not match this discovery artifact/date/credit ceiling.");
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  checkpoint = {
    schemaVersion: 1, date, discoveryLaunchCount: discovery.launches.length,
    discoveryCredits: discovery.creditsUsed, totalCreditCeiling: maxCredits,
    nextIndex: 0, completedMints: [], incompleteMints: [],
    cumulativeCreditsUsed: discovery.creditsUsed, updatedAt: new Date().toISOString()
  };
  await atomicJson(checkpointPath, checkpoint);
}
const solUsd = await fetchSolUsdPrice();
if (solUsd.status !== "AVAILABLE") throw new Error("Fresh SOL/USD reference unavailable.");
const startIndex = checkpoint.nextIndex;
const endIndex = Math.min(startIndex + batchSize, discovery.launches.length);
let budgetStopped = false;

for (let index = startIndex; index < endIndex; index += 1) {
  const launch = discovery.launches[index]!;
  const remaining = maxCredits - checkpoint.cumulativeCreditsUsed;
  if (remaining < 1) { budgetStopped = true; break; }
  const collected = await collectHistoricalLaunchWindow({
    mint: launch.event.mint, bondingCurve: launch.event.bondingCurve,
    createSignature: launch.signature, launchBlockTime: launch.blockTime,
    horizonSeconds: 600, maxSignatures: 120
  }, { apiKey, maxCredits: remaining, requestIntervalMs: 250 });
  checkpoint.cumulativeCreditsUsed += collected.creditsUsed;
  const replay = collected.status === "COMPLETE"
    ? replayHistoricalCoin({
        mint: launch.event.mint, transactions: collected.transactions,
        launchBlockTime: launch.blockTime, horizonSeconds: 600, decodeComplete: true
      }, { solUsdPriceUsd: solUsd.observation.priceUsd, minimumTradeUsd: 0.01, horizonSeconds: 600 })
    : null;

  const record = {
    index, mint: launch.event.mint, launch, collection: {
      status: collected.status, signaturesScanned: collected.state.scannedCount,
      signatureCount: collected.state.signatures.length, pagesScanned: collected.state.pagesScanned,
      verifiedTransactions: collected.transactions.length,
      confirmedFailedSignatures: collected.failedSignatures.length,
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
  await atomicJson(resolve(directory, "coins", `${String(index).padStart(4, "0")}-${launch.event.mint}.json`), record);

  if (collected.status === "BUDGET_EXHAUSTED") {
    budgetStopped = true;
    break; // Retry this mint next run; the collector currently cannot resume mid-coin.
  }
  if (collected.status !== "COMPLETE") checkpoint.incompleteMints.push(launch.event.mint);
  checkpoint.completedMints.push(launch.event.mint);
  checkpoint.nextIndex = index + 1;
  checkpoint.updatedAt = new Date().toISOString();
  await atomicJson(checkpointPath, checkpoint);
}

checkpoint.updatedAt = new Date().toISOString();
await atomicJson(checkpointPath, checkpoint);
const summary = {
  date, batchSize, startIndex, endIndex: checkpoint.nextIndex,
  discoveredLaunches: discovery.launches.length,
  completedMints: checkpoint.completedMints.length,
  incompleteMints: checkpoint.incompleteMints,
  cumulativeCreditsUsed: checkpoint.cumulativeCreditsUsed,
  remainingCredits: maxCredits - checkpoint.cumulativeCreditsUsed,
  nextIndex: checkpoint.nextIndex, budgetStopped,
  status: checkpoint.nextIndex >= discovery.launches.length ? "ALL_LAUNCHES_PROCESSED"
    : budgetStopped ? "PAUSED_BUDGET_OR_MID_COIN" : "BATCH_COMPLETE",
  solUsdReference: solUsd.observation,
  sampleWarning: "Discovery currently selects the earliest launches in the day, not a time-stratified/random control sample. Use for pipeline validation only; do not tune strategy thresholds or infer profitability from this biased sample."
};
await atomicJson(resolve(directory, `batch-summary-${date}.json`), summary);
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
if (budgetStopped) process.exitCode = 2;
