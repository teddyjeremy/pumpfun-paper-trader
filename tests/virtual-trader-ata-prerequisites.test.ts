import { describe, expect, it } from "vitest";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  inspectVirtualTraderAtaPrerequisites
} from "../src/ingestion/virtual-trader-ata-prerequisites.js";
import { deriveNonSigningVirtualTraderIdentity } from "../src/ingestion/virtual-trader-identity.js";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const MINT = new PublicKey(new Uint8Array(32).fill(7));

function rpcFetcher(values: Array<unknown>) {
  return async () => new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: "paper-account-snapshot",
    result: { context: { slot: 1234 }, value: values }
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function tokenAccountData(mint: PublicKey, owner: PublicKey): string {
  const bytes = new Uint8Array(165);
  bytes.set(mint.toBytes(), 0);
  bytes.set(owner.toBytes(), 32);
  bytes[108] = 1;
  return Buffer.from(bytes).toString("base64");
}

describe("virtual trader ATA prerequisites", () => {
  it("creates idempotent unsigned ATA instructions for missing base and quote accounts", async () => {
    const identity = await deriveNonSigningVirtualTraderIdentity();
    const quoteMint = new PublicKey(new Uint8Array(32).fill(9));
    const result = await inspectVirtualTraderAtaPrerequisites({
      identity,
      baseMint: MINT.toBase58(),
      baseTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
      quoteMint: quoteMint.toBase58(),
      quoteTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
      config: {
        apiKey: "test-key",
        now: () => NOW,
        fetcher: rpcFetcher([null, null])
      }
    });

    expect(result.slot).toBe(1234);
    expect(result.requirements.map(item => item.state)).toEqual([
      "MISSING_CREATE_REQUIRED", "MISSING_CREATE_REQUIRED"
    ]);
    expect(result.createInstructions).toHaveLength(2);
    expect(result.createInstructions.every(ix => ix.programId.toBase58() ===
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")).toBe(true);
    expect(result.accountsPresent).toBe(false);
    expect(result.paperEntryAuthorized).toBe(false);
  });

  it("accepts only initialized ATA data matching the virtual owner, mint and token program", async () => {
    const identity = await deriveNonSigningVirtualTraderIdentity();
    const owner = new PublicKey(identity.publicKey);
    const ata = getAssociatedTokenAddressSync(MINT, owner, false, TOKEN_PROGRAM_ID);
    const observedAt = new Date(NOW).toISOString();
    const account = {
      address: ata.toBase58(),
      owner: TOKEN_PROGRAM_ID.toBase58(),
      data: tokenAccountData(MINT, owner),
      slot: 1234,
      observedAt
    };
    const fetcher = async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: "paper-account-snapshot",
      result: {
        context: { slot: 1234 },
        value: [{
          owner: account.owner,
          data: [account.data, "base64"],
          lamports: 2_039_280,
          executable: false,
          rentEpoch: 0
        }]
      }
    }), { status: 200, headers: { "content-type": "application/json" } });

    const result = await inspectVirtualTraderAtaPrerequisites({
      identity,
      baseMint: MINT.toBase58(),
      baseTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
      config: { apiKey: "test-key", now: () => NOW, fetcher }
    });
    expect(result.accountsPresent).toBe(true);
    expect(result.createInstructions).toHaveLength(0);
    expect(result.requirements[0]?.state).toBe("PRESENT_AND_VERIFIED");
    expect(result.paperEntryAuthorized).toBe(false);
  });

  it("rejects an existing ATA whose token authority does not match", async () => {
    const identity = await deriveNonSigningVirtualTraderIdentity();
    const otherOwner = new PublicKey(new Uint8Array(32).fill(3));
    const ata = getAssociatedTokenAddressSync(MINT, new PublicKey(identity.publicKey), false, TOKEN_PROGRAM_ID);
    const fetcher = async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: "paper-account-snapshot",
      result: {
        context: { slot: 1234 },
        value: [{
          owner: TOKEN_PROGRAM_ID.toBase58(),
          data: [tokenAccountData(MINT, otherOwner), "base64"],
          lamports: 2_039_280,
          executable: false,
          rentEpoch: 0
        }]
      }
    }), { status: 200, headers: { "content-type": "application/json" } });

    await expect(inspectVirtualTraderAtaPrerequisites({
      identity,
      baseMint: MINT.toBase58(),
      baseTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
      config: { apiKey: "test-key", now: () => NOW, fetcher }
    })).rejects.toThrow("unexpected mint, authority or token program");
    expect(ata.toBase58()).toBeTruthy();
  });
});
