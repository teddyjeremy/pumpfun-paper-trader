import BN from "bn.js";
import { Buffer } from "node:buffer";
import { PublicKey, SystemProgram, TransactionInstruction, type AccountInfo } from "@solana/web3.js";
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
  NATIVE_SOL_MINT, PUMP_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
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
import { estimateFeesForUnsignedInstructions, type UnsignedInstructionFeeEvidence } from "./solana-fee-estimator.js";

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
  if (quoteMintRaw && (quoteMintRaw.slot !== snapshot.slot ||
      quoteMintRaw.observedAt !== snapshot.observedAt)) {
    throw new Error("Pump curve quote mint is outside the verified Helius context.");
  }
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
  if (!curve.quoteMint.equals(quoteMint) ||
      curve.complete || curve.isCashbackCoin ||
      !curve.virtualTokenReserves.eq(new BN(decoded.virtualTokenReserves)) ||
      !curve.virtualQuoteReserves.eq(new BN(decoded.virtualQuoteReserves)) ||
      !curve.realTokenReserves.eq(new BN(decoded.realTokenReserves)) ||
      !curve.realQuoteReserves.eq(new BN(decoded.realQuoteReserves)) ||
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
  snapshot?: VerifiedPumpQuoteSnapshot;
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
      grossQuote.gt(context.curve.realQuoteReserves) ||
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
  const quote = input.side === "BUY"
    ? quotePumpCurveBuyFromSnapshot(snapshot, input.amountBaseUnits)
    : quotePumpCurveSellFromSnapshot(snapshot, input.amountBaseUnits);
  return { ...quote, snapshot };
}


export interface PumpCurveV3UnsignedInstruction {
  provider: "pump-sdk-4.3.1";
  venue: "PUMP_CURVE";
  side: "BUY" | "SELL";
  mint: string;
  user: string;
  quoteMint: string;
  baseTokenProgram: string;
  quoteTokenProgram: string;
  buybackFeeRecipient: string;
  userVolumeAccumulatorAddress: string;
  instruction: TransactionInstruction;
  requiredAccountAddressesToVerify: string[];
  optionalAccountAddresses: string[];
  slot: number;
  observedAt: string;
  executionReady: false;
  paperEntryAuthorized: false;
  blockers: string[];
}

/**
 * Build one exact-size, unsigned Pump Curve V3 instruction from the same
 * verified account snapshot used by the quote adapter. The caller must still
 * verify every returned ATA, rent reserve, payer balance and fresh fee message.
 * This function never signs, simulates or submits.
 */
export async function buildPumpCurveV3UnsignedInstruction(input: {
  snapshot: VerifiedPumpQuoteSnapshot;
  user: string;
  side: "BUY" | "SELL";
  tokenAmountBaseUnits: string;
  quoteAmountBaseUnits: string;
  buybackFeeRecipient?: string;
}): Promise<PumpCurveV3UnsignedInstruction> {
  if (!isU64BaseUnits(input.tokenAmountBaseUnits) || BigInt(input.tokenAmountBaseUnits) <= 0n) {
    throw new Error("Pump curve instruction token amount must be a positive u64 base-unit integer.");
  }
  if (!isU64BaseUnits(input.quoteAmountBaseUnits) || BigInt(input.quoteAmountBaseUnits) <= 0n) {
    throw new Error("Pump curve instruction quote amount must be a positive u64 base-unit integer.");
  }
  let user: PublicKey;
  try { user = new PublicKey(input.user); }
  catch { throw new Error("Pump curve instruction user address is invalid."); }
  if (!user || user.equals(SystemProgram.programId)) {
    throw new Error("Pump curve instruction user must be a non-zero public key.");
  }

  const context = decodeContext(input.snapshot);
  if (context.curve.complete || context.curve.isCashbackCoin) {
    throw new Error("Curve V3 instructions are unavailable for completed or cashback curves.");
  }
  const tokenAmount = new BN(input.tokenAmountBaseUnits);
  const quoteAmount = new BN(input.quoteAmountBaseUnits);
  if (input.side === "BUY") {
    if (tokenAmount.gt(context.curveBaseTokenBalance)) {
      throw new Error("Pump curve instruction buy amount exceeds the remaining curve token supply.");
    }
    const minimumQuote = getBuyV3QuoteAmountFromTokenAmount({
      global: context.global, feeConfig: context.feeConfig,
      mintSupply: context.curve.tokenTotalSupply, bondingCurve: context.curve,
      amount: tokenAmount, curveBaseTokenBalance: context.curveBaseTokenBalance
    });
    if (quoteAmount.lt(minimumQuote)) {
      throw new Error("Pump curve buy quote limit is below the official SDK gross quote.");
    }
  } else {
    if (tokenAmount.gt(context.curve.realTokenReserves)) {
      throw new Error("Pump curve instruction sell amount exceeds the real token reserve.");
    }
    const minimumQuote = getSellSolAmountFromTokenAmount({
      global: context.global, feeConfig: context.feeConfig,
      mintSupply: context.curve.tokenTotalSupply, bondingCurve: context.curve,
      amount: tokenAmount
    });
    if (minimumQuote.lten(0) || quoteAmount.gt(minimumQuote)) {
      throw new Error("Pump curve sell minimum exceeds the official SDK net quote.");
    }
  }

  const configuredRecipients = context.global.buybackFeeRecipients ?? [];
  const recipient = input.buybackFeeRecipient
    ? new PublicKey(input.buybackFeeRecipient)
    : configuredRecipients[0];
  if (!recipient || !configuredRecipients.some(candidate => candidate.equals(recipient))) {
    throw new Error("Buyback fee recipient must be selected from the verified on-chain Global configuration.");
  }

  const tokenProgram = new PublicKey(requiredAccount(input.snapshot, "baseMint").owner);
  const quoteTokenProgram = new PublicKey(SPL_TOKEN_PROGRAM_ID);
  const solPairedQuote = isSolQuoteMint(context.quoteMint.toBase58());
  // Pump V3 instruction accounts always use WSOL for SOL-paired curves, even
  // when a legacy curve stores Pubkey::default to represent native SOL.
  const instructionQuoteMint = solPairedQuote ? new PublicKey(NATIVE_SOL_MINT) : context.quoteMint;
  const params = {
    user, mint: context.mint, amount: tokenAmount, quoteAmount,
    tokenProgram, quoteMint: instructionQuoteMint, quoteTokenProgram,
    buybackFeeRecipient: recipient
  };
  const method = input.side === "BUY" ? "getBuyV3InstructionRaw" : "getSellV3InstructionRaw";
  const builder = (PUMP_SDK as unknown as Record<string, unknown>)[method];
  if (typeof builder !== "function") {
    throw new Error(`Pinned Pump SDK does not expose ${method}.`);
  }
  const instruction = await Promise.resolve(
    (builder as (args: typeof params) => TransactionInstruction).call(PUMP_SDK, params)
  );
  if (!(instruction instanceof TransactionInstruction) ||
      !instruction.programId.equals(new PublicKey(PUMP_PROGRAM_ID))) {
    throw new Error("Pump SDK returned an invalid curve instruction.");
  }

  const userVolumeAccumulator = PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), user.toBuffer()], new PublicKey(PUMP_PROGRAM_ID)
  )[0];
  const requiredAccountAddressesToVerify = [
    getAssociatedTokenAddressSync(context.mint, user, false, tokenProgram).toBase58(),
    userVolumeAccumulator.toBase58()
  ];
  const optionalAccountAddresses: string[] = [];
  if (solPairedQuote) {
    // For native-SOL curves the program takes WSOL ATA addresses but does not
    // use or require those accounts to exist; the buyback recipient is a wallet.
    optionalAccountAddresses.push(
      getAssociatedTokenAddressSync(instructionQuoteMint, user, false, quoteTokenProgram).toBase58()
    );
    requiredAccountAddressesToVerify.push(recipient.toBase58());
  } else {
    requiredAccountAddressesToVerify.push(
      getAssociatedTokenAddressSync(instructionQuoteMint, user, false, quoteTokenProgram).toBase58(),
      getAssociatedTokenAddressSync(instructionQuoteMint, recipient, false, quoteTokenProgram).toBase58()
    );
  }
  return {
    provider: "pump-sdk-4.3.1", venue: "PUMP_CURVE", side: input.side,
    mint: context.mint.toBase58(), user: user.toBase58(),
    quoteMint: instructionQuoteMint.toBase58(),
    userVolumeAccumulatorAddress: userVolumeAccumulator.toBase58(),
    baseTokenProgram: tokenProgram.toBase58(), quoteTokenProgram: quoteTokenProgram.toBase58(),
    buybackFeeRecipient: recipient.toBase58(),
    instruction, requiredAccountAddressesToVerify, optionalAccountAddresses,
    slot: input.snapshot.slot, observedAt: input.snapshot.observedAt,
    executionReady: false, paperEntryAuthorized: false,
    blockers: [
      "USER_BASE_ATA_EXISTENCE_AND_STATE_NOT_VERIFIED",
      "BUYBACK_FEE_RECIPIENT_ACCOUNT_EXISTENCE_AND_STATE_NOT_VERIFIED",
      "ATA_RENT_AND_VIRTUAL_PAYER_BALANCE_NOT_VERIFIED",
      "USER_VOLUME_ACCUMULATOR_STATE_AND_RENT_NOT_VERIFIED",
      "EXACT_UNSIGNED_TRANSACTION_FEE_MESSAGE_NOT_ATTACHED",
      "PAPER_ENTRY_AUTHORIZATION_NOT_GRANTED"
    ]
  };
}


export interface PumpCurveV3UnsignedInstructionWithFees extends PumpCurveV3UnsignedInstruction {
  feeEvidence: UnsignedInstructionFeeEvidence;
}

/**
 * Attach base-network and account-lock-specific priority-fee evidence to the
 * exact unsigned curve instruction. The recent blockhash is supplied by the
 * caller so the fee message is compiled from the same instruction that would
 * be used for paper execution. No signing, simulation or submission occurs.
 */
export async function buildPumpCurveV3UnsignedInstructionWithFees(input: {
  snapshot: VerifiedPumpQuoteSnapshot;
  user: string;
  side: "BUY" | "SELL";
  tokenAmountBaseUnits: string;
  quoteAmountBaseUnits: string;
  buybackFeeRecipient?: string;
  apiKey: string;
  recentBlockhash: string;
  computeUnitLimit: number;
  fetcher?: typeof fetch;
  nowMs?: number;
}): Promise<PumpCurveV3UnsignedInstructionWithFees> {
  const built = await buildPumpCurveV3UnsignedInstruction(input);
  const feeEvidence = await estimateFeesForUnsignedInstructions({
    apiKey: input.apiKey,
    payer: new PublicKey(built.user),
    recentBlockhash: input.recentBlockhash,
    instructions: [built.instruction],
    computeUnitLimit: input.computeUnitLimit,
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs })
  });
  const blockers = built.blockers.filter(blocker =>
    blocker !== "EXACT_UNSIGNED_TRANSACTION_FEE_MESSAGE_NOT_ATTACHED");
  if (feeEvidence.status !== "AVAILABLE") {
    blockers.push("EXACT_UNSIGNED_TRANSACTION_FEE_EVIDENCE_UNAVAILABLE");
  }
  return { ...built, blockers, feeEvidence, executionReady: false, paperEntryAuthorized: false };
}
