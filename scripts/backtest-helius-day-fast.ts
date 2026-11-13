import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { discoverStratifiedPumpLaunches } from "../src/ingestion/helius-stratified-discovery.js";

const option = (name: string, fallback: string) =>
  process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const date = option("date", "");
const offsetMinutes = Number(option("utc-offset-minutes", "180"));
const maxCredits = Number(option("max-credits", "3000"));
const apiKey = process.env.HELIUS_API_KEY ?? "";
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isSafeInteger(offsetMinutes) ||
    Math.abs(offsetMinutes) > 840 || !Number.isSafeInteger(maxCredits) || maxCredits < 100 ||
    !apiKey.trim()) throw new Error("Set HELIUS_API_KEY and pass valid date/credit options.");
const midnight = Date.parse(`${date}T00:00:00.000Z`) - offsetMinutes * 60_000;
if (!Number.isFinite(midnight) || new Date(midnight + offsetMinutes * 60_000).toISOString().slice(0,10) !== date) {
  throw new Error("Invalid local calendar date.");
}
const startTime = Math.floor(midnight / 1000);
const result = await discoverStratifiedPumpLaunches(startTime, startTime + 86_400, {
  apiKey, maxCredits, requestIntervalMs: 250
});
const output = {
  requestedLocalDate: date, utcOffsetMinutes: offsetMinutes,
  timezoneInterpretation: "Fixed operator-supplied UTC offset.",
  sampleOrder: "Time-stratified: two earliest and two latest CreateEvents per hourly bucket, then activity-ranked screening.",
  creditMetering: "Parsed Events Scan reports exact creditsCharged; each selected getTransaction is counted as one standard RPC credit.",
  ...result,
  launches: result.launches.map(row => ({
    ...row, event: Object.fromEntries(Object.entries(row.event).map(([key,value]) =>
      [key, typeof value === "bigint" ? value.toString() : value]))
  }))
};
const directory = resolve("artifacts");
await mkdir(directory, { recursive: true });
const path = resolve(directory, `pump-launch-discovery-${date}.json`);
try {
  const prior = JSON.parse(await readFile(path, "utf8")) as { status?: string };
  if (prior.status === "SAMPLE_COMPLETE" || prior.status === "DAY_EXHAUSTED") {
    throw new Error("A completed discovery artifact already exists; refusing to overwrite it.");
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT" &&
      !(error instanceof Error && error.message.includes("completed discovery artifact"))) throw error;
  if (error instanceof Error && error.message.includes("completed discovery artifact")) throw error;
}
const temp = `${path}.tmp`;
await writeFile(temp, JSON.stringify(output, null, 2) + "\n");
await rename(temp, path);
process.stdout.write(JSON.stringify({
  status: result.status, launches: result.launches.length, creditsUsed: result.creditsUsed,
  scanRequests: result.scanRequests, scanCredits: result.scanCredits,
  transactionFetches: result.transactionFetches, artifact: path, reason: result.reason,
  sampling: result.sampling
}, null, 2) + "\n");
if (result.status !== "SAMPLE_COMPLETE") process.exitCode = 2;
