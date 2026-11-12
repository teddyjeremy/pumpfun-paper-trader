import { describe, expect, it } from "vitest";
import {
  canRequestPaperExitQuote, createUnverifiedMarketState, updatePumpMarketState,
  type VerifiedCurveEvidence, type VerifiedPoolEvidence
} from "../src/paper/pump-market-state.js";

const now = Date.parse("2026-11-12T12:00:00.000Z");
const iso = new Date(now).toISOString();
const curve = (overrides: Partial<VerifiedCurveEvidence> = {}): VerifiedCurveEvidence => ({
  source: "verified-pump-curve-account", verified: true, mint: "mint",
  curveAddress: "curve", quoteMint: "So11111111111111111111111111111111111111112", complete: false, migrated: false,
  tokenReserveBaseUnits: "1000", quoteReserveBaseUnits: "500",
  virtualTokenReservesBaseUnits: "2000", virtualQuoteReservesBaseUnits: "3000",
  realQuoteReservesBaseUnits: "500", tokenTotalSupplyBaseUnits: "1000000",
  creatorFeeBps: "75", creatorFeeBaseUnits: "10", protocolFeesBaseUnits: "20",
  isMayhemMode: false, isCashbackCoin: false,
  slot: 100, observedAt: iso, ...overrides
});
const pool = (overrides: Partial<VerifiedPoolEvidence> = {}): VerifiedPoolEvidence => ({
  source: "verified-canonical-pumpswap-pool", verified: true, canonical: true,
  mint: "mint", quoteMint: "So11111111111111111111111111111111111111112",
  poolAddress: "pool", baseReserveBaseUnits: "1000", rawQuoteVaultReserveBaseUnits: "600",
  virtualQuoteReservesBaseUnits: "-100", quoteReserveBaseUnits: "500",
  creatorFeeBps: "75", protocolFeesBaseUnits: "10", creatorFeesBaseUnits: "20",
  isMayhemMode: false, isCashbackCoin: false,
  slot: 101, observedAt: iso, ...overrides
});

describe("Pump market migration state", () => {
  it("starts unverified and never permits an exit quote", () => {
    const state = createUnverifiedMarketState("mint", iso);
    expect(state.status).toBe("UNVERIFIED");
    expect(canRequestPaperExitQuote(state)).toBe(false);
  });

  it("accepts a fresh verified live curve but still requires a sell quote", () => {
    const initial = createUnverifiedMarketState("mint", iso);
    const state = updatePumpMarketState(initial, { curve: curve(), nowMs: now });
    expect(state.status).toBe("LIVE_CURVE");
    expect(canRequestPaperExitQuote(state)).toBe(true);
    expect(state.reason).toMatch(/sell quote is still required/);
  });

  it("moves a completed curve to migration pending without auto-selling", () => {
    const initial = createUnverifiedMarketState("mint", iso);
    const state = updatePumpMarketState(initial, { curve: curve({ complete: true }), nowMs: now });
    expect(state.status).toBe("MIGRATION_PENDING");
    expect(canRequestPaperExitQuote(state)).toBe(false);
    expect(state.reason).toMatch(/Do not auto-sell/);
  });

  it("accepts a migrated curve with zeroed reserves as migration pending", () => {
    const initial = createUnverifiedMarketState("mint", iso);
    const state = updatePumpMarketState(initial, {
      curve: curve({ migrated: true, tokenReserveBaseUnits: "0", quoteReserveBaseUnits: "0" }),
      nowMs: now
    });
    expect(state.status).toBe("MIGRATION_PENDING");
    expect(canRequestPaperExitQuote(state)).toBe(false);
  });

  it("accepts only a verified canonical pool with fresh non-zero reserves", () => {
    const initial = createUnverifiedMarketState("mint", iso);
    const state = updatePumpMarketState(initial, { pool: pool(), nowMs: now });
    expect(state.status).toBe("MIGRATED_POOL_VERIFIED");
    expect(canRequestPaperExitQuote(state)).toBe(true);
  });

  it("blocks mismatched, stale, non-canonical or empty pool evidence", () => {
    const initial = createUnverifiedMarketState("mint", iso);
    for (const evidence of [
      pool({ mint: "other" }), pool({ canonical: false }),
      pool({ observedAt: "2026-11-12T11:59:00.000Z" }),
      pool({ baseReserveBaseUnits: "0" }), pool({ quoteReserveBaseUnits: "0" }),
      pool({ quoteReserveBaseUnits: "501" }),
      pool({ rawQuoteVaultReserveBaseUnits: "not-a-number" })
    ]) {
      const state = updatePumpMarketState(initial, { pool: evidence, nowMs: now });
      expect(state.status).toBe("EXIT_BLOCKED");
      expect(canRequestPaperExitQuote(state)).toBe(false);
    }
  });

  it("blocks stale curve evidence and never falls back to an old live curve", () => {
    const initial = createUnverifiedMarketState("mint", iso);
    const live = updatePumpMarketState(initial, { curve: curve(), nowMs: now });
    const stale = updatePumpMarketState(live, { curve: curve({ observedAt: "2026-11-12T11:59:00.000Z" }), nowMs: now });
    expect(stale.status).toBe("EXIT_BLOCKED");
    expect(canRequestPaperExitQuote(stale)).toBe(false);
  });
});
