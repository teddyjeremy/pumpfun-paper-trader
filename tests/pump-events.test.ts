import { describe, expect, it } from "vitest";
import { decodePumpCreateEvents } from "../src/ingestion/pump-events.js";

const discriminator = [27, 114, 169, 77, 222, 235, 99, 118];
function encodeBase64(bytes: number[]): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function u32(value: number): number[] {
  return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
}
function u64(value: bigint): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < 8; index += 1) bytes.push(Number((value >> BigInt(index * 8)) & 255n));
  return bytes;
}
function string(value: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(value));
  return [...u32(bytes.length), ...bytes];
}
function pubkey(fill: number): number[] {
  return Array.from({ length: 32 }, () => fill);
}
function createEventPayload(): number[] {
  return [
    ...discriminator, ...string("Test Coin"), ...string("TEST"), ...string("https://example.invalid/metadata.json"),
    ...pubkey(1), ...pubkey(2), ...pubkey(3), ...pubkey(4),
    ...u64(1_700_000_000n), ...u64(1_000_000n), ...u64(30_000_000_000n),
    ...u64(793_100_000_000_000n), ...u64(1_000_000_000_000_000n), ...pubkey(5),
    0, 0, ...pubkey(0), ...u64(0n), ...u64(0n), 0, 0
  ];
}

describe("Pump.fun CreateEvent decoder", () => {
  it("decodes the official event layout and preserves raw integer amounts", () => {
    const [event] = decodePumpCreateEvents(["Program data: " + encodeBase64(createEventPayload())]);
    expect(event).toMatchObject({
      name: "Test Coin", symbol: "TEST", uri: "https://example.invalid/metadata.json",
      mint: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
      bondingCurve: "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR",
      timestamp: 1_700_000_000n, virtualSolReserves: 30_000_000_000n,
      tokenTotalSupply: 1_000_000_000_000_000n, isMayhemMode: false, depth: 0
    });
  });

  it("ignores unrelated program data and non-data log lines", () => {
    expect(decodePumpCreateEvents([
      "Program log: Instruction: Buy",
      "Program data: " + encodeBase64([1, 2, 3, 4, 5, 6, 7, 8, 9])
    ])).toEqual([]);
  });

  it("rejects truncated matching events instead of emitting partial candidates", () => {
    expect(() => decodePumpCreateEvents(["Program data: " + encodeBase64(discriminator)])).toThrow(/Truncated/);
  });

  it("rejects malformed base64 log payloads", () => {
    expect(() => decodePumpCreateEvents(["Program data: !!!"])).toThrow(/base64/);
  });

  it("rejects invalid Borsh booleans", () => {
    const payload = createEventPayload();
    const boolOffset = discriminator.length + string("Test Coin").length + string("TEST").length +
      string("https://example.invalid/metadata.json").length + 32 * 4 + 8 * 5 + 32;
    payload[boolOffset] = 2;
    expect(() => decodePumpCreateEvents(["Program data: " + encodeBase64(payload)])).toThrow(/boolean/);
  });
});
