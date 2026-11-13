import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { discoverPumpLaunchesInTimeRange } from "../src/ingestion/helius-day-discovery.js";

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
const offsetMinutes = Number(option("utc-offset-minutes", "180"));
const maxCredits = positiveInteger("max-credits", 100_000, 100_000);
const maxLaunches = positiveInteger("max-launches", 100, 100);
const pageSize = positiveInteger("page-size", 1_000, 1_000);
const apiKey = process.env.HELIUS_API_KEY ?? "";

if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isSafeInteger(offsetMinutes) || Math.abs(offsetMinutes) > 840 ||
    !apiKey.trim()) {
  throw new Error("Set HELIUS_API_KEY and pass --date=YYYY-MM-DD; UTC offset defaults to Nairobi (+180 minutes).");
}

const localMidnightUtc = Date.parse(`${date}T00:00:00.000Z`) - offsetMinutes * 60_000;
if (!Number.isFinite(localMidnightUtc) ||
    new Date(localMidnightUtc + offsetMinutes * 60_000).toISOString().slice(0, 10) !== date) {
  throw new Error("Invalid calendar date.");
}

const startTime = Math.floor(localMidnightUtc / 1_000);
const endTime = startTime + 86_400;
const result = await discoverPumpLaunchesInTimeRange(startTime, endTime, {
  apiKey, maxCredits, maxLaunches, pageSize, requestIntervalMs: 250
});

const output = {
  requestedLocalDate: date,
  utcOffsetMinutes: offsetMinutes,
  timezoneInterpretation: "Fixed UTC offset supplied by operator; no daylight-saving inference.",
  sampleOrder: "Earliest launches from the requested local day; DAY_EXHAUSTED is required to trust this sample.",
  creditMetering: "One credit per standard getSignaturesForAddress or getTransaction RPC request.",
  ...result,
  launches: result.launches.map(launch => ({
    ...launch,
    event: Object.fromEntries(Object.entries(launch.event).map(([key, value]) =>
      [key, typeof value === "bigint" ? value.toString() : value]))
  }))
};
const directory = resolve("artifacts");
await mkdir(directory, { recursive: true });
const path = resolve(directory, `pump-launch-discovery-${date}.json`);
await writeFile(path, JSON.stringify(output, null, 2) + "\n", { flag: "wx" }).catch(async error => {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  throw new Error(`Refusing to overwrite existing artifact: ${path}`);
});
process.stdout.write(JSON.stringify({
  status: result.status, launches: result.launches.length,
  creditsUsed: result.creditsUsed, pagesScanned: result.pagesScanned,
  signaturesScanned: result.signaturesScanned, transactionFetches: result.transactionFetches,
  artifact: path, reason: result.reason
}, null, 2) + "\n");
if (result.status === "INCOMPLETE" || result.status === "BUDGET_EXHAUSTED") process.exitCode = 2;
