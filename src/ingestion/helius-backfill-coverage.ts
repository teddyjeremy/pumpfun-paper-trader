import type { HistoricalBackfillState } from "./helius-backfill.js";

export interface HistoricalDecodeCoverageInput {
  state: Pick<HistoricalBackfillState, "status" | "signatures">;
  queueSignatures: readonly string[];
  verifiedSignatures: readonly string[];
  failedSignatures: readonly string[];
  archivedSignatures: readonly string[];
  incompleteReason: string | null;
  queueCursor: number;
}
export interface HistoricalDecodeCoverage {
  complete: boolean;
  reason: string | null;
  verifiedTransactionCount: number;
}

/**
 * Decode coverage is complete only when every scanned signature has a terminal
 * verified or confirmed-failed outcome, every verified transaction is archived,
 * and no signature remains queued or marked incomplete.
 */
export function assessHistoricalDecodeCoverage(
  input: HistoricalDecodeCoverageInput
): HistoricalDecodeCoverage {
  const signatures = input.state.signatures.map(item => item.signature);
  if (signatures.some(signature => typeof signature !== "string" || signature.length === 0) ||
      new Set(signatures).size !== signatures.length) {
    throw new Error("Historical signature window contains an empty or duplicate signature.");
  }
  const expected = new Set(signatures);
  const validSubset = (values: readonly string[], label: string): Set<string> => {
    const result = new Set(values);
    if (result.size !== values.length || [...result].some(value => !expected.has(value))) {
      throw new Error(`Historical decode ${label} set contains duplicates or an unrelated signature.`);
    }
    return result;
  };
  const verified = validSubset(input.verifiedSignatures, "verified");
  const failed = validSubset(input.failedSignatures, "failed");
  const archived = validSubset(input.archivedSignatures, "archived");
  const queued = validSubset(input.queueSignatures, "queued");
  if ([...verified].some(signature => failed.has(signature))) {
    throw new Error("A historical signature cannot be both verified and confirmed failed.");
  }
  if ([...archived].some(signature => !verified.has(signature))) {
    throw new Error("A historical transaction cannot be archived before successful verification.");
  }
  if ([...queued].some(signature => verified.has(signature) || failed.has(signature))) {
    throw new Error("A terminal historical signature cannot remain in the decode queue.");
  }
  if (!Number.isSafeInteger(input.queueCursor) || input.queueCursor < 0 ||
      input.queueCursor > signatures.length) {
    throw new Error("Historical decode queue cursor is invalid.");
  }
  const verifiedNotArchived = [...verified].some(signature => !archived.has(signature));
  const unresolved = signatures.filter(signature => !verified.has(signature) && !failed.has(signature));
  const complete = input.state.status === "COMPLETE" &&
    input.queueCursor >= signatures.length &&
    queued.size === 0 &&
    input.incompleteReason === null &&
    unresolved.length === 0 &&
    !verifiedNotArchived;
  const reason = complete ? null :
    input.state.status !== "COMPLETE" ? "Historical signature-window coverage is incomplete." :
    input.incompleteReason ??
    (input.queueCursor < signatures.length ? "Historical signatures remain to be queued." :
      queued.size > 0 ? "Historical signatures remain in the transaction queue." :
        unresolved.length > 0 ? "One or more historical signatures have no verified or confirmed-failed terminal outcome." :
          verifiedNotArchived ? "Verified historical transactions remain unarchived in PostgreSQL." :
            "Historical transaction decoding has not been confirmed complete.");
  return { complete, reason, verifiedTransactionCount: verified.size };
}
