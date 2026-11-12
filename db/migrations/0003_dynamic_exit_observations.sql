-- Migration is a market transition, never an automatic close.
ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS market_phase TEXT NOT NULL DEFAULT 'bonding_curve',
  ADD COLUMN IF NOT EXISTS market_venue TEXT,
  ADD COLUMN IF NOT EXISTS migrated_pool_address TEXT,
  ADD COLUMN IF NOT EXISTS migration_detected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS migration_slot BIGINT,
  ADD COLUMN IF NOT EXISTS last_verified_market_quote_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS exit_blocked_reason TEXT,
  ADD COLUMN IF NOT EXISTS highest_net_return_pct NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS active_stop_net_return_pct NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS last_exit_evaluated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dynamic_exit_evidence JSONB NOT NULL DEFAULT '{}'::jsonb;
UPDATE positions SET market_phase='closed' WHERE status='closed';
UPDATE positions SET market_phase='exit_blocked' WHERE status='exit_unexecutable';
ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_market_phase_check;
ALTER TABLE positions ADD CONSTRAINT positions_market_phase_check CHECK (market_phase IN ('bonding_curve','migration_pending','migrated_market','exit_blocked','closed'));
ALTER TABLE execution_quotes ADD COLUMN IF NOT EXISTS market_phase TEXT NOT NULL DEFAULT 'bonding_curve', ADD COLUMN IF NOT EXISTS venue TEXT, ADD COLUMN IF NOT EXISTS pool_address TEXT;
ALTER TABLE market_windows ADD COLUMN IF NOT EXISTS market_phase TEXT NOT NULL DEFAULT 'bonding_curve', ADD COLUMN IF NOT EXISTS venue TEXT, ADD COLUMN IF NOT EXISTS pool_address TEXT;
ALTER TABLE market_windows DROP CONSTRAINT IF EXISTS market_windows_window_seconds_check;
ALTER TABLE market_windows ADD CONSTRAINT market_windows_window_seconds_check CHECK (window_seconds IN (1,2,3,5,10,15,30,60));
ALTER TABLE market_windows DROP CONSTRAINT IF EXISTS market_windows_mint_window_seconds_window_ended_at_key;
CREATE UNIQUE INDEX IF NOT EXISTS market_windows_market_venue_window_idx ON market_windows (mint,market_phase,venue,window_seconds,window_ended_at);
CREATE TABLE IF NOT EXISTS position_exit_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), position_id UUID NOT NULL REFERENCES positions(id),
  mint TEXT NOT NULL REFERENCES tokens(mint), evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_slot BIGINT, market_phase TEXT NOT NULL CHECK (market_phase IN ('bonding_curve','migration_pending','migrated_market','exit_blocked')),
  venue TEXT, current_net_return_pct NUMERIC(12,6), highest_net_return_pct NUMERIC(12,6),
  active_stop_net_return_pct NUMERIC(12,6), buy_sell_ratio NUMERIC(20,8),
  buy_volume_decline_pct NUMERIC(12,6), buyer_rate_decline_pct NUMERIC(12,6),
  sell_volume_expansion_pct NUMERIC(12,6), price_response_decline_pct NUMERIC(12,6),
  liquidity_change_pct NUMERIC(12,6), large_holder_distribution_detected BOOLEAN,
  bearish_signal_count INTEGER NOT NULL DEFAULT 0,
  decision TEXT NOT NULL CHECK (decision IN ('hold','sell','exit_blocked')),
  exit_reason TEXT, sell_quote_id UUID REFERENCES execution_quotes(id), evidence JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS position_exit_evaluations_position_time_idx ON position_exit_evaluations(position_id,evaluated_at DESC);
CREATE INDEX IF NOT EXISTS position_exit_evaluations_mint_time_idx ON position_exit_evaluations(mint,evaluated_at DESC);
CREATE INDEX IF NOT EXISTS positions_market_phase_status_idx ON positions(market_phase,status);
INSERT INTO schema_migrations(version) VALUES ('0003_dynamic_exit_observations') ON CONFLICT(version) DO NOTHING;
