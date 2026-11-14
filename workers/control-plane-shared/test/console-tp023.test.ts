import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, OUTSIDER_JWT, baseEnv, fakeWorkflow, migratedDb, accessEnv } from "./harness.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import recovery from "../../recovery-manager/src/index.ts";
import consoleWorker, { CONSOLE_ALLOW_LIST, SERVICE_BINDINGS, type ConsoleService } from "../../console/src/index.ts";

const ORIGIN = "https://console.example.workers.dev";
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

interface Recorder { calls: Request[]; binding: { fetch(r: Request): Promise<Response> } }

function recorder(reply: () => Response = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "text/plain", "set-cookie": "sid=1", "x-upstream": "1" } })): Recorder {
  const calls: Request[] = [];
  return { calls, binding: { async fetch(r: Request) { calls.push(r); return reply(); } } };
}

/** Fake Workers Static Assets: the SPA shell for any non-file path, a bundle for /assets/*.js. */
export function fakeAssets() {
  const calls: Request[] = [];
  return { calls, binding: { async fetch(r: Request) {
    calls.push(r);
    const p = new URL(r.url).pathname;
    if (p.endsWith(".js")) return new Response("console.log(1)", { headers: { "content-type": "text/javascript", "set-cookie": "a=1" } });
    if (p.endsWith(".css")) return new Response("body{}", { headers: { "content-type": "text/css" } });
    return new Response('<!doctype html><script type="module" src="/assets/index-x.js"></script>', { headers: { "content-type": "text/html", etag: "x" } });
  } } };
}

function consoleEnv(extra: Record<string, unknown> = {}) {
  const recorders = {} as Record<ConsoleService, Recorder>;
  const bindings: Record<string, unknown> = {};
  for (const [service, name] of Object.entries(SERVICE_BINDINGS)) {
    recorders[service as ConsoleService] = recorder();
    bindings[name] = recorders[service as ConsoleService].binding;
  }
  const env = {
    SERVICE_NAME: "cryptophys-console",
    SERVICE_ENVIRONMENT: "production",
    API_CONTRACT_VERSION: "v1",
    CF_VERSION_METADATA: { id: "ver-console", tag: "abc1234" },
    ACCESS_TEAM_DOMAIN: accessEnv().ACCESS_TEAM_DOMAIN,
    ACCESS_AUD: accessEnv().ACCESS_AUD,
    OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`,
    APPROVER_IDENTITIES: APPROVER_EMAIL,
    ASSETS: fakeAssets().binding,
    ...bindings,
    ...extra,
  };
  // Role lookups (GET /v1/accounts/me on the Registry, 2026-11-07) are not forwards of the caller's request.
  const forwards = (r: Recorder) => r.calls.filter((c) => !c.url.includes("/v1/accounts/me")).length;
  const lookups = () => recorders.registry.calls.length - forwards(recorders.registry);
  return { env, recorders, lookups, total: () => Object.values(recorders).reduce((n, r) => n + forwards(r), 0) };
}

interface Opts { jwt?: string | null; origin?: string | null; csrf?: boolean; body?: BodyInit; type?: string; headers?: Record<string, string> }

function creq(method: string, path: string, o: Opts = {}): Request {
  const h: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.jwt !== null) h["cf-access-jwt-assertion"] = o.jwt ?? OPERATOR_JWT;
  if (o.origin !== null && method !== "GET") h.origin = o.origin ?? ORIGIN;
  if (o.csrf !== false && method !== "GET") h["x-cryptophys-console"] = "1";
  if (o.type) h["content-type"] = o.type;
  return new Request(`${ORIGIN}${path}`, { method, headers: h, body: o.body });
}

async function run(env: unknown, r: Request) {
  const res = await consoleWorker.fetch(r, env as never);
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* html or text */ }
  return { status: res.status, body, headers: res.headers, text };
}

const hkeys = (h: Headers): string[] => { const out: string[] = []; h.forEach((_v, k) => out.push(k)); return out.sort(); };
const concrete = (path: string) => { let n = 0; return path.replace(/\{id\}/g, () => `id${++n}`); };

// ---------------------------------------------------------------- criteria

test("1. access: no JWT and outsiders are denied without a forward; operators get the shell with the exact CSP", async () => {
  const { env, total } = consoleEnv();
  assert.equal((await run(env, creq("GET", "/", { jwt: null }))).status, 403);
  assert.equal((await run(env, creq("GET", "/api/platform/v1/overview", { jwt: null }))).status, 403);
  for (const [method, path] of [["GET", "/"], ["GET", "/api/whoami"], ["GET", "/api/platform/v1/overview"], ["POST", "/api/recovery/v1/plans"]]) {
    assert.equal((await run(env, creq(method, path, { jwt: OUTSIDER_JWT }))).status, 403, `${method} ${path}`);
  }
  assert.equal(total(), 0);
  const home = await run(env, creq("GET", "/"));
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(home.headers.get("content-security-policy"), CSP);
  assert.equal(home.headers.get("x-frame-options"), "DENY");
  assert.equal(home.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(home.text, /<script>|style=|innerHTML/);
  const js = await run(env, creq("GET", "/assets/index-x.js"));
  assert.equal(js.status, 200);
  assert.equal(js.headers.get("set-cookie"), null);
  assert.equal(js.headers.get("content-security-policy"), CSP);
  // Assets are behind the operator check too: an outsider never reaches the ASSETS binding.
  const assets = fakeAssets();
  assert.equal((await run({ ...env, ASSETS: assets.binding }, creq("GET", "/assets/index-x.js", { jwt: OUTSIDER_JWT }))).status, 403);
  assert.equal(assets.calls.length, 0);
});

test("2. whoami: operator is not an approver, a dual identity is, and the actor is lower-case", async () => {
  const { env } = consoleEnv();
  const plain = await run(env, creq("GET", "/api/whoami"));
  assert.deepEqual(plain.body, { actor: OPERATOR_EMAIL, type: "user", role: "operator", operator: true, approver: false, owner: false, viewer: false });
  const both = await run({ ...env, APPROVER_IDENTITIES: `${OPERATOR_EMAIL},${APPROVER_EMAIL}` }, creq("GET", "/api/whoami"));
  assert.equal(both.body.approver, true);
  assert.equal(both.body.actor, OPERATOR_EMAIL);
  assert.equal(both.body.actor, both.body.actor.toLowerCase());
});

test("3. allow-list: every row forwards to the right binding; everything else is 404 not_allowed", async () => {
  for (const rule of CONSOLE_ALLOW_LIST) {
    const { env, recorders, total } = consoleEnv();
    const path = concrete(rule.path);
    const res = await run(env, creq(rule.method, `/api/${rule.service}${path}`, rule.method === "GET" ? {} : { body: "{}", type: "application/json" }));
    assert.equal(res.status, 200, `${rule.method} ${rule.service}${rule.path}`);
    assert.equal(total(), 1);
    const [forwarded] = recorders[rule.service].calls;
    assert.equal(forwarded.method, rule.method);
    assert.equal(new URL(forwarded.url).pathname, path);
    assert.equal(new URL(forwarded.url).origin, "https://console.internal");
  }
  const { env, total } = consoleEnv();
  const denied: [string, string][] = [["GET", "/api/kernel/mcp"], ["POST", "/api/kernel/mcp"], ["POST", "/api/audit/v1/events"], ["GET", "/api/recovery/health"],
    ["GET", "/api/ghost/v1/plans"], ["GET", "/api/kernel/v1/kernel/agents-enabled"], ["POST", "/api/platform/v1/overview"], ["DELETE", "/api/recovery/v1/plans/abc"], ["GET", "/api/kernel"]];
  for (const [method, path] of denied) {
    const res = await run(env, creq(method, path, method === "GET" ? {} : { body: "{}", type: "application/json" }));
    assert.deepEqual([res.status, res.body.error], [404, "not_allowed"], `${method} ${path}`);
  }
  assert.equal(total(), 0);
});

test("4. path safety: dot segments, percent escapes and over-long segments are 400 invalid_path", async () => {
  const { env, total } = consoleEnv();
  const paths = ["/api/kernel/..", "/api/kernel/v1/agents/%2e%2e", "/api/kernel/v1/agents/a%2Fb", "/api/kernel/v1/agents/a%40b", `/api/kernel/v1/agents/${"a".repeat(129)}`, "/api/kernel/v1//agents"];
  for (const path of paths) {
    const res = await run(env, creq("GET", path));
    assert.deepEqual([res.status, res.body.error], [400, "invalid_path"], path);
  }
  assert.equal((await run(env, creq("GET", `/api/kernel/v1/agents/${"a".repeat(128)}`))).status, 200);
  assert.equal(total(), 1);
});

test("5. csrf: a POST without Origin, with a foreign Origin or without the custom header is 403 csrf", async () => {
  const { env, total } = consoleEnv();
  const post = { body: "{}", type: "application/json" };
  for (const o of [{ ...post, origin: null }, { ...post, origin: "https://evil.example" }, { ...post, csrf: false }]) {
    const res = await run(env, creq("POST", "/api/recovery/v1/plans", o));
    assert.deepEqual([res.status, res.body.error], [403, "csrf"]);
  }
  assert.equal(total(), 0);
  assert.equal((await run(env, creq("POST", "/api/recovery/v1/plans", post))).status, 200);
});

test("6. header hygiene: only the JWT is forwarded, set-cookie is dropped, the GET query passes and is capped", async () => {
  const { env, recorders } = consoleEnv();
  const browser = { cookie: "session=secret", authorization: "Bearer abc", "x-forwarded-for": "1.2.3.4" };
  const get = await run(env, creq("GET", "/api/kernel/v1/reports?limit=5", { headers: browser }));
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("set-cookie"), null);
  assert.equal(get.headers.get("x-upstream"), null);
  assert.equal(get.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(get.headers.get("x-content-type-options"), "nosniff");
  const [forwardedGet] = recorders.kernel.calls;
  assert.deepEqual(hkeys(forwardedGet.headers), ["cf-access-jwt-assertion"]);
  assert.equal(forwardedGet.headers.get("cf-access-jwt-assertion"), OPERATOR_JWT);
  assert.equal(new URL(forwardedGet.url).search, "?limit=5");

  await run(env, creq("POST", "/api/recovery/v1/plans?x=1", { headers: browser, body: JSON.stringify({ a: 1 }), type: "application/json" }));
  const [forwardedPost] = recorders.recovery.calls;
  assert.deepEqual(hkeys(forwardedPost.headers), ["cf-access-jwt-assertion", "content-type"]);
  assert.equal(new URL(forwardedPost.url).search, "");
  assert.equal(await forwardedPost.text(), JSON.stringify({ a: 1 }));

  const long = await run(env, creq("GET", `/api/kernel/v1/reports?q=${"x".repeat(520)}`));
  assert.equal(long.status, 400);
  assert.equal(recorders.kernel.calls.length, 1);
});

test("7. bodies and failures: >32 KiB is 413, non-JSON is 415, a throwing or missing binding is 502 upstream_unavailable", async () => {
  const { env, total } = consoleEnv();
  const big = await run(env, creq("POST", "/api/recovery/v1/plans", { body: JSON.stringify({ x: "a".repeat(32 * 1024) }), type: "application/json" }));
  assert.equal(big.status, 413);
  const text = await run(env, creq("POST", "/api/recovery/v1/plans", { body: "x=1", type: "text/plain" }));
  assert.equal(text.status, 415);
  assert.equal(total(), 0);
  const throwing = { fetch: async () => { throw new Error("boom"); } };
  const down = await run({ ...env, KERNEL: throwing }, creq("GET", "/api/kernel/v1/status"));
  assert.deepEqual([down.status, down.body], [502, { error: "upstream_unavailable", service: "kernel" }]);
  const missing = await run({ ...env, PLATFORM: undefined }, creq("GET", "/api/platform/v1/overview"));
  assert.deepEqual([missing.status, missing.body.error], [502, "upstream_unavailable"]);
});

test("8. identity is preserved end to end through the real recovery-manager Worker", async () => {
  const db = migratedDb();
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const recoveryEnv = { ...baseEnv("cryptophys-recovery-manager", db), RECOVERY_LIFECYCLE: fakeWorkflow().binding, APPROVER_IDENTITIES: `${OPERATOR_EMAIL},${APPROVER_EMAIL}`, POLICY: {
    evaluate: async (input: Record<string, unknown>) => {
      const parsed = parsePolicyRequest(input);
      if (parsed instanceof Error) throw parsed;
      return decide(policyEnv as never, parsed);
    },
  } };
  const { env } = consoleEnv({ RECOVERY: { fetch: (r: Request) => recovery.fetch(r, recoveryEnv as never) } });
  const post = (path: string, jwt: string, body: unknown) => run(env, creq("POST", path, { jwt, body: JSON.stringify(body), type: "application/json" }));

  const plan = { service_id: "cryptophys-platform-api", plan_version: "1", title: "Roll back Platform API", rationale: "Bad release",
    steps: [{ action: "rollback_worker_version", description: "Roll back to the previous version" }] };
  const created = await post("/api/recovery/v1/plans", OPERATOR_JWT, plan);
  assert.equal(created.status, 201);
  assert.equal(created.body.plan.created_by, OPERATOR_EMAIL);
  const id = created.body.plan.plan_id;

  const self = await post(`/api/recovery/v1/plans/${id}/approve`, OPERATOR_JWT, {});
  assert.deepEqual([self.status, self.body.error], [403, "separation_of_duties"]);
  const approved = await post(`/api/recovery/v1/plans/${id}/approve`, APPROVER_JWT, {});
  assert.equal(approved.status, 200);
  assert.equal(approved.body.plan.status, "approved");
  assert.equal(approved.body.plan.approved_by, APPROVER_EMAIL);
  const row = db.raw.prepare("SELECT approved_by FROM recovery_plans WHERE plan_id = ?").get(id) as any;
  assert.equal(row.approved_by, APPROVER_EMAIL);
});

test("9. health and ready: health matches the deploy filter fields; ready is 200, and 503 without APPROVER_IDENTITIES", async () => {
  const { env } = consoleEnv();
  const health = await run(env, creq("GET", "/health"));
  assert.equal(health.status, 200);
  assert.deepEqual([health.body.status, health.body.service, health.body.environment, health.body.contract_version, health.body.version.id],
    ["ok", "cryptophys-console", "production", "v1", "ver-console"]);
  assert.equal((await run(env, creq("GET", "/health", { jwt: null }))).status, 403);
  const ready = await run(env, creq("GET", "/ready"));
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, "ready");
  assert.equal(ready.body.production_ready, true);
  assert.deepEqual(Object.keys(ready.body.checks), ["production_environment", "access_configured", "operator_identities_configured", "approver_identities_configured", "service_bindings", "ui_assets"]);
  assert.ok(Object.values(ready.body.checks).every((v) => v === true));
  const noApprovers = await run({ ...env, APPROVER_IDENTITIES: undefined }, creq("GET", "/ready"));
  assert.deepEqual([noApprovers.status, noApprovers.body.checks.approver_identities_configured], [503, false]);
});

test("10. no regressions: the allow-list holds exactly the specified rows (typecheck, test count and dry-run are verified by commands)", () => {
  const key = (r: { service: string; method: string; path: string }) => `${r.service} ${r.method} ${r.path}`;
  const keys = CONSOLE_ALLOW_LIST.map(key);
  assert.equal(new Set(keys).size, keys.length);
  // 33 TP-023 rows + 2 read-only consensus rows (ADR-0009 phase 1) + 2 owner-click rows (phase 4) + the agreement report (Wave B) + the mode control + 4 Users page rows (2026-11-07)
  // + 3 knowledge-review rows (TP-028: the list, approve and reject).
  // + 2 read-only Forge rows (ADR-0012 phase 1b: the Code page) + the Forge checks (phase 3)
  // - the manual execution route (hardening 2026-11-08: the AI runs approved plans)
  // + the read-only deployments list (the Pipelines page) + the Forge change requests and deploy plans (ADR-0012 phase 4, shadow) + the organism census (ADR-0013)
  // + the read-only metabolism view and the real Cloudflare usage (owner 2026-11-10).
  // + Aether's read-only overview for the Knowledge page (owner 2026-11-10: learning progress and existing knowledge).
  // + the live AI mesh view (owner 2026-11-11: "halaman AI Mesh ... autonomous dan dinamis").
  // + the Forge's measured Workers Builds minutes (owner 2026-11-12) and its npm dependency audit (ADR-0012 G5).
  // + the approver's acknowledgement of a critical report (ADR-0009 amendment 2026-11-13).
  // + the Owner page's read-only inbox (owner 2026-11-13: one panel for approvals and open critical reports).
  // + the Forge's git bundle backups in R2 (ADR-0012 gate 8).
  // + the Alerts page (owner 2026-11-13): the list, add, change, test, delete.
  // + the Vision page's read-only vision (ADR-0016 T0).
  // + the account-wide Observer's read-only view (owner 2026-11-14).
  assert.equal(keys.length, 69);
  const expected = [
    ...["/v1/kernel", "/v1/status", "/v1/notices", "/v1/owner/inbox", "/v1/reports", "/v1/agents", "/v1/agents/{id}", "/v1/agents/{id}/actions", "/v1/consensus", "/v1/consensus/report", "/v1/consensus/{id}", "/v1/knowledge", "/v1/metabolism", "/v1/mesh", "/v1/alerts", "/v1/vision"].map((p) => `kernel GET ${p}`),
    ...["/v1/kernel/agents-enabled", "/v1/agents/{id}/wake", "/v1/agents/{id}/suspend", "/v1/agents/{id}/resume", "/v1/agents/{id}/principals", "/v1/consensus/{id}/approve", "/v1/consensus/{id}/reject", "/v1/consensus/mode", "/v1/knowledge/{id}/approve", "/v1/knowledge/{id}/reject", "/v1/reports/{id}/acknowledge", "/v1/alerts", "/v1/alerts/{id}", "/v1/alerts/{id}/test"].map((p) => `kernel POST ${p}`),
    "kernel DELETE /v1/agents/{id}/principals/{id}", "kernel DELETE /v1/alerts/{id}",
    ...["/v1/plans", "/v1/plans/{id}"].map((p) => `recovery GET ${p}`),
    ...["/v1/plans", "/v1/plans/{id}/approve", "/v1/plans/{id}/disable"].map((p) => `recovery POST ${p}`),
    ...["/v1/services", "/v1/services/{id}", "/v1/accounts"].map((p) => `registry GET ${p}`),
    ...["/v1/accounts", "/v1/accounts/sync-login", "/v1/accounts/{id}/disable"].map((p) => `registry POST ${p}`),
    ...["/v1/services/{id}", "/v1/services/{id}/desired-version"].map((p) => `registry PUT ${p}`),
    ...["/v1/decisions", "/v1/decisions/{id}"].map((p) => `policy GET ${p}`),
    "policy POST /v1/evaluate",
    ...["/v1/drift", "/v1/drift/{id}"].map((p) => `drift GET ${p}`),
    "drift POST /v1/observe",
    ...["/v1/events", "/v1/events/{id}", "/v1/verify"].map((p) => `audit GET ${p}`),
    "orchestrator GET /v1/deployments",
    "orchestrator POST /v1/deployments",
    "platform GET /v1/overview",
    "platform GET /v1/usage",
    "platform GET /v1/observer",
    "forge GET /v1/forge/status",
    "forge GET /v1/forge/commits",
    "forge GET /v1/forge/checks",
    "forge GET /v1/forge/changes",
    "forge GET /v1/forge/deploy-plans",
    "forge GET /v1/forge/census",
    "forge GET /v1/forge/build-usage",
    "forge GET /v1/forge/dependency-audit",
    "forge GET /v1/forge/git-backup",
    "aether GET /v1/overview",
  ];
  assert.deepEqual([...keys].sort(), [...expected].sort());
  assert.ok(!keys.some((k) => k.includes("mcp")));
  assert.ok(!keys.includes("audit POST /v1/events"));
});
