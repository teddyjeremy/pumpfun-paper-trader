/**
 * Sample pump.fun launches across the last 7 days from public Solana RPC
 * plus GeckoTerminal candles and trades. No API key. Resumable.
 *
 *   node scripts/collect-public-history.mjs
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const RPCS = [
  "https://public.rpc.solanavibestation.com",
  "https://api.mainnet-beta.solana.com"
];
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const WSOL = "So11111111111111111111111111111111111111112";
const OUT = resolve("data/public-history");
const SUPPLY_UI = 1_000_000_000;
const SAMPLES_PER_DAY = 16;
const HUNT_SLOTS = 45;
const CANDLE_MINUTES = 180;

let rpcCursor = 0;

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}
function dayKey(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}
function num(value, digits = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toPrecision(digits));
}

async function rpc(method, params, attempt = 0) {
  const url = RPCS[rpcCursor % RPCS.length];
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(45_000)
    });
    if (response.status === 429 || response.status >= 500) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (payload.error) {
      const code = payload.error.code;
      const message = String(payload.error.message ?? "");
      if (code === -32007 || code === -32009 || code === -32004 || code === -32001 ||
          /skipped|not available|ledger jump|cleaned up|first available block/i.test(message)) {
        return null;
      }
      if (code === -32015 || code === 429 || /rate|congested|too many/i.test(message)) {
        throw new Error(message);
      }
      throw new Error(`${code} ${message}`);
    }
    return payload.result;
  } catch (error) {
    if (attempt >= 5) throw error;
    rpcCursor += 1;
    await sleep(400 * 2 ** attempt);
    return rpc(method, params, attempt + 1);
  }
}

async function gecko(path, attempt = 0) {
  const response = await fetch(`https://api.geckoterminal.com/api/v2${path}`, {
    headers: { accept: "application/json", "user-agent": "pumpfun-paper-research/0.1" },
    signal: AbortSignal.timeout(30_000)
  });
  if (response.status === 429 || response.status >= 500) {
    if (attempt >= 5) throw new Error(`Gecko ${response.status} ${path}`);
    await sleep(1200 * (attempt + 1));
    return gecko(path, attempt + 1);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    if (attempt >= 3) return null;
    await sleep(500);
    return gecko(path, attempt + 1);
  }
  await sleep(220);
  return response.json();
}

function accountMeta(tx) {
  const message = tx.transaction.message;
  const raw = message.accountKeys ?? [];
  const pubs = raw.map(key => typeof key === "string" ? key : key.pubkey);
  let signers;
  if (raw.length > 0 && typeof raw[0] === "object" && raw[0] && "signer" in raw[0]) {
    signers = raw.filter(key => key.signer).map(key => key.pubkey);
  } else {
    const required = message.header?.numRequiredSignatures ?? 1;
    signers = pubs.slice(0, required);
  }
  return { pubs, signers };
}

function instructionNames(tx) {
  return (tx.meta?.logMessages ?? [])
    .filter(line => line.startsWith("Program log: Instruction:"))
    .map(line => line.slice("Program log: Instruction:".length).trim());
}

function isCreate(names) {
  return names.some(name => name === "Create" || name === "CreateV2");
}

function tokenRows(tx, mint = "") {
  const rows = tx.meta?.postTokenBalances ?? [];
  return mint ? rows.filter(row => row.mint === mint) : rows;
}

function creatorHoldPct(tx, mint, creator) {
  let ui = 0;
  for (const row of tokenRows(tx, mint)) {
    if (row.owner !== creator) continue;
    ui += Number(row.uiTokenAmount?.uiAmount ?? 0);
  }
  if (!Number.isFinite(ui) || ui <= 0) return 0;
  return num(ui / SUPPLY_UI * 100, 4);
}

function parseCreate(tx, blockTime) {
  const names = instructionNames(tx);
  if (!isCreate(names) || tx.meta?.err) return null;
  const logs = tx.meta?.logMessages ?? [];
  if (!logs.some(line => line.includes(PUMP))) return null;
  const { signers } = accountMeta(tx);
  const creator = signers[0];
  if (!creator) return null;
  const mints = [...new Set(tokenRows(tx).map(row => row.mint).filter(mint => mint.endsWith("pump")))];
  if (mints.length !== 1) return null;
  const mint = mints[0];
  const pre = tx.meta.preBalances?.[0] ?? 0;
  const post = tx.meta.postBalances?.[0] ?? 0;
  return {
    mint,
    creator,
    createdAt: blockTime,
    creatorHoldPct: creatorHoldPct(tx, mint, creator),
    creatorSolIn: num(Math.max(0, (pre - post) / 1e9), 4),
    feeLamports: tx.meta.fee ?? 0
  };
}

function sameSlotFlow(block, mint, creator) {
  const buyers = new Map();
  let creatorSold = false;
  for (const tx of block.transactions) {
    if (tx.meta?.err) continue;
    const mentions = (tx.meta?.postTokenBalances ?? []).some(row => row.mint === mint)
      || (tx.meta?.preTokenBalances ?? []).some(row => row.mint === mint);
    if (!mentions) continue;
    const names = instructionNames(tx);
    const isSell = names.some(name => name.startsWith("Sell"));
    const isBuy = names.some(name => name.startsWith("Buy") || name === "BuyExactQuoteInV3");
    const { signers } = accountMeta(tx);
    const wallet = signers[0];
    if (!wallet) continue;
    if (isSell && wallet === creator) creatorSold = true;
    if (!isBuy) continue;
    const pre = tx.meta.preBalances?.[0] ?? 0;
    const post = tx.meta.postBalances?.[0] ?? 0;
    const sol = Math.max(0, (pre - post) / 1e9);
    const prev = buyers.get(wallet) ?? 0;
    buyers.set(wallet, prev + sol);
  }
  const rows = [...buyers.entries()].map(([wallet, sol]) => ({ wallet, sol: num(sol, 4) }))
    .sort((a, b) => b.sol - a.sol)
    .slice(0, 12);
  const total = rows.reduce((sum, row) => sum + row.sol, 0);
  const top = rows[0]?.sol ?? 0;
  return {
    sameSlotBuyers: rows.length,
    sameSlotBuySol: num(total, 4),
    sameSlotTopShare: total > 0 ? num(top / total, 4) : null,
    creatorSoldInSlot: creatorSold,
    sameSlotWallets: rows
  };
}

async function blockTime(slot) {
  return rpc("getBlockTime", [slot]);
}

async function slotAt(targetSeconds, latestSlot) {
  let lo = Math.max(1, latestSlot - Math.floor(9 * 86400 * 5));
  let hi = latestSlot;
  for (let i = 0; i < 28 && hi - lo > 80; i += 1) {
    const mid = Math.floor((lo + hi) / 2);
    const time = await blockTime(mid);
    if (time == null) {
      hi -= Math.floor((hi - lo) / 3) || 1;
      continue;
    }
    if (time < targetSeconds) lo = mid;
    else hi = mid;
  }
  return lo;
}

async function loadBlock(slot) {
  return rpc("getBlock", [slot, {
    encoding: "json",
    transactionDetails: "full",
    rewards: false,
    maxSupportedTransactionVersion: 1
  }]);
}

function takeCreates(block, slot, stats, kept) {
  if (!block?.blockTime || !Array.isArray(block.transactions)) {
    stats.empty += 1;
    return 0;
  }
  let taken = 0;
  for (const tx of block.transactions) {
    const created = parseCreate(tx, block.blockTime);
    if (!created) continue;
    stats.createsSeen += 1;
    if (typeof tx.meta?.fee === "number") stats.fees.push(tx.meta.fee);
    if (kept.has(created.mint) || taken >= 1) continue;
    kept.set(created.mint, { ...created, slot, ...sameSlotFlow(block, created.mint, created.creator) });
    taken += 1;
  }
  return taken;
}

async function discover(startSeconds, endSeconds) {
  const latest = await rpc("getSlot", [{ commitment: "confirmed" }]);
  const origin = await slotAt(startSeconds, latest);
  const originTime = await blockTime(origin) ?? startSeconds;
  const latestTime = await blockTime(latest) ?? endSeconds;
  const slotsPerSec = Math.max(2, (latest - origin) / Math.max(1, latestTime - originTime));
  console.log(`slot ${origin} @ ${new Date(originTime * 1000).toISOString()} -> ${latest} (${slotsPerSec.toFixed(2)} slots/s)`);
  const kept = new Map();
  const stats = { blocks: 0, empty: 0, createsSeen: 0, fees: [] };
  const spacing = 86400 / SAMPLES_PER_DAY;
  for (let stamp = startSeconds + spacing / 2; stamp < endSeconds; stamp += spacing) {
    let slot = Math.min(latest - 2, Math.max(origin, origin + Math.round((stamp - originTime) * slotsPerSec)));
    for (let step = 0; step < HUNT_SLOTS && slot < latest; step += 1, slot += 1) {
      const block = await loadBlock(slot);
      stats.blocks += 1;
      const taken = takeCreates(block, slot, stats, kept);
      if (stats.blocks % 50 === 0) {
        console.log(`scanned ${stats.blocks} blocks, kept ${kept.size}, creates seen ${stats.createsSeen}`);
      }
      if (taken > 0) break;
    }
  }
  const fees = stats.fees.sort((a, b) => a - b);
  const quantile = p => fees.length === 0 ? null : fees[Math.min(fees.length - 1, Math.floor((fees.length - 1) * p))];
  return {
    launches: [...kept.values()],
    stats: {
      ...stats,
      fees: undefined,
      feeSamples: fees.length,
      feeP50: quantile(0.5),
      feeP75: quantile(0.75),
      feeP90: quantile(0.9),
      slotsPerSec,
      originSlot: origin,
      latestSlot: latest
    }
  };
}

function poolRows(payload) {
  const rows = [];
  for (const item of payload?.data ?? []) {
    const attributes = item.attributes ?? {};
    const quote = String(item.relationships?.quote_token?.data?.id ?? "").split("_").pop();
    const createdAt = Date.parse(attributes.pool_created_at ?? "") / 1000;
    rows.push({
      dex: item.relationships?.dex?.data?.id ?? "other",
      address: attributes.address,
      createdAt: Number.isFinite(createdAt) ? Math.floor(createdAt) : null,
      reserveUsd: Number(attributes.reserve_in_usd ?? 0),
      name: attributes.name ?? "",
      solQuote: quote === WSOL
    });
  }
  return rows.filter(row => row.address && row.createdAt);
}

function choosePools(rows) {
  const sorted = [...rows].sort((a, b) => a.createdAt - b.createdAt);
  const curve = sorted.find(row => row.dex === "pump-fun");
  const graduated = sorted.find(row => row.dex === "pumpswap" || row.dex.startsWith("raydium"));
  const launch = curve ?? graduated ?? sorted[0] ?? null;
  return { launch, graduated: launch && graduated && graduated.address !== launch.address ? graduated : null };
}

async function candlesFor(pool, createdAt) {
  const before = createdAt + (CANDLE_MINUTES + 5) * 60;
  const payload = await gecko(`/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=${CANDLE_MINUTES + 20}&currency=usd&before_timestamp=${before}`);
  const list = payload?.data?.attributes?.ohlcv_list ?? [];
  return list
    .map(row => [Number(row[0]), num(row[1]), num(row[2]), num(row[3]), num(row[4]), num(row[5], 4)])
    .filter(row => row[0] >= createdAt - 120 && row[0] <= createdAt + CANDLE_MINUTES * 60)
    .sort((a, b) => a[0] - b[0]);
}

async function tradesFor(pool, from, to) {
  const payload = await gecko(`/networks/solana/pools/${pool}/trades?trade_volume_in_usd_greater_than=0`);
  const trades = [];
  for (const item of payload?.data ?? []) {
    const attributes = item.attributes ?? {};
    const time = Date.parse(attributes.block_timestamp ?? "") / 1000;
    if (!Number.isFinite(time) || time < from || time > to) continue;
    const side = attributes.kind === "sell" ? "s" : attributes.kind === "buy" ? "b" : null;
    if (!side) continue;
    trades.push([
      Math.floor(time),
      side,
      num(attributes.volume_in_usd, 4),
      attributes.tx_from_address ?? "",
      num(side === "b" ? attributes.price_to_in_usd : attributes.price_from_in_usd)
    ]);
  }
  trades.sort((a, b) => a[0] - b[0]);
  return trades.slice(0, 80);
}

async function solPrice() {
  const payload = await gecko(`/simple/networks/solana/token_price/${WSOL}`);
  const price = Number(payload?.data?.attributes?.token_prices?.[WSOL]);
  if (!Number.isFinite(price) || price <= 0) throw new Error("SOL price unavailable");
  return price;
}

async function existingMints() {
  try {
    const text = await readFile(resolve(OUT, "coins.jsonl"), "utf8");
    return new Set(text.split("\n").filter(Boolean).map(line => JSON.parse(line).mint));
  } catch {
    return new Set();
  }
}

async function enrich(launches) {
  const done = await existingMints();
  let wrote = 0;
  let skipped = 0;
  for (const launch of launches) {
    if (done.has(launch.mint)) continue;
    try {
      const payload = await gecko(`/networks/solana/tokens/${launch.mint}/pools?page=1`);
      const { launch: pool, graduated } = choosePools(poolRows(payload));
      if (!pool) {
        skipped += 1;
        continue;
      }
      const createdAt = pool.createdAt ?? launch.createdAt;
      const candleRows = await candlesFor(pool.address, createdAt);
      if (candleRows.length < 5) {
        skipped += 1;
        continue;
      }
      const trades = await tradesFor(pool.address, createdAt - 60, createdAt + CANDLE_MINUTES * 60);
      let graduatedRecord = null;
      if (graduated) {
        const graduatedCandles = await candlesFor(graduated.address, graduated.createdAt);
        if (graduatedCandles.length >= 5) {
          graduatedRecord = {
            dex: graduated.dex,
            pool: graduated.address,
            createdAt: graduated.createdAt,
            reserveUsd: num(graduated.reserveUsd, 4),
            candles: graduatedCandles
          };
        }
      }
      const symbol = String(pool.name.split("/")[0] ?? "").trim();
      const record = {
        mint: launch.mint,
        symbol,
        creator: launch.creator,
        createdAt,
        discoveredAt: launch.createdAt,
        dex: pool.dex,
        pool: pool.address,
        solQuote: pool.solQuote,
        reserveUsd: num(pool.reserveUsd, 4),
        creatorHoldPct: launch.creatorHoldPct,
        creatorSolIn: launch.creatorSolIn,
        creatorSoldInSlot: launch.creatorSoldInSlot,
        sameSlotBuyers: launch.sameSlotBuyers,
        sameSlotBuySol: launch.sameSlotBuySol,
        sameSlotTopShare: launch.sameSlotTopShare,
        sameSlotWallets: launch.sameSlotWallets,
        candles: candleRows,
        trades,
        graduated: graduatedRecord
      };
      await appendFile(resolve(OUT, "coins.jsonl"), `${JSON.stringify(record)}\n`);
      done.add(launch.mint);
      wrote += 1;
      if (wrote % 10 === 0) console.log(`enriched ${wrote}, skipped ${skipped}`);
      await sleep(180);
    } catch (error) {
      console.error("enrich failed", launch.mint, error instanceof Error ? error.message : error);
      await sleep(800);
    }
  }
  return { wrote, skipped, total: done.size };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const endSeconds = Math.floor(Date.now() / 1000);
  const startSeconds = endSeconds - 7 * 86400;
  const price = await solPrice();
  console.log(`SOL $${price.toFixed(2)}. Discovering ${new Date(startSeconds * 1000).toISOString()} -> ${new Date(endSeconds * 1000).toISOString()}`);
  const { launches, stats } = await discover(startSeconds, endSeconds);
  await writeFile(resolve(OUT, "launches.json"), JSON.stringify(launches));
  console.log(`discovery kept ${launches.length}`);
  const enrichment = await enrich(launches);
  const days = {};
  try {
    const lines = (await readFile(resolve(OUT, "coins.jsonl"), "utf8")).split("\n").filter(Boolean);
    for (const line of lines) {
      const row = JSON.parse(line);
      const key = dayKey(row.createdAt);
      days[key] = (days[key] ?? 0) + 1;
    }
  } catch { /* first run may still be empty */ }
  const manifest = {
    source: "solana public RPC getBlock samples of pump Create/CreateV2, plus GeckoTerminal pools, minute OHLCV and recent trades",
    pumpFrontend: "blocked by Cloudflare from this environment",
    helius: "not used; HELIUS_API_KEY was not available",
    window: { startSeconds, endSeconds },
    solUsd: price,
    venueFeeBpsPerSide: 125,
    feeLamportsPerTxP75: stats.feeP75,
    notes: [
      "Sampled slots, not every launch. Trade counts cannot be scaled as if this were the full pump.fun firehose.",
      "reserveUsd is the pool reserve at collection time, not at launch, and is not an entry feature.",
      "same-slot wallet stats come from the create block itself.",
      "Gecko trades are the newest trades still inside the 3-hour candle window when they overlap it."
    ],
    discovery: stats,
    enrichment,
    coinsByDay: days
  };
  await writeFile(resolve(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ coinsByDay: days, enrichment, feeP75: stats.feeP75, createsSeen: stats.createsSeen, blocks: stats.blocks }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
