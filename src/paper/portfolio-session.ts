import type { PaperPortfolioState } from "./portfolio.js";

export type PaperTransitionEventKind = "PAPER_ENTRY" | "PAPER_EXIT" | "POSITION_MARK" | "BANKROLL_TOP_UP";
export interface PaperTransitionEvent {
  kind: PaperTransitionEventKind;
  mint?: string;
  data: unknown;
}
export interface PaperPortfolioSessionMeta {
  sessionId: string;
  startedAt: string;
  stoppedAt: string | null;
  strategyVersion: string;
  eventCount: number;
  initialBankrollUsd: number;
  topUpAmountUsd: number;
  topUpThresholdUsd: number;
  topUpCount: number;
  totalTopUpsUsd: number;
}
export interface PaperSessionTransaction {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
}
export interface PaperSessionStorage {
  transaction<T>(closure: (txn: PaperSessionTransaction) => Promise<T>): Promise<T>;
}
export interface PaperTransitionMarker {
  eventIds: string[];
  committedAt: string;
}
export interface PaperPortfolioTransitionInput<TResult> {
  sessionId: string;
  idempotencyKey: string;
  occurredAt: string;
  mint?: string;
  apply: (portfolio: PaperPortfolioState) => {
    state: PaperPortfolioState;
    result: TResult;
    events: PaperTransitionEvent[];
  };
}
export type PaperPortfolioTransitionResult<TResult> =
  | { status: "APPLIED"; state: PaperPortfolioState; result: TResult; eventIds: string[] }
  | { status: "DUPLICATE"; state: PaperPortfolioState; result: null; eventIds: string[] };

const PAGE_SIZE = 100;

function safeEventData(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Paper transition audit data is not JSON serializable.");
  return JSON.parse(encoded) as unknown;
}

/**
 * Commits portfolio state, idempotency marker and audit events in one durable
 * storage transaction. A stopped/replaced session cannot accept late fills.
 */
export async function commitPaperPortfolioTransition<TResult>(
  storage: PaperSessionStorage,
  input: PaperPortfolioTransitionInput<TResult>
): Promise<PaperPortfolioTransitionResult<TResult>> {
  if (!input.sessionId.trim() || !input.idempotencyKey.trim() ||
      !Number.isFinite(Date.parse(input.occurredAt))) {
    throw new Error("Paper transition session, idempotency key and timestamp are required.");
  }
  return storage.transaction(async txn => {
    const activeSessionId = await txn.get<string>("active_audit_session_id");
    if (activeSessionId !== input.sessionId) throw new Error("Paper transition does not belong to the active session.");
    const portfolioKey = `paper_portfolio:${input.sessionId}`;
    const markerKey = `paper_transition:${input.sessionId}:${input.idempotencyKey}`;
    const previousMarker = await txn.get<PaperTransitionMarker>(markerKey);
    const portfolio = await txn.get<PaperPortfolioState>(portfolioKey);
    if (!portfolio) throw new Error("Paper portfolio state is missing for the active session.");
    if (previousMarker) {
      return { status: "DUPLICATE", state: portfolio, result: null,
        eventIds: previousMarker.eventIds } as const;
    }
    const metaKey = `audit_session:${input.sessionId}`;
    const meta = await txn.get<PaperPortfolioSessionMeta>(metaKey);
    if (!meta || meta.sessionId !== input.sessionId || !Number.isSafeInteger(meta.eventCount) || meta.eventCount < 1) {
      throw new Error("Paper session metadata is missing or invalid.");
    }
    const applied = input.apply(portfolio);
    if (!Array.isArray(applied.events) || applied.events.length === 0) {
      throw new Error("A paper transition must produce at least one audit event.");
    }
    let eventCount = meta.eventCount;
    let pageNumber = Math.floor((eventCount - 1) / PAGE_SIZE);
    let pageKey = `audit_events:${input.sessionId}:${String(pageNumber).padStart(8, "0")}`;
    let page = await txn.get<Array<Record<string, unknown>>>(pageKey) ?? [];
    const eventIds: string[] = [];
    for (let index = 0; index < applied.events.length; index += 1) {
      const event = applied.events[index]!;
      const sequence = ++eventCount;
      pageNumber = Math.floor((sequence - 1) / PAGE_SIZE);
      pageKey = `audit_events:${input.sessionId}:${String(pageNumber).padStart(8, "0")}`;
      if ((sequence - 1) % PAGE_SIZE === 0) page = await txn.get<Array<Record<string, unknown>>>(pageKey) ?? [];
      const eventId = `paper-transition:${input.idempotencyKey}:${index}`;
      page.push({
        sessionId: input.sessionId, sequence, eventId, kind: event.kind,
        occurredAt: input.occurredAt, mint: event.mint ?? input.mint ?? null,
        strategyVersion: meta.strategyVersion, data: safeEventData(event.data)
      });
      await txn.put(pageKey, page);
      await txn.put(`audit_event_id:${input.sessionId}:${eventId}`, sequence);
      eventIds.push(eventId);
    }
    await txn.put(portfolioKey, applied.state);
    await txn.put(markerKey, { eventIds, committedAt: input.occurredAt } satisfies PaperTransitionMarker);
    await txn.put(metaKey, {
      ...meta,
      eventCount,
      topUpCount: applied.state.bankroll.topUpCount,
      totalTopUpsUsd: applied.state.bankroll.totalTopUpsUsd
    });
    return { status: "APPLIED", state: applied.state, result: applied.result, eventIds } as const;
  });
}
