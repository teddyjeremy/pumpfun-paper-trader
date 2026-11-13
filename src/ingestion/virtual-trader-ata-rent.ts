import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { HeliusAccountReadConfig } from "./helius-accounts.js";
import type { VirtualTraderAtaPrerequisites } from "./virtual-trader-ata-prerequisites.js";

const LEGACY_TOKEN_ACCOUNT_BYTES = 165;

export interface AtaRentLineItem {
  role: "base" | "quote" | "buyback";
  address: string;
  tokenProgram: string;
  accountSpaceBytes: number | null;
  status: "NEW_RENT_REQUIRED" | "ALREADY_PRESENT" | "UNSUPPORTED_LAYOUT";
  minimumRentLamports: number | null;
}

export interface VirtualTraderAtaRentEstimate {
  source: "helius-getMinimumBalanceForRentExemption";
  fetchedAt: string;
  items: AtaRentLineItem[];
  newAtaRentReserveLamports: number | null;
  allNewAtaRentKnown: boolean;
  existingAtaRentExemptionVerified: false;
  simulatedPayerBalanceChecked: false;
  /** Rent is an expense in the simulated portfolio, not a funded chain account. */
  paperRentCanBeReservedInPortfolio: boolean;
  paperEntryAuthorized: false;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Helius rent response is malformed.");
  }
  return value as Record<string, unknown>;
}

/**
 * Calculates refundable rent-exempt SOL that must be reserved for missing legacy
 * SPL Token ATAs. Rent is locked collateral, not a trading fee or realized loss;
 * the portfolio may release the reserve only after the ATA is verified closed.
 * Token-2022 is fail-closed until mint extensions determine its exact account size.
 * This is paper accounting only: it never funds or creates an on-chain account.
 */
export async function estimateVirtualTraderAtaRent(input: {
  prerequisites: VirtualTraderAtaPrerequisites;
  config: HeliusAccountReadConfig;
}): Promise<VirtualTraderAtaRentEstimate> {
  if (input.prerequisites.paperEntryAuthorized !== false) {
    throw new Error("ATA prerequisites must remain explicitly non-authorizing.");
  }
  const missing = input.prerequisites.requirements.filter(
    requirement => requirement.state === "MISSING_CREATE_REQUIRED"
  );
  const unsupported = missing.filter(requirement =>
    requirement.tokenProgram === TOKEN_2022_PROGRAM_ID.toBase58()
  );
  const invalid = missing.filter(requirement =>
    requirement.tokenProgram !== TOKEN_PROGRAM_ID.toBase58() &&
    requirement.tokenProgram !== TOKEN_2022_PROGRAM_ID.toBase58()
  );
  if (invalid.length) throw new Error("ATA rent estimate received an unsupported token program.");

  const fetchedAt = new Date((input.config.now ?? Date.now)()).toISOString();
  const items: AtaRentLineItem[] = input.prerequisites.requirements.map(requirement => {
    if (requirement.state === "PRESENT_AND_VERIFIED") {
      return {
        role: requirement.role,
        address: requirement.address,
        tokenProgram: requirement.tokenProgram,
        accountSpaceBytes: null,
        status: "ALREADY_PRESENT",
        minimumRentLamports: null
      };
    }
    if (requirement.tokenProgram === TOKEN_2022_PROGRAM_ID.toBase58()) {
      return {
        role: requirement.role,
        address: requirement.address,
        tokenProgram: requirement.tokenProgram,
        accountSpaceBytes: null,
        status: "UNSUPPORTED_LAYOUT",
        minimumRentLamports: null
      };
    }
    return {
      role: requirement.role,
      address: requirement.address,
      tokenProgram: requirement.tokenProgram,
      accountSpaceBytes: LEGACY_TOKEN_ACCOUNT_BYTES,
      status: "NEW_RENT_REQUIRED",
      minimumRentLamports: null
    };
  });

  if (unsupported.length) {
    return {
      source: "helius-getMinimumBalanceForRentExemption",
      fetchedAt,
      items,
      newAtaRentReserveLamports: null,
      allNewAtaRentKnown: false,
      existingAtaRentExemptionVerified: false,
      simulatedPayerBalanceChecked: false,
      paperRentCanBeReservedInPortfolio: false,
      paperEntryAuthorized: false
    };
  }

  const sizes = [...new Set(items
    .filter(item => item.status === "NEW_RENT_REQUIRED")
    .map(item => item.accountSpaceBytes!))];
  const fetcher = input.config.fetcher ?? fetch;
  const rentBySize = new Map<number, number>();
  for (const size of sizes) {
    const response = await fetcher(
      `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(input.config.apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `paper-ata-rent-${size}`,
          method: "getMinimumBalanceForRentExemption",
          params: [size, { commitment: input.config.commitment ?? "confirmed" }]
        })
      }
    );
    if (!response.ok) throw new Error(`Helius rent RPC returned HTTP ${response.status}.`);
    const envelope = asRecord(await response.json());
    if (envelope.error || !Object.prototype.hasOwnProperty.call(envelope, "result")) {
      throw new Error("Helius rent RPC did not return a minimum balance.");
    }
    const lamports = envelope.result;
    if (typeof lamports !== "number" || !Number.isSafeInteger(lamports) || lamports < 0) {
      throw new Error("Helius rent RPC returned an invalid lamport amount.");
    }
    rentBySize.set(size, lamports);
  }

  for (const item of items) {
    if (item.status === "NEW_RENT_REQUIRED" && item.accountSpaceBytes !== null) {
      item.minimumRentLamports = rentBySize.get(item.accountSpaceBytes) ?? null;
    }
  }
  const allNewAtaRentKnown = items.every(item =>
    item.status !== "NEW_RENT_REQUIRED" || item.minimumRentLamports !== null
  );
  const total = allNewAtaRentKnown
    ? items.reduce((sum, item) => sum + (item.minimumRentLamports ?? 0), 0)
    : null;
  if (total !== null && !Number.isSafeInteger(total)) {
    throw new Error("Combined ATA rent exceeds safe integer precision.");
  }

  return {
    source: "helius-getMinimumBalanceForRentExemption",
    fetchedAt,
    items,
    newAtaRentReserveLamports: total,
    allNewAtaRentKnown,
    existingAtaRentExemptionVerified: false,
    simulatedPayerBalanceChecked: false,
    paperRentCanBeReservedInPortfolio: allNewAtaRentKnown,
    paperEntryAuthorized: false
  };
}
