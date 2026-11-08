-- 0031 (ADR-0012 phase 3): Forge checks. One row per commit of main that the Forge ran the
-- control-plane test suite against (workers/forge/src/checks.ts). Informational until the Forge
-- and GitHub CI agree on 20 consecutive commits.
CREATE TABLE IF NOT EXISTS forge_check_runs (
  commit_sha TEXT PRIMARY KEY CHECK (length(commit_sha) = 40),
  status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'error')),
  runner TEXT NOT NULL,
  files INTEGER,
  pass INTEGER,
  fail INTEGER,
  skip INTEGER,
  failures TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_forge_check_runs_started ON forge_check_runs (started_at DESC);
