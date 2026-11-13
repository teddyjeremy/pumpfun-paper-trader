-- Durable archive for independent WebSocket interruption recovery.
-- Kept separate from launch-window backfill jobs because their time bounds differ.
CREATE TABLE IF NOT EXISTS helius_gap_recovery_jobs (
  session_id TEXT NOT NULL REFERENCES paper_sessions(id) ON DELETE RESTRICT,
  mint TEXT NOT NULL,
  bonding_curve TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  start_signature TEXT NOT NULL,
  start_slot BIGINT NOT NULL CHECK (start_slot >= 0),
  end_signature TEXT NOT NULL,
  end_slot BIGINT NOT NULL CHECK (end_slot >= 0),
  pages_scanned INTEGER NOT NULL DEFAULT 0 CHECK (pages_scanned >= 0),
  signature_state JSONB NOT NULL DEFAULT '[]'::jsonb,
  decode_cursor INTEGER NOT NULL DEFAULT 0 CHECK (decode_cursor >= 0),
  verified_signature_state JSONB NOT NULL DEFAULT '[]'::jsonb,
  failed_signature_state JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('SCANNING','SCANNED','DECODING','DECODED','ARCHIVED','INCOMPLETE')),
  archived_complete BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id,mint,started_at),
  CHECK (ended_at >= started_at),
  CHECK (start_signature <> end_signature),
  CHECK (decode_cursor <= jsonb_array_length(signature_state)),
  CHECK (jsonb_typeof(signature_state) = 'array'),
  CHECK (jsonb_typeof(verified_signature_state) = 'array'),
  CHECK (jsonb_typeof(failed_signature_state) = 'array')
);
CREATE INDEX IF NOT EXISTS helius_gap_recovery_jobs_session_status_idx
  ON helius_gap_recovery_jobs(session_id,status,updated_at DESC);

ALTER TABLE helius_transaction_observations
  DROP CONSTRAINT IF EXISTS helius_transaction_observations_observation_source_check;
ALTER TABLE helius_transaction_observations
  ADD CONSTRAINT helius_transaction_observations_observation_source_check
  CHECK (observation_source IN ('HISTORICAL_BACKFILL','LIVE_MONITOR','GAP_RECOVERY'));

INSERT INTO schema_migrations(version) VALUES ('0009_helius_gap_recovery_archive')
ON CONFLICT (version) DO NOTHING;
