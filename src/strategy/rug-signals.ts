import { readFileSync } from "node:fs";

/**
 * Anti-rug inputs. Every field is optional so a later Helius CSV can fill the
 * holes without the live bot requiring a key. Absent fields are not treated as
 * passes or failures; only present evidence can reject.
 */
export interface RugSignal {
  mint: string;
  mintAuthorityRevoked?: boolean;
  freezeAuthorityRevoked?: boolean;
  devHoldingPct?: number;
  devSoldPct?: number;
  top10HolderPct?: number;
  bundledBuyPct?: number;
  freshWalletClusterPct?: number;
  lpLockedOrBurned?: boolean;
  honeypot?: boolean;
  creatorPriorRugs?: number;
  socialsOk?: boolean;
}

export interface LaunchRugEvidence {
  creatorHoldPct: number;
  creatorSoldInSlot: boolean;
  sameSlotBuyers: number;
  sameSlotTopShare: number | null;
  graduated: boolean;
}

export interface RugThresholds {
  maxCreatorHoldPct: number;
  rejectCreatorSoldInSlot: boolean;
  minSameSlotBuyers: number;
  /** Null disables the same-slot concentration check. */
  maxSameSlotTopShare: number | null;
  maxDevHoldingPct: number;
  maxDevSoldPct: number;
  maxTop10HolderPct: number;
  maxBundledBuyPct: number;
  maxFreshWalletClusterPct: number;
  maxCreatorPriorRugs: number;
}

export const DEFAULT_RUG_THRESHOLDS: RugThresholds = Object.freeze({
  maxCreatorHoldPct: 4,
  rejectCreatorSoldInSlot: true,
  minSameSlotBuyers: 1,
  maxSameSlotTopShare: 0.7,
  maxDevHoldingPct: 6,
  maxDevSoldPct: 1,
  maxTop10HolderPct: 45,
  maxBundledBuyPct: 40,
  maxFreshWalletClusterPct: 55,
  maxCreatorPriorRugs: 0
});

export interface RugDecision {
  ok: boolean;
  reasons: string[];
}

function badNumber(value: number | undefined, max: number, reason: string, reasons: string[]): void {
  if (value === undefined || !Number.isFinite(value)) return;
  if (value > max) reasons.push(reason);
}

/** Free launch-block evidence plus any CSV/Helius fields that are actually present. */
export function evaluateRugFilters(
  launch: LaunchRugEvidence,
  signal: RugSignal | null,
  thresholds: RugThresholds
): RugDecision {
  const reasons: string[] = [];
  if (launch.creatorHoldPct > thresholds.maxCreatorHoldPct) {
    reasons.push("creator_hold");
  }
  if (thresholds.rejectCreatorSoldInSlot && launch.creatorSoldInSlot) {
    reasons.push("creator_sold_in_launch_block");
  }
  if (launch.sameSlotBuyers < thresholds.minSameSlotBuyers) {
    reasons.push("thin_launch_block");
  }
  if (thresholds.maxSameSlotTopShare !== null && launch.sameSlotTopShare !== null &&
      launch.sameSlotTopShare > thresholds.maxSameSlotTopShare) {
    reasons.push("same_slot_concentration");
  }
  if (signal) {
    if (signal.mintAuthorityRevoked === false) reasons.push("mint_authority");
    if (signal.freezeAuthorityRevoked === false) reasons.push("freeze_authority");
    badNumber(signal.devHoldingPct, thresholds.maxDevHoldingPct, "dev_holding", reasons);
    badNumber(signal.devSoldPct, thresholds.maxDevSoldPct, "dev_sold", reasons);
    badNumber(signal.top10HolderPct, thresholds.maxTop10HolderPct, "top10_holders", reasons);
    badNumber(signal.bundledBuyPct, thresholds.maxBundledBuyPct, "bundled_buys", reasons);
    badNumber(signal.freshWalletClusterPct, thresholds.maxFreshWalletClusterPct, "fresh_wallet_cluster", reasons);
    if (signal.honeypot === true) reasons.push("honeypot");
    if (signal.creatorPriorRugs !== undefined && signal.creatorPriorRugs > thresholds.maxCreatorPriorRugs) {
      reasons.push("creator_rug_history");
    }
    if (signal.socialsOk === false) reasons.push("socials");
    if (launch.graduated && signal.lpLockedOrBurned === false) reasons.push("lp_unlocked");
  }
  return { ok: reasons.length === 0, reasons };
}

function parseBool(value: string): boolean | undefined {
  const text = value.trim().toLowerCase();
  if (text === "") return undefined;
  if (["1", "true", "yes", "y"].includes(text)) return true;
  if (["0", "false", "no", "n"].includes(text)) return false;
  return undefined;
}
function parseNum(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const CSV_COLUMNS = [
  "mint", "mint_authority_revoked", "freeze_authority_revoked", "dev_holding_pct",
  "dev_sold_pct", "top10_holder_pct", "bundled_buy_pct", "fresh_wallet_cluster_pct",
  "lp_locked_or_burned", "honeypot", "creator_prior_rugs", "socials_ok"
] as const;

/** Parse the rug CSV Jeremy is collecting. Unknown columns are ignored. `outcome` is never used as a feature. */
export function parseRugCsv(text: string): Map<string, RugSignal> {
  const lines = text.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith("#"));
  const header = lines[0]?.split(",").map(cell => cell.trim().toLowerCase()) ?? [];
  if (!header.includes("mint")) throw new Error("Rug CSV needs a mint column.");
  const index = new Map(header.map((name, position) => [name, position]));
  const out = new Map<string, RugSignal>();
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const mint = cells[index.get("mint") ?? 0]?.trim() ?? "";
    if (!mint) continue;
    const signal: RugSignal = { mint };
    const bool = (column: typeof CSV_COLUMNS[number], key: keyof RugSignal) => {
      const position = index.get(column);
      if (position === undefined) return;
      const parsed = parseBool(cells[position] ?? "");
      if (parsed !== undefined) (signal as unknown as Record<string, boolean>)[key] = parsed;
    };
    const num = (column: typeof CSV_COLUMNS[number], key: keyof RugSignal) => {
      const position = index.get(column);
      if (position === undefined) return;
      const parsed = parseNum(cells[position] ?? "");
      if (parsed !== undefined) (signal as unknown as Record<string, number>)[key] = parsed;
    };
    bool("mint_authority_revoked", "mintAuthorityRevoked");
    bool("freeze_authority_revoked", "freezeAuthorityRevoked");
    num("dev_holding_pct", "devHoldingPct");
    num("dev_sold_pct", "devSoldPct");
    num("top10_holder_pct", "top10HolderPct");
    num("bundled_buy_pct", "bundledBuyPct");
    num("fresh_wallet_cluster_pct", "freshWalletClusterPct");
    bool("lp_locked_or_burned", "lpLockedOrBurned");
    bool("honeypot", "honeypot");
    num("creator_prior_rugs", "creatorPriorRugs");
    bool("socials_ok", "socialsOk");
    out.set(mint, signal);
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (char === "\"" && line[i + 1] === "\"") {
      current += "\"";
      i += 1;
    } else if (char === "\"") quoted = !quoted;
    else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else current += char;
  }
  cells.push(current);
  return cells;
}

export function loadRugCsv(path: string): Map<string, RugSignal> {
  try {
    return parseRugCsv(readFileSync(path, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return new Map();
    throw error;
  }
}

export interface HeliusAssetLike {
  id?: string;
  token_info?: {
    mint_authority?: string | null;
    freeze_authority?: string | null;
  };
  ownership?: { owner?: string };
  authorities?: Array<{ address?: string; scopes?: string[] }>;
}

/** Map a Helius DAS asset into rug fields we can actually see. Does not invent holder percentages. */
export function rugFromHeliusAsset(asset: HeliusAssetLike): RugSignal | null {
  const mint = asset.id?.trim();
  if (!mint) return null;
  const info = asset.token_info;
  const signal: RugSignal = { mint };
  if (info && "mint_authority" in info) signal.mintAuthorityRevoked = info.mint_authority == null || info.mint_authority === "";
  if (info && "freeze_authority" in info) signal.freezeAuthorityRevoked = info.freeze_authority == null || info.freeze_authority === "";
  return signal;
}

export interface HeliusCache {
  [mint: string]: RugSignal;
}

/**
 * One getAssetBatch for mints not already cached. Chunked, never looped.
 * Free-tier friendly: callers should pass only new candidates.
 */
export async function fetchHeliusRugSignals(input: {
  apiKey: string;
  mints: string[];
  cache: HeliusCache;
  fetchImpl?: typeof fetch;
  maxBatch?: number;
  /** getAssetBatch is 10 credits per call. Stop before this running total. */
  creditLedger?: { used: number; cap: number };
}): Promise<HeliusCache> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const missing = [...new Set(input.mints.map(mint => mint.trim()).filter(Boolean))]
    .filter(mint => !input.cache[mint]);
  const chunkSize = Math.min(100, input.maxBatch ?? 20);
  for (let offset = 0; offset < missing.length; offset += chunkSize) {
    if (input.creditLedger && input.creditLedger.used + 10 > input.creditLedger.cap) break;
    const ids = missing.slice(offset, offset + chunkSize);
    if (input.creditLedger) input.creditLedger.used += 10;
    const response = await fetchImpl(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(input.apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "rug-batch",
        method: "getAssetBatch",
        params: { ids }
      })
    });
    if (!response.ok) throw new Error(`Helius getAssetBatch failed with HTTP ${response.status}`);
    const payload = await response.json() as { result?: HeliusAssetLike[]; error?: { message?: string } };
    if (payload.error) throw new Error(payload.error.message ?? "Helius getAssetBatch error");
    const returned = new Set<string>();
    for (const asset of payload.result ?? []) {
      const signal = rugFromHeliusAsset(asset);
      if (!signal) continue;
      input.cache[signal.mint] = signal;
      returned.add(signal.mint);
    }
    for (const id of ids) if (!returned.has(id)) input.cache[id] = { mint: id };
  }
  return input.cache;
}
