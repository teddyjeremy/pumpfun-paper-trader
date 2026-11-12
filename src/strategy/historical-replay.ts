import type { VerifiedPumpTransaction } from "../ingestion/helius.js";
import type { PumpTradeEvent } from "../ingestion/pump-events.js";
import { buildCandidatePriceVolumeProfiles } from "../ingestion/price-volume-profile.js";
import { buildCandidateTradeFlows } from "../ingestion/trade-flow.js";

export interface HistoricalReplayCoinInput {
  mint: string;
  transactions: readonly VerifiedPumpTransaction[];
  launchBlockTime: number;
  horizonSeconds?: number;
  decodeComplete: boolean;
  decodeReason?: string | null;
}

export interface HistoricalReplayConfig {
  solUsdPriceUsd: number;
  minimumTradeUsd?: number;
  horizonSeconds?: number;
  /** Required to assign labels; no success/failure label is fabricated without both values. */
  label?: {
    minFavorableExcursionPct: number;
    maxAdverseExcursionPct: number;
    roundTripCostPct?: number;
  };
}

export interface HistoricalSetupSnapshot {
  evaluatedAt: number;
  profileStatus: string;
  coverageStatus: string;
  dataComplete: boolean;
  reclaimDetected: boolean;
  pullbackVolumeVsImpulsePct: number | null;
  reclaimVolumeVsPullbackPct: number | null;
  reclaimAbovePreviousFiveSecondHighPct: number | null;
  flowConfirmationPass: boolean;
  flowDataComplete: boolean;
  distinctBuyersAcrossLatestThree: number;
  largestBuyerShareAcrossLatestThreeBps: number | null;
  setupEligible: boolean;
}

export interface HistoricalEntryOutcome {
  entryAt: number;
  entryPriceQuotePerToken: number;
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
  grossFinalReturnPct: number;
  netFinalReturnPct: number | null;
  roundTripCostPct: number | null;
  label: "SUCCESS" | "FAILURE" | "UNKNOWN";
  labelReason: string;
}

export interface HistoricalCoinReplay {
  mint: string;
  launchBlockTime: number;
  horizonSeconds: number;
  decodeComplete: boolean;
  decodeReason: string | null;
  verifiedTransactionCount: number;
  verifiedTradeCount: number;
  snapshots: HistoricalSetupSnapshot[];
  firstSetup: HistoricalSetupSnapshot | null;
  outcome: HistoricalEntryOutcome | null;
  status: "COMPLETE" | "INCOMPLETE" | "NO_SETUP" | "NO_FORWARD_ENTRY";
}

export interface VolumeThresholdCandidate {
  maxPullbackVolumeVsImpulsePct: number;
  minReclaimVolumeVsPullbackPct: number;
  training: { samples: number; precision: number | null; recall: number | null; f1: number | null; accepted: number };
  holdout: { samples: number; precision: number | null; recall: number | null; f1: number | null; accepted: number };
}

export interface VolumeThresholdCalibration {
  status: "INSUFFICIENT_SAMPLE" | "NO_GENERALIZATION" | "CALIBRATION_CANDIDATE";
  labeledCoins: number;
  trainingCoins: number;
  holdoutCoins: number;
  positiveCoins: number;
  negativeCoins: number;
  recommended: VolumeThresholdCandidate | null;
  candidates: VolumeThresholdCandidate[];
  note: string;
}

function validPercent(value: number, label: string, allowZero = true): void {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0) || value > 10_000) {
    throw new Error(`${label} must be a finite percentage in the supported range.`);
  }
}

function eventTimestamp(event: PumpTradeEvent): number {
  const timestamp = Number(event.timestamp);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : Number.NaN;
}

function eventPrice(event: PumpTradeEvent): number | null {
  const quote = event.virtualSolReserves > 0n ? event.virtualSolReserves : event.virtualQuoteReserves;
  if (quote <= 0n || event.virtualTokenReserves <= 0n) return null;
  const value = Number(quote) / Number(event.virtualTokenReserves);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function sortedTrades(input: HistoricalReplayCoinInput): PumpTradeEvent[] {
  return input.transactions.flatMap(transaction => transaction.tradeEvents)
    .filter(event => event.mint === input.mint && Number.isFinite(eventTimestamp(event)))
    .sort((a, b) => eventTimestamp(a) - eventTimestamp(b));
}

function metrics(input: {
  trades: readonly PumpTradeEvent[];
  entryAt: number;
  entryPrice: number;
  horizonEnd: number;
  label?: HistoricalReplayConfig["label"];
  decodeComplete: boolean;
}): HistoricalEntryOutcome | null {
  const future = input.trades.filter(event => {
    const at = eventTimestamp(event);
    return at >= input.entryAt && at <= input.horizonEnd;
  }).map(event => ({ at: eventTimestamp(event), price: eventPrice(event) }))
    .filter((item): item is { at: number; price: number } => item.price !== null);
  if (future.length < 2) return null;
  const prices = future.map(item => item.price);
  const maxPrice = Math.max(...prices);
  const minPrice = Math.min(...prices);
  const finalPrice = future[future.length - 1]!.price;
  const maxFavorableExcursionPct = ((maxPrice / input.entryPrice) - 1) * 100;
  const maxAdverseExcursionPct = ((1 - minPrice / input.entryPrice)) * 100;
  const grossFinalReturnPct = ((finalPrice / input.entryPrice) - 1) * 100;
  const roundTripCostPct = input.label?.roundTripCostPct ?? null;
  const netFinalReturnPct = roundTripCostPct === null ? null : grossFinalReturnPct - roundTripCostPct;
  let label: HistoricalEntryOutcome["label"] = "UNKNOWN";
  let labelReason = "A complete forward window and explicit outcome thresholds are required.";
  if (input.decodeComplete && input.label) {
    label = maxFavorableExcursionPct >= input.label.minFavorableExcursionPct &&
      maxAdverseExcursionPct <= input.label.maxAdverseExcursionPct ? "SUCCESS" : "FAILURE";
    labelReason = label === "SUCCESS"
      ? "Observed forward path met the configured favorable-excursion and adverse-excursion criteria."
      : "Observed forward path failed at least one configured excursion criterion.";
  } else if (!input.decodeComplete) {
    labelReason = "Transaction decoding coverage is incomplete; outcome is not labelled.";
  }
  return {
    entryAt: input.entryAt,
    entryPriceQuotePerToken: input.entryPrice,
    maxFavorableExcursionPct,
    maxAdverseExcursionPct,
    grossFinalReturnPct,
    netFinalReturnPct,
    roundTripCostPct,
    label,
    labelReason
  };
}

export function replayHistoricalCoin(
  input: HistoricalReplayCoinInput,
  config: HistoricalReplayConfig
): HistoricalCoinReplay {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input.mint) ||
      !Number.isSafeInteger(input.launchBlockTime) || input.launchBlockTime < 0) {
    throw new Error("Historical replay requires a valid mint and verified launch block time.");
  }
  if (!Number.isFinite(config.solUsdPriceUsd) || config.solUsdPriceUsd <= 0) {
    throw new Error("A fresh positive SOL/USD reference is required for USD micro-trade filtering.");
  }
  const horizonSeconds = input.horizonSeconds ?? config.horizonSeconds ?? 600;
  if (!Number.isSafeInteger(horizonSeconds) || horizonSeconds < 60 || horizonSeconds > 1800) {
    throw new Error("Historical replay horizon must be between 60 and 1800 seconds.");
  }
  const minimumTradeUsd = config.minimumTradeUsd ?? 0.01;
  if (!Number.isFinite(minimumTradeUsd) || minimumTradeUsd < 0) {
    throw new Error("Minimum trade notional is invalid.");
  }
  if (config.label) {
    validPercent(config.label.minFavorableExcursionPct, "Minimum favorable excursion", false);
    validPercent(config.label.maxAdverseExcursionPct, "Maximum adverse excursion");
    if (config.label.roundTripCostPct !== undefined) {
      validPercent(config.label.roundTripCostPct, "Round-trip execution cost");
    }
  }

  const trades = sortedTrades(input);
  const horizonEnd = input.launchBlockTime + horizonSeconds;
  const observedEnd = Math.min(horizonEnd, Math.floor(trades.reduce(
    (latest, event) => Math.max(latest, eventTimestamp(event)), input.launchBlockTime
  )));
  const firstBucketEnd = Math.ceil(input.launchBlockTime / 5) * 5 + 5;
  const snapshots: HistoricalSetupSnapshot[] = [];
  let firstSetup: HistoricalSetupSnapshot | null = null;
  let entryEvent: PumpTradeEvent | null = null;

  if (observedEnd >= firstBucketEnd) {
    for (let evaluatedAt = firstBucketEnd; evaluatedAt <= observedEnd; evaluatedAt += 5) {
      const incompleteMints = input.decodeComplete ? [] : [input.mint];
      const sharedOptions = {
        nowSeconds: evaluatedAt,
        horizonSeconds,
        incompleteMints,
        coverageStartByMint: { [input.mint]: input.launchBlockTime },
        candidateMints: [input.mint],
        solUsdPriceUsd: config.solUsdPriceUsd,
        minimumTradeUsd
      };
      const profile = buildCandidatePriceVolumeProfiles(input.transactions, sharedOptions)
        .find(item => item.mint === input.mint && item.quoteUnit === "SOL");
      const flow = buildCandidateTradeFlows(input.transactions, sharedOptions)
        .find(item => item.mint === input.mint && item.quoteUnit === "SOL");
      if (!profile || !flow) continue;
      const setupEligible = input.decodeComplete && profile.dataComplete &&
        profile.microTradeFilterStatus === "APPLIED" &&
        profile.reclaimDetected && profile.pullbackVolumeVsImpulsePct !== null &&
        profile.reclaimVolumeVsPullbackPct !== null &&
        flow.dataComplete && flow.microTradeFilterStatus === "APPLIED" &&
        flow.flowConfirmationPass;
      const snapshot: HistoricalSetupSnapshot = {
        evaluatedAt,
        profileStatus: profile.profileStatus,
        coverageStatus: profile.coverageStatus,
        dataComplete: profile.dataComplete,
        reclaimDetected: profile.reclaimDetected,
        pullbackVolumeVsImpulsePct: profile.pullbackVolumeVsImpulsePct,
        reclaimVolumeVsPullbackPct: profile.reclaimVolumeVsPullbackPct,
        reclaimAbovePreviousFiveSecondHighPct: profile.reclaimAbovePreviousFiveSecondHighPct,
        flowConfirmationPass: flow.flowConfirmationPass,
        flowDataComplete: flow.dataComplete,
        distinctBuyersAcrossLatestThree: flow.distinctBuyersAcrossLatestThree,
        largestBuyerShareAcrossLatestThreeBps: flow.largestBuyerShareAcrossLatestThreeBps,
        setupEligible
      };
      snapshots.push(snapshot);
      if (setupEligible && firstSetup === null && profile.reclaimTime !== null) {
        entryEvent = trades.find(event => {
          const at = eventTimestamp(event);
          return at >= profile.reclaimTime! && at <= profile.reclaimTime! + 2 &&
            eventPrice(event) !== null;
        }) ?? null;
        if (entryEvent) firstSetup = snapshot;
      }
      if (firstSetup) break;
    }
  }

  const entryAt = entryEvent ? eventTimestamp(entryEvent) : null;
  const entryPrice = entryEvent ? eventPrice(entryEvent) : null;
  const outcome = entryAt !== null && entryPrice !== null
    ? metrics({
        trades, entryAt, entryPrice, horizonEnd,
        label: config.label, decodeComplete: input.decodeComplete
      })
    : null;
  const status = !input.decodeComplete ? "INCOMPLETE"
    : !firstSetup ? "NO_SETUP"
      : !outcome ? "NO_FORWARD_ENTRY" : "COMPLETE";
  return {
    mint: input.mint,
    launchBlockTime: input.launchBlockTime,
    horizonSeconds,
    decodeComplete: input.decodeComplete,
    decodeReason: input.decodeReason ?? null,
    verifiedTransactionCount: input.transactions.length,
    verifiedTradeCount: trades.length,
    snapshots,
    firstSetup,
    outcome,
    status
  };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index), high = Math.ceil(index);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (index - low);
}

function scoreThreshold(
  coins: readonly HistoricalCoinReplay[],
  maxPullback: number,
  minReclaim: number
): VolumeThresholdCandidate["training"] {
  const accepted = coins.filter(coin => coin.firstSetup &&
    coin.firstSetup.pullbackVolumeVsImpulsePct !== null &&
    coin.firstSetup.reclaimVolumeVsPullbackPct !== null &&
    coin.firstSetup.pullbackVolumeVsImpulsePct <= maxPullback &&
    coin.firstSetup.reclaimVolumeVsPullbackPct >= minReclaim);
  const tp = accepted.filter(coin => coin.outcome?.label === "SUCCESS").length;
  const fp = accepted.filter(coin => coin.outcome?.label === "FAILURE").length;
  const fn = coins.filter(coin => coin.outcome?.label === "SUCCESS" && !accepted.includes(coin)).length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? 2 * precision * recall / (precision + recall) : null;
  return { samples: coins.length, precision, recall, f1, accepted: accepted.length };
}

export function calibrateVolumeThresholds(
  replays: readonly HistoricalCoinReplay[]
): VolumeThresholdCalibration {
  const labeled = replays.filter(coin => coin.outcome?.label !== "UNKNOWN" &&
    coin.firstSetup?.pullbackVolumeVsImpulsePct !== null &&
    coin.firstSetup?.reclaimVolumeVsPullbackPct !== null);
  const ordered = [...labeled].sort((a, b) => a.launchBlockTime - b.launchBlockTime);
  const split = Math.floor(ordered.length * 0.7);
  const training = ordered.slice(0, split);
  const holdout = ordered.slice(split);
  const positiveCoins = labeled.filter(coin => coin.outcome?.label === "SUCCESS").length;
  const negativeCoins = labeled.filter(coin => coin.outcome?.label === "FAILURE").length;
  if (training.length < 30 || holdout.length < 10 ||
      training.filter(coin => coin.outcome?.label === "SUCCESS").length < 5 ||
      training.filter(coin => coin.outcome?.label === "FAILURE").length < 5 ||
      holdout.filter(coin => coin.outcome?.label === "SUCCESS").length < 2 ||
      holdout.filter(coin => coin.outcome?.label === "FAILURE").length < 2) {
    return {
      status: "INSUFFICIENT_SAMPLE", labeledCoins: labeled.length,
      trainingCoins: training.length, holdoutCoins: holdout.length,
      positiveCoins, negativeCoins, recommended: null, candidates: [],
      note: "Need at least 30 labelled training coins and 10 chronological holdout coins, with both outcome classes represented. No volume threshold is recommended before that."
    };
  }
  const pullbackValues = training.map(coin => coin.firstSetup!.pullbackVolumeVsImpulsePct!);
  const reclaimValues = training.map(coin => coin.firstSetup!.reclaimVolumeVsPullbackPct!);
  const pullbackThresholds = [...new Set([0.1,0.25,0.5,0.75,0.9].map(p => percentile(pullbackValues,p)).filter(Number.isFinite))];
  const reclaimThresholds = [...new Set([0.1,0.25,0.5,0.75,0.9].map(p => percentile(reclaimValues,p)).filter(Number.isFinite))];
  const candidates: VolumeThresholdCandidate[] = [];
  for (const maxPullbackVolumeVsImpulsePct of pullbackThresholds) {
    for (const minReclaimVolumeVsPullbackPct of reclaimThresholds) {
      candidates.push({
        maxPullbackVolumeVsImpulsePct,
        minReclaimVolumeVsPullbackPct,
        training: scoreThreshold(training,maxPullbackVolumeVsImpulsePct,minReclaimVolumeVsPullbackPct),
        holdout: scoreThreshold(holdout,maxPullbackVolumeVsImpulsePct,minReclaimVolumeVsPullbackPct)
      });
    }
  }
  candidates.sort((a,b) =>
    (b.training.f1 ?? -1) - (a.training.f1 ?? -1) ||
    (b.training.precision ?? -1) - (a.training.precision ?? -1) ||
    b.training.accepted - a.training.accepted
  );
  const best = candidates[0] ?? null;
  const generalizes = Boolean(best && best.training.accepted >= 5 && best.holdout.accepted >= 2 &&
    (best.holdout.f1 ?? 0) >= 0.5 && (best.holdout.precision ?? 0) >= 0.5);
  return {
    status: generalizes ? "CALIBRATION_CANDIDATE" : "NO_GENERALIZATION",
    labeledCoins: labeled.length, trainingCoins: training.length, holdoutCoins: holdout.length,
    positiveCoins, negativeCoins, recommended: generalizes ? best : null, candidates,
    note: generalizes
      ? "Candidate thresholds are selected on earlier launches and must be reviewed against holdout performance; they remain paper-only."
      : "The best training thresholds did not meet minimum holdout performance. Do not promote them into the entry rules."
  };
}
