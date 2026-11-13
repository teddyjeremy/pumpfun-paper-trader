import { describe, expect, it } from "vitest";
import { collectCompleteWalletTransactionHistory } from "../src/ingestion/complete-wallet-transaction-history.js";

const mint = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const walletA = "11111111111111111111111111111111";
const walletB = "Vote111111111111111111111111111111111111111";
const funder = "SysvarRent111111111111111111111111111111111";
const signatureChar = (index: number) => "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[index % 58]!;
function response(result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: "test", result });
}
function transaction(signature: string, wallet: string, time: number) {
  return {
    signature, slot: time, blockTime: time, feePayer: funder,
    transaction: { message: {
      accountKeys: [{ pubkey: funder, signer: true }, { pubkey: wallet, signer: true }],
      instructions: [{
        program: "system",
        parsed: { type: "transfer", info: { source: funder, destination: wallet, lamports: 1_000_000 } }
      }]
    } },
    meta: { err: null, innerInstructions: [] }
  };
}

describe("complete paginated wallet transaction history", () => {
  it("requires cursor exhaustion and detects common funders and shared authorities", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      expect(body.method).toBe("getTransactionsForAddress");
      const wallet = String(body.params[0]);
      calls.push(wallet);
      return response({
        data: wallet === walletA
          ? [transaction("3".repeat(64), walletA, 1_794_484_800)]
          : [transaction("5".repeat(64), walletB, 1_794_484_810)]
      });
    };
    const result = await collectCompleteWalletTransactionHistory(mint, [walletA, walletB], {
      apiKey: "test-key", walletSetVerifiedComplete: true, fetcher
    });
    expect(result).toMatchObject({
      status: "OBSERVED",
      coverage: "FULL_WALLET_HISTORY_WITHIN_CONFIGURED_CAP",
      dataComplete: true,
      walletSetComplete: true,
      walletsRequested: 2,
      walletsChecked: 2,
      transactionsChecked: 2,
      pagesScanned: 2,
      estimatedCredits: 200
    });
    expect(result.walletsCovered).toEqual([walletA, walletB]);
    expect(result.links).toHaveLength(2);
    expect(result.links.map(link => link.evidence).flat()).toContain("COMMON_FUNDER");
    expect(result.links.map(link => link.evidence).flat()).toContain("SHARED_AUTHORITY");
    expect(calls).toEqual([walletA, walletB]);
  });

  it("traverses pagination and fails closed when the page cap leaves a cursor", async () => {
    let call = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { params: [string, Record<string, unknown>] };
      const [wallet, options] = body.params;
      call += 1;
      return response({
        data: [transaction(signatureChar(call) + "3".repeat(63), wallet, 1_794_484_800 + call)],
        ...(wallet === walletA && !options.paginationToken ? { paginationToken: "cursor-a" } : {})
      });
    };
    const result = await collectCompleteWalletTransactionHistory(mint, [walletA, walletB], {
      apiKey: "test-key", walletSetVerifiedComplete: true, maxPages: 1, fetcher
    });
    expect(result.status).toBe("DATA_INCOMPLETE");
    expect(result.dataComplete).toBe(false);
    expect(result.walletsCovered).toEqual([walletB]);
    expect(result.warnings.some(warning => warning.includes("exceeded the configured"))).toBe(true);
  });

  it("never clears risk when the buyer set itself is not independently complete", async () => {
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { params: [string] };
      return response({ data: [transaction("7".repeat(64), body.params[0], 1_794_484_800)] });
    };
    const result = await collectCompleteWalletTransactionHistory(mint, [walletA, walletB], {
      apiKey: "test-key", walletSetVerifiedComplete: false, fetcher
    });
    expect(result.status).toBe("DATA_INCOMPLETE");
    expect(result.walletSetComplete).toBe(false);
    expect(result.walletsCovered).toEqual([walletA, walletB]);
  });

  it("scans sixteen wallets for positive risk evidence but never claims an oversized set is complete", async () => {
    const wallets = [walletA, walletB, ...Array.from({ length: 15 }, (_, index) =>
      "Stake11111111111111111111111111111111111111".slice(0, 32) + String(index).padStart(2, "1"))];
    let calls = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { params: [string] };
      calls += 1;
      return response({ data: [transaction("8".repeat(64), body.params[0], 1_794_484_800 + calls)] });
    };
    const result = await collectCompleteWalletTransactionHistory(mint, wallets, {
      apiKey: "test-key", walletSetVerifiedComplete: true, fetcher
    });
    expect(result.status).toBe("DATA_INCOMPLETE");
    expect(result.walletSetComplete).toBe(false);
    expect(result.walletsChecked).toBe(16);
    expect(calls).toBe(16);
  });
});
