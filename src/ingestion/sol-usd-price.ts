export interface SolUsdPriceObservation {
  source: "binance-spot";
  symbol: "SOLUSDT";
  priceUsd: number;
  observedAt: string;
  ageMs: number;
}

export type SolUsdPriceResult =
  | { status: "AVAILABLE"; observation: SolUsdPriceObservation }
  | { status: "UNAVAILABLE"; reason: string };

/**
 * Fetches a public SOL/USDT last-trade price for USD-notional filtering only.
 * It is not an execution quote and must never be used to estimate a fill.
 */
export async function fetchSolUsdPrice(input: {
  fetcher?: typeof fetch;
  nowMs?: number;
  maxAgeMs?: number;
} = {}): Promise<SolUsdPriceResult> {
  const fetcher = input.fetcher ?? fetch;
  const nowMs = input.nowMs ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? 10_000;
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return { status: "UNAVAILABLE", reason: "Invalid SOL/USD freshness configuration." };
  }
  let response: Response;
  try {
    response = await fetcher(
      "https://data-api.binance.vision/api/v3/ticker/24hr?symbol=SOLUSDT",
      { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(3_000) }
    );
  } catch {
    return { status: "UNAVAILABLE", reason: "SOL/USD provider request failed." };
  }
  if (!response.ok) return { status: "UNAVAILABLE", reason: `SOL/USD provider HTTP status ${response.status}.` };
  let payload: unknown;
  try { payload = await response.json(); }
  catch { return { status: "UNAVAILABLE", reason: "SOL/USD provider returned invalid JSON." }; }
  if (!payload || typeof payload !== "object") {
    return { status: "UNAVAILABLE", reason: "SOL/USD provider response is malformed." };
  }
  const data = payload as Record<string, unknown>;
  const priceUsd = typeof data.lastPrice === "string" ? Number(data.lastPrice) : Number.NaN;
  const closeTime = data.closeTime;
  if (data.symbol !== "SOLUSDT" || !Number.isFinite(priceUsd) || priceUsd <= 0 ||
      !Number.isSafeInteger(closeTime) || (closeTime as number) <= 0) {
    return { status: "UNAVAILABLE", reason: "SOL/USD provider response failed validation." };
  }
  const ageMs = nowMs - (closeTime as number);
  if (ageMs < -2_000 || ageMs > maxAgeMs) {
    return { status: "UNAVAILABLE", reason: "SOL/USD last trade is stale or has an invalid future timestamp." };
  }
  return {
    status: "AVAILABLE",
    observation: {
      source: "binance-spot",
      symbol: "SOLUSDT",
      priceUsd,
      observedAt: new Date(closeTime as number).toISOString(),
      ageMs: Math.max(0, ageMs)
    }
  };
}
