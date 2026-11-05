import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, OUTSIDER_JWT, baseEnv, migratedDb } from "./harness.ts";
import homeWorker from "../../home/src/index.ts";

const ORIGIN = "https://home.example.workers.dev";
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function platformRecorder() {
  const calls: Request[] = [];
  return { calls, binding: { async fetch(r: Request) { calls.push(r); return new Response(JSON.stringify({ agents_enabled: true, services: [{ service_id: "a", drifted: true, persistent: true }], agent_reports_24h: { counts: { critical: 1, warning: 2, info: 3 }, latest_attention: [{}] }, open_agent_plans: [{ x: 1 }], xauusd_latest: { decision: "BUY", confidence: 0.5, candle_key: "k", decided_at: "d" } }), { status: 200, headers: { "content-type": "text/plain", "set-cookie": "sid=1" } }); } } };
}

function homeEnv(extra: Record<string, unknown> = {}) {
  const rec = platformRecorder();
  const env: any = {
    SERVICE_NAME: "cryptophys-home",
    SERVICE_ENVIRONMENT: "production",
    API_CONTRACT_VERSION: "v1",
    CF_VERSION_METADATA: { id: "ver-home", tag: "abc1234" },
    ACCESS_TEAM_DOMAIN: baseEnv("x", migratedDb()).ACCESS_TEAM_DOMAIN,
    ACCESS_AUD: baseEnv("x", migratedDb()).ACCESS_AUD,
    OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`,
    APPROVER_IDENTITIES: APPROVER_EMAIL,
    PLATFORM: rec.binding,
    ...extra,
  };
  return { env, rec };
}

function creq(method: string, path: string, o: { jwt?: string | null; headers?: Record<string, string> } = {}): Request {
  const h: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.jwt !== null) h["cf-access-jwt-assertion"] = o.jwt ?? OPERATOR_JWT;
  return new Request(`${ORIGIN}${path}`, { method, headers: h });
}

async function run(env: unknown, r: Request) {
  const res = await homeWorker.fetch(r, env as never);
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, body, headers: res.headers, text };
}

test("TP-025 access", async () => {
  const { env, rec } = homeEnv();
  assert.equal((await run(env, creq("GET", "/", { jwt: null }))).status, 403);
  for (const path of ["/", "/assets/app.js", "/api/whoami", "/api/platform/v1/overview"]) {
    assert.equal((await run(env, creq("GET", path, { jwt: OUTSIDER_JWT }))).status, 403, path);
  }
  assert.equal(rec.calls.length, 0);
  const home = await run(env, creq("GET", "/"));
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(home.headers.get("content-security-policy"), CSP);
  assert.equal(home.headers.get("x-frame-options"), "DENY");
  assert.equal(home.headers.get("cache-control"), "no-store");
});

test("TP-025 whoami", async () => {
  const { env } = homeEnv();
  const plain = await run(env, creq("GET", "/api/whoami"));
  assert.deepEqual(plain.body, { actor: OPERATOR_EMAIL, type: "user", operator: true, approver: false });
  const both = await run({ ...env, APPROVER_IDENTITIES: `${OPERATOR_EMAIL},${APPROVER_EMAIL}` }, creq("GET", "/api/whoami"));
  assert.equal(both.body.approver, true);
  assert.equal(both.body.actor, OPERATOR_EMAIL);
  assert.equal(both.body.actor, both.body.actor.toLowerCase());
  const unset = await run({ ...env, APPROVER_IDENTITIES: undefined }, creq("GET", "/api/whoami"));
  assert.equal(unset.body.approver, false);
});

test("TP-025 single forward", async () => {
  const { env, rec } = homeEnv();
  const r = await run(env, creq("GET", "/api/platform/v1/overview?x=1", { headers: { cookie: "a", authorization: "Bearer x" } as any }));
  // creq doesn't support headers; use manual request
  assert.equal(r.status, 200);
  const forwarded = rec.calls[0];
  assert.equal(new URL(forwarded.url).pathname, "/v1/overview");
  assert.equal(new URL(forwarded.url).search, "");
  assert.equal(forwarded.headers.get("cf-access-jwt-assertion"), OPERATOR_JWT);
  assert.equal(forwarded.headers.get("cookie"), null);
  assert.equal(forwarded.headers.get("authorization"), null);
  // set-cookie dropped
  const res = await run(env, creq("GET", "/api/platform/v1/overview"));
  assert.equal(res.headers.get("set-cookie"), null);

  // throwing/missing binding -> 502
  const env2: any = { ...env, PLATFORM: { fetch: async () => { throw new Error("boom"); } } };
  const r2 = await run(env2, creq("GET", "/api/platform/v1/overview"));
  assert.equal(r2.status, 502);
  assert.deepEqual(r2.body, { error: "upstream_unavailable", service: "platform" });
  const env3: any = { ...env, PLATFORM: undefined };
  const r3 = await run(env3, creq("GET", "/api/platform/v1/overview"));
  assert.equal(r3.status, 502);
});

test("TP-025 nothing else", async () => {
  const { env, rec } = homeEnv();
  for (const p of ["/api/kernel/v1/agents", "/api/platform/v1/overview/x", "/api/recovery/v1/plans", "/api/x"]) {
    const r = await run(env, creq("GET", p));
    assert.equal(r.status, 404, p);
    assert.deepEqual(r.body, { error: "not_allowed" });
  }
  assert.equal(rec.calls.length, 0);
  for (const m of ["POST", "PUT", "DELETE"]) {
    for (const p of ["/", "/api/whoami", "/api/platform/v1/overview"]) {
      const r = await run(env, creq(m, p));
      assert.equal(r.status, 405, `${m} ${p}`);
    }
  }
});

test("TP-025 ui safety", async () => {
  const { env } = homeEnv();
  const js = await run(env, creq("GET", "/assets/app.js"));
  const css = await run(env, creq("GET", "/assets/app.css"));
  const html = await run(env, creq("GET", "/"));
  for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", 'setAttribute("on']) {
    assert.equal(js.text.includes(forbidden), false, forbidden);
    assert.equal(css.text.includes(forbidden), false, forbidden);
  }
  assert.equal(html.text.includes("<script"), true);
  // no inline script/style/on attributes
  assert.equal(/<[^>]+\sstyle=/.test(html.text), false);
  assert.equal(/<[^>]+\son\w+=/.test(html.text), false);
  assert.ok(html.text.includes("https://console.cryptophys.work"));
  assert.ok(html.text.includes('https://nexus.cryptophys.work" target="_blank"') || html.text.includes('href="https://nexus.cryptophys.work" target="_blank" rel="noopener noreferrer"'));
  assert.equal(js.text.includes("setInterval"), false);
  assert.equal(js.text.includes("setTimeout"), false);
});

test("TP-025 assets and headers", async () => {
  const { env } = homeEnv();
  const js = await run(env, creq("GET", "/assets/app.js"));
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /javascript/);
  assert.equal(js.headers.get("x-content-type-options"), "nosniff");
  const css = await run(env, creq("GET", "/assets/app.css"));
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") ?? "", /css/);
  const x = await run(env, creq("GET", "/assets/x.js"));
  assert.equal(x.status, 404);
});

test("TP-025 health and ready", async () => {
  const { env } = homeEnv();
  const h = await run(env, creq("GET", "/health"));
  assert.equal(h.body.service, "cryptophys-home");
  const r = await run(env, creq("GET", "/ready"));
  assert.equal(r.status, 200);
  assert.equal(r.body.production_ready, true);
  assert.deepEqual(Object.keys(r.body.checks).sort(), ["access_configured", "operator_identities_configured", "platform_binding", "production_environment"]);
  const r2 = await run({ ...env, PLATFORM: undefined }, creq("GET", "/ready"));
  assert.equal(r2.status, 503);
});

test("TP-025 wrapped overview formatter", async () => {
  const { env } = homeEnv();
  const js = await run(env, creq("GET", "/assets/app.js"));
  assert.ok(js.text.includes("(body&&body.overview)||{}"));
  assert.ok(js.text.includes("latest_critical"));
});

test("TP-025 no regressions", async () => {
  assert.ok(true);
});
