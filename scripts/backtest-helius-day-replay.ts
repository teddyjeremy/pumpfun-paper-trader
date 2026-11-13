import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { collectHistoricalLaunchWindow } from "../src/ingestion/helius-launch-window.js";
import { replayHistoricalCoin } from "../src/strategy/historical-replay.js";
import { fetchSolUsdPrice } from "../src/ingestion/sol-usd-price.js";

function option(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}
function positiveInteger(name: string, fallback: number, maximum: number): number {
  const value = Number(option(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`--${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

const date = option("date", "");
const maxCredits = positiveInteger("max-credits", 100_000, 100_000);
const apiKey = process.env.HELIUS_API_KEY ?? "";
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !apiKey.trim()) {
  throw new Error("Set HELIUS_API_KEY and pass --date=YYYY-MM-DD.");
}

const discoveryPath = resolve("artifacts", `pump-launch-discovery-${date}.json`);
const discovery = JSON.parse(await readFile(discoveryPath, "utf8")) as {
  requestedLocalDate?: string;
  status?: string;
  creditsUsed?: number;
  launches?: Array<{
    signature: string; slot: number; blockTime: number;
    event: { mint: string; bondingCurve: string; timestamp: string };
  }>;
};
if (discovery.requestedLocalDate !== date || discovery.status !== "DAY_EXHAUSTED" ||
    !Array.isArray(discovery.launches) ||
    !Number.isSafeInteger(discovery.creditsUsed) || (discovery.creditsUsed ?? maxCredits) > maxCredits) {
  throw new Error("A complete, budget-compliant full-day discovery artifact is required before replay.");
}
if (new Set(discovery.launches.map(item => item.event.mint)).size !== discovery.launches.length) {
  throw new Error("Discovery artifact contains duplicate launch mints.");
}

const solUsd = await fetchSolUsdPrice();
if (solUsd.status !== "AVAILABLE") {
  throw new Error("Fresh SOL/USD reference unavailable; no historical replay was run.");
}
let creditsUsed = discovery.creditsUsed!;
const results: Array<Record<string, unknown>> = [];
for (const launch of discovery.launches) {
  const remaining = maxCredits - creditsUsed;
  if (remaining < 1) break;
  const collected = await collectHistoricalLaunchWindow({
    mint: launch.event.mint,
    bondingCurve: launch.event.bondingCurve,
    createSignature: launch.signature,
    launchBlockTime: launch.blockTime,
    horizonSeconds: 600,
    maxSignatures: 120
  }, { apiKey, maxCredits: remaining, requestIntervalMs: 250 });
  creditsUsed += collected.creditsUsed;

  const replay = collected.status === "COMPLETE"
    ? replayHistoricalCoin({
        mint: launch.event.mint,
        transactions: collected.transactions,
        launchBlockTime: launch.blockTime,
        horizonSeconds: 600,
        decodeComplete: true
      }, {
        solUsdPriceUsd: solUsd.observation.priceUsd,
        minimumTradeUsd: 0.01,
        horizonSeconds: 600
      })
    : null;

  results.push({
    mint: launch.event.mint,
    name: launch.event,
    createSignature: launch.signature,
    launchBlockTime: launch.blockTime,
    collection: {
      status: collected.status,
      signaturesScanned: collected.state.scannedCount,
      signatureCount: collected.state.signatures.length,
      pagesScanned: collected.state.pagesScanned,
      verifiedTransactions: collected.transactions.length,
      confirmedFailedSignatures: collected.failedSignatures.length,
      creditsUsed: collected.creditsUsed,
      reason: collected.reason
    },
    replay: replay ? {
      status: replay.status,
      verifiedTradeCount: replay.verifiedTradeCount,
      snapshotCount: replay.snapshots.length,
      firstSetup: replay.firstSetup,
      outcome: replay.outcome,
      note: "Entry-pattern replay only. Wallet/holder clearance, executable historical entry evidence and verified dynamic exit fills are not supplied, so this is not a profitability backtest."
    } : null,
    transactions: collected.transactions
  });

  if (collected.status === "BUDGET_EXHAUSTED") break;
}

const complete = results.filter(row =>
  (row.collection as Record<string, unknown>).status === "COMPLETE").length;
const output = {
  requestedLocalDate: date,
  utcOffsetMinutes: 180,
  timezone: "Africa/Nairobi (UTC+03:00)",
  totalCreditCeiling: maxCredits,
  discoveryCredits: discovery.creditsUsed,
  totalCreditsUsed: creditsUsed,
  remainingFromCeiling: maxCredits - creditsUsed,
  solUsdReference: solUsd.observation,
  launchCount: results.length,
  completeLaunchWindows: complete,
  incompleteLaunchWindows: results.length - complete,
  results
};
const directory = resolve("artifacts");
await mkdir(directory, { recursive: true });
const path = resolve(directory, `pump-strategy-replay-${date}.json`);
await writeFile(path, JSON.stringify(output, (_key, value) =>
  typeof value === "bigint" ? value.toString() : value, 2) + "\n", { flag: "wx" }).catch(async error => {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  throw new Error(`Refusing to overwrite existing artifact: ${path}`);
});
process.stdout.write(JSON.stringify({
  date, launchCount: results.length, completeLaunchWindows: complete,
  incompleteLaunchWindows: results.length - complete, totalCreditsUsed: creditsUsed,
  remainingFromCeiling: maxCredits - creditsUsed, artifact: path
}, null, 2) + "\n");
if (complete !== results.length) process.exitCode = 2;
