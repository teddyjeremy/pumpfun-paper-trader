import { describe, expect, it } from "vitest";
import {
  decodePumpSwapPoolAccount, decodeSplTokenAccount, decodeVerifiedPumpCurveAccount,
  verifyCanonicalPumpSwapPoolSnapshot, toVerifiedPumpCurveEvidence, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID
} from "../src/ingestion/pump-account-decoder.js";

const observedAt = "2026-11-12T12:00:00.000Z";
const slot = 55;
const ZERO_KEY = "11111111111111111111111111111111";

function writeU64(data: Uint8Array, offset: number, value: bigint): void {
  for (let i = 0; i < 8; i++) data[offset + i] = Number((value >> BigInt(i * 8)) & 255n);
}
function account(address: string, owner: string, data: Uint8Array) {
  return { address, owner, data, slot, observedAt };
}
function curveData(complete = false): Uint8Array {
  const data = new Uint8Array(166);
  data.set([23, 183, 248, 55, 96, 216, 172, 96], 0);
  writeU64(data, 8, 1_000n);
  writeU64(data, 16, 2_000n);
  writeU64(data, 24, 700n);
  writeU64(data, 32, 1_500n);
  writeU64(data, 40, 1_000_000n);
  data[48] = complete ? 1 : 0;
  data[81] = 0;
  data[82] = 0;
  return data;
}
function poolData(): Uint8Array {
  const data = new Uint8Array(271);
  data.set([241, 154, 109, 4, 17, 177, 109, 188], 0);
  data[8] = 254;
  data[9] = 0; data[10] = 0; // canonical pool index 0
  writeU64(data, 203, 1_000n);
  return data;
}
function tokenVault(amount: bigint): Uint8Array {
  const data = new Uint8Array(165);
  writeU64(data, 64, amount);
  data[108] = 1;
  return data;
}

describe("IDL-aligned Pump account decoders", () => {
  it("decodes a current Pump bonding curve only when owner and PDA match", () => {
    const decoded = decodeVerifiedPumpCurveAccount({
      account: account("curve-pda", PUMP_PROGRAM_ID, curveData()),
      expectedMint: "mint", expectedCurveAddress: "curve-pda"
    });
    expect(toVerifiedPumpCurveEvidence(decoded)).toMatchObject({
      source: "verified-pump-curve-account", verified: true, mint: "mint", curveAddress: "curve-pda",
      complete: false, migrated: false, tokenReserveBaseUnits: "700", quoteReserveBaseUnits: "1500"
    });
    expect(decoded).toMatchObject({
      mint: "mint", complete: false, migrated: false,
      virtualTokenReserves: "1000", virtualQuoteReserves: "2000",
      realTokenReserves: "700", realQuoteReserves: "1500",
      tokenTotalSupply: "1000000", creator: ZERO_KEY
    });
  });

  it("treats curve completion as terminal but not proof of a migrated pool", () => {
    const decoded = decodeVerifiedPumpCurveAccount({
      account: account("curve-pda", PUMP_PROGRAM_ID, curveData(true)),
      expectedMint: "mint", expectedCurveAddress: "curve-pda"
    });
    expect(decoded.complete).toBe(true);
    expect(decoded.migrated).toBe(false);
  });

  it("rejects wrong program owner, PDA and discriminator", () => {
    expect(() => decodeVerifiedPumpCurveAccount({
      account: account("curve-pda", PUMP_AMM_PROGRAM_ID, curveData()),
      expectedMint: "mint", expectedCurveAddress: "curve-pda"
    })).toThrow(/not owned/);
    expect(() => decodeVerifiedPumpCurveAccount({
      account: account("wrong", PUMP_PROGRAM_ID, curveData()),
      expectedMint: "mint", expectedCurveAddress: "curve-pda"
    })).toThrow(/PDA/);
    const invalid = curveData(); invalid[0] = 0;
    expect(() => decodeVerifiedPumpCurveAccount({
      account: account("curve-pda", PUMP_PROGRAM_ID, invalid),
      expectedMint: "mint", expectedCurveAddress: "curve-pda"
    })).toThrow(/discriminator/);
  });

  it("decodes PumpSwap pool fields and defaults appended fields on legacy layouts", () => {
    const decoded = decodePumpSwapPoolAccount(account("pool", PUMP_AMM_PROGRAM_ID, poolData()));
    expect(decoded).toMatchObject({
      index: 0, creator: ZERO_KEY, baseMint: ZERO_KEY, quoteMint: ZERO_KEY,
      baseVault: ZERO_KEY, quoteVault: ZERO_KEY, virtualQuoteReserves: "0",
      creatorFeeBps: "0"
    });
    const legacy = poolData().slice(0, 245);
    expect(decodePumpSwapPoolAccount(account("pool", PUMP_AMM_PROGRAM_ID, legacy)).virtualQuoteReserves).toBe("0");
  });

  it("decodes initialized SPL token vault balances", () => {
    expect(decodeSplTokenAccount(account("vault", SPL_TOKEN_PROGRAM_ID, tokenVault(123n))))
      .toMatchObject({ mint: ZERO_KEY, tokenAuthority: ZERO_KEY, amountBaseUnits: "123" });
  });

  it("only assembles canonical pool evidence when pool, PDA authorities and vaults all match", () => {
    const pool = account("pool", PUMP_AMM_PROGRAM_ID, poolData());
    const baseVault = account(ZERO_KEY, SPL_TOKEN_PROGRAM_ID, tokenVault(10_000n));
    const quoteVault = account(ZERO_KEY, SPL_TOKEN_PROGRAM_ID, tokenVault(20_000n));
    const snapshot = verifyCanonicalPumpSwapPoolSnapshot({
      poolAccount: pool, baseVaultAccount: baseVault, quoteVaultAccount: quoteVault,
      expectedMint: ZERO_KEY, expectedPoolAddress: "pool",
      expectedPoolCreatorAuthority: ZERO_KEY, expectedPoolAuthority: ZERO_KEY,
      nowMs: Date.parse(observedAt)
    });
    expect(snapshot).toMatchObject({
      verified: true, canonical: true, mint: ZERO_KEY,
      baseReserveBaseUnits: "10000", quoteReserveBaseUnits: "20000", slot
    });
  });

  it("rejects a noncanonical pool, mismatched vault authority and cross-slot vault snapshot", () => {
    const pool = account("pool", PUMP_AMM_PROGRAM_ID, poolData());
    const baseVault = account(ZERO_KEY, SPL_TOKEN_PROGRAM_ID, tokenVault(10_000n));
    const quoteVault = account(ZERO_KEY, SPL_TOKEN_PROGRAM_ID, tokenVault(20_000n));
    expect(() => verifyCanonicalPumpSwapPoolSnapshot({
      poolAccount: pool, baseVaultAccount: baseVault, quoteVaultAccount: quoteVault,
      expectedMint: ZERO_KEY, expectedPoolAddress: "pool",
      expectedPoolCreatorAuthority: "not-the-creator", expectedPoolAuthority: ZERO_KEY,
      nowMs: Date.parse(observedAt)
    })).toThrow(/canonical/);
    const wrongAuthority = tokenVault(10_000n); wrongAuthority.fill(1, 32, 64);
    expect(() => verifyCanonicalPumpSwapPoolSnapshot({
      poolAccount: pool, baseVaultAccount: account(ZERO_KEY, SPL_TOKEN_PROGRAM_ID, wrongAuthority),
      quoteVaultAccount: quoteVault, expectedMint: ZERO_KEY, expectedPoolAddress: "pool",
      expectedPoolCreatorAuthority: ZERO_KEY, expectedPoolAuthority: ZERO_KEY,
      nowMs: Date.parse(observedAt)
    })).toThrow(/vault/);
    expect(() => verifyCanonicalPumpSwapPoolSnapshot({
      poolAccount: pool, baseVaultAccount: baseVault,
      quoteVaultAccount: { ...quoteVault, slot: slot + 1 },
      expectedMint: ZERO_KEY, expectedPoolAddress: "pool",
      expectedPoolCreatorAuthority: ZERO_KEY, expectedPoolAuthority: ZERO_KEY,
      nowMs: Date.parse(observedAt)
    })).toThrow(/same RPC context slot/);
  });
});
