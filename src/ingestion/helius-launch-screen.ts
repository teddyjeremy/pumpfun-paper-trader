import { buildHeliusRpcUrl } from "./helius.js";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;

export interface HistoricalLaunchActivityScreenInput {
  mint: string;
  bondingCurve: string;
  createSignature: string;
  launchBlockTime: number;
  horizonSeconds?: number;
}

export interface HistoricalLaunchActivityScreenResult {
  status: "SCREENED" | "INCOMPLETE";
  mint: string;
  bondingCurve: string;
  signaturesObserved: number;
  successfulSignatures: number;
  failedSignatures: number;
  activeTimeBuckets: number;
  activeSpanSeconds: number;
  latestActivitySecondsAfterLaunch: number | null;
  createSignatureSeen: boolean;
  sampleCapped: boolean;
  activityScore: number;
  reason: string | null;
}

/**
 * One-request, low-cost activity pre-screen. Signature count is an activity
 * proxy, not a buyer count or proof of executed Pump trades. Full decoding is
 * reserved for the ranked candidates.
 */
export async function screenHistoricalLaunchActivity(
  input: HistoricalLaunchActivityScreenInput,
  config: { apiKey: string; fetcher?: typeof fetch; pageSize?: number }
): Promise<HistoricalLaunchActivityScreenResult> {
  const horizon = input.horizonSeconds ?? 600;
  const pageSize = config.pageSize ?? 100;
  const fail = (reason: string): HistoricalLaunchActivityScreenResult => ({
    status: "INCOMPLETE", mint: input.mint, bondingCurve: input.bondingCurve,
    signaturesObserved: 0, successfulSignatures: 0, failedSignatures: 0,
    activeTimeBuckets: 0, activeSpanSeconds: 0,
    latestActivitySecondsAfterLaunch: null, createSignatureSeen: false,
    sampleCapped: false, activityScore: 0, reason
  });
  if (!ADDRESS.test(input.mint) || !ADDRESS.test(input.bondingCurve) ||
      !SIGNATURE.test(input.createSignature) || !Number.isSafeInteger(input.launchBlockTime) ||
      input.launchBlockTime < 0 || !Number.isSafeInteger(horizon) || horizon < 60 ||
      horizon > 1800 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000 ||
      !config.apiKey.trim()) throw new Error("Invalid historical launch activity screen input.");

  try {
    const response = await (config.fetcher ?? fetch)(buildHeliusRpcUrl(config.apiKey), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "pumpfun-historical-activity-screen",
        method: "getSignaturesForAddress",
        params: [input.bondingCurve, { commitment: "confirmed", limit: pageSize }]
      })
    });
    if (!response.ok) return fail(`Helius signature screen returned HTTP ${response.status}.`);
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail("Malformed Helius response.");
    const envelope = payload as Record<string, unknown>;
    if (envelope.error || !Array.isArray(envelope.result)) return fail("Helius did not return a valid signature page.");
    const rows = envelope.result as unknown[];
    const seen = new Set<string>();
    const timestamps: number[] = [];
    let successful = 0, failed = 0, createSeen = false;
    let previousSlot = Number.POSITIVE_INFINITY;
    let previousTime = Number.POSITIVE_INFINITY;
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") return fail("Malformed signature row.");
      const row = raw as Record<string, unknown>;
      if (typeof row.signature !== "string" || !SIGNATURE.test(row.signature) ||
          seen.has(row.signature) || !Number.isSafeInteger(row.slot) || (row.slot as number) < 0 ||
          !Number.isSafeInteger(row.blockTime) || (row.blockTime as number) < 0 ||
          !Object.prototype.hasOwnProperty.call(row, "err")) return fail("Invalid or duplicate signature evidence.");
      if ((row.slot as number) > previousSlot || (row.blockTime as number) > previousTime) {
        return fail("Signature history is not newest-to-oldest.");
      }
      previousSlot = row.slot as number;
      previousTime = row.blockTime as number;
      seen.add(row.signature);
      if (row.signature === input.createSignature) createSeen = true;
      const elapsed = (row.blockTime as number) - input.launchBlockTime;
      if (elapsed < 0 || elapsed > horizon || row.signature === input.createSignature) continue;
      if (row.err === null) {
        successful += 1;
        timestamps.push(row.blockTime as number);
      } else {
        failed += 1;
      }
    }
    if (rows.length === 0) return fail("Bonding-curve history returned no signatures.");
    const buckets = new Set(timestamps.map(time => Math.floor((time - input.launchBlockTime) / 10)));
    const span = timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
    const latest = timestamps.length ? Math.max(...timestamps) - input.launchBlockTime : null;
    const score = successful + buckets.size * 3 + Math.min(60, Math.floor(span / 10));
    return {
      status: "SCREENED", mint: input.mint, bondingCurve: input.bondingCurve,
      signaturesObserved: successful + failed, successfulSignatures: successful,
      failedSignatures: failed, activeTimeBuckets: buckets.size,
      activeSpanSeconds: span, latestActivitySecondsAfterLaunch: latest,
      createSignatureSeen: createSeen, sampleCapped: rows.length === pageSize,
      activityScore: score,
      reason: createSeen ? null : rows.length === pageSize
        ? "High-activity sample is capped at one page; counts are a lower bound."
        : "Create signature was not reached; activity sample is incomplete."
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Activity screen request failed.");
  }
}
