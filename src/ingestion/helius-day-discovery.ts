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
  status: "SAMPLE_CAP_REACHED" | "DAY_EXHAUSTED" | "BUDGET_EXHAUSTED" | "INCOMPLETE";
  startTime: number;
  endTime: number;
  launches: HistoricalLaunchDiscovery[];
  pagesScanned: number;
  signaturesScanned: number;
  transactionFetches: number;
  creditsUsed: number;
  nextBefore: string | null;
  reason: string | null;
}

export interface HistoricalDayDiscoveryConfig {
  apiKey: string;
  fetcher?: typeof fetch;
  maxCredits: number;
  maxLaunches: number;
  pageSize?: number;
  requestIntervalMs?: number;
}

/**
 * Discover Pump.fun CreateEvents in a bounded historical interval using only
 * standard Helius RPC. Every RPC call is counted as one Free-plan credit.
 *
 * The sample is newest-first: reaching maxLaunches is explicitly a sample,
 * never proof that the entire day was scanned. Missing transaction data,
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
    transactionFetches: number, creditsUsed: number, nextBefore: string | null
  ): HistoricalDayDiscoveryResult => ({
    status, startTime, endTime, launches, pagesScanned, signaturesScanned,
    transactionFetches, creditsUsed, nextBefore, reason
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
  let creditsUsed = 0;
  let pagesScanned = 0;
  let signaturesScanned = 0;
  let transactionFetches = 0;
  let before: string | null = null;
  let previousOldest: { signature: string; slot: number; blockTime: number } | null = null;
  const seen = new Set<string>();
  const launches: HistoricalLaunchDiscovery[] = [];
  let lastRequestAt = 0;

  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    if (creditsUsed >= config.maxCredits) throw new Error("CREDIT_BUDGET_EXHAUSTED");
    const wait = interval - (Date.now() - lastRequestAt);
    if (lastRequestAt > 0 && wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    const response = await fetcher(buildHeliusRpcUrl(config.apiKey), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "pumpfun-nov12-discovery", method, params })
    });
    lastRequestAt = Date.now();
    creditsUsed += 1;
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
    while (true) {
      const page = await rpc("getSignaturesForAddress", [
        PUMP_FUN_PROGRAM_ID,
        { commitment: "confirmed", limit: pageSize, ...(before ? { before } : {}) }
      ]);
      pagesScanned += 1;
      if (!Array.isArray(page)) throw new Error("Helius returned a malformed program-signature page.");
      if (page.length === 0) {
        return result("DAY_EXHAUSTED", null, launches, pagesScanned, signaturesScanned,
          transactionFetches, creditsUsed, before);
      }

      const parsed: Array<{ signature: string; slot: number; blockTime: number | null; err: unknown }> = [];
      for (const raw of page) {
        if (!raw || typeof raw !== "object") throw new Error("Malformed signature record.");
        const row = raw as Record<string, unknown>;
        if (typeof row.signature !== "string" || !SIGNATURE.test(row.signature) ||
            !Number.isSafeInteger(row.slot) || (row.slot as number) < 0 ||
            !(row.blockTime === null || (Number.isSafeInteger(row.blockTime) && (row.blockTime as number) >= 0)) ||
            !Object.prototype.hasOwnProperty.call(row, "err")) {
          throw new Error("Signature record lacks a valid signature, slot, blockTime or err field.");
        }
        if (seen.has(row.signature)) throw new Error("Duplicate signature across program-history pages.");
        seen.add(row.signature);
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
      if (previousOldest && (first.slot > previousOldest.slot ||
          (first.blockTime !== null && previousOldest.blockTime !== null && first.blockTime > previousOldest.blockTime))) {
        throw new Error("Program-signature pagination crossed its prior page boundary.");
      }

      for (const item of parsed) {
        if (item.blockTime === null) throw new Error("Null blockTime prevents proving the historical day boundary.");
        if (item.blockTime < startTime) {
          return result("DAY_EXHAUSTED", null, launches, pagesScanned, signaturesScanned,
            transactionFetches, creditsUsed, before);
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
          launches.push({ signature: item.signature, slot: item.slot, blockTime: item.blockTime, event });
          if (launches.length >= config.maxLaunches) {
            return result("SAMPLE_CAP_REACHED", null, launches, pagesScanned, signaturesScanned,
              transactionFetches, creditsUsed, item.signature);
          }
        }
      }
      const oldest = parsed[parsed.length - 1]!;
      previousOldest = { signature: oldest.signature, slot: oldest.slot, blockTime: oldest.blockTime! };
      before = oldest.signature;
      if (page.length < pageSize) {
        return result("DAY_EXHAUSTED", null, launches, pagesScanned, signaturesScanned,
          transactionFetches, creditsUsed, before);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Historical discovery failed.";
    const status = message === "CREDIT_BUDGET_EXHAUSTED" ? "BUDGET_EXHAUSTED" : "INCOMPLETE";
    return result(status, status === "BUDGET_EXHAUSTED"
      ? "Helius credit ceiling reached before the requested sample was complete."
      : message, launches, pagesScanned, signaturesScanned, transactionFetches, creditsUsed, before);
  }
}
