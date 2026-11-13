import { PublicKey } from "@solana/web3.js";
import { fetchHeliusMultipleAccounts, type HeliusAccountReadConfig } from "./helius-accounts.js";
import { buildHeliusRpcUrl } from "./helius.js";
import { PUMP_PROGRAM_ID } from "./pump-account-decoder.js";
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

const USER_VOLUME_ACCUMULATOR_DISCRIMINATOR = Uint8Array.from([30, 11, 48, 57, 93, 5, 90, 28]);

export interface PumpUserVolumeAccumulatorPrerequisite {
  address: string;
  state: "PRESENT_AND_VERIFIED" | "MISSING_INIT_IF_NEEDED";
  accountSpaceBytes: 137;
  minimumRentLamports: number | null;
  slot: number;
  observedAt: string;
}

export interface PumpInstructionAccountPrerequisites {
  venue: "PUMP_CURVE" | "PUMPSWAP";
  owner: string;
  ataSnapshot: VirtualTraderAtaPrerequisites;
  rentEstimate: VirtualTraderAtaRentEstimate;
  volumeAccumulator?: PumpUserVolumeAccumulatorPrerequisite;
  totalNewRentReserveLamports: number | null;
  executionReady: false;
  paperEntryAuthorized: false;
  blockers: string[];
}


async function inspectPumpUserVolumeAccumulator(input: {
  user: string;
  address: string;
  config: HeliusAccountReadConfig;
}): Promise<PumpUserVolumeAccumulatorPrerequisite> {
  const expectedAddress = PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), new PublicKey(input.user).toBuffer()],
    new PublicKey(PUMP_PROGRAM_ID)
  )[0].toBase58();
  if (input.address !== expectedAddress) {
    throw new Error("Pump user volume accumulator address does not match the canonical user PDA.");
  }
  const snapshot = await fetchHeliusMultipleAccounts([input.address], input.config);
  const nowMs = (input.config.now ?? Date.now)();
  const observedMs = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(observedMs) ||
      observedMs > nowMs || nowMs - observedMs > 2_000) {
    throw new Error("Pump user volume accumulator snapshot is stale or invalid.");
  }
  const account = snapshot.accounts[0] ?? null;
  if (account) {
    if (account.address !== input.address || account.slot !== snapshot.slot ||
        account.observedAt !== snapshot.observedAt || account.owner !== PUMP_PROGRAM_ID ||
        account.data.length !== 137 ||
        !USER_VOLUME_ACCUMULATOR_DISCRIMINATOR.every((byte, index) => account.data[index] === byte)) {
      throw new Error("Pump user volume accumulator has an unexpected owner, discriminator, size or snapshot context.");
    }
    return {
      address: input.address, state: "PRESENT_AND_VERIFIED",
      accountSpaceBytes: 137, minimumRentLamports: null,
      slot: snapshot.slot, observedAt: snapshot.observedAt
    };
  }

  const fetcher = input.config.fetcher ?? fetch;
  const response = await fetcher(buildHeliusRpcUrl(input.config.apiKey), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "paper-user-volume-accumulator-rent",
      method: "getMinimumBalanceForRentExemption",
      params: [137, { commitment: input.config.commitment ?? "confirmed" }]
    })
  });
  if (!response.ok) throw new Error("Helius volume accumulator rent request failed.");
  const envelope = await response.json() as { error?: unknown; result?: unknown };
  if (envelope.error || typeof envelope.result !== "number" ||
      !Number.isSafeInteger(envelope.result) || envelope.result < 0) {
    throw new Error("Helius returned invalid user volume accumulator rent evidence.");
  }
  return {
    address: input.address, state: "MISSING_INIT_IF_NEEDED",
    accountSpaceBytes: 137, minimumRentLamports: envelope.result,
    slot: snapshot.slot, observedAt: snapshot.observedAt
  };
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
  const volumeAccumulator = await inspectPumpUserVolumeAccumulator({
    user: input.instruction.user,
    address: input.instruction.userVolumeAccumulatorAddress,
    config: input.config
  });
  const volumeRent = volumeAccumulator.state === "MISSING_INIT_IF_NEEDED"
    ? volumeAccumulator.minimumRentLamports : 0;
  const totalNewRentReserveLamports = rentEstimate.newAtaRentReserveLamports === null || volumeRent === null
    ? null : rentEstimate.newAtaRentReserveLamports + volumeRent;
  const blockers = [...input.instruction.blockers];
  if (ataSnapshot.accountsPresent) {
    removeBlocker(blockers, "USER_BASE_ATA_EXISTENCE_AND_STATE_NOT_VERIFIED");
  } else {
    blockers.push("USER_BASE_ATA_CREATION_INSTRUCTIONS_AND_RENT_RESERVE_REQUIRED");
  }
  if (rentEstimate.allNewAtaRentKnown) removeBlocker(blockers, "ATA_RENT_AND_VIRTUAL_PAYER_BALANCE_NOT_VERIFIED");
  else blockers.push("ATA_RENT_LAYOUT_OR_AMOUNT_UNSUPPORTED");
  // The curve builder's buyback recipient is a wallet account for native-SOL
  // curves, not an ATA. This inspector has not fetched or validated that wallet
  // account, so retain the blocker until a dedicated account-state check exists.
  if (volumeAccumulator.state === "PRESENT_AND_VERIFIED") {
    removeBlocker(blockers, "USER_VOLUME_ACCUMULATOR_STATE_AND_RENT_NOT_VERIFIED");
  } else if (volumeAccumulator.minimumRentLamports !== null) {
    removeBlocker(blockers, "USER_VOLUME_ACCUMULATOR_STATE_AND_RENT_NOT_VERIFIED");
    blockers.push(
      "USER_VOLUME_ACCUMULATOR_RENT_RESERVE_NOT_RECORDED_IN_PAPER_PORTFOLIO",
      "USER_VOLUME_ACCUMULATOR_INIT_INSTRUCTION_NOT_INCLUDED"
    );
  }
  blockers.push("VIRTUAL_PAYER_BALANCE_NOT_VERIFIED");
  return {
    venue: "PUMP_CURVE", owner: ataSnapshot.owner, ataSnapshot, rentEstimate,
    volumeAccumulator, totalNewRentReserveLamports,
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
  if (input.instruction.buybackFeeRecipients.length === 0) {
    throw new Error("PumpSwap V2 requires at least one buyback fee recipient.");
  }
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
  const totalNewRentReserveLamports = rentEstimate.newAtaRentReserveLamports;
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
    totalNewRentReserveLamports,
    executionReady: false, paperEntryAuthorized: false, blockers: [...new Set(blockers)]
  };
}
