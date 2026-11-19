// Owner 2026-11-19: the Owner page's Incidents panel (ai-kernel/src/incidents.ts, GET /v1/incidents). An incident opens on
// a critical report or a native deploy that failed without a full restore; its timeline is joined from existing records;
// its status is derived: open, mitigated (acknowledged), resolved (a later deploy of the unit succeeded and its Workers
// show no drift). The 2026-11-18 21:57 deploy (dep_01b18773) is the first entry and carries its written summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, APPROVER_EMAIL, baseEnv, call, migratedDb, req } from "./harness.ts";
import { listIncidents, INCIDENT_WINDOW_MS } from "../../ai-kernel/src/incidents.ts";
import { INCIDENT_SUMMARIES } from "../../ai-kernel/src/incident-summaries.ts";
import { unitForService } from "../src/deploy-units.ts";
import { readFileSync } from "node:fs";
import kernel from "../../ai-kernel/src/index.ts";

type Db = ReturnType<typeof migratedDb>;
const NOW = Date.parse("2026-11-19T07:00:00.000Z");
const at = (iso: string) => iso;
const REPORT = "rpt_60582ed1-8491-478c-b407-bac5f851258f";
const REQ = "dep_01b18773-20bf-48eb-aa11-382ce83f307a";
const HEAL = "dep_61634e20-c7d2-4fa3-82ad-403b0071a68c";
const CP = [...unitForService("cryptophys-ai-kernel")!.services];
let n = 0;

function request(db: Db, id: string, status: string, version: string, details: object, created: string, updated = created) {
  db.raw.prepare(`INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
    VALUES (?, 'cryptophys-policy-engine', ?, 'x', ?, NULL, ?, ?, ?, ?)`).run(id, version, status, id, JSON.stringify(details), created, updated);
}
function report(db: Db, id: string, subject: string, body: object, created: string, severity = "critical") {
  db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at) VALUES (?, 'deployment-orchestrator', 'platform_digest', ?, ?, ?, 'deterministic', NULL, ?)")
    .run(id, severity, subject, JSON.stringify(body), created);
}
function drift(db: Db, service: string, drifted: boolean, observed: string) {
  n += 1;
  db.raw.prepare("INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at) VALUES (?, ?, 'd', 'o', ?, '{}', ?)")
    .run(`obs_inc_${n}`, service, drifted ? 1 : 0, observed);
}
function audit(db: Db, type: string, subject: string, payload: object, created: string) {
  n += 1;
  db.raw.prepare("INSERT INTO audit_events (event_id, event_type, actor, subject, outcome, payload_json, previous_hash, event_hash, created_at) VALUES (?, ?, 'test', ?, 'x', ?, ?, ?, ?)")
    .run(`evt_inc_${n}`, type, subject, JSON.stringify(payload), `p${n}`, `h${n}`, created);
}

function incidentOf2026_11_18(db: Db) {
  request(db, REQ, "failed", "bf94be10356c" + "0".repeat(28), {
    executor: "native:deploy", unit: "control-plane",
    outcome: { ok: false, reason: "do_migration_tag_not_applied: v8", restored: false, not_restored: ["cryptophys-ai-kernel", "cryptophys-drift-detector", "cryptophys-policy-engine"],
      migrations_applied: ["0082_typed_proposals.sql"], do_migrations: ["cryptophys-ai-kernel:v9"], steps: [] },
  }, at("2026-11-18T21:55:00.000Z"), at("2026-11-18T21:57:40.000Z"));
  report(db, REPORT, "Deploy of control-plane at bf94be10356c failed", { request_id: REQ, reason: "do_migration_tag_not_applied: v8", restored: false }, at("2026-11-18T21:57:49.553Z"));
  drift(db, "cryptophys-ai-kernel", true, at("2026-11-18T22:00:08.000Z"));
}

test("IN1. the 2026-11-18 deploy: open, then mitigated when acknowledged, then resolved by a later deploy with no drift; one joined timeline and its summary", async () => {
  const db = migratedDb();
  incidentOf2026_11_18(db);
  let [i] = (await listIncidents(db as never, NOW)).incidents;
  assert.deepEqual([i.incident_id, i.status, i.unit, i.request_id, i.report_id], [`inc_${REPORT}`, "open", "control-plane", REQ, REPORT]);
  assert.deepEqual(i.services, CP);
  assert.match(i.timeline.find((e) => e.kind === "deploy_failed")!.text, /do_migration_tag_not_applied: v8; D1 migrations applied: 0082_typed_proposals\.sql; Durable Object migrations: cryptophys-ai-kernel:v9; not restored: /);
  // Acknowledged: mitigated.
  db.raw.prepare("INSERT INTO agent_report_acknowledgements (report_id, acknowledged_by, reason, acknowledged_at) VALUES (?, ?, 'production checked; three Workers on bf94be1', ?)")
    .run(REPORT, APPROVER_EMAIL, at("2026-11-18T23:40:00.000Z"));
  audit(db, "deployment.no_path", "cryptophys-policy-engine", { commit_sha: "dd".repeat(20), unit: "control-plane", github_gate: "github_main_not_mirrored", native_deploy: { reason: "d1_migrations_mismatch" } }, at("2026-11-19T00:23:14.000Z"));
  db.raw.prepare(`INSERT INTO recovery_plans (plan_id, service_id, plan_version, status, steps_json, approved_by, last_execution_json, created_by, created_at, updated_at)
    VALUES ('plan_a73526dd-3895-4bc5-9a6e-f99c1a5806dc', 'cryptophys-ai-kernel', ?, 'failed', '{}', 'b@example.com', ?, 'a@example.com', ?, ?)`)
    .run("0a".repeat(20), JSON.stringify({ failed_stage: { id: "step-1", detail: "break-glass deploy not queued: binding_set_outside_config:durable_object_namespace:HUB" } }), at("2026-11-19T02:29:12.000Z"), at("2026-11-19T02:31:08.000Z"));
  [i] = (await listIncidents(db as never, NOW)).incidents;
  assert.deepEqual([i.status, i.mitigated_at, i.resolved_at], ["mitigated", "2026-11-18T23:40:00.000Z", null]);
  assert.match(i.status_reason, /no later deploy of the unit has succeeded yet/);
  // A later deploy succeeded, but a Worker still drifts: still mitigated.
  request(db, HEAL, "succeeded", "47ee2d551de4" + "0".repeat(28), { workflow: "deploy-control-plane.yml", unit: "control-plane" }, at("2026-11-19T05:23:12.000Z"), at("2026-11-19T05:27:00.000Z"));
  for (const s of CP) drift(db, s, s === "cryptophys-ai-kernel", at("2026-11-19T05:30:08.000Z"));
  [i] = (await listIncidents(db as never, NOW)).incidents;
  assert.equal(i.status, "mitigated");
  assert.match(i.status_reason, /still shows drift/);
  // No drift on any Worker of the unit after the deploy: resolved.
  drift(db, "cryptophys-ai-kernel", false, at("2026-11-19T05:45:08.000Z"));
  [i] = (await listIncidents(db as never, NOW)).incidents;
  assert.deepEqual([i.status, i.resolved_at], ["resolved", "2026-11-19T05:45:08.000Z"]);
  assert.deepEqual(i.timeline.map((e) => e.kind), ["deploy_requested", "deploy_failed", "report", "acknowledged", "no_path", "recovery_plan", "deploy_succeeded", "drift_clear"]);
  assert.match(i.timeline.find((e) => e.kind === "recovery_plan")!.text, /failed \(break-glass deploy not queued: binding_set_outside_config/);
  assert.match(i.timeline.find((e) => e.kind === "no_path")!.text, /native d1_migrations_mismatch, GitHub github_main_not_mirrored/);
  assert.ok(!JSON.stringify(i).includes(APPROVER_EMAIL), "no email address in an incident");
  assert.deepEqual(i.summary, INCIDENT_SUMMARIES[`inc_${REPORT}`]);
  assert.ok(i.summary!.lessons.length >= 3);
});

test("IN2. a failed deploy without a full restore and no report opens its own incident; a restored failure, an old one and a non-critical report do not", async () => {
  const db = migratedDb();
  const id = "dep_22222222-2222-4222-8222-222222222222";
  request(db, id, "failed", "ab".repeat(20), { executor: "native:deploy", outcome: { ok: false, reason: "x", restored: false, not_restored: ["cryptophys-ai-kernel"] } }, at("2026-11-19T01:00:00.000Z"));
  request(db, "dep_33333333-3333-4333-8333-333333333333", "failed", "cd".repeat(20), { executor: "native:deploy", outcome: { ok: false, reason: "y", restored: true } }, at("2026-11-19T01:10:00.000Z"));
  request(db, "dep_44444444-4444-4444-8444-444444444444", "failed", "ef".repeat(20), { executor: "native:deploy", outcome: { ok: false, restored: false } }, new Date(NOW - INCIDENT_WINDOW_MS - 60_000).toISOString());
  report(db, "rpt_info", "Daily digest", {}, at("2026-11-19T02:00:00.000Z"), "warning");
  const view = await listIncidents(db as never, NOW);
  assert.deepEqual(view.incidents.map((i) => [i.incident_id, i.status, i.report_id]), [[`inc_${id}`, "open", null]]);
  assert.match(view.incidents[0].title, /failed without a full restore/);
  assert.equal(view.incidents[0].summary, null);
});

test("IN3. a critical report without a deploy: mitigated when acknowledged, resolved when its agent reports it resolved", async () => {
  const db = migratedDb();
  report(db, "rpt_hb", "Executor heartbeat missing", {}, at("2026-11-19T03:00:00.000Z"));
  assert.equal((await listIncidents(db as never, NOW)).incidents[0].status, "open");
  db.raw.prepare("INSERT INTO agent_report_acknowledgements (report_id, acknowledged_by, reason, acknowledged_at) VALUES ('rpt_hb', ?, 'looked at it, executor back', ?)").run(APPROVER_EMAIL, at("2026-11-19T03:10:00.000Z"));
  assert.equal((await listIncidents(db as never, NOW)).incidents[0].status, "mitigated");
  report(db, "rpt_hb_ok", "Resolved: Executor heartbeat missing", {}, at("2026-11-19T03:20:00.000Z"), "info");
  const [i] = (await listIncidents(db as never, NOW)).incidents;
  assert.deepEqual([i.status, i.resolved_at, i.timeline.map((e) => e.kind)], ["resolved", "2026-11-19T03:20:00.000Z", ["report", "acknowledged", "resolved_report"]]);
});

test("IN4. GET /v1/incidents: operators read, other methods are refused", async () => {
  const db = migratedDb();
  incidentOf2026_11_18(db);
  const env = baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL });
  const r = await call(kernel, env as never, req("GET", "/v1/incidents", undefined, OPERATOR_JWT));
  assert.equal(r.status, 200);
  assert.equal(r.body.schema, "incidents.v1");
  assert.equal(r.body.incidents[0].incident_id, `inc_${REPORT}`);
  assert.equal((await call(kernel, env as never, req("POST", "/v1/incidents", {}, OPERATOR_JWT))).status, 405);
  assert.equal((await call(kernel, env as never, req("GET", "/v1/incidents", undefined, null))).status, 403);
});

function notice(db: Db, type: string, items: object[] | undefined, created: string) {
  audit(db, type, "production_unhandled", { fingerprint: "f", count: items?.length ?? 0, title: "t", delivery: "sent", channels: {}, ...(items ? { items } : {}) }, created);
}
const item = (code: string, subject: string, detail: string, since: string | null = null) => ({ key: `${code}:${subject}`, code, subject, detail, since });

test("IN5. owner 2026-11-19: production problems are incidents from the notice history; one about a Worker of an unresolved deploy incident joins its timeline", async () => {
  const db = migratedDb();
  incidentOf2026_11_18(db);
  // An event written before items were kept says nothing per problem.
  notice(db, "owner.notice_opened", undefined, at("2026-11-18T22:10:00.000Z"));
  notice(db, "owner.notice_changed", [
    item("self_unhealthy", "cryptophys-ai-kernel", "AI Kernel is drifted or unhealthy (version_mismatch)", at("2026-11-18T22:05:00.000Z")),
    item("git_backup_unverified", "run_1", "Git backup failed git bundle verify"),
    item("break_glass_deployed", "break_glass:dep_x", "Break-glass deploy succeeded"),
  ], at("2026-11-18T22:22:00.000Z"));
  notice(db, "owner.notice_changed", [item("self_unhealthy", "cryptophys-ai-kernel", "AI Kernel is drifted or unhealthy (version_mismatch)")], at("2026-11-19T01:22:00.000Z"));
  notice(db, "owner.notice_closed", [], at("2026-11-19T05:52:00.000Z"));
  const view = await listIncidents(db as never, NOW);
  const deploy = view.incidents.find((i) => i.incident_id === `inc_${REPORT}`)!;
  assert.deepEqual(deploy.timeline.filter((e) => e.kind.startsWith("problem")).map((e) => [e.kind, e.at]),
    [["problem", "2026-11-18T22:05:00.000Z"], ["problem_cleared", "2026-11-19T05:52:00.000Z"]], "the kernel's drift joins the deploy incident");
  const own = view.incidents.filter((i) => i.incident_id.startsWith("inc_p:"));
  assert.deepEqual(own.map((i) => [i.incident_id, i.status, i.opened_at, i.resolved_at]),
    [["inc_p:git_backup_unverified:run_1@2026-11-18T22:22:00.000Z", "resolved", "2026-11-18T22:22:00.000Z", "2026-11-19T01:22:00.000Z"]], "break_glass_deployed is not an incident");
  // A problem still listed is open.
  notice(db, "owner.notice_opened", [item("deploys_stalled", "deploy_stall:none", "Deploys stalled", at("2026-11-19T06:00:00.000Z"))], at("2026-11-19T06:22:00.000Z"));
  const again = (await listIncidents(db as never, NOW)).incidents.find((i) => i.incident_id.startsWith("inc_p:deploys_stalled"))!;
  assert.deepEqual([again.status, again.opened_at, again.status_reason], ["open", "2026-11-19T06:00:00.000Z", "listed as a production problem no agent is handling"]);
});

test("IN6. the production_unhandled notice events keep each problem as an item (key, code, subject, detail, since)", () => {
  const src = readFileSync(new URL("../../ai-kernel/src/owner-notices.ts", import.meta.url), "utf8");
  assert.match(src, /items: n\.active \? n\.items : \[\]/);
  assert.match(src, /key: `\$\{p\.code\}:\$\{p\.subject\}`/);
});
