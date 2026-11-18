import type { ClosedTrade } from "./simulate-trade.js";

export interface EquityDoublingPolicy {
  startingEquityUsd: number;
  initialStakeUsd?: number;
  initialConcurrentPositions?: number;
  stakeIncreaseMultiplier?: number;
  maxStakeUsd?: number;
}

export interface EquityDoublingPortfolioResult {
  startingEquityUsd: number;
  endingEquityUsd: number;
  pnlUsd: number;
  taken: number;
  skippedConcurrency: number;
  skippedCapital: number;
  skippedDuplicateMint: number;
  /** Highest number of positions actually open at the same time. */
  maxConcurrentPositions: number;
  /** Highest slot capacity unlocked by equity doublings, whether all slots were used or not. */
  maxConcurrentSlots: number;
  highestDoublingLevel: number;
  largestStakeUsd: number;
  maxDrawdownPct: number;
  tradesPerDay: number;
}

/**
 * Historical portfolio simulation using realized-equity milestones.
 * Open positions keep their slots occupied until exit; mint entries are unique.
 * Stake and slot increases are based on the highest realized-equity doubling
 * achieved, so a drawdown cannot cause rapid sizing oscillation.
 */
export function simulateEquityDoublingPortfolio(
  trades: readonly ClosedTrade[],
  policy: EquityDoublingPolicy,
  rentUsd = 0
): EquityDoublingPortfolioResult {
  const startingEquity = policy.startingEquityUsd;
  const initialStake = policy.initialStakeUsd ?? 1;
  const initialSlots = policy.initialConcurrentPositions ?? 1;
  const multiplier = policy.stakeIncreaseMultiplier ?? 1.5;
  const maxStake = policy.maxStakeUsd ?? 100;
  if (!Number.isFinite(startingEquity) || startingEquity <= 0 ||
      !Number.isFinite(initialStake) || initialStake <= 0 ||
      !Number.isSafeInteger(initialSlots) || initialSlots < 1 ||
      !Number.isFinite(multiplier) || multiplier < 1 ||
      !Number.isFinite(maxStake) || maxStake < initialStake ||
      !Number.isFinite(rentUsd) || rentUsd < 0) {
    throw new Error("Invalid equity-doubling portfolio policy.");
  }

  const ordered = [...trades].sort((a, b) =>
    a.entryTime - b.entryTime || a.mint.localeCompare(b.mint));
  let cash = startingEquity;
  let realizedPnl = 0;
  let highWaterEquity = startingEquity;
  let highestDoublingLevel = 0;
  let largestStakeUsd = initialStake;
  let maxConcurrentPositions = 0;
  let maxConcurrentSlots = initialSlots;
  let maxDrawdownPct = 0;
  let taken = 0;
  let skippedConcurrency = 0;
  let skippedCapital = 0;
  let skippedDuplicateMint = 0;
  const seenMints = new Set<string>();
  const open: Array<{ mint: string; exitTime: number; stake: number; pnl: number }> = [];
  const days = new Set(ordered.map(trade =>
    new Date(trade.entryTime * 1_000).toISOString().slice(0, 10)));

  const equity = () => cash + open.reduce((sum, position) => sum + position.stake + rentUsd, 0);
  const updateGrowthLevel = () => {
    highWaterEquity = Math.max(highWaterEquity, equity());
    highestDoublingLevel = Math.max(highestDoublingLevel,
      Math.floor(Math.log2(highWaterEquity / startingEquity) + 1e-12));
    maxConcurrentSlots = Math.max(maxConcurrentSlots, initialSlots + highestDoublingLevel);
    largestStakeUsd = Math.max(largestStakeUsd,
      Math.min(maxStake, initialStake * multiplier ** highestDoublingLevel));
    if (highWaterEquity > 0) {
      maxDrawdownPct = Math.max(maxDrawdownPct,
        (highWaterEquity - equity()) / highWaterEquity * 100);
    }
  };
  const closeDue = (at: number) => {
    for (let index = open.length - 1; index >= 0; index -= 1) {
      const position = open[index]!;
      if (position.exitTime > at) continue;
      cash += position.stake + position.pnl + rentUsd;
      realizedPnl += position.pnl;
      open.splice(index, 1);
    }
    updateGrowthLevel();
  };

  for (const trade of ordered) {
    if (!trade.mint || !Number.isSafeInteger(trade.entryTime) ||
        !Number.isSafeInteger(trade.exitTime) || trade.exitTime < trade.entryTime ||
        !Number.isFinite(trade.stakeUsd) || trade.stakeUsd <= 0 ||
        !Number.isFinite(trade.pnlUsd)) continue;
    closeDue(trade.entryTime);
    if (seenMints.has(trade.mint)) {
      skippedDuplicateMint += 1;
      continue;
    }
    const stake = Math.min(maxStake, initialStake * multiplier ** highestDoublingLevel);
    const slots = initialSlots + highestDoublingLevel;
    if (open.length >= slots) {
      skippedConcurrency += 1;
      continue;
    }
    if (cash < stake + rentUsd) {
      skippedCapital += 1;
      continue;
    }
    const scaledPnl = trade.pnlUsd * (stake / trade.stakeUsd);
    cash -= stake + rentUsd;
    open.push({ mint: trade.mint, exitTime: trade.exitTime, stake, pnl: scaledPnl });
    maxConcurrentPositions = Math.max(maxConcurrentPositions, open.length);
    seenMints.add(trade.mint);
    taken += 1;
    updateGrowthLevel();
  }
  closeDue(Number.MAX_SAFE_INTEGER);
  updateGrowthLevel();
  return {
    startingEquityUsd: startingEquity,
    endingEquityUsd: cash,
    pnlUsd: realizedPnl,
    taken,
    skippedConcurrency,
    skippedCapital,
    skippedDuplicateMint,
    maxConcurrentPositions,
    maxConcurrentSlots,
    highestDoublingLevel,
    largestStakeUsd,
    maxDrawdownPct,
    tradesPerDay: taken / Math.max(1, days.size)
  };
}
