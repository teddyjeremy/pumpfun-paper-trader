import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isSolQuoteMint } from "../src/ingestion/trade-flow.js";

type Trade = {
  mint: string; solAmount: string; quoteAmount?: string; tokenAmount: string; isBuy: boolean; user: string;
  timestamp: string; virtualSolReserves: string; virtualQuoteReserves?: string; virtualTokenReserves: string;
  realSolReserves: string; realQuoteReserves?: string; quoteMint: string;
};
type CoinRecord = {
  index: number;
  mint: string;
  launch?: { blockTime?: number };
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
const artifactsDir = resolve("artifacts");
const discovery = JSON.parse(await readFile(resolve(artifactsDir, `pump-launch-discovery-${date}.json`), "utf8")) as { requestedLocalDate: string; launches: Array<{ event: { mint: string } }> };
const screening = JSON.parse(await readFile(resolve(artifactsDir, `pump-launch-screen-${date}.json`), "utf8")) as { date: string; status: string; selectedLaunchIndexes: number[] };
const checkpoint = JSON.parse(await readFile(resolve(artifactsDir, "checkpoint.json"), "utf8")) as { date: string; selectedLaunchIndexes: number[]; nextCandidateIndex: number };
if (discovery.requestedLocalDate !== date || screening.date !== date || screening.status !== "COMPLETE" ||
    checkpoint.date !== date || JSON.stringify(screening.selectedLaunchIndexes) !== JSON.stringify(checkpoint.selectedLaunchIndexes)) {
  throw new Error("Ranking requires matching discovery, screening and replay checkpoints for this date.");
}
const directory = resolve(artifactsDir, "coins");
const selected = screening.selectedLaunchIndexes.slice(0, checkpoint.nextCandidateIndex);
const files = selected.map(index => {
  const mint = discovery.launches[index]?.event.mint;
  if (!mint) throw new Error(`Selected launch index ${index} is missing from discovery.`);
  return { index, file: `${String(index).padStart(4, "0")}-${mint}.json` };
});
const candidates: Candidate[] = [];
for (const selectedFile of files) {
  const file = selectedFile.file;
  let coin: CoinRecord;
  try { coin = JSON.parse(await readFile(resolve(directory, file), "utf8")) as CoinRecord; }
  catch { candidates.push({ mint: discovery.launches[selectedFile.index]!.event.mint, status: "INCOMPLETE", uniqueBuyers30s: 0, buyTrades30s: 0, sellTrades30s: 0, buyVolumeSol30s: 0, priceMovePct30s: null, peakPriceMovePct30s: null, realSolLiquidityAt30s: null, reasons: ["Selected coin has not yet produced a complete per-coin artifact."] }); continue; }
  if (coin.index !== selectedFile.index || coin.mint !== discovery.launches[selectedFile.index]!.event.mint) throw new Error(`Coin artifact identity mismatch: ${file}`);
  if (coin.collection?.status !== "COMPLETE" || !Array.isArray(coin.transactions)) {
    candidates.push({ mint: coin.mint, status: "INCOMPLETE", uniqueBuyers30s: 0, buyTrades30s: 0,
      sellTrades30s: 0, buyVolumeSol30s: 0, priceMovePct30s: null, peakPriceMovePct30s: null,
      realSolLiquidityAt30s: null, reasons: ["Full historical transaction collection is incomplete."] });
    continue;
  }
  const trades = coin.transactions.flatMap(tx => tx.tradeEvents ?? [])
    .filter(event => event.mint === coin.mint && isSolQuoteMint(event.quoteMint))
    .map(event => {
      const quoteAmount = BigInt(event.quoteAmount ?? "0");
      const legacyAmount = BigInt(event.solAmount ?? "0");
      const quoteReserves = BigInt(event.virtualQuoteReserves ?? "0");
      const solReserves = BigInt(event.virtualSolReserves ?? "0");
      const realQuoteReserves = BigInt(event.realQuoteReserves ?? "0");
      const realSolReserves = BigInt(event.realSolReserves ?? "0");
      return {
        ...event, time: Number(event.timestamp),
        sol: Number(quoteAmount > 0n ? quoteAmount : legacyAmount) / 1e9,
        price: Number(quoteReserves > 0n ? quoteReserves : solReserves) / Number(event.virtualTokenReserves),
        liquidity: Number(realQuoteReserves > 0n ? realQuoteReserves : realSolReserves) / 1e9
      };
    })
    .filter(event => Number.isSafeInteger(event.time) && event.time >= 0 &&
      Number.isFinite(event.price) && event.price > 0 && Number.isFinite(event.sol) && event.sol >= 0)
    .sort((a, b) => a.time - b.time);
  const launchTime = coin.launch?.blockTime;
  const window = Number.isSafeInteger(launchTime)
    ? trades.filter(event => event.time >= launchTime! && event.time <= launchTime! + 30)
    : [];
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
  if (!Number.isSafeInteger(launchTime)) reasons.push("Launch timestamp is missing; cannot evaluate the true first 30 seconds.");
  if (buyers.size < minBuyers) reasons.push(`Only ${buyers.size} unique buyers in first 30 seconds; need ${minBuyers}.`);
  if (buys.length < minBuyTrades) reasons.push(`Only ${buys.length} buy trades in first 30 seconds; need ${minBuyTrades}.`);
  if (priceMovePct === null || priceMovePct < minMovePct) reasons.push(`End-of-window price movement did not remain at or above ${minMovePct}%.`);
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
  selectedCoins: selected.length, filesProcessed: files.length, completeCoins: complete, incompleteCoins: candidates.length - complete,
  qualifiedCoins: candidates.filter(row => row.status === "QUALIFIED").length,
  rejectedCoins: candidates.filter(row => row.status === "REJECTED").length,
  candidates,
  interpretation: "This is a historical activity/liquidity pre-qualification, not a strategy win-rate or profitability result. The 30-second window begins at the decoded CreateEvent block time. Price movement is measured from the first SOL-quoted buy to the final observed SOL-quoted trade in that window. Reserve-based price and liquidity are on-chain event observations, not executable quotes."
};
const outputDir = resolve("artifacts");
await mkdir(outputDir, { recursive: true });
const path = resolve(outputDir, `pump-candidate-ranking-${date}.json`);
const temp = `${path}.tmp`;
await writeFile(temp, JSON.stringify(output, null, 2) + "\n");
await rename(temp, path);
process.stdout.write(JSON.stringify({ date, selectedCoins: selected.length, filesProcessed: files.length, completeCoins: complete,
  incompleteCoins: candidates.length - complete, qualifiedCoins: output.qualifiedCoins,
  rejectedCoins: output.rejectedCoins, artifact: path }, null, 2) + "\n");
