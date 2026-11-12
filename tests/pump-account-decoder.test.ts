import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { deriveCanonicalPumpSwapPoolPda, derivePumpBondingCurvePda, derivePumpPoolCreatorAuthorityPda } from "../src/ingestion/pump-pdas.js";
import { createUnverifiedMarketState } from "../src/paper/pump-market-state.js";
import { applyVerifiedPumpCurveAccount, applyVerifiedPumpSwapPoolAccounts } from "../src/ingestion/pump-market-verifier.js";
import {
  decodePumpSwapPoolAccount, decodeSplTokenAccount, decodeVerifiedPumpCurveAccount,
  verifyCanonicalPumpSwapPoolSnapshot, toVerifiedPumpCurveEvidence, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID, NATIVE_SOL_MINT
} from "../src/ingestion/pump-account-decoder.js";

const observedAt = "2026-11-12T12:00:00.000Z";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
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
  data[81] = 1;
  data[82] = 1;
  writeU64(data, 115, 75n);
  data[123] = 1;
  data[124] = 1;
  writeU64(data, 125, 10n);
  writeU64(data, 133, 20n);
  data[141] = 2;
  writeU64(data, 142, 30n);
  writeU64(data, 150, 40n);
  writeU64(data, 158, 50n);
  data.set(new PublicKey(USDC_MINT).toBytes(), 83);
  return data;
}
function poolData(creator = ZERO_KEY, baseMint = ZERO_KEY, quoteMint = ZERO_KEY, baseVault = ZERO_KEY, quoteVault = ZERO_KEY): Uint8Array {
  const data = new Uint8Array(287);
  data.set([241, 154, 109, 4, 17, 177, 109, 188], 0);
  data[8] = 254;
  data[9] = 0; data[10] = 0; // canonical pool index
  data.set(new PublicKey(creator).toBytes(), 11);
  data.set(new PublicKey(baseMint).toBytes(), 43);
  data.set(new PublicKey(quoteMint).toBytes(), 75);
  data.set(new PublicKey(baseVault).toBytes(), 139);
  data.set(new PublicKey(quoteVault).toBytes(), 171); 0
  writeU64(data, 203, 1_000n);
  writeU64(data, 271, 100n);
  writeU64(data, 279, 200n);
  return data;
}
function tokenVault(amount: bigint, mint = ZERO_KEY, authority = ZERO_KEY): Uint8Array {
  const data = new Uint8Array(165);
  data.set(new PublicKey(mint).toBytes(), 0);
  data.set(new PublicKey(authority).toBytes(), 32);
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
      tokenTotalSupply: "1000000", creator: ZERO_KEY, quoteMint: USDC_MINT, creatorFeeBps: "75",
      creatorFeeBaseUnits: "10", protocolFeesBaseUnits: "20", isMayhemMode: true,
      isCashbackCoin: true, canEditCreatorFee: true, isHolderReward: true,
      depth: 2, initialVirtualQuoteReserves: "30", postCompleteBaseOut: "40", postCompleteQuoteIn: "50"
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
      bump: 254, index: 0, creator: ZERO_KEY, baseMint: ZERO_KEY, quoteMint: ZERO_KEY,
      lpMint: ZERO_KEY, baseVault: ZERO_KEY, quoteVault: ZERO_KEY, lpSupplyBaseUnits: "1000",
      virtualQuoteReserves: "0",
      creatorFeeBps: "0", protocolFeesBaseUnits: "100", creatorFeesBaseUnits: "200",
      isMayhemMode: false, isCashbackCoin: false, canEditCreatorFee: false, isHolderReward: false
    });
    const legacy = poolData().slice(0, 245);
    expect(decodePumpSwapPoolAccount(account("pool", PUMP_AMM_PROGRAM_ID, legacy)).virtualQuoteReserves).toBe("0");
  });

  it("decodes initialized SPL token vault balances", () => {
    expect(decodeSplTokenAccount(account("vault", SPL_TOKEN_PROGRAM_ID, tokenVault(123n))))
      .toMatchObject({ mint: ZERO_KEY, tokenAuthority: ZERO_KEY, amountBaseUnits: "123" });
  });

  it("only assembles canonical pool evidence when pool, PDA authorities and vaults all match", () => {
    const baseVaultAddress = new PublicKey(new Uint8Array(32).fill(1)).toBase58();
    const quoteVaultAddress = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
    const pool = account(ZERO_KEY, PUMP_AMM_PROGRAM_ID,
      poolData(ZERO_KEY, ZERO_KEY, ZERO_KEY, baseVaultAddress, quoteVaultAddress));
    const baseVault = account(baseVaultAddress, SPL_TOKEN_PROGRAM_ID, tokenVault(10_000n, ZERO_KEY, ZERO_KEY));
    const quoteVault = account(quoteVaultAddress, SPL_TOKEN_PROGRAM_ID, tokenVault(20_000n, ZERO_KEY, ZERO_KEY));
    const snapshot = verifyCanonicalPumpSwapPoolSnapshot({
      poolAccount: pool, baseVaultAccount: baseVault, quoteVaultAccount: quoteVault,
      expectedMint: ZERO_KEY, expectedPoolAddress: ZERO_KEY,
      expectedPoolCreatorAuthority: ZERO_KEY, expectedPoolAuthority: ZERO_KEY,
      nowMs: Date.parse(observedAt)
    });
    expect(snapshot).toMatchObject({
      verified: true, canonical: true, mint: ZERO_KEY,
      baseReserveBaseUnits: "10000", quoteReserveBaseUnits: "20000", slot
    });
  });

  it("rejects a noncanonical pool, mismatched vault authority and cross-slot vault snapshot", () => {
    const pool = account(ZERO_KEY, PUMP_AMM_PROGRAM_ID, poolData());
    const baseVault = account(ZERO_KEY, SPL_TOKEN_PROGRAM_ID, tokenVault(10_000n));
    const quoteVault = account(ZERO_KEY, SPL_TOKEN_PROGRAM_ID, tokenVault(20_000n));
    expect(() => verifyCanonicalPumpSwapPoolSnapshot({
      poolAccount: pool, baseVaultAccount: baseVault, quoteVaultAccount: quoteVault,
      expectedMint: ZERO_KEY, expectedPoolAddress: ZERO_KEY,
      expectedPoolCreatorAuthority: "not-the-creator", expectedPoolAuthority: ZERO_KEY,
      nowMs: Date.parse(observedAt)
    })).toThrow(/canonical/);
    const wrongAuthority = tokenVault(10_000n, ZERO_KEY, ZERO_KEY); wrongAuthority.fill(1, 32, 64);
    expect(() => verifyCanonicalPumpSwapPoolSnapshot({
      poolAccount: pool, baseVaultAccount: account(baseVault.address, SPL_TOKEN_PROGRAM_ID, wrongAuthority),
      quoteVaultAccount: quoteVault, expectedMint: ZERO_KEY, expectedPoolAddress: ZERO_KEY,
      expectedPoolCreatorAuthority: ZERO_KEY, expectedPoolAuthority: ZERO_KEY,
      nowMs: Date.parse(observedAt)
    })).toThrow(/vault/);
    expect(() => verifyCanonicalPumpSwapPoolSnapshot({
      poolAccount: pool, baseVaultAccount: baseVault,
      quoteVaultAccount: { ...quoteVault, slot: slot + 1 },
      expectedMint: ZERO_KEY, expectedPoolAddress: ZERO_KEY,
      expectedPoolCreatorAuthority: ZERO_KEY, expectedPoolAuthority: ZERO_KEY,
      nowMs: Date.parse(observedAt)
    })).toThrow(/same RPC context slot/);
  });

  it("connects decoded curve and canonical pool accounts to the fail-closed market state machine", () => {
    const mint = NATIVE_SOL_MINT;
    const curveAddress = derivePumpBondingCurvePda(mint);
    const initial = createUnverifiedMarketState(mint, observedAt);
    const live = applyVerifiedPumpCurveAccount({
      state: initial, account: account(curveAddress, PUMP_PROGRAM_ID, curveData()),
      nowMs: Date.parse(observedAt)
    });
    expect(live.status).toBe("LIVE_CURVE");
    const pending = applyVerifiedPumpCurveAccount({
      state: initial, account: account(curveAddress, PUMP_PROGRAM_ID, curveData(true)),
      nowMs: Date.parse(observedAt)
    });
    expect(pending.status).toBe("MIGRATION_PENDING");
    const creator = derivePumpPoolCreatorAuthorityPda(mint);
    const poolAddress = deriveCanonicalPumpSwapPoolPda(mint, USDC_MINT);
    const baseVault = new PublicKey(new Uint8Array(32).fill(1)).toBase58();
    const quoteVault = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
    const migrated = applyVerifiedPumpSwapPoolAccounts({
      state: pending,
      poolAccount: account(poolAddress, PUMP_AMM_PROGRAM_ID, poolData(creator, mint, USDC_MINT, baseVault, quoteVault)),
      baseVaultAccount: account(baseVault, SPL_TOKEN_PROGRAM_ID, tokenVault(10_000n, mint, poolAddress)),
      quoteVaultAccount: account(quoteVault, SPL_TOKEN_PROGRAM_ID, tokenVault(20_000n, USDC_MINT, poolAddress)),
      nowMs: Date.parse(observedAt)
    });
    expect(migrated.status).toBe("MIGRATED_POOL_VERIFIED");
    expect(migrated.pool?.baseReserveBaseUnits).toBe("10000");
  });

});
