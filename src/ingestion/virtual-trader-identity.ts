import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

const IDENTITY_DOMAIN = "pumpfun-paper-trader:non-signing-virtual-trader:v1";
const MAX_DERIVATION_ATTEMPTS = 256;

export interface NonSigningVirtualTraderIdentity {
  kind: "NON_SIGNING_VIRTUAL_TRADER";
  publicKey: string;
  derivationVersion: 1;
  canSign: false;
  canSubmit: false;
}

export interface VirtualTraderTokenAccount {
  owner: string;
  mint: string;
  tokenProgram: string;
  associatedTokenAddress: string;
  existence: "MUST_BE_VERIFIED_FROM_CHAIN";
}

/**
 * Derive a stable, public-only address for compiling unsigned paper-trade
 * messages. No keypair or private key is generated, retained, or returned.
 *
 * The on-curve check means SDK instruction builders can represent this address
 * as a conventional wallet owner. It does not make the address signable: this
 * module intentionally has no signing or submission capability.
 */
export async function deriveNonSigningVirtualTraderIdentity(): Promise<NonSigningVirtualTraderIdentity> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto is required to derive the virtual trader identity.");

  const encoder = new TextEncoder();
  for (let counter = 0; counter < MAX_DERIVATION_ATTEMPTS; counter += 1) {
    const material = encoder.encode(`${IDENTITY_DOMAIN}:${counter}`);
    const digest = await subtle.digest("SHA-256", material);
    const bytes = new Uint8Array(digest);
    if (!PublicKey.isOnCurve(bytes)) continue;

    return {
      kind: "NON_SIGNING_VIRTUAL_TRADER",
      publicKey: new PublicKey(bytes).toBase58(),
      derivationVersion: 1,
      canSign: false,
      canSubmit: false
    };
  }
  throw new Error("Unable to derive an on-curve virtual trader address within the bounded search.");
}

/**
 * Derive the token account address only. This does not assert that the account
 * exists, is initialized, is funded, or is usable. Callers must verify the
 * account against a fresh chain snapshot before compiling venue instructions.
 */
export function deriveVirtualTraderTokenAccount(input: {
  identity: NonSigningVirtualTraderIdentity;
  mint: string;
  tokenProgram: string;
}): VirtualTraderTokenAccount {
  if (input.identity.kind !== "NON_SIGNING_VIRTUAL_TRADER" ||
      input.identity.canSign !== false || input.identity.canSubmit !== false ||
      input.identity.derivationVersion !== 1) {
    throw new Error("A supported non-signing virtual trader identity is required.");
  }

  const owner = new PublicKey(input.identity.publicKey);
  if (!PublicKey.isOnCurve(owner.toBytes())) {
    throw new Error("Virtual trader owner must be an on-curve public key.");
  }
  const mint = new PublicKey(input.mint);
  const tokenProgram = new PublicKey(input.tokenProgram);
  if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("Virtual trader token account requires the canonical SPL Token or Token-2022 program.");
  }

  const associatedTokenAddress = getAssociatedTokenAddressSync(
    mint, owner, false, tokenProgram
  );
  return {
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    tokenProgram: tokenProgram.toBase58(),
    associatedTokenAddress: associatedTokenAddress.toBase58(),
    existence: "MUST_BE_VERIFIED_FROM_CHAIN"
  };
}
