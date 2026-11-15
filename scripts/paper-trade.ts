/**
 * Paper-only session for the data-backed throughput rules.
 * Never signs, never submits, and has no private-key path.
 *
 *   npm run paper -- --replay     # historical research only
 *
 * Forward polling is intentionally blocked: this standalone runner prices
 * from GeckoTerminal candles and writes a local JSON file. It does not obtain
 * fresh exact-size Pump SDK buy/sell quotes, validate live sellability, or
 * commit the durable Worker journal transition required for paper fills.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MEASURED_COSTS, type CostAssumptions } from "../src/strategy/cost-model.js";
import { LIGHT_SNIPE, parseSampleCsv, simulateSampleToken, summarizeSample } from "../src/strategy/helius-sample.js";
import {
  evaluateRugFilters, fetchHeliusRugSignals, loadRugCsv, type HeliusCache, type RugSignal, type RugThresholds
} from "../src/strategy/rug-signals.js";
import {
  advancePaperPosition, barsFromRows, closeTime, launchEvidence, locateEntry, simulatePortfolio,
  type ClosedTrade, type EntryRule, type ExitRule, type OpenPaperPosition, type PathCoin
} from "../src/strategy/simulate-trade.js";

const RPC = "https://public.rpc.solanavibestation.com";
const WSOL = "So11111111111111111111111111111111111111112";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SESSION_PATH = resolve("data/paper-session.json");
const CACHE_PATH = resolve("data/cache/helius-assets.json");
const POLL_MS = 25_000;

interface ChosenStrategy {
  id: string;
  family: EntryRule["family"];
  profitableOnHoldout: boolean;
  entry: EntryRule;
  exit: ExitRule;
  rug: RugThresholds;
  sizing: { startingEquityUsd: number; stakeUsd: number; maxConcurrent: number; dailyDrawdownKillPct: number };
  copyWallets: string[];
  costs: CostAssumptions & { fixedRoundTripUsd?: number; rentUsd?: number };
}

interface Session {
  strategyId: string;
  startedAt: string;
  equityUsd: number;
  dayKey: string;
  dayStartEquityUsd: number;
  killed: boolean;
  seen: string[];
  open: OpenPaperPosition[];
  closed: ClosedTrade[];
  lastBar: Record<string, number>;
  heliusCreditsUsed: number;
}

function arg(flag: string): boolean {
  return process.argv.includes(flag);
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch { return null; }
}

async function gecko(path: string): Promise<unknown> {
  const response = await fetch(`https://api.geckoterminal.com/api/v2${path}`, {
    headers: { accept: "application/json", "user-agent": "pumpfun-paper/0.1" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) return null;
  const text = await response.text();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  return JSON.parse(text) as unknown;
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(25_000)
  });
  const text = await response.text();
  if (!text.startsWith("{")) return null;
  const payload = JSON.parse(text) as { result?: unknown };
  return payload.result ?? null;
}

function instructionNames(tx: { meta?: { logMessages?: string[] } }): string[] {
  return (tx.meta?.logMessages ?? [])
    .filter(line => line.startsWith("Program log: Instruction:"))
    .map(line => line.slice("Program log: Instruction:".length).trim());
}

async function hydrateLaunch(mint: string): Promise<Pick<PathCoin, "creator" | "creatorHoldPct" | "creatorSoldInSlot" | "sameSlotBuyers" | "sameSlotTopShare"> | null> {
  const signatures = await rpc("getSignaturesForAddress", [mint, { limit: 20 }]) as Array<{ signature: string }> | null;
  if (!signatures?.length) return null;
  const sample = signatures.slice(-8);
  let creator = "";
  let hold = 0;
  let sold = false;
  let buyers = 0;
  for (const row of sample) {
    const tx = await rpc("getTransaction", [row.signature, { encoding: "json", maxSupportedTransactionVersion: 1 }]) as {
      meta?: { logMessages?: string[]; postTokenBalances?: Array<{ mint?: string; owner?: string; uiTokenAmount?: { uiAmount?: number } }>; err?: unknown };
      transaction?: { message?: { accountKeys?: Array<string | { pubkey: string; signer?: boolean }> } };
    } | null;
    if (!tx?.meta || tx.meta.err) continue;
    const names = instructionNames(tx);
    const keys = tx.transaction?.message?.accountKeys ?? [];
    const signer = typeof keys[0] === "string" ? keys[0] : keys[0]?.pubkey ?? "";
    if (names.some(name => name === "Create" || name === "CreateV2")) {
      creator = signer;
      for (const balance of tx.meta.postTokenBalances ?? []) {
        if (balance.mint === mint && balance.owner === signer) hold += Number(balance.uiTokenAmount?.uiAmount ?? 0);
      }
    }
    if (creator && signer === creator && names.some(name => name.startsWith("Sell"))) sold = true;
    if (names.some(name => name.startsWith("Buy"))) buyers += 1;
  }
  if (!creator) return null;
  return {
    creator,
    creatorHoldPct: hold / 1_000_000_000 * 100,
    creatorSoldInSlot: sold,
    sameSlotBuyers: buyers,
    sameSlotTopShare: null
  };
}

async function solPrice(fallback: number): Promise<number> {
  const payload = await gecko(`/simple/networks/solana/token_price/${WSOL}`) as {
    data?: { attributes?: { token_prices?: Record<string, string> } };
  } | null;
  const price = Number(payload?.data?.attributes?.token_prices?.[WSOL]);
  return Number.isFinite(price) && price > 0 ? price : fallback;
}

async function replay(strategy: ChosenStrategy): Promise<void> {
  const tokens = parseSampleCsv(await readFile(resolve("data/helius/tokens.csv"), "utf8"));
  const holdout = tokens.filter(token => token.launchDate >= "2026-11-14");
  const cost: CostAssumptions = {
    solUsd: strategy.costs.solUsd,
    venueFeeBps: strategy.costs.venueFeeBps,
    slippageFloorBps: strategy.costs.slippageFloorBps,
    feeLamportsPerTx: strategy.costs.feeLamportsPerTx,
    rentLamports: strategy.costs.rentLamports
  };
  const sampleTrades = holdout.flatMap(token => {
    const trade = simulateSampleToken(token, LIGHT_SNIPE, strategy.sizing.stakeUsd, cost);
    return trade ? [trade] : [];
  });
  const stats = summarizeSample(sampleTrades);
  const portfolio = simulatePortfolio(sampleTrades.map(trade => ({
    mint: trade.mint,
    family: "launch",
    entryTime: trade.launchTime,
    exitTime: trade.launchTime + trade.holdMinutes * 60,
    entryPrice: 1,
    exitPrice: 1,
    stakeUsd: strategy.sizing.stakeUsd,
    pnlUsd: trade.pnlUsd,
    returnPct: trade.returnPct,
    holdMinutes: trade.holdMinutes,
    exitReason: trade.reason === "take_profit" ? "take_profit" as const : trade.reason === "max_hold" ? "max_hold" as const : "stop" as const,
    win: trade.pnlUsd > 0
  })), strategy.sizing, cost.rentLamports / 1e9 * cost.solUsd);
  console.log(JSON.stringify({
    mode: "replay",
    strategy: strategy.id,
    profitableOnHoldout: strategy.profitableOnHoldout,
    holdoutDay: "2026-11-14",
    ...stats,
    portfolio
  }, null, 2));
}

async function pollOnce(strategy: ChosenStrategy, session: Session, rugs: Map<string, RugSignal>, helius: HeliusCache): Promise<void> {
  const price = await solPrice(strategy.costs.solUsd);
  const cost: CostAssumptions = { ...MEASURED_COSTS, ...strategy.costs, solUsd: price };
  const payload = await gecko("/networks/solana/new_pools?page=1") as { data?: Array<Record<string, unknown>> } | null;
  const pools = payload?.data ?? [];
  const now = Math.floor(Date.now() / 1000);
  let considered = 0;
  for (const item of pools) {
    const attributes = (item.attributes ?? {}) as Record<string, unknown>;
    const relationships = (item.relationships ?? {}) as Record<string, { data?: { id?: string } }>;
    const dex = relationships.dex?.data?.id ?? "";
    if (dex !== "pump-fun" && dex !== "pumpswap" && !dex.startsWith("raydium")) continue;
    const pool = String(attributes.address ?? "");
    const createdAt = Date.parse(String(attributes.pool_created_at ?? "")) / 1000;
    if (!pool || !Number.isFinite(createdAt) || now - createdAt > 30 * 60) continue;
    if (session.seen.includes(pool)) continue;
    const base = String(relationships.base_token?.data?.id ?? "").split("_").pop() ?? "";
    if (!base.endsWith("pump")) continue;
    if (considered >= 3) break;
    considered += 1;
    const candlePayload = await gecko(`/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=30&currency=usd`) as {
      data?: { attributes?: { ohlcv_list?: number[][] } };
    } | null;
    const candles = barsFromRows(candlePayload?.data?.attributes?.ohlcv_list ?? []).sort((a, b) => a.t - b.t);
    const launch = await hydrateLaunch(base);
    if (!launch) {
      session.seen.push(pool);
      continue;
    }
    const coin: PathCoin = {
      mint: base,
      createdAt: Math.floor(createdAt),
      dex,
      creator: launch?.creator ?? "",
      creatorHoldPct: launch?.creatorHoldPct ?? 0,
      creatorSoldInSlot: launch?.creatorSoldInSlot ?? false,
      sameSlotBuyers: launch?.sameSlotBuyers ?? 0,
      sameSlotTopShare: launch?.sameSlotTopShare ?? null,
      sameSlotWallets: [],
      candles,
      trades: [],
      graduated: dex === "pump-fun" ? null : { dex, createdAt: Math.floor(createdAt), candles }
    };
    const apiKey = process.env.HELIUS_API_KEY?.trim() ?? "";
    if (apiKey) {
      try {
        const ledger = { used: session.heliusCreditsUsed, cap: 400 };
        await fetchHeliusRugSignals({ apiKey, mints: [base], cache: helius, maxBatch: 5, creditLedger: ledger });
        session.heliusCreditsUsed = ledger.used;
        await mkdir(resolve("data/cache"), { recursive: true });
        await writeFile(CACHE_PATH, JSON.stringify(helius));
      } catch (error) {
        console.error("Helius rug lookup skipped:", error instanceof Error ? error.message : error);
      }
    }
    const rug = evaluateRugFilters(launchEvidence(coin, dex !== "pump-fun"), rugs.get(base) ?? helius[base] ?? null, strategy.rug);
    const tooOld = now - createdAt > Math.max(20, strategy.entry.delayMinutes + strategy.exit.maxHoldMinutes) * 60;
    if (!rug.ok || tooOld) session.seen.push(pool);
    const located = rug.ok ? locateEntry(coin, { ...strategy.entry, copyWallets: strategy.copyWallets }) : null;
    const entryBar = located ? located.bars[located.index] : undefined;
    if (!entryBar || now - closeTime(entryBar) > 180) continue;
    if (session.open.some(position => position.mint === base) || session.closed.some(trade => trade.mint === base)) continue;
    const day = new Date().toISOString().slice(0, 10);
    if (session.dayKey !== day) {
      session.dayKey = day;
      session.dayStartEquityUsd = session.equityUsd;
      session.killed = false;
    }
    if (session.equityUsd <= session.dayStartEquityUsd * (1 - strategy.sizing.dailyDrawdownKillPct / 100)) {
      session.killed = true;
    }
    if (session.killed || session.open.length >= strategy.sizing.maxConcurrent) continue;
    const rent = cost.rentLamports / 1e9 * cost.solUsd;
    const locked = session.open.length * (strategy.sizing.stakeUsd + rent);
    if (session.equityUsd - locked < strategy.sizing.stakeUsd + rent) continue;
    const hardStop = entryBar.c * (1 - strategy.exit.stopLossPct);
    session.open.push({
      mint: base,
      pool,
      entryTime: closeTime(entryBar),
      entryPrice: entryBar.c,
      stop: hardStop,
      high: entryBar.c,
      hardStop,
      deadline: closeTime(entryBar) + strategy.exit.maxHoldMinutes * 60,
      stakeUsd: strategy.sizing.stakeUsd
    });
    session.lastBar[pool] = entryBar.t;
    session.seen.push(pool);
    console.log(JSON.stringify({ event: "paper-entry", mint: base, dex, family: strategy.family, entryPrice: entryBar.c, stakeUsd: strategy.sizing.stakeUsd }));
  }
  for (const position of [...session.open]) {
    const candlePayload = await gecko(`/networks/solana/pools/${position.pool}/ohlcv/minute?aggregate=1&limit=3&currency=usd`) as {
      data?: { attributes?: { ohlcv_list?: number[][] } };
    } | null;
    const fresh = barsFromRows(candlePayload?.data?.attributes?.ohlcv_list ?? [])
      .filter(bar => bar.t > (session.lastBar[position.pool] ?? 0))
      .sort((a, b) => a.t - b.t);
    let current = position;
    for (const bar of fresh) {
      const stepped = advancePaperPosition({ position: current, bar, exit: strategy.exit, cost });
      current = stepped.position;
      session.lastBar[position.pool] = bar.t;
      if (!stepped.closed) continue;
      session.equityUsd += stepped.closed.pnlUsd;
      session.closed.push(stepped.closed);
      session.open = session.open.filter(open => open.mint !== position.mint);
      console.log(JSON.stringify({ event: "paper-exit", ...stepped.closed, equityUsd: session.equityUsd }));
      break;
    }
    const stillOpen = session.open.find(open => open.mint === position.mint);
    if (stillOpen) Object.assign(stillOpen, current);
  }
  console.log(JSON.stringify({
    event: "poll",
    strategy: strategy.id,
    paperOnly: true,
    liveTrading: false,
    program: PUMP,
    solUsd: price,
    considered,
    equityUsd: session.equityUsd,
    open: session.open.length,
    killed: session.killed,
    note: strategy.profitableOnHoldout
      ? "Holdout expectancy was positive. This is still paper."
      : "Holdout expectancy was not positive. Paper only; do not fund this."
  }));
}

async function main(): Promise<void> {
  if (arg("--live")) {
    console.error("Refusing --live. This process never signs or sends transactions.");
    process.exit(2);
  }
  if (!arg("--replay")) {
    console.error(
      "Refusing forward paper polling: candle-derived prices and local JSON state are not executable paper fills. " +
      "Forward paper execution must use the Cloudflare Worker with fresh exact-size Pump SDK buy/sell quotes, " +
      "validated sellability, complete creator and wallet-cluster evidence, reviewed chronological calibration, " +
      "all strict strategy rules, and an idempotent durable journal transition."
    );
    process.exit(2);
  }
  const strategy = await readJson<ChosenStrategy>(resolve("data/helius/chosen-strategy.json"));
  if (!strategy) throw new Error("Missing data/helius/chosen-strategy.json. Run npm run backtest:rules first.");
  await replay(strategy);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
