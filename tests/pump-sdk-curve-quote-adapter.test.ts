import { describe, expect, it } from "vitest";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { PUMP_PROGRAM_ID } from "../src/ingestion/pump-account-decoder.js";
import { buildPumpUserVolumeAccumulatorInitInstruction } from "../src/ingestion/pump-sdk-runtime.js";
import {
  buildPumpCurveV3UnsignedInstruction,
  fetchPumpCurveSdkQuote,
  quotePumpCurveBuyFromSnapshot,
  quotePumpCurveSellFromSnapshot
} from "../src/ingestion/pump-sdk-curve-quote-adapter.js";

describe("official Pump curve quote adapter safety gates", () => {
  it("builds the official volume accumulator initializer with the expected accounts", async () => {
    const payer = new PublicKey(new Uint8Array(32).fill(11));
    const user = new PublicKey(new Uint8Array(32).fill(12));
    const accumulator = PublicKey.findProgramAddressSync(
      [Buffer.from("user_volume_accumulator"), user.toBuffer()],
      new PublicKey(PUMP_PROGRAM_ID)
    )[0];
    const instruction = await buildPumpUserVolumeAccumulatorInitInstruction({
      payer: payer.toBase58(), user: user.toBase58()
    });
    expect(instruction.programId.toBase58()).toBe(PUMP_PROGRAM_ID);
    const accounts = instruction.keys.map(key => key.pubkey.toBase58());
    expect(accounts).toContain(payer.toBase58());
    expect(accounts).toContain(user.toBase58());
    expect(accounts).toContain(accumulator.toBase58());
    expect(accounts).toContain(SystemProgram.programId.toBase58());
    expect(instruction.keys.find(key => key.pubkey.equals(payer))?.isSigner).toBe(true);
  });

  it("rejects malformed buy budgets before decoding market state", () => {
    expect(() => quotePumpCurveBuyFromSnapshot({} as never, "0")).toThrow(/positive base-unit/);
    expect(() => quotePumpCurveBuyFromSnapshot({} as never, "-1")).toThrow(/positive base-unit/);
    expect(() => quotePumpCurveBuyFromSnapshot({} as never, "1.2")).toThrow(/positive base-unit/);
    expect(() => quotePumpCurveBuyFromSnapshot({} as never, "18446744073709551616")).toThrow(/positive base-unit/);
  });

  it("rejects malformed sell sizes before decoding market state", () => {
    expect(() => quotePumpCurveSellFromSnapshot({} as never, "0")).toThrow(/positive base-unit/);
    expect(() => quotePumpCurveSellFromSnapshot({} as never, "-1")).toThrow(/positive base-unit/);
    expect(() => quotePumpCurveSellFromSnapshot({} as never, "1.2")).toThrow(/positive base-unit/);
    expect(() => quotePumpCurveSellFromSnapshot({} as never, "18446744073709551616")).toThrow(/positive base-unit/);
  });

  it("does not issue Helius reads for malformed quote sizes", async () => {
    let called = false;
    await expect(fetchPumpCurveSdkQuote({
      mint: "So11111111111111111111111111111111111111112",
      side: "BUY", amountBaseUnits: "18446744073709551616",
      config: { apiKey: "test", fetcher: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      } }
    })).rejects.toThrow(/positive base-unit/);
    expect(called).toBe(false);
  });
});
