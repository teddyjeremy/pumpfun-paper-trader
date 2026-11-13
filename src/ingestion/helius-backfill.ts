import { buildHeliusRpcUrl, type HeliusRpcConfig } from "./helius.js";

export interface AddressSignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

export type BackfillStatus =
  | "PENDING"
  | "PAGING"
  | "READY_TO_FETCH"
  | "COMPLETE"
  | "INCOMPLETE";

export interface HistoricalBackfillState {
  mint: string;
  bondingCurve: string;
  createSignature: string;
  launchBlockTime: number | null;
  horizonSeconds: number;
  maxSignatures: number;
  signatures: AddressSignatureInfo[];
  pagesScanned: number;
  scannedCount: number;
  before: string | null;
  lastPageSlot: number | null;
  lastPageBlockTime: number | null;
  status: BackfillStatus;
  reason: string | null;
}

export const DEFAULT_BACKFILL_HORIZON_SECONDS = 600;
export const DEFAULT_BACKFILL_MAX_SIGNATURES = 120;
export const DEFAULT_BACKFILL_PAGE_SIZE = 100;

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;

export function createHistoricalBackfillState(input: {
  mint: string;
  bondingCurve: string;
  createSignature: string;
  launchBlockTime: number | null;
  horizonSeconds?: number;
  maxSignatures?: number;
}): HistoricalBackfillState {
  if (!BASE58_ADDRESS.test(input.mint)) throw new Error("Invalid mint address.");
  if (!BASE58_ADDRESS.test(input.bondingCurve)) throw new Error("Invalid bonding-curve address.");
  if (!BASE58_SIGNATURE.test(input.createSignature)) throw new Error("Invalid create signature.");
  if (input.launchBlockTime !== null && (!Number.isSafeInteger(input.launchBlockTime) || input.launchBlockTime < 0)) {
    throw new Error("Invalid verified launch block time.");
  }
  const horizonSeconds = input.horizonSeconds ?? DEFAULT_BACKFILL_HORIZON_SECONDS;
  const maxSignatures = input.maxSignatures ?? DEFAULT_BACKFILL_MAX_SIGNATURES;
  if (!Number.isSafeInteger(horizonSeconds) || horizonSeconds < 60 || horizonSeconds > 1800) {
    throw new Error("Backfill horizon must be between 60 and 1800 seconds.");
  }
  if (!Number.isSafeInteger(maxSignatures) || maxSignatures < 1 || maxSignatures > 500) {
    throw new Error("Backfill signature cap must be between 1 and 500.");
  }
  return {
    mint: input.mint,
    bondingCurve: input.bondingCurve,
    createSignature: input.createSignature,
    launchBlockTime: input.launchBlockTime,
    horizonSeconds,
    maxSignatures,
    signatures: [],
    pagesScanned: 0,
    scannedCount: 0,
    before: null,
    lastPageSlot: null,
    lastPageBlockTime: null,
    status: input.launchBlockTime === null ? "INCOMPLETE" : "PENDING",
    reason: input.launchBlockTime === null ? "Verified launch block time is unavailable." : null
  };
}

/** Standard Solana RPC pagination request. One address per call. */
export function buildAddressSignaturesRequest(
  address: string,
  before: string | null,
  limit = DEFAULT_BACKFILL_PAGE_SIZE
): {
  jsonrpc: "2.0";
  id: string;
  method: "getSignaturesForAddress";
  params: [string, { commitment: "confirmed"; limit: number; before?: string }];
} {
  if (!BASE58_ADDRESS.test(address)) throw new Error("Invalid address.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("Signature page limit must be between 1 and 1000.");
  }
  if (before !== null && !BASE58_SIGNATURE.test(before)) throw new Error("Invalid pagination signature.");
  return {
    jsonrpc: "2.0",
    id: "pumpfun-historical-backfill",
    method: "getSignaturesForAddress",
    params: [address, {
      commitment: "confirmed",
      limit,
      ...(before ? { before } : {})
    }]
  };
}

export type BackfillPageResult =
  | { status: "CONTINUE"; state: HistoricalBackfillState; signaturesToFetch: AddressSignatureInfo[] }
  | { status: "COMPLETE"; state: HistoricalBackfillState; signaturesToFetch: AddressSignatureInfo[] }
  | { status: "INCOMPLETE"; state: HistoricalBackfillState; signaturesToFetch: AddressSignatureInfo[] };

/**
 * Consume one newest-to-oldest RPC page. A candidate is COMPLETE only when the
 * provider's create signature is reached and every signature inside the
 * configured launch horizon has a usable blockTime. Reaching a cap is never
 * silently interpreted as complete coverage.
 */
export function applyAddressSignaturesPage(
  current: HistoricalBackfillState,
  page: unknown
): BackfillPageResult {
  const incomplete = (reason: string): BackfillPageResult => ({
    status: "INCOMPLETE",
    state: { ...current, status: "INCOMPLETE", reason },
    signaturesToFetch: []
  });
  if (current.status === "INCOMPLETE" || current.status === "COMPLETE") {
    return {
      status: current.status,
      state: current,
      signaturesToFetch: []
    };
  }
  if (!Array.isArray(page)) return incomplete("Helius returned a malformed address-signature page.");

  const parsed: AddressSignatureInfo[] = [];
  for (const item of page) {
    if (!item || typeof item !== "object") return incomplete("A signature record is malformed.");
    const row = item as Record<string, unknown>;
    if (typeof row.signature !== "string" || !BASE58_SIGNATURE.test(row.signature) ||
        !Number.isSafeInteger(row.slot) || (row.slot as number) < 0 ||
        !(row.blockTime === null || (Number.isSafeInteger(row.blockTime) && (row.blockTime as number) >= 0)) ||
        !Object.prototype.hasOwnProperty.call(row, "err")) {
      return incomplete("A signature record lacks a valid signature, slot, block time, or transaction status.");
    }
    parsed.push({
      signature: row.signature,
      slot: row.slot as number,
      blockTime: row.blockTime as number | null,
      err: row.err
    });
  }
  if (parsed.length === 0) {
    return incomplete("The create signature was not found before the address history ended.");
  }

  if (new Set(parsed.map(item => item.signature)).size !== parsed.length) {
    return incomplete("Helius returned duplicate signatures within an address-history page.");
  }
  for (let index = 1; index < parsed.length; index += 1) {
    const newer = parsed[index - 1]!;
    const older = parsed[index]!;
    if (older.slot > newer.slot ||
        (newer.blockTime !== null && older.blockTime !== null && older.blockTime > newer.blockTime)) {
      return incomplete("Helius address-history page is not ordered newest-to-oldest.");
    }
  }

  if (current.before !== null && parsed.some(item => item.signature === current.before)) {
    return incomplete("Helius repeated a signature from the preceding pagination page.");
  }
  const firstOnPage = parsed[0]!;
  if ((current.lastPageSlot !== null && firstOnPage.slot > current.lastPageSlot) ||
      (current.lastPageBlockTime !== null && firstOnPage.blockTime !== null &&
        firstOnPage.blockTime > current.lastPageBlockTime)) {
    return incomplete("Helius address-history pagination moved backwards in page order.");
  }

  const launchTime = current.launchBlockTime;
  if (launchTime === null) return incomplete("Verified launch block time is unavailable.");
  const endTime = launchTime + current.horizonSeconds;
  const existing = new Set(current.signatures.map(item => item.signature));
  const additions: AddressSignatureInfo[] = [];
  let foundCreate = false;
  let crossedBeforeLaunch = false;
  let processedCount = 0;

  for (const item of parsed) {
    processedCount += 1;
    if (item.signature === current.createSignature) {
      if (item.blockTime === null || item.blockTime !== launchTime) {
        return incomplete("The verified create signature has a missing or mismatched blockTime.");
      }
      foundCreate = true;
      additions.push(item);
      break;
    }
    if (item.blockTime === null) {
      return incomplete("A null blockTime prevents proving launch-window coverage.");
    }
    if (item.blockTime < launchTime) {
      crossedBeforeLaunch = true;
      break;
    }
    if (item.blockTime <= endTime && !existing.has(item.signature)) additions.push(item);
  }

  if (crossedBeforeLaunch) {
    return incomplete("Address history crossed the launch time without finding the verified create signature.");
  }

  const merged = [...current.signatures, ...additions];
  // Count only records through the create signature. RPC pages can contain
  // newer transactions after the launch boundary; they are not part of this scan.
  const scannedCount = current.scannedCount + processedCount;
  if (merged.length > current.maxSignatures || scannedCount > current.maxSignatures) {
    return incomplete("Historical backfill reached its configured signature-scan cap before coverage was proven.");
  }

  const last = parsed[parsed.length - 1]!;
  if (foundCreate) {
    const state: HistoricalBackfillState = {
      ...current,
      signatures: merged,
      pagesScanned: current.pagesScanned + 1,
      scannedCount,
      before: null,
      lastPageSlot: parsed[parsed.length - 1]!.slot,
      lastPageBlockTime: parsed[parsed.length - 1]!.blockTime,
      status: "READY_TO_FETCH",
      reason: null
    };
    return { status: "COMPLETE", state: { ...state, status: "COMPLETE" }, signaturesToFetch: merged };
  }

  if (merged.length >= current.maxSignatures) {
    return incomplete("Historical signature cap reached before the create signature was found.");
  }

  const state: HistoricalBackfillState = {
    ...current,
    signatures: merged,
    pagesScanned: current.pagesScanned + 1,
    scannedCount,
    before: last.signature,
    status: "PAGING",
    reason: null
  };
  return { status: "CONTINUE", state, signaturesToFetch: [] };
}

function incompleteBackfillPage(current: HistoricalBackfillState, reason: string): BackfillPageResult {
  return {
    status: "INCOMPLETE",
    state: { ...current, status: "INCOMPLETE", reason },
    signaturesToFetch: []
  };
}

/** Fetch and consume one real Helius address-history page; state remains resumable between calls. */
export async function fetchHeliusAddressSignaturesPage(
  current: HistoricalBackfillState,
  config: HeliusRpcConfig
): Promise<BackfillPageResult> {
  if (current.status === "COMPLETE" || current.status === "INCOMPLETE") {
    return { status: current.status, state: current, signaturesToFetch: [] };
  }
  try {
    const request = buildAddressSignaturesRequest(current.bondingCurve, current.before);
    const fetcher = config.fetcher ?? fetch;
    const response = await fetcher(buildHeliusRpcUrl(config.apiKey), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    if (!response.ok) return incompleteBackfillPage(current, `Helius signature history returned HTTP ${response.status}.`);
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return incompleteBackfillPage(current, "Helius signature history returned malformed JSON.");
    }
    const envelope = payload as Record<string, unknown>;
    if (envelope.error) return incompleteBackfillPage(current, "Helius signature history returned a JSON-RPC error.");
    if (!Object.prototype.hasOwnProperty.call(envelope, "result") || !Array.isArray(envelope.result)) {
      return incompleteBackfillPage(current, "Helius signature history omitted its result page.");
    }
    return applyAddressSignaturesPage(current, envelope.result);
  } catch {
    return incompleteBackfillPage(current, "Helius signature history request failed before coverage could be verified.");
  }
}
