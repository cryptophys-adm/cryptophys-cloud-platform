-- 0041 (ADR-0013 phase 3): self-registration. Council seats become data (agents.voter) instead of a
-- list in code, and AI engines get a registry (engines). Seeds reproduce today's state exactly: the
-- nine voters of ADR-0009 §2 and the nine engines the DNA declares. From here on, new agents, engines
-- and seats are added only by consensus actions (register_agent, register_privileged_agent,
-- register_engine, admit_voter), never by hand.
ALTER TABLE agents ADD COLUMN voter INTEGER NOT NULL DEFAULT 0 CHECK (voter IN (0, 1));
UPDATE agents SET voter = 1 WHERE agent_id IN (
  'platform-api', 'deployment-orchestrator', 'platform-registry', 'policy-engine', 'drift-detector',
  'audit-ledger', 'recovery-manager', 'supervisor', 'auditor'
);
CREATE TABLE IF NOT EXISTS engines (
  service_id TEXT NOT NULL,
  task TEXT NOT NULL CHECK (length(task) BETWEEN 3 AND 63),
  status TEXT NOT NULL CHECK (status IN ('enabled', 'retired')),
  registered_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (service_id, task)
);
INSERT OR IGNORE INTO engines (service_id, task, status, registered_by, created_at, updated_at) VALUES
  ('cryptophys-ai-kernel', 'draft_audit_digest', 'enabled', 'migration:0041', '2026-11-09T12:00:00.000Z', '2026-11-09T12:00:00.000Z'),
  ('cryptophys-ai-kernel', 'draft_recovery_proposal', 'enabled', 'migration:0041', '2026-11-09T12:00:00.000Z', '2026-11-09T12:00:00.000Z'),
  ('cryptophys-audit-ledger', 'categorize_event', 'enabled', 'migration:0041', '2026-11-09T12:00:00.000Z', '2026-11-09T12:00:00.000Z'),
  ('cryptophys-deployment-orchestrator', 'summarize_deployment_risk', 'enabled', 'migration:0041', '2026-11-09T12:00:00.000Z', '2026-11-09T12:00:00.000Z'),
  ('cryptophys-drift-detector', 'summarize_drift', 'enabled', 'migration:0041', '2026-11-09T12:00:00.000Z', '2026-11-09T12:00:00.000Z'),
  ('cryptophys-platform-api', 'summarize_platform_overview', 'enabled', 'migration:0041', '2026-11-09T12:00:00.000Z', '2026-11-09T12:00:00.000Z'),
  ('cryptophys-platform-registry', 'suggest_tags', 'enabled', 'migration:0041', '2026-11-09T12:00:00.000Z', '2026-11-09T12:00:00.000Z'),
  ('cryptophys-policy-engine', 'explain_decision', 'enabled', 'migration:0041', '2026-11-09T12:00:00.000Z', '2026-11-09T12:00:00.000Z'),
  ('cryptophys-recovery-manager', 'draft_recovery_options', 'enabled', 'migration:0041', '2026-11-09T12:00:00.000Z', '2026-11-09T12:00:00.000Z');
