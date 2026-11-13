import { describe, expect, it } from "vitest";
import { assessHeliusGapRecovery } from "../src/ingestion/helius-gap-recovery.js";
import type { HeliusCoverageGap } from "../src/ingestion/helius-monitor.js";
import type { AddressSignatureInfo } from "../src/ingestion/helius-backfill.js";

const sig = (char: string) => char.repeat(64);
const gap: HeliusCoverageGap = {
  mint: "11111111111111111111111111111111",
  startedAt: "2026-11-13T10:00:00.000Z",
  endedAt: "2026-11-13T10:01:00.000Z",
  startSignature: sig("1"), startSlot: 100,
  endSignature: sig("3"), endSlot: 102
};
const records: AddressSignatureInfo[] = [
  { signature: sig("3"), slot: 102, blockTime: 1002, err: null },
  { signature: sig("2"), slot: 101, blockTime: 1001, err: { InstructionError: [0, "Custom"] } },
  { signature: sig("1"), slot: 100, blockTime: 1000, err: null }
];

describe("Helius WebSocket gap recovery", () => {
  it("requires both boundary anchors and archives every successful transaction", () => {
    expect(assessHeliusGapRecovery({
      gap, signatures: records,
      verifiedSignatures: [sig("3"), sig("1")],
      failedSignatures: [sig("2")],
      archivedSignatures: [sig("3"), sig("1")]
    })).toMatchObject({ recovered: true, recoveredSignatures: 3, reason: null });
  });

  it("does not treat a closed/reconnected socket as recovered without anchors", () => {
    expect(assessHeliusGapRecovery({
      gap: { ...gap, endSignature: null, endSlot: null },
      signatures: records, verifiedSignatures: [sig("3"), sig("1")],
      failedSignatures: [sig("2")], archivedSignatures: [sig("3"), sig("1")]
    }).recovered).toBe(false);
  });

  it("rejects an incomplete archive even when the entire signature list was scanned", () => {
    const result = assessHeliusGapRecovery({
      gap, signatures: records,
      verifiedSignatures: [sig("3"), sig("1")],
      failedSignatures: [sig("2")], archivedSignatures: [sig("3")]
    });
    expect(result.recovered).toBe(false);
    expect(result.reason).toContain("not verified and archived");
  });

  it("rejects newer records appearing after older records", () => {
    const result = assessHeliusGapRecovery({
      gap, signatures: [records[0]!, records[2]!, records[1]!],
      verifiedSignatures: [sig("3"), sig("1")],
      failedSignatures: [sig("2")], archivedSignatures: [sig("3"), sig("1")]
    });
    expect(result.recovered).toBe(false);
    expect(result.reason).toContain("newest-to-oldest");
  });

  it("rejects a scan missing either signature anchor", () => {
    const result = assessHeliusGapRecovery({
      gap, signatures: records.slice(0, 2),
      verifiedSignatures: [sig("3")], failedSignatures: [sig("2")],
      archivedSignatures: [sig("3")]
    });
    expect(result.recovered).toBe(false);
    expect(result.reason).toContain("both interruption boundary anchors");
  });
});
