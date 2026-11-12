-- 0051 (ADR-0012 G4, §5j): change requests pushed to the Forge's work repository cryptophys/platform-work.
-- Contributors push branches (cr/…, claude/…, agent/…) there instead of opening GitHub pull requests; the
-- Forge discovers each branch and registers it as change request fg-<branch slug> with source 'forge'.
-- The table is rebuilt because SQLite cannot change a CHECK constraint in place:
--   - source admits 'forge' next to 'github';
--   - repo: the Artifacts repository the head is read from ('platform' for GitHub-sourced requests, whose
--     heads are pushed to cr/<number> of platform; 'platform-work' for forge-sourced ones);
--   - blocked_reason: set when the Forge refuses to check a head (not_based_on_main: the head does not
--     contain canonical main, so a later merge could not be a fast-forward). NULL otherwise.
-- Every existing row is kept as it is, with repo 'platform' and no blocked reason.
CREATE TABLE forge_change_requests_new (
  cr_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('github', 'forge')),
  number INTEGER NOT NULL,
  branch TEXT NOT NULL,
  source_branch TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  head_sha TEXT NOT NULL CHECK (length(head_sha) = 40),
  base_sha TEXT NOT NULL CHECK (length(base_sha) = 40),
  github_ci TEXT CHECK (github_ci IS NULL OR github_ci IN ('success', 'failure')),
  status TEXT NOT NULL CHECK (status IN ('open', 'merged', 'closed')),
  changed_paths TEXT,
  critical TEXT,
  verdict_at_outcome TEXT CHECK (verdict_at_outcome IS NULL OR verdict_at_outcome IN ('would_merge', 'needs_owner', 'blocked', 'pending')),
  merge_sha TEXT,
  agrees INTEGER CHECK (agrees IS NULL OR agrees IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  outcome_at TEXT,
  repo TEXT NOT NULL DEFAULT 'platform' CHECK (repo IN ('platform', 'platform-work')),
  blocked_reason TEXT CHECK (blocked_reason IS NULL OR blocked_reason IN ('not_based_on_main')),
  CHECK (source = 'forge' OR (repo = 'platform' AND blocked_reason IS NULL)),
  CHECK (source = 'github' OR (repo = 'platform-work' AND github_ci IS NULL))
);

INSERT INTO forge_change_requests_new
  (cr_id, source, number, branch, source_branch, title, author, head_sha, base_sha, github_ci, status, changed_paths, critical,
   verdict_at_outcome, merge_sha, agrees, created_at, updated_at, outcome_at, repo, blocked_reason)
SELECT cr_id, source, number, branch, source_branch, title, author, head_sha, base_sha, github_ci, status, changed_paths, critical,
   verdict_at_outcome, merge_sha, agrees, created_at, updated_at, outcome_at, 'platform', NULL
FROM forge_change_requests;

DROP TABLE forge_change_requests;
ALTER TABLE forge_change_requests_new RENAME TO forge_change_requests;
CREATE INDEX IF NOT EXISTS idx_forge_change_requests_status ON forge_change_requests(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_forge_change_requests_head ON forge_change_requests(head_sha);
CREATE INDEX IF NOT EXISTS idx_forge_change_requests_source ON forge_change_requests(source, status);
