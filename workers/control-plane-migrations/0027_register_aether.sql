-- 0027 (TP-027): register Aether, the Knowledge Guardian cluster (RFC_AETHER_KNOWLEDGE_GUARDIAN in
-- cryptophys-adm/xauusd-ai-trading-assistant, phase A3; owner approval 2026-11-07).
--   1. Report kind 'knowledge_audit' for Aether's advisory reports (agent_reports rebuilt as in 0017).
--   2. Four Aether agents hosted by the external Worker 'cryptophys-aether' (repository
--      cryptophys-adm/cryptophys-aether), tier_max 1. They reach the kernel only through AgentRpc
--      with props.host_worker = "cryptophys-aether"; no secret.
--   3. The service row (also the agents' host) for drift observation, 'disabled' until the Worker is deployed and the Drift
--      Detector has its EXT_AETHER binding (a follow-up after the first deploy), so no drift alert
--      fires for a Worker that does not exist yet.

CREATE TABLE agent_reports_new (
  report_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  kind TEXT NOT NULL CHECK (kind IN ('signal_digest', 'audit_digest', 'platform_digest', 'xauusd_digest', 'hud_digest', 'knowledge_audit')),
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

-- The service row first: agents.host_worker references service_registry(service_id).
INSERT OR IGNORE INTO service_registry
  (service_id, display_name, environment, status, metadata_json, created_at, updated_at)
VALUES
  ('cryptophys-aether', 'Aether Knowledge Guardian', 'production', 'disabled',
   '{"owner":"cryptophys-adm","purpose":"Knowledge Guardian cluster: decision audit, agent compliance, the Aether Canon and learned knowledge (advisory only)","data_classification":"internal","deployed_by":"cryptophys-adm/cryptophys-aether (Cloudflare Workers Builds)","health_path":"/health","note":"disabled until the first deploy and the Drift Detector EXT_AETHER binding (TP-027 follow-up)"}',
   '2026-11-07T12:00:00.000Z', '2026-11-07T12:00:00.000Z');

INSERT OR IGNORE INTO agents
  (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at)
VALUES
  ('aether-auditor', 'Aether Auditor', 'cryptophys-aether',
   'Aether decision auditor: reads the XAUUSD decision cards (no price levels), finds repeated failures and publishes advisory knowledge audits.',
   1, '["signals.observe","reports.publish"]', 'enabled', NULL, 'migration:0027',
   '2026-11-07T12:00:00.000Z', '2026-11-07T12:00:00.000Z'),
  ('aether-guardian', 'Aether Guardian', 'cryptophys-aether',
   'Aether compliance guardian: checks what each XAUUSD agent said against its role and the Aether Canon doctrine (advisory only).',
   1, '["signals.observe","reports.publish"]', 'enabled', NULL, 'migration:0027',
   '2026-11-07T12:00:00.000Z', '2026-11-07T12:00:00.000Z'),
  ('aether-curator', 'Aether Curator', 'cryptophys-aether',
   'Aether knowledge curator: keeps the learned-knowledge ledger (candidates, review, expiry) separate from the Canon; a person approves every item.',
   1, '["reports.publish"]', 'enabled', NULL, 'migration:0027',
   '2026-11-07T12:00:00.000Z', '2026-11-07T12:00:00.000Z'),
  ('aether-calibrator', 'Aether Calibrator', 'cryptophys-aether',
   'Aether calibrator: proposes parameter candidates within reviewed grids for shadow testing; the owner promotes by PR.',
   1, '["reports.publish"]', 'enabled', NULL, 'migration:0027',
   '2026-11-07T12:00:00.000Z', '2026-11-07T12:00:00.000Z');
