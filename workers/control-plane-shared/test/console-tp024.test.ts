import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, OUTSIDER_JWT, baseEnv, migratedDb } from "./harness.ts";
import { UI_ROUTES } from "../../console/src/ui/routes.ts";
import consoleWorker, { CONSOLE_ALLOW_LIST, SERVICE_BINDINGS, type ConsoleService } from "../../console/src/index.ts";

const ORIGIN = "https://console.example.workers.dev";
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const UNSAFE = ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", 'setAttribute("on'];

interface Recorder { calls: Request[]; binding: { fetch(r: Request): Promise<Response> } }
function recorder(): Recorder {
  const calls: Request[] = [];
  return { calls, binding: { async fetch(r: Request) { calls.push(r); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }); } } };
}
function consoleEnv() {
  const bindings: Record<string, unknown> = {};
  for (const [service, name] of Object.entries(SERVICE_BINDINGS)) {
    bindings[name] = recorder().binding;
  }
  const env = {
    SERVICE_NAME: "cryptophys-console",
    SERVICE_ENVIRONMENT: "production",
    API_CONTRACT_VERSION: "v1",
    CF_VERSION_METADATA: { id: "ver-console", tag: "abc1234" },
    ACCESS_TEAM_DOMAIN: baseEnv("x", migratedDb()).ACCESS_TEAM_DOMAIN,
    ACCESS_AUD: baseEnv("x", migratedDb()).ACCESS_AUD,
    OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`,
    APPROVER_IDENTITIES: APPROVER_EMAIL,
    ...bindings,
  };
  return env;
}
interface Opts { jwt?: string | null; }
function creq(method: string, path: string, o: Opts = {}): Request {
  const h: Record<string, string> = {};
  if (o.jwt !== null) h["cf-access-jwt-assertion"] = o.jwt ?? OPERATOR_JWT;
  return new Request(`${ORIGIN}${path}`, { method, headers: h });
}
async function run(env: unknown, r: Request) {
  const res = await consoleWorker.fetch(r, env as never);
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* html or text */ }
  return { status: res.status, body, headers: res.headers, text };
}

// PROMPT.md §4, row by row: id, service, method, path, approverOnly, confirm.
const EXPECTED_TABLE: [string, string, string, string, boolean, string | null][] = [
  ["platform.overview", "platform", "GET", "/v1/overview", false, null],
  ["kernel.kernel", "kernel", "GET", "/v1/kernel", false, null],
  ["kernel.status", "kernel", "GET", "/v1/status", false, null],
  ["kernel.reports", "kernel", "GET", "/v1/reports", false, null],
  ["kernel.agents", "kernel", "GET", "/v1/agents", false, null],
  ["kernel.agent", "kernel", "GET", "/v1/agents/{id}", false, null],
  ["kernel.agent_actions", "kernel", "GET", "/v1/agents/{id}/actions", false, null],
  ["kernel.agents_disabled", "kernel", "POST", "/v1/kernel/agents-enabled", false, "AGENTS OFF"],
  ["kernel.agents_enabled", "kernel", "POST", "/v1/kernel/agents-enabled", true, "AGENTS ON"],
  ["kernel.wake", "kernel", "POST", "/v1/agents/{id}/wake", false, "WAKE {id}"],
  ["kernel.suspend", "kernel", "POST", "/v1/agents/{id}/suspend", false, "SUSPEND {id}"],
  ["kernel.resume", "kernel", "POST", "/v1/agents/{id}/resume", true, "RESUME {id}"],
  ["kernel.principal_add", "kernel", "POST", "/v1/agents/{id}/principals", true, "PRINCIPAL {id}"],
  ["kernel.principal_remove", "kernel", "DELETE", "/v1/agents/{id}/principals/{id}", true, "REVOKE {id}"],
  ["recovery.plans", "recovery", "GET", "/v1/plans", false, null],
  ["recovery.plan", "recovery", "GET", "/v1/plans/{id}", false, null],
  ["recovery.create", "recovery", "POST", "/v1/plans", false, "CREATE PLAN"],
  ["recovery.approve", "recovery", "POST", "/v1/plans/{id}/approve", true, "APPROVE {id13}"],
  ["recovery.execute_start", "recovery", "POST", "/v1/plans/{id}/executions", false, "START {id13}"],
  ["recovery.execute_finish", "recovery", "POST", "/v1/plans/{id}/executions", false, "FINISH {id13}"],
  ["recovery.disable", "recovery", "POST", "/v1/plans/{id}/disable", false, "DISABLE {id13}"],
  ["registry.services", "registry", "GET", "/v1/services", false, null],
  ["registry.service", "registry", "GET", "/v1/services/{id}", false, null],
  ["registry.upsert", "registry", "PUT", "/v1/services/{id}", false, "UPDATE {id}"],
  ["registry.desired_version", "registry", "PUT", "/v1/services/{id}/desired-version", false, "VERSION {id}"],
  ["policy.decisions", "policy", "GET", "/v1/decisions", false, null],
  ["policy.decision", "policy", "GET", "/v1/decisions/{id}", false, null],
  ["policy.evaluate", "policy", "POST", "/v1/evaluate", false, null],
  ["drift.list", "drift", "GET", "/v1/drift", false, null],
  ["drift.observe", "drift", "POST", "/v1/observe", false, null],
  ["audit.events", "audit", "GET", "/v1/events", false, null],
  ["audit.event", "audit", "GET", "/v1/events/{id}", false, null],
  ["audit.verify", "audit", "GET", "/v1/verify", false, null],
  ["orchestrator.deploy", "orchestrator", "POST", "/v1/deployments", false, "DEPLOY {sha12}"],
];
const EXPECTED_IDS = EXPECTED_TABLE.map((r) => r[0]);

test("1. route table: exactly the 34 ids with those fields, matching allow-list rows", async () => {
  assert.equal(UI_ROUTES.length, 34);
  assert.deepEqual(UI_ROUTES.map((r) => r.id).sort(), [...EXPECTED_IDS].sort());
  const allowKey = (s: string, m: string, p: string) => `${s} ${m} ${p}`;
  const allowSet = new Set(CONSOLE_ALLOW_LIST.map((r) => allowKey(r.service, r.method, r.path)));
  for (const r of UI_ROUTES) {
    // allow-list uses placeholders; compare pattern by segment
    const matched = CONSOLE_ALLOW_LIST.some((a) => a.service === r.service && a.method === r.method && a.path.split("/").length === r.path.split("/").length && a.path.split("/").every((seg, i) => seg === "{id}" || seg === r.path.split("/")[i]));
    assert.ok(matched, `no allow-list match for ${r.id}`);
  }
  assert.equal(new Set(UI_ROUTES.map((r) => r.id)).size, 34);
  // every field equals §4, in order
  assert.deepEqual(
    UI_ROUTES.map((r) => ({ ...r })),
    EXPECTED_TABLE.map(([id, service, method, path, approverOnly, confirm]) => ({ id, service, method, path, approverOnly, confirm })),
  );
});

test("2. approver flags: exactly the five approverOnly ids", () => {
  const got = UI_ROUTES.filter((r) => r.approverOnly).map((r) => r.id).sort();
  assert.deepEqual(got, ["kernel.agents_enabled","kernel.principal_add","kernel.principal_remove","kernel.resume","recovery.approve"].sort());
});

test("3. confirmations: non-GET have confirm except policy.evaluate and drift.observe; GET have null", () => {
  for (const r of UI_ROUTES) {
    if (r.method === "GET") assert.equal(r.confirm, null, r.id);
    else {
      if (r.id === "policy.evaluate" || r.id === "drift.observe") assert.equal(r.confirm, null, r.id);
      else assert.ok(r.confirm, r.id);
    }
  }
});

test("4. no unsafe DOM or eval in served JS/CSS and HTML has no inline script/style/on*", async () => {
  const env = consoleEnv();
  const js = await run(env, creq("GET", "/assets/app.js", { jwt: OPERATOR_JWT }));
  const css = await run(env, creq("GET", "/assets/app.css", { jwt: OPERATOR_JWT }));
  const html = await run(env, creq("GET", "/", { jwt: OPERATOR_JWT }));
  for (const s of UNSAFE) {
    assert.ok(!js.text.includes(s), `js contains ${s}`);
    assert.ok(!css.text.includes(s), `css contains ${s}`);
    assert.ok(!html.text.includes(s), `html contains ${s}`);
  }
  assert.doesNotMatch(html.text, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html.text, /\sstyle=/i);
  assert.doesNotMatch(html.text, /\son[a-z]+\s*=/i);
});

test("5. assets and headers: referenced assets 200 with right type and security headers; unknown 404; exact CSP; outsider 403", async () => {
  const env = consoleEnv();
  const html = await run(env, creq("GET", "/", { jwt: OPERATOR_JWT }));
  const assets = Array.from(new Set(html.text.match(/\/assets\/[A-Za-z0-9._-]+/g) || []));
  assert.ok(assets.length > 0);
  for (const a of assets) {
    const r = await run(env, creq("GET", a, { jwt: OPERATOR_JWT }));
    assert.equal(r.status, 200, a);
    assert.ok(r.headers.get("x-content-type-options") === "nosniff");
    assert.ok(r.headers.get("cache-control") === "no-store");
    assert.ok(r.headers.get("x-frame-options") === "DENY");
    if (a.endsWith(".js")) assert.match(r.headers.get("content-type") ?? "", /text\/javascript/);
    if (a.endsWith(".css")) assert.match(r.headers.get("content-type") ?? "", /text\/css/);
  }
  const unknown = await run(env, creq("GET", "/assets/x.js", { jwt: OPERATOR_JWT }));
  assert.equal(unknown.status, 404);
  assert.equal(html.headers.get("content-security-policy"), CSP);
  for (const a of assets) {
    const r = await run(env, creq("GET", a, { jwt: OUTSIDER_JWT }));
    assert.equal(r.status, 403, a);
  }
});

test("6. single call path: one fetch( in client, /api/ literals only whoami or built", async () => {
  const env = consoleEnv();
  const js = await run(env, creq("GET", "/assets/app.js", { jwt: OPERATOR_JWT }));
  const fetches = js.text.match(/fetch\(/g) || [];
  assert.equal(fetches.length, 1);
  const literals = js.text.match(/"[^"]*\/api\/[^"]*"/g) || [];
  for (const lit of literals) {
    assert.ok(lit === '"/api/whoami"' || lit === '"/api/"', `unexpected api literal ${lit}`);
  }
});

test("7. embedded table equals JSON.stringify(UI_ROUTES)", async () => {
  const env = consoleEnv();
  const js = await run(env, creq("GET", "/assets/app.js", { jwt: OPERATOR_JWT }));
  const m = js.text.match(/var UI_ROUTES = (\[[\s\S]*?\]);/);
  assert.ok(m, "embedded UI_ROUTES not found");
  assert.equal(m![1], JSON.stringify(UI_ROUTES));
});

test("8. no regressions: the TP-023 server surface is unchanged (allow-list, CSP, whoami, forwarding)", async () => {
  // 33 allow-list rows, untouched by TP-024; the kernel /mcp and audit POST /v1/events stay out.
  assert.equal(CONSOLE_ALLOW_LIST.length, 33);
  assert.ok(!CONSOLE_ALLOW_LIST.some((a) => a.path === "/mcp" || (a.service === "audit" && a.method === "POST")));
  const env = consoleEnv();
  const html = await run(env, creq("GET", "/", { jwt: OPERATOR_JWT }));
  assert.equal(html.headers.get("content-security-policy"), CSP);
  const who = await run(env, creq("GET", "/api/whoami", { jwt: APPROVER_JWT }));
  assert.equal(who.status, 200);
  assert.equal(who.body.approver, true);
  assert.equal(who.body.actor, APPROVER_EMAIL.toLowerCase());
  const mcp = await run(env, creq("GET", "/api/kernel/mcp", { jwt: OPERATOR_JWT }));
  assert.equal(mcp.status, 404);
  assert.equal(mcp.body.error, "not_allowed");
  // console-tp023.test.ts runs unchanged in the same npm test; typecheck, the test count and the
  // console dry-run are verified by the commands recorded in STATUS.md.
});


test("9. SAFE principal identifiers containing @, + and : reach the Worker unencoded", async () => {
  const env = consoleEnv();
  const kernel = recorder();
  (env as Record<string, unknown>).KERNEL = kernel.binding;
  const js = await run(env, creq("GET", "/assets/app.js", { jwt: OPERATOR_JWT }));
  assert.match(js.text, /return String\(v\);/);
  assert.doesNotMatch(js.text, /encodeURIComponent/);

  const identity = "ops@cryptophys.work:svc+1";
  const request = creq("DELETE", `/api/kernel/v1/agents/platform-api/principals/${identity}`);
  request.headers.set("origin", ORIGIN);
  request.headers.set("x-cryptophys-console", "1");
  const response = await run(env, request);
  assert.equal(response.status, 200);
  assert.equal(kernel.calls.length, 1);
  assert.equal(kernel.calls[0].method, "DELETE");
  assert.equal(new URL(kernel.calls[0].url).pathname, `/v1/agents/platform-api/principals/${identity}`);
  assert.ok(!kernel.calls[0].url.includes("%40"));
  assert.ok(!kernel.calls[0].url.includes("%2B"));
  assert.ok(!kernel.calls[0].url.includes("%3A"));
});

test("10. Mission Control reads the actual observe() overview fields", async () => {
  const env = consoleEnv();
  const js = await run(env, creq("GET", "/assets/app.js", { jwt: OPERATOR_JWT }));
  assert.match(js.text, /Array\.isArray\(o\.services\)/);
  assert.match(js.text, /Array\.isArray\(o\.open_agent_plans\)/);
  assert.match(js.text, /reports\.counts/);
  assert.match(js.text, /reports\.latest_critical/);
  for (const key of ["decision", "confidence", "candle_key", "decided_at"]) {
    assert.ok(js.text.includes("x." + key), "missing XAUUSD display field " + key);
  }
  assert.doesNotMatch(js.text, /Object\.keys\(x\)/);
});

test("11. maxLength is applied and approval text states the actual separation-of-duties rule", async () => {
  const env = consoleEnv();
  const js = await run(env, creq("GET", "/assets/app.js", { jwt: OPERATOR_JWT }));
  assert.match(js.text, /PLAIN_PROPS = \[.*"maxLength"/);
  assert.ok(js.text.includes("Approval is recorded under your identity. You cannot approve a plan you authored."));
  assert.ok(!js.text.includes("A different person must start the execution steps."));
});

test("12. audit export defers object URL revocation until after the click task", async () => {
  const env = consoleEnv();
  const js = await run(env, creq("GET", "/assets/app.js", { jwt: OPERATOR_JWT }));
  assert.match(js.text, /setTimeout\(function \(\) \{ URL\.revokeObjectURL\(url\); \}, 0\)/);
});


test("13. confirmation dialog traps Tab focus and wraps in both directions", async () => {
  const env = consoleEnv();
  const js = await run(env, creq("GET", "/assets/app.js", { jwt: OPERATOR_JWT }));
  assert.ok(js.text.includes("modal.querySelectorAll("));
  assert.ok(js.text.includes("if (ev.key !== \"Tab\") return;"));
  assert.ok(js.text.includes("ev.shiftKey && document.activeElement === first"));
  assert.ok(js.text.includes("!ev.shiftKey && document.activeElement === last"));
  assert.ok(js.text.includes("last.focus()"));
  assert.ok(js.text.includes("first.focus()"));
});
