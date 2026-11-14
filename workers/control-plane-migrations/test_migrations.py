#!/usr/bin/env python3
"""Isolated SQLite tests for the control-plane D1 migrations; never connects to Cloudflare."""
from pathlib import Path
import re
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


# Migration 0011: one-time agent syscall consumption and continuous rate-limit backfill.
full_db = sqlite3.connect(":memory:")
full_db.execute("PRAGMA foreign_keys = ON")
for migration in sorted(ROOT.glob("*.sql")):
    if migration.name >= "0011_agent_syscall_consumptions.sql":
        continue
    full_db.executescript(migration.read_text(encoding="utf-8"))

full_db.executemany(
    """INSERT INTO agent_actions
       (action_id, agent_id, capability, tier, decision_id, outcome, input_json, result_json, created_at)
       VALUES (?, 'supervisor', 'signals.reingest', 2, ?, ?, '{}', '{}', ?)""",
    [
        ("act-success", "dec-success", "succeeded", "2026-11-04T15:00:00.000Z"),
        ("act-failed", "dec-failed", "failed", "2026-11-04T15:01:00.000Z"),
        ("act-denied", "dec-denied", "denied", "2026-11-04T15:02:00.000Z"),
    ],
)
for migration in sorted(ROOT.glob("*.sql")):
    if migration.name < "0011_agent_syscall_consumptions.sql":
        continue
    full_db.executescript(migration.read_text(encoding="utf-8"))
consumed = {
    row[0] for row in full_db.execute("SELECT decision_id FROM agent_syscall_consumptions")
}
assert consumed == {"dec-success", "dec-failed"}, f"unexpected consumption backfill: {consumed}"
assert full_db.execute("PRAGMA foreign_key_check").fetchall() == []
full_db.close()


# Migration 0053: one acknowledgement per critical report, a bounded reason, and a real report behind it.
ack_db = sqlite3.connect(":memory:")
ack_db.execute("PRAGMA foreign_keys = ON")
for migration in sorted(ROOT.glob("*.sql")):
    ack_db.executescript(migration.read_text(encoding="utf-8"))
ack_db.execute(
    """INSERT INTO agent_reports
       (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at)
       VALUES ('rpt-ack', 'supervisor', 'platform_digest', 'critical', 'deploy failed', '{}', 'deterministic', NULL, 't0'),
              ('rpt-ack-2', 'supervisor', 'platform_digest', 'critical', 'rollback failed', '{}', 'deterministic', NULL, 't0')"""
)
ack_db.execute(
    """INSERT INTO agent_report_acknowledgements (report_id, acknowledged_by, reason, acknowledged_at)
       VALUES ('rpt-ack', 'owner@example.com', 'cause fixed and live', 't1')"""
)
expect_integrity_error("second acknowledgement of one report", lambda: ack_db.execute(
    """INSERT INTO agent_report_acknowledgements (report_id, acknowledged_by, reason, acknowledged_at)
       VALUES ('rpt-ack', 'owner@example.com', 'acknowledged twice', 't2')"""
))
expect_integrity_error("acknowledgement of an unknown report", lambda: ack_db.execute(
    """INSERT INTO agent_report_acknowledgements (report_id, acknowledged_by, reason, acknowledged_at)
       VALUES ('rpt-missing', 'owner@example.com', 'no such report here', 't2')"""
))
expect_integrity_error("acknowledgement reason under 10 characters", lambda: ack_db.execute(
    """INSERT INTO agent_report_acknowledgements (report_id, acknowledged_by, reason, acknowledged_at)
       VALUES ('rpt-ack-2', 'owner@example.com', 'short', 't2')"""
))
expect_integrity_error("acknowledgement reason over 500 characters", lambda: ack_db.execute(
    """INSERT INTO agent_report_acknowledgements (report_id, acknowledged_by, reason, acknowledged_at)
       VALUES ('rpt-ack-2', 'owner@example.com', ?, 't2')""", ("x" * 501,)
))
assert {row[2] for row in ack_db.execute("PRAGMA foreign_key_list(agent_report_acknowledgements)")} == {"agent_reports"}
assert ack_db.execute("PRAGMA foreign_key_check").fetchall() == []
ack_db.close()
print("PASS: 0053 agent report acknowledgements (primary key, reason bounds, report foreign key)")


# Migration 0054: one row per git backup run, status ok or failed only, run id unique.
gb_db = sqlite3.connect(":memory:")
for migration in sorted(ROOT.glob("*.sql")):
    gb_db.executescript(migration.read_text(encoding="utf-8"))
gb_db.execute(
    """INSERT INTO forge_git_backups (run_id, main_sha, day, ran_at, status, r2_key, bundle_sha256, bundle_bytes, objects, refs)
       VALUES ('gb-1', 'abc', '2026-11-13', 't0', 'ok', 'git-backups/platform/2026-11-13-abc.bundle', 'f00', 10, 3, 1)"""
)
expect_integrity_error("git backup status outside ok/failed", lambda: gb_db.execute(
    """INSERT INTO forge_git_backups (run_id, main_sha, day, ran_at, status) VALUES ('gb-2', 'abc', '2026-11-13', 't1', 'pending')"""
))
expect_integrity_error("duplicate git backup run id", lambda: gb_db.execute(
    """INSERT INTO forge_git_backups (run_id, main_sha, day, ran_at, status) VALUES ('gb-1', 'abc', '2026-11-13', 't1', 'failed')"""
))
assert {row[1] for row in gb_db.execute("PRAGMA index_list(forge_git_backups)")} >= {"idx_forge_git_backups_ran", "idx_forge_git_backups_head"}
gb_db.close()
print("PASS: 0054 forge git backups (status CHECK, run id key, indexes)")

# Migration 0055: cryptophys-home is retired. Its registry row is kept and only disabled; every
# other row and the drift history are unchanged. Applying it twice changes nothing more.
home_db = sqlite3.connect(":memory:")
home_db.execute("PRAGMA foreign_keys = ON")
for migration in sorted(ROOT.glob("*.sql")):
    if migration.name >= "0055_retire_home.sql":
        continue
    home_db.executescript(migration.read_text(encoding="utf-8"))
assert home_db.execute(
    "SELECT status FROM service_registry WHERE service_id = 'cryptophys-home'"
).fetchone() == ("registered",), "0022 registers cryptophys-home"
home_db.execute(
    "UPDATE service_registry SET desired_version = 'abcdefabcdef', status = 'healthy' WHERE service_id = 'cryptophys-home'"
)
home_db.execute(
    """INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at)
       VALUES ('obs-home', 'cryptophys-home', 'd', 'o', 0, '{}', 't0')"""
)
others_before = home_db.execute(
    "SELECT * FROM service_registry WHERE service_id <> 'cryptophys-home' ORDER BY service_id"
).fetchall()
rows_before = home_db.execute("SELECT COUNT(*) FROM service_registry").fetchone()[0]
retire_home = (ROOT / "0055_retire_home.sql").read_text(encoding="utf-8")
retire_home_code = "\n".join(line.split("--", 1)[0] for line in retire_home.splitlines()).upper()
assert "DELETE" not in retire_home_code and "DROP" not in retire_home_code, "0055 deletes nothing"
assert retire_home_code.count("UPDATE SERVICE_REGISTRY") == 1 and retire_home_code.count(";") == 1, "0055 is one registry update"
for _ in range(2):
    home_db.executescript(retire_home)
    row = home_db.execute(
        "SELECT status, desired_version, display_name FROM service_registry WHERE service_id = 'cryptophys-home'"
    ).fetchone()
    assert row == ("disabled", "abcdefabcdef", "Cerebrum Home"), f"0055 only disables the row: {row}"
    assert home_db.execute("SELECT COUNT(*) FROM service_registry").fetchone()[0] == rows_before
    assert home_db.execute(
        "SELECT * FROM service_registry WHERE service_id <> 'cryptophys-home' ORDER BY service_id"
    ).fetchall() == others_before, "0055 changes no other service"
    assert home_db.execute(
        "SELECT COUNT(*) FROM drift_observations WHERE service_id = 'cryptophys-home'"
    ).fetchone()[0] == 1, "drift history is kept"
assert home_db.execute("PRAGMA foreign_key_check").fetchall() == []
for migration in sorted(ROOT.glob("*.sql")):
    if migration.name > "0055_retire_home.sql":
        home_db.executescript(migration.read_text(encoding="utf-8"))
home_db.close()
print("PASS: 0055 retire cryptophys-home (row kept and disabled, nothing else changed, idempotent)")

# Migration 0056 (owner 2026-11-13, Alerts page): the owner's Telegram alert channels. Additive: one table and the
# seed row for the existing xauusd bot. A row never holds a bot token: a custom channel needs a chat id and the
# token's last four characters only; the default channel has neither.
alert_db = sqlite3.connect(":memory:")
alert_db.execute("PRAGMA foreign_keys = ON")
for migration in sorted(ROOT.glob("*.sql")):
    alert_db.executescript(migration.read_text(encoding="utf-8"))
alerts_sql = (ROOT / "0056_alert_channels.sql").read_text(encoding="utf-8")
alerts_code = "\n".join(line.split("--", 1)[0] for line in alerts_sql.splitlines()).upper()
assert "DROP" not in alerts_code and "DELETE" not in alerts_code and "ALTER" not in alerts_code, "0056 is additive"
assert alert_db.execute("SELECT channel_id, kind, chat_id, token_hint, enabled FROM alert_channels").fetchall() == [
    ("alc_default", "telegram_default", None, None, 1)
], "0056 seeds the existing bot only"
assert {r[1] for r in alert_db.execute("PRAGMA table_info(alert_channels)")} == {
    "channel_id", "name", "kind", "chat_id", "topics_json", "enabled", "token_hint",
    "created_by", "created_at", "updated_by", "updated_at",
}, "no column can hold a bot token"
ok_row = ("alc_x", "Cerebrum", "telegram", "-100123", '["critical_reports"]', 1, "Ab9z", "o@e.com", "t", "o@e.com", "t")
alert_db.execute("INSERT INTO alert_channels VALUES (?,?,?,?,?,?,?,?,?,?,?)", ok_row)
for bad in [
    ("alc_y", "x", "telegram", None, "[]", 1, "Ab9z", "o", "t", "o", "t"),            # a custom channel needs a chat id
    ("alc_y", "x", "telegram", "1", "[]", 1, None, "o", "t", "o", "t"),               # and a token hint
    ("alc_y", "x", "telegram", "1", "[]", 1, "123456:full-token", "o", "t", "o", "t"),  # never more than four characters
    ("alc_y", "x", "telegram_default", "1", "[]", 1, None, "o", "t", "o", "t"),       # the default has no chat id
    ("alc_y", "x", "email", "1", "[]", 1, "Ab9z", "o", "t", "o", "t"),                # telegram only
    ("bad_y", "x", "telegram", "1", "[]", 1, "Ab9z", "o", "t", "o", "t"),             # ids start with alc_
    ("alc_y", "x", "telegram", "1", "{}", 1, "Ab9z", "o", "t", "o", "t"),             # topics are an array
]:
    try:
        alert_db.execute("INSERT INTO alert_channels VALUES (?,?,?,?,?,?,?,?,?,?,?)", bad)
    except sqlite3.IntegrityError:
        continue
    raise AssertionError(f"0056 accepted {bad}")
alert_db.close()
print("PASS: 0056 alert channels (additive, default seed, no token column, CHECKs)")

# Migration 0057 (ADR-0012 G3b, 2026-11-13): where canonical main moves. Additive; the default is github, so
# applying it changes nothing until a reviewed migration flips the row at the cut-over.
merge_db = sqlite3.connect(":memory:")
merge_db.execute("PRAGMA foreign_keys = ON")
for migration in sorted(ROOT.glob("*.sql")):
    if migration.name <= "0057_forge_merge_path.sql":
        merge_db.executescript(migration.read_text(encoding="utf-8"))
merge_sql = (ROOT / "0057_forge_merge_path.sql").read_text(encoding="utf-8")
merge_code = "\n".join(line.split("--", 1)[0] for line in merge_sql.splitlines()).upper()
assert not re.search(r"\b(DROP|DELETE|ALTER|UPDATE)\b", merge_code), "0057 is additive"
assert merge_db.execute("SELECT control, value FROM forge_controls").fetchall() == [("merge_path", "github")], "0057 keeps GitHub merging"
for bad in [("merge_path", "anything"), ("other", "github")]:
    try:
        merge_db.execute("INSERT OR REPLACE INTO forge_controls VALUES (?, ?, 'x', 't')", bad)
    except sqlite3.IntegrityError:
        continue
    raise AssertionError(f"0057 accepted {bad}")
merge_db.close()
print("PASS: 0057 forge merge path (additive, default github, CHECKs)")

# Migration 0058 (ADR-0012 G6, cut-over step 4): the merge path is the Forge. Only that row changes.
cut_db = sqlite3.connect(":memory:")
cut_db.execute("PRAGMA foreign_keys = ON")
for migration in sorted(ROOT.glob("*.sql")):
    cut_db.executescript(migration.read_text(encoding="utf-8"))
assert cut_db.execute("SELECT control, value, updated_by FROM forge_controls").fetchall() == [("merge_path", "forge", "migration:0058")], "0058 flips the merge path"
cut_sql = (ROOT / "0058_cutover_merge_path_forge.sql").read_text(encoding="utf-8")
cut_code = "\n".join(line.split("--", 1)[0] for line in cut_sql.splitlines()).upper()
assert not re.search(r"\b(DROP|DELETE|ALTER|INSERT)\b", cut_code) and cut_code.count("UPDATE ") == 1 and "WHERE CONTROL = 'MERGE_PATH'" in cut_code, "0058 changes one row"
cut_db.close()
print("PASS: 0058 cut-over (merge path forge, one row)")

# Migration 0059 (resource audit 2026-11-14): an index on drift_observations(observed_at); additive, no row changes.
idx_db = sqlite3.connect(":memory:")
idx_db.execute("PRAGMA foreign_keys = ON")
for migration in sorted(ROOT.glob("*.sql")):
    idx_db.executescript(migration.read_text(encoding="utf-8"))
assert idx_db.execute("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_drift_observed'").fetchone()[0].replace(" ", "") == "CREATEINDEXidx_drift_observedONdrift_observations(observed_at)", "0059 indexes observed_at"
plan = " ".join(r[3] for r in idx_db.execute("EXPLAIN QUERY PLAN SELECT observation_id FROM drift_observations WHERE observed_at < '2026-01-01' ORDER BY observed_at LIMIT 10").fetchall())
assert "idx_drift_observed" in plan, f"the retention scan uses the index: {plan}"
idx_sql = (ROOT / "0059_drift_observed_index.sql").read_text(encoding="utf-8")
idx_code = "\n".join(line.split("--", 1)[0] for line in idx_sql.splitlines()).upper()
assert not re.search(r"\b(DROP|DELETE|ALTER|INSERT|UPDATE)\b", idx_code) and idx_code.count("CREATE INDEX") == 1, "0059 only adds an index"
idx_db.close()
print("PASS: 0059 drift observed_at index (additive)")
