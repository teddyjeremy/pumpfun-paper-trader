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
  if (persistence.migrationVersion !== "0002_migration_aware_dynamic_exits") {
    return unavailable("Required ledger migrations 0001 and 0002 are not both applied");
  }

  try {
  const [portfolioResult, positionsResult, tradesResult, closedResult] = await Promise.all([
    pool.query(`
      SELECT
        COALESCE(SUM(net_pnl_lamports) FILTER (WHERE status = 'closed'), 0)::text AS realized_pnl_lamports,
        (COALESCE(SUM(net_pnl_lamports) FILTER (WHERE status = 'closed'), 0) / 1000000000::numeric)::text AS realized_pnl_sol,
        CASE WHEN COUNT(*) FILTER (WHERE status = 'closed' AND net_pnl_usd IS NULL) = 0
          THEN SUM(net_pnl_usd) FILTER (WHERE status = 'closed')::text ELSE NULL END AS realized_pnl_usd,
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
          AND input_amount_base_units >= p.token_quantity_base_units
          AND (market_phase = p.market_phase OR p.market_phase = 'migration_pending')
        ORDER BY quoted_at DESC LIMIT 1
      ) q ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(COALESCE(protocol_fee_lamports, 0) + COALESCE(creator_fee_lamports, 0) + COALESCE(network_fee_lamports, 0) + COALESCE(priority_fee_lamports, 0)), 0) AS fees
        FROM trades WHERE position_id = p.id AND side = 'buy'
      ) buy_fees ON true
      WHERE p.status IN ('buy_pending','open','sell_pending','exit_unexecutable')
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
    sellQuoteStatus: row.quote_status == null ? null : String(row.quote_status),
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
