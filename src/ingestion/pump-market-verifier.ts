import {
  decodeVerifiedPumpCurveAccount, toVerifiedPumpCurveEvidence,
  verifyCanonicalPumpSwapPoolSnapshot, type RawProgramAccount
} from "./pump-account-decoder.js";
import { updatePumpMarketState, type PumpMarketState } from "../paper/pump-market-state.js";

export function applyVerifiedPumpCurveAccount(input: {
  state: PumpMarketState;
  account: RawProgramAccount;
  expectedCurveAddress: string;
  nowMs?: number;
}): PumpMarketState {
  const decoded = decodeVerifiedPumpCurveAccount({
    account: input.account,
    expectedMint: input.state.mint,
    expectedCurveAddress: input.expectedCurveAddress
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
  expectedPoolAddress: string;
  expectedPoolCreatorAuthority: string;
  expectedPoolAuthority: string;
  nowMs?: number;
}): PumpMarketState {
  const pool = verifyCanonicalPumpSwapPoolSnapshot({
    poolAccount: input.poolAccount,
    baseVaultAccount: input.baseVaultAccount,
    quoteVaultAccount: input.quoteVaultAccount,
    expectedMint: input.state.mint,
    expectedPoolAddress: input.expectedPoolAddress,
    expectedPoolCreatorAuthority: input.expectedPoolCreatorAuthority,
    expectedPoolAuthority: input.expectedPoolAuthority,
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs })
  });
  return updatePumpMarketState(input.state, {
    pool, ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs })
  });
}
