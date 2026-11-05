-- Expand agent_reports.kind so the 8 AI Worker platform agents, 7 active XAUUSD agents,
-- and 14 XAUUSD Pine HUD agents registered in 0016 can publish typed advisory reports
-- ('platform_digest', 'xauusd_digest', 'hud_digest') alongside 'signal_digest' and 'audit_digest'.
-- Also ensure all 8 platform AI Worker agents include 'reports.publish' in capabilities_json.

CREATE TABLE agent_reports_new (
  report_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  kind TEXT NOT NULL CHECK (kind IN ('signal_digest', 'audit_digest', 'platform_digest', 'xauusd_digest', 'hud_digest')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  subject TEXT NOT NULL,
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  ai_status TEXT NOT NULL,
  decision_id TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO agent_reports_new
  (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at)
SELECT report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at
FROM agent_reports;

DROP TABLE agent_reports;
ALTER TABLE agent_reports_new RENAME TO agent_reports;
CREATE INDEX agent_reports_agent_created ON agent_reports (agent_id, created_at);

UPDATE agents
SET capabilities_json = '["platform.observe","signals.observe","audit.verify","reports.publish","memory.recall","memory.remember"]',
    updated_by = 'migration:0017',
    updated_at = '2026-11-05T00:00:00.000Z'
WHERE agent_id = 'platform-api';

UPDATE agents
SET capabilities_json = '["platform.observe","audit.verify","reports.publish","memory.recall","memory.remember"]',
    updated_by = 'migration:0017',
    updated_at = '2026-11-05T00:00:00.000Z'
WHERE agent_id IN ('deployment-orchestrator', 'policy-engine');

UPDATE agents
SET capabilities_json = '["platform.observe","reports.publish","memory.recall","memory.remember"]',
    updated_by = 'migration:0017',
    updated_at = '2026-11-05T00:00:00.000Z'
WHERE agent_id = 'platform-registry';

UPDATE agents
SET capabilities_json = '["platform.observe","recovery.propose","reports.publish","memory.recall","memory.remember"]',
    updated_by = 'migration:0017',
    updated_at = '2026-11-05T00:00:00.000Z'
WHERE agent_id = 'recovery-manager';
