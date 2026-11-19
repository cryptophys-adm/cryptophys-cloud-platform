// Orchestrator findings A and D (owner "approve all", 2026-11-19).
// A: a recovery_failed item stayed on the Owner page for 24 hours although the Worker was healthy and in sync again,
//    or a later deploy of its unit had succeeded; it is now resolved (recovery-resolution.ts), dropped from the inbox
//    and shown as superseded on the Recovery page.
// D: the Supervisor drafted redeploy_commit for a desired version that was no longer main's head, which the
//    Orchestrator refuses (version_not_current_main); approval now retires such a plan as not_main (and the
//    Supervisor no longer drafts it: ai-kernel.test.ts "supervisor D").
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVER_EMAIL, APPROVER_JWT, OPERATOR_EMAIL, baseEnv, call, migratedDb, req } from "./harness.ts";
import recovery from "../../recovery-manager/src/index.ts";
import { retireSupersededDrafts } from "../../recovery-manager/src/superseded.ts";
import { failedPlanResolution, notMain } from "../src/recovery-resolution.ts";
import { unhandledProblems } from "../../ai-kernel/src/owner-inbox.ts";

type Db = ReturnType<typeof migratedDb>;
const NOW = Date.now();
const H = 3_600_000;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
let seq = 0;

function registry(db: Db, service: string, status: string, seenAgo: number) {
  db.raw.prepare("UPDATE service_registry SET status = ?, updated_at = ? WHERE service_id = ?").run(status, at(seenAgo), service);
}
function observe(db: Db, service: string, drifted: boolean, msAgo: number) {
  db.raw.prepare("INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at) VALUES (?, ?, 'h', ?, ?, '{}', ?)")
    .run(`obs_${seq++}`, service, drifted ? "x" : "h", drifted ? 1 : 0, at(msAgo));
}
function deploy(db: Db, service: string, status: string, msAgo: number) {
  db.raw.prepare("INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, idempotency_key, created_at, updated_at) VALUES (?, ?, 'e1a363e0', 'consensus', ?, ?, ?, ?)")
    .run(`dep_${seq}`, service, status, `k${seq++}`, at(msAgo), at(msAgo));
}
function plan(db: Db, id: string, service: string, status: string, endedAgo: number, reason: string | null = null) {
  db.raw.prepare(`INSERT INTO recovery_plans (plan_id, service_id, plan_version, status, steps_json, created_by, created_at, updated_at, disabled_reason)
    VALUES (?, ?, 'aaaaaaaaaaaa', ?, '{"title":"t","rationale":"r","steps":[{"action":"manual","description":"m"}]}', 'agent:supervisor', ?, ?, ?)`)
    .run(id, service, status, at(endedAgo + H), at(endedAgo), reason);
}

test("RA1. a failed plan is resolved by a later successful deploy of its unit, or by its Worker healthy and in sync since", async () => {
  const db = migratedDb();
  const end = { service_id: "cryptophys-policy-engine", updated_at: at(2 * H) };
  registry(db, "cryptophys-policy-engine", "degraded", 10 * 60_000);
  observe(db, "cryptophys-policy-engine", true, 3 * H);
  assert.equal(await failedPlanResolution(db as never, end), null, "drifted and degraded: still the owner's");
  deploy(db, "cryptophys-ai-kernel", "succeeded", 3 * H);
  deploy(db, "cryptophys-ai-kernel", "failed", H);
  assert.equal(await failedPlanResolution(db as never, end), null, "a deploy before the plan's end, or a failed one, resolves nothing");
  deploy(db, "cryptophys-ai-kernel", "succeeded", H / 2);
  const d = await failedPlanResolution(db as never, end);
  assert.equal(d?.reason, "deployed", "the Control Plane unit holds both Workers");
  assert.match(d!.detail, /a later deploy of control-plane succeeded \(e1a363e, dep_\d+\)/);

  const db2 = migratedDb();
  const console = { service_id: "cryptophys-console", updated_at: at(2 * H) };
  observe(db2, "cryptophys-console", true, 3 * H);
  observe(db2, "cryptophys-console", false, 90 * 60_000);
  registry(db2, "cryptophys-console", "healthy", 3 * H);
  assert.equal(await failedPlanResolution(db2 as never, console), null, "not seen since the plan ended");
  registry(db2, "cryptophys-console", "healthy", 5 * 60_000);
  assert.equal((await failedPlanResolution(db2 as never, console))?.reason, "in_sync");
  observe(db2, "cryptophys-console", true, 60_000);
  assert.equal(await failedPlanResolution(db2 as never, console), null, "drifted again");
  assert.equal(await failedPlanResolution(db2 as never, { ...console, updated_at: "not a time" }), null);
});

test("RA2. the Owner page drops a resolved recovery_failed item and keeps the others", async () => {
  const db = migratedDb();
  for (const s of (db.raw.prepare("SELECT service_id FROM service_registry WHERE status != 'disabled'").all() as { service_id: string }[]).map((r) => r.service_id)) {
    observe(db, s, false, 20 * 60_000);
    registry(db, s, "registered", 5 * 60_000);
  }
  registry(db, "cryptophys-console", "healthy", 5 * 60_000);
  plan(db, "plan_console", "cryptophys-console", "failed", H);
  plan(db, "plan_api", "cryptophys-platform-api", "disabled", 2 * H, "approval_expired");
  plan(db, "plan_forge", "cryptophys-forge", "failed", 3 * H);
  deploy(db, "cryptophys-forge", "succeeded", 2 * H);
  const items = (await unhandledProblems(db as never, NOW)).filter((p) => p.code === "recovery_failed").map((p) => p.subject);
  assert.deepEqual(items, ["plan_api"], "console is healthy and in sync since, the Forge was deployed since; the API is still the owner's");
});

test("RA3. the Recovery page reads the resolution: superseded, with the reason; open plans have none", async () => {
  const db = migratedDb();
  const env = { ...baseEnv("cryptophys-recovery-manager", db), APPROVER_IDENTITIES: `${OPERATOR_EMAIL},${APPROVER_EMAIL}` } as Record<string, unknown>;
  const DONE = "plan_00000000-0000-4000-8000-000000000001", OPEN = "plan_00000000-0000-4000-8000-000000000002";
  plan(db, DONE, "cryptophys-console", "failed", H);
  plan(db, OPEN, "cryptophys-console", "draft", H);
  deploy(db, "cryptophys-console", "succeeded", H / 2);
  const done = await call(recovery, env, req("GET", `/v1/plans/${DONE}`));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.plan.resolution.reason, "deployed");
  assert.equal(done.body.plan.status, "failed", "the record itself is unchanged");
  assert.equal((await call(recovery, env, req("GET", `/v1/plans/${OPEN}`))).body.plan.resolution, null);
});

test("RD1. notMain: a commit that is not a prefix of main's head; never on missing evidence", () => {
  const MAIN = "5d8c92fddaa62fe54f2d30ba13ebb9afd7249200";
  assert.equal(notMain("f54fef2", MAIN), true);
  assert.equal(notMain("5d8c92f", MAIN), false);
  assert.equal(notMain("5D8C92FDDAA6", MAIN), false);
  assert.equal(notMain("f54fef2", null), false, "head unreadable: nothing is retired");
  assert.equal(notMain("unknown", MAIN), false, "not a commit");
  assert.equal(notMain("abc", MAIN), false, "too short to name a commit");
});

test("RD2. approval retires a redeploy plan whose version is no longer main's head (not_main); the sweep does too", async () => {
  const db = migratedDb();
  const env = { ...baseEnv("cryptophys-recovery-manager", db), APPROVER_IDENTITIES: `${OPERATOR_EMAIL},${APPROVER_EMAIL}` } as Record<string, unknown>;
  const OLD = "f54fef24de40", HEAD = "5d8c92fddaa62fe54f2d30ba13ebb9afd7249200";
  db.raw.prepare("UPDATE service_registry SET desired_version = ?, observed_version = '66a48590a063' WHERE service_id = 'cryptophys-console'").run(OLD);
  const steps = [{ action: "redeploy_commit", description: "Redeploy" }, { action: "manual", description: "Confirm" }];
  const make = async () => (await call(recovery, env, req("POST", "/v1/plans", { service_id: "cryptophys-console", plan_version: OLD, title: "Recover", rationale: "drift", steps }))).body.plan.plan_id as string;
  const a = await make();
  const b = await make();
  const fresh = await call(recovery, env, req("POST", `/v1/plans/${a}/approve`, {}, APPROVER_JWT));
  assert.equal(fresh.status, 200, "no Forge plan yet: the head is unreadable, the plan is approved as before");
  db.raw.prepare("INSERT INTO forge_deploy_plans (main_sha, fingerprint, forge_units, forge_at) VALUES (?, 'f', '[]', ?)").run(HEAD, new Date().toISOString());
  const res = await call(recovery, env, req("POST", `/v1/plans/${b}/approve`, {}, APPROVER_JWT));
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "plan_superseded");
  assert.match(res.body.message ?? JSON.stringify(res.body), /no longer main's head/);
  assert.deepEqual({ ...(db.raw.prepare("SELECT status, disabled_reason FROM recovery_plans WHERE plan_id = ?").get(b) as object) }, { status: "disabled", disabled_reason: "not_main" });
  const c = await make();
  assert.deepEqual(await retireSupersededDrafts(db as never), { checked: 1, retired: [{ plan_id: c, reason: "not_main" }] });
});
