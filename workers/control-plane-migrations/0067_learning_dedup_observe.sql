-- 0067 (owner 2026-11-14, after the learning mandate "learning tidak boleh dibatasi siapa pun, itu adalah mandat
-- tertinggi"): exact-duplicate dedup instead of a cap, and learning made visible instead of blocked. Additive only:
-- three columns and two lookup indexes, no row is changed or removed. (0066 is taken by another in-flight branch.)
--
--   1. agent_memories.dedup_sha256 and knowledge_proposals.dedup_sha256: the SHA-256 of the agent id, the subject and
--      the normalized content (ai-kernel/src/learning-dedup.ts says exactly what is normalized). memory.remember and
--      knowledge.propose look it up first; an identical row returns its own id and nothing new is written.
--      The indexes are deliberately NOT unique:
--        - rows written before this migration have NULL (SQLite has no SHA-256 to backfill them in SQL), and
--          production may already hold exact duplicates; a UNIQUE index would need a DELETE first, which is
--          destructive (the Forge's owner-only rule, migration-rules.ts) and could fail the apply;
--        - memory.remember upserts the Vectorize vector before the D1 row, so a UNIQUE violation on a concurrent
--          duplicate would leave an orphan vector and refuse a learning call. A lookup refuses nothing: two truly
--          simultaneous identical calls may both be written, which costs one row and never blocks learning.
--   2. ai_usage.learning_requests: the AI requests made for learning (purpose "learning"), also counted in requests.
--      They are metered and shown, never refused (control-plane-shared/src/power-mode.ts).
ALTER TABLE agent_memories ADD COLUMN dedup_sha256 TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_memories_dedup ON agent_memories (agent_id, dedup_sha256);

ALTER TABLE knowledge_proposals ADD COLUMN dedup_sha256 TEXT;
CREATE INDEX IF NOT EXISTS idx_knowledge_proposals_dedup ON knowledge_proposals (proposer_agent_id, dedup_sha256);

ALTER TABLE ai_usage ADD COLUMN learning_requests INTEGER NOT NULL DEFAULT 0 CHECK (learning_requests >= 0);
