-- 0003: runtime support for the operational control-plane services.
-- Forward-only. Requires 0001 and 0002.

-- Per-service, per-UTC-day Workers AI request budget (AI-ENGINE-REQUIREMENT.md).
CREATE TABLE ai_usage (
  service_id TEXT NOT NULL,
  day TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0 CHECK(requests >= 0),
  failures INTEGER NOT NULL DEFAULT 0 CHECK(failures >= 0),
  PRIMARY KEY(service_id, day),
  FOREIGN KEY(service_id) REFERENCES service_registry(service_id)
);

-- Audit chain: each event extends exactly one predecessor, so a head can be
-- extended at most once (concurrent writers retry against the new head).
CREATE UNIQUE INDEX idx_audit_previous_hash_unique ON audit_events(previous_hash);

-- Audit events are append-only at the database layer.
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

-- Recovery plans record their author so approval can require a different approver.
ALTER TABLE recovery_plans ADD COLUMN created_by TEXT;

-- Register the platform's own Workers. desired_version is set by the deploy workflow.
INSERT OR IGNORE INTO service_registry
  (service_id, display_name, environment, status, metadata_json, created_at, updated_at)
VALUES
  ('cryptophys-platform-api', 'Platform API', 'production', 'registered',
   '{"owner":"cryptophys-adm","purpose":"Public platform health and metadata API","data_classification":"public","source":"workers/platform-api"}',
   '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z'),
  ('cryptophys-deployment-orchestrator', 'Deployment Orchestrator', 'production', 'registered',
   '{"owner":"cryptophys-adm","purpose":"Authenticated, CI-gated production deployment dispatch","data_classification":"internal","source":"workers/deployment-orchestrator"}',
   '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z'),
  ('cryptophys-platform-registry', 'Platform Registry', 'production', 'registered',
   '{"owner":"cryptophys-adm","purpose":"Desired inventory and ownership metadata","data_classification":"internal","source":"workers/platform-registry"}',
   '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z'),
  ('cryptophys-policy-engine', 'Policy Engine', 'production', 'registered',
   '{"owner":"cryptophys-adm","purpose":"Deterministic deployment and recovery policy decisions","data_classification":"internal","source":"workers/policy-engine"}',
   '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z'),
  ('cryptophys-drift-detector', 'Drift Detector', 'production', 'registered',
   '{"owner":"cryptophys-adm","purpose":"Desired-versus-observed version and health comparison","data_classification":"internal","source":"workers/drift-detector"}',
   '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z'),
  ('cryptophys-audit-ledger', 'Audit Ledger', 'production', 'registered',
   '{"owner":"cryptophys-adm","purpose":"Append-only hash-chained audit records","data_classification":"internal","source":"workers/audit-ledger"}',
   '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z'),
  ('cryptophys-recovery-manager', 'Recovery Manager', 'production', 'registered',
   '{"owner":"cryptophys-adm","purpose":"Reviewed recovery plans with separated approval","data_classification":"internal","source":"workers/recovery-manager"}',
   '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
