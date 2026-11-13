-- Persist the exact historical scan interval and pagination boundary.
-- A decoded-complete flag is valid only for the exact signature window it certified.

ALTER TABLE helius_backfill_jobs
  ADD COLUMN IF NOT EXISTS scan_provider TEXT NOT NULL DEFAULT 'helius'
    CHECK (scan_provider = 'helius'),
  ADD COLUMN IF NOT EXISTS scan_commitment TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (scan_commitment = 'confirmed'),
  ADD COLUMN IF NOT EXISTS window_end_block_time BIGINT
    CHECK (window_end_block_time IS NULL OR window_end_block_time >= 0),
  ADD COLUMN IF NOT EXISTS last_page_slot BIGINT
    CHECK (last_page_slot IS NULL OR last_page_slot >= 0),
  ADD COLUMN IF NOT EXISTS last_page_block_time BIGINT
    CHECK (last_page_block_time IS NULL OR last_page_block_time >= 0);

UPDATE helius_backfill_jobs
SET window_end_block_time = launch_block_time + horizon_seconds
WHERE launch_block_time IS NOT NULL AND window_end_block_time IS NULL;

INSERT INTO schema_migrations(version) VALUES ('0008_helius_scan_provenance')
ON CONFLICT (version) DO NOTHING;
