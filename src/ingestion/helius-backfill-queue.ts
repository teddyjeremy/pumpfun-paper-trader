import {
  enqueueHeliusSignatureWork,
  type HeliusMonitorState
} from "./helius-monitor.js";
import type { HistoricalBackfillState } from "./helius-backfill.js";

export interface HistoricalBackfillQueueProgress {
  state: HeliusMonitorState;
  cursor: number;
  queued: number;
  duplicates: number;
  overflow: boolean;
  invalid: boolean;
}

/**
 * Queue a completed backfill from a durable cursor. The caller must persist
 * the returned monitor state before persisting the returned cursor: if a
 * restart happens between those writes, replay is safe because queued
 * signatures are deduplicated by the monitor state.
 *
 * An overflow never advances the cursor, so the same signature can be retried
 * after the live queue drains.
 */
export function enqueueHistoricalBackfillSignatures(
  monitor: HeliusMonitorState,
  backfill: HistoricalBackfillState,
  cursor: number,
  now = new Date().toISOString()
): HistoricalBackfillQueueProgress {
  if (backfill.status !== "COMPLETE") {
    throw new Error("Only a complete historical signature window can be queued.");
  }
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > backfill.signatures.length) {
    throw new Error("Historical backfill queue cursor is invalid.");
  }
  if (!Number.isFinite(Date.parse(now))) {
    throw new Error("Historical backfill queue timestamp is invalid.");
  }

  let state = monitor;
  let nextCursor = cursor;
  let queued = 0;
  let duplicates = 0;
  let overflow = false;
  let invalid = false;

  while (nextCursor < backfill.signatures.length) {
    const signature = backfill.signatures[nextCursor]!;
    const result = enqueueHeliusSignatureWork(state, {
      signature: signature.signature,
      mint: backfill.mint,
      slot: signature.slot
    }, now);
    state = result.state;
    if (result.outcome === "QUEUED") queued += 1;
    else if (result.outcome === "DUPLICATE") duplicates += 1;
    else if (result.outcome === "OVERFLOW") {
      overflow = true;
      break;
    } else {
      invalid = true;
      break;
    }
    nextCursor += 1;
  }

  return { state, cursor: nextCursor, queued, duplicates, overflow, invalid };
}
