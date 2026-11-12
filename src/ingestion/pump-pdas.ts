import { Buffer } from "node:buffer";
import { PublicKey } from "@solana/web3.js";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from "./pump-account-decoder.js";

const PUMP_PROGRAM = new PublicKey(PUMP_PROGRAM_ID);
const PUMP_AMM_PROGRAM = new PublicKey(PUMP_AMM_PROGRAM_ID);

function publicKey(value: string, label: string): PublicKey {
  try { return new PublicKey(value); }
  catch { throw new Error(`Invalid ${label} public key.`); }
}

/** PDA seeds copied from the official Pump program IDL migrate_v2 instruction. */
export function derivePumpBondingCurvePda(mint: string): string {
  const mintKey = publicKey(mint, "mint");
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mintKey.toBuffer()],
    PUMP_PROGRAM
  )[0].toBase58();
}

/** PDA seeds copied from the official Pump program IDL migrate_v2 instruction. */
export function derivePumpPoolCreatorAuthorityPda(baseMint: string): string {
  const mintKey = publicKey(baseMint, "base mint");
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), mintKey.toBuffer()],
    PUMP_PROGRAM
  )[0].toBase58();
}

/**
 * Canonical PumpSwap pool PDA: ["pool", index=0 (u16 LE), creator,
 * base_mint, quote_mint] under the official PumpSwap program.
 */
export function deriveCanonicalPumpSwapPoolPda(baseMint: string, quoteMint: string): string {
  const base = publicKey(baseMint, "base mint");
  const quote = publicKey(quoteMint, "quote mint");
  const creator = new PublicKey(derivePumpPoolCreatorAuthorityPda(baseMint));
  const index = Buffer.alloc(2);
  index.writeUInt16LE(0, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), index, creator.toBuffer(), base.toBuffer(), quote.toBuffer()],
    PUMP_AMM_PROGRAM
  )[0].toBase58();
}

/** PumpSwap pool PDA is also the authority of its associated token vaults. */
export function derivePumpSwapPoolVaultAuthority(poolAddress: string): string {
  return publicKey(poolAddress, "pool").toBase58();
}
