import { buildHeliusRpcUrl, PUMP_FUN_PROGRAM_ID } from "./helius.js";
import { decodeSuccessfulPumpTransaction, type PumpCreateEvent } from "./pump-events.js";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;

export interface HistoricalLaunchDiscovery {
  signature: string;
  slot: number;
  blockTime: number;
  event: PumpCreateEvent;
}

export interface HistoricalDayDiscoveryResult {
  status: "DAY_EXHAUSTED" | "BUDGET_EXHAUSTED" | "INCOMPLETE";
  startTime: number;
  endTime: number;
  launches: HistoricalLaunchDiscovery[];
  pagesScanned: number;
  signaturesScanned: number;
  transactionFetches: number;
  creditsUsed: number;
  nextBefore: string | null;
  reason: string | null;
  resumeBoundary: { signature: string; slot: number; blockTime: number } | null;
}

export interface HistoricalDayDiscoveryConfig {
  apiKey: string;
  fetcher?: typeof fetch;
  maxCredits: number;
  maxLaunches: number;
  pageSize?: number;
  requestIntervalMs?: number;
  resume?: {
    before: string;
    pagesScanned: number;
    signaturesScanned: number;
    transactionFetches: number;
    creditsUsed: number;
    launches: HistoricalLaunchDiscovery[];
    previousOldest?: { signature: string; slot: number; blockTime: number };
  };
}

/**
 * Discover Pump.fun CreateEvents in a bounded historical interval using only
 * standard Helius RPC. Every RPC call is counted as one Free-plan credit.
 *
 * The standard-RPC fallback walks newest-to-oldest and retains at most one
 * launch per equal-width time bucket. DAY_EXHAUSTED proves the full interval was traversed;
 * budget exhaustion never returns a complete day sample. Missing transaction data,
 * pagination anomalies and decoder failures stop the scan as INCOMPLETE.
 */
export async function discoverPumpLaunchesInTimeRange(
  startTime: number,
  endTime: number,
  config: HistoricalDayDiscoveryConfig
): Promise<HistoricalDayDiscoveryResult> {
  const pageSize = config.pageSize ?? 1_000;
  const interval = config.requestIntervalMs ?? 250;
  const result = (status: HistoricalDayDiscoveryResult["status"], reason: string | null,
    launches: HistoricalLaunchDiscovery[], pagesScanned: number, signaturesScanned: number,
    transactionFetches: number, creditsUsed: number, nextBefore: string | null,
    resumeBoundary: { signature: string; slot: number; blockTime: number } | null
  ): HistoricalDayDiscoveryResult => ({
    status, startTime, endTime, launches, pagesScanned, signaturesScanned,
    transactionFetches, creditsUsed, nextBefore, reason, resumeBoundary
  });

  if (!Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) ||
      startTime < 0 || endTime <= startTime ||
      !config.apiKey.trim() ||
      !Number.isSafeInteger(config.maxCredits) || config.maxCredits < 2 ||
      !Number.isSafeInteger(config.maxLaunches) || config.maxLaunches < 1 ||
      config.maxLaunches > 100 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000 ||
      !Number.isFinite(interval) || interval < 0 || interval > 10_000) {
    throw new Error("Invalid historical discovery range or safety limits.");
  }

  const fetcher = config.fetcher ?? fetch;
  const resume = config.resume;
  if (resume && (!SIGNATURE.test(resume.before) ||
      !Number.isSafeInteger(resume.pagesScanned) || resume.pagesScanned < 0 ||
      !Number.isSafeInteger(resume.signaturesScanned) || resume.signaturesScanned < 0 ||
      !Number.isSafeInteger(resume.transactionFetches) || resume.transactionFetches < 0 ||
      !Number.isSafeInteger(resume.creditsUsed) || resume.creditsUsed < 0 || resume.creditsUsed >= config.maxCredits ||
      !Array.isArray(resume.launches) || resume.launches.length > config.maxLaunches ||
      (resume.previousOldest !== undefined && (resume.previousOldest.signature !== resume.before ||
        !Number.isSafeInteger(resume.previousOldest.slot) || resume.previousOldest.slot < 0 ||
        !Number.isSafeInteger(resume.previousOldest.blockTime) || resume.previousOldest.blockTime < 0)))) {
    throw new Error("Invalid historical discovery resume checkpoint.");
  }
  let creditsUsed = resume?.creditsUsed ?? 0;
  let pagesScanned = resume?.pagesScanned ?? 0;
  let signaturesScanned = resume?.signaturesScanned ?? 0;
  let transactionFetches = resume?.transactionFetches ?? 0;
  let before: string | null = resume?.before ?? null;
  let previousOldest: { signature: string; slot: number; blockTime: number } | null = resume?.previousOldest ?? null;
  const launches: HistoricalLaunchDiscovery[] = resume?.launches ? [...resume.launches] : [];
  let lastRequestAt = 0;

  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    if (creditsUsed >= config.maxCredits) throw new Error("CREDIT_BUDGET_EXHAUSTED");
    const wait = interval - (Date.now() - lastRequestAt);
    if (lastRequestAt > 0 && wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    // Count attempted requests before I/O so transport failures cannot understate spend.
    creditsUsed += 1;
    lastRequestAt = Date.now();
    const response = await fetcher(buildHeliusRpcUrl(config.apiKey), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "pumpfun-nov12-discovery", method, params })
    });
    if (!response.ok) throw new Error(`HELIUS_HTTP_${response.status}`);
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Malformed Helius JSON-RPC envelope.");
    const envelope = payload as Record<string, unknown>;
    if (envelope.error || !Object.prototype.hasOwnProperty.call(envelope, "result")) {
      throw new Error("Helius JSON-RPC returned an error or omitted result.");
    }
    return envelope.result;
  };

  try {
    if (before && !previousOldest) {
      const boundary = await rpc("getTransaction", [before, {
        encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0
      }]);
      transactionFetches += 1;
      if (!boundary || typeof boundary !== "object" ||
          !Number.isSafeInteger((boundary as Record<string, unknown>).slot) ||
          !Number.isSafeInteger((boundary as Record<string, unknown>).blockTime) ||
          ((boundary as Record<string, unknown>).blockTime as number) < 0) {
        throw new Error("Could not validate the previous discovery cursor boundary.");
      }
      previousOldest = { signature: before,
        slot: (boundary as Record<string, unknown>).slot as number,
        blockTime: (boundary as Record<string, unknown>).blockTime as number };
    }
    while (true) {
      const page = await rpc("getSignaturesForAddress", [
        PUMP_FUN_PROGRAM_ID,
        { commitment: "confirmed", limit: pageSize, ...(before ? { before } : {}) }
      ]);
      pagesScanned += 1;
      if (!Array.isArray(page)) throw new Error("Helius returned a malformed program-signature page.");
      if (page.length === 0) {
        return result("DAY_EXHAUSTED", null, launches, pagesScanned, signaturesScanned,
          transactionFetches, creditsUsed, before, previousOldest);
      }

      const parsed: Array<{ signature: string; slot: number; blockTime: number | null; err: unknown }> = [];
      const pageSeen = new Set<string>();
      for (const raw of page) {
        if (!raw || typeof raw !== "object") throw new Error("Malformed signature record.");
        const row = raw as Record<string, unknown>;
        if (typeof row.signature !== "string" || !SIGNATURE.test(row.signature) ||
            !Number.isSafeInteger(row.slot) || (row.slot as number) < 0 ||
            !(row.blockTime === null || (Number.isSafeInteger(row.blockTime) && (row.blockTime as number) >= 0)) ||
            !Object.prototype.hasOwnProperty.call(row, "err")) {
          throw new Error("Signature record lacks a valid signature, slot, blockTime or err field.");
        }
        if (pageSeen.has(row.signature)) throw new Error("Duplicate signature within program-history page.");
        pageSeen.add(row.signature);
        parsed.push({ signature: row.signature, slot: row.slot as number,
          blockTime: row.blockTime as number | null, err: row.err });
      }
      for (let index = 1; index < parsed.length; index += 1) {
        const newer = parsed[index - 1]!;
        const older = parsed[index]!;
        if (older.slot > newer.slot ||
            (newer.blockTime !== null && older.blockTime !== null && older.blockTime > newer.blockTime)) {
          throw new Error("Program-signature history is not ordered newest-to-oldest.");
        }
      }
      const first = parsed[0]!;
      if (previousOldest && first.signature === previousOldest.signature) {
        throw new Error("Helius repeated the previous page cursor instead of advancing.");
      }
      if (previousOldest && (first.slot > previousOldest.slot ||
          (first.blockTime !== null && previousOldest.blockTime !== null && first.blockTime > previousOldest.blockTime))) {
        throw new Error("Program-signature pagination crossed its prior page boundary.");
      }

      for (const item of parsed) {
        if (item.blockTime === null) throw new Error("Null blockTime prevents proving the historical day boundary.");
        if (item.blockTime < startTime) {
          return result("DAY_EXHAUSTED", null, launches, pagesScanned, signaturesScanned,
            transactionFetches, creditsUsed, before, previousOldest);
        }
        if (item.blockTime >= endTime) continue;
        signaturesScanned += 1;
        if (item.err !== null) continue;

        const transaction = await rpc("getTransaction", [item.signature, {
          encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0
        }]);
        transactionFetches += 1;
        if (transaction === null || !transaction || typeof transaction !== "object") {
          throw new Error("A successful program signature has no retrievable transaction.");
        }
        const tx = transaction as Record<string, unknown>;
        if (tx.slot !== item.slot || tx.blockTime !== item.blockTime) {
          throw new Error("Transaction slot or blockTime disagrees with the signature index.");
        }
        const meta = tx.meta as Record<string, unknown> | undefined;
        if (!meta || meta.err !== null) throw new Error("Transaction execution status disagrees with the signature index.");
        const logs = meta.logMessages;
        if (!Array.isArray(logs) || !logs.every(line => typeof line === "string")) {
          throw new Error("Successful transaction is missing complete log messages.");
        }
        if (!(logs as string[]).some(line => line.includes(`Program ${PUMP_FUN_PROGRAM_ID} invoke`))) {
          throw new Error("Program address history returned a transaction without a Pump.fun invocation.");
        }
        const decoded = decodeSuccessfulPumpTransaction(transaction);
        if (decoded.status !== "DECODED" || decoded.signature !== item.signature || decoded.slot !== item.slot) {
          throw new Error(decoded.status === "DATA_INCOMPLETE"
            ? decoded.reason : "Decoded transaction identity does not match the signature index.");
        }
        for (const event of decoded.createEvents) {
          const eventTime = Number(event.timestamp);
          if (eventTime < startTime || eventTime >= endTime ||
              !ADDRESS.test(event.mint) || !ADDRESS.test(event.bondingCurve)) continue;
          // Keep one deterministic launch from each equal-width time bucket.
          // This prevents the sample from being dominated by the earliest part
          // of the day while keeping memory and deep-replay costs strictly bounded.
          const bucket = Math.min(config.maxLaunches - 1,
            Math.floor((eventTime - startTime) * config.maxLaunches / (endTime - startTime)));
          const occupied = launches.some(existing =>
            Math.min(config.maxLaunches - 1,
              Math.floor((Number(existing.event.timestamp) - startTime) * config.maxLaunches / (endTime - startTime))) === bucket
          );
          if (!occupied) launches.push({ signature: item.signature, slot: item.slot, blockTime: item.blockTime, event });
          launches.sort((a, b) => a.blockTime - b.blockTime ||
            Number(a.event.timestamp - b.event.timestamp) || a.signature.localeCompare(b.signature));
        }
      }
      const oldest = parsed[parsed.length - 1]!;
      previousOldest = { signature: oldest.signature, slot: oldest.slot, blockTime: oldest.blockTime! };
      before = oldest.signature;
      if (page.length < pageSize) {
        return result("DAY_EXHAUSTED", null, launches, pagesScanned, signaturesScanned,
          transactionFetches, creditsUsed, before, previousOldest);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Historical discovery failed.";
    const status = message === "CREDIT_BUDGET_EXHAUSTED" ? "BUDGET_EXHAUSTED" : "INCOMPLETE";
    return result(status, status === "BUDGET_EXHAUSTED"
      ? "Helius credit ceiling reached before the requested sample was complete."
      : message, launches, pagesScanned, signaturesScanned, transactionFetches, creditsUsed, before, previousOldest);
  }
}
