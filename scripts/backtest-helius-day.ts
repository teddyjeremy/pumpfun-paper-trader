import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { discoverPumpLaunchesInTimeRange, type HistoricalLaunchDiscovery } from "../src/ingestion/helius-day-discovery.js";

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
const maxCredits = positiveInteger("max-credits", 40_000, 100_000);
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
const directory = resolve("artifacts");
await mkdir(directory, { recursive: true });
const path = resolve(directory, `pump-launch-discovery-${date}.json`);
let resume: Parameters<typeof discoverPumpLaunchesInTimeRange>[2]["resume"];
try {
  const previous = JSON.parse(await readFile(path, "utf8")) as {
    requestedLocalDate?: string; status?: string; startTime?: number; endTime?: number;
    pagesScanned?: number; signaturesScanned?: number; transactionFetches?: number;
    creditsUsed?: number; nextBefore?: string | null;
    resumeBoundary?: { signature: string; slot: number; blockTime: number } | null;
    launches?: Array<{ signature: string; slot: number; blockTime: number;
      event: HistoricalLaunchDiscovery["event"] & { timestamp: string | bigint } }>;
  };
  if (previous.requestedLocalDate !== date || previous.startTime !== startTime || previous.endTime !== endTime) {
    throw new Error("Existing discovery artifact belongs to a different date/time range.");
  }
  if (previous.status === "DAY_EXHAUSTED") {
    process.stdout.write(JSON.stringify({ date, status: "DAY_EXHAUSTED", artifact: path, resumed: false }, null, 2) + "\\n");
    process.exit(0);
  }
  if (!["INCOMPLETE", "BUDGET_EXHAUSTED"].includes(previous.status ?? "") ||
      typeof previous.nextBefore !== "string" ||
      !Number.isSafeInteger(previous.pagesScanned) ||
      !Number.isSafeInteger(previous.signaturesScanned) ||
      !Number.isSafeInteger(previous.transactionFetches) ||
      !Number.isSafeInteger(previous.creditsUsed) ||
      !Array.isArray(previous.launches) || previous.launches.length > maxLaunches) {
    throw new Error("Existing discovery artifact does not contain a valid resumable cursor.");
  }
  if (previous.creditsUsed! >= maxCredits) {
    throw new Error("The existing discovery checkpoint already consumed the configured credit ceiling; increase the explicit ceiling to resume.");
  }
  resume = {
    before: previous.nextBefore,
    pagesScanned: previous.pagesScanned!,
    signaturesScanned: previous.signaturesScanned!,
    transactionFetches: previous.transactionFetches!,
    creditsUsed: previous.creditsUsed!,
    launches: previous.launches.map(launch => ({
      ...launch, event: { ...launch.event, timestamp: BigInt(launch.event.timestamp) }
    })),
    ...(previous.resumeBoundary ? { previousOldest: previous.resumeBoundary } : {})
  };
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const result = await discoverPumpLaunchesInTimeRange(startTime, endTime, {
  apiKey, maxCredits, maxLaunches, pageSize, requestIntervalMs: 250,
  ...(resume ? { resume } : {})
});

const output = {
  requestedLocalDate: date,
  utcOffsetMinutes: offsetMinutes,
  timezoneInterpretation: "Fixed UTC offset supplied by operator; no daylight-saving inference.",
  sampleOrder: "One deterministic launch from each equal-width time bucket across the full local day; DAY_EXHAUSTED is required to trust this sample.",
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
const tempPath = `${path}.tmp`;
await writeFile(tempPath, JSON.stringify(output, null, 2) + "\n");
await rename(tempPath, path);
process.stdout.write(JSON.stringify({
  status: result.status, launches: result.launches.length,
  creditsUsed: result.creditsUsed, pagesScanned: result.pagesScanned,
  signaturesScanned: result.signaturesScanned, transactionFetches: result.transactionFetches,
  artifact: path, reason: result.reason
}, null, 2) + "\n");
if (result.status === "INCOMPLETE" || result.status === "BUDGET_EXHAUSTED") process.exitCode = 2;
