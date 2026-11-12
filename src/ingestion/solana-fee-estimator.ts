import { buildHeliusRpcUrl } from "./helius.js";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
const MIN_RECENT_FEE_SAMPLES = 10;
const RECENT_SLOT_WINDOW = 150;

export interface SolanaFeeEstimate {
  provider: "helius-solana-rpc";
  commitment: "confirmed";
  networkFeeLamports: string;
  priorityFeeLamports: string;
  priorityFeeMicroLamportsPerCu: string;
  computeUnitLimit: number;
  feeMessageSha256: string;
  sampleCount: number;
  firstSampleSlot: number;
  lastSampleSlot: number;
  observedSlot: number;
  observedAt: string;
  priorityPercentile: 75;
}

export type SolanaFeeEstimateResult =
  | { status: "AVAILABLE"; estimate: SolanaFeeEstimate }
  | { status: "UNAVAILABLE"; reason: string };

export interface SolanaFeeEstimatorConfig {
  apiKey: string;
  /** Base64-encoded compiled message for the exact venue transaction, without a SetComputeUnitPrice instruction. */
  messageBase64: string;
  /** Account locks used by the transaction; these scope the prioritization-fee samples. */
  writableAccountKeys: readonly string[];
  /** The compute-unit limit that the transaction will actually request. */
  computeUnitLimit: number;
  fetcher?: typeof fetch;
  nowMs?: number;
}

/**
 * Estimates Solana network and priority fees for a specific unsigned message.
 *
 * The caller must supply the compiled message for the exact transaction
 * instruction/account set. The message must omit SetComputeUnitPrice so
 * getFeeForMessage returns the base network fee separately. Priority pricing
 * uses the 75th percentile of recent prioritization samples for the message's
 * writable account locks, multiplied by the transaction's actual CU limit.
 *
 * This function never builds, signs, simulates or submits a transaction.
 * Missing, stale or malformed RPC evidence is an unavailable estimate.
 */
export async function estimateSolanaTransactionFees(
  config: SolanaFeeEstimatorConfig
): Promise<SolanaFeeEstimateResult> {
  const nowMs = config.nowMs ?? Date.now();
  if (!config.apiKey.trim() || !Number.isFinite(nowMs)) {
    return unavailable("Fee estimator configuration is invalid.");
  }
  if (typeof config.messageBase64 !== "string" ||
      config.messageBase64.length === 0 ||
      config.messageBase64.length > 2_000 ||
      !BASE64.test(config.messageBase64)) {
    return unavailable("A valid base64 compiled transaction message is required.");
  }
  if (!Array.isArray(config.writableAccountKeys) || config.writableAccountKeys.length < 1 ||
      config.writableAccountKeys.length > 128 ||
      config.writableAccountKeys.some(key => typeof key !== "string" || !ADDRESS.test(key)) ||
      new Set(config.writableAccountKeys).size !== config.writableAccountKeys.length) {
    return unavailable("Writable transaction account locks are missing, duplicated or invalid.");
  }
  if (!Number.isSafeInteger(config.computeUnitLimit) ||
      config.computeUnitLimit < 1 || config.computeUnitLimit > MAX_COMPUTE_UNIT_LIMIT) {
    return unavailable("Transaction compute-unit limit is outside Solana's supported range.");
  }

  const fetcher = config.fetcher ?? fetch;
  let rpcUrl: string;
  try { rpcUrl = buildHeliusRpcUrl(config.apiKey); }
  catch { return unavailable("Helius RPC configuration is unavailable."); }

  const [feeResponse, priorityResponse, slotResponse] = await Promise.all([
    rpc(fetcher, rpcUrl, "getFeeForMessage", [config.messageBase64, { commitment: "confirmed" }]),
    rpc(fetcher, rpcUrl, "getRecentPrioritizationFees", [config.writableAccountKeys]),
    rpc(fetcher, rpcUrl, "getSlot", [{ commitment: "confirmed" }])
  ]);
  if (!feeResponse.ok || !priorityResponse.ok || !slotResponse.ok) {
    return unavailable("Solana RPC did not return all required transaction fee evidence.");
  }

  const feeValue = asRecord(feeResponse.result)?.value;
  if (typeof feeValue !== "number" || !Number.isSafeInteger(feeValue) || feeValue <= 0) {
    return unavailable("The exact transaction message has no valid base network fee estimate.");
  }
  const currentSlot = slotResponse.result;
  if (!Number.isSafeInteger(currentSlot) || (currentSlot as number) < 1) {
    return unavailable("Solana RPC returned an invalid confirmed slot.");
  }
  if (!Array.isArray(priorityResponse.result) ||
      priorityResponse.result.length < MIN_RECENT_FEE_SAMPLES ||
      priorityResponse.result.length > RECENT_SLOT_WINDOW) {
    return unavailable("Solana RPC returned malformed, insufficient or oversized prioritization-fee samples.");
  }

  const samples = priorityResponse.result.flatMap((item: unknown) => {
    const row = asRecord(item);
    if (!row || !Number.isSafeInteger(row.slot) ||
        !Number.isSafeInteger(row.prioritizationFee) ||
        (row.slot as number) < Math.max(0, (currentSlot as number) - RECENT_SLOT_WINDOW) ||
        (row.slot as number) > (currentSlot as number) ||
        (row.prioritizationFee as number) < 0) return [];
    return [{ slot: row.slot as number, microLamports: BigInt(row.prioritizationFee as number) }];
  }).sort((a, b) => a.slot - b.slot);

  if (samples.length < MIN_RECENT_FEE_SAMPLES) {
    return unavailable("Fewer than ten recent account-lock-specific priority-fee samples are available.");
  }
  if (new Set(samples.map(sample => sample.slot)).size !== samples.length) {
    return unavailable("Recent priority-fee samples contain duplicate slots.");
  }

  const orderedFees = samples.map(sample => sample.microLamports).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  const percentileIndex = Math.ceil(orderedFees.length * 0.75) - 1;
  const priorityMicroLamports = orderedFees[percentileIndex];
  if (priorityMicroLamports === undefined) {
    return unavailable("Priority-fee percentile could not be calculated.");
  }
  const priorityLamports = (
    priorityMicroLamports * BigInt(config.computeUnitLimit) + 999_999n
  ) / 1_000_000n;
  const digestBytes = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(config.messageBase64)
  ));
  const messageDigest = [...digestBytes].map(value => value.toString(16).padStart(2, "0")).join("");

  return {
    status: "AVAILABLE",
    estimate: {
      provider: "helius-solana-rpc",
      commitment: "confirmed",
      networkFeeLamports: BigInt(feeValue).toString(),
      priorityFeeLamports: priorityLamports.toString(),
      priorityFeeMicroLamportsPerCu: priorityMicroLamports.toString(),
      computeUnitLimit: config.computeUnitLimit,
      feeMessageSha256: messageDigest,
      sampleCount: samples.length,
      firstSampleSlot: samples[0]!.slot,
      lastSampleSlot: samples[samples.length - 1]!.slot,
      observedSlot: currentSlot as number,
      observedAt: new Date(nowMs).toISOString(),
      priorityPercentile: 75
    }
  };
}

async function rpc(
  fetcher: typeof fetch,
  url: string,
  method: string,
  params: unknown[]
): Promise<{ ok: true; result: unknown } | { ok: false }> {
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params })
    });
    if (!response.ok) return { ok: false };
    const payload = asRecord(await response.json());
    if (!payload || payload.error || !Object.prototype.hasOwnProperty.call(payload, "result")) {
      return { ok: false };
    }
    return { ok: true, result: payload.result };
  } catch {
    return { ok: false };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unavailable(reason: string): SolanaFeeEstimateResult {
  return { status: "UNAVAILABLE", reason };
}
