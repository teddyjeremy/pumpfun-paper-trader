import { buildHeliusRpcUrl, PUMP_FUN_PROGRAM_ID } from "./helius.js";
import { decodeSuccessfulPumpTransaction, type PumpCreateEvent } from "./pump-events.js";

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface ParsedCreateSignature {
  signature: string;
  slot: number;
  blockTime: number;
}

export interface ParsedCreateScanPage {
  data: ParsedCreateSignature[];
  paginationToken: string | null;
  stoppedOn: "windowEnd" | "limit" | "budget" | "deadline";
  scannedTransactions: number;
  matchedTransactions: number;
  creditsCharged: number;
}

export interface VerifiedParsedLaunch {
  signature: string;
  slot: number;
  blockTime: number;
  event: PumpCreateEvent;
}


/** A failed selected transaction can be skipped only while the scan supplied a safe next-page cursor. */
export function canContinueParsedLaunchBucket(input: {
  paginationToken: string | null;
  pagesScanned: number;
  maxPagesPerBucket: number;
}): boolean {
  return typeof input.paginationToken === "string" && input.paginationToken.length > 0 &&
    Number.isSafeInteger(input.pagesScanned) && input.pagesScanned >= 0 &&
    Number.isSafeInteger(input.maxPagesPerBucket) && input.maxPagesPerBucket > 0 &&
    input.pagesScanned < input.maxPagesPerBucket;
}

/** A bucket is EMPTY only when the provider reached its end with no failed matches. */
export function canMarkParsedLaunchBucketEmpty(input: {
  stoppedOn: string;
  paginationToken: string | null;
  priorVerificationFailure: boolean;
}): boolean {
  return input.stoppedOn === "windowEnd" && input.paginationToken === null &&
    input.priorVerificationFailure === false;
}

/** Find the earliest incomplete bucket whose saved cursor can still be resumed. */
export function findFirstResumableParsedLaunchBucket(
  buckets: Array<{ status: string; paginationToken: string | null; pagesScanned: number }>,
  maxPagesPerBucket: number
): number | null {
  const index = buckets.findIndex(bucket => (bucket.status === "INCOMPLETE" || bucket.status === "RUNNING") &&
    canContinueParsedLaunchBucket({
      paginationToken: bucket.paginationToken,
      pagesScanned: bucket.pagesScanned,
      maxPagesPerBucket
    }));
  return index < 0 ? null : index;
}

/**
 * Ask Helius's server-side Parsed Events Scan to search only Pump create/create_v2
 * instructions inside a narrow timestamp bucket. It avoids crawling unrelated
 * program history and only returns matching signatures.
 */
export async function fetchPumpCreateScanPage(input: {
  startTime: number;
  endTime: number;
  paginationToken?: string | null;
}, config: { apiKey: string; fetcher?: typeof fetch; maxScannedTransactions?: number }): Promise<ParsedCreateScanPage> {
  if (!config.apiKey.trim() || !Number.isSafeInteger(input.startTime) ||
      !Number.isSafeInteger(input.endTime) || input.startTime < 0 || input.endTime <= input.startTime ||
      (input.paginationToken !== undefined && input.paginationToken !== null &&
        (typeof input.paginationToken !== "string" || input.paginationToken.length < 1 || input.paginationToken.length > 256))) {
    throw new Error("Invalid Parsed Events launch scan input.");
  }
  const maxScanned = config.maxScannedTransactions ?? 10_000;
  if (!Number.isSafeInteger(maxScanned) || maxScanned < 1 || maxScanned > 10_000) {
    throw new Error("Parsed Events scan budget must be between 1 and 10,000 transactions.");
  }
  const response = await (config.fetcher ?? fetch)(
    `https://mainnet.helius-rpc.com/v1/parsed-events/scan?api-key=${encodeURIComponent(config.apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: PUMP_FUN_PROGRAM_ID,
        match: {
          programs: [{
            programId: PUMP_FUN_PROGRAM_ID,
            instructions: ["create", "create_v2"]
          }]
        },
        time: { gte: input.startTime, lt: input.endTime },
        status: "succeeded",
        commitment: "confirmed",
        sortOrder: "asc",
        returnShape: "signatures",
        limit: 1,
        budget: { maxScannedTransactions: maxScanned },
        ...(input.paginationToken ? { paginationToken: input.paginationToken } : {})
      })
    }
  );
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403 || response.status === 404
      ? "Helius Parsed Events Scan is unavailable for this API key/plan. Refusing to fall back to the expensive unbounded standard-RPC crawl."
      : `Helius Parsed Events Scan returned HTTP ${response.status}.`;
    throw new Error(message);
  }
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Malformed Parsed Events Scan response.");
  }
  const result = payload as Record<string, unknown>;
  const scan = result.scan && typeof result.scan === "object" && !Array.isArray(result.scan)
    ? result.scan as Record<string, unknown> : null;
  const validationFailures: string[] = [];
  if (!Array.isArray(result.data)) validationFailures.push("data is not an array");
  if (!scan) {
    validationFailures.push("scan summary is missing or malformed");
  } else {
    if (!["windowEnd", "limit", "budget", "deadline"].includes(String(scan.stoppedOn))) {
      validationFailures.push(`stoppedOn=${String(scan.stoppedOn ?? "missing")}`);
    }
    if (!Number.isSafeInteger(scan.scannedTransactions) || (scan.scannedTransactions as number) < 0) {
      validationFailures.push(`scannedTransactions=${String(scan.scannedTransactions ?? "missing")}`);
    }
    if (!Number.isSafeInteger(scan.matchedTransactions) || (scan.matchedTransactions as number) < 0) {
      validationFailures.push(`matchedTransactions=${String(scan.matchedTransactions ?? "missing")}`);
    }
    if (!Number.isSafeInteger(scan.creditsCharged) ||
        (scan.creditsCharged as number) < 10 || (scan.creditsCharged as number) > 20) {
      validationFailures.push(`creditsCharged=${String(scan.creditsCharged ?? "missing")} (expected integer 10-20)`);
    }
  }
  const paginationTokenValid = result.paginationToken === undefined || result.paginationToken === null ||
    (typeof result.paginationToken === "string" && result.paginationToken.length > 0 && result.paginationToken.length <= 256);
  if (!paginationTokenValid) {
    const token = result.paginationToken;
    validationFailures.push(`paginationToken type=${typeof token}, length=${typeof token === "string" ? token.length : "n/a"}`);
  }
  if (validationFailures.length > 0 || !scan || !Array.isArray(result.data)) {
    throw new Error(`Parsed Events Scan response failed validation: ${validationFailures.join("; ").slice(0, 320)}.`);
  }
  const data: ParsedCreateSignature[] = [];
  for (const raw of result.data) {
    if (!raw || typeof raw !== "object") throw new Error("Malformed parsed Create signature.");
    const row = raw as Record<string, unknown>;
    if (typeof row.signature !== "string" || !SIGNATURE.test(row.signature) ||
        !Number.isSafeInteger(row.slot) || (row.slot as number) < 0 ||
        !Number.isSafeInteger(row.blockTime) || (row.blockTime as number) < input.startTime ||
        (row.blockTime as number) >= input.endTime) {
      throw new Error("Parsed Create signature has invalid identity or falls outside its time bucket.");
    }
    data.push({ signature: row.signature, slot: row.slot as number, blockTime: row.blockTime as number });
  }
  for (let index = 1; index < data.length; index += 1) {
    if (data[index]!.blockTime < data[index - 1]!.blockTime) {
      throw new Error("Parsed Create signatures are not in ascending time order.");
    }
  }
  return {
    data,
    paginationToken: typeof result.paginationToken === "string" ? result.paginationToken : null,
    stoppedOn: scan.stoppedOn as ParsedCreateScanPage["stoppedOn"],
    scannedTransactions: scan.scannedTransactions as number,
    matchedTransactions: scan.matchedTransactions as number,
    creditsCharged: scan.creditsCharged as number
  };
}

/** Fetch and independently decode only a selected Create transaction. */
export async function fetchVerifiedParsedLaunch(
  input: ParsedCreateSignature,
  bucket: { startTime: number; endTime: number },
  config: { apiKey: string; fetcher?: typeof fetch }
): Promise<VerifiedParsedLaunch> {
  if (!SIGNATURE.test(input.signature) || !Number.isSafeInteger(input.slot) || input.slot < 0 ||
      !Number.isSafeInteger(input.blockTime) || input.blockTime < bucket.startTime ||
      input.blockTime >= bucket.endTime || !config.apiKey.trim()) {
    throw new Error("Invalid selected Create signature evidence.");
  }
  const response = await (config.fetcher ?? fetch)(buildHeliusRpcUrl(config.apiKey), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "pumpfun-selected-create", method: "getTransaction",
      params: [input.signature, {
        encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0
      }]
    })
  });
  if (!response.ok) throw new Error(`Selected Create transaction returned HTTP ${response.status}.`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Selected Create transaction response is malformed.");
  }
  const result = (payload as Record<string, unknown>).result;
  if (!result || typeof result !== "object") throw new Error("Selected Create transaction is unavailable.");
  const tx = result as Record<string, unknown>;
  if (tx.slot !== input.slot || tx.blockTime !== input.blockTime) {
    throw new Error("Selected Create transaction slot or block time disagrees with Parsed Events signature evidence.");
  }
  const meta = tx.meta as Record<string, unknown> | undefined;
  if (!meta || meta.err !== null || !Array.isArray(meta.logMessages) ||
      !meta.logMessages.every(line => typeof line === "string")) {
    throw new Error("Selected Create transaction did not return successful complete logs.");
  }
  const decoded = decodeSuccessfulPumpTransaction(result);
  if (decoded.status !== "DECODED" || decoded.signature !== input.signature || decoded.slot !== input.slot) {
    throw new Error(decoded.status === "DATA_INCOMPLETE"
      ? decoded.reason : "Selected Create transaction identity failed independent decoding.");
  }
  const event = decoded.createEvents.find(item =>
    ADDRESS.test(item.mint) && ADDRESS.test(item.bondingCurve) &&
    Number(item.timestamp) >= bucket.startTime && Number(item.timestamp) < bucket.endTime
  );
  if (!event) throw new Error("Parsed create instruction did not produce a valid Pump CreateEvent in its time bucket.");
  return { ...input, event };
}
