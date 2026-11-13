import { buildHeliusRpcUrl } from "./helius.js";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const HOLDER_ACCOUNT_LIMIT = 20;
export const HOLDER_REJECT_BPS = 2_000;

export interface HolderConcentrationAccount {
  tokenAccount: string;
  owner: string;
  amount: string;
  shareBps: number;
}

export interface HolderConcentrationSnapshot {
  provider: "helius";
  commitment: "confirmed";
  mint: string;
  supply: string;
  decimals: number;
  observedTokenAccounts: number;
  observedOwners: number;
  largestObservedTokenAccountShareBps: number;
  largestObservedOwnerShareBps: number;
  rejectThresholdBps: number;
  status: "REJECT_OBSERVED" | "UNKNOWN" | "PASS_COMPLETE";
  coverage: "TOP_20_TOKEN_ACCOUNTS_ONLY" | "FULL_TOKEN_ACCOUNT_CENSUS_STABLE";
  dataComplete: boolean;
  censusSlotRange?: { start: number; end: number };
  censusPasses?: number;
  reason: string;
  accounts: HolderConcentrationAccount[];
  observedAt: string;
}

export type HolderConcentrationResult =
  | { status: "OBSERVED"; snapshot: HolderConcentrationSnapshot }
  | { status: "DATA_INCOMPLETE"; mint: string; reason: string };

export interface HolderConcentrationConfig {
  apiKey: string;
  fetcher?: typeof fetch;
}

/**
 * Inspect the top 20 token accounts and resolve each token-account owner.
 * A verified >20% owner concentration is a hard reject. Absence of an
 * observed breach is never a PASS: getTokenLargestAccounts is not a complete
 * enumeration of all token accounts or all balances owned by a wallet.
 */
export async function fetchHolderConcentration(
  mint: string,
  config: HolderConcentrationConfig
): Promise<HolderConcentrationResult> {
  if (!ADDRESS.test(mint)) {
    return { status: "DATA_INCOMPLETE", mint, reason: "Invalid mint address." };
  }
  const fetcher = config.fetcher ?? fetch;
  const url = buildHeliusRpcUrl(config.apiKey);

  const supplyResponse = await rpcCall(fetcher, url, "getTokenSupply", [mint, { commitment: "confirmed" }]);
  if (!supplyResponse.ok) {
    return { status: "DATA_INCOMPLETE", mint, reason: supplyResponse.reason };
  }
  const supplyValue = record(record(supplyResponse.result)?.value);
  const supply = parsePositiveInteger(supplyValue?.amount);
  const decimals = supplyValue?.decimals;
  if (supply === null || !Number.isSafeInteger(decimals) || (decimals as number) < 0) {
    return { status: "DATA_INCOMPLETE", mint, reason: "Token supply or decimals are missing or invalid." };
  }

  const largestResponse = await rpcCall(fetcher, url, "getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
  if (!largestResponse.ok) {
    return { status: "DATA_INCOMPLETE", mint, reason: largestResponse.reason };
  }
  const largestValue = record(largestResponse.result)?.value;
  if (!Array.isArray(largestValue) || largestValue.length === 0 || largestValue.length > HOLDER_ACCOUNT_LIMIT) {
    return { status: "DATA_INCOMPLETE", mint, reason: "Helius returned an empty or malformed largest-account list." };
  }
  const largestAccounts = largestValue.map(item => {
    const value = record(item);
    return {
      address: value?.address,
      amount: parsePositiveInteger(value?.amount)
    };
  });
  if (largestAccounts.some(item => typeof item.address !== "string" || !ADDRESS.test(item.address) || item.amount === null)) {
    return { status: "DATA_INCOMPLETE", mint, reason: "Largest-account entries contain invalid addresses or balances." };
  }
  const addresses = largestAccounts.map(item => item.address as string);
  if (new Set(addresses).size !== addresses.length) {
    return { status: "DATA_INCOMPLETE", mint, reason: "Largest-account response contains duplicate token accounts." };
  }

  const accountsResponse = await rpcCall(fetcher, url, "getMultipleAccounts", [
    addresses,
    { encoding: "jsonParsed", commitment: "confirmed" }
  ]);
  if (!accountsResponse.ok) {
    return { status: "DATA_INCOMPLETE", mint, reason: accountsResponse.reason };
  }
  const accountValues = record(accountsResponse.result)?.value;
  if (!Array.isArray(accountValues) || accountValues.length !== addresses.length) {
    return { status: "DATA_INCOMPLETE", mint, reason: "Token-account owner lookup returned an incomplete result." };
  }

  const accounts: HolderConcentrationAccount[] = [];
  const ownerAmounts = new Map<string, bigint>();
  for (let index = 0; index < accountValues.length; index += 1) {
    const account = record(accountValues[index]);
    const data = record(account?.data);
    const parsed = record(data?.parsed);
    const info = record(parsed?.info);
    const tokenAmount = record(info?.tokenAmount);
    const owner = info?.owner;
    const accountMint = info?.mint;
    const amount = parsePositiveInteger(tokenAmount?.amount);
    const expectedAmount = largestAccounts[index]!.amount;
    if (account === null || typeof owner !== "string" || !ADDRESS.test(owner) ||
        accountMint !== mint || amount === null || amount !== expectedAmount) {
      return {
        status: "DATA_INCOMPLETE",
        mint,
        reason: "A token-account owner or balance could not be verified against the largest-account snapshot."
      };
    }
    ownerAmounts.set(owner, (ownerAmounts.get(owner) ?? 0n) + amount);
    accounts.push({
      tokenAccount: addresses[index]!,
      owner,
      amount: amount.toString(),
      shareBps: toCeilingBps(amount, supply)
    });
  }

  const largestAccount = largestAccounts.reduce((max, item) =>
    item.amount! > max ? item.amount! : max, 0n);
  const largestOwner = [...ownerAmounts.values()].reduce((max, amount) => amount > max ? amount : max, 0n);
  const breached = largestOwner * 10_000n > supply * BigInt(HOLDER_REJECT_BPS);
  return {
    status: "OBSERVED",
    snapshot: {
      provider: "helius",
      commitment: "confirmed",
      mint,
      supply: supply.toString(),
      decimals: decimals as number,
      observedTokenAccounts: accounts.length,
      observedOwners: ownerAmounts.size,
      largestObservedTokenAccountShareBps: toCeilingBps(largestAccount, supply),
      largestObservedOwnerShareBps: toCeilingBps(largestOwner, supply),
      rejectThresholdBps: HOLDER_REJECT_BPS,
      status: breached ? "REJECT_OBSERVED" : "UNKNOWN",
      coverage: "TOP_20_TOKEN_ACCOUNTS_ONLY",
      dataComplete: false,
      reason: breached
        ? "An observed wallet owns more than 20% of total token supply; reject."
        : "No >20% owner was observed in the top 20 token accounts, but this is not a complete holder census and cannot clear the candidate.",
      accounts,
      observedAt: new Date().toISOString()
    }
  };
}


const HOLDER_CENSUS_PAGE_SIZE = 1_000;
const HOLDER_CENSUS_MAX_PAGES = 5;
const HOLDER_CENSUS_MAX_SLOT_SPAN = 120;

interface CensusTokenAccount {
  address: string;
  owner: string;
  mint: string;
  amount: bigint;
}

interface CensusScan {
  accounts: CensusTokenAccount[];
  supply: bigint;
  decimals: number;
  startSlot: number;
  endSlot: number;
}

async function readConfirmedSlot(fetcher: typeof fetch, url: string): Promise<number | null> {
  const response = await rpcCall(fetcher, url, "getSlot", [{ commitment: "confirmed" }]);
  if (!response.ok || !Number.isSafeInteger(response.result) ||
      (response.result as number) < 0) return null;
  return response.result as number;
}

async function readConfirmedSupply(
  fetcher: typeof fetch, url: string, mint: string
): Promise<{ amount: bigint; decimals: number } | null> {
  const response = await rpcCall(fetcher, url, "getTokenSupply", [mint, { commitment: "confirmed" }]);
  if (!response.ok) return null;
  const value = record(record(response.result)?.value);
  const amount = parsePositiveInteger(value?.amount);
  const decimals = value?.decimals;
  if (amount === null || !Number.isSafeInteger(decimals) ||
      (decimals as number) < 0 || (decimals as number) > 18) return null;
  return { amount, decimals: decimals as number };
}

function parseCensusAmount(value: unknown): bigint | null {
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    try { return BigInt(value); } catch { return null; }
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  return null;
}

async function scanAllHolderTokenAccounts(
  mint: string, fetcher: typeof fetch, url: string
): Promise<CensusScan | null> {
  const startSlot = await readConfirmedSlot(fetcher, url);
  const supplyBefore = await readConfirmedSupply(fetcher, url, mint);
  if (startSlot === null || supplyBefore === null) return null;

  const accounts: CensusTokenAccount[] = [];
  const seen = new Set<string>();
  let complete = false;
  for (let page = 1; page <= HOLDER_CENSUS_MAX_PAGES; page += 1) {
    const response = await rpcCall(fetcher, url, "getTokenAccounts", [{
      mint, page, limit: HOLDER_CENSUS_PAGE_SIZE, displayOptions: {}
    }]);
    if (!response.ok) return null;
    const result = record(response.result);
    const items = result?.token_accounts;
    if (!Array.isArray(items) || items.length > HOLDER_CENSUS_PAGE_SIZE) return null;
    for (const item of items) {
      const account = record(item);
      const address = account?.address;
      const owner = account?.owner;
      const accountMint = account?.mint;
      const amount = parseCensusAmount(account?.amount);
      if (typeof address !== "string" || !ADDRESS.test(address) ||
          typeof owner !== "string" || !ADDRESS.test(owner) ||
          accountMint !== mint || amount === null || seen.has(address)) return null;
      seen.add(address);
      accounts.push({ address, owner, mint, amount });
    }
    if (items.length < HOLDER_CENSUS_PAGE_SIZE) {
      complete = true;
      break;
    }
  }
  // A full final page at the configured cap is ambiguous: there may be more
  // accounts, so it must never be labelled a complete census.
  if (!complete || accounts.length === 0) return null;

  const supplyAfter = await readConfirmedSupply(fetcher, url, mint);
  const endSlot = await readConfirmedSlot(fetcher, url);
  if (supplyAfter === null || endSlot === null || supplyAfter.amount !== supplyBefore.amount ||
      supplyAfter.decimals !== supplyBefore.decimals ||
      endSlot < startSlot || endSlot - startSlot > HOLDER_CENSUS_MAX_SLOT_SPAN) return null;

  return { accounts, supply: supplyAfter.amount, decimals: supplyAfter.decimals, startSlot, endSlot };
}

/**
 * Full holder census for entry-risk clearance. Helius pages are scanned twice;
 * both complete scans, token supply and bounded confirmed-slot windows must
 * agree. Any cap, pagination gap, duplicate, malformed account or changing
 * snapshot remains DATA_INCOMPLETE. This is read-only and never mutates chain state.
 */
export async function fetchCompleteHolderConcentration(
  mint: string,
  config: HolderConcentrationConfig
): Promise<HolderConcentrationResult> {
  if (!ADDRESS.test(mint)) {
    return { status: "DATA_INCOMPLETE", mint, reason: "Invalid mint address." };
  }
  const fetcher = config.fetcher ?? fetch;
  const url = buildHeliusRpcUrl(config.apiKey);
  try {
    const first = await scanAllHolderTokenAccounts(mint, fetcher, url);
    if (!first) {
      return { status: "DATA_INCOMPLETE", mint, reason: "First full holder-census pass was incomplete or unstable." };
    }
    const second = await scanAllHolderTokenAccounts(mint, fetcher, url);
    if (!second) {
      return { status: "DATA_INCOMPLETE", mint, reason: "Second full holder-census pass was incomplete or unstable." };
    }
    const canonical = (scan: CensusScan) => scan.accounts
      .map(account => `${account.address}:${account.owner}:${account.amount.toString()}`)
      .sort().join("\\n");
    if (first.supply !== second.supply || first.decimals !== second.decimals || canonical(first) !== canonical(second) ||
        second.endSlot < first.startSlot ||
        second.endSlot - first.startSlot > HOLDER_CENSUS_MAX_SLOT_SPAN * 2) {
      return { status: "DATA_INCOMPLETE", mint, reason: "Repeated full holder-census passes did not produce the same stable account set and supply." };
    }

    const ownerAmounts = new Map<string, bigint>();
    let totalBalances = 0n;
    let largestAccount = 0n;
    const positiveAccounts: HolderConcentrationAccount[] = [];
    for (const account of second.accounts) {
      if (account.amount === 0n) continue;
      totalBalances += account.amount;
      ownerAmounts.set(account.owner, (ownerAmounts.get(account.owner) ?? 0n) + account.amount);
      if (account.amount > largestAccount) largestAccount = account.amount;
      positiveAccounts.push({
        tokenAccount: account.address,
        owner: account.owner,
        amount: account.amount.toString(),
        shareBps: toCeilingBps(account.amount, second.supply)
      });
    }
    if (positiveAccounts.length === 0 || totalBalances !== second.supply) {
      return {
        status: "DATA_INCOMPLETE", mint,
        reason: "Full holder-census balances do not reconcile exactly to the verified token supply."
      };
    }
    const largestOwner = [...ownerAmounts.values()].reduce((max, amount) => amount > max ? amount : max, 0n);
    const largestOwnerShareBps = toCeilingBps(largestOwner, second.supply);
    const breached = largestOwner * 10_000n > second.supply * BigInt(HOLDER_REJECT_BPS);
    return {
      status: "OBSERVED",
      snapshot: {
        provider: "helius",
        commitment: "confirmed",
        mint,
        supply: second.supply.toString(),
        decimals: second.decimals,
        observedTokenAccounts: positiveAccounts.length,
        observedOwners: ownerAmounts.size,
        largestObservedTokenAccountShareBps: toCeilingBps(largestAccount, second.supply),
        largestObservedOwnerShareBps: largestOwnerShareBps,
        rejectThresholdBps: HOLDER_REJECT_BPS,
        status: breached ? "REJECT_OBSERVED" : "PASS_COMPLETE",
        coverage: "FULL_TOKEN_ACCOUNT_CENSUS_STABLE",
        dataComplete: true,
        censusSlotRange: { start: first.startSlot, end: second.endSlot },
        censusPasses: 2,
        reason: breached
          ? "A verified holder owns more than 20% of total token supply; reject."
          : "Two complete, matching token-account censuses and stable supply passed the 20% holder-concentration check.",
        accounts: positiveAccounts,
        observedAt: new Date().toISOString()
      }
    };
  } catch {
    return { status: "DATA_INCOMPLETE", mint, reason: "Full holder-census RPC collection failed closed." };
  }
}

async function rpcCall(
  fetcher: typeof fetch,
  url: string,
  method: string,
  params: unknown[]
): Promise<{ ok: true; result: unknown } | { ok: false; reason: string }> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params })
    });
  } catch {
    return { ok: false, reason: `Helius ${method} request failed before a response.` };
  }
  if (!response.ok) return { ok: false, reason: `Helius ${method} returned HTTP ${response.status}.` };
  let payload: unknown;
  try { payload = await response.json(); }
  catch { return { ok: false, reason: `Helius ${method} returned invalid JSON.` }; }
  const envelope = record(payload);
  if (!envelope || envelope.error || !Object.prototype.hasOwnProperty.call(envelope, "result")) {
    return { ok: false, reason: `Helius ${method} returned an invalid JSON-RPC response.` };
  }
  return { ok: true, result: envelope.result };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parsePositiveInteger(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

function toCeilingBps(amount: bigint, supply: bigint): number {
  return Number((amount * 10_000n + supply - 1n) / supply);
}
