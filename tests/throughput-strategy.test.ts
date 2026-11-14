import { describe, expect, it } from "vitest";
import { failedSellPnlUsd, roundTripPnlUsd, MEASURED_COSTS } from "../src/strategy/cost-model.js";
import { evaluateRugFilters, parseRugCsv, rugFromHeliusAsset, DEFAULT_RUG_THRESHOLDS } from "../src/strategy/rug-signals.js";
import {
  simulateFromEntry, simulatePortfolio, tryTrade, type Bar, type EntryRule, type PathCoin
} from "../src/strategy/simulate-trade.js";

function bar(t: number, price: number, volume = 100): Bar {
  return { t, o: price, h: price, l: price, c: price, v: volume };
}

function coin(candles: Bar[], patch: Partial<PathCoin> = {}): PathCoin {
  return {
    mint: "Mint111111111111111111111111111111111111pump",
    createdAt: candles[0]!.t,
    dex: "pump-fun",
    creator: "Creator",
    creatorHoldPct: 0.2,
    creatorSoldInSlot: false,
    sameSlotBuyers: 4,
    sameSlotTopShare: 0.3,
    sameSlotWallets: [],
    candles,
    trades: [],
    graduated: null,
    ...patch
  };
}

const launchEntry: EntryRule = {
  family: "launch",
  delayMinutes: 1,
  minVolumeUsd: 0,
  maxDropPct: 0.5,
  lookbackMinutes: 3,
  minReturnPct: 0.2,
  maxChasePct: 2,
  copyMinWallets: 2,
  copyWindowSeconds: 60,
  copyWallets: []
};

describe("round trip costs", () => {
  it("charges the measured 1.25% venue fee per side and keeps a stop from wiping the position", () => {
    const pnl = roundTripPnlUsd({ stakeUsd: 1, entryPrice: 1, exitPrice: 0.95 });
    const flat = roundTripPnlUsd({ stakeUsd: 1, entryPrice: 1, exitPrice: 1 });
    expect(flat).toBeLessThan(0);
    expect(pnl).toBeLessThan(flat);
    expect(pnl).toBeGreaterThan(-0.2);
    expect(failedSellPnlUsd(1)).toBeLessThan(-1);
  });
});

describe("exits", () => {
  it("stops out near -5% instead of riding the coin to zero", () => {
    const start = 1_700_000_000;
    const candles = [bar(start, 1), bar(start + 60, 1), bar(start + 120, 0.2, 50)];
    candles[2] = { t: start + 120, o: 0.96, h: 0.96, l: 0.2, c: 0.2, v: 50 };
    const trade = tryTrade({
      coin: coin(candles),
      entry: launchEntry,
      exit: { stopLossPct: 0.05, takeProfitPct: 0.4, trailActivatePct: 0.2, trailDistancePct: 0.1, maxHoldMinutes: 30 },
      rug: DEFAULT_RUG_THRESHOLDS,
      stakeUsd: 0.4
    });
    expect(trade?.exitReason).toBe("stop");
    expect(trade!.returnPct).toBeLessThan(-5);
    expect(trade!.returnPct).toBeGreaterThan(-25);
    expect(trade!.pnlUsd).toBeGreaterThan(-0.4);
  });

  it("takes profit and trails without giving the whole move back", () => {
    const start = 1_700_000_000;
    const candles = [
      bar(start, 1),
      bar(start + 60, 1),
      bar(start + 120, 1.12),
      bar(start + 180, 1.05)
    ];
    candles[2] = { t: start + 120, o: 1.01, h: 1.12, l: 1.01, c: 1.12, v: 80 };
    candles[3] = { t: start + 180, o: 1.1, h: 1.11, l: 1.0, c: 1.02, v: 40 };
    const trade = simulateFromEntry({
      coin: coin(candles),
      bars: candles,
      index: 1,
      exit: { stopLossPct: 0.05, takeProfitPct: 0.1, trailActivatePct: 0.2, trailDistancePct: 0.1, maxHoldMinutes: 30 },
      stakeUsd: 0.4,
      family: "launch"
    });
    expect(trade?.exitReason).toBe("take_profit");
    expect(trade!.pnlUsd).toBeGreaterThan(0);
  });
});

describe("rug filters", () => {
  it("rejects creator dumps and accepts a clean launch", () => {
    const clean = evaluateRugFilters({
      creatorHoldPct: 0.4, creatorSoldInSlot: false, sameSlotBuyers: 3, sameSlotTopShare: 0.4, graduated: false
    }, null, DEFAULT_RUG_THRESHOLDS);
    const dumped = evaluateRugFilters({
      creatorHoldPct: 0.4, creatorSoldInSlot: true, sameSlotBuyers: 3, sameSlotTopShare: 0.4, graduated: false
    }, null, DEFAULT_RUG_THRESHOLDS);
    expect(clean.ok).toBe(true);
    expect(dumped.ok).toBe(false);
  });

  it("plugs CSV and Helius fields without treating blanks as failures", () => {
    const csv = parseRugCsv("mint,honeypot,dev_holding_pct,outcome\nMintA,true,1,rug\nMintB,,,\n");
    expect(csv.get("MintA")?.honeypot).toBe(true);
    expect(csv.get("MintB")?.honeypot).toBeUndefined();
    const decision = evaluateRugFilters({
      creatorHoldPct: 0, creatorSoldInSlot: false, sameSlotBuyers: 2, sameSlotTopShare: 0.2, graduated: false
    }, csv.get("MintA") ?? null, DEFAULT_RUG_THRESHOLDS);
    expect(decision.reasons).toContain("honeypot");
    expect(rugFromHeliusAsset({ id: "MintC", token_info: { mint_authority: null, freeze_authority: "Freeze" } }))
      .toMatchObject({ mint: "MintC", mintAuthorityRevoked: true, freezeAuthorityRevoked: false });
  });
});

describe("portfolio kill switch", () => {
  it("stops new entries after a 20% daily drawdown", () => {
    const start = 1_700_000_000;
    const losses = Array.from({ length: 8 }, (_, index) => ({
      mint: `m${index}`,
      family: "launch",
      entryTime: start + index * 60,
      exitTime: start + index * 60 + 30,
      entryPrice: 1,
      exitPrice: 0.95,
      stakeUsd: 0.5,
      pnlUsd: -0.2,
      returnPct: -40,
      holdMinutes: 0.5,
      exitReason: "stop" as const,
      win: false
    }));
    const result = simulatePortfolio(losses, {
      startingEquityUsd: 2.4,
      stakeUsd: 0.5,
      maxConcurrent: 3,
      dailyDrawdownKillPct: 20
    }, 0.11);
    expect(result.taken).toBeLessThan(losses.length);
    expect(result.killedDays).toBe(1);
    expect(result.endingEquityUsd).toBeGreaterThan(0);
  });
});

describe("measured fee identity", () => {
  it("uses the on-chain 125 bps schedule and the p75 landed fee", () => {
    expect(MEASURED_COSTS.venueFeeBps).toBe(125);
    expect(MEASURED_COSTS.feeLamportsPerTx).toBe(15_000);
    expect(MEASURED_COSTS.rentLamports).toBe(1_488_440);
  });
});
