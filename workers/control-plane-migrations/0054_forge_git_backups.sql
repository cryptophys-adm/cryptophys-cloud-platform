-- 0054 (ADR-0012 gate 8, §5m): the off-Artifacts copy of the canonical repository. At most once per UTC day per
-- head of main (an hour after a failed run), the Forge fetches cryptophys/platform over Git smart HTTP
-- (upload-pack, a full clone of every refs/heads/*), wraps the packfile as a git bundle v2 and writes it to the
-- R2 bucket cryptophys-forge-bundles under git-backups/platform/<UTC date>-<main sha>.bundle. Each run is one
-- row: the bundle's SHA-256, size, refs and object count, or the error. R2 keeps the newest bundle of each of
-- the last 30 days that have one; `pruned_at` marks a row whose object retention deleted. Rows are kept 90 days,
-- except a row whose bundle is still retained. Additive only.
CREATE TABLE IF NOT EXISTS forge_git_backups (
  run_id TEXT PRIMARY KEY,
  main_sha TEXT NOT NULL,
  day TEXT NOT NULL,
  ran_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  r2_key TEXT,
  bundle_sha256 TEXT,
  bundle_bytes INTEGER,
  pack_bytes INTEGER,
  pack_sha1 TEXT,
  pack_version INTEGER,
  objects INTEGER,
  refs INTEGER,
  refs_json TEXT,
  error TEXT,
  pruned_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_forge_git_backups_ran ON forge_git_backups(ran_at);
CREATE INDEX IF NOT EXISTS idx_forge_git_backups_head ON forge_git_backups(main_sha, day, ran_at);
