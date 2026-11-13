import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { screenHistoricalLaunchActivity, type HistoricalLaunchActivityScreenResult } from "../src/ingestion/helius-launch-screen.js";

type Launch = {
  signature: string; slot: number; blockTime: number;
  event: { mint: string; bondingCurve: string; timestamp: string };
};
type Discovery = { requestedLocalDate: string; status: string; creditsUsed: number; launches: Launch[] };
type ScreenArtifact = {
  schemaVersion: 1; date: string; discoveryLaunchCount: number;
  status: "RUNNING" | "COMPLETE" | "BUDGET_EXHAUSTED";
  maxCandidates: number; minSuccessfulSignatures: number; minActiveTimeBuckets: number;
  creditsUsed: number; nextIndex: number;
  results: Array<{ index: number; result: HistoricalLaunchActivityScreenResult }>;
  selectedLaunchIndexes: number[]; updatedAt: string;
};
function option(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}
function integer(name: string, fallback: number, max: number): number {
  const value = Number(option(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`--${name} must be between 1 and ${max}.`);
  return value;
}
async function save(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n");
  await rename(temp, path);
}
const date = option("date", "");
const maxCredits = integer("max-credits", 500, 10_000);
const maxSharePct = integer("max-share-pct", 30, 30);
const minSuccessfulSignatures = integer("min-successful", 5, 100);
const minActiveTimeBuckets = integer("min-active-buckets", 3, 60);
const apiKey = process.env.HELIUS_API_KEY ?? "";
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !apiKey.trim()) throw new Error("Set HELIUS_API_KEY and pass --date=YYYY-MM-DD.");
const dir = resolve("artifacts");
await mkdir(dir, { recursive: true });
const discovery = JSON.parse(await readFile(resolve(dir, `pump-launch-discovery-${date}.json`), "utf8")) as Discovery;
if (discovery.requestedLocalDate !== date || !(discovery.status === "DAY_EXHAUSTED" || discovery.status === "SAMPLE_COMPLETE") ||
    !Array.isArray(discovery.launches) || !Number.isSafeInteger(discovery.creditsUsed)) {
  throw new Error("A complete day-discovery artifact is required before activity screening.");
}
const path = resolve(dir, `pump-launch-screen-${date}.json`);
const maxCandidates = Math.floor(discovery.launches.length * maxSharePct / 100);
let artifact: ScreenArtifact;
try {
  artifact = JSON.parse(await readFile(path, "utf8")) as ScreenArtifact;
  if (artifact.schemaVersion !== 1 || artifact.date !== date ||
      artifact.discoveryLaunchCount !== discovery.launches.length ||
      artifact.maxCandidates !== maxCandidates ||
      artifact.minSuccessfulSignatures !== minSuccessfulSignatures ||
      artifact.minActiveTimeBuckets !== minActiveTimeBuckets ||
      !Array.isArray(artifact.results) || !Number.isSafeInteger(artifact.nextIndex) ||
      artifact.nextIndex < 0 || artifact.nextIndex > discovery.launches.length ||
      !Number.isSafeInteger(artifact.creditsUsed) || artifact.creditsUsed < 0 ||
      artifact.creditsUsed > maxCredits) throw new Error("Saved screen checkpoint does not match this run's inputs.");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  artifact = {
    schemaVersion: 1, date, discoveryLaunchCount: discovery.launches.length,
    status: "RUNNING", maxCandidates, minSuccessfulSignatures, minActiveTimeBuckets,
    creditsUsed: 0, nextIndex: 0, results: [], selectedLaunchIndexes: [],
    updatedAt: new Date().toISOString()
  };
  await save(path, artifact);
}
const resultByIndex = new Map(artifact.results.map(row => [row.index, row.result]));
let lastRequestAt = 0;
for (let index = artifact.nextIndex; index < discovery.launches.length; index += 1) {
  if (artifact.creditsUsed >= maxCredits) {
    artifact.status = "BUDGET_EXHAUSTED";
    break;
  }
  const wait = 250 - (Date.now() - lastRequestAt);
  if (lastRequestAt > 0 && wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  const launch = discovery.launches[index]!;
  artifact.creditsUsed += 1; // Count attempted RPC calls before I/O.
  lastRequestAt = Date.now();
  const result = await screenHistoricalLaunchActivity({
    mint: launch.event.mint, bondingCurve: launch.event.bondingCurve,
    createSignature: launch.signature, launchBlockTime: launch.blockTime,
    horizonSeconds: 600
  }, { apiKey });
  artifact.results.push({ index, result });
  artifact.nextIndex = index + 1;
  artifact.updatedAt = new Date().toISOString();
  await save(path, artifact);
}
if (artifact.nextIndex === discovery.launches.length) artifact.status = "COMPLETE";
if (artifact.status === "COMPLETE") {
  const ranked = artifact.results.filter(row => row.result.status === "SCREENED" &&
      row.result.successfulSignatures >= minSuccessfulSignatures &&
      row.result.activeTimeBuckets >= minActiveTimeBuckets)
    .sort((a, b) => b.result.activityScore - a.result.activityScore ||
      discovery.launches[a.index]!.blockTime - discovery.launches[b.index]!.blockTime ||
      a.index - b.index)
    .slice(0, maxCandidates);
  artifact.selectedLaunchIndexes = ranked.map(row => row.index);
}
artifact.updatedAt = new Date().toISOString();
await save(path, artifact);
const screened = artifact.results.filter(row => row.result.status === "SCREENED").length;
const rejected = artifact.results.length - screened;
process.stdout.write(JSON.stringify({
  date, status: artifact.status, discovered: discovery.launches.length,
  screened, incompleteScreens: rejected, maxCandidateSharePct: maxSharePct,
  maxCandidates, selectedCandidates: artifact.selectedLaunchIndexes.length,
  minSuccessfulSignatures, minActiveTimeBuckets, screeningCreditsUsed: artifact.creditsUsed,
  candidateIndexes: artifact.selectedLaunchIndexes,
  artifact: path,
  note: "Signature activity is only a cheap pre-screen proxy. It does not prove unique buyers, buy direction, volume, price movement, risk clearance, or profitability. Detailed decode/replay is required for selected candidates."
}, null, 2) + "\n");
if (artifact.status !== "COMPLETE") process.exitCode = 2;
