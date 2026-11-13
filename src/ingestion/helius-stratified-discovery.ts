import { buildHeliusRpcUrl, PUMP_FUN_PROGRAM_ID } from "./helius.js";
import { decodeSuccessfulPumpTransaction, type PumpCreateEvent } from "./pump-events.js";

const CREATE_DISCRIMINATORS = ["0x181ec828051c0777", "0xd6904cec5f8b31b4"];
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;

export interface StratifiedLaunch {
  signature: string; slot: number; blockTime: number;
  event: PumpCreateEvent;
}
export interface StratifiedDiscoveryResult {
  status: "SAMPLE_COMPLETE" | "BUDGET_EXHAUSTED" | "INCOMPLETE";
  startTime: number; endTime: number; launches: StratifiedLaunch[];
  scanRequests: number; scanCredits: number; transactionFetches: number;
  creditsUsed: number; reason: string | null;
  sampling: { timeBuckets: number; perBucketEdges: number; strategy: string };
}
export async function discoverStratifiedPumpLaunches(
  startTime: number, endTime: number,
  config: { apiKey: string; maxCredits: number; fetcher?: typeof fetch; requestIntervalMs?: number }
): Promise<StratifiedDiscoveryResult> {
  if (!Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) || endTime - startTime !== 86_400 ||
      !config.apiKey.trim() || !Number.isSafeInteger(config.maxCredits) || config.maxCredits < 100) {
    throw new Error("Invalid 24-hour stratified discovery range or credit budget.");
  }
  const fetcher = config.fetcher ?? fetch;
  const interval = config.requestIntervalMs ?? 250;
  let creditsUsed = 0, scanRequests = 0, scanCredits = 0, transactionFetches = 0, lastRequestAt = 0;
  const signatures = new Map<string, { signature: string; slot: number; blockTime: number }>();
  const launches: StratifiedLaunch[] = [];
  const baseUrl = "https://mainnet.helius-rpc.com/v1/parsed-events/scan";
  const wait = async () => {
    const delay = interval - (Date.now() - lastRequestAt);
    if (lastRequestAt && delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    lastRequestAt = Date.now();
  };
  const fail = (status: StratifiedDiscoveryResult["status"], reason: string): StratifiedDiscoveryResult => ({
    status, startTime, endTime, launches, scanRequests, scanCredits, transactionFetches, creditsUsed, reason,
    sampling: { timeBuckets: 24, perBucketEdges: 2, strategy: "Two earliest and two latest create transactions per one-hour bucket." }
  });
  try {
    for (let bucket = 0; bucket < 24; bucket += 1) {
      const gte = startTime + bucket * 3600, lt = gte + 3600;
      for (const sortOrder of ["asc", "desc"] as const) {
        if (creditsUsed + 20 > config.maxCredits) return fail("BUDGET_EXHAUSTED", "Credit budget cannot cover the next bounded scan request.");
        await wait();
        const response = await fetcher(`${baseUrl}?api-key=${encodeURIComponent(config.apiKey)}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            address: PUMP_FUN_PROGRAM_ID,
            match: { programs: [{ programId: PUMP_FUN_PROGRAM_ID, discriminators: CREATE_DISCRIMINATORS, scope: "transaction" }] },
            time: { gte, lt }, sortOrder, returnShape: "signatures", limit: 100,
            budget: { maxScannedTransactions: 10_000 }
          })
        });
        scanRequests += 1;
        if (!response.ok) {
          const detail = await response.text();
          return fail("INCOMPLETE", response.status === 401 || response.status === 403
            ? "Helius Parsed Events Scan is unavailable for this API key/plan; it requires a paid plan. No expensive legacy scan was started."
            : `Parsed Events Scan HTTP ${response.status}: ${detail.slice(0, 240)}`);
        }
        const payload = await response.json() as Record<string, unknown>;
        const data = payload.data, scan = payload.scan as Record<string, unknown> | undefined;
        if (!Array.isArray(data) || !scan || !Number.isSafeInteger(scan.creditsCharged) ||
            !Number.isSafeInteger(scan.scannedTransactions) ||
            !["windowEnd", "limit"].includes(String(scan.stoppedOn))) {
          return fail("INCOMPLETE", "Parsed Events Scan did not prove the requested time-bucket edge was reached.");
        }
        const charged = scan.creditsCharged as number;
        if (charged < 0 || creditsUsed + charged > config.maxCredits) return fail("BUDGET_EXHAUSTED", "Actual Parsed Events Scan charge exceeds the configured credit ceiling.");
        creditsUsed += charged; scanCredits += charged;
        const edgeRows = sortOrder === "asc" ? data.slice(0, 2) : data.slice(-2);
        for (const raw of edgeRows) {
          if (!raw || typeof raw !== "object") return fail("INCOMPLETE", "Malformed parsed-event signature row.");
          const row = raw as Record<string, unknown>;
          if (typeof row.signature !== "string" || !SIGNATURE.test(row.signature) ||
              !Number.isSafeInteger(row.slot) || !Number.isSafeInteger(row.blockTime) ||
              (row.blockTime as number) < gte || (row.blockTime as number) >= lt) {
            return fail("INCOMPLETE", "Parsed-event signature failed signature/slot/time validation.");
          }
          signatures.set(row.signature, { signature: row.signature, slot: row.slot as number, blockTime: row.blockTime as number });
        }
      }
    }
    const selected = [...signatures.values()].sort((a,b) => a.blockTime-b.blockTime || a.slot-b.slot || a.signature.localeCompare(b.signature));
    for (const row of selected) {
      if (creditsUsed + 1 > config.maxCredits) return fail("BUDGET_EXHAUSTED", "Credit ceiling reached while verifying selected CreateEvents.");
      await wait();
      creditsUsed += 1; transactionFetches += 1;
      const response = await fetcher(buildHeliusRpcUrl(config.apiKey), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "pump-stratified-create", method: "getTransaction",
          params: [row.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }] })
      });
      if (!response.ok) return fail("INCOMPLETE", `Create transaction fetch returned HTTP ${response.status}.`);
      const envelope = await response.json() as Record<string, unknown>;
      if (envelope.error || !envelope.result || typeof envelope.result !== "object") return fail("INCOMPLETE", "A selected Create transaction is unavailable.");
      const tx = envelope.result as Record<string, unknown>;
      if (tx.slot !== row.slot || tx.blockTime !== row.blockTime) return fail("INCOMPLETE", "Create transaction slot/time does not match Parsed Events Scan.");
      const decoded = decodeSuccessfulPumpTransaction(tx);
      if (decoded.status !== "DECODED" || decoded.signature !== row.signature || decoded.slot !== row.slot) {
        return fail("INCOMPLETE", decoded.status === "DATA_INCOMPLETE" ? decoded.reason : "Selected Create transaction did not decode.");
      }
      for (const event of decoded.createEvents) {
        if (ADDRESS.test(event.mint) && ADDRESS.test(event.bondingCurve) &&
            Number(event.timestamp) >= startTime && Number(event.timestamp) < endTime) {
          launches.push({ ...row, event });
        }
      }
    }
    launches.sort((a,b) => a.blockTime-b.blockTime || Number(a.event.timestamp-b.event.timestamp) || a.signature.localeCompare(b.signature));
    if (!launches.length) return fail("SAMPLE_COMPLETE", "No CreateEvents were found in the stratified day sample.");
    return { status: "SAMPLE_COMPLETE", startTime, endTime, launches, scanRequests, scanCredits,
      transactionFetches, creditsUsed, reason: null,
      sampling: { timeBuckets: 24, perBucketEdges: 2, strategy: "Two earliest and two latest create transactions per one-hour bucket; maximum 96 candidates before activity screening." } };
  } catch (error) {
    return fail("INCOMPLETE", error instanceof Error ? error.message : "Stratified historical discovery failed.");
  }
}
