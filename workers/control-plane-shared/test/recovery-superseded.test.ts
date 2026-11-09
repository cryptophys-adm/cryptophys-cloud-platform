// 2026-11-09: the owner was shown a supervisor draft from 2026-11-08 22:07 asking to redeploy the
// Forge at 6fafa095ce3e, while the Forge already ran the newer desired version 5bc3c94. A draft
// redeploy plan that a later deploy made unnecessary is now refused at approval and retired by the
// hourly sweep, with an audit event.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVER_EMAIL, APPROVER_JWT, OPERATOR_EMAIL, baseEnv, call, migratedDb, req } from "./harness.ts";
import recovery from "../../recovery-manager/src/index.ts";
import { retireSupersededDrafts, sameVersion, supersededReason } from "../../recovery-manager/src/superseded.ts";

type Db = ReturnType<typeof migratedDb>;
const OLD = "6fafa095ce3e";
const NEW = "5bc3c94b14d1";
const REDEPLOY = [{ action: "redeploy_commit", description: "Redeploy the desired version" }, { action: "manual", description: "Confirm" }];

function envFor(db: Db = migratedDb()) {
  return { db, env: { ...baseEnv("cryptophys-recovery-manager", db), APPROVER_IDENTITIES: `${OPERATOR_EMAIL},${APPROVER_EMAIL}` } as Record<string, unknown> };
}
function registry(db: Db, desired: string | null, observed: string | null, service = "cryptophys-console") {
  db.raw.prepare("UPDATE service_registry SET desired_version = ?, observed_version = ? WHERE service_id = ?").run(desired, observed, service);
}
async function draft(env: Record<string, unknown>, version: string, steps = REDEPLOY, service = "cryptophys-console"): Promise<string> {
  const created = await call(recovery, env, req("POST", "/v1/plans", { service_id: service, plan_version: version, title: "Recover", rationale: "drift", steps }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.plan.plan_id as string;
}
const row = (db: Db, id: string) => ({ ...(db.raw.prepare("SELECT status, disabled_reason FROM recovery_plans WHERE plan_id = ?").get(id) as { status: string; disabled_reason: string | null }) });

test("RS1. version matching and the reason: superseded, drift resolved, or still needed", () => {
  assert.equal(sameVersion("6fafa095ce3e", "6fafa095ce3e1234567890abcdef1234567890ab"), true);
  assert.equal(sameVersion("6FAFA09", "6fafa095ce3e"), true);
  assert.equal(sameVersion("6fafa09", "5bc3c94"), false);
  assert.equal(sameVersion("abc", "abc"), false, "too short to name a commit");
  assert.equal(sameVersion("not-a-sha", "not-a-sha"), false);
  const plan = (v: string, steps: unknown = { steps: REDEPLOY }) => ({ plan_id: "p", service_id: "s", plan_version: v, status: "draft", steps_json: JSON.stringify(steps) });
  assert.equal(supersededReason(plan(OLD), { desired_version: NEW, observed_version: NEW }), "superseded");
  assert.equal(supersededReason(plan(OLD), { desired_version: NEW, observed_version: OLD }), "superseded", "desired moved on, whatever runs");
  assert.equal(supersededReason(plan(NEW), { desired_version: NEW, observed_version: NEW }), "drift_resolved");
  assert.equal(supersededReason(plan(NEW), { desired_version: NEW, observed_version: OLD }), null, "still drifted: the plan is still needed");
  assert.equal(supersededReason(plan(NEW), { desired_version: NEW, observed_version: null }), null, "unknown running version: keep it");
  assert.equal(supersededReason(plan(OLD), { desired_version: null, observed_version: NEW }), null, "no desired version: nothing to compare");
  assert.equal(supersededReason(plan(OLD, { steps: [{ action: "rollback_worker_version" }] }), { desired_version: NEW, observed_version: NEW }), null, "only redeploy plans");
  assert.equal(supersededReason({ ...plan(OLD), status: "approved" }, { desired_version: NEW, observed_version: NEW }), null, "only drafts");
});

test("RS2. approval refuses a superseded redeploy plan and disables it, with an audit event", async () => {
  const { db, env } = envFor();
  registry(db, OLD, "66a48590a063");
  const id = await draft(env, OLD);
  registry(db, NEW, NEW); // a normal deploy fixed it later
  const res = await call(recovery, env, req("POST", `/v1/plans/${id}/approve`, {}, APPROVER_JWT));
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "plan_superseded");
  assert.deepEqual(row(db, id), { status: "disabled", disabled_reason: "superseded" });
  const audit = db.raw.prepare("SELECT actor, payload_json FROM audit_events WHERE event_type = 'recovery.plan_superseded'").get() as { actor: string; payload_json: string };
  assert.equal(audit.actor, APPROVER_EMAIL);
  assert.deepEqual(JSON.parse(audit.payload_json), { service_id: "cryptophys-console", plan_version: OLD, reason: "superseded", desired_version: NEW, observed_version: NEW });
  assert.equal((await call(recovery, env, req("POST", `/v1/plans/${id}/approve`, {}, APPROVER_JWT))).body.error, "invalid_state", "it cannot be approved later");
});

test("RS3. approval refuses a redeploy plan whose drift is already resolved; a still-needed plan is approved as before", async () => {
  const { db, env } = envFor();
  registry(db, NEW, "66a48590a063");
  const resolved = await draft(env, NEW);
  const needed = await draft(env, NEW);
  registry(db, NEW, NEW);
  assert.equal((await call(recovery, env, req("POST", `/v1/plans/${resolved}/approve`, {}, APPROVER_JWT))).body.error, "plan_superseded");
  assert.deepEqual(row(db, resolved), { status: "disabled", disabled_reason: "drift_resolved" });
  registry(db, NEW, "66a48590a063"); // drifted again
  const ok = await call(recovery, env, req("POST", `/v1/plans/${needed}/approve`, {}, APPROVER_JWT));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.plan.status, "approved");
});

test("RS4. the hourly sweep retires only drafts that are no longer needed; scheduled() runs it", async () => {
  const { db, env } = envFor();
  registry(db, OLD, "66a48590a063");
  const stale = await draft(env, OLD);
  const manual = await draft(env, OLD, [{ action: "manual", description: "Inspect logs" }]);
  registry(db, NEW, "66a48590a063");
  const current = await draft(env, NEW);
  const out = await retireSupersededDrafts(db as never);
  assert.deepEqual(out, { checked: 3, retired: [{ plan_id: stale, reason: "superseded" }] });
  assert.equal(row(db, stale).status, "disabled");
  assert.equal(row(db, manual).status, "draft", "a manual plan is the owner's call");
  assert.equal(row(db, current).status, "draft", "the service is still drifted from the plan's version");
  assert.equal((await retireSupersededDrafts(db as never)).retired.length, 0, "idempotent");
  // scheduled(): the D1 backup and the sweep both run.
  registry(db, NEW, NEW);
  const waits: Promise<unknown>[] = [];
  await recovery.scheduled({} as never, env as never, { waitUntil: (p: Promise<unknown>) => { waits.push(p.catch(() => undefined)); } } as never);
  await Promise.all(waits);
  assert.deepEqual(row(db, current), { status: "disabled", disabled_reason: "drift_resolved" });
  const actors = db.raw.prepare("SELECT DISTINCT actor FROM audit_events WHERE event_type = 'recovery.plan_superseded'").all().map((a: any) => a.actor);
  assert.deepEqual(actors, ["system:recovery-sweep"]);
});
