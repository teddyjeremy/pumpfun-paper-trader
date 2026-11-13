CREATE TABLE IF NOT EXISTS historical_backtest_runs (
  date TEXT PRIMARY KEY CHECK (date ~ '^\\d{4}-\\d{2}-\\d{2}$'),
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','SAMPLE_COMPLETE','INCOMPLETE','BUDGET_EXHAUSTED','UNKNOWN')),
  discovery_status TEXT,
  screening_status TEXT,
  discovered_count INTEGER NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  screened_count INTEGER NOT NULL DEFAULT 0 CHECK (screened_count >= 0),
  selected_count INTEGER NOT NULL DEFAULT 0 CHECK (selected_count >= 0),
  replayed_count INTEGER NOT NULL DEFAULT 0 CHECK (replayed_count >= 0),
  complete_count INTEGER NOT NULL DEFAULT 0 CHECK (complete_count >= 0),
  incomplete_count INTEGER NOT NULL DEFAULT 0 CHECK (incomplete_count >= 0),
  qualified_count INTEGER NOT NULL DEFAULT 0 CHECK (qualified_count >= 0),
  rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  credits_used INTEGER NOT NULL DEFAULT 0 CHECK (credits_used >= 0),
  artifact_run_id TEXT,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS historical_backtest_candidates (
  date TEXT NOT NULL REFERENCES historical_backtest_runs(date) ON DELETE CASCADE,
  discovery_index INTEGER NOT NULL CHECK (discovery_index >= 0),
  mint TEXT NOT NULL,
  screen_status TEXT,
  activity_score DOUBLE PRECISION,
  selected BOOLEAN NOT NULL DEFAULT FALSE,
  replay_status TEXT NOT NULL DEFAULT 'NOT_SELECTED'
    CHECK (replay_status IN ('NOT_SELECTED','PENDING','COMPLETE','INCOMPLETE','QUALIFIED','REJECTED')),
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (date, discovery_index),
  UNIQUE (date, mint)
);

CREATE INDEX IF NOT EXISTS historical_backtest_candidates_date_selected_idx
  ON historical_backtest_candidates(date, selected, discovery_index);
