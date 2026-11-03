import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CI_CLIENT_ID, CI_JWT, OPERATOR_JWT, OPERATOR_EMAIL, accessCertsResponse, call, fakeAi, isAccessCerts, migratedDb, signAccessJwt } from "./harness.ts";
import orchestrator, { DeploymentLock } from "../../deployment-orchestrator/src/index.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** Durable Object namespace backed by real DeploymentLock instances with in-memory storage. */
function lockNamespace() {
  const objects = new Map<string, DeploymentLock>();
  return {
    idFromName: (name: string) => name,
    get(id: unknown) {
      const key = String(id);
      if (!objects.has(key)) {
        const data = new Map<string, unknown>();
        objects.set(key, new DeploymentLock({
          storage: { get: async (k: string) => data.get(k) as never, put: async (k: string, v: unknown) => { data.set(k, v); } },
          blockConcurrencyWhile: (cb) => cb(),
        }));
      }
      return { fetch: (input: RequestInfo | URL, init?: RequestInit) => objects.get(key)!.fetch(new Request(input as string, init)) };
    },
  };
}

interface GithubState {
  mainSha: string;
  runs: { workflow_id: number; name: string; path?: string; event?: string; status: string; conclusion: string | null; run_number: number }[];
  dispatchStatus: number;
  dispatched: unknown[];
  actionsForbidden?: boolean;
}

let github: GithubState;
const realFetch = globalThis.fetch;

beforeEach(() => {
  github = {
    mainSha: SHA,
    runs: [{ workflow_id: 1, name: "Validate", status: "completed", conclusion: "success", run_number: 7 }],
    dispatchStatus: 204,
    dispatched: [],
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (isAccessCerts(url)) return accessCertsResponse();
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    assert.match(String((init?.headers as Record<string, string>)?.authorization), /^Bearer gh-token$/);
    if (url.endsWith("/git/ref/heads/main")) return reply({ object: { sha: github.mainSha } });
    if (url.endsWith("/status")) return reply({ state: "success", total_count: 0 });
    if (url.includes("/actions/runs?head_sha=")) {
      assert.ok(url.includes(`head_sha=${SHA}`));
      if (github.actionsForbidden) return reply({ message: "Resource not accessible by personal access token" }, 403);
      return reply({ total_count: github.runs.length, workflow_runs: github.runs });
    }
    if (url.endsWith("/dispatches")) {
      github.dispatched.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: github.dispatchStatus });
    }
    throw new Error(`unexpected GitHub call ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function env(db = migratedDb()) {
  return {
    SERVICE_NAME: "cryptophys-deployment-orchestrator",
    SERVICE_ENVIRONMENT: "production",
    API_CONTRACT_VERSION: "v1",
    GH_ACTIONS_TOKEN: "gh-token",
    DEPLOY_ALLOWED_IDENTITIES: `${CI_CLIENT_ID}, ${OPERATOR_EMAIL.toUpperCase()}`,
    DEPLOYMENT_LOCK: lockNamespace(),
    DB: db,
    AI: fakeAi({ response: '{"summary":"Routine API release.","risk_level":"low","notes":["All checks passed"]}' }),
    AI_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
    ACCESS_TEAM_DOMAIN: "cryptophys.cloudflareaccess.com",
    ACCESS_AUD: "test-audience-tag",
  };
}

const deploy = (body: unknown, jwt: string | null = CI_JWT, query = "") =>
  new Request(`https://cryptophys-deployment-orchestrator.example.workers.dev/v1/deployments${query}`, {
    method: "POST",
    headers: { ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const ready = () => new Request("https://cryptophys-deployment-orchestrator.example.workers.dev/ready", { headers: { "cf-access-jwt-assertion": CI_JWT } });

test("readiness requires the migrated schema and AI binding in addition to secrets and lock", async () => {
  assert.equal((await call(orchestrator, env(), ready())).body.production_dispatch_enabled, true);
  const noSchema = await call(orchestrator, env(migratedDb({ recordLedger: false })), ready());
  assert.deepEqual([noSchema.status, noSchema.body.checks.database_schema], [503, false]);
  assert.equal((await call(orchestrator, { ...env(), AI: undefined }, ready())).status, 503);
  const noIdentities = await call(orchestrator, { ...env(), DEPLOY_ALLOWED_IDENTITIES: " " }, ready());
  assert.deepEqual([noIdentities.status, noIdentities.body.checks.deploy_identities_configured], [503, false]);
});

test("authenticated, CI-green request is ledgered, audited, dispatched once and advised", async () => {
  const e = env();
  const res = await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY", requested_by: "spoofed@evil" }, OPERATOR_JWT, "?advisory=true"));
  assert.equal(res.status, 202);
  assert.equal(res.body.status, "production_dispatch_accepted");
  assert.equal(res.body.advisory.status, "ok");
  assert.equal(res.body.advisory.data.risk_level, "low");
  assert.deepEqual(github.dispatched, [{ ref: "main", inputs: { confirm_production: "DEPLOY", commit_sha: SHA } }]);

  const row = e.DB.raw.prepare("SELECT status, requested_by, requested_version FROM deployment_requests WHERE request_id = ?").get(res.body.request_id) as any;
  assert.deepEqual([row.status, row.requested_by, row.requested_version], ["running", OPERATOR_EMAIL, SHA]);
  const evt = e.DB.raw.prepare("SELECT event_type, outcome FROM audit_events WHERE event_id = ?").get(res.body.audit_event_id) as any;
  assert.deepEqual([evt.event_type, evt.outcome], ["deployment.dispatched", "running"]);

  const again = await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }));
  assert.deepEqual([again.status, again.body.error], [409, "duplicate_production_deployment_request"]);
  assert.equal(github.dispatched.length, 1);
});

test("AI is never consulted for the gate: a red check blocks even with a glowing advisory", async () => {
  const e = env();
  github.runs.push({ workflow_id: 2, name: "Validate Control Plane Workers", status: "completed", conclusion: "failure", run_number: 3 });
  const res = await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }, CI_JWT, "?advisory=true"));
  assert.deepEqual([res.status, res.body.error], [409, "ci_not_green"]);
  assert.equal(github.dispatched.length, 0);
  assert.equal((e.AI as any).calls.length, 0);
  const evt = e.DB.raw.prepare("SELECT outcome, payload_json FROM audit_events WHERE event_type = 'deployment.rejected'").get() as any;
  assert.equal(evt.outcome, "ci_not_green");
  assert.match(evt.payload_json, /Validate Control Plane Workers/);
});

test("stale SHA, bad auth, bad input and dispatch failures are handled without dispatching twice", async () => {
  const e = env();
  assert.equal((await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }, null))).status, 403, "no Access JWT");
  const stranger = await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }, await signAccessJwt({ common_name: "other-token.access" })));
  assert.deepEqual([stranger.status, stranger.body.error], [403, "forbidden"], "valid Access identity that is not on the allow-list");
  const nobody = await call(orchestrator, { ...e, DEPLOY_ALLOWED_IDENTITIES: "" }, deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }));
  assert.equal(nobody.status, 403, "an empty allow-list admits nobody");
  assert.equal((await call(orchestrator, e, deploy({ commit_sha: "abc", confirm_production: "DEPLOY" }))).status, 400);
  assert.equal((await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "yes" }))).status, 400);

  github.mainSha = "f".repeat(40);
  const stale = await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }));
  assert.deepEqual([stale.status, stale.body.error], [409, "commit_not_current_main"]);

  github.mainSha = SHA;
  github.dispatchStatus = 422;
  const failed = await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }));
  assert.deepEqual([failed.status, failed.body.manual_reconciliation_required], [502, true]);
  const row = e.DB.raw.prepare("SELECT status FROM deployment_requests WHERE request_id = ?").get(failed.body.request_id) as any;
  assert.equal(row.status, "failed");
  const types = e.DB.raw.prepare("SELECT event_type FROM audit_events ORDER BY rowid").all().map((r: any) => r.event_type);
  assert.deepEqual(types, ["deployment.rejected", "deployment.dispatch_failed"]);
});

test("a CI lookup the token may not read fails closed and names the missing permission", async () => {
  const e = env();
  github.actionsForbidden = true;
  const res = await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }));
  assert.deepEqual([res.status, res.body.error], [502, "github_ci_lookup_failed"]);
  assert.deepEqual(res.body.lookups.workflow_runs, { http_status: 403, required_permission: "Actions: Read" });
  assert.equal(res.body.lookups.commit_status.http_status, 200);
  assert.equal(github.dispatched.length, 0);
  assert.doesNotMatch(JSON.stringify(res.body), /gh-token/);
});

test("scheduled monitoring runs neither block nor satisfy the CI gate", async () => {
  github.runs = [
    { workflow_id: 1, name: "Validate", path: ".github/workflows/validate.yml", event: "push", status: "completed", conclusion: "success", run_number: 8 },
    { workflow_id: 77, name: "Drift Alert", path: ".github/workflows/drift-alert.yml", event: "schedule", status: "completed", conclusion: "failure", run_number: 3 },
    { workflow_id: 77, name: "Drift Alert", path: ".github/workflows/drift-alert.yml", event: "schedule", status: "in_progress", conclusion: null, run_number: 4 },
  ];
  const ok = await call(orchestrator, env(), deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }));
  assert.equal(ok.status, 202, "a scheduled run on main must not block a deployment");
  const dispatchedBefore = github.dispatched.length;
  github.runs = [{ workflow_id: 77, name: "Drift Alert", path: ".github/workflows/drift-alert.yml", event: "schedule", status: "completed", conclusion: "success", run_number: 5 }];
  const onlyScheduled = await call(orchestrator, env(), deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }));
  assert.deepEqual([onlyScheduled.status, onlyScheduled.body.error], [409, "ci_not_green"], "a scheduled run alone is not CI evidence");
  assert.equal(github.dispatched.length, dispatchedBefore);
});

test("trusted main request workflow is excluded from its own CI gate", async () => {
  github.runs = [
    { workflow_id: 1, name: "Validate", path: ".github/workflows/validate.yml", status: "completed", conclusion: "success", run_number: 7 },
    { workflow_id: 405003375, name: "Request Platform API Deployment", path: ".github/workflows/request-platform-api-deployment.yml@refs/heads/main", status: "in_progress", conclusion: null, run_number: 5 },
  ];
  const res = await call(orchestrator, env(), deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }));
  assert.equal(res.status, 202, "the trusted request workflow must not self-block the deployment gate");
  assert.equal(github.dispatched.length, 1);

  // The request workflow alone is not CI evidence; a real validation/deployment run remains required.
  github.runs = [
    { workflow_id: 405003375, name: "Request Platform API Deployment", path: ".github/workflows/request-platform-api-deployment.yml", status: "in_progress", conclusion: null, run_number: 6 },
  ];
  const noCi = await call(orchestrator, env(), deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }));
  assert.deepEqual([noCi.status, noCi.body.error], [409, "ci_not_green"]);
  assert.equal(github.dispatched.length, 1);
});

test("gate uses the latest run of each workflow, requires runs, and blocks in-progress work", async () => {
  // A failed deploy attempt superseded by a later successful run of the same workflow does not block.
  github.runs = [
    { workflow_id: 1, name: "Validate", status: "completed", conclusion: "success", run_number: 7 },
    { workflow_id: 9, name: "Deploy Control Plane", status: "completed", conclusion: "failure", run_number: 2 },
    { workflow_id: 9, name: "Deploy Control Plane", status: "completed", conclusion: "success", run_number: 3 },
  ];
  assert.equal((await call(orchestrator, env(), deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }))).status, 202);

  // ...but a failure in the latest run of a workflow blocks.
  github.runs = [
    { workflow_id: 9, name: "Deploy Control Plane", status: "completed", conclusion: "success", run_number: 3 },
    { workflow_id: 9, name: "Deploy Control Plane", status: "completed", conclusion: "failure", run_number: 4 },
  ];
  const latestFailed = await call(orchestrator, env(), deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }));
  assert.deepEqual([latestFailed.status, latestFailed.body.error], [409, "ci_not_green"]);

  github.runs = [{ workflow_id: 1, name: "Validate", status: "in_progress", conclusion: null, run_number: 8 }];
  assert.equal((await call(orchestrator, env(), deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }))).status, 409);

  github.runs = [];
  assert.equal((await call(orchestrator, env(), deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }))).status, 409, "no CI at all is not green");
});
