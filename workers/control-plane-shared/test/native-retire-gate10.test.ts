// ADR-0012 G6 gate 10 (docs/GITHUB-CUTOVER.md): the Orchestrator retires a Worker through the Cloudflare API, without
// retire-worker.yml, with the workflow's gates read from the Forge's records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { baseEnv, forgeSees, migratedDb } from "./harness.ts";
import { DEPLOY_UNITS } from "../src/deploy-units.ts";
import { storeBundles, type BuiltModule, type BundleBucket } from "../../forge/src/bundles.ts";
import { DeploymentLock, listDeployments, retireForConsensus, runNativeExecutors } from "../../deployment-orchestrator/src/index.ts";
import { SAFE_MINUTES } from "../../deployment-orchestrator/src/native-rollback.ts";
import { CloudflareRetire, executeRetire, planRetire, RETIRABLE } from "../../deployment-orchestrator/src/native-retire.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const ACCOUNT = "a".repeat(32);
const MAIN = "2c".repeat(20);
const realFetch = globalThis.fetch;

const nextSafeMinute = (after: number): number => {
  const first = Math.ceil(after / 60_000) * 60_000;
  for (let i = 0; i < 60; i++) {
    const t = first + i * 60_000;
    if (SAFE_MINUTES.includes(new Date(t).getUTCMinutes())) return t;
  }
  throw new Error("no safe minute");
};

// ---------------------------------------------------------------- the Forge's bundles for main (R2)
function bucket() {
  const objects = new Map<string, string>();
  const b: BundleBucket & { objects: typeof objects; get(key: string): Promise<{ text(): Promise<string> } | null> } = {
    objects,
    async put(key, value) { objects.set(key, value); return {}; },
    async get(key) { const o = objects.get(key); return o === undefined ? null : { text: async () => o }; },
    async list({ prefix = "" } = {}) { return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, uploaded: new Date() })), truncated: false }; },
    async delete(keys) { for (const k of [keys].flat()) objects.delete(k); },
  };
  return b;
}
const toml = (name: string, extra = "") => `name = "${name}"\nmain = "src/worker.ts"\ncompatibility_date = "2026-11-01"\n${extra}`;
async function bundlesFor(b: ReturnType<typeof bucket>, commit: string, extra: Record<string, string> = {}, add: string[] = []) {
  const built: BuiltModule[] = [];
  for (const name of [...DEPLOY_UNITS.flatMap((u) => u.services), ...add]) {
    built.push({ dir: `workers/${name.replace("cryptophys-", "")}`, text: `export default {};`, toml: toml(name, extra[name] ?? ""), external: [] });
  }
  await storeBundles(b, commit, built, Date.now(), ["0001_init.sql"]);
}

// ---------------------------------------------------------------- a fake Cloudflare API (domains, Workflows, scripts)
interface World { domains: Array<{ id: string; hostname: string; service: string }>; workflows: Set<string>; scripts: Set<string> }
function fakeCloudflare(world: World, opts: { status?: (method: string, path: string) => number | undefined } = {}) {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer deploy-token");
    const prefix = `/client/v4/accounts/${ACCOUNT}/`;
    assert.ok(url.hostname === "api.cloudflare.com" && url.pathname.startsWith(prefix), `unexpected ${url}`);
    const path = url.pathname.slice(prefix.length);
    assert.ok(!url.searchParams.has("force"), "a retirement never deletes with force");
    calls.push(`${method} ${path}${url.search}`);
    const forced = opts.status?.(method, path);
    if (forced !== undefined) return Response.json({ success: false, errors: [{ code: forced }] }, { status: forced });
    if (path === "workers/domains" && method === "GET") {
      return Response.json({ success: true, result: world.domains.filter((d) => d.hostname === url.searchParams.get("hostname")) });
    }
    let m = /^workers\/domains\/([A-Za-z0-9-]+)$/.exec(path);
    if (m && method === "DELETE") {
      const i = world.domains.findIndex((d) => d.id === m![1]);
      if (i < 0) return Response.json({ success: false }, { status: 404 });
      world.domains.splice(i, 1);
      return Response.json({ success: true, result: null });
    }
    m = /^workflows\/([a-z0-9-]+)$/.exec(path);
    if (m) {
      if (!world.workflows.has(m[1])) return Response.json({ success: false }, { status: 404 });
      if (method === "DELETE") world.workflows.delete(m[1]);
      return Response.json({ success: true, result: {} });
    }
    m = /^workers\/scripts\/([a-z0-9-]+)(\/settings)?$/.exec(path);
    if (m) {
      if (!world.scripts.has(m[1])) return Response.json({ success: false }, { status: 404 });
      if (method === "DELETE" && !m[2]) world.scripts.delete(m[1]);
      return Response.json({ success: true, result: {} });
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  return { fetcher, calls };
}
const homeWorld = (): World => ({
  domains: [
    { id: "dom-home-1", hostname: "home.cryptophys.work", service: "cryptophys-home" },
    { id: "dom-console-1", hostname: "console.cryptophys.work", service: "cryptophys-console" },
    { id: "dom-nexus-1", hostname: "nexus.cryptophys.work", service: "cryptophys-xauusd-nexus-dashboard" },
  ],
  workflows: new Set(["cryptophys-recovery-lifecycle"]),
  scripts: new Set(["cryptophys-home", "cryptophys-console", "cryptophys-policy-engine"]),
});

// ---------------------------------------------------------------- D1: the Forge's head, an owner-approved retire_worker
function lockNs() {
  const stores = new Map<string, Map<string, unknown>>();
  return { idFromName: (n: string) => n, get: (id: unknown) => {
    const key = String(id); if (!stores.has(key)) stores.set(key, new Map()); const data = stores.get(key)!;
    const lock = new DeploymentLock({ storage: { get: async (k: string) => data.get(k) as never, put: async (k: string, v: unknown) => { data.set(k, v); }, delete: async (k: string) => data.delete(k) }, blockConcurrencyWhile: (cb) => cb() });
    return { fetch: (i: RequestInfo | URL, init?: RequestInit) => lock.fetch(new Request(i, init)) };
  } };
}
let n = 0;
function approvedRetire(db: Db, target: string): { proposal: string; decision: string } {
  n++;
  const proposal = `cns_${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
  const decision = `dec_${String(n).padStart(8, "0")}-2222-4222-8222-222222222222`;
  const at = new Date().toISOString();
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES (?, 'supervisor', 'retire_worker', ?, 'critical', '{}', '{}', 'critical', 8, 8, 0, 1, ?, 'allow', 'executing', NULL, ?, ?)`).run(proposal, target, decision, at, at);
  db.raw.prepare(`INSERT INTO policy_decisions (decision_id, subject, action, resource, decision, reason, evidence_json, created_at) VALUES (?, 'ai:kernel', 'consensus.execute', ?, 'allow', 'ok', '{}', ?)`)
    .run(decision, `retire_worker:${target}`, at);
  db.raw.prepare("INSERT INTO consensus_owner_decisions (proposal_id, decision, decided_by, reason, created_at) VALUES (?, 'approve', 'owner@example.com', 'ADR-0010 amendment', ?)").run(proposal, at);
  return { proposal, decision };
}
async function scenario() {
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'critical' WHERE control = 'mode'").run();
  // Every unit runs main: nothing is pending.
  db.raw.prepare("UPDATE service_registry SET desired_version = ? WHERE status != 'disabled'").run(MAIN.slice(0, 12));
  await forgeSees(db, { main: MAIN, files: ["docs/x.md"], ready: true });
  const b = bucket();
  await bundlesFor(b, MAIN);
  return { db, b };
}
function nativeEnv(db: Db, b: ReturnType<typeof bucket>, extra: Record<string, unknown> = {}) {
  const reports: any[] = [];
  const env = baseEnv("cryptophys-deployment-orchestrator", db, {
    GH_ACTIONS_TOKEN: "gh-token", DEPLOYMENT_LOCK: lockNs(), CF_DEPLOY_TOKEN: "deploy-token", CF_ACCOUNT_ID: ACCOUNT, BUNDLES: b,
    DRIFT: { probeService: async () => ({ reachable: true, healthy: true, version_tag: MAIN.slice(0, 12), error: null }) },
    REGISTRY: { recordRollback: async () => ({ desired_version: "x" }) },
    AGENTS: { syscall: async (_agent: string, _cap: string, input: unknown) => { reports.push(input); return { outcome: "succeeded" }; } },
    ...extra,
  });
  return { env, reports };
}
const head = (sha: string | null = MAIN, ready = true, pending: string[] = []) => ({ sha, ready, pending });

// ---------------------------------------------------------------- tests
test("NR1. RETIRABLE is retire-worker.yml's list: the same Workers, Workflows and custom domains", () => {
  const yml = read(".github/workflows/retire-worker.yml");
  const block = /case "\$WORKER" in([\s\S]*?)esac/.exec(yml)![1];
  const fromYml: Record<string, { workflow: string | null; detach: Array<{ host: string; worker: string }> }> = {};
  for (const m of block.matchAll(/^\s*(cryptophys-[a-z0-9-]+)\) (.*);;$/gm)) {
    const wf = /WORKFLOW_NAME=([a-z0-9-]+)/.exec(m[2]);
    const dd = /DETACH_DOMAINS=([^"]+)"/.exec(m[2]);
    fromYml[m[1]] = {
      workflow: wf ? wf[1] : null,
      detach: dd ? dd[1].trim().split(/\s+/).map((e) => ({ host: e.split("=")[0], worker: e.split("=")[1] })) : [],
    };
  }
  assert.deepEqual(Object.keys(fromYml).sort(), ["cryptophys-home", "cryptophys-signal-engine"]);
  assert.deepEqual(JSON.parse(JSON.stringify(RETIRABLE)), fromYml);
  // A deploy unit is never retirable.
  for (const w of Object.keys(RETIRABLE)) assert.ok(!DEPLOY_UNITS.some((u) => (u.services as readonly string[]).includes(w)), w);
});

test("NR2. planRetire only reads, and refuses anything the workflow would refuse", async () => {
  const b = bucket();
  await bundlesFor(b, MAIN);
  const { fetcher, calls } = fakeCloudflare(homeWorld());
  const cf = new CloudflareRetire("deploy-token", ACCOUNT, fetcher);
  const plan = await planRetire(cf, b, head(), "cryptophys-home");
  assert.deepEqual(plan, {
    ok: true, worker: "cryptophys-home", main_sha: MAIN, workflow: null, workflow_present: false, script_present: true,
    domains: [{ host: "home.cryptophys.work", worker: "cryptophys-home", ids: ["dom-home-1"] }, { host: "console.cryptophys.work", worker: "cryptophys-console", ids: ["dom-console-1"] }],
  });
  assert.ok(calls.every((c) => c.startsWith("GET ")), "planning never changes anything");

  const refusal = async (h: ReturnType<typeof head>, worker: string, bundles = b, world = homeWorld(), status?: (m: string, p: string) => number | undefined) => {
    const r = await planRetire(new CloudflareRetire("deploy-token", ACCOUNT, fakeCloudflare(world, { status }).fetcher), bundles, h, worker);
    return r.ok ? "ok" : r.reason;
  };
  assert.equal(await refusal(head(), "cryptophys-console"), "not_retirable");
  assert.equal(await refusal(head(), "cryptophys-unknown"), "not_retirable");
  assert.equal(await refusal(head(null), "cryptophys-home"), "forge_main_unknown");
  assert.equal(await refusal(head(MAIN, false), "cryptophys-home"), "forge_checks_not_ready");
  assert.equal(await refusal(head(MAIN, true, ["console"]), "cryptophys-home"), "deploys_pending");
  assert.equal(await refusal(head("3d".repeat(20)), "cryptophys-home"), "forge_bundles_missing");
  // The Worker's source is still on main.
  const withHome = bucket();
  await bundlesFor(withHome, MAIN, {}, ["cryptophys-home"]);
  assert.equal(await refusal(head(), "cryptophys-home", withHome), "source_still_on_main");
  // A Worker on main still binds to it, or still declares one of the domains to detach.
  const bound = bucket();
  await bundlesFor(bound, MAIN, { "cryptophys-drift-detector": `[[services]]\nbinding = "SVC_HOME"\nservice = "cryptophys-home"\n` });
  assert.equal(await refusal(head(), "cryptophys-home", bound), "still_bound_on_main");
  const declared = bucket();
  await bundlesFor(declared, MAIN, { "cryptophys-console": `[[routes]]\npattern = "console.cryptophys.work"\ncustom_domain = true\n` });
  assert.equal(await refusal(head(), "cryptophys-home", declared), "domain_still_declared_on_main");
  // A domain on another Worker than expected: nothing is detached.
  const moved = homeWorld();
  moved.domains[1].service = "cryptophys-platform-api";
  assert.equal(await refusal(head(), "cryptophys-home", b, moved), "domain_on_unexpected_worker");
  // CF_DEPLOY_TOKEN may not read the domains: a permission refusal (the workflow's tokens may).
  assert.equal(await refusal(head(), "cryptophys-home", b, homeWorld(), (m, p) => p === "workers/domains" ? 403 : undefined), "domains_unreadable_403");
  assert.equal(await refusal(head(), "cryptophys-home", b, homeWorld(), (m, p) => p.startsWith("workers/scripts/") ? 500 : undefined), "script_unreadable_500");
  // The Signal Engine's Workflow is read too.
  const se = await planRetire(new CloudflareRetire("deploy-token", ACCOUNT, fakeCloudflare({ domains: [], workflows: new Set(["cryptophys-signal-ingest"]), scripts: new Set() }).fetcher), b, head(), "cryptophys-signal-engine");
  assert.deepEqual(se.ok && [se.workflow, se.workflow_present, se.script_present, se.domains], ["cryptophys-signal-ingest", true, false, []]);
});

test("NR3. executeRetire detaches, then deletes without force, and verifies everything is gone", async () => {
  const b = bucket();
  await bundlesFor(b, MAIN);
  const world = homeWorld();
  const { fetcher, calls } = fakeCloudflare(world);
  const cf = new CloudflareRetire("deploy-token", ACCOUNT, fetcher);
  const plan = await planRetire(cf, b, head(), "cryptophys-home");
  assert.ok(plan.ok);
  calls.length = 0;
  const run = await executeRetire(cf, plan as Extract<typeof plan, { ok: true }>, { delayMs: 0 });
  assert.deepEqual(run, { ok: true, changed: true, steps: ["detached home.cryptophys.work", "detached console.cryptophys.work", "deleted cryptophys-home", "verified absent"] });
  assert.deepEqual(calls, [
    "DELETE workers/domains/dom-home-1", "GET workers/domains?hostname=home.cryptophys.work",
    "DELETE workers/domains/dom-console-1", "GET workers/domains?hostname=console.cryptophys.work",
    "DELETE workers/scripts/cryptophys-home", "GET workers/scripts/cryptophys-home/settings",
  ]);
  // cryptophys-console and the Nexus domain are untouched.
  assert.ok(world.scripts.has("cryptophys-console"));
  assert.deepEqual(world.domains.map((d) => d.hostname), ["nexus.cryptophys.work"]);
});

test("NR4. a failure reports whether anything changed", async () => {
  const b = bucket();
  await bundlesFor(b, MAIN);
  const run = async (status: (m: string, p: string) => number | undefined) => {
    const world = homeWorld();
    const plan = await planRetire(new CloudflareRetire("deploy-token", ACCOUNT, fakeCloudflare(world).fetcher), b, head(), "cryptophys-home");
    const cf = new CloudflareRetire("deploy-token", ACCOUNT, fakeCloudflare(world, { status }).fetcher);
    return { r: await executeRetire(cf, plan as Extract<typeof plan, { ok: true }>, { delayMs: 0 }), world };
  };
  // The first detach is refused: nothing changed, the script is still there.
  let x = await run((m, p) => m === "DELETE" && p.startsWith("workers/domains/") ? 403 : undefined);
  assert.deepEqual({ ok: x.r.ok, changed: x.r.changed, reason: x.r.reason }, { ok: false, changed: false, reason: "domain_detach_403: home.cryptophys.work" });
  assert.ok(x.world.scripts.has("cryptophys-home"));
  // Cloudflare refuses the delete (another Worker still binds to it): the domains are already detached.
  x = await run((m, p) => m === "DELETE" && p === "workers/scripts/cryptophys-home" ? 409 : undefined);
  assert.deepEqual({ ok: x.r.ok, changed: x.r.changed, reason: x.r.reason }, { ok: false, changed: true, reason: "script_delete_409" });
  // A domain that does not go away.
  x = await run((m, p) => m === "DELETE" && p === "workers/domains/dom-home-1" ? 200 : undefined);
  assert.equal(x.r.reason, "domain_still_attached: home.cryptophys.work");
});

test("NR5. retire_worker end to end: queued, signed and executed by the Orchestrator's cron; no GitHub", async () => {
  const { db, b } = await scenario();
  const world = homeWorld();
  const { fetcher } = fakeCloudflare(world);
  const { env, reports } = nativeEnv(db, b);
  const p = approvedRetire(db, "cryptophys-home");
  globalThis.fetch = fetcher;
  try {
    const queued = await retireForConsensus(env as never, p.proposal, p.decision, "cryptophys-home");
    assert.equal(queued.dispatched, true, JSON.stringify(queued));
    assert.equal(queued.executor, "native:retire");
    // A replay of the same proposal is a no-op.
    assert.equal((await retireForConsensus(env as never, p.proposal, p.decision, "cryptophys-home")).reason, "already_dispatched");
  } finally { globalThis.fetch = realFetch; }
  const row = db.raw.prepare("SELECT * FROM deployment_requests").get() as any;
  assert.deepEqual({ s: row.service_id, v: row.requested_version, by: row.requested_by, st: row.status, key: row.idempotency_key },
    { s: "cryptophys-home", v: "retire", by: `consensus:${p.proposal}`, st: "approved", key: `consensus:retire:cryptophys-home:${p.proposal}` });
  assert.match(JSON.parse(row.details_json).signature, /^[0-9a-f]{64}$/);
  assert.ok(world.scripts.has("cryptophys-home"), "queueing only reads");
  // Not at an unsafe minute; then at the next safe one.
  const safe = nextSafeMinute(Date.now());
  assert.deepEqual(await runNativeExecutors(env as never, safe + 60_000 * (SAFE_MINUTES.includes(new Date(safe + 60_000).getUTCMinutes()) ? 2 : 1), fetcher), { executed: 0, succeeded: 0 });
  assert.deepEqual(await runNativeExecutors(env as never, safe, fetcher, { delayMs: 0 }), { executed: 1, succeeded: 1 });
  assert.ok(!world.scripts.has("cryptophys-home"));
  assert.deepEqual(world.domains.map((d) => d.hostname), ["nexus.cryptophys.work"]);
  const done = db.raw.prepare("SELECT status, details_json FROM deployment_requests").get() as any;
  assert.equal(done.status, "succeeded");
  assert.equal(JSON.parse(done.details_json).outcome.changed, true);
  const audit = db.raw.prepare("SELECT event_type FROM audit_events WHERE subject = 'cryptophys-home' ORDER BY rowid").all().map((r: any) => r.event_type);
  assert.deepEqual(audit, ["deployment.retire_queued", "deployment.retire_succeeded"]);
  assert.deepEqual(reports, [], "a completed retirement raises no report");
  const listed = (await listDeployments(env as never)) as any;
  assert.equal(JSON.stringify(listed).includes("native retirement"), true);
});

test("NR6. a refusal at execution changes nothing and warns the owner; a new proposal queues again; a partial failure is critical", async () => {
  const { db, b } = await scenario();
  const world = homeWorld();
  const { fetcher } = fakeCloudflare(world);
  const { env, reports } = nativeEnv(db, b);
  const p = approvedRetire(db, "cryptophys-home");
  globalThis.fetch = fetcher;
  try { assert.equal((await retireForConsensus(env as never, p.proposal, p.decision, "cryptophys-home")).dispatched, true); }
  finally { globalThis.fetch = realFetch; }
  // Between the click and the run, a domain moved to another Worker.
  world.domains[1].service = "cryptophys-platform-api";
  const safe = nextSafeMinute(Date.now());
  assert.deepEqual(await runNativeExecutors(env as never, safe, fetcher, { delayMs: 0 }), { executed: 0, succeeded: 0 });
  const row = db.raw.prepare("SELECT status, details_json FROM deployment_requests").get() as any;
  assert.equal(row.status, "failed");
  assert.match(JSON.parse(row.details_json).outcome.reason, /^refused: domain_on_unexpected_worker/);
  assert.ok(world.scripts.has("cryptophys-home") && world.domains.length === 3, "nothing changed");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].severity, "warning");
  assert.equal(reports[0].body.changed, false);
  // A new owner-approved proposal queues again.
  world.domains[1].service = "cryptophys-console";
  const p2 = approvedRetire(db, "cryptophys-home");
  const failing = fakeCloudflare(world, { status: (m, path) => m === "DELETE" && path === "workers/scripts/cryptophys-home" ? 409 : undefined });
  globalThis.fetch = failing.fetcher;
  try { assert.equal((await retireForConsensus(env as never, p2.proposal, p2.decision, "cryptophys-home")).dispatched, true); }
  finally { globalThis.fetch = realFetch; }
  assert.deepEqual(await runNativeExecutors(env as never, nextSafeMinute(safe + 60_000), failing.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 0 });
  assert.equal(reports.length, 2);
  assert.equal(reports[1].severity, "critical", "domains were detached but the Worker was not deleted");
  assert.equal(reports[1].body.changed, true);
  assert.match(reports[1].subject, /Retirement of .* stopped part way/);
});

test("NR7. the workflow stays the path when CF_DEPLOY_TOKEN may not read, or the native credentials are absent; a safety refusal stops", async () => {
  const dispatchedTo = async (env: Record<string, unknown>, db: Db, world: World, status?: (m: string, p: string) => number | undefined) => {
    const dispatched: string[] = [];
    const cf = fakeCloudflare(world, { status });
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const m = /\/actions\/workflows\/([a-z-]+\.yml)\/dispatches$/.exec(String(i));
      if (m) { dispatched.push(m[1]); return new Response(null, { status: 204 }); }
      return cf.fetcher(i, init);
    }) as typeof fetch;
    try {
      const p = approvedRetire(db, "cryptophys-home");
      const r = await retireForConsensus(env as never, p.proposal, p.decision, "cryptophys-home").catch((e: Error) => ({ error: e.message }));
      return { r, dispatched };
    } finally { globalThis.fetch = realFetch; }
  };
  // The domains cannot be read with CF_DEPLOY_TOKEN: the workflow, with its tokens, retires it.
  let s = await scenario();
  let x = await dispatchedTo(nativeEnv(s.db, s.b).env, s.db, homeWorld(), (m, p) => p === "workers/domains" ? 403 : undefined);
  assert.deepEqual(x.dispatched, ["retire-worker.yml"]);
  // No native credentials: the workflow, as before gate 10.
  s = await scenario();
  x = await dispatchedTo(nativeEnv(s.db, s.b, { CF_DEPLOY_TOKEN: undefined }).env, s.db, homeWorld());
  assert.deepEqual(x.dispatched, ["retire-worker.yml"]);
  // A safety refusal (a domain on another Worker) never falls back to the workflow.
  s = await scenario();
  const moved = homeWorld();
  moved.domains[0].service = "cryptophys-platform-api";
  x = await dispatchedTo(nativeEnv(s.db, s.b).env, s.db, moved);
  assert.deepEqual(x.dispatched, []);
  assert.match(JSON.stringify(x.r), /native_retire_refused: domain_on_unexpected_worker/);
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM deployment_requests").get() as any).n, 0);
});

test("NR8. a stored row is executed only as the queue wrote it", async () => {
  const { db, b } = await scenario();
  const world = homeWorld();
  const { fetcher } = fakeCloudflare(world);
  const { env } = nativeEnv(db, b);
  const p = approvedRetire(db, "cryptophys-home");
  globalThis.fetch = fetcher;
  try { await retireForConsensus(env as never, p.proposal, p.decision, "cryptophys-home"); }
  finally { globalThis.fetch = realFetch; }
  // Another D1-bound Worker rewrites the target: the signature no longer matches and the row never runs.
  db.raw.prepare("UPDATE deployment_requests SET service_id = 'cryptophys-signal-engine', idempotency_key = replace(idempotency_key, 'cryptophys-home', 'cryptophys-signal-engine'), details_json = replace(details_json, '\"worker\":\"cryptophys-home\"', '\"worker\":\"cryptophys-signal-engine\"')").run();
  assert.deepEqual(await runNativeExecutors(env as never, nextSafeMinute(Date.now()), fetcher, { delayMs: 0 }), { executed: 0, succeeded: 0 });
  const row = db.raw.prepare("SELECT status, details_json FROM deployment_requests").get() as any;
  assert.equal(row.status, "failed");
  assert.equal(JSON.parse(row.details_json).outcome.reason, "invalid_native_retire_signature");
  assert.ok(world.scripts.has("cryptophys-home"));
});
