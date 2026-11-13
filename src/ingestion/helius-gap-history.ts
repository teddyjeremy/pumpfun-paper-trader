import { buildAddressSignaturesRequest, type AddressSignatureInfo } from "./helius-backfill.js";
import { buildHeliusRpcUrl, type HeliusRpcConfig } from "./helius.js";
import type { HeliusCoverageGap } from "./helius-monitor.js";

export interface HeliusGapHistoryResume {
  before: string;
  signatures: AddressSignatureInfo[];
  previousPageOldest: AddressSignatureInfo;
  pagesScanned: number;
}

export type HeliusGapHistoryResult =
  | { complete: true; signatures: AddressSignatureInfo[]; pagesScanned: number }
  | { complete: false; signatures: AddressSignatureInfo[]; pagesScanned: number; reason: string;
      resume?: HeliusGapHistoryResume };

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
  pageSize = PAGE_SIZE,
  resume?: HeliusGapHistoryResume
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
      gap.startSlot === null || gap.startSlot === undefined ||
      gap.endSlot === null || gap.endSlot === undefined ||
      !Number.isSafeInteger(gap.startSlot) || !Number.isSafeInteger(gap.endSlot) ||
      gap.startSlot < 0 || gap.endSlot < gap.startSlot ||
      !Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs < startedAtMs) {
    return { complete: false, signatures: [], pagesScanned: 0, reason: "Gap is missing valid address, ordered time interval, or closed signature/slot anchors." };
  }

  const records: AddressSignatureInfo[] = resume ? [...resume.signatures] : [];
  const seen = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const item = records[index]!;
    if (!SIGNATURE.test(item.signature) || seen.has(item.signature) ||
        !Number.isSafeInteger(item.slot) || item.slot < 0 ||
        !(item.blockTime === null || (Number.isSafeInteger(item.blockTime) && item.blockTime >= 0)) ||
        !(item.err === null || (typeof item.err === "object" && !Array.isArray(item.err)))) {
      return { complete: false, signatures: [], pagesScanned: 0, reason: "Persisted gap-history resume contains malformed or duplicate records." };
    }
    if (index > 0) {
      const newer = records[index - 1]!;
      if (item.slot > newer.slot ||
          (newer.blockTime !== null && item.blockTime !== null && item.blockTime > newer.blockTime)) {
        return { complete: false, signatures: [], pagesScanned: 0, reason: "Persisted gap-history resume is not newest-to-oldest." };
      }
    }
    seen.add(item.signature);
  }
  const lastRecord = records[records.length - 1] ?? null;
  if (resume && (!SIGNATURE.test(resume.before) || !lastRecord ||
      resume.before !== lastRecord.signature ||
      resume.previousPageOldest.signature !== lastRecord.signature ||
      resume.previousPageOldest.slot !== lastRecord.slot ||
      resume.previousPageOldest.blockTime !== lastRecord.blockTime ||
      !(resume.previousPageOldest.blockTime === null ||
        (Number.isSafeInteger(resume.previousPageOldest.blockTime) && resume.previousPageOldest.blockTime >= 0)) ||
      !(resume.previousPageOldest.err === null ||
        (typeof resume.previousPageOldest.err === "object" && !Array.isArray(resume.previousPageOldest.err))) ||
      !Number.isSafeInteger(resume.pagesScanned) || resume.pagesScanned < 1)) {
    return { complete: false, signatures: [], pagesScanned: 0, reason: "Persisted gap-history resume cursor does not match its page boundary." };
  }
  let before: string | null = resume?.before ?? null;
  let previousPageOldest: AddressSignatureInfo | null = resume?.previousPageOldest ?? null;
  const priorPages = resume?.pagesScanned ?? 0;

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    let response: Response;
    try {
      response = await fetcher(buildHeliusRpcUrl(config.apiKey), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildAddressSignaturesRequest(bondingCurve, before, pageSize))
      });
    } catch {
      return { complete: false, signatures: records, pagesScanned: priorPages + pageNumber, reason: "Helius gap-history request failed." };
    }
    if (!response.ok) {
      return { complete: false, signatures: records, pagesScanned: priorPages + pageNumber, reason: `Helius gap-history returned HTTP ${response.status}.` };
    }

    let payload: unknown;
    try { payload = await response.json(); }
    catch {
      return { complete: false, signatures: records, pagesScanned: priorPages + pageNumber, reason: "Helius gap-history returned invalid JSON." };
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { complete: false, signatures: records, pagesScanned: priorPages + pageNumber, reason: "Helius gap-history response is malformed." };
    }
    const envelope = payload as Record<string, unknown>;
    if (envelope.error || !Array.isArray(envelope.result)) {
      return { complete: false, signatures: records, pagesScanned: priorPages + pageNumber, reason: "Helius gap-history omitted a valid signature page." };
    }
    const page: AddressSignatureInfo[] = [];
    for (const value of envelope.result) {
      if (!value || typeof value !== "object") {
        return { complete: false, signatures: records, pagesScanned: priorPages + pageNumber + 1, reason: "Gap-history page contains a malformed record." };
      }
      const row = value as Record<string, unknown>;
      if (typeof row.signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(row.signature) ||
          !Number.isSafeInteger(row.slot) || (row.slot as number) < 0 ||
          !(row.blockTime === null || (Number.isSafeInteger(row.blockTime) && (row.blockTime as number) >= 0)) ||
          !Object.prototype.hasOwnProperty.call(row, "err") ||
          !(row.err === null || (typeof row.err === "object" && !Array.isArray(row.err)))) {
        return { complete: false, signatures: records, pagesScanned: priorPages + pageNumber + 1, reason: "Gap-history record lacks a valid signature, slot, blockTime, or status." };
      }
      if (seen.has(row.signature)) {
        return { complete: false, signatures: records, pagesScanned: priorPages + pageNumber + 1, reason: "Gap-history pagination returned a duplicate signature." };
      }
      page.push({ signature: row.signature, slot: row.slot as number, blockTime: row.blockTime as number | null, err: row.err });
    }
    if (page.length === 0) {
      return { complete: false, signatures: records, pagesScanned: priorPages + pageNumber + 1, reason: "Address history ended before both gap anchors were found." };
    }
    for (let i = 1; i < page.length; i += 1) {
      const newer = page[i - 1]!;
      const older = page[i]!;
      if (older.slot > newer.slot ||
          (newer.blockTime !== null && older.blockTime !== null && older.blockTime > newer.blockTime)) {
        return { complete: false, signatures: records, pagesScanned: priorPages + pageNumber + 1, reason: "Gap-history page is not newest-to-oldest." };
      }
    }
    const newest = page[0]!;
    const oldest = page[page.length - 1]!;
    if (previousPageOldest &&
        (newest.slot > previousPageOldest.slot ||
          (newest.blockTime !== null && previousPageOldest.blockTime !== null &&
            newest.blockTime > previousPageOldest.blockTime))) {
      return { complete: false, signatures: records, pagesScanned: priorPages + pageNumber + 1, reason: "Gap-history pagination crossed its page boundary out of order." };
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
        return { complete: false, signatures: records, pagesScanned: priorPages + pageNumber + 1, reason: "Gap anchors are reversed or their slots do not match." };
      }
      return {
        complete: true,
        signatures: records.slice(endIndex, startIndex + 1),
        pagesScanned: priorPages + pageNumber + 1
      };
    }

    previousPageOldest = oldest;
    before = oldest.signature;
    if (page.length < pageSize) {
      return { complete: false, signatures: records, pagesScanned: priorPages + pageNumber + 1, reason: "Address history ended before both gap anchors were found." };
    }
  }
  const oldest = previousPageOldest;
  if (!oldest || !before) {
    return { complete: false, signatures: records, pagesScanned: priorPages + MAX_PAGES, reason: "Gap-history scan reached its page bound without a resumable page boundary." };
  }
  return {
    complete: false, signatures: records, pagesScanned: priorPages + MAX_PAGES,
    reason: "Gap-history scan reached its per-run page bound; resume from the persisted cursor.",
    resume: {
      before, signatures: records, previousPageOldest: oldest,
      pagesScanned: priorPages + MAX_PAGES
    }
  };
}
