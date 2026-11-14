import { PUMP_FUN_PROGRAM_ID } from "./pump-constants.js";

/**
 * Decoder for Pump.fun's on-chain CreateEvent log.
 * Field order and discriminator are pinned to the official Pump IDL:
 * https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json
 *
 * This decodes successful transaction log payloads only. It does not infer
 * trades, prices, fills, or quote-side economics.
 */
const CREATE_EVENT_DISCRIMINATOR = Uint8Array.from([27, 114, 169, 77, 222, 235, 99, 118]);
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAX_STRING_BYTES = 16_384;

export interface PumpCreateEvent {
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  user: string;
  creator: string;
  timestamp: bigint;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  tokenProgram: string;
  isMayhemMode: boolean;
  isCashbackEnabled: boolean;
  quoteMint: string;
  virtualQuoteReserves: bigint;
  creatorFeeBps: bigint;
  isHolderReward: boolean;
  depth: number;
  /** Bytes appended by a newer on-chain event version after the verified IDL prefix. */
  trailingBytes?: number;
}


export interface PumpTradeEvent {
  mint: string;
  solAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: string;
  timestamp: bigint;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  feeRecipient: string;
  feeBasisPoints: bigint;
  fee: bigint;
  creator: string;
  creatorFeeBasisPoints: bigint;
  creatorFee: bigint;
  trackVolume: boolean;
  totalUnclaimedTokens: bigint;
  totalClaimedTokens: bigint;
  currentSolVolume: bigint;
  lastUpdateTimestamp: bigint;
  ixName: string;
  mayhemMode: boolean;
  cashbackFeeBasisPoints: bigint;
  cashback: bigint;
  buybackFeeBasisPoints: bigint;
  buybackFee: bigint;
  shareholders: Array<{ address: string; shareBps: number }>;
  quoteMint: string;
  quoteAmount: bigint;
  virtualQuoteReserves: bigint;
  realQuoteReserves: bigint;
  holderRewardsBps: bigint;
  holderRewards: bigint;
  creatorFeeUnclaimed: bigint;
  /** Bytes appended by a newer on-chain TradeEvent version after the verified IDL prefix. */
  trailingBytes?: number;
}

class BorshReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  readU8(): number {
    this.require(1);
    return this.bytes[this.offset++]!;
  }

  readU16(): number {
    this.require(2);
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 2).getUint16(0, true);
    this.offset += 2;
    return value;
  }

  readBool(): boolean {
    const value = this.readU8();
    if (value !== 0 && value !== 1) throw new Error("Invalid Borsh boolean in Pump CreateEvent.");
    return value === 1;
  }

  readU32(): number {
    this.require(4);
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4).getUint32(0, true);
    this.offset += 4;
    return value;
  }

  readU64(): bigint {
    this.require(8);
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8).getBigUint64(0, true);
    this.offset += 8;
    return value;
  }

  readI64(): bigint {
    this.require(8);
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8).getBigInt64(0, true);
    this.offset += 8;
    return value;
  }

  readString(): string {
    const length = this.readU32();
    if (length > MAX_STRING_BYTES) throw new Error("Pump CreateEvent string exceeds the decoder limit.");
    this.require(length);
    const value = new TextDecoder("utf-8", { fatal: true }).decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return value;
  }

  readPubkey(): string {
    this.require(32);
    const value = encodeBase58(this.bytes.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return value;
  }

  get remaining(): number { return this.bytes.length - this.offset; }

  finish(): void {
    if (this.offset !== this.bytes.length) throw new Error("Unexpected trailing bytes in Pump event payload.");
  }

  private require(length: number): void {
    if (!Number.isInteger(length) || length < 0 || this.offset + length > this.bytes.length) {
      throw new Error("Truncated Pump CreateEvent payload.");
    }
  }
}

function encodeBase58(bytes: Uint8Array): string {
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)]! + encoded;
    value /= 58n;
  }
  return "1".repeat(leadingZeroes) + encoded;
}

function pumpProgramDataLogs(logs: readonly string[]): string[] {
  const hasInvocationContext = logs.some(log => /^Program \\S+ invoke \\[\\d+\\]$/.test(log));
  const dataLogs: string[] = [];
  if (!hasInvocationContext) {
    return logs.filter(log => log.includes("Program data: "));
  }
  const stack: string[] = [];
  for (const log of logs) {
    const invoke = /^Program (\\S+) invoke \\[(\\d+)\\]$/.exec(log);
    if (invoke) {
      const depth = Number(invoke[2]);
      if (Number.isSafeInteger(depth) && depth > 0) {
        stack.length = depth - 1;
        stack[depth - 1] = invoke[1]!;
      }
      continue;
    }
    const completed = /^Program (\\S+) (?:success|failed:.*)$/.exec(log);
    if (completed) {
      const index = stack.lastIndexOf(completed[1]!);
      if (index >= 0) stack.length = index;
      continue;
    }
    if (stack[stack.length - 1] === PUMP_FUN_PROGRAM_ID && log.includes("Program data: ")) {
      dataLogs.push(log);
    }
  }
  return dataLogs;
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("Invalid base64 in Pump program log.");
  }
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

/** Pass logs only when the transaction metadata reports err === null. */
export function decodePumpCreateEvents(logs: readonly string[]): PumpCreateEvent[] {
  const events: PumpCreateEvent[] = [];
  for (const log of pumpProgramDataLogs(logs)) {
    const marker = "Program data: ";
    const markerIndex = log.indexOf(marker);
    if (markerIndex < 0) continue;
    const encoded = log.slice(markerIndex + marker.length).trim();
    if (!encoded) continue;
    const bytes = decodeBase64(encoded);
    if (bytes.length < CREATE_EVENT_DISCRIMINATOR.length) continue;

    let matches = true;
    for (let index = 0; index < CREATE_EVENT_DISCRIMINATOR.length; index += 1) {
      if (bytes[index] !== CREATE_EVENT_DISCRIMINATOR[index]) { matches = false; break; }
    }
    if (!matches) continue;

    const reader = new BorshReader(bytes.subarray(CREATE_EVENT_DISCRIMINATOR.length));
    const event: PumpCreateEvent = {
      name: reader.readString(),
      symbol: reader.readString(),
      uri: reader.readString(),
      mint: reader.readPubkey(),
      bondingCurve: reader.readPubkey(),
      user: reader.readPubkey(),
      creator: reader.readPubkey(),
      timestamp: reader.readI64(),
      virtualTokenReserves: reader.readU64(),
      virtualSolReserves: reader.readU64(),
      realTokenReserves: reader.readU64(),
      tokenTotalSupply: reader.readU64(),
      tokenProgram: reader.readPubkey(),
      isMayhemMode: reader.readBool(),
      isCashbackEnabled: reader.readBool(),
      quoteMint: reader.readPubkey(),
      virtualQuoteReserves: reader.readU64(),
      creatorFeeBps: reader.readU64(),
      isHolderReward: reader.readBool(),
      depth: reader.readU8()
    };
    // The public IDL is the verified prefix. Newer deployments may append
    // fields; preserve their byte count while retaining the decoded launch
    // identity, rather than discarding a valid mint/curve/timestamp tuple.
    const trailingBytes = reader.remaining;
    if (trailingBytes > 64) throw new Error("Pump CreateEvent has more than 64 unknown trailing bytes.");
    if (trailingBytes > 0) event.trailingBytes = trailingBytes;
    events.push(event);
  }
  return events;
}


const TRADE_EVENT_DISCRIMINATOR = Uint8Array.from([189, 219, 127, 211, 78, 230, 97, 238]);

/** Decode Pump.fun TradeEvent payloads using the official IDL field order. */
export function decodePumpTradeEvents(logs: readonly string[]): PumpTradeEvent[] {
  const events: PumpTradeEvent[] = [];
  for (const log of logs) {
    const marker = "Program data: ";
    const markerIndex = log.indexOf(marker);
    if (markerIndex < 0) continue;
    const encoded = log.slice(markerIndex + marker.length).trim();
    if (!encoded) continue;
    const bytes = decodeBase64(encoded);
    if (bytes.length < TRADE_EVENT_DISCRIMINATOR.length) continue;

    let matches = true;
    for (let index = 0; index < TRADE_EVENT_DISCRIMINATOR.length; index += 1) {
      if (bytes[index] !== TRADE_EVENT_DISCRIMINATOR[index]) { matches = false; break; }
    }
    if (!matches) continue;

    const reader = new BorshReader(bytes.subarray(TRADE_EVENT_DISCRIMINATOR.length));
    const mint = reader.readPubkey();
    const solAmount = reader.readU64();
    const tokenAmount = reader.readU64();
    const isBuy = reader.readBool();
    const user = reader.readPubkey();
    const timestamp = reader.readI64();
    const virtualSolReserves = reader.readU64();
    const virtualTokenReserves = reader.readU64();
    const realSolReserves = reader.readU64();
    const realTokenReserves = reader.readU64();
    const feeRecipient = reader.readPubkey();
    const feeBasisPoints = reader.readU64();
    const fee = reader.readU64();
    const creator = reader.readPubkey();
    const creatorFeeBasisPoints = reader.readU64();
    const creatorFee = reader.readU64();
    const trackVolume = reader.readBool();
    const totalUnclaimedTokens = reader.readU64();
    const totalClaimedTokens = reader.readU64();
    const currentSolVolume = reader.readU64();
    const lastUpdateTimestamp = reader.readI64();
    const ixName = reader.readString();
    const mayhemMode = reader.readBool();
    const cashbackFeeBasisPoints = reader.readU64();
    const cashback = reader.readU64();
    const buybackFeeBasisPoints = reader.readU64();
    const buybackFee = reader.readU64();
    const shareholderCount = reader.readU32();
    if (shareholderCount > 10_000) throw new Error("Pump TradeEvent shareholder vector exceeds the decoder limit.");
    const shareholders = Array.from({ length: shareholderCount }, () => ({
      address: reader.readPubkey(),
      shareBps: reader.readU16()
    }));
    const quoteMint = reader.readPubkey();
    const quoteAmount = reader.readU64();
    const virtualQuoteReserves = reader.readU64();
    const realQuoteReserves = reader.readU64();
    const holderRewardsBps = reader.readU64();
    const holderRewards = reader.readU64();
    const creatorFeeUnclaimed = reader.readU64();
    // Preserve the verified trade prefix when newer deployments append fields.
    // Unknown suffix bytes are recorded but never interpreted as strategy evidence.
    const trailingBytes = reader.remaining;
    if (trailingBytes > 64) throw new Error("Pump TradeEvent has more than 64 unknown trailing bytes.");

    events.push({
      mint, solAmount, tokenAmount, isBuy, user, timestamp,
      virtualSolReserves, virtualTokenReserves, realSolReserves, realTokenReserves,
      feeRecipient, feeBasisPoints, fee, creator, creatorFeeBasisPoints, creatorFee,
      trackVolume, totalUnclaimedTokens, totalClaimedTokens, currentSolVolume,
      lastUpdateTimestamp, ixName, mayhemMode, cashbackFeeBasisPoints, cashback,
      buybackFeeBasisPoints, buybackFee, shareholders, quoteMint, quoteAmount,
      virtualQuoteReserves, realQuoteReserves, holderRewardsBps, holderRewards,
      creatorFeeUnclaimed,
      ...(trailingBytes > 0 ? { trailingBytes } : {})
    });
  }
  return events;
}


export type PumpTransactionDecodeResult =
  | {
      status: "DECODED";
      signature: string;
      slot: number;
      createEvents: PumpCreateEvent[];
      tradeEvents: PumpTradeEvent[];
    }
  | { status: "FAILED_TRANSACTION"; signature: string }
  | { status: "DATA_INCOMPLETE"; reason: string };

/**
 * Transaction-level safety gate for standard Solana getTransaction responses.
 * Failed transactions are never decoded as observations. Missing transaction
 * metadata/logs are explicit data gaps, not empty/no-trade observations.
 */
export function decodeSuccessfulPumpTransaction(input: unknown): PumpTransactionDecodeResult {
  if (!input || typeof input !== "object") {
    return { status: "DATA_INCOMPLETE", reason: "Transaction response is missing or malformed." };
  }

  const transaction = input as {
    slot?: unknown;
    transaction?: { signatures?: unknown };
    meta?: { err?: unknown; logMessages?: unknown };
  };

  const signatures = transaction.transaction?.signatures;
  const signature = Array.isArray(signatures) && typeof signatures[0] === "string"
    ? signatures[0]
    : null;
  if (!signature) {
    return { status: "DATA_INCOMPLETE", reason: "Transaction signature is missing." };
  }

  if (!Number.isSafeInteger(transaction.slot) || (transaction.slot as number) < 0) {
    return { status: "DATA_INCOMPLETE", reason: "Transaction slot is missing or invalid." };
  }

  if (!transaction.meta || !Object.prototype.hasOwnProperty.call(transaction.meta, "err") ||
      transaction.meta.err === undefined) {
    return { status: "DATA_INCOMPLETE", reason: "Transaction execution metadata is missing." };
  }
  if (transaction.meta.err !== null) {
    return { status: "FAILED_TRANSACTION", signature };
  }

  if (!Array.isArray(transaction.meta.logMessages) ||
      !transaction.meta.logMessages.every((line): line is string => typeof line === "string")) {
    return { status: "DATA_INCOMPLETE", reason: "Successful transaction log messages are missing." };
  }

  try {
    return {
      status: "DECODED",
      signature,
      slot: transaction.slot as number,
      createEvents: decodePumpCreateEvents(transaction.meta.logMessages),
      tradeEvents: decodePumpTradeEvents(transaction.meta.logMessages)
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 160) : "unknown decoder error";
    return { status: "DATA_INCOMPLETE", reason: `Pump event payload decode failed: ${detail}` };
  }
}
