-- Cryptophys control-plane shared state schema.
-- Apply once to D1 database cryptophys-control-plane; all records are tenant/service scoped.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS service_registry (
  service_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  endpoint TEXT,
  desired_version TEXT,
  observed_version TEXT,
  environment TEXT NOT NULL CHECK(environment IN ('development','preview','production')),
  status TEXT NOT NULL CHECK(status IN ('registered','healthy','degraded','unavailable','disabled')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deployment_requests (
  request_id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  requested_version TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','running','succeeded','failed','cancelled')),
  approval_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deployment_requests_status_created ON deployment_requests(status, created_at);
CREATE TABLE IF NOT EXISTS policy_decisions (
  decision_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('allow','deny')),
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_policy_decisions_subject_created ON policy_decisions(subject, created_at);
CREATE TABLE IF NOT EXISTS drift_observations (
  observation_id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  desired_hash TEXT NOT NULL,
  observed_hash TEXT NOT NULL,
  drifted INTEGER NOT NULL CHECK(drifted IN (0,1)),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drift_service_observed ON drift_observations(service_id, observed_at);
CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  subject TEXT NOT NULL,
  outcome TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  previous_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_subject_created ON audit_events(subject, created_at);
CREATE TABLE IF NOT EXISTS recovery_plans (
  plan_id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  plan_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','approved','executing','completed','failed','disabled')),
  steps_json TEXT NOT NULL,
  approved_by TEXT,
  last_execution_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recovery_service_status ON recovery_plans(service_id, status);
CREATE TABLE IF NOT EXISTS idempotency_records (
  idempotency_key TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
