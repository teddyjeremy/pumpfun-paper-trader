import { buildHeliusRpcUrl, type HeliusRpcConfig } from "./helius.js";

export interface HeliusPriorityFeeSample {
  slot: number;
  microLamportsPerComputeUnit: string;
}

export interface PaperNetworkFeeEstimate {
  networkFeeLamports: string;
  priorityFeeLamports: string;
  baseFeeLamportsPerSignature: number;
  signatureCount: number;
  computeUnitLimit: number;
  priorityFeePercentile: number;
  microLamportsPerComputeUnit: string;
  sampleCount: number;
  nonZeroSampleCount: number;
  source: "helius-getRecentPrioritizationFees";
  baseFeeAssumption: "5000-lamports-per-signature";
}

/**
 * Fetches the recent cluster fee samples and converts a percentile into a
 * transaction priority-fee estimate. The RPC reports micro-lamports/CU.
 */
export async function fetchHeliusPriorityFeeSamples(input: {
  config: HeliusRpcConfig;
  writableAccounts?: string[];
}): Promise<HeliusPriorityFeeSample[]> {
  const addresses = input.writableAccounts ?? [];
  if (!Array.isArray(addresses) || addresses.length > 128 ||
      addresses.some(address => typeof address !== "string" ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) ||
      new Set(addresses).size !== addresses.length) {
    throw new Error("Priority-fee writable accounts must be at most 128 unique base58 addresses.");
  }
  const params = addresses.length > 0 ? [addresses] : [];
  const response = await (input.config.fetcher ?? fetch)(buildHeliusRpcUrl(input.config.apiKey), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "paper-priority-fees",
      method: "getRecentPrioritizationFees", params
    })
  });
  if (!response.ok) throw new Error(`Helius priority-fee RPC returned HTTP ${response.status}.`);
  const envelope = await response.json() as Record<string, unknown>;
  if (!envelope || typeof envelope !== "object" || envelope.error) {
    throw new Error("Helius priority-fee RPC returned a malformed response or JSON-RPC error.");
  }
  if (!Array.isArray(envelope.result) || envelope.result.length < 1 || envelope.result.length > 150) {
    throw new Error("Helius priority-fee RPC returned no samples or exceeded its 150-slot response bound.");
  }
  const samples = envelope.result.map(value => {
    if (!value || typeof value !== "object") throw new Error("Helius priority-fee sample is malformed.");
    const record = value as Record<string, unknown>;
    if (!Number.isSafeInteger(record.slot) || (record.slot as number) < 0 ||
        !Number.isSafeInteger(record.prioritizationFee) || (record.prioritizationFee as number) < 0) {
      throw new Error("Helius priority-fee sample contains invalid slot or fee values.");
    }
    return {
      slot: record.slot as number,
      microLamportsPerComputeUnit: String(record.prioritizationFee)
    };
  });
  if (new Set(samples.map(sample => sample.slot)).size !== samples.length) {
    throw new Error("Helius priority-fee samples contain duplicate slots.");
  }
  return samples;
}

export function buildPaperNetworkFeeEstimate(input: {
  samples: readonly HeliusPriorityFeeSample[];
  computeUnitLimit: number;
  signatureCount?: number;
  priorityFeePercentile?: number;
  baseFeeLamportsPerSignature?: number;
  maxPriorityFeeLamports?: string;
}): PaperNetworkFeeEstimate {
  const signatureCount = input.signatureCount ?? 1;
  const percentile = input.priorityFeePercentile ?? 75;
  const baseFeePerSignature = input.baseFeeLamportsPerSignature ?? 5_000;
  if (!Number.isSafeInteger(input.computeUnitLimit) || input.computeUnitLimit < 1 ||
      input.computeUnitLimit > 1_400_000) {
    throw new Error("Paper quote compute-unit limit must be between 1 and 1,400,000.");
  }
  if (!Number.isSafeInteger(signatureCount) || signatureCount < 1 || signatureCount > 10) {
    throw new Error("Paper quote signature count must be between 1 and 10.");
  }
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 100) {
    throw new Error("Priority-fee percentile must be between 0 and 100.");
  }
  if (!Number.isSafeInteger(baseFeePerSignature) || baseFeePerSignature < 1) {
    throw new Error("Base fee per signature must be a positive safe integer.");
  }
  if (input.samples.length < 1 || input.samples.length > 150) {
    throw new Error("At least one and at most 150 recent priority-fee samples are required.");
  }
  const nonZero = input.samples.map(sample => {
    if (!/^(0|[1-9]\d*)$/.test(sample.microLamportsPerComputeUnit)) {
      throw new Error("Priority-fee sample must be a non-negative integer.");
    }
    return BigInt(sample.microLamportsPerComputeUnit);
  }).filter(value => value > 0n).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const index = nonZero.length === 0 ? -1 :
    Math.max(0, Math.ceil((percentile / 100) * nonZero.length) - 1);
  const selectedMicroLamports = index < 0 ? 0n : nonZero[index]!;
  const priorityFeeLamports = (selectedMicroLamports * BigInt(input.computeUnitLimit) + 999_999n) / 1_000_000n;
  if (input.maxPriorityFeeLamports !== undefined) {
    if (!/^(0|[1-9]\d*)$/.test(input.maxPriorityFeeLamports)) {
      throw new Error("Maximum priority fee must be a non-negative integer.");
    }
    if (priorityFeeLamports > BigInt(input.maxPriorityFeeLamports)) {
      throw new Error("Estimated priority fee exceeds the configured paper cost cap.");
    }
  }
  return {
    networkFeeLamports: String(BigInt(baseFeePerSignature) * BigInt(signatureCount)),
    priorityFeeLamports: priorityFeeLamports.toString(),
    baseFeeLamportsPerSignature: baseFeePerSignature,
    signatureCount,
    computeUnitLimit: input.computeUnitLimit,
    priorityFeePercentile: percentile,
    microLamportsPerComputeUnit: selectedMicroLamports.toString(),
    sampleCount: input.samples.length,
    nonZeroSampleCount: nonZero.length,
    source: "helius-getRecentPrioritizationFees",
    baseFeeAssumption: "5000-lamports-per-signature"
  };
}
