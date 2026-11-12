-- 0051 (ADR-0012 G5): the replacement for GitHub's Dependabot alerts. Once a day per head of main, the Forge
-- reads every package-lock.json of the commit from the Artifacts repository and asks the npm registry's bulk
-- advisory endpoint (the one `npm audit` uses) which of the installed versions are affected. Only package names
-- and versions are sent. Each run is one row; each affected package version and advisory is one finding.
-- `runtime` is 1 when a lockfile that holds the package belongs to a Worker (a workers/<dir> with a
-- wrangler.toml, the Console UI build included) and 0 for tooling (tests, scripts). Kept 90 days.
CREATE TABLE IF NOT EXISTS forge_dependency_audits (
  run_id TEXT PRIMARY KEY,
  main_sha TEXT NOT NULL,
  ran_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  lockfiles INTEGER NOT NULL DEFAULT 0,
  packages INTEGER NOT NULL DEFAULT 0,
  advisories INTEGER NOT NULL DEFAULT 0,
  critical INTEGER NOT NULL DEFAULT 0,
  high INTEGER NOT NULL DEFAULT 0,
  moderate INTEGER NOT NULL DEFAULT 0,
  low INTEGER NOT NULL DEFAULT 0,
  info INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_forge_dependency_audits_ran ON forge_dependency_audits(ran_at);
CREATE INDEX IF NOT EXISTS idx_forge_dependency_audits_head ON forge_dependency_audits(main_sha, ran_at);

CREATE TABLE IF NOT EXISTS forge_dependency_findings (
  run_id TEXT NOT NULL,
  package TEXT NOT NULL,
  version TEXT NOT NULL,
  advisory_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'moderate', 'low', 'info')),
  title TEXT,
  url TEXT,
  vulnerable_versions TEXT,
  lockfiles TEXT NOT NULL DEFAULT '[]',
  runtime INTEGER NOT NULL DEFAULT 0 CHECK (runtime IN (0, 1)),
  PRIMARY KEY (run_id, package, version, advisory_id)
);
CREATE INDEX IF NOT EXISTS idx_forge_dependency_findings_severity ON forge_dependency_findings(run_id, severity);
