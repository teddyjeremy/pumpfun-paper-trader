import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { PublicKey } from "@solana/web3.js";
import { createUnverifiedMarketState } from "../src/paper/pump-market-state.js";
import { refreshPumpMarketStateFromHelius } from "../src/ingestion/helius-pump-market.js";
import {
  NATIVE_SOL_MINT, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID
} from "../src/ingestion/pump-account-decoder.js";
import {
  deriveCanonicalPumpSwapPoolPda, derivePumpBondingCurvePda, derivePumpPoolCreatorAuthorityPda
} from "../src/ingestion/pump-pdas.js";

const BASE_MINT = NATIVE_SOL_MINT;
const QUOTE_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NOW = "2026-11-12T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const SLOT = 77;
const baseVault = new PublicKey(new Uint8Array(32).fill(1)).toBase58();
const quoteVault = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
const curveAddress = derivePumpBondingCurvePda(BASE_MINT);
const creator = derivePumpPoolCreatorAuthorityPda(BASE_MINT);
const poolAddress = deriveCanonicalPumpSwapPoolPda(BASE_MINT, QUOTE_MINT);

function u64(data: Uint8Array, offset: number, value: bigint): void {
  for (let i = 0; i < 8; i++) data[offset + i] = Number((value >> BigInt(i * 8)) & 255n);
}
function curveData(complete: boolean): Uint8Array {
  const data = new Uint8Array(166);
  data.set([23, 183, 248, 55, 96, 216, 172, 96], 0);
  u64(data, 8, 1_000n); u64(data, 16, 2_000n); u64(data, 24, 700n);
  u64(data, 32, 1_500n); u64(data, 40, 1_000_000n);
  data[48] = complete ? 1 : 0;
  data.set(new PublicKey(QUOTE_MINT).toBytes(), 83);
  return data;
}
function poolData(): Uint8Array {
  const data = new Uint8Array(287);
  data.set([241, 154, 109, 4, 17, 177, 109, 188], 0);
  data[8] = 254; data[9] = 0; data[10] = 0;
  data.set(new PublicKey(creator).toBytes(), 11);
  data.set(new PublicKey(BASE_MINT).toBytes(), 43);
  data.set(new PublicKey(QUOTE_MINT).toBytes(), 75);
  data.set(new PublicKey(baseVault).toBytes(), 139);
  data.set(new PublicKey(quoteVault).toBytes(), 171);
  u64(data, 203, 1_000n);
  return data;
}
function tokenAccount(mint: string, amount: bigint, authority = poolAddress): Uint8Array {
  const data = new Uint8Array(165);
  data.set(new PublicKey(mint).toBytes(), 0);
  data.set(new PublicKey(authority).toBytes(), 32);
  u64(data, 64, amount);
  data[108] = 1;
  return data;
}
function encoded(data: Uint8Array): [string, "base64"] {
  return [Buffer.from(data).toString("base64"), "base64"];
}
function rpcResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "test", result }), {
    status: 200, headers: { "content-type": "application/json" }
  });
}
function account(owner: string, data: Uint8Array) {
  return { owner, data: encoded(data), executable: false, lamports: 1, rentEpoch: 0 };
}
function harness(options: { complete: boolean; missingPool?: boolean; missingVault?: boolean; badVaultAuthority?: boolean }) {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push(body.method);
    if (body.method === "getMultipleAccounts") {
      const addresses = body.params[0] as string[];
      if (addresses.length === 1) {
        return rpcResponse({ context: { slot: SLOT }, value: [
          account(PUMP_PROGRAM_ID, curveData(options.complete))
        ] });
      }
      return rpcResponse({ context: { slot: SLOT }, value: [
        account(PUMP_AMM_PROGRAM_ID, poolData()),
        options.missingVault ? null : account(SPL_TOKEN_PROGRAM_ID,
          tokenAccount(BASE_MINT, 10_000n, options.badVaultAuthority ? creator : poolAddress)),
        account(SPL_TOKEN_PROGRAM_ID, tokenAccount(QUOTE_MINT, 20_000n))
      ] });
    }
    if (body.method === "getProgramAccounts") {
      return rpcResponse({ context: { slot: SLOT }, value: options.missingPool ? [] : [{
        pubkey: poolAddress, account: account(PUMP_AMM_PROGRAM_ID, poolData())
      }] });
    }
    throw new Error(`Unexpected Helius method ${body.method}`);
  };
  return {
    calls,
    config: { apiKey: "test-api-key", now: () => NOW_MS, fetcher }
  };
}

describe("Helius-backed Pump market verification", () => {
  it("marks a fresh incomplete curve LIVE_CURVE without searching for a pool", async () => {
    const h = harness({ complete: false });
    const state = await refreshPumpMarketStateFromHelius({
      state: createUnverifiedMarketState(BASE_MINT, NOW), config: h.config
    });
    expect(state.status).toBe("LIVE_CURVE");
    expect(h.calls).toEqual(["getMultipleAccounts"]);
  });

  it("keeps a completed curve MIGRATION_PENDING until the canonical pool appears", async () => {
    const h = harness({ complete: true, missingPool: true });
    const state = await refreshPumpMarketStateFromHelius({
      state: createUnverifiedMarketState(BASE_MINT, NOW), config: h.config
    });
    expect(state.status).toBe("MIGRATION_PENDING");
    expect(state.reason).toContain("has not been discovered");
    expect(h.calls).toEqual(["getMultipleAccounts", "getProgramAccounts"]);
  });

  it("verifies canonical pool and both vaults from one Helius context slot", async () => {
    const h = harness({ complete: true });
    const state = await refreshPumpMarketStateFromHelius({
      state: createUnverifiedMarketState(BASE_MINT, NOW), config: h.config
    });
    expect(state.status).toBe("MIGRATED_POOL_VERIFIED");
    expect(state.pool).toMatchObject({
      poolAddress, baseReserveBaseUnits: "10000", quoteReserveBaseUnits: "20000", slot: SLOT
    });
    expect(h.calls).toEqual(["getMultipleAccounts", "getProgramAccounts", "getMultipleAccounts"]);
  });

  it("does not advance when a pool vault is missing", async () => {
    const h = harness({ complete: true, missingVault: true });
    const state = await refreshPumpMarketStateFromHelius({
      state: createUnverifiedMarketState(BASE_MINT, NOW), config: h.config
    });
    expect(state.status).toBe("MIGRATION_PENDING");
    expect(state.pool).toBeNull();
  });

  it("blocks exits when a discovered pool's vault authority does not match the pool PDA", async () => {
    const h = harness({ complete: true, badVaultAuthority: true });
    const state = await refreshPumpMarketStateFromHelius({
      state: createUnverifiedMarketState(BASE_MINT, NOW), config: h.config
    });
    expect(state.status).toBe("EXIT_BLOCKED");
    expect(state.pool).toBeNull();
  });
});
