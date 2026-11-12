import { buildHeliusRpcUrl, type HeliusRpcConfig } from "./helius.js";
import type { RawProgramAccount } from "./pump-account-decoder.js";

export interface HeliusAccountReadConfig extends HeliusRpcConfig {
  now?: () => number;
  maxAccountBytes?: number;
}

export interface HeliusAccountSnapshot {
  slot: number;
  commitment: "confirmed" | "finalized";
  observedAt: string;
  accounts: Array<RawProgramAccount | null>;
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
