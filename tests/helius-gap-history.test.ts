import { describe, expect, it } from "vitest";
import { fetchHeliusGapAddressHistory } from "../src/ingestion/helius-gap-history.js";
import type { HeliusCoverageGap } from "../src/ingestion/helius-monitor.js";

const sig = (char: string) => char.repeat(64);
const gap: HeliusCoverageGap = {
  mint: "11111111111111111111111111111111",
  startedAt: "2026-11-13T10:00:00.000Z",
  endedAt: "2026-11-13T10:01:00.000Z",
  startSignature: sig("1"), startSlot: 100,
  endSignature: sig("3"), endSlot: 102
};
const row = (char: string, slot: number) => ({
  signature: sig(char), slot, blockTime: slot + 900, err: null
});

describe("Helius gap address-history scan", () => {
  it("scans newest-to-oldest and returns the inclusive anchored interval", async () => {
    const fetcher: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      const before = request.params[1].before;
      return Response.json({ result: before
        ? [row("1", 100), row("5", 99)]
        : [row("4", 103), row("3", 102), row("2", 101)] });
    };
    const result = await fetchHeliusGapAddressHistory("11111111111111111111111111111111", gap,
      { apiKey: "test", fetcher }, fetcher, 3);
    expect(result).toMatchObject({ complete: true, pagesScanned: 2 });
    if (result.complete) expect(result.signatures.map(item => item.signature)).toEqual([sig("3"), sig("2"), sig("1")]);
  });

  it("fails closed when the address history ends before the older anchor", async () => {
    const fetcher: typeof fetch = async () => Response.json({ result: [row("3", 102), row("2", 101)] });
    const result = await fetchHeliusGapAddressHistory("11111111111111111111111111111111", gap,
      { apiKey: "test", fetcher });
    expect(result.complete).toBe(false);
    if (!result.complete) expect(result.reason).toContain("ended before");
  });

  it("rejects reversed slot anchors", async () => {
    const fetcher: typeof fetch = async () => Response.json({ result: [row("3", 102), row("1", 101)] });
    const result = await fetchHeliusGapAddressHistory("11111111111111111111111111111111",
      { ...gap, startSlot: 100 }, { apiKey: "test", fetcher });
    expect(result.complete).toBe(false);
    if (!result.complete) expect(result.reason).toContain("slot");
  });
});
