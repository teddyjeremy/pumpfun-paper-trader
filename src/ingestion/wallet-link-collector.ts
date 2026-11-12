import { buildHeliusRpcUrl } from "./helius.js";
import type { WalletLinkEvidence } from "./wallet-cluster-risk.js";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_WALLETS = 8;
const SIGNATURE_SAMPLE = 20;
const MAX_TRANSACTIONS_PER_WALLET = 3;

export interface WalletFundingEvidenceResult {
  provider: "helius";
  mint: string;
  status: "OBSERVED" | "DATA_INCOMPLETE";
  coverage: "RECENT_SIGNATURE_SAMPLE_ONLY";
  walletsChecked: number;
  transactionsChecked: number;
  links: WalletLinkEvidence[];
  warnings: string[];
  observedAt: string;
}

export interface WalletFundingEvidenceConfig {
  apiKey: string;
  fetcher?: typeof fetch;
}

/**
 * Bounded standard-RPC funding inspection. It samples up to three of the
 * oldest signatures among each wallet's latest twenty signatures and only
 * recognizes parsed System Program SOL transfers. A common funder is emitted
 * as a >=70% link only when at least two separate funding transfers to EACH
 * wallet are observed. This is still partial evidence, never a clean-wallet
 * clearance; exchanges, custodians and unobserved older funding remain risks.
 */
export async function collectWalletFundingEvidence(
  mint: string,
  wallets: readonly string[],
  config: WalletFundingEvidenceConfig
): Promise<WalletFundingEvidenceResult> {
  const warnings = [
    "Only the latest 20 signatures per wallet are sampled; this is not a complete wallet history.",
    "A shared funder can be an exchange, custodian, or service and is not proof of common ownership.",
    "No observed link is UNKNOWN, never a wallet-cluster safety PASS."
  ];
  if (!ADDRESS.test(mint)) {
    return emptyResult(mint, "DATA_INCOMPLETE", warnings, 0, 0);
  }
  const uniqueWallets = [...new Set(wallets.filter(wallet => ADDRESS.test(wallet)))].slice(0, MAX_WALLETS);
  if (uniqueWallets.length < 2) {
    return emptyResult(mint, "DATA_INCOMPLETE", [...warnings, "At least two valid wallets are required."], uniqueWallets.length, 0);
  }

  const fetcher = config.fetcher ?? fetch;
  const url = buildHeliusRpcUrl(config.apiKey);
  const funderCounts = new Map<string, Map<string, number>>();
  let transactionsChecked = 0;
  let incomplete = false;

  for (const wallet of uniqueWallets) {
    const signatures = await rpc(fetcher, url, "getSignaturesForAddress", [wallet, {
      commitment: "confirmed", limit: SIGNATURE_SAMPLE
    }]);
    if (!signatures.ok || !Array.isArray(signatures.result)) {
      incomplete = true;
      warnings.push("Signature history could not be completely read for one or more wallets.");
      continue;
    }
    const validSignatures = signatures.result.filter(item =>
      item && typeof item === "object" &&
      typeof (item as Record<string, unknown>).signature === "string"
    ).map(item => (item as Record<string, unknown>).signature as string);
    // The RPC returns newest first; inspect the oldest three in this bounded
    // recent sample to approximate initial funding without unbounded history.
    const sample = validSignatures.slice(-MAX_TRANSACTIONS_PER_WALLET);
    const counts = new Map<string, Set<string>>();
    for (const signature of sample) {
      const tx = await rpc(fetcher, url, "getTransaction", [signature, {
        encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0
      }]);
      if (!tx.ok || !tx.result || typeof tx.result !== "object") {
        incomplete = true;
        continue;
      }
      transactionsChecked += 1;
      for (const transfer of parsedSystemTransfers(tx.result)) {
        if (transfer.destination !== wallet || transfer.source === wallet) continue;
        const signaturesFromFunder = counts.get(transfer.source) ?? new Set<string>();
        signaturesFromFunder.add(signature);
        counts.set(transfer.source, signaturesFromFunder);
      }
    }
    funderCounts.set(wallet, counts);
  }

  const walletByFunder = new Map<string, string[]>();
  for (const [wallet, counts] of funderCounts) {
    for (const [funder, fundingSignatures] of counts) {
      if (fundingSignatures.size < 2) continue;
      const recipients = walletByFunder.get(funder) ?? [];
      recipients.push(wallet);
      walletByFunder.set(funder, recipients);
    }
  }

  const links: WalletLinkEvidence[] = [];
  const emitted = new Set<string>();
  for (const [funder, recipients] of walletByFunder) {
    for (let i = 0; i < recipients.length; i += 1) {
      for (let j = i + 1; j < recipients.length; j += 1) {
        const a = recipients[i]!;
        const b = recipients[j]!;
        const pair = [a, b].sort();
        const key = pair.join(":");
        if (emitted.has(key)) continue;
        emitted.add(key);
        links.push({
          mint, walletA: pair[0]!, walletB: pair[1]!,
          confidenceBps: 7_000,
          evidence: ["COMMON_FUNDER", "REPEATED_FUNDING"],
          observedAt: new Date().toISOString()
        });
      }
    }
  }

  if (links.length === 0) warnings.push("No repeated common-funder relationship was observed in the sampled transaction history.");
  return {
    provider: "helius", mint,
    status: incomplete ? "DATA_INCOMPLETE" : "OBSERVED",
    coverage: "RECENT_SIGNATURE_SAMPLE_ONLY",
    walletsChecked: uniqueWallets.length,
    transactionsChecked,
    links,
    warnings,
    observedAt: new Date().toISOString()
  };
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
  fetcher: typeof fetch,
  url: string,
  method: string,
  params: unknown[]
): Promise<{ ok: true; result: unknown } | { ok: false }> {
  try {
    const response = await fetcher(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params })
    });
    if (!response.ok) return { ok: false };
    const payload = asRecord(await response.json());
    if (!payload || payload.error || !Object.prototype.hasOwnProperty.call(payload, "result")) return { ok: false };
    return { ok: true, result: payload.result };
  } catch {
    return { ok: false };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function emptyResult(
  mint: string, status: WalletFundingEvidenceResult["status"], warnings: string[],
  walletsChecked: number, transactionsChecked: number
): WalletFundingEvidenceResult {
  return {
    provider: "helius", mint, status, coverage: "RECENT_SIGNATURE_SAMPLE_ONLY",
    walletsChecked, transactionsChecked, links: [], warnings, observedAt: new Date().toISOString()
  };
}
