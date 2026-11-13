import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  fetchPumpCreateScanPage, fetchFirstVerifiedParsedLaunch,
  findFirstResumableParsedLaunchBucket, canContinueParsedLaunchBucket, canMarkParsedLaunchBucketEmpty,
  type ParsedCreateScanPage, type VerifiedParsedLaunch
} from "../src/ingestion/helius-parsed-launch-discovery.js";

type BucketState = {
  index: number; startTime: number; endTime: number;
  status: "RUNNING" | "FOUND" | "EMPTY" | "INCOMPLETE";
  paginationToken: string | null; pagesScanned: number;
  scannedTransactions: number; creditsUsed: number; hasUnverifiedMatch?: boolean; rescanAttempts?: number;
  launch?: VerifiedParsedLaunch; reason: string | null;
};
type Artifact = {
  schemaVersion: 2; provider: "HELIUS_PARSED_EVENTS_SCAN";
  requestedLocalDate: string; utcOffsetMinutes: number;
  startTime: number; endTime: number; sampleMethod: string;
  status: "RUNNING" | "SAMPLE_COMPLETE" | "BUDGET_EXHAUSTED" | "INCOMPLETE";
  maxCredits: number; maxLaunches: number; maxPagesPerBucket: number;
  legacyPriorCreditsUsed: number;
  nextBucketIndex: number; creditsUsed: number;
  pagesScanned: number; signaturesScanned: number; transactionFetches: number;
  buckets: BucketState[]; launches: VerifiedParsedLaunch[];
  reason: string | null; updatedAt: string;
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
async function save(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item, 2) + "\n");
  await rename(temp, path);
}
const date = option("date", "");
const offsetMinutes = Number(option("utc-offset-minutes", "180"));
const maxCredits = integer("max-credits", 10_000, 100_000);
const maxLaunches = integer("max-launches", 100, 100);
const maxPagesPerBucket = integer("max-pages-per-bucket", 5, 20);
const apiKey = process.env.HELIUS_API_KEY ?? "";
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isSafeInteger(offsetMinutes) || Math.abs(offsetMinutes) > 840 || !apiKey.trim()) {
  throw new Error("Set HELIUS_API_KEY and pass --date=YYYY-MM-DD; UTC offset defaults to Nairobi (+180 minutes).");
}
const midnightUtc = Date.parse(`${date}T00:00:00.000Z`) - offsetMinutes * 60_000;
if (!Number.isFinite(midnightUtc) ||
    new Date(midnightUtc + offsetMinutes * 60_000).toISOString().slice(0, 10) !== date) {
  throw new Error("Invalid historical calendar date.");
}
const startTime = Math.floor(midnightUtc / 1_000);
const endTime = startTime + 86_400;
const directory = resolve("artifacts");
await mkdir(directory, { recursive: true });
const path = resolve(directory, `pump-launch-discovery-${date}.json`);
let artifact: Artifact;
let legacyPriorCreditsUsed = 0;
try {
  const previous = JSON.parse(await readFile(path, "utf8")) as Partial<Artifact> & {
    creditsUsed?: number; provider?: string; requestedLocalDate?: string;
    startTime?: number; endTime?: number;
  };
  if (previous.requestedLocalDate && previous.requestedLocalDate !== date) {
    throw new Error("Restored historical discovery artifact belongs to a different date.");
  }
  if (previous.provider === "HELIUS_PARSED_EVENTS_SCAN") {
    if (previous.schemaVersion !== 2 || previous.requestedLocalDate !== date ||
        previous.startTime !== startTime || previous.endTime !== endTime ||
        previous.maxLaunches !== maxLaunches ||
        !Number.isSafeInteger(previous.maxPagesPerBucket) ||
        previous.maxPagesPerBucket! > maxPagesPerBucket ||
        !Array.isArray(previous.buckets) || !Number.isSafeInteger(previous.nextBucketIndex) ||
        previous.nextBucketIndex! < 0 || previous.nextBucketIndex! > maxLaunches ||
        !Number.isSafeInteger(previous.creditsUsed) || previous.creditsUsed! < 0 ||
        previous.creditsUsed! > maxCredits) {
      throw new Error("Existing Parsed Events checkpoint does not match this date, bucket layout or credit ceiling.");
    }
    artifact = previous as Artifact;
    // A resumed checkpoint may safely raise its page ceiling; never lower it.
    artifact.maxPagesPerBucket = maxPagesPerBucket;
    artifact.maxCredits = maxCredits;
  } else {
    legacyPriorCreditsUsed = Number.isSafeInteger(previous.creditsUsed) && previous.creditsUsed! > 0
      ? previous.creditsUsed! : 0;
    artifact = {
      schemaVersion: 2, provider: "HELIUS_PARSED_EVENTS_SCAN",
      requestedLocalDate: date, utcOffsetMinutes: offsetMinutes,
      startTime, endTime,
      sampleMethod: "One Pump create/create_v2 instruction per equal-width time bucket across the full Nairobi day.",
      status: "RUNNING", maxCredits, maxLaunches, maxPagesPerBucket,
      legacyPriorCreditsUsed,
      nextBucketIndex: 0, creditsUsed: 0, pagesScanned: 0,
      signaturesScanned: 0, transactionFetches: 0,
      buckets: [], launches: [], reason: null, updatedAt: new Date().toISOString()
    };
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  artifact = {
    schemaVersion: 2, provider: "HELIUS_PARSED_EVENTS_SCAN",
    requestedLocalDate: date, utcOffsetMinutes: offsetMinutes,
    startTime, endTime,
    sampleMethod: "One Pump create/create_v2 instruction per equal-width time bucket across the full Nairobi day.",
    status: "RUNNING", maxCredits, maxLaunches, maxPagesPerBucket,
    legacyPriorCreditsUsed,
    nextBucketIndex: 0, creditsUsed: 0, pagesScanned: 0,
    signaturesScanned: 0, transactionFetches: 0,
    buckets: [], launches: [], reason: null, updatedAt: new Date().toISOString()
  };
}
if (artifact.status === "INCOMPLETE") {
  const resumableIndex = findFirstResumableParsedLaunchBucket(artifact.buckets, maxPagesPerBucket);
  if (resumableIndex !== null) {
    const retryBucket = artifact.buckets[resumableIndex]!;
    const hasFailedSelectedMatch = retryBucket.hasUnverifiedMatch === true ||
      (typeof retryBucket.reason === "string" &&
        (retryBucket.reason.includes("Selected Create transaction") ||
         retryBucket.reason.includes("Pump event log payload") ||
         retryBucket.reason.includes("Pump CreateEvent")));
    if (hasFailedSelectedMatch && !retryBucket.paginationToken &&
        (retryBucket.rescanAttempts ?? 0) < 1) {
      retryBucket.pagesScanned = 0;
      retryBucket.scannedTransactions = 0;
      retryBucket.reason = null;
      retryBucket.status = "RUNNING";
      retryBucket.hasUnverifiedMatch = true;
      retryBucket.rescanAttempts = (retryBucket.rescanAttempts ?? 0) + 1;
      artifact.buckets[resumableIndex] = retryBucket;
    }
    artifact.nextBucketIndex = Math.min(artifact.nextBucketIndex, resumableIndex);
    artifact.status = "RUNNING";
    artifact.reason = null;
  }
}
if (artifact.status === "SAMPLE_COMPLETE") {
  if (artifact.buckets.length !== maxLaunches ||
      artifact.buckets.some((bucket, index) => bucket?.index !== index ||
        (bucket.status !== "FOUND" && bucket.status !== "EMPTY"))) {
    throw new Error("A SAMPLE_COMPLETE artifact must contain exactly one terminal FOUND/EMPTY result for every time bucket.");
  }
  process.stdout.write(JSON.stringify({
    date, status: artifact.status, launches: artifact.launches.length,
    creditsUsed: artifact.creditsUsed, legacyPriorCreditsUsed: artifact.legacyPriorCreditsUsed,
    artifact: path, resumed: false
  }, null, 2) + "\n");
  process.exit(0);
}

let lastRequestAt = 0;
let budgetStopped = false;
let fatalScanError = false;
for (let index = artifact.nextBucketIndex; index < maxLaunches; index += 1) {
  const start = startTime + Math.floor(index * (endTime - startTime) / maxLaunches);
  const end = startTime + Math.floor((index + 1) * (endTime - startTime) / maxLaunches);
  let bucket = artifact.buckets[index] ?? {
    index, startTime: start, endTime: end, status: "RUNNING" as const,
    paginationToken: null, pagesScanned: 0, scannedTransactions: 0,
    creditsUsed: 0, reason: null
  };
  if (bucket.status === "FOUND" || bucket.status === "EMPTY" ||
      (bucket.status === "INCOMPLETE" && !canContinueParsedLaunchBucket({
        paginationToken: bucket.paginationToken,
        pagesScanned: bucket.pagesScanned,
        maxPagesPerBucket
      }))) {
    artifact.nextBucketIndex = index + 1;
    continue;
  }
  if (bucket.startTime !== start || bucket.endTime !== end) throw new Error("Saved bucket time bounds are inconsistent.");
  bucket.status = "RUNNING";
  while (bucket.pagesScanned < maxPagesPerBucket) {
    // Reserve the maximum possible scan charge plus one raw transaction fetch.
    if (artifact.creditsUsed + 31 > maxCredits) {
      budgetStopped = true;
      artifact.status = "BUDGET_EXHAUSTED";
      artifact.buckets[index] = bucket;
      artifact.nextBucketIndex = index;
      artifact.reason = "Credit ceiling reached; this bucket cursor is saved for a later run.";
      break;
    }
    const wait = 250 - (Date.now() - lastRequestAt);
    if (lastRequestAt > 0 && wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    let page: ParsedCreateScanPage;
    try {
      page = await fetchPumpCreateScanPage({
        startTime: start, endTime: end, paginationToken: bucket.paginationToken
      }, { apiKey, maxScannedTransactions: 10_000 });
    } catch (error) {
      bucket.status = "RUNNING";
      bucket.reason = error instanceof Error ? error.message : "Parsed Events scan failed.";
      artifact.buckets[index] = bucket;
      artifact.nextBucketIndex = index;
      artifact.status = "INCOMPLETE";
      artifact.reason = bucket.reason;
      artifact.updatedAt = new Date().toISOString();
      await save(path, artifact);
      fatalScanError = true;
      break;
    }
    lastRequestAt = Date.now();
    artifact.creditsUsed += page.creditsCharged;
    bucket.creditsUsed += page.creditsCharged;
    bucket.pagesScanned += 1;
    bucket.scannedTransactions += page.scannedTransactions;
    artifact.pagesScanned += 1;
    artifact.signaturesScanned += page.scannedTransactions;
    bucket.paginationToken = page.paginationToken;
    if (page.data.length > 0) {
      const verified = await fetchFirstVerifiedParsedLaunch(page.data, {
        startTime: start, endTime: end
      }, { apiKey });
      artifact.creditsUsed += verified.attempts;
      bucket.creditsUsed += verified.attempts;
      artifact.transactionFetches += verified.attempts;
      if (verified.launch) {
        bucket.launch = verified.launch;
        bucket.status = "FOUND";
        bucket.reason = null;
        bucket.hasUnverifiedMatch = false;
        bucket.paginationToken = null;
        artifact.launches.push(verified.launch);
        artifact.buckets[index] = bucket;
        artifact.nextBucketIndex = index + 1;
        artifact.launches.sort((a, b) => a.blockTime - b.blockTime || a.signature.localeCompare(b.signature));
        artifact.updatedAt = new Date().toISOString();
        await save(path, artifact);
        break;
      }

      // A page can return several Create signatures. Try each bounded candidate
      // before moving to another scan page or declaring the bucket incomplete.
      bucket.hasUnverifiedMatch = true;
      bucket.reason = verified.reason;
      if (canContinueParsedLaunchBucket({
        paginationToken: bucket.paginationToken,
        pagesScanned: bucket.pagesScanned,
        maxPagesPerBucket
      })) {
        bucket.status = "RUNNING";
        artifact.buckets[index] = bucket;
        artifact.nextBucketIndex = index;
        artifact.updatedAt = new Date().toISOString();
        await save(path, artifact);
        continue;
      }
      bucket.status = "INCOMPLETE";
      artifact.status = "INCOMPLETE";
      artifact.reason = bucket.reason;
      artifact.buckets[index] = bucket;
      artifact.nextBucketIndex = index + 1;
      artifact.updatedAt = new Date().toISOString();
      await save(path, artifact);
      break;
    }
    if (canMarkParsedLaunchBucketEmpty({
      stoppedOn: page.stoppedOn,
      paginationToken: page.paginationToken,
      priorVerificationFailure: bucket.hasUnverifiedMatch === true
    })) {
      bucket.status = "EMPTY";
      bucket.reason = null;
      artifact.buckets[index] = bucket;
      artifact.nextBucketIndex = index + 1;
      artifact.updatedAt = new Date().toISOString();
      await save(path, artifact);
      break;
    }
    if (!page.paginationToken) {
      bucket.status = "INCOMPLETE";
      bucket.reason = bucket.reason ?? `Scan stopped on ${page.stoppedOn} without a continuation cursor.`;
      artifact.buckets[index] = bucket;
      artifact.nextBucketIndex = index + 1;
      artifact.status = "INCOMPLETE";
      artifact.reason = bucket.reason;
      artifact.updatedAt = new Date().toISOString();
      await save(path, artifact);
      break;
    }
    if (bucket.pagesScanned >= maxPagesPerBucket) {
      bucket.status = "INCOMPLETE";
      bucket.reason = `Bucket exceeded ${maxPagesPerBucket * 10_000} scanned transactions without a verified CreateEvent.`;
      artifact.buckets[index] = bucket;
      artifact.nextBucketIndex = index + 1;
      artifact.status = "INCOMPLETE";
      artifact.reason = bucket.reason;
      artifact.updatedAt = new Date().toISOString();
      await save(path, artifact);
      break;
    }
    artifact.buckets[index] = bucket;
    artifact.nextBucketIndex = index;
    artifact.updatedAt = new Date().toISOString();
    await save(path, artifact);
  }
  if (budgetStopped || fatalScanError) break;
  if (bucket.status === "INCOMPLETE") continue;
}
if (!budgetStopped && artifact.nextBucketIndex >= maxLaunches) {
  artifact.status = artifact.buckets.length === maxLaunches &&
    artifact.buckets.every((bucket, index) => bucket?.index === index &&
      (bucket.status === "FOUND" || bucket.status === "EMPTY"))
    ? "SAMPLE_COMPLETE" : "INCOMPLETE";
}
artifact.launches.sort((a, b) => a.blockTime - b.blockTime || a.signature.localeCompare(b.signature));
artifact.updatedAt = new Date().toISOString();
await save(path, artifact);
process.stdout.write(JSON.stringify({
  date, status: artifact.status, provider: artifact.provider,
  timeBuckets: maxLaunches, bucketsProcessed: artifact.nextBucketIndex,
  launches: artifact.launches.length,
  emptyBuckets: artifact.buckets.filter(bucket => bucket.status === "EMPTY").length,
  incompleteBuckets: artifact.buckets.filter(bucket => bucket.status === "INCOMPLETE").length,
  scanPages: artifact.pagesScanned, scannedTransactions: artifact.signaturesScanned,
  transactionFetches: artifact.transactionFetches,
  creditsUsed: artifact.creditsUsed, legacyPriorCreditsUsed: artifact.legacyPriorCreditsUsed,
  maxCredits, remainingCredits: maxCredits - artifact.creditsUsed,
  artifact: path, reason: artifact.reason,
  note: "Only verified Pump create/create_v2 launches are returned. Each time bucket is bounded to at most 50,000 scanned transactions; an exhausted bucket is marked INCOMPLETE, never EMPTY."
}, null, 2) + "\n");
if (artifact.status !== "SAMPLE_COMPLETE") process.exitCode = 2;
