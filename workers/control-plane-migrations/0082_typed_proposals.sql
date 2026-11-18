-- HAIC H2, typed proposals (ADR-0017 H2; docs/design/HAIC-H0-H1.md §4.4, §5; owner answers of 2026-11-18).
--
-- Additive only: one new table. A typed_proposal.v1 is a directive turned into a typed change: a council's pick (and,
-- with H2b, an owner's chat directive) makes a draft; only the owner confirms or rejects it; a confirmed one goes its
-- kind's way (consensus, the evolver, the orchestrator, xauusd) and records where. body_json is the validated proposal
-- (control-plane-shared/src/typed-proposal.ts): never a price.
CREATE TABLE IF NOT EXISTS typed_proposals (
  proposal_id TEXT PRIMARY KEY CHECK (length(proposal_id) = 19 AND substr(proposal_id, 1, 3) = 'tp_' AND NOT (substr(proposal_id, 4) GLOB '*[^0-9a-f]*')),
  kind TEXT NOT NULL CHECK (kind IN ('policy_parameter', 'repository_task', 'vision_kpi', 'shadow_arm')),
  state TEXT NOT NULL CHECK (state IN ('draft', 'confirmed', 'rejected', 'handoff_pending', 'handed_off', 'failed', 'expired')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  origin_source TEXT NOT NULL CHECK (origin_source IN ('council', 'chat')),
  origin_ref TEXT NOT NULL CHECK (length(origin_ref) BETWEEN 1 AND 200),
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  handoff_path TEXT CHECK (handoff_path IS NULL OR handoff_path IN ('consensus', 'evolver', 'orchestrator', 'xauusd')),
  handoff_ref TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_typed_proposals_state ON typed_proposals(state, created_at);
