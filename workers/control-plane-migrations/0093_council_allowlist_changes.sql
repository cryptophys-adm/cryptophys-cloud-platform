-- 0093 (CB2b, 2026-11-28; owner "sementara B dulu", the coordinator's design: "The Supervisor records the proposal from a
-- Forge-written pending row, the same as merge_change"): a change of the council repository's policy/allowlist.json,
-- mirrored from xauusd's organism.json council_owned_keys, waiting for the owner's click (consensus action
-- merge_council_allowlist, critical). ADR-0014 §13.
--
-- Additive only: one new table and its index. The Forge writes a row when xauusd's block differs from council main's
-- allowlist (the new file on branch allowlist/<head12> of `council`); the Supervisor proposes it; the Forge's executor
-- fast-forwards council main from base_sha to head_sha only while main is still base_sha.
--   summary_json: the keys with their type and bounds (min, max, the size of an enum), added, changed or removed; never
--     a value from free text.
CREATE TABLE IF NOT EXISTS council_allowlist_changes (
  change_id TEXT PRIMARY KEY CHECK (length(change_id) = 16 AND substr(change_id, 1, 4) = 'cal-' AND NOT (substr(change_id, 5) GLOB '*[^0-9a-f]*')),
  base_sha TEXT NOT NULL CHECK (length(base_sha) = 40),
  head_sha TEXT NOT NULL CHECK (length(head_sha) = 40),
  branch TEXT NOT NULL CHECK (length(branch) BETWEEN 1 AND 80),
  summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(summary_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'merged', 'superseded', 'refused')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_council_allowlist_changes_status ON council_allowlist_changes(status, created_at);
