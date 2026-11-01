-- 0002: enforce service referential integrity and service-scoped idempotency.
-- Forward-only: 0001 has already been applied in the connected D1 database; do not rewrite it.
-- The copies below intentionally fail if existing service_id values have no service_registry row.
PRAGMA foreign_keys = ON;

CREATE TABLE deployment_requests_new (
  request_id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  requested_version TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','running','succeeded','failed','cancelled')),
  approval_id TEXT,
  idempotency_key TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(service_id, idempotency_key),
  FOREIGN KEY(service_id) REFERENCES service_registry(service_id)
);
INSERT INTO deployment_requests_new
  (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
SELECT request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at
FROM deployment_requests;
DROP TABLE deployment_requests;
ALTER TABLE deployment_requests_new RENAME TO deployment_requests;
CREATE INDEX idx_deployment_requests_status_created ON deployment_requests(status, created_at);

CREATE TABLE drift_observations_new (
  observation_id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  desired_hash TEXT NOT NULL,
  observed_hash TEXT NOT NULL,
  drifted INTEGER NOT NULL CHECK(drifted IN (0,1)),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  observed_at TEXT NOT NULL,
  FOREIGN KEY(service_id) REFERENCES service_registry(service_id)
);
INSERT INTO drift_observations_new
  (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at)
SELECT observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at
FROM drift_observations;
DROP TABLE drift_observations;
ALTER TABLE drift_observations_new RENAME TO drift_observations;
CREATE INDEX idx_drift_service_observed ON drift_observations(service_id, observed_at);

CREATE TABLE recovery_plans_new (
  plan_id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  plan_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','approved','executing','completed','failed','disabled')),
  steps_json TEXT NOT NULL,
  approved_by TEXT,
  last_execution_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(service_id) REFERENCES service_registry(service_id)
);
INSERT INTO recovery_plans_new
  (plan_id, service_id, plan_version, status, steps_json, approved_by, last_execution_json, created_at, updated_at)
SELECT plan_id, service_id, plan_version, status, steps_json, approved_by, last_execution_json, created_at, updated_at
FROM recovery_plans;
DROP TABLE recovery_plans;
ALTER TABLE recovery_plans_new RENAME TO recovery_plans;
CREATE INDEX idx_recovery_service_status ON recovery_plans(service_id, status);

CREATE TABLE idempotency_records_new (
  idempotency_key TEXT NOT NULL,
  service_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(service_id, idempotency_key),
  FOREIGN KEY(service_id) REFERENCES service_registry(service_id)
);
INSERT INTO idempotency_records_new (idempotency_key, service_id, response_json, created_at)
SELECT idempotency_key, service_id, response_json, created_at
FROM idempotency_records;
DROP TABLE idempotency_records;
ALTER TABLE idempotency_records_new RENAME TO idempotency_records;
