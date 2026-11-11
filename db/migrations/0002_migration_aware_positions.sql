-- Migration-aware positions, dynamic-exit telemetry, and worker fencing.
-- Safe to apply after 0001_initial_ledger; preserves existing paper records.

ALTER TABLE positions
  DROP CONSTRAINT IF EXISTS positions_status_check;

ALTER TABLE positions
  ADD CONSTRAINT positions_status_check
  CHECK (status IN (
    'buy_pending',
    'open',
    'sell_pending',
    'closed',
    'exit_unexecutable',
    'migration_pending',
    'open_migrated',
    'exit_blocked'
  ));

DROP INDEX IF EXISTS positions_one_active_per_mint_idx;
CREATE UNIQUE INDEX positions_one_active_per_mint_idx
  ON positions (mint)
  WHERE status IN (
    'buy_pending',
    'open',
    'sell_pending',
    'exit_unexecutable',
    'migration_pending',
    'open_migrated',
    'exit_blocked'
  );

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS market_state TEXT NOT NULL DEFAULT 'bonding_curve'
    CHECK (market_state IN ('bonding_curve','migration_pending','migrated_pool','exit_blocked')),
  ADD COLUMN IF NOT EXISTS migrated_pool_address TEXT,
  ADD COLUMN IF NOT EXISTS migrated_pool_program TEXT,
  ADD COLUMN IF NOT EXISTS last_verified_market_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_exit_signal_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trailing_high_water_price NUMERIC(30,18),
  ADD COLUMN IF NOT EXISTS active_stop_price NUMERIC(30,18),
  ADD COLUMN IF NOT EXISTS exit_signal_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS position_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id UUID NOT NULL REFERENCES positions(id),
  mint TEXT NOT NULL REFERENCES tokens(mint),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'opened','market_migration_detected','migrated_pool_verified',
    'market_data_stale','exit_signal_observed','exit_signal_confirmed',
    'exit_quote_blocked','exit_submitted','closed','invariant_violation'
  )),
  previous_market_state TEXT,
  market_state TEXT,
  slot BIGINT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS position_events_position_time_idx
  ON position_events (position_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS position_events_mint_time_idx
  ON position_events (mint, occurred_at DESC);

-- A single database-backed lease fences accidental duplicate workers.
CREATE TABLE IF NOT EXISTS worker_leases (
  lease_name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS worker_leases_expiry_idx ON worker_leases (expires_at);

-- Entry/exit command idempotency survives process restarts and retries.
CREATE TABLE IF NOT EXISTS execution_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('paper_buy','paper_sell','position_transition')),
  mint TEXT NOT NULL REFERENCES tokens(mint),
  position_id UUID REFERENCES positions(id),
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES ('0002_migration_aware_positions')
ON CONFLICT (version) DO NOTHING;
