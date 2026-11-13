import { buildHeliusRpcUrl } from "./helius.js";
import { SOL_QUOTE_MINT } from "./trade-flow.js";
import type { WalletLinkEvidence } from "./wallet-cluster-risk.js";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;
export const WALLET_HISTORY_PAGE_SIZE = 100;
export const WALLET_HISTORY_MAX_PAGES = 2;
export const WALLET_HISTORY_MAX_WALLETS = 16;

export interface CompleteWalletFundingEvidenceResult {
  provider: "helius";
  mint: string;
  status: "OBSERVED" | "DATA_INCOMPLETE";
  coverage: "FULL_SOL_TRANSFER_HISTORY_WITHIN_CONFIGURED_CAP" | "INCOMPLETE_SOL_TRANSFER_HISTORY";
  dataComplete: boolean;
  walletSetComplete: boolean;
  walletsRequested: number;
  requestedWallets: string[];
  walletsCovered: string[];
  walletsChecked: number;
  transfersChecked: number;
  pagesScanned: number;
  links: WalletLinkEvidence[];
  warnings: string[];
  observedAt: string;
}

export interface CompleteWalletFundingEvidenceConfig {
  apiKey: string;
  fetcher?: typeof fetch;
}

/**
 * Collects the complete native-SOL/WSOL transfer history for each supplied
 * wallet using Helius cursor pagination. This is the relevant evidence for
 * common SOL funders; it is not a claim that every non-transfer wallet action
 * has been inspected. A wallet is complete only when the provider returns no
 * continuation cursor before the hard page cap.
 *
 * The caller must supply the complete set of relevant wallets. More than sixteen
 * wallets fails closed instead of silently treating a selected subset as the
 * full cluster.
 */
export async function collectCompleteWalletFundingEvidence(
  mint: string,
  wallets: readonly string[],
  config: CompleteWalletFundingEvidenceConfig
): Promise<CompleteWalletFundingEvidenceResult> {
  const warnings: string[] = [];
  const uniqueWallets = [...new Set(wallets.filter(wallet => ADDRESS.test(wallet)))];
  const walletSetComplete = uniqueWallets.length <= WALLET_HISTORY_MAX_WALLETS &&
    uniqueWallets.length === wallets.length;
  if (!ADDRESS.test(mint) || uniqueWallets.length < 2) {
    return result(mint, "DATA_INCOMPLETE", false, walletSetComplete, uniqueWallets.length, 0, 0, 0,
      ["A valid mint and at least two unique wallets are required."]);
  }
  if (!walletSetComplete) {
    warnings.push("The supplied wallet set exceeds the bounded sixteen-wallet collection limit or contains invalid/duplicate wallet entries.");
    return result(mint, "DATA_INCOMPLETE", false, false, uniqueWallets.length, 0, 0, 0, warnings, [], uniqueWallets);
  }

  const fetcher = config.fetcher ?? fetch;
  const url = buildHeliusRpcUrl(config.apiKey);
  const funderCounts = new Map<string, Map<string, { signatures: Set<string>; timestamps: number[] }>>();
  let transfersChecked = 0;
  let pagesScanned = 0;
  let incomplete = false;

  for (const wallet of uniqueWallets) {
    const counts = new Map<string, { signatures: Set<string>; timestamps: number[] }>();
    const seenCursors = new Set<string>();
    const seenSignatures = new Set<string>();
    let cursor: string | null = null;
    let walletComplete = false;

    for (let pageNumber = 0; pageNumber < WALLET_HISTORY_MAX_PAGES; pageNumber += 1) {
      const params: Record<string, unknown> = {
        commitment: "confirmed",
        mint: SOL_QUOTE_MINT,
        direction: "in",
        solMode: "merged",
        limit: WALLET_HISTORY_PAGE_SIZE,
        ...(cursor ? { paginationToken: cursor } : {})
      };
      const response = await rpc(fetcher, url, "getTransfersByAddress", [wallet, params]);
      pagesScanned += 1;
      if (!response.ok) {
        warnings.push(`SOL transfer history failed for wallet ${wallet}.`);
        incomplete = true;
        break;
      }
      const payload = asRecord(response.result);
      if (!payload || !Array.isArray(payload.data) || payload.data.length > WALLET_HISTORY_PAGE_SIZE) {
        warnings.push(`SOL transfer history page was malformed for wallet ${wallet}.`);
        incomplete = true;
        break;
      }
      const nextCursor = payload.paginationToken;
      if (nextCursor !== undefined && nextCursor !== null &&
          (typeof nextCursor !== "string" || nextCursor.length === 0 || seenCursors.has(nextCursor))) {
        warnings.push(`SOL transfer history pagination cursor was invalid or repeated for wallet ${wallet}.`);
        incomplete = true;
        break;
      }

      for (const raw of payload.data) {
        const transfer = asRecord(raw);
        const signature = transfer?.signature;
        const blockTime = transfer?.blockTime;
        const source = transfer?.fromUserAccount;
        const destination = transfer?.toUserAccount;
        const amount = transfer?.amount;
        if (transfer?.type !== "transfer" || transfer.mint !== SOL_QUOTE_MINT ||
            typeof signature !== "string" || !SIGNATURE.test(signature) ||
            !Number.isSafeInteger(blockTime) || (blockTime as number) < 0 ||
            typeof source !== "string" || !ADDRESS.test(source) ||
            typeof destination !== "string" || destination !== wallet ||
            source === wallet || typeof amount !== "string" || !/^[1-9][0-9]*$/.test(amount)) {
          warnings.push(`A SOL transfer row was malformed or did not match the requested wallet for ${wallet}.`);
          incomplete = true;
          break;
        }
        transfersChecked += 1;
        seenSignatures.add(signature);
        const evidence = counts.get(source) ?? { signatures: new Set<string>(), timestamps: [] };
        evidence.signatures.add(signature);
        evidence.timestamps.push(blockTime as number);
        counts.set(source, evidence);
      }
      if (incomplete && warnings[warnings.length - 1]?.includes(wallet)) break;

      if (typeof nextCursor !== "string" || nextCursor.length === 0) {
        walletComplete = true;
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      if (pageNumber === WALLET_HISTORY_MAX_PAGES - 1) {
        warnings.push(`Wallet ${wallet} SOL transfer history exceeded the configured ${WALLET_HISTORY_MAX_PAGES * WALLET_HISTORY_PAGE_SIZE}-transfer cap.`);
        incomplete = true;
      }
    }

    if (!walletComplete) incomplete = true;
    if (seenSignatures.size === 0) {
      warnings.push(`No incoming SOL transfers were found for wallet ${wallet}; the provider reported no remaining pages.`);
    }
    funderCounts.set(wallet, counts);
  }

  const walletByFunder = new Map<string, Array<{ wallet: string; timestamps: number[] }>>();
  for (const [wallet, counts] of funderCounts) {
    for (const [funder, evidence] of counts) {
      if (evidence.signatures.size < 1 || evidence.timestamps.length < 1) continue;
      const sorted = [...evidence.timestamps].sort((a, b) => a - b);
      if (sorted[sorted.length - 1]! - sorted[0]! > 60) continue;
      const recipients = walletByFunder.get(funder) ?? [];
      recipients.push({ wallet, timestamps: evidence.timestamps });
      walletByFunder.set(funder, recipients);
    }
  }

  const links: WalletLinkEvidence[] = [];
  const emitted = new Set<string>();
  for (const recipients of walletByFunder.values()) {
    for (let i = 0; i < recipients.length; i += 1) {
      for (let j = i + 1; j < recipients.length; j += 1) {
        const a = recipients[i]!, b = recipients[j]!;
        const times = [...a.timestamps, ...b.timestamps].sort((x, y) => x - y);
        if (times[times.length - 1]! - times[0]! > 60) continue;
        const pair = [a.wallet, b.wallet].sort();
        const key = pair.join(":");
        if (emitted.has(key)) continue;
        emitted.add(key);
        links.push({
          mint, walletA: pair[0]!, walletB: pair[1]!, confidenceBps: 7_000,
          evidence: ["COMMON_FUNDER", "REPEATED_FUNDING"],
          observedAt: new Date().toISOString()
        });
      }
    }
  }

  if (links.length === 0) warnings.push("No repeated common SOL-funder relationship was observed in the completely collected transfer histories.");
  const complete = !incomplete && walletSetComplete;
  return result(mint, complete ? "OBSERVED" : "DATA_INCOMPLETE", complete, walletSetComplete,
    uniqueWallets.length, uniqueWallets.length, transfersChecked, pagesScanned, warnings, links, uniqueWallets, complete ? uniqueWallets : []);
}

async function rpc(
  fetcher: typeof fetch, url: string, method: string, params: unknown[]
): Promise<{ ok: true; result: unknown } | { ok: false }> {
  try {
    const response = await fetcher(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params })
    });
    if (!response.ok) return { ok: false };
    const envelope = asRecord(await response.json());
    if (!envelope || envelope.error || !Object.prototype.hasOwnProperty.call(envelope, "result")) return { ok: false };
    return { ok: true, result: envelope.result };
  } catch {
    return { ok: false };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function result(
  mint: string, status: CompleteWalletFundingEvidenceResult["status"], dataComplete: boolean,
  walletSetComplete: boolean, walletsRequested: number, walletsChecked: number,
  transfersChecked: number, pagesScanned: number, warnings: string[],
  links: WalletLinkEvidence[] = [], requestedWallets: string[] = [], walletsCovered: string[] = []
): CompleteWalletFundingEvidenceResult {
  return {
    provider: "helius", mint, status,
    coverage: dataComplete ? "FULL_SOL_TRANSFER_HISTORY_WITHIN_CONFIGURED_CAP" : "INCOMPLETE_SOL_TRANSFER_HISTORY",
    dataComplete, walletSetComplete, walletsRequested, requestedWallets, walletsCovered, walletsChecked,
    transfersChecked, pagesScanned, links, warnings, observedAt: new Date().toISOString()
  };
}
