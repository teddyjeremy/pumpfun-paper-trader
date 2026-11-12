import { describe, expect, it } from "vitest";
import { collectWalletFundingEvidence } from "../src/ingestion/wallet-link-collector.js";

const mint = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const walletA = "11111111111111111111111111111111";
const walletB = "Vote111111111111111111111111111111111111111";
const funder = "SysvarRent111111111111111111111111111111111";
const signatures = ["3".repeat(64), "4".repeat(64), "5".repeat(64)];

function response(value: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "test", result: value }), { status: 200 });
}

describe("bounded wallet funding evidence collector", () => {
  it("requires repeated direct funding to both wallets before creating a 70% link", async () => {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      calls.push(body);
      if (body.method === "getSignaturesForAddress") {
        return response(signatures.map(signature => ({ signature })));
      }
      const wallet = body.params[0] === signatures[0] || body.params[0] === signatures[1] || body.params[0] === signatures[2]
        ? (calls.filter(call => call.method === "getSignaturesForAddress").length === 1 ? walletA : walletB)
        : walletA;
      return response({
        blockTime: 1794484800,
        transaction: { message: { instructions: [{
          program: "system", parsed: { type: "transfer", info: {
            source: funder, destination: wallet, lamports: 1_000_000
          } }
        }] } },
        meta: { innerInstructions: [] }
      });
    };
    const result = await collectWalletFundingEvidence(mint, [walletA, walletB], {
      apiKey: "test-key", fetcher
    });
    expect(result.status).toBe("OBSERVED");
    expect(result.walletsChecked).toBe(2);
    expect(result.transactionsChecked).toBe(6);
    expect(result.links).toHaveLength(1);
    expect(result.links[0]?.confidenceBps).toBe(7_000);
    expect(result.links[0]?.evidence).toContain("REPEATED_FUNDING");
    expect(result.coverage).toBe("RECENT_SIGNATURE_SAMPLE_ONLY");
  });

  it("never claims a clean result when fewer than two wallets are available", async () => {
    const result = await collectWalletFundingEvidence(mint, [walletA], { apiKey: "test-key" });
    expect(result.status).toBe("DATA_INCOMPLETE");
    expect(result.links).toEqual([]);
  });

  it("does not treat one common transfer per wallet as high-confidence linkage", async () => {
    let walletIndex = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (body.method === "getSignaturesForAddress") {
        walletIndex += 1;
        return response([{ signature: signatures[0] }]);
      }
      const destination = walletIndex === 1 ? walletA : walletB;
      return response({
        blockTime: 1794484800,
        transaction: { message: { instructions: [{
          program: "system", parsed: { type: "transfer", info: {
            source: funder, destination, lamports: 1_000_000
          } }
        }] } },
        meta: { innerInstructions: [] }
      });
    };
    const result = await collectWalletFundingEvidence(mint, [walletA, walletB], {
      apiKey: "test-key", fetcher
    });
    expect(result.links).toEqual([]);
  });
});
