/**
 * Fail-closed decoders for the Pump and PumpSwap account layouts in the
 * official pump-fun/pump-public-docs IDLs.
 *
 * PDA derivation is deliberately injected by the caller (the official SDK is
 * the source of truth for that derivation). This module never labels an
 * account canonical merely because its bytes look plausible.
 */
export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";

const CURVE_DISCRIMINATOR = [23, 183, 248, 55, 96, 216, 172, 96] as const;
const POOL_DISCRIMINATOR = [241, 154, 109, 4, 17, 177, 109, 188] as const;
const TOKEN_ACCOUNT_SIZE = 165;

export interface RawProgramAccount {
  address: string;
  owner: string;
  data: Uint8Array;
  slot: number;
  observedAt: string;
}

export interface DecodedPumpCurveAccount {
  address: string;
  mint: string;
  creator: string;
  quoteMint: string;
  complete: boolean;
  migrated: boolean;
  virtualTokenReserves: string;
  virtualQuoteReserves: string;
  realTokenReserves: string;
  realQuoteReserves: string;
  tokenTotalSupply: string;
  creatorFeeBps: string;
  creatorFeeBaseUnits: string;
  protocolFeesBaseUnits: string;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  canEditCreatorFee: boolean;
  isHolderReward: boolean;
  depth: number;
  initialVirtualQuoteReserves: string;
  postCompleteBaseOut: string;
  postCompleteQuoteIn: string;
  slot: number;
  observedAt: string;
}


export function toVerifiedPumpCurveEvidence(curve: DecodedPumpCurveAccount) {
  return {
    source: "verified-pump-curve-account" as const,
    verified: true as const,
    mint: curve.mint,
    curveAddress: curve.address,
    quoteMint: curve.quoteMint,
    complete: curve.complete,
    migrated: false,
    tokenReserveBaseUnits: curve.realTokenReserves,
    quoteReserveBaseUnits: curve.realQuoteReserves,
    slot: curve.slot,
    observedAt: curve.observedAt
  };
}

export interface DecodedPumpSwapPoolAccount {
  address: string;
  index: number;
  creator: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  coinCreator: string;
  virtualQuoteReserves: string;
  creatorFeeBps: string;
  protocolFeesBaseUnits: string;
  creatorFeesBaseUnits: string;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  canEditCreatorFee: boolean;
  isHolderReward: boolean;
  slot: number;
  observedAt: string;
}

export interface DecodedSplTokenAccount {
  address: string;
  mint: string;
  tokenAuthority: string;
  amountBaseUnits: string;
  tokenProgram: string;
}

export interface VerifiedPumpSwapPoolSnapshot {
  source: "verified-canonical-pumpswap-pool";
  verified: true;
  canonical: true;
  mint: string;
  quoteMint: string;
  poolAddress: string;
  baseReserveBaseUnits: string;
  quoteReserveBaseUnits: string;
  slot: number;
  observedAt: string;
}

function assertAccount(account: RawProgramAccount): void {
  if (!account.address.trim() || !Number.isSafeInteger(account.slot) || account.slot < 0 ||
      !Number.isFinite(Date.parse(account.observedAt))) {
    throw new Error("Account address, slot or observation timestamp is invalid.");
  }
  if (!(account.data instanceof Uint8Array)) throw new Error("Account data must be decoded bytes.");
}

function assertDiscriminator(data: Uint8Array, expected: readonly number[], label: string): void {
  if (data.length < 8 || expected.some((byte, index) => data[index] !== byte)) {
    throw new Error(`Invalid ${label} account discriminator.`);
  }
}

function readU8(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 1 > data.length) throw new Error("Account data is truncated.");
  return data[offset]!;
}
function readBool(data: Uint8Array, offset: number): boolean {
  const value = readU8(data, offset);
  if (value !== 0 && value !== 1) throw new Error("Account boolean field is invalid.");
  return value === 1;
}
function readU16(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > data.length) throw new Error("Account data is truncated.");
  return data[offset]! + data[offset + 1]! * 256;
}
function readUnsigned(data: Uint8Array, offset: number, bytes: number): bigint {
  if (offset < 0 || offset + bytes > data.length) throw new Error("Account integer field is truncated.");
  let value = 0n;
  for (let i = bytes - 1; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i]!);
  return value;
}
function readSigned128(data: Uint8Array, offset: number): bigint {
  const unsigned = readUnsigned(data, offset, 16);
  return (unsigned & (1n << 127n)) === 0n ? unsigned : unsigned - (1n << 128n);
}
function readPubkey(data: Uint8Array, offset: number): string {
  if (offset < 0 || offset + 32 > data.length) throw new Error("Account public key is truncated.");
  return encodeBase58(data.slice(offset, offset + 32));
}
function encodeBase58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = alphabet[remainder]! + encoded;
    value /= 58n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes++;
  return "1".repeat(leadingZeroes) + (encoded || (leadingZeroes === bytes.length ? "" : "1"));
}

/**
 * Decodes only a Pump curve account whose program owner, PDA address and mint
 * are independently supplied and matched by the caller's official-SDK PDA
 * derivation. Older layouts are accepted only when the required prefix is
 * complete; fields introduced later default to protocol-safe zero/false.
 */
export function decodeVerifiedPumpCurveAccount(input: {
  account: RawProgramAccount;
  expectedMint: string;
  expectedCurveAddress: string;
}): DecodedPumpCurveAccount {
  const { account } = input;
  assertAccount(account);
  if (account.owner !== PUMP_PROGRAM_ID) throw new Error("Bonding curve account is not owned by the Pump program.");
  if (account.address !== input.expectedCurveAddress) throw new Error("Bonding curve PDA does not match the expected mint.");
  assertDiscriminator(account.data, CURVE_DISCRIMINATOR, "Pump bonding curve");
  const data = account.data;
  // Required through creator + is_mayhem_mode. The IDL appends fields over time.
  if (data.length < 82 || data.length > 166) throw new Error("Unsupported Pump bonding curve account length.");
  const boundary = [82, 83, 115, 123, 124, 125, 133, 141, 142, 150, 158, 166];
  if (!boundary.includes(data.length)) throw new Error("Pump bonding curve has a partial or unknown field layout.");
  const mint = input.expectedMint;
  const quoteMint = data.length >= 115 ? readPubkey(data, 83) : NATIVE_SOL_MINT;
  return {
    address: account.address, mint, creator: readPubkey(data, 49), quoteMint,
    complete: readBool(data, 48), migrated: false,
    virtualTokenReserves: readUnsigned(data, 8, 8).toString(),
    virtualQuoteReserves: readUnsigned(data, 16, 8).toString(),
    realTokenReserves: readUnsigned(data, 24, 8).toString(),
    realQuoteReserves: readUnsigned(data, 32, 8).toString(),
    tokenTotalSupply: readUnsigned(data, 40, 8).toString(),
    creatorFeeBps: data.length >= 123 ? readUnsigned(data, 115, 8).toString() : "0",
    canEditCreatorFee: data.length >= 124 ? readBool(data, 123) : false,
    isHolderReward: data.length >= 125 ? readBool(data, 124) : false,
    creatorFeeBaseUnits: data.length >= 133 ? readUnsigned(data, 125, 8).toString() : "0",
    protocolFeesBaseUnits: data.length >= 141 ? readUnsigned(data, 133, 8).toString() : "0",
    isMayhemMode: data.length >= 82 ? readBool(data, 81) : false,
    isCashbackCoin: data.length >= 83 ? readBool(data, 82) : false,
    depth: data.length >= 142 ? readU8(data, 141) : 0,
    initialVirtualQuoteReserves: data.length >= 150 ? readUnsigned(data, 142, 8).toString() : "0",
    postCompleteBaseOut: data.length >= 158 ? readUnsigned(data, 150, 8).toString() : "0",
    postCompleteQuoteIn: data.length >= 166 ? readUnsigned(data, 158, 8).toString() : "0",
    slot: account.slot, observedAt: account.observedAt
  };
}

/**
 * Decodes PumpSwap's Pool account. Canonical status is NOT inferred here:
 * callers must compare the decoded creator with the Pump pool-authority PDA
 * derived by the official SDK, and compare index === 0.
 */
export function decodePumpSwapPoolAccount(account: RawProgramAccount): DecodedPumpSwapPoolAccount {
  assertAccount(account);
  if (account.owner !== PUMP_AMM_PROGRAM_ID) throw new Error("Pool account is not owned by the PumpSwap program.");
  assertDiscriminator(account.data, POOL_DISCRIMINATOR, "PumpSwap pool");
  const data = account.data;
  // Base layout is 245 bytes; appended fields are virtual quote reserves,
  // creator fee bps, can_edit_creator_fee and is_holder_reward.
  if (![245, 261, 269, 270, 271, 279, 287].includes(data.length)) {
    throw new Error("Unsupported or partially written PumpSwap pool account length.");
  }
  return {
    address: account.address, index: readU16(data, 9), creator: readPubkey(data, 11),
    baseMint: readPubkey(data, 43), quoteMint: readPubkey(data, 75),
    baseVault: readPubkey(data, 139), quoteVault: readPubkey(data, 171),
    coinCreator: readPubkey(data, 211),
    virtualQuoteReserves: data.length >= 261 ? readSigned128(data, 245).toString() : "0",
    creatorFeeBps: data.length >= 269 ? readUnsigned(data, 261, 8).toString() : "0",
    canEditCreatorFee: data.length >= 270 ? readBool(data, 269) : false,
    isHolderReward: data.length >= 271 ? readBool(data, 270) : false,
    protocolFeesBaseUnits: data.length >= 279 ? readUnsigned(data, 271, 8).toString() : "0",
    creatorFeesBaseUnits: data.length >= 287 ? readUnsigned(data, 279, 8).toString() : "0",
    isMayhemMode: readBool(data, 243),
    isCashbackCoin: readBool(data, 244),
    slot: account.slot, observedAt: account.observedAt
  };
}

export function decodeSplTokenAccount(account: RawProgramAccount): DecodedSplTokenAccount {
  assertAccount(account);
  if (account.owner !== SPL_TOKEN_PROGRAM_ID && account.owner !== TOKEN_2022_PROGRAM_ID) {
    throw new Error("Vault is not owned by an accepted SPL Token program.");
  }
  if (account.data.length < TOKEN_ACCOUNT_SIZE) throw new Error("SPL token account data is truncated.");
  const state = readU8(account.data, 108);
  if (state !== 1 && state !== 2) throw new Error("SPL token account is not initialized.");
  return {
    address: account.address, mint: readPubkey(account.data, 0),
    tokenAuthority: readPubkey(account.data, 32),
    amountBaseUnits: readUnsigned(account.data, 64, 8).toString(),
    tokenProgram: account.owner
  };
}

/**
 * Produces market evidence only after the caller supplies the canonical PDA
 * and creator authority derived by the official PumpSwap SDK, plus fresh
 * on-chain vault account data matching the pool's recorded vault addresses.
 */
export function verifyCanonicalPumpSwapPoolSnapshot(input: {
  poolAccount: RawProgramAccount;
  baseVaultAccount: RawProgramAccount;
  quoteVaultAccount: RawProgramAccount;
  expectedMint: string;
  expectedPoolAddress: string;
  expectedPoolCreatorAuthority: string;
  expectedPoolAuthority: string;
  nowMs?: number;
}): VerifiedPumpSwapPoolSnapshot {
  const pool = decodePumpSwapPoolAccount(input.poolAccount);
  const baseVault = decodeSplTokenAccount(input.baseVaultAccount);
  const quoteVault = decodeSplTokenAccount(input.quoteVaultAccount);
  if (pool.address !== input.expectedPoolAddress || pool.index !== 0 ||
      pool.creator !== input.expectedPoolCreatorAuthority ||
      input.expectedPoolAuthority !== input.expectedPoolAddress) {
    throw new Error("PumpSwap pool is not the canonical migration pool for this mint.");
  }
  if (pool.baseMint !== input.expectedMint || baseVault.mint !== input.expectedMint ||
      baseVault.address !== pool.baseVault || quoteVault.address !== pool.quoteVault ||
      quoteVault.mint !== pool.quoteMint || baseVault.tokenAuthority !== input.expectedPoolAuthority ||
      quoteVault.tokenAuthority !== input.expectedPoolAuthority) {
    throw new Error("PumpSwap pool mint or vault accounts do not match the canonical pool.");
  }
  if (BigInt(baseVault.amountBaseUnits) <= 0n || BigInt(quoteVault.amountBaseUnits) <= 0n) {
    throw new Error("PumpSwap pool has no non-zero token and quote liquidity.");
  }
  if (input.baseVaultAccount.slot !== input.poolAccount.slot ||
      input.quoteVaultAccount.slot !== input.poolAccount.slot) {
    throw new Error("Pool and vault accounts must come from the same RPC context slot.");
  }
  const nowMs = input.nowMs ?? Date.now();
  const observations = [input.poolAccount.observedAt, input.baseVaultAccount.observedAt, input.quoteVaultAccount.observedAt];
  if (!Number.isFinite(nowMs) || observations.some(value => {
    const timestamp = Date.parse(value);
    return !Number.isFinite(timestamp) || timestamp > nowMs || nowMs - timestamp > 2_000;
  })) throw new Error("Pool or vault account evidence is stale.");
  return {
    source: "verified-canonical-pumpswap-pool", verified: true, canonical: true,
    mint: pool.baseMint, quoteMint: pool.quoteMint, poolAddress: pool.address,
    baseReserveBaseUnits: baseVault.amountBaseUnits,
    quoteReserveBaseUnits: (BigInt(quoteVault.amountBaseUnits) + BigInt(pool.virtualQuoteReserves)).toString(),
    slot: Math.min(input.poolAccount.slot, input.baseVaultAccount.slot, input.quoteVaultAccount.slot),
    observedAt: observations.sort().at(-1)!
  };
}
