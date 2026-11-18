-- HAIC H1.5d, agent-proposed councils (docs/design/HAIC-H0-H1.md §4.1; owner answer Q9 of 2026-11-16: an agent-raised
-- council is an inbox item that the owner starts).
--
-- Additive only: four columns on councils (0079), every existing row reading the owner's trigger and NULLs.
--   trigger_kind        what raised the council: 'owner' (every council until now), an Observer or census 'finding', or a
--                       'kpi_regression' of the trading organ's health;
--   topic_key           the deterministic fingerprint of the topic and question (council.ts topicKey), for the 7-day dedup;
--   evidence_refs_json  the proposal's evidence refs (JSON array of ev: refs; never a price), for the dedup's "new evidence";
--   started_at          when the council began to deliberate (a proposal begins only on the owner's click), so a proposal
--                       counts neither as open nor against the 4 councils a UTC day until then.
ALTER TABLE councils ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'owner' CHECK (trigger_kind IN ('owner', 'finding', 'kpi_regression', 'agent', 'strategist'));
ALTER TABLE councils ADD COLUMN topic_key TEXT CHECK (topic_key IS NULL OR length(topic_key) <= 300);
ALTER TABLE councils ADD COLUMN evidence_refs_json TEXT CHECK (evidence_refs_json IS NULL OR json_valid(evidence_refs_json));
ALTER TABLE councils ADD COLUMN started_at TEXT;
CREATE INDEX IF NOT EXISTS idx_councils_topic_key ON councils(topic_key, created_at);
