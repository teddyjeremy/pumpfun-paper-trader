export interface PumpTradeFeeBps {
  protocol: number;
  creator: number;
  lp: number;
}

export interface PumpQuoteAmounts {
  /** Amount entering the pool/curve before trade fees. */
  grossQuoteIn: string;
  /** Quote amount used by the reserve curve after trade fees. */
  netQuoteIn: string;
  /** Gross quote output before trade fees. */
  grossQuoteOut: string;
  /** Quote amount received after trade fees. */
  netQuoteOut: string;
  tokenIn: string;
  tokenOut: string;
  fees: { protocol: string; creator: string; lp: string; total: string };
  priceImpactPct: number;
}

export interface PumpCurveQuoteState {
  virtualTokenReserves: string;
  virtualQuoteReserves: string;
  realTokenReserves: string;
  complete: boolean;
  fees: Pick<PumpTradeFeeBps, "protocol" | "creator">;
}

export interface PumpSwapQuoteState {
  baseVaultReserves: string;
  quoteVaultReserves: string;
  /** May be negative on current PumpSwap pools. */
  virtualQuoteReserves: string;
  /** Protocol and creator fees already booked in the quote vault. */
  protocolFeeBucketsBaseUnits: string;
  creatorFeeBucketsBaseUnits: string;
  fees: PumpTradeFeeBps;
}

const BPS = 10_000n;

function units(value: string, label: string, allowNegative = false): bigint {
  const pattern = allowNegative ? /^-?\d+$/ : /^\d+$/;
  if (!pattern.test(value)) throw new Error(`Invalid ${label} base units.`);
  return BigInt(value);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error("Invalid fee division.");
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function validateFees(fees: PumpTradeFeeBps): void {
  for (const [name, value] of Object.entries(fees)) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
      throw new Error(`Invalid ${name} fee basis points.`);
    }
  }
  if (fees.protocol + fees.creator + fees.lp > 10_000) {
    throw new Error("Combined Pump fees cannot exceed 100%.");
  }
}

function feeAmounts(amount: bigint, fees: PumpTradeFeeBps) {
  validateFees(fees);
  const protocol = ceilDiv(amount * BigInt(fees.protocol), BPS);
  const creator = ceilDiv(amount * BigInt(fees.creator), BPS);
  const lp = ceilDiv(amount * BigInt(fees.lp), BPS);
  return { protocol, creator, lp, total: protocol + creator + lp };
}

/**
 * Converts a gross quote-asset budget into the maximum reserve-curve input
 * after fees. The adjustment mirrors the on-chain rounding guard: separately
 * rounded fee components must never make the spend exceed the supplied budget.
 */
function quoteAfterFees(grossInput: bigint, fees: PumpTradeFeeBps): {
  net: bigint; charged: ReturnType<typeof feeAmounts>;
} {
  validateFees(fees);
  const totalBps = BigInt(fees.protocol + fees.creator + fees.lp);
  let net = grossInput * BPS / (BPS + totalBps);
  let charged = feeAmounts(net, fees);
  if (net + charged.total > grossInput) {
    net -= net + charged.total - grossInput;
    charged = feeAmounts(net, fees);
  }
  if (net <= 0n || net + charged.total > grossInput) {
    throw new Error("Quote budget is too small after fee rounding.");
  }
  return { net, charged };
}

function impactPct(executionPrice: number, spotPrice: number, side: "BUY" | "SELL"): number {
  if (!Number.isFinite(executionPrice) || !Number.isFinite(spotPrice) ||
      executionPrice <= 0 || spotPrice <= 0) {
    throw new Error("Quote price cannot be represented safely.");
  }
  const impact = side === "BUY"
    ? (executionPrice / spotPrice - 1) * 100
    : (1 - executionPrice / spotPrice) * 100;
  if (!Number.isFinite(impact)) throw new Error("Quote impact is invalid.");
  return Math.max(0, impact);
}

function result(input: {
  grossQuoteIn?: bigint;
  netQuoteIn?: bigint;
  grossQuoteOut?: bigint;
  netQuoteOut?: bigint;
  tokenIn?: bigint;
  tokenOut?: bigint;
  fees: { protocol: bigint; creator: bigint; lp: bigint; total: bigint };
  impact: number;
}): PumpQuoteAmounts {
  return {
    grossQuoteIn: (input.grossQuoteIn ?? 0n).toString(),
    netQuoteIn: (input.netQuoteIn ?? 0n).toString(),
    grossQuoteOut: (input.grossQuoteOut ?? 0n).toString(),
    netQuoteOut: (input.netQuoteOut ?? 0n).toString(),
    tokenIn: (input.tokenIn ?? 0n).toString(),
    tokenOut: (input.tokenOut ?? 0n).toString(),
    fees: {
      protocol: input.fees.protocol.toString(),
      creator: input.fees.creator.toString(),
      lp: input.fees.lp.toString(),
      total: input.fees.total.toString()
    },
    priceImpactPct: input.impact
  };
}

/** Exact-in SOL/quote-asset buy math for a live Pump bonding curve. */
export function quotePumpCurveBuy(input: {
  quoteInBaseUnits: string;
  state: PumpCurveQuoteState;
}): PumpQuoteAmounts {
  const budget = units(input.quoteInBaseUnits, "quote input");
  const virtualToken = units(input.state.virtualTokenReserves, "virtual token reserves");
  const virtualQuote = units(input.state.virtualQuoteReserves, "virtual quote reserves");
  const realToken = units(input.state.realTokenReserves, "real token reserves");
  if (input.state.complete) throw new Error("A completed bonding curve cannot be quoted.");
  if (budget <= 1n || virtualToken <= 0n || virtualQuote <= 0n || realToken <= 0n) {
    throw new Error("Bonding curve quote state or input is empty.");
  }
  const fees = { ...input.state.fees, lp: 0 };
  const afterFees = quoteAfterFees(budget, fees);
  // Pump's buyExactSolIn formula uses (net_quote - 1) to preserve its
  // integer-rounding invariant.
  const effectiveInput = afterFees.net - 1n;
  const tokenOut = effectiveInput * virtualToken / (virtualQuote + effectiveInput);
  if (tokenOut <= 0n || tokenOut > realToken) {
    throw new Error("Bonding curve buy exceeds available real token reserves.");
  }
  const spot = Number(virtualQuote) / Number(virtualToken);
  const execution = Number(afterFees.net) / Number(tokenOut);
  return result({
    grossQuoteIn: budget, netQuoteIn: afterFees.net, tokenOut,
    fees: afterFees.charged, impact: impactPct(execution, spot, "BUY")
  });
}

/** Exact-in token sell math for a live Pump bonding curve. */
export function quotePumpCurveSell(input: {
  tokenInBaseUnits: string;
  state: PumpCurveQuoteState;
}): PumpQuoteAmounts {
  const tokenIn = units(input.tokenInBaseUnits, "token input");
  const virtualToken = units(input.state.virtualTokenReserves, "virtual token reserves");
  const virtualQuote = units(input.state.virtualQuoteReserves, "virtual quote reserves");
  if (input.state.complete) throw new Error("A completed bonding curve cannot be quoted.");
  if (tokenIn <= 0n || virtualToken <= 0n || virtualQuote <= 0n) {
    throw new Error("Bonding curve quote state or input is empty.");
  }
  const grossQuoteOut = tokenIn * virtualQuote / (virtualToken + tokenIn);
  if (grossQuoteOut <= 0n) throw new Error("Bonding curve sell output rounds to zero.");
  const fees = feeAmounts(grossQuoteOut, { ...input.state.fees, lp: 0 });
  const netQuoteOut = grossQuoteOut - fees.total;
  if (netQuoteOut <= 0n) throw new Error("Bonding curve sell proceeds are consumed by fees.");
  const spot = Number(virtualQuote) / Number(virtualToken);
  const execution = Number(grossQuoteOut) / Number(tokenIn);
  return result({
    tokenIn, grossQuoteOut, netQuoteOut, fees,
    impact: impactPct(execution, spot, "SELL")
  });
}

/** Exact-in quote-asset buy math for a PumpSwap pool. */
export function quotePumpSwapBuy(input: {
  quoteInBaseUnits: string;
  state: PumpSwapQuoteState;
}): PumpQuoteAmounts {
  const budget = units(input.quoteInBaseUnits, "quote input");
  const base = units(input.state.baseVaultReserves, "base vault reserves");
  const quoteVault = units(input.state.quoteVaultReserves, "quote vault reserves");
  const virtualQuote = units(input.state.virtualQuoteReserves, "virtual quote reserves", true);
  const effectiveQuote = quoteVault + virtualQuote;
  if (budget <= 1n || base <= 0n || effectiveQuote <= 0n) {
    throw new Error("PumpSwap quote state or input is empty.");
  }
  const afterFees = quoteAfterFees(budget, input.state.fees);
  const tokenOut = base * afterFees.net / (effectiveQuote + afterFees.net);
  if (tokenOut <= 0n || tokenOut >= base) throw new Error("PumpSwap buy output is outside pool reserves.");
  const spot = Number(effectiveQuote) / Number(base);
  const execution = Number(afterFees.net) / Number(tokenOut);
  return result({
    grossQuoteIn: budget, netQuoteIn: afterFees.net, tokenOut,
    fees: afterFees.charged, impact: impactPct(execution, spot, "BUY")
  });
}

/** Exact-in token sell math for a PumpSwap pool. */
export function quotePumpSwapSell(input: {
  tokenInBaseUnits: string;
  state: PumpSwapQuoteState;
}): PumpQuoteAmounts {
  const tokenIn = units(input.tokenInBaseUnits, "token input");
  const base = units(input.state.baseVaultReserves, "base vault reserves");
  const quoteVault = units(input.state.quoteVaultReserves, "quote vault reserves");
  const virtualQuote = units(input.state.virtualQuoteReserves, "virtual quote reserves", true);
  const protocolFeeBuckets = units(input.state.protocolFeeBucketsBaseUnits, "protocol fee buckets");
  const creatorFeeBuckets = units(input.state.creatorFeeBucketsBaseUnits, "creator fee buckets");
  const feeBucketsTotal = protocolFeeBuckets + creatorFeeBuckets;
  const effectiveQuote = quoteVault + virtualQuote;
  const spendableQuoteVault = quoteVault - feeBucketsTotal;
  if (tokenIn <= 0n || base <= 0n || effectiveQuote <= 0n || spendableQuoteVault <= 0n) {
    throw new Error("PumpSwap quote state or input is empty.");
  }
  const grossQuoteOut = effectiveQuote * tokenIn / (base + tokenIn);
  if (grossQuoteOut <= 0n) throw new Error("PumpSwap sell output rounds to zero.");
  if (grossQuoteOut > spendableQuoteVault) {
    throw new Error("PumpSwap sell exceeds quote-vault liquidity after reserved fee buckets.");
  }
  const fees = feeAmounts(grossQuoteOut, input.state.fees);
  const netQuoteOut = grossQuoteOut - fees.total;
  if (netQuoteOut <= 0n) throw new Error("PumpSwap sell proceeds are consumed by fees.");
  const spot = Number(effectiveQuote) / Number(base);
  const execution = Number(grossQuoteOut) / Number(tokenIn);
  return result({
    tokenIn, grossQuoteOut, netQuoteOut, fees,
    impact: impactPct(execution, spot, "SELL")
  });
}
