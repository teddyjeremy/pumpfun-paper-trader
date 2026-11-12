import { ComputeBudgetProgram, Message, MessageV0, PublicKey, TransactionInstruction, TransactionMessage, VersionedMessage } from "@solana/web3.js";
import { buildHeliusRpcUrl } from "./helius.js";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
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
 * Compile the exact unsigned instruction set intended for paper execution.
 * The caller supplies the venue instructions, payer identity and recent
 * blockhash. This adds the actual CU limit and derives writable locks from
 * the compiled message header. It never signs, simulates or submits.
 */
export interface UnsignedFeeMessageInput {
  payer: PublicKey;
  recentBlockhash: string;
  instructions: readonly TransactionInstruction[];
  computeUnitLimit: number;
}

export interface UnsignedFeeMessage {
  messageBase64: string;
  writableAccountKeys: string[];
  computeUnitLimit: number;
  messageSha256: string;
}

export async function compileUnsignedFeeMessage(
  input: UnsignedFeeMessageInput
): Promise<UnsignedFeeMessage> {
  if (!Number.isSafeInteger(input.computeUnitLimit) ||
      input.computeUnitLimit < 1 || input.computeUnitLimit > MAX_COMPUTE_UNIT_LIMIT) {
    throw new Error("Unsigned fee message compute-unit limit is invalid.");
  }
  if (input.instructions.length < 1 || input.instructions.length > 48) {
    throw new Error("Unsigned fee message requires a bounded, non-empty venue instruction list.");
  }
  if (input.instructions.some(ix => ix.programId.equals(ComputeBudgetProgram.programId))) {
    throw new Error("Venue instructions must not contain Compute Budget instructions; the compiler owns fee settings.");
  }
  if (typeof input.recentBlockhash !== "string" || !input.recentBlockhash.trim()) {
    throw new Error("A recent blockhash is required to compile the exact unsigned message.");
  }

  const message = new TransactionMessage({
    payerKey: input.payer,
    recentBlockhash: input.recentBlockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: input.computeUnitLimit }),
      ...input.instructions
    ]
  }).compileToLegacyMessage();

  const keys = message.accountKeys;
  const header = message.header;
  const signedWritable = header.numRequiredSignatures - header.numReadonlySignedAccounts;
  const unsignedWritable = keys.length - header.numRequiredSignatures - header.numReadonlyUnsignedAccounts;
  const writableAccountKeys = keys.filter((_key, index) =>
    index < signedWritable ||
    (index >= header.numRequiredSignatures &&
      index < header.numRequiredSignatures + unsignedWritable)
  ).map(key => key.toBase58());

  if (writableAccountKeys.length < 1 || writableAccountKeys.length > 128 ||
      new Set(writableAccountKeys).size !== writableAccountKeys.length) {
    throw new Error("Compiled transaction produced invalid writable account locks.");
  }

  const bytes = message.serialize();
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const messageBase64 = btoa(binary);
  const digestBytes = new Uint8Array(await crypto.subtle.digest(
    "SHA-256", bytes
  ));
  return {
    messageBase64,
    writableAccountKeys,
    computeUnitLimit: input.computeUnitLimit,
    messageSha256: [...digestBytes].map(value => value.toString(16).padStart(2, "0")).join("")
  };
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
  if (!messageHasSafeFeeInstructions(config.messageBase64, config.computeUnitLimit)) {
    return unavailable("The compiled message must contain one matching SetComputeUnitLimit and omit SetComputeUnitPrice.");
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

  const feeResult = asRecord(feeResponse.result);
  const feeContext = asRecord(feeResult?.context);
  const feeValue = feeResult?.value;
  if (typeof feeValue !== "number" || !Number.isSafeInteger(feeValue) || feeValue <= 0) {
    return unavailable("The exact transaction message has no valid base network fee estimate.");
  }
  const currentSlot = slotResponse.result;
  if (!Number.isSafeInteger(currentSlot) || (currentSlot as number) < 1) {
    return unavailable("Solana RPC returned an invalid confirmed slot.");
  }
  const feeContextSlot = feeContext?.slot;
  if (!Number.isSafeInteger(feeContextSlot) ||
      (feeContextSlot as number) > (currentSlot as number) ||
      (currentSlot as number) - (feeContextSlot as number) > RECENT_SLOT_WINDOW) {
    return unavailable("The exact-message base fee was returned from a stale or invalid confirmed slot.");
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

/**
 * Decode legacy and v0 compiled messages. The exact message must contain one
 * explicit CU limit matching the fee calculation and no CU-price instruction.
 * getFeeForMessage includes an embedded CU price, so accepting one would
 * double-count priority fees when the sampled estimate is added.
 */
function messageHasSafeFeeInstructions(messageBase64: string, expectedLimit: number): boolean {
  try {
    const binary = atob(messageBase64);
    if (binary.length === 0 || btoa(binary) !== messageBase64) return false;
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const versioned = (bytes[0]! & 0x80) !== 0;
    const message = versioned ? VersionedMessage.deserialize(bytes) : Message.from(bytes);
    const keys = versioned
      ? (message as MessageV0).staticAccountKeys
      : (message as Message).accountKeys;
    const instructions = versioned
      ? (message as MessageV0).compiledInstructions
      : (message as Message).instructions;
    let limitCount = 0;
    for (const instruction of instructions) {
      const programId = keys[instruction.programIdIndex];
      if (!programId || programId.toBase58() !== COMPUTE_BUDGET_PROGRAM_ID) continue;
      const data = decodeBase58(instruction.data);
      if (data[0] === 3) return false;
      if (data[0] === 2) {
        if (data.length !== 5) return false;
        limitCount += 1;
        const limit = data[1]! + (data[2]! << 8) + (data[3]! << 16) + (data[4]! << 24);
        if (limit !== expectedLimit) return false;
      }
    }
    return limitCount === 1;
  } catch {
    return false;
  }
}

function decodeBase58(value: string | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error("Invalid base58 instruction data.");
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 255n));
    number >>= 8n;
  }
  for (let index = 0; index < value.length && value[index] === "1"; index += 1) bytes.unshift(0);
  return Uint8Array.from(bytes);
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
