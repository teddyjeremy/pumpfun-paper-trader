import { readdir, readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Trade = {
  mint: string; solAmount: string; tokenAmount: string; isBuy: boolean; user: string;
  timestamp: string; virtualSolReserves: string; virtualTokenReserves: string;
  realSolReserves: string; quoteMint: string;
};
type CoinRecord = {
  mint: string;
  collection?: { status?: string; verifiedTransactions?: number };
  transactions?: Array<{ tradeEvents?: Trade[] }>;
};
type Candidate = {
  mint: string; status: "QUALIFIED" | "REJECTED" | "INCOMPLETE";
  uniqueBuyers30s: number; buyTrades30s: number; sellTrades30s: number;
  buyVolumeSol30s: number; priceMovePct30s: number | null;
  peakPriceMovePct30s: number | null; realSolLiquidityAt30s: number | null;
  reasons: string[];
};
const arg = (name: string, fallback: string) =>
  process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const int = (name: string, fallback: number, max: number) => {
  const value = Number(arg(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`--${name} must be between 1 and ${max}.`);
  return value;
};
const date = arg("date", "");
const minBuyers = int("min-buyers", 15, 500);
const minBuyTrades = int("min-buy-trades", 15, 5000);
const minMovePct = Number(arg("min-move-pct", "10"));
const minLiquiditySol = Number(arg("min-liquidity-sol", "5"));
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(minMovePct) || minMovePct < 0 ||
    !Number.isFinite(minLiquiditySol) || minLiquiditySol < 0) throw new Error("Invalid ranking date or thresholds.");
const directory = resolve("artifacts", "coins");
const files = (await readdir(directory)).filter(name => name.endsWith(".json")).sort();
const candidates: Candidate[] = [];
for (const file of files) {
  const coin = JSON.parse(await readFile(resolve(directory, file), "utf8")) as CoinRecord;
  if (coin.collection?.status !== "COMPLETE" || !Array.isArray(coin.transactions)) {
    candidates.push({ mint: coin.mint, status: "INCOMPLETE", uniqueBuyers30s: 0, buyTrades30s: 0,
      sellTrades30s: 0, buyVolumeSol30s: 0, priceMovePct30s: null, peakPriceMovePct30s: null,
      realSolLiquidityAt30s: null, reasons: ["Full historical transaction collection is incomplete."] });
    continue;
  }
  const trades = coin.transactions.flatMap(tx => tx.tradeEvents ?? [])
    .filter(event => event.mint === coin.mint && event.quoteMint === "So11111111111111111111111111111111111111112")
    .map(event => ({
      ...event, time: Number(event.timestamp), sol: Number(event.solAmount) / 1e9,
      price: Number(event.virtualSolReserves) / Number(event.virtualTokenReserves),
      liquidity: Number(event.realSolReserves) / 1e9
    }))
    .filter(event => Number.isSafeInteger(event.time) && event.time >= 0 &&
      Number.isFinite(event.price) && event.price > 0 && Number.isFinite(event.sol) && event.sol >= 0)
    .sort((a, b) => a.time - b.time);
  const start = trades[0]?.time;
  const window = start === undefined ? [] : trades.filter(event => event.time >= start && event.time <= start + 30);
  const buys = window.filter(event => event.isBuy);
  const sells = window.filter(event => !event.isBuy);
  const buyers = new Set(buys.map(event => event.user));
  const firstBuy = buys[0];
  const last = window[window.length - 1];
  const prices = window.map(event => event.price);
  const priceMovePct = firstBuy && last ? (last.price / firstBuy.price - 1) * 100 : null;
  const peakMovePct = firstBuy && prices.length ? (Math.max(...prices) / firstBuy.price - 1) * 100 : null;
  const liquidity = last?.liquidity ?? null;
  const reasons: string[] = [];
  if (buyers.size < minBuyers) reasons.push(`Only ${buyers.size} unique buyers in first 30 seconds; need ${minBuyers}.`);
  if (buys.length < minBuyTrades) reasons.push(`Only ${buys.length} buy trades in first 30 seconds; need ${minBuyTrades}.`);
  if (priceMovePct === null || peakMovePct === null || peakMovePct < minMovePct) reasons.push(`Peak price movement did not reach ${minMovePct}%.`);
  if (liquidity === null || liquidity < minLiquiditySol) reasons.push(`Observed real SOL reserves below ${minLiquiditySol} SOL or unavailable.`);
  candidates.push({
    mint: coin.mint, status: reasons.length ? "REJECTED" : "QUALIFIED",
    uniqueBuyers30s: buyers.size, buyTrades30s: buys.length, sellTrades30s: sells.length,
    buyVolumeSol30s: buys.reduce((sum, event) => sum + event.sol, 0),
    priceMovePct30s: priceMovePct, peakPriceMovePct30s: peakMovePct,
    realSolLiquidityAt30s: liquidity, reasons
  });
}
candidates.sort((a, b) => Number(b.status === "QUALIFIED") - Number(a.status === "QUALIFIED") ||
  b.uniqueBuyers30s - a.uniqueBuyers30s || (b.peakPriceMovePct30s ?? -Infinity) - (a.peakPriceMovePct30s ?? -Infinity));
const complete = candidates.filter(row => row.status !== "INCOMPLETE").length;
const output = {
  date, windowSeconds: 30, thresholds: { minBuyers, minBuyTrades, minMovePct, minLiquiditySol },
  filesProcessed: files.length, completeCoins: complete, incompleteCoins: candidates.length - complete,
  qualifiedCoins: candidates.filter(row => row.status === "QUALIFIED").length,
  rejectedCoins: candidates.filter(row => row.status === "REJECTED").length,
  candidates,
  interpretation: "This is a historical activity/liquidity pre-qualification, not a strategy win-rate or profitability result. The 30-second window starts at the first decoded SOL-quoted trade, not the exact launch timestamp. Reserve-based price and liquidity are on-chain event observations, not executable quotes."
};
const outputDir = resolve("artifacts");
await mkdir(outputDir, { recursive: true });
const path = resolve(outputDir, `pump-candidate-ranking-${date}.json`);
const temp = `${path}.tmp`;
await writeFile(temp, JSON.stringify(output, null, 2) + "\n");
await rename(temp, path);
process.stdout.write(JSON.stringify({ date, filesProcessed: files.length, completeCoins: complete,
  incompleteCoins: candidates.length - complete, qualifiedCoins: output.qualifiedCoins,
  rejectedCoins: output.rejectedCoins, artifact: path }, null, 2) + "\n");
