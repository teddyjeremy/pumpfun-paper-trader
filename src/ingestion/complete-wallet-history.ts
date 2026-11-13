import { buildHeliusRpcUrl } from "./helius.js";
import type { WalletLinkEvidence } from "./wallet-cluster-risk.js";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;
export const WALLET_HISTORY_PAGE_SIZE = 100;
export const WALLET_HISTORY_MAX_PAGES = 5;
export const WALLET_HISTORY_MAX_WALLETS = 8;

export interface CompleteWalletFundingEvidenceResult {
  provider: "helius";
  mint: string;
  status: "OBSERVED" | "DATA_INCOMPLETE";
  coverage: "FULL_HISTORY_WITHIN_CONFIGURED_CAP" | "INCOMPLETE_HISTORY";
  dataComplete: boolean;
  walletSetComplete: boolean;
  walletsRequested: number;
  walletsChecked: number;
  transactionsChecked: number;
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
 * Collects every available transaction for the supplied wallets using Helius'
 * cursor-paginated getTransactionsForAddress RPC. A wallet is complete only
 * when the provider returns no continuation cursor before the hard page cap.
 * The cap is a safety bound, never evidence of completion.
 *
 * The caller must supply the complete set of relevant wallets. This collector
 * deliberately reports walletSetComplete=false when more than eight are
 * supplied, rather than silently treating the selected subset as the cluster.
 */
export async function collectCompleteWalletFundingEvidence(
  mint: string,
  wallets: readonly string[],
  config: CompleteWalletFundingEvidenceConfig
): Promise<CompleteWalletFundingEvidenceResult> {
  const warnings: string[] = [];
  const uniqueWallets = [...new Set(wallets.filter(wallet => ADDRESS.test(wallet)))];
  const walletSetComplete = uniqueWallets.length <= WALLET_HISTORY_MAX_WALLETS &&
    uniqueWallets.length === wallets.filter(wallet => ADDRESS.test(wallet)).length;
  if (!ADDRESS.test(mint) || uniqueWallets.length < 2) {
    return result(mint, "DATA_INCOMPLETE", false, walletSetComplete, uniqueWallets.length, 0, 0, 0,
      ["A valid mint and at least two unique wallets are required."]);
  }
  if (!walletSetComplete) {
    warnings.push("The supplied wallet set exceeds the bounded eight-wallet collection limit or contains duplicate wallet entries.");
    return result(mint, "DATA_INCOMPLETE", false, false, uniqueWallets.length, 0, 0, 0, warnings);
  }

  const fetcher = config.fetcher ?? fetch;
  const url = buildHeliusRpcUrl(config.apiKey);
  const selectedWallets = uniqueWallets.slice(0, WALLET_HISTORY_MAX_WALLETS);
  const funderCounts = new Map<string, Map<string, { signatures: Set<string>; timestamps: number[] }>>();
  let transactionsChecked = 0;
  let pagesScanned = 0;
  let incomplete = !walletSetComplete;

  for (const wallet of selectedWallets) {
    const counts = new Map<string, { signatures: Set<string>; timestamps: number[] }>();
    const seenSignatures = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let walletComplete = false;

    for (let pageNumber = 0; pageNumber < WALLET_HISTORY_MAX_PAGES; pageNumber += 1) {
      const params: Record<string, unknown> = {
        commitment: "confirmed",
        transactionDetails: "full",
        limit: WALLET_HISTORY_PAGE_SIZE,
        ...(cursor ? { paginationToken: cursor } : {})
      };
      const response = await rpc(fetcher, url, "getTransactionsForAddress", [wallet, params]);
      pagesScanned += 1;
      if (!response.ok) {
        warnings.push(`Transaction history failed for wallet ${wallet}.`);
        incomplete = true;
        break;
      }
      const payload = asRecord(response.result);
      if (!payload || !Array.isArray(payload.data) || payload.data.length > WALLET_HISTORY_PAGE_SIZE) {
        warnings.push(`Transaction history page was malformed for wallet ${wallet}.`);
        incomplete = true;
        break;
      }
      const nextCursor = payload.paginationToken;
      if (nextCursor !== undefined && nextCursor !== null &&
          (typeof nextCursor !== "string" || nextCursor.length === 0 || seenCursors.has(nextCursor))) {
        warnings.push(`Transaction history pagination cursor was invalid or repeated for wallet ${wallet}.`);
        incomplete = true;
        break;
      }

      for (const raw of payload.data) {
        const transaction = asRecord(raw);
        const signature = transaction?.signature;
        const slot = transaction?.slot;
        const blockTime = transaction?.blockTime;
        const meta = asRecord(transaction?.meta);
        if (typeof signature !== "string" || !SIGNATURE.test(signature) ||
            !Number.isSafeInteger(slot) || (slot as number) < 0 ||
            !Number.isSafeInteger(blockTime) || (blockTime as number) < 0 ||
            !meta || !Object.prototype.hasOwnProperty.call(meta, "err") ||
            seenSignatures.has(signature)) {
          warnings.push(`A transaction record was malformed, duplicated, or lacked a verifiable timestamp for wallet ${wallet}.`);
          incomplete = true;
          walletComplete = false;
          break;
        }
        seenSignatures.add(signature);
        transactionsChecked += 1;
        if (meta.err !== null) continue;
        for (const transfer of parsedSystemTransfers(transaction)) {
          if (transfer.destination !== wallet || transfer.source === wallet) continue;
          const evidence = counts.get(transfer.source) ?? { signatures: new Set<string>(), timestamps: [] };
          evidence.signatures.add(signature);
          evidence.timestamps.push(blockTime as number);
          counts.set(transfer.source, evidence);
        }
      }
      if (incomplete && !walletComplete && warnings.length > 0 &&
          warnings[warnings.length - 1]!.includes(wallet)) break;

      if (typeof nextCursor !== "string" || nextCursor.length === 0) {
        walletComplete = true;
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      if (pageNumber === WALLET_HISTORY_MAX_PAGES - 1) {
        warnings.push(`Wallet ${wallet} history exceeded the configured ${WALLET_HISTORY_MAX_PAGES * WALLET_HISTORY_PAGE_SIZE}-transaction cap.`);
        incomplete = true;
      }
    }

    if (!walletComplete) incomplete = true;
    if (seenSignatures.size === 0) {
      warnings.push(`No verifiable transaction history was returned for wallet ${wallet}.`);
      incomplete = true;
    }
    funderCounts.set(wallet, counts);
  }

  const walletByFunder = new Map<string, Array<{ wallet: string; timestamps: number[] }>>();
  for (const [wallet, counts] of funderCounts) {
    for (const [funder, evidence] of counts) {
      if (evidence.signatures.size < 2 || evidence.timestamps.length < 2) continue;
      const sorted = [...evidence.timestamps].sort((a, b) => a - b);
      if (sorted[sorted.length - 1]! - sorted[0]! > 60) continue;
      const recipients = walletByFunder.get(funder) ?? [];
      recipients.push({ wallet, timestamps: evidence.timestamps });
      walletByFunder.set(funder, recipients);
    }
  }

  const links: WalletLinkEvidence[] = [];
  const emitted = new Set<string>();
  for (const [funder, recipients] of walletByFunder) {
    void funder;
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

  if (links.length === 0) warnings.push("No repeated common-funder relationship was observed in the completely collected wallet histories.");
  const complete = !incomplete && walletSetComplete;
  return result(mint, complete ? "OBSERVED" : "DATA_INCOMPLETE", complete, walletSetComplete,
    uniqueWallets.length, selectedWallets.length, transactionsChecked, pagesScanned, warnings, links);
}

function parsedSystemTransfers(input: unknown): Array<{ source: string; destination: string }> {
  const root = asRecord(input);
  const transaction = asRecord(root?.transaction);
  const message = asRecord(transaction?.message);
  const meta = asRecord(root?.meta);
  const instructions: unknown[] = [
    ...(Array.isArray(message?.instructions) ? message.instructions : []),
    ...(Array.isArray(meta?.innerInstructions) ? meta.innerInstructions.flatMap(group => {
      const row = asRecord(group);
      return Array.isArray(row?.instructions) ? row.instructions : [];
    }) : [])
  ];
  const output: Array<{ source: string; destination: string }> = [];
  for (const raw of instructions) {
    const instruction = asRecord(raw);
    const parsed = asRecord(instruction?.parsed);
    const info = asRecord(parsed?.info);
    if (instruction?.program !== "system" || parsed?.type !== "transfer" ||
        typeof info?.source !== "string" || !ADDRESS.test(info.source) ||
        typeof info.destination !== "string" || !ADDRESS.test(info.destination) ||
        typeof info.lamports !== "number" || !Number.isSafeInteger(info.lamports) || info.lamports <= 0) continue;
    output.push({ source: info.source, destination: info.destination });
  }
  return output;
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
  transactionsChecked: number, pagesScanned: number, warnings: string[],
  links: WalletLinkEvidence[] = []
): CompleteWalletFundingEvidenceResult {
  return {
    provider: "helius", mint, status,
    coverage: dataComplete ? "FULL_HISTORY_WITHIN_CONFIGURED_CAP" : "INCOMPLETE_HISTORY",
    dataComplete, walletSetComplete, walletsRequested, walletsChecked,
    transactionsChecked, pagesScanned, links, warnings, observedAt: new Date().toISOString()
  };
}
