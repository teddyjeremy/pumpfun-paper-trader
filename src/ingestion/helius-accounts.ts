import { buildHeliusRpcUrl, type HeliusRpcConfig } from "./helius.js";
import { decodePumpSwapPoolAccount, PUMP_AMM_PROGRAM_ID, type DecodedPumpSwapPoolAccount, type RawProgramAccount } from "./pump-account-decoder.js";

export interface HeliusAccountReadConfig extends HeliusRpcConfig {
  now?: () => number;
  maxAccountBytes?: number;
  maxPoolCandidates?: number;
}

export interface HeliusAccountSnapshot {
  slot: number;
  commitment: "confirmed" | "finalized";
  observedAt: string;
  accounts: Array<RawProgramAccount | null>;
}

export interface HeliusEpochInfo {
  epoch: number;
  absoluteSlot: number;
  slotIndex: number;
}

/** Fetches the current epoch context used to select Token-2022 transfer fees. */
export async function fetchHeliusEpochInfo(config: HeliusAccountReadConfig): Promise<HeliusEpochInfo> {
  const response = await (config.fetcher ?? fetch)(buildHeliusRpcUrl(config.apiKey), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "paper-epoch-info", method: "getEpochInfo",
      params: [{ commitment: config.commitment ?? "confirmed" }]
    })
  });
  if (!response.ok) throw new Error(`Helius epoch RPC returned HTTP ${response.status}.`);
  const envelope = asRecord(await response.json());
  if (envelope.error) throw new Error("Helius epoch RPC returned a JSON-RPC error.");
  const result = asRecord(envelope.result);
  const epoch = result.epoch;
  const absoluteSlot = result.absoluteSlot;
  const slotIndex = result.slotIndex;
  if (!Number.isSafeInteger(epoch) || (epoch as number) < 0 ||
      !Number.isSafeInteger(absoluteSlot) || (absoluteSlot as number) < 0 ||
      !Number.isSafeInteger(slotIndex) || (slotIndex as number) < 0 ||
      (slotIndex as number) > (absoluteSlot as number)) {
    throw new Error("Helius epoch RPC omitted a valid epoch, absolute slot or slot index.");
  }
  return { epoch: epoch as number, absoluteSlot: absoluteSlot as number, slotIndex: slotIndex as number };
}

function decodeBase64(value: string, maximumBytes: number): Uint8Array {
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Helius account data is not valid base64.");
  }
  const estimatedBytes = Math.floor(value.length * 3 / 4);
  if (estimatedBytes > maximumBytes) throw new Error("Helius account data exceeds the configured size limit.");
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Helius JSON-RPC response is malformed.");
  return value as Record<string, unknown>;
}

function parseContextSlot(value: unknown): number {
  const context = asRecord(value);
  if (!Number.isSafeInteger(context.slot) || (context.slot as number) < 0) {
    throw new Error("Helius account response omitted a valid context slot.");
  }
  return context.slot as number;
}

function parseAccount(
  address: string,
  value: unknown,
  slot: number,
  observedAt: string,
  maxAccountBytes: number
): RawProgramAccount | null {
  if (value === null) return null;
  const account = asRecord(value);
  if (typeof account.owner !== "string" || typeof account.data !== "object" || !Array.isArray(account.data)) {
    throw new Error("Helius returned an account with an invalid owner or data field.");
  }
  const data = account.data as unknown[];
  if (data.length !== 2 || typeof data[0] !== "string" || data[1] !== "base64") {
    throw new Error("Helius account data must use the base64 encoding.");
  }
  return {
    address,
    owner: account.owner,
    data: decodeBase64(data[0], maxAccountBytes),
    slot,
    observedAt
  };
}

/**
 * Fetches related program/vault accounts in one getMultipleAccounts request.
 * Solana's context slot is shared by all returned accounts, which is required
 * before combining pool state and vault balances into one market snapshot.
 */
export async function fetchHeliusMultipleAccounts(
  addresses: string[],
  config: HeliusAccountReadConfig
): Promise<HeliusAccountSnapshot> {
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 100 ||
      addresses.some(address => typeof address !== "string" || !address.trim()) ||
      new Set(addresses).size !== addresses.length) {
    throw new Error("Provide between 1 and 100 unique Solana account addresses.");
  }
  const commitment = config.commitment ?? "confirmed";
  const fetcher = config.fetcher ?? fetch;
  const maxAccountBytes = config.maxAccountBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maxAccountBytes) || maxAccountBytes < 1 || maxAccountBytes > 10 * 1024 * 1024) {
    throw new Error("Invalid maximum account data size.");
  }
  const response = await fetcher(buildHeliusRpcUrl(config.apiKey), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "paper-account-snapshot", method: "getMultipleAccounts",
      params: [addresses, { encoding: "base64", commitment }]
    })
  });
  if (!response.ok) throw new Error(`Helius account RPC returned HTTP ${response.status}.`);
  const envelope = asRecord(await response.json());
  if (envelope.error) throw new Error("Helius account RPC returned a JSON-RPC error.");
  const result = asRecord(envelope.result);
  const slot = parseContextSlot(result.context);
  if (!Array.isArray(result.value) || result.value.length !== addresses.length) {
    throw new Error("Helius returned an incomplete multiple-account response.");
  }
  const observedAt = new Date((config.now ?? Date.now)()).toISOString();
  const accounts = result.value.map((value, index) =>
    parseAccount(addresses[index]!, value, slot, observedAt, maxAccountBytes)
  );
  return { slot, commitment, observedAt, accounts };
}

export interface PumpSwapPoolDiscoveryResult {
  contextSlot: number;
  observedAt: string;
  pools: DecodedPumpSwapPoolAccount[];
}

/**
 * Finds pool accounts whose base_mint matches a candidate mint. This is only
 * discovery: a returned pool is not trusted until its canonical PDA/authority
 * and its vault accounts are re-fetched and verified in one getMultipleAccounts
 * context slot.
 */
export async function discoverPumpSwapPoolsForMint(
  mint: string,
  config: HeliusAccountReadConfig
): Promise<PumpSwapPoolDiscoveryResult> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    throw new Error("Invalid PumpSwap base mint.");
  }
  const commitment = config.commitment ?? "confirmed";
  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(buildHeliusRpcUrl(config.apiKey), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "pump-pool-discovery", method: "getProgramAccounts",
      params: [PUMP_AMM_PROGRAM_ID, {
        encoding: "base64", commitment, withContext: true,
        filters: [{ memcmp: { offset: 43, bytes: mint } }]
      }]
    })
  });
  if (!response.ok) throw new Error(`Helius pool discovery returned HTTP ${response.status}.`);
  const envelope = asRecord(await response.json());
  if (envelope.error) throw new Error("Helius pool discovery returned a JSON-RPC error.");
  const result = asRecord(envelope.result);
  const slot = parseContextSlot(result.context);
  if (!Array.isArray(result.value)) throw new Error("Helius pool discovery omitted account results.");
  const maximumResults = config.maxPoolCandidates ?? 25;
  if (!Number.isSafeInteger(maximumResults) || maximumResults < 1 || maximumResults > 50) {
    throw new Error("PumpSwap discovery candidate limit must be between 1 and 50.");
  }
  if (result.value.length > maximumResults) {
    throw new Error("PumpSwap pool discovery exceeded the bounded candidate result limit.");
  }
  const observedAt = new Date((config.now ?? Date.now)()).toISOString();
  const candidates: DecodedPumpSwapPoolAccount[] = [];
  for (const item of result.value) {
    const record = asRecord(item);
    if (typeof record.pubkey !== "string") throw new Error("Helius pool discovery returned an invalid account address.");
    const raw = parseAccount(record.pubkey, record.account, slot, observedAt, config.maxAccountBytes ?? 64 * 1024);
    if (!raw) continue;
    const decoded = decodePumpSwapPoolAccount(raw);
    if (decoded.baseMint !== mint) throw new Error("Helius memcmp pool result did not match the requested base mint.");
    candidates.push(decoded);
  }
  return { contextSlot: slot, observedAt, pools: candidates };
}

/** Selects a single index-0 pool only when SDK-derived canonical addresses match. */
export async function discoverCanonicalPumpSwapPoolForMint(input: {
  mint: string;
  expectedPoolAddress: string;
  expectedPoolCreatorAuthority: string;
  config: HeliusAccountReadConfig;
}): Promise<{ pool: DecodedPumpSwapPoolAccount; contextSlot: number; observedAt: string } | null> {
  const discovery = await discoverPumpSwapPoolsForMint(input.mint, input.config);
  const matches = discovery.pools.filter(pool =>
    pool.address === input.expectedPoolAddress && pool.index === 0 &&
    pool.creator === input.expectedPoolCreatorAuthority
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error("More than one PumpSwap account matched the canonical pool identity.");
  return { pool: matches[0]!, contextSlot: discovery.contextSlot, observedAt: discovery.observedAt };
}
