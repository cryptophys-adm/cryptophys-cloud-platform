// The Deployment Orchestrator's HTTP surface. Owner 2026-11-14: "hapus aja, karena roadmap berikutnya kita kembangkan
// Human Ai Interaction & Collaboration". The manual POST /v1/deployments (a GitHub ref lookup and CI gate, then a
// dispatch of deploy-platform-api.yml) is removed. Every scenario its gate used to decide is kept below and must now
// reach nothing: no GitHub call, no dispatch, no ledger row, no audit event, no lock claim, no AI and no report.
// What stays is tested here and elsewhere: readiness and the read-only list (below, and pipelines.test.ts); the CI
// evidence the consensus fallback's GitHub gate shares (latestRunPerWorkflow, ciGreen; below and consensus-phase3);
// consensus deploys and their workflow fallback (consensus-phase3, native-deploy-g2b/g2c1); native rollback
// (native-rollback-0012).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CI_CLIENT_ID, CI_JWT, OPERATOR_JWT, OPERATOR_EMAIL, accessCertsResponse, call, fakeAi, isAccessCerts, migratedDb, signAccessJwt } from "./harness.ts";
import orchestrator, { ciGreen, DeploymentLock, latestRunPerWorkflow } from "../../deployment-orchestrator/src/index.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** Durable Object namespace backed by real DeploymentLock instances with in-memory storage; counts every lock call. */
function lockNamespace() {
  const objects = new Map<string, DeploymentLock>();
  const ns = {
    calls: 0,
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
      return { fetch: (input: RequestInfo | URL, init?: RequestInit) => { ns.calls++; return objects.get(key)!.fetch(new Request(input as string, init)); } };
    },
  };
  return ns;
}

interface GithubState {
  mainSha: string;
  runs: { workflow_id: number; name: string; path?: string; event?: string; head_branch?: string; status: string; conclusion: string | null; run_number: number; run_attempt?: number }[];
  dispatchStatus: number;
  dispatched: unknown[];
  /** Every GitHub API URL requested. */
  calls: string[];
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
    calls: [],
  };
  // The same GitHub fake the manual path was tested against: had it survived, these requests would succeed.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (isAccessCerts(url)) return accessCertsResponse();
    github.calls.push(url);
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    assert.match(String((init?.headers as Record<string, string>)?.authorization), /^Bearer gh-token$/);
    if (url.endsWith("/git/ref/heads/main")) return reply({ object: { sha: github.mainSha } });
    if (url.endsWith("/status")) return reply({ state: "success", total_count: 0 });
    if (url.includes("/actions/runs?head_sha=")) {
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
  const reports: unknown[] = [];
  return {
    SERVICE_NAME: "cryptophys-deployment-orchestrator",
    SERVICE_ENVIRONMENT: "production",
    API_CONTRACT_VERSION: "v1",
    GH_ACTIONS_TOKEN: "gh-token",
    DEPLOYMENT_LOCK: lockNamespace(),
    DB: db,
    AI: fakeAi({ response: '{"summary":"Routine API release.","risk_level":"low","notes":["All checks passed"]}' }),
    AI_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
    ACCESS_TEAM_DOMAIN: "cryptophys.cloudflareaccess.com",
    ACCESS_AUD: "test-audience-tag",
    OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL}`,
    AGENTS: { whoami: async () => ({}), observe: async () => ({}), syscall: async (...args: unknown[]) => { reports.push(args); return {}; } },
    reports,
  };
}
/** The deploy workflow still sets the old allow-list as a var until the owner removes that line; it must change nothing. */
const staleEnv = () => ({ ...env(), DEPLOY_ALLOWED_IDENTITIES: `${CI_CLIENT_ID}, ${OPERATOR_EMAIL.toUpperCase()}` });
const rows = (e: ReturnType<typeof env>, table: "deployment_requests" | "audit_events") =>
  (e.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n as number;

const deploy = (body: unknown, jwt: string | null = CI_JWT, query = "", method = "POST") =>
  new Request(`https://cryptophys-deployment-orchestrator.example.workers.dev/v1/deployments${query}`, {
    method,
    headers: { ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}), "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const ready = () => new Request("https://cryptophys-deployment-orchestrator.example.workers.dev/ready", { headers: { "cf-access-jwt-assertion": CI_JWT } });

test("readiness requires the migrated schema, the AI binding and the GitHub token (the consensus fallback); no deploy allow-list", async () => {
  const ok = await call(orchestrator, env(), ready());
  assert.equal(ok.status, 200);
  assert.equal(ok.body.production_dispatch_enabled, true);
  assert.equal("deploy_identities_configured" in ok.body.checks, false, "the manual path's allow-list is no readiness check any more");
  const noSchema = await call(orchestrator, env(migratedDb({ recordLedger: false })), ready());
  assert.deepEqual([noSchema.status, noSchema.body.checks.database_schema], [503, false]);
  assert.equal((await call(orchestrator, { ...env(), AI: undefined }, ready())).status, 503);
  const noToken = await call(orchestrator, { ...env(), GH_ACTIONS_TOKEN: "" }, ready());
  assert.deepEqual([noToken.status, noToken.body.checks.github_token_configured], [503, false], "the workflow fallback still needs its token");
  assert.equal((await call(orchestrator, { ...env(), DEPLOY_ALLOWED_IDENTITIES: " " }, ready())).status, 200, "a leftover allow-list var changes nothing");
});

test("an allow-listed, CI-green request with ?advisory=true is no longer served: nothing is looked up, ledgered, dispatched or advised", async () => {
  const e = staleEnv();
  const res = await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY", requested_by: "spoofed@evil" }, OPERATOR_JWT, "?advisory=true"));
  assert.equal(res.status, 405);
  assert.equal(res.body.error, "method_not_allowed");
  assert.equal(res.body.advisory, undefined, "no AI risk summary");
  assert.equal(res.body.request_id, undefined, "no request is created");
  assert.deepEqual(github.dispatched, []);
  assert.deepEqual(github.calls, [], "GitHub is not asked for main's ref or CI");
  assert.equal(rows(e, "deployment_requests"), 0);
  assert.equal(rows(e, "audit_events"), 0);
  assert.equal(e.DEPLOYMENT_LOCK.calls, 0, "no deployment lock is claimed");
  const again = await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }));
  assert.deepEqual([again.status, again.body.error], [405, "method_not_allowed"], "nor for the CI service token");
});

test("AI is never consulted and nothing is reported: a red check meets the same 405 as a green one", async () => {
  const e = staleEnv();
  github.runs.push({ workflow_id: 2, name: "Validate Control Plane Workers", status: "completed", conclusion: "failure", run_number: 3 });
  const res = await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }, CI_JWT, "?advisory=true"));
  assert.deepEqual([res.status, res.body.error], [405, "method_not_allowed"]);
  assert.equal(github.dispatched.length, 0);
  assert.equal((e.AI as any).calls.length, 0);
  assert.equal(e.DB.raw.prepare("SELECT outcome FROM audit_events WHERE event_type = 'deployment.rejected'").get(), undefined, "no rejection is audited");
  assert.equal(e.reports.length, 0, "no agent report is published");
});

test("no identity, body or main state reaches the removed gate; Access still runs first", async () => {
  const e = staleEnv();
  assert.equal((await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }, null))).status, 403, "no Access JWT: Access refuses before routing");
  const stranger = await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }, await signAccessJwt({ common_name: "other-token.access" })));
  assert.deepEqual([stranger.status, stranger.body.error], [405, "method_not_allowed"], "there is no allow-list left to consult");
  const nobody = await call(orchestrator, { ...e, DEPLOY_ALLOWED_IDENTITIES: "" }, deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }));
  assert.equal(nobody.status, 405);
  assert.equal((await call(orchestrator, e, deploy({ commit_sha: "abc", confirm_production: "DEPLOY" }))).status, 405, "the body is not read");
  assert.equal((await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "yes" }))).status, 405);
  assert.equal((await call(orchestrator, e, deploy("{not json"))).status, 405);

  github.mainSha = "f".repeat(40);
  const stale = await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }));
  assert.deepEqual([stale.status, stale.body.error], [405, "method_not_allowed"]);

  github.mainSha = SHA;
  github.dispatchStatus = 422;
  const failed = await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }));
  assert.deepEqual([failed.status, failed.body.manual_reconciliation_required], [405, undefined]);
  assert.equal(rows(e, "deployment_requests"), 0);
  const types = e.DB.raw.prepare("SELECT event_type FROM audit_events ORDER BY rowid").all().map((r: any) => r.event_type);
  assert.deepEqual(types, [], "neither deployment.rejected nor deployment.dispatch_failed");
  assert.deepEqual(github.calls, []);
});

test("the rest of the surface is unchanged: the read-only list, other methods 405, other paths 404", async () => {
  const e = staleEnv();
  github.actionsForbidden = true;
  const list = await call(orchestrator, e, deploy(undefined, OPERATOR_JWT, "?limit=5", "GET"));
  assert.equal(list.status, 200, "GET /v1/deployments, the ledger the Pipelines page shows, stays");
  assert.deepEqual(list.body.requests, []);
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    const res = await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }, CI_JWT, "", method));
    assert.deepEqual([method, res.status], [method, 405]);
  }
  const other = await call(orchestrator, e, new Request("https://cryptophys-deployment-orchestrator.example.workers.dev/v1/deploy", { method: "POST", headers: { "cf-access-jwt-assertion": CI_JWT } }));
  assert.deepEqual([other.status, other.body.error], [404, "not_found"]);
  assert.deepEqual(github.calls, []);
  assert.doesNotMatch(JSON.stringify(list.body), /gh-token/);
});

test("the consensus fallback's CI evidence: scheduled monitoring runs neither block nor satisfy it", async () => {
  // latestRunPerWorkflow is shared by ciGreen, the GitHub-side CI check kept beside the consensus fallback.
  github.runs = [
    { workflow_id: 1, name: "Validate", path: ".github/workflows/validate.yml", event: "push", status: "completed", conclusion: "success", run_number: 8 },
    { workflow_id: 77, name: "Drift Alert", path: ".github/workflows/drift-alert.yml", event: "schedule", status: "completed", conclusion: "failure", run_number: 3 },
    { workflow_id: 77, name: "Drift Alert", path: ".github/workflows/drift-alert.yml", event: "schedule", status: "in_progress", conclusion: null, run_number: 4 },
  ];
  assert.deepEqual(latestRunPerWorkflow(github.runs as never).map((r) => r.name), ["Validate"], "a scheduled run on main does not block");
  assert.deepEqual(latestRunPerWorkflow([{ workflow_id: 77, name: "Drift Alert", event: "schedule", status: "completed", conclusion: "success", run_number: 5 }] as never), [], "a scheduled run alone is not CI evidence");
  github.runs = [
    { workflow_id: 1, name: "Validate Control Plane Workers", event: "push", head_branch: "main", status: "completed", conclusion: "success", run_number: 9 },
    { workflow_id: 77, name: "Drift Alert", event: "schedule", head_branch: "main", status: "completed", conclusion: "failure", run_number: 3 },
  ];
  const gate = await ciGreen("gh-token", SHA);
  assert.equal(gate.green, true, "ciGreen still reads GitHub with the Orchestrator's token");
  assert.deepEqual(gate.workflows, [{ name: "Validate Control Plane Workers", conclusion: "success" }]);
  assert.ok(github.calls.some((u) => u.includes(`/actions/runs?head_sha=${SHA}&event=push`)));
});

test("the consensus fallback's CI evidence: the latest run of each workflow decides; none at all is not green", () => {
  // A failed deploy attempt superseded by a later successful run of the same workflow does not block.
  const superseded = latestRunPerWorkflow([
    { workflow_id: 1, name: "Validate", status: "completed", conclusion: "success", run_number: 7 },
    { workflow_id: 9, name: "Deploy Control Plane", status: "completed", conclusion: "failure", run_number: 2 },
    { workflow_id: 9, name: "Deploy Control Plane", status: "completed", conclusion: "success", run_number: 3 },
  ]);
  assert.deepEqual(superseded.map((r) => [r.name, r.conclusion]), [["Validate", "success"], ["Deploy Control Plane", "success"]]);

  // ...but a failure in the latest run of a workflow blocks.
  const latestFailed = latestRunPerWorkflow([
    { workflow_id: 9, name: "Deploy Control Plane", status: "completed", conclusion: "success", run_number: 3 },
    { workflow_id: 9, name: "Deploy Control Plane", status: "completed", conclusion: "failure", run_number: 4 },
  ]);
  assert.deepEqual(latestFailed.map((r) => r.conclusion), ["failure"]);

  // A re-run attempt of the same run number supersedes the first attempt.
  const rerun = latestRunPerWorkflow([
    { workflow_id: 1, name: "Validate", status: "completed", conclusion: "failure", run_number: 8, run_attempt: 1 },
    { workflow_id: 1, name: "Validate", status: "in_progress", conclusion: null, run_number: 8, run_attempt: 2 },
  ]);
  assert.deepEqual(rerun.map((r) => [r.status, r.run_attempt]), [["in_progress", 2]]);

  assert.deepEqual(latestRunPerWorkflow([]), [], "no CI at all is no evidence");
});
