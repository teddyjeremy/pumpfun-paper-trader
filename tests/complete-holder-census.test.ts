import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { fetchCompleteHolderConcentration } from "../src/ingestion/holder-risk.js";

const mint = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const accountA = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
const accountB = "LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY";
const ownerA = "So11111111111111111111111111111111111111112";
const ownerB = "11111111111111111111111111111111";
const ownerC = Keypair.generate().publicKey.toBase58();
const ownerD = Keypair.generate().publicKey.toBase58();
const ownerE = Keypair.generate().publicKey.toBase58();
const accountAddresses = Array.from({ length: 5 }, () => Keypair.generate().publicKey.toBase58());

function slot(value: number) {
  return Response.json({ jsonrpc: "2.0", result: value });
}
function supply(amount = "1000") {
  return Response.json({ jsonrpc: "2.0", result: { value: { amount, decimals: 6 } } });
}
function page(amounts: string[], owners: string[]) {
  return Response.json({
    jsonrpc: "2.0",
    result: {
      token_accounts: amounts.map((amount, index) => ({
        address: accountAddresses[index] ?? Keypair.generate().publicKey.toBase58(),
        owner: owners[index]!,
        mint,
        amount
      }))
    }
  });
}
function scan(amounts: string[], owners: string[], start: number) {
  return [
    slot(start), supply(),
    page(amounts, owners),
    supply(), slot(start + 1)
  ];
}
function mockFetcher(responses: Response[]) {
  let index = 0;
  return vi.fn(async () => responses[index++] ?? Response.json({ error: { code: -1 } }));
}

describe("complete holder census", () => {
  it("marks a complete, stable two-pass census as PASS_COMPLETE below the 20% threshold", async () => {
    const responses = [
      ...scan(["200", "200", "200", "200", "200"], [ownerA, ownerB, ownerC, ownerD, ownerE], 100),
      ...scan(["200", "200", "200", "200", "200"], [ownerA, ownerB, ownerC, ownerD, ownerE], 102)
    ];
    const fetcher = mockFetcher(responses);
    const result = await fetchCompleteHolderConcentration(mint, { apiKey: "test-key", fetcher });
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") return;
    expect(result.snapshot).toMatchObject({
      mint,
      supply: "1000",
      decimals: 6,
      observedTokenAccounts: 5,
      observedOwners: 5,
      largestObservedOwnerShareBps: 2_000,
      status: "PASS_COMPLETE",
      coverage: "FULL_TOKEN_ACCOUNT_CENSUS_STABLE",
      dataComplete: true,
      censusPasses: 2
    });
    expect(fetcher).toHaveBeenCalledTimes(10);
  });

  it("rejects an owner above 20% after complete census", async () => {
    const fetcher = mockFetcher([
      ...scan(["250", "150", "200", "200", "200"], [ownerA, ownerB, ownerC, ownerD, ownerE], 100),
      ...scan(["250", "150", "200", "200", "200"], [ownerA, ownerB, ownerC, ownerD, ownerE], 102)
    ]);
    const result = await fetchCompleteHolderConcentration(mint, { apiKey: "test-key", fetcher });
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") return;
    expect(result.snapshot.status).toBe("REJECT_OBSERVED");
    expect(result.snapshot.largestObservedOwnerShareBps).toBe(2_500);
  });

  it("fails closed when the repeated census differs", async () => {
    const fetcher = mockFetcher([
      ...scan(["200", "200", "200", "200", "200"], [ownerA, ownerB, ownerC, ownerD, ownerE], 100),
      ...scan(["201", "199", "200", "200", "200"], [ownerA, ownerB, ownerC, ownerD, ownerE], 102)
    ]);
    const result = await fetchCompleteHolderConcentration(mint, { apiKey: "test-key", fetcher });
    expect(result).toMatchObject({
      status: "DATA_INCOMPLETE",
      reason: expect.stringContaining("did not produce the same stable account set")
    });
  });

  it("fails closed when enumerated holder balances do not reconcile to total supply", async () => {
    const fetcher = mockFetcher([
      ...scan(["200", "100"], [ownerA, ownerB], 100),
      ...scan(["200", "100"], [ownerA, ownerB], 102)
    ]);
    const result = await fetchCompleteHolderConcentration(mint, { apiKey: "test-key", fetcher });
    expect(result).toMatchObject({
      status: "DATA_INCOMPLETE",
      reason: expect.stringContaining("do not reconcile exactly")
    });
  });

  it("fails closed when pagination reaches the configured cap without proving completion", async () => {
    const fullPage = Response.json({
      jsonrpc: "2.0",
      result: {
        token_accounts: Array.from({ length: 1_000 }, () => ({
          address: Keypair.generate().publicKey.toBase58(),
          owner: ownerA,
          mint,
          amount: "1"
        }))
      }
    });
    const responses = [slot(100), supply(), ...Array.from({ length: 5 }, () => fullPage.clone())];
    const fetcher = mockFetcher(responses);
    const result = await fetchCompleteHolderConcentration(mint, { apiKey: "test-key", fetcher });
    expect(result).toMatchObject({ status: "DATA_INCOMPLETE" });
  });
});
