import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { call, fakeAi, migratedDb } from "./harness.ts";
import orchestrator, { DeploymentLock } from "../../deployment-orchestrator/src/index.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SECRET = "orchestrator-shared-secret-0123456789";

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
  runs: { name: string; status: string; conclusion: string | null }[];
  dispatchStatus: number;
  dispatched: unknown[];
}

let github: GithubState;
const realFetch = globalThis.fetch;

beforeEach(() => {
  github = {
    mainSha: SHA,
    runs: [{ name: "Type-check platform API", status: "completed", conclusion: "success" }],
    dispatchStatus: 204,
    dispatched: [],
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    assert.match(String((init?.headers as Record<string, string>)?.authorization), /^Bearer gh-token$/);
    if (url.endsWith("/git/ref/heads/main")) return reply({ object: { sha: github.mainSha } });
    if (url.endsWith("/status")) return reply({ state: "success", total_count: 0 });
    if (url.includes("/check-runs")) return reply({ total_count: github.runs.length, check_runs: github.runs });
    if (url.includes("/check-suites")) return reply({ total_count: 1, check_suites: [{ status: "completed", conclusion: github.runs.every((r) => r.conclusion === "success") ? "success" : "failure" }] });
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
    ORCHESTRATOR_SHARED_SECRET: SECRET,
    DEPLOYMENT_LOCK: lockNamespace(),
    DB: db,
    AI: fakeAi({ response: '{"summary":"Routine API release.","risk_level":"low","notes":["All checks passed"]}' }),
    AI_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
    ACCESS_TEAM_DOMAIN: "cryptophys.cloudflareaccess.com",
    ACCESS_AUD: "test-audience-tag",
  };
}

const deploy = (body: unknown, token = SECRET, query = "") =>
  new Request(`https://orchestrator.internal/v1/deployments${query}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("readiness requires the migrated schema and AI binding in addition to secrets and lock", async () => {
  assert.equal((await call(orchestrator, env(), new Request("https://o.internal/ready"))).body.production_dispatch_enabled, true);
  const noSchema = await call(orchestrator, env(migratedDb({ recordLedger: false })), new Request("https://o.internal/ready"));
  assert.deepEqual([noSchema.status, noSchema.body.checks.database_schema], [503, false]);
  assert.equal((await call(orchestrator, { ...env(), AI: undefined }, new Request("https://o.internal/ready"))).status, 503);
});

test("authenticated, CI-green request is ledgered, audited, dispatched once and advised", async () => {
  const e = env();
  const res = await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY", requested_by: "operator@cryptophys" }, SECRET, "?advisory=true"));
  assert.equal(res.status, 202);
  assert.equal(res.body.status, "production_dispatch_accepted");
  assert.equal(res.body.advisory.status, "ok");
  assert.equal(res.body.advisory.data.risk_level, "low");
  assert.deepEqual(github.dispatched, [{ ref: "main", inputs: { confirm_production: "DEPLOY", commit_sha: SHA } }]);

  const row = e.DB.raw.prepare("SELECT status, requested_by, requested_version FROM deployment_requests WHERE request_id = ?").get(res.body.request_id) as any;
  assert.deepEqual([row.status, row.requested_by, row.requested_version], ["running", "operator@cryptophys", SHA]);
  const evt = e.DB.raw.prepare("SELECT event_type, outcome FROM audit_events WHERE event_id = ?").get(res.body.audit_event_id) as any;
  assert.deepEqual([evt.event_type, evt.outcome], ["deployment.dispatched", "running"]);

  const again = await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }));
  assert.deepEqual([again.status, again.body.error], [409, "duplicate_production_deployment_request"]);
  assert.equal(github.dispatched.length, 1);
});

test("AI is never consulted for the gate: a red check blocks even with a glowing advisory", async () => {
  const e = env();
  github.runs.push({ name: "Validate", status: "completed", conclusion: "failure" });
  const res = await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }, SECRET, "?advisory=true"));
  assert.deepEqual([res.status, res.body.error], [409, "ci_not_green"]);
  assert.equal(github.dispatched.length, 0);
  assert.equal((e.AI as any).calls.length, 0);
  const evt = e.DB.raw.prepare("SELECT outcome, payload_json FROM audit_events WHERE event_type = 'deployment.rejected'").get() as any;
  assert.equal(evt.outcome, "ci_not_green");
  assert.match(evt.payload_json, /Validate/);
});

test("stale SHA, bad auth, bad input and dispatch failures are handled without dispatching twice", async () => {
  const e = env();
  assert.equal((await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY" }, "wrong"))).status, 401);
  assert.equal((await call(orchestrator, e, deploy({ commit_sha: "abc", confirm_production: "DEPLOY" }))).status, 400);
  assert.equal((await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "yes" }))).status, 400);
  assert.equal((await call(orchestrator, e, deploy({ commit_sha: SHA, confirm_production: "DEPLOY", requested_by: "a b" }))).status, 400);

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
