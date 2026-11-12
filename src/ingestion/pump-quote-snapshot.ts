import {
  fetchHeliusMultipleAccounts,
  type HeliusAccountReadConfig,
  type HeliusAccountSnapshot
} from "./helius-accounts.js";
import type { RawProgramAccount } from "./pump-account-decoder.js";

export type PumpQuoteAccountRole =
  | "market"
  | "baseMint"
  | "quoteMint"
  | "globalConfig"
  | "feeConfig"
  | "baseVault"
  | "quoteVault"
  | "quoteControl"
  | "ammFeeConfig"
  | "feeProgramGlobal";

export interface PumpQuoteAccountAddresses {
  market: string;
  baseMint: string;
  quoteMint: string;
  globalConfig: string;
  feeConfig: string;
  baseVault?: string;
  quoteVault?: string;
  quoteControl?: string;
  ammFeeConfig?: string;
  feeProgramGlobal?: string;
}

export interface VerifiedPumpQuoteSnapshot {
  source: "helius-getMultipleAccounts";
  verified: true;
  slot: number;
  commitment: "confirmed" | "finalized";
  observedAt: string;
  accounts: Partial<Record<PumpQuoteAccountRole, RawProgramAccount | null>> & Pick<
    Record<PumpQuoteAccountRole, RawProgramAccount | null>,
    "market" | "baseMint" | "quoteMint" | "globalConfig" | "feeConfig"
  >;
  accountCount: number;
}

const DEFAULT_MAX_AGE_MS = 2_000;

/**
 * Quotes must be built from one Helius getMultipleAccounts response.
 * This helper intentionally does not decode SDK accounts or calculate prices:
 * it establishes that every required input came from the same RPC context slot.
 */
export function verifyPumpQuoteAccountSnapshot(input: {
  addresses: PumpQuoteAccountAddresses;
  snapshot: HeliusAccountSnapshot;
  nowMs?: number;
  maxAgeMs?: number;
}): VerifiedPumpQuoteSnapshot {
  const nowMs = input.nowMs ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 10_000) {
    throw new Error("Pump quote snapshot clock or freshness limit is invalid.");
  }
  const roles = Object.keys(input.addresses) as PumpQuoteAccountRole[];
  const entries = roles.map(role => [role, input.addresses[role]] as const);
  const requiredRoles: PumpQuoteAccountRole[] = [
    "market", "baseMint", "quoteMint", "globalConfig", "feeConfig"
  ];
  if (requiredRoles.some(role => !roles.includes(role)) ||
      entries.some(([, address]) => typeof address !== "string" || !address.trim()) ||
      new Set(entries.map(([, address]) => address)).size !== entries.length) {
    throw new Error("Pump quote snapshot requires unique addresses for market, mints, global config and fee config.");
  }
  if (!Number.isSafeInteger(input.snapshot.slot) || input.snapshot.slot < 0 ||
      !Number.isFinite(Date.parse(input.snapshot.observedAt)) ||
      Date.parse(input.snapshot.observedAt) > nowMs ||
      nowMs - Date.parse(input.snapshot.observedAt) > maxAgeMs) {
    throw new Error("Pump quote snapshot is stale or has an invalid context slot.");
  }
  if (input.snapshot.accounts.length !== entries.length) {
    throw new Error("Pump quote snapshot account count does not match its requested address set.");
  }
  const accounts = {} as Partial<Record<PumpQuoteAccountRole, RawProgramAccount | null>>;
  for (let index = 0; index < entries.length; index += 1) {
    const [role, address] = entries[index]!;
    const account = input.snapshot.accounts[index] ?? null;
    if (!account) {
      if (role === "quoteMint" && address === "11111111111111111111111111111111") {
        accounts[role] = null;
        continue;
      }
      throw new Error(`Pump quote snapshot is missing or misordered the ${role} account.`);
    }
    if (account.address !== address) {
      throw new Error(`Pump quote snapshot is missing or misordered the ${role} account.`);
    }
    if (account.slot !== input.snapshot.slot || account.observedAt !== input.snapshot.observedAt) {
      throw new Error("Every Pump quote account must share the same Helius context slot and observation time.");
    }
    accounts[role] = account;
  }
  return {
    source: "helius-getMultipleAccounts",
    verified: true,
    slot: input.snapshot.slot,
    commitment: input.snapshot.commitment,
    observedAt: input.snapshot.observedAt,
    accounts: accounts as VerifiedPumpQuoteSnapshot["accounts"],
    accountCount: entries.length
  };
}

export async function fetchVerifiedPumpQuoteAccountSnapshot(input: {
  addresses: PumpQuoteAccountAddresses;
  config: HeliusAccountReadConfig;
}): Promise<VerifiedPumpQuoteSnapshot> {
  const roles = Object.keys(input.addresses) as PumpQuoteAccountRole[];
  const requestRoles = roles.filter(role =>
    !(role === "quoteMint" && input.addresses.quoteMint === "11111111111111111111111111111111")
  );
  const requestAddresses = requestRoles.map(role => input.addresses[role]!);
  const fetched = await fetchHeliusMultipleAccounts(requestAddresses, input.config);
  let requestIndex = 0;
  const snapshot: HeliusAccountSnapshot = {
    ...fetched,
    accounts: roles.map(role => {
      if (role === "quoteMint" && input.addresses.quoteMint === "11111111111111111111111111111111") {
        return null;
      }
      return fetched.accounts[requestIndex++] ?? null;
    })
  };
  return verifyPumpQuoteAccountSnapshot({
    addresses: input.addresses,
    snapshot,
    nowMs: (input.config.now ?? Date.now)()
  });
}
