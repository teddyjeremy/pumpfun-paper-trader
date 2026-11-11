-- Migration-aware position lifecycle. Graduation changes the venue, not the position's open/closed state.

ALTER TABLE tokens
  ADD COLUMN IF NOT EXISTS pumpswap_pool_address TEXT,
  ADD COLUMN IF NOT EXISTS migration_signature TEXT,
  ADD COLUMN IF NOT EXISTS migration_observed_at TIMESTAMPTZ;

ALTER TABLE positions
  DROP CONSTRAINT IF EXISTS positions_status_check;

ALTER TABLE positions
  ADD CONSTRAINT positions_status_check
  CHECK (status IN (
    'buy_pending',
    'open',
    'migration_pending',
    'open_migrated',
    'sell_pending',
    'exit_blocked',
    'closed',
    'exit_unexecutable'
  ));

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS active_venue TEXT NOT NULL DEFAULT 'bonding_curve'
    CHECK (active_venue IN ('bonding_curve','pumpswap','unknown')),
  ADD COLUMN IF NOT EXISTS migrated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pool_address TEXT,
  ADD COLUMN IF NOT EXISTS peak_price_sol NUMERIC(30,18),
  ADD COLUMN IF NOT EXISTS active_stop_price_sol NUMERIC(30,18),
  ADD COLUMN IF NOT EXISTS last_exit_signal TEXT;

DROP INDEX IF EXISTS positions_one_active_per_mint_idx;
CREATE UNIQUE INDEX positions_one_active_per_mint_idx
  ON positions (mint)
  WHERE status IN (
    'buy_pending','open','migration_pending','open_migrated',
    'sell_pending','exit_blocked','exit_unexecutable'
  );

CREATE TABLE IF NOT EXISTS position_exit_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id UUID NOT NULL REFERENCES positions(id),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  venue TEXT NOT NULL CHECK (venue IN ('bonding_curve','pumpswap','unknown')),
  current_price_sol NUMERIC(30,18),
  peak_price_sol NUMERIC(30,18),
  active_stop_price_sol NUMERIC(30,18),
  buy_volume_lamports NUMERIC(30,0),
  sell_volume_lamports NUMERIC(30,0),
  unique_buyers INTEGER,
  unique_sellers INTEGER,
  buy_volume_decline_fraction NUMERIC(12,8),
  exit_signal TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('hold','switch_venue','wait_for_pool','sell_signal','exit_blocked')),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS position_exit_observations_position_time_idx
  ON position_exit_observations (position_id, observed_at DESC);

INSERT INTO schema_migrations (version) VALUES ('0002_migration_aware_positions')
ON CONFLICT (version) DO NOTHING;
