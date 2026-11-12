export interface RawTradePrice {
  mint: string;
  quoteMint: string;
  quoteAmount: string;
  tokenAmount: string;
  timestamp: string;
  signature: string;
  isBuy: boolean;
}
export interface CandidatePriceTracker {
  mint: string;
  quoteMint: string;
  firstObservedAt: string;
  firstQuoteAmount: string;
  firstTokenAmount: string;
  firstSignature: string;
  peakObservedAt: string;
  peakQuoteAmount: string;
  peakTokenAmount: string;
  peakSignature: string;
  observations: number;
  multipleFromFirstObserved: number;
  reached15x: boolean;
  reached2x: boolean;
  reached3x: boolean;
  baseline: "FIRST_OBSERVED_TRADE_NOT_DISCOVERY_OR_DECISION_PRICE";
  followUpStatus: "PARTIAL" | "MISSING";
}
export function updateCandidatePriceTracker(
  previous: CandidatePriceTracker | null,
  trade: RawTradePrice
): CandidatePriceTracker {
  const quote = BigInt(trade.quoteAmount);
  const tokens = BigInt(trade.tokenAmount);
  if (quote <= 0n || tokens <= 0n) throw new Error("Trade price requires positive quote and token amounts.");
  if (!Number.isFinite(Date.parse(trade.timestamp))) throw new Error("Invalid trade timestamp.");
  if (!trade.mint || !trade.quoteMint || !trade.signature) throw new Error("Trade price identity is incomplete.");
  if (previous && (previous.mint !== trade.mint || previous.quoteMint !== trade.quoteMint)) {
    throw new Error("Cannot compare prices across different mints or quote mints.");
  }
  const baselineQuote = previous ? BigInt(previous.firstQuoteAmount) : quote;
  const baselineTokens = previous ? BigInt(previous.firstTokenAmount) : tokens;
  const oldPeakQuote = previous ? BigInt(previous.peakQuoteAmount) : quote;
  const oldPeakTokens = previous ? BigInt(previous.peakTokenAmount) : tokens;
  const isNewPeak = quote * oldPeakTokens > oldPeakQuote * tokens;
  const peakQuote = isNewPeak ? quote : oldPeakQuote;
  const peakTokens = isNewPeak ? tokens : oldPeakTokens;
  const multiple = Number(peakQuote * baselineTokens) / Number(peakTokens * baselineQuote);
  return {
    mint: trade.mint, quoteMint: trade.quoteMint,
    firstObservedAt: previous?.firstObservedAt ?? trade.timestamp,
    firstQuoteAmount: baselineQuote.toString(), firstTokenAmount: baselineTokens.toString(),
    firstSignature: previous?.firstSignature ?? trade.signature,
    peakObservedAt: isNewPeak ? trade.timestamp : previous?.peakObservedAt ?? trade.timestamp,
    peakQuoteAmount: peakQuote.toString(), peakTokenAmount: peakTokens.toString(),
    peakSignature: isNewPeak ? trade.signature : previous?.peakSignature ?? trade.signature,
    observations: (previous?.observations ?? 0) + 1,
    multipleFromFirstObserved: Math.round(multiple * 1e6) / 1e6,
    reached15x: multiple >= 1.5, reached2x: multiple >= 2, reached3x: multiple >= 3,
    baseline: "FIRST_OBSERVED_TRADE_NOT_DISCOVERY_OR_DECISION_PRICE",
    followUpStatus: "PARTIAL"
  };
}
