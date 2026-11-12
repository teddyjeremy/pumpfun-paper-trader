/**
 * Deterministic paper-session audit primitives.
 * Storage adapter integration is a separate acceptance gate.
 */
export type AuditEventKind =
  | "SESSION_STARTED" | "SESSION_STOPPED" | "DISCOVERY" | "OBSERVATION"
  | "FEATURE_SNAPSHOT" | "STRATEGY_DECISION" | "REJECTION_REASON"
  | "RISK_EVIDENCE" | "QUOTE_REQUESTED" | "QUOTE_RESULT" | "PAPER_ENTRY"
  | "PAPER_EXIT" | "POSITION_MARK" | "BANKROLL_TOP_UP" | "DATA_GAP"
  | "PROVIDER_STATUS" | "ERROR" | "CANDIDATE_OUTCOME";
export interface PaperAuditEvent<T = Record<string, unknown>> {
  sessionId: string; sequence: number; eventId: string; kind: AuditEventKind;
  occurredAt: string; mint: string | null; strategyVersion: string; data: T;
}
export interface BankrollState {
  initialBankrollUsd: number; totalTopUpsUsd: number; topUpCount: number;
  currentEquityUsd: number; totalCapitalContributedUsd: number;
  lastTopUpAt: string | null; nextEventSequence: number;
}
export const DEFAULT_PAPER_SESSION_CONFIG = {
  initialBankrollUsd: 2.70, topUpAmountUsd: 2.70,
  topUpThresholdUsd: 1.00, strategyVersion: "strict-v1"
} as const;
export function createBankrollState(initialBankrollUsd = 2.70): BankrollState {
  if (!Number.isFinite(initialBankrollUsd) || initialBankrollUsd <= 0) throw new Error("Initial paper bankroll must be positive.");
  return { initialBankrollUsd, totalTopUpsUsd: 0, topUpCount: 0,
    currentEquityUsd: initialBankrollUsd, totalCapitalContributedUsd: initialBankrollUsd,
    lastTopUpAt: null, nextEventSequence: 1 };
}
export function markPaperEquity(state: BankrollState, equityUsd: number): BankrollState {
  if (!Number.isFinite(equityUsd) || equityUsd < 0) throw new Error("Paper equity must be finite and non-negative.");
  return { ...state, currentEquityUsd: roundUsd(equityUsd) };
}
/** Top up only when marked equity is strictly below the threshold. */
export function replenishPaperBankroll(state: BankrollState, occurredAt: string,
  amountUsd = 2.70, thresholdUsd = 1.00) {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || !Number.isFinite(thresholdUsd) || thresholdUsd < 0) throw new Error("Invalid top-up policy.");
  if (!Number.isFinite(Date.parse(occurredAt))) throw new Error("Invalid top-up timestamp.");
  if (state.currentEquityUsd >= thresholdUsd) return { state, event: null };
  const before = state.currentEquityUsd;
  const next: BankrollState = { ...state, totalTopUpsUsd: roundUsd(state.totalTopUpsUsd + amountUsd),
    topUpCount: state.topUpCount + 1, currentEquityUsd: roundUsd(before + amountUsd),
    totalCapitalContributedUsd: roundUsd(state.totalCapitalContributedUsd + amountUsd),
    lastTopUpAt: occurredAt, nextEventSequence: state.nextEventSequence + 1 };
  return { state: next, event: {
    sequence: state.nextEventSequence, eventId: `bankroll-top-up-${next.topUpCount}`,
    kind: "BANKROLL_TOP_UP" as const, occurredAt, mint: null,
    data: { replenishmentNumber: next.topUpCount, trigger: "EQUITY_BELOW_THRESHOLD",
      thresholdUsd, balanceBeforeUsd: roundUsd(before), amountAddedUsd: amountUsd,
      balanceAfterUsd: next.currentEquityUsd, cumulativeTopUpsUsd: next.totalTopUpsUsd,
      cumulativeCapitalContributedUsd: next.totalCapitalContributedUsd }
  } };
}
export interface CandidateOutcome {
  mint: string; decision: "REJECT" | "WATCH" | "BUY" | "NO_DECISION"; decisionAt: string;
  decisionPriceUsd: number | null; discoveryPriceUsd: number | null;
  highestPriceUsd: number | null; highestPriceAt: string | null;
  maxMultipleFromDecision: number | null; maxMultipleFromDiscovery: number | null;
  reached15x: boolean; reached2x: boolean; reached3x: boolean;
  followUpStatus: "COMPLETE" | "PARTIAL" | "MISSING"; rejectionReasons: string[];
}
export function calculateCandidateOutcome(input: {
  mint: string; decision: CandidateOutcome["decision"]; decisionAt: string;
  decisionPriceUsd: number | null; discoveryPriceUsd: number | null;
  observedPricesUsd: readonly { priceUsd: number; observedAt: string }[];
  rejectionReasons?: string[]; followUpStatus: CandidateOutcome["followUpStatus"];
}): CandidateOutcome {
  const valid = input.observedPricesUsd.filter(p => Number.isFinite(p.priceUsd) && p.priceUsd > 0 && Number.isFinite(Date.parse(p.observedAt)));
  const peak = valid.reduce<{priceUsd:number;observedAt:string}|null>((best,item) => !best || item.priceUsd > best.priceUsd ? item : best, null);
  const fromDecision = peak && input.decisionPriceUsd && input.decisionPriceUsd > 0 ? peak.priceUsd / input.decisionPriceUsd : null;
  const fromDiscovery = peak && input.discoveryPriceUsd && input.discoveryPriceUsd > 0 ? peak.priceUsd / input.discoveryPriceUsd : null;
  return { mint: input.mint, decision: input.decision, decisionAt: input.decisionAt,
    decisionPriceUsd: input.decisionPriceUsd, discoveryPriceUsd: input.discoveryPriceUsd,
    highestPriceUsd: peak?.priceUsd ?? null, highestPriceAt: peak?.observedAt ?? null,
    maxMultipleFromDecision: fromDecision === null ? null : roundMultiple(fromDecision),
    maxMultipleFromDiscovery: fromDiscovery === null ? null : roundMultiple(fromDiscovery),
    reached15x: fromDecision !== null && fromDecision >= 1.5,
    reached2x: fromDecision !== null && fromDecision >= 2,
    reached3x: fromDecision !== null && fromDecision >= 3,
    followUpStatus: input.followUpStatus, rejectionReasons: [...new Set(input.rejectionReasons ?? [])] };
}
function roundUsd(value: number): number { return Math.round((value + Number.EPSILON) * 1e8) / 1e8; }
function roundMultiple(value: number): number { return Math.round((value + Number.EPSILON) * 1e6) / 1e6; }
