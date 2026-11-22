/**
 * Parse the operator-reviewed provider charge applied to each simulated
 * transaction. Missing or non-decimal values are unknown, never an implicit
 * zero. An explicit "0" is valid when the operator has confirmed no charge.
 */
export function parseProviderFeeUsdPerTransaction(raw: string | undefined): number | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}
