import { buildAddressSignaturesRequest, type AddressSignatureInfo } from "./helius-backfill.js";
import { buildHeliusRpcUrl, type HeliusRpcConfig } from "./helius.js";
import type { HeliusCoverageGap } from "./helius-monitor.js";

export type HeliusGapHistoryResult =
  | { complete: true; signatures: AddressSignatureInfo[]; pagesScanned: number }
  | { complete: false; signatures: AddressSignatureInfo[]; pagesScanned: number; reason: string };

const PAGE_SIZE = 1_000;
const MAX_PAGES = 10;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;

/**
 * Independently scan the bonding-curve address from newest to oldest until
 * both WebSocket gap anchors are found. This is deliberately separate from
 * launch-window backfill: a launch scan cannot prove an arbitrary reconnect gap.
 */
export async function fetchHeliusGapAddressHistory(
  bondingCurve: string,
  gap: HeliusCoverageGap,
  config: HeliusRpcConfig,
  fetcher: typeof fetch = config.fetcher ?? fetch,
  pageSize = PAGE_SIZE
): Promise<HeliusGapHistoryResult> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE) {
    return { complete: false, signatures: [], pagesScanned: 0, reason: "Gap-history page size is outside the supported range." };
  }
  const startedAtMs = Date.parse(gap.startedAt);
  const endedAtMs = Date.parse(gap.endedAt ?? "");
  if (!ADDRESS.test(bondingCurve) || !ADDRESS.test(gap.mint) ||
      !gap.startSignature || !SIGNATURE.test(gap.startSignature) ||
      !gap.endSignature || !SIGNATURE.test(gap.endSignature) ||
      gap.startSignature === gap.endSignature ||
      !Number.isSafeInteger(gap.startSlot) || !Number.isSafeInteger(gap.endSlot) ||
      gap.startSlot < 0 || gap.endSlot < gap.startSlot ||
      !Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs < startedAtMs) {
    return { complete: false, signatures: [], pagesScanned: 0, reason: "Gap is missing valid address, ordered time interval, or closed signature/slot anchors." };
  }

  const records: AddressSignatureInfo[] = [];
  const seen = new Set<string>();
  let before: string | null = null;
  let previousPageOldest: AddressSignatureInfo | null = null;

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    let response: Response;
    try {
      response = await fetcher(buildHeliusRpcUrl(config.apiKey), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildAddressSignaturesRequest(bondingCurve, before, pageSize))
      });
    } catch {
      return { complete: false, signatures: records, pagesScanned: pageNumber, reason: "Helius gap-history request failed." };
    }
    if (!response.ok) {
      return { complete: false, signatures: records, pagesScanned: pageNumber, reason: `Helius gap-history returned HTTP ${response.status}.` };
    }

    let payload: unknown;
    try { payload = await response.json(); }
    catch {
      return { complete: false, signatures: records, pagesScanned: pageNumber, reason: "Helius gap-history returned invalid JSON." };
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { complete: false, signatures: records, pagesScanned: pageNumber, reason: "Helius gap-history response is malformed." };
    }
    const envelope = payload as Record<string, unknown>;
    if (envelope.error || !Array.isArray(envelope.result)) {
      return { complete: false, signatures: records, pagesScanned: pageNumber, reason: "Helius gap-history omitted a valid signature page." };
    }
    const page: AddressSignatureInfo[] = [];
    for (const value of envelope.result) {
      if (!value || typeof value !== "object") {
        return { complete: false, signatures: records, pagesScanned: pageNumber + 1, reason: "Gap-history page contains a malformed record." };
      }
      const row = value as Record<string, unknown>;
      if (typeof row.signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(row.signature) ||
          !Number.isSafeInteger(row.slot) || (row.slot as number) < 0 ||
          !(row.blockTime === null || (Number.isSafeInteger(row.blockTime) && (row.blockTime as number) >= 0)) ||
          !Object.prototype.hasOwnProperty.call(row, "err") ||
          !(row.err === null || (typeof row.err === "object" && !Array.isArray(row.err)))) {
        return { complete: false, signatures: records, pagesScanned: pageNumber + 1, reason: "Gap-history record lacks a valid signature, slot, blockTime, or status." };
      }
      if (seen.has(row.signature)) {
        return { complete: false, signatures: records, pagesScanned: pageNumber + 1, reason: "Gap-history pagination returned a duplicate signature." };
      }
      page.push({ signature: row.signature, slot: row.slot as number, blockTime: row.blockTime as number | null, err: row.err });
    }
    if (page.length === 0) {
      return { complete: false, signatures: records, pagesScanned: pageNumber + 1, reason: "Address history ended before both gap anchors were found." };
    }
    for (let i = 1; i < page.length; i += 1) {
      const newer = page[i - 1]!;
      const older = page[i]!;
      if (older.slot > newer.slot ||
          (newer.blockTime !== null && older.blockTime !== null && older.blockTime > newer.blockTime)) {
        return { complete: false, signatures: records, pagesScanned: pageNumber + 1, reason: "Gap-history page is not newest-to-oldest." };
      }
    }
    const newest = page[0]!;
    const oldest = page[page.length - 1]!;
    if (previousPageOldest &&
        (newest.slot > previousPageOldest.slot ||
          (newest.blockTime !== null && previousPageOldest.blockTime !== null &&
            newest.blockTime > previousPageOldest.blockTime))) {
      return { complete: false, signatures: records, pagesScanned: pageNumber + 1, reason: "Gap-history pagination crossed its page boundary out of order." };
    }
    for (const item of page) {
      seen.add(item.signature);
      records.push(item);
    }

    const endIndex = records.findIndex(item => item.signature === gap.endSignature);
    const startIndex = records.findIndex(item => item.signature === gap.startSignature);
    if (endIndex >= 0 && startIndex >= 0) {
      if (endIndex > startIndex ||
          records[endIndex]!.slot !== gap.endSlot ||
          records[startIndex]!.slot !== gap.startSlot) {
        return { complete: false, signatures: records, pagesScanned: pageNumber + 1, reason: "Gap anchors are reversed or their slots do not match." };
      }
      return {
        complete: true,
        signatures: records.slice(endIndex, startIndex + 1),
        pagesScanned: pageNumber + 1
      };
    }

    previousPageOldest = oldest;
    before = oldest.signature;
    if (page.length < pageSize) {
      return { complete: false, signatures: records, pagesScanned: pageNumber + 1, reason: "Address history ended before both gap anchors were found." };
    }
  }
  return { complete: false, signatures: records, pagesScanned: MAX_PAGES, reason: "Gap-history scan exceeded its 10,000-signature safety bound." };
}
