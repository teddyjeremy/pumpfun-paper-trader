import { describe, expect, it } from "vitest";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  estimateVirtualTraderAtaRent,
  type VirtualTraderAtaRentEstimate
} from "../src/ingestion/virtual-trader-ata-rent.js";
import type { VirtualTraderAtaPrerequisites } from "../src/ingestion/virtual-trader-ata-prerequisites.js";

const base = {
  source: "helius-getMultipleAccounts",
  slot: 100,
  observedAt: "2026-11-13T00:00:00.000Z",
  owner: "11111111111111111111111111111111",
  createInstructions: [],
  accountsPresent: false,
  paperEntryAuthorized: false
} satisfies Omit<VirtualTraderAtaPrerequisites, "requirements">;

function prerequisites(tokenProgram: string, state: "PRESENT_AND_VERIFIED" | "MISSING_CREATE_REQUIRED") {
  return {
    ...base,
    requirements: [{
      role: "base" as const,
      address: "11111111111111111111111111111111",
      mint: "11111111111111111111111111111111",
      tokenProgram,
      state
    }]
  } satisfies VirtualTraderAtaPrerequisites;
}

function rentFetcher(lamports: number, calls: number[]) {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    expect(body.method).toBe("getMinimumBalanceForRentExemption");
    expect(body.params[0]).toBe(165);
    calls.push(1);
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: "rent",
      result: lamports
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

describe("virtual trader ATA rent accounting", () => {
  it("queries exact rent for each unique missing legacy ATA size and totals it", async () => {
    const calls: number[] = [];
    const result = await estimateVirtualTraderAtaRent({
      prerequisites: {
        ...base,
        requirements: [
          { role: "base", address: "base", mint: "mint-a", tokenProgram: TOKEN_PROGRAM_ID.toBase58(), state: "MISSING_CREATE_REQUIRED" },
          { role: "quote", address: "quote", mint: "mint-b", tokenProgram: TOKEN_PROGRAM_ID.toBase58(), state: "MISSING_CREATE_REQUIRED" }
        ]
      },
      config: { apiKey: "test-key", now: () => Date.parse("2026-11-13T00:00:00.000Z"), fetcher: rentFetcher(2_039_280, calls) }
    });

    expect(calls).toHaveLength(1);
    expect(result.items.map(item => item.minimumRentLamports)).toEqual([2_039_280, 2_039_280]);
    expect(result.newAtaRentReserveLamports).toBe(4_078_560);
    expect(result.allNewAtaRentKnown).toBe(true);
    expect(result.paperRentCanBeReservedInPortfolio).toBe(true);
    expect(result.simulatedPayerBalanceChecked).toBe(false);
    expect(result.paperEntryAuthorized).toBe(false);
  });

  it("does not charge rent again for already-present accounts", async () => {
    const result = await estimateVirtualTraderAtaRent({
      prerequisites: prerequisites(TOKEN_PROGRAM_ID.toBase58(), "PRESENT_AND_VERIFIED"),
      config: { apiKey: "test-key", fetcher: async () => { throw new Error("RPC must not be called"); } }
    });
    expect(result.newAtaRentReserveLamports).toBe(0);
    expect(result.items[0]?.status).toBe("ALREADY_PRESENT");
    expect(result.paperRentCanBeReservedInPortfolio).toBe(true);
    expect(result.existingAtaRentExemptionVerified).toBe(false);
  });

  it("fails closed for Token-2022 until extension-aware account sizing is available", async () => {
    const result = await estimateVirtualTraderAtaRent({
      prerequisites: prerequisites(TOKEN_2022_PROGRAM_ID.toBase58(), "MISSING_CREATE_REQUIRED"),
      config: { apiKey: "test-key", fetcher: async () => { throw new Error("RPC must not be called"); } }
    });
    expect(result.items[0]?.status).toBe("UNSUPPORTED_LAYOUT");
    expect(result.newAtaRentReserveLamports).toBeNull();
    expect(result.allNewAtaRentKnown).toBe(false);
    expect(result.paperRentCanBeReservedInPortfolio).toBe(false);
    expect(result.paperEntryAuthorized).toBe(false);
  });

  it("rejects malformed rent values instead of rounding them", async () => {
    await expect(estimateVirtualTraderAtaRent({
      prerequisites: prerequisites(TOKEN_PROGRAM_ID.toBase58(), "MISSING_CREATE_REQUIRED"),
      config: {
        apiKey: "test-key",
        fetcher: async () => new Response(JSON.stringify({ result: 2_039_280.5 }), { status: 200 })
      }
    })).rejects.toThrow("invalid lamport amount");
  });
});
