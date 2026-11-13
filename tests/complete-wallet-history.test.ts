import { describe, expect, it } from "vitest";
import { collectCompleteWalletFundingEvidence } from "../src/ingestion/complete-wallet-history.js";

const mint = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const walletA = "11111111111111111111111111111111";
const walletB = "Vote111111111111111111111111111111111111111";
const funder = "SysvarRent111111111111111111111111111111111";

function response(result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: "test", result });
}
function tx(signature: string, destination: string, time: number) {
  return {
    signature, slot: time, blockTime: time,
    transaction: { message: { instructions: [{
      program: "system",
      parsed: { type: "transfer", info: { source: funder, destination, lamports: 1_000_000 } }
    }] } },
    meta: { err: null, innerInstructions: [] }
  };
}

describe("complete paginated wallet history", () => {
  it("requires full cursor exhaustion for every supplied wallet and detects repeated common funding", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      expect(body.method).toBe("getTransactionsForAddress");
      const wallet = String(body.params[0]);
      calls.push(wallet);
      return response({
        data: wallet === walletA
          ? [tx("3".repeat(64), walletA, 1_794_484_800), tx("4".repeat(64), walletA, 1_794_484_820)]
          : [tx("5".repeat(64), walletB, 1_794_484_810), tx("6".repeat(64), walletB, 1_794_484_830)]
      });
    };
    const result = await collectCompleteWalletFundingEvidence(mint, [walletA, walletB], {
      apiKey: "test-key", fetcher
    });
    expect(result).toMatchObject({
      status: "OBSERVED",
      coverage: "FULL_HISTORY_WITHIN_CONFIGURED_CAP",
      dataComplete: true,
      walletSetComplete: true,
      walletsRequested: 2,
      walletsChecked: 2,
      transactionsChecked: 4,
      pagesScanned: 2
    });
    expect(result.links).toHaveLength(1);
    expect(result.links[0]?.confidenceBps).toBe(7_000);
    expect(calls).toEqual([walletA, walletB]);
  });

  it("continues through every pagination cursor before marking a wallet complete", async () => {
    const calls: Array<{ wallet: string; cursor: unknown }> = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { params: [string, Record<string, unknown>] };
      const [wallet, options] = body.params;
      calls.push({ wallet, cursor: options.paginationToken ?? null });
      return response({
        data: [tx((calls.length + 10).toString().repeat(64), wallet, 1_794_484_800 + calls.length)],
        ...(wallet === walletA && !options.paginationToken ? { paginationToken: "cursor-a" } : {})
      });
    };
    const result = await collectCompleteWalletFundingEvidence(mint, [walletA, walletB], {
      apiKey: "test-key", fetcher
    });
    expect(result.dataComplete).toBe(true);
    expect(result.pagesScanned).toBe(3);
    expect(calls).toEqual([
      { wallet: walletA, cursor: null },
      { wallet: walletA, cursor: "cursor-a" },
      { wallet: walletB, cursor: null }
    ]);
  });

  it("fails closed when the page cap is reached with a continuation cursor", async () => {
    let call = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { params: [string, Record<string, unknown>] };
      const wallet = body.params[0];
      call += 1;
      return response({
        data: [tx((call + 10).toString().repeat(64), wallet, 1_794_484_800 + call)],
        paginationToken: `cursor-${call}`
      });
    };
    const result = await collectCompleteWalletFundingEvidence(mint, [walletA, walletB], {
      apiKey: "test-key", fetcher
    });
    expect(result.status).toBe("DATA_INCOMPLETE");
    expect(result.dataComplete).toBe(false);
    expect(result.coverage).toBe("INCOMPLETE_HISTORY");
    expect(result.warnings.some(warning => warning.includes("exceeded the configured"))).toBe(true);
  });

  it("does not claim the supplied wallet set is complete when it exceeds the bounded wallet count", async () => {
    const wallets = [walletA, walletB, "Stake11111111111111111111111111111111111111",
      "SysvarRent111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111",
      "SysvarS1otHashes111111111111111111111111111", "SysvarRecentB1ockHashes11111111111111111111",
      "Vote111111111111111111111111111111111111111", "ComputeBudget111111111111111111111111111111"];
    const fetcher: typeof fetch = async () => response({ data: [tx("7".repeat(64), walletA, 1_794_484_800)] });
    const result = await collectCompleteWalletFundingEvidence(mint, wallets, {
      apiKey: "test-key", fetcher
    });
    expect(result.status).toBe("DATA_INCOMPLETE");
    expect(result.walletSetComplete).toBe(false);
    expect(result.walletsRequested).toBe(9);
    expect(result.walletsChecked).toBe(8);
  });
});
