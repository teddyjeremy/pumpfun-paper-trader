import { describe, expect, it } from "vitest";
import { calculatePortfolioPolicy } from "../src/strategy/portfolio-policy.js";

describe("portfolio doubling policy", () => {
  it("starts with one $1 position at $2.70", () => {
    const policy = calculatePortfolioPolicy(2.7);
    expect(policy.maxConcurrentPositions).toBe(1);
    expect(policy.stakePerPositionUsd).toBe(1);
  });

  it("adds a second position and increases stake by 50% at $5", () => {
    const policy = calculatePortfolioPolicy(5);
    expect(policy.maxConcurrentPositions).toBe(2);
    expect(policy.stakePerPositionUsd).toBe(1.5);
  });

  it("adds a third position and increases stake again at $10", () => {
    const policy = calculatePortfolioPolicy(10);
    expect(policy.maxConcurrentPositions).toBe(3);
    expect(policy.stakePerPositionUsd).toBe(2.25);
  });

  it("caps stake at $100 and never allocates beyond equity", () => {
    const policy = calculatePortfolioPolicy(100_000);
    expect(policy.stakePerPositionUsd).toBe(100);
    expect(policy.maxConcurrentPositions * policy.stakePerPositionUsd).toBeLessThanOrEqual(100_000);
  });

  it("does not open a position if equity cannot fund the initial stake", () => {
    const policy = calculatePortfolioPolicy(0.5);
    expect(policy.maxConcurrentPositions).toBe(0);
  });
});
