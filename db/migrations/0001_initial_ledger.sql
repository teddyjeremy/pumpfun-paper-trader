-- Initial durable ledger for the Pump.fun paper trader.
-- Amounts are stored as integer base units/lamports or exact NUMERIC values.
-- This migration is additive; it does not delete or rewrite existing data.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('debug','info','warning','error','fatal')),
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS system_events_occurred_at_idx ON system_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS system_events_type_time_idx ON system_events (event_type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  bonding_curve TEXT,
  creator TEXT,
  name TEXT,
  symbol TEXT,
  metadata_uri TEXT,
  token_program TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  graduated_at TIMESTAMPTZ,
  curve_status TEXT NOT NULL DEFAULT 'unknown' CHECK (curve_status IN ('unknown','active','approaching_graduation','graduated','unavailable')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS token_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mint TEXT NOT NULL REFERENCES tokens(mint),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  slot BIGINT,
  real_sol_reserves_lamports NUMERIC(30,0),
  virtual_sol_reserves_lamports NUMERIC(30,0),
  token_reserves_base_units NUMERIC(40,0),
  market_cap_sol NUMERIC(30,12),
  price_sol NUMERIC(30,18),
  holder_count INTEGER,
  unique_buyers_60s INTEGER,
  unique_sellers_60s INTEGER,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS token_snapshots_mint_time_idx ON token_snapshots (mint, observed_at DESC);

CREATE TABLE IF NOT EXISTS risk_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mint TEXT NOT NULL REFERENCES tokens(mint),
  assessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  risk_score NUMERIC(6,2),
  decision TEXT NOT NULL CHECK (decision IN ('eligible','monitor','reject')),
  hard_rejected BOOLEAN NOT NULL DEFAULT false,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  strategy_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS risk_assessments_mint_time_idx ON risk_assessments (mint, assessed_at DESC);

CREATE TABLE IF NOT EXISTS opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mint TEXT NOT NULL REFERENCES tokens(mint),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  stage TEXT NOT NULL CHECK (stage IN ('discovered','enriched','risk_passed','quoted','watchlisted','entered','rejected','expired')),
  momentum_score NUMERIC(6,2),
  risk_score NUMERIC(6,2),
  expected_net_profit_pct NUMERIC(12,6),
  rejection_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  feature_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  strategy_version TEXT NOT NULL,
  config_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS opportunities_detected_at_idx ON opportunities (detected_at DESC);
CREATE INDEX IF NOT EXISTS opportunities_mint_time_idx ON opportunities (mint, detected_at DESC);
CREATE INDEX IF NOT EXISTS opportunities_stage_time_idx ON opportunities (stage, detected_at DESC);

CREATE TABLE IF NOT EXISTS execution_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mint TEXT NOT NULL REFERENCES tokens(mint),
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  quoted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  context_slot BIGINT,
  input_amount_base_units NUMERIC(40,0),
  output_amount_base_units NUMERIC(40,0),
  protocol_fee_lamports NUMERIC(30,0),
  creator_fee_lamports NUMERIC(30,0),
  network_fee_lamports NUMERIC(30,0),
  priority_fee_lamports NUMERIC(30,0),
  price_impact_pct NUMERIC(12,6),
  slippage_pct NUMERIC(12,6),
  quote_status TEXT NOT NULL CHECK (quote_status IN ('success','missing','stale','cost_rejected','sellability_failed','unavailable')),
  provider TEXT NOT NULL,
  sdk_version TEXT,
  raw_quote JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS execution_quotes_mint_time_idx ON execution_quotes (mint, quoted_at DESC);

CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mint TEXT NOT NULL REFERENCES tokens(mint),
  status TEXT NOT NULL CHECK (status IN ('buy_pending','open','sell_pending','closed','exit_unexecutable')),
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  principal_lamports NUMERIC(30,0) NOT NULL,
  token_quantity_base_units NUMERIC(40,0) NOT NULL DEFAULT 0,
  entry_quote_id UUID REFERENCES execution_quotes(id),
  exit_quote_id UUID REFERENCES execution_quotes(id),
  zero_balance_confirmed BOOLEAN NOT NULL DEFAULT false,
  gross_pnl_lamports NUMERIC(30,0),
  total_cost_lamports NUMERIC(30,0),
  net_pnl_lamports NUMERIC(30,0),
  net_pnl_usd NUMERIC(24,10),
  exit_reason TEXT,
  strategy_version TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'closed' OR zero_balance_confirmed = true)
);
CREATE INDEX IF NOT EXISTS positions_status_created_idx ON positions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS positions_mint_created_idx ON positions (mint, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS positions_one_active_per_mint_idx
  ON positions (mint) WHERE status IN ('buy_pending','open','sell_pending','exit_unexecutable');

CREATE TABLE IF NOT EXISTS trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id UUID NOT NULL REFERENCES positions(id),
  mint TEXT NOT NULL REFERENCES tokens(mint),
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  token_amount_base_units NUMERIC(40,0) NOT NULL,
  sol_amount_lamports NUMERIC(30,0) NOT NULL,
  protocol_fee_lamports NUMERIC(30,0) NOT NULL DEFAULT 0,
  creator_fee_lamports NUMERIC(30,0) NOT NULL DEFAULT 0,
  network_fee_lamports NUMERIC(30,0) NOT NULL DEFAULT 0,
  priority_fee_lamports NUMERIC(30,0) NOT NULL DEFAULT 0,
  price_impact_pct NUMERIC(12,6),
  slippage_pct NUMERIC(12,6),
  quote_id UUID REFERENCES execution_quotes(id),
  simulation_profile TEXT NOT NULL CHECK (simulation_profile IN ('optimistic','realistic','conservative')),
  simulated_latency_ms INTEGER NOT NULL,
  strategy_version TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS trades_executed_at_idx ON trades (executed_at DESC);
CREATE INDEX IF NOT EXISTS trades_mint_time_idx ON trades (mint, executed_at DESC);
CREATE INDEX IF NOT EXISTS trades_position_idx ON trades (position_id, executed_at);

CREATE TABLE IF NOT EXISTS market_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mint TEXT NOT NULL REFERENCES tokens(mint),
  window_seconds INTEGER NOT NULL CHECK (window_seconds IN (1,3,5,10,15,30,60)),
  window_started_at TIMESTAMPTZ NOT NULL,
  window_ended_at TIMESTAMPTZ NOT NULL,
  buy_count INTEGER NOT NULL DEFAULT 0,
  sell_count INTEGER NOT NULL DEFAULT 0,
  unique_buyers INTEGER NOT NULL DEFAULT 0,
  unique_sellers INTEGER NOT NULL DEFAULT 0,
  buy_volume_lamports NUMERIC(30,0) NOT NULL DEFAULT 0,
  sell_volume_lamports NUMERIC(30,0) NOT NULL DEFAULT 0,
  volume_imbalance NUMERIC(12,8),
  buy_pressure NUMERIC(12,8),
  price_change_pct NUMERIC(12,6),
  price_acceleration NUMERIC(18,10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mint, window_seconds, window_ended_at)
);
CREATE INDEX IF NOT EXISTS market_windows_mint_time_idx ON market_windows (mint, window_ended_at DESC);

CREATE TABLE IF NOT EXISTS provider_health (
  provider TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('connected','disconnected','reconnecting','degraded')),
  last_event_at TIMESTAMPTZ,
  last_slot BIGINT,
  reconnect_count INTEGER NOT NULL DEFAULT 0,
  slot_lag BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO schema_migrations (version) VALUES ('0001_initial_ledger')
ON CONFLICT (version) DO NOTHING;
