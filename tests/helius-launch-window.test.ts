import { describe, expect, it, vi } from "vitest";
import { collectHistoricalLaunchWindow } from "../src/ingestion/helius-launch-window.js";
import { PUMP_FUN_PROGRAM_ID } from "../src/ingestion/helius.js";

const createSignature = "5".repeat(88);
const tradeSignature = "6".repeat(88);
const failedSignature = "7".repeat(88);
const mint = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const curve = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
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
function transaction(signature: string, slot: number, blockTime: number) {
  return {
    slot, blockTime, transaction: { signatures: [signature] },
    meta: { err: null, logMessages: [
      `Program ${PUMP_FUN_PROGRAM_ID} invoke [1]`, createLog(1_000)
    ] }
  };
}

describe("complete historical Pump launch-window collection", () => {
  it("reconciles every successful transaction and confirmed failed signature", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "getSignaturesForAddress") {
        expect(body.params[0]).toBe(curve);
        return rpcResult([
          { signature: tradeSignature, slot: 102, blockTime: 1_001, err: null },
          { signature: failedSignature, slot: 101, blockTime: 1_000, err: { InstructionError: [0, "Custom"] } },
          { signature: createSignature, slot: 100, blockTime: 1_000, err: null }
        ]);
      }
      const signature = body.params[0] as string;
      return rpcResult(transaction(signature, signature === tradeSignature ? 102 : 100,
        signature === tradeSignature ? 1_001 : 1_000));
    });
    const result = await collectHistoricalLaunchWindow({
      mint, bondingCurve: curve, createSignature, launchBlockTime: 1_000
    }, { apiKey: "test", maxCredits: 10, fetcher, requestIntervalMs: 0 });
    expect(result).toMatchObject({
      status: "COMPLETE", creditsUsed: 3, failedSignatures: [failedSignature],
      state: { status: "COMPLETE", signatures: expect.any(Array) }
    });
    expect(result.transactions.map(item => item.signature)).toEqual([tradeSignature, createSignature]);
  });

  it("counts a successfully decoded non-matching transaction as terminal coverage", async () => {
    const unrelatedSignature = "8".repeat(88);
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "getSignaturesForAddress") {
        return rpcResult([
          { signature: unrelatedSignature, slot: 101, blockTime: 1_001, err: null },
          { signature: createSignature, slot: 100, blockTime: 1_000, err: null }
        ]);
      }
      const signature = body.params[0] as string;
      if (signature === unrelatedSignature) {
        return rpcResult({
          slot: 101, blockTime: 1_001, transaction: { signatures: [signature] },
          meta: { err: null, logMessages: [`Program ${PUMP_FUN_PROGRAM_ID} invoke [1]`] }
        });
      }
      return rpcResult(transaction(signature, 100, 1_000));
    });
    const result = await collectHistoricalLaunchWindow({
      mint, bondingCurve: curve, createSignature, launchBlockTime: 1_000
    }, { apiKey: "test", maxCredits: 10, fetcher, requestIntervalMs: 0 });
    expect(result.status).toBe("COMPLETE");
    expect(result.ignoredSignatures).toEqual([unrelatedSignature]);
    expect(result.transactions.map(item => item.signature)).toEqual([createSignature]);
  });

  it("never exceeds the caller's remaining Helius credit budget", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "getSignaturesForAddress") {
        return rpcResult([
          { signature: tradeSignature, slot: 102, blockTime: 1_001, err: null },
          { signature: createSignature, slot: 100, blockTime: 1_000, err: null }
        ]);
      }
      const signature = body.params[0] as string;
      return rpcResult(transaction(signature, signature === tradeSignature ? 102 : 100,
        signature === tradeSignature ? 1_001 : 1_000));
    });
    const result = await collectHistoricalLaunchWindow({
      mint, bondingCurve: curve, createSignature, launchBlockTime: 1_000
    }, { apiKey: "test", maxCredits: 2, fetcher, requestIntervalMs: 0 });
    expect(result.status).toBe("BUDGET_EXHAUSTED");
    expect(result.creditsUsed).toBe(2);
  });
});
