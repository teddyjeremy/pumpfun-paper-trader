import { calculateEpochFee } from "@solana/spl-token";
import type { TransferFeeConfig } from "@solana/spl-token";

export interface Token2022TransferFeeResult {
  grossAmountBaseUnits: string;
  netAmountBaseUnits: string;
  feeAmountBaseUnits: string;
  feeBasisPoints: number;
  maximumFeeBaseUnits: string;
  epoch: number | null;
  verified: true;
}

/**
 * Calculates the Token-2022 transfer fee for the exact snapshot epoch.
 * The caller must first prove that the epoch info and mint snapshot belong to
 * the same epoch. Transfer hooks remain unsupported and must fail closed.
 */
export function calculateToken2022TransferFee(input: {
  config: TransferFeeConfig | null;
  epoch: number | null;
  grossAmountBaseUnits: bigint;
}): Token2022TransferFeeResult {
  const { config, epoch, grossAmountBaseUnits } = input;
  if (grossAmountBaseUnits <= 0n || grossAmountBaseUnits > 18_446_744_073_709_551_615n) {
    throw new Error("Transfer-fee amount must be a positive u64 base-unit value.");
  }
  if (!config) {
    return {
      grossAmountBaseUnits: grossAmountBaseUnits.toString(),
      netAmountBaseUnits: grossAmountBaseUnits.toString(),
      feeAmountBaseUnits: "0",
      feeBasisPoints: 0,
      maximumFeeBaseUnits: "0",
      epoch,
      verified: true
    };
  }
  if (!Number.isSafeInteger(epoch) || epoch === null || epoch < 0) {
    throw new Error("A verified epoch is required for Token-2022 transfer-fee mints.");
  }
  const active = BigInt(epoch) >= config.newerTransferFee.epoch
    ? config.newerTransferFee
    : config.olderTransferFee;
  if (!Number.isInteger(active.transferFeeBasisPoints) ||
      active.transferFeeBasisPoints < 0 || active.transferFeeBasisPoints > 10_000 ||
      active.maximumFee < 0n) {
    throw new Error("Token-2022 transfer-fee schedule is invalid.");
  }
  const fee = calculateEpochFee(config, BigInt(epoch), grossAmountBaseUnits);
  if (fee < 0n || fee > grossAmountBaseUnits || fee > active.maximumFee) {
    throw new Error("Token-2022 transfer-fee calculation returned an invalid amount.");
  }
  const net = grossAmountBaseUnits - fee;
  if (net <= 0n) throw new Error("Token-2022 transfer fee consumes the entire quoted token amount.");
  return {
    grossAmountBaseUnits: grossAmountBaseUnits.toString(),
    netAmountBaseUnits: net.toString(),
    feeAmountBaseUnits: fee.toString(),
    feeBasisPoints: active.transferFeeBasisPoints,
    maximumFeeBaseUnits: active.maximumFee.toString(),
    epoch,
    verified: true
  };
}
