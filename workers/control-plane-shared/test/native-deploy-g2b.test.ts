// ADR-0012 G2b: the Orchestrator deploys a code-only change from the Forge's bundles (R2), through the Workers
// Versions and Deployments APIs. Anything else stays on the unit's GitHub workflow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { baseEnv, forgeSees, migratedDb } from "./harness.ts";
import { DEPLOY_UNITS, unitForService } from "../src/deploy-units.ts";
import { storeBundles, type BuiltModule, type BundleBucket } from "../../forge/src/bundles.ts";
import worker, { DeploymentLock, deployForConsensus, listDeployments, NATIVE_DEPLOY_MAX_AGE_MS, runNativeExecutors } from "../../deployment-orchestrator/src/index.ts";
import { KEEP_BINDINGS, SAFE_MINUTES } from "../../deployment-orchestrator/src/native-rollback.ts";
import { nativeDeployConfigured, nativeDeployEligible } from "../../deployment-orchestrator/src/native-deploy.ts";
import { recordNativeDeploy, recordRollback } from "../../platform-registry/src/index.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const ACCOUNT = "a".repeat(32);
const OLD = "0a".repeat(20);
const NEW = "1b".repeat(20);
const MIGRATIONS = ["0001_init.sql", "0002_more.sql"];
const CONTROL_PLANE = unitForService("cryptophys-policy-engine")!;
const CONSOLE = unitForService("cryptophys-console")!;
const realFetch = globalThis.fetch;

const nextSafeMinute = (after: number): number => {
  const first = Math.ceil(after / 60_000) * 60_000;
  for (let i = 0; i < 60; i++) {
    const candidate = first + i * 60_000;
    if (SAFE_MINUTES.includes(new Date(candidate).getUTCMinutes())) return candidate;
  }
  throw new Error("no safe minute found");
};

// ---------------------------------------------------------------- the Forge's bundles (R2)
function bucket() {
  const objects = new Map<string, { value: string; uploaded: Date }>();
  const b: BundleBucket & { objects: typeof objects; get(key: string): Promise<{ text(): Promise<string> } | null> } = {
    objects,
    async put(key, value) { objects.set(key, { value, uploaded: new Date() }); return {}; },
    async get(key) { const o = objects.get(key); return o ? { text: async () => o.value } : null; },
    async list({ prefix = "", cursor, limit = 1000 } = {}) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      return { objects: page.map((key) => ({ key, uploaded: objects.get(key)!.uploaded })), truncated: start + limit < keys.length, cursor: String(start + limit) };
    },
    async delete(keys) { for (const k of [keys].flat()) objects.delete(k); },
  };
  return b;
}
const toml = (name: string, extra = "") => `name = "${name}"\nmain = "src/worker.ts"\ncompatibility_date = "2026-11-01"\ncompatibility_flags = ["nodejs_compat"]\n${extra}`;
const moduleText = (name: string, commit: string) => `export default { fetch() { return new Response("${name} ${commit.slice(0, 12)}"); } };`;
type Tweak = { toml?: string; external?: string[]; omit?: boolean };
async function bundlesFor(b: ReturnType<typeof bucket>, commit: string, tweaks: Record<string, Tweak> = {}, migrations: string[] | null = MIGRATIONS) {
  const built: BuiltModule[] = [];
  for (const u of DEPLOY_UNITS) for (const name of u.services) {
    const t = tweaks[name] ?? {};
    if (t.omit) continue;
    built.push({ dir: `workers/${name.replace("cryptophys-", "")}`, text: moduleText(name, commit), toml: toml(name, t.toml ?? ""), external: t.external ?? [] });
  }
  await storeBundles(b, commit, built, Date.now(), migrations ?? undefined);
}

// ---------------------------------------------------------------- D1: registry, the Forge's head, a passed proposal
function lockNs() {
  const stores = new Map<string, Map<string, unknown>>();
  return { idFromName: (n: string) => n, get: (id: unknown) => {
    const key = String(id); if (!stores.has(key)) stores.set(key, new Map()); const data = stores.get(key)!;
    const lock = new DeploymentLock({ storage: { get: async (k: string) => data.get(k) as never, put: async (k: string, v: unknown) => { data.set(k, v); }, delete: async (k: string) => data.delete(k) }, blockConcurrencyWhile: (cb) => cb() });
    return { fetch: (i: RequestInfo | URL, init?: RequestInit) => lock.fetch(new Request(i, init)) };
  } };
}
let n = 0;
function passedProposal(db: Db, target: string): { proposal: string; decision: string } {
  n++;
  const proposal = `cns_${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
  const decision = `dec_${String(n).padStart(8, "0")}-2222-4222-8222-222222222222`;
  const at = new Date().toISOString();
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES (?, 'supervisor', 'deploy_commit', ?, 'routine', ?, '{}', 'deploy', 8, 8, 0, 1, ?, 'allow', 'executing', NULL, ?, ?)`).run(proposal, target, JSON.stringify({ commit_sha: NEW }), decision, at, at);
  db.raw.prepare(`INSERT INTO policy_decisions (decision_id, subject, action, resource, decision, reason, evidence_json, created_at) VALUES (?, 'ai:kernel', 'consensus.execute', ?, 'allow', 'ok', '{}', ?)`)
    .run(decision, `deploy_commit:${target}`, at);
  return { proposal, decision };
}
async function scenario() {
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  db.raw.prepare("UPDATE service_registry SET desired_version = ?").run(OLD.slice(0, 12));
  await forgeSees(db, { main: NEW, files: ["workers/console/src/index.ts", "workers/policy-engine/src/index.ts"], ready: true });
  const b = bucket();
  await bundlesFor(b, OLD);
  return { db, b };
}

// ---------------------------------------------------------------- a fake Workers Versions/Deployments API
const BINDINGS = [
  { type: "d1", name: "DB", id: "db-uuid" },
  { type: "secret_text", name: "ACCESS_GROUPS_TOKEN" },
  { type: "plain_text", name: "ACCESS_AUD", text: "aud" },
  { type: "service", name: "AGENTS", service: "cryptophys-ai-kernel", entrypoint: "AgentRpc", props: { host_worker: "x" } },
  { type: "version_metadata", name: "CF_VERSION_METADATA" },
];
interface Script { active: { version_id: string; percentage: number }[]; versions: Map<string, { bindings: unknown[]; tag?: string }> }
function fakeCloudflare(services: string[], opts: { uploadedBindings?: (svc: string, kept: unknown[]) => unknown[] } = {}) {
  const scripts = new Map<string, Script>();
  let v = 0;
  const uuid = () => `${String(++v).padStart(8, "0")}-0000-4000-8000-000000000000`;
  for (const s of services) { const id = uuid(); scripts.set(s, { active: [{ version_id: id, percentage: 100 }], versions: new Map([[id, { bindings: structuredClone(BINDINGS) }]]) }); }
  const calls: string[] = [];
  const uploads: { script: string; metadata: any; moduleName: string; moduleType: string; moduleText: string }[] = [];
  const deployments: { script: string; body: any }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const m = new RegExp(`^https://api\\.cloudflare\\.com/client/v4/accounts/${ACCOUNT}/workers/scripts/([a-z0-9-]+)/(.*)$`).exec(url);
    assert.ok(m, `unexpected ${url}`);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer deploy-token");
    const [, script, rest] = m!;
    const s = scripts.get(script);
    assert.ok(s, `unknown script ${script}`);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${script} ${rest.replace(/[0-9a-f-]{36}/, "<id>")}`);
    if (rest === "deployments" && method === "GET") return Response.json({ success: true, result: { deployments: [{ created_on: "2026-11-12T00:00:00Z", versions: s!.active }] } });
    if (rest === "deployments" && method === "POST") {
      const body = JSON.parse(String(init!.body));
      deployments.push({ script, body });
      s!.active = body.versions;
      return Response.json({ success: true, result: { id: "dep" } });
    }
    if (rest === "versions" && method === "POST") {
      const form = init!.body as FormData;
      assert.ok(form instanceof FormData, "a version upload is multipart");
      assert.equal(new Headers(init?.headers).get("content-type"), null, "fetch sets the multipart boundary itself");
      const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
      const mod = form.get(metadata.main_module) as File;
      uploads.push({ script, metadata, moduleName: mod.name, moduleType: mod.type, moduleText: await mod.text() });
      const latest = [...s!.versions.values()].at(-1)!;
      const id = uuid();
      s!.versions.set(id, { bindings: opts.uploadedBindings ? opts.uploadedBindings(script, structuredClone(latest.bindings)) : structuredClone(latest.bindings), tag: metadata.annotations["workers/tag"] });
      return Response.json({ success: true, result: { id, number: v } });
    }
    const vm = /^versions\/([0-9a-f-]{36})$/.exec(rest);
    if (vm && method === "GET") {
      const ver = s!.versions.get(vm[1]);
      return ver ? Response.json({ success: true, result: { id: vm[1], resources: { bindings: ver.bindings } } }) : Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  const tagOf = (svc: string) => scripts.get(svc)!.versions.get(scripts.get(svc)!.active[0].version_id)?.tag ?? OLD.slice(0, 12);
  return { fetcher, calls, uploads, deployments, scripts, tagOf };
}

function nativeEnv(db: Db, b: ReturnType<typeof bucket> | undefined, extra: Record<string, unknown> = {}) {
  const reports: any[] = [];
  const env = baseEnv("cryptophys-deployment-orchestrator", db, {
    GH_ACTIONS_TOKEN: "", DEPLOYMENT_LOCK: lockNs(), CF_DEPLOY_TOKEN: "deploy-token", CF_ACCOUNT_ID: ACCOUNT,
    BUNDLES: b,
    DRIFT: { probeService: async () => ({ reachable: true, healthy: true, version_tag: NEW.slice(0, 12), error: null }) },
    REGISTRY: { recordRollback: (id: string) => recordRollback({ DB: db } as never, id), recordNativeDeploy: (id: string) => recordNativeDeploy({ DB: db } as never, id) },
    AGENTS: { syscall: async (_agent: string, _cap: string, input: unknown) => { reports.push(input); return { outcome: "succeeded" }; } },
    ...extra,
  });
  return { env, reports };
}
const noGitHub = () => {
  globalThis.fetch = (async (i: RequestInfo | URL) => { throw new Error(`GitHub must not be called: ${String(i)}`); }) as typeof fetch;
};
const desired = (db: Db, svc: string) => (db.raw.prepare("SELECT desired_version FROM service_registry WHERE service_id = ?").get(svc) as any).desired_version;

// ---------------------------------------------------------------- tests
test("G2b-1. eligibility: code only for every Worker of the unit, against the bundle of the version each one runs", async () => {
  const cases: Array<[string, Record<string, Tweak>, string[] | null, string, string?]> = [
    ["eligible", {}, MIGRATIONS, "eligible"],
    ["a wrangler.toml change", { "cryptophys-recovery-manager": { toml: "[vars]\nX = \"1\"\n" } }, MIGRATIONS, "config_changed", "cryptophys-recovery-manager"],
    ["static assets", { "cryptophys-audit-ledger": { toml: "[assets]\ndirectory = \"dist\"\n" } }, MIGRATIONS, "assets", "cryptophys-audit-ledger"],
    ["a module the bundle does not inline", { "cryptophys-ai-kernel": { external: ["a.wasm"] } }, MIGRATIONS, "multi_module", "cryptophys-ai-kernel"],
    ["a new migration", {}, [...MIGRATIONS, "0003_new.sql"], "new_migration", "cryptophys-policy-engine"],
    ["a Worker missing from the target bundle", { "cryptophys-drift-detector": { omit: true } }, MIGRATIONS, "service_not_in_bundle", "cryptophys-drift-detector"],
    ["a target manifest without migrations (G2a)", {}, null, "migrations_unknown"],
  ];
  for (const [label, tweaks, migrations, expect, service] of cases) {
    const { db, b } = await scenario();
    await bundlesFor(b, NEW, tweaks, migrations);
    const e = await nativeDeployEligible({ DB: db as never, BUNDLES: b }, CONTROL_PLANE, NEW);
    if (expect === "eligible") {
      assert.equal(e.eligible, true, label);
      assert.deepEqual(e.eligible && e.services.map((s) => s.service), [...CONTROL_PLANE.services], "unit order");
    } else {
      assert.deepEqual(e.eligible ? "eligible" : [e.reason, e.service], [expect, service], label);
    }
  }
  // Missing evidence on either side.
  const { db, b } = await scenario();
  assert.deepEqual(await nativeDeployEligible({ DB: db as never, BUNDLES: b }, CONSOLE, NEW), { eligible: false, reason: "no_bundle" });
  await bundlesFor(b, NEW);
  db.raw.prepare("UPDATE service_registry SET desired_version = 'cccccccccccc' WHERE service_id = 'cryptophys-console'").run();
  assert.deepEqual(await nativeDeployEligible({ DB: db as never, BUNDLES: b }, CONSOLE, NEW), { eligible: false, reason: "running_bundle_missing", service: "cryptophys-console" });
  db.raw.prepare("UPDATE service_registry SET desired_version = NULL WHERE service_id = 'cryptophys-console'").run();
  assert.deepEqual(await nativeDeployEligible({ DB: db as never, BUNDLES: b }, CONSOLE, NEW), { eligible: false, reason: "desired_version_unknown", service: "cryptophys-console" });
  // The running version's manifest predates the migrations field (G2a): unknown, not equal.
  const g2a = await scenario();
  for (const k of [...g2a.b.objects.keys()]) g2a.b.objects.delete(k);
  await bundlesFor(g2a.b, OLD, {}, null);
  await bundlesFor(g2a.b, NEW);
  assert.deepEqual(await nativeDeployEligible({ DB: g2a.db as never, BUNDLES: g2a.b }, CONSOLE, NEW), { eligible: false, reason: "migrations_unknown", service: "cryptophys-console" });
  // A broken bucket is ineligible, never an error.
  const broken = { get: async () => { throw new Error("r2 down"); }, list: async () => { throw new Error("r2 down"); } };
  assert.deepEqual(await nativeDeployEligible({ DB: db as never, BUNDLES: broken }, CONSOLE, NEW), { eligible: false, reason: "bundle_read_failed" });
});

test("G2b-2. happy path: queued without GitHub, then uploaded, bindings compared, deployed, verified and recorded for every Worker in order", async () => {
  const { db, b } = await scenario();
  await bundlesFor(b, NEW);
  const { env, reports } = nativeEnv(db, b);
  assert.equal(nativeDeployConfigured(env as never), true);
  noGitHub();
  try {
    const { proposal, decision } = passedProposal(db, "cryptophys-policy-engine");
    const r = await deployForConsensus(env as never, proposal, decision, "cryptophys-policy-engine", { commit_sha: NEW });
    assert.equal(r.dispatched, true);
    assert.equal(r.executor, "native:deploy");
    assert.match(String(r.request_id), /^dep_[0-9a-f-]{36}$/);
    const row = db.raw.prepare("SELECT status, requested_version, requested_by, approval_id, idempotency_key, details_json FROM deployment_requests").get() as any;
    assert.deepEqual([row.status, row.requested_version, row.requested_by, row.approval_id, row.idempotency_key], ["approved", NEW, `consensus:${proposal}`, proposal, `consensus:${CONTROL_PLANE.workflow}:${NEW}`]);
    const details = JSON.parse(row.details_json);
    assert.equal(details.executor, "native:deploy");
    assert.equal(details.workflow, undefined, "the GitHub ledger reconcile never looks at a native request");
    assert.match(details.signature, /^[0-9a-f]{64}$/);
    assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'deployment.native_deploy_queued'").get() as any).n, 1);
    // The same commit is never queued or dispatched twice.
    const again = passedProposal(db, "cryptophys-policy-engine");
    assert.equal((await deployForConsensus(env as never, again.proposal, again.decision, "cryptophys-policy-engine", { commit_sha: NEW })).dispatched, false);

    const cf = fakeCloudflare([...CONTROL_PLANE.services]);
    assert.deepEqual(await runNativeExecutors(env as never, Date.parse("2026-11-12T03:07:00Z"), cf.fetcher, { delayMs: 0 }), { executed: 0, succeeded: 0 }, ":07 is a kernel cron minute");
    assert.deepEqual(await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 1 });

    // Upload metadata: the Forge's module, every binding type kept, the commit tag annotated.
    assert.deepEqual(cf.uploads.map((u) => u.script), [...CONTROL_PLANE.services], "the workflow's deploy order");
    for (const u of cf.uploads) {
      assert.equal(u.metadata.main_module, `${u.script}.mjs`);
      assert.equal(u.moduleName, `${u.script}.mjs`);
      assert.equal(u.moduleType, "application/javascript+module");
      assert.equal(u.moduleText, moduleText(u.script, NEW));
      assert.equal(u.metadata.compatibility_date, "2026-11-01");
      assert.deepEqual(u.metadata.compatibility_flags, ["nodejs_compat"]);
      assert.deepEqual(u.metadata.keep_bindings, [...KEEP_BINDINGS]);
      assert.equal(u.metadata.bindings, undefined, "no binding is ever sent");
      assert.equal(u.metadata.annotations["workers/tag"], NEW.slice(0, 12));
      assert.match(u.metadata.annotations["workers/message"], new RegExp(NEW));
    }
    // Per Worker: capture, read the active bindings, upload, read the new bindings, only then deploy.
    const first = CONTROL_PLANE.services[0];
    assert.deepEqual(cf.calls.filter((c) => c.split(" ")[1] === first), [
      `GET ${first} deployments`, `GET ${first} versions/<id>`, `POST ${first} versions`, `GET ${first} versions/<id>`, `POST ${first} deployments`,
    ]);
    assert.deepEqual(cf.deployments.map((d) => d.body.versions.length === 1 && d.body.versions[0].percentage), CONTROL_PLANE.services.map(() => 100));
    for (const svc of CONTROL_PLANE.services) assert.equal(cf.tagOf(svc), NEW.slice(0, 12));

    const done = db.raw.prepare("SELECT status, details_json FROM deployment_requests WHERE request_id = ?").get(String(r.request_id)) as any;
    assert.equal(done.status, "succeeded");
    assert.equal(JSON.parse(done.details_json).outcome.steps.at(-1), "desired_recorded");
    for (const svc of CONTROL_PLANE.services) assert.equal(desired(db, svc), NEW.slice(0, 12), svc);
    assert.equal(desired(db, "cryptophys-console"), OLD.slice(0, 12), "other units untouched");
    const sets = db.raw.prepare("SELECT actor FROM audit_events WHERE event_type = 'registry.desired_version_set'").all() as any[];
    assert.deepEqual(sets.map((s) => s.actor), CONTROL_PLANE.services.map(() => `native-deploy:${r.request_id}`));
    assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'deployment.native_deploy_succeeded'").get() as any).n, 1);
    assert.equal(reports.length, 0, "no critical report on success");
    assert.deepEqual(await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 61_000), cf.fetcher, { delayMs: 0 }), { executed: 0, succeeded: 0 }, "a finished request is not run again");
    const listed = (await listDeployments(env as never)).requests.find((x: any) => x.request_id === r.request_id) as any;
    assert.equal(listed.workflow, "native deploy");
  } finally { globalThis.fetch = realFetch; }
});

test("G2b-3. a binding difference after upload stops before traffic moves; the request fails with a critical report", async () => {
  for (const [label, change] of [
    ["a binding lost", (kept: any[]) => kept.filter((x) => x.name !== "ACCESS_GROUPS_TOKEN")],
    ["a binding's record changed (props)", (kept: any[]) => kept.map((x) => x.name === "AGENTS" ? { ...x, props: {} } : x)],
  ] as const) {
    const { db, b } = await scenario();
    await bundlesFor(b, NEW);
    const { env, reports } = nativeEnv(db, b);
    noGitHub();
    try {
      const { proposal, decision } = passedProposal(db, "cryptophys-console");
      const r = await deployForConsensus(env as never, proposal, decision, "cryptophys-console", { commit_sha: NEW });
      assert.equal(r.executor, "native:deploy", label);
      const cf = fakeCloudflare([...CONSOLE.services], { uploadedBindings: (_svc, kept) => change(kept) });
      assert.deepEqual(await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 0 });
      assert.equal(cf.uploads.length, 1, "the version was uploaded");
      assert.equal(cf.deployments.length, 0, `${label}: no deployment POST`);
      const row = db.raw.prepare("SELECT status, details_json FROM deployment_requests").get() as any;
      assert.equal(row.status, "failed");
      const outcome = JSON.parse(row.details_json).outcome;
      assert.equal(outcome.reason, "bindings_differ");
      assert.equal(outcome.restored, true);
      assert.equal(outcome.production_changed, false);
      assert.equal(desired(db, "cryptophys-console"), OLD.slice(0, 12));
      assert.equal(reports.length, 1);
      assert.equal(reports[0].severity, "critical");
      assert.match(reports[0].subject, /^Deploy of console at 1b1b1b1b1b1b failed$/);
    } finally { globalThis.fetch = realFetch; }
  }
});

test("G2b-4. a Worker that never reports live restores every captured deployment already changed", async () => {
  const { db, b } = await scenario();
  await bundlesFor(b, NEW);
  const failing = CONTROL_PLANE.services[2];
  const { env } = nativeEnv(db, b, {
    DRIFT: { probeService: async (svc: string) => ({ reachable: true, healthy: true, version_tag: svc === failing ? OLD.slice(0, 12) : NEW.slice(0, 12), error: null }) },
  });
  noGitHub();
  try {
    const { proposal, decision } = passedProposal(db, "cryptophys-policy-engine");
    await deployForConsensus(env as never, proposal, decision, "cryptophys-policy-engine", { commit_sha: NEW });
    const cf = fakeCloudflare([...CONTROL_PLANE.services]);
    const before = new Map(CONTROL_PLANE.services.map((s) => [s, structuredClone(cf.scripts.get(s)!.active)]));
    assert.deepEqual(await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 0 });
    assert.deepEqual(cf.uploads.map((u) => u.script), CONTROL_PLANE.services.slice(0, 3), "stops at the failing Worker");
    // Deployed 0, 1, 2; then restored 2, 1, 0.
    assert.deepEqual(cf.deployments.map((d) => d.script), [...CONTROL_PLANE.services.slice(0, 3), ...CONTROL_PLANE.services.slice(0, 3).reverse()]);
    for (const s of CONTROL_PLANE.services) assert.deepEqual(cf.scripts.get(s)!.active, before.get(s), `${s} runs its captured deployment`);
    const outcome = JSON.parse((db.raw.prepare("SELECT details_json FROM deployment_requests").get() as any).details_json).outcome;
    assert.deepEqual([outcome.ok, outcome.reason, outcome.service, outcome.restored], [false, "not_live_at_tag", failing, true]);
    for (const s of CONTROL_PLANE.services) assert.equal(desired(db, s), OLD.slice(0, 12), "nothing recorded");
    assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'deployment.native_deploy_failed'").get() as any).n, 1);
  } finally { globalThis.fetch = realFetch; }
});

test("G2b-5. not configured, or not code only: the GitHub dispatch exactly as before, with the reason in the audit", async () => {
  const github = (dispatched: any[], githubMain = NEW) => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: githubMain } });
      const m = /\/actions\/workflows\/([a-z-]+\.yml)\/dispatches$/.exec(url);
      if (m && init?.method === "POST") { dispatched.push({ workflow: m[1], body: JSON.parse(String(init.body)) }); return new Response(null, { status: 204 }); }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
  };
  try {
    for (const [label, configure] of [
      ["no deploy token", async (db: Db, b: ReturnType<typeof bucket>) => ({ env: nativeEnv(db, b, { GH_ACTIONS_TOKEN: "gh", CF_DEPLOY_TOKEN: undefined }).env, reason: "not_configured" })],
      ["no bundles binding", async (db: Db) => ({ env: nativeEnv(db, undefined, { GH_ACTIONS_TOKEN: "gh" }).env, reason: "not_configured" })],
      ["a configuration change", async (db: Db, b: ReturnType<typeof bucket>) => {
        await bundlesFor(b, NEW, { "cryptophys-console": { toml: "[vars]\nX = \"2\"\n" } });
        return { env: nativeEnv(db, b, { GH_ACTIONS_TOKEN: "gh" }).env, reason: "config_changed" };
      }],
    ] as const) {
      const { db, b } = await scenario();
      const { env, reason } = await configure(db, b);
      const dispatched: any[] = [];
      github(dispatched);
      const { proposal, decision } = passedProposal(db, "cryptophys-console");
      const r = await deployForConsensus(env as never, proposal, decision, "cryptophys-console", { commit_sha: NEW });
      assert.deepEqual(r, { dispatched: true, request_id: r.request_id, workflow: "deploy-console.yml", unit: "console", commit_sha: NEW }, label);
      assert.deepEqual(dispatched, [{ workflow: "deploy-console.yml", body: { ref: "main", inputs: { confirm_production: "DEPLOY", commit_sha: NEW } } }], label);
      const row = db.raw.prepare("SELECT status, details_json FROM deployment_requests").get() as any;
      assert.equal(row.status, "running");
      assert.equal(JSON.parse(row.details_json).workflow, "deploy-console.yml");
      const ev = JSON.parse((db.raw.prepare("SELECT payload_json FROM audit_events WHERE event_type = 'deployment.dispatched'").get() as any).payload_json);
      assert.equal(ev.native_deploy.reason, reason, label);
      const cf = fakeCloudflare([...CONSOLE.services]);
      await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 });
      assert.deepEqual(cf.calls, [], `${label}: the native executor never touches a GitHub request`);
    }
    // The GitHub path keeps the mirror check; the native path does not need GitHub at all.
    const { db, b } = await scenario();
    await bundlesFor(b, NEW, { "cryptophys-console": { toml: "[vars]\nX = \"2\"\n" } });
    const { env } = nativeEnv(db, b, { GH_ACTIONS_TOKEN: "gh" });
    const dispatched: any[] = [];
    github(dispatched, "9".repeat(40));
    const p = passedProposal(db, "cryptophys-console");
    await assert.rejects(deployForConsensus(env as never, p.proposal, p.decision, "cryptophys-console", { commit_sha: NEW }), /github_main_not_mirrored/);
    assert.deepEqual(dispatched, []);
    // Native configured, ineligible and no GitHub token: nothing can deploy it.
    const { env: noToken } = nativeEnv(db, b);
    const q = passedProposal(db, "cryptophys-console");
    await assert.rejects(deployForConsensus(noToken as never, q.proposal, q.decision, "cryptophys-console", { commit_sha: NEW }), /not_configured/);
    // The Forge gate still applies to the native path.
    const other = await scenario();
    await bundlesFor(other.b, NEW);
    const { env: nat } = nativeEnv(other.db, other.b);
    noGitHub();
    const s = passedProposal(other.db, "cryptophys-console");
    await assert.rejects(deployForConsensus(nat as never, s.proposal, s.decision, "cryptophys-console", { commit_sha: "2".repeat(40) }), /commit_not_current_main/);
    await forgeSees(other.db, { main: NEW, files: ["workers/console/src/index.ts"], ready: false });
    const t = passedProposal(other.db, "cryptophys-console");
    await assert.rejects(deployForConsensus(nat as never, t.proposal, t.decision, "cryptophys-console", { commit_sha: NEW }), /ci_not_green/);
  } finally { globalThis.fetch = realFetch; }
});

test("G2b-6. the executor re-checks the queue: signature, expiry, main's head and eligibility, before any Cloudflare call", async () => {
  const run = async (mutate: (db: Db, b: ReturnType<typeof bucket>) => Promise<void> | void, at?: number) => {
    const { db, b } = await scenario();
    await bundlesFor(b, NEW);
    const { env } = nativeEnv(db, b);
    noGitHub();
    try {
      const { proposal, decision } = passedProposal(db, "cryptophys-console");
      await deployForConsensus(env as never, proposal, decision, "cryptophys-console", { commit_sha: NEW });
      await mutate(db, b);
      const cf = fakeCloudflare([...CONSOLE.services]);
      await runNativeExecutors(env as never, at ?? nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 });
      assert.deepEqual(cf.calls, []);
      const row = db.raw.prepare("SELECT status, details_json FROM deployment_requests").get() as any;
      assert.equal(row.status, "failed");
      return JSON.parse(row.details_json).outcome.reason as string;
    } finally { globalThis.fetch = realFetch; }
  };
  assert.equal(await run((db) => {
    const r = db.raw.prepare("SELECT request_id, details_json FROM deployment_requests").get() as any;
    const d = JSON.parse(r.details_json); d.unit = "control-plane";
    db.raw.prepare("UPDATE deployment_requests SET details_json = ?").run(JSON.stringify(d));
  }), "invalid_native_deploy_request");
  assert.equal(await run((db) => {
    const r = db.raw.prepare("SELECT details_json FROM deployment_requests").get() as any;
    const d = JSON.parse(r.details_json); d.signature = "0".repeat(64);
    db.raw.prepare("UPDATE deployment_requests SET details_json = ?").run(JSON.stringify(d));
  }), "invalid_native_deploy_signature");
  assert.equal(await run(() => undefined, nextSafeMinute(Date.now() + NATIVE_DEPLOY_MAX_AGE_MS + 60_000)), "stale: native deploy request expired");
  assert.equal(await run(async (db) => { await forgeSees(db, { main: "3".repeat(40), files: [], ready: true }); }), "commit_not_current_main");
  assert.equal(await run(async (_db, b) => { await bundlesFor(b, NEW, { "cryptophys-console": { toml: "[vars]\nY = \"1\"\n" } }); }), "not_eligible: config_changed (cryptophys-console)");
});

test("G2b-7. the Registry records a native deploy only for a running native deploy request of the last hour, for every Worker of the unit", async () => {
  const db = migratedDb();
  const id = (k: number) => `dep_${String(k).repeat(8)}-1111-4111-8111-111111111111`;
  const insert = (k: number, status: string, details: object, version = NEW, created = new Date().toISOString(), service = "cryptophys-audit-ledger") => db.raw.prepare(
    `INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
     VALUES (?, ?, ?, 'x', ?, NULL, ?, ?, ?, ?)`).run(id(k), service, version, status, id(k), JSON.stringify(details), created, created);
  insert(1, "running", { executor: "native:rollback" });
  insert(2, "approved", { executor: "native:deploy" });
  insert(3, "running", { executor: "native:deploy" }, NEW, new Date(Date.now() - 2 * 3_600_000).toISOString());
  insert(4, "running", { executor: "native:deploy" }, NEW.slice(0, 12));
  insert(5, "running", { workflow: "deploy-control-plane.yml" });
  insert(6, "running", { executor: "native:deploy" });
  insert(7, "running", { executor: "native:deploy" }, NEW, new Date().toISOString(), "xauusd-ai-trading-assistant");
  const reg = { DB: db } as never;
  await assert.rejects(recordNativeDeploy(reg, "dep_bad"), /invalid_request_id/);
  await assert.rejects(recordNativeDeploy(reg, id(9)), /deploy_request_not_found/);
  await assert.rejects(recordNativeDeploy(reg, id(1)), /not_a_native_deploy/);
  await assert.rejects(recordNativeDeploy(reg, id(5)), /not_a_native_deploy/);
  await assert.rejects(recordNativeDeploy(reg, id(2)), /deploy_not_running/);
  await assert.rejects(recordNativeDeploy(reg, id(3)), /deploy_request_expired/);
  await assert.rejects(recordNativeDeploy(reg, id(4)), /invalid_version/);
  await assert.rejects(recordNativeDeploy(reg, id(7)), /no_deploy_unit_for_service/);
  assert.deepEqual(await recordNativeDeploy(reg, id(6)), { desired_version: NEW.slice(0, 12), services: [...CONTROL_PLANE.services] });
  for (const s of CONTROL_PLANE.services) assert.equal(desired(db, s), NEW.slice(0, 12), s);
  const sets = db.raw.prepare("SELECT subject, actor FROM audit_events WHERE event_type = 'registry.desired_version_set'").all() as any[];
  assert.deepEqual(sets.map((s) => [s.subject, s.actor]), CONTROL_PLANE.services.map((s) => [s, `native-deploy:${id(6)}`]));
  // A native rollback request is not a native deploy, and the reverse.
  await assert.rejects(recordRollback(reg, id(6)), /not_a_native_rollback/);
});

test("G2b-8. wiring: BUNDLES binding, the Control Plane order equals its workflow's, RPC, keep_bindings covers every binding the platform uses", async () => {
  const orch = read("workers/deployment-orchestrator/wrangler.toml");
  assert.match(orch, /\[\[r2_buckets\]\]\nbinding = "BUNDLES"\nbucket_name = "cryptophys-forge-bundles"/);
  const order = /DEPLOY_ORDER: "([a-z -]+)"/.exec(read(".github/workflows/deploy-control-plane.yml"))![1].split(" ").map((d) => `cryptophys-${d}`);
  assert.deepEqual([...CONTROL_PLANE.services], order, "native deploys follow the workflow's deploy order");
  assert.match(read("workers/platform-registry/src/worker.ts"), /async recordNativeDeploy\(requestId: string\)/);
  // Every binding table in a platform wrangler.toml, and the workflows' --var (plain_text), is a kept type.
  const TYPE: Record<string, string> = {
    "[[d1_databases]]": "d1", "[[services]]": "service", "[[durable_objects.bindings]]": "durable_object_namespace", "[[r2_buckets]]": "r2_bucket",
    "[[kv_namespaces]]": "kv_namespace", "[ai]": "ai", "[[vectorize]]": "vectorize", "[[workflows]]": "workflow", "[[artifacts]]": "artifacts",
    "[[worker_loaders]]": "worker_loader", "[version_metadata]": "version_metadata", "[[secrets_store_secrets]]": "secrets_store_secret",
    "[[send_email]]": "send_email", "[[analytics_engine_datasets]]": "analytics_engine", "[[queues.producers]]": "queue", "[browser]": "browser", "[vars]": "plain_text",
  };
  const NOT_BINDINGS = new Set(["[observability]", "[triggers]", "[[migrations]]", "[[rules]]", "[assets]", "[limits]", "[previews]", "[workflows.default_retention]", "[build]", "[placement]"]);
  for (const dir of readdirSync(new URL("workers/", ROOT))) {
    let text: string;
    try { text = read(`workers/${dir}/wrangler.toml`); } catch { continue; }
    for (const [section] of text.matchAll(/^\[\[?[a-z0-9_.]+\]\]?/gm)) {
      if (NOT_BINDINGS.has(section)) continue;
      assert.ok(TYPE[section], `workers/${dir}/wrangler.toml: ${section} is not a known binding table`);
      assert.ok((KEEP_BINDINGS as readonly string[]).includes(TYPE[section]), `${section} is kept`);
    }
  }
  for (const t of ["secret_text", "secret_key", "plain_text"]) assert.ok((KEEP_BINDINGS as readonly string[]).includes(t));
  // Readiness reports native deploy like native rollback (informational, not a gate).
  const db = migratedDb();
  const { env } = nativeEnv(db, bucket());
  assert.equal(nativeDeployConfigured(env as never), true);
  assert.equal(nativeDeployConfigured({ ...env, BUNDLES: undefined } as never), false);
  assert.equal(typeof worker.scheduled, "function");
});
