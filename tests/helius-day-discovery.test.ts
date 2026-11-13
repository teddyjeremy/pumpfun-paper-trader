import { describe, expect, it, vi } from "vitest";
import { discoverPumpLaunchesInTimeRange } from "../src/ingestion/helius-day-discovery.js";
import { PUMP_FUN_PROGRAM_ID } from "../src/ingestion/helius.js";

const signature = "5".repeat(88);
const discriminator = [27, 114, 169, 77, 222, 235, 99, 118];
const u32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const u64 = (n: bigint) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(i * 8)) & 255n));
const string = (value: string) => {
  const bytes = Array.from(new TextEncoder().encode(value));
  return [...u32(bytes.length), ...bytes];
};
const pubkey = (n: number) => Array.from({ length: 32 }, () => n);
function createLog(timestamp: number): string {
  const bytes = [
    ...discriminator, ...string("Backtest coin"), ...string("BACK"), ...string("https://example.invalid/coin.json"),
    ...pubkey(1), ...pubkey(2), ...pubkey(3), ...pubkey(4),
    ...u64(BigInt(timestamp)), ...u64(1_000_000n), ...u64(30_000_000_000n),
    ...u64(793_100_000_000_000n), ...u64(1_000_000_000_000_000n), ...pubkey(5),
    0, 0, ...pubkey(0), ...u64(0n), ...u64(0n), 0, 0
  ];
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return "Program data: " + btoa(binary);
}
function rpcResult(result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: "test", result });
}

describe("bounded historical Pump launch discovery", () => {
  it("discovers verified CreateEvents and stops at the explicit launch sample cap", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "getSignaturesForAddress") {
        expect(body.params[0]).toBe(PUMP_FUN_PROGRAM_ID);
        return rpcResult(body.params[1].before
          ? [{ signature: "6".repeat(88), slot: 800, blockTime: 1_600, err: null }]
          : [{ signature, slot: 900, blockTime: 1_800, err: null }]);
      }
      expect(body.method).toBe("getTransaction");
      return rpcResult({
        slot: 900, blockTime: 1_800,
        transaction: { signatures: [signature] },
        meta: { err: null, logMessages: [
          `Program ${PUMP_FUN_PROGRAM_ID} invoke [1]`,
          createLog(1_800)
        ] }
      });
    });
    const result = await discoverPumpLaunchesInTimeRange(1_700, 1_900, {
      apiKey: "test", fetcher, maxCredits: 10, maxLaunches: 1,
      pageSize: 1, requestIntervalMs: 0
    });
    expect(result).toMatchObject({
      status: "DAY_EXHAUSTED", pagesScanned: 2,
      signaturesScanned: 1, transactionFetches: 1, creditsUsed: 3
    });
    expect(result.launches).toHaveLength(1);
    expect(result.launches[0]?.event.name).toBe("Backtest coin");
    expect(result.launches[0]?.event.timestamp).toBe(1_800n);
  });

  it("stops rather than exceeding the explicit Helius credit ceiling", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "getSignaturesForAddress") {
        return rpcResult([{ signature, slot: 900, blockTime: 1_800, err: null }]);
      }
      return rpcResult({
        slot: 900, blockTime: 1_800,
        transaction: { signatures: [signature] },
        meta: { err: null, logMessages: [`Program ${PUMP_FUN_PROGRAM_ID} invoke [1]`] }
      });
    });
    const result = await discoverPumpLaunchesInTimeRange(1_700, 1_900, {
      apiKey: "test", fetcher, maxCredits: 2, maxLaunches: 10,
      pageSize: 1, requestIntervalMs: 0
    });
    expect(result.status).toBe("BUDGET_EXHAUSTED");
    expect(result.creditsUsed).toBe(2);
    expect(result.reason).toMatch(/ceiling/);
  });

  it("resumes from a durable cursor without re-scanning prior pages", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      rpcResult([{ signature: "7".repeat(88), slot: 899, blockTime: 1_699, err: null }]));
    const result = await discoverPumpLaunchesInTimeRange(1_700, 1_900, {
      apiKey: "test", fetcher, maxCredits: 20, maxLaunches: 10,
      pageSize: 1, requestIntervalMs: 0,
      resume: {
        before: "8".repeat(88), pagesScanned: 4, signaturesScanned: 20,
        transactionFetches: 12, creditsUsed: 16, launches: [],
        previousOldest: { signature: "8".repeat(88), slot: 900, blockTime: 1_800 }
      }
    });
    expect(result).toMatchObject({
      status: "DAY_EXHAUSTED", pagesScanned: 5, signaturesScanned: 20,
      transactionFetches: 12, creditsUsed: 17,
      nextBefore: "8".repeat(88),
      resumeBoundary: { signature: "8".repeat(88), slot: 900, blockTime: 1_800 }
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed on invalid ranges and malformed page order", async () => {
    const fetcher = vi.fn(async () => rpcResult([
      { signature, slot: 900, blockTime: 1_800, err: null },
      { signature: "6".repeat(88), slot: 901, blockTime: 1_801, err: null }
    ]));
    await expect(discoverPumpLaunchesInTimeRange(2_000, 1_000, {
      apiKey: "test", fetcher, maxCredits: 10, maxLaunches: 1
    })).rejects.toThrow(/Invalid historical/);
    const result = await discoverPumpLaunchesInTimeRange(1_700, 1_900, {
      apiKey: "test", fetcher, maxCredits: 10, maxLaunches: 10,
      pageSize: 2, requestIntervalMs: 0
    });
    expect(result.status).toBe("INCOMPLETE");
    expect(result.reason).toMatch(/newest-to-oldest/);
  });
});
