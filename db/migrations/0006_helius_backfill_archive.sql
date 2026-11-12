-- Persistent historical backfill checkpoints and verified transaction observations.
-- Durable Object storage remains the execution queue; PostgreSQL is the queryable archive.

CREATE TABLE IF NOT EXISTS helius_backfill_jobs (
  session_id TEXT NOT NULL REFERENCES paper_sessions(id) ON DELETE RESTRICT,
  mint TEXT NOT NULL,
  bonding_curve TEXT NOT NULL,
  create_signature TEXT NOT NULL,
  launch_block_time BIGINT CHECK (launch_block_time IS NULL OR launch_block_time >= 0),
  horizon_seconds INTEGER NOT NULL CHECK (horizon_seconds BETWEEN 60 AND 1800),
  max_signatures INTEGER NOT NULL CHECK (max_signatures BETWEEN 1 AND 500),
  pages_scanned INTEGER NOT NULL DEFAULT 0 CHECK (pages_scanned >= 0),
  scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
  before_signature TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','PAGING','READY_TO_FETCH','COMPLETE','INCOMPLETE')),
  reason TEXT,
  signature_count INTEGER NOT NULL DEFAULT 0 CHECK (signature_count >= 0),
  signature_state JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, mint),
  CHECK (status = 'INCOMPLETE' OR launch_block_time IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS helius_backfill_jobs_session_status_idx
  ON helius_backfill_jobs(session_id,status,updated_at DESC);

CREATE TABLE IF NOT EXISTS helius_transaction_observations (
  session_id TEXT NOT NULL REFERENCES paper_sessions(id) ON DELETE RESTRICT,
  mint TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot BIGINT NOT NULL CHECK (slot >= 0),
  provider TEXT NOT NULL CHECK (provider = 'helius'),
  commitment TEXT NOT NULL CHECK (commitment IN ('confirmed','finalized')),
  observation_source TEXT NOT NULL CHECK (observation_source IN ('HISTORICAL_BACKFILL','LIVE_MONITOR')),
  received_at TIMESTAMPTZ NOT NULL,
  create_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  trade_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_observation JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id,mint,signature)
);
CREATE INDEX IF NOT EXISTS helius_transaction_observations_mint_slot_idx
  ON helius_transaction_observations(mint,slot ASC);

INSERT INTO schema_migrations(version) VALUES ('0006_helius_backfill_archive')
ON CONFLICT (version) DO NOTHING;
