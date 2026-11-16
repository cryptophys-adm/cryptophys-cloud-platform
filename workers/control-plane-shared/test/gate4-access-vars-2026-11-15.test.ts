// ADR-0012 G6 gate 4, part A (owner 2026-11-15, "1 setuju"): the native deploy repeats the deploy workflows' smoke
// tests through Cloudflare Access (native-smoke.ts) and carries their deploy-time --var values from the active
// version, checked before the upload and verified after it (deploy-vars.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accessCertsResponse, baseEnv, call, CI_JWT, isAccessCerts, migratedDb } from "./harness.ts";
import orchestrator from "../../deployment-orchestrator/src/index.ts";
import { DEPLOY_UNITS, unitForService } from "../src/deploy-units.ts";
import { executeNativeDeploy, nativeDeployEligible, type BundleWorker, type PlannedService } from "../../deployment-orchestrator/src/native-deploy.ts";
import { SMOKE_SECRETS, SMOKE_TABLE, SmokeRunner, smokeToken, type SmokeProbe } from "../../deployment-orchestrator/src/native-smoke.ts";
import { DEPLOY_VARS, DEPLOY_VAR_SOURCES, deployVarsConsistent, keptDeployVars, verifyDeployVars, type DeployVarReference } from "../../deployment-orchestrator/src/deploy-vars.ts";
import { parseToml } from "../../deployment-orchestrator/src/config-diff.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const ACCOUNT = "a".repeat(32);
const OLD = "0c".repeat(20);
const NEW = "4d".repeat(20);
const TAG = NEW.slice(0, 12);
const SUBDOMAIN = "cryptophys";
const CLIENT_ID = "ci0123456789abcdef.access";
const CLIENT_SECRET = "s3cr3t-value";
const AUD = "f".repeat(64);
const TEAM = "cryptophys.cloudflareaccess.com";
const REF: DeployVarReference = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, CF_ACCOUNT_ID: ACCOUNT, CI_CLIENT_ID: CLIENT_ID };
const OPS = `${CLIENT_ID},ops@example.com,owner@example.com`;
const APPROVERS = "ops@example.com,owner@example.com";
const VALUES: Record<string, string> = {
  ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OPERATOR_IDENTITIES: OPS, DEPLOY_ALLOWED_IDENTITIES: OPS, APPROVER_IDENTITIES: APPROVERS, CF_ACCOUNT_ID: ACCOUNT,
};

/** An active version's bindings: config bindings, a secret, and the workflow's --var values for `service`. */
function activeBindings(unit: string, service: string, override: Record<string, string | null> = {}): Array<Record<string, unknown>> {
  const vars = (DEPLOY_VARS[unit][service] ?? []).flatMap((n) => {
    const v = n in override ? override[n] : VALUES[n];
    return v === null ? [] : [{ type: "plain_text", name: n, text: v }];
  });
  return [
    { type: "d1", name: "DB", id: "11111111-2222-3333-4444-555555555555" },
    { type: "secret_text", name: "CF_DEPLOY_TOKEN" },
    { type: "version_metadata", name: "CF_VERSION_METADATA" },
    { type: "plain_text", name: "SERVICE_NAME", text: service },
    ...vars,
  ];
}

// ---------------------------------------------------------------- a fake Cloudflare for the executor (code-only path)
function fakeCf(bindings: (svc: string) => Array<Record<string, unknown>>, opts: { upload?: (svc: string, kept: Array<Record<string, unknown>>) => Array<Record<string, unknown>> } = {}) {
  let n = 0;
  const id = () => `${String(++n).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const scripts = new Map<string, { active: { version_id: string; percentage: number }[]; versions: Map<string, Array<Record<string, unknown>>>; latest: string }>();
  const script = (s: string) => {
    if (!scripts.has(s)) { const v = id(); scripts.set(s, { active: [{ version_id: v, percentage: 100 }], versions: new Map([[v, bindings(s)]]), latest: v }); }
    return scripts.get(s)!;
  };
  const calls: string[] = [];
  const digest = (b: unknown[]) => JSON.stringify([...b].map((x) => JSON.stringify(x)).sort());
  const cf = {
    calls, scripts, script,
    async active(s: string) { calls.push(`active ${s}`); return structuredClone(script(s).active); },
    async version(s: string, v: string) { calls.push(`version ${s}`); const b = script(s).versions.get(v); if (!b) throw new Error("cloudflare_api_404_10007"); return { id: v, resources: { bindings: structuredClone(b) } }; },
    async versionBindingSet(s: string, v: string) {
      const b = script(s).versions.get(v)!;
      return { names: b.map((x) => `${x.type}:${x.name}`).sort(), digest: digest(b) };
    },
    async uploadVersion(s: string) {
      calls.push(`upload ${s}`);
      const sc = script(s);
      const kept = structuredClone(sc.versions.get(sc.latest)!);
      const v = id();
      sc.versions.set(v, opts.upload ? opts.upload(s, kept) : kept);
      sc.latest = v;
      return v;
    },
    async deploy(s: string, versions: { version_id: string; percentage: number }[]) { calls.push(`deploy ${s} ${versions[0].version_id}`); script(s).active = structuredClone(versions); },
  };
  return cf;
}

async function sha256(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function plannedFor(services: string[]): Promise<{ plan: PlannedService[]; bundles: { get(k: string): Promise<{ text(): Promise<string> } | null>; list(): Promise<{ objects: []; truncated: false }> } }> {
  const modules = new Map<string, string>();
  const plan: PlannedService[] = [];
  for (const service of services) {
    const text = `export default { fetch() { return new Response(${JSON.stringify(service)}); } };`;
    modules.set(`bundles/${NEW}/${service}.mjs`, text);
    const worker: BundleWorker = {
      name: service, module: `${service}.mjs`, main_module: `${service}.mjs`, sha256: await sha256(text), bytes: new TextEncoder().encode(text).length,
      config_sha256: "c".repeat(64), compatibility_date: "2026-11-01", compatibility_flags: [], single_module: true, assets: false, external: [], limits: false, modules: null, config: null,
    };
    plan.push({ service, worker, running_tag: OLD.slice(0, 12) });
  }
  return { plan, bundles: { async get(k) { const t = modules.get(k); return t === undefined ? null : { text: async () => t }; }, async list() { return { objects: [], truncated: false }; } } };
}

function deployEnv(bundles: Awaited<ReturnType<typeof plannedFor>>["bundles"]) {
  const recorded: string[] = [];
  return {
    recorded,
    env: {
      DRIFT: { async probeService() { return { reachable: true, healthy: true, version_tag: TAG, error: null }; } },
      REGISTRY: { async recordRollback() { return { desired_version: "" }; }, async recordNativeDeploy(id: string) { recorded.push(id); return { desired_version: TAG, services: [] }; } },
      BUNDLES: bundles,
    },
  };
}

// ---------------------------------------------------------------- a fake public internet behind Access
interface Seen { url: string; method: string; headers: Record<string, string>; redirect?: string; body?: string }
function fakeInternet(answer: (url: URL, seen: Seen) => { status: number; body?: unknown } | null = () => null) {
  const seen: Seen[] = [];
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const s: Seen = { url: url.href, method: init.method ?? "GET", headers: { ...(init.headers as Record<string, string> ?? {}) }, redirect: init.redirect, body: typeof init.body === "string" ? init.body : undefined };
    seen.push(s);
    const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.href === `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/subdomain`) {
      return s.headers.authorization === "Bearer deploy-token" ? reply(200, { success: true, result: { subdomain: SUBDOMAIN } }) : reply(403, { success: false });
    }
    const custom = answer(url, s);
    if (custom) return reply(custom.status, custom.body);
    // Access: no service token, no Worker.
    if (s.headers["CF-Access-Client-Id"] !== CLIENT_ID || s.headers["CF-Access-Client-Secret"] !== CLIENT_SECRET) return reply(302);
    const host = /^([a-z0-9-]+)\.cryptophys\.workers\.dev$/.exec(url.hostname)?.[1];
    if (!host) return reply(404, { error: "no_route" });
    const name = host === "cryptophys-platform-api" ? "cryptophys-cloud-platform" : host;
    if (url.pathname === "/health") return reply(200, { status: "ok", service: name, environment: "production", contract_version: "v1", version: { id: "v", tag: TAG } });
    if (url.pathname === "/ready") return reply(200, { status: "ready", service: name, production_ready: true, production_dispatch_enabled: true, checks: { a: true, b: true } });
    if (host === "cryptophys-forge" && url.pathname === "/v1/forge/status") return reply(200, { repo: { name: "platform" }, head: { sha: NEW, title: "t" } });
    if (host === "cryptophys-audit-ledger" && url.pathname === "/v1/verify") return reply(200, { valid: true, events_checked: 12 });
    return reply(404, { error: "not_found" });
  }) as typeof fetch;
  return { fetcher, seen };
}
const runner = (fetcher: typeof fetch, env: Record<string, string> = {}) =>
  new SmokeRunner({ CF_ACCESS_CLIENT_ID: CLIENT_ID, CF_ACCESS_CLIENT_SECRET: CLIENT_SECRET, CF_DEPLOY_TOKEN: "deploy-token", CF_ACCOUNT_ID: ACCOUNT, ...env }, fetcher, { delayMs: 0 });

// ================================================================= 1. smoke success
test("G4-1. smoke success: each Worker is probed through Access after its live check, then the unit's own step, then the record", async () => {
  const { plan, bundles } = await plannedFor(["cryptophys-forge"]);
  const cf = fakeCf((s) => activeBindings("forge", s));
  const { env, recorded } = deployEnv(bundles);
  const net = fakeInternet();
  const run = await executeNativeDeploy(cf as never, env as never, "req-1", NEW, plan, { delayMs: 0, smoke: runner(net.fetcher) });
  assert.equal(run.ok, true, run.reason);
  assert.deepEqual(run.smoke, { status: "passed", probes: 4 });
  const i = (s: string) => run.steps.indexOf(s);
  assert.ok(i("cryptophys-forge:verified") < i("cryptophys-forge:smoke_passed") && i("cryptophys-forge:smoke_passed") < i("unit:smoke_passed") && i("unit:smoke_passed") < i("desired_recorded"), run.steps.join(" "));
  assert.deepEqual(recorded, ["req-1"]);
  const probes = net.seen.filter((s) => s.url.includes(".workers.dev"));
  assert.deepEqual(probes.map((s) => `${s.method} ${s.url}`), [
    "GET https://cryptophys-forge.cryptophys.workers.dev/health",
    "GET https://cryptophys-forge.cryptophys.workers.dev/health",
    "GET https://cryptophys-forge.cryptophys.workers.dev/ready",
    "GET https://cryptophys-forge.cryptophys.workers.dev/v1/forge/status",
  ]);
  // The first probe goes without credentials and must be stopped by Access; redirects are never followed.
  assert.equal(probes[0].headers["CF-Access-Client-Id"], undefined);
  for (const p of probes.slice(1)) assert.equal(p.headers["CF-Access-Client-Id"], CLIENT_ID);
  assert.ok(probes.every((p) => p.redirect === "manual"));
  assert.ok(!JSON.stringify(run).includes(CLIENT_SECRET), "the secret never reaches the outcome");
});

test("G4-1b. the Console's probes send its Origin and console headers, and reach the Nexus mount", async () => {
  const console = SMOKE_TABLE.console.probes;
  const csrf = console.find((p) => p.id === "console:csrf")!;
  const mcp = console.find((p) => p.id === "console:deny_mcp")!;
  const net = fakeInternet((url) => {
    if (url.hostname === "nexus.cryptophys.work") return { status: 200, body: { service: "cryptophys-console" } };
    if (url.pathname === "/api/kernel/mcp") return { status: 404, body: { error: "not_allowed" } };
    if (url.pathname === "/api/drift/v1/observe") return { status: 403, body: { error: "csrf" } };
    return null;
  });
  const r = runner(net.fetcher);
  for (const p of [csrf, mcp, console.find((p) => p.id === "console:nexus_mount")!]) {
    const out = await (r as unknown as { probe(p: SmokeProbe, tag: string): Promise<string | null> }).probe(p, TAG);
    assert.equal(out, null, p.id);
  }
  const [c, m, x] = net.seen.filter((s) => !s.url.startsWith("https://api.cloudflare.com"));
  assert.deepEqual([c.method, c.headers.Origin, c.headers["x-cryptophys-console"]], ["POST", "https://cryptophys-console.cryptophys.workers.dev", undefined]);
  assert.deepEqual([m.headers.Origin, m.headers["x-cryptophys-console"]], ["https://cryptophys-console.cryptophys.workers.dev", "1"]);
  assert.equal(x.url, "https://nexus.cryptophys.work/console/health");
});

// ================================================================= 2. smoke failure -> restore
test("G4-2. a failed smoke test restores every changed Worker, like a failed live check, and records no desired version", async () => {
  const { plan, bundles } = await plannedFor(["cryptophys-policy-engine", "cryptophys-audit-ledger"]);
  const cf = fakeCf((s) => activeBindings("control-plane", s));
  const before = { pe: cf.script("cryptophys-policy-engine").active, al: cf.script("cryptophys-audit-ledger").active };
  const { env, recorded } = deployEnv(bundles);
  // The audit ledger's /ready answers 503 through Access (its new version is not ready).
  const net = fakeInternet((url, s) => url.hostname.startsWith("cryptophys-audit-ledger.") && url.pathname === "/ready" && s.headers["CF-Access-Client-Id"] ? { status: 503, body: { status: "not_ready" } } : null);
  const run = await executeNativeDeploy(cf as never, env as never, "req-2", NEW, plan, { delayMs: 0, smoke: runner(net.fetcher) });
  assert.equal(run.ok, false);
  assert.equal(run.reason, "smoke_failed: control-plane:cryptophys-audit-ledger:ready: http_503");
  assert.equal(run.service, "cryptophys-audit-ledger");
  assert.equal(run.restored, true);
  assert.equal(run.production_changed, true);
  assert.deepEqual(run.smoke, { status: "failed", reason: "http_503", probe: "control-plane:cryptophys-audit-ledger:ready", probes: 5 });
  assert.ok(run.steps.includes("cryptophys-policy-engine:smoke_passed"));
  assert.ok(run.steps.indexOf("cryptophys-audit-ledger:restored") < run.steps.indexOf("cryptophys-policy-engine:restored"), "newest change first");
  assert.deepEqual(cf.script("cryptophys-policy-engine").active, before.pe);
  assert.deepEqual(cf.script("cryptophys-audit-ledger").active, before.al);
  assert.deepEqual(recorded, []);
  // The probe was retried before failing (SMOKE_ATTEMPTS), never with a followed redirect.
  assert.equal(net.seen.filter((s) => s.url === "https://cryptophys-audit-ledger.cryptophys.workers.dev/ready").length, 5);
});

test("G4-2b. a failure in the unit's own smoke step, after every Worker is live, restores all of them; so does a Worker Access does not protect", async () => {
  {
    const { plan, bundles } = await plannedFor(["cryptophys-forge"]);
    const cf = fakeCf((s) => activeBindings("forge", s));
    const before = cf.script("cryptophys-forge").active;
    const { env, recorded } = deployEnv(bundles);
    const net = fakeInternet((url, s) => url.pathname === "/v1/forge/status" && s.headers["CF-Access-Client-Id"] ? { status: 200, body: { repo: null, head: null } } : null);
    const run = await executeNativeDeploy(cf as never, env as never, "req-3", NEW, plan, { delayMs: 0, smoke: runner(net.fetcher) });
    assert.equal(run.reason, "smoke_failed: forge:forge:status: contract_failed");
    assert.equal(run.restored, true);
    assert.deepEqual(cf.script("cryptophys-forge").active, before);
    assert.deepEqual(recorded, []);
  }
  {
    const { plan, bundles } = await plannedFor(["cryptophys-platform-api"]);
    const cf = fakeCf((s) => activeBindings("platform-api", s));
    const { env } = deployEnv(bundles);
    // Without credentials the Worker answers itself: it is not behind Access.
    const net = fakeInternet((url, s) => !s.headers["CF-Access-Client-Id"] && url.pathname === "/health" ? { status: 200, body: { status: "ok" } } : null);
    const run = await executeNativeDeploy(cf as never, env as never, "req-4", NEW, plan, { delayMs: 0, smoke: runner(net.fetcher) });
    assert.equal(run.reason, "smoke_failed: platform-api:cryptophys-platform-api:access_required: http_200");
    assert.equal(run.restored, true);
  }
  {
    // A token set but unusable (one half missing) never passes for a skipped one.
    const r = runner(fakeInternet().fetcher, { CF_ACCESS_CLIENT_SECRET: "" });
    assert.equal(r.skipped, null);
    const out = await r.afterService("forge", "cryptophys-forge", TAG);
    assert.deepEqual(out, { ok: false, probe: "forge:cryptophys-forge:access_required", reason: "access_service_token_incomplete", probes: [] });
  }
});

test("G4-2c. without the service token the smoke tests are skipped and recorded so; the token is normalised like access-headers.sh", async () => {
  const r = new SmokeRunner({ CF_DEPLOY_TOKEN: "deploy-token", CF_ACCOUNT_ID: ACCOUNT }, fakeInternet().fetcher);
  assert.equal(r.skipped, "access_service_token_not_set");
  const { plan, bundles } = await plannedFor(["cryptophys-forge"]);
  const cf = fakeCf((s) => activeBindings("forge", s));
  const run = await executeNativeDeploy(cf as never, deployEnv(bundles).env as never, "req-5", NEW, plan, { delayMs: 0, smoke: r });
  assert.equal(run.ok, true);
  assert.deepEqual(run.smoke, { status: "skipped", reason: "access_service_token_not_set", probes: 0 });
  assert.deepEqual(SMOKE_SECRETS, ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"]);
  assert.deepEqual(smokeToken({ CF_ACCESS_CLIENT_ID: " CF-Access-Client-Id: abc.access\r\n", CF_ACCESS_CLIENT_SECRET: "cf-access-client-secret: xyz " }), { id: "abc.access", secret: "xyz" });
  assert.deepEqual(smokeToken({ CF_ACCESS_CLIENT_ID: "cfast_abc", CF_ACCESS_CLIENT_SECRET: "abc.access" }), { reason: "access_service_token_swapped" });
});

// ================================================================= 3. workflow / native parity of the smoke table
/** Every URL a deploy workflow requests through Access, as `METHOD target/path`, with the jq filter it applies. */
function workflowProbes(unit: string, yaml: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (key: string, jq?: string) => { if (!out.has(key)) out.set(key, new Set()); if (jq) out.get(key)!.add(jq); };
  const unq = (s: string) => s.startsWith("'") ? s.slice(1, -1) : s.slice(1, -1).replace(/\\"/g, '"');
  const order = /DEPLOY_ORDER: "([^"]+)"/.exec(yaml)?.[1].split(" ") ?? [];
  // verify-worker-live.sh --require-access: /health (with and without the token) and /ready.
  for (const m of yaml.matchAll(/verify-worker-live\.sh"[\s\\]*--script ("\$name"|[a-z-]+)([\s\S]*?)(?=\n\s*(?:echo|printf|- name:|$))/g)) {
    const scripts = m[1] === '"$name"' ? order.map((d) => `cryptophys-${d}`) : [m[1]];
    const health = /--health-filter ("(?:[^"\\]|\\.)*"|'[^']*')/.exec(m[2])![1];
    const ready = /--ready-filter ("(?:[^"\\]|\\.)*"|'[^']*')/.exec(m[2])![1];
    assert.match(m[2], /--require-access/, `${unit}: verify-worker-live without --require-access`);
    for (const s of scripts) { add(`GET ${s}/health`, unq(health)); add(`GET ${s}/ready`, unq(ready)); }
    const custom = /--custom-domain ([a-z0-9.-]+)/.exec(m[2]);
    if (custom) add(`GET https://${custom[1]}/health`);
  }
  // deploy-console.yml: probe METHOD PATH STATUS 'FILTER'.
  for (const m of yaml.matchAll(/^\s*probe (GET|POST) (\/\S+) (\d{3}) ('[^']*')/gm)) add(`${m[1]} cryptophys-console${m[2]}#${m[3]}`, unq(m[4]));
  for (const m of yaml.matchAll(/(https:\/\/nexus\.cryptophys\.work\/[^\s"]+)/g)) add(`GET ${m[1]}`, '.service == "cryptophys-console"');
  // deploy-control-plane.yml: api METHOD "<worker URL><path>" [JSON], then the jq it pipes to.
  const target: Record<string, string> = { registry: "cryptophys-platform-registry", kernel: "cryptophys-ai-kernel" };
  for (const m of yaml.matchAll(/api (GET|POST|PUT) "(?:\$\(url ([a-z-]+)\)|\$\{(registry|kernel)\})(\/[^"]*)"/g)) {
    const path = m[4].replace(/cryptophys-\$\{dir\}/g, "{service}").replace(/\$\{([a-z_]+)\}/g, "{$1}");
    add(`${m[1]} ${m[2] ? `cryptophys-${m[2]}` : target[m[3]]}${path}`);
  }
  // deploy-forge.yml: curl ... "${base}/path" (POST when --request POST on the same line).
  for (const line of yaml.split("\n")) for (const m of line.matchAll(/"\$\{base\}(\/[^"]+)"/g)) add(`${/--request POST/.test(line) ? "POST" : "GET"} cryptophys-forge${m[1]}`);
  return out;
}
const tableKey = (p: SmokeProbe) => `${p.method} ${p.origin === "workers_dev" ? p.service : p.origin}${p.path}${p.service === "cryptophys-console" && p.origin === "workers_dev" && p.after === "unit" ? `#${p.status[0]}` : ""}`;

test("G4-3. parity: every URL a deploy workflow probes through Access is in the native smoke table or listed as not repeated, with the same jq filter", () => {
  assert.deepEqual(Object.keys(SMOKE_TABLE).sort(), DEPLOY_UNITS.map((u) => u.unit).sort());
  for (const unit of DEPLOY_UNITS) {
    const t = SMOKE_TABLE[unit.unit];
    assert.equal(t.workflow, unit.workflow);
    const yaml = read(`.github/workflows/${unit.workflow}`);
    const flat = yaml.replace(/\\"/g, '"');
    const wf = workflowProbes(unit.unit, yaml);
    // The extraction is not vacuous: the three live URLs of every Worker, plus each unit's own steps.
    assert.equal(wf.size, { "deployment-orchestrator": 3, "control-plane": 24, console: 12, "platform-api": 2, forge: 4 }[unit.unit], `${unit.unit}: ${[...wf.keys()].join(", ")}`);
    const table = new Set(t.probes.map(tableKey));
    const skipped = new Set(t.not_repeated.filter((n) => !n.filter).map((n) => `${n.method} ${n.url}`));
    // A filter-level exclusion: the URL is probed, one named term of the workflow's filter is not.
    const termsOff = new Map(t.not_repeated.filter((n) => n.filter).map((n) => [`${n.method} ${n.url}`, n.filter!]));
    for (const [k, term] of termsOff) {
      assert.ok(table.has(k), `${unit.unit}: ${k}: a filter exclusion for a URL the table does not probe`);
      assert.ok([...(wf.get(k) ?? [])].some((jq) => jq.includes(` and ${term}`)), `${unit.unit}: ${k}: the workflow's filter has no term ${term}`);
    }
    for (const k of skipped) assert.ok(!table.has(k), `${unit.unit}: ${k} is both probed and not repeated`);
    for (const k of wf.keys()) assert.ok(table.has(k) || skipped.has(k), `${unit.unit}: the workflow probes ${k}, the native table does not (add it, or list it in not_repeated with the reason)`);
    for (const k of [...table, ...skipped]) assert.ok(wf.has(k), `${unit.unit}: ${k} is not in ${unit.workflow}`);
    // Every Worker of the unit gets the three live probes; every jq filter is the workflow's own, verbatim.
    for (const s of unit.services) {
      assert.deepEqual(t.probes.filter((p) => p.service === s && p.after === "service").map((p) => `${p.auth} ${p.path} ${p.status.join("|")}`),
        ["none /health 302|401|403", "service_token /health 200", "service_token /ready 200"], s);
    }
    for (const p of t.probes) {
      if (!p.jq) { assert.equal(p.auth, "none", p.id); continue; }
      assert.equal(typeof p.check, "function", p.id);
      const term = p.auth === "service_token" ? termsOff.get(tableKey(p)) : undefined;
      const fromWorkflow = wf.get(tableKey(p));
      // The workflow's filters for this URL, with the excluded term (if any) taken out: nothing else may differ.
      const expected = new Set([...(fromWorkflow ?? [])].map((jq) => term ? jq.replace(` and ${term}`, "") : jq));
      if (!term) assert.ok(flat.includes(p.jq), `${unit.unit}: ${p.id}: its jq filter is not in ${unit.workflow}`);
      if (fromWorkflow?.size) assert.ok(expected.has(p.jq), `${unit.unit}: ${p.id}: the workflow applies ${[...fromWorkflow].join(" | ")} to this URL`);
      else assert.ok(!term, `${unit.unit}: ${p.id}: an excluded term on a URL without a workflow filter`);
    }
  }
  // The token the probes send is the one the workflows hold for them.
  for (const u of DEPLOY_UNITS) for (const s of SMOKE_SECRETS) assert.ok(read(`.github/workflows/${u.workflow}`).includes(`secrets.${s}`), `${u.workflow}: ${s}`);
});

test("G4-3b. the translated checks agree with their jq filters on passing and failing bodies", () => {
  const ctx = { service: "x", tag: TAG, now: Date.parse("2026-11-15T12:00:00Z") };
  const by = (unit: string, id: string) => SMOKE_TABLE[unit].probes.find((p) => p.id === id)!.check!;
  const health = by("control-plane", "cryptophys-drift-detector:health");
  const good = { status: "ok", service: "cryptophys-drift-detector", environment: "production", contract_version: "v1", version: { tag: TAG } };
  assert.equal(health(good, ctx), true);
  assert.equal(health({ ...good, version: { tag: "000000000000" } }, ctx), false);
  assert.equal(health({ ...good, service: "cryptophys-ai-kernel" }, ctx), false);
  const ready = by("control-plane", "cryptophys-drift-detector:ready");
  assert.equal(ready({ status: "ready", service: "cryptophys-drift-detector", production_ready: true, checks: { a: true } }, ctx), true);
  assert.equal(ready({ status: "ready", service: "cryptophys-drift-detector", production_ready: true, checks: { a: true, b: false } }, ctx), false);
  assert.equal(ready({ status: "ready", service: "cryptophys-drift-detector", production_ready: true, checks: null }, ctx), false);
  const stuck = by("control-plane", "control-plane:consensus_not_stuck");
  assert.equal(stuck({ mode: "deploy", proposals: [{ status: "executing", decided_at: "2026-11-15T11:45:00" }] }, ctx), true);
  assert.equal(stuck({ mode: "deploy", proposals: [{ status: "executing", decided_at: "2026-11-15T11:00:00" }] }, ctx), false);
  assert.equal(stuck({ mode: "auto", proposals: [] }, ctx), false);
  const xau = by("control-plane", "control-plane:kernel_xauusd_latest");
  assert.equal(xau({ xauusd_latest: null }, ctx), true);
  assert.equal(xau({}, ctx), false);
  assert.equal(xau({ xauusd_latest: { candle_key: 1, confidence: 1, decided_at: 1, decision: "BUY", report_id: 1, reported_at: 1 } }, ctx), true);
  assert.equal(xau({ xauusd_latest: { candle_key: 1, confidence: 1, decided_at: 1, decision: "BUY", report_id: 1, reported_at: 1, reasoning: "x" } }, ctx), false);
  const whoami = by("console", "console:whoami");
  assert.equal(whoami({ operator: true, approver: false, type: "service_token" }, ctx), true);
  assert.equal(whoami({ operator: true, approver: true, type: "service_token" }, ctx), false, "the smoke token is never an approver");
});

test("G4-3c. the Orchestrator can reach the public hostnames: global_fetch_strictly_public is set, and it fetches no hostname of its own zones", () => {
  const toml = parseToml(read("workers/deployment-orchestrator/wrangler.toml"))!;
  assert.deepEqual(toml.compatibility_flags, ["global_fetch_strictly_public"]);
  const src = ["index.ts", "native-deploy.ts", "native-rollback.ts", "native-access.ts", "native-retire.ts", "assets-upload.ts", "recovery-deploy.ts"]
    .map((f) => read(`workers/deployment-orchestrator/src/${f}`)).join("\n");
  assert.ok(!/fetch\w*\([^)]*cryptophys\.work/.test(src), "no fetch to a cryptophys.work hostname outside the smoke module");
});

// ================================================================= 4. deploy-time vars kept from the active version and verified
/** Every `--var NAME` a workflow passes, per Worker of its unit. */
function workflowVars(unit: (typeof DEPLOY_UNITS)[number]): Record<string, string[]> {
  const yaml = read(`.github/workflows/${unit.workflow}`);
  const names = (line: string) => [...line.matchAll(/--var "([A-Z_]+):/g)].map((m) => m[1]);
  if (unit.services.length === 1) return { [unit.services[0]]: names(yaml) };
  const out: Record<string, string[]> = Object.fromEntries(unit.services.map((s) => [s, [] as string[]]));
  for (const line of yaml.split("\n")) {
    if (!line.includes('--var "')) continue;
    const dirs = [...line.matchAll(/"\$dir" == "([a-z-]+)"/g)].map((m) => `cryptophys-${m[1]}`);
    for (const s of dirs.length ? dirs : unit.services) out[s].push(...names(line));
  }
  return out;
}

test("G4-4. parity: DEPLOY_VARS lists exactly the --var values each workflow passes, and each has a declared source", () => {
  for (const unit of DEPLOY_UNITS) {
    assert.deepEqual(Object.fromEntries(Object.entries(DEPLOY_VARS[unit.unit]).map(([k, v]) => [k, [...v]])), workflowVars(unit), unit.workflow);
    const yaml = read(`.github/workflows/${unit.workflow}`);
    // The version tag the native upload sets (commit[0:12]) is the workflow's --tag.
    assert.ok(yaml.includes('--tag "${COMMIT_SHA:0:12}"') || (yaml.includes('tag="${COMMIT_SHA:0:12}"') && yaml.includes('--tag "$tag"')), unit.workflow);
  }
  for (const vars of Object.values(DEPLOY_VARS)) for (const names of Object.values(vars)) for (const n of names) assert.ok(DEPLOY_VAR_SOURCES[n], n);
});

test("G4-4b. the deploy-time values are kept from the active version, checked before the upload and verified on the new version", async () => {
  const { plan, bundles } = await plannedFor(["cryptophys-policy-engine", "cryptophys-platform-registry"]);
  const cf = fakeCf((s) => activeBindings("control-plane", s));
  const { env } = deployEnv(bundles);
  const run = await executeNativeDeploy(cf as never, env as never, "req-6", NEW, plan, { delayMs: 0, deployVars: REF });
  assert.equal(run.ok, true, run.reason);
  assert.deepEqual(run.deploy_vars, {
    "cryptophys-policy-engine": ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "OPERATOR_IDENTITIES"],
    "cryptophys-platform-registry": ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "OPERATOR_IDENTITIES", "APPROVER_IDENTITIES", "CF_ACCOUNT_ID"],
  });
  for (const s of ["cryptophys-policy-engine", "cryptophys-platform-registry"]) {
    const i = (x: string) => run.steps.indexOf(`${s}:${x}`);
    assert.ok(i("captured") < i("vars_kept") && i("vars_kept") < i("uploaded") && i("uploaded") < i("vars_verified") && i("vars_verified") < i("deployed"), run.steps.join(" "));
    // The new version, now active, binds the same text.
    const sc = cf.script(s);
    const live = sc.versions.get(sc.active[0].version_id)!;
    assert.equal(live.find((b) => b.name === "OPERATOR_IDENTITIES")!.text, OPS);
  }
  assert.ok(!JSON.stringify(run).includes("ops@example.com"), "values are never in the outcome, only names");

  // After the upload: a version that does not carry the kept text never receives traffic.
  assert.deepEqual(verifyDeployVars({ ACCESS_AUD: AUD }, [{ type: "plain_text", name: "ACCESS_AUD", text: AUD }]), { ok: true });
  assert.deepEqual(verifyDeployVars({ ACCESS_AUD: AUD }, []), { ok: false, reason: "deploy_var_missing:ACCESS_AUD" });
  assert.deepEqual(verifyDeployVars({ ACCESS_AUD: AUD }, [{ type: "plain_text", name: "ACCESS_AUD", text: "e".repeat(64) }]), { ok: false, reason: "deploy_var_differs:ACCESS_AUD" });
  assert.deepEqual(verifyDeployVars({ ACCESS_AUD: AUD }, [{ type: "secret_text", name: "ACCESS_AUD" }]), { ok: false, reason: "deploy_var_differs:ACCESS_AUD" });
  assert.deepEqual(verifyDeployVars({ ACCESS_AUD: AUD }, null), { ok: false, reason: "uploaded_bindings_unreadable" });
});

test("G4-4c. an upload that loses a kept value stops before the deploy call; nothing is moved", async () => {
  const { plan, bundles } = await plannedFor(["cryptophys-forge"]);
  const cf = fakeCf((s) => activeBindings("forge", s), { upload: (_s, kept) => kept.filter((b) => b.name !== "APPROVER_IDENTITIES") });
  const run = await executeNativeDeploy(cf as never, deployEnv(bundles).env as never, "req-7", NEW, plan, { delayMs: 0, deployVars: REF });
  assert.equal(run.ok, false);
  // The binding check stops it first (the digest covers every record); the value check would as well.
  assert.match(run.reason!, /^(bindings_differ|deploy_vars_differ: deploy_var_missing:APPROVER_IDENTITIES)$/);
  assert.equal(run.production_changed, false);
  assert.ok(!cf.calls.some((c) => c.startsWith("deploy ")));
});

// ================================================================= 5. a value that cannot be sourced -> refused, clearly
test("G4-5. a value no platform source holds refuses the deploy with its name, before any upload", async () => {
  const unit = "forge", svc = "cryptophys-forge";
  const reason = (override: Record<string, string | null>, ref: DeployVarReference = REF) => {
    const r = keptDeployVars(unit, svc, activeBindings(unit, svc, override), ref);
    return "reason" in r ? r.reason : null;
  };
  assert.equal(reason({}), null);
  assert.equal(reason({ APPROVER_IDENTITIES: null }), "deploy_var_unsourced:APPROVER_IDENTITIES");
  assert.equal(reason({ ACCESS_AUD: "not-an-aud" }), "deploy_var_malformed:ACCESS_AUD");
  assert.equal(reason({ ACCESS_AUD: "e".repeat(64) }), "deploy_var_mismatch:ACCESS_AUD");
  assert.equal(reason({ OPERATOR_IDENTITIES: "other.access,ops@example.com" }), "deploy_var_mismatch:OPERATOR_IDENTITIES");
  assert.equal(reason({ OPERATOR_IDENTITIES: "ops@example.com" }), "deploy_var_malformed:OPERATOR_IDENTITIES");
  assert.equal(reason({}, { ...REF, CI_CLIENT_ID: undefined }), "deploy_var_reference_missing:OPERATOR_IDENTITIES");
  const asSecret = activeBindings(unit, svc, { ACCESS_TEAM_DOMAIN: null });
  asSecret.push({ type: "secret_text", name: "ACCESS_TEAM_DOMAIN" });
  assert.deepEqual(keptDeployVars(unit, svc, asSecret, REF), { reason: "deploy_var_not_plain:ACCESS_TEAM_DOMAIN" });
  assert.deepEqual(keptDeployVars(unit, "cryptophys-new-worker", [], REF), { reason: "deploy_vars_unknown:cryptophys-new-worker" });
  assert.deepEqual(keptDeployVars(unit, svc, null, REF), { reason: "active_bindings_unreadable" });
  assert.equal(deployVarsConsistent([{ OPERATOR_IDENTITIES: OPS }, { DEPLOY_ALLOWED_IDENTITIES: OPS }]), null);
  assert.equal(deployVarsConsistent([{ APPROVER_IDENTITIES: APPROVERS }, { APPROVER_IDENTITIES: "owner@example.com" }]), "deploy_var_inconsistent:APPROVER_IDENTITIES");

  // The executor: refused after the capture, before any upload; production unchanged.
  const { plan, bundles } = await plannedFor([svc]);
  const cf = fakeCf((s) => activeBindings(unit, s, { APPROVER_IDENTITIES: null }));
  const run = await executeNativeDeploy(cf as never, deployEnv(bundles).env as never, "req-8", NEW, plan, { delayMs: 0, deployVars: REF });
  assert.equal(run.ok, false);
  assert.equal(run.reason, "deploy_vars_refused: deploy_var_unsourced:APPROVER_IDENTITIES");
  assert.equal(run.service, svc);
  assert.equal(run.production_changed, false);
  assert.ok(!cf.calls.some((c) => c.startsWith("upload ") || c.startsWith("deploy ")));
});

test("G4-5b. eligibility refuses the same way, read only, so the unit stays on its workflow with the reason", async () => {
  const db = migratedDb();
  const svc = "cryptophys-platform-api";
  db.raw.prepare("UPDATE service_registry SET desired_version = ? WHERE service_id = ?").run(OLD.slice(0, 12), svc);
  const worker = (sha: string) => ({
    name: svc, module: `${svc}.mjs`, main_module: `${svc}.mjs`, sha256: sha.slice(0, 2).repeat(32), bytes: 10, config_sha256: "c".repeat(64),
    compatibility_date: "2026-11-01", compatibility_flags: [], single_module: true, assets: false,
  });
  const manifests = new Map([OLD, NEW].map((c) => [`bundles/${c}/manifest.json`, JSON.stringify({ schema: "forge-bundles.v1", commit: c, workers: [worker(c)], migrations: [], migration_files: [] })]));
  const BUNDLES = {
    async get(k: string) { const t = manifests.get(k); return t ? { text: async () => t } : null; },
    async list(o: { prefix?: string } = {}) { return { objects: [...manifests.keys()].filter((k) => k.startsWith(o.prefix ?? "")).map((key) => ({ key })), truncated: false }; },
  };
  const unit = unitForService(svc)!;
  const cfWith = (override: Record<string, string | null>) => fakeCf((s) => activeBindings("platform-api", s, override));
  assert.equal((await nativeDeployEligible({ DB: db as never, BUNDLES }, unit, NEW, cfWith({}) as never, { deployVars: REF })).eligible, true);
  assert.deepEqual(await nativeDeployEligible({ DB: db as never, BUNDLES }, unit, NEW, cfWith({ OPERATOR_IDENTITIES: null }) as never, { deployVars: REF }),
    { eligible: false, reason: "deploy_var_unsourced:OPERATOR_IDENTITIES", service: svc });
  // Without the gate-4 switch (no service token on the Orchestrator) the earlier rule applies: kept, not checked.
  assert.equal((await nativeDeployEligible({ DB: db as never, BUNDLES }, unit, NEW, cfWith({ OPERATOR_IDENTITIES: null }) as never)).eligible, true);
});

test("G4-6. wiring: the planned deploy gets both gate-4 checks once the owner sets the token; the break-glass deploy keeps its own rules", () => {
  const src = read("workers/deployment-orchestrator/src/index.ts");
  // Owner 2026-11-16: gate4Deploy is gate4Eligibility plus the identity table (identity-lists-2026-11-16.test.ts).
  assert.match(src, /const g = gate4Eligibility\(env\);\n  if \(!g\.deployVars\) return g;/);
  assert.match(src, /nativeDeployEligible\(env, unit, sha, new CloudflareWorkers\([^)]*\), await gate4Deploy\(env\)\)/);
  assert.match(src, /nativeDeployEligible\(env, unitForService\(r\.service_id\)!, r\.requested_version, cf, await gate4Deploy\(env\)\)/);
  assert.match(src, /isBreakGlass \? \{ destructive: named \} : \{ \.\.\.\(await gate4Deploy\(env\)\), \.\.\.gate4Smoke\(env, fetcher, opts\.delayMs\) \}/);
  assert.match(src, /reason === "access_service_token_not_set"\) return \{\};/);
  const nd = read("workers/deployment-orchestrator/src/native-deploy.ts");
  // The smoke tests run after the live check and before new schedules; the unit's step before the desired version.
  assert.ok(nd.indexOf('steps.push(`${service}:verified`)') < nd.indexOf("opts.smoke.afterService") && nd.indexOf("opts.smoke.afterService") < nd.indexOf("for (const step of configPlan?.steps"));
  assert.ok(nd.indexOf("opts.smoke.afterUnit") < nd.indexOf("env.REGISTRY.recordNativeDeploy(requestId)"));
});

// ================================================================= follow-up: the Orchestrator's readiness without GitHub
test("G4-7. the orchestrator's smoke test passes without GH_ACTIONS_TOKEN; its one excluded filter term is named, and only that one", async () => {
  const t = SMOKE_TABLE["deployment-orchestrator"];
  const ex = t.not_repeated.filter((n) => n.filter);
  assert.deepEqual(ex.map((n) => [n.method, n.url, n.filter, n.why]), [["GET", "cryptophys-deployment-orchestrator/ready", ".production_dispatch_enabled == true",
    "GitHub fallback readiness; not a native readiness condition (cut-over step 7 revokes GH_ACTIONS_TOKEN)"]]);
  for (const u of Object.values(SMOKE_TABLE)) if (u.unit !== "deployment-orchestrator") assert.ok(u.not_repeated.every((n) => !n.filter), u.unit);
  // The Orchestrator's /ready as it answers with the native deploy configured and the GitHub token revoked.
  const body = { status: "ready", service: "cryptophys-deployment-orchestrator", production_dispatch_enabled: false, github_fallback: "absent", checks: { production_environment: true, database_schema: true } };
  const { plan, bundles } = await plannedFor(["cryptophys-deployment-orchestrator"]);
  const cf = fakeCf((s) => activeBindings("deployment-orchestrator", s));
  const { env, recorded } = deployEnv(bundles);
  const net = fakeInternet((url, s) => url.pathname === "/ready" && s.headers["CF-Access-Client-Id"] === CLIENT_ID ? { status: 200, body } : null);
  const run = await executeNativeDeploy(cf as never, env as never, "req-9", NEW, plan, { delayMs: 0, smoke: runner(net.fetcher), deployVars: REF });
  assert.equal(run.ok, true, run.reason);
  assert.deepEqual(run.smoke, { status: "passed", probes: 3 });
  assert.deepEqual(recorded, ["req-9"]);
  // Still a real readiness check: a failing check or a not-ready status fails it.
  const ready = t.probes.find((p) => p.id === "cryptophys-deployment-orchestrator:ready")!.check!;
  const ctx = { service: "x", tag: TAG, now: 0 };
  assert.equal(ready(body, ctx), true);
  assert.equal(ready({ ...body, checks: { ...body.checks, database_schema: false } }, ctx), false);
  assert.equal(ready({ ...body, status: "not_configured" }, ctx), false);
});

test("G4-8. the Orchestrator's /ready is ready with the native deploy configured and no GH_ACTIONS_TOKEN; the fallback is reported, not required", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (isAccessCerts(String(input))) return accessCertsResponse();
    throw new Error(`unexpected fetch ${String(input)}`);
  }) as typeof fetch;
  try {
    const lock = { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response("{}") }) };
    const native = {
      DEPLOYMENT_LOCK: lock, CF_DEPLOY_TOKEN: "deploy-token", CF_ACCOUNT_ID: ACCOUNT,
      DRIFT: { probeService: async () => ({}) }, REGISTRY: { recordRollback: async () => ({}) }, BUNDLES: { get: async () => null, list: async () => ({ objects: [], truncated: false }) },
    };
    const ready = () => new Request("https://cryptophys-deployment-orchestrator.example.workers.dev/ready", { headers: { "cf-access-jwt-assertion": CI_JWT } });
    const env = (extra: Record<string, unknown>) => baseEnv("cryptophys-deployment-orchestrator", migratedDb(), { ...native, ...extra });
    const revoked = await call(orchestrator, env({ GH_ACTIONS_TOKEN: "" }), ready());
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.status, "ready");
    assert.equal(revoked.body.native_deploy, "configured");
    assert.equal(revoked.body.github_fallback, "absent");
    assert.equal(revoked.body.production_dispatch_enabled, false, "the fallback cannot dispatch without its token; informational");
    assert.equal("github_token_configured" in revoked.body.checks, false, "not a readiness condition with the native deploy");
    // The native smoke filter accepts this answer; the workflow's own filter (with the fallback term) would not.
    const check = SMOKE_TABLE["deployment-orchestrator"].probes.find((p) => p.id === "cryptophys-deployment-orchestrator:ready")!.check!;
    assert.equal(check(revoked.body, { service: "x", tag: TAG, now: 0 }), true);
    const kept = await call(orchestrator, env({ GH_ACTIONS_TOKEN: "gh-token" }), ready());
    assert.deepEqual([kept.status, kept.body.github_fallback, kept.body.production_dispatch_enabled], [200, "available", true]);
    // Without the native deploy the fallback is the only path: its token stays a readiness check.
    const noNative = await call(orchestrator, baseEnv("cryptophys-deployment-orchestrator", migratedDb(), { DEPLOYMENT_LOCK: lock, GH_ACTIONS_TOKEN: "" }), ready());
    assert.deepEqual([noNative.status, noNative.body.checks.github_token_configured, noNative.body.github_fallback], [503, false, "absent"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
