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

  const launchTime = current.launchBlockTime;
  if (launchTime === null) return incomplete("Verified launch block time is unavailable.");
  const endTime = launchTime + current.horizonSeconds;
  const existing = new Set(current.signatures.map(item => item.signature));
  const additions: AddressSignatureInfo[] = [];
  let foundCreate = false;
  let crossedBeforeLaunch = false;

  for (const item of parsed) {
    if (item.signature === current.createSignature) {
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
  const scannedCount = current.scannedCount + parsed.length;
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
