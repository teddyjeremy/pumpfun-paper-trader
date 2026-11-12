-- Queryable, replayable projections of the append-only Durable Object paper journal.
-- The journal remains the source of truth; these tables are rebuilt/upserted from its events.

CREATE TABLE IF NOT EXISTS paper_position_projection (
  session_id TEXT NOT NULL REFERENCES paper_sessions(id) ON DELETE RESTRICT,
  external_position_id TEXT NOT NULL,
  mint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED','EXIT_BLOCKED')),
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  stake_usd NUMERIC(24,10) NOT NULL CHECK (stake_usd >= 0),
  token_amount_base_units NUMERIC(40,0) NOT NULL CHECK (token_amount_base_units > 0),
  token_decimals SMALLINT NOT NULL CHECK (token_decimals BETWEEN 0 AND 18),
  entry_price_usd_per_token NUMERIC(36,18) NOT NULL CHECK (entry_price_usd_per_token >= 0),
  buy_costs_usd NUMERIC(24,10) NOT NULL CHECK (buy_costs_usd >= 0),
  latest_liquidation_value_usd NUMERIC(24,10) NOT NULL CHECK (latest_liquidation_value_usd >= 0),
  realized_pnl_usd NUMERIC(24,10),
  exit_reason TEXT,
  last_event_sequence BIGINT NOT NULL,
  snapshot JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, external_position_id)
);
CREATE INDEX IF NOT EXISTS paper_position_projection_session_status_idx
  ON paper_position_projection(session_id,status,opened_at DESC);
CREATE INDEX IF NOT EXISTS paper_position_projection_mint_idx
  ON paper_position_projection(mint,opened_at DESC);

CREATE TABLE IF NOT EXISTS paper_execution_quote_projection (
  session_id TEXT NOT NULL REFERENCES paper_sessions(id) ON DELETE RESTRICT,
  external_quote_id TEXT NOT NULL,
  external_position_id TEXT NOT NULL,
  mint TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  provider TEXT NOT NULL,
  venue TEXT,
  context_slot BIGINT,
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  requested_usd NUMERIC(24,10) NOT NULL CHECK (requested_usd >= 0),
  input_amount_base_units NUMERIC(40,0) NOT NULL CHECK (input_amount_base_units > 0),
  output_amount_base_units NUMERIC(40,0) NOT NULL CHECK (output_amount_base_units > 0),
  output_usd NUMERIC(24,10) NOT NULL CHECK (output_usd >= 0),
  price_impact_pct NUMERIC(12,6) NOT NULL CHECK (price_impact_pct >= 0),
  simulated_latency_ms INTEGER NOT NULL CHECK (simulated_latency_ms >= 0),
  simulated_fill_at TIMESTAMPTZ NOT NULL,
  fee_breakdown_usd JSONB NOT NULL,
  raw_quote JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, external_quote_id),
  FOREIGN KEY (session_id, external_position_id)
    REFERENCES paper_position_projection(session_id, external_position_id)
    ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS paper_execution_quote_projection_mint_time_idx
  ON paper_execution_quote_projection(mint,observed_at DESC);

CREATE TABLE IF NOT EXISTS paper_trade_projection (
  session_id TEXT NOT NULL REFERENCES paper_sessions(id) ON DELETE RESTRICT,
  external_trade_id TEXT NOT NULL,
  external_position_id TEXT NOT NULL,
  mint TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  quote_id TEXT NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL,
  token_amount_base_units NUMERIC(40,0) NOT NULL CHECK (token_amount_base_units > 0),
  quote_amount_base_units NUMERIC(40,0) NOT NULL CHECK (quote_amount_base_units > 0),
  gross_usd NUMERIC(24,10) NOT NULL CHECK (gross_usd >= 0),
  total_fees_usd NUMERIC(24,10) NOT NULL CHECK (total_fees_usd >= 0),
  simulated_latency_ms INTEGER NOT NULL CHECK (simulated_latency_ms >= 0),
  raw_trade JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, external_trade_id),
  FOREIGN KEY (session_id, external_position_id)
    REFERENCES paper_position_projection(session_id, external_position_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (session_id, quote_id)
    REFERENCES paper_execution_quote_projection(session_id, external_quote_id)
    ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS paper_trade_projection_session_time_idx
  ON paper_trade_projection(session_id,executed_at DESC);
CREATE INDEX IF NOT EXISTS paper_trade_projection_mint_time_idx
  ON paper_trade_projection(mint,executed_at DESC);

INSERT INTO schema_migrations(version) VALUES ('0005_paper_trade_projections')
ON CONFLICT (version) DO NOTHING;
