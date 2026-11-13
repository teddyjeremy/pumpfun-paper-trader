import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import type { HeliusAccountReadConfig } from "./helius-accounts.js";
import {
  buildPumpCurveV3UnsignedInstruction,
  type PumpCurveV3UnsignedInstruction
} from "./pump-sdk-curve-quote-adapter.js";
import {
  buildPumpSwapV2UnsignedInstructions,
  type PumpSwapV2UnsignedInstruction
} from "./pump-sdk-quote-adapter.js";
import { estimateFeesForUnsignedInstructions, type UnsignedInstructionFeeEvidence } from "./solana-fee-estimator.js";
import {
  inspectPumpCurveV3InstructionPrerequisites,
  inspectPumpSwapV2InstructionPrerequisites,
  type PumpInstructionAccountPrerequisites
} from "./pump-instruction-prerequisites.js";
import type { VerifiedPumpQuoteSnapshot } from "./pump-quote-snapshot.js";
import type { NonSigningVirtualTraderIdentity } from "./virtual-trader-identity.js";

export interface PumpUnsignedExecutionPlan {
  provider: "pump-sdk-4.3.1";
  venue: "PUMP_CURVE" | "PUMPSWAP";
  side: "BUY" | "SELL";
  mint: string;
  user: string;
  instructions: TransactionInstruction[];
  requiredAccountAddressesToVerify: string[];
  accountPrerequisites: PumpInstructionAccountPrerequisites;
  feeEvidence: UnsignedInstructionFeeEvidence;
  rentReserveLamports: number | null;
  executionReady: false;
  paperEntryAuthorized: false;
  blockers: string[];
}

function removeBlocker(blockers: string[], blocker: string): void {
  const index = blockers.indexOf(blocker);
  if (index >= 0) blockers.splice(index, 1);
}

function dedupePrerequisiteAtaCreates(
  prerequisiteInstructions: readonly TransactionInstruction[],
  venueInstructions: readonly TransactionInstruction[]
): TransactionInstruction[] {
  const existing = new Set<string>();
  for (const instruction of venueInstructions) {
    if (instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && instruction.keys[1]) {
      existing.add(instruction.keys[1].pubkey.toBase58());
    }
  }
  return prerequisiteInstructions.filter(instruction => {
    const address = instruction.keys[1]?.pubkey.toBase58();
    return !address || !existing.has(address);
  });
}

async function attachExactFees(input: {
  apiKey: string;
  user: string;
  recentBlockhash: string;
  instructions: TransactionInstruction[];
  computeUnitLimit: number;
  fetcher?: typeof fetch;
  nowMs?: number;
}): Promise<UnsignedInstructionFeeEvidence> {
  return estimateFeesForUnsignedInstructions({
    apiKey: input.apiKey,
    payer: new PublicKey(input.user),
    recentBlockhash: input.recentBlockhash,
    instructions: input.instructions,
    computeUnitLimit: input.computeUnitLimit,
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs })
  });
}

function finishPlan(input: {
  venue: PumpUnsignedExecutionPlan["venue"];
  side: "BUY" | "SELL";
  mint: string;
  user: string;
  venueInstructions: TransactionInstruction[];
  requiredAccountAddressesToVerify: string[];
  accountPrerequisites: PumpInstructionAccountPrerequisites;
  feeEvidence: UnsignedInstructionFeeEvidence;
}): PumpUnsignedExecutionPlan {
  const prerequisiteCreates = dedupePrerequisiteAtaCreates(
    input.accountPrerequisites.ataSnapshot.createInstructions,
    input.venueInstructions
  );
  const instructions = [...prerequisiteCreates, ...input.venueInstructions];
  const blockers = [...input.accountPrerequisites.blockers];
  if (input.accountPrerequisites.rentEstimate.allNewAtaRentKnown) {
    removeBlocker(blockers, "USER_BASE_ATA_CREATION_INSTRUCTIONS_AND_RENT_RESERVE_REQUIRED");
    removeBlocker(blockers, "MISSING_ATAS_REQUIRE_IDEMPOTENT_CREATE_INSTRUCTIONS");
    removeBlocker(blockers, "USER_BASE_ATA_EXISTENCE_AND_STATE_NOT_VERIFIED");
    removeBlocker(blockers, "USER_QUOTE_ATA_EXISTENCE_AND_STATE_NOT_VERIFIED");
    removeBlocker(blockers, "BUYBACK_QUOTE_ATA_EXISTENCE_AND_STATE_NOT_VERIFIED");
    removeBlocker(blockers, "ATA_RENT_LAYOUT_OR_AMOUNT_UNSUPPORTED");
    if ((input.accountPrerequisites.rentEstimate.newAtaRentReserveLamports ?? 0) > 0) {
      blockers.push("ATA_RENT_RESERVE_NOT_YET_RECORDED_IN_PAPER_PORTFOLIO");
    }
  } else {
    blockers.push("ATA_RENT_LAYOUT_OR_AMOUNT_UNSUPPORTED");
  }
  if (input.feeEvidence.status === "AVAILABLE") {
    removeBlocker(blockers, "EXACT_UNSIGNED_TRANSACTION_FEE_MESSAGE_NOT_ATTACHED");
    removeBlocker(blockers, "EXACT_UNSIGNED_TRANSACTION_FEE_EVIDENCE_UNAVAILABLE");
  } else {
    blockers.push("EXACT_UNSIGNED_TRANSACTION_FEE_EVIDENCE_UNAVAILABLE");
  }
  blockers.push("VIRTUAL_PAYER_BALANCE_NOT_VERIFIED", "PAPER_ENTRY_AUTHORIZATION_NOT_GRANTED");
  return {
    provider: "pump-sdk-4.3.1", venue: input.venue, side: input.side,
    mint: input.mint, user: input.user, instructions,
    requiredAccountAddressesToVerify: [...new Set([
      ...input.requiredAccountAddressesToVerify,
      ...input.accountPrerequisites.ataSnapshot.requirements.map(item => item.address),
      ...(input.accountPrerequisites.volumeAccumulator
        ? [input.accountPrerequisites.volumeAccumulator.address] : [])
    ])],
    accountPrerequisites: input.accountPrerequisites,
    feeEvidence: input.feeEvidence,
    rentReserveLamports: input.accountPrerequisites.totalNewRentReserveLamports,
    executionReady: false, paperEntryAuthorized: false,
    blockers: [...new Set(blockers)]
  };
}

/**
 * Assemble a complete unsigned Pump Curve V3 instruction bundle, including any
 * required user-ATA creation, then estimate fees for the exact final message.
 * No signing, simulation or transaction submission occurs.
 */
export async function buildPumpCurveV3UnsignedPlan(input: {
  identity: NonSigningVirtualTraderIdentity;
  snapshot: VerifiedPumpQuoteSnapshot;
  side: "BUY" | "SELL";
  tokenAmountBaseUnits: string;
  quoteAmountBaseUnits: string;
  apiKey: string;
  recentBlockhash: string;
  computeUnitLimit: number;
  config: HeliusAccountReadConfig;
  fetcher?: typeof fetch;
  nowMs?: number;
}): Promise<PumpUnsignedExecutionPlan> {
  const built: PumpCurveV3UnsignedInstruction = await buildPumpCurveV3UnsignedInstruction({
    snapshot: input.snapshot, user: input.identity.publicKey,
    side: input.side, tokenAmountBaseUnits: input.tokenAmountBaseUnits,
    quoteAmountBaseUnits: input.quoteAmountBaseUnits
  });
  const accountPrerequisites = await inspectPumpCurveV3InstructionPrerequisites({
    identity: input.identity, instruction: built, config: input.config
  });
  const prerequisiteCreates = dedupePrerequisiteAtaCreates(
    accountPrerequisites.ataSnapshot.createInstructions, [built.instruction]
  );
  const instructions = [...prerequisiteCreates, built.instruction];
  const feeEvidence = await attachExactFees({
    apiKey: input.apiKey, user: built.user, recentBlockhash: input.recentBlockhash,
    instructions, computeUnitLimit: input.computeUnitLimit,
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs })
  });
  const plan = finishPlan({
    venue: "PUMP_CURVE", side: input.side, mint: built.mint, user: built.user,
    venueInstructions: [built.instruction],
    requiredAccountAddressesToVerify: built.requiredAccountAddressesToVerify,
    accountPrerequisites, feeEvidence
  });
  return { ...plan, instructions };
}

/** Assemble PumpSwap V2 instructions, every configured buyback ATA prerequisite and exact final-message fee evidence. */
export async function buildPumpSwapV2UnsignedPlan(input: {
  identity: NonSigningVirtualTraderIdentity;
  snapshot: VerifiedPumpQuoteSnapshot;
  side: "BUY" | "SELL";
  tokenAmountBaseUnits: string;
  quoteAmountBaseUnits: string;
  apiKey: string;
  recentBlockhash: string;
  computeUnitLimit: number;
  config: HeliusAccountReadConfig;
  fetcher?: typeof fetch;
  nowMs?: number;
}): Promise<PumpUnsignedExecutionPlan> {
  const built: PumpSwapV2UnsignedInstruction = await buildPumpSwapV2UnsignedInstructions({
    snapshot: input.snapshot, user: input.identity.publicKey,
    side: input.side, tokenAmountBaseUnits: input.tokenAmountBaseUnits,
    quoteAmountBaseUnits: input.quoteAmountBaseUnits
  });
  const accountPrerequisites = await inspectPumpSwapV2InstructionPrerequisites({
    identity: input.identity, instruction: built, config: input.config
  });
  const prerequisiteCreates = dedupePrerequisiteAtaCreates(
    accountPrerequisites.ataSnapshot.createInstructions, built.instructions
  );
  const instructions = [...prerequisiteCreates, ...built.instructions];
  const feeEvidence = await attachExactFees({
    apiKey: input.apiKey, user: built.user, recentBlockhash: input.recentBlockhash,
    instructions, computeUnitLimit: input.computeUnitLimit,
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs })
  });
  const plan = finishPlan({
    venue: "PUMPSWAP", side: input.side, mint: built.mint, user: built.user,
    venueInstructions: built.instructions,
    requiredAccountAddressesToVerify: built.requiredAccountAddressesToVerify,
    accountPrerequisites, feeEvidence
  });
  return { ...plan, instructions };
}
