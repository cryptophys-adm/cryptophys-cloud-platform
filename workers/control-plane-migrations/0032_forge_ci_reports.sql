-- 0032 (ADR-0012 phase 3): the GitHub CI conclusion for each commit of main, reported by
-- forge-ci-report.yml while GitHub is still the source of truth. GET /v1/forge/checks compares it
-- with the Forge check of the same commit; 20 consecutive agreements are the bar for phase 4.
CREATE TABLE IF NOT EXISTS forge_ci_reports (
  commit_sha TEXT PRIMARY KEY CHECK (length(commit_sha) = 40),
  conclusion TEXT NOT NULL CHECK (conclusion IN ('success', 'failure')),
  workflow_run_id TEXT NOT NULL,
  reported_at TEXT NOT NULL
);
