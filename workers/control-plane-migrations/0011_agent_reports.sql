-- Signal Analyst agent and generic agent reports store (TP-006, ADR-0007).
-- Agents at tier >= 1 publish advisory digests through the Policy-gated reports.publish syscall.

CREATE TABLE agent_reports (
  report_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  kind TEXT NOT NULL CHECK (kind IN ('signal_digest', 'audit_digest')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  subject TEXT NOT NULL,
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  ai_status TEXT NOT NULL,
  decision_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX agent_reports_agent_created ON agent_reports (agent_id, created_at);

INSERT OR IGNORE INTO agents
  (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at)
VALUES
  ('signal-analyst', 'Signal Analyst', 'cryptophys-ai-kernel',
   'Reads Signal Engine confluence, decisions, Mizan and macro context hourly and publishes an advisory digest when actions change or every 6 hours.',
   1, '["signals.observe","reports.publish"]', 'enabled', NULL, 'migration:0011',
   '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z');
