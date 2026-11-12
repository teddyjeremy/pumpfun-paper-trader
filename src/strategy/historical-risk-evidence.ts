import type { WalletHoldingEvidence, WalletLinkEvidence } from "../ingestion/wallet-cluster-risk.js";

export interface PersistedRiskEvidenceEvent {
  occurredAt: string;
  payload: unknown;
}

export interface HydratedHistoricalRiskEvidence {
  walletLinks: WalletLinkEvidence[];
  walletHoldings: WalletHoldingEvidence[];
  walletClusterEvidenceCoverage?: "FULL_WALLET_HISTORY" | "RECENT_SIGNATURE_SAMPLE_ONLY";
  walletClusterEvidenceCompleteAt?: number;
  holderCensusCompleteAt?: number;
  riskEvidenceEventCount: number;
  riskEvidenceTruncated: boolean;
}

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LINK_EVIDENCE = new Set([
  "COMMON_FUNDER", "REPEATED_FUNDING", "SHARED_AUTHORITY", "REPEATED_TOKEN_TRANSFER"
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function parsePayload(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try { return asRecord(JSON.parse(value)); } catch { return null; }
  }
  return asRecord(value);
}

function timestamp(value: unknown): { iso: string; seconds: number } | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  const seconds = Math.floor(milliseconds / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  return { iso: new Date(milliseconds).toISOString(), seconds };
}

function parseWalletLink(value: unknown, mint: string): WalletLinkEvidence | null {
  const link = asRecord(value);
  if (!link) return null;
  const walletA = link.walletA;
  const walletB = link.walletB;
  const confidenceBps = link.confidenceBps;
  const observedAt = timestamp(link.observedAt);
  const evidence = Array.isArray(link.evidence)
    ? link.evidence.filter((item): item is string => typeof item === "string" && LINK_EVIDENCE.has(item))
    : [];
  if (link.mint !== undefined && link.mint !== mint) return null;
  if (typeof walletA !== "string" || !ADDRESS.test(walletA) ||
      typeof walletB !== "string" || !ADDRESS.test(walletB) || walletA === walletB ||
      !Number.isSafeInteger(confidenceBps) || (confidenceBps as number) < 0 ||
      (confidenceBps as number) > 10_000 || !observedAt || evidence.length === 0) return null;
  return {
    mint, walletA, walletB, confidenceBps: confidenceBps as number,
    evidence: [...new Set(evidence)] as WalletLinkEvidence["evidence"],
    observedAt: observedAt.iso
  };
}

function parseHolderAccounts(snapshot: Record<string, unknown>, mint: string): WalletHoldingEvidence[] {
  const observedAt = timestamp(snapshot.observedAt);
  if (!observedAt || !Array.isArray(snapshot.accounts)) return [];
  const holdings: WalletHoldingEvidence[] = [];
  for (const value of snapshot.accounts) {
    const account = asRecord(value);
    if (!account || typeof account.owner !== "string" || !ADDRESS.test(account.owner) ||
        typeof account.amount !== "string" || !/^[1-9]\d*$/.test(account.amount)) continue;
    holdings.push({ mint, wallet: account.owner, amount: account.amount, observedAt: observedAt.iso });
  }
  return holdings;
}

/**
 * Rehydrates only timestamped evidence from the append-only RISK_EVIDENCE audit
 * events. Partial provider coverage remains partial; top-20 holders and recent
 * signature samples can contribute observed rejects but can never clear risk.
 */
export function hydrateHistoricalRiskEvidence(input: {
  mint: string;
  events: readonly PersistedRiskEvidenceEvent[];
  eventCount?: number;
  truncated?: boolean;
}): HydratedHistoricalRiskEvidence {
  if (!ADDRESS.test(input.mint)) throw new Error("Historical risk evidence requires a valid mint.");
  const truncated = input.truncated ?? false;
  const walletLinks = new Map<string, WalletLinkEvidence>();
  const walletHoldings = new Map<string, WalletHoldingEvidence>();
  let walletClusterEvidenceCoverage: HydratedHistoricalRiskEvidence["walletClusterEvidenceCoverage"];
  let walletClusterEvidenceCompleteAt: number | undefined;
  let holderCensusCompleteAt: number | undefined;

  for (const event of input.events) {
    const payload = parsePayload(event.payload);
    if (!payload) continue;
    if (payload.evidenceType === "WALLET_CLUSTER") {
      const funding = asRecord(payload.fundingEvidence);
      if (!funding) continue;
      const coverage = funding.coverage;
      if (coverage === "RECENT_SIGNATURE_SAMPLE_ONLY") {
        walletClusterEvidenceCoverage = "RECENT_SIGNATURE_SAMPLE_ONLY";
      }
      const observedAt = timestamp(funding.observedAt);
      if (!truncated && funding.status === "OBSERVED" &&
          coverage === "FULL_WALLET_HISTORY" && observedAt) {
        walletClusterEvidenceCoverage = "FULL_WALLET_HISTORY";
        walletClusterEvidenceCompleteAt = observedAt.seconds;
      }
      if (Array.isArray(funding.links)) {
        for (const rawLink of funding.links) {
          const link = parseWalletLink(rawLink, input.mint);
          if (!link) continue;
          const key = [link.walletA, link.walletB].sort().join(":") + ":" + link.observedAt;
          walletLinks.set(key, link);
        }
      }
    } else if (payload.evidenceType === "HOLDER_CONCENTRATION") {
      const result = asRecord(payload.result);
      const snapshot = asRecord(result?.snapshot);
      if (!snapshot || result?.status !== "OBSERVED") continue;
      for (const holding of parseHolderAccounts(snapshot, input.mint)) {
        const key = `${holding.wallet}:${holding.observedAt}`;
        walletHoldings.set(key, holding);
      }
      const observedAt = timestamp(snapshot.observedAt);
      if (!truncated && snapshot.dataComplete === true &&
          snapshot.coverage === "FULL_HOLDER_CENSUS" && observedAt) {
        holderCensusCompleteAt = observedAt.seconds;
      }
    }
  }

  if (truncated) {
    walletClusterEvidenceCoverage = "RECENT_SIGNATURE_SAMPLE_ONLY";
    walletClusterEvidenceCompleteAt = undefined;
    holderCensusCompleteAt = undefined;
  }
  return {
    walletLinks: [...walletLinks.values()],
    walletHoldings: [...walletHoldings.values()],
    ...(walletClusterEvidenceCoverage === undefined ? {} : { walletClusterEvidenceCoverage }),
    ...(walletClusterEvidenceCompleteAt === undefined ? {} : { walletClusterEvidenceCompleteAt }),
    ...(holderCensusCompleteAt === undefined ? {} : { holderCensusCompleteAt }),
    riskEvidenceEventCount: input.eventCount ?? input.events.length,
    riskEvidenceTruncated: truncated
  };
}
