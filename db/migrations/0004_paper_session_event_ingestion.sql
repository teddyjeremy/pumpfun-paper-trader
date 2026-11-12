-- Durable ingestion of the Durable Object audit journal into PostgreSQL.
-- Apply only after reviewing the schema and taking a database backup.

CREATE TABLE IF NOT EXISTS paper_sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active','stopped','failed')),
  started_at TIMESTAMPTZ NOT NULL,
  stopped_at TIMESTAMPTZ,
  strategy_version TEXT NOT NULL,
  last_sequence BIGINT NOT NULL DEFAULT 0,
  last_event_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paper_session_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL REFERENCES paper_sessions(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  mint TEXT,
  strategy_version TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, event_id),
  UNIQUE (session_id, sequence)
);
CREATE INDEX IF NOT EXISTS paper_session_events_session_sequence_idx
  ON paper_session_events (session_id, sequence);
CREATE INDEX IF NOT EXISTS paper_session_events_mint_time_idx
  ON paper_session_events (mint, occurred_at DESC);

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS session_id TEXT REFERENCES paper_sessions(id),
  ADD COLUMN IF NOT EXISTS external_position_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS positions_session_external_id_idx
  ON positions (session_id, external_position_id)
  WHERE session_id IS NOT NULL AND external_position_id IS NOT NULL;

ALTER TABLE execution_quotes
  ADD COLUMN IF NOT EXISTS session_id TEXT REFERENCES paper_sessions(id),
  ADD COLUMN IF NOT EXISTS external_quote_id TEXT,
  ADD COLUMN IF NOT EXISTS pump_fee_lamports NUMERIC(30,0),
  ADD COLUMN IF NOT EXISTS venue TEXT,
  ADD COLUMN IF NOT EXISTS pool_address TEXT,
  ADD COLUMN IF NOT EXISTS market_phase TEXT NOT NULL DEFAULT 'bonding_curve';

CREATE UNIQUE INDEX IF NOT EXISTS execution_quotes_session_external_id_idx
  ON execution_quotes (session_id, external_quote_id)
  WHERE session_id IS NOT NULL AND external_quote_id IS NOT NULL;

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS session_id TEXT REFERENCES paper_sessions(id),
  ADD COLUMN IF NOT EXISTS external_trade_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS trades_session_external_id_idx
  ON trades (session_id, external_trade_id)
  WHERE session_id IS NOT NULL AND external_trade_id IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('0004_paper_session_event_ingestion')
ON CONFLICT (version) DO NOTHING;
