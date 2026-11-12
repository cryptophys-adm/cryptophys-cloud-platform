-- 0049 (owner 2026-11-12, "apakah pembatasan sudah sesuai batas free tier build cloudflare?" → "ya kerjakan
-- opsi 2"): the Workers Builds minutes this account uses, measured. Once an hour the Forge lists the builds of
-- every Worker on the account through the Workers Builds API (read only, its own CF_BUILDS_API_TOKEN) and keeps
-- one row per finished build with its measured duration. The Console and the owner notices read the month's
-- total against the free-tier allowance (3,000 build minutes a month). Nothing here is estimated: a build
-- without a start or stop time is kept with a NULL duration and shown as unmeasured.
CREATE TABLE IF NOT EXISTS forge_builds (
  build_uuid TEXT PRIMARY KEY,
  worker TEXT NOT NULL,
  preview_id TEXT,
  branch TEXT,
  commit_sha TEXT,
  status TEXT,
  outcome TEXT,
  created_on TEXT,
  started_on TEXT,
  stopped_on TEXT,
  duration_s INTEGER CHECK (duration_s IS NULL OR duration_s >= 0),
  billed_minutes INTEGER CHECK (billed_minutes IS NULL OR billed_minutes >= 0),
  queued_s INTEGER CHECK (queued_s IS NULL OR queued_s >= 0),
  seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forge_builds_stopped ON forge_builds(stopped_on);
CREATE INDEX IF NOT EXISTS idx_forge_builds_worker ON forge_builds(worker, stopped_on);

-- One row per collection, so a page can tell a quiet month from a collector that stopped.
CREATE TABLE IF NOT EXISTS forge_build_collections (
  collected_at TEXT PRIMARY KEY,
  outcome TEXT NOT NULL CHECK (outcome IN ('collected', 'partial', 'failed')),
  workers INTEGER NOT NULL DEFAULT 0,
  builds_seen INTEGER NOT NULL DEFAULT 0,
  builds_new INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
