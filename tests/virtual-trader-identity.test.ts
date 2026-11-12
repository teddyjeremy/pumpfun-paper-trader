import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  deriveNonSigningVirtualTraderIdentity,
  deriveVirtualTraderTokenAccount
} from "../src/ingestion/virtual-trader-identity.js";

describe("non-signing virtual trader identity", () => {
  it("derives a deterministic on-curve public address without exposing signing capability", async () => {
    const first = await deriveNonSigningVirtualTraderIdentity();
    const second = await deriveNonSigningVirtualTraderIdentity();

    expect(first).toEqual(second);
    expect(first.kind).toBe("NON_SIGNING_VIRTUAL_TRADER");
    expect(first.canSign).toBe(false);
    expect(first.canSubmit).toBe(false);
    expect(PublicKey.isOnCurve(new PublicKey(first.publicKey).toBytes())).toBe(true);
    expect(first).not.toHaveProperty("secretKey");
    expect(first).not.toHaveProperty("privateKey");
  });

  it("derives deterministic ATAs for the explicitly verified token program", async () => {
    const identity = await deriveNonSigningVirtualTraderIdentity();
    const mint = new PublicKey("So11111111111111111111111111111111111111112");

    const legacy = deriveVirtualTraderTokenAccount({
      identity, mint: mint.toBase58(), tokenProgram: TOKEN_PROGRAM_ID.toBase58()
    });
    const token2022 = deriveVirtualTraderTokenAccount({
      identity, mint: mint.toBase58(), tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58()
    });

    expect(legacy.associatedTokenAddress).not.toBe(token2022.associatedTokenAddress);
    expect(legacy.existence).toBe("MUST_BE_VERIFIED_FROM_CHAIN");
    expect(token2022.existence).toBe("MUST_BE_VERIFIED_FROM_CHAIN");
    expect(deriveVirtualTraderTokenAccount({
      identity, mint: mint.toBase58(), tokenProgram: TOKEN_PROGRAM_ID.toBase58()
    })).toEqual(legacy);
  });

  it("rejects unsupported token programs and identities that claim signing ability", async () => {
    const identity = await deriveNonSigningVirtualTraderIdentity();
    expect(() => deriveVirtualTraderTokenAccount({
      identity, mint: PublicKey.default.toBase58(), tokenProgram: PublicKey.default.toBase58()
    })).toThrow(/canonical SPL Token/);
    expect(() => deriveVirtualTraderTokenAccount({
      identity: { ...identity, canSign: true } as never,
      mint: PublicKey.default.toBase58(),
      tokenProgram: TOKEN_PROGRAM_ID.toBase58()
    })).toThrow(/non-signing/);
  });
});
