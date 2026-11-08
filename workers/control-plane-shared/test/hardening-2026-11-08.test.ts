// Hardening 2026-11-08 (docs/RETROSPECTIVE-2026-11-08.md §9, owner-approved except the one-time PIN IdP):
// writes that shape production are an approver's act for a person; the deploy workflows' service
// token keeps operating; smoke-test plans are marked synthetic and hidden; dead routes are gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, CI_JWT, OPERATOR_JWT, OUTSIDER_JWT, baseEnv, call, fakeWorkflow, migratedDb, req, signAccessJwt } from "./harness.ts";
import { requireApproverOrServiceOperator } from "../src/access.ts";
import recovery, { isSyntheticPlan } from "../../recovery-manager/src/index.ts";
import registry from "../../platform-registry/src/index.ts";
import { UI_ROUTES } from "../../console/src/ui/routes.ts";

const ROOT = new URL("../../../", import.meta.url);
const PLAN = { service_id: "cryptophys-platform-api", plan_version: "1", title: "Roll back Platform API", rationale: "Bad release",
  steps: [{ action: "rollback_worker_version", description: "Roll back to the previous version" }] };

test("H1. requireApproverOrServiceOperator: service token → operator rule, person → approver rule", async () => {
  const env: any = { ...baseEnv("x", migratedDb()), APPROVER_IDENTITIES: APPROVER_EMAIL };
  const ok = async (jwt: string) => (await requireApproverOrServiceOperator(req("POST", "/v1/plans", {}, jwt), env)).ok;
  assert.equal(await ok(CI_JWT), true, "CI service token (OPERATOR_IDENTITIES)");
  assert.equal(await ok(APPROVER_JWT), true, "an approver person");
  assert.equal(await ok(OPERATOR_JWT), false, "an operator person is not enough");
  assert.equal(await ok(OUTSIDER_JWT), false);
  assert.equal(await ok(await signAccessJwt({ common_name: "other.access" })), false, "an unknown service token");
  // An approver account from the Users page counts too.
  env.DB.raw.prepare("INSERT INTO platform_accounts (email, kind, privilege, status, created_by, created_at, updated_by, updated_at) VALUES ('acct@cryptophys.work', 'admin', 'approver', 'active', 'o', 't', 'o', 't')").run();
  assert.equal(await ok(await signAccessJwt({ email: "acct@cryptophys.work" })), true);
});

test("H2. plans authored by a service token are synthetic and hidden from the list unless include_synthetic=1", async () => {
  const db = migratedDb();
  const env = { ...baseEnv("cryptophys-recovery-manager", db), RECOVERY_LIFECYCLE: fakeWorkflow().binding, APPROVER_IDENTITIES: APPROVER_EMAIL };
  const byCi = await call(recovery, env, req("POST", "/v1/plans", PLAN));
  assert.equal(byCi.status, 201);
  assert.equal(byCi.body.plan.created_by, CI_CLIENT_ID);
  assert.equal(byCi.body.plan.synthetic, true, "the deploy workflow's verification plan is marked");
  const byPerson = await call(recovery, env, req("POST", "/v1/plans", { ...PLAN, plan_version: "2" }, APPROVER_JWT));
  assert.equal(byPerson.status, 201);
  assert.equal(byPerson.body.plan.synthetic, false);
  assert.equal(isSyntheticPlan({ created_by: "ai:recovery-manager" } as any), false, "agent-drafted plans are real");
  const listed = await call(recovery, env, req("GET", "/v1/plans"));
  assert.deepEqual(listed.body.plans.map((p: any) => p.plan_id), [byPerson.body.plan.plan_id], "the synthetic plan is hidden by default");
  const all = await call(recovery, env, req("GET", "/v1/plans?include_synthetic=1"));
  assert.equal(all.body.plans.length, 2);
  assert.equal((await call(recovery, env, req("GET", `/v1/plans/${byCi.body.plan.plan_id}`))).status, 200, "a synthetic plan is still readable by id");
});

test("H3. registry writes: an operator person is refused, an approver or the deploy token is not; reads stay with operators", async () => {
  const env = { ...baseEnv("cryptophys-platform-registry", migratedDb()), APPROVER_IDENTITIES: APPROVER_EMAIL };
  const dv = (jwt: string) => call(registry, env, req("PUT", "/v1/services/cryptophys-platform-api/desired-version", { desired_version: "823108ad3da4", actor: "a" }, jwt));
  assert.equal((await dv(OPERATOR_JWT)).status, 403);
  assert.equal((await dv(APPROVER_JWT)).status, 200);
  assert.equal((await dv(CI_JWT)).status, 200, "the deploy workflow records versions");
  assert.equal((await call(registry, env, req("GET", "/v1/services/cryptophys-platform-api", undefined, OPERATOR_JWT))).status, 200);
  assert.equal((await call(registry, env, req("GET", "/v1/services", undefined, OPERATOR_JWT))).status, 200);
  assert.equal((await call(registry, env, req("GET", "/v1/services", undefined, OUTSIDER_JWT))).status, 403);
});

test("H4. Console: manual execution routes are gone; plan creation and registry writes are approver-only", () => {
  const ids = new Set(UI_ROUTES.map((r) => r.id));
  assert.equal(ids.has("recovery.execute_start"), false);
  assert.equal(ids.has("recovery.execute_finish"), false);
  for (const id of ["recovery.create", "registry.upsert", "registry.desired_version"]) {
    assert.equal(UI_ROUTES.find((r) => r.id === id)?.approverOnly, true, id);
  }
  const detail = readFileSync(new URL("workers/console/ui/src/pages/RecoveryDetail.tsx", ROOT), "utf8");
  assert.doesNotMatch(detail, /execute_finish|execute_start/, "no page calls the removed routes");
  assert.match(readFileSync(new URL("workers/console/ui/src/pages/Recovery.tsx", ROOT), "utf8"), /include_synthetic/);
  assert.match(readFileSync(new URL("workers/console/ui/src/pages/Infrastructure.tsx", ROOT), "utf8"), /who\.approver/);
});

test("H5. retired workflows and the request-workflow carve-out are gone; one validation workflow remains", () => {
  for (const f of [".github/workflows/request-platform-api-deployment.yml", ".github/workflows/validate.yml"]) {
    assert.equal(existsSync(new URL(f, ROOT)), false, `${f} is retired`);
  }
  assert.doesNotMatch(readFileSync(new URL(".github/workflows/ops-dispatch.yml", ROOT), "utf8"), /request-platform-api-deployment/);
  assert.doesNotMatch(readFileSync(new URL("workers/deployment-orchestrator/src/index.ts", ROOT), "utf8"), /REQUEST_WORKFLOW_PATH/);
  const orch = readFileSync(new URL(".github/workflows/deploy-deployment-orchestrator.yml", ROOT), "utf8");
  assert.doesNotMatch(orch, /Remove the retired ORCHESTRATOR_SHARED_SECRET/);
  assert.match(orch, /ORCHESTRATOR_SHARED_SECRET/, "the fail-closed absence check stays");
  const validate = readFileSync(new URL(".github/workflows/validate-control-plane.yml", ROOT), "utf8");
  assert.match(validate, /\n  platform-api:\n/, "the former validate.yml jobs run here");
});

test("H6. migration 0034 corrects the Signal Analyst purpose without touching capabilities or status", () => {
  const db = migratedDb();
  const row = db.raw.prepare("SELECT purpose, status, capabilities_json FROM agents WHERE agent_id = 'signal-analyst'").get() as any;
  assert.match(row.purpose, /XAUUSD/);
  assert.doesNotMatch(row.purpose, /Signal Engine/);
  assert.ok(row.status && row.capabilities_json);
});
