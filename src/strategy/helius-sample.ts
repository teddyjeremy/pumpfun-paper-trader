import { roundTripPnlUsd, type CostAssumptions, MEASURED_COSTS } from "./cost-model.js";

/** One row of the Helius/Gecko token table. Prices are snapshot levels, not 1-minute bars. */
export interface SampleToken {
  mint: string;
  launchTime: number;
  launchDate: string;
  graduated: boolean;
  outcome: string;
  startPrice: number | null;
  price1m: number | null;
  price5m: number | null;
  price15m: number | null;
  price1h: number | null;
  price6h: number | null;
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  creatorHoldPct: number | null;
  devSoldEarly5m: boolean | null;
  top10ExclLpPct: number | null;
  launchSlotBuyers: number | null;
  uniqueBuyers60s: number | null;
  gmgnBundlerRate: number | null;
}

export interface SampleTrade {
  mint: string;
  launchTime: number;
  pnlUsd: number;
  returnPct: number;
  reason: "stop" | "gap" | "take_profit" | "max_hold";
  holdMinutes: number;
}

export interface SampleRule {
  id: string;
  family: "launch" | "momentum" | "graduation";
  entry: "1m" | "5m";
  /** Momentum only: minimum gain from the first print to the 5-minute print. */
  minRunup: number;
  takeProfitMultiple: number;
  maxHoldMinutes: number;
  maxCreatorHoldPct: number | null;
  rejectDevSoldEarly: boolean;
  maxTop10ExclLpPct: number | null;
  minUniqueBuyers60s: number | null;
  maxLaunchSlotBuyers: number | null;
  maxBundlerRate: number | null;
}

const POINTS: Array<{ minutes: number; key: keyof SampleToken }> = [
  { minutes: 1, key: "price1m" },
  { minutes: 5, key: "price5m" },
  { minutes: 15, key: "price15m" },
  { minutes: 60, key: "price1h" },
  { minutes: 360, key: "price6h" }
];

function priceAt(token: SampleToken, key: keyof SampleToken): number | null {
  const value = token[key];
  return typeof value === "number" && value > 0 ? value : null;
}

export function passesRugFilters(token: SampleToken, rule: SampleRule): boolean {
  if (token.mintAuthorityRevoked === false || token.freezeAuthorityRevoked === false) return false;
  if (rule.rejectDevSoldEarly && token.devSoldEarly5m === true) return false;
  if (rule.maxCreatorHoldPct !== null && token.creatorHoldPct !== null && token.creatorHoldPct > rule.maxCreatorHoldPct) return false;
  if (rule.maxTop10ExclLpPct !== null && token.top10ExclLpPct !== null && token.top10ExclLpPct >= rule.maxTop10ExclLpPct) return false;
  if (rule.minUniqueBuyers60s !== null && token.uniqueBuyers60s !== null && token.uniqueBuyers60s < rule.minUniqueBuyers60s) return false;
  if (rule.maxLaunchSlotBuyers !== null && token.launchSlotBuyers !== null && token.launchSlotBuyers >= rule.maxLaunchSlotBuyers) return false;
  if (rule.maxBundlerRate !== null && token.gmgnBundlerRate !== null && token.gmgnBundlerRate >= rule.maxBundlerRate) return false;
  if (rule.family === "graduation" && !token.graduated) return false;
  if (rule.family === "momentum") {
    const start = token.startPrice;
    const five = token.price5m;
    const one = token.price1m;
    if (start === null || five === null || five / start < rule.minRunup) return false;
    if (one !== null && five < one * 0.98) return false;
  }
  return true;
}

/**
 * Walk the snapshot path. A take-profit limit fills at the target. A stop that
 * the next snapshot has already blown through fills at that snapshot, not at -5%.
 */
export function simulateSampleToken(token: SampleToken, rule: SampleRule, stakeUsd: number, cost: CostAssumptions = MEASURED_COSTS): SampleTrade | null {
  if (!passesRugFilters(token, rule)) return null;
  const entryMinutes = rule.entry === "1m" ? 1 : 5;
  const entryKey = rule.entry === "1m" ? "price1m" : "price5m";
  const entry = priceAt(token, entryKey);
  if (entry === null) return null;
  const future = POINTS.filter(point => point.minutes > entryMinutes && point.minutes <= rule.maxHoldMinutes)
    .map(point => ({ minutes: point.minutes, price: priceAt(token, point.key) }))
    .filter((point): point is { minutes: number; price: number } => point.price !== null);
  if (future.length === 0) return null;
  const stop = entry * 0.95;
  const target = entry * rule.takeProfitMultiple;
  let exitPrice = future[future.length - 1]!.price;
  let reason: SampleTrade["reason"] = "max_hold";
  let holdMinutes = future[future.length - 1]!.minutes - entryMinutes;
  for (const point of future) {
    if (point.price <= stop) {
      exitPrice = point.price;
      reason = point.price < stop * 0.99 ? "gap" : "stop";
      holdMinutes = point.minutes - entryMinutes;
      break;
    }
    if (point.price >= target) {
      exitPrice = target;
      reason = "take_profit";
      holdMinutes = point.minutes - entryMinutes;
      break;
    }
  }
  const pnlUsd = roundTripPnlUsd({ stakeUsd, entryPrice: entry, exitPrice, reserveUsd: null, cost });
  return {
    mint: token.mint,
    launchTime: token.launchTime + entryMinutes * 60,
    pnlUsd,
    returnPct: (exitPrice / entry - 1) * 100,
    reason,
    holdMinutes
  };
}

export interface SampleStats {
  trades: number;
  winRate: number;
  avgWinUsd: number;
  avgLossUsd: number;
  expectancyUsd: number;
  pnlUsd: number;
  avgHoldMinutes: number;
  worstReturnPct: number;
}

export function summarizeSample(trades: SampleTrade[]): SampleStats {
  const wins = trades.filter(trade => trade.pnlUsd > 0);
  const losses = trades.filter(trade => trade.pnlUsd <= 0);
  const pnl = trades.reduce((sum, trade) => sum + trade.pnlUsd, 0);
  return {
    trades: trades.length,
    winRate: trades.length === 0 ? 0 : wins.length / trades.length,
    avgWinUsd: wins.length === 0 ? 0 : wins.reduce((sum, trade) => sum + trade.pnlUsd, 0) / wins.length,
    avgLossUsd: losses.length === 0 ? 0 : losses.reduce((sum, trade) => sum + trade.pnlUsd, 0) / losses.length,
    expectancyUsd: trades.length === 0 ? 0 : pnl / trades.length,
    pnlUsd: pnl,
    avgHoldMinutes: trades.length === 0 ? 0 : trades.reduce((sum, trade) => sum + trade.holdMinutes, 0) / trades.length,
    worstReturnPct: trades.reduce((worst, trade) => Math.min(worst, trade.returnPct), 0)
  };
}

export const LIGHT_SNIPE: SampleRule = Object.freeze({
  id: "launch-snipe-1m-2x-15m",
  family: "launch",
  entry: "1m",
  minRunup: 1,
  takeProfitMultiple: 2,
  maxHoldMinutes: 15,
  maxCreatorHoldPct: 8,
  rejectDevSoldEarly: true,
  maxTop10ExclLpPct: null,
  minUniqueBuyers60s: null,
  maxLaunchSlotBuyers: null,
  maxBundlerRate: null
});

export function parseSampleCsv(text: string): SampleToken[] {
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  const header = splitCsv(lines[0] ?? "");
  const index = new Map(header.map((name, position) => [name, position]));
  const cell = (cells: string[], name: string) => cells[index.get(name) ?? -1] ?? "";
  const num = (cells: string[], name: string): number | null => {
    const raw = cell(cells, name).trim();
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const bool = (cells: string[], name: string): boolean | null => {
    const raw = cell(cells, name).trim().toLowerCase();
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    return null;
  };
  const tokens: SampleToken[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsv(line);
    const launch = Date.parse(cell(cells, "launch_time"));
    if (!Number.isFinite(launch)) continue;
    tokens.push({
      mint: cell(cells, "mint").trim(),
      launchTime: Math.floor(launch / 1000),
      launchDate: cell(cells, "launch_date").trim(),
      graduated: bool(cells, "graduated") === true,
      outcome: cell(cells, "outcome").trim(),
      startPrice: num(cells, "start_price"),
      price1m: num(cells, "price_1m"),
      price5m: num(cells, "price_5m"),
      price15m: num(cells, "price_15m"),
      price1h: num(cells, "price_1h"),
      price6h: num(cells, "price_6h"),
      mintAuthorityRevoked: bool(cells, "mint_authority_revoked"),
      freezeAuthorityRevoked: bool(cells, "freeze_authority_revoked"),
      creatorHoldPct: num(cells, "creator_hold_pct"),
      devSoldEarly5m: bool(cells, "dev_sold_early_5m"),
      top10ExclLpPct: num(cells, "top10_holder_pct_excl_lp"),
      launchSlotBuyers: num(cells, "launch_slot_buyers"),
      uniqueBuyers60s: num(cells, "unique_buyers_60s"),
      gmgnBundlerRate: num(cells, "gmgn_bundler_rate")
    });
  }
  return tokens;
}

function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (char === "\"" && line[i + 1] === "\"") { current += "\""; i += 1; }
    else if (char === "\"") quoted = !quoted;
    else if (char === "," && !quoted) { cells.push(current); current = ""; }
    else current += char;
  }
  cells.push(current);
  return cells;
}
