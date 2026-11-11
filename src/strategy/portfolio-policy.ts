export type PortfolioPolicy = {
  equityUsd: number;
  doublingSteps: number;
  stakePerPositionUsd: number;
  maxConcurrentPositions: number;
  nextCapacityThresholdUsd: number;
};

export type PortfolioPolicyOptions = {
  initialStakeUsd?: number;
  firstCapacityThresholdUsd?: number;
  maxStakeUsd?: number;
  hardMaxOpenPositions?: number;
};

export function calculatePortfolioPolicy(
  equityUsd: number,
  options: PortfolioPolicyOptions = {}
): PortfolioPolicy {
  const initialStakeUsd = options.initialStakeUsd ?? 1;
  const firstCapacityThresholdUsd = options.firstCapacityThresholdUsd ?? 5;
  const maxStakeUsd = options.maxStakeUsd ?? 100;
  const hardMaxOpenPositions = options.hardMaxOpenPositions ?? 50;

  if (![equityUsd, initialStakeUsd, firstCapacityThresholdUsd, maxStakeUsd].every(Number.isFinite)
      || equityUsd < 0 || initialStakeUsd <= 0 || firstCapacityThresholdUsd <= 0
      || maxStakeUsd < initialStakeUsd || !Number.isInteger(hardMaxOpenPositions)
      || hardMaxOpenPositions < 1) {
    throw new Error("Invalid portfolio policy inputs.");
  }

  let doublingSteps = 0;
  let stakePerPositionUsd = initialStakeUsd;
  let maxConcurrentPositions = 1;
  let nextCapacityThresholdUsd = firstCapacityThresholdUsd;

  while (equityUsd >= nextCapacityThresholdUsd && maxConcurrentPositions < hardMaxOpenPositions) {
    doublingSteps += 1;
    maxConcurrentPositions += 1;
    stakePerPositionUsd = Math.min(maxStakeUsd, stakePerPositionUsd * 1.5);
    nextCapacityThresholdUsd *= 2;
  }

  // Never allocate more principal than the current paper equity can support.
  maxConcurrentPositions = Math.min(
    maxConcurrentPositions,
    Math.floor(equityUsd / stakePerPositionUsd)
  );

  return {
    equityUsd,
    doublingSteps,
    stakePerPositionUsd,
    maxConcurrentPositions,
    nextCapacityThresholdUsd
  };
}
