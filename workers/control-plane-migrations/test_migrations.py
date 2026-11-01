#!/usr/bin/env python3
"""Isolated SQLite tests for the control-plane D1 migrations; never connects to Cloudflare."""
from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parent
INITIAL = ROOT / "0001_initial.sql"
FORWARD = ROOT / "0002_service_referential_integrity.sql"

def expect_integrity_error(label, operation):
    try:
        operation()
    except sqlite3.IntegrityError:
        return
    raise AssertionError(f"{label}: expected SQLite integrity constraint failure")

db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys = ON")
db.executescript(INITIAL.read_text(encoding="utf-8"))

expected_tables = {
    "service_registry", "deployment_requests", "policy_decisions",
    "drift_observations", "audit_events", "recovery_plans", "idempotency_records",
}
tables_before = {
    row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
}
assert expected_tables <= tables_before, f"missing initial tables: {expected_tables - tables_before}"

for service_id, name in (("svc-a", "Service A"), ("svc-b", "Service B")):
    db.execute(
        """INSERT INTO service_registry
           (service_id, display_name, environment, status, created_at, updated_at)
           VALUES (?, ?, 'development', 'registered', 't0', 't0')""",
        (service_id, name),
    )

db.execute(
    """INSERT INTO deployment_requests
       (request_id, service_id, requested_version, requested_by, status, idempotency_key,
        details_json, created_at, updated_at)
       VALUES ('req-1', 'svc-a', 'v1', 'test', 'pending', 'legacy-key', '{}', 't0', 't0')"""
)
db.execute(
    """INSERT INTO policy_decisions
       (decision_id, subject, action, resource, decision, reason, evidence_json, created_at)
       VALUES ('decision-1', 'svc-a', 'inspect', 'worker', 'allow', 'test', '{}', 't0')"""
)
db.execute(
    """INSERT INTO drift_observations
       (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at)
       VALUES ('obs-1', 'svc-a', 'h1', 'h2', 1, '{}', 't0')"""
)
db.execute(
    """INSERT INTO audit_events
       (event_id, event_type, actor, subject, outcome, payload_json, previous_hash, event_hash, created_at)
       VALUES ('event-1', 'test', 'test', 'svc-a', 'ok', '{}', NULL, 'hash-1', 't0')"""
)
db.execute(
    """INSERT INTO recovery_plans
       (plan_id, service_id, plan_version, status, steps_json, created_at, updated_at)
       VALUES ('plan-1', 'svc-a', 'v1', 'draft', '[]', 't0', 't0')"""
)
db.execute(
    """INSERT INTO idempotency_records
       (idempotency_key, service_id, response_json, created_at)
       VALUES ('legacy-idem', 'svc-a', '{}', 't0')"""
)
db.commit()

# Run only against this in-memory database. No credentials or remote D1 endpoint are used.
db.executescript(FORWARD.read_text(encoding="utf-8"))

expected_indexes = {
    "idx_deployment_requests_status_created",
    "idx_policy_decisions_subject_created",
    "idx_drift_service_observed",
    "idx_audit_subject_created",
    "idx_recovery_service_status",
}
indexes = {
    row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='index'")
}
assert expected_indexes <= indexes, f"missing indexes: {expected_indexes - indexes}"

for table in ("deployment_requests", "drift_observations", "recovery_plans", "idempotency_records"):
    targets = {row[2] for row in db.execute(f"PRAGMA foreign_key_list({table})")}
    assert "service_registry" in targets, f"{table} lacks service_registry foreign key"

for table in expected_tables:
    assert db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 1 or table == "service_registry", (
        f"seed row was not preserved for {table}"
    )
assert db.execute("SELECT COUNT(*) FROM service_registry").fetchone()[0] == 2
assert db.execute("PRAGMA foreign_key_check").fetchall() == []

# Each service may reuse an idempotency key, but a service may not reuse its own key.
for request_id, service_id in (("req-a", "svc-a"), ("req-b", "svc-b")):
    db.execute(
        """INSERT INTO deployment_requests
           (request_id, service_id, requested_version, requested_by, status, idempotency_key,
            details_json, created_at, updated_at)
           VALUES (?, ?, 'v1', 'test', 'pending', 'shared-key', '{}', 't1', 't1')""",
        (request_id, service_id),
    )
expect_integrity_error(
    "duplicate deployment idempotency key within service",
    lambda: db.execute(
        """INSERT INTO deployment_requests
           (request_id, service_id, requested_version, requested_by, status, idempotency_key,
            details_json, created_at, updated_at)
           VALUES ('req-a2', 'svc-a', 'v1', 'test', 'pending', 'shared-key', '{}', 't1', 't1')"""
    ),
)
db.execute("INSERT INTO idempotency_records VALUES ('shared-key', 'svc-a', '{}', 't1')")
db.execute("INSERT INTO idempotency_records VALUES ('shared-key', 'svc-b', '{}', 't1')")
expect_integrity_error(
    "duplicate idempotency record key within service",
    lambda: db.execute("INSERT INTO idempotency_records VALUES ('shared-key', 'svc-a', '{}', 't2')"),
)

# Invalid service references must fail for every service-scoped table.
expect_integrity_error(
    "deployment request foreign key",
    lambda: db.execute(
        """INSERT INTO deployment_requests
           (request_id, service_id, requested_version, requested_by, status, idempotency_key,
            details_json, created_at, updated_at)
           VALUES ('bad-req', 'missing', 'v1', 'test', 'pending', 'bad-key', '{}', 't', 't')"""
    ),
)
expect_integrity_error(
    "drift observation foreign key",
    lambda: db.execute(
        """INSERT INTO drift_observations
           (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at)
           VALUES ('bad-obs', 'missing', 'h1', 'h2', 0, '{}', 't')"""
    ),
)
expect_integrity_error(
    "recovery plan foreign key",
    lambda: db.execute(
        """INSERT INTO recovery_plans
           (plan_id, service_id, plan_version, status, steps_json, created_at, updated_at)
           VALUES ('bad-plan', 'missing', 'v1', 'draft', '[]', 't', 't')"""
    ),
)
expect_integrity_error(
    "idempotency record foreign key",
    lambda: db.execute("INSERT INTO idempotency_records VALUES ('bad-key', 'missing', '{}', 't')"),
)

# Preserve the original CHECK constraints.
expect_integrity_error(
    "service environment CHECK",
    lambda: db.execute(
        """INSERT INTO service_registry
           (service_id, display_name, environment, status, created_at, updated_at)
           VALUES ('bad-env', 'bad', 'invalid', 'registered', 't', 't')"""
    ),
)
expect_integrity_error(
    "drifted CHECK",
    lambda: db.execute(
        """INSERT INTO drift_observations
           (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at)
           VALUES ('bad-drift', 'svc-a', 'h1', 'h2', 2, '{}', 't')"""
    ),
)

assert db.execute("PRAGMA foreign_key_check").fetchall() == []
# A failed forward migration must not leave a partially rebuilt schema.
# This mirrors D1's transactional migration behavior using an isolated SQLite transaction.
failure_db = sqlite3.connect(":memory:")
failure_db.execute("PRAGMA foreign_keys = ON")
failure_db.executescript(INITIAL.read_text(encoding="utf-8"))
failure_db.execute(
    """INSERT INTO service_registry
       (service_id, display_name, environment, status, created_at, updated_at)
       VALUES ('svc-valid', 'Service', 'development', 'registered', 't0', 't0')"""
)
failure_db.execute(
    """INSERT INTO deployment_requests
       (request_id, service_id, requested_version, requested_by, status, idempotency_key,
        details_json, created_at, updated_at)
       VALUES ('orphan-request', 'missing-service', 'v1', 'test', 'pending', 'orphan-key', '{}', 't0', 't0')"""
)
failure_db.commit()

try:
    failure_db.executescript("BEGIN;\n" + FORWARD.read_text(encoding="utf-8") + "\nCOMMIT;")
except sqlite3.IntegrityError:
    failure_db.rollback()
else:
    raise AssertionError("orphan service reference: forward migration should fail closed")

tables_after_failure = {
    row[0] for row in failure_db.execute("SELECT name FROM sqlite_master WHERE type='table'")
}
assert "deployment_requests" in tables_after_failure
assert "deployment_requests_new" not in tables_after_failure, (
    "failed migration left a partially rebuilt deployment_requests table"
)
assert failure_db.execute(
    "SELECT service_id FROM deployment_requests WHERE request_id='orphan-request'"
).fetchone() == ("missing-service",), "failed migration did not preserve the original row"
assert not failure_db.execute("PRAGMA foreign_key_list(deployment_requests)").fetchall(), (
    "failed migration unexpectedly replaced the original deployment_requests schema"
)
failure_db.close()

print("PASS: initial schema, forward migration, data preservation, indexes, CHECK constraints, foreign keys, service-scoped idempotency, and fail-closed rollback")
