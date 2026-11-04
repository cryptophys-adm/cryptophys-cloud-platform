-- External agent principals bound to Cloudflare Access service-token identities (TP-009, ADR-0007).
-- No seed rows; principals are registered and revoked by an approver via the AI Kernel API.

CREATE TABLE agent_principals (
  access_identity TEXT PRIMARY KEY CHECK (length(trim(access_identity)) >= 1 AND length(access_identity) <= 200),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX agent_principals_agent_id ON agent_principals (agent_id);
