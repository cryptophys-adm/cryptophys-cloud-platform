-- 0029 (TP-028): learned-knowledge proposals (RFC_AETHER_KNOWLEDGE_GUARDIAN in
-- cryptophys-adm/xauusd-ai-trading-assistant, phase A6; owner go 2026-11-07).
--   1. knowledge_proposals: tier 1 drafts from Aether's curator and calibrator (knowledge.propose).
--      Only a person who is an approver approves or rejects one (Console); approval means "approved
--      for shadow testing", never promotion, which stays an owner PR in the xauusd repository.
--      A pending proposal expires after 14 days. Every decision is also in the audit chain.
--   2. Grants: aether-curator and aether-calibrator get knowledge.propose (tier 1) and
--      knowledge.status (tier 0, their own proposals only). No other agent gets either.
CREATE TABLE knowledge_proposals (
  proposal_id TEXT PRIMARY KEY CHECK (proposal_id GLOB 'knw_*'),
  proposer_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  item_id TEXT NOT NULL,
  item_version INTEGER NOT NULL CHECK (item_version BETWEEN 1 AND 999),
  kind TEXT NOT NULL CHECK (kind IN ('caution', 'role_reminder', 'param_candidate')),
  item_json TEXT NOT NULL CHECK (json_valid(item_json)),
  content_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  decided_by TEXT,
  reason TEXT,
  decision_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE (proposer_agent_id, item_id, item_version)
);
CREATE INDEX knowledge_proposals_status ON knowledge_proposals (status, created_at);
CREATE INDEX knowledge_proposals_agent ON knowledge_proposals (proposer_agent_id, created_at);

UPDATE agents
SET capabilities_json = json_insert(capabilities_json, '$[#]', 'knowledge.propose'),
    updated_by = 'migration:0029', updated_at = '2026-11-07T14:00:00.000Z'
WHERE agent_id IN ('aether-curator', 'aether-calibrator')
  AND NOT EXISTS (SELECT 1 FROM json_each(agents.capabilities_json) WHERE value = 'knowledge.propose');

UPDATE agents
SET capabilities_json = json_insert(capabilities_json, '$[#]', 'knowledge.status'),
    updated_by = 'migration:0029', updated_at = '2026-11-07T14:00:00.000Z'
WHERE agent_id IN ('aether-curator', 'aether-calibrator')
  AND NOT EXISTS (SELECT 1 FROM json_each(agents.capabilities_json) WHERE value = 'knowledge.status');
