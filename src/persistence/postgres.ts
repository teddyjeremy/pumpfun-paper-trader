import pg from "pg";
import { buildPaperLedgerProjection } from "./paper-ledger-projection.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;

const pool = connectionString
  ? new Pool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true
    })
  : null;

pool?.on("error", () => {
  // Do not log connection strings, server details, or credentials.
});

export interface PersistenceStatus {
  configured: boolean;
  connected: boolean;
  schemaReady: boolean;
  migrationVersion: string | null;
  checkedAt: string;
  error: string | null;
}

export async function getPersistenceStatus(): Promise<PersistenceStatus> {
  const checkedAt = new Date().toISOString();
  if (!pool) {
    return {
      configured: false,
      connected: false,
      schemaReady: false,
      migrationVersion: null,
      checkedAt,
      error: "DATABASE_URL is not configured"
    };
  }

  try {
    await pool.query("SELECT 1");
  } catch {
    return {
      configured: true,
      connected: false,
      schemaReady: false,
      migrationVersion: null,
      checkedAt,
      error: "PostgreSQL connection failed; inspect provider status without exposing credentials"
    };
  }

  try {
    const result = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1"
    );
    return {
      configured: true,
      connected: true,
      schemaReady: result.rows.length > 0,
      migrationVersion: result.rows[0]?.version ?? null,
      checkedAt,
      error: null
    };
  } catch {
    return {
      configured: true,
      connected: true,
      schemaReady: false,
      migrationVersion: null,
      checkedAt,
      error: "Database is reachable but the paper-trading schema is not applied"
    };
  }
}


function sumSolDecimals(values: string[]): string {
  const scale = 1_000_000_000n;
  const total = values.reduce((sum, value) => {
    const negative = value.startsWith("-");
    const normalized = negative ? value.slice(1) : value;
    const [whole = "0", fraction = ""] = normalized.split(".");
    const fractionalLamports = BigInt((fraction + "000000000").slice(0, 9));
    const amount = BigInt(whole || "0") * scale + fractionalLamports;
    return sum + (negative ? -amount : amount);
  }, 0n);
  const sign = total < 0n ? "-" : "";
  const absolute = total < 0n ? -total : total;
  const whole = absolute / scale;
  const fraction = String(absolute % scale).padStart(9, "0");
  return sign + whole.toString() + "." + fraction;
}

export interface DashboardPosition {
  id: string;
  mint: string;
  name: string | null;
  symbol: string | null;
  status: string;
  marketPhase: string;
  venue: string | null;
  openedAt: string | null;
  principalSol: string;
  tokenQuantity: string;
  latestSellQuoteAt: string | null;
  sellQuoteFresh: boolean;
  sellQuoteStatus: string | null;
  estimatedExitSol: string | null;
  estimatedUnrealizedPnlSol: string | null;
  unrealizedValuationStatus: "fresh_executable_quote" | "quote_unavailable_or_stale";
  exitBlockedReason: string | null;
  activeStopNetReturnPct: string | null;
}

export async function getTradingDashboardSnapshot() {
  const unavailable = (reason: string) => ({
    available: false,
    reason,
    generatedAt: new Date().toISOString(),
    portfolio: null,
    positions: [],
    closedPositions: [],
    trades: []
  });
  if (!pool) return unavailable("DATABASE_URL is not configured");

  const persistence = await getPersistenceStatus();
  if (!persistence.connected) return unavailable("PostgreSQL is not connected");
  try {
    const requiredMigrations = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = ANY($1::text[])",
      [["0001_initial_ledger", "0002_migration_aware_positions",
        "0003_dynamic_exit_observations", "0004_paper_session_event_ingestion"]]
    );
    if (requiredMigrations.rows.length !== 4) {
      return unavailable("Required ledger migrations 0001, 0002, 0003 and 0004 are not all applied");
    }
  } catch {
    return unavailable("Ledger migration status could not be verified");
  }

  try {
  const [portfolioResult, positionsResult, tradesResult, closedResult] = await Promise.all([
    pool.query(`
      SELECT
        COALESCE(SUM(net_pnl_lamports) FILTER (WHERE status = 'closed'), 0)::text AS realized_pnl_lamports,
        (COALESCE(SUM(net_pnl_lamports) FILTER (WHERE status = 'closed'), 0) / 1000000000::numeric)::text AS realized_pnl_sol,
        CASE WHEN COUNT(*) FILTER (WHERE status = 'closed' AND net_pnl_usd IS NULL) = 0
          THEN SUM(net_pnl_usd) FILTER (WHERE status = 'closed')::text ELSE NULL END AS realized_pnl_usd,
        COUNT(*) FILTER (WHERE status IN ('buy_pending','open','sell_pending','exit_unexecutable','migration_pending','open_migrated','exit_blocked'))::int AS open_positions,
        COUNT(*) FILTER (WHERE status = 'closed')::int AS closed_positions,
        COUNT(*) FILTER (WHERE status = 'closed' AND zero_balance_confirmed)::int AS confirmed_closed_positions
      FROM positions
    `),
    pool.query(`
      SELECT
        p.id::text, p.mint, t.name, t.symbol, p.status, p.market_phase,
        p.market_venue, p.opened_at,
        (p.principal_lamports / 1000000000::numeric)::text AS principal_sol,
        p.token_quantity_base_units::text AS token_quantity,
        p.exit_blocked_reason, p.active_stop_net_return_pct::text,
        q.quoted_at AS latest_sell_quote_at,
        q.quote_status AS sell_quote_status,
        (q.id IS NOT NULL AND q.quote_status = 'success' AND q.quoted_at >= now() - interval '15 seconds') AS sell_quote_fresh,
        CASE WHEN q.id IS NOT NULL AND q.quote_status = 'success' AND q.quoted_at >= now() - interval '15 seconds' THEN
          ((q.output_amount_base_units - COALESCE(q.protocol_fee_lamports, 0) - COALESCE(q.creator_fee_lamports, 0)
            - COALESCE(q.network_fee_lamports, 0) - COALESCE(q.priority_fee_lamports, 0)) / 1000000000::numeric)::text
        ELSE NULL END AS estimated_exit_sol,
        CASE WHEN q.id IS NOT NULL AND q.quote_status = 'success' AND q.quoted_at >= now() - interval '15 seconds' THEN
          ((q.output_amount_base_units - COALESCE(q.protocol_fee_lamports, 0) - COALESCE(q.creator_fee_lamports, 0)
            - COALESCE(q.network_fee_lamports, 0) - COALESCE(q.priority_fee_lamports, 0)
            - p.principal_lamports - COALESCE(buy_fees.fees, 0)) / 1000000000::numeric)::text
        ELSE NULL END AS estimated_unrealized_pnl_sol
      FROM positions p
      JOIN tokens t ON t.mint = p.mint
      LEFT JOIN LATERAL (
        SELECT id, quoted_at, quote_status, output_amount_base_units, protocol_fee_lamports,
          creator_fee_lamports, network_fee_lamports, priority_fee_lamports
        FROM execution_quotes
        WHERE mint = p.mint AND side = 'sell'
          AND input_amount_base_units = p.token_quantity_base_units
          AND market_phase = p.market_phase
        ORDER BY quoted_at DESC LIMIT 1
      ) q ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(COALESCE(protocol_fee_lamports, 0) + COALESCE(creator_fee_lamports, 0) + COALESCE(network_fee_lamports, 0) + COALESCE(priority_fee_lamports, 0)), 0) AS fees
        FROM trades WHERE position_id = p.id AND side = 'buy'
      ) buy_fees ON true
      WHERE p.status IN ('buy_pending','open','sell_pending','exit_unexecutable','migration_pending','open_migrated','exit_blocked')
      ORDER BY p.created_at DESC
    `),
    pool.query(`
      SELECT tr.id::text, tr.position_id::text, tr.mint, t.name, t.symbol,
        tr.side, tr.executed_at, tr.token_amount_base_units::text AS token_amount,
        (tr.sol_amount_lamports / 1000000000::numeric)::text AS sol_amount,
        ((COALESCE(tr.protocol_fee_lamports, 0) + COALESCE(tr.creator_fee_lamports, 0)
          + COALESCE(tr.network_fee_lamports, 0) + COALESCE(tr.priority_fee_lamports, 0))
          / 1000000000::numeric)::text AS fees_sol,
        tr.price_impact_pct::text, tr.slippage_pct::text,
        tr.simulation_profile, tr.simulated_latency_ms, tr.strategy_version
      FROM trades tr
      JOIN tokens t ON t.mint = tr.mint
      ORDER BY tr.executed_at DESC
      LIMIT 200
    `),
    pool.query(`
      SELECT p.id::text, p.mint, t.name, t.symbol, p.opened_at, p.closed_at,
        (p.principal_lamports / 1000000000::numeric)::text AS principal_sol,
        (p.gross_pnl_lamports / 1000000000::numeric)::text AS gross_pnl_sol,
        (p.total_cost_lamports / 1000000000::numeric)::text AS costs_sol,
        (p.net_pnl_lamports / 1000000000::numeric)::text AS net_pnl_sol,
        p.net_pnl_usd::text AS net_pnl_usd, p.exit_reason, p.zero_balance_confirmed
      FROM positions p JOIN tokens t ON t.mint = p.mint
      WHERE p.status = 'closed'
      ORDER BY p.closed_at DESC NULLS LAST
      LIMIT 100
    `)
  ]);

  const portfolio = portfolioResult.rows[0] ?? {};
  const positions: DashboardPosition[] = positionsResult.rows.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    mint: String(row.mint),
    name: row.name == null ? null : String(row.name),
    symbol: row.symbol == null ? null : String(row.symbol),
    status: String(row.status),
    marketPhase: String(row.market_phase),
    venue: row.market_venue == null ? null : String(row.market_venue),
    openedAt: row.opened_at == null ? null : new Date(String(row.opened_at)).toISOString(),
    principalSol: String(row.principal_sol ?? "0"),
    tokenQuantity: String(row.token_quantity ?? "0"),
    latestSellQuoteAt: row.latest_sell_quote_at == null ? null : new Date(String(row.latest_sell_quote_at)).toISOString(),
    sellQuoteFresh: row.sell_quote_fresh === true,
    sellQuoteStatus: row.sell_quote_status == null ? null : String(row.sell_quote_status),
    estimatedExitSol: row.estimated_exit_sol == null ? null : String(row.estimated_exit_sol),
    estimatedUnrealizedPnlSol: row.estimated_unrealized_pnl_sol == null ? null : String(row.estimated_unrealized_pnl_sol),
    unrealizedValuationStatus: row.sell_quote_fresh === true ? "fresh_executable_quote" : "quote_unavailable_or_stale",
    exitBlockedReason: row.exit_blocked_reason == null ? null : String(row.exit_blocked_reason),
    activeStopNetReturnPct: row.active_stop_net_return_pct == null ? null : String(row.active_stop_net_return_pct)
  }));

  return {
    available: true,
    generatedAt: new Date().toISOString(),
    valuationPolicy: "Open-position valuation uses a successful sell quote no older than 15 seconds and sized for the full remaining token quantity. No chart-price mark is substituted.",
    portfolio: {
      realizedPnlLamports: String(portfolio.realized_pnl_lamports ?? "0"),
      realizedPnlSol: String(portfolio.realized_pnl_sol ?? '0'),
      realizedPnlUsd: portfolio.realized_pnl_usd == null ? null : String(portfolio.realized_pnl_usd),
      openPositions: Number(portfolio.open_positions ?? 0),
      closedPositions: Number(portfolio.closed_positions ?? 0),
      confirmedClosedPositions: Number(portfolio.confirmed_closed_positions ?? 0),
      unrealizedPnlSol: positions.every(p => p.estimatedUnrealizedPnlSol !== null)
        ? sumSolDecimals(positions.map(p => p.estimatedUnrealizedPnlSol as string))
        : null,
      unrealizedPnlUsd: null,
      usdValuationNote: "Open positions are listed individually with SOL proceeds and SOL unrealized PnL when a fresh full-size sell quote exists. Portfolio-level unrealized PnL is withheld if any open position lacks a fresh full-size sell quote. Unrealized USD requires a timestamped SOL/USD price feed."
    },
    positions,
    closedPositions: closedResult.rows.map((row: Record<string, unknown>) => ({
      id: String(row.id), mint: String(row.mint),
      name: row.name == null ? null : String(row.name),
      symbol: row.symbol == null ? null : String(row.symbol),
      openedAt: row.opened_at == null ? null : new Date(String(row.opened_at)).toISOString(),
      closedAt: row.closed_at == null ? null : new Date(String(row.closed_at)).toISOString(),
      principalSol: String(row.principal_sol ?? "0"),
      grossPnlSol: row.gross_pnl_sol == null ? null : String(row.gross_pnl_sol),
      costsSol: row.costs_sol == null ? null : String(row.costs_sol),
      netPnlSol: row.net_pnl_sol == null ? null : String(row.net_pnl_sol),
      netPnlUsd: row.net_pnl_usd == null ? null : String(row.net_pnl_usd),
      exitReason: row.exit_reason == null ? null : String(row.exit_reason),
      zeroBalanceConfirmed: row.zero_balance_confirmed === true
    })),
    trades: tradesResult.rows.map((row: Record<string, unknown>) => ({
      id: String(row.id), positionId: String(row.position_id), mint: String(row.mint),
      name: row.name == null ? null : String(row.name), symbol: row.symbol == null ? null : String(row.symbol),
      side: String(row.side), executedAt: new Date(String(row.executed_at)).toISOString(),
      tokenAmount: String(row.token_amount), solAmount: String(row.sol_amount),
      feesSol: String(row.fees_sol), priceImpactPct: row.price_impact_pct == null ? null : String(row.price_impact_pct),
      slippagePct: row.slippage_pct == null ? null : String(row.slippage_pct),
      simulationProfile: String(row.simulation_profile), simulatedLatencyMs: Number(row.simulated_latency_ms),
      strategyVersion: String(row.strategy_version)
    }))
  };
  } catch {
    return unavailable("Ledger tables are unavailable or the dashboard query failed; inspect database migrations and service logs");
  }
}


export interface PaperAuditEventInput {
  sessionId: string;
  sequence: number;
  eventId: string;
  kind: string;
  occurredAt: string;
  mint: string | null;
  strategyVersion: string;
  data: unknown;
}

export interface PersistPaperAuditEventsResult {
  inserted: number;
  duplicates: number;
  lastSequence: number;
}

/**
 * Persist an ordered Durable Object audit batch. A row lock serializes
 * concurrent sync requests; event id + sequence uniqueness makes retries safe.
 */
export async function persistPaperAuditEvents(
  sessionId: string,
  events: PaperAuditEventInput[]
): Promise<PersistPaperAuditEventsResult> {
  if (!pool) throw new Error("PostgreSQL persistence is not configured.");
  if (!sessionId.trim() || sessionId.length > 128) throw new Error("Invalid paper session id.");
  if (!Array.isArray(events) || events.length === 0 || events.length > 100) {
    throw new Error("Paper audit batch must contain between 1 and 100 events.");
  }
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  for (const event of ordered) {
    if (event.sessionId !== sessionId || !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
        !event.eventId || event.eventId.length > 256 || !event.kind || event.kind.length > 128 ||
        !event.strategyVersion || event.strategyVersion.length > 128 ||
        (event.mint !== null && (typeof event.mint !== "string" || event.mint.length > 64)) ||
        !Number.isFinite(Date.parse(event.occurredAt))) {
      throw new Error("Paper audit event contains invalid identity, sequence or timestamp fields.");
    }
    if (JSON.stringify(event.data ?? {}) === undefined) {
      throw new Error("Paper audit event payload is not JSON serializable.");
    }
  }

  const client = await pool.connect();
  let inserted = 0;
  let duplicates = 0;
  try {
    await client.query("BEGIN");
    const first = ordered[0]!;
    await client.query(
      `INSERT INTO paper_sessions (id,status,started_at,strategy_version,last_sequence,last_event_at)
       VALUES ($1,'active',$2,$3,0,$2)
       ON CONFLICT (id) DO NOTHING`,
      [sessionId, first.occurredAt, first.strategyVersion]
    );
    const sessionResult = await client.query<{ last_sequence: string }>(
      "SELECT last_sequence::text FROM paper_sessions WHERE id=$1 FOR UPDATE",
      [sessionId]
    );
    const lockedSession = sessionResult.rows[0];
    if (!lockedSession) throw new Error("Paper session row could not be locked.");
    let lastSequence = BigInt(lockedSession.last_sequence);

    for (const event of ordered) {
      const sequence = BigInt(event.sequence);
      if (sequence <= lastSequence) {
        const existing = await client.query<{ event_id: string; event_type: string; same_event: boolean }>(
          `SELECT event_id,event_type,
             (payload=$3::jsonb AND occurred_at=$4 AND mint IS NOT DISTINCT FROM $5
               AND strategy_version=$6) AS same_event
           FROM paper_session_events WHERE session_id=$1 AND sequence=$2`,
          [sessionId, event.sequence, JSON.stringify(event.data ?? {}),
            event.occurredAt, event.mint, event.strategyVersion]
        );
        const existingEvent = existing.rows[0];
        if (!existingEvent ||
            existingEvent.event_id !== event.eventId ||
            existingEvent.event_type !== event.kind ||
            existingEvent.same_event !== true) {
          throw new Error("Paper audit replay conflicts with an existing session sequence or payload.");
        }
        duplicates++;
        continue;
      }
      if (sequence !== lastSequence + 1n) {
        throw new Error(`Paper audit sequence gap: expected ${lastSequence + 1n}, received ${sequence}.`);
      }
      await client.query(
        `INSERT INTO paper_session_events
          (session_id,event_id,sequence,event_type,mint,strategy_version,occurred_at,payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [sessionId, event.eventId, event.sequence, event.kind, event.mint,
          event.strategyVersion, event.occurredAt, JSON.stringify(event.data ?? {})]
      );

      // Keep queryable position/quote/trade projections in the same SQL
      // transaction as the immutable journal event. A projection failure
      // rolls back the event insert so the Durable Object outbox can retry.
      const projection = buildPaperLedgerProjection(event);
      for (const position of projection.positions) {
        const projected = await client.query(
          `INSERT INTO paper_position_projection
            (session_id,external_position_id,mint,status,opened_at,closed_at,stake_usd,
             token_amount_base_units,token_decimals,entry_price_usd_per_token,buy_costs_usd,
             latest_liquidation_value_usd,realized_pnl_usd,exit_reason,last_event_sequence,snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
           ON CONFLICT (session_id,external_position_id) DO UPDATE SET
             mint=EXCLUDED.mint,status=EXCLUDED.status,opened_at=EXCLUDED.opened_at,
             closed_at=EXCLUDED.closed_at,stake_usd=EXCLUDED.stake_usd,
             token_amount_base_units=EXCLUDED.token_amount_base_units,
             token_decimals=EXCLUDED.token_decimals,
             entry_price_usd_per_token=EXCLUDED.entry_price_usd_per_token,
             buy_costs_usd=EXCLUDED.buy_costs_usd,
             latest_liquidation_value_usd=EXCLUDED.latest_liquidation_value_usd,
             realized_pnl_usd=EXCLUDED.realized_pnl_usd,exit_reason=EXCLUDED.exit_reason,
             last_event_sequence=EXCLUDED.last_event_sequence,snapshot=EXCLUDED.snapshot,updated_at=now()
           WHERE EXCLUDED.last_event_sequence >= paper_position_projection.last_event_sequence
           RETURNING external_position_id`,
          [sessionId, position.positionId, position.mint, position.status, position.openedAt,
            position.closedAt, position.stakeUsd, position.tokenAmountBaseUnits,
            position.tokenDecimals, position.entryPriceUsdPerToken, position.buyCostsUsd,
            position.latestLiquidationValueUsd, position.realizedPnlUsd, position.exitReason,
            event.sequence, JSON.stringify(position.raw)]
        );
        if ((projected.rowCount ?? 0) !== 1) throw new Error("Paper position projection conflicted with a newer event.");
      }
      for (const quote of projection.quotes) {
        const projected = await client.query(
          `INSERT INTO paper_execution_quote_projection
            (session_id,external_quote_id,external_position_id,mint,side,provider,venue,context_slot,
             observed_at,expires_at,requested_usd,input_amount_base_units,output_amount_base_units,
             output_usd,price_impact_pct,simulated_latency_ms,simulated_fill_at,fee_breakdown_usd,raw_quote)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb)
           ON CONFLICT (session_id,external_quote_id) DO UPDATE SET
             raw_quote=EXCLUDED.raw_quote
           WHERE paper_execution_quote_projection.raw_quote=EXCLUDED.raw_quote
           RETURNING external_quote_id`,
          [sessionId, quote.quoteId, (projection.positions.find(position => position.mint === quote.mint)?.positionId) ??
            String((event.data as Record<string, unknown>).positionId ?? ""),
            quote.mint, quote.side, quote.provider, quote.venue ?? null, quote.slot ?? null,
            quote.observedAt, quote.expiresAt, quote.requestedUsd, quote.inputAmountBaseUnits,
            quote.outputAmountBaseUnits, quote.outputUsd, quote.priceImpactPct,
            quote.simulatedLatencyMs, quote.simulatedFillAt,
            JSON.stringify(quote.feeBreakdownUsd), JSON.stringify(quote.raw)]
        );
        if ((projected.rowCount ?? 0) !== 1) throw new Error("Paper quote projection id conflicts with different quote evidence.");
      }
      for (const trade of projection.trades) {
        const projected = await client.query(
          `INSERT INTO paper_trade_projection
            (session_id,external_trade_id,external_position_id,mint,side,quote_id,executed_at,
             token_amount_base_units,quote_amount_base_units,gross_usd,total_fees_usd,
             simulated_latency_ms,raw_trade)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
           ON CONFLICT (session_id,external_trade_id) DO UPDATE SET
             raw_trade=EXCLUDED.raw_trade
           WHERE paper_trade_projection.raw_trade=EXCLUDED.raw_trade
           RETURNING external_trade_id`,
          [sessionId, trade.externalTradeId, trade.positionId, trade.mint, trade.side,
            trade.quoteId, trade.executedAt, trade.tokenAmountBaseUnits,
            trade.quoteAmountBaseUnits, trade.grossUsd, trade.totalFeesUsd,
            trade.simulatedLatencyMs, JSON.stringify(trade.raw)]
        );
        if ((projected.rowCount ?? 0) !== 1) throw new Error("Paper trade projection id conflicts with different trade evidence.");
      }
      const stopped = event.kind === "SESSION_STOPPED";
      await client.query(
        `UPDATE paper_sessions
         SET status=$2,
             stopped_at=CASE WHEN $2='stopped' THEN $3 ELSE stopped_at END,
             last_sequence=$4,last_event_at=$3,strategy_version=$5,updated_at=now()
         WHERE id=$1`,
        [sessionId, stopped ? "stopped" : "active", event.occurredAt,
          event.sequence, event.strategyVersion]
      );
      lastSequence = sequence;
      inserted++;
    }
    await client.query("COMMIT");
    return { inserted, duplicates, lastSequence: Number(lastSequence) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface WorkerLeaseResult {
  acquired: boolean;
  ownerId: string | null;
  expiresAt: string | null;
}

function validateLeaseInput(leaseName: string, ownerId: string, ttlSeconds: number): void {
  if (!leaseName.trim() || leaseName.length > 128 || !ownerId.trim() || ownerId.length > 256 ||
      !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 15 || ttlSeconds > 120) {
    throw new Error("Worker lease identity or TTL is invalid.");
  }
}

export async function acquireWorkerLease(
  leaseName: string, ownerId: string, ttlSeconds = 45
): Promise<WorkerLeaseResult> {
  if (!pool) throw new Error("PostgreSQL persistence is not configured.");
  validateLeaseInput(leaseName, ownerId, ttlSeconds);
  const result = await pool.query<{ owner_id: string; expires_at: Date }>(
    `INSERT INTO worker_leases (lease_name,owner_id,acquired_at,heartbeat_at,expires_at)
     VALUES ($1,$2,now(),now(),now()+($3 * interval '1 second'))
     ON CONFLICT (lease_name) DO UPDATE
       SET owner_id=EXCLUDED.owner_id,
           acquired_at=CASE WHEN worker_leases.owner_id=EXCLUDED.owner_id
             THEN worker_leases.acquired_at ELSE now() END,
           heartbeat_at=now(), expires_at=EXCLUDED.expires_at
       WHERE worker_leases.expires_at <= now() OR worker_leases.owner_id=EXCLUDED.owner_id
     RETURNING owner_id,expires_at`,
    [leaseName, ownerId, ttlSeconds]
  );
  const row = result.rows[0];
  return row
    ? { acquired: true, ownerId: row.owner_id, expiresAt: new Date(row.expires_at).toISOString() }
    : { acquired: false, ownerId: null, expiresAt: null };
}

export async function heartbeatWorkerLease(
  leaseName: string, ownerId: string, ttlSeconds = 45
): Promise<WorkerLeaseResult> {
  if (!pool) throw new Error("PostgreSQL persistence is not configured.");
  validateLeaseInput(leaseName, ownerId, ttlSeconds);
  const result = await pool.query<{ owner_id: string; expires_at: Date }>(
    `UPDATE worker_leases
     SET heartbeat_at=now(),expires_at=now()+($3 * interval '1 second')
     WHERE lease_name=$1 AND owner_id=$2 AND expires_at>now()
     RETURNING owner_id,expires_at`,
    [leaseName, ownerId, ttlSeconds]
  );
  const row = result.rows[0];
  return row
    ? { acquired: true, ownerId: row.owner_id, expiresAt: new Date(row.expires_at).toISOString() }
    : { acquired: false, ownerId: null, expiresAt: null };
}

export async function releaseWorkerLease(leaseName: string, ownerId: string): Promise<boolean> {
  if (!pool) throw new Error("PostgreSQL persistence is not configured.");
  if (!leaseName.trim() || leaseName.length > 128 || !ownerId.trim() || ownerId.length > 256) {
    throw new Error("Worker lease identity is invalid.");
  }
  const result = await pool.query(
    "DELETE FROM worker_leases WHERE lease_name=$1 AND owner_id=$2",
    [leaseName, ownerId]
  );
  return (result.rowCount ?? 0) === 1;
}


export async function getPaperSessionLedgerSnapshot(sessionId?: string) {
  const unavailable = (reason: string) => ({
    available: false as const, reason, generatedAt: new Date().toISOString(),
    sessions: [], positions: [], quotes: [], trades: []
  });
  if (!pool) return unavailable("DATABASE_URL is not configured");
  const persistence = await getPersistenceStatus();
  if (!persistence.connected) return unavailable("PostgreSQL is not connected");
  try {
    const projectionMigration = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE version='0005_paper_trade_projections' LIMIT 1"
    );
    if (projectionMigration.rows.length === 0) {
      return unavailable("Migration 0005_paper_trade_projections must be explicitly applied before reading the paper ledger projection");
    }
  } catch {
    return unavailable("Paper ledger migration status could not be verified");
  }
  if (sessionId !== undefined && (!sessionId.trim() || sessionId.length > 128)) {
    return unavailable("Invalid paper session id");
  }
  try {
    const sessionsResult = await pool.query(
      `SELECT id,status,started_at,stopped_at,strategy_version,last_sequence,last_event_at,metadata
       FROM paper_sessions
       ${sessionId ? "WHERE id=$1" : ""}
       ORDER BY started_at DESC LIMIT 50`,
      sessionId ? [sessionId] : []
    );
    const ids = sessionsResult.rows.map(row => String(row.id));
    if (ids.length === 0) {
      return { available: true as const, generatedAt: new Date().toISOString(),
        sessions: [], positions: [], quotes: [], trades: [] };
    }
    const [positions, quotes, trades] = await Promise.all([
      pool.query(
        `SELECT session_id,external_position_id,mint,status,opened_at,closed_at,
          stake_usd::text,token_amount_base_units::text,token_decimals,
          entry_price_usd_per_token::text,buy_costs_usd::text,
          latest_liquidation_value_usd::text,realized_pnl_usd::text,exit_reason,
          last_event_sequence,snapshot
         FROM paper_position_projection WHERE session_id=ANY($1::text[])
         ORDER BY opened_at DESC`, [ids]
      ),
      pool.query(
        `SELECT session_id,external_quote_id,external_position_id,mint,side,provider,venue,
          context_slot,observed_at,expires_at,requested_usd::text,
          input_amount_base_units::text,output_amount_base_units::text,output_usd::text,
          price_impact_pct::text,simulated_latency_ms,simulated_fill_at,
          fee_breakdown_usd,raw_quote
         FROM paper_execution_quote_projection WHERE session_id=ANY($1::text[])
         ORDER BY observed_at DESC LIMIT 500`, [ids]
      ),
      pool.query(
        `SELECT session_id,external_trade_id,external_position_id,mint,side,quote_id,
          executed_at,token_amount_base_units::text,quote_amount_base_units::text,
          gross_usd::text,total_fees_usd::text,simulated_latency_ms,raw_trade
         FROM paper_trade_projection WHERE session_id=ANY($1::text[])
         ORDER BY executed_at DESC LIMIT 500`, [ids]
      )
    ]);
    return {
      available: true as const,
      generatedAt: new Date().toISOString(),
      sessions: sessionsResult.rows,
      positions: positions.rows,
      quotes: quotes.rows,
      trades: trades.rows
    };
  } catch {
    return unavailable("Paper ledger projection tables are unavailable; inspect migration 0005 and database logs");
  }
}


export interface HeliusBackfillArchiveInput {
  sessionId: string;
  mint: string;
  state: {
    bondingCurve: string;
    createSignature: string;
    launchBlockTime: number | null;
    horizonSeconds: number;
    maxSignatures: number;
    signatures: Array<{ signature: string; slot: number; blockTime: number | null; err: unknown }>;
    pagesScanned: number;
    scannedCount: number;
    before: string | null;
    status: "PENDING" | "PAGING" | "READY_TO_FETCH" | "COMPLETE" | "INCOMPLETE";
    reason: string | null;
  };
  transaction?: {
    mint: string;
    signature: string;
    slot: number;
    provider: "helius";
    commitment: "confirmed" | "finalized";
    receivedAt: string;
    createEvents: unknown[];
    tradeEvents: unknown[];
  };
}

/** Persist an idempotent backfill checkpoint and, when supplied, a verified decoded transaction. */
export async function persistHeliusBackfillArchive(input: HeliusBackfillArchiveInput): Promise<void> {
  if (!pool) throw new Error("PostgreSQL persistence is not configured.");
  const { sessionId, mint, state, transaction } = input;
  const address = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const signaturePattern = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;
  if (!sessionId.trim() || sessionId.length > 128 || !address.test(mint) ||
      !address.test(state.bondingCurve) || !signaturePattern.test(state.createSignature) ||
      (state.launchBlockTime === null ? state.status !== "INCOMPLETE" :
        !Number.isSafeInteger(state.launchBlockTime) || state.launchBlockTime < 0) ||
      !Number.isSafeInteger(state.horizonSeconds) || state.horizonSeconds < 60 || state.horizonSeconds > 1800 ||
      !Number.isSafeInteger(state.maxSignatures) || state.maxSignatures < 1 || state.maxSignatures > 500 ||
      !Number.isSafeInteger(state.pagesScanned) || state.pagesScanned < 0 ||
      !Number.isSafeInteger(state.scannedCount) || state.scannedCount < 0 ||
      !Array.isArray(state.signatures) || state.signatures.length > state.maxSignatures ||
      (state.before !== null && !signaturePattern.test(state.before)) ||
      (state.status === "COMPLETE" && !state.signatures.some(item => item.signature === state.createSignature)) ||
      !["PENDING","PAGING","READY_TO_FETCH","COMPLETE","INCOMPLETE"].includes(state.status)) {
    throw new Error("Historical backfill archive contains invalid identity or progress fields.");
  }
  for (const item of state.signatures) {
    if (!signaturePattern.test(item.signature) || !Number.isSafeInteger(item.slot) || item.slot < 0 ||
        !(item.blockTime === null || (Number.isSafeInteger(item.blockTime) && item.blockTime >= 0))) {
      throw new Error("Historical backfill archive contains an invalid signature record.");
    }
  }
  if (state.status === "COMPLETE" &&
      (state.launchBlockTime === null || state.signatures.some(item => item.blockTime === null))) {
    throw new Error("Complete historical coverage requires verified block times for every archived signature.");
  }
  if (state.scannedCount < state.signatures.length) {
    throw new Error("Historical signature count exceeds the verified scan count.");
  }
  if (transaction) {
    const signatureEvidence = state.signatures.find(item => item.signature === transaction.signature);
    if (transaction.mint !== mint || !signaturePattern.test(transaction.signature) ||
        !Number.isSafeInteger(transaction.slot) || transaction.slot < 0 ||
        !signatureEvidence || signatureEvidence.slot !== transaction.slot ||
        transaction.provider !== "helius" || !["confirmed","finalized"].includes(transaction.commitment) ||
        !Number.isFinite(Date.parse(transaction.receivedAt)) ||
        !Array.isArray(transaction.createEvents) || !Array.isArray(transaction.tradeEvents)) {
      throw new Error("Historical transaction observation does not match verified signature evidence.");
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const session = await client.query("SELECT id FROM paper_sessions WHERE id=$1 FOR SHARE", [sessionId]);
    if (session.rowCount !== 1) throw new Error("Paper session must be ingested before its Helius archive.");
    const checkpoint = await client.query(
      `INSERT INTO helius_backfill_jobs
        (session_id,mint,bonding_curve,create_signature,launch_block_time,horizon_seconds,max_signatures,
         pages_scanned,scanned_count,before_signature,status,reason,signature_count,signature_state,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,now())
       ON CONFLICT (session_id,mint) DO UPDATE SET
         pages_scanned=EXCLUDED.pages_scanned,scanned_count=EXCLUDED.scanned_count,
         before_signature=EXCLUDED.before_signature,status=EXCLUDED.status,reason=EXCLUDED.reason,
         signature_count=EXCLUDED.signature_count,signature_state=EXCLUDED.signature_state,updated_at=now()
       WHERE helius_backfill_jobs.bonding_curve=EXCLUDED.bonding_curve
         AND helius_backfill_jobs.create_signature=EXCLUDED.create_signature
         AND helius_backfill_jobs.launch_block_time IS NOT DISTINCT FROM EXCLUDED.launch_block_time
         AND helius_backfill_jobs.horizon_seconds=EXCLUDED.horizon_seconds
         AND helius_backfill_jobs.max_signatures=EXCLUDED.max_signatures
         AND EXCLUDED.pages_scanned >= helius_backfill_jobs.pages_scanned
         AND EXCLUDED.scanned_count >= helius_backfill_jobs.scanned_count
         AND (EXCLUDED.pages_scanned > helius_backfill_jobs.pages_scanned OR
           (EXCLUDED.scanned_count=helius_backfill_jobs.scanned_count
            AND EXCLUDED.before_signature IS NOT DISTINCT FROM helius_backfill_jobs.before_signature
            AND EXCLUDED.status=helius_backfill_jobs.status
            AND EXCLUDED.reason IS NOT DISTINCT FROM helius_backfill_jobs.reason
            AND EXCLUDED.signature_state=helius_backfill_jobs.signature_state))
       RETURNING mint`,
      [sessionId,mint,state.bondingCurve,state.createSignature,state.launchBlockTime,state.horizonSeconds,
        state.maxSignatures,state.pagesScanned,state.scannedCount,state.before,state.status,state.reason,
        state.signatures.length,JSON.stringify(state.signatures)]
    );
    if (checkpoint.rowCount !== 1) {
      throw new Error("Historical backfill checkpoint conflicts with immutable identity or previously persisted progress.");
    }
    if (transaction) {
      const raw = JSON.stringify(transaction);
      const result = await client.query(
        `INSERT INTO helius_transaction_observations
          (session_id,mint,signature,slot,provider,commitment,received_at,create_events,trade_events,raw_observation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb)
         ON CONFLICT (session_id,mint,signature) DO UPDATE SET
           raw_observation=EXCLUDED.raw_observation
         WHERE helius_transaction_observations.raw_observation=EXCLUDED.raw_observation
         RETURNING signature`,
        [sessionId,mint,transaction.signature,transaction.slot,transaction.provider,transaction.commitment,
          transaction.receivedAt,JSON.stringify(transaction.createEvents),JSON.stringify(transaction.tradeEvents),raw]
      );
      if (result.rowCount !== 1) throw new Error("Historical transaction signature conflicts with previously archived evidence.");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
