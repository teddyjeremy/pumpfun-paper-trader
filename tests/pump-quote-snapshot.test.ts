import { describe, expect, it } from "vitest";
import {
  verifyPumpQuoteAccountSnapshot,
  type PumpQuoteAccountAddresses
} from "../src/ingestion/pump-quote-snapshot.js";
import type { HeliusAccountSnapshot } from "../src/ingestion/helius-accounts.js";
import type { RawProgramAccount } from "../src/ingestion/pump-account-decoder.js";

const nowMs = Date.parse("2026-11-12T12:00:00.000Z");
const observedAt = new Date(nowMs).toISOString();
const addresses: PumpQuoteAccountAddresses = {
  market: "market", baseMint: "base-mint", quoteMint: "quote-mint",
  globalConfig: "global", feeConfig: "fee-config",
  baseVault: "base-vault", quoteVault: "quote-vault"
};
function account(address: string, slot = 55): RawProgramAccount {
  return { address, owner: "program", data: new Uint8Array([1]), slot, observedAt };
}
function snapshot(overrides: Partial<HeliusAccountSnapshot> = {}): HeliusAccountSnapshot {
  return {
    slot: 55, commitment: "confirmed", observedAt,
    accounts: Object.values(addresses).map(address => account(address)),
    ...overrides
  };
}

describe("coherent Pump quote account snapshots", () => {
  it("accepts all required quote accounts from one fresh Helius context slot", () => {
    const result = verifyPumpQuoteAccountSnapshot({ addresses, snapshot: snapshot(), nowMs });
    expect(result).toMatchObject({
      source: "helius-getMultipleAccounts", verified: true, slot: 55,
      accountCount: 7, commitment: "confirmed"
    });
    expect(result.accounts.market?.address).toBe("market");
    expect(result.accounts.quoteVault?.address).toBe("quote-vault");
  });

  it("rejects a missing account and an account returned in the wrong order", () => {
    expect(() => verifyPumpQuoteAccountSnapshot({
      addresses, snapshot: snapshot({ accounts: [null, ...snapshot().accounts.slice(1)] }), nowMs
    })).toThrow(/missing or misordered/);
    expect(() => verifyPumpQuoteAccountSnapshot({
      addresses, snapshot: snapshot({ accounts: [...snapshot().accounts].reverse() }), nowMs
    })).toThrow(/missing or misordered/);
  });

  it("rejects mixed context slots and mixed observation timestamps", () => {
    const mixedSlot = snapshot();
    mixedSlot.accounts[3] = account("global", 56);
    expect(() => verifyPumpQuoteAccountSnapshot({ addresses, snapshot: mixedSlot, nowMs }))
      .toThrow(/same Helius context slot/);
    const mixedTime = snapshot();
    mixedTime.accounts[2] = { ...account("quote-mint"), observedAt: "2026-11-12T11:59:00.000Z" };
    expect(() => verifyPumpQuoteAccountSnapshot({ addresses, snapshot: mixedTime, nowMs }))
      .toThrow(/same Helius context slot/);
  });

  it("rejects stale snapshots, invalid addresses and duplicate account roles", () => {
    expect(() => verifyPumpQuoteAccountSnapshot({
      addresses, snapshot: snapshot({ observedAt: "2026-11-12T11:59:00.000Z" }), nowMs
    })).toThrow(/stale/);
    expect(() => verifyPumpQuoteAccountSnapshot({
      addresses: { ...addresses, quoteVault: "base-vault" }, snapshot: snapshot(), nowMs
    })).toThrow(/unique addresses/);
    expect(() => verifyPumpQuoteAccountSnapshot({
      addresses: { ...addresses, quoteMint: "" }, snapshot: snapshot(), nowMs
    })).toThrow(/unique addresses/);
  });

  it("requires global and fee config as part of the same snapshot", () => {
    const { globalConfig: _global, ...missingGlobal } = addresses;
    const withoutGlobal = { ...missingGlobal };
    expect(() => verifyPumpQuoteAccountSnapshot({
      addresses: withoutGlobal as PumpQuoteAccountAddresses,
      snapshot: snapshot({ accounts: snapshot().accounts.slice(1) }), nowMs
    })).toThrow(/unique addresses/);
  });
});
