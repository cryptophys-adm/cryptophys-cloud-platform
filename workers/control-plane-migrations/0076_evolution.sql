-- ADR-0014 §11 (owner 2026-11-17: "aktifkan evolver sekarang termasuk jalur balik"), docs/design/EVOLVER.md §3 and
-- step V2: the evolution intents, the attempts, the return path's state updates and the owner's kill switch for the
-- evolver. Additive only: four new tables, their indexes, and the switch's one row.

-- One row per need, whatever its source. (source, source_ref) is unique, so a need is recorded once: a council task by
-- its proposal_id, an inventory finding by its subject.
CREATE TABLE IF NOT EXISTS evolution_intents (
  intent_id TEXT PRIMARY KEY CHECK (intent_id GLOB 'int_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
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
CREATE INDEX IF NOT EXISTS idx_evolution_intents_state ON evolution_intents(state, created_at);

-- One row per attempt on an intent (the evolver, step V5).
CREATE TABLE IF NOT EXISTS evolutions (
  evolution_id TEXT PRIMARY KEY CHECK (evolution_id GLOB 'evo_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  intent_id TEXT NOT NULL REFERENCES evolution_intents(intent_id),
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
CREATE INDEX IF NOT EXISTS idx_evolutions_started ON evolutions(started_at);
CREATE INDEX IF NOT EXISTS idx_evolutions_intent ON evolutions(intent_id);

-- The return path (council.decisions.read, step V3): one append-only row per state change of a council intent, read by
-- the origin that handed the proposal off, oldest first, by (created_at, update_id).
CREATE TABLE IF NOT EXISTS evolution_updates (
  update_id TEXT PRIMARY KEY CHECK (update_id GLOB 'evu_*'),
  intent_id TEXT NOT NULL REFERENCES evolution_intents(intent_id),
  origin TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  refs_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(refs_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evolution_updates_origin ON evolution_updates(origin, created_at, update_id);

-- The evolver's own kill switch, which only the owner sets (POST /v1/evolution/mode). On by the owner's decision of
-- 2026-11-17; the platform kill switch and consensus mode shadow stop the evolver as well.
CREATE TABLE IF NOT EXISTS evolver_controls (
  control TEXT PRIMARY KEY CHECK (control = 'mode'),
  value TEXT NOT NULL CHECK (value IN ('on', 'off')),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO evolver_controls (control, value, updated_by, updated_at)
  VALUES ('mode', 'on', 'owner:decision-2026-11-17', '2026-11-17T17:00:00.000Z');
