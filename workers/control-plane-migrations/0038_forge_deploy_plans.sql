-- 0038 (ADR-0012 phase 4, shadow): deploy plans. For the same main commit and the same registry
-- inputs (every unit's desired versions, the fingerprint), the Forge computes which deploy units are
-- pending from the Artifacts repository, and the Deployment Orchestrator from the GitHub compare
-- API. Each records its side; whichever records second sets `agrees`. Ten consecutive agreements are
-- the bar before deploys stop depending on GitHub to decide what changed.
CREATE TABLE IF NOT EXISTS forge_deploy_plans (
  main_sha TEXT NOT NULL CHECK (length(main_sha) = 40),
  fingerprint TEXT NOT NULL,
  forge_units TEXT,
  forge_skipped TEXT,
  forge_at TEXT,
  github_units TEXT,
  github_skipped TEXT,
  github_at TEXT,
  agrees INTEGER CHECK (agrees IS NULL OR agrees IN (0, 1)),
  PRIMARY KEY (main_sha, fingerprint)
);
