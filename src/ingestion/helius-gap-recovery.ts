import type { AddressSignatureInfo } from "./helius-backfill.js";
import type { HeliusCoverageGap } from "./helius-monitor.js";

export interface HeliusGapRecoveryInput {
  gap: HeliusCoverageGap;
  /** Complete bonding-curve address history, newest to oldest, including both anchors. */
  signatures: readonly AddressSignatureInfo[];
  verifiedSignatures: readonly string[];
  failedSignatures: readonly string[];
  archivedSignatures: readonly string[];
}

export interface HeliusGapRecoveryResult {
  recovered: boolean;
  reason: string | null;
  recoveredSignatures: number;
}

/**
 * Prove a WebSocket interruption was backfilled. The scan must include both
 * notification anchors, preserve newest-to-oldest order, classify every
 * transaction in the inclusive interval, and archive every successful decode.
 * Merely reconnecting a socket or exhausting an unrelated launch-window scan
 * cannot recover an interruption.
 */
export function assessHeliusGapRecovery(
  input: HeliusGapRecoveryInput
): HeliusGapRecoveryResult {
  const { gap } = input;
  const startedAtMs = Date.parse(gap.startedAt);
  const endedAtMs = Date.parse(gap.endedAt ?? "");
  const addressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const signaturePattern = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;
  if (!addressPattern.test(gap.mint) || !gap.endedAt ||
      !Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs < startedAtMs ||
      !gap.startSignature || !signaturePattern.test(gap.startSignature) ||
      !gap.endSignature || !signaturePattern.test(gap.endSignature) ||
      gap.startSignature === gap.endSignature ||
      gap.startSlot === null || gap.startSlot === undefined ||
      gap.endSlot === null || gap.endSlot === undefined ||
      !Number.isSafeInteger(gap.startSlot) || !Number.isSafeInteger(gap.endSlot) ||
      gap.startSlot < 0 || gap.endSlot < gap.startSlot) {
    return { recovered: false, reason: "Interruption is missing valid, ordered time, address, signature, or slot anchors.", recoveredSignatures: 0 };
  }
  const all = input.signatures;
  const seen = new Set<string>();
  let previous: AddressSignatureInfo | null = null;
  for (const item of all) {
    if (!signaturePattern.test(item.signature) || seen.has(item.signature) ||
        !Number.isSafeInteger(item.slot) || item.slot < 0 ||
        (item.blockTime !== null && (!Number.isSafeInteger(item.blockTime) || item.blockTime < 0)) ||
        !(item.err === null || (typeof item.err === "object" && !Array.isArray(item.err)))) {
      return { recovered: false, reason: "Address-history scan contains duplicate or malformed signature records.", recoveredSignatures: 0 };
    }
    if (previous && (item.slot > previous.slot ||
        (item.blockTime !== null && previous.blockTime !== null && item.blockTime > previous.blockTime))) {
      return { recovered: false, reason: "Address-history scan is not newest-to-oldest.", recoveredSignatures: 0 };
    }
    seen.add(item.signature);
    previous = item;
  }
  const newerIndex = all.findIndex(item => item.signature === gap.endSignature);
  const olderIndex = all.findIndex(item => item.signature === gap.startSignature);
  if (newerIndex < 0 || olderIndex < 0 || newerIndex > olderIndex ||
      all[newerIndex]?.slot !== gap.endSlot || all[olderIndex]?.slot !== gap.startSlot) {
    return { recovered: false, reason: "Complete address-history scan did not prove both interruption boundary anchors.", recoveredSignatures: 0 };
  }
  const interval = all.slice(newerIndex, olderIndex + 1);
  const expected = new Set(interval.map(item => item.signature));
  const subset = (values: readonly string[], label: string): Set<string> | null => {
    const set = new Set(values);
    if (set.size !== values.length || [...set].some(signature => !expected.has(signature))) {
      return null;
    }
    return set;
  };
  const verified = subset(input.verifiedSignatures, "verified");
  const failed = subset(input.failedSignatures, "failed");
  const archived = subset(input.archivedSignatures, "archived");
  if (!verified || !failed || !archived) {
    return { recovered: false, reason: "Terminal outcome or archive evidence contains duplicates or signatures outside the gap interval.", recoveredSignatures: 0 };
  }
  if ([...verified].some(signature => failed.has(signature)) ||
      [...archived].some(signature => !verified.has(signature))) {
    return { recovered: false, reason: "Gap interval has conflicting outcomes or unverified archived transactions.", recoveredSignatures: 0 };
  }
  for (const item of interval) {
    if (item.err === null) {
      if (!verified.has(item.signature) || !archived.has(item.signature)) {
        return { recovered: false, reason: "A successful transaction in the interruption interval is not verified and archived.", recoveredSignatures: 0 };
      }
    } else if (!failed.has(item.signature)) {
      return { recovered: false, reason: "A failed transaction in the interruption interval lacks a confirmed failed outcome.", recoveredSignatures: 0 };
    }
  }
  return { recovered: true, reason: null, recoveredSignatures: interval.length };
}
