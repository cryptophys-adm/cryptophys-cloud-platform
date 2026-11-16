// 2026-11-16 (owner-approved): native deploys end with every Worker's service bindings equal to its wrangler.toml as the
// Forge stored it for the commit. Incident 2026-11-15 ~22:00-23:30 UTC: an out-of-band version of
// cryptophys-recovery-manager (most likely a dashboard secret edit) dropped the AGENTS binding's
// `props = { host_worker = "cryptophys-recovery-manager" }`; the AI Kernel's AgentRpc refused the caller
// (`caller_identity_missing`) and every Recovery Manager report was lost, and each later native deploy kept the loss
// (keep_bindings, the digest against the active version, the plan keeping unchanged records verbatim).
// Every path that uploads a version is covered: code only, configuration plan, break-glass and the rescue executor.
// Native rollback uploads nothing (it redeploys a version production ran), so it is exempt; BP11 shows that.
// Props unknown: it is not verified live that the versions API returns `props`. A record with no `props` key is
// therefore never drift by itself: the declared binding is still resent, the step
// `<worker>:service_binding_props_unverifiable:<NAME>` is recorded and no drift audit is written; a new version showing
// the declared props proves the loss (restored). BP12 runs every path against an API that omits `props` everywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { baseEnv, forgeSees, migratedDb } from "./harness.ts";
import { DEPLOY_UNITS, unitForService } from "../src/deploy-units.ts";
import { storeBundles, type BuiltModule, type BundleBucket } from "../../forge/src/bundles.ts";
import { DeploymentLock, deployForConsensus, runNativeExecutors } from "../../deployment-orchestrator/src/index.ts";
import { CloudflareWorkers, executeRollback, KEEP_BINDINGS, SAFE_MINUTES } from "../../deployment-orchestrator/src/native-rollback.ts";
import { executeNativeDeploy, nativeDeployEligible, type PlannedService } from "../../deployment-orchestrator/src/native-deploy.ts";
import { bindingsFromToml, parseToml, planConfigChange, type BindingRecord, type ConfigPlan } from "../../deployment-orchestrator/src/config-diff.ts";
import { breakGlassChoice } from "../../deployment-orchestrator/src/recovery-deploy.ts";
import { namedTopology as validateTopology, TOPOLOGY_ITEM } from "../src/break-glass.ts";
import { recordNativeDeploy, recordRollback } from "../../platform-registry/src/index.ts";
import {
  BINDING_DRIFT_DETECTED_EVENT, BINDING_DRIFT_REPAIRED_EVENT, declaredServiceBindings, unverifiableStep, declaredServiceBindingsFromToml, serviceBindingDrift, serviceDriftRefusal,
  verifyServiceBindings, type ServiceBinding,
} from "../src/service-bindings.ts";
import { RESCUE_KEEP_BINDINGS, RESCUE_MINUTES, RescueCloudflare, executeRescueDeploy, rescueChoice, rescueForRecovery } from "../src/executor-rescue.ts";
import { ORCHESTRATOR_SERVICE } from "../src/executor-first.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const ACCOUNT = "a".repeat(32);
const OLD = "0e".repeat(20);
const NEW = "5f".repeat(20);
const TAG = NEW.slice(0, 12);
const RM = "cryptophys-recovery-manager";
const CONTROL_PLANE = unitForService(RM)!;
const RM_TOML = read("workers/recovery-manager/wrangler.toml");
const D1_ID = "0f6a3c1e-1111-4222-8333-944445555666";
const realFetch = globalThis.fetch;

const agentsToml = (worker: string) => `[[services]]\nbinding = "AGENTS"\nservice = "cryptophys-ai-kernel"\nentrypoint = "AgentRpc"\nprops = { host_worker = "${worker}" }\n`;
/** A minimal config for every Worker but the Recovery Manager, which uses its real wrangler.toml. */
const tomlFor = (name: string) => name === RM ? RM_TOML
  : `name = "${name}"\nmain = "src/worker.ts"\ncompatibility_date = "2026-11-01"\ncompatibility_flags = ["nodejs_compat"]\n\n${agentsToml(name)}`;

/** What `wrangler deploy` of `toml` leaves on the version: rendered placeholders, the API's own fields, a secret. */
function deployedFrom(toml: string): BindingRecord[] {
  const b = bindingsFromToml(parseToml(toml)!).bindings!;
  return [...b.map((r) => {
    const o: BindingRecord = { ...r };
    if (o.type === "d1") o.id = D1_ID;
    if (o.type === "service") o.environment = "production";
    return o;
  }), { type: "secret_text", name: "CF_ACCESS_CLIENT_SECRET" }];
}
const stripProps = (bindings: BindingRecord[], name = "AGENTS") => bindings.map((b) => b.name === name ? Object.fromEntries(Object.entries(b).filter(([k]) => k !== "props")) as BindingRecord : b);
const stripAll = (bindings: BindingRecord[]) => bindings.map((b) => b.type === "service" ? Object.fromEntries(Object.entries(b).filter(([k]) => k !== "props")) as BindingRecord : b);
const withField = (bindings: BindingRecord[], name: string, field: Record<string, unknown>) => bindings.map((b) => b.name === name ? { ...b, ...field } : b);

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
type Bucket = ReturnType<typeof bucket>;
/** main's migrations: exactly what the test database's ledger lists, so none is pending. */
const MIGRATIONS = (migratedDb().raw.prepare("SELECT name FROM d1_migrations ORDER BY id").all() as Array<{ name: string }>).map((r) => r.name);
async function bundlesFor(b: Bucket, commit: string, tomls: Record<string, string> = {}) {
  const built: BuiltModule[] = [];
  for (const u of DEPLOY_UNITS) for (const name of u.services) {
    if (name === "cryptophys-console") continue;
    built.push({ dir: `workers/${name.replace("cryptophys-", "")}`, text: `export default { fetch() { return new Response("${name} ${commit.slice(0, 12)}"); } };`, toml: tomls[name] ?? tomlFor(name), external: [] });
  }
  await storeBundles(b, commit, built, Date.now(), MIGRATIONS, { migrationSql: Object.fromEntries(MIGRATIONS.map((f) => [f, `-- ${f}\nSELECT 1;\n`])), externals: async () => new Map() });
}

// ---------------------------------------------------------------- a Workers API that honours `bindings` and `keep_bindings`
interface Version { bindings: BindingRecord[]; tag?: string; runtime: Record<string, unknown> }
interface Upload { script: string; metadata: any }
/**
 * Every script's versions and active deployment. A version upload binds what it sends (the API adds a service
 * binding's `environment`) plus the records of the kept types from the script's LATEST version, as Cloudflare does.
 * `afterUpload` may change what the new version binds (a broken upload). `listed` are the account's script names.
 */
function fakeCloudflare(active: Record<string, BindingRecord[]>, opts: { listed?: string[]; afterUpload?: (svc: string, b: BindingRecord[]) => BindingRecord[]; onlyScript?: string; token?: string; omitProps?: boolean } = {}) {
  let n = 0;
  const uuid = () => `${String(++n).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const scripts = new Map<string, { active: Array<{ version_id: string; percentage: number }>; versions: Map<string, Version>; first: string }>();
  for (const [svc, bindings] of Object.entries(active)) {
    const id = uuid();
    scripts.set(svc, { active: [{ version_id: id, percentage: 100 }], versions: new Map([[id, { bindings: structuredClone(bindings), runtime: { compatibility_date: "2026-11-01", compatibility_flags: [] } }]]), first: id });
  }
  const uploads: Upload[] = [];
  const deployments: Array<{ script: string; versions: Array<{ version_id: string; percentage: number }> }> = [];
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${opts.token ?? "deploy-token"}`);
    if (url === `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts` && method === "GET") {
      calls.push("GET scripts");
      return Response.json({ success: true, result: (opts.listed ?? [...scripts.keys()]).map((id) => ({ id })) });
    }
    const m = new RegExp(`^https://api\\.cloudflare\\.com/client/v4/accounts/${ACCOUNT}/workers/scripts/([a-z0-9-]+)/(.*)$`).exec(url);
    assert.ok(m, `unexpected ${method} ${url}`);
    const [, script, rest] = m!;
    if (opts.onlyScript) assert.equal(script, opts.onlyScript);
    const s = scripts.get(script);
    assert.ok(s, `unknown script ${script}`);
    calls.push(`${method} ${script} ${rest.replace(/[0-9a-f-]{36}/, "<id>")}`);
    if (rest === "deployments" && method === "GET") return Response.json({ success: true, result: { deployments: [{ created_on: "2026-11-16T00:00:00Z", versions: s!.active }] } });
    if (rest === "deployments" && method === "POST") {
      const body = JSON.parse(String(init!.body));
      deployments.push({ script, versions: body.versions });
      s!.active = body.versions;
      return Response.json({ success: true, result: { id: "dep" } });
    }
    if (rest === "versions" && method === "POST") {
      const metadata = JSON.parse(await ((init!.body as FormData).get("metadata") as Blob).text());
      uploads.push({ script, metadata });
      const latest = [...s!.versions.values()].at(-1)!;
      const sent: BindingRecord[] = (metadata.bindings ?? []).map((b: BindingRecord) => b.type === "service" && b.environment === undefined ? { ...b, environment: "production" } : { ...b });
      const keep: string[] = metadata.keep_bindings ?? [];
      const kept = latest.bindings.filter((b) => keep.includes(b.type) && !sent.some((x) => x.name === b.name));
      const bindings = [...structuredClone(kept), ...sent];
      const id = uuid();
      s!.versions.set(id, { bindings: opts.afterUpload ? opts.afterUpload(script, bindings) : bindings, tag: metadata.annotations["workers/tag"],
        runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags ?? [], ...(metadata.limits ? { limits: metadata.limits } : {}) } });
      return Response.json({ success: true, result: { id } });
    }
    const vm = /^versions\/([0-9a-f-]{36})$/.exec(rest);
    if (vm && method === "GET") {
      const v = s!.versions.get(vm[1]);
      // omitProps: an API that never returns a service binding's props (what it stores is unchanged).
      const shown = !v ? [] : opts.omitProps ? stripAll(v.bindings) : v.bindings;
      return v ? Response.json({ success: true, result: { id: vm[1], resources: { bindings: structuredClone(shown), script_runtime: v.runtime } } })
        : Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  const activeBindings = (svc: string) => { const sc = scripts.get(svc)!; return sc.versions.get(sc.active[0].version_id)!.bindings; };
  const tagOf = (svc: string) => { const sc = scripts.get(svc)!; return sc.versions.get(sc.active[0].version_id)!.tag ?? OLD.slice(0, 12); };
  return { fetcher, uploads, deployments, calls, scripts, activeBindings, tagOf };
}
type Fake = ReturnType<typeof fakeCloudflare>;
/** Production as `wrangler deploy` of the running commit left it, then the incident applied to the Recovery Manager. */
const production = (rm: (b: BindingRecord[]) => BindingRecord[] = (b) => b, tomls: Record<string, string> = {}) =>
  Object.fromEntries(CONTROL_PLANE.services.map((s) => [s, s === RM ? rm(deployedFrom(tomls[s] ?? tomlFor(s))) : deployedFrom(tomls[s] ?? tomlFor(s))]));

// ---------------------------------------------------------------- D1 and the Orchestrator's env
function lockNs() {
  const stores = new Map<string, Map<string, unknown>>();
  return { idFromName: (x: string) => x, get: (id: unknown) => {
    const key = String(id); if (!stores.has(key)) stores.set(key, new Map()); const data = stores.get(key)!;
    const lock = new DeploymentLock({ storage: { get: async (k: string) => data.get(k) as never, put: async (k: string, v: unknown) => { data.set(k, v); }, delete: async (k: string) => data.delete(k) }, blockConcurrencyWhile: (cb) => cb() });
    return { fetch: (i: RequestInfo | URL, init?: RequestInit) => lock.fetch(new Request(i, init)) };
  } };
}
let seq = 0;
function passedProposal(db: Db, target: string) {
  seq++;
  const proposal = `cns_${String(seq).padStart(8, "0")}-1111-4111-8111-111111111116`;
  const decision = `dec_${String(seq).padStart(8, "0")}-2222-4222-8222-222222222226`;
  const at = new Date().toISOString();
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES (?, 'supervisor', 'deploy_commit', ?, 'routine', ?, '{}', 'deploy', 8, 8, 0, 1, ?, 'allow', 'executing', NULL, ?, ?)`).run(proposal, target, JSON.stringify({ commit_sha: NEW }), decision, at, at);
  db.raw.prepare(`INSERT INTO policy_decisions (decision_id, subject, action, resource, decision, reason, evidence_json, created_at) VALUES (?, 'ai:kernel', 'consensus.execute', ?, 'allow', 'ok', '{}', ?)`)
    .run(decision, `deploy_commit:${target}`, at);
  return { proposal, decision };
}
async function scenario(target: Record<string, string> = {}) {
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  db.raw.prepare("UPDATE service_registry SET desired_version = ?").run(OLD.slice(0, 12));
  await forgeSees(db, { main: NEW, files: ["workers/recovery-manager/src/index.ts"], ready: true });
  const b = bucket();
  await bundlesFor(b, OLD);
  await bundlesFor(b, NEW, target);
  return { db, b };
}
function nativeEnv(db: Db, b: Bucket) {
  const reports: any[] = [];
  const env = baseEnv("cryptophys-deployment-orchestrator", db, {
    GH_ACTIONS_TOKEN: "", DEPLOYMENT_LOCK: lockNs(), CF_DEPLOY_TOKEN: "deploy-token", CF_ACCOUNT_ID: ACCOUNT, BUNDLES: b,
    DRIFT: { probeService: async () => ({ reachable: true, healthy: true, version_tag: TAG, error: null }) },
    REGISTRY: { recordRollback: (id: string) => recordRollback({ DB: db } as never, id), recordNativeDeploy: (id: string) => recordNativeDeploy({ DB: db } as never, id) },
    AGENTS: { syscall: async (_a: string, _c: string, input: unknown) => { reports.push(input); return { outcome: "succeeded" }; } },
  });
  return { env, reports };
}
const nextSafeMinute = (after: number): number => {
  const first = Math.ceil(after / 60_000) * 60_000;
  for (let i = 0; i < 60; i++) { const c = first + i * 60_000; if (SAFE_MINUTES.includes(new Date(c).getUTCMinutes())) return c; }
  throw new Error("no safe minute");
};
const noGitHub = () => { globalThis.fetch = (async (i: RequestInfo | URL) => { throw new Error(`GitHub must not be called: ${String(i)}`); }) as typeof fetch; };
const events = (db: Db, type: string) => (db.raw.prepare("SELECT subject, outcome, payload_json FROM audit_events WHERE event_type = ? ORDER BY rowid").all(type) as any[])
  .map((r) => ({ subject: r.subject as string, outcome: r.outcome as string, payload: JSON.parse(r.payload_json) }));
const agents = (b: BindingRecord[]) => b.find((x) => x.name === "AGENTS");
/** An undeclared service binding is refused with its name only (no path drops it; the owner decides, 2026-11-16). */
const undeclaredRefusal = (name: string) => `service_binding_undeclared:${name}`;
const RM_AGENTS = { type: "service", name: "AGENTS", service: "cryptophys-ai-kernel", entrypoint: "AgentRpc", props: { host_worker: RM }, environment: "production" };

/** The Orchestrator's own plan and executor for the Control Plane unit, against `fake`. */
async function deployDirect(db: Db, b: Bucket, fake: Fake) {
  const cf = new CloudflareWorkers("deploy-token", ACCOUNT, fake.fetcher);
  const e = await nativeDeployEligible({ DB: db as never, BUNDLES: b }, CONTROL_PLANE, NEW, cf);
  assert.equal(e.eligible, true, JSON.stringify(e));
  const env = { DRIFT: { probeService: async () => ({ reachable: true, healthy: true, version_tag: TAG, error: null }) }, REGISTRY: { recordRollback: async () => ({ desired_version: "" }), recordNativeDeploy: async () => ({ desired_version: TAG, services: [] }) }, BUNDLES: b, DB: db as never };
  return { plan: (e as { services: PlannedService[] }).services, run: await executeNativeDeploy(cf, env, "dep_bp", NEW, (e as { services: PlannedService[] }).services, { delayMs: 0 }) };
}

// ---------------------------------------------------------------- tests
test("BP1. the declared service bindings: every workers/*/wrangler.toml reads them as the configuration plan does, props included", () => {
  const dirs = readdirSync(new URL("workers/", ROOT)).filter((d) => existsSync(new URL(`workers/${d}/wrangler.toml`, ROOT)));
  let withProps = 0;
  for (const d of dirs) {
    const text = read(`workers/${d}/wrangler.toml`);
    const declared = declaredServiceBindingsFromToml(text);
    assert.ok(!("reason" in declared), `${d}: ${JSON.stringify(declared)}`);
    const plan = bindingsFromToml(parseToml(text)!).bindings!.filter((b) => b.type === "service");
    assert.deepEqual((declared as { bindings: ServiceBinding[] }).bindings, [...plan].sort((a, b) => a.name.localeCompare(b.name)), d);
    withProps += (declared as { bindings: ServiceBinding[] }).bindings.filter((b) => b.props).length;
  }
  assert.ok(withProps >= 3, `${withProps} declared bindings carry props`);
  // The incident's binding, as the Recovery Manager's reviewed config declares it (wrangler.toml lines ~100-104).
  const rm = declaredServiceBindingsFromToml(RM_TOML) as { bindings: ServiceBinding[] };
  assert.deepEqual(rm.bindings.find((b) => b.name === "AGENTS"), { type: "service", name: "AGENTS", service: "cryptophys-ai-kernel", entrypoint: "AgentRpc", props: { host_worker: RM } });
  // Anything unreadable is refused, never guessed.
  assert.deepEqual(declaredServiceBindingsFromToml("name = ["), { reason: "config_unparsed" });
  assert.deepEqual(declaredServiceBindings(parseToml('[[services]]\nbinding = "A"\nservice = "x"\nweird = 1\n')!), { reason: "unsupported_binding_field:services.weird" });
  assert.deepEqual(declaredServiceBindings(parseToml('[[services]]\nbinding = "A"\nservice = "x"\n[[services]]\nbinding = "A"\nservice = "y"\n')!), { reason: "duplicate_binding_name:A" });
  assert.deepEqual(declaredServiceBindings(parseToml('[[services]]\nbinding = "A"\nservice = "x"\nprops = "host"\n')!), { reason: "services_unreadable:A" });
  assert.deepEqual(declaredServiceBindings(parseToml('name = "w"\n')!), { bindings: [] });
});

test("BP2. the comparison: missing, service, entrypoint and props (deep-equal), undeclared and name conflicts; the API's environment is not a difference", () => {
  const declared = (declaredServiceBindingsFromToml(RM_TOML) as { bindings: ServiceBinding[] }).bindings;
  const good = deployedFrom(RM_TOML);
  assert.deepEqual(serviceBindingDrift(declared, good), { restore: [], undeclared: [], conflicts: [], unverifiable: [] }, "as wrangler deployed it");
  // No `props` key at all: unknown, not drift (the API may simply not return props); `{}` is present and differs.
  assert.deepEqual(serviceBindingDrift(declared, stripProps(good)), { restore: [], undeclared: [], conflicts: [], unverifiable: ["AGENTS"] }, "the incident, as an API without props shows it");
  assert.deepEqual(serviceBindingDrift(declared, withField(good, "AGENTS", { props: {} }))!.restore, [{ name: "AGENTS", kinds: ["props"], retarget: false }]);
  assert.deepEqual(serviceBindingDrift(declared, withField(stripProps(good), "AGENTS", { entrypoint: "HealthRpc" })), { restore: [{ name: "AGENTS", kinds: ["entrypoint"], retarget: false }], undeclared: [], conflicts: [], unverifiable: ["AGENTS"] });
  assert.deepEqual(serviceBindingDrift(declared, withField(good, "AGENTS", { props: { host_worker: "cryptophys-ai-kernel" } }))!.restore, [{ name: "AGENTS", kinds: ["props"], retarget: false }]);
  assert.deepEqual(serviceBindingDrift(declared, withField(good, "AGENTS", { props: { host_worker: RM, extra: 1 } }))!.restore[0].kinds, ["props"], "props compare deep, not by key");
  assert.deepEqual(serviceBindingDrift(declared, withField(good, "AGENTS", { entrypoint: "HealthRpc" }))!.restore, [{ name: "AGENTS", kinds: ["entrypoint"], retarget: false }]);
  assert.deepEqual(serviceBindingDrift(declared, withField(good, "AGENTS", { service: "cryptophys-forge" }))!.restore, [{ name: "AGENTS", kinds: ["service"], retarget: true }]);
  assert.deepEqual(serviceBindingDrift(declared, good.filter((b) => b.name !== "AGENTS"))!.restore, [{ name: "AGENTS", kinds: ["missing"], retarget: true }]);
  const extra = [...good, { type: "service", name: "EXTRA", service: "cryptophys-forge", environment: "production" }];
  assert.deepEqual(serviceBindingDrift(declared, extra), { restore: [], undeclared: ["EXTRA"], conflicts: [], unverifiable: [] });
  assert.equal(serviceDriftRefusal(serviceBindingDrift(declared, extra)!), "service_binding_undeclared:EXTRA");
  const conflict = [...good.filter((b) => b.name !== "AGENTS"), { type: "plain_text", name: "AGENTS", text: "x" }];
  assert.equal(serviceDriftRefusal(serviceBindingDrift(declared, conflict)!), "service_binding_name_conflict:AGENTS");
  assert.equal(serviceBindingDrift(declared, "nope"), null, "unreadable fails closed");
  // After the upload: exactly the declared values, props included.
  assert.deepEqual(verifyServiceBindings(declared, good), { ok: true, unverifiable: [] });
  assert.deepEqual(verifyServiceBindings(declared, stripProps(good)), { ok: true, unverifiable: ["AGENTS"] }, "no props key: accepted, named");
  assert.deepEqual(verifyServiceBindings(declared, withField(good, "AGENTS", { props: { host_worker: "x" } })), { ok: false, reason: "service_binding_props_differs", binding: "AGENTS" });
  assert.deepEqual(verifyServiceBindings(declared, withField(stripProps(good), "AGENTS", { entrypoint: "HealthRpc" })), { ok: false, reason: "service_binding_entrypoint_differs", binding: "AGENTS" });
  assert.deepEqual(verifyServiceBindings(declared, extra), { ok: false, reason: "service_binding_unexpected", binding: "EXTRA" });
  assert.deepEqual(verifyServiceBindings(declared, withField(good, "AGENTS", { environment: "staging" })), { ok: false, reason: "service_binding_environment_differs", binding: "AGENTS" });
});

test("BP3. the incident, code only: the AGENTS props stripped out of band are sent again, verified on the new version, recorded and audited", async () => {
  const { db, b } = await scenario();
  const { env, reports } = nativeEnv(db, b);
  noGitHub();
  try {
    const { proposal, decision } = passedProposal(db, "cryptophys-policy-engine");
    const r = await deployForConsensus(env as never, proposal, decision, "cryptophys-policy-engine", { commit_sha: NEW });
    assert.equal(r.executor, "native:deploy", JSON.stringify(r));
    const cf = fakeCloudflare(production(stripProps));
    assert.equal(agents(cf.activeBindings(RM))!.props, undefined, "production as the dashboard edit left it");
    assert.deepEqual(await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 1 });
    // Only the drifted Worker's upload sends its declared service bindings; `service` is then not a kept type.
    for (const u of cf.uploads) {
      if (u.script === RM) {
        assert.deepEqual(u.metadata.bindings, (declaredServiceBindingsFromToml(RM_TOML) as { bindings: ServiceBinding[] }).bindings);
        assert.deepEqual(u.metadata.keep_bindings, KEEP_BINDINGS.filter((t) => t !== "service"));
      } else {
        assert.equal(u.metadata.bindings, undefined, `${u.script}: unchanged code-only upload`);
        assert.deepEqual(u.metadata.keep_bindings, [...KEEP_BINDINGS]);
      }
    }
    // Production now binds the declared props, and everything else exactly as before.
    assert.deepEqual(agents(cf.activeBindings(RM)), RM_AGENTS);
    assert.deepEqual(cf.activeBindings(RM).filter((x) => x.type !== "service").map((x) => `${x.type}:${x.name}`).sort(),
      deployedFrom(RM_TOML).filter((x) => x.type !== "service").map((x) => `${x.type}:${x.name}`).sort());
    for (const s of CONTROL_PLANE.services) assert.equal(cf.tagOf(s), TAG);
    const row = db.raw.prepare("SELECT status, details_json FROM deployment_requests").get() as any;
    assert.equal(row.status, "succeeded");
    const outcome = JSON.parse(row.details_json).outcome;
    assert.ok(outcome.steps.includes(`${RM}:service_bindings_restored:AGENTS`), outcome.steps.join(" "));
    // The active record had no props key (unknown); the new version shows the declared props, which proves the loss.
    assert.equal(outcome.steps.filter((x: string) => x === unverifiableStep(RM, "AGENTS")).length, 1);
    assert.ok(outcome.steps.indexOf(unverifiableStep(RM, "AGENTS")) < outcome.steps.indexOf(`${RM}:service_bindings_restored:AGENTS`));
    assert.ok(outcome.steps.indexOf(`${RM}:bindings_match`) < outcome.steps.indexOf(`${RM}:deployed`), "verified before traffic moves");
    assert.equal(outcome.steps.filter((x: string) => x.includes("service_bindings_restored")).length, 1, "only the drifted binding");
    assert.deepEqual(outcome.binding_drift, { [RM]: { restored: [{ name: "AGENTS", kinds: ["props"], retarget: false }], undeclared: [], repaired: true } });
    // Visible: no "detected" event before the upload (props unknown alone), repaired once the loss is proven and the
    // Worker is live; names only.
    const detected = events(db, BINDING_DRIFT_DETECTED_EVENT);
    assert.deepEqual(detected, []);
    const repaired = events(db, BINDING_DRIFT_REPAIRED_EVENT);
    assert.deepEqual(repaired.map((x) => [x.subject, x.outcome, x.payload.bindings]), [[RM, "repaired", ["AGENTS"]]]);
    assert.ok(!JSON.stringify([...detected, ...repaired]).includes("host_worker"), "no binding value in the audit chain");
    assert.equal(reports.length, 0);
    // The next deploy finds nothing to repair: the code-only upload is the unchanged one.
    const again = fakeCloudflare(Object.fromEntries(CONTROL_PLANE.services.map((s) => [s, cf.activeBindings(s)])));
    const second = await deployDirect(db, b, again);
    assert.equal(second.run.ok, true, second.run.reason);
    assert.ok(again.uploads.every((u) => u.metadata.bindings === undefined));
    assert.equal(second.run.binding_drift, undefined);
  } finally { globalThis.fetch = realFetch; }
});

test("BP4. props that differ (another host_worker) and a different entrypoint are restored the same way", async () => {
  for (const [label, change, kinds] of [
    ["props differ", (x: BindingRecord[]) => withField(x, "AGENTS", { props: { host_worker: "cryptophys-ai-kernel" } }), ["props"]],
    ["entrypoint differs", (x: BindingRecord[]) => withField(x, "AGENTS", { entrypoint: "HealthRpc" }), ["entrypoint"]],
    ["props empty", (x: BindingRecord[]) => withField(x, "AGENTS", { props: {} }), ["props"]],
  ] as const) {
    const { db, b } = await scenario();
    const cf = fakeCloudflare(production(change));
    const { run } = await deployDirect(db, b, cf);
    assert.equal(run.ok, true, `${label}: ${run.reason}`);
    assert.deepEqual(agents(cf.activeBindings(RM)), RM_AGENTS, label);
    assert.deepEqual(run.binding_drift?.[RM]?.restored.map((d) => d.kinds), [kinds], label);
    assert.ok(run.steps.includes(`${RM}:service_bindings_restored:AGENTS`), label);
  }
});

test("BP5. a configuration plan: an unchanged binding whose active record lost its props is planned from the config, uploaded and verified", async () => {
  // Pure: the plan no longer keeps the stripped record verbatim.
  const active = stripProps(deployedFrom(RM_TOML));
  const plan = planConfigChange(RM_TOML, RM_TOML, active) as ConfigPlan;
  assert.equal(plan.eligible, true, JSON.stringify(plan));
  assert.equal(plan.sources["service:AGENTS"], "config");
  assert.deepEqual(plan.bindings.find((x) => x.name === "AGENTS"), { type: "service", name: "AGENTS", service: "cryptophys-ai-kernel", entrypoint: "AgentRpc", props: { host_worker: RM } });
  assert.deepEqual(plan.service_bindings, { restored: [], undeclared: [], unverifiable: ["AGENTS"] }, "no props key: unknown, resent");
  const differs = planConfigChange(RM_TOML, RM_TOML, withField(deployedFrom(RM_TOML), "AGENTS", { props: { host_worker: "cryptophys-ai-kernel" } })) as ConfigPlan;
  assert.deepEqual([differs.sources["service:AGENTS"], differs.service_bindings], ["config", { restored: [{ name: "AGENTS", kinds: ["props"], retarget: false }], undeclared: [], unverifiable: [] }]);
  // As deployed: kept verbatim, as before; nothing restored.
  const same = planConfigChange(RM_TOML, RM_TOML, deployedFrom(RM_TOML)) as ConfigPlan;
  assert.equal(same.sources["service:AGENTS"], "active");
  assert.deepEqual(same.service_bindings, { restored: [], undeclared: [], unverifiable: [] });
  // An API that echoes `props: {}` for a binding declared without props is no drift (kept verbatim, nothing resent).
  const orch = read("workers/deployment-orchestrator/wrangler.toml");
  const echoed = planConfigChange(orch, orch, withField(deployedFrom(orch), "DRIFT", { props: {} })) as ConfigPlan;
  assert.deepEqual([echoed.eligible, echoed.sources["service:DRIFT"], echoed.service_bindings.restored], [true, "active", []]);
  // A binding the toml diff changes is a change, not a repair, when production bound the running value.
  const retargeted = RM_TOML.replace('props = { host_worker = "cryptophys-recovery-manager" }', 'props = { host_worker = "cryptophys-recovery-manager", tier = 1 }');
  const change = planConfigChange(RM_TOML, retargeted, deployedFrom(RM_TOML)) as ConfigPlan;
  assert.deepEqual([change.changes.changed, change.service_bindings.restored], [["service:AGENTS"], []]);
  // ...and both when it did not (before: active_differs_from_config, so the deploy stayed on GitHub).
  const wrong = withField(deployedFrom(RM_TOML), "AGENTS", { props: { host_worker: "cryptophys-ai-kernel" } });
  assert.deepEqual((planConfigChange(RM_TOML, retargeted, wrong) as ConfigPlan).service_bindings.restored.map((d) => d.name), ["AGENTS"]);

  // End to end through the executor: a [vars] change makes the Recovery Manager a configuration plan.
  const target = RM_TOML.replace('AI_DAILY_REQUEST_LIMIT = "80"', 'AI_DAILY_REQUEST_LIMIT = "70"');
  assert.notEqual(target, RM_TOML);
  const { db, b } = await scenario({ [RM]: target });
  const cf = fakeCloudflare(production(stripProps));
  const { plan: planned, run } = await deployDirect(db, b, cf);
  assert.ok(planned.find((p) => p.service === RM)?.config, "planned from the configs");
  assert.equal(run.ok, true, run.reason);
  const up = cf.uploads.find((u) => u.script === RM)!;
  assert.deepEqual(up.metadata.keep_bindings, ["secret_text", "secret_key"]);
  assert.deepEqual(up.metadata.bindings.find((x: BindingRecord) => x.name === "AGENTS"), { type: "service", name: "AGENTS", service: "cryptophys-ai-kernel", entrypoint: "AgentRpc", props: { host_worker: RM } });
  assert.deepEqual(agents(cf.activeBindings(RM)), RM_AGENTS);
  assert.equal(cf.activeBindings(RM).find((x) => x.name === "AI_DAILY_REQUEST_LIMIT")?.text, "70");
  assert.ok(run.steps.includes(`${RM}:service_bindings_restored:AGENTS`));
  assert.deepEqual(events(db, BINDING_DRIFT_REPAIRED_EVENT).map((x) => x.payload.bindings), [["AGENTS"]]);
});

test("BP6. an active service binding wrangler.toml does not declare refuses the deploy before any upload, with its name, and is reported", async () => {
  const EXTRA = { type: "service", name: "SHADOW", service: "cryptophys-forge", entrypoint: "MergeRpc", environment: "production" };
  // Code only, end to end: the request fails, nothing is uploaded or deployed, the owner gets a critical report.
  const { db, b } = await scenario();
  const { env, reports } = nativeEnv(db, b);
  noGitHub();
  try {
    const { proposal, decision } = passedProposal(db, "cryptophys-policy-engine");
    assert.equal((await deployForConsensus(env as never, proposal, decision, "cryptophys-policy-engine", { commit_sha: NEW })).executor, "native:deploy", "queued: the refusal is the executor's, so it is reported");
    const prod = production();
    prod["cryptophys-policy-engine"] = [...prod["cryptophys-policy-engine"], EXTRA];
    const cf = fakeCloudflare(prod);
    assert.deepEqual(await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 0 });
    assert.deepEqual([cf.uploads.length, cf.deployments.length], [0, 0], "nothing uploaded, nothing deployed");
    assert.ok(cf.activeBindings("cryptophys-policy-engine").some((x) => x.name === "SHADOW"), "not dropped silently");
    const outcome = JSON.parse((db.raw.prepare("SELECT details_json FROM deployment_requests").get() as any).details_json).outcome;
    assert.deepEqual([outcome.reason, outcome.production_changed, outcome.restored], [undeclaredRefusal("SHADOW"), false, true]);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].severity, "critical");
    assert.deepEqual(reports[0].body.binding_drift, { "cryptophys-policy-engine": { restored: [], undeclared: ["SHADOW"], repaired: false, refused: undeclaredRefusal("SHADOW") } });
    assert.match(reports[0].body.binding_action_required, /does not drop or retarget it/);
    assert.deepEqual(events(db, BINDING_DRIFT_DETECTED_EVENT).map((x) => [x.subject, x.outcome, x.payload.undeclared, x.payload.reason]),
      [["cryptophys-policy-engine", "refused", ["SHADOW"], undeclaredRefusal("SHADOW")]]);
    assert.equal(events(db, BINDING_DRIFT_REPAIRED_EVENT).length, 0);
  } finally { globalThis.fetch = realFetch; }

  // A configuration plan: the plan leaves it out (it is not kept verbatim any more), and the executor refuses.
  const plan = planConfigChange(RM_TOML, RM_TOML, [...deployedFrom(RM_TOML), EXTRA]) as ConfigPlan;
  assert.deepEqual([plan.eligible, plan.service_bindings.undeclared, plan.bindings.some((x) => x.name === "SHADOW")], [true, ["SHADOW"], false]);
  const target = RM_TOML.replace('AI_DAILY_REQUEST_LIMIT = "80"', 'AI_DAILY_REQUEST_LIMIT = "70"');
  const s2 = await scenario({ [RM]: target });
  const cf2 = fakeCloudflare(production((x) => [...x, EXTRA]));
  const { run } = await deployDirect(s2.db, s2.b, cf2);
  assert.deepEqual([run.ok, run.reason, run.production_changed], [false, undeclaredRefusal("SHADOW"), true], "earlier Workers of the unit moved, then restored");
  assert.equal(run.restored, true);
  assert.ok(!cf2.uploads.some((u) => u.script === RM), "the Recovery Manager was never uploaded");
  for (const s of CONTROL_PLANE.services) assert.equal(cf2.tagOf(s), OLD.slice(0, 12), `${s} restored`);
});

test("BP7. a restored binding must point at a Worker of the account; an upload that does not bind the declared values never gets traffic", async () => {
  // AGENTS missing entirely: restoring it retargets, so the account's script list is read first.
  const missing = (x: BindingRecord[]) => x.filter((y) => y.name !== "AGENTS");
  let s = await scenario();
  let cf = fakeCloudflare(production(missing), { listed: CONTROL_PLANE.services.filter((x) => x !== "cryptophys-ai-kernel") });
  let { run } = await deployDirect(s.db, s.b, cf);
  assert.deepEqual([run.ok, run.reason], [false, "service_binding_target_missing:AGENTS"]);
  assert.ok(!cf.uploads.some((u) => u.script === RM));
  s = await scenario();
  cf = fakeCloudflare(production(missing));
  ({ run } = await deployDirect(s.db, s.b, cf));
  assert.equal(run.ok, true, run.reason);
  assert.deepEqual(agents(cf.activeBindings(RM)), RM_AGENTS);
  assert.equal(cf.calls.filter((c) => c === "GET scripts").length, 1, "read once, only for the retargeted binding");
  // A props-only repair needs no list: the target is the one production already binds.
  s = await scenario();
  cf = fakeCloudflare(production(stripProps), { listed: [] });
  assert.equal((await deployDirect(s.db, s.b, cf)).run.ok, true);
  assert.equal(cf.calls.filter((c) => c === "GET scripts").length, 0);
  // The API answering with other props than the declared ones: stopped before the deploy call.
  s = await scenario();
  cf = fakeCloudflare(production(stripProps), { afterUpload: (svc, x) => svc === RM ? withField(x, "AGENTS", { props: { host_worker: "cryptophys-ai-kernel" } }) : x });
  ({ run } = await deployDirect(s.db, s.b, cf));
  assert.deepEqual([run.ok, run.reason], [false, "service_bindings_differ: service_binding_props_differs (AGENTS)"]);
  assert.ok(!cf.deployments.some((d) => d.script === RM));
  // Any other binding lost on the way (keep_bindings copying from another version) is still the old check.
  s = await scenario();
  cf = fakeCloudflare(production(stripProps), { afterUpload: (svc, x) => svc === RM ? x.filter((y) => y.name !== "CF_ACCESS_CLIENT_SECRET") : x });
  ({ run } = await deployDirect(s.db, s.b, cf));
  assert.deepEqual([run.ok, run.reason], [false, "bindings_differ"]);
});

test("BP8. break-glass: the owner-approved deploy plans through the same layer and ends with the declared props", async () => {
  const { db, b } = await scenario();
  const cf = fakeCloudflare(production(stripProps));
  const workers = new CloudflareWorkers("deploy-token", ACCOUNT, cf.fetcher);
  const choice = await breakGlassChoice({ DB: db as never, BUNDLES: b }, CONTROL_PLANE, NEW, [], workers);
  assert.equal(choice.ok, true, JSON.stringify(choice));
  const env = { DRIFT: { probeService: async () => ({ reachable: true, healthy: true, version_tag: TAG, error: null }) }, REGISTRY: { recordRollback: async () => ({ desired_version: "" }), recordNativeDeploy: async () => ({ desired_version: TAG, services: [] }) }, BUNDLES: b, DB: db as never };
  // The options the executor loop passes a break-glass request (index.ts): its named destructive items, none here.
  const run = await executeNativeDeploy(workers, env, "dep_bg", NEW, (choice as { services: PlannedService[] }).services, { delayMs: 0, migrations: [], destructive: [], destructiveTopology: [] });
  assert.equal(run.ok, true, run.reason);
  assert.deepEqual(agents(cf.activeBindings(RM)), RM_AGENTS);
  assert.ok(run.steps.includes(`${RM}:service_bindings_restored:AGENTS`));
  // The break-glass request runs through that executor, not a path of its own.
  const index = read("workers/deployment-orchestrator/src/index.ts");
  assert.match(index, /if \(isDeploy\) \{[\s\S]{0,1200}run = await executeNativeDeploy\(cf,[\s\S]{0,200}\.\.\.\(isBreakGlass \? \{ destructive: named \}/);
  assert.match(read("workers/deployment-orchestrator/src/recovery-deploy.ts"), /nativeDeployEligible\(env, unit, sha, cf, \{ migrations: "skip"/);
});

// ---------------------------------------------------------------- the rescue executor (Recovery Manager, Orchestrator's script only)
const ORCH_TOML = read("workers/deployment-orchestrator/wrangler.toml");
const ORCH_DECLARED = (declaredServiceBindingsFromToml(ORCH_TOML) as { bindings: ServiceBinding[] }).bindings;
const rescueChoiceFor = (services = ORCH_DECLARED) => ({ ok: true as const, module: `${ORCHESTRATOR_SERVICE}.mjs`, text: "export default {};", compatibility_date: "2026-11-01", compatibility_flags: [], running_tag: OLD.slice(0, 12), pending_migrations: [], services });
const rescueEnv = { DRIFT: { probeService: async () => ({ healthy: true, version_tag: TAG }) }, REGISTRY: { recordNativeDeploy: async () => ({}) } };

test("BP9. rescue: the Orchestrator's stripped AGENTS props are sent again by the Recovery Manager's own client and verified", async () => {
  const cf = fakeCloudflare({ [ORCHESTRATOR_SERVICE]: stripProps(deployedFrom(ORCH_TOML)) }, { onlyScript: ORCHESTRATOR_SERVICE, token: "rescue-token" });
  const run = await executeRescueDeploy(new RescueCloudflare("rescue-token", ACCOUNT, cf.fetcher), rescueEnv, "dep_r", NEW, rescueChoiceFor(), { sleep: async () => undefined });
  assert.equal(run.ok, true, run.reason);
  assert.deepEqual(cf.uploads[0].metadata.bindings, ORCH_DECLARED);
  assert.deepEqual(cf.uploads[0].metadata.keep_bindings, RESCUE_KEEP_BINDINGS.filter((t) => t !== "service"));
  assert.deepEqual(agents(cf.activeBindings(ORCHESTRATOR_SERVICE))!.props, { host_worker: ORCHESTRATOR_SERVICE });
  assert.deepEqual(run.steps, ["captured", unverifiableStep(ORCHESTRATOR_SERVICE, "AGENTS"), "uploaded", "bindings_match", `${ORCHESTRATOR_SERVICE}:service_bindings_restored:AGENTS`, "deployed", "verified", "desired_recorded"]);
  assert.deepEqual(run.binding_drift, { restored: [{ name: "AGENTS", kinds: ["props"], retarget: false }], undeclared: [], repaired: true });
  // Nothing to repair: the unchanged upload (every type kept, no binding sent).
  const clean = fakeCloudflare({ [ORCHESTRATOR_SERVICE]: deployedFrom(ORCH_TOML) }, { onlyScript: ORCHESTRATOR_SERVICE, token: "rescue-token" });
  const ok = await executeRescueDeploy(new RescueCloudflare("rescue-token", ACCOUNT, clean.fetcher), rescueEnv, "dep_r2", NEW, rescueChoiceFor(), { sleep: async () => undefined });
  assert.equal(ok.ok, true, ok.reason);
  assert.deepEqual([clean.uploads[0].metadata.bindings, clean.uploads[0].metadata.keep_bindings], [undefined, [...RESCUE_KEEP_BINDINGS]]);
  assert.equal(ok.binding_drift, undefined);
});

test("BP10. rescue refuses before any upload what it may not repair: an undeclared binding, a retarget to a Worker the account does not list, a stored config that does not match", async () => {
  const cases: Array<[string, BindingRecord[], string]> = [
    ["undeclared", [...deployedFrom(ORCH_TOML), { type: "service", name: "SHADOW", service: "cryptophys-forge", environment: "production" }], undeclaredRefusal("SHADOW")],
    ["missing (retarget)", deployedFrom(ORCH_TOML).filter((x) => x.name !== "AGENTS"), "service_binding_target_missing:AGENTS"],
    ["another service (retarget)", withField(deployedFrom(ORCH_TOML), "AGENTS", { service: "cryptophys-forge" }), "service_binding_target_missing:AGENTS"],
  ];
  for (const [label, active, reason] of cases) {
    const cf = fakeCloudflare({ [ORCHESTRATOR_SERVICE]: active }, { onlyScript: ORCHESTRATOR_SERVICE, token: "rescue-token" });
    const run = await executeRescueDeploy(new RescueCloudflare("rescue-token", ACCOUNT, cf.fetcher), rescueEnv, "dep_x", NEW, rescueChoiceFor(), { sleep: async () => undefined });
    assert.deepEqual([run.ok, run.reason, run.production_changed, cf.uploads.length, cf.deployments.length], [false, reason, false, 0, 0], label);
    assert.equal(run.binding_drift?.refused, reason, label);
  }
  // The choice reads the declared bindings from the config the Forge stored for the commit, hash-checked.
  const db = migratedDb();
  db.raw.prepare("UPDATE service_registry SET desired_version = ?").run(OLD.slice(0, 12));
  await forgeSees(db, { main: NEW, files: ["workers/deployment-orchestrator/src/index.ts"], ready: true });
  const b = bucket();
  await bundlesFor(b, OLD, { [ORCHESTRATOR_SERVICE]: ORCH_TOML });
  await bundlesFor(b, NEW, { [ORCHESTRATOR_SERVICE]: ORCH_TOML });
  const env = { DB: db as never, BUNDLES: b };
  const choice = await rescueChoice(env as never, NEW, []);
  assert.equal(choice.ok, true, JSON.stringify(choice));
  assert.deepEqual((choice as { services: ServiceBinding[] }).services, ORCH_DECLARED);
  b.objects.set(`bundles/${NEW}/config/${ORCHESTRATOR_SERVICE}.toml`, { value: ORCH_TOML.replace("host_worker", "host"), uploaded: new Date() });
  assert.deepEqual(await rescueChoice(env as never, NEW, []), { ok: false, reason: "config_hash_mismatch", file: `bundles/${NEW}/config/${ORCHESTRATOR_SERVICE}.toml` });
  b.objects.delete(`bundles/${NEW}/config/${ORCHESTRATOR_SERVICE}.toml`);
  assert.deepEqual(await rescueChoice(env as never, NEW, []), { ok: false, reason: "config_missing", file: `bundles/${NEW}/config/${ORCHESTRATOR_SERVICE}.toml` });
});

test("BP11. exempt: native rollback uploads no version (it redeploys one production ran), so it neither sends nor drops a binding", async () => {
  const fake = fakeCloudflare({ [RM]: deployedFrom(RM_TOML) });
  const id = [...fake.scripts.get(RM)!.versions.keys()][0];
  fake.scripts.get(RM)!.versions.get(id)!.tag = OLD.slice(0, 12);
  const versionsList = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith(`/scripts/${RM}/versions?per_page=100`)) return Response.json({ success: true, result: { items: [{ id, annotations: { "workers/tag": OLD.slice(0, 12) }, metadata: { created_on: "2026-11-15T00:00:00Z" } }] } });
    return fake.fetcher(input, init);
  }) as typeof fetch;
  const run = await executeRollback(new CloudflareWorkers("deploy-token", ACCOUNT, versionsList), {
    DRIFT: { probeService: async () => ({ reachable: true, healthy: true, version_tag: OLD.slice(0, 12), error: null }) },
    REGISTRY: { recordRollback: async () => ({ desired_version: OLD.slice(0, 12) }) },
  }, "dep_rb", RM, OLD.slice(0, 12), { delayMs: 0 });
  assert.equal(run.ok, true, run.reason);
  assert.equal(fake.uploads.length, 0, "no version upload on the rollback path");
  assert.ok(!fake.calls.some((c) => c.startsWith("POST") && c.endsWith(" versions")));
  assert.doesNotMatch(read("workers/deployment-orchestrator/src/native-rollback.ts").slice(read("workers/deployment-orchestrator/src/native-rollback.ts").indexOf("export async function executeRollback")), /uploadVersion/);
});

test("BP12. an API that never returns props: every path succeeds, resends the declared props, writes no drift audit or report, and names them unverifiable once", async () => {
  const declaredOf = (toml: string) => (declaredServiceBindingsFromToml(toml) as { bindings: ServiceBinding[] }).bindings;
  const noDrift = (db: Db) => assert.deepEqual([events(db, BINDING_DRIFT_DETECTED_EVENT).length, events(db, BINDING_DRIFT_REPAIRED_EVENT).length], [0, 0], "no drift audit");

  // Code only, end to end (queued, run): production is as wrangler deployed it; the API only hides the props.
  {
    const { db, b } = await scenario();
    const { env, reports } = nativeEnv(db, b);
    noGitHub();
    try {
      const { proposal, decision } = passedProposal(db, "cryptophys-policy-engine");
      assert.equal((await deployForConsensus(env as never, proposal, decision, "cryptophys-policy-engine", { commit_sha: NEW })).executor, "native:deploy");
      const cf = fakeCloudflare(production(), { omitProps: true });
      assert.deepEqual(await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 1 });
      const outcome = JSON.parse((db.raw.prepare("SELECT status, details_json FROM deployment_requests").get() as any).details_json).outcome;
      for (const svc of CONTROL_PLANE.services) {
        const up = cf.uploads.find((u) => u.script === svc)!;
        assert.deepEqual(up.metadata.bindings, declaredOf(tomlFor(svc)), `${svc}: the declared bindings are resent`);
        assert.deepEqual(up.metadata.keep_bindings, KEEP_BINDINGS.filter((t) => t !== "service"));
        assert.equal(outcome.steps.filter((x: string) => x === unverifiableStep(svc, "AGENTS")).length, 1, `${svc}: named once`);
        assert.ok(!outcome.steps.includes(`${svc}:service_bindings_restored:AGENTS`), `${svc}: not reported as restored`);
        assert.deepEqual(agents(cf.activeBindings(svc))!.props, { host_worker: svc === RM ? RM : svc }, `${svc}: what Cloudflare stores carries the props`);
        assert.equal(cf.tagOf(svc), TAG);
      }
      assert.equal(outcome.binding_drift, undefined);
      noDrift(db);
      assert.equal(reports.length, 0, "no critical report");
    } finally { globalThis.fetch = realFetch; }
  }

  // A real loss the API does not show is still repaired (resent), without a drift alarm.
  {
    const { db, b } = await scenario();
    const cf = fakeCloudflare(production(stripProps), { omitProps: true });
    const { run } = await deployDirect(db, b, cf);
    assert.equal(run.ok, true, run.reason);
    assert.deepEqual(agents(cf.activeBindings(RM))!.props, { host_worker: RM });
    assert.equal(run.binding_drift, undefined);
    noDrift(db);
  }

  // Configuration plan: the [vars] change makes the Recovery Manager a plan; its AGENTS is planned from the config.
  {
    const target = RM_TOML.replace('AI_DAILY_REQUEST_LIMIT = "80"', 'AI_DAILY_REQUEST_LIMIT = "70"');
    const { db, b } = await scenario({ [RM]: target });
    const cf = fakeCloudflare(production(), { omitProps: true });
    const { plan, run } = await deployDirect(db, b, cf);
    assert.ok(plan.find((p) => p.service === RM)?.config);
    assert.equal(run.ok, true, run.reason);
    const up = cf.uploads.find((u) => u.script === RM)!;
    assert.deepEqual(up.metadata.bindings.find((x: BindingRecord) => x.name === "AGENTS")?.props, { host_worker: RM });
    assert.equal(run.steps.filter((x) => x === unverifiableStep(RM, "AGENTS")).length, 1);
    assert.equal(run.binding_drift, undefined);
    noDrift(db);
  }

  // Break-glass: the same plan and executor.
  {
    const { db, b } = await scenario();
    const cf = fakeCloudflare(production(), { omitProps: true });
    const workers = new CloudflareWorkers("deploy-token", ACCOUNT, cf.fetcher);
    const choice = await breakGlassChoice({ DB: db as never, BUNDLES: b }, CONTROL_PLANE, NEW, [], workers);
    assert.equal(choice.ok, true, JSON.stringify(choice));
    const env = { DRIFT: { probeService: async () => ({ reachable: true, healthy: true, version_tag: TAG, error: null }) }, REGISTRY: { recordRollback: async () => ({ desired_version: "" }), recordNativeDeploy: async () => ({ desired_version: TAG, services: [] }) }, BUNDLES: b, DB: db as never };
    const run = await executeNativeDeploy(workers, env, "dep_bg12", NEW, (choice as { services: PlannedService[] }).services, { delayMs: 0, migrations: [], destructive: [], destructiveTopology: [] });
    assert.equal(run.ok, true, run.reason);
    assert.ok(run.steps.includes(unverifiableStep(RM, "AGENTS")));
    assert.equal(run.binding_drift, undefined);
    noDrift(db);
  }

  // Rescue: its own client, the same rules.
  {
    const cf = fakeCloudflare({ [ORCHESTRATOR_SERVICE]: deployedFrom(ORCH_TOML) }, { onlyScript: ORCHESTRATOR_SERVICE, token: "rescue-token", omitProps: true });
    const run = await executeRescueDeploy(new RescueCloudflare("rescue-token", ACCOUNT, cf.fetcher), rescueEnv, "dep_r12", NEW, rescueChoiceFor(), { sleep: async () => undefined });
    assert.equal(run.ok, true, run.reason);
    assert.deepEqual(cf.uploads[0].metadata.bindings, ORCH_DECLARED);
    assert.deepEqual(run.steps, ["captured", unverifiableStep(ORCHESTRATOR_SERVICE, "AGENTS"), "uploaded", "bindings_match", "deployed", "verified", "desired_recorded"]);
    assert.equal(run.binding_drift, undefined);
  }

  // Still refused without props: a different entrypoint the new version keeps, and props present but wrong.
  {
    const { db, b } = await scenario();
    const cf = fakeCloudflare(production(), { omitProps: true, afterUpload: (svc, x) => svc === RM ? withField(x, "AGENTS", { entrypoint: "HealthRpc" }) : x });
    const { run } = await deployDirect(db, b, cf);
    assert.deepEqual([run.ok, run.reason], [false, "service_bindings_differ: service_binding_entrypoint_differs (AGENTS)"]);
    assert.ok(!cf.deployments.some((d) => d.script === RM));
  }
  {
    // Rescue: the active record has no props key (resent), and the new version shows other props: refused before deploy.
    const cf = fakeCloudflare({ [ORCHESTRATOR_SERVICE]: stripProps(deployedFrom(ORCH_TOML)) }, { onlyScript: ORCHESTRATOR_SERVICE, token: "rescue-token",
      afterUpload: (_svc, x) => withField(x, "AGENTS", { props: { host_worker: "cryptophys-ai-kernel" } }) });
    const run = await executeRescueDeploy(new RescueCloudflare("rescue-token", ACCOUNT, cf.fetcher), rescueEnv, "dep_r13", NEW, rescueChoiceFor(), { sleep: async () => undefined });
    assert.deepEqual([run.ok, run.reason, cf.deployments.length], [false, "service_bindings_differ: service_binding_props_differs (AGENTS)", 0]);
  }
});

// ---------------------------------------------------------------- 2026-11-16 (owner): undeclared bindings are never dropped; rescue script list
const PE = "cryptophys-policy-engine";
const SHADOW = { type: "service", name: "SHADOW", service: "cryptophys-forge", entrypoint: "MergeRpc", environment: "production" };
const withShadow = () => { const p = production(); p[PE] = [...p[PE], SHADOW]; return p; };
const bgEnv = (db: Db, b: Bucket) => ({ DRIFT: { probeService: async () => ({ reachable: true, healthy: true, version_tag: TAG, error: null }) }, REGISTRY: { recordRollback: async () => ({ desired_version: "" }), recordNativeDeploy: async () => ({ desired_version: TAG, services: [] }) }, BUNDLES: b, DB: db as never });

test("BP13. an undeclared service binding is never dropped: refused with its name on the routine, break-glass and rescue paths; no break-glass item removes it", async () => {
  // No destructive_topology item drops a service binding: a plan naming one is invalid (Recovery Manager, Policy Engine).
  for (const item of [`service_binding_removal:${PE}:SHADOW`, `service_binding_removal:${ORCHESTRATOR_SERVICE}:SHADOW`]) {
    assert.equal(TOPOLOGY_ITEM.test(item), false, item);
    assert.ok(validateTopology([item]) instanceof Error, item);
  }
  // Routine: refused before any upload, with the plain reason (no break-glass item mentioned).
  {
    const { db, b } = await scenario();
    const cf = fakeCloudflare(withShadow());
    const { run } = await deployDirect(db, b, cf);
    assert.deepEqual([run.ok, run.reason, cf.uploads.length], [false, "service_binding_undeclared:SHADOW", 0]);
    assert.doesNotMatch(run.reason!, /break-glass|destructive_topology|service_binding_removal/);
    assert.ok(cf.activeBindings(PE).some((x) => x.name === "SHADOW"), "not dropped");
  }
  // Break-glass: the plan is chosen (the refusal is the executor's, so it is reported), then refused the same way,
  // whatever destructive topology the plan names.
  {
    const { db, b } = await scenario();
    const cf = fakeCloudflare(withShadow());
    const workers = new CloudflareWorkers("deploy-token", ACCOUNT, cf.fetcher);
    const choice = await breakGlassChoice({ DB: db as never, BUNDLES: b }, CONTROL_PLANE, NEW, [], workers);
    assert.equal(choice.ok, true, JSON.stringify(choice));
    const run = await executeNativeDeploy(workers, bgEnv(db, b), "dep_bg13", NEW, (choice as { services: PlannedService[] }).services,
      { delayMs: 0, migrations: [], destructive: [], destructiveTopology: [`workers_dev_disable:${PE}`, `service_binding_removal:${PE}:SHADOW`] });
    assert.deepEqual([run.ok, run.reason, cf.uploads.length, run.production_changed], [false, "service_binding_undeclared:SHADOW", 0, false]);
    assert.ok(cf.activeBindings(PE).some((x) => x.name === "SHADOW"), "not dropped");
    assert.equal(events(db, "deployment.destructive_topology_applying").length, 0);
  }
  // Rescue: refused the same way (BP10 runs the other refusals).
  {
    const cf = fakeCloudflare({ [ORCHESTRATOR_SERVICE]: [...deployedFrom(ORCH_TOML), SHADOW] }, { onlyScript: ORCHESTRATOR_SERVICE, token: "rescue-token" });
    const run = await executeRescueDeploy(new RescueCloudflare("rescue-token", ACCOUNT, cf.fetcher), rescueEnv, "dep_r13", NEW, rescueChoiceFor(), { sleep: async () => undefined });
    assert.deepEqual([run.ok, run.reason, cf.uploads.length], [false, "service_binding_undeclared:SHADOW", 0]);
  }
});

test("BP14. rescue: its client may also read the account's script list (only that), and restores a missing binding only to a listed Worker", async () => {
  const noSleep = { sleep: async () => undefined };
  const rescueFake = (active: BindingRecord[], listed?: string[]) =>
    fakeCloudflare({ [ORCHESTRATOR_SERVICE]: active }, { onlyScript: ORCHESTRATOR_SERVICE, token: "rescue-token", ...(listed ? { listed } : {}) });
  // Missing AGENTS, target listed: restored.
  let cf = rescueFake(deployedFrom(ORCH_TOML).filter((x) => x.name !== "AGENTS"), [ORCHESTRATOR_SERVICE, "cryptophys-ai-kernel", "cryptophys-drift-detector", "cryptophys-platform-registry"]);
  let run = await executeRescueDeploy(new RescueCloudflare("rescue-token", ACCOUNT, cf.fetcher), rescueEnv, "dep_l1", NEW, rescueChoiceFor(), noSleep);
  assert.equal(run.ok, true, run.reason);
  assert.deepEqual(agents(cf.activeBindings(ORCHESTRATOR_SERVICE))!.props, { host_worker: ORCHESTRATOR_SERVICE });
  assert.deepEqual(run.binding_drift?.restored, [{ name: "AGENTS", kinds: ["missing"], retarget: true }]);
  assert.equal(cf.calls.filter((c) => c === "GET scripts").length, 1);
  // Not listed: refused before any upload.
  cf = rescueFake(deployedFrom(ORCH_TOML).filter((x) => x.name !== "AGENTS"), [ORCHESTRATOR_SERVICE]);
  run = await executeRescueDeploy(new RescueCloudflare("rescue-token", ACCOUNT, cf.fetcher), rescueEnv, "dep_l2", NEW, rescueChoiceFor(), noSleep);
  assert.deepEqual([run.ok, run.reason, cf.uploads.length], [false, "service_binding_target_missing:AGENTS", 0]);
  // A props-only repair reads no list (the target is the one production already binds).
  cf = rescueFake(withField(deployedFrom(ORCH_TOML), "AGENTS", { props: { host_worker: "x" } }), []);
  run = await executeRescueDeploy(new RescueCloudflare("rescue-token", ACCOUNT, cf.fetcher), rescueEnv, "dep_l3", NEW, rescueChoiceFor(), noSleep);
  assert.equal(run.ok, true, run.reason);
  assert.equal(cf.calls.filter((c) => c === "GET scripts").length, 0);

  // Every other address is refused before any request: another script, a write to the list, another account, a traversal.
  let fetched = 0;
  const client = new RescueCloudflare("rescue-token", ACCOUNT, (async () => { fetched++; return Response.json({ success: true, result: [] }); }) as typeof fetch);
  const request = (url: string, init?: RequestInit) => (client as unknown as { request(u: string, i?: RequestInit): Promise<Response> }).request(url, init);
  const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts`;
  for (const [url, init] of [
    [`${base}/cryptophys-ai-kernel/versions`, undefined],
    [`${base}/cryptophys-ai-kernel/deployments`, { method: "POST", body: "{}" }],
    [base, { method: "POST", body: "{}" }],
    [base, { method: "PUT", body: "{}" }],
    [`${base}?per_page=1000`, undefined],
    [`https://api.cloudflare.com/client/v4/accounts/${"b".repeat(32)}/workers/scripts`, undefined],
    [`${base}/${ORCHESTRATOR_SERVICE}/../cryptophys-ai-kernel/versions`, undefined],
    [`https://api.cloudflare.com/client/v4/zones/z/workers/routes`, undefined],
  ] as Array<[string, RequestInit | undefined]>) {
    await assert.rejects(request(url, init), /rescue_address_refused/, url);
  }
  assert.equal(fetched, 0, "nothing was sent");
  assert.deepEqual(await client.scriptIds(), []);
  assert.equal(fetched, 1, "the list itself is allowed");
});

test("BP15. rescue applies no topology change: an Orchestrator plan naming any destructive_topology item is refused, not run with it ignored", async () => {
  const db = migratedDb();
  const now = (() => { const t = Math.ceil(Date.now() / 60_000) * 60_000; for (let i = 0; i < 60; i++) { const c = t + i * 60_000; if ((RESCUE_MINUTES as readonly number[]).includes(new Date(c).getUTCMinutes())) return c + 5_000; } throw new Error("no minute"); })();
  const planId = "plan_bp15";
  const decisionId = "dec_bp15";
  const steps = { steps: [{ action: "force_redeploy_unit", description: "rescue", destructive_topology: [`workers_dev_disable:${ORCHESTRATOR_SERVICE}`] }] };
  const at = new Date(now - 60_000).toISOString();
  db.raw.prepare(`INSERT INTO recovery_plans (plan_id, service_id, plan_version, status, steps_json, approved_by, created_by, last_execution_json, created_at, updated_at)
    VALUES (?, ?, ?, 'executing', ?, 'owner@example.com', 'ops@example.com', ?, ?, ?)`).run(planId, ORCHESTRATOR_SERVICE, NEW, JSON.stringify(steps), JSON.stringify({ policy_decision_id: decisionId }), at, at);
  db.raw.prepare(`INSERT INTO policy_decisions (decision_id, subject, action, resource, decision, reason, evidence_json, created_at) VALUES (?, 'ops@example.com', 'recovery.execute', ?, 'allow', 'ok', '{}', ?)`)
    .run(decisionId, planId, at);
  let fetched = 0;
  const env = { DB: db as never, BUNDLES: bucket(), DRIFT: rescueEnv.DRIFT, REGISTRY: rescueEnv.REGISTRY, CF_ORCHESTRATOR_DEPLOY_TOKEN: "rescue-token", CF_ACCOUNT_ID: ACCOUNT };
  const out = await rescueForRecovery(env as never, planId, decisionId, { now, fetcher: (async () => { fetched++; return Response.json({ success: false }); }) as typeof fetch });
  assert.equal(out.status, "failed");
  assert.match((out as { detail: string }).detail, /^rescue deploy refused: named_topology_not_pending \(workers_dev_disable:cryptophys-deployment-orchestrator; the rescue deploy applies no topology change\); nothing in production changed$/);
  assert.equal(fetched, 0, "no Cloudflare call");
  const refused = events(db, "deployment.rescue_refused");
  assert.deepEqual(refused.map((x) => [x.payload.reason, x.payload.item]), [["named_topology_not_pending", `workers_dev_disable:${ORCHESTRATOR_SERVICE}`]]);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM deployment_requests").get() as any).n, 0, "no request claimed");
});
