import BN from "bn.js";
import { Buffer } from "node:buffer";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  getTransferFeeConfig, getTransferHook, unpackMint, type RawMint
} from "@solana/spl-token";
import {
  PUMP_SDK, PUMP_GLOBAL_PDA, PUMP_FEE_CONFIG_PDA,
  computeFeesBps, getBuyTokenAmountFromSolAmount,
  getBuySolAmountFromTokenAmount, getSellSolAmountFromTokenAmount
} from "@pump-fun/pump-sdk";
import type { BondingCurve, FeeConfig, Global } from "@pump-fun/pump-sdk";
import {
  decodeVerifiedPumpCurveAccount, PUMP_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID, type RawProgramAccount
} from "./pump-account-decoder.js";
import { derivePumpBondingCurvePda } from "./pump-pdas.js";
import {
  fetchVerifiedPumpQuoteAccountSnapshot,
  type VerifiedPumpQuoteSnapshot
} from "./pump-quote-snapshot.js";
import type { HeliusAccountReadConfig } from "./helius-accounts.js";

const PUMP_FEE_PROGRAM_ID = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const MAX_U64 = 18_446_744_073_709_551_615n;
const BPS = new BN(10_000);

function isU64(value: string): boolean {
  return /^\d+$/.test(value) && value.length <= 20 && BigInt(value) <= MAX_U64;
}

function accountInfo(account: RawProgramAccount): AccountInfo<Buffer> {
  return {
    data: Buffer.from(account.data), executable: false, lamports: 0,
    owner: new PublicKey(account.owner), rentEpoch: 0
  };
}

function feeAmount(amount: BN, bps: BN): BN {
  return amount.mul(bps).add(new BN(9_999)).div(BPS);
}

function priceImpactPct(
  executionQuote: BN, executionToken: BN,
  spotQuote: BN, spotToken: BN, side: "BUY" | "SELL"
): number {
  if (executionQuote.lten(0) || executionToken.lten(0) ||
      spotQuote.lten(0) || spotToken.lten(0)) {
    throw new Error("Bonding-curve price impact inputs must be positive.");
  }
  const scale = new BN("1000000000000");
  const ratio = Number(
    executionQuote.mul(spotToken).mul(scale).div(executionToken.mul(spotQuote)).toString()
  ) / Number(scale.toString());
  const impact = side === "BUY" ? (ratio - 1) * 100 : (1 - ratio) * 100;
  if (!Number.isFinite(impact)) throw new Error("Bonding-curve price impact is invalid.");
  return Math.max(0, impact);
}

export interface PumpCurveSdkQuote {
  provider: "pump-sdk-4.3.1";
  venue: "pump-bonding-curve";
  side: "BUY" | "SELL";
  mint: string;
  quoteMint: string;
  slot: number;
  observedAt: string;
  inputAmountBaseUnits: string;
  outputAmountBaseUnits: string;
  grossQuoteAmountBaseUnits: string;
  netQuoteAmountBaseUnits: string;
  fees: {
    protocolBaseUnits: string;
    creatorBaseUnits: string;
    totalBaseUnits: string;
  };
  unspentQuoteBaseUnits: string;
  priceImpactPct: number;
  baseDecimals: number;
  quoteDecimals: 9;
  transferTaxVerifiedZero: true;
  executionReady: false;
  blockers: string[];
}

export interface PumpCurveSdkQuoteState {
  global: Global;
  feeConfig: FeeConfig | null;
  bondingCurve: BondingCurve;
  mint: PublicKey;
  slot: number;
  observedAt: string;
  baseDecimals: number;
}

function quoteFees(state: PumpCurveSdkQuoteState) {
  const curve = state.bondingCurve;
  const rates = computeFeesBps({
    global: state.global,
    feeConfig: state.feeConfig,
    mintSupply: curve.tokenTotalSupply,
    virtualQuoteReserves: curve.virtualQuoteReserves,
    virtualTokenReserves: curve.virtualTokenReserves,
    quoteMint: curve.quoteMint,
    creatorFeeBps: curve.creatorFeeBps
  });
  return {
    protocol: rates.protocolFeeBps,
    creator: PublicKey.default.equals(curve.creator) ? new BN(0) : rates.creatorFeeBps
  };
}

/** SDK-backed exact-input quote for an active legacy-SOL Pump bonding curve. */
export function quotePumpCurveBuyFromSdkState(
  state: PumpCurveSdkQuoteState,
  quoteBudgetBaseUnits: string
): PumpCurveSdkQuote {
  if (!isU64(quoteBudgetBaseUnits) || BigInt(quoteBudgetBaseUnits) <= 0n) {
    throw new Error("Bonding-curve buy budget must be a positive u64 base-unit integer.");
  }
  const curve = state.bondingCurve;
  if (curve.complete || curve.virtualTokenReserves.isZero() ||
      !curve.quoteMint.equals(PublicKey.default) || curve.isCashbackCoin) {
    throw new Error("Bonding curve is complete, migrated, cashback or not SOL-quoted.");
  }
  const budget = new BN(quoteBudgetBaseUnits);
  const tokensOut = getBuyTokenAmountFromSolAmount({
    global: state.global, feeConfig: state.feeConfig,
    mintSupply: curve.tokenTotalSupply, bondingCurve: curve, amount: budget
  });
  if (tokensOut.isZero() || tokensOut.gte(curve.virtualTokenReserves)) {
    throw new Error("SDK bonding-curve buy output is zero or outside virtual reserves.");
  }

  // Exact inverse constant-product input for the SDK-selected token output.
  const netCurveInput = tokensOut.mul(curve.virtualQuoteReserves)
    .div(curve.virtualTokenReserves.sub(tokensOut)).addn(1);
  const rates = quoteFees(state);
  const protocolFee = feeAmount(netCurveInput, rates.protocol);
  const creatorFee = feeAmount(netCurveInput, rates.creator);
  const totalCost = netCurveInput.add(protocolFee).add(creatorFee);
  const sdkExactCost = getBuySolAmountFromTokenAmount({
    global: state.global, feeConfig: state.feeConfig,
    mintSupply: curve.tokenTotalSupply, bondingCurve: curve, amount: tokensOut
  });
  if (!totalCost.eq(sdkExactCost) || totalCost.gt(budget)) {
    throw new Error("Pump SDK buy quote and independently reconciled fee amounts disagree.");
  }

  return {
    provider: "pump-sdk-4.3.1", venue: "pump-bonding-curve", side: "BUY",
    mint: state.mint.toBase58(), quoteMint: PublicKey.default.toBase58(),
    slot: state.slot, observedAt: state.observedAt,
    inputAmountBaseUnits: budget.toString(), outputAmountBaseUnits: tokensOut.toString(),
    grossQuoteAmountBaseUnits: totalCost.toString(),
    netQuoteAmountBaseUnits: netCurveInput.toString(),
    fees: { protocolBaseUnits: protocolFee.toString(), creatorBaseUnits: creatorFee.toString(),
      totalBaseUnits: protocolFee.add(creatorFee).toString() },
    unspentQuoteBaseUnits: budget.sub(totalCost).toString(),
    priceImpactPct: priceImpactPct(netCurveInput, tokensOut,
      curve.virtualQuoteReserves, curve.virtualTokenReserves, "BUY"),
    baseDecimals: state.baseDecimals, quoteDecimals: 9,
    transferTaxVerifiedZero: true, executionReady: false,
    blockers: ["network fee and priority fee estimates are not attached",
      "SOL/USD valuation is not attached", "simulated execution latency is not attached"]
  };
}

/** SDK-backed exact-size sell quote for an active legacy-SOL Pump bonding curve. */
export function quotePumpCurveSellFromSdkState(
  state: PumpCurveSdkQuoteState,
  tokenAmountBaseUnits: string
): PumpCurveSdkQuote {
  if (!isU64(tokenAmountBaseUnits) || BigInt(tokenAmountBaseUnits) <= 0n) {
    throw new Error("Bonding-curve sell size must be a positive u64 base-unit integer.");
  }
  const curve = state.bondingCurve;
  if (curve.complete || curve.virtualTokenReserves.isZero() ||
      !curve.quoteMint.equals(PublicKey.default) || curve.isCashbackCoin) {
    throw new Error("Bonding curve is complete, migrated, cashback or not SOL-quoted.");
  }
  const tokenAmount = new BN(tokenAmountBaseUnits);
  const grossQuote = tokenAmount.mul(curve.virtualQuoteReserves)
    .div(curve.virtualTokenReserves.add(tokenAmount));
  if (grossQuote.isZero() || grossQuote.gt(curve.realQuoteReserves)) {
    throw new Error("Bonding-curve sell exceeds verified real quote liquidity.");
  }
  const rates = quoteFees(state);
  const protocolFee = feeAmount(grossQuote, rates.protocol);
  const creatorFee = feeAmount(grossQuote, rates.creator);
  const totalFees = protocolFee.add(creatorFee);
  const expectedNet = BN.max(new BN(0), grossQuote.sub(totalFees));
  const sdkNet = getSellSolAmountFromTokenAmount({
    global: state.global, feeConfig: state.feeConfig,
    mintSupply: curve.tokenTotalSupply, bondingCurve: curve, amount: tokenAmount
  });
  if (!expectedNet.eq(sdkNet) || expectedNet.isZero()) {
    throw new Error("Pump SDK sell quote and independently reconciled fee amounts disagree or round to zero.");
  }

  return {
    provider: "pump-sdk-4.3.1", venue: "pump-bonding-curve", side: "SELL",
    mint: state.mint.toBase58(), quoteMint: PublicKey.default.toBase58(),
    slot: state.slot, observedAt: state.observedAt,
    inputAmountBaseUnits: tokenAmount.toString(), outputAmountBaseUnits: sdkNet.toString(),
    grossQuoteAmountBaseUnits: grossQuote.toString(),
    netQuoteAmountBaseUnits: sdkNet.toString(),
    fees: { protocolBaseUnits: protocolFee.toString(), creatorBaseUnits: creatorFee.toString(),
      totalBaseUnits: totalFees.toString() },
    unspentQuoteBaseUnits: "0",
    priceImpactPct: priceImpactPct(grossQuote, tokenAmount,
      curve.virtualQuoteReserves, curve.virtualTokenReserves, "SELL"),
    baseDecimals: state.baseDecimals, quoteDecimals: 9,
    transferTaxVerifiedZero: true, executionReady: false,
    blockers: ["network fee and priority fee estimates are not attached",
      "SOL/USD valuation is not attached", "simulated execution latency is not attached"]
  };
}

function decodeCurveState(snapshot: VerifiedPumpQuoteSnapshot, mint: PublicKey): PumpCurveSdkQuoteState {
  const curveAccount = snapshot.accounts.market;
  const mintAccount = snapshot.accounts.baseMint;
  const globalAccount = snapshot.accounts.globalConfig;
  const feeAccount = snapshot.accounts.feeConfig;
  if (!curveAccount || !mintAccount || !globalAccount || !feeAccount ||
      snapshot.accounts.quoteMint !== null) {
    throw new Error("Pump curve quote snapshot is missing a required SOL-curve account or has a non-SOL quote mint.");
  }
  for (const [role, account] of [
    ["market", curveAccount], ["baseMint", mintAccount],
    ["globalConfig", globalAccount], ["feeConfig", feeAccount]
  ] as const) {
    if (account.slot !== snapshot.slot || account.observedAt !== snapshot.observedAt) {
      throw new Error(`Pump curve ${role} account is outside the verified Helius context.`);
    }
  }
  const curveAddress = derivePumpBondingCurvePda(mint.toBase58());
  if (curveAccount.address !== curveAddress || curveAccount.owner !== PUMP_PROGRAM_ID ||
      globalAccount.address !== PUMP_GLOBAL_PDA.toBase58() || globalAccount.owner !== PUMP_PROGRAM_ID ||
      feeAccount.address !== PUMP_FEE_CONFIG_PDA.toBase58() || feeAccount.owner !== PUMP_FEE_PROGRAM_ID) {
    throw new Error("Pump curve, Global or FeeConfig account identity/owner verification failed.");
  }
  if (mintAccount.owner !== SPL_TOKEN_PROGRAM_ID && mintAccount.owner !== TOKEN_2022_PROGRAM_ID) {
    throw new Error("Pump curve mint is not owned by an accepted token program.");
  }
  const customCurve = decodeVerifiedPumpCurveAccount({
    account: curveAccount, expectedMint: mint.toBase58(), expectedCurveAddress: curveAddress
  });
  if (customCurve.complete || customCurve.migrated || customCurve.quoteMint !== PublicKey.default.toBase58()) {
    throw new Error("Only an active, incomplete, legacy-SOL bonding curve can be quoted here.");
  }
  const unpackedMint = unpackMint(mint, accountInfo(mintAccount), new PublicKey(mintAccount.owner));
  if (getTransferFeeConfig(unpackedMint) || getTransferHook(unpackedMint)) {
    throw new Error("Transfer-fee and transfer-hook mints are not supported by the bonding-curve quote adapter.");
  }
  const sdkCurve = PUMP_SDK.decodeBondingCurve(accountInfo(curveAccount));
  const global = PUMP_SDK.decodeGlobal(accountInfo(globalAccount));
  const feeConfig = PUMP_SDK.decodeFeeConfig(accountInfo(feeAccount));
  if (!sdkCurve.virtualTokenReserves.eq(new BN(customCurve.virtualTokenReserves)) ||
      !sdkCurve.virtualQuoteReserves.eq(new BN(customCurve.virtualQuoteReserves)) ||
      !sdkCurve.realTokenReserves.eq(new BN(customCurve.realTokenReserves)) ||
      !sdkCurve.realQuoteReserves.eq(new BN(customCurve.realQuoteReserves)) ||
      !sdkCurve.tokenTotalSupply.eq(new BN(customCurve.tokenTotalSupply)) ||
      sdkCurve.complete !== customCurve.complete) {
    throw new Error("Official Pump SDK curve decoder disagrees with the verified curve account.");
  }
  return {
    global, feeConfig, bondingCurve: sdkCurve, mint,
    slot: snapshot.slot, observedAt: snapshot.observedAt,
    baseDecimals: unpackedMint.decimals
  };
}

/** Fetch a fresh single-slot curve + Global + FeeConfig + mint snapshot, then quote offline. */
export async function fetchPumpCurveSdkQuote(input: {
  mint: string;
  side: "BUY" | "SELL";
  amountBaseUnits: string;
  config: HeliusAccountReadConfig;
}): Promise<PumpCurveSdkQuote> {
  if (!PublicKey.isOnCurve(new PublicKey(input.mint).toBytes()) && !input.mint) {
    throw new Error("Mint address is invalid.");
  }
  const mint = new PublicKey(input.mint);
  const curveAddress = derivePumpBondingCurvePda(input.mint);
  const snapshot = await fetchVerifiedPumpQuoteAccountSnapshot({
    addresses: {
      market: curveAddress,
      baseMint: input.mint,
      quoteMint: PublicKey.default.toBase58(),
      globalConfig: PUMP_GLOBAL_PDA.toBase58(),
      feeConfig: PUMP_FEE_CONFIG_PDA.toBase58()
    },
    config: input.config
  });
  const state = decodeCurveState(snapshot, mint);
  return input.side === "BUY"
    ? quotePumpCurveBuyFromSdkState(state, input.amountBaseUnits)
    : quotePumpCurveSellFromSdkState(state, input.amountBaseUnits);
}
