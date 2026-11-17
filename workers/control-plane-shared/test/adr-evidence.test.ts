// The ADR Steward, step 2 (docs/design/ADR-STEWARD.md §3, §4.4, §11 row 2; owner 2026-11-16, "ya semua, sesuai
// rekomendasimu"): the predicate evaluator and the named readings over node:sqlite fixtures built from the real
// migrations (harness.ts migratedDb). Each kind is proven and open on real rows; the combinators, depends_on and the
// per-ADR summary follow §4.4; the 0012 seed gives 18 of 26 on matching evidence; an empty database proves nothing;
// every query is a bounded, indexed SELECT; an unknown kind is refused before any query. Plain fs reads relative to
// the repository root, so the Forge runner can bundle it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { FakeD1, migratedDb } from "./harness.ts";
import {
  AdrEvidenceContext, AdrEvidenceRefused, EV_REF, evaluateAdrManifest, evaluateAdrManifests, evaluatePredicate, isoTime,
  type AdrEvaluation, type AdrEvidenceDb, type AdrEvidenceDeps, type AdrEvidenceResult,
} from "../src/adr-evidence.ts";
import { ADR_PREDICATE_KINDS, ADR_READINGS, type AdrManifest, type AdrPredicate } from "../src/adr-progress.ts";

const ROOT = new URL("../../../", import.meta.url);
const readRepo = (p: string) => (existsSync(new URL(p, ROOT)) ? readFileSync(new URL(p, ROOT), "utf8") : null);
const PROGRESS = "architecture/adr/progress/";
const manifests = (): AdrManifest[] => (readdirSync(new URL(PROGRESS, ROOT)) as string[]).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readRepo(PROGRESS + f)!));

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const ago = (h: number) => new Date(NOW - h * HOUR).toISOString();
type Db = ReturnType<typeof migratedDb>;

// ------------------------------------------------------------------ fixture rows (real columns of the migrations)
let seq = 0;
function audit(db: Db, type: string, at: string, payload: Record<string, unknown> = {}): string {
  const id = `evt_${++seq}`;
  db.raw.prepare("INSERT INTO audit_events (event_id, event_type, actor, subject, outcome, payload_json, previous_hash, event_hash, created_at) VALUES (?, ?, 'test', 'test', 'succeeded', ?, NULL, ?, ?)")
    .run(id, type, JSON.stringify(payload), `hash_${id}`, at);
  return id;
}
function deployment(db: Db, id: string, at: string, details: unknown, status = "succeeded", service = "cryptophys-console"): void {
  db.raw.prepare(`INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
    VALUES (?, ?, ?, 'test', ?, NULL, ?, ?, ?, ?)`).run(id, service, "a".repeat(40), status, `idem_${id}`, typeof details === "string" ? details : JSON.stringify(details), at, at);
}
function proposal(db: Db, id: string, action: string, target: string, status: string, at: string, ownerApproved = false): void {
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed,
    policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at) VALUES (?, 'supervisor', ?, ?, 'routine', '{}', '{}', 'routine', 3, 3, 0, 1, NULL, NULL, ?, NULL, ?, ?)`)
    .run(id, action, target, status, at, at);
  if (ownerApproved) db.raw.prepare("INSERT INTO consensus_owner_decisions (proposal_id, decision, decided_by, reason, created_at) VALUES (?, 'approve', 'owner@cryptophys.work', NULL, ?)").run(id, at);
}
function changeRequest(db: Db, id: string, status: string, outcomeAt: string | null, sourceBranch = `claude/${id}`): void {
  db.raw.prepare(`INSERT INTO forge_change_requests (cr_id, source, number, branch, source_branch, title, author, head_sha, base_sha, github_ci, status, created_at, updated_at, outcome_at, repo)
    VALUES (?, 'forge', 1, ?, ?, 'test', 'test', ?, ?, NULL, ?, ?, ?, ?, 'platform-work')`)
    .run(id, `cr/${id}`, sourceBranch, "a".repeat(40), "b".repeat(40), status, ago(300), outcomeAt ?? ago(300), outcomeAt);
}
const deps = (db: AdrEvidenceDb, extra: Partial<AdrEvidenceDeps> = {}): AdrEvidenceDeps => ({ db, readFile: readRepo, now: NOW, ...extra });
const ev = (db: AdrEvidenceDb, p: AdrPredicate, extra: Partial<AdrEvidenceDeps> = {}) => evaluatePredicate(p, deps(db, extra));
const stateOf = async (db: AdrEvidenceDb, p: AdrPredicate, extra: Partial<AdrEvidenceDeps> = {}) => (await ev(db, p, extra)).state;
const refsOk = (r: AdrEvidenceResult) => r.refs.forEach((x) => assert.match(x, EV_REF, x));

/** A spy on the D1-like reader: every SQL text with its bound values. */
function spy(db: AdrEvidenceDb): { db: AdrEvidenceDb; seen: { sql: string; args: unknown[] }[] } {
  const seen: { sql: string; args: unknown[] }[] = [];
  return { seen, db: { prepare: (sql: string) => ({ bind: (...args: unknown[]) => { seen.push({ sql, args }); return db.prepare(sql).bind(...args); } }) } };
}

/**
 * Every query a spy saw: a read-only SELECT ending in a LIMIT, never LIKE, and no full table scan in its plan (a
 * SCAN must walk an index; json_each is a virtual table over one row's JSON).
 */
function assertBoundedAndIndexed(raw: Db["raw"], seen: { sql: string; args: unknown[] }[]): void {
  assert.ok(seen.length > 0);
  for (const { sql } of seen) {
    assert.match(sql, /^\s*SELECT\s/i, sql);
    assert.match(sql, /\sLIMIT\s+(\?|\d+)\s*$/i, `no LIMIT: ${sql}`);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA)\b|\bLIKE\b/i, sql);
  }
  for (const [sql, args] of new Map(seen.map((q) => [q.sql, q.args]))) {
    const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as (string | number | null)[])) as { detail: string }[]).map((r) => r.detail);
    for (const line of plan) if (/^SCAN /.test(line)) assert.match(line, /USING (COVERING )?INDEX|USING (INTEGER )?PRIMARY KEY|VIRTUAL TABLE/, `full scan in ${sql}: ${plan.join(" | ")}`);
  }
}

test("AE1. every predicate kind is proven on matching rows and open without them, with ev: refs", async () => {
  const db = migratedDb();
  const s = spy(db);
  const covered = new Set<string>();
  const check = async (p: AdrPredicate, want: string, extra: Partial<AdrEvidenceDeps> = {}) => {
    const r = await ev(s.db, p, extra);
    assert.equal(r.state, want, `${JSON.stringify(p)}: ${r.reason}`);
    refsOk(r);
    covered.add(p.kind);
    return r;
  };

  // migration_applied: the d1_migrations ledger (CURRENT_TIMESTAMP is read as ISO).
  await check({ kind: "migration_applied", name: "0999_test_only.sql" }, "open");
  db.raw.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES ('0999_test_only.sql', '2026-11-16 10:00:00')").run();
  const mig = await check({ kind: "migration_applied", name: "0999_test_only.sql" }, "proven");
  assert.equal(mig.at, "2026-11-16T10:00:00.000Z");
  assert.deepEqual(mig.refs, ["ev:platform/d1_migrations/0999_test_only.sql@2026-11-16T10:00:00.000Z"]);
  assert.equal(mig.live, false, "a past event is sticky");

  // audit_event: type, payload paths, since, min_count.
  await check({ kind: "audit_event", event_type: "test.ae_one" }, "open");
  const e1 = audit(db, "test.ae_one", ago(30), { executor: "native:retire", n: 2, ok: true });
  const a = await check({ kind: "audit_event", event_type: "test.ae_one" }, "proven");
  assert.deepEqual(a.refs, [`ev:platform/audit/${e1}@${ago(30)}`]);
  await check({ kind: "audit_event", event_type: "test.ae_one", payload: { "$.executor": "native:retire", "$.n": 2, "$.ok": true } }, "proven");
  await check({ kind: "audit_event", event_type: "test.ae_one", payload: { "$.executor": "native:deploy" } }, "open");
  await check({ kind: "audit_event", event_type: "test.ae_one", since: ago(10) }, "open");
  await check({ kind: "audit_event", event_type: "test.ae_one", min_count: 2 }, "open");
  audit(db, "test.ae_one", ago(20));
  await check({ kind: "audit_event", event_type: "test.ae_one", min_count: 2 }, "proven");

  // quiet_window: no success, a clean window from the first success, a recent failure with its earliest proof time.
  const qw = { kind: "quiet_window", fail_types: ["test.qw_failed", "test.qw_broken"], success_type: "test.qw_ok", hours: 24 } as AdrPredicate;
  assert.match((await check(qw, "open")).reason!, /no test\.qw_ok yet/);
  audit(db, "test.qw_ok", ago(10));
  const young = await check(qw, "open");
  assert.equal(young.earliest, ago(-14), "24 h after the first success");
  audit(db, "test.qw_ok", ago(40));
  await check(qw, "proven");
  audit(db, "test.qw_broken", ago(5));
  const broken = await check(qw, "open");
  assert.match(broken.reason!, /no test\.qw_ok since test\.qw_broken/);
  audit(db, "test.qw_ok", ago(4));
  const waiting = await check(qw, "open");
  assert.equal(waiting.earliest, ago(-19), "the newest failure + 24 h");
  assert.equal((await ev(db, qw, { now: NOW + 20 * HOUR })).state, "proven", "the window closes on its own");

  // deploy_step: an exact step or a suffix, the executor, only succeeded requests (json_each, never LIKE).
  const step = { kind: "deploy_step", step: "unit:smoke_passed", executor: "native:deploy" } as AdrPredicate;
  await check(step, "open");
  deployment(db, "dr_failed", ago(9), { executor: "native:deploy", outcome: { steps: ["unit:smoke_passed"] } }, "failed");
  deployment(db, "dr_other", ago(8), { executor: "native:rollback", outcome: { steps: ["unit:smoke_passed"] } });
  deployment(db, "dr_broken", ago(7), "not json");
  await check(step, "open");
  deployment(db, "dr_ok", ago(6), { executor: "native:deploy", outcome: { steps: ["cryptophys-console:deployed", "unit:smoke_passed", "cryptophys-console:topology_planned"] } });
  const ds = await check(step, "proven");
  assert.deepEqual(ds.refs, [`ev:platform/deployment/dr_ok@${ago(6)}#outcome.steps`]);
  await check({ kind: "deploy_step", step_suffix: ":topology_planned" }, "proven");
  await check({ kind: "deploy_step", step_suffix: ":do_migration_deployed" }, "open");
  await check({ kind: "deploy_step", step: "unit:smoke_passed", since: ago(1) }, "open");

  // merged_and_deployed: merged, then a succeeded deploy of a Worker of the unit after the merge.
  const md = { kind: "merged_and_deployed", cr_id: "fg-ae1", unit: "forge" } as AdrPredicate;
  await check(md, "open");
  changeRequest(db, "fg-ae1", "merged", ago(50), "claude/ae1-branch");
  assert.match((await check(md, "open")).reason!, /no succeeded deploy of forge since/);
  deployment(db, "dr_forge_before", ago(60), {}, "succeeded", "cryptophys-forge");
  deployment(db, "dr_console_after", ago(40), {}, "succeeded", "cryptophys-console");
  await check(md, "open");
  deployment(db, "dr_forge_after", ago(30), {}, "succeeded", "cryptophys-forge");
  await check(md, "proven");
  await check({ kind: "merged_and_deployed", branch: "claude/ae1-branch", unit: "forge" }, "proven");
  await check({ kind: "merged_and_deployed", branch: "claude/ae1-branch", unit: "console" }, "proven", { now: NOW });
  changeRequest(db, "fg-ae1-open", "open", null);
  await check({ kind: "merged_and_deployed", cr_id: "fg-ae1-open", unit: "forge" }, "open");

  // census_clean: the newest census, consistent and fresh.
  await check({ kind: "census_clean" }, "open");
  const census = db.raw.prepare("INSERT INTO forge_organism_census (main_sha, status, organs, agents, engines, voters, findings, genome, taken_at) VALUES (?, ?, 1, 1, 1, 1, '[]', NULL, ?)");
  census.run("c".repeat(40), "consistent", ago(0.5));
  await check({ kind: "census_clean" }, "proven");
  await check({ kind: "census_clean" }, "open", { now: NOW + 2 * HOUR });
  await check({ kind: "census_clean", max_age_h: 3 }, "proven", { now: NOW + 2 * HOUR });
  census.run("d".repeat(40), "changes", ago(0.2));
  assert.match((await check({ kind: "census_clean" }, "open")).reason!, /is changes/);

  // observer: findings, runs and vitals, expecting some or none.
  const finding = { kind: "observer", source: "findings", kind_filter: "anomaly", worker: "cryptophys-forge", expect: "some" } as AdrPredicate;
  await check(finding, "open");
  await check({ ...finding, expect: "none" }, "proven");
  db.raw.prepare("INSERT INTO observer_findings (finding_id, worker, metric, kind, severity, bucket, detail, created_at) VALUES ('of_1', 'cryptophys-forge', 'errors', 'anomaly', 'warning', ?, 'x', ?)").run(ago(3), ago(3));
  await check(finding, "proven");
  await check({ ...finding, expect: "none" }, "open");
  await check({ ...finding, metric: "cpu_p99_ms" }, "open");
  await check({ ...finding, since: ago(1) }, "open");
  const runs = { kind: "observer", source: "runs", kind_filter: "inventory", expect: "some" } as AdrPredicate;
  db.raw.prepare("INSERT INTO observer_runs (run_id, kind, bucket, ran_at, status) VALUES ('or_1', 'inventory', 'b1', ?, 'unavailable')").run(ago(2));
  await check(runs, "open");
  db.raw.prepare("INSERT INTO observer_runs (run_id, kind, bucket, ran_at, status) VALUES ('or_2', 'inventory', 'b2', ?, 'ok')").run(ago(1));
  await check(runs, "proven");
  const vitals = { kind: "observer", source: "vitals", subject: "cryptophys-forge", expect: "some" } as AdrPredicate;
  await check(vitals, "open");
  const vital = db.raw.prepare("INSERT INTO observer_vitals (subject, kind, hour, requests, errors, cpu_p99_ms, recorded_at) VALUES (?, 'worker', ?, ?, ?, ?, ?)");
  vital.run("cryptophys-forge", ago(2), 100, 3, 12.5, ago(1));
  await check(vitals, "proven");

  // kpi_threshold: a report metric (body.schema, metrics[].metric) and an Observer vitals column.
  const kpi = { kind: "kpi_threshold", source: "report_metric", agent_id: "signal-analyst", body_schema: "trading_organ_health.v1", metric: "hit_rate_7d", op: ">=", value: 0.5, max_age_h: 24 } as AdrPredicate;
  await check(kpi, "open");
  const report = db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at) VALUES (?, 'signal-analyst', 'xauusd_digest', 'info', 's', ?, 'ok', NULL, ?)");
  report.run("rep_other", JSON.stringify({ schema: "something_else.v1", metrics: [{ metric: "hit_rate_7d", value: 0.9 }] }), ago(1));
  await check(kpi, "open");
  report.run("rep_low", JSON.stringify({ schema: "trading_organ_health.v1", metrics: [{ metric: "hit_rate_7d", value: 0.4 }] }), ago(3));
  assert.match((await check(kpi, "open")).reason!, /hit_rate_7d = 0\.4, needs >= 0\.5/);
  report.run("rep_ok", JSON.stringify({ schema: "trading_organ_health.v1", metrics: [{ metric: "hit_rate_7d", value: 0.62 }] }), ago(2));
  const k = await check(kpi, "proven");
  assert.deepEqual(k.refs, [`ev:platform/report/rep_ok@${ago(2)}#metrics.hit_rate_7d`]);
  await check(kpi, "open", { now: NOW + 30 * HOUR });
  const kv = { kind: "kpi_threshold", source: "observer_vitals", subject: "cryptophys-forge", metric: "errors", op: "<=", value: 5, max_age_h: 6 } as AdrPredicate;
  await check(kv, "proven");
  await check({ ...kv, value: 2 }, "open");
  await check({ ...kv, kind_filter: "d1" }, "open");

  // consensus_executed: executed, optionally owner-approved; a pending_owner match is reported as waiting for the click.
  const merge = { kind: "consensus_executed", action: "merge_change" } as AdrPredicate;
  await check(merge, "open");
  proposal(db, "cns_ae_pending", "merge_change", "fg-x", "pending_owner", ago(1));
  const pend = await check(merge, "open");
  assert.deepEqual(pend.pending_owner?.map((p) => p.proposal_id), ["cns_ae_pending"]);
  proposal(db, "cns_ae_failed", "merge_change", "fg-y", "failed", ago(5));
  await check(merge, "open");
  proposal(db, "cns_ae_exec", "merge_change", "fg-z", "executed", ago(4));
  const exec = await check(merge, "proven");
  assert.deepEqual(exec.refs, [`ev:platform/consensus/cns_ae_exec@${ago(4)}`]);
  await check({ ...merge, target: "fg-x" }, "open");
  await check({ ...merge, owner_approved: true }, "open");
  proposal(db, "cns_ae_owner", "merge_change", "fg-w", "executed", ago(3), true);
  await check({ ...merge, owner_approved: true }, "proven");
  await check({ ...merge, since: ago(2) }, "open");

  // agent_registered: the agents table, status enabled unless named.
  await check({ kind: "agent_registered", agent_id: "supervisor" }, "proven");
  await check({ kind: "agent_registered", agent_id: "evolver" }, "open");
  db.raw.prepare("UPDATE agents SET status = 'suspended' WHERE agent_id = 'auditor'").run();
  await check({ kind: "agent_registered", agent_id: "auditor" }, "open");
  await check({ kind: "agent_registered", agent_id: "auditor", status: "suspended" }, "proven");

  // reading: each named reading has its own test (AE2); one here for the kind.
  await check({ kind: "reading", name: "forge_merge_path" }, "proven");

  // doc_asserted: the quote must be in the file; never proven.
  const doc = await check({ kind: "doc_asserted", ref: "docs/GITHUB-CUTOVER.md", quote: "done: merged in #301" }, "doc_asserted");
  assert.deepEqual(doc.refs, ["ev:platform/doc/docs/GITHUB-CUTOVER.md#quote"]);
  await check({ kind: "doc_asserted", ref: "docs/GITHUB-CUTOVER.md", quote: "a sentence that is not there" }, "open");
  await check({ kind: "doc_asserted", ref: "docs/NOT-A-FILE.md", quote: "anything at all" }, "open");
  await check({ kind: "doc_asserted", ref: "docs/GITHUB-CUTOVER.md", quote: "done: merged in #301" }, "unknown", { readFile: undefined });

  // external_asserted: a dated claim the platform cannot read; never proven.
  const ext = await check({ kind: "external_asserted", source: "xauusd", ref: "docs/RFC_ROOM_CELLS.md Status: P2b done", as_of: "2026-11-16" }, "external_asserted");
  assert.equal(ext.at, "2026-11-16T00:00:00.000Z");
  // not_measurable_yet: always that, with its reason as the blocker.
  const nmy = await check({ kind: "not_measurable_yet", reason: "no intents table" }, "not_measurable_yet");
  assert.equal(nmy.reason, "no intents table");

  for (const c of ["all_of", "any_of", "sequence"]) covered.add(c); // AE3
  assert.deepEqual([...covered].sort(), [...ADR_PREDICATE_KINDS].sort(), "every kind of §3 is exercised");
  assertBoundedAndIndexed(db.raw, s.seen);
});

test("AE2. the named readings read real tables, and an unreadable source is unknown, never proven", async () => {
  const db = migratedDb();
  const s = spy(db);
  const r = (name: string, extra: Partial<AdrEvidenceDeps> = {}) => ev(s.db, { kind: "reading", name }, extra);
  const covered = new Set<string>();
  const want = async (name: string, state: string, extra: Partial<AdrEvidenceDeps> = {}) => {
    const x = await r(name, extra);
    assert.equal(x.state, state, `${name}: ${x.reason}`);
    refsOk(x);
    covered.add(name);
    return x;
  };
  // forge_merge_path: migration 0058 set it to forge.
  await want("forge_merge_path", "proven");
  db.raw.prepare("UPDATE forge_controls SET value = 'github' WHERE control = 'merge_path'").run();
  await want("forge_merge_path", "open");
  // forge_work_cr_merged: source forge, status merged.
  await want("forge_work_cr_merged", "open");
  changeRequest(db, "fg-ae2-open", "open", null);
  await want("forge_work_cr_merged", "open");
  changeRequest(db, "fg-ae2", "merged", ago(12));
  assert.equal((await want("forge_work_cr_merged", "proven")).live, false);
  // git_backup_verified_48h: the newest verification, verified and within 48 h.
  await want("git_backup_verified_48h", "open");
  const backup = db.raw.prepare("INSERT INTO forge_git_backups (run_id, main_sha, day, ran_at, status, verified_at, verify_status) VALUES (?, ?, '2026-11-17', ?, 'ok', ?, ?)");
  backup.run("gb_1", "a".repeat(40), ago(30), ago(29), "verified");
  await want("git_backup_verified_48h", "proven");
  await want("git_backup_verified_48h", "open", { now: NOW + 20 * HOUR });
  backup.run("gb_2", "b".repeat(40), ago(5), ago(4), "failed");
  await want("git_backup_verified_48h", "open");
  // dependency_audit_fresh_48h: the newest completed audit within 48 h.
  await want("dependency_audit_fresh_48h", "open");
  const dep = db.raw.prepare("INSERT INTO forge_dependency_audits (run_id, main_sha, ran_at, status) VALUES (?, ?, ?, ?)");
  dep.run("dep_failed", "a".repeat(40), ago(1), "failed");
  await want("dependency_audit_fresh_48h", "open");
  dep.run("dep_ok", "a".repeat(40), ago(10), "ok");
  await want("dependency_audit_fresh_48h", "proven");
  await want("dependency_audit_fresh_48h", "open", { now: NOW + 40 * HOUR });
  // vision_valid: no D1, the bundled vision checked with visionProblems.
  await want("vision_valid", "proven");
  await want("vision_valid", "open", { readFile: (p) => (p === "organism/vision.json" ? "{\"schema\":\"organism.vision.v1\"}" : null) });
  await want("vision_valid", "open", { readFile: () => "not json" });
  await want("vision_valid", "unknown", { readFile: () => { throw new Error("bundle missing"); } });
  // drift_in_sync_all: the newest observation of every service that is not disabled.
  const services = (db.raw.prepare("SELECT service_id FROM service_registry WHERE status != 'disabled'").all() as { service_id: string }[]).map((s) => s.service_id);
  await want("drift_in_sync_all", "open");
  const obs = db.raw.prepare("INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at) VALUES (?, ?, 'd', 'o', ?, '{}', ?)");
  services.forEach((s, i) => obs.run(`do_${i}_old`, s, 1, ago(5)));
  services.forEach((s, i) => obs.run(`do_${i}`, s, 0, ago(2)));
  await want("drift_in_sync_all", "proven");
  obs.run("do_last", services[0], 1, ago(1));
  assert.match((await want("drift_in_sync_all", "open")).reason!, new RegExp(`drifted: ${services[0]}`));
  // adr_index_live: the Steward registered and enabled; adr_progress comes with step 3, so not measurable until then.
  await want("adr_index_live", "open");
  db.raw.prepare(`INSERT INTO agents (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, updated_by, created_at, updated_at)
    VALUES ('adr-steward', 'ADR Steward', 'cryptophys-ai-kernel', 'test', 1, '[]', 'enabled', 'test', ?, ?)`).run(ago(1), ago(1));
  await want("adr_index_live", "not_measurable_yet");
  // orchestrator_github_fallback_absent: no read-only RPC yet; with one, absent is proven.
  await want("orchestrator_github_fallback_absent", "not_measurable_yet");
  await want("orchestrator_github_fallback_absent", "proven", { githubFallback: async () => "absent" });
  await want("orchestrator_github_fallback_absent", "open", { githubFallback: async () => "present" });
  await want("orchestrator_github_fallback_absent", "unknown", { githubFallback: async () => { throw new Error("rpc down"); } });
  assert.deepEqual([...covered].sort(), [...ADR_READINGS].sort(), "every reading of §3 is exercised");
  assert.deepEqual(Object.keys(new AdrEvidenceContext(deps(db)).readings).sort(), [...ADR_READINGS].sort(), "the code implements exactly the fixed list");
  assertBoundedAndIndexed(db.raw, s.seen);
  // A database error is unknown with the source named, never open or proven.
  const broken: AdrEvidenceDb = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("D1_ERROR"); }, all: async () => { throw new Error("D1_ERROR"); } }) }) };
  const u = await ev(broken, { kind: "audit_event", event_type: "forge.merged" });
  assert.equal(u.state, "unknown");
  assert.deepEqual(u.sources, ["audit_events"]);
});

test("AE3. all_of, any_of and sequence nest as §3 says, unknown included", async () => {
  const db = migratedDb();
  const P: AdrPredicate = { kind: "migration_applied", name: "0001_initial.sql" };
  const O: AdrPredicate = { kind: "migration_applied", name: "0999_not_applied.sql" };
  const D: AdrPredicate = { kind: "doc_asserted", ref: "docs/GITHUB-CUTOVER.md", quote: "done: merged in #301" };
  const X: AdrPredicate = { kind: "external_asserted", source: "aether", ref: "a claim", as_of: "2026-11-15" };
  const N: AdrPredicate = { kind: "not_measurable_yet", reason: "nothing measures it" };
  const all = (...of: AdrPredicate[]): AdrPredicate => ({ kind: "all_of", of });
  const any = (...of: AdrPredicate[]): AdrPredicate => ({ kind: "any_of", of });
  const cases: [AdrPredicate, string][] = [
    [all(P, P), "proven"], [all(P, D), "doc_asserted"], [all(D, X), "external_asserted"], [all(P, O), "open"], [all(O, N), "not_measurable_yet"], [all(P, N), "not_measurable_yet"],
    [any(O, D), "doc_asserted"], [any(D, P), "proven"], [any(X, D), "doc_asserted"], [any(O, N), "open"], [any(N), "not_measurable_yet"],
    [all(any(O, P), any(D, N)), "doc_asserted"], [any(all(P, O), all(P, P)), "proven"], [all(any(O, N), P), "open"], [any(all(P, D), all(X, P)), "doc_asserted"],
  ];
  for (const [p, want] of cases) assert.equal(await stateOf(db, p), want, JSON.stringify(p));
  // Unknown (no repository reader): a definite failure still decides; otherwise the result is unknown, never proven.
  const noFiles = { readFile: undefined };
  assert.equal(await stateOf(db, all(D, O), noFiles), "open");
  assert.equal(await stateOf(db, all(D, P), noFiles), "unknown");
  assert.equal(await stateOf(db, any(D, P), noFiles), "proven");
  assert.equal(await stateOf(db, any(D, O), noFiles), "unknown");
  // The open reason names what is missing; an open quiet_window's earliest time survives the combinators.
  const r = await ev(db, all(P, O, N));
  assert.match(r.reason!, /0999_not_applied\.sql is not applied; nothing measures it/);
  audit(db, "test.ae3_fail", ago(1));
  audit(db, "test.ae3_ok", ago(0.5));
  const qw: AdrPredicate = { kind: "quiet_window", fail_types: ["test.ae3_fail"], success_type: "test.ae3_ok", hours: 24 };
  assert.equal((await ev(db, all(P, qw))).earliest, ago(-23));
  assert.equal((await ev(db, any(O, qw))).earliest, ago(-23));
  // A live member makes a combination live; past events alone are sticky.
  assert.equal((await ev(db, all(P, P))).live, false);
  assert.equal((await ev(db, all(P, D))).live, true);

  // sequence: each event after the previous one, found as the first chain; a live reading only has to hold.
  const A: AdrPredicate = { kind: "audit_event", event_type: "test.seq_a" };
  const B: AdrPredicate = { kind: "audit_event", event_type: "test.seq_b" };
  const seq = (...of: AdrPredicate[]): AdrPredicate => ({ kind: "sequence", of });
  assert.equal(await stateOf(db, seq(A, B)), "open");
  audit(db, "test.seq_b", ago(50));
  audit(db, "test.seq_a", ago(40));
  const early = await ev(db, seq(A, B));
  assert.equal(early.state, "open", "B before A is not the sequence");
  assert.match(early.reason!, /step 2 of 2: no test\.seq_b event after/);
  const bLate = audit(db, "test.seq_b", ago(30));
  audit(db, "test.seq_a", ago(20));
  const chain = await ev(db, seq(A, B));
  assert.equal(chain.state, "proven");
  assert.equal(chain.at, ago(30), "the first B after the first A");
  assert.ok(chain.refs.includes(`ev:platform/audit/${bLate}@${ago(30)}`));
  assert.equal(await stateOf(db, seq(B, A)), "proven", "B at -50, then A at -40");
  assert.equal(await stateOf(db, seq(A, B, { kind: "reading", name: "forge_merge_path" })), "proven");
  assert.equal(await stateOf(db, seq(A, B, O)), "open");
  // A consensus vote, then its execution event: G10's shape.
  proposal(db, "cns_seq_retire", "retire_worker", "cryptophys-home", "executed", ago(10), true);
  const g10 = seq({ kind: "consensus_executed", action: "retire_worker", owner_approved: true }, { kind: "audit_event", event_type: "deployment.retire_succeeded", payload: { "$.executor": "native:retire" } });
  audit(db, "deployment.retire_succeeded", ago(11), { executor: "native:retire" });
  assert.equal(await stateOf(db, g10), "open", "retired before the owner's approval");
  audit(db, "deployment.retire_succeeded", ago(9), { executor: "native:retire" });
  assert.equal(await stateOf(db, g10), "proven");
});

const probe = (adr: string, phases: unknown[], extra: Record<string, unknown> = {}) =>
  ({ schema: "adr.progress.v1", adr, title: `Probe ${adr}`, adr_file: null, lifecycle: "held", lifecycle_note: "test only", phases, ...extra });

test("AE4. depends_on chooses the next step and names blockers, and never overrides evidence (§3, §4.4)", async () => {
  const db = migratedDb({ recordLedger: false });
  db.raw.prepare("INSERT INTO d1_migrations (name) VALUES ('0001_initial.sql')").run();
  const P = { kind: "migration_applied", name: "0001_initial.sql" };
  const O = { kind: "migration_applied", name: "0002_service_referential_integrity.sql" };
  const m = probe("9990", [
    { id: "A", title: "A waits for B", depends_on: ["B"], evidence: O, next: "Do A after B" },
    { id: "B", title: "B first", evidence: O },
    { id: "C", title: "C is proven although B is open", depends_on: ["B"], evidence: P, weight: 2 },
    { id: "D", title: "D depends on a phase of another ADR", depends_on: ["9991:Z"], evidence: O },
  ]);
  const e = await evaluateAdrManifest(m, deps(db)) as AdrEvaluation;
  assert.equal(e.valid, true);
  const by = Object.fromEntries(e.phases.map((p) => [p.id, p]));
  assert.equal(by.C.state, "proven", "depends_on does not override evidence");
  assert.deepEqual(by.C.blockers, []);
  assert.deepEqual(by.A.blockers, ["A: migration 0002_service_referential_integrity.sql is not applied", "A: depends on B"]);
  assert.deepEqual(by.D.blockers, ["D: migration 0002_service_referential_integrity.sql is not applied", "D: depends on 9991:Z (not evaluated)"]);
  assert.deepEqual(e.next_step, { phase: "B", text: "B first" }, "the first open phase whose dependencies are complete");
  assert.equal(e.status, "held", "the lifecycle says held; the phases are still computed");
  assert.equal(e.phases_complete, 1);
  assert.equal(e.percent, 40, "weighted: C weighs 2 of 5");
  assert.equal(e.percent_proven, 40);
  assert.deepEqual(e.open.map((o) => o.phase), ["A", "B", "D"]);
  // Across ADRs in one call: 9991:Z proven lets D's dependency through; the next step then follows the order.
  const other = probe("9991", [{ id: "Z", title: "Z", evidence: P }]);
  const [e1] = await evaluateAdrManifests([m, other], deps(db)) as AdrEvaluation[];
  assert.deepEqual(e1.phases.find((p) => p.id === "D")!.blockers, ["D: migration 0002_service_referential_integrity.sql is not applied"]);
  // Once B holds, A is next, with its own `next` text.
  db.raw.prepare("INSERT INTO d1_migrations (name) VALUES ('0002_service_referential_integrity.sql')").run();
  const m2 = probe("9992", [
    { id: "B", title: "B", evidence: P }, { id: "A", title: "A", depends_on: ["B"], evidence: { kind: "migration_applied", name: "0998_not_yet.sql" }, next: "Do A after B" },
  ]);
  assert.deepEqual((await evaluateAdrManifest(m2, deps(db)) as AdrEvaluation).next_step, { phase: "A", text: "Do A after B" });

  // Status from the phases when the lifecycle is accepted: not_started, in_progress, done; deferred is a badge.
  const accepted = (adr: string, phases: unknown[], lifecycle = "accepted") =>
    ({ schema: "adr.progress.v1", adr, title: "Probe", adr_file: `architecture/adr/${adr}-probe.md`, lifecycle, phases });
  const st = async (phases: unknown[], lifecycle?: string) => (await evaluateAdrManifest(accepted("0997", phases, lifecycle), deps(db)) as AdrEvaluation);
  assert.equal((await st([{ id: "X", title: "X", evidence: { kind: "not_measurable_yet", reason: "r" } }])).status, "not_started");
  assert.equal((await st([{ id: "X", title: "X", evidence: P }, { id: "Y", title: "Y", evidence: { kind: "not_measurable_yet", reason: "r" } }])).status, "in_progress");
  const done = await st([{ id: "X", title: "X", evidence: P }, { id: "Y", title: "Y", evidence: { kind: "doc_asserted", ref: "docs/GITHUB-CUTOVER.md", quote: "done: merged in #301" } }], "deferred");
  assert.equal(done.status, "done");
  assert.equal(done.deferred, true);
  assert.equal(done.next_step, null);
  assert.deepEqual([done.phases_proven, done.phases_asserted, done.percent, done.percent_proven], [1, 1, 100, 50]);

  // Drift (§4.8): proof the document says is only built is doc_behind; a "done" document over open evidence is doc_ahead.
  const drift = await st([
    { id: "Q", title: "Q", evidence: P, doc_claim: { state: "built", ref: "docs/GITHUB-CUTOVER.md", quote: "done: merged in #301" } },
    { id: "R", title: "R", evidence: { kind: "migration_applied", name: "0998_not_yet.sql" }, doc_claim: { state: "done", ref: "docs/GITHUB-CUTOVER.md", quote: "no such words here" } },
    { id: "S", title: "S", evidence: { kind: "doc_asserted", ref: "docs/GITHUB-CUTOVER.md", quote: "done: merged in #301" }, doc_claim: { state: "not_built", ref: "docs/GITHUB-CUTOVER.md", quote: "done: merged in #301" } },
  ]);
  assert.deepEqual(drift.drift.map((d) => [d.phase, d.kind]), [["Q", "doc_behind"], ["R", "doc_ahead"]], "an asserted phase gets no finding");
  assert.equal(drift.phases[0].doc_claim!.quote_found, true);
  assert.equal(drift.phases[1].doc_claim!.quote_found, false);
});

/** The evidence ADR-0012's seed (§8.1) needs for 12 proven phases; the 6 asserted ones come from docs/GITHUB-CUTOVER.md. */
function seed0012(db: Db): void {
  audit(db, "forge.bundles_stored", ago(100));                                                         // G2
  audit(db, "deployment.native_deploy_succeeded", ago(200));                                           // G3
  deployment(db, "dr_unit", ago(150), { executor: "native:deploy", outcome: { ok: true, steps: ["cryptophys-console:deployed", "unit:smoke_passed"] } }); // G4A
  proposal(db, "cns_merge", "merge_change", "fg-claude-x", "executed", ago(120));                      // G5 with forge_controls from 0058
  changeRequest(db, "fg-claude-x", "merged", ago(110));                                                // G6, S5
  db.raw.prepare("INSERT INTO forge_dependency_audits (run_id, main_sha, ran_at, status) VALUES ('dep_1', ?, ?, 'ok')").run("a".repeat(40), ago(5)); // G7
  db.raw.prepare("INSERT INTO forge_git_backups (run_id, main_sha, day, ran_at, status, verified_at, verify_status) VALUES ('gb_1', ?, '2026-11-17', ?, 'ok', ?, 'verified')")
    .run("a".repeat(40), ago(7), ago(6));                                                              // G8
  proposal(db, "cns_access", "change_access", "access:cryptophys-cloud-platform", "executed", ago(90), true); // G9
  audit(db, "deployment.rescue_succeeded", ago(80), { executor: "rescue:deployment-orchestrator" });   // GX
  audit(db, "forge.git_backup_written", ago(7));                                                       // S3
  // Open on purpose: W24 (a failure 10 h ago) and G10 (the owner's click pending).
  audit(db, "deployment.native_deploy_failed", ago(10));
  audit(db, "deployment.native_deploy_succeeded", ago(9));
  proposal(db, "cns_retire", "retire_worker", "cryptophys-signal-engine", "pending_owner", ago(2));
  // S4, S5 and G13 read the ledger, which migratedDb() records.
}


test("AE5. the 0012 seed reads 18 of 26 (12 proven, 6 asserted) on matching evidence, and every query is a bounded, indexed SELECT", async () => {
  const db = migratedDb();
  seed0012(db);
  const s = spy(db);
  const all = await evaluateAdrManifests(manifests(), deps(s.db)) as AdrEvaluation[];
  assert.ok(all.every((e) => e.valid), JSON.stringify(all.filter((e) => !e.valid)));
  const e = all.find((x) => x.adr === "0012")!;
  const states = (st: string) => e.phases.filter((p) => p.state === st).map((p) => p.id);
  assert.deepEqual(states("proven"), ["G2", "G3", "G4A", "G5", "G6", "G7", "G8", "G9", "GX", "S3", "S4", "S5"]);
  assert.deepEqual(states("doc_asserted"), ["G1", "G11", "G12", "G13", "S1", "S2"]);
  assert.deepEqual(e.open.map((o) => o.phase), ["G4B", "G4D", "G10", "GB", "W24", "S6", "S7", "S8"]);
  assert.deepEqual([e.status, e.phases_total, e.phases_complete, e.phases_proven, e.phases_asserted, e.percent, e.percent_proven], ["in_progress", 26, 18, 12, 6, 69, 46]);
  assert.deepEqual(e.next_step, { phase: "G4B", text: "First live run of a part B path" });
  assert.ok(e.blockers.includes("W24: earliest 2026-11-18T02:00Z"), JSON.stringify(e.blockers));
  assert.ok(e.blockers.includes("G10: waits for the owner's click (cns_retire)"));
  assert.ok(e.blockers.includes("S6: depends on W24"));
  assert.ok(e.blockers.includes("S8: depends on S7"));
  assert.ok(!e.blockers.some((b) => b.startsWith("G2:")), "a complete phase has no blocker");
  assert.deepEqual(e.owner_actions.map((a) => [a.phase, a.href, a.proposal_id, a.outside_platform]),
    [["G10", "#/consensus", "cns_retire", false], ["G10", "#/owner", null, false], ["S7", null, null, true]]);
  assert.equal(e.stale, false);
  assert.deepEqual(e.drift, [], "G4B, G10 and GB are built and open: the documents agree");
  for (const p of e.phases) p.refs.forEach((r) => assert.match(r, EV_REF, `${p.id}: ${r}`));
  assert.ok(e.phases.find((p) => p.id === "G5")!.refs.includes(`ev:platform/consensus/cns_merge@${ago(120)}`));

  // The other seeds of §8 on the same evidence.
  const row = (id: string) => { const x = all.find((y) => y.adr === id)!; return [x.status, x.phases_complete, x.phases_total, x.percent]; };
  assert.deepEqual(row("0014"), ["in_progress", 1, 9, 11], "E1: merge_change executed");
  assert.equal(all.find((y) => y.adr === "0014")!.deferred, true);
  assert.deepEqual(row("0016"), ["in_progress", 1, 6, 17]);
  assert.deepEqual(row("0017"), ["not_started", 0, 6, 0]);
  assert.deepEqual(row("0018"), ["held", 1, 5, 20]);
  assert.deepEqual(row("0019"), ["planned", 0, 0, 0]);
  assert.deepEqual(row("0015"), ["in_progress", 3, 8, 38]);
  assert.equal(all.find((y) => y.adr === "0015")!.phases_external_asserted, 3);

  // Every query: read-only, bounded by a LIMIT, through an index; a full pass stays well under D1's per-call limit.
  assert.ok(s.seen.length < 150, `${s.seen.length} queries for a full pass`);
  assertBoundedAndIndexed(db.raw, s.seen);
});

test("AE6. an empty database proves nothing: open or not measurable, asserted only by text, unknown without tables", async () => {
  const db = migratedDb({ recordLedger: false });
  db.raw.exec("PRAGMA foreign_keys = OFF");
  for (const { name } of db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('audit_events', 'sqlite_sequence')").all() as { name: string }[]) db.raw.exec(`DELETE FROM "${name}"`);
  const s = spy(db);
  // No repository text either: every phase is open or not measurable, except a manifest's own dated external claim.
  const external = (e: AdrEvaluation, id: string) => manifests().find((m) => m.adr === e.adr)!.phases.find((p) => p.id === id)!.evidence.kind === "external_asserted";
  for (const e of await evaluateAdrManifests(manifests(), deps(s.db, { readFile: () => null })) as AdrEvaluation[]) {
    for (const p of e.phases) {
      if (external(e, p.id)) { assert.equal(p.state, "external_asserted"); continue; }
      assert.ok(p.state === "open" || p.state === "not_measurable_yet", `${e.adr}:${p.id} is ${p.state}`);
    }
    assert.equal(e.phases_proven + e.phases_doc_asserted, 0);
    assert.notEqual(e.status, "done");
    assert.equal(e.stale, false);
  }
  // With the repository's text: documents assert, nothing is proven.
  for (const e of await evaluateAdrManifests(manifests(), deps(s.db)) as AdrEvaluation[]) {
    assert.equal(e.phases_proven, 0, `${e.adr} proves nothing on an empty database`);
    for (const p of e.phases) assert.ok(["open", "not_measurable_yet", "doc_asserted", "external_asserted"].includes(p.state), `${e.adr}:${p.id} is ${p.state}`);
  }
  assertBoundedAndIndexed(db.raw, s.seen);
  // No tables at all: every database read is unknown and the documents are stale, never proven.
  const bare = new FakeD1(new DatabaseSync(":memory:"));
  for (const e of await evaluateAdrManifests(manifests(), deps(bare, { readFile: () => null })) as AdrEvaluation[]) {
    for (const p of e.phases) assert.ok(["open", "not_measurable_yet", "unknown"].includes(p.state) || external(e, p.id), `${e.adr}:${p.id} is ${p.state}`);
    assert.equal(e.phases_proven, 0);
    if (e.phases.some((p) => p.state === "unknown")) { assert.equal(e.stale, true); assert.ok(e.stale_sources.length > 0); }
  }
  const e12 = (await evaluateAdrManifest(manifests().find((m) => m.adr === "0012"), deps(bare, { readFile: () => null }))) as AdrEvaluation;
  assert.ok(e12.stale_sources.includes("audit_events") && e12.stale_sources.includes("d1_migrations"), JSON.stringify(e12.stale_sources));
});

test("AE7. an unknown kind, or a name the evaluator does not map, is refused before any query", async () => {
  const db = migratedDb({ recordLedger: false });
  const s = spy(db);
  const refused = async (p: unknown, where: RegExp) => {
    await assert.rejects(evaluatePredicate(p as AdrPredicate, deps(s.db)), (e: unknown) => e instanceof AdrEvidenceRefused && e.problems.some((x) => where.test(x)));
  };
  await refused({ kind: "sql", query: "SELECT * FROM agents" }, /predicate\.kind: must be one of/);
  await refused({ kind: "all_of", of: [{ kind: "migration_applied", name: "0001_initial.sql" }, { kind: "any_of", of: [{ kind: "shell", cmd: "rm" }] }] }, /predicate\.of\[1\]\.of\[0\]\.kind/);
  await refused({ kind: "audit_event", event_type: "forge.merged", sql: "1=1" }, /predicate\.sql: unknown field/);
  await refused({ kind: "reading", name: "everything_fine" }, /predicate\.name: must be one of/);
  await refused({ kind: "merged_and_deployed", cr_id: "fg-x", unit: "everything" }, /predicate\.unit: must be one of/);
  await refused({ kind: "kpi_threshold", source: "observer_vitals", subject: "x", metric: "requests FROM agents --", op: ">=", value: 1, max_age_h: 1 }, /predicate\.metric: must be one of/);
  await refused({ kind: "observer", source: "runs", kind_filter: "everything" }, /predicate\.kind_filter/);
  await refused({ kind: "observer", source: "vitals" }, /predicate\.subject: required for vitals/);
  assert.equal(s.seen.length, 0, "nothing reached the database");
  // A manifest with an unknown kind is reported invalid with its problems and never computed.
  const bad = { ...manifests().find((m) => m.adr === "0012")!, phases: [{ id: "G1", title: "x", evidence: { kind: "sql", query: "SELECT 1" } }] };
  const e = await evaluateAdrManifest(bad, deps(s.db));
  assert.equal(e.valid, false);
  assert.equal(e.status, "invalid");
  assert.ok(!e.valid && e.problems.some((x) => /phases\[0\]\.evidence\.kind/.test(x)));
  assert.equal(s.seen.length, 0);
  // Times from the ledger and ISO times read the same way.
  assert.equal(isoTime("2026-11-16 10:00:00"), "2026-11-16T10:00:00.000Z");
  assert.equal(isoTime("2026-11-16T10:00:00.000Z"), "2026-11-16T10:00:00.000Z");
  assert.equal(isoTime("not a time"), null);
});
