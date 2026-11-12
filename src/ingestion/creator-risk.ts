import type { PumpCreateEvent, PumpTradeEvent } from "./pump-events.js";
import type { VerifiedPumpTransaction } from "./helius.js";

export const CREATOR_SELL_WINDOW_SECONDS = 60;
export const CREATOR_SELL_REJECT_BPS = 5;

export type CreatorSellStatus = "REJECT_OBSERVED" | "PASS_COMPLETE" | "PENDING" | "UNKNOWN";

export interface CreatorSellRisk {
  mint: string;
  creator: string | null;
  launchTimestamp: number | null;
  tokenTotalSupply: string | null;
  creatorSellTokenAmount: string;
  creatorSellShareBps: number | null;
  rejectThresholdBps: number;
  status: CreatorSellStatus;
  reason: string;
}

interface LaunchEvidence {
  event: PumpCreateEvent;
  timestamp: number;
}

function validTimestamp(value: bigint): number | null {
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

/**
 * Evaluate the agreed direct-creator sell rule for the first 60 seconds.
 * A verified threshold breach is enough to reject even with partial coverage.
 * A non-breach is PASS only when the entire first 60 seconds was observed
 * from before launch with no known data gap; otherwise it remains UNKNOWN.
 */
export function evaluateCreatorSellRisk(
  transactions: readonly VerifiedPumpTransaction[],
  options: {
    nowSeconds?: number;
    candidateMints?: readonly string[];
    incompleteMints?: readonly string[];
    coverageStartByMint?: Readonly<Record<string, number>>;
  } = {}
): CreatorSellRisk[] {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new Error("Invalid creator-risk evaluation time.");
  }

  const launches = new Map<string, LaunchEvidence>();
  for (const transaction of transactions) {
    for (const event of transaction.createEvents) {
      const timestamp = validTimestamp(event.timestamp);
      if (timestamp === null || event.tokenTotalSupply <= 0n) continue;
      const previous = launches.get(event.mint);
      if (!previous || timestamp < previous.timestamp) {
        launches.set(event.mint, { event, timestamp });
      }
    }
  }

  const creatorSellAmounts = new Map<string, bigint>();
  for (const transaction of transactions) {
    for (const trade of transaction.tradeEvents) {
      const launch = launches.get(trade.mint);
      if (!launch || trade.isBuy) continue;
      const timestamp = validTimestamp(trade.timestamp);
      if (timestamp === null || timestamp < launch.timestamp ||
          timestamp >= launch.timestamp + CREATOR_SELL_WINDOW_SECONDS) continue;
      if (trade.user === launch.event.creator && trade.tokenAmount > 0n) {
        creatorSellAmounts.set(
          trade.mint,
          (creatorSellAmounts.get(trade.mint) ?? 0n) + trade.tokenAmount
        );
      }
    }
  }

  const incomplete = new Set(options.incompleteMints ?? []);
  const mints = new Set([
    ...(options.candidateMints ?? []),
    ...launches.keys(),
    ...creatorSellAmounts.keys()
  ]);
  const output: CreatorSellRisk[] = [];

  for (const mint of mints) {
    const launch = launches.get(mint);
    const sold = creatorSellAmounts.get(mint) ?? 0n;
    if (!launch) {
      output.push({
        mint, creator: null, launchTimestamp: null, tokenTotalSupply: null,
        creatorSellTokenAmount: sold.toString(), creatorSellShareBps: null,
        rejectThresholdBps: CREATOR_SELL_REJECT_BPS, status: "UNKNOWN",
        reason: "Verified create event and total supply are unavailable."
      });
      continue;
    }

    const supply = launch.event.tokenTotalSupply;
    const shareBps = Number((sold * 10_000n + supply - 1n) / supply);
    const breached = sold * 10_000n > supply * BigInt(CREATOR_SELL_REJECT_BPS);
    let status: CreatorSellStatus;
    let reason: string;

    if (breached) {
      status = "REJECT_OBSERVED";
      reason = "Observed direct creator sales exceed 0.05% of token supply during the first 60 seconds.";
    } else if (nowSeconds < launch.timestamp + CREATOR_SELL_WINDOW_SECONDS) {
      status = "PENDING";
      reason = "The first 60-second creator-sale observation window has not finished.";
    } else if (incomplete.has(mint)) {
      status = "UNKNOWN";
      reason = "A known monitoring or transaction-data gap prevents a safe creator-sale clearance.";
    } else {
      const coverageStart = options.coverageStartByMint?.[mint];
      if (coverageStart === undefined || coverageStart > launch.timestamp) {
        status = "UNKNOWN";
        reason = "Monitoring did not begin before launch, so early creator sales may have been missed.";
      } else {
        status = "PASS_COMPLETE";
        reason = "The full first 60 seconds were covered and observed creator sales did not exceed 0.05% of supply.";
      }
    }

    output.push({
      mint,
      creator: launch.event.creator,
      launchTimestamp: launch.timestamp,
      tokenTotalSupply: supply.toString(),
      creatorSellTokenAmount: sold.toString(),
      creatorSellShareBps: shareBps,
      rejectThresholdBps: CREATOR_SELL_REJECT_BPS,
      status,
      reason
    });
  }

  return output.sort((a, b) => a.mint.localeCompare(b.mint));
}
