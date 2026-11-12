import { describe, expect, it, vi } from "vitest";
import { fetchHolderConcentration } from "../src/ingestion/holder-risk.js";

const mint = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const accountA = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
const accountB = "LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY";
const ownerA = "So11111111111111111111111111111111111111112";
const ownerB = "11111111111111111111111111111111";

function rpcFixture(amounts: string[], owners: string[], mints = amounts.map(() => mint)) {
  const accounts = amounts.map((amount, index) => ({
    data: {
      parsed: {
        info: {
          mint: mints[index],
          owner: owners[index],
          tokenAmount: { amount }
        }
      }
    }
  }));
  return [
    Response.json({ jsonrpc: "2.0", result: { value: { amount: "1000000", decimals: 6 } } }),
    Response.json({
      jsonrpc: "2.0",
      result: { value: amounts.map((amount, index) => ({
        address: index === 0 ? accountA : accountB,
        amount
      })) }
    }),
    Response.json({ jsonrpc: "2.0", result: { value: accounts } })
  ];
}

function mockFetcher(responses: Response[]) {
  let index = 0;
  return vi.fn(async () => responses[index++] ?? Response.json({ error: { code: -1 } }));
}

describe("top-holder concentration screening", () => {
  it("rejects when observed accounts aggregate to more than 20% for one owner", async () => {
    const fetcher = mockFetcher(rpcFixture(["150000", "100001"], [ownerA, ownerA]));
    const result = await fetchHolderConcentration(mint, { apiKey: "test-key", fetcher });
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") return;
    expect(result.snapshot).toMatchObject({
      mint, observedTokenAccounts: 2, observedOwners: 1,
      largestObservedTokenAccountShareBps: 1_500,
      largestObservedOwnerShareBps: 2_501,
      status: "REJECT_OBSERVED",
      coverage: "TOP_20_TOKEN_ACCOUNTS_ONLY",
      dataComplete: false
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not reject at exactly 20% and never reports a complete pass from top-20 data", async () => {
    const fetcher = mockFetcher(rpcFixture(["200000", "100000"], [ownerA, ownerB]));
    const result = await fetchHolderConcentration(mint, { apiKey: "test-key", fetcher });
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") return;
    expect(result.snapshot.largestObservedOwnerShareBps).toBe(2_000);
    expect(result.snapshot.status).toBe("UNKNOWN");
    expect(result.snapshot.dataComplete).toBe(false);
  });

  it("keeps an apparently dispersed top-20 snapshot UNKNOWN rather than clearing all holders", async () => {
    const fetcher = mockFetcher(rpcFixture(["100000", "50000"], [ownerA, ownerB]));
    const result = await fetchHolderConcentration(mint, { apiKey: "test-key", fetcher });
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") return;
    expect(result.snapshot.status).toBe("UNKNOWN");
    expect(result.snapshot.reason).toContain("not a complete holder census");
  });

  it("fails closed when an owner or mint cannot be verified", async () => {
    const fetcher = mockFetcher(rpcFixture(["250000"], [ownerA], [ownerB]));
    const result = await fetchHolderConcentration(mint, { apiKey: "test-key", fetcher });
    expect(result).toMatchObject({ status: "DATA_INCOMPLETE", mint });
  });

  it("fails closed on an RPC error", async () => {
    const fetcher = mockFetcher([Response.json({ error: { code: -32000 } })]);
    const result = await fetchHolderConcentration(mint, { apiKey: "test-key", fetcher });
    expect(result).toMatchObject({ status: "DATA_INCOMPLETE", reason: expect.stringContaining("invalid JSON-RPC") });
  });

  it("rejects an invalid mint before making RPC calls", async () => {
    const fetcher = vi.fn();
    const result = await fetchHolderConcentration("invalid", { apiKey: "test-key", fetcher });
    expect(result).toMatchObject({ status: "DATA_INCOMPLETE", reason: "Invalid mint address." });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
