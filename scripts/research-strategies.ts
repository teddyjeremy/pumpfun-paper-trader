import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MEASURED_COSTS, tradeCost, type CostAssumptions } from "../src/strategy/cost-model.js";
import { DEFAULT_RUG_THRESHOLDS, type RugThresholds } from "../src/strategy/rug-signals.js";
import {
  addTrade, barsFromRows, emptyStats, expectancy, simulatePortfolio, summarize, tryTrade,
  type ClosedTrade, type EntryRule, type ExitRule, type PathCoin, type TapeTrade, type TradeStats
} from "../src/strategy/simulate-trade.js";

interface RawCoin {
  mint: string;
  symbol?: string;
  creator?: string;
  createdAt: number;
  dex?: string;
  creatorHoldPct?: number;
  creatorSoldInSlot?: boolean;
  sameSlotBuyers?: number;
  sameSlotTopShare?: number | null;
  sameSlotWallets?: Array<{ wallet: string; sol: number }>;
  candles?: number[][];
  trades?: Array<[number, string, number, string, number]>;
  graduated?: null | { dex?: string; createdAt?: number; candles?: number[][] };
}

interface Scored {
  family: EntryRule["family"];
  label: string;
  entry: EntryRule;
  exit: ExitRule;
  rug: RugThresholds;
  train: TradeStats;
  valid: TradeStats;
}

const STAKE = 0.4;
const HOLD_SECONDS = 2 * 86400;

function asCoin(raw: RawCoin): PathCoin | null {
  const candles = barsFromRows(raw.candles ?? []);
  if (!raw.mint || !Number.isFinite(raw.createdAt) || candles.length < 5) return null;
  const trades: TapeTrade[] = [];
  for (const row of raw.trades ?? []) {
    const side = row[1] === "s" ? "sell" : row[1] === "b" ? "buy" : null;
    if (!side || !row[3]) continue;
    trades.push({ t: Number(row[0]), side, usd: Number(row[2]), wallet: String(row[3]), price: Number(row[4]) });
  }
  const graduatedCandles = barsFromRows(raw.graduated?.candles ?? []);
  return {
    mint: raw.mint,
    createdAt: raw.createdAt,
    dex: raw.dex ?? "pump-fun",
    creator: raw.creator ?? "",
    creatorHoldPct: Number(raw.creatorHoldPct ?? 0),
    creatorSoldInSlot: Boolean(raw.creatorSoldInSlot),
    sameSlotBuyers: Number(raw.sameSlotBuyers ?? 0),
    sameSlotTopShare: raw.sameSlotTopShare ?? null,
    sameSlotWallets: raw.sameSlotWallets ?? [],
    candles,
    trades,
    graduated: raw.graduated?.createdAt && graduatedCandles.length >= 5
      ? { dex: raw.graduated.dex ?? "pumpswap", createdAt: raw.graduated.createdAt, candles: graduatedCandles }
      : null
  };
}

function baseEntry(family: EntryRule["family"], patch: Partial<EntryRule> = {}): EntryRule {
  return {
    family,
    delayMinutes: 2,
    minVolumeUsd: 0,
    maxDropPct: 0.35,
    lookbackMinutes: 3,
    minReturnPct: 0.2,
    maxChasePct: 2,
    copyMinWallets: 2,
    copyWindowSeconds: 90,
    copyWallets: [],
    ...patch
  };
}

function rugOf(patch: Partial<RugThresholds>): RugThresholds {
  return { ...DEFAULT_RUG_THRESHOLDS, ...patch };
}

function runSet(coins: PathCoin[], entry: EntryRule, exit: ExitRule, rug: RugThresholds, cost: CostAssumptions): TradeStats {
  const stats = emptyStats();
  for (const coin of coins) {
    const trade = tryTrade({ coin, entry, exit, rug, stakeUsd: STAKE, cost });
    if (trade) addTrade(stats, trade);
  }
  return stats;
}

function collectTrades(coins: PathCoin[], entry: EntryRule, exit: ExitRule, rug: RugThresholds, cost: CostAssumptions, stake: number): ClosedTrade[] {
  const trades: ClosedTrade[] = [];
  for (const coin of coins) {
    const trade = tryTrade({ coin, entry, exit, rug, stakeUsd: stake, cost });
    if (trade) trades.push(trade);
  }
  return trades;
}

function better(candidate: Scored, current: Scored | null, minTrain: number, minValid: number, requirePositive: boolean): boolean {
  const train = summarize(candidate.train);
  const valid = summarize(candidate.valid);
  if (candidate.train.trades < minTrain || candidate.valid.trades < minValid) return false;
  if (requirePositive && (train.expectancyUsd <= 0 || valid.expectancyUsd <= 0)) return false;
  if (!current) return true;
  if (candidate.valid.trades !== current.valid.trades) return candidate.valid.trades > current.valid.trades;
  return expectancy(candidate.valid) > expectancy(current.valid);
}

function familyBest(rows: Scored[], family: Scored["family"], minTrain: number, minValid: number): Scored | null {
  let picked: Scored | null = null;
  for (const row of rows) {
    if (row.family !== family) continue;
    if (better(row, picked, minTrain, minValid, true)) picked = row;
  }
  if (picked) return picked;
  for (const row of rows) {
    if (row.family !== family) continue;
    if (!picked || expectancy(row.valid) > expectancy(picked.valid)) picked = row;
  }
  return picked;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function publicSummary(stats: TradeStats) {
  const summary = summarize(stats);
  return {
    trades: summary.trades,
    winRate: round(summary.winRate, 4),
    avgWinUsd: round(summary.avgWinUsd, 4),
    avgLossUsd: round(summary.avgLossUsd, 4),
    expectancyUsd: round(summary.expectancyUsd, 4),
    avgHoldMinutes: round(summary.avgHoldMinutes, 2),
    worstReturnPct: round(summary.worstReturnPct, 2),
    pnlUsd: round(summary.pnlUsd, 4)
  };
}

interface WalletRow {
  wallet: string;
  buys: number;
  mints: number;
  days: number;
  sameSlotShare: number;
  creatorShare: number;
  totalPnlUsd: number;
  medianPnlUsd: number;
  included: boolean;
  excludeReason: string | null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function walletBook(train: PathCoin[], cost: CostAssumptions): WalletRow[] {
  const book = new Map<string, { buys: number; mints: Set<string>; days: Set<string>; sameSlot: number; asCreator: number; pnls: number[] }>();
  const seenBuy = new Set<string>();
  const touch = (wallet: string) => {
    let row = book.get(wallet);
    if (!row) {
      row = { buys: 0, mints: new Set(), days: new Set(), sameSlot: 0, asCreator: 0, pnls: [] };
      book.set(wallet, row);
    }
    return row;
  };
  for (const coin of train) {
    const day = new Date(coin.createdAt * 1000).toISOString().slice(0, 10);
    const first = coin.candles[0];
    for (const buyer of coin.sameSlotWallets) {
      if (!buyer.wallet || buyer.sol <= 0 || seenBuy.has(`${buyer.wallet}|${coin.mint}`)) continue;
      seenBuy.add(`${buyer.wallet}|${coin.mint}`);
      const row = touch(buyer.wallet);
      row.buys += 1;
      row.mints.add(coin.mint);
      row.days.add(day);
      row.sameSlot += 1;
      if (buyer.wallet === coin.creator) row.asCreator += 1;
      if (first && first.o > 0) {
        const later = coin.candles.find(bar => bar.t + 60 >= coin.createdAt + 600);
        if (later) row.pnls.push(roundTripPnl(first.o, later.c, cost));
      }
    }
    for (const trade of coin.trades) {
      if (trade.side !== "buy" || !trade.wallet || seenBuy.has(`${trade.wallet}|${coin.mint}`)) continue;
      seenBuy.add(`${trade.wallet}|${coin.mint}`);
      const row = touch(trade.wallet);
      row.buys += 1;
      row.mints.add(coin.mint);
      row.days.add(new Date(trade.t * 1000).toISOString().slice(0, 10));
      if (trade.wallet === coin.creator) row.asCreator += 1;
      const price = trade.price > 0 ? trade.price : 0;
      const later = coin.candles.find(bar => bar.t + 60 >= trade.t + 600);
      if (price > 0 && later) row.pnls.push(roundTripPnl(price, later.c, cost));
    }
  }
  const rows: WalletRow[] = [];
  for (const [wallet, row] of book) {
    const sameSlotShare = row.buys === 0 ? 0 : row.sameSlot / row.buys;
    const creatorShare = row.buys === 0 ? 0 : row.asCreator / row.buys;
    const total = row.pnls.reduce((sum, value) => sum + value, 0);
    const med = median(row.pnls);
    let exclude: string | null = null;
    if (sameSlotShare >= 0.7) exclude = "launch_slot_sniper_or_bundler";
    else if (creatorShare >= 0.4) exclude = "creator_or_dev";
    else if (row.buys < 5 || row.mints.size < 2) exclude = "too_few_trades";
    else if (row.pnls.length < 4) exclude = "pnl_not_observable";
    else if (total <= 0 || med <= 0) exclude = "not_profitable";
    else if (row.days.size < 1) exclude = "single_observation";
    rows.push({
      wallet,
      buys: row.buys,
      mints: row.mints.size,
      days: row.days.size,
      sameSlotShare: round(sameSlotShare, 4),
      creatorShare: round(creatorShare, 4),
      totalPnlUsd: round(total, 4),
      medianPnlUsd: round(med, 4),
      included: exclude === null,
      excludeReason: exclude
    });
  }
  rows.sort((a, b) => Number(b.included) - Number(a.included) || b.totalPnlUsd - a.totalPnlUsd);
  return rows;
}

function roundTripPnl(entry: number, exit: number, cost: CostAssumptions): number {
  const side = 1 - (cost.venueFeeBps + cost.slippageFloorBps) / 10_000;
  const fixed = 2 * cost.feeLamportsPerTx / 1e9 * cost.solUsd;
  return STAKE * (exit / entry) * side * side - STAKE - fixed;
}

async function main(): Promise<void> {
  const root = resolve("data/public-history");
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8")) as {
    solUsd?: number;
    feeLamportsPerTxP75?: number | null;
    window?: { endSeconds?: number };
    discovery?: { createsSeen?: number; blocks?: number; slotsPerSec?: number };
  };
  const lines = (await readFile(resolve(root, "coins.jsonl"), "utf8")).split("\n").filter(Boolean);
  const coins = lines.map(line => asCoin(JSON.parse(line) as RawCoin)).filter((coin): coin is PathCoin => coin !== null);
  const end = manifest.window?.endSeconds ?? Math.max(...coins.map(coin => coin.createdAt));
  const split = end - HOLD_SECONDS;
  const train = coins.filter(coin => coin.createdAt < split);
  const valid = coins.filter(coin => coin.createdAt >= split);
  const cost: CostAssumptions = {
    ...MEASURED_COSTS,
    solUsd: manifest.solUsd && manifest.solUsd > 0 ? manifest.solUsd : MEASURED_COSTS.solUsd,
    feeLamportsPerTx: manifest.feeLamportsPerTxP75 && manifest.feeLamportsPerTxP75 > 0
      ? manifest.feeLamportsPerTxP75
      : MEASURED_COSTS.feeLamportsPerTx
  };
  const exits: ExitRule[] = [];
  for (const takeProfitPct of [0.1, 0.2, 0.4]) {
    for (const trailActivatePct of [0.1, 0.2]) {
      for (const trailDistancePct of [0.08, 0.15]) {
        for (const maxHoldMinutes of [8, 20, 60]) {
          exits.push({ stopLossPct: 0.05, takeProfitPct, trailActivatePct, trailDistancePct, maxHoldMinutes });
        }
      }
    }
  }
  const rugGrid: RugThresholds[] = [
    rugOf({ maxCreatorHoldPct: 4, rejectCreatorSoldInSlot: true, minSameSlotBuyers: 1, maxSameSlotTopShare: 0.7 }),
    rugOf({ maxCreatorHoldPct: 8, rejectCreatorSoldInSlot: true, minSameSlotBuyers: 1, maxSameSlotTopShare: null }),
    rugOf({ maxCreatorHoldPct: 100, rejectCreatorSoldInSlot: false, minSameSlotBuyers: 1, maxSameSlotTopShare: null })
  ];
  const launchEntries: EntryRule[] = [];
  for (const delayMinutes of [1, 2, 5]) {
    for (const minVolumeUsd of [0, 80, 300]) {
      for (const maxDropPct of [0.1, 0.35]) {
        launchEntries.push(baseEntry("launch", { delayMinutes, minVolumeUsd, maxDropPct }));
      }
    }
  }
  const momentumEntries: EntryRule[] = [];
  for (const lookbackMinutes of [3, 5]) {
    for (const minReturnPct of [0.12, 0.25, 0.45]) {
      for (const minVolumeUsd of [40, 200]) {
        momentumEntries.push(baseEntry("momentum", { lookbackMinutes, minReturnPct, minVolumeUsd, maxChasePct: 2.5 }));
      }
    }
  }
  const graduationEntries: EntryRule[] = [];
  for (const delayMinutes of [1, 3]) {
    for (const minVolumeUsd of [40, 200]) {
      graduationEntries.push(baseEntry("graduation", { delayMinutes, minVolumeUsd, maxDropPct: 0.25 }));
    }
  }

  const scored: Scored[] = [];
  const evaluate = (entries: EntryRule[]) => {
    for (const entry of entries) {
      for (const rug of rugGrid) {
        for (const exit of exits) {
          const row: Scored = {
            family: entry.family,
            label: entry.family,
            entry, exit, rug,
            train: runSet(train, entry, exit, rug, cost),
            valid: runSet(valid, entry, exit, rug, cost)
          };
          scored.push(row);
        }
      }
    }
  };
  evaluate(launchEntries);
  evaluate(momentumEntries);
  evaluate(graduationEntries);

  const wallets = walletBook(train, cost);
  const copyWallets = wallets.filter(row => row.included).slice(0, 25).map(row => row.wallet);
  const copyEntries = [60, 180].map(copyWindowSeconds => baseEntry("copy", {
    copyWallets, copyMinWallets: 2, copyWindowSeconds
  }));
  if (copyWallets.length >= 2) evaluate(copyEntries);

  const minTrain = Math.max(12, Math.floor(train.length * 0.08));
  const minValid = Math.max(8, Math.floor(valid.length * 0.08));
  const families = ["launch", "momentum", "graduation", "copy"] as const;
  const byFamily = Object.fromEntries(families.map(family => {
    const best = familyBest(scored, family, minTrain, minValid);
    return [family, best ? {
      profitable: expectancy(best.train) > 0 && expectancy(best.valid) > 0 && best.train.trades >= minTrain && best.valid.trades >= minValid,
      entry: best.entry,
      exit: best.exit,
      rug: best.rug,
      train: publicSummary(best.train),
      validation: publicSummary(best.valid)
    } : null];
  }));

  let winner: Scored | null = null;
  for (const row of scored) {
    if (better(row, winner, minTrain, minValid, true)) winner = row;
  }
  let profitable = true;
  if (!winner) {
    profitable = false;
    for (const row of scored) {
      if (!winner || expectancy(row.valid) > expectancy(winner.valid)) winner = row;
    }
  }
  if (!winner) throw new Error("No strategy configurations were scored.");

  const sizingCandidates = [];
  for (const stakeUsd of [0.2, 0.35, 0.5, 0.7]) {
    for (const maxConcurrent of [1, 2, 3]) {
      const trades = collectTrades(valid, winner.entry, winner.exit, winner.rug, cost, stakeUsd);
      const portfolio = simulatePortfolio(trades, {
        startingEquityUsd: 2.4,
        stakeUsd,
        maxConcurrent,
        dailyDrawdownKillPct: 20
      }, cost.rentLamports / 1e9 * cost.solUsd);
      sizingCandidates.push({ stakeUsd, maxConcurrent, ...portfolio, expectancyUsd: trades.length ? portfolio.pnlUsd / trades.length : 0 });
    }
  }
  const positiveSizes = sizingCandidates.filter(row => row.expectancyUsd > 0 && row.taken >= minValid);
  const sizing = (positiveSizes.length > 0 ? positiveSizes : sizingCandidates)
    .sort((a, b) => b.endingEquityUsd - a.endingEquityUsd)[0]!;

  const costs = tradeCost(sizing.stakeUsd, null, cost);
  const capacityPerDay = sizing.maxConcurrent * (1440 / Math.max(1, publicSummary(winner.valid).avgHoldMinutes || 10));
  const blocks = manifest.discovery?.blocks ?? 0;
  const createsPerSlot = blocks > 0 ? (manifest.discovery?.createsSeen ?? 0) / blocks : 0;
  const slotsPerSec = manifest.discovery?.slotsPerSec ?? 2.5;
  const launchesPerDay = createsPerSlot * slotsPerSec * 86400;
  const fireRate = (winner.train.trades + winner.valid.trades) / Math.max(1, coins.length);
  const projectedSignals = fireRate * launchesPerDay;
  const viableTradesPerDay = Math.min(projectedSignals, capacityPerDay);
  const fixed = costs.fixedUsd;
  const variable = costs.roundTripVariablePct / 100 * sizing.stakeUsd;
  const costPerTrade = fixed + variable;

  const chosen = {
    id: `${winner.family}-throughput-v1`,
    family: winner.family,
    profitableOnHoldout: profitable,
    entry: winner.entry,
    exit: winner.exit,
    rug: winner.rug,
    sizing: {
      startingEquityUsd: 2.4,
      stakeUsd: sizing.stakeUsd,
      maxConcurrent: sizing.maxConcurrent,
      dailyDrawdownKillPct: 20
    },
    copyWallets: winner.family === "copy" ? copyWallets : [],
    costs: {
      solUsd: cost.solUsd,
      venueFeeBpsPerSide: cost.venueFeeBps,
      slippageFloorBps: cost.slippageFloorBps,
      feeLamportsPerTx: cost.feeLamportsPerTx,
      rentLamports: cost.rentLamports,
      fixedRoundTripUsd: round(costs.fixedUsd, 4),
      roundTripVariablePct: round(costs.roundTripVariablePct, 3),
      rentUsd: round(costs.rentUsd, 4),
      costPerTradeUsdAtStake: round(costPerTrade, 4)
    }
  };

  const report = {
    dataset: {
      coins: coins.length,
      train: train.length,
      validation: valid.length,
      splitUnix: split,
      graduated: coins.filter(coin => coin.graduated).length,
      solUsd: cost.solUsd
    },
    selection: {
      rule: "Among configs with positive train and validation expectancy and enough trades, pick the most validation trades, then higher validation expectancy. Losses use a 5% price stop. If none are profitable, the highest validation expectancy is reported and marked unprofitable.",
      minTrainTrades: minTrain,
      minValidationTrades: minValid,
      referenceStakeUsd: STAKE
    },
    families: byFamily,
    winner: {
      ...chosen,
      train: publicSummary(winner.train),
      validation: publicSummary(winner.valid)
    },
    sizingSweep: sizingCandidates.map(row => ({
      stakeUsd: row.stakeUsd,
      maxConcurrent: row.maxConcurrent,
      endingEquityUsd: round(row.endingEquityUsd, 4),
      maxDrawdownPct: round(row.maxDrawdownPct, 2),
      taken: row.taken,
      tradesPerDay: round(row.tradesPerDay, 2),
      pnlUsd: round(row.pnlUsd, 4)
    })),
    throughput: {
      launchesPerDayEstimate: round(launchesPerDay, 1),
      sampleFireRate: round(fireRate, 4),
      projectedSignalsPerDay: round(projectedSignals, 1),
      capacityTradesPerDay: round(capacityPerDay, 1),
      viableTradesPerDay: round(viableTradesPerDay, 1),
      fiveHundredPerDayViable: viableTradesPerDay >= 500 && costPerTrade * 500 < 2.4,
      costOf500TradesUsd: round(costPerTrade * 500, 2),
      note: "500 trades/day is viable only if the account can fund the fees and the hold time allows the slots. Sampled launches are not the full firehose; projected signals are an extrapolation."
    },
    copyTrading: {
      walletsConsidered: wallets.length,
      walletsIncluded: copyWallets.length,
      note: "Included wallets need several observable buys, more than one mint, positive median and total pnl after fees, and are not majority same-slot snipers or the token creator. Same-slot bundlers are excluded on purpose."
    }
  };

  await writeFile(resolve(root, "chosen-strategy.json"), `${JSON.stringify(chosen, null, 2)}\n`);
  await writeFile(resolve(root, "backtest-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve("wallets.json"), `${JSON.stringify({
    generatedFrom: "training split of data/public-history/coins.jsonl",
    stakeUsd: STAKE,
    solUsd: cost.solUsd,
    rules: "Include only if buys>=5, mints>=2, observable pnl samples>=4, total and median pnl > 0, same-slot share < 70%, creator share < 40%.",
    wallets
  }, null, 2)}\n`);
  console.log(JSON.stringify({
    coins: coins.length,
    train: train.length,
    valid: valid.length,
    winner: winner.family,
    profitable,
    validation: report.winner.validation,
    trainStats: report.winner.train,
    sizing,
    throughput: report.throughput,
    copyWallets: copyWallets.length,
    families: Object.fromEntries(families.map(family => [family, byFamily[family]?.validation ?? null]))
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
