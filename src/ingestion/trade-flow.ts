import type { PumpTradeEvent } from "./pump-events.js";
import type { VerifiedPumpTransaction } from "./helius.js";

export const TRADE_FLOW_WINDOW_SECONDS = 2;
export const TRADE_FLOW_HORIZON_SECONDS = 10 * 60;
export const MAX_FLOW_WINDOWS_PER_MINT = TRADE_FLOW_HORIZON_SECONDS / TRADE_FLOW_WINDOW_SECONDS;
export const SOL_QUOTE_MINT = "11111111111111111111111111111111";

export interface TradeFlowWindow {
  startTime: number;
  endTime: number;
  tradeCount: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  buyQuoteVolume: string;
  sellQuoteVolume: string;
  largestBuyerShareBps: number | null;
  buySellRatio: number | null;
  hasBuyVolume: boolean;
  hasSellVolume: boolean;
  flowWindowPass: boolean;
}

export interface CandidateTradeFlow {
  mint: string;
  quoteMint: string;
  quoteUnit: "SOL" | "NON_SOL_RAW";
  windowSeconds: number;
  horizonSeconds: number;
  windows: TradeFlowWindow[];
  observedTradeEvents: number;
  latestThreeWindowFlowPass: boolean;
  distinctBuyersAcrossLatestThree: number;
  largestBuyerShareAcrossLatestThreeBps: number | null;
  flowConfirmationPass: boolean;
  dataComplete: boolean;
  coverage: "OBSERVED_EVENTS_ONLY";
  entryEligible: false;
}

/**
 * Build event-time flow windows from verified Pump.fun TradeEvents.
 *
 * Volumes remain raw quote-mint base units. SOL quote events use lamports;
 * non-SOL quote mints are kept separate and are never compared with SOL.
 * Empty windows are omitted: absence of a decoded event is not proof of
 * zero trading or complete provider delivery.
 */
export function buildCandidateTradeFlows(
  transactions: readonly VerifiedPumpTransaction[],
  options: {
    nowSeconds?: number;
    horizonSeconds?: number;
    incompleteMints?: readonly string[];
    coverageStartByMint?: Readonly<Record<string, number>>;
    candidateMints?: readonly string[];
  } = {}
): CandidateTradeFlow[] {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const horizonSeconds = options.horizonSeconds ?? TRADE_FLOW_HORIZON_SECONDS;
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0 ||
      !Number.isSafeInteger(horizonSeconds) || horizonSeconds < TRADE_FLOW_WINDOW_SECONDS) {
    throw new Error("Invalid trade-flow time range.");
  }

  const lowerBound = nowSeconds - horizonSeconds;
  const incomplete = new Set(options.incompleteMints ?? []);
  const groups = new Map<string, {
    mint: string;
    quoteMint: string;
    windows: Map<number, PumpTradeEvent[]>;
  }>();

  const ensureGroup = (mint: string, quoteMint: string) => {
    const key = `${mint}:${quoteMint}`;
    let group = groups.get(key);
    if (!group) {
      group = { mint, quoteMint, windows: new Map() };
      groups.set(key, group);
    }
    return group;
  };

  for (const transaction of transactions) {
    for (const created of transaction.createEvents) {
      ensureGroup(created.mint, created.quoteMint);
    }
    for (const trade of transaction.tradeEvents) {
      const timestamp = Number(trade.timestamp);
      if (!Number.isSafeInteger(timestamp) || timestamp < lowerBound || timestamp > nowSeconds) continue;
      const group = ensureGroup(trade.mint, trade.quoteMint);
      const windowStart = Math.floor(timestamp / TRADE_FLOW_WINDOW_SECONDS) * TRADE_FLOW_WINDOW_SECONDS;
      if (windowStart + TRADE_FLOW_WINDOW_SECONDS > nowSeconds) continue;
      const events = group.windows.get(windowStart) ?? [];
      events.push(trade);
      group.windows.set(windowStart, events);
    }
  }

  for (const mint of options.candidateMints ?? []) {
    if (![...groups.values()].some(group => group.mint === mint)) {
      ensureGroup(mint, SOL_QUOTE_MINT);
    }
  }

  const output: CandidateTradeFlow[] = [];
  for (const group of groups.values()) {
    const windows = [...group.windows.entries()]
      .sort(([a], [b]) => a - b)
      .slice(-MAX_FLOW_WINDOWS_PER_MINT)
      .map(([startTime, events]) => summarizeWindow(startTime, events));
    const latestThree = getLatestThreeConsecutive(windows);
    const distinctBuyers = latestThree
      ? new Set(latestThree.flatMap(window => window.buyers)).size
      : 0;
    const totalBuyVolume = latestThree
      ? latestThree.reduce((sum, window) => sum + window.buyVolume, 0n)
      : 0n;
    const buyerVolumes = new Map<string, bigint>();
    if (latestThree) {
      for (const window of latestThree) {
        for (const [buyer, amount] of window.buyerVolumes) {
          buyerVolumes.set(buyer, (buyerVolumes.get(buyer) ?? 0n) + amount);
        }
      }
    }
    const largestBuyerVolume = [...buyerVolumes.values()].reduce((max, amount) => amount > max ? amount : max, 0n);
    const largestBuyerShareBps = totalBuyVolume > 0n
      ? Number((largestBuyerVolume * 10_000n + totalBuyVolume - 1n) / totalBuyVolume)
      : null;
    const latestThreeWindowFlowPass = Boolean(latestThree?.every(window => window.flowWindowPass));
    const coverageStart = options.coverageStartByMint?.[group.mint];
    const firstFullyCoveredWindow = coverageStart === undefined
      ? null
      : Math.ceil(coverageStart / TRADE_FLOW_WINDOW_SECONDS) * TRADE_FLOW_WINDOW_SECONDS;
    const latestCompletedWindowEnd =
      Math.floor(nowSeconds / TRADE_FLOW_WINDOW_SECONDS) * TRADE_FLOW_WINDOW_SECONDS;
    const latestThreeAreFresh = Boolean(latestThree) &&
      latestThree![2]!.endTime === latestCompletedWindowEnd;
    const dataComplete = !incomplete.has(group.mint) &&
      latestThreeAreFresh &&
      (firstFullyCoveredWindow === null || latestThree![0]!.startTime >= firstFullyCoveredWindow);
    const flowConfirmationPass = dataComplete &&
      latestThreeWindowFlowPass &&
      distinctBuyers >= 5 &&
      totalBuyVolume > 0n &&
      largestBuyerVolume * 100n <= totalBuyVolume * 72n;

    output.push({
      mint: group.mint,
      quoteMint: group.quoteMint,
      quoteUnit: group.quoteMint === SOL_QUOTE_MINT ? "SOL" : "NON_SOL_RAW",
      windowSeconds: TRADE_FLOW_WINDOW_SECONDS,
      horizonSeconds,
      windows: windows.map(({ buyers: _buyers, buyerVolumes: _buyerVolumes, buyVolume: _buyVolume, sellVolume: _sellVolume, ...window }) => window),
      observedTradeEvents: windows.reduce((sum, window) => sum + window.tradeCount, 0),
      latestThreeWindowFlowPass,
      distinctBuyersAcrossLatestThree: distinctBuyers,
      largestBuyerShareAcrossLatestThreeBps: largestBuyerShareBps,
      flowConfirmationPass,
      dataComplete,
      coverage: "OBSERVED_EVENTS_ONLY",
      entryEligible: false
    });
  }
  return output.sort((a, b) => a.mint.localeCompare(b.mint) || a.quoteMint.localeCompare(b.quoteMint));
}

function summarizeWindow(startTime: number, events: readonly PumpTradeEvent[]) {
  let buyVolume = 0n;
  let sellVolume = 0n;
  const buyerVolumes = new Map<string, bigint>();
  const buyers = new Set<string>();
  const sellers = new Set<string>();

  for (const event of events) {
    const amount = event.quoteMint === SOL_QUOTE_MINT
      ? (event.quoteAmount > 0n ? event.quoteAmount : event.solAmount)
      : event.quoteAmount;
    if (amount <= 0n) continue;
    if (event.isBuy) {
      buyVolume += amount;
      buyers.add(event.user);
      buyerVolumes.set(event.user, (buyerVolumes.get(event.user) ?? 0n) + amount);
    } else {
      sellVolume += amount;
      sellers.add(event.user);
    }
  }

  const largestBuyerVolume = [...buyerVolumes.values()].reduce((max, amount) => amount > max ? amount : max, 0n);
  const largestBuyerShareBps = buyVolume > 0n
    ? Number((largestBuyerVolume * 10_000n + buyVolume - 1n) / buyVolume)
    : null;
  const flowWindowPass = buyVolume > sellVolume * 3n &&
    buyers.size >= 3 &&
    sellers.size * 2 <= buyers.size;

  return {
    startTime,
    endTime: startTime + TRADE_FLOW_WINDOW_SECONDS,
    tradeCount: events.length,
    uniqueBuyers: buyers.size,
    uniqueSellers: sellers.size,
    buyQuoteVolume: buyVolume.toString(),
    sellQuoteVolume: sellVolume.toString(),
    largestBuyerShareBps,
    buySellRatio: sellVolume > 0n ? Number(buyVolume) / Number(sellVolume) : null,
    hasBuyVolume: buyVolume > 0n,
    hasSellVolume: sellVolume > 0n,
    flowWindowPass,
    buyers: [...buyers],
    buyerVolumes,
    buyVolume,
    sellVolume
  };
}

function getLatestThreeConsecutive<T extends { startTime: number }>(windows: readonly T[]): T[] | null {
  if (windows.length < 3) return null;
  const latest = windows.slice(-3);
  return latest[1]!.startTime === latest[0]!.startTime + TRADE_FLOW_WINDOW_SECONDS &&
    latest[2]!.startTime === latest[1]!.startTime + TRADE_FLOW_WINDOW_SECONDS
    ? latest
    : null;
}
