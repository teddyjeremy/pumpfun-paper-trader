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
}

class BorshReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  readU8(): number {
    this.require(1);
    return this.bytes[this.offset++]!;
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

  finish(): void {
    if (this.offset !== this.bytes.length) throw new Error("Unexpected trailing bytes in Pump CreateEvent.");
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

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("Invalid base64 in Pump program log.");
  }
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

/** Pass logs only when the transaction metadata reports err === null. */
export function decodePumpCreateEvents(logs: readonly string[]): PumpCreateEvent[] {
  const events: PumpCreateEvent[] = [];
  for (const log of logs) {
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
    events.push({
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
    });
    reader.finish();
  }
  return events;
}
