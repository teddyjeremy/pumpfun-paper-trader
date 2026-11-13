import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { decodeSplTokenAccount, type RawProgramAccount } from "./pump-account-decoder.js";
import { fetchHeliusMultipleAccounts, type HeliusAccountReadConfig } from "./helius-accounts.js";
import type { NonSigningVirtualTraderIdentity } from "./virtual-trader-identity.js";

const MAX_SNAPSHOT_AGE_MS = 2_000;

export interface VirtualTraderAtaRequirement {
  role: "base" | "quote" | "buyback";
  address: string;
  mint: string;
  tokenProgram: string;
  state: "PRESENT_AND_VERIFIED" | "MISSING_CREATE_REQUIRED";
}

export interface VirtualTraderAtaPrerequisites {
  source: "helius-getMultipleAccounts";
  slot: number;
  observedAt: string;
  owner: string;
  requirements: VirtualTraderAtaRequirement[];
  createInstructions: TransactionInstruction[];
  accountsPresent: boolean;
  /** This module never grants paper-entry authorization. */
  paperEntryAuthorized: false;
}

interface AtaSpec {
  role: "base" | "quote" | "buyback";
  owner: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
}

function assertIdentity(identity: NonSigningVirtualTraderIdentity): PublicKey {
  if (identity.kind !== "NON_SIGNING_VIRTUAL_TRADER" ||
      identity.canSign !== false || identity.canSubmit !== false ||
      identity.derivationVersion !== 1) {
    throw new Error("A supported non-signing virtual trader identity is required.");
  }
  const owner = new PublicKey(identity.publicKey);
  if (!PublicKey.isOnCurve(owner.toBytes())) {
    throw new Error("Virtual trader identity must be an on-curve public key.");
  }
  return owner;
}

function assertTokenProgram(program: PublicKey): void {
  if (!program.equals(TOKEN_PROGRAM_ID) && !program.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("Only canonical SPL Token and Token-2022 programs are supported.");
  }
}

function verifyPresentAta(input: {
  account: RawProgramAccount;
  expectedAddress: PublicKey;
  expectedMint: PublicKey;
  expectedOwner: PublicKey;
  expectedTokenProgram: PublicKey;
  slot: number;
  observedAt: string;
}): void {
  const { account } = input;
  if (account.address !== input.expectedAddress.toBase58() ||
      account.slot !== input.slot || account.observedAt !== input.observedAt ||
      account.owner !== input.expectedTokenProgram.toBase58()) {
    throw new Error("Virtual trader ATA address, token program or snapshot context does not match.");
  }
  const decoded = decodeSplTokenAccount(account);
  if (decoded.address !== input.expectedAddress.toBase58() ||
      decoded.mint !== input.expectedMint.toBase58() ||
      decoded.tokenAuthority !== input.expectedOwner.toBase58() ||
      decoded.tokenProgram !== input.expectedTokenProgram.toBase58()) {
    throw new Error("Existing virtual trader ATA has an unexpected mint, authority or token program.");
  }
}

/**
 * Fetches and verifies the virtual trader's base/quote ATAs in one Helius
 * context. Missing ATAs get idempotent create instructions for inclusion in
 * an unsigned message; this function never signs, funds, submits or authorizes
 * a paper entry. A null quoteMint means the venue uses native SOL directly.
 */
export async function inspectVirtualTraderAtaPrerequisites(input: {
  identity: NonSigningVirtualTraderIdentity;
  payer?: string;
  baseMint: string;
  baseTokenProgram: string;
  quoteMint?: string | null;
  quoteTokenProgram?: string;
  additionalRequirements?: readonly { role: "buyback"; owner: string; mint: string; tokenProgram: string }[];
  config: HeliusAccountReadConfig;
}): Promise<VirtualTraderAtaPrerequisites> {
  const owner = assertIdentity(input.identity);
  const payer = input.payer ? new PublicKey(input.payer) : owner;
  const specs: AtaSpec[] = [{
    role: "base",
    owner,
    mint: new PublicKey(input.baseMint),
    tokenProgram: new PublicKey(input.baseTokenProgram)
  }];
  for (const spec of specs) assertTokenProgram(spec.tokenProgram);
  if (input.quoteMint) {
    if (!input.quoteTokenProgram) throw new Error("A quote token program is required when quoteMint is supplied.");
    const quoteSpec: AtaSpec = {
      role: "quote",
      owner,
      mint: new PublicKey(input.quoteMint),
      tokenProgram: new PublicKey(input.quoteTokenProgram)
    };
    assertTokenProgram(quoteSpec.tokenProgram);
    specs.push(quoteSpec);
  }
  for (const requirement of input.additionalRequirements ?? []) {
    const additional: AtaSpec = {
      role: "buyback", owner: new PublicKey(requirement.owner),
      mint: new PublicKey(requirement.mint), tokenProgram: new PublicKey(requirement.tokenProgram)
    };
    assertTokenProgram(additional.tokenProgram);
    if (!PublicKey.isOnCurve(additional.owner.toBytes())) {
      throw new Error("Buyback ATA owner must be an on-curve public key.");
    }
    specs.push(additional);
  }

  const derived = specs.map(spec => ({
    ...spec,
    address: getAssociatedTokenAddressSync(spec.mint, spec.owner, false, spec.tokenProgram)
  }));
  if (new Set(derived.map(item => item.address.toBase58())).size !== derived.length) {
    throw new Error("Virtual trader ATA requirements must resolve to unique addresses.");
  }

  const snapshot = await fetchHeliusMultipleAccounts(
    derived.map(item => item.address.toBase58()),
    input.config
  );
  const nowMs = (input.config.now ?? Date.now)();
  const observedMs = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(observedMs) ||
      observedMs > nowMs || nowMs - observedMs > MAX_SNAPSHOT_AGE_MS) {
    throw new Error("Virtual trader ATA snapshot is stale or has an invalid observation time.");
  }

  const createInstructions: TransactionInstruction[] = [];
  const verifiedRequirements: VirtualTraderAtaRequirement[] = [];
  for (let index = 0; index < derived.length; index += 1) {
    const requirement = derived[index]!;
    const account = snapshot.accounts[index] ?? null;
    const address = requirement.address.toBase58();
    if (account) {
      verifyPresentAta({
        account,
        expectedAddress: requirement.address,
        expectedMint: requirement.mint,
        expectedOwner: requirement.owner,
        expectedTokenProgram: requirement.tokenProgram,
        slot: snapshot.slot,
        observedAt: snapshot.observedAt
      });
      verifiedRequirements.push({
        role: requirement.role,
        address,
        mint: requirement.mint.toBase58(),
        tokenProgram: requirement.tokenProgram.toBase58(),
        state: "PRESENT_AND_VERIFIED"
      });
    } else {
      createInstructions.push(createAssociatedTokenAccountIdempotentInstruction(
        payer, requirement.address, requirement.owner, requirement.mint, requirement.tokenProgram
      ));
      verifiedRequirements.push({
        role: requirement.role,
        address,
        mint: requirement.mint.toBase58(),
        tokenProgram: requirement.tokenProgram.toBase58(),
        state: "MISSING_CREATE_REQUIRED"
      });
    }
  }

  return {
    source: "helius-getMultipleAccounts",
    slot: snapshot.slot,
    observedAt: snapshot.observedAt,
    owner: owner.toBase58(),
    requirements: verifiedRequirements,
    createInstructions,
    accountsPresent: verifiedRequirements.every(item => item.state === "PRESENT_AND_VERIFIED"),
    paperEntryAuthorized: false
  };
}
