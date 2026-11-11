import pg from "pg";

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
      "SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1"
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
  estimatedExitSol: string | null;
  estimatedUnrealizedPnlSol: string | null;
  unrealizedValuationStatus: "fresh_executable_quote" | "quote_unavailable_or_stale";
  exitBlockedReason: string | null;
  activeStopNetReturnPct: string | null;
}

export async function getTradingDashboardSnapshot() {
  if (!pool) {
    return {
      available: false,
      reason: "DATABASE_URL is not configured",
      generatedAt: new Date().toISOString(),
      portfolio: null,
      positions: [],
      trades: []
    };
  }

  const [portfolioResult, positionsResult, tradesResult] = await Promise.all([
    pool.query(`
      SELECT
        COALESCE(SUM(net_pnl_lamports) FILTER (WHERE status = 'closed'), 0)::text AS realized_pnl_lamports,
        COALESCE(SUM(net_pnl_usd) FILTER (WHERE status = 'closed'), 0)::text AS realized_pnl_usd,
        COUNT(*) FILTER (WHERE status IN ('buy_pending','open','sell_pending','exit_unexecutable'))::int AS open_positions,
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
        (q.id IS NOT NULL) AS sell_quote_fresh,
        CASE WHEN q.id IS NOT NULL THEN
          ((q.output_amount_base_units - q.protocol_fee_lamports - q.creator_fee_lamports
            - q.network_fee_lamports - q.priority_fee_lamports) / 1000000000::numeric)::text
        ELSE NULL END AS estimated_exit_sol,
        CASE WHEN q.id IS NOT NULL THEN
          ((q.output_amount_base_units - q.protocol_fee_lamports - q.creator_fee_lamports
            - q.network_fee_lamports - q.priority_fee_lamports
            - p.principal_lamports - COALESCE(buy_fees.fees, 0)) / 1000000000::numeric)::text
        ELSE NULL END AS estimated_unrealized_pnl_sol
      FROM positions p
      JOIN tokens t ON t.mint = p.mint
      LEFT JOIN LATERAL (
        SELECT id, quoted_at, output_amount_base_units, protocol_fee_lamports,
          creator_fee_lamports, network_fee_lamports, priority_fee_lamports
        FROM execution_quotes
        WHERE mint = p.mint AND side = 'sell' AND quote_status = 'success'
          AND quoted_at >= now() - interval '15 seconds'
          AND input_amount_base_units >= p.token_quantity_base_units
          AND (market_phase = p.market_phase OR p.market_phase = 'migration_pending')
        ORDER BY quoted_at DESC LIMIT 1
      ) q ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(protocol_fee_lamports + creator_fee_lamports + network_fee_lamports + priority_fee_lamports), 0) AS fees
        FROM trades WHERE position_id = p.id AND side = 'buy'
      ) buy_fees ON true
      WHERE p.status IN ('buy_pending','open','sell_pending','exit_unexecutable')
      ORDER BY p.created_at DESC
    `),
    pool.query(`
      SELECT tr.id::text, tr.position_id::text, tr.mint, t.name, t.symbol,
        tr.side, tr.executed_at, tr.token_amount_base_units::text AS token_amount,
        (tr.sol_amount_lamports / 1000000000::numeric)::text AS sol_amount,
        ((tr.protocol_fee_lamports + tr.creator_fee_lamports
          + tr.network_fee_lamports + tr.priority_fee_lamports)
          / 1000000000::numeric)::text AS fees_sol,
        tr.price_impact_pct::text, tr.slippage_pct::text,
        tr.simulation_profile, tr.simulated_latency_ms, tr.strategy_version
      FROM trades tr
      JOIN tokens t ON t.mint = tr.mint
      ORDER BY tr.executed_at DESC
      LIMIT 200
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
      realizedPnlSol: (Number(portfolio.realized_pnl_lamports ?? 0) / 1_000_000_000).toFixed(9),
      realizedPnlUsd: portfolio.realized_pnl_usd == null ? null : String(portfolio.realized_pnl_usd),
      openPositions: Number(portfolio.open_positions ?? 0),
      closedPositions: Number(portfolio.closed_positions ?? 0),
      confirmedClosedPositions: Number(portfolio.confirmed_closed_positions ?? 0),
      unrealizedPnlSol: positions.every(p => p.estimatedUnrealizedPnlSol !== null)
        ? positions.reduce((sum, p) => sum + Number(p.estimatedUnrealizedPnlSol ?? 0), 0).toFixed(9)
        : null,
      unrealizedPnlUsd: null,
      usdValuationNote: "Unrealized USD is unavailable until a timestamped SOL/USD price feed is persisted. SOL-denominated quote PnL remains visible."
    },
    positions,
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
}
