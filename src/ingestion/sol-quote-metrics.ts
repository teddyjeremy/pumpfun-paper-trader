import { isSolQuoteMint } from "./trade-flow.js";

export interface SolQuoteMetricInput {
  quoteMint: string;
  quoteAmount?: string | bigint;
  solAmount?: string | bigint;
  virtualQuoteReserves?: string | bigint;
  virtualSolReserves?: string | bigint;
  virtualTokenReserves: string | bigint;
  realQuoteReserves?: string | bigint;
  realSolReserves?: string | bigint;
}

export interface SolQuoteMetrics {
  sol: number;
  price: number | null;
  liquidity: number;
}

/** Convert a Pump TradeEvent's quote-side amounts and reserves into SOL units. */
export function getSolQuoteMetrics(event: SolQuoteMetricInput): SolQuoteMetrics | null {
  if (!isSolQuoteMint(event.quoteMint)) return null;

  const quoteAmount = BigInt(event.quoteAmount ?? "0");
  const legacyAmount = BigInt(event.solAmount ?? "0");
  const virtualQuoteReserves = BigInt(event.virtualQuoteReserves ?? "0");
  const virtualSolReserves = BigInt(event.virtualSolReserves ?? "0");
  const virtualTokenReserves = BigInt(event.virtualTokenReserves);
  const realQuoteReserves = BigInt(event.realQuoteReserves ?? "0");
  const realSolReserves = BigInt(event.realSolReserves ?? "0");

  const amount = quoteAmount > 0n ? quoteAmount : legacyAmount;
  const quoteReserves = virtualQuoteReserves > 0n ? virtualQuoteReserves : virtualSolReserves;
  const realReserves = realQuoteReserves > 0n ? realQuoteReserves : realSolReserves;

  return {
    sol: Number(amount) / 1_000_000_000,
    price: virtualTokenReserves > 0n ? Number(quoteReserves) / Number(virtualTokenReserves) : null,
    liquidity: Number(realReserves) / 1_000_000_000
  };
}
