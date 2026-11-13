import type { VerifiedPumpTransaction } from "../ingestion/helius.js";
import type { PumpTradeEvent } from "../ingestion/pump-events.js";
import { buildCandidatePriceVolumeProfiles } from "../ingestion/price-volume-profile.js";
import { buildCandidateTradeFlows, isSolQuoteMint } from "../ingestion/trade-flow.js";
import { evaluateCreatorSellRisk } from "../ingestion/creator-risk.js";
import { evaluateWalletClusterRisk, type WalletHoldingEvidence, type WalletLinkEvidence } from "../ingestion/wallet-cluster-risk.js";

export interface HistoricalReplayCoinInput {
  mint: string;
  transactions: readonly VerifiedPumpTransaction[];
  launchBlockTime: number;
  horizonSeconds?: number;
  decodeComplete: boolean;
  decodeReason?: string | null;
  /** Historical second at which complete relevant-wallet history/linkage coverage was independently verified. Recent-20 signature samples do not qualify. */
  walletClusterEvidenceCompleteAt?: number;
  /** Coverage class for wallet-link evidence; RECENT_SIGNATURE_SAMPLE_ONLY is reject-only, never a clearance. */
  walletClusterEvidenceCoverage?: "FULL_WALLET_HISTORY" | "FULL_SOL_TRANSFER_HISTORY" | "RECENT_SIGNATURE_SAMPLE_ONLY";
  /** Historical second at which a genuinely complete holder census was independently verified. Top-20 snapshots do not qualify. */
  holderCensusCompleteAt?: number;
  /** Timestamped completeness transitions; latest evidence at or before evaluation wins. */
  walletClusterEvidenceTimeline?: readonly { observedAt: number; complete: boolean }[];
  holderCensusEvidenceTimeline?: readonly { observedAt: number; complete: boolean }[];
  /** Historical second when every non-risk entry gate (signal freshness, liquidity/MC, executable quote/cost and capacity) was verified. */
  entryEvidenceCompleteAt?: number;
  /** Historical second when the dynamic exit lifecycle completed with a fresh full-size sell quote and zero-balance confirmation. */
  exitLifecycleCompleteAt?: number;
  /** Simulated exit timestamp, in Unix seconds, supplied only by a full dynamic-exit replay. */
  simulatedExitAt?: number;
  /** Gross SOL/WSOL quote amount per token at the simulated exit; net return is supplied separately after all fees. */
  simulatedExitPriceQuotePerToken?: number;
  /** Exact simulated net return after SDK entry/exit quotes and all costs; not a reserve-price estimate. */
  simulatedNetFinalReturnPct?: number;
  walletLinks?: readonly WalletLinkEvidence[];
  walletHoldings?: readonly WalletHoldingEvidence[];
}

export interface HistoricalReplayConfig {
  solUsdPriceUsd: number;
  minimumTradeUsd?: number;
  horizonSeconds?: number;
  /** Thresholds for exploratory labels; labels still require complete risk, entry and exit evidence. */
  label?: {
    minFavorableExcursionPct: number;
    maxAdverseExcursionPct: number;
    roundTripCostPct: number;
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
  creatorSellRiskStatus: "REJECT_OBSERVED" | "PASS_COMPLETE" | "PENDING" | "UNKNOWN";
  walletClusterRiskStatus: "REJECT_OBSERVED" | "PASS_COMPLETE" | "UNKNOWN";
  walletClusterAttributionStatus: "CONFIRMED_LINKS" | "NO_HIGH_CONFIDENCE_LINKS" | "INVALID_EVIDENCE" | "UNKNOWN";
  /** Risk-cleared market candidate only; remaining strategy and executable-quote rules are not implied. */
  riskClearedSetupEligible: boolean;
  /** Market-pattern candidate only; does not imply creator/cluster or execution clearance. */
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
  status: "COMPLETE" | "INCOMPLETE" | "NO_SETUP" | "NO_FORWARD_ENTRY" | "RISK_NOT_CLEARED" | "ENTRY_EVIDENCE_INCOMPLETE" | "EXIT_EVIDENCE_INCOMPLETE";
}

export interface CalibrationPartitionMetrics {
  samples: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  accepted: number;
  winRate: number | null;
  expectancyNetPct: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number | null;
}

export interface VolumeThresholdCandidate {
  maxPullbackVolumeVsImpulsePct: number;
  minReclaimVolumeVsPullbackPct: number;
  training: CalibrationPartitionMetrics;
  holdout: CalibrationPartitionMetrics;
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
  const quote = isSolQuoteMint(event.quoteMint) ? event.virtualSolReserves : event.virtualQuoteReserves;
  if (quote <= 0n || event.virtualTokenReserves <= 0n) return null;
  const scaled = (quote * 1_000_000_000_000n) / event.virtualTokenReserves;
  const value = Number(scaled) / 1_000_000_000_000;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function sortedTrades(input: HistoricalReplayCoinInput): PumpTradeEvent[] {
  return input.transactions.flatMap(transaction => transaction.tradeEvents)
    // The historical price path is denominated in SOL. Non-SOL quote events
    // must not be mixed into entry or forward-return prices.
    .filter(event => event.mint === input.mint && isSolQuoteMint(event.quoteMint) &&
      Number.isFinite(eventTimestamp(event)))
    .sort((a, b) => eventTimestamp(a) - eventTimestamp(b));
}

export function hasCompleteHistoricalExitEvidence(input: {
  entryAt: number;
  replayEndAt: number;
  exitLifecycleCompleteAt?: number;
  simulatedExitAt?: number;
  simulatedExitPriceQuotePerToken?: number;
  simulatedNetFinalReturnPct?: number;
}): boolean {
  return Number.isSafeInteger(input.exitLifecycleCompleteAt) && input.exitLifecycleCompleteAt! >= 0 &&
    Number.isSafeInteger(input.simulatedExitAt) && input.simulatedExitAt! >= 0 &&
    input.exitLifecycleCompleteAt! >= input.simulatedExitAt! &&
    input.exitLifecycleCompleteAt! <= input.replayEndAt &&
    input.simulatedExitAt! >= input.entryAt &&
    input.simulatedExitAt! <= input.replayEndAt &&
    Number.isFinite(input.simulatedExitPriceQuotePerToken) &&
    input.simulatedExitPriceQuotePerToken! > 0 &&
    Number.isFinite(input.simulatedNetFinalReturnPct);
}

export function hasCompleteHistoricalEntryEvidence(input: {
  entryAt: number;
  entryEvidenceCompleteAt?: number;
}): boolean {
  return Number.isSafeInteger(input.entryEvidenceCompleteAt) &&
    input.entryEvidenceCompleteAt! >= 0 &&
    input.entryEvidenceCompleteAt! <= input.entryAt;
}

export function classifyHistoricalWalletClusterRisk(input: {
  walletRisk: ReturnType<typeof evaluateWalletClusterRisk> | null;
  walletClusterEvidenceCompleteAt?: number;
  walletClusterEvidenceCoverage?: "FULL_WALLET_HISTORY" | "FULL_SOL_TRANSFER_HISTORY" | "RECENT_SIGNATURE_SAMPLE_ONLY";
  holderCensusCompleteAt?: number;
  walletClusterEvidenceTimeline?: readonly { observedAt: number; complete: boolean }[];
  holderCensusEvidenceTimeline?: readonly { observedAt: number; complete: boolean }[];
  evaluatedAt: number;
}): "PASS_COMPLETE" | "REJECT_OBSERVED" | "UNKNOWN" {
  if (input.walletRisk?.status === "REJECT_OBSERVED") return "REJECT_OBSERVED";
  const latestAt = (timeline: readonly { observedAt: number; complete: boolean }[] | undefined) =>
    [...(timeline ?? [])]
      .filter(item => Number.isSafeInteger(item.observedAt) && item.observedAt >= 0 &&
        item.observedAt <= input.evaluatedAt)
      .sort((a, b) => a.observedAt - b.observedAt)
      .at(-1);
  const latestWalletEvidence = latestAt(input.walletClusterEvidenceTimeline);
  const latestHolderEvidence = latestAt(input.holderCensusEvidenceTimeline);
  const walletCoverageComplete = latestWalletEvidence
    ? latestWalletEvidence.complete
    : input.walletClusterEvidenceCoverage === "FULL_WALLET_HISTORY" &&
      Number.isSafeInteger(input.walletClusterEvidenceCompleteAt) &&
      input.walletClusterEvidenceCompleteAt! >= 0 &&
      input.walletClusterEvidenceCompleteAt! <= input.evaluatedAt;
  const holderCoverageComplete = latestHolderEvidence
    ? latestHolderEvidence.complete
    : Number.isSafeInteger(input.holderCensusCompleteAt) &&
      input.holderCensusCompleteAt! >= 0 &&
      input.holderCensusCompleteAt! <= input.evaluatedAt;
  if (walletCoverageComplete && holderCoverageComplete && input.walletRisk !== null &&
      input.walletRisk.attributionStatus !== "INVALID_EVIDENCE") return "PASS_COMPLETE";
  return "UNKNOWN";
}

function metrics(input: {
  trades: readonly PumpTradeEvent[];
  entryAt: number;
  entryPrice: number;
  horizonEnd: number;
  label?: HistoricalReplayConfig["label"];
  decodeComplete: boolean;
  riskCleared: boolean;
  entryEvidenceComplete: boolean;
  exitEvidenceComplete: boolean;
  simulatedExitAt?: number;
  simulatedExitPriceQuotePerToken?: number;
  simulatedNetFinalReturnPct?: number;
}): HistoricalEntryOutcome | null {
  const future = input.trades.filter(event => {
    const at = eventTimestamp(event);
    return at >= input.entryAt && at <= Math.min(input.horizonEnd,
      input.exitEvidenceComplete && input.simulatedExitAt !== undefined ? input.simulatedExitAt : input.horizonEnd);
  }).map(event => ({ at: eventTimestamp(event), price: eventPrice(event) }))
    .filter((item): item is { at: number; price: number } => item.price !== null);
  if (future.length < 2) return null;
  const prices = future.map(item => item.price);
  const maxPrice = Math.max(...prices);
  const minPrice = Math.min(...prices);
  const finalPrice = input.exitEvidenceComplete && input.simulatedExitPriceQuotePerToken !== undefined
    ? input.simulatedExitPriceQuotePerToken
    : future[future.length - 1]!.price;
  const maxFavorableExcursionPct = ((maxPrice / input.entryPrice) - 1) * 100;
  const maxAdverseExcursionPct = ((1 - minPrice / input.entryPrice)) * 100;
  const grossFinalReturnPct = ((finalPrice / input.entryPrice) - 1) * 100;
  const roundTripCostPct = input.label?.roundTripCostPct ?? null;
  const netFinalReturnPct = input.exitEvidenceComplete && input.simulatedNetFinalReturnPct !== undefined
    ? input.simulatedNetFinalReturnPct
    : roundTripCostPct === null ? null : grossFinalReturnPct - roundTripCostPct;
  let label: HistoricalEntryOutcome["label"] = "UNKNOWN";
  let labelReason = "A complete forward window, explicit excursion thresholds and an assumed round-trip cost are required.";
  if (!input.riskCleared) {
    labelReason = "Creator and complete holder/cluster evidence were not cleared at the candidate time; reserve-price performance is exploratory and is not labelled as a strategy outcome.";
  } else if (!input.entryEvidenceComplete) {
    labelReason = "Signal freshness, liquidity/market-cap, executable quote/cost and portfolio-capacity gates were not all verified by the candidate time; reserve-price performance is not labelled as a strategy outcome.";
  } else if (!input.exitEvidenceComplete) {
    labelReason = "The dynamic exit lifecycle, fresh full-size sell quote and zero-balance confirmation were not replayed; reserve-price performance is not labelled as a strategy outcome.";
  } else if (input.decodeComplete && input.label && netFinalReturnPct !== null) {
    const metExcursions = maxFavorableExcursionPct >= input.label.minFavorableExcursionPct &&
      maxAdverseExcursionPct <= input.label.maxAdverseExcursionPct;
    label = metExcursions && netFinalReturnPct > 0 ? "SUCCESS" : "FAILURE";
    labelReason = label === "SUCCESS"
      ? "Risk-cleared candidate path met both excursion criteria and remained net-positive after the simulated SDK entry/exit costs."
      : !metExcursions
        ? "Risk-cleared candidate path failed at least one configured excursion criterion."
        : "Risk-cleared candidate final return was not positive after the simulated SDK entry/exit costs.";
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
      // Risk evaluators must see only evidence available at this historical instant.
      const evidenceTransactions = input.transactions.filter(tx => tx.blockTime !== null && tx.blockTime !== undefined && Number.isSafeInteger(tx.blockTime) && tx.blockTime <= evaluatedAt);
      const creatorRisk = evaluateCreatorSellRisk(evidenceTransactions, {
        nowSeconds: evaluatedAt,
        candidateMints: [input.mint],
        incompleteMints: input.decodeComplete ? [] : [input.mint],
        coverageStartByMint: { [input.mint]: input.launchBlockTime }
      }).find(item => item.mint === input.mint);
      const createEvent = evidenceTransactions.flatMap(tx => tx.createEvents)
        .filter(event => event.mint === input.mint)
        .sort((a, b) => Number(a.timestamp - b.timestamp))[0];
      const walletRisk = createEvent ? evaluateWalletClusterRisk(evidenceTransactions, {
        mint: input.mint,
        creator: createEvent.creator,
        totalSupply: createEvent.tokenTotalSupply.toString(),
        links: (input.walletLinks ?? []).filter(link => {
          const observedAt = Date.parse(link.observedAt);
          return Number.isFinite(observedAt) && observedAt <= evaluatedAt * 1_000;
        }),
        holdings: (input.walletHoldings ?? []).filter(holding => {
          const observedAt = Date.parse(holding.observedAt ?? "");
          return Number.isFinite(observedAt) && observedAt <= evaluatedAt * 1_000;
        })
      }) : null;
      const creatorRiskStatus = creatorRisk?.status ?? "UNKNOWN";
      const walletClusterRiskStatus = classifyHistoricalWalletClusterRisk({
        walletRisk,
        ...(input.walletClusterEvidenceCompleteAt === undefined ? {} : {
          walletClusterEvidenceCompleteAt: input.walletClusterEvidenceCompleteAt
        }),
        ...(input.walletClusterEvidenceCoverage === undefined ? {} : {
          walletClusterEvidenceCoverage: input.walletClusterEvidenceCoverage
        }),
        ...(input.holderCensusCompleteAt === undefined ? {} : {
          holderCensusCompleteAt: input.holderCensusCompleteAt
        }),
        ...(input.walletClusterEvidenceTimeline === undefined ? {} : {
          walletClusterEvidenceTimeline: input.walletClusterEvidenceTimeline
        }),
        ...(input.holderCensusEvidenceTimeline === undefined ? {} : {
          holderCensusEvidenceTimeline: input.holderCensusEvidenceTimeline
        }),
        evaluatedAt
      });
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
        creatorSellRiskStatus: creatorRiskStatus,
        walletClusterRiskStatus,
        walletClusterAttributionStatus: walletRisk?.attributionStatus ?? "UNKNOWN",
        riskClearedSetupEligible: setupEligible && creatorRiskStatus === "PASS_COMPLETE" && walletClusterRiskStatus === "PASS_COMPLETE",
        setupEligible
      };
      snapshots.push(snapshot);
      if (setupEligible && firstSetup === null && profile.reclaimTime !== null) {
        firstSetup = snapshot;
        entryEvent = trades.find(event => {
          const at = eventTimestamp(event);
          return at >= profile.reclaimTime! && at <= profile.reclaimTime! + 2 &&
            eventPrice(event) !== null;
        }) ?? null;
        break;
      }
    }
  }

  const entryAt = entryEvent ? eventTimestamp(entryEvent) : null;
  const entryPrice = entryEvent ? eventPrice(entryEvent) : null;
  const outcome = firstSetup !== null && entryAt !== null && entryPrice !== null
    ? metrics({
        trades, entryAt, entryPrice, horizonEnd,
        label: config.label, decodeComplete: input.decodeComplete,
        riskCleared: firstSetup.riskClearedSetupEligible,
        entryEvidenceComplete: hasCompleteHistoricalEntryEvidence({
          entryAt,
          ...(input.entryEvidenceCompleteAt === undefined ? {} : {
            entryEvidenceCompleteAt: input.entryEvidenceCompleteAt
          })
        }),
        exitEvidenceComplete: hasCompleteHistoricalExitEvidence({
          entryAt,
          replayEndAt: Math.min(observedEnd, entryAt + horizonSeconds),
          ...(input.exitLifecycleCompleteAt === undefined ? {} : {
            exitLifecycleCompleteAt: input.exitLifecycleCompleteAt
          }),
          ...(input.simulatedExitAt === undefined ? {} : {
            simulatedExitAt: input.simulatedExitAt
          }),
          ...(input.simulatedExitPriceQuotePerToken === undefined ? {} : {
            simulatedExitPriceQuotePerToken: input.simulatedExitPriceQuotePerToken
          }),
          ...(input.simulatedNetFinalReturnPct === undefined ? {} : {
            simulatedNetFinalReturnPct: input.simulatedNetFinalReturnPct
          })
        }),
        ...(input.simulatedExitAt === undefined ? {} : { simulatedExitAt: input.simulatedExitAt }),
        ...(input.simulatedExitPriceQuotePerToken === undefined ? {} : {
          simulatedExitPriceQuotePerToken: input.simulatedExitPriceQuotePerToken
        }),
        ...(input.simulatedNetFinalReturnPct === undefined ? {} : {
          simulatedNetFinalReturnPct: input.simulatedNetFinalReturnPct
        })
      })
    : null;
  const status = !input.decodeComplete ? "INCOMPLETE"
    : !firstSetup ? "NO_SETUP"
      : !firstSetup.riskClearedSetupEligible ? "RISK_NOT_CLEARED"
        : entryAt === null ? "NO_FORWARD_ENTRY"
        : !hasCompleteHistoricalEntryEvidence({
          entryAt,
          ...(input.entryEvidenceCompleteAt === undefined ? {} : {
            entryEvidenceCompleteAt: input.entryEvidenceCompleteAt
          })
        }) ? "ENTRY_EVIDENCE_INCOMPLETE"
          : !hasCompleteHistoricalExitEvidence({
            entryAt,
            replayEndAt: Math.min(observedEnd, entryAt + horizonSeconds),
            ...(input.exitLifecycleCompleteAt === undefined ? {} : {
              exitLifecycleCompleteAt: input.exitLifecycleCompleteAt
            }),
            ...(input.simulatedExitAt === undefined ? {} : {
              simulatedExitAt: input.simulatedExitAt
            }),
            ...(input.simulatedExitPriceQuotePerToken === undefined ? {} : {
              simulatedExitPriceQuotePerToken: input.simulatedExitPriceQuotePerToken
            }),
            ...(input.simulatedNetFinalReturnPct === undefined ? {} : {
              simulatedNetFinalReturnPct: input.simulatedNetFinalReturnPct
            })
          }) ? "EXIT_EVIDENCE_INCOMPLETE"
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
): CalibrationPartitionMetrics {
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
  const returns = accepted
    .map(coin => coin.outcome?.netFinalReturnPct)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const grossWins = returns.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLosses = Math.abs(returns.filter(value => value < 0).reduce((sum, value) => sum + value, 0));
  const orderedReturns = accepted
    .filter(coin => typeof coin.outcome?.netFinalReturnPct === "number")
    .sort((a, b) => a.launchBlockTime - b.launchBlockTime)
    .map(coin => coin.outcome!.netFinalReturnPct!);
  let equity = 1;
  let peak = 1;
  let maxDrawdownPct = 0;
  for (const value of orderedReturns) {
    equity *= Math.max(0, 1 + value / 100);
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (1 - equity / peak) * 100);
  }
  return {
    samples: coins.length, precision, recall, f1, accepted: accepted.length,
    winRate: returns.length > 0 ? returns.filter(value => value > 0).length / returns.length : null,
    expectancyNetPct: returns.length > 0 ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? null : 0,
    maxDrawdownPct: returns.length > 0 ? maxDrawdownPct : null
  };
}

/**
 * Split calibration data by launch timestamp, never by array index alone.
 * Coins launched in the same second stay in the same partition so a batch
 * cannot leak across the training/holdout boundary.
 */
export function splitChronologicalCalibrationCoins<T extends { launchBlockTime: number }>(
  coins: readonly T[],
  trainingFraction = 0.7
): { training: T[]; holdout: T[] } {
  if (!Number.isFinite(trainingFraction) || trainingFraction <= 0 || trainingFraction >= 1) {
    throw new Error("Training fraction must be greater than 0 and less than 1.");
  }
  const ordered = coins.map((coin, index) => ({ coin, index }))
    .sort((a, b) => a.coin.launchBlockTime - b.coin.launchBlockTime || a.index - b.index);
  if (ordered.length < 2) {
    return { training: ordered.map(item => item.coin), holdout: [] };
  }

  const groups: Array<{ timestamp: number; coins: T[] }> = [];
  for (const { coin } of ordered) {
    const last = groups[groups.length - 1];
    if (last && last.timestamp === coin.launchBlockTime) last.coins.push(coin);
    else groups.push({ timestamp: coin.launchBlockTime, coins: [coin] });
  }
  if (groups.length < 2) {
    return { training: [], holdout: ordered.map(item => item.coin) };
  }

  const targetTrainingCount = ordered.length * trainingFraction;
  let bestBoundary = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let cumulative = 0;
  for (let boundary = 1; boundary < groups.length; boundary += 1) {
    cumulative += groups[boundary - 1]!.coins.length;
    const distance = Math.abs(cumulative - targetTrainingCount);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestBoundary = boundary;
    }
  }
  return {
    training: groups.slice(0, bestBoundary).flatMap(group => group.coins),
    holdout: groups.slice(bestBoundary).flatMap(group => group.coins)
  };
}

export function calibrateVolumeThresholds(
  replays: readonly HistoricalCoinReplay[]
): VolumeThresholdCalibration {
  const labeled = replays.filter(coin => coin.outcome !== null && coin.outcome.label !== "UNKNOWN" &&
    coin.firstSetup !== null &&
    coin.firstSetup.pullbackVolumeVsImpulsePct !== null &&
    coin.firstSetup.reclaimVolumeVsPullbackPct !== null);
  const { training, holdout } = splitChronologicalCalibrationCoins(labeled, 0.7);
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
    (best.holdout.f1 ?? 0) >= 0.5 && (best.holdout.precision ?? 0) >= 0.5 &&
    (best.holdout.expectancyNetPct ?? Number.NEGATIVE_INFINITY) > 0 &&
    (best.holdout.profitFactor === null ? best.holdout.winRate === 1 : best.holdout.profitFactor > 1));
  return {
    status: generalizes ? "CALIBRATION_CANDIDATE" : "NO_GENERALIZATION",
    labeledCoins: labeled.length, trainingCoins: training.length, holdoutCoins: holdout.length,
    positiveCoins, negativeCoins, recommended: generalizes ? best : null, candidates,
    note: generalizes
      ? "Candidate thresholds are selected on earlier launches and pass chronological holdout precision/F1, positive net expectancy, and profit-factor checks. Review sample size and drawdown before any paper-only promotion."
      : "The best training thresholds did not meet minimum holdout performance. Do not promote them into the entry rules."
  };
}


const CREATE_EVENT_BIGINT_FIELDS = [
  "timestamp","virtualTokenReserves","virtualSolReserves","realTokenReserves",
  "tokenTotalSupply","virtualQuoteReserves","creatorFeeBps"
] as const;
const TRADE_EVENT_BIGINT_FIELDS = [
  "solAmount","tokenAmount","timestamp","virtualSolReserves","virtualTokenReserves",
  "realSolReserves","realTokenReserves","feeBasisPoints","fee","creatorFeeBasisPoints",
  "creatorFee","totalUnclaimedTokens","totalClaimedTokens","currentSolVolume",
  "lastUpdateTimestamp","cashbackFeeBasisPoints","cashback","buybackFeeBasisPoints",
  "buybackFee","quoteAmount","virtualQuoteReserves","realQuoteReserves",
  "holderRewardsBps","holderRewards","creatorFeeUnclaimed"
] as const;

function hydrateEventBigInts(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Archived Pump event is not an object.");
  }
  const event = { ...(value as Record<string, unknown>) };
  for (const field of fields) {
    const raw = event[field];
    if (typeof raw === "bigint") continue;
    if (typeof raw === "string" && /^\d+$/.test(raw)) {
      event[field] = BigInt(raw);
    } else if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
      event[field] = BigInt(raw);
    } else {
      throw new Error(`Archived Pump event field ${field} is not a valid base-unit integer.`);
    }
  }
  return event;
}

/** Restore JSON-safe PostgreSQL observations into the bigint event types used by the replay builders. */
export function hydrateArchivedVerifiedTransaction(value: unknown): VerifiedPumpTransaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Archived Helius transaction is malformed.");
  }
  const raw = value as Record<string, unknown>;
  const address = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const signature = raw.signature;
  const slot = raw.slot;
  if (typeof raw.mint !== "string" || !address.test(raw.mint) ||
      typeof signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(signature) ||
      typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0 ||
      raw.provider !== "helius" || raw.source !== "HISTORICAL_BACKFILL" ||
      !["confirmed","finalized"].includes(String(raw.commitment)) ||
      typeof raw.receivedAt !== "string" || !Number.isFinite(Date.parse(raw.receivedAt)) ||
      !Array.isArray(raw.createEvents) || !Array.isArray(raw.tradeEvents)) {
    throw new Error("Archived Helius transaction failed identity or provenance validation.");
  }
  const createEvents = raw.createEvents.map(event => hydrateEventBigInts(event, CREATE_EVENT_BIGINT_FIELDS));
  const tradeEvents = raw.tradeEvents.map(event => hydrateEventBigInts(event, TRADE_EVENT_BIGINT_FIELDS));
  for (const event of [...createEvents, ...tradeEvents]) {
    if (event.mint !== raw.mint) throw new Error("Archived Pump event mint does not match its transaction.");
  }
  const blockTime = raw.blockTime === null || raw.blockTime === undefined ? null : Number(raw.blockTime);
  if (blockTime !== null && (!Number.isSafeInteger(blockTime) || blockTime < 0)) {
    throw new Error("Archived Helius block time is invalid.");
  }
  return {
    ...raw,
    mint: raw.mint,
    signature,
    slot,
    blockTime,
    provider: "helius",
    commitment: raw.commitment,
    receivedAt: raw.receivedAt,
    createEvents,
    tradeEvents
  } as unknown as VerifiedPumpTransaction;
}
