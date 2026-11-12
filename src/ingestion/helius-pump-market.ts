import {
  discoverCanonicalPumpSwapPoolForMint, fetchHeliusMultipleAccounts,
  type HeliusAccountReadConfig
} from "./helius-accounts.js";
import type { RawProgramAccount } from "./pump-account-decoder.js";
import {
  deriveCanonicalPumpSwapPoolPda, derivePumpBondingCurvePda, derivePumpPoolCreatorAuthorityPda
} from "./pump-pdas.js";
import {
  applyVerifiedPumpCurveAccount, applyVerifiedPumpSwapPoolAccounts
} from "./pump-market-verifier.js";
import type { PumpMarketState } from "../paper/pump-market-state.js";

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : "Unknown account verification failure.";
}

/**
 * Fetches and verifies the live Pump curve, then (only after curve completion)
 * discovers the canonical index-0 PumpSwap pool and re-fetches the pool and
 * both vaults together at one Helius context slot.
 *
 * Network/discovery failures never authorize a quote or fill. A completed
 * curve remains MIGRATION_PENDING until the pool/vault snapshot is verified.
 */
export async function refreshPumpMarketStateFromHelius(input: {
  state: PumpMarketState;
  config: HeliusAccountReadConfig;
}): Promise<PumpMarketState> {
  let nowMs = (input.config.now ?? Date.now)();
  if (!Number.isFinite(nowMs)) {
    return { ...input.state, status: "EXIT_BLOCKED", pool: null,
      reason: "Helius account verifier received an invalid local timestamp." };
  }
  let curveAccount: RawProgramAccount | null;
  try {
    const curveAddress = derivePumpBondingCurvePda(input.state.mint);
    const snapshot = await fetchHeliusMultipleAccounts([curveAddress], input.config);
    curveAccount = snapshot.accounts[0] ?? null;
  } catch (error) {
    return {
      ...input.state, status: "EXIT_BLOCKED", updatedAt: new Date(nowMs).toISOString(), curve: null, pool: null,
      reason: `Pump curve account fetch failed: ${failureReason(error)}`
    };
  }
  if (!curveAccount) {
    return {
      ...input.state, status: "EXIT_BLOCKED", updatedAt: new Date(nowMs).toISOString(), curve: null, pool: null,
      reason: "The expected Pump bonding-curve PDA has no account data."
    };
  }

  let curveState: PumpMarketState;
  try {
    nowMs = (input.config.now ?? Date.now)();
    if (!Number.isFinite(nowMs)) throw new Error("Invalid curve verification timestamp.");
    curveState = applyVerifiedPumpCurveAccount({
      state: input.state, account: curveAccount, nowMs
    });
  } catch (error) {
    return {
      ...input.state, status: "EXIT_BLOCKED", updatedAt: new Date(nowMs).toISOString(), curve: null, pool: null,
      reason: `Pump curve verification failed: ${failureReason(error)}`
    };
  }
  if (curveState.status !== "MIGRATION_PENDING" || !curveState.curve) return curveState;

  const quoteMint = curveState.curve.quoteMint;
  try {
    const expectedPoolAddress = deriveCanonicalPumpSwapPoolPda(input.state.mint, quoteMint);
    const expectedPoolCreatorAuthority = derivePumpPoolCreatorAuthorityPda(input.state.mint);
    const candidate = await discoverCanonicalPumpSwapPoolForMint({
      mint: input.state.mint, expectedPoolAddress, expectedPoolCreatorAuthority, config: input.config
    });
    if (!candidate) {
      return { ...curveState, reason: "Curve is complete; canonical PumpSwap pool has not been discovered yet." };
    }

    const poolSnapshot = await fetchHeliusMultipleAccounts(
      [candidate.pool.address, candidate.pool.baseVault, candidate.pool.quoteVault], input.config
    );
    const [poolAccount, baseVaultAccount, quoteVaultAccount] = poolSnapshot.accounts;
    if (!poolAccount || !baseVaultAccount || !quoteVaultAccount) {
      return { ...curveState, reason: "Curve is complete; canonical pool or one of its vault accounts is not yet available." };
    }
    nowMs = (input.config.now ?? Date.now)();
    if (!Number.isFinite(nowMs)) throw new Error("Invalid pool verification timestamp.");
    return applyVerifiedPumpSwapPoolAccounts({
      state: curveState, poolAccount, baseVaultAccount, quoteVaultAccount, nowMs
    });
  } catch (error) {
    return {
      ...curveState, status: "EXIT_BLOCKED", updatedAt: new Date(nowMs).toISOString(), pool: null,
      reason: `PumpSwap pool/vault verification failed: ${failureReason(error)}`
    };
  }
}
