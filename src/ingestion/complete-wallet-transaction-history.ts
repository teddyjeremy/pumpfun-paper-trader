import { buildHeliusRpcUrl } from "./helius.js";
import type { WalletLinkEvidence } from "./wallet-cluster-risk.js";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;
export const WALLET_TRANSACTION_HISTORY_PAGE_SIZE = 100;
export const WALLET_TRANSACTION_HISTORY_MAX_PAGES = 2;
export const WALLET_TRANSACTION_HISTORY_MAX_WALLETS = 16;

export interface CompleteWalletTransactionHistoryResult {
  provider: "helius";
  mint: string;
  status: "OBSERVED" | "DATA_INCOMPLETE";
  coverage: "FULL_WALLET_HISTORY_WITHIN_CONFIGURED_CAP" | "INCOMPLETE_WALLET_HISTORY";
  dataComplete: boolean;
  walletSetComplete: boolean;
  requestedWallets: string[];
  walletsCovered: string[];
  walletsRequested: number;
  walletsChecked: number;
  transactionsChecked: number;
  pagesScanned: number;
  estimatedCredits: number;
  links: WalletLinkEvidence[];
  warnings: string[];
  observedAt: string;
}

export interface CompleteWalletTransactionHistoryConfig {
  apiKey: string;
  /** Must be true only when the caller has independently verified the complete buyer set. */
  walletSetVerifiedComplete: boolean;
  fetcher?: typeof fetch;
  maxPages?: number;
}

/**
 * Fetch every transaction for each supplied wallet using Helius cursor
 * pagination. Reaching the configured page cap with a continuation cursor is
 * DATA_INCOMPLETE, never a complete history. The bounded maximum is 200
 * transactions per wallet by default (2 x 100), and up to 16 wallets.
 *
 * This scans all wallet transactions in the configured provider history,
 * unlike getTransfersByAddress which sees only parsed transfer events. It
 * extracts common System Program funders and repeated non-wallet signers.
 */
export async function collectCompleteWalletTransactionHistory(
  mint: string,
  wallets: readonly string[],
  config: CompleteWalletTransactionHistoryConfig
): Promise<CompleteWalletTransactionHistoryResult> {
  const uniqueWallets = [...new Set(wallets.filter(wallet => ADDRESS.test(wallet)))];
  const suppliedSetValid = uniqueWallets.length === wallets.length;
  const walletSetComplete = config.walletSetVerifiedComplete === true &&
    suppliedSetValid && uniqueWallets.length <= WALLET_TRANSACTION_HISTORY_MAX_WALLETS;
  const maxPages = config.maxPages ?? WALLET_TRANSACTION_HISTORY_MAX_PAGES;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 5) {
    throw new Error("Wallet transaction history maxPages must be between 1 and 5.");
  }
  const warnings: string[] = [];
  if (!ADDRESS.test(mint) || uniqueWallets.length < 2) {
    return result(mint, false, walletSetComplete, uniqueWallets, [], 0, 0, 0, 0,
      ["A valid mint and at least two unique wallets are required."]);
  }
  if (!walletSetComplete) {
    warnings.push("The buyer set is not independently complete, exceeds sixteen wallets, or contains invalid/duplicate entries; only the first sixteen wallets are scanned for positive risk evidence.");
  }

  const selectedWallets = uniqueWallets.slice(0, WALLET_TRANSACTION_HISTORY_MAX_WALLETS);
  const fetcher = config.fetcher ?? fetch;
  const url = buildHeliusRpcUrl(config.apiKey);
  const completedWallets = new Set<string>();
  const funderEvidence = new Map<string, Map<string, { signatures: Set<string>; timestamps: number[] }>>();
  const authorityEvidence = new Map<string, Map<string, { signatures: Set<string>; timestamps: number[] }>>();
  let transactionsChecked = 0;
  let pagesScanned = 0;
  let walletsChecked = 0;
  let incomplete = !walletSetComplete;

  for (const wallet of selectedWallets) {
    walletsChecked += 1;
    const seenSignatures = new Set<string>();
    const funders = new Map<string, { signatures: Set<string>; timestamps: number[] }>();
    const authorities = new Map<string, { signatures: Set<string>; timestamps: number[] }>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let walletComplete = false;

    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const params: Record<string, unknown> = {
        commitment: "confirmed",
        transactionDetails: "full",
        limit: WALLET_TRANSACTION_HISTORY_PAGE_SIZE,
        ...(cursor ? { paginationToken: cursor } : {})
      };
      const response = await rpc(fetcher, url, "getTransactionsForAddress", [wallet, params]);
      pagesScanned += 1;
      if (!response.ok) {
        warnings.push(`Transaction history request failed for wallet ${wallet}.`);
        incomplete = true;
        break;
      }
      const payload = asRecord(response.result);
      if (!payload || !Array.isArray(payload.data) ||
          payload.data.length > WALLET_TRANSACTION_HISTORY_PAGE_SIZE) {
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
        const txRoot = asRecord(transaction?.transaction);
        const message = asRecord(txRoot?.message);
        if (typeof signature !== "string" || !SIGNATURE.test(signature) ||
            !Number.isSafeInteger(slot) || (slot as number) < 0 ||
            !Number.isSafeInteger(blockTime) || (blockTime as number) < 0 ||
            !meta || !Object.prototype.hasOwnProperty.call(meta, "err") ||
            !message || seenSignatures.has(signature)) {
          warnings.push(`A transaction record was malformed, duplicated, or missing verifiable block metadata for wallet ${wallet}.`);
          incomplete = true;
          walletComplete = false;
          break;
        }
        seenSignatures.add(signature);
        transactionsChecked += 1;
        if (meta.err !== null) continue;

        const accountKeys = Array.isArray(message.accountKeys) ? message.accountKeys : [];
        const signers = accountKeys.flatMap((rawKey, index) => {
          const key = asRecord(rawKey);
          const address = typeof rawKey === "string" ? rawKey : key?.pubkey;
          const signer = typeof rawKey === "string" ? index === 0 : key?.signer === true;
          return signer && typeof address === "string" && ADDRESS.test(address) && address !== wallet
            ? [address] : [];
        });
        const feePayer = typeof transaction.feePayer === "string" && ADDRESS.test(transaction.feePayer)
          ? transaction.feePayer
          : accountKeys.length > 0
            ? keyAddress(accountKeys[0])
            : null;
        const sharedAuthorities = new Set([...signers, ...(feePayer && feePayer !== wallet ? [feePayer] : [])]);
        for (const authority of sharedAuthorities) {
          const evidence = authorities.get(authority) ?? { signatures: new Set<string>(), timestamps: [] };
          evidence.signatures.add(signature);
          evidence.timestamps.push(blockTime as number);
          authorities.set(authority, evidence);
        }

        for (const transfer of parsedSystemTransfers(transaction)) {
          if (transfer.destination !== wallet || transfer.source === wallet) continue;
          const evidence = funders.get(transfer.source) ?? { signatures: new Set<string>(), timestamps: [] };
          evidence.signatures.add(signature);
          evidence.timestamps.push(blockTime as number);
          funders.set(transfer.source, evidence);
        }
      }
      if (incomplete && !walletComplete && warnings[warnings.length - 1]?.includes(wallet)) break;
      if (typeof nextCursor !== "string" || nextCursor.length === 0) {
        walletComplete = true;
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      if (pageNumber === maxPages - 1) {
        warnings.push(`Wallet ${wallet} history exceeded the configured ${maxPages * WALLET_TRANSACTION_HISTORY_PAGE_SIZE}-transaction cap.`);
        incomplete = true;
      }
    }
    if (walletComplete) completedWallets.add(wallet);
    else incomplete = true;
    funderEvidence.set(wallet, funders);
    authorityEvidence.set(wallet, authorities);
  }

  const links: WalletLinkEvidence[] = [];
  const emitted = new Set<string>();
  const emitPairs = (
    evidenceByWallet: Map<string, Map<string, { signatures: Set<string>; timestamps: number[] }>>,
    evidenceType: "COMMON_FUNDER" | "SHARED_AUTHORITY"
  ) => {
    const recipientsByEvidence = new Map<string, Array<{ wallet: string; timestamps: number[] }>>();
    for (const [wallet, evidenceMap] of evidenceByWallet) {
      for (const [identity, evidence] of evidenceMap) {
        if (evidence.signatures.size < 1 || evidence.timestamps.length < 1) continue;
        const recipients = recipientsByEvidence.get(identity) ?? [];
        recipients.push({ wallet, timestamps: evidence.timestamps });
        recipientsByEvidence.set(identity, recipients);
      }
    }
    for (const recipients of recipientsByEvidence.values()) {
      for (let i = 0; i < recipients.length; i += 1) {
        for (let j = i + 1; j < recipients.length; j += 1) {
          const a = recipients[i]!, b = recipients[j]!;
          const times = [...a.timestamps, ...b.timestamps].sort((x, y) => x - y);
          if (times[times.length - 1]! - times[0]! > 60) continue;
          const pair = [a.wallet, b.wallet].sort();
          const key = `${evidenceType}:${pair.join(":")}`;
          if (emitted.has(key)) continue;
          emitted.add(key);
          links.push({
            mint, walletA: pair[0]!, walletB: pair[1]!, confidenceBps: 7_000,
            evidence: evidenceType === "COMMON_FUNDER"
              ? ["COMMON_FUNDER", "REPEATED_FUNDING"] as const : ["SHARED_AUTHORITY"] as const,
            observedAt: new Date().toISOString()
          });
        }
      }
    }
  };
  emitPairs(funderEvidence, "COMMON_FUNDER");
  emitPairs(authorityEvidence, "SHARED_AUTHORITY");

  const dataComplete = !incomplete && walletSetComplete && completedWallets.size === selectedWallets.length;
  if (links.length === 0) warnings.push("No common funder or shared-authority relationship was observed in the completely collected wallet histories.");
  return result(mint, dataComplete, walletSetComplete, uniqueWallets,
    [...completedWallets], walletsChecked, transactionsChecked, pagesScanned,
    pagesScanned * 100, warnings, links);
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

function keyAddress(value: unknown): string | null {
  if (typeof value === "string") return ADDRESS.test(value) ? value : null;
  const row = asRecord(value);
  return typeof row?.pubkey === "string" && ADDRESS.test(row.pubkey) ? row.pubkey : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function result(
  mint: string, dataComplete: boolean, walletSetComplete: boolean, requestedWallets: string[],
  walletsCovered: string[], walletsChecked: number, transactionsChecked: number, pagesScanned: number,
  estimatedCredits: number, warnings: string[], links: WalletLinkEvidence[] = []
): CompleteWalletTransactionHistoryResult {
  return {
    provider: "helius", mint,
    status: dataComplete ? "OBSERVED" : "DATA_INCOMPLETE",
    coverage: dataComplete ? "FULL_WALLET_HISTORY_WITHIN_CONFIGURED_CAP" : "INCOMPLETE_WALLET_HISTORY",
    dataComplete, walletSetComplete, requestedWallets, walletsCovered,
    walletsRequested: requestedWallets.length, walletsChecked,
    transactionsChecked, pagesScanned, estimatedCredits, links, warnings,
    observedAt: new Date().toISOString()
  };
}
