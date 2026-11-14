import {
  createHistoricalBackfillState, fetchHeliusAddressSignaturesPage
} from "./helius-backfill.js";
import { fetchAndVerifyPumpTransaction, type VerifiedPumpTransaction } from "./helius.js";

export interface HistoricalLaunchWindowInput {
  mint: string;
  bondingCurve: string;
  createSignature: string;
  launchBlockTime: number;
  horizonSeconds?: number;
  maxSignatures?: number;
}

export interface HistoricalLaunchWindowResult {
  status: "COMPLETE" | "BUDGET_EXHAUSTED" | "INCOMPLETE";
  mint: string;
  state: ReturnType<typeof createHistoricalBackfillState>;
  transactions: VerifiedPumpTransaction[];
  failedSignatures: string[];
  ignoredSignatures: string[];
  decodeFailures: Array<{ signature: string; reason: string }>;
  creditsUsed: number;
  reason: string | null;
}

/**
 * Fetch the exact bonding-curve address history for one launch window and
 * decode every successful signature. The caller supplies the remaining
 * shared credit budget; failed signatures are terminal only when the
 * signature index itself confirms err !== null.
 */
export async function collectHistoricalLaunchWindow(
  input: HistoricalLaunchWindowInput,
  config: {
    apiKey: string;
    maxCredits: number;
    fetcher?: typeof fetch;
    requestIntervalMs?: number;
  }
): Promise<HistoricalLaunchWindowResult> {
  const fetcher = config.fetcher ?? fetch;
  const interval = config.requestIntervalMs ?? 250;
  if (!Number.isSafeInteger(config.maxCredits) || config.maxCredits < 1 ||
      !Number.isFinite(interval) || interval < 0 || interval > 10_000) {
    throw new Error("Invalid historical launch-window credit or rate limit.");
  }
  let creditsUsed = 0;
  let lastRequestAt = 0;
  let budgetExhausted = false;
  const countedFetcher: typeof fetch = async (url, init) => {
    if (creditsUsed >= config.maxCredits) {
      budgetExhausted = true;
      throw new Error("HELIUS_CREDIT_BUDGET_EXHAUSTED");
    }
    const wait = interval - (Date.now() - lastRequestAt);
    if (lastRequestAt > 0 && wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    creditsUsed += 1;
    const response = await fetcher(url, init);
    lastRequestAt = Date.now();
    return response;
  };

  let state: ReturnType<typeof createHistoricalBackfillState>;
  try {
    state = createHistoricalBackfillState({
      mint: input.mint,
      bondingCurve: input.bondingCurve,
      createSignature: input.createSignature,
      launchBlockTime: input.launchBlockTime,
      horizonSeconds: input.horizonSeconds ?? 600,
      maxSignatures: input.maxSignatures ?? 500
    });
  } catch (error) {
    throw error;
  }

  const transactions: VerifiedPumpTransaction[] = [];
  const failedSignatures: string[] = [];
  const ignoredSignatures: string[] = [];
  const decodeFailures: Array<{ signature: string; reason: string }> = [];
  const finish = (status: HistoricalLaunchWindowResult["status"], reason: string | null) => ({
    status, mint: input.mint, state, transactions, failedSignatures, ignoredSignatures, decodeFailures, creditsUsed, reason
  });

  while (state.status !== "COMPLETE" && state.status !== "INCOMPLETE") {
    const page = await fetchHeliusAddressSignaturesPage(state, {
      apiKey: config.apiKey, commitment: "confirmed", fetcher: countedFetcher
    });
    state = page.state;
    if (budgetExhausted) {
      return finish("BUDGET_EXHAUSTED", "Helius credit ceiling reached during launch-window pagination.");
    }
    if (page.status === "INCOMPLETE") {
      return finish("INCOMPLETE", state.reason ?? "Launch-window signature coverage is incomplete.");
    }
  }
  if (state.status !== "COMPLETE") {
    return finish("INCOMPLETE", state.reason ?? "Launch-window signature scan did not complete.");
  }

  for (const signatureInfo of state.signatures) {
    if (signatureInfo.err !== null) {
      failedSignatures.push(signatureInfo.signature);
      continue;
    }
    const fetched = await fetchAndVerifyPumpTransaction(signatureInfo.signature, input.mint, {
      apiKey: config.apiKey, commitment: "confirmed", fetcher: countedFetcher
    });
    if (budgetExhausted) {
      return finish("BUDGET_EXHAUSTED", "Helius credit ceiling reached during transaction decoding.");
    }
    if (fetched.status === "NOT_RELEVANT") {
      // A successfully fetched and decoded transaction that does not contain
      // this mint is a terminal non-match, not a missing transaction.
      ignoredSignatures.push(signatureInfo.signature);
      continue;
    }
    if (fetched.status === "DATA_INCOMPLETE") {
      decodeFailures.push({ signature: signatureInfo.signature, reason: fetched.reason });
      continue;
    }
    if (fetched.status !== "VERIFIED") {
      return finish("INCOMPLETE",
        `Signature ${signatureInfo.signature.slice(0, 12)}… did not verify as a successful Pump transaction.`);
    }
    if (fetched.transaction.slot !== signatureInfo.slot ||
        fetched.transaction.blockTime !== signatureInfo.blockTime) {
      return finish("INCOMPLETE", "Decoded transaction slot or blockTime disagrees with its signature-history record.");
    }
    transactions.push(fetched.transaction);
  }

  if (transactions.length + failedSignatures.length + ignoredSignatures.length + decodeFailures.length !== state.signatures.length ||
      !transactions.some(transaction => transaction.signature === input.createSignature &&
        transaction.createEvents.some(event => event.mint === input.mint))) {
    const decodeReason = decodeFailures.length
      ? ` ${decodeFailures.length} transaction(s) could not be decoded; first: ${decodeFailures[0]!.reason}`
      : "";
    return finish("INCOMPLETE", `Launch-window signatures do not reconcile to verified transactions and confirmed failures.${decodeReason}`);
  }
  if (decodeFailures.length > 0) {
    return finish("INCOMPLETE",
      `${decodeFailures.length} transaction(s) could not be decoded; first: ${decodeFailures[0]!.reason}`);
  }
  return finish("COMPLETE", null);
}
