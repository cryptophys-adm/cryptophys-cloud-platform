-- 0088 (PF3, 2026-11-24; owner: "harus dibuat jalurnya untuk feedback loop"): the knowledge.verdict write-back. xauusd's
-- shadow-knowledge arm tests Aether's autonomous knowledge items (caution, role_reminder) in shadow; this table keeps
-- its verdicts, so a proposal no longer looks merely 'pending' until the 14-day expiry and Aether's curator reads the
-- outcome back with knowledge.status (ai-kernel/src/knowledge.ts). The next free number after PF1's 0087.
--
-- Additive only: one new table and two indexes. knowledge_proposals is not altered; its status keeps its meaning (a
-- person's review), and a verdict is a reading beside it, never a decision.
--   knowledge_verdicts: one row per verdict the reporter sent (the agent holding knowledge.verdict, XAUUSD_CEILING).
--     Append-only: the kernel never updates or deletes a row; the newest row per proposal is its latest verdict.
--     terminal is 1 exactly for live, retired, not_better, worse and holdout_failed (CHECK).
--     reason is the reporter's plain text, secrets redacted and prices masked before it is stored (10 to 300 chars).
--     evidence_json holds only the closed list of evidence keys the kernel validates (no price, no level).
--   idx_knowledge_verdicts_dedup is UNIQUE on (proposal_id, verdict, window_end or ''): the same verdict for the same
--     window is one row; the kernel answers a repeat with the existing row (deduplicated), so nothing is refused.
CREATE TABLE IF NOT EXISTS knowledge_verdicts (
  verdict_id TEXT PRIMARY KEY NOT NULL CHECK (verdict_id GLOB 'kvd_*'),
  proposal_id TEXT NOT NULL REFERENCES knowledge_proposals(proposal_id),
  item_id TEXT NOT NULL CHECK (length(item_id) BETWEEN 3 AND 42),
  item_version INTEGER NOT NULL CHECK (item_version BETWEEN 1 AND 999),
  verdict TEXT NOT NULL CHECK (verdict IN ('live', 'retired', 'not_better', 'worse', 'holdout_failed', 'collecting', 'inconclusive', 'not_tested')),
  terminal INTEGER NOT NULL CHECK (terminal = (CASE WHEN verdict IN ('live', 'retired', 'not_better', 'worse', 'holdout_failed') THEN 1 ELSE 0 END)),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 300),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
  reporter_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  window_end TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_verdicts_dedup ON knowledge_verdicts (proposal_id, verdict, COALESCE(window_end, ''));
CREATE INDEX IF NOT EXISTS idx_knowledge_verdicts_proposal ON knowledge_verdicts (proposal_id, created_at);
