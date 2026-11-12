import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { fileURLToPath } from "node:url";
import { applyDatabaseMigrations } from "../src/db/migrate.js";
import {
  acquireWorkerLease,
  heartbeatWorkerLease,
  persistPaperAuditEvents,
  releaseWorkerLease
} from "../src/persistence/postgres.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const inspector = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 1 }) : null;
const sessionId = `integration-${process.pid}-${Date.now()}`;
const mint = "IntegrationMint111111111111111111111111111111";

const position = {
  positionId: "integration-position",
  mint,
  status: "OPEN",
  openedAt: "2026-11-12T10:00:00.000Z",
  stakeUsd: 1,
  tokenAmountBaseUnits: "1000000",
  tokenDecimals: 6,
  entryPriceUsdPerToken: 1,
  buyCostsUsd: 0.001,
  latestLiquidationValueUsd: 0.98,
  realizedPnlUsd: null,
  exitReason: null
};

function quote(side: "BUY" | "SELL", quoteId: string) {
  return {
    quoteId,
    mint,
    side,
    provider: "integration-test",
    venue: "PUMP_CURVE",
    slot: 123,
    observedAt: "2026-11-12T10:00:00.100Z",
    expiresAt: "2026-11-12T10:00:02.100Z",
    requestedUsd: side === "BUY" ? 1 : 0.98,
    inputAmountBaseUnits: side === "BUY" ? "10000000" : "1000000",
    outputAmountBaseUnits: side === "BUY" ? "1000000" : "9800000",
    outputUsd: side === "BUY" ? 1 : 0.98,
    priceImpactPct: 0.2,
    simulatedLatencyMs: 75,
    simulatedFillAt: "2026-11-12T10:00:00.150Z",
    feeBreakdownUsd: { pump: 0.001, network: 0, priority: 0 }
  };
}

const entryEvent = {
  sessionId,
  sequence: 1,
  eventId: "integration-entry-1",
  kind: "PAPER_ENTRY",
  occurredAt: "2026-11-12T10:00:00.200Z",
  mint,
  strategyVersion: "integration-test-v1",
  data: {
    position,
    buyQuoteId: "integration-buy-q",
    initialSellQuoteId: "integration-initial-sell-q",
    buyQuote: quote("BUY", "integration-buy-q"),
    initialSellQuote: quote("SELL", "integration-initial-sell-q")
  }
};

describe.skipIf(!databaseUrl)("PostgreSQL paper ledger integration", () => {
  beforeAll(async () => {
    await applyDatabaseMigrations(
      databaseUrl,
      fileURLToPath(new URL("../db/migrations", import.meta.url))
    );
  });

  afterAll(async () => {
    await inspector?.end();
  });


  it("fences expired PostgreSQL worker leases from stale owners", async () => {
    const leaseName = `${sessionId}-worker`;
    const first = await acquireWorkerLease(leaseName, "worker-a", 15);
    expect(first.acquired).toBe(true);

    const competing = await acquireWorkerLease(leaseName, "worker-b", 15);
    expect(competing.acquired).toBe(false);
    expect((await heartbeatWorkerLease(leaseName, "worker-b", 15)).acquired).toBe(false);
    expect((await heartbeatWorkerLease(leaseName, "worker-a", 15)).acquired).toBe(true);
    expect(await releaseWorkerLease(leaseName, "worker-b")).toBe(false);

    await inspector!.query(
      "UPDATE worker_leases SET expires_at=now()-interval '1 second' WHERE lease_name=$1",
      [leaseName]
    );
    const takeover = await acquireWorkerLease(leaseName, "worker-c", 15);
    expect(takeover.acquired).toBe(true);
    expect(takeover.ownerId).toBe("worker-c");

    // The former owner must not renew or release the new owner's lease.
    expect((await heartbeatWorkerLease(leaseName, "worker-a", 15)).acquired).toBe(false);
    expect(await releaseWorkerLease(leaseName, "worker-a")).toBe(false);
    expect((await heartbeatWorkerLease(leaseName, "worker-c", 15)).acquired).toBe(true);
    expect(await releaseWorkerLease(leaseName, "worker-c")).toBe(true);
  });

  it("persists projections atomically and makes exact retries idempotent", async () => {
    const first = await persistPaperAuditEvents(sessionId, [entryEvent]);
    expect(first).toEqual({ inserted: 1, duplicates: 0, lastSequence: 1 });

    const retry = await persistPaperAuditEvents(sessionId, [entryEvent]);
    expect(retry).toEqual({ inserted: 0, duplicates: 1, lastSequence: 1 });

    const counts = await inspector!.query(
      `SELECT
        (SELECT COUNT(*)::int FROM paper_session_events WHERE session_id=$1) AS events,
        (SELECT COUNT(*)::int FROM paper_position_projection WHERE session_id=$1) AS positions,
        (SELECT COUNT(*)::int FROM paper_execution_quote_projection WHERE session_id=$1) AS quotes,
        (SELECT COUNT(*)::int FROM paper_trade_projection WHERE session_id=$1) AS trades`,
      [sessionId]
    );
    expect(counts.rows[0]).toEqual({ events: 1, positions: 1, quotes: 2, trades: 1 });

    await expect(persistPaperAuditEvents(sessionId, [{
      ...entryEvent,
      data: { ...entryEvent.data, position: { ...position, stakeUsd: 1.25 } }
    }])).rejects.toThrow(/replay conflicts/);

    const malformedExit = {
      ...entryEvent,
      sequence: 2,
      eventId: "integration-invalid-entry-2",
      kind: "PAPER_ENTRY",
      occurredAt: "2026-11-12T10:00:01.000Z",
      data: {
        ...entryEvent.data,
        position: { ...position, positionId: "integration-invalid-position" },
        buyQuote: { ...quote("BUY", "integration-invalid-buy-q"), outputAmountBaseUnits: "999999" },
        initialSellQuote: quote("SELL", "integration-invalid-sell-q"),
        buyQuoteId: "integration-invalid-buy-q",
        initialSellQuoteId: "integration-invalid-sell-q"
      }
    };
    await expect(persistPaperAuditEvents(sessionId, [malformedExit])).rejects.toThrow(/do not reconcile/);

    const afterRollback = await inspector!.query(
      `SELECT s.last_sequence,
        (SELECT COUNT(*)::int FROM paper_session_events e WHERE e.session_id=s.id) AS events,
        (SELECT COUNT(*)::int FROM paper_position_projection p WHERE p.session_id=s.id) AS positions
       FROM paper_sessions s WHERE s.id=$1`,
      [sessionId]
    );
    expect(afterRollback.rows[0]).toEqual({ last_sequence: "1", events: 1, positions: 1 });

    const next = await persistPaperAuditEvents(sessionId, [{
      ...entryEvent,
      sequence: 2,
      eventId: "integration-session-heartbeat-2",
      kind: "SESSION_HEARTBEAT",
      occurredAt: "2026-11-12T10:00:02.000Z",
      data: { heartbeat: true }
    }]);
    expect(next).toEqual({ inserted: 1, duplicates: 0, lastSequence: 2 });
  });
});
