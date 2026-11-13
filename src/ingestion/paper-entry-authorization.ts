import { PublicKey } from "@solana/web3.js";
import {
  openPaperPosition,
  type ExecutablePaperQuote,
  type PaperPortfolioState
} from "../paper/portfolio.js";
import type { UnsignedInstructionFeeEvidence } from "./solana-fee-estimator.js";

const PORTFOLIO_RESOLVED_BLOCKERS = new Set([
  "VIRTUAL_PAYER_BALANCE_NOT_VERIFIED",
  "PAPER_ENTRY_AUTHORIZATION_NOT_GRANTED",
  "ATA_RENT_RESERVE_NOT_YET_RECORDED_IN_PAPER_PORTFOLIO",
  "USER_VOLUME_ACCUMULATOR_RENT_RESERVE_NOT_RECORDED_IN_PAPER_PORTFOLIO"
]);

export interface PaperEntryPlanAuthorizationInput {
  mint: string;
  portfolio: PaperPortfolioState | null;
  buyQuote: ExecutablePaperQuote;
  sellQuote: ExecutablePaperQuote;
  exactFeeEvidence: {
    buy: UnsignedInstructionFeeEvidence;
    sell: UnsignedInstructionFeeEvidence;
  } | undefined;
  solUsdPriceUsd: number;
  nowMs?: number;
}

export type PaperEntryPlanAuthorization =
  | { authorized: true; rentReserveUsd: number; resolvedBlockers: string[]; reason: null }
  | { authorized: false; rentReserveUsd: null; resolvedBlockers: []; reason: string };

/**
 * A quote is never an authorization. This final Worker-side gate requires both
 * exact unsigned plans to have only portfolio-resolvable blockers, then runs
 * the real portfolio entry transition as a pure preview. That preview verifies
 * stake, buy/sell fees and refundable ATA/accumulator rent against available
 * simulated cash. The durable transition repeats the checks atomically.
 */
export function authorizePaperEntryFromVerifiedPlan(
  input: PaperEntryPlanAuthorizationInput
): PaperEntryPlanAuthorization {
  const reject = (reason: string): PaperEntryPlanAuthorization => ({
    authorized: false, rentReserveUsd: null, resolvedBlockers: [], reason
  });
  if (!input.portfolio) return reject("Active paper portfolio is unavailable.");
  if (!Number.isFinite(input.solUsdPriceUsd) || input.solUsdPriceUsd <= 0) {
    return reject("A fresh positive SOL/USD reference is required to reserve refundable account rent.");
  }
  const evidence = input.exactFeeEvidence;
  if (!evidence || evidence.buy.status !== "AVAILABLE" || evidence.sell.status !== "AVAILABLE") {
    return reject("Both BUY and exact-size SELL unsigned-message fee estimates must be available.");
  }
  const buyPlan = evidence.buy.planEvidence;
  const sellPlan = evidence.sell.planEvidence;
  if (!buyPlan || !sellPlan ||
      buyPlan.provider !== "pump-sdk-4.3.1" || sellPlan.provider !== "pump-sdk-4.3.1" ||
      buyPlan.side !== "BUY" || sellPlan.side !== "SELL" ||
      buyPlan.mint !== input.mint || sellPlan.mint !== input.mint ||
      buyPlan.venue !== sellPlan.venue || buyPlan.user !== sellPlan.user ||
      buyPlan.executionReady !== false || sellPlan.executionReady !== false ||
      buyPlan.paperEntryAuthorized !== false || sellPlan.paperEntryAuthorized !== false ||
      buyPlan.requiredAccountAddressesToVerify.length === 0 ||
      sellPlan.requiredAccountAddressesToVerify.length === 0) {
    return reject("BUY and SELL plan identities or required account evidence do not match.");
  }
  try {
    new PublicKey(buyPlan.user);
  } catch {
    return reject("Unsigned plan payer identity is not a valid public key.");
  }
  if (!/^[a-f0-9]{64}$/i.test(evidence.buy.messageSha256) ||
      !/^[a-f0-9]{64}$/i.test(evidence.sell.messageSha256)) {
    return reject("Exact unsigned-message hashes are missing or malformed.");
  }
  const blockers = [...new Set([
    ...buyPlan.blockers,
    ...sellPlan.blockers
  ])];
  const unresolved = blockers.filter(blocker => !PORTFOLIO_RESOLVED_BLOCKERS.has(blocker));
  if (unresolved.length > 0) {
    return reject(`Unsigned account prerequisites remain blocked: ${unresolved.join(", ")}.`);
  }
  const buyRent = buyPlan.rentReserveLamports;
  const sellRent = sellPlan.rentReserveLamports;
  if (!Number.isSafeInteger(buyRent) || (buyRent as number) < 0 ||
      !Number.isSafeInteger(sellRent) || (sellRent as number) < 0) {
    return reject("Both unsigned plans must provide verified non-negative rent reserve lamports.");
  }
  // Both plans refer to the same virtual trader accounts. Reserve the larger
  // snapshot amount, not the sum, to avoid charging the same ATA rent twice.
  const rentReserveLamports = Math.max(buyRent as number, sellRent as number);
  const rentReserveUsd = rentReserveLamports / 1_000_000_000 * input.solUsdPriceUsd;
  if (!Number.isFinite(rentReserveUsd) || rentReserveUsd < 0) {
    return reject("Converted refundable account rent reserve is invalid.");
  }
  const nowMs = input.nowMs ?? Date.now();
  try {
    openPaperPosition(input.portfolio, {
      mint: input.mint,
      positionId: `paper-entry-preview:${input.mint}:${input.buyQuote.quoteId}`,
      occurredAt: new Date(nowMs).toISOString(),
      buyQuote: input.buyQuote,
      sellQuote: input.sellQuote,
      rentReserveUsd,
      nowMs
    });
  } catch (error) {
    return reject(error instanceof Error
      ? `Simulated payer/portfolio budget check failed: ${error.message}`
      : "Simulated payer/portfolio budget check failed.");
  }
  return {
    authorized: true,
    rentReserveUsd,
    resolvedBlockers: blockers,
    reason: null
  };
}
