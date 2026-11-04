-- Every Signal Engine ingestion pass is recorded, including per-series failures, so a market
-- data source that is unreachable from Cloudflare is visible in D1 and /v1/status instead of
-- only in transient Worker logs.
CREATE TABLE signal_ingest_runs (
  run_id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  series_total INTEGER NOT NULL CHECK (series_total >= 0),
  series_failed INTEGER NOT NULL CHECK (series_failed >= 0 AND series_failed <= series_total),
  results_json TEXT NOT NULL CHECK (json_valid(results_json))
);
CREATE INDEX signal_ingest_runs_started ON signal_ingest_runs (started_at);
