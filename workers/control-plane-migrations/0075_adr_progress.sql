-- 0075 (ADR Steward step 3, docs/design/ADR-STEWARD.md §4.6; owner 2026-11-16, "ya semua, sesuai rekomendasimu"): the
-- ADR Steward's documents. One row per ADR holds the queryable columns and the adr.progress-doc.v1 body as D1 JSON
-- (ADR-0015 §4: a few kilobytes each, so no R2); one history row per revision. Only the Steward writes them, and only
-- when a document changed (its body hash), so a quiet pass writes nothing and no column is a heartbeat (ADR-0015 §7).
-- No new index: the list reads about 20 rows by primary key, and history is read per ADR by (adr_id, revision).
-- Additive: two new tables, CREATE TABLE IF NOT EXISTS; no existing row or table is changed.
CREATE TABLE IF NOT EXISTS adr_progress (
  adr_id TEXT PRIMARY KEY CHECK (length(adr_id) = 4 AND adr_id GLOB '[0-9][0-9][0-9][0-9]'),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('accepted', 'deferred', 'held', 'planned', 'superseded')),
  status TEXT NOT NULL CHECK (status IN ('not_started', 'in_progress', 'done', 'superseded', 'held', 'planned')),
  phases_total INTEGER NOT NULL CHECK (phases_total >= 0),
  phases_proven INTEGER NOT NULL CHECK (phases_proven >= 0),
  phases_asserted INTEGER NOT NULL CHECK (phases_asserted >= 0),
  percent INTEGER NOT NULL CHECK (percent BETWEEN 0 AND 100),
  percent_proven INTEGER NOT NULL CHECK (percent_proven BETWEEN 0 AND 100),
  manifest_sha256 TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  body_json TEXT NOT NULL CHECK (json_valid(body_json) AND length(body_json) <= 32768),
  explanation_json TEXT CHECK (explanation_json IS NULL OR json_valid(explanation_json)),
  changed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS adr_progress_history (
  adr_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  percent INTEGER NOT NULL,
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  explanation_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (adr_id, revision)
);
