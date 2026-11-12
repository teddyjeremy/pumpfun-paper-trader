export interface RawTradePrice {
  mint: string;
  quoteMint: string;
  quoteAmount: string;
  tokenAmount: string;
  timestamp: string;
  signature: string;
  isBuy: boolean;
  decisionPriceQuotePerToken?: number | null;
  decisionAt?: string | null;
  discoveryPriceQuotePerToken?: number | null;
}
export interface CandidatePriceTracker {
  sessionId?: string;
  mint: string;
  quoteMint: string;
  firstObservedAt: string;
  firstQuoteAmount: string;
  firstTokenAmount: string;
  firstSignature: string;
  decisionPriceQuotePerToken: number | null;
  decisionAt: string | null;
  decisionPeakQuoteAmount: string | null;
  decisionPeakTokenAmount: string | null;
  decisionPeakPriceQuotePerToken: number | null;
  decisionPeakObservedAt: string | null;
  decisionPeakSignature: string | null;
  discoveryPriceQuotePerToken: number | null;
  maxMultipleFromDecision: number | null;
  maxMultipleFromDiscovery: number | null;
  reached15xFromDecision: boolean;
  reached2xFromDecision: boolean;
  reached3xFromDecision: boolean;
  reached15xFromDiscovery: boolean;
  reached2xFromDiscovery: boolean;
  reached3xFromDiscovery: boolean;
  reached15xFromDecisionAt: string | null;
  reached2xFromDecisionAt: string | null;
  reached3xFromDecisionAt: string | null;
  reached15xFromDiscoveryAt: string | null;
  reached2xFromDiscoveryAt: string | null;
  reached3xFromDiscoveryAt: string | null;
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
  const peakPrice = Number(peakQuote) / Number(peakTokens);
  const decisionPrice = trade.decisionPriceQuotePerToken ?? previous?.decisionPriceQuotePerToken ?? null;
  const decisionAt = trade.decisionAt ?? previous?.decisionAt ?? null;
  const oldDecisionQuote = previous?.decisionPeakQuoteAmount ? BigInt(previous.decisionPeakQuoteAmount) : null;
  const oldDecisionTokens = previous?.decisionPeakTokenAmount ? BigInt(previous.decisionPeakTokenAmount) : null;
  const afterDecision = decisionAt !== null && Date.parse(trade.timestamp) >= Date.parse(decisionAt);
  const improvesDecisionPeak = afterDecision && (
    oldDecisionQuote === null || oldDecisionTokens === null ||
    quote * oldDecisionTokens > oldDecisionQuote * tokens
  );
  const decisionPeakQuote = improvesDecisionPeak ? quote : oldDecisionQuote;
  const decisionPeakTokens = improvesDecisionPeak ? tokens : oldDecisionTokens;
  const observedDecisionPeakPrice = decisionPeakQuote !== null && decisionPeakTokens !== null
    ? Number(decisionPeakQuote) / Number(decisionPeakTokens) : null;
  // The decision price itself is the initial 1.0x post-decision high-water mark.
  const decisionPeakPrice = decisionPrice !== null && decisionPrice > 0
    ? Math.max(decisionPrice, observedDecisionPeakPrice ?? 0) : observedDecisionPeakPrice;
  const discoveryPrice = trade.discoveryPriceQuotePerToken ?? previous?.discoveryPriceQuotePerToken ?? null;
  const decisionMultiple = decisionPrice !== null && decisionPrice > 0 && decisionPeakPrice !== null
    ? decisionPeakPrice / decisionPrice : null;
  const discoveryMultiple = discoveryPrice !== null && discoveryPrice > 0 ? peakPrice / discoveryPrice : null;
  const decisionPeakAt = improvesDecisionPeak ? trade.timestamp : previous?.decisionPeakObservedAt ?? null;
  const decision15 = decisionMultiple !== null && decisionMultiple >= 1.5;
  const decision2 = decisionMultiple !== null && decisionMultiple >= 2;
  const decision3 = decisionMultiple !== null && decisionMultiple >= 3;
  const discovery15 = discoveryMultiple !== null && discoveryMultiple >= 1.5;
  const discovery2 = discoveryMultiple !== null && discoveryMultiple >= 2;
  const discovery3 = discoveryMultiple !== null && discoveryMultiple >= 3;
  const discoveryPeakAt = isNewPeak ? trade.timestamp : previous?.peakObservedAt ?? trade.timestamp;
  return {
    mint: trade.mint, quoteMint: trade.quoteMint,
    firstObservedAt: previous?.firstObservedAt ?? trade.timestamp,
    firstQuoteAmount: baselineQuote.toString(), firstTokenAmount: baselineTokens.toString(),
    firstSignature: previous?.firstSignature ?? trade.signature,
    decisionPriceQuotePerToken: decisionPrice, decisionAt,
    decisionPeakQuoteAmount: decisionPeakQuote?.toString() ?? null,
    decisionPeakTokenAmount: decisionPeakTokens?.toString() ?? null,
    decisionPeakPriceQuotePerToken: decisionPeakPrice,
    decisionPeakObservedAt: decisionPeakPrice === decisionPrice ? decisionAt : decisionPeakAt,
    decisionPeakSignature: decisionPeakPrice === decisionPrice ? null : improvesDecisionPeak ? trade.signature : previous?.decisionPeakSignature ?? null,
    discoveryPriceQuotePerToken: discoveryPrice,
    maxMultipleFromDecision: decisionMultiple === null ? null : Math.round(decisionMultiple * 1e6) / 1e6,
    maxMultipleFromDiscovery: discoveryMultiple === null ? null : Math.round(discoveryMultiple * 1e6) / 1e6,
    reached15xFromDecision: decision15, reached2xFromDecision: decision2, reached3xFromDecision: decision3,
    reached15xFromDiscovery: discovery15, reached2xFromDiscovery: discovery2, reached3xFromDiscovery: discovery3,
    reached15xFromDecisionAt: decision15 ? previous?.reached15xFromDecisionAt ?? decisionPeakAt : null,
    reached2xFromDecisionAt: decision2 ? previous?.reached2xFromDecisionAt ?? decisionPeakAt : null,
    reached3xFromDecisionAt: decision3 ? previous?.reached3xFromDecisionAt ?? decisionPeakAt : null,
    reached15xFromDiscoveryAt: discovery15 ? previous?.reached15xFromDiscoveryAt ?? discoveryPeakAt : null,
    reached2xFromDiscoveryAt: discovery2 ? previous?.reached2xFromDiscoveryAt ?? discoveryPeakAt : null,
    reached3xFromDiscoveryAt: discovery3 ? previous?.reached3xFromDiscoveryAt ?? discoveryPeakAt : null,
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
