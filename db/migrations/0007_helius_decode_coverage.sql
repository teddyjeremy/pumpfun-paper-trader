-- Persist transaction-decoding completeness separately from address-history coverage.
ALTER TABLE helius_backfill_jobs
  ADD COLUMN IF NOT EXISTS decoded_complete BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS decoded_reason TEXT,
  ADD COLUMN IF NOT EXISTS verified_transaction_count INTEGER NOT NULL DEFAULT 0
    CHECK (verified_transaction_count >= 0),
  ADD COLUMN IF NOT EXISTS decoded_at TIMESTAMPTZ;

INSERT INTO schema_migrations(version) VALUES ('0007_helius_decode_coverage')
ON CONFLICT (version) DO NOTHING;
