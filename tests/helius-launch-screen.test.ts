import { describe, expect, it, vi } from "vitest";
import { screenHistoricalLaunchActivity } from "../src/ingestion/helius-launch-screen.js";

const mint = "1".repeat(32);
const curve = "2".repeat(32);
const create = "5".repeat(88);
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const rows = (count: number) => Array.from({ length: count }, (_, index) => ({
  signature: "6".repeat(86) + alphabet[Math.floor(index / 58)] + alphabet[index % 58],
  slot: 1000 - index,
  blockTime: 10_000 - index * 10,
  err: null
}));
const response = (result: unknown) => Response.json({ jsonrpc: "2.0", id: "test", result });

describe("cheap historical launch activity screening", () => {
  it("counts successful curve activity and distinct time buckets without fetching transactions", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response([
      ...rows(8),
      { signature: create, slot: 900, blockTime: 9_900, err: null }
    ]));
    const result = await screenHistoricalLaunchActivity({
      mint, bondingCurve: curve, createSignature: create, launchBlockTime: 9_900
    }, { apiKey: "test", fetcher, pageSize: 100 });
    expect(result).toMatchObject({
      status: "SCREENED", signaturesObserved: 8, successfulSignatures: 8,
      failedSignatures: 0, activeTimeBuckets: 8, createSignatureSeen: true,
      sampleCapped: false
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.method).toBe("getSignaturesForAddress");
  });

  it("retains a capped high-activity sample as a lower bound", async () => {
    const result = await screenHistoricalLaunchActivity({
      mint, bondingCurve: curve, createSignature: create, launchBlockTime: 9_000
    }, { apiKey: "test", fetcher: async () => response(rows(100)), pageSize: 100 });
    expect(result.status).toBe("SCREENED");
    expect(result.sampleCapped).toBe(true);
    expect(result.createSignatureSeen).toBe(false);
    expect(result.reason).toMatch(/lower bound/);
  });

  it("fails closed on malformed ordering and never treats it as a dead coin", async () => {
    const result = await screenHistoricalLaunchActivity({
      mint, bondingCurve: curve, createSignature: create, launchBlockTime: 9_000
    }, { apiKey: "test", fetcher: async () => response([
      { signature: "6".repeat(88), slot: 900, blockTime: 9_100, err: null },
      { signature: "7".repeat(88), slot: 901, blockTime: 9_110, err: null }
    ]) });
    expect(result.status).toBe("INCOMPLETE");
    expect(result.activityScore).toBe(0);
  });
});
