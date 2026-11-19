-- 0063 (owner 2026-11-14, "setuju"; "gak perlu shadow, langsung production"): the account-wide Observer
-- (control-plane-shared/src/observer.ts). Additive: three new tables and their indexes, nothing else.
-- Retention is done in code (observer.ts sweepObserver): vitals and runs 30 days, findings 90 days.

-- One compact row per Worker (or D1 database, KV namespace, Durable Object namespace, Workers AI model) and UTC hour,
-- as the GraphQL Analytics API measured it. NULL is "not measured", never zero.
CREATE TABLE IF NOT EXISTS observer_vitals (
  subject TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('worker', 'd1', 'kv', 'do', 'ai')),
  hour TEXT NOT NULL,
  requests INTEGER CHECK (requests IS NULL OR requests >= 0),
  errors INTEGER CHECK (errors IS NULL OR errors >= 0),
  rows_read INTEGER CHECK (rows_read IS NULL OR rows_read >= 0),
  rows_written INTEGER CHECK (rows_written IS NULL OR rows_written >= 0),
  neurons REAL CHECK (neurons IS NULL OR neurons >= 0),
  cpu_p50_ms REAL,
  cpu_p99_ms REAL,
  wall_p50_ms REAL,
  wall_p99_ms REAL,
  exceeded_cpu INTEGER CHECK (exceeded_cpu IS NULL OR exceeded_cpu >= 0),
  exceeded_memory INTEGER CHECK (exceeded_memory IS NULL OR exceeded_memory >= 0),
  exceptions INTEGER CHECK (exceptions IS NULL OR exceptions >= 0),
  sample_json TEXT NOT NULL DEFAULT '{}',
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (subject, hour)
);
CREATE INDEX IF NOT EXISTS idx_observer_vitals_hour ON observer_vitals(hour);

-- Anomalies, early warnings, inventory differences and missing capabilities only; one per worker, metric and bucket
-- (the hour for an anomaly, the UTC day for an inventory or capability finding).
CREATE TABLE IF NOT EXISTS observer_findings (
  finding_id TEXT PRIMARY KEY,
  worker TEXT NOT NULL,
  metric TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('anomaly', 'early_warning', 'inventory', 'capability')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning')),
  bucket TEXT NOT NULL,
  value REAL,
  baseline_7d REAL,
  z REAL,
  since_deploy_json TEXT,
  sample_json TEXT NOT NULL DEFAULT '{}',
  detail TEXT NOT NULL,
  report_only INTEGER NOT NULL DEFAULT 0 CHECK (report_only IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (worker, metric, bucket)
);
CREATE INDEX IF NOT EXISTS idx_observer_findings_created ON observer_findings(created_at);
CREATE INDEX IF NOT EXISTS idx_observer_findings_kind_created ON observer_findings(kind, created_at);

-- One row per sensing hour and per changed inventory (an unchanged inventory is written again every 6 h at most).
CREATE TABLE IF NOT EXISTS observer_runs (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('senses', 'inventory')),
  bucket TEXT NOT NULL,
  ran_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'unavailable')),
  datasets_json TEXT NOT NULL DEFAULT '{}',
  findings_json TEXT NOT NULL DEFAULT '[]',
  digest TEXT,
  UNIQUE (kind, bucket)
);
CREATE INDEX IF NOT EXISTS idx_observer_runs_kind_ran ON observer_runs(kind, ran_at);
