/**
 * Costs measured on 2026-11-14 from public Solana RPC and the pump fee config.
 * Bonding-curve and low-mcap PumpSwap schedules were both 125 bps per side
 * (95 protocol + 30 creator on the curve; 2 lp + 93 protocol + 30 creator on PumpSwap).
 * Landed pump transaction fees in sampled blocks: median 5,000 lamports, p75 15,000.
 */
export interface CostAssumptions {
  solUsd: number;
  /** Protocol + creator + lp, per side. */
  venueFeeBps: number;
  /** Extra per side for crossing a 1-minute print. Impact is added when reserve is known. */
  slippageFloorBps: number;
  /** Base plus priority, per signature. The p75 of observed pump transaction fees. */
  feeLamportsPerTx: number;
  rentLamports: number;
}

export const MEASURED_COSTS: CostAssumptions = Object.freeze({
  solUsd: 74.11,
  venueFeeBps: 125,
  slippageFloorBps: 30,
  feeLamportsPerTx: 15_000,
  rentLamports: 1_488_440
});

export interface TradeCost {
  variableBpsPerSide: number;
  roundTripVariablePct: number;
  fixedUsd: number;
  rentUsd: number;
}

export function tradeCost(stakeUsd: number, reserveUsd: number | null, cost: CostAssumptions = MEASURED_COSTS): TradeCost {
  const impactBps = reserveUsd !== null && reserveUsd > 0
    ? Math.min(250, (stakeUsd / reserveUsd) * 10_000)
    : 0;
  const variableBpsPerSide = cost.venueFeeBps + Math.max(cost.slippageFloorBps, impactBps);
  const fixedUsd = 2 * cost.feeLamportsPerTx / 1e9 * cost.solUsd;
  const rentUsd = cost.rentLamports / 1e9 * cost.solUsd;
  return {
    variableBpsPerSide,
    roundTripVariablePct: (1 - (1 - variableBpsPerSide / 10_000) ** 2) * 100,
    fixedUsd,
    rentUsd
  };
}

/** Net USD pnl for a round trip that actually sells. Rent is returned when the token account closes. */
export function roundTripPnlUsd(input: {
  stakeUsd: number;
  entryPrice: number;
  exitPrice: number;
  reserveUsd?: number | null;
  cost?: CostAssumptions;
}): number {
  const cost = input.cost ?? MEASURED_COSTS;
  const reserve = input.reserveUsd === undefined ? null : input.reserveUsd;
  const fees = tradeCost(input.stakeUsd, reserve, cost);
  const side = 1 - fees.variableBpsPerSide / 10_000;
  const proceeds = input.stakeUsd * (input.exitPrice / input.entryPrice) * side * side;
  return proceeds - input.stakeUsd - fees.fixedUsd;
}

/** Buy landed, sell never could. Stake, the buy signature, and unrecovered rent are gone. */
export function failedSellPnlUsd(stakeUsd: number, cost: CostAssumptions = MEASURED_COSTS): number {
  const fees = tradeCost(stakeUsd, null, cost);
  return -(stakeUsd + fees.fixedUsd / 2 + fees.rentUsd);
}
