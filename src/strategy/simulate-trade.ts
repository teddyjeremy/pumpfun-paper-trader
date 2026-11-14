import { roundTripPnlUsd, type CostAssumptions, MEASURED_COSTS } from "./cost-model.js";
import {
  evaluateRugFilters, type LaunchRugEvidence, type RugSignal, type RugThresholds, DEFAULT_RUG_THRESHOLDS
} from "./rug-signals.js";

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface TapeTrade {
  t: number;
  side: "buy" | "sell";
  usd: number;
  wallet: string;
  price: number;
}

export interface PathCoin {
  mint: string;
  createdAt: number;
  dex: string;
  creator: string;
  creatorHoldPct: number;
  creatorSoldInSlot: boolean;
  sameSlotBuyers: number;
  sameSlotTopShare: number | null;
  sameSlotWallets: Array<{ wallet: string; sol: number }>;
  candles: Bar[];
  trades: TapeTrade[];
  graduated: null | { dex: string; createdAt: number; candles: Bar[] };
}

export interface ExitRule {
  stopLossPct: number;
  takeProfitPct: number;
  trailActivatePct: number;
  trailDistancePct: number;
  maxHoldMinutes: number;
}

export interface EntryRule {
  family: "launch" | "momentum" | "graduation" | "copy";
  delayMinutes: number;
  minVolumeUsd: number;
  maxDropPct: number;
  lookbackMinutes: number;
  minReturnPct: number;
  maxChasePct: number;
  copyMinWallets: number;
  copyWindowSeconds: number;
  copyWallets: string[];
}

export interface ClosedTrade {
  mint: string;
  family: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  stakeUsd: number;
  pnlUsd: number;
  returnPct: number;
  holdMinutes: number;
  exitReason: "stop" | "trail" | "take_profit" | "max_hold" | "data_end" | "unsellable";
  win: boolean;
}

export function barsFromRows(rows: number[][]): Bar[] {
  return rows.filter(row => row.length >= 6).map(row => ({
    t: Number(row[0]), o: Number(row[1]), h: Number(row[2]),
    l: Number(row[3]), c: Number(row[4]), v: Number(row[5])
  })).filter(bar => bar.c > 0 && bar.h > 0 && bar.l > 0 && bar.o > 0 && Number.isFinite(bar.t));
}

export function closeTime(bar: Bar): number {
  return bar.t + 60;
}

function tradableBars(candles: Bar[], createdAt: number): Bar[] {
  return candles.filter(bar => closeTime(bar) > createdAt);
}

export function launchEvidence(coin: PathCoin, graduated: boolean): LaunchRugEvidence {
  return {
    creatorHoldPct: coin.creatorHoldPct,
    creatorSoldInSlot: coin.creatorSoldInSlot,
    sameSlotBuyers: coin.sameSlotBuyers,
    sameSlotTopShare: coin.sameSlotTopShare,
    graduated
  };
}

export function findLaunchEntry(coin: PathCoin, rule: EntryRule): { index: number; bars: Bar[] } | null {
  const bars = tradableBars(coin.candles, coin.createdAt);
  const readyAt = coin.createdAt + rule.delayMinutes * 60;
  const index = bars.findIndex(bar => closeTime(bar) >= readyAt);
  if (index < 0) return null;
  const entry = bars[index]!;
  const seen = bars.slice(0, index + 1);
  const volume = seen.reduce((sum, bar) => sum + bar.v, 0);
  const first = seen[0]!;
  const drop = first.o > 0 ? (entry.c / first.o) - 1 : 0;
  if (volume < rule.minVolumeUsd) return null;
  if (drop < -rule.maxDropPct) return null;
  return { index, bars };
}

export function findMomentumEntry(coin: PathCoin, rule: EntryRule): { index: number; bars: Bar[] } | null {
  const bars = tradableBars(coin.candles, coin.createdAt);
  const lookback = Math.max(1, rule.lookbackMinutes);
  if (bars.length <= lookback) return null;
  const firstClose = bars[0]!.c;
  for (let index = lookback; index < bars.length; index += 1) {
    const entry = bars[index]!;
    const past = bars[index - lookback]!;
    const ret = past.c > 0 ? (entry.c / past.c) - 1 : 0;
    let volume = 0;
    for (let cursor = index - lookback + 1; cursor <= index; cursor += 1) volume += bars[cursor]!.v;
    const chase = firstClose > 0 ? (entry.c / firstClose) - 1 : 0;
    if (ret >= rule.minReturnPct && volume >= rule.minVolumeUsd && chase <= rule.maxChasePct) {
      return { index, bars };
    }
  }
  return null;
}

export function findGraduationEntry(coin: PathCoin, rule: EntryRule): { index: number; bars: Bar[] } | null {
  if (!coin.graduated || coin.graduated.candles.length === 0) return null;
  const pseudo: PathCoin = { ...coin, createdAt: coin.graduated.createdAt, candles: coin.graduated.candles, dex: coin.graduated.dex };
  return findLaunchEntry(pseudo, rule);
}

export function findCopyEntry(coin: PathCoin, rule: EntryRule): { index: number; bars: Bar[] } | null {
  if (rule.copyWallets.length < rule.copyMinWallets) return null;
  const wanted = new Set(rule.copyWallets);
  const bars = tradableBars(coin.candles, coin.createdAt);
  if (bars.length === 0) return null;
  const unique: Array<{ t: number; wallet: string }> = [];
  const seen = new Set<string>();
  for (const trade of [...coin.trades].sort((a, b) => a.t - b.t)) {
    if (trade.side !== "buy" || !wanted.has(trade.wallet) || seen.has(trade.wallet)) continue;
    if (trade.t < coin.createdAt) continue;
    seen.add(trade.wallet);
    unique.push({ t: trade.t, wallet: trade.wallet });
  }
  for (let i = 0; i < unique.length; i += 1) {
    const start = unique[i]!.t;
    const cluster = unique.filter(hit => hit.t >= start && hit.t - start <= rule.copyWindowSeconds);
    if (cluster.length < rule.copyMinWallets) continue;
    const readyAt = cluster[rule.copyMinWallets - 1]!.t;
    const index = bars.findIndex(bar => closeTime(bar) >= readyAt);
    if (index < 0 || index >= bars.length - 1) continue;
    return { index, bars };
  }
  return null;
}

export interface OpenPaperPosition {
  mint: string;
  pool: string;
  entryTime: number;
  entryPrice: number;
  stop: number;
  high: number;
  hardStop: number;
  deadline: number;
  stakeUsd: number;
}

/** One new closed bar against an open paper position. Does not look ahead. */
export function advancePaperPosition(input: {
  position: OpenPaperPosition;
  bar: Bar;
  exit: ExitRule;
  cost?: CostAssumptions;
}): { position: OpenPaperPosition; closed: ClosedTrade | null } {
  const cost = input.cost ?? MEASURED_COSTS;
  const position = { ...input.position };
  let exitPrice: number | null = null;
  let exitReason: ClosedTrade["exitReason"] | null = null;
  if (input.bar.l <= position.stop) {
    exitPrice = Math.min(input.bar.o, position.stop);
    exitReason = position.stop > position.hardStop * 1.0000001 ? "trail" : "stop";
  } else if (input.bar.h >= position.entryPrice * (1 + input.exit.takeProfitPct)) {
    exitPrice = position.entryPrice * (1 + input.exit.takeProfitPct);
    exitReason = "take_profit";
  } else {
    position.high = Math.max(position.high, input.bar.h);
    if ((position.high / position.entryPrice) - 1 >= input.exit.trailActivatePct) {
      position.stop = Math.max(position.stop, position.high * (1 - input.exit.trailDistancePct));
    }
    if (closeTime(input.bar) >= position.deadline) {
      exitPrice = input.bar.c;
      exitReason = "max_hold";
    }
  }
  if (exitPrice === null || exitReason === null) return { position, closed: null };
  const pnlUsd = roundTripPnlUsd({
    stakeUsd: position.stakeUsd,
    entryPrice: position.entryPrice,
    exitPrice: Math.max(exitPrice, 1e-12),
    reserveUsd: null,
    cost
  });
  return {
    position,
    closed: {
      mint: position.mint,
      family: "paper",
      entryTime: position.entryTime,
      exitTime: input.bar.t,
      entryPrice: position.entryPrice,
      exitPrice,
      stakeUsd: position.stakeUsd,
      pnlUsd,
      returnPct: pnlUsd / position.stakeUsd * 100,
      holdMinutes: Math.max(0, (input.bar.t - position.entryTime) / 60),
      exitReason,
      win: pnlUsd > 0
    }
  };
}

export function locateEntry(coin: PathCoin, rule: EntryRule): { index: number; bars: Bar[] } | null {
  if (rule.family === "launch") return findLaunchEntry(coin, rule);
  if (rule.family === "momentum") return findMomentumEntry(coin, rule);
  if (rule.family === "graduation") return findGraduationEntry(coin, rule);
  return findCopyEntry(coin, rule);
}

export function simulateFromEntry(input: {
  coin: PathCoin;
  bars: Bar[];
  index: number;
  exit: ExitRule;
  stakeUsd: number;
  family: string;
  cost?: CostAssumptions;
}): ClosedTrade | null {
  const cost = input.cost ?? MEASURED_COSTS;
  const entryBar = input.bars[input.index];
  if (!entryBar || entryBar.c <= 0 || input.index >= input.bars.length - 1) return null;
  const entryPrice = entryBar.c;
  const entryTime = closeTime(entryBar);
  const hardStop = entryPrice * (1 - input.exit.stopLossPct);
  let stop = hardStop;
  const target = entryPrice * (1 + input.exit.takeProfitPct);
  let high = entryPrice;
  const deadline = entryTime + input.exit.maxHoldMinutes * 60;
  let exitPrice = entryBar.c;
  let exitTime = entryTime;
  let exitReason: ClosedTrade["exitReason"] = "data_end";

  for (let cursor = input.index + 1; cursor < input.bars.length; cursor += 1) {
    const bar = input.bars[cursor]!;
    if (bar.l <= stop) {
      exitPrice = Math.min(bar.o, stop);
      exitTime = bar.t;
      exitReason = stop > hardStop * 1.0000001 ? "trail" : "stop";
      break;
    }
    if (bar.h >= target) {
      exitPrice = target;
      exitTime = bar.t;
      exitReason = "take_profit";
      break;
    }
    high = Math.max(high, bar.h);
    if ((high / entryPrice) - 1 >= input.exit.trailActivatePct) {
      stop = Math.max(stop, high * (1 - input.exit.trailDistancePct));
    }
    exitPrice = bar.c;
    exitTime = closeTime(bar);
    exitReason = "data_end";
    if (closeTime(bar) >= deadline) {
      exitReason = "max_hold";
      break;
    }
  }

  const pnlUsd = roundTripPnlUsd({
    stakeUsd: input.stakeUsd,
    entryPrice,
    exitPrice: Math.max(exitPrice, 1e-12),
    reserveUsd: null,
    cost
  });
  const reason = exitReason;
  return {
    mint: input.coin.mint,
    family: input.family,
    entryTime,
    exitTime,
    entryPrice,
    exitPrice,
    stakeUsd: input.stakeUsd,
    pnlUsd,
    returnPct: pnlUsd / input.stakeUsd * 100,
    holdMinutes: Math.max(0, (exitTime - entryTime) / 60),
    exitReason: reason,
    win: pnlUsd > 0
  };
}

export function tryTrade(input: {
  coin: PathCoin;
  entry: EntryRule;
  exit: ExitRule;
  rug: RugThresholds;
  signal?: RugSignal | null;
  stakeUsd: number;
  cost?: CostAssumptions;
}): ClosedTrade | null {
  const graduated = input.entry.family === "graduation";
  const rug = evaluateRugFilters(launchEvidence(input.coin, graduated), input.signal ?? null, input.rug);
  if (!rug.ok) return null;
  const located = locateEntry(input.coin, input.entry);
  if (!located) return null;
  return simulateFromEntry({
    coin: input.coin,
    bars: located.bars,
    index: located.index,
    exit: input.exit,
    stakeUsd: input.stakeUsd,
    family: input.entry.family,
    ...(input.cost ? { cost: input.cost } : {})
  });
}

export interface TradeStats {
  trades: number;
  wins: number;
  pnlUsd: number;
  winPnlUsd: number;
  lossPnlUsd: number;
  holdMinutes: number;
  worstReturnPct: number;
}

export function emptyStats(): TradeStats {
  return { trades: 0, wins: 0, pnlUsd: 0, winPnlUsd: 0, lossPnlUsd: 0, holdMinutes: 0, worstReturnPct: 0 };
}

export function addTrade(stats: TradeStats, trade: ClosedTrade): void {
  stats.trades += 1;
  stats.pnlUsd += trade.pnlUsd;
  stats.holdMinutes += trade.holdMinutes;
  if (trade.win) {
    stats.wins += 1;
    stats.winPnlUsd += trade.pnlUsd;
  } else stats.lossPnlUsd += trade.pnlUsd;
  if (stats.trades === 1 || trade.returnPct < stats.worstReturnPct) stats.worstReturnPct = trade.returnPct;
}

export function expectancy(stats: TradeStats): number {
  return stats.trades === 0 ? 0 : stats.pnlUsd / stats.trades;
}

export function summarize(stats: TradeStats): {
  trades: number;
  winRate: number;
  avgWinUsd: number;
  avgLossUsd: number;
  expectancyUsd: number;
  avgHoldMinutes: number;
  worstReturnPct: number;
  pnlUsd: number;
} {
  const losses = stats.trades - stats.wins;
  return {
    trades: stats.trades,
    winRate: stats.trades === 0 ? 0 : stats.wins / stats.trades,
    avgWinUsd: stats.wins === 0 ? 0 : stats.winPnlUsd / stats.wins,
    avgLossUsd: losses === 0 ? 0 : stats.lossPnlUsd / losses,
    expectancyUsd: expectancy(stats),
    avgHoldMinutes: stats.trades === 0 ? 0 : stats.holdMinutes / stats.trades,
    worstReturnPct: stats.worstReturnPct,
    pnlUsd: stats.pnlUsd
  };
}

export interface PortfolioResult {
  endingEquityUsd: number;
  maxDrawdownPct: number;
  taken: number;
  skippedConcurrency: number;
  killedDays: number;
  pnlUsd: number;
  tradesPerDay: number;
}

export interface SizingPolicy {
  startingEquityUsd: number;
  stakeUsd: number;
  maxConcurrent: number;
  /** Stop opening new trades after equity falls this percent from the UTC day start. */
  dailyDrawdownKillPct: number;
}

export function simulatePortfolio(trades: ClosedTrade[], policy: SizingPolicy, rentUsd = MEASURED_COSTS.rentLamports / 1e9 * MEASURED_COSTS.solUsd): PortfolioResult {
  const ordered = [...trades].sort((a, b) => a.entryTime - b.entryTime || a.mint.localeCompare(b.mint));
  let equity = policy.startingEquityUsd;
  let peak = equity;
  let maxDrawdownPct = 0;
  const open: Array<{ exitTime: number; stake: number }> = [];
  const dayStart = new Map<string, number>();
  const killed = new Set<string>();
  let taken = 0;
  let skipped = 0;
  let pnl = 0;
  const rent = rentUsd;

  const release = (now: number) => {
    for (let i = open.length - 1; i >= 0; i -= 1) {
      const position = open[i]!;
      if (position.exitTime <= now) open.splice(i, 1);
    }
  };
  const mark = () => {
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak * 100);
  };

  for (const trade of ordered) {
    release(trade.entryTime);
    const day = new Date(trade.entryTime * 1000).toISOString().slice(0, 10);
    if (!dayStart.has(day)) dayStart.set(day, equity);
    const start = dayStart.get(day)!;
    if (equity <= start * (1 - policy.dailyDrawdownKillPct / 100)) killed.add(day);
    const locked = open.reduce((sum, position) => sum + position.stake, 0) + open.length * rent;
    const free = equity - locked;
    if (killed.has(day) || open.length >= policy.maxConcurrent || free < policy.stakeUsd + rent) {
      skipped += 1;
      continue;
    }
    open.push({ exitTime: trade.exitTime, stake: policy.stakeUsd });
    equity += trade.pnlUsd;
    pnl += trade.pnlUsd;
    taken += 1;
    mark();
  }
  const days = new Set(ordered.map(trade => new Date(trade.entryTime * 1000).toISOString().slice(0, 10))).size || 1;
  return {
    endingEquityUsd: equity,
    maxDrawdownPct,
    taken,
    skippedConcurrency: skipped,
    killedDays: killed.size,
    pnlUsd: pnl,
    tradesPerDay: taken / days
  };
}

export { DEFAULT_RUG_THRESHOLDS };
