import { PublicKey } from "@solana/web3.js";
import type { HeliusAccountReadConfig } from "./helius-accounts.js";
import {
  inspectVirtualTraderAtaPrerequisites,
  type VirtualTraderAtaPrerequisites
} from "./virtual-trader-ata-prerequisites.js";
import {
  estimateVirtualTraderAtaRent,
  type VirtualTraderAtaRentEstimate
} from "./virtual-trader-ata-rent.js";
import type { NonSigningVirtualTraderIdentity } from "./virtual-trader-identity.js";
import type { PumpCurveV3UnsignedInstruction } from "./pump-sdk-curve-quote-adapter.js";
import type { PumpSwapV2UnsignedInstruction } from "./pump-sdk-quote-adapter.js";

export interface PumpInstructionAccountPrerequisites {
  venue: "PUMP_CURVE" | "PUMPSWAP";
  owner: string;
  ataSnapshot: VirtualTraderAtaPrerequisites;
  rentEstimate: VirtualTraderAtaRentEstimate;
  executionReady: false;
  paperEntryAuthorized: false;
  blockers: string[];
}

function removeBlocker(blockers: string[], blocker: string): void {
  const index = blockers.indexOf(blocker);
  if (index >= 0) blockers.splice(index, 1);
}

function assertTraderMatches(identity: NonSigningVirtualTraderIdentity, user: string): void {
  if (identity.kind !== "NON_SIGNING_VIRTUAL_TRADER" || identity.canSign !== false ||
      identity.canSubmit !== false || identity.publicKey !== user) {
    throw new Error("Unsigned instruction user must match the non-signing virtual trader identity.");
  }
  // Reject malformed keys before any provider request.
  new PublicKey(user);
}

/** Verify curve base ATA and reserve refundable rent for any idempotent ATA creation. */
export async function inspectPumpCurveV3InstructionPrerequisites(input: {
  identity: NonSigningVirtualTraderIdentity;
  instruction: PumpCurveV3UnsignedInstruction;
  config: HeliusAccountReadConfig;
}): Promise<PumpInstructionAccountPrerequisites> {
  assertTraderMatches(input.identity, input.instruction.user);
  const ataSnapshot = await inspectVirtualTraderAtaPrerequisites({
    identity: input.identity,
    baseMint: input.instruction.mint,
    baseTokenProgram: input.instruction.baseTokenProgram,
    config: input.config
  });
  const rentEstimate = await estimateVirtualTraderAtaRent({
    prerequisites: ataSnapshot, config: input.config
  });
  const blockers = [...input.instruction.blockers];
  if (ataSnapshot.accountsPresent) {
    removeBlocker(blockers, "USER_BASE_ATA_EXISTENCE_AND_STATE_NOT_VERIFIED");
  } else {
    blockers.push("USER_BASE_ATA_CREATION_INSTRUCTIONS_AND_RENT_RESERVE_REQUIRED");
  }
  if (rentEstimate.allNewAtaRentKnown) removeBlocker(blockers, "ATA_RENT_AND_VIRTUAL_PAYER_BALANCE_NOT_VERIFIED");
  else blockers.push("ATA_RENT_LAYOUT_OR_AMOUNT_UNSUPPORTED");
  removeBlocker(blockers, "BUYBACK_FEE_RECIPIENT_ACCOUNT_EXISTENCE_AND_STATE_NOT_VERIFIED");
  blockers.push("VIRTUAL_PAYER_BALANCE_NOT_VERIFIED");
  return {
    venue: "PUMP_CURVE", owner: ataSnapshot.owner, ataSnapshot, rentEstimate,
    executionReady: false, paperEntryAuthorized: false, blockers: [...new Set(blockers)]
  };
}

/** Verify the user ATAs and every configured PumpSwap buyback quote ATA. */
export async function inspectPumpSwapV2InstructionPrerequisites(input: {
  identity: NonSigningVirtualTraderIdentity;
  instruction: PumpSwapV2UnsignedInstruction;
  config: HeliusAccountReadConfig;
}): Promise<PumpInstructionAccountPrerequisites> {
  assertTraderMatches(input.identity, input.instruction.user);
  const additionalRequirements = input.instruction.buybackFeeRecipients.map(owner => ({
    role: "buyback" as const,
    owner,
    mint: input.instruction.quoteMint,
    tokenProgram: input.instruction.quoteTokenProgram
  }));
  const ataSnapshot = await inspectVirtualTraderAtaPrerequisites({
    identity: input.identity,
    baseMint: input.instruction.mint,
    baseTokenProgram: input.instruction.baseTokenProgram,
    quoteMint: input.instruction.quoteMint,
    quoteTokenProgram: input.instruction.quoteTokenProgram,
    additionalRequirements,
    config: input.config
  });
  const rentEstimate = await estimateVirtualTraderAtaRent({
    prerequisites: ataSnapshot, config: input.config
  });
  const blockers = [...input.instruction.blockers];
  const rolesPresent = (role: "base" | "quote" | "buyback") =>
    ataSnapshot.requirements.filter(item => item.role === role)
      .every(item => item.state === "PRESENT_AND_VERIFIED");
  if (rolesPresent("base")) removeBlocker(blockers, "USER_BASE_ATA_EXISTENCE_AND_STATE_NOT_VERIFIED");
  if (rolesPresent("quote")) removeBlocker(blockers, "USER_QUOTE_ATA_EXISTENCE_AND_STATE_NOT_VERIFIED");
  if (rolesPresent("buyback")) removeBlocker(blockers, "BUYBACK_QUOTE_ATA_EXISTENCE_AND_STATE_NOT_VERIFIED");
  if (!ataSnapshot.accountsPresent) blockers.push("MISSING_ATAS_REQUIRE_IDEMPOTENT_CREATE_INSTRUCTIONS");
  if (rentEstimate.allNewAtaRentKnown) removeBlocker(blockers, "ATA_RENT_AND_VIRTUAL_PAYER_BALANCE_NOT_VERIFIED");
  else blockers.push("ATA_RENT_LAYOUT_OR_AMOUNT_UNSUPPORTED");
  blockers.push("VIRTUAL_PAYER_BALANCE_NOT_VERIFIED");
  return {
    venue: "PUMPSWAP", owner: ataSnapshot.owner, ataSnapshot, rentEstimate,
    executionReady: false, paperEntryAuthorized: false, blockers: [...new Set(blockers)]
  };
}
