export interface CachedExecutableQuoteEvidence {
  status: string;
  validatedAt: string;
  result?: {
    status?: string;
    buyQuote?: { mint?: string; venue?: string; expiresAt?: string };
    initialSellQuote?: { mint?: string; venue?: string; expiresAt?: string };
    exactFeeEvidence?: { buy?: { status?: string }; sell?: { status?: string } };
    economics?: { roundTripCostPct?: number; meetsRoundTripCostLimit?: boolean };
  };
}

/**
 * Return the measured round-trip cost only while both quote legs and both
 * exact-message fee estimates are still valid. Missing, stale or mismatched
 * evidence never clears the strategy quote gate.
 */
export function getFreshExecutableQuoteCostPct(
  value: unknown,
  mint: string,
  nowMs = Date.now(),
  maxAgeMs = 2_000
): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Number.isFinite(nowMs) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) {
    return null;
  }
  const evidence = value as CachedExecutableQuoteEvidence;
  const validatedAt = Date.parse(evidence.validatedAt);
  const ageMs = nowMs - validatedAt;
  const result = evidence.result;
  const buy = result?.buyQuote;
  const sell = result?.initialSellQuote;
  const economics = result?.economics;
  if (evidence.status !== "QUOTES_VALIDATED" ||
      result?.status !== "QUOTES_VALIDATED" ||
      !Number.isFinite(validatedAt) || ageMs < 0 || ageMs > maxAgeMs ||
      buy?.mint !== mint || sell?.mint !== mint ||
      !buy.venue || buy.venue !== sell.venue ||
      !Number.isFinite(Date.parse(buy.expiresAt ?? "")) ||
      !Number.isFinite(Date.parse(sell.expiresAt ?? "")) ||
      Date.parse(buy.expiresAt ?? "") < nowMs ||
      Date.parse(sell.expiresAt ?? "") < nowMs ||
      result.exactFeeEvidence?.buy?.status !== "AVAILABLE" ||
      result.exactFeeEvidence?.sell?.status !== "AVAILABLE" ||
      !economics || typeof economics.roundTripCostPct !== "number" ||
      !Number.isFinite(economics.roundTripCostPct) ||
      economics.roundTripCostPct < 0) {
    return null;
  }
  return economics.roundTripCostPct;
}
