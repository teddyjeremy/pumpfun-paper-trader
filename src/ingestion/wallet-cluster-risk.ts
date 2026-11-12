import type { PumpTradeEvent } from "./pump-events.js";
import type { VerifiedPumpTransaction } from "./helius.js";

export const MIN_LINK_CONFIDENCE_BPS = 7_000;
export const LINKED_WALLET_SELL_REJECT_BPS = 25;
export const LINKED_CLUSTER_BUY_VOLUME_REJECT_BPS = 3_500;
export const LINKED_CLUSTER_HOLDER_REJECT_BPS = 2_000;

export interface WalletLinkEvidence {
  mint: string;
  walletA: string;
  walletB: string;
  confidenceBps: number;
  evidence: Array<"COMMON_FUNDER" | "REPEATED_FUNDING" | "SHARED_AUTHORITY" | "REPEATED_TOKEN_TRANSFER">;
  observedAt: string;
}

export interface WalletHoldingEvidence {
  mint: string;
  wallet: string;
  amount: string;
}

export interface WalletClusterRisk {
  mint: string;
  status: "REJECT_OBSERVED" | "WATCH";
  attributionStatus: "CONFIRMED_LINKS" | "NO_HIGH_CONFIDENCE_LINKS" | "INVALID_EVIDENCE";
  linkedWalletCount: number;
  largestClusterConfidenceBps: number | null;
  linkedWalletSellShareBps: number | null;
  largestClusterBuyVolumeShareBps: number | null;
  largestClusterHoldingShareBps: number | null;
  reasons: string[];
  limitations: string[];
}

/**
 * Evaluate only externally established linkage evidence. This module does not
 * infer a relationship from similar trade timing, shared token purchases, or
 * common behaviour. Every graph edge must independently meet the 70% floor.
 */
export function evaluateWalletClusterRisk(
  transactions: readonly VerifiedPumpTransaction[],
  options: {
    mint: string;
    creator: string | null;
    totalSupply: string | null;
    links?: readonly WalletLinkEvidence[];
    holdings?: readonly WalletHoldingEvidence[];
  }
): WalletClusterRisk {
  const reasons: string[] = [];
  const limitations = [
    "No creator-linked wallet or cluster clearance is possible without independently verified funding, authority, or transfer evidence.",
    "Holder balances are only as complete as the supplied wallet-holding evidence; this module does not claim a full holder census."
  ];
  if (!options.totalSupply || !/^[1-9][0-9]*$/.test(options.totalSupply)) {
    return emptyRisk(options.mint, "INVALID_EVIDENCE", reasons, limitations);
  }
  const supply = BigInt(options.totalSupply);
  const allLinks = (options.links ?? []).filter(link => link.mint === options.mint);
  const validLinks = allLinks.filter(link =>
    link.walletA !== link.walletB &&
    Number.isInteger(link.confidenceBps) &&
    link.confidenceBps >= MIN_LINK_CONFIDENCE_BPS &&
    link.confidenceBps <= 10_000 &&
    link.evidence.length > 0 &&
    link.evidence.every(item => ["COMMON_FUNDER", "REPEATED_FUNDING", "SHARED_AUTHORITY", "REPEATED_TOKEN_TRANSFER"].includes(item))
  );
  if (validLinks.length !== allLinks.length) {
    reasons.push("One or more supplied linkage records failed validation or fell below 70% confidence and were excluded.");
  }
  if (validLinks.length === 0) {
    return emptyRisk(options.mint, allLinks.length ? "INVALID_EVIDENCE" : "NO_HIGH_CONFIDENCE_LINKS", reasons, limitations);
  }

  const parent = new Map<string, string>();
  const find = (wallet: string): string => {
    const current = parent.get(wallet);
    if (!current) { parent.set(wallet, wallet); return wallet; }
    if (current === wallet) return wallet;
    const root = find(current);
    parent.set(wallet, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const link of validLinks) union(link.walletA, link.walletB);

  const members = new Map<string, Set<string>>();
  for (const wallet of parent.keys()) {
    const root = find(wallet);
    const group = members.get(root) ?? new Set<string>();
    group.add(wallet);
    members.set(root, group);
  }
  const clusters = [...members.values()];
  const confidenceByCluster = clusters.map(group => {
    const relevant = validLinks.filter(link => group.has(link.walletA) && group.has(link.walletB));
    return relevant.length ? Math.min(...relevant.map(link => link.confidenceBps)) : 0;
  });
  const creatorClusterWallets = new Set<string>();
  if (options.creator) {
    for (const group of clusters) {
      if (group.has(options.creator)) for (const wallet of group) creatorClusterWallets.add(wallet);
    }
  }

  let linkedSells = 0n;
  let allSells = 0n;
  let linkedBuys = 0n;
  let allBuys = 0n;
  for (const tx of transactions) for (const trade of tx.tradeEvents) {
    if (trade.mint !== options.mint || trade.quoteAmount <= 0n) continue;
    if (trade.isBuy) {
      allBuys += trade.quoteAmount;
      if (clusters.some(group => group.has(trade.user))) linkedBuys += trade.quoteAmount;
    } else {
      allSells += trade.tokenAmount;
      if (creatorClusterWallets.has(trade.user)) linkedSells += trade.tokenAmount;
    }
  }
  const linkedSellShare = allSells > 0n ? linkedSells : 0n;
  const sellBps = allSells > 0n ? ceilBps(linkedSellShare, supply) : null;
  const clusterBuyBps = allBuys > 0n ? ceilBps(linkedBuys, allBuys) : null;

  const holdingByCluster = new Map<number, bigint>();
  for (const holding of options.holdings ?? []) {
    if (holding.mint !== options.mint || !/^[0-9]+$/.test(holding.amount)) continue;
    const groupIndex = clusters.findIndex(group => group.has(holding.wallet));
    if (groupIndex >= 0) holdingByCluster.set(groupIndex, (holdingByCluster.get(groupIndex) ?? 0n) + BigInt(holding.amount));
  }
  const largestClusterHolding = [...holdingByCluster.values()].reduce((max, value) => value > max ? value : max, 0n);
  const holdingBps = holdingByCluster.size ? ceilBps(largestClusterHolding, supply) : null;
  const linkedCreatorSellBreach = creatorClusterWallets.size > 1 && linkedSells * 10_000n > supply * BigInt(LINKED_WALLET_SELL_REJECT_BPS);
  const clusterBuyBreach = clusterBuyBps !== null && clusterBuyBps > LINKED_CLUSTER_BUY_VOLUME_REJECT_BPS;
  const clusterHoldingBreach = holdingBps !== null && holdingBps > LINKED_CLUSTER_HOLDER_REJECT_BPS;
  if (linkedCreatorSellBreach) reasons.push("Creator-linked wallets sold more than 0.25% of supply.");
  if (clusterBuyBreach) reasons.push("High-confidence linked clusters contributed more than 35% of observed buy quote volume.");
  if (clusterHoldingBreach) reasons.push("A high-confidence linked cluster holds more than 20% of supply.");

  return {
    mint: options.mint,
    status: linkedCreatorSellBreach || clusterBuyBreach || clusterHoldingBreach ? "REJECT_OBSERVED" : "WATCH",
    attributionStatus: "CONFIRMED_LINKS",
    linkedWalletCount: new Set(clusters.flatMap(group => [...group])).size,
    largestClusterConfidenceBps: confidenceByCluster.length ? Math.max(...confidenceByCluster) : null,
    linkedWalletSellShareBps: sellBps,
    largestClusterBuyVolumeShareBps: clusterBuyBps,
    largestClusterHoldingShareBps: holdingBps,
    reasons,
    limitations
  };
}

function emptyRisk(
  mint: string,
  attributionStatus: WalletClusterRisk["attributionStatus"],
  reasons: string[],
  limitations: string[]
): WalletClusterRisk {
  return {
    mint, status: "WATCH", attributionStatus, linkedWalletCount: 0,
    largestClusterConfidenceBps: null, linkedWalletSellShareBps: null,
    largestClusterBuyVolumeShareBps: null, largestClusterHoldingShareBps: null,
    reasons, limitations
  };
}

function ceilBps(amount: bigint, denominator: bigint): number {
  return Number((amount * 10_000n + denominator - 1n) / denominator);
}
