// Console "Pipelines" (2026-11-08): the manual Platform API form was the only content and no person
// ever used it (24 requests: CI token, consensus, a test client). The page now lists what runs and
// what was deployed, from the Orchestrator's read-only GET /v1/deployments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, CI_JWT, OPERATOR_EMAIL, OPERATOR_JWT, OUTSIDER_JWT, call, migratedDb, signAccessJwt } from "./harness.ts";
import { appendAuditEvent } from "../src/audit.ts";
import orchestrator, { deploymentOrigin, listDeployments, presentDeploymentRequest } from "../../deployment-orchestrator/src/index.ts";

const ROOT = new URL("../../../", import.meta.url);
const SHA = "e0bd92815ac9cbae7481e14e1798238068e4b2a9";

function env(db = migratedDb()) {
  return {
    SERVICE_NAME: "cryptophys-deployment-orchestrator", SERVICE_ENVIRONMENT: "production", API_CONTRACT_VERSION: "v1",
    GH_ACTIONS_TOKEN: "gh-token", DEPLOY_ALLOWED_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL}`,
    OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL,
    DEPLOYMENT_LOCK: {} as never, DB: db,
    ACCESS_TEAM_DOMAIN: "cryptophys.cloudflareaccess.com", ACCESS_AUD: "test-audience-tag",
  };
}
const list = (jwt: string, query = "") => new Request(`https://cryptophys-deployment-orchestrator.example.workers.dev/v1/deployments${query}`, { headers: { "cf-access-jwt-assertion": jwt } });

async function seed(db: ReturnType<typeof migratedDb>) {
  const ins = db.raw.prepare(`INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
    VALUES (?, 'cryptophys-platform-api', ?, ?, ?, NULL, ?, ?, ?, ?)`);
  ins.run("dep_old", SHA, `${CI_CLIENT_ID}`, "succeeded", "k1", JSON.stringify({ workflow: "deploy-platform-api.yml", outcome: { run_url: "https://github.com/x/y/actions/runs/1", conclusion: "success" } }), "2026-11-08T10:00:00Z", "2026-11-08T10:05:00Z");
  ins.run("dep_run", SHA, "consensus:cns_1", "running", "k2", JSON.stringify({ workflow: "deploy-platform-api.yml", proposal_id: "cns_1" }), "2026-11-08T14:00:00Z", "2026-11-08T14:00:01Z");
  ins.run("dep_rb", SHA, "agent:recovery-manager", "approved", "k3", JSON.stringify({ executor: "cloudflare-deployments-api", version_tag: "abc", signature: "SECRET-SIGNATURE" }), "2026-11-08T14:01:00Z", "2026-11-08T14:01:00Z");
  ins.run("dep_bad", SHA, "someone@cryptophys.work", "failed", "k4", JSON.stringify({ outcome: { run_url: "https://evil.example/run", reason: "stale" } }), "2026-11-08T09:00:00Z", "2026-11-08T12:00:00Z");
  await appendAuditEvent(db as never, { event_type: "registry.desired_version_set", actor: CI_CLIENT_ID, subject: "cryptophys-console", outcome: "success", payload: { desired_version: "e0bd92815ac9", previous: "086d3bf94fce" } });
}

test("P1. origin of a deployment in words", () => {
  assert.equal(deploymentOrigin("consensus:cns_1"), "consensus");
  assert.equal(deploymentOrigin("agent:supervisor"), "agent");
  assert.equal(deploymentOrigin("edecae24.access"), "deploy workflow");
  assert.equal(deploymentOrigin("owner@cryptophys.work"), "person");
  assert.equal(deploymentOrigin("orchestrator-client"), "other");
  assert.equal(deploymentOrigin(null), "other");
});

test("P2. a request shows display fields only: no rollback signature, GitHub run links only", () => {
  const rb = presentDeploymentRequest({ request_id: "dep_rb", service_id: "s", requested_version: "v", requested_by: "agent:x", status: "approved",
    details_json: JSON.stringify({ executor: "cloudflare-deployments-api", signature: "SECRET-SIGNATURE" }), created_at: "t", updated_at: "t" });
  assert.equal(rb.workflow, "native rollback");
  assert.doesNotMatch(JSON.stringify(rb), /SECRET-SIGNATURE/);
  const bad = presentDeploymentRequest({ request_id: "d", details_json: JSON.stringify({ outcome: { run_url: "https://evil.example/run" } }) });
  assert.equal(bad.run_url, null);
  assert.equal(presentDeploymentRequest({ request_id: "d", details_json: "not json" }).workflow, null, "bad JSON does not throw");
});

test("P3. the list: active requests and proposals, recent requests, recorded versions", async () => {
  const db = migratedDb();
  await seed(db);
  const out = await listDeployments({ DB: db as never }, 10);
  assert.deepEqual(out.active.requests.map((r: any) => r.request_id).sort(), ["dep_rb", "dep_run"]);
  assert.deepEqual(out.requests.map((r: any) => r.request_id), ["dep_rb", "dep_run", "dep_old", "dep_bad"], "newest first");
  assert.equal(out.requests.find((r: any) => r.request_id === "dep_old")!.run_url, "https://github.com/x/y/actions/runs/1");
  const { at, ...dep } = out.deploys[0] as any;
  assert.deepEqual(dep, { service_id: "cryptophys-console", version: "e0bd92815ac9", previous: "086d3bf94fce", origin: "deploy workflow", actor: CI_CLIENT_ID });
  assert.ok(Date.parse(at));
  assert.equal((await listDeployments({ DB: db as never }, 2)).requests.length, 2, "limit applies");
  assert.equal((await listDeployments({ DB: db as never }, 10_000)).requests.length, 4, "limit is clamped, not an error");
  assert.doesNotMatch(JSON.stringify(out), /SECRET-SIGNATURE/);
});

test("P4. GET /v1/deployments: operators and viewer accounts read; outsiders do not; POST rules unchanged", async () => {
  const db = migratedDb();
  await seed(db);
  const e = env(db);
  const ci = await call(orchestrator, e, list(CI_JWT, "?limit=5"));
  assert.equal(ci.status, 200);
  assert.equal(ci.body.requests.length, 4);
  assert.equal((await call(orchestrator, e, list(OPERATOR_JWT))).status, 200);
  db.raw.prepare("INSERT INTO platform_accounts (email, kind, privilege, status, created_by, created_at, updated_by, updated_at) VALUES ('viewer@cryptophys.work', 'admin', 'viewer', 'active', 'o', 't', 'o', 't')").run();
  const viewerJwt = await signAccessJwt({ email: "viewer@cryptophys.work" });
  assert.equal((await call(orchestrator, e, list(viewerJwt))).status, 200, "a viewer account may read");
  const viewerPost = await call(orchestrator, e, new Request("https://cryptophys-deployment-orchestrator.example.workers.dev/v1/deployments",
    { method: "POST", headers: { "cf-access-jwt-assertion": viewerJwt, "content-type": "application/json" }, body: JSON.stringify({ commit_sha: SHA, confirm_production: "DEPLOY" }) }));
  assert.equal(viewerPost.status, 403, "but may not request a deployment");
  assert.equal((await call(orchestrator, e, list(OUTSIDER_JWT))).status, 403);
  assert.equal((await call(orchestrator, { ...e, OPERATOR_IDENTITIES: undefined }, list(CI_JWT))).status, 503, "unset operator list fails closed");
  assert.equal((await call(orchestrator, e, new Request("https://cryptophys-deployment-orchestrator.example.workers.dev/v1/deployments", { method: "DELETE", headers: { "cf-access-jwt-assertion": CI_JWT } }))).status, 405);
});

test("P5. wiring: the deploy passes the operator lists; the Pipelines page reads the list and keeps the manual form folded", () => {
  const wf = readFileSync(new URL(".github/workflows/deploy-deployment-orchestrator.yml", ROOT), "utf8");
  assert.match(wf, /--var "OPERATOR_IDENTITIES:\$\{OPERATOR_IDENTITIES\}"/);
  assert.match(wf, /--var "APPROVER_IDENTITIES:\$\{APPROVER_IDENTITIES\}"/);
  const page = readFileSync(new URL("workers/console/ui/src/pages/Pipelines.tsx", ROOT), "utf8");
  assert.match(page, /call\("orchestrator\.deployments"/);
  assert.match(page, /Open manual deploy/);
  assert.match(page, /route: "orchestrator\.deploy"/, "the emergency path stays");
});
