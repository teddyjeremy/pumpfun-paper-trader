import BN from "bn.js";
import { Buffer } from "node:buffer";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { getTransferFeeConfig, unpackMint, type RawMint } from "@solana/spl-token";
import {
  PUMP_AMM_SDK,
  buyQuoteInput,
  computeFeesBps,
  sellBaseInput
} from "@pump-fun/pump-sdk/swap";
import type { FeeConfig, GlobalConfig, Pool } from "@pump-fun/pump-sdk/swap";
import {
  decodePumpSwapPoolAccount,
  decodeSplTokenAccount,
  PUMP_AMM_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_SOL_MINT,
  type RawProgramAccount
} from "./pump-account-decoder.js";
import {
  deriveCanonicalPumpSwapPoolPda,
  derivePumpPoolCreatorAuthorityPda,
  derivePumpSwapPoolVaultAuthority
} from "./pump-pdas.js";
import { verifyCanonicalPumpSwapPoolSnapshot } from "./pump-account-decoder.js";
import {
  GLOBAL_CONFIG_PDA,
  PUMP_AMM_FEE_CONFIG_PDA
} from "@pump-fun/pump-sdk/swap";
import {
  fetchHeliusMultipleAccounts,
  type HeliusAccountReadConfig
} from "./helius-accounts.js";
import {
  fetchVerifiedPumpQuoteAccountSnapshot,
  type VerifiedPumpQuoteSnapshot
} from "./pump-quote-snapshot.js";

const PUMP_FEE_PROGRAM_ID = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const BPS = new BN(10_000);

export interface PumpSdkSwapQuote {
  provider: "pump-sdk-4.3.1";
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
    lpBaseUnits: string;
    protocolBaseUnits: string;
    creatorBaseUnits: string;
    totalBaseUnits: string;
  };
  unspentQuoteBaseUnits: string;
  priceImpactPct: number;
  baseDecimals: number;
  quoteDecimals: number;
  transferTaxVerifiedZero: true;
  executionReady: false;
  blockers: string[];
}

interface DecodedSwapContext {
  mint: PublicKey;
  quoteMint: PublicKey;
  pool: Pool;
  globalConfig: GlobalConfig;
  feeConfig: FeeConfig;
  baseMintAccount: RawMint;
  baseReserve: BN;
  quoteVaultReserve: BN;
  effectiveQuoteReserve: BN;
  feeBucketsTotal: BN;
  baseDecimals: number;
  quoteDecimals: number;
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

function requiredAccount(snapshot: VerifiedPumpQuoteSnapshot, role: "market" | "baseMint" | "quoteMint" |
  "globalConfig" | "feeConfig" | "baseVault" | "quoteVault"): RawProgramAccount {
  const account = snapshot.accounts[role];
  if (!account) throw new Error(`Pump quote snapshot is missing ${role}.`);
  return account;
}

function feeAmount(amount: BN, basisPoints: BN): BN {
  return amount.mul(basisPoints).add(BPS.subn(1)).div(BPS);
}

function feeBreakdown(amount: BN, rates: {
  lpFeeBps: BN; protocolFeeBps: BN; creatorFeeBps: BN;
}) {
  const lp = feeAmount(amount, rates.lpFeeBps);
  const protocol = feeAmount(amount, rates.protocolFeeBps);
  const creator = feeAmount(amount, rates.creatorFeeBps);
  return { lp, protocol, creator, total: lp.add(protocol).add(creator) };
}

function impactPct(executionQuote: BN, executionBase: BN, spotQuote: BN, spotBase: BN,
  side: "BUY" | "SELL"): number {
  if (executionQuote.lten(0) || executionBase.lten(0) || spotQuote.lten(0) || spotBase.lten(0)) {
    throw new Error("SDK quote impact inputs must be positive.");
  }
  const scale = new BN("1000000000000");
  const ratioScaled = executionQuote.mul(spotBase).mul(scale).div(executionBase.mul(spotQuote));
  const ratio = Number(ratioScaled.toString()) / Number(scale.toString());
  const impact = side === "BUY" ? (ratio - 1) * 100 : (1 - ratio) * 100;
  if (!Number.isFinite(impact)) throw new Error("SDK quote impact is not finite.");
  return Math.max(0, impact);
}

function decodeContext(snapshot: VerifiedPumpQuoteSnapshot): DecodedSwapContext {
  if (!snapshot.verified || !Number.isSafeInteger(snapshot.slot) || snapshot.slot < 0) {
    throw new Error("Pump quote snapshot is not verified.");
  }
  const marketAccount = requiredAccount(snapshot, "market");
  const baseMintRaw = requiredAccount(snapshot, "baseMint");
  const quoteMintRaw = requiredAccount(snapshot, "quoteMint");
  const globalRaw = requiredAccount(snapshot, "globalConfig");
  const feeRaw = requiredAccount(snapshot, "feeConfig");
  const baseVaultRaw = requiredAccount(snapshot, "baseVault");
  const quoteVaultRaw = requiredAccount(snapshot, "quoteVault");

  if (marketAccount.owner !== PUMP_AMM_PROGRAM_ID ||
      globalRaw.owner !== PUMP_AMM_PROGRAM_ID ||
      feeRaw.owner !== PUMP_FEE_PROGRAM_ID) {
    throw new Error("PumpSwap market or configuration account has an unexpected program owner.");
  }
  if (baseMintRaw.owner !== SPL_TOKEN_PROGRAM_ID && baseMintRaw.owner !== TOKEN_2022_PROGRAM_ID) {
    throw new Error("Base mint is not owned by an accepted token program.");
  }
  if (quoteMintRaw.owner !== SPL_TOKEN_PROGRAM_ID && quoteMintRaw.owner !== TOKEN_2022_PROGRAM_ID) {
    throw new Error("Quote mint is not owned by an accepted token program.");
  }

  const decodedPool = decodePumpSwapPoolAccount(marketAccount);
  const mint = new PublicKey(baseMintRaw.address);
  const quoteMint = new PublicKey(quoteMintRaw.address);
  if (decodedPool.baseMint !== mint.toBase58() || decodedPool.quoteMint !== quoteMint.toBase58()) {
    throw new Error("PumpSwap pool mint addresses do not match the quote snapshot.");
  }
  if (!quoteMint.equals(new PublicKey(NATIVE_SOL_MINT))) {
    throw new Error("Only WSOL-quoted PumpSwap pools are currently supported by this quote adapter.");
  }

  const expectedPool = deriveCanonicalPumpSwapPoolPda(mint.toBase58(), quoteMint.toBase58());
  const expectedCreator = derivePumpPoolCreatorAuthorityPda(mint.toBase58());
  const expectedAuthority = derivePumpSwapPoolVaultAuthority(expectedPool);
  const verifiedPool = verifyCanonicalPumpSwapPoolSnapshot({
    poolAccount: marketAccount,
    baseVaultAccount: baseVaultRaw,
    quoteVaultAccount: quoteVaultRaw,
    expectedMint: mint.toBase58(),
    expectedPoolAddress: expectedPool,
    expectedPoolCreatorAuthority: expectedCreator,
    expectedPoolAuthority: expectedAuthority,
    nowMs: Date.parse(snapshot.observedAt)
  });
  if (!verifiedPool.verified || !verifiedPool.canonical) {
    throw new Error("PumpSwap pool failed canonical verification.");
  }

  const baseVault = decodeSplTokenAccount(baseVaultRaw);
  const quoteVault = decodeSplTokenAccount(quoteVaultRaw);
  if (baseVault.tokenProgram !== baseMintRaw.owner || quoteVault.tokenProgram !== quoteMintRaw.owner) {
    throw new Error("Vault token programs do not match their mint owners.");
  }

  const unpackedBaseMint = unpackMint(mint, accountInfo(baseMintRaw), new PublicKey(baseMintRaw.owner));
  const quoteMintAccount = unpackMint(quoteMint, accountInfo(quoteMintRaw), new PublicKey(quoteMintRaw.owner));
  const baseMintAccount: RawMint = {
    ...unpackedBaseMint,
    mintAuthority: unpackedBaseMint.mintAuthority ?? PublicKey.default,
    mintAuthorityOption: unpackedBaseMint.mintAuthority ? 1 : 0,
    freezeAuthority: unpackedBaseMint.freezeAuthority ?? PublicKey.default,
    freezeAuthorityOption: unpackedBaseMint.freezeAuthority ? 1 : 0
  };
  if (getTransferFeeConfig(unpackedBaseMint) || getTransferFeeConfig(quoteMintAccount)) {
    throw new Error("Token-2022 transfer-fee mints are not supported by this quote adapter.");
  }

  const pool = PUMP_AMM_SDK.decodePool(accountInfo(marketAccount));
  const globalConfig = PUMP_AMM_SDK.decodeGlobalConfig(accountInfo(globalRaw));
  const feeConfig = PUMP_AMM_SDK.decodeFeeConfig(accountInfo(feeRaw));
  if (!pool.baseMint.equals(mint) || !pool.quoteMint.equals(quoteMint) ||
      !pool.poolBaseTokenAccount.equals(new PublicKey(baseVaultRaw.address)) ||
      !pool.poolQuoteTokenAccount.equals(new PublicKey(quoteVaultRaw.address))) {
    throw new Error("Official Pump SDK pool decoder disagrees with the verified account snapshot.");
  }
  if (pool.isCashbackCoin) {
    throw new Error("Cashback PumpSwap pools are not supported by the v2 quote path.");
  }

  const baseReserve = new BN(baseVault.amountBaseUnits);
  const quoteVaultReserve = new BN(quoteVault.amountBaseUnits);
  const effectiveQuoteReserve = quoteVaultReserve.add(pool.virtualQuoteReserves);
  const feeBucketsTotal = pool.protocolFees.add(pool.creatorFees);
  if (baseReserve.isZero() || effectiveQuoteReserve.lten(0) ||
      quoteVaultReserve.lte(feeBucketsTotal)) {
    throw new Error("PumpSwap pool has no spendable quote liquidity.");
  }

  return {
    mint, quoteMint, pool, globalConfig, feeConfig, baseMintAccount,
    baseReserve, quoteVaultReserve, effectiveQuoteReserve, feeBucketsTotal,
    baseDecimals: baseMintAccount.decimals, quoteDecimals: quoteMintAccount.decimals
  };
}

function feeRates(context: DecodedSwapContext) {
  const rates = computeFeesBps({
    globalConfig: context.globalConfig,
    feeConfig: context.feeConfig,
    creator: context.pool.creator,
    baseMintSupply: new BN(context.baseMintAccount.supply.toString()),
    baseMint: context.mint,
    baseReserve: context.baseReserve,
    quoteReserve: context.effectiveQuoteReserve,
    quoteMint: context.quoteMint,
    isMayhemMode: context.pool.isMayhemMode,
    creatorFeeBps: context.pool.creatorFeeBps
  });
  return PublicKey.default.equals(context.pool.coinCreator)
    ? { ...rates, creatorFeeBps: new BN(0) }
    : rates;
}

/**
 * Quote an exact WSOL budget with the official PumpSwap offline pricing function.
 * This is a pricing result, not an executable order: network/priority costs,
 * USD conversion and simulated latency still need to be attached.
 */
export function quotePumpSwapBuyFromSnapshot(
  snapshot: VerifiedPumpQuoteSnapshot,
  quoteBudgetBaseUnits: string
): PumpSdkSwapQuote {
  if (!/^\d+$/.test(quoteBudgetBaseUnits) || BigInt(quoteBudgetBaseUnits) <= 0n) {
    throw new Error("Buy quote budget must be a positive base-unit integer.");
  }
  const context = decodeContext(snapshot);
  const quote = new BN(quoteBudgetBaseUnits);
  const result = buyQuoteInput({
    quote, slippage: 0,
    baseReserve: context.baseReserve,
    quoteReserve: context.quoteVaultReserve,
    virtualQuoteReserves: context.pool.virtualQuoteReserves,
    globalConfig: context.globalConfig,
    baseMintAccount: context.baseMintAccount,
    baseMint: context.mint,
    coinCreator: context.pool.coinCreator,
    creator: context.pool.creator,
    feeConfig: context.feeConfig,
    quoteMint: context.quoteMint,
    isMayhemMode: context.pool.isMayhemMode,
    creatorFeeBps: context.pool.creatorFeeBps
  });
  const rates = feeRates(context);
  const totalFeeBps = rates.lpFeeBps.add(rates.protocolFeeBps).add(rates.creatorFeeBps);
  const preAdjustmentNet = quote.mul(BPS).div(BPS.add(totalFeeBps));
  const fees = feeBreakdown(preAdjustmentNet, rates);
  const excess = preAdjustmentNet.add(fees.total).sub(quote);
  const expectedNet = excess.gtn(0) ? preAdjustmentNet.sub(excess) : preAdjustmentNet;
  if (!expectedNet.eq(result.internalQuoteWithoutFees) ||
      expectedNet.add(fees.total).gt(quote)) {
    throw new Error("Official SDK exact-input quote and fee split do not reconcile.");
  }
  const unspent = quote.sub(expectedNet).sub(fees.total);
  const impact = impactPct(result.internalQuoteWithoutFees, result.base,
    context.effectiveQuoteReserve, context.baseReserve, "BUY");
  return {
    provider: "pump-sdk-4.3.1", side: "BUY", mint: context.mint.toBase58(),
    quoteMint: context.quoteMint.toBase58(), slot: snapshot.slot, observedAt: snapshot.observedAt,
    inputAmountBaseUnits: quote.toString(), outputAmountBaseUnits: result.base.toString(),
    grossQuoteAmountBaseUnits: quote.toString(),
    netQuoteAmountBaseUnits: result.internalQuoteWithoutFees.toString(),
    fees: { lpBaseUnits: fees.lp.toString(), protocolBaseUnits: fees.protocol.toString(),
      creatorBaseUnits: fees.creator.toString(), totalBaseUnits: fees.total.toString() },
    unspentQuoteBaseUnits: unspent.toString(), priceImpactPct: impact,
    baseDecimals: context.baseDecimals, quoteDecimals: context.quoteDecimals,
    transferTaxVerifiedZero: true, executionReady: false,
    blockers: ["network fee and priority fee estimates are not attached", "SOL/USD valuation is not attached", "simulated execution latency is not attached"]
  };
}

/** Quote an exact token amount with the official PumpSwap offline pricing function. */
export function quotePumpSwapSellFromSnapshot(
  snapshot: VerifiedPumpQuoteSnapshot,
  tokenAmountBaseUnits: string
): PumpSdkSwapQuote {
  if (!/^\d+$/.test(tokenAmountBaseUnits) || BigInt(tokenAmountBaseUnits) <= 0n) {
    throw new Error("Sell token amount must be a positive base-unit integer.");
  }
  const context = decodeContext(snapshot);
  const tokenAmount = new BN(tokenAmountBaseUnits);
  const result = sellBaseInput({
    base: tokenAmount, slippage: 0,
    baseReserve: context.baseReserve,
    quoteReserve: context.quoteVaultReserve,
    virtualQuoteReserves: context.pool.virtualQuoteReserves,
    feeBucketsTotal: context.feeBucketsTotal,
    globalConfig: context.globalConfig,
    baseMintAccount: context.baseMintAccount,
    baseMint: context.mint,
    coinCreator: context.pool.coinCreator,
    creator: context.pool.creator,
    feeConfig: context.feeConfig,
    quoteMint: context.quoteMint,
    isMayhemMode: context.pool.isMayhemMode,
    creatorFeeBps: context.pool.creatorFeeBps
  });
  const rates = feeRates(context);
  const fees = feeBreakdown(result.internalQuoteAmountOut, rates);
  const net = result.uiQuote;
  if (!result.internalQuoteAmountOut.sub(fees.total).eq(net)) {
    throw new Error("Official PumpSwap sell output does not reconcile with its fee breakdown.");
  }
  const impact = impactPct(result.internalQuoteAmountOut, tokenAmount,
    context.effectiveQuoteReserve, context.baseReserve, "SELL");
  return {
    provider: "pump-sdk-4.3.1", side: "SELL", mint: context.mint.toBase58(),
    quoteMint: context.quoteMint.toBase58(), slot: snapshot.slot, observedAt: snapshot.observedAt,
    inputAmountBaseUnits: tokenAmount.toString(), outputAmountBaseUnits: net.toString(),
    grossQuoteAmountBaseUnits: result.internalQuoteAmountOut.toString(),
    netQuoteAmountBaseUnits: net.toString(),
    fees: { lpBaseUnits: fees.lp.toString(), protocolBaseUnits: fees.protocol.toString(),
      creatorBaseUnits: fees.creator.toString(), totalBaseUnits: fees.total.toString() },
    unspentQuoteBaseUnits: "0", priceImpactPct: impact,
    baseDecimals: context.baseDecimals, quoteDecimals: context.quoteDecimals,
    transferTaxVerifiedZero: true, executionReady: false,
    blockers: ["network fee and priority fee estimates are not attached", "SOL/USD valuation is not attached", "simulated execution latency is not attached"]
  };
}


/**
 * Discover the pool's vault addresses, then re-fetch the pool, both vaults,
 * both mints and the SDK fee/config accounts in one final Helius context slot.
 * The first read is discovery only; it is never used for pricing.
 */
export async function fetchPumpSwapSdkQuote(input: {
  mint: string;
  poolAddress: string;
  side: "BUY" | "SELL";
  amountBaseUnits: string;
  config: HeliusAccountReadConfig;
}): Promise<PumpSdkSwapQuote> {
  const discovery = await fetchHeliusMultipleAccounts([input.poolAddress], input.config);
  const marketAccount = discovery.accounts[0];
  if (!marketAccount) throw new Error("Canonical PumpSwap pool account is not available.");

  const decodedPool = decodePumpSwapPoolAccount(marketAccount);
  if (decodedPool.address !== input.poolAddress || decodedPool.baseMint !== input.mint) {
    throw new Error("Discovered PumpSwap pool does not match the requested mint and address.");
  }
  const expectedPoolAddress = deriveCanonicalPumpSwapPoolPda(input.mint, decodedPool.quoteMint);
  if (expectedPoolAddress !== input.poolAddress) {
    throw new Error("Discovered PumpSwap pool is not the canonical index-0 pool.");
  }

  const snapshot = await fetchVerifiedPumpQuoteAccountSnapshot({
    addresses: {
      market: input.poolAddress,
      baseMint: input.mint,
      quoteMint: decodedPool.quoteMint,
      globalConfig: GLOBAL_CONFIG_PDA.toBase58(),
      feeConfig: PUMP_AMM_FEE_CONFIG_PDA.toBase58(),
      baseVault: decodedPool.baseVault,
      quoteVault: decodedPool.quoteVault
    },
    config: input.config
  });
  return input.side === "BUY"
    ? quotePumpSwapBuyFromSnapshot(snapshot, input.amountBaseUnits)
    : quotePumpSwapSellFromSnapshot(snapshot, input.amountBaseUnits);
}
