-- 0037 (ADR-0012 phase 4, shadow): change requests. While GitHub is still the source of truth, every
-- same-repository pull request is mirrored to the Forge as change request gh-<number>: its head is
-- pushed to the Artifacts branch cr/<number>, the Forge checks that head like a commit of main, and
-- computes the merge verdict it would give (would_merge / needs_owner / blocked / pending). When
-- GitHub merges or closes the pull request, the verdict at that moment is frozen next to the GitHub
-- outcome, so the two paths can be compared before the Forge merges by itself.
CREATE TABLE IF NOT EXISTS forge_change_requests (
  cr_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('github')),
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
  outcome_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_forge_change_requests_status ON forge_change_requests(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_forge_change_requests_head ON forge_change_requests(head_sha);
