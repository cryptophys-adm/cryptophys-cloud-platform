-- ADR-0014 §11, docs/design/EVOLVER.md §3 (2026-11-17): the evolution tables again, with CHECKs that D1 can evaluate.
--
-- Migration 0076 created evolution_intents and evolutions with a CHECK on their ids written as one GLOB of 64
-- characters ('int_' and twelve [0-9a-f] classes). D1 refuses such a pattern on every evaluation ("LIKE or GLOB pattern
-- too complex"), so no row could ever be inserted: the intake failed at every tick from the deploy (19:42 UTC) on.
-- SQLite's own limit is far higher, which is why the tests passed. evolution_updates references evolution_intents.
--
-- Additive only, routine: three new tables with the same columns, the id CHECKs written as length, prefix and a short
-- negated class (every pattern here is at most 13 characters; test EV9 keeps every migration under D1's limit). The
-- three tables of 0076 stay as they are, empty, and are no longer used; removing them is a destructive migration the
-- owner may approve later. evolver_controls (0076) is unaffected and stays in use.

CREATE TABLE IF NOT EXISTS evolution_intents_v2 (
  intent_id TEXT PRIMARY KEY CHECK (length(intent_id) = 16 AND substr(intent_id, 1, 4) = 'int_' AND NOT (substr(intent_id, 5) GLOB '*[^0-9a-f]*')),
  source TEXT NOT NULL CHECK (source IN ('council', 'inventory', 'census', 'probe', 'owner')),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 200),
  origin_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(origin_json)),
  target_repo TEXT NOT NULL CHECK (length(target_repo) BETWEEN 1 AND 200),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  spec TEXT NOT NULL DEFAULT '' CHECK (length(spec) <= 8192),
  evidence_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_refs_json) AND json_type(evidence_refs_json) = 'array'),
  state TEXT NOT NULL CHECK (state IN ('queued', 'waiting_external', 'rejected', 'in_progress', 'proposed', 'merged', 'deployed', 'deployed_unmeasured', 'closed', 'refused', 'unfit', 'reverted')),
  state_reason TEXT,
  evolution_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source, source_ref)
);
CREATE INDEX IF NOT EXISTS idx_evolution_intents_v2_state ON evolution_intents_v2(state, created_at);

CREATE TABLE IF NOT EXISTS evolutions_v2 (
  evolution_id TEXT PRIMARY KEY CHECK (length(evolution_id) = 16 AND substr(evolution_id, 1, 4) = 'evo_' AND NOT (substr(evolution_id, 5) GLOB '*[^0-9a-f]*')),
  intent_id TEXT NOT NULL REFERENCES evolution_intents_v2(intent_id),
  state TEXT NOT NULL CHECK (state IN ('planning', 'writing', 'refused', 'proposed', 'merged', 'deployed', 'deployed_unmeasured', 'closed', 'unfit', 'reverted')),
  branch TEXT,
  base_sha TEXT,
  head_sha TEXT,
  cr_id TEXT,
  merge_sha TEXT,
  deploy_ref TEXT,
  model TEXT NOT NULL,
  ai_calls INTEGER NOT NULL DEFAULT 0 CHECK (ai_calls BETWEEN 0 AND 3),
  changed_lines INTEGER CHECK (changed_lines IS NULL OR changed_lines >= 0),
  files_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(files_json)),
  refusals_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(refusals_json)),
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_evolutions_v2_started ON evolutions_v2(started_at);
CREATE INDEX IF NOT EXISTS idx_evolutions_v2_intent ON evolutions_v2(intent_id);

CREATE TABLE IF NOT EXISTS evolution_updates_v2 (
  update_id TEXT PRIMARY KEY CHECK (substr(update_id, 1, 4) = 'evu_'),
  intent_id TEXT NOT NULL REFERENCES evolution_intents_v2(intent_id),
  origin TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  refs_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(refs_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evolution_updates_v2_origin ON evolution_updates_v2(origin, created_at, update_id);
