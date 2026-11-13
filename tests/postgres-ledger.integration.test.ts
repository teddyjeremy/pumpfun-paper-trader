import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { fileURLToPath } from "node:url";
import { applyDatabaseMigrations } from "../src/db/migrate.js";
type LedgerPersistence = typeof import("../src/persistence/postgres.js");
let ledgerPersistence: LedgerPersistence | null = null;

const { Pool } = pg;
const databaseUrl = process.env.PAPER_TEST_DATABASE_URL;
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
    // Require an explicitly named test database so a developer's ordinary
    // DATABASE_URL can never trigger migrations or writes from this suite.
    process.env.DATABASE_URL = databaseUrl!;
    ledgerPersistence = await import("../src/persistence/postgres.js");
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
    const first = await ledgerPersistence!.acquireWorkerLease(leaseName, "worker-a", 15);
    expect(first.acquired).toBe(true);

    const competing = await ledgerPersistence!.acquireWorkerLease(leaseName, "worker-b", 15);
    expect(competing.acquired).toBe(false);
    expect((await ledgerPersistence!.heartbeatWorkerLease(leaseName, "worker-b", 15)).acquired).toBe(false);
    expect((await ledgerPersistence!.heartbeatWorkerLease(leaseName, "worker-a", 15)).acquired).toBe(true);
    expect(await ledgerPersistence!.releaseWorkerLease(leaseName, "worker-b")).toBe(false);

    await inspector!.query(
      "UPDATE worker_leases SET expires_at=now()-interval '1 second' WHERE lease_name=$1",
      [leaseName]
    );
    const takeover = await ledgerPersistence!.acquireWorkerLease(leaseName, "worker-c", 15);
    expect(takeover.acquired).toBe(true);
    expect(takeover.ownerId).toBe("worker-c");

    // The former owner must not renew or release the new owner's lease.
    expect((await ledgerPersistence!.heartbeatWorkerLease(leaseName, "worker-a", 15)).acquired).toBe(false);
    expect(await ledgerPersistence!.releaseWorkerLease(leaseName, "worker-a")).toBe(false);
    expect((await ledgerPersistence!.heartbeatWorkerLease(leaseName, "worker-c", 15)).acquired).toBe(true);
    expect(await ledgerPersistence!.releaseWorkerLease(leaseName, "worker-c")).toBe(true);
  });

  it("persists projections atomically and makes exact retries idempotent", async () => {
    const first = await ledgerPersistence!.persistPaperAuditEvents(sessionId, [entryEvent]);
    expect(first).toEqual({ inserted: 1, duplicates: 0, lastSequence: 1 });

    const retry = await ledgerPersistence!.persistPaperAuditEvents(sessionId, [entryEvent]);
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

    const dashboardLedger = await ledgerPersistence!.getPaperSessionLedgerSnapshot(sessionId);
    expect(dashboardLedger.available).toBe(true);
    expect(dashboardLedger.positions).toHaveLength(1);
    expect(dashboardLedger.positions[0]).toMatchObject({
      session_id: sessionId, mint, status: "OPEN", token_amount_base_units: "1000000"
    });
    expect(dashboardLedger.quotes).toHaveLength(2);
    expect(dashboardLedger.trades).toHaveLength(1);
    expect(dashboardLedger.trades[0]).toMatchObject({
      session_id: sessionId, mint, side: "buy", quote_id: "integration-buy-q"
    });

    await expect(ledgerPersistence!.persistPaperAuditEvents(sessionId, [{
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
    await expect(ledgerPersistence!.persistPaperAuditEvents(sessionId, [malformedExit])).rejects.toThrow(/do not reconcile/);

    const afterRollback = await inspector!.query(
      `SELECT s.last_sequence,
        (SELECT COUNT(*)::int FROM paper_session_events e WHERE e.session_id=s.id) AS events,
        (SELECT COUNT(*)::int FROM paper_position_projection p WHERE p.session_id=s.id) AS positions
       FROM paper_sessions s WHERE s.id=$1`,
      [sessionId]
    );
    expect(afterRollback.rows[0]).toEqual({ last_sequence: "1", events: 1, positions: 1 });

    const closedAt = "2026-11-12T10:01:00.000Z";
    const closedPosition = {
      ...position, status: "CLOSED", closedAt,
      latestLiquidationValueUsd: 0, realizedPnlUsd: -0.021, exitReason: "TEST_EXIT"
    };
    const exitQuote = {
      ...quote("SELL", "integration-exit-sell-q"),
      observedAt: "2026-11-12T10:00:59.000Z",
      expiresAt: "2026-11-12T10:01:01.000Z",
      simulatedFillAt: "2026-11-12T10:01:00.050Z"
    };
    const exitEvent = {
      ...entryEvent, sequence: 2, eventId: "integration-exit-2",
      kind: "PAPER_EXIT", occurredAt: closedAt,
      data: { position: closedPosition, sellQuoteId: exitQuote.quoteId,
        exitReason: "TEST_EXIT", sellQuote: exitQuote }
    };
    const exit = await ledgerPersistence!.persistPaperAuditEvents(sessionId, [exitEvent]);
    expect(exit).toEqual({ inserted: 1, duplicates: 0, lastSequence: 2 });
    expect(await ledgerPersistence!.persistPaperAuditEvents(sessionId, [exitEvent]))
      .toEqual({ inserted: 0, duplicates: 1, lastSequence: 2 });

    // A fresh dashboard read must reconstruct the closed trade and both fills
    // from the durable PostgreSQL projections, independent of Worker memory.
    const recoveredLedger = await ledgerPersistence!.getPaperSessionLedgerSnapshot(sessionId);
    expect(recoveredLedger.available).toBe(true);
    expect(recoveredLedger.positions).toHaveLength(1);
    expect(recoveredLedger.positions[0]).toMatchObject({
      session_id: sessionId, mint, status: "CLOSED", exit_reason: "TEST_EXIT"
    });
    expect(recoveredLedger.quotes).toHaveLength(3);
    expect(recoveredLedger.trades).toHaveLength(2);
    expect(recoveredLedger.trades.map((trade: { side: string }) => trade.side).sort())
      .toEqual(["buy", "sell"]);

    const next = await ledgerPersistence!.persistPaperAuditEvents(sessionId, [{
      ...entryEvent,
      sequence: 3,
      eventId: "integration-session-heartbeat-3",
      kind: "SESSION_HEARTBEAT",
      occurredAt: "2026-11-12T10:01:02.000Z",
      data: { heartbeat: true }
    }]);
    expect(next).toEqual({ inserted: 1, duplicates: 0, lastSequence: 3 });
  });
  it("persists resumable Helius checkpoints and verified decoded transactions idempotently", async () => {
    await ledgerPersistence!.persistPaperAuditEvents(sessionId, [entryEvent]);
    const backfillMint = "So11111111111111111111111111111111111111112";
    const createSignature = "5".repeat(64);
    const state = {
      bondingCurve: "11111111111111111111111111111111",
      createSignature,
      launchBlockTime: 1762941600,
      horizonSeconds: 600,
      maxSignatures: 120,
      signatures: [{ signature: createSignature, slot: 123, blockTime: 1762941600, err: null }],
      pagesScanned: 1,
      scannedCount: 1,
      before: null,
      lastPageSlot: 123,
      lastPageBlockTime: 1762941600,
      status: "COMPLETE" as const,
      reason: null
    };
    const transaction = {
      mint: backfillMint,
      signature: createSignature,
      slot: 123,
      provider: "helius" as const,
      commitment: "confirmed" as const,
      source: "HISTORICAL_BACKFILL" as const,
      receivedAt: "2026-11-12T10:00:03.000Z",
      createEvents: [{ mint: backfillMint, bondingCurve: state.bondingCurve }],
      tradeEvents: []
    };
    const pendingDecode = { complete: false, reason: "Historical signatures are still being checked.", verifiedTransactionCount: 0 };
    await ledgerPersistence!.persistHeliusBackfillArchive({ sessionId, mint: backfillMint, state, transaction, decodeCoverage: pendingDecode });
    await ledgerPersistence!.persistHeliusBackfillArchive({ sessionId, mint: backfillMint, state, transaction, decodeCoverage: pendingDecode });
    await ledgerPersistence!.persistHeliusBackfillArchive({
      sessionId, mint: backfillMint, state, transaction,
      decodeCoverage: { complete: true, reason: null, verifiedTransactionCount: 1 }
    });

    const archived = await inspector!.query(
      `SELECT j.status,j.pages_scanned,j.signature_count,j.launch_block_time,j.decoded_complete,
        j.verified_transaction_count,
        (SELECT COUNT(*)::int FROM helius_transaction_observations t
          WHERE t.session_id=j.session_id AND t.mint=j.mint) AS transactions
       FROM helius_backfill_jobs j WHERE j.session_id=$1 AND j.mint=$2`,
      [sessionId, backfillMint]
    );
    expect(archived.rows[0]).toEqual({
      status: "COMPLETE", pages_scanned: 1, signature_count: 1,
      launch_block_time: "1762941600", decoded_complete: true,
      verified_transaction_count: 1, transactions: 1
    });
    await ledgerPersistence!.persistPaperAuditEvents(sessionId, [{
      ...entryEvent,
      sequence: 4,
      eventId: "integration-wallet-risk-4",
      kind: "RISK_EVIDENCE",
      mint: backfillMint,
      occurredAt: "2026-11-12T10:00:04.000Z",
      data: {
        evidenceType: "WALLET_CLUSTER",
        fundingEvidence: {
          status: "OBSERVED", dataComplete: true, walletSetComplete: true,
          observedAt: "2026-11-12T10:00:03.900Z",
          requestedWallets: ["11111111111111111111111111111111"],
          walletsCovered: ["11111111111111111111111111111111"], links: []
        }
      }
    }]);
    const replayDataset = await ledgerPersistence!.getHeliusBackfillReplayDataset(sessionId);
    expect(replayDataset).toHaveLength(1);
    expect(replayDataset[0]).toMatchObject({
      mint: backfillMint, launchBlockTime: 1762941600, decodedComplete: true,
      signatureCount: 1, verifiedTransactionCount: 1
    });
    expect(replayDataset[0]?.transactions).toHaveLength(1);
    expect(replayDataset[0]?.riskEvidence).toHaveLength(1);
    expect(replayDataset[0]?.riskEvidence[0]).toMatchObject({
      occurredAt: "2026-11-12T10:00:04.000Z",
      payload: { evidenceType: "WALLET_CLUSTER" }
    });

    const expandedWindow = {
      ...state,
      pagesScanned: 2,
      scannedCount: 2,
      lastPageSlot: 122,
      lastPageBlockTime: 1762941599,
      signatures: [
        ...state.signatures,
        { signature: "7".repeat(64), slot: 122, blockTime: 1762941599, err: null }
      ]
    };
    await ledgerPersistence!.persistHeliusBackfillArchive({
      sessionId, mint: backfillMint, state: expandedWindow,
      decodeCoverage: { complete: false, reason: "Expanded signature window requires decoding.", verifiedTransactionCount: 0 }
    });
    const revoked = await inspector!.query(
      "SELECT decoded_complete,decoded_reason,window_end_block_time,last_page_slot,last_page_block_time,scan_provider,scan_commitment FROM helius_backfill_jobs WHERE session_id=$1 AND mint=$2",
      [sessionId, backfillMint]
    );
    expect(revoked.rows[0]).toEqual({
      decoded_complete: false,
      decoded_reason: "Expanded signature window requires decoding.",
      window_end_block_time: "1762942200",
      last_page_slot: "122",
      last_page_block_time: "1762941599",
      scan_provider: "helius",
      scan_commitment: "confirmed"
    });

    await expect(ledgerPersistence!.persistHeliusBackfillArchive({
      sessionId, mint: backfillMint, state,
      transaction: { ...transaction, slot: 124 }, decodeCoverage: pendingDecode
    })).rejects.toThrow(/verified signature evidence|conflicts/);

    const incompleteMint = "11111111111111111111111111111111";
    const incomplete = {
      ...state,
      createSignature: "6".repeat(64),
      launchBlockTime: null,
      signatures: [],
      pagesScanned: 0,
      scannedCount: 0,
      status: "INCOMPLETE" as const,
      reason: "Verified launch block time is unavailable."
    };
    await ledgerPersistence!.persistHeliusBackfillArchive({
      sessionId, mint: incompleteMint, state: incomplete,
      decodeCoverage: { complete: false, reason: "Verified launch block time is unavailable.", verifiedTransactionCount: 0 }
    });
    const incompleteRow = await inspector!.query(
      "SELECT status,launch_block_time,reason FROM helius_backfill_jobs WHERE session_id=$1 AND mint=$2",
      [sessionId, incompleteMint]
    );
    expect(incompleteRow.rows[0]).toEqual({
      status: "INCOMPLETE", launch_block_time: null,
      reason: "Verified launch block time is unavailable."
    });
  });

});
