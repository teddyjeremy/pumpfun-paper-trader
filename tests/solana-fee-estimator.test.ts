import { describe, expect, it } from "vitest";
import { estimateSolanaTransactionFees } from "../src/ingestion/solana-fee-estimator.js";

const account = "11111111111111111111111111111111";
const now = Date.parse("2026-11-12T12:00:00.000Z");

function feeFetcher(options: {
  baseFee?: unknown;
  samples?: unknown;
  slot?: unknown;
} = {}): typeof fetch {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string };
    let result: unknown;
    if (request.method === "getFeeForMessage") {
      result = { context: { slot: 110 }, value: options.baseFee ?? 5_000 };
    } else if (request.method === "getRecentPrioritizationFees") {
      result = options.samples ?? Array.from({ length: 10 }, (_, index) => ({
        slot: 100 + index,
        prioritizationFee: index + 1
      }));
    } else {
      result = options.slot ?? 110;
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.method, result }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
}

const baseInput = {
  apiKey: "test-api-key",
  messageBase64: "AQ==",
  accountKeys: [account],
  computeUnitLimit: 200_000,
  nowMs: now
};

describe("Solana transaction fee estimator", () => {
  it("combines exact-message base fee with account-lock-specific p75 priority pricing", async () => {
    const result = await estimateSolanaTransactionFees({
      ...baseInput,
      fetcher: feeFetcher()
    });
    expect(result.status).toBe("AVAILABLE");
    if (result.status !== "AVAILABLE") return;
    expect(result.estimate.networkFeeLamports).toBe("5000");
    expect(result.estimate.priorityFeeMicroLamportsPerCu).toBe("8");
    expect(result.estimate.priorityFeeLamports).toBe("2");
    expect(result.estimate.sampleCount).toBe(10);
    expect(result.estimate.firstSampleSlot).toBe(100);
    expect(result.estimate.lastSampleSlot).toBe(109);
    expect(result.estimate.observedSlot).toBe(110);
    expect(result.estimate.feeMessageSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed when recent fee samples are insufficient", async () => {
    const result = await estimateSolanaTransactionFees({
      ...baseInput,
      fetcher: feeFetcher({ samples: [{ slot: 109, prioritizationFee: 10 }] })
    });
    expect(result.status).toBe("UNAVAILABLE");
  });

  it("fails closed when fee evidence is outside the recent slot window", async () => {
    const samples = Array.from({ length: 10 }, (_, index) => ({
      slot: 1,
      prioritizationFee: index + 1
    }));
    const result = await estimateSolanaTransactionFees({
      ...baseInput,
      fetcher: feeFetcher({ samples, slot: 1_000 })
    });
    expect(result.status).toBe("UNAVAILABLE");
  });

  it("rejects malformed messages, duplicate locks and invalid compute limits before RPC", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return new Response("{}");
    };
    const malformed = await estimateSolanaTransactionFees({
      ...baseInput, messageBase64: "not base64", fetcher
    });
    const duplicateLocks = await estimateSolanaTransactionFees({
      ...baseInput, accountKeys: [account, account], fetcher
    });
    const badLimit = await estimateSolanaTransactionFees({
      ...baseInput, computeUnitLimit: 1_400_001, fetcher
    });
    expect(malformed.status).toBe("UNAVAILABLE");
    expect(duplicateLocks.status).toBe("UNAVAILABLE");
    expect(badLimit.status).toBe("UNAVAILABLE");
    expect(calls).toBe(0);
  });

  it("fails closed when the exact transaction message has no base fee", async () => {
    const result = await estimateSolanaTransactionFees({
      ...baseInput,
      fetcher: feeFetcher({ baseFee: null })
    });
    expect(result.status).toBe("UNAVAILABLE");
  });
});
