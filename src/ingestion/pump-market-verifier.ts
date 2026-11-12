import { deriveCanonicalPumpSwapPoolPda, derivePumpBondingCurvePda, derivePumpPoolCreatorAuthorityPda, derivePumpSwapPoolVaultAuthority } from "./pump-pdas.js";
import {
  decodeVerifiedPumpCurveAccount, toVerifiedPumpCurveEvidence,
  verifyCanonicalPumpSwapPoolSnapshot, type RawProgramAccount
} from "./pump-account-decoder.js";
import { updatePumpMarketState, type PumpMarketState } from "../paper/pump-market-state.js";

export function applyVerifiedPumpCurveAccount(input: {
  state: PumpMarketState;
  account: RawProgramAccount;
  nowMs?: number;
}): PumpMarketState {
  const decoded = decodeVerifiedPumpCurveAccount({
    account: input.account,
    expectedMint: input.state.mint,
    expectedCurveAddress: derivePumpBondingCurvePda(input.state.mint)
  });
  return updatePumpMarketState(input.state, {
    curve: toVerifiedPumpCurveEvidence(decoded),
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs })
  });
}

export function applyVerifiedPumpSwapPoolAccounts(input: {
  state: PumpMarketState;
  poolAccount: RawProgramAccount;
  baseVaultAccount: RawProgramAccount;
  quoteVaultAccount: RawProgramAccount;
  nowMs?: number;
}): PumpMarketState {
  const quoteMint = input.state.curve?.quoteMint;
  if (!quoteMint) throw new Error("A verified curve quote mint is required to derive the canonical PumpSwap pool.");
  const expectedPoolAddress = deriveCanonicalPumpSwapPoolPda(input.state.mint, quoteMint);
  const expectedPoolCreatorAuthority = derivePumpPoolCreatorAuthorityPda(input.state.mint);
  const expectedPoolAuthority = derivePumpSwapPoolVaultAuthority(expectedPoolAddress);
  const pool = verifyCanonicalPumpSwapPoolSnapshot({
    poolAccount: input.poolAccount,
    baseVaultAccount: input.baseVaultAccount,
    quoteVaultAccount: input.quoteVaultAccount,
    expectedMint: input.state.mint,
    expectedPoolAddress,
    expectedPoolCreatorAuthority,
    expectedPoolAuthority,
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs })
  });
  return updatePumpMarketState(input.state, {
    pool, ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs })
  });
}
