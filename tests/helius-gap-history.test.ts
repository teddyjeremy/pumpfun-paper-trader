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

  it("returns a durable cursor at the page bound and resumes without rescanning earlier pages", async () => {
    const all = Array.from({ length: 12 }, (_, index) => row(String(index + 1), 200 - index));
    const requests: Array<string | null> = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      const before = request.params[1].before ?? null;
      requests.push(before);
      const start = before ? all.findIndex(item => item.signature === before) + 1 : 0;
      return Response.json({ result: all.slice(start, start + 1) });
    };
    const first = await fetchHeliusGapAddressHistory(
      "11111111111111111111111111111111",
      { ...gap, startSignature: all[11]!.signature, startSlot: all[11]!.slot,
        endSignature: all[0]!.signature, endSlot: all[0]!.slot },
      { apiKey: "test", fetcher }, fetcher, 1
    );
    expect(first.complete).toBe(false);
    if (first.complete) return;
    expect(first.resume?.before).toBe(all[9]!.signature);
    const second = await fetchHeliusGapAddressHistory(
      "11111111111111111111111111111111",
      { ...gap, startSignature: all[11]!.signature, startSlot: all[11]!.slot,
        endSignature: all[0]!.signature, endSlot: all[0]!.slot },
      { apiKey: "test", fetcher }, fetcher, 1, first.resume
    );
    expect(second.complete).toBe(true);
    if (second.complete) expect(second.signatures.map(item => item.signature))
      .toEqual(all.map(item => item.signature));
    expect(requests[10]).toBe(all[9]!.signature);
  });

  it("fails closed when the address history ends before the older anchor", async () => {
    const fetcher: typeof fetch = async () => Response.json({ result: [row("3", 102), row("2", 101)] });
    const result = await fetchHeliusGapAddressHistory("11111111111111111111111111111111", gap,
      { apiKey: "test", fetcher });
    expect(result.complete).toBe(false);
    if (!result.complete) expect(result.reason).toContain("ended before");
  });

  it("rejects malformed gap addresses, signatures and time intervals before making RPC calls", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return Response.json({ result: [] });
    };
    const invalidGaps = [
      { ...gap, mint: "not-an-address" },
      { ...gap, startSignature: "not-a-signature" },
      { ...gap, endedAt: "not-a-date" },
      { ...gap, startedAt: "2026-11-13T10:02:00.000Z" },
      { ...gap, endSlot: 99 }
    ];
    for (const invalidGap of invalidGaps) {
      const result = await fetchHeliusGapAddressHistory("11111111111111111111111111111111",
        invalidGap, { apiKey: "test", fetcher }, fetcher);
      expect(result.complete).toBe(false);
      expect(result.pagesScanned).toBe(0);
    }
    expect(calls).toBe(0);
  });

  it("rejects non-object transaction errors instead of classifying them as failed", async () => {
    const fetcher: typeof fetch = async () => Response.json({
      result: [{ ...row("3", 102), err: "failed" }]
    });
    const result = await fetchHeliusGapAddressHistory("11111111111111111111111111111111",
      gap, { apiKey: "test", fetcher }, fetcher);
    expect(result.complete).toBe(false);
    if (!result.complete) expect(result.reason).toContain("lacks a valid");
  });

  it("rejects reversed slot anchors", async () => {
    const fetcher: typeof fetch = async () => Response.json({ result: [row("3", 102), row("1", 101)] });
    const result = await fetchHeliusGapAddressHistory("11111111111111111111111111111111",
      { ...gap, startSlot: 100 }, { apiKey: "test", fetcher });
    expect(result.complete).toBe(false);
    if (!result.complete) expect(result.reason).toContain("slot");
  });
});
