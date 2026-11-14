import { decodeSuccessfulPumpTransaction, type PumpCreateEvent, type PumpTradeEvent } from "./pump-events.js";
import { PUMP_FUN_PROGRAM_ID } from "./pump-constants.js";
export { PUMP_FUN_PROGRAM_ID } from "./pump-constants.js";
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface HeliusRpcConfig {
  apiKey: string;
  commitment?: "confirmed" | "finalized";
  fetcher?: typeof fetch;
}

export interface VerifiedPumpTransaction {
  provider: "helius";
  commitment: "confirmed" | "finalized";
  signature: string;
  slot: number;
  /** Standard Solana transaction blockTime; null when the RPC cannot prove it. */
  blockTime?: number | null;
  mint: string;
  createEvents: PumpCreateEvent[];
  tradeEvents: PumpTradeEvent[];
  receivedAt: string;
}

export type HeliusTransactionResult =
  | { status: "VERIFIED"; transaction: VerifiedPumpTransaction }
  | { status: "FAILED_TRANSACTION"; signature: string }
  | { status: "DATA_INCOMPLETE"; reason: string }
  | { status: "NOT_RELEVANT"; reason: string };

export function buildHeliusRpcUrl(apiKey: string): string {
  if (!apiKey.trim()) throw new Error("HELIUS_API_KEY is required.");
  return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
}

export function buildHeliusWebSocketUrl(apiKey: string): string {
  if (!apiKey.trim()) throw new Error("HELIUS_API_KEY is required.");
  return `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
}

/** Standard Solana logsSubscribe: one address per mentions filter. */
export function buildCandidateLogsSubscribe(
  bondingCurve: string,
  requestId: number,
  commitment: "confirmed" | "finalized" = "confirmed"
): { jsonrpc: "2.0"; id: number; method: "logsSubscribe"; params: [ { mentions: [string] }, { commitment: string } ] } {
  if (!BASE58_ADDRESS.test(bondingCurve)) throw new Error("Invalid bonding-curve address.");
  if (!Number.isSafeInteger(requestId) || requestId < 1) throw new Error("Invalid JSON-RPC request ID.");
  return {
    jsonrpc: "2.0",
    id: requestId,
    method: "logsSubscribe",
    params: [{ mentions: [bondingCurve] }, { commitment }]
  };
}

export function parseHeliusLogsNotification(input: unknown): {
  signature: string; slot: number; err: unknown;
} | null {
  if (!input || typeof input !== "object") return null;
  const message = input as Record<string, unknown>;
  if (message.method !== "logsNotification" || !message.params || typeof message.params !== "object") return null;
  const params = message.params as Record<string, unknown>;
  if (!params.result || typeof params.result !== "object") return null;
  const result = params.result as Record<string, unknown>;
  if (!result.value || typeof result.value !== "object") return null;
  const value = result.value as Record<string, unknown>;
  const context = result.context as Record<string, unknown> | undefined;
  if (typeof value.signature !== "string" || !BASE58_SIGNATURE.test(value.signature) ||
      !context || !Number.isSafeInteger(context.slot) || (context.slot as number) < 0 ||
      !Object.prototype.hasOwnProperty.call(value, "err")) return null;
  return { signature: value.signature, slot: context.slot as number, err: value.err };
}

function transactionMentionsPumpProgram(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const tx = input as Record<string, unknown>;
  const transaction = tx.transaction as Record<string, unknown> | undefined;
  const message = transaction?.message as Record<string, unknown> | undefined;
  const keys = message?.accountKeys;
  if (Array.isArray(keys) && keys.some((key) => {
    if (typeof key === "string") return key === PUMP_FUN_PROGRAM_ID;
    return Boolean(key && typeof key === "object" &&
      (key as Record<string, unknown>).pubkey === PUMP_FUN_PROGRAM_ID);
  })) return true;
  const meta = tx.meta as Record<string, unknown> | undefined;
  const logs = meta?.logMessages;
  return Array.isArray(logs) && logs.some((line) =>
    typeof line === "string" && line.includes(`Program ${PUMP_FUN_PROGRAM_ID} invoke`)
  );
}

/**
 * Fetch a single transaction selected by a candidate-specific logsSubscribe.
 * Callers must pass through the shared Helius token bucket before invoking.
 */
export async function fetchAndVerifyPumpTransaction(
  signature: string,
  expectedMint: string,
  config: HeliusRpcConfig
): Promise<HeliusTransactionResult> {
  if (!BASE58_SIGNATURE.test(signature)) return { status: "DATA_INCOMPLETE", reason: "Invalid transaction signature." };
  if (!BASE58_ADDRESS.test(expectedMint)) return { status: "DATA_INCOMPLETE", reason: "Invalid expected mint." };
  const commitment = config.commitment ?? "confirmed";
  const fetcher = config.fetcher ?? fetch;

  let response: Response;
  try {
    response = await fetcher(buildHeliusRpcUrl(config.apiKey), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: signature,
        method: "getTransaction",
        params: [signature, {
          encoding: "json",
          commitment,
          maxSupportedTransactionVersion: 1
        }]
      })
    });
  } catch {
    return { status: "DATA_INCOMPLETE", reason: "Helius transaction request failed before a response." };
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 160);
    return { status: "DATA_INCOMPLETE", reason: "Helius HTTP status " + response.status + (detail ? ": " + detail : "") + "." };
  }
  let payload: unknown;
  try { payload = await response.json(); }
  catch { return { status: "DATA_INCOMPLETE", reason: "Helius returned invalid JSON." }; }
  if (!payload || typeof payload !== "object") return { status: "DATA_INCOMPLETE", reason: "Helius JSON-RPC response is malformed." };

  const envelope = payload as Record<string, unknown>;
  if (envelope.error) {
    const rpcError = envelope.error as Record<string, unknown>;
    const detail = String(rpcError.message ?? rpcError.code ?? "unknown JSON-RPC error").slice(0, 160);
    return { status: "DATA_INCOMPLETE", reason: "Helius JSON-RPC returned an error: " + detail + "." };
  }
  if (!Object.prototype.hasOwnProperty.call(envelope, "result")) {
    return { status: "DATA_INCOMPLETE", reason: "Helius response omitted result." };
  }
  if (envelope.result === null) return { status: "DATA_INCOMPLETE", reason: "Transaction is not available at the requested commitment." };

  const decoded = decodeSuccessfulPumpTransaction(envelope.result);
  if (decoded.status === "FAILED_TRANSACTION") return decoded;
  if (decoded.status !== "DECODED") return decoded;
  if (decoded.signature !== signature) return { status: "DATA_INCOMPLETE", reason: "Helius transaction signature did not match the requested signature." };
  if (!transactionMentionsPumpProgram(envelope.result)) return { status: "NOT_RELEVANT", reason: "Transaction does not invoke the Pump.fun program." };

  const createEvents = decoded.createEvents.filter((event) => event.mint === expectedMint);
  const tradeEvents = decoded.tradeEvents.filter((event) => event.mint === expectedMint);
  const transactionPayload = envelope.result as Record<string, unknown>;
  const blockTime = Number.isSafeInteger(transactionPayload.blockTime) &&
    (transactionPayload.blockTime as number) >= 0
    ? transactionPayload.blockTime as number
    : null;
  if (createEvents.length === 0 && tradeEvents.length === 0) {
    return { status: "NOT_RELEVANT", reason: "Decoded Pump events do not belong to the expected mint." };
  }

  return {
    status: "VERIFIED",
    transaction: {
      provider: "helius",
      commitment,
      signature: decoded.signature,
      slot: decoded.slot,
      blockTime,
      mint: expectedMint,
      createEvents,
      tradeEvents,
      receivedAt: new Date().toISOString()
    }
  };
}
