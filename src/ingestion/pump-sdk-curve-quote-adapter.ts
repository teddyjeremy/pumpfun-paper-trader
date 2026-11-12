import BN from "bn.js";
import { Buffer } from "node:buffer";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, getTransferFeeConfig, getTransferHook, unpackMint,
  type RawMint
} from "@solana/spl-token";
import {
  GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, PUMP_SDK,
  getBuyV3QuoteAmountFromTokenAmount,
  getBuyV3TokenAmountFromQuoteAmount,
  getSellSolAmountFromTokenAmount
} from "@pump-fun/pump-sdk";
import {
  decodeSplTokenAccount, decodeVerifiedPumpCurveAccount,
  PUMP_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  type RawProgramAccount
} from "./pump-account-decoder.js";
import { derivePumpBondingCurvePda } from "./pump-pdas.js";
import {
  fetchHeliusMultipleAccounts, type HeliusAccountReadConfig
} from "./helius-accounts.js";
import {
  fetchVerifiedPumpQuoteAccountSnapshot, type VerifiedPumpQuoteSnapshot
} from "./pump-quote-snapshot.js";
import { isSolQuoteMint } from "./trade-flow.js";

const PUMP_FEE_PROGRAM_ID = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const MAX_U64 = 18_446_744_073_709_551_615n;

function isU64BaseUnits(value: string): boolean {
  return /^\d+$/.test(value) && value.length <= 20 && BigInt(value) <= MAX_U64;
}

function accountInfo(account: RawProgramAccount): AccountInfo<Buffer> {
  return {
    data: Buffer.from(account.data),
    executable: false,
    lamports: 0,
    owner: new PublicKey(account.owner),
    rentEpoch: 0
  };
}

function requiredAccount(
  snapshot: VerifiedPumpQuoteSnapshot,
  role: "market" | "baseMint" | "globalConfig" | "feeConfig" | "baseVault"
): RawProgramAccount {
  const account = snapshot.accounts[role];
  if (!account) throw new Error(`Pump curve quote snapshot is missing ${role}.`);
  if (account.slot !== snapshot.slot || account.observedAt !== snapshot.observedAt) {
    throw new Error(`Pump curve ${role} account is not from the verified snapshot context.`);
  }
  return account;
}

function zeroFeeFields<T>(value: T, key = ""): T {
  if (/(fee|fees).*(bps|basispoints)$/i.test(key)) return new BN(0) as T;
  if (value instanceof BN) return value.clone() as T;
  if (value instanceof PublicKey || Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(item => zeroFeeFields(item)) as T;
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = zeroFeeFields(childValue, childKey);
    }
    return result as T;
  }
  return value;
}

function impactPct(
  executionQuote: BN,
  executionBase: BN,
  spotQuote: BN,
  spotBase: BN,
  side: "BUY" | "SELL"
): number {
  if (executionQuote.lten(0) || executionBase.lten(0) ||
      spotQuote.lten(0) || spotBase.lten(0)) {
    throw new Error("Pump curve quote impact inputs must be positive.");
  }
  const scale = new BN("1000000000000");
  const ratioScaled = executionQuote.mul(spotBase).mul(scale).div(executionBase.mul(spotQuote));
  const ratio = Number(ratioScaled.toString()) / Number(scale.toString());
  const impact = side === "BUY" ? (ratio - 1) * 100 : (1 - ratio) * 100;
  if (!Number.isFinite(impact)) throw new Error("Pump curve quote impact is not finite.");
  return Math.max(0, impact);
}

interface DecodedCurveContext {
  mint: PublicKey;
  quoteMint: PublicKey;
  curve: ReturnType<typeof PUMP_SDK.decodeBondingCurve>;
  global: ReturnType<typeof PUMP_SDK.decodeGlobal>;
  feeConfig: ReturnType<typeof PUMP_SDK.decodeFeeConfig>;
  curveBaseTokenBalance: BN;
  baseMintAccount: RawMint;
  baseDecimals: number;
  quoteDecimals: number;
}

function decodeContext(snapshot: VerifiedPumpQuoteSnapshot): DecodedCurveContext {
  if (!snapshot.verified || !Number.isSafeInteger(snapshot.slot) || snapshot.slot < 0) {
    throw new Error("Pump curve quote snapshot is not verified.");
  }
  const marketRaw = requiredAccount(snapshot, "market");
  const baseMintRaw = requiredAccount(snapshot, "baseMint");
  const globalRaw = requiredAccount(snapshot, "globalConfig");
  const feeRaw = requiredAccount(snapshot, "feeConfig");
  const baseVaultRaw = requiredAccount(snapshot, "baseVault");
  if (marketRaw.owner !== PUMP_PROGRAM_ID || globalRaw.owner !== PUMP_PROGRAM_ID ||
      feeRaw.owner !== PUMP_FEE_PROGRAM_ID) {
    throw new Error("Pump curve market or configuration account has an unexpected program owner.");
  }
  if (globalRaw.address !== GLOBAL_PDA.toBase58() ||
      feeRaw.address !== PUMP_FEE_CONFIG_PDA.toBase58()) {
    throw new Error("Pump curve quote config PDA does not match the official SDK.");
  }
  if (baseMintRaw.owner !== SPL_TOKEN_PROGRAM_ID && baseMintRaw.owner !== TOKEN_2022_PROGRAM_ID) {
    throw new Error("Pump curve base mint is not owned by an accepted token program.");
  }

  const mint = new PublicKey(baseMintRaw.address);
  const expectedCurve = derivePumpBondingCurvePda(mint.toBase58());
  const decoded = decodeVerifiedPumpCurveAccount({
    account: marketRaw, expectedMint: mint.toBase58(), expectedCurveAddress: expectedCurve
  });
  if (!isSolQuoteMint(decoded.quoteMint)) {
    throw new Error("Only native-SOL and WSOL bonding curves are supported by this quote adapter.");
  }
  const quoteMint = new PublicKey(decoded.quoteMint);
  const quoteMintRaw = snapshot.accounts.quoteMint ?? null;
  if (decoded.quoteMint === "11111111111111111111111111111111") {
    if (quoteMintRaw) throw new Error("Legacy native-SOL curves must not include a quote-mint account.");
  } else {
    if (!quoteMintRaw || quoteMintRaw.address !== decoded.quoteMint ||
        quoteMintRaw.owner !== SPL_TOKEN_PROGRAM_ID) {
      throw new Error("WSOL mint account is missing or has an unexpected owner.");
    }
  }

  const tokenProgram = new PublicKey(baseMintRaw.owner);
  const baseMintUnpacked = unpackMint(mint, accountInfo(baseMintRaw), tokenProgram);
  const baseMintAccount: RawMint = {
    ...baseMintUnpacked,
    mintAuthority: baseMintUnpacked.mintAuthority ?? PublicKey.default,
    mintAuthorityOption: baseMintUnpacked.mintAuthority ? 1 : 0,
    freezeAuthority: baseMintUnpacked.freezeAuthority ?? PublicKey.default,
    freezeAuthorityOption: baseMintUnpacked.freezeAuthority ? 1 : 0
  };
  if (getTransferFeeConfig(baseMintUnpacked) || getTransferHook(baseMintUnpacked)) {
    throw new Error("Transfer-fee and transfer-hook base mints are not supported by this quote adapter.");
  }
  let quoteDecimals = 9;
  if (quoteMintRaw) {
    const quoteMintUnpacked = unpackMint(quoteMint, accountInfo(quoteMintRaw), new PublicKey(quoteMintRaw.owner));
    if (quoteMintUnpacked.decimals !== 9 || getTransferFeeConfig(quoteMintUnpacked) ||
        getTransferHook(quoteMintUnpacked)) {
      throw new Error("WSOL quote mint decimals or transfer extensions are unsupported.");
    }
    quoteDecimals = quoteMintUnpacked.decimals;
  }
  if (!Number.isInteger(baseMintAccount.decimals) || baseMintAccount.decimals < 0 ||
      baseMintAccount.decimals > 18) {
    throw new Error("Pump curve base mint decimals are invalid.");
  }

  const curveBaseVault = decodeSplTokenAccount(baseVaultRaw);
  if (curveBaseVault.mint !== mint.toBase58() ||
      curveBaseVault.tokenAuthority !== expectedCurve ||
      curveBaseVault.tokenProgram !== baseMintRaw.owner) {
    throw new Error("Pump curve token vault does not match the mint, PDA and token program.");
  }

  const curve = PUMP_SDK.decodeBondingCurve(accountInfo(marketRaw));
  const global = PUMP_SDK.decodeGlobal(accountInfo(globalRaw));
  const feeConfig = PUMP_SDK.decodeFeeConfig(accountInfo(feeRaw));
  if (!curve.mint.equals(mint) || !curve.quoteMint.equals(quoteMint) ||
      curve.complete || curve.isCashbackCoin ||
      !curve.virtualTokenReserves.eq(new BN(decoded.virtualTokenReserves)) ||
      !curve.virtualQuoteReserves.eq(new BN(decoded.virtualQuoteReserves)) ||
      !curve.realTokenReserves.eq(new BN(decoded.realTokenReserves)) ||
      !curve.tokenTotalSupply.eq(new BN(decoded.tokenTotalSupply)) ||
      !curveBaseVault.amountBaseUnits ||
      BigInt(curveBaseVault.amountBaseUnits) !== BigInt(decoded.realTokenReserves)) {
    throw new Error("Official Pump SDK curve state disagrees with verified account and token-vault evidence.");
  }

  return {
    mint, quoteMint, curve, global, feeConfig,
    curveBaseTokenBalance: new BN(curveBaseVault.amountBaseUnits),
    baseMintAccount, baseDecimals: baseMintAccount.decimals, quoteDecimals
  };
}

export interface PumpSdkCurveQuote {
  provider: "pump-sdk-4.3.1";
  venue: "PUMP_CURVE";
  side: "BUY" | "SELL";
  mint: string;
  quoteMint: string;
  slot: number;
  observedAt: string;
  inputAmountBaseUnits: string;
  outputAmountBaseUnits: string;
  grossQuoteAmountBaseUnits: string;
  netQuoteAmountBaseUnits: string;
  venueFeeBaseUnits: string;
  priceImpactPct: number;
  baseDecimals: number;
  quoteDecimals: number;
  transferTaxVerifiedZero: true;
  executionReady: false;
  blockers: string[];
}

function quoteBlockers(): string[] {
  return [
    "network fee and priority fee estimates are not attached",
    "SOL/USD valuation is not attached",
    "simulated execution latency is not attached"
  ];
}

/** Exact net-SOL stake input, priced with the official Pump v3 offline quote functions. */
export function quotePumpCurveBuyFromSnapshot(
  snapshot: VerifiedPumpQuoteSnapshot,
  netQuoteBudgetBaseUnits: string
): PumpSdkCurveQuote {
  if (!isU64BaseUnits(netQuoteBudgetBaseUnits) || BigInt(netQuoteBudgetBaseUnits) <= 0n) {
    throw new Error("Pump curve buy budget must be a positive base-unit integer within u64.");
  }
  const context = decodeContext(snapshot);
  const netQuote = new BN(netQuoteBudgetBaseUnits);
  const zeroGlobal = zeroFeeFields(context.global);
  const zeroFeeConfig = zeroFeeFields(context.feeConfig);
  const zeroCurve = zeroFeeFields(context.curve);
  const tokenOut = getBuyV3TokenAmountFromQuoteAmount({
    global: zeroGlobal, feeConfig: zeroFeeConfig,
    mintSupply: context.curve.tokenTotalSupply, bondingCurve: zeroCurve,
    amount: netQuote, curveBaseTokenBalance: context.curveBaseTokenBalance
  });
  if (tokenOut.lten(0) || tokenOut.gt(context.curveBaseTokenBalance) ||
      !isU64BaseUnits(tokenOut.toString())) {
    throw new Error("Pump curve buy output is zero or crosses the remaining curve supply.");
  }
  const grossQuote = getBuyV3QuoteAmountFromTokenAmount({
    global: context.global, feeConfig: context.feeConfig,
    mintSupply: context.curve.tokenTotalSupply, bondingCurve: context.curve,
    amount: tokenOut, curveBaseTokenBalance: context.curveBaseTokenBalance
  });
  const fee = grossQuote.sub(netQuote);
  if (grossQuote.lten(0) || fee.isNeg() || !isU64BaseUnits(grossQuote.toString())) {
    throw new Error("Pump SDK buy quote did not reconcile to a positive u64 gross debit.");
  }
  const impact = impactPct(netQuote, tokenOut,
    context.curve.virtualQuoteReserves, context.curve.virtualTokenReserves, "BUY");
  return {
    provider: "pump-sdk-4.3.1", venue: "PUMP_CURVE", side: "BUY",
    mint: context.mint.toBase58(), quoteMint: context.quoteMint.toBase58(),
    slot: snapshot.slot, observedAt: snapshot.observedAt,
    inputAmountBaseUnits: grossQuote.toString(), outputAmountBaseUnits: tokenOut.toString(),
    grossQuoteAmountBaseUnits: grossQuote.toString(), netQuoteAmountBaseUnits: netQuote.toString(),
    venueFeeBaseUnits: fee.toString(), priceImpactPct: impact,
    baseDecimals: context.baseDecimals, quoteDecimals: context.quoteDecimals,
    transferTaxVerifiedZero: true, executionReady: false, blockers: quoteBlockers()
  };
}

/** Exact token input, priced gross and net with the official Pump offline sell function. */
export function quotePumpCurveSellFromSnapshot(
  snapshot: VerifiedPumpQuoteSnapshot,
  tokenAmountBaseUnits: string
): PumpSdkCurveQuote {
  if (!isU64BaseUnits(tokenAmountBaseUnits) || BigInt(tokenAmountBaseUnits) <= 0n) {
    throw new Error("Pump curve sell amount must be a positive base-unit integer within u64.");
  }
  const context = decodeContext(snapshot);
  const tokenAmount = new BN(tokenAmountBaseUnits);
  const zeroGlobal = zeroFeeFields(context.global);
  const zeroFeeConfig = zeroFeeFields(context.feeConfig);
  const zeroCurve = zeroFeeFields(context.curve);
  const grossQuote = getSellSolAmountFromTokenAmount({
    global: zeroGlobal, feeConfig: zeroFeeConfig,
    mintSupply: context.curve.tokenTotalSupply, bondingCurve: zeroCurve, amount: tokenAmount
  });
  const netQuote = getSellSolAmountFromTokenAmount({
    global: context.global, feeConfig: context.feeConfig,
    mintSupply: context.curve.tokenTotalSupply, bondingCurve: context.curve, amount: tokenAmount
  });
  const fee = grossQuote.sub(netQuote);
  if (grossQuote.lten(0) || netQuote.lten(0) || fee.isNeg() ||
      !isU64BaseUnits(grossQuote.toString()) || !isU64BaseUnits(netQuote.toString())) {
    throw new Error("Pump SDK sell quote did not reconcile to positive u64 proceeds.");
  }
  const impact = impactPct(grossQuote, tokenAmount,
    context.curve.virtualQuoteReserves, context.curve.virtualTokenReserves, "SELL");
  return {
    provider: "pump-sdk-4.3.1", venue: "PUMP_CURVE", side: "SELL",
    mint: context.mint.toBase58(), quoteMint: context.quoteMint.toBase58(),
    slot: snapshot.slot, observedAt: snapshot.observedAt,
    inputAmountBaseUnits: tokenAmount.toString(), outputAmountBaseUnits: netQuote.toString(),
    grossQuoteAmountBaseUnits: grossQuote.toString(), netQuoteAmountBaseUnits: netQuote.toString(),
    venueFeeBaseUnits: fee.toString(), priceImpactPct: impact,
    baseDecimals: context.baseDecimals, quoteDecimals: context.quoteDecimals,
    transferTaxVerifiedZero: true, executionReady: false, blockers: quoteBlockers()
  };
}

/** Discover curve quote mint and ATA, then re-fetch every pricing input in one Helius context slot. */
export async function fetchPumpCurveSdkQuote(input: {
  mint: string;
  side: "BUY" | "SELL";
  amountBaseUnits: string;
  config: HeliusAccountReadConfig;
}): Promise<PumpSdkCurveQuote> {
  if (!isU64BaseUnits(input.amountBaseUnits) || BigInt(input.amountBaseUnits) <= 0n) {
    throw new Error("Pump curve quote amount must be a positive base-unit integer within u64.");
  }
  const mint = new PublicKey(input.mint);
  const curveAddress = derivePumpBondingCurvePda(mint.toBase58());
  const discovery = await fetchHeliusMultipleAccounts([curveAddress, mint.toBase58()], input.config);
  const market = discovery.accounts[0];
  const baseMint = discovery.accounts[1];
  if (!market || !baseMint) throw new Error("Pump curve or mint discovery account is not available.");
  if (baseMint.owner !== SPL_TOKEN_PROGRAM_ID && baseMint.owner !== TOKEN_2022_PROGRAM_ID) {
    throw new Error("Pump curve base mint is not owned by an accepted token program.");
  }
  const decoded = decodeVerifiedPumpCurveAccount({
    account: market, expectedMint: mint.toBase58(), expectedCurveAddress: curveAddress
  });
  if (!isSolQuoteMint(decoded.quoteMint)) {
    throw new Error("Only native-SOL and WSOL bonding curves are supported by this quote adapter.");
  }
  const curveTokenAccount = getAssociatedTokenAddressSync(
    mint, new PublicKey(curveAddress), true, new PublicKey(baseMint.owner)
  ).toBase58();
  const snapshot = await fetchVerifiedPumpQuoteAccountSnapshot({
    addresses: {
      market: curveAddress,
      baseMint: mint.toBase58(),
      quoteMint: decoded.quoteMint,
      globalConfig: GLOBAL_PDA.toBase58(),
      feeConfig: PUMP_FEE_CONFIG_PDA.toBase58(),
      baseVault: curveTokenAccount
    },
    config: input.config
  });
  return input.side === "BUY"
    ? quotePumpCurveBuyFromSnapshot(snapshot, input.amountBaseUnits)
    : quotePumpCurveSellFromSnapshot(snapshot, input.amountBaseUnits);
}
