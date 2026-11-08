-- 0035 (ADR-0012 §5c, owner decision 2026-11-08): the type-check runs on Workers Builds from the
-- Artifacts repository (workers/forge-typecheck). Each build reports its result for the commit it
-- checked; the Forge check of that commit takes it as its typecheck step. One row per commit; a
-- re-run replaces it. Diagnostics are text only (file, line, code and message), never file content.
CREATE TABLE IF NOT EXISTS forge_typecheck_reports (
  commit_sha TEXT PRIMARY KEY CHECK (length(commit_sha) = 40),
  conclusion TEXT NOT NULL CHECK (conclusion IN ('success', 'failure')),
  build_id TEXT NOT NULL,
  branch TEXT,
  files INTEGER,
  errors INTEGER NOT NULL DEFAULT 0,
  diagnostics TEXT,
  toolchain TEXT,
  reported_at TEXT NOT NULL
);
