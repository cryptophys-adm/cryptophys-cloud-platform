-- HAIC H4, the autonomy dial (ADR-0017 H4 §5; the owner's answers of 2026-11-18).
--
-- Additive only: one new table and one new nullable column.
--   autonomy_dial: the owner's level for a group of consensus actions (control-plane-shared/src/autonomy-dial.ts).
--     No row means the group is at its ceiling, its ADR-0009 class: today's behaviour. The dial only lowers a group
--     and raises it back to that ceiling; source says whether the owner set it or a regression lowered it.
--   consensus_proposals.autonomy_level: the effective level a proposal was tallied under (NULL for proposals tallied
--     before H4). A routine action tallied at owner_click waits in pending_owner; the target Workers then require the
--     owner's approval as for a critical action (consensus-exec.ts).
CREATE TABLE IF NOT EXISTS autonomy_dial (
  group_id TEXT PRIMARY KEY CHECK (group_id IN ('deploys', 'merges', 'recovery', 'registry', 'agents', 'policy', 'protected', 'trading')),
  level TEXT NOT NULL CHECK (level IN ('observe', 'suggest', 'owner_click', 'consensus')),
  source TEXT NOT NULL CHECK (source IN ('owner', 'auto_downgrade')),
  set_by TEXT NOT NULL CHECK (length(set_by) BETWEEN 1 AND 200),
  set_at TEXT NOT NULL,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 500)
);
ALTER TABLE consensus_proposals ADD COLUMN autonomy_level TEXT CHECK (autonomy_level IS NULL OR autonomy_level IN ('observe', 'suggest', 'owner_click', 'consensus'));
