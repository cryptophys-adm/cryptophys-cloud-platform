-- HAIC H3b, the corrections ledger (docs/design/HAIC-H3.md §4.2; the owner's answers of 2026-11-19, every default).
--
-- Additive only: one new table and its four lookup indexes.
--   corrections: one row per owner rating or correction (correction.v1, control-plane-shared/src/correction.ts), the
--     whole record in body_json. Append-only: the kernel (ai-kernel/src/corrections.ts) never updates or deletes a row;
--     a changed rating is a new row with supersedes set, and the newest row per (actor, target_ref) counts.
--   category and source take free values here; their closed lists live in the validator, so a new value is a contract
--     version, not a table rebuild.
--   idx_corrections_dedup is NOT unique, as in 0070: a unique index would refuse a concurrent learning call; two truly
--     simultaneous identical calls may both be written, which costs one row and refuses nothing.
CREATE TABLE IF NOT EXISTS corrections (
  correction_id TEXT PRIMARY KEY CHECK (length(correction_id) = 20 AND substr(correction_id, 1, 4) = 'cor_'),
  side TEXT NOT NULL CHECK (side IN ('cerebrum', 'nexus')),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 40),
  label TEXT NOT NULL CHECK (label IN ('owner_rating', 'owner_correction', 'owner_decision', 'reviewer_correction')),
  rating TEXT CHECK (rating IS NULL OR rating IN ('up', 'down')),
  category TEXT CHECK (category IS NULL OR length(category) <= 40),
  target_ref TEXT NOT NULL CHECK (length(target_ref) BETWEEN 4 AND 300),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 3 AND 120),
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  actor TEXT NOT NULL,
  attested_by TEXT NOT NULL,
  weight INTEGER NOT NULL CHECK (weight BETWEEN 1 AND 3),
  supersedes TEXT,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  dedup_sha256 TEXT NOT NULL CHECK (length(dedup_sha256) = 64),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corrections_subject ON corrections(subject, created_at);
CREATE INDEX IF NOT EXISTS idx_corrections_target ON corrections(target_ref, created_at);
CREATE INDEX IF NOT EXISTS idx_corrections_dedup ON corrections(actor, dedup_sha256);
CREATE INDEX IF NOT EXISTS idx_corrections_side ON corrections(side, created_at);
