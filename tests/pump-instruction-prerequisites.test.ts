import { describe, expect, it } from "vitest";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PUMP_PROGRAM_ID } from "../src/ingestion/pump-account-decoder.js";
import {
  inspectPumpCurveV3InstructionPrerequisites,
  inspectPumpSwapV2InstructionPrerequisites
} from "../src/ingestion/pump-instruction-prerequisites.js";
import { deriveNonSigningVirtualTraderIdentity } from "../src/ingestion/virtual-trader-identity.js";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const MINT = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
const QUOTE = "So11111111111111111111111111111111111111112";

function fetcherForMissingAccounts() {
  const rentCalls: number[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    if (body.method === "getMultipleAccounts") {
      const addresses = body.params[0] as string[];
      return Response.json({
        jsonrpc: "2.0", id: "accounts",
        result: { context: { slot: 1234 }, value: addresses.map(() => null) }
      });
    }
    if (body.method === "getMinimumBalanceForRentExemption") {
      const size = Number(body.params[0]);
      rentCalls.push(size);
      return Response.json({
        jsonrpc: "2.0", id: "rent",
        result: size === 137 ? 1_844_400 : 2_039_280
      });
    }
    throw new Error(`Unexpected RPC method ${body.method}`);
  };
  return { fetcher, rentCalls };
}

describe("unsigned Pump instruction account prerequisites", () => {
  it("checks Pump V3 user volume accumulator and includes its refundable rent in the reserve", async () => {
    const identity = await deriveNonSigningVirtualTraderIdentity();
    const user = new PublicKey(identity.publicKey);
    const volumePda = PublicKey.findProgramAddressSync(
      [Buffer.from("user_volume_accumulator"), user.toBuffer()],
      new PublicKey(PUMP_PROGRAM_ID)
    )[0];
    const mock = fetcherForMissingAccounts();
    const result = await inspectPumpCurveV3InstructionPrerequisites({
      identity,
      instruction: {
        provider: "pump-sdk-4.3.1", venue: "PUMP_CURVE", side: "BUY",
        mint: MINT, user: identity.publicKey, quoteMint: QUOTE,
        baseTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
        quoteTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
        buybackFeeRecipient: new PublicKey(new Uint8Array(32).fill(8)).toBase58(),
        userVolumeAccumulatorAddress: volumePda.toBase58(),
        instruction: {} as never, requiredAccountAddressesToVerify: [],
        optionalAccountAddresses: [], slot: 1234, observedAt: new Date(NOW).toISOString(),
        executionReady: false, paperEntryAuthorized: false,
        blockers: ["USER_BASE_ATA_EXISTENCE_AND_STATE_NOT_VERIFIED",
          "ATA_RENT_AND_VIRTUAL_PAYER_BALANCE_NOT_VERIFIED",
          "BUYBACK_FEE_RECIPIENT_ACCOUNT_EXISTENCE_AND_STATE_NOT_VERIFIED",
          "USER_VOLUME_ACCUMULATOR_STATE_AND_RENT_NOT_VERIFIED"]
      },
      config: { apiKey: "test-key", now: () => NOW, fetcher: mock.fetcher }
    });
    expect(result.volumeAccumulator?.state).toBe("MISSING_INIT_IF_NEEDED");
    expect(result.volumeAccumulator?.minimumRentLamports).toBe(1_844_400);
    expect(result.ataSnapshot.createInstructions).toHaveLength(1);
    expect(result.totalNewRentReserveLamports).toBe(3_883_680);
    expect(result.blockers).toContain("USER_VOLUME_ACCUMULATOR_RENT_RESERVE_NOT_RECORDED_IN_PAPER_PORTFOLIO");
    expect(result.blockers).toContain("USER_VOLUME_ACCUMULATOR_INIT_INSTRUCTION_NOT_INCLUDED");
    expect(result.blockers).toContain("BUYBACK_FEE_RECIPIENT_ACCOUNT_EXISTENCE_AND_STATE_NOT_VERIFIED");
    expect(result.paperEntryAuthorized).toBe(false);
    expect(mock.rentCalls.sort((a, b) => a - b)).toEqual([137, 165]);
  });

  it("rejects a non-canonical volume-accumulator address before making RPC requests", async () => {
    const identity = await deriveNonSigningVirtualTraderIdentity();
    const fetcher: typeof fetch = async () => {
      throw new Error("RPC must not be called for a non-canonical accumulator PDA.");
    };
    await expect(inspectPumpCurveV3InstructionPrerequisites({
      identity,
      instruction: {
        provider: "pump-sdk-4.3.1", venue: "PUMP_CURVE", side: "BUY",
        mint: MINT, user: identity.publicKey, quoteMint: QUOTE,
        baseTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
        quoteTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
        buybackFeeRecipient: new PublicKey(new Uint8Array(32).fill(8)).toBase58(),
        userVolumeAccumulatorAddress: new PublicKey(new Uint8Array(32).fill(9)).toBase58(),
        instruction: {} as never, requiredAccountAddressesToVerify: [],
        optionalAccountAddresses: [], slot: 1234, observedAt: new Date(NOW).toISOString(),
        executionReady: false, paperEntryAuthorized: false, blockers: []
      },
      config: { apiKey: "test-key", now: () => NOW, fetcher }
    })).rejects.toThrow(/does not match the canonical user PDA/);
  });

  it("rejects a Pump-owned 137-byte account with the wrong volume-accumulator discriminator", async () => {
    const identity = await deriveNonSigningVirtualTraderIdentity();
    const user = new PublicKey(identity.publicKey);
    const volumePda = PublicKey.findProgramAddressSync(
      [Buffer.from("user_volume_accumulator"), user.toBuffer()],
      new PublicKey(PUMP_PROGRAM_ID)
    )[0];
    let accountReads = 0;
    const invalidData = new Uint8Array(137);
    const invalidAccountBase64 = btoa(String.fromCharCode(...invalidData));
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (body.method === "getMultipleAccounts") {
        accountReads += 1;
        const addresses = body.params[0] as string[];
        return Response.json({
          jsonrpc: "2.0", id: "accounts",
          result: {
            context: { slot: 1234 },
            value: addresses.map(address => accountReads === 2 && address === volumePda.toBase58()
              ? { owner: PUMP_PROGRAM_ID, data: [invalidAccountBase64, "base64"] }
              : null)
          }
        });
      }
      if (body.method === "getMinimumBalanceForRentExemption") {
        return Response.json({ jsonrpc: "2.0", id: "rent", result: 2_039_280 });
      }
      throw new Error(`Unexpected RPC method ${body.method}`);
    };
    await expect(inspectPumpCurveV3InstructionPrerequisites({
      identity,
      instruction: {
        provider: "pump-sdk-4.3.1", venue: "PUMP_CURVE", side: "BUY",
        mint: MINT, user: identity.publicKey, quoteMint: QUOTE,
        baseTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
        quoteTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
        buybackFeeRecipient: new PublicKey(new Uint8Array(32).fill(8)).toBase58(),
        userVolumeAccumulatorAddress: volumePda.toBase58(),
        instruction: {} as never, requiredAccountAddressesToVerify: [],
        optionalAccountAddresses: [], slot: 1234, observedAt: new Date(NOW).toISOString(),
        executionReady: false, paperEntryAuthorized: false, blockers: []
      },
      config: { apiKey: "test-key", now: () => NOW, fetcher }
    })).rejects.toThrow(/unexpected owner, discriminator, size or snapshot context/);
  });

  it("accepts a present volume accumulator only with the expected discriminator", async () => {
    const identity = await deriveNonSigningVirtualTraderIdentity();
    const user = new PublicKey(identity.publicKey);
    const volumePda = PublicKey.findProgramAddressSync(
      [Buffer.from("user_volume_accumulator"), user.toBuffer()],
      new PublicKey(PUMP_PROGRAM_ID)
    )[0];
    let accountReads = 0;
    const data = new Uint8Array(137);
    data.set([30, 11, 48, 57, 93, 5, 90, 28]);
    const encoded = btoa(String.fromCharCode(...data));
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (body.method === "getMultipleAccounts") {
        accountReads += 1;
        const addresses = body.params[0] as string[];
        return Response.json({
          jsonrpc: "2.0", id: "accounts",
          result: {
            context: { slot: 1234 },
            value: addresses.map(address => accountReads === 2 && address === volumePda.toBase58()
              ? { owner: PUMP_PROGRAM_ID, data: [encoded, "base64"] }
              : null)
          }
        });
      }
      if (body.method === "getMinimumBalanceForRentExemption") {
        return Response.json({ jsonrpc: "2.0", id: "rent", result: 2_039_280 });
      }
      throw new Error(`Unexpected RPC method ${body.method}`);
    };
    const result = await inspectPumpCurveV3InstructionPrerequisites({
      identity,
      instruction: {
        provider: "pump-sdk-4.3.1", venue: "PUMP_CURVE", side: "BUY",
        mint: MINT, user: identity.publicKey, quoteMint: QUOTE,
        baseTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
        quoteTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
        buybackFeeRecipient: new PublicKey(new Uint8Array(32).fill(8)).toBase58(),
        userVolumeAccumulatorAddress: volumePda.toBase58(),
        instruction: {} as never, requiredAccountAddressesToVerify: [],
        optionalAccountAddresses: [], slot: 1234, observedAt: new Date(NOW).toISOString(),
        executionReady: false, paperEntryAuthorized: false, blockers: []
      },
      config: { apiKey: "test-key", now: () => NOW, fetcher }
    });
    expect(result.volumeAccumulator?.state).toBe("PRESENT_AND_VERIFIED");
    expect(result.volumeAccumulator?.minimumRentLamports).toBeNull();
    expect(result.totalNewRentReserveLamports).toBe(2_039_280);
  });

  it("fails closed when PumpSwap has no configured buyback fee recipients", async () => {
    const identity = await deriveNonSigningVirtualTraderIdentity();
    await expect(inspectPumpSwapV2InstructionPrerequisites({
      identity,
      instruction: {
        provider: "pump-sdk-4.3.1", venue: "PUMPSWAP", side: "BUY",
        mint: MINT, user: identity.publicKey, quoteMint: QUOTE,
        baseTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
        quoteTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
        buybackFeeRecipients: [],
        instructions: [], requiredAccountAddressesToVerify: [],
        slot: 1234, observedAt: new Date(NOW).toISOString(),
        executionReady: false, paperEntryAuthorized: false,
        blockers: ["BUYBACK_QUOTE_ATA_EXISTENCE_AND_STATE_NOT_VERIFIED"]
      },
      config: { apiKey: "test-key", now: () => NOW, fetcher: fetcherForMissingAccounts().fetcher }
    })).rejects.toThrow("at least one buyback fee recipient");
  });

  it("checks every configured PumpSwap buyback quote ATA and totals all missing ATA rent", async () => {
    const identity = await deriveNonSigningVirtualTraderIdentity();
    const recipients = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
    const mock = fetcherForMissingAccounts();
    const result = await inspectPumpSwapV2InstructionPrerequisites({
      identity,
      instruction: {
        provider: "pump-sdk-4.3.1", venue: "PUMPSWAP", side: "BUY",
        mint: MINT, user: identity.publicKey, quoteMint: QUOTE,
        baseTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
        quoteTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
        buybackFeeRecipients: recipients,
        instructions: [], requiredAccountAddressesToVerify: [],
        slot: 1234, observedAt: new Date(NOW).toISOString(),
        executionReady: false, paperEntryAuthorized: false,
        blockers: ["USER_BASE_ATA_EXISTENCE_AND_STATE_NOT_VERIFIED",
          "USER_QUOTE_ATA_EXISTENCE_AND_STATE_NOT_VERIFIED",
          "BUYBACK_QUOTE_ATA_EXISTENCE_AND_STATE_NOT_VERIFIED",
          "ATA_RENT_AND_VIRTUAL_PAYER_BALANCE_NOT_VERIFIED"]
      },
      config: { apiKey: "test-key", now: () => NOW, fetcher: mock.fetcher }
    });
    expect(result.ataSnapshot.requirements.map(item => item.role))
      .toEqual(["base", "quote", "buyback", "buyback"]);
    expect(result.ataSnapshot.createInstructions).toHaveLength(4);
    expect(result.totalNewRentReserveLamports).toBe(8_157_120);
    expect(result.rentEstimate.allNewAtaRentKnown).toBe(true);
    expect(result.paperEntryAuthorized).toBe(false);
    expect(mock.rentCalls).toEqual([165]);
  });
});
