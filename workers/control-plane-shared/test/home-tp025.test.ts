import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, OUTSIDER_JWT, baseEnv, migratedDb } from "./harness.ts";
import homeWorker from "../../home/src/index.ts";
import { summarize } from "../../home/src/ui/summary.ts";
import { APP_JS } from "../../home/src/ui/app-js.ts";

const ORIGIN = "https://home.example.workers.dev";
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function platformRecorder() {
  const calls: Request[] = [];
  return { calls, binding: { async fetch(r: Request) { calls.push(r); return new Response(JSON.stringify({ agents_enabled: true, services: [{ service_id: "a", drifted: true, persistent: true }], agent_reports_24h: { counts: { critical: 1, warning: 2, info: 3 }, latest_critical: [{}] }, open_agent_plans: [{ x: 1 }], xauusd_latest: { decision: "BUY", confidence: 0.5, candle_key: "k", decided_at: "d" } }), { status: 200, headers: { "content-type": "text/plain", "set-cookie": "sid=1" } }); } } };
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

test("TP-025 wrapped overview formatter is behavioural", () => {
  const result = summarize({
    overview: {
      agents_enabled: true,
      services: [{ service_id: "cryptophys-policy-engine", drifted: true, persistent: false }],
      agent_reports_24h: { counts: { critical: 0, warning: 1, info: 12 }, latest_critical: [{ report_id: "r1" }] },
      open_agent_plans: [{ plan_id: "p1" }],
      xauusd_latest: { decision: "BUY", confidence: 0.75, candle_key: "candle-1", decided_at: "2026-11-06T00:00:00.000Z" },
    },
  });
  assert.equal(result.agents, "running");
  assert.equal(result.drift, 1);
  assert.deepEqual(result.driftIds, ["cryptophys-policy-engine"]);
  assert.equal(result.critical, 0);
  assert.equal(result.warning, 1);
  assert.equal(result.info, 12);
  assert.equal(result.latestCritical, 1);
  assert.equal(result.plans, 1);
  assert.deepEqual(result.xauusd, {
    decision: "BUY",
    confidence: 0.75,
    candle_key: "candle-1",
    decided_at: "2026-11-06T00:00:00.000Z",
  });
  assert.ok(APP_JS.includes(summarize.toString()));
});

test("TP-025 summary distinguishes unknown, stopped, none and unavailable", () => {
  assert.deepEqual(summarize({}), {
    agents: "unknown",
    drift: "unknown",
    driftIds: "unknown",
    critical: "unknown",
    warning: "unknown",
    info: "unknown",
    latestCritical: "unknown",
    plans: "unknown",
    xauusd: { decision: "unknown", confidence: "unknown", candle_key: "unknown", decided_at: "unknown" },
  });
  const stopped = summarize({ overview: { agents_enabled: false } });
  assert.equal(stopped.agents, "stopped (kill switch)");
  assert.equal(stopped.drift, "unknown");
  assert.deepEqual(summarize({ overview: { xauusd_latest: null } }).xauusd, {
    decision: "none", confidence: "none", candle_key: "none", decided_at: "none",
  });
  assert.deepEqual(summarize({ overview: { xauusd_latest: { error: "x" } } }).xauusd, {
    decision: "unavailable", confidence: "unavailable", candle_key: "unavailable", decided_at: "unavailable",
  });
  assert.deepEqual(summarize({ xauusd_latest: { error: "x" } }).xauusd, {
    decision: "unavailable", confidence: "unavailable", candle_key: "unavailable", decided_at: "unavailable",
  });
});

test("TP-025 layout, navigation and cards", async () => {
  const { env } = homeEnv();
  const html = await run(env, creq("GET", "/"));
  const js = await run(env, creq("GET", "/assets/app.js"));
  const css = await run(env, creq("GET", "/assets/app.css"));
  assert.equal((html.text.match(/id="refresh"/g) ?? []).length, 1);
  assert.ok(html.text.indexOf('<main id="main">') < html.text.indexOf('<button type="button" id="refresh">'));
  assert.ok(html.text.includes('<a href="/" id="nav-home" aria-current="page">Home</a>'));
  assert.ok(html.text.includes("XAUUSD room (separate site until phase 2)"));
  assert.ok(html.text.includes('target="_blank" rel="noopener noreferrer"'));
  assert.ok(css.text.includes("grid-template-columns:220px 1fr"));
  assert.ok(css.text.includes("flex-direction:column"));
  assert.ok(css.text.includes("@media (max-width:720px){body{display:block}nav{flex-direction:row;flex-wrap:wrap"));
  assert.ok(css.text.includes("--bg:#0f1419"));
  assert.ok(css.text.includes("--card:#171d24"));
  assert.ok(css.text.includes("--border:#2a323c"));
  for (const expected of ["Platform status", "XAUUSD (display only)", "Operator console: agents, recovery, registry, policy, audit, deploy.", "XAUUSD room. Opens in a new tab."]) {
    assert.ok(js.text.includes(expected), expected);
  }
});

test("TP-025 no regressions", async () => {
  const { env } = homeEnv();
  const home = await run(env, creq("GET", "/"));
  assert.equal(home.status, 200);
  assert.equal(home.headers.get("content-security-policy"), CSP);
  const who = await run(env, creq("GET", "/api/whoami"));
  assert.equal(who.body.operator, true);
  const denied = await run(env, creq("GET", "/api/kernel/v1/agents"));
  assert.equal(denied.status, 404);
  assert.deepEqual(denied.body, { error: "not_allowed" });
});

test("TP-025 Home Worker Wrangler dry-run bundle", () => {
  const outDir = mkdtempSync(join(tmpdir(), "dry-home-tp025-"));
  try {
    const result = spawnSync("npx", [
      "wrangler", "deploy", "--dry-run",
      "--config", "../home/wrangler.toml",
      "--outdir", outDir,
    ], { encoding: "utf8" });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    assert.equal(result.status, 0, output);
    assert.equal(result.error, undefined, String(result.error ?? ""));
    const uploadLine = output.split(/\\r?\\n/).find((line) => line.includes("Total Upload:"));
    assert.ok(uploadLine, output);
    assert.ok(output.includes("--dry-run: exiting now."), output);
    console.log(uploadLine);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
