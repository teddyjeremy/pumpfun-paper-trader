import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Keypair, SystemProgram, TransactionMessage } from "@solana/web3.js";
import { estimateSolanaTransactionFees } from "../src/ingestion/solana-fee-estimator.js";

const account = "11111111111111111111111111111111";
const now = Date.parse("2026-11-12T12:00:00.000Z");
const payer = Keypair.generate();
const recipient = Keypair.generate().publicKey;
const blockhash = "11111111111111111111111111111111";
function compiledMessageBase64(withPriorityPrice = false, versioned = false): string {
  const instructions = [
    ...(withPriorityPrice ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10 })] : []),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports: 1 })
  ];
  const transactionMessage = new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: blockhash, instructions
  });
  const bytes = versioned
    ? transactionMessage.compileToV0Message().serialize()
    : transactionMessage.compileToLegacyMessage().serialize();
  return Buffer.from(bytes).toString("base64");
}

function feeFetcher(options: {
  baseFee?: unknown;
  samples?: unknown;
  slot?: unknown;
  feeContextSlot?: unknown;
} = {}): typeof fetch {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string };
    let result: unknown;
    if (request.method === "getFeeForMessage") {
      result = { context: { slot: options.feeContextSlot ?? 110 }, value: Object.prototype.hasOwnProperty.call(options, "baseFee") ? options.baseFee : 5_000 };
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
  messageBase64: compiledMessageBase64(),
  writableAccountKeys: [account],
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


  it("rejects SetComputeUnitPrice in legacy and v0 compiled messages before RPC", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return new Response("{}");
    };
    const legacy = await estimateSolanaTransactionFees({
      ...baseInput, messageBase64: compiledMessageBase64(true, false), fetcher
    });
    const v0 = await estimateSolanaTransactionFees({
      ...baseInput, messageBase64: compiledMessageBase64(true, true), fetcher
    });
    expect(legacy.status).toBe("UNAVAILABLE");
    expect(v0.status).toBe("UNAVAILABLE");
    expect(calls).toBe(0);
  });


  it("rejects a compiled message whose explicit compute limit differs from the estimate", async () => {
    const transactionMessage = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports: 1 })
      ]
    });
    const messageBase64 = Buffer.from(transactionMessage.compileToLegacyMessage().serialize()).toString("base64");
    let calls = 0;
    const result = await estimateSolanaTransactionFees({
      ...baseInput, messageBase64,
      fetcher: async () => { calls += 1; return new Response("{}"); }
    });
    expect(result.status).toBe("UNAVAILABLE");
    expect(calls).toBe(0);
  });

  it("accepts a valid v0 message without SetComputeUnitPrice", async () => {
    const result = await estimateSolanaTransactionFees({
      ...baseInput, messageBase64: compiledMessageBase64(false, true),
      fetcher: feeFetcher()
    });
    expect(result.status).toBe("AVAILABLE");
  });

  it("fails closed when recent fee samples are insufficient", async () => {
    const result = await estimateSolanaTransactionFees({
      ...baseInput,
      fetcher: feeFetcher({ samples: [{ slot: 109, prioritizationFee: 10 }] })
    });
    expect(result.status).toBe("UNAVAILABLE");
  });

  it("fails closed when the exact-message base fee context is stale", async () => {
    const result = await estimateSolanaTransactionFees({
      ...baseInput,
      fetcher: feeFetcher({ feeContextSlot: 1, slot: 300 })
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

  it("fails closed when fee samples contain duplicate slots", async () => {
    const samples = Array.from({ length: 10 }, () => ({
      slot: 109,
      prioritizationFee: 10
    }));
    const result = await estimateSolanaTransactionFees({
      ...baseInput,
      fetcher: feeFetcher({ samples })
    });
    expect(result.status).toBe("UNAVAILABLE");
  });

  it("fails closed when the RPC response exceeds the bounded recent-slot window", async () => {
    const samples = Array.from({ length: 151 }, (_, index) => ({
      slot: 100 + index,
      prioritizationFee: index
    }));
    const result = await estimateSolanaTransactionFees({
      ...baseInput,
      fetcher: feeFetcher({ samples, slot: 250 })
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
      ...baseInput, writableAccountKeys: [account, account], fetcher
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
