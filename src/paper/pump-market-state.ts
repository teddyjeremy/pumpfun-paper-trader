export type PumpMarketStatus =
  | "UNVERIFIED"
  | "LIVE_CURVE"
  | "MIGRATION_PENDING"
  | "MIGRATED_POOL_VERIFIED"
  | "EXIT_BLOCKED";

export interface VerifiedCurveEvidence {
  source: "verified-pump-curve-account";
  verified: true;
  mint: string;
  curveAddress: string;
  quoteMint: string;
  complete: boolean;
  migrated: boolean;
  tokenReserveBaseUnits: string;
  quoteReserveBaseUnits: string;
  virtualTokenReservesBaseUnits: string;
  virtualQuoteReservesBaseUnits: string;
  realQuoteReservesBaseUnits: string;
  tokenTotalSupplyBaseUnits: string;
  creatorFeeBps: string;
  creatorFeeBaseUnits: string;
  protocolFeesBaseUnits: string;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  slot: number;
  observedAt: string;
}

export interface VerifiedPoolEvidence {
  source: "verified-canonical-pumpswap-pool";
  verified: true;
  canonical: true;
  mint: string;
  quoteMint: string;
  poolAddress: string;
  baseReserveBaseUnits: string;
  /** Raw quote-vault token-account balance, before virtual reserves. */
  rawQuoteVaultReserveBaseUnits: string;
  /** Signed PumpSwap virtual quote-reserve adjustment. */
  virtualQuoteReservesBaseUnits: string;
  /** Effective pricing reserve: raw quote vault + virtual quote adjustment. */
  quoteReserveBaseUnits: string;
  creatorFeeBps: string;
  protocolFeesBaseUnits: string;
  creatorFeesBaseUnits: string;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  slot: number;
  observedAt: string;
}

export interface PumpMarketState {
  mint: string;
  status: PumpMarketStatus;
  updatedAt: string;
  curve: VerifiedCurveEvidence | null;
  pool: VerifiedPoolEvidence | null;
  reason: string;
}

export const MARKET_EVIDENCE_MAX_AGE_MS = 2_000;

function validBaseUnits(value: string, allowZero = false): boolean {
  return /^\d+$/.test(value) && (allowZero ? BigInt(value) >= 0n : BigInt(value) > 0n);
}

function validSignedBaseUnits(value: string): boolean {
  return /^-?[0-9]+$/.test(value);
}

function validObservation(observedAt: string, nowMs: number): boolean {
  const observedMs = Date.parse(observedAt);
  return Number.isFinite(observedMs) && observedMs <= nowMs &&
    nowMs - observedMs <= MARKET_EVIDENCE_MAX_AGE_MS;
}

function validSlot(slot: number): boolean {
  return Number.isSafeInteger(slot) && slot >= 0;
}

export function createUnverifiedMarketState(mint: string, now = new Date().toISOString()): PumpMarketState {
  if (!mint.trim() || !Number.isFinite(Date.parse(now))) throw new Error("Market identity and timestamp are required.");
  return { mint, status: "UNVERIFIED", updatedAt: now, curve: null, pool: null,
    reason: "No fresh verified Pump.fun curve or canonical PumpSwap pool evidence is available." };
}

/**
 * Applies authoritative account evidence only. A completed/migrated curve never
 * triggers a sell; until a canonical pool is verified, the position is EXIT_BLOCKED.
 */
export function updatePumpMarketState(
  previous: PumpMarketState,
  input: { curve?: VerifiedCurveEvidence; pool?: VerifiedPoolEvidence; nowMs?: number }
): PumpMarketState {
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) throw new Error("Invalid market observation time.");
  const now = new Date(nowMs).toISOString();

  if (input.pool) {
    const pool = input.pool;
    const poolValid = pool.verified === true && pool.canonical === true &&
      pool.mint === previous.mint && Boolean(pool.poolAddress.trim()) &&
      Boolean(pool.quoteMint.trim()) && validBaseUnits(pool.baseReserveBaseUnits) &&
      validBaseUnits(pool.rawQuoteVaultReserveBaseUnits) &&
      validSignedBaseUnits(pool.virtualQuoteReservesBaseUnits) &&
      BigInt(pool.rawQuoteVaultReserveBaseUnits) + BigInt(pool.virtualQuoteReservesBaseUnits) > 0n &&
      pool.quoteReserveBaseUnits === (BigInt(pool.rawQuoteVaultReserveBaseUnits) +
        BigInt(pool.virtualQuoteReservesBaseUnits)).toString() &&
      validBaseUnits(pool.quoteReserveBaseUnits) &&
      validBaseUnits(pool.creatorFeeBps, true) &&
      validBaseUnits(pool.protocolFeesBaseUnits, true) &&
      validBaseUnits(pool.creatorFeesBaseUnits, true) &&
      typeof pool.isMayhemMode === "boolean" && typeof pool.isCashbackCoin === "boolean" &&
      validSlot(pool.slot) &&
      validObservation(pool.observedAt, nowMs);
    if (!poolValid) {
      return { ...previous, status: "EXIT_BLOCKED", updatedAt: now, pool: null,
        reason: "Canonical PumpSwap pool evidence is missing, mismatched, stale or has no verified liquidity." };
    }
    return { ...previous, status: "MIGRATED_POOL_VERIFIED", updatedAt: now, pool,
      reason: "Canonical PumpSwap pool and non-zero reserves are verified. A fresh size-specific sell quote is still required before an exit." };
  }

  if (input.curve) {
    const curve = input.curve;
    const terminalCurve = curve.complete || curve.migrated;
    const curveValid = curve.verified === true && curve.mint === previous.mint &&
      Boolean(curve.curveAddress.trim()) && Boolean(curve.quoteMint.trim()) &&
      validBaseUnits(curve.tokenReserveBaseUnits, terminalCurve) &&
      validBaseUnits(curve.quoteReserveBaseUnits, terminalCurve) &&
      validBaseUnits(curve.virtualTokenReservesBaseUnits) &&
      validBaseUnits(curve.virtualQuoteReservesBaseUnits) &&
      validBaseUnits(curve.realQuoteReservesBaseUnits, terminalCurve) &&
      validBaseUnits(curve.tokenTotalSupplyBaseUnits) &&
      validBaseUnits(curve.creatorFeeBps, true) &&
      validBaseUnits(curve.creatorFeeBaseUnits, true) &&
      validBaseUnits(curve.protocolFeesBaseUnits, true) &&
      typeof curve.isMayhemMode === "boolean" && typeof curve.isCashbackCoin === "boolean" &&
      validSlot(curve.slot) &&
      validObservation(curve.observedAt, nowMs);
    if (!curveValid) {
      return { ...previous, status: "EXIT_BLOCKED", updatedAt: now, curve: null,
        reason: "Pump.fun curve evidence is missing, mismatched, stale or invalid." };
    }
    if (curve.migrated || curve.complete) {
      return { ...previous, status: "MIGRATION_PENDING", updatedAt: now, curve, pool: null,
        reason: "Curve is complete or migrated. Do not auto-sell; verify the canonical PumpSwap pool and its liquidity." };
    }
    return { ...previous, status: "LIVE_CURVE", updatedAt: now, curve, pool: null,
      reason: "Verified live bonding curve. A fresh size-specific executable sell quote is still required before an exit." };
  }

  return { ...previous, status: "EXIT_BLOCKED", updatedAt: now,
    reason: "No new authoritative market evidence was supplied; retain the position and retry verification." };
}

/** Market verification is necessary but never sufficient to authorize a simulated sell. */
export function canRequestPaperExitQuote(state: PumpMarketState): boolean {
  return state.status === "LIVE_CURVE" || state.status === "MIGRATED_POOL_VERIFIED";
}
