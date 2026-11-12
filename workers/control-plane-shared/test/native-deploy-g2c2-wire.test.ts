// ADR-0012 G2c-2 (§5l), integration steps 1–5: a configuration change deploys natively. The Forge keeps each
// Worker's wrangler.toml; eligibility plans the change against the active version's full binding records; the
// version is uploaded with exactly the planned bindings and verified (bindings and script_runtime) before any
// traffic moves; cron schedules and observability are applied only after the live check, and restored (newest
// first, before the deployment) on any later failure. Workers with static assets stay on GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accessCertsResponse, baseEnv, forgeSees, isAccessCerts, migratedDb } from "./harness.ts";
import { unitForService } from "../src/deploy-units.ts";
import { storeBundles, type BuiltModule, type BundleBucket } from "../../forge/src/bundles.ts";
import { DeploymentLock, deployForConsensus, runNativeExecutors } from "../../deployment-orchestrator/src/index.ts";
import { CloudflareWorkers, KEEP_BINDINGS, SAFE_MINUTES } from "../../deployment-orchestrator/src/native-rollback.ts";
import { nativeDeployEligible, parseManifest } from "../../deployment-orchestrator/src/native-deploy.ts";
import { bindingsFromToml, parseToml } from "../../deployment-orchestrator/src/config-diff.ts";
import { recordNativeDeploy, recordRollback } from "../../platform-registry/src/index.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const ACCOUNT = "a".repeat(32);
const OLD = "0c".repeat(20);
const NEW = "2d".repeat(20);
const FORGE = unitForService("cryptophys-forge")!;
const PLATFORM_API = unitForService("cryptophys-platform-api")!;
const CONSOLE = unitForService("cryptophys-console")!;
const D1_ID = "d1000000-0000-4000-8000-000000000001";
const realFetch = globalThis.fetch;
const enc = new TextEncoder();

// The repository's own configs: the running version runs them as committed.
const FORGE_TOML = read("workers/forge/wrangler.toml");
const API_TOML = read("workers/platform-api/wrangler.toml");
const CONSOLE_TOML = read("workers/console/wrangler.toml");
const OLD_CRONS = ["4,19,34,49 * * * *"];
const NEW_CRONS = ["5,20,35,50 * * * *"];
const edit = (text: string, from: string, to: string) => { assert.ok(text.includes(from), from); return text.replace(from, to); };
/** The happy-path target: a new [vars] entry, new crons and a changed [observability]; [limits] unchanged. */
const FORGE_TARGET = edit(edit(edit(FORGE_TOML,
  'API_CONTRACT_VERSION = "v1"\n', 'API_CONTRACT_VERSION = "v1"\nNATIVE_CONFIG_PROBE = "on"\n'),
  `crons = ${JSON.stringify(OLD_CRONS)}`, `crons = ${JSON.stringify(NEW_CRONS)}`),
  "[observability]\nenabled = true\n", "[observability]\nenabled = true\nhead_sampling_rate = 0.5\n");

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
  const objects = new Map<string, { value: string | Uint8Array; uploaded: Date; meta?: unknown }>();
  const b = {
    objects,
    async put(key: string, value: string | Uint8Array, options?: unknown) { objects.set(key, { value, uploaded: new Date(), meta: options }); return {}; },
    async get(key: string) {
      const o = objects.get(key);
      if (!o) return null;
      const bytes = typeof o.value === "string" ? enc.encode(o.value) : o.value;
      return { text: async () => typeof o.value === "string" ? o.value : new TextDecoder().decode(o.value), arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer };
    },
    async list({ prefix = "", cursor, limit = 1000 }: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      return { objects: keys.slice(start, start + limit).map((key) => ({ key, uploaded: objects.get(key)!.uploaded })), truncated: start + limit < keys.length, cursor: String(start + limit) };
    },
    async delete(keys: string | string[]) { for (const k of [keys].flat()) objects.delete(k); },
  };
  return b satisfies BundleBucket;
}
type Bucket = ReturnType<typeof bucket>;
const moduleText = (name: string, commit: string) => `export default { fetch() { return new Response("${name} ${commit.slice(0, 12)}"); } };`;
/** One commit's bundles for the given Workers (single module), with their configs. */
async function store(b: Bucket, commit: string, configs: Record<string, string>) {
  const built: BuiltModule[] = Object.entries(configs).map(([name, toml]) => ({ dir: `workers/${name.replace("cryptophys-", "")}`, text: moduleText(name, commit), toml, external: [] }));
  await storeBundles(b, commit, built, Date.now(), ["0001_init.sql"]);
}
const manifestOf = (b: Bucket, commit: string) => JSON.parse(String(b.objects.get(`bundles/${commit}/manifest.json`)!.value));

// ---------------------------------------------------------------- the active version, as wrangler deployed it
/** The rendered config's bindings (the D1 id resolved, the API's `environment` on services), the deploy-time --var values and one secret. */
function activeFor(toml: string) {
  const declared = bindingsFromToml(parseToml(toml)!).bindings!.map((b) => {
    if (b.type === "d1") return { ...b, id: D1_ID };
    if (b.type === "service") return { ...b, environment: "production" };
    return { ...b };
  });
  return [
    ...declared,
    { type: "plain_text", name: "ACCESS_TEAM_DOMAIN", text: "team.cloudflareaccess.com" },
    { type: "plain_text", name: "ACCESS_AUD", text: "aud-production" },
    { type: "plain_text", name: "OPERATOR_IDENTITIES", text: "ops@example.com" },
    { type: "secret_text", name: "CF_BUILDS_API_TOKEN" },
  ];
}

// ---------------------------------------------------------------- a fake Workers API: versions, deployments, schedules, script settings
type Binding = { type: string; name: string; [k: string]: unknown };
interface Version { bindings: Binding[]; runtime: Record<string, unknown>; tag?: string }
interface Script { active: { version_id: string; percentage: number }[]; versions: Map<string, Version>; schedules: { cron: string }[]; observability: Record<string, unknown> }
interface FakeOpts {
  /** Change what the uploaded version reports (bindings, runtime). */
  uploaded?: (v: Version) => void;
  /** Answer this call with a 500 (the n-th time it is made, from 1). */
  fail?: (call: string, n: number) => boolean;
  /** Runs before a call is answered (the n-th time it is made, from 1). */
  before?: (call: string, n: number, s: Script) => void;
}
function fakeCloudflare(initial: Record<string, { bindings: Binding[]; crons?: string[]; limits?: Record<string, unknown> }>, opts: FakeOpts = {}) {
  const scripts = new Map<string, Script>();
  let v = 0;
  const uuid = () => `${String(++v).padStart(8, "0")}-0000-4000-8000-000000000000`;
  for (const [name, s] of Object.entries(initial)) {
    const id = uuid();
    const runtime = { compatibility_date: "2026-11-01", compatibility_flags: [], usage_model: "standard", ...(s.limits ? { limits: s.limits } : {}) };
    scripts.set(name, { active: [{ version_id: id, percentage: 100 }], versions: new Map([[id, { bindings: structuredClone(s.bindings), runtime }]]), schedules: (s.crons ?? []).map((cron) => ({ cron })), observability: { enabled: true } });
  }
  const log: string[] = [];
  const counts = new Map<string, number>();
  const uploads: { script: string; metadata: any }[] = [];
  const writes = () => log.filter((c) => /^(POST|PUT|PATCH) /.test(c));
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const m = new RegExp(`^https://api\\.cloudflare\\.com/client/v4/accounts/${ACCOUNT}/workers/scripts/([a-z0-9-]+)/(.*)$`).exec(url);
    assert.ok(m, `unexpected ${url}`);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer deploy-token");
    const [, script, rest] = m!;
    const s = scripts.get(script);
    assert.ok(s, `unknown script ${script}`);
    const method = init?.method ?? "GET";
    const call = `${method} ${script} ${rest.replace(/[0-9a-f-]{36}/, "<id>")}`;
    const n = (counts.get(call) ?? 0) + 1;
    counts.set(call, n);
    log.push(call);
    opts.before?.(call, n, s!);
    if (opts.fail?.(call, n)) return Response.json({ success: false, errors: [{ code: 10013 }] }, { status: 500 });
    if (rest === "deployments" && method === "GET") return Response.json({ success: true, result: { deployments: [{ created_on: "2026-11-12T00:00:00Z", versions: s!.active }] } });
    if (rest === "deployments" && method === "POST") { s!.active = JSON.parse(String(init!.body)).versions; return Response.json({ success: true, result: { id: "dep" } }); }
    if (rest === "versions" && method === "POST") {
      const form = init!.body as FormData;
      const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
      uploads.push({ script, metadata });
      const latest = [...s!.versions.values()].at(-1)!;
      const kept = latest.bindings.filter((b) => metadata.keep_bindings.includes(b.type));
      // Sent bindings as the API reports them back: a service binding gains environment "production".
      const sent = (metadata.bindings ?? []).map((b: Binding) => b.type === "service" && b.environment === undefined ? { ...b, environment: "production" } : b);
      const version: Version = {
        bindings: metadata.bindings ? [...sent, ...kept.filter((k) => !sent.some((x: Binding) => x.name === k.name))] : structuredClone(kept),
        runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags ?? [], usage_model: "standard", ...(metadata.limits ? { limits: metadata.limits } : {}) },
        tag: metadata.annotations["workers/tag"],
      };
      opts.uploaded?.(version);
      const id = uuid();
      s!.versions.set(id, version);
      return Response.json({ success: true, result: { id, number: v } });
    }
    const vm = /^versions\/([0-9a-f-]{36})$/.exec(rest);
    if (vm && method === "GET") {
      const ver = s!.versions.get(vm[1]);
      return ver ? Response.json({ success: true, result: { id: vm[1], resources: { bindings: ver.bindings, script_runtime: ver.runtime } } }) : Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
    }
    if (rest === "schedules" && method === "PUT") {
      s!.schedules = JSON.parse(String(init!.body));
      return Response.json({ success: true, result: { schedules: s!.schedules.map((x) => ({ ...x, created_on: "2026-11-12T00:00:00Z", modified_on: "2026-11-12T00:00:00Z" })) } });
    }
    if (rest === "script-settings" && method === "PATCH") {
      s!.observability = JSON.parse(String(init!.body)).observability;
      return Response.json({ success: true, result: { logpush: false, observability: s!.observability, tail_consumers: [] } });
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  return { fetcher, log, uploads, scripts, writes };
}
type Fake = ReturnType<typeof fakeCloudflare>;
const forgeFake = (opts: FakeOpts = {}, bindings = activeFor(FORGE_TOML)) => fakeCloudflare({ "cryptophys-forge": { bindings, crons: OLD_CRONS, limits: { cpu_ms: 300000 } } }, opts);

// ---------------------------------------------------------------- D1, proposals, the Orchestrator's env
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
  const proposal = `cns_${String(n).padStart(8, "0")}-5555-4555-8555-555555555555`;
  const decision = `dec_${String(n).padStart(8, "0")}-6666-4666-8666-666666666666`;
  const at = new Date().toISOString();
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES (?, 'supervisor', 'deploy_commit', ?, 'routine', ?, '{}', 'deploy', 8, 8, 0, 1, ?, 'allow', 'executing', NULL, ?, ?)`).run(proposal, target, JSON.stringify({ commit_sha: NEW }), decision, at, at);
  db.raw.prepare(`INSERT INTO policy_decisions (decision_id, subject, action, resource, decision, reason, evidence_json, created_at) VALUES (?, 'ai:kernel', 'consensus.execute', ?, 'allow', 'ok', '{}', ?)`)
    .run(decision, `deploy_commit:${target}`, at);
  return { proposal, decision };
}
async function freshDb(): Promise<Db> {
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  db.raw.prepare("UPDATE service_registry SET desired_version = ?").run(OLD.slice(0, 12));
  await forgeSees(db, { main: NEW, files: ["workers/forge/wrangler.toml", "workers/platform-api/src/index.ts", "workers/console/src/index.ts"], ready: true });
  return db;
}
/** Between cases on one database: no request rows (UNIQUE idempotency key), every desired version back at OLD. */
const reset = (db: Db) => {
  db.raw.prepare("DELETE FROM deployment_requests").run();
  db.raw.prepare("UPDATE service_registry SET desired_version = ?").run(OLD.slice(0, 12));
};
function nativeEnv(db: Db, b: Bucket, log: string[], extra: Record<string, unknown> = {}) {
  const reports: any[] = [];
  const env = baseEnv("cryptophys-deployment-orchestrator", db, {
    GH_ACTIONS_TOKEN: "", DEPLOYMENT_LOCK: lockNs(), CF_DEPLOY_TOKEN: "deploy-token", CF_ACCOUNT_ID: ACCOUNT, BUNDLES: b,
    DRIFT: { probeService: async (svc: string) => { log.push(`probe ${svc}`); return { reachable: true, healthy: true, version_tag: NEW.slice(0, 12), error: null }; } },
    REGISTRY: { recordRollback: (id: string) => recordRollback({ DB: db } as never, id), recordNativeDeploy: (id: string) => recordNativeDeploy({ DB: db } as never, id) },
    AGENTS: { syscall: async (_agent: string, _cap: string, input: unknown) => { reports.push(input); return { outcome: "succeeded" }; } },
    ...extra,
  });
  return { env, reports };
}
/** Global fetch for the queue-time eligibility (it reads Cloudflare with the deploy token) and, when given, GitHub. */
function routeFetch(cf: Fake, github?: { dispatched: string[] }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (isAccessCerts(url)) return accessCertsResponse();
    if (url.startsWith("https://api.cloudflare.com/")) return cf.fetcher(input, init);
    if (github && url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: NEW } });
    const m = /\/actions\/workflows\/([a-z-]+\.yml)\/dispatches$/.exec(url);
    if (github && m && init?.method === "POST") { github.dispatched.push(m[1]); return new Response(null, { status: 204 }); }
    throw new Error(`GitHub must not be called: ${url}`);
  }) as typeof fetch;
}
const desired = (db: Db, svc: string) => (db.raw.prepare("SELECT desired_version FROM service_registry WHERE service_id = ?").get(svc) as any).desired_version;
const requestRow = (db: Db) => db.raw.prepare("SELECT request_id, status, details_json FROM deployment_requests").get() as any;
const forgeBundles = async (target = FORGE_TARGET) => { const b = bucket(); await store(b, OLD, { "cryptophys-forge": FORGE_TOML }); await store(b, NEW, { "cryptophys-forge": target }); return b; };

/** Queue a native deploy of the Forge unit through consensus, then run the executor once against `cf`. */
async function queueAndRun(db: Db, b: Bucket, cf: Fake) {
  const { env, reports } = nativeEnv(db, b, cf.log);
  routeFetch(cf);
  const { proposal, decision } = passedProposal(db, "cryptophys-forge");
  const queued = await deployForConsensus(env as never, proposal, decision, "cryptophys-forge", { commit_sha: NEW });
  assert.equal(queued.executor, "native:deploy");
  const queueLog = cf.log.splice(0);
  const result = await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 });
  const row = requestRow(db);
  return { queued, queueLog, result, row, outcome: JSON.parse(row.details_json).outcome, reports };
}

// ---------------------------------------------------------------- tests
test("G2c2W-1. the Forge keeps each Worker's wrangler.toml, named in the manifest; the Cloudflare client reads full versions and script settings", async () => {
  const b = bucket();
  await store(b, NEW, { "cryptophys-forge": FORGE_TOML, "cryptophys-platform-api": API_TOML });
  const manifest = manifestOf(b, NEW);
  assert.equal(manifest.schema, "forge-bundles.v1", "the schema stays v1; config is optional");
  for (const [name, toml] of [["cryptophys-forge", FORGE_TOML], ["cryptophys-platform-api", API_TOML]]) {
    const w = manifest.workers.find((x: any) => x.name === name);
    assert.equal(w.config, `config/${name}.toml`);
    const stored = b.objects.get(`bundles/${NEW}/${w.config}`)!;
    assert.equal(stored.value, toml, "the committed source, never a rendered config");
    assert.equal(Buffer.from(await crypto.subtle.digest("SHA-256", enc.encode(String(stored.value)))).toString("hex"), w.config_sha256);
  }
  // The manifest is still written last, after every config it names.
  assert.equal([...b.objects.keys()].at(-1), `bundles/${NEW}/manifest.json`);
  // A reader accepts only the Forge's own path; an older manifest without it reads as config unknown (null).
  const parsed = parseManifest(JSON.stringify(manifest), NEW)!;
  assert.deepEqual(parsed.workers.map((w) => w.config), ["config/cryptophys-forge.toml", "config/cryptophys-platform-api.toml"]);
  const foreign = structuredClone(manifest); foreign.workers[0].config = "../other/secret.toml";
  assert.equal(parseManifest(JSON.stringify(foreign), NEW), null);
  const older = structuredClone(manifest); delete older.workers[0].config;
  assert.equal(parseManifest(JSON.stringify(older), NEW)!.workers[0].config, null);

  // The client: full version records, script settings, and the fetcher called as a plain function (the runtime's
  // global fetch throws "Illegal invocation" when called as a method of another object).
  const seen: { url: string; method: string; body: unknown; self: unknown }[] = [];
  const strictFetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    seen.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ?? null, self: this });
    const url = String(input);
    if (url.endsWith("/versions/00000001-0000-4000-8000-000000000000")) return Promise.resolve(Response.json({ success: true, result: { id: "x", resources: { bindings: [{ type: "ai", name: "AI" }], script_runtime: { compatibility_date: "2026-11-01", limits: { cpu_ms: 300000 } } } } }));
    return Promise.resolve(Response.json({ success: true, result: { schedules: [] } }));
  } as typeof fetch;
  const cf = new CloudflareWorkers("deploy-token", ACCOUNT, strictFetch);
  const record = await cf.version("cryptophys-forge", "00000001-0000-4000-8000-000000000000");
  assert.deepEqual(record.resources, { bindings: [{ type: "ai", name: "AI" }], script_runtime: { compatibility_date: "2026-11-01", limits: { cpu_ms: 300000 } } });
  await cf.scriptSetting("cryptophys-forge", { method: "PUT", path: "schedules", body: [{ cron: "1 * * * *" }] });
  await cf.scriptSetting("cryptophys-forge", { method: "PATCH", path: "script-settings", body: { observability: { enabled: true } } });
  assert.deepEqual(seen.map((s) => [s.method, s.url.replace(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/`, ""), s.body, s.self]), [
    ["GET", "cryptophys-forge/versions/00000001-0000-4000-8000-000000000000", null, undefined],
    ["PUT", "cryptophys-forge/schedules", '[{"cron":"1 * * * *"}]', undefined],
    ["PATCH", "cryptophys-forge/script-settings", '{"observability":{"enabled":true}}', undefined],
  ]);
  await assert.rejects(cf.scriptSetting("cryptophys-forge", { method: "PUT", path: "script-settings" } as never), /invalid_script_setting/);
  await assert.rejects(cf.version("cryptophys-forge", "not-a-version"), /invalid_version_id/);
});

test("G2c2W-2. a configuration change deploys natively: planned bindings sent and verified, deployed, verified live, then schedules and observability", async () => {
  const db = await freshDb();
  const b = await forgeBundles();
  const cf = forgeFake();
  try {
    const { queued, queueLog, result, row, outcome, reports } = await queueAndRun(db, b, cf);
    assert.deepEqual(result, { executed: 1, succeeded: 1 });
    // Queueing read the active version (never wrote) and recorded what the plan changes.
    assert.deepEqual(queueLog, ["GET cryptophys-forge deployments", "GET cryptophys-forge versions/<id>"]);
    const audit = JSON.parse((db.raw.prepare("SELECT payload_json FROM audit_events WHERE event_type = 'deployment.native_deploy_queued'").get() as any).payload_json);
    assert.equal(audit.request_id, queued.request_id);
    assert.deepEqual(audit.config, { "cryptophys-forge": { added: ["plain_text:NATIVE_CONFIG_PROBE"], removed: [], changed: [], settings: ["triggers.crons", "observability"], steps: ["schedules", "script_settings"] } });
    // The executor: eligibility again (read only), capture and plan again, upload, verify, deploy, live, then the steps.
    assert.deepEqual(cf.log, [
      "GET cryptophys-forge deployments", "GET cryptophys-forge versions/<id>",
      "GET cryptophys-forge deployments", "GET cryptophys-forge versions/<id>",
      "POST cryptophys-forge versions", "GET cryptophys-forge versions/<id>",
      "POST cryptophys-forge deployments", "probe cryptophys-forge",
      "PUT cryptophys-forge schedules", "PATCH cryptophys-forge script-settings",
    ]);
    // The upload: exactly the planned bindings, secrets kept by type only, the target's settings and limits.
    assert.equal(cf.uploads.length, 1);
    const md = cf.uploads[0].metadata;
    assert.deepEqual(md.keep_bindings, ["secret_text", "secret_key"]);
    assert.deepEqual([md.compatibility_date, md.compatibility_flags, md.limits, "placement" in md], ["2026-11-01", [], { cpu_ms: 300000 }, false]);
    assert.equal(md.annotations["workers/tag"], NEW.slice(0, 12));
    const sent = new Map<string, any>(md.bindings.map((x: Binding) => [`${x.type}:${x.name}`, x]));
    assert.deepEqual(sent.get("plain_text:NATIVE_CONFIG_PROBE"), { type: "plain_text", name: "NATIVE_CONFIG_PROBE", text: "on" });
    assert.deepEqual(sent.get("d1:DB"), { type: "d1", name: "DB", id: D1_ID }, "the active D1 id, never the placeholder");
    assert.equal(sent.get("plain_text:ACCESS_AUD").text, "aud-production", "deploy-time --var values kept verbatim");
    assert.deepEqual(sent.get("service:EXT_ORGANISM_XAUUSD"), { type: "service", name: "EXT_ORGANISM_XAUUSD", service: "xauusd-ai-trading-assistant", entrypoint: "OrganismDna", environment: "production" });
    assert.equal([...sent.keys()].some((k) => k.startsWith("secret_")), false, "no secret is ever sent");
    assert.doesNotMatch(JSON.stringify(md), /__CONTROL_PLANE_D1_DATABASE_ID__/);
    // Production: the new version (with the secret kept) at 100%, the new crons and observability.
    const s = cf.scripts.get("cryptophys-forge")!;
    const live = s.versions.get(s.active[0].version_id)!;
    assert.equal(live.tag, NEW.slice(0, 12));
    assert.ok(live.bindings.some((x) => x.type === "secret_text" && x.name === "CF_BUILDS_API_TOKEN"));
    assert.deepEqual(s.schedules, NEW_CRONS.map((cron) => ({ cron })));
    assert.deepEqual(s.observability, { enabled: true, head_sampling_rate: 0.5 });
    // Recorded.
    assert.equal(row.status, "succeeded");
    assert.deepEqual(outcome.steps, [
      "cryptophys-forge:captured", "cryptophys-forge:planned", "cryptophys-forge:uploaded", "cryptophys-forge:bindings_match", "cryptophys-forge:settings_match",
      "cryptophys-forge:deployed", "cryptophys-forge:verified", "cryptophys-forge:schedules_applied", "cryptophys-forge:script_settings_applied", "desired_recorded",
    ]);
    assert.deepEqual(outcome.settings_applied, ["cryptophys-forge:schedules", "cryptophys-forge:script_settings"]);
    assert.equal(desired(db, "cryptophys-forge"), NEW.slice(0, 12));
    assert.equal(reports.length, 0);
  } finally { globalThis.fetch = realFetch; }
});

test("G2c2W-3. every refusal keeps the GitHub workflow with its reason in the native_deploy audit payload; the offline ones read no Cloudflare", async () => {
  const db = await freshDb();
  const D1_NEW = '\n[[d1_databases]]\nbinding = "DB2"\ndatabase_name = "cryptophys-control-plane"\ndatabase_id = "__CONTROL_PLANE_D1_DATABASE_ID__"\n';
  const forgeCfg = `bundles/${NEW}/config/cryptophys-forge.toml`;
  type Case = { label: string; target?: string; arrange?: (b: Bucket) => void; active?: Binding[]; split?: boolean; unit?: typeof FORGE | typeof CONSOLE; expect: Record<string, string>; reads: number };
  const cases: Case[] = [
    { label: "the running manifest names no config (built before G2c-2)", arrange: (b) => {
      const m = manifestOf(b, OLD); delete m.workers[0].config; b.objects.get(`bundles/${OLD}/manifest.json`)!.value = JSON.stringify(m);
    }, expect: { reason: "config_not_stored", service: "cryptophys-forge", file: `bundles/${OLD}/manifest.json` }, reads: 0 },
    { label: "the target config is missing in R2", arrange: (b) => { b.objects.delete(forgeCfg); }, expect: { reason: "config_missing", service: "cryptophys-forge", file: forgeCfg }, reads: 0 },
    { label: "the running config differs from its config_sha256", arrange: (b) => {
      const k = `bundles/${OLD}/config/cryptophys-forge.toml`; b.objects.get(k)!.value = String(b.objects.get(k)!.value) + "\n# edited\n";
    }, expect: { reason: "config_hash_mismatch", service: "cryptophys-forge", file: `bundles/${OLD}/config/cryptophys-forge.toml` }, reads: 0 },
    { label: "a routing change", target: edit(FORGE_TARGET, "workers_dev = true", "workers_dev = false"), expect: { reason: "routing_changed", service: "cryptophys-forge" }, reads: 0 },
    { label: "a Durable Object migration", target: FORGE_TARGET + '\n[[migrations]]\ntag = "v3"\nnew_sqlite_classes = ["X"]\n', expect: { reason: "do_migration", service: "cryptophys-forge" }, reads: 0 },
    { label: "[limits] removed (the version's limits could not be verified)", target: edit(FORGE_TARGET, "[limits]\ncpu_ms = 300000\n", ""), expect: { reason: "limits_removed", service: "cryptophys-forge" }, reads: 0 },
    { label: "[placement] (sent, but never read back)", target: FORGE_TARGET + '\n[placement]\nmode = "smart"\n', expect: { reason: "placement_unverified", service: "cryptophys-forge" }, reads: 0 },
    { label: "a new D1 binding carrying the deploy-time placeholder", target: FORGE_TARGET + D1_NEW, expect: { reason: "unresolved_placeholder:__CONTROL_PLANE_D1_DATABASE_ID__", service: "cryptophys-forge" }, reads: 2 },
    { label: "a changed var the active version overrides (--var)", target: edit(FORGE_TARGET, 'SERVICE_ENVIRONMENT = "production"', 'SERVICE_ENVIRONMENT = "prod"'),
      active: activeFor(FORGE_TOML).map((x) => x.name === "SERVICE_ENVIRONMENT" ? { ...x, text: "staging" } : x),
      expect: { reason: "active_differs_from_config:plain_text:SERVICE_ENVIRONMENT", service: "cryptophys-forge" }, reads: 2 },
    { label: "an active deployment split across versions", split: true, expect: { reason: "active_deployment_split", service: "cryptophys-forge" }, reads: 1 },
    { label: "a Worker that serves static assets (the Console, a later step)", unit: CONSOLE, expect: { reason: "assets", service: "cryptophys-console" }, reads: 0 },
  ];
  try {
    for (const c of cases) {
      reset(db);
      const unit = c.unit ?? FORGE;
      const target = unit.services[0];
      const b = bucket();
      if (unit === CONSOLE) {
        await store(b, OLD, { "cryptophys-console": CONSOLE_TOML });
        await store(b, NEW, { "cryptophys-console": CONSOLE_TOML });
      } else {
        await store(b, OLD, { "cryptophys-forge": FORGE_TOML });
        await store(b, NEW, { "cryptophys-forge": c.target ?? FORGE_TARGET });
      }
      c.arrange?.(b);
      const cf = unit === CONSOLE ? fakeCloudflare({ "cryptophys-console": { bindings: activeFor(CONSOLE_TOML) } }) : forgeFake({}, c.active);
      if (c.split) {
        const s = cf.scripts.get("cryptophys-forge")!;
        s.active = [{ version_id: s.active[0].version_id, percentage: 90 }, { version_id: "00000099-0000-4000-8000-000000000000", percentage: 10 }];
      }
      const github = { dispatched: [] as string[] };
      routeFetch(cf, github);
      const { env } = nativeEnv(db, b, cf.log, { GH_ACTIONS_TOKEN: "gh" });
      const { proposal, decision } = passedProposal(db, target);
      const r = await deployForConsensus(env as never, proposal, decision, target, { commit_sha: NEW });
      assert.equal(r.workflow, unit.workflow, c.label);
      assert.deepEqual(github.dispatched, [unit.workflow], c.label);
      const ev = JSON.parse((db.raw.prepare("SELECT payload_json FROM audit_events WHERE event_type = 'deployment.dispatched' ORDER BY rowid DESC LIMIT 1").get() as any).payload_json);
      assert.equal(ev.request_id, r.request_id, c.label);
      assert.deepEqual(ev.native_deploy, c.expect, c.label);
      assert.equal(cf.log.length, c.reads, `${c.label}: Cloudflare reads`);
      assert.deepEqual(cf.writes(), [], `${c.label}: nothing written to Cloudflare`);
    }
    // Without a Cloudflare reader (the G2b and G2c-1 callers), a planned Worker keeps the earlier answers.
    const b = await forgeBundles();
    assert.deepEqual(await nativeDeployEligible({ DB: db as never, BUNDLES: b }, FORGE, NEW), { eligible: false, reason: "config_changed", service: "cryptophys-forge" });
    const same = await forgeBundles(FORGE_TOML);
    assert.deepEqual(await nativeDeployEligible({ DB: db as never, BUNDLES: same }, FORGE, NEW), { eligible: false, reason: "limits", service: "cryptophys-forge" });
  } finally { globalThis.fetch = realFetch; }
});

test("G2c2W-4. a version that does not match the plan, or a plan that no longer holds at execution, never moves traffic", async () => {
  const db = await freshDb();
  const cases: Array<[string, FakeOpts, string]> = [
    ["a planned binding came back different", { uploaded: (v) => { v.bindings = v.bindings.map((x) => x.name === "NATIVE_CONFIG_PROBE" ? { ...x, text: "off" } : x); } },
      "planned_bindings_differ: binding_differs (plain_text:NATIVE_CONFIG_PROBE)"],
    ["a secret was not kept", { uploaded: (v) => { v.bindings = v.bindings.filter((x) => x.type !== "secret_text"); } }, "planned_bindings_differ: secrets_differ"],
    ["a binding outside the plan appeared", { uploaded: (v) => { v.bindings.push({ type: "kv_namespace", name: "EXTRA", namespace_id: "k" }); } }, "planned_bindings_differ: unexpected_binding (kv_namespace:EXTRA)"],
    ["the version runs without the planned cpu_ms", { uploaded: (v) => { delete v.runtime.limits; } }, "version_settings_differ: limits_differ"],
    ["the version runs another compatibility date", { uploaded: (v) => { v.runtime.compatibility_date = "2026-10-01"; } }, "version_settings_differ: compatibility_date_differs"],
    // The active version changed after the executor's eligibility check (the 2nd read) and before its capture (the 3rd):
    // the plan computed again right before the upload refuses, and nothing is uploaded.
    ["the active bindings changed before the capture", {
      before: (call, k, s) => {
        if (call === "GET cryptophys-forge deployments" && k === 3) s.versions.get(s.active[0].version_id)!.bindings.push({ type: "plain_text", name: "NATIVE_CONFIG_PROBE", text: "dashboard" });
      },
    }, "config_plan_refused: binding_set_outside_config:plain_text:NATIVE_CONFIG_PROBE"],
  ];
  try {
    for (const [label, opts, reason] of cases) {
      reset(db);
      const b = await forgeBundles();
      const cf = forgeFake(opts);
      const before = structuredClone(cf.scripts.get("cryptophys-forge")!.active);
      const { result, row, outcome, reports } = await queueAndRun(db, b, cf);
      assert.deepEqual(result, { executed: 1, succeeded: 0 }, label);
      assert.equal(row.status, "failed", label);
      assert.equal(outcome.reason, reason, label);
      assert.deepEqual(cf.writes(), reason.startsWith("config_plan_refused") ? [] : ["POST cryptophys-forge versions"], `${label}: no deployment, no schedules, no settings`);
      const s = cf.scripts.get("cryptophys-forge")!;
      assert.deepEqual(s.active, before, label);
      assert.deepEqual(s.schedules, OLD_CRONS.map((cron) => ({ cron })), label);
      assert.deepEqual([outcome.production_changed, outcome.restored, "settings_applied" in outcome], [false, true, false], label);
      assert.equal(desired(db, "cryptophys-forge"), OLD.slice(0, 12), label);
      assert.equal(reports.length, 1, label);
      assert.equal(reports[0].severity, "critical", label);
      assert.equal(reports[0].body.reason, reason, label);
    }
  } finally { globalThis.fetch = realFetch; }
});

test("G2c2W-5. a failure after a script setting was applied restores the settings newest first, then the captured deployment", async () => {
  const db = await freshDb();
  const b = await forgeBundles();
  // The observability PATCH fails the first time (after the schedules were applied); the restore calls succeed.
  const cf = forgeFake({ fail: (call, k) => call === "PATCH cryptophys-forge script-settings" && k === 1 });
  const before = structuredClone(cf.scripts.get("cryptophys-forge")!.active);
  try {
    const { result, row, outcome, reports } = await queueAndRun(db, b, cf);
    assert.deepEqual(result, { executed: 1, succeeded: 0 });
    assert.equal(row.status, "failed");
    assert.match(outcome.reason, /^cloudflare_api_500_10013$/);
    // After the live check: the new schedules, the failed PATCH; then the PATCH's restore body, the schedules'
    // restore body (newest first), and only then the captured deployment.
    const afterProbe = cf.log.slice(cf.log.indexOf("probe cryptophys-forge") + 1);
    assert.deepEqual(afterProbe, [
      "PUT cryptophys-forge schedules", "PATCH cryptophys-forge script-settings",
      "PATCH cryptophys-forge script-settings", "PUT cryptophys-forge schedules",
      "GET cryptophys-forge deployments", "POST cryptophys-forge deployments", "GET cryptophys-forge deployments",
    ]);
    const s = cf.scripts.get("cryptophys-forge")!;
    assert.deepEqual(s.active, before, "the captured deployment runs again");
    assert.deepEqual(s.schedules, OLD_CRONS.map((cron) => ({ cron })), "the running crons");
    assert.deepEqual(s.observability, { enabled: true }, "the running observability");
    assert.deepEqual(outcome.steps.slice(-4), ["cryptophys-forge:schedules_applied", "cryptophys-forge:script_settings_restored", "cryptophys-forge:schedules_restored", "cryptophys-forge:restored"]);
    assert.deepEqual([outcome.restored, outcome.production_changed, outcome.service], [true, true, "cryptophys-forge"]);
    assert.deepEqual(outcome.settings_applied, ["cryptophys-forge:schedules", "cryptophys-forge:script_settings"]);
    assert.equal(desired(db, "cryptophys-forge"), OLD.slice(0, 12), "nothing recorded");
    // The same critical report as any native deploy failure, naming the settings that were applied.
    assert.equal(reports.length, 1);
    assert.equal(reports[0].severity, "critical");
    assert.match(reports[0].subject, /^Deploy of forge at 2d2d2d2d2d2d failed$/);
    assert.deepEqual([reports[0].body.restored, reports[0].body.settings_applied], [true, ["cryptophys-forge:schedules", "cryptophys-forge:script_settings"]]);
    assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'deployment.native_deploy_failed'").get() as any).n, 1);
  } finally { globalThis.fetch = realFetch; }
});

test("G2c2W-6. code only is unchanged (G2b), and [limits] deploys only through the verified plan", async () => {
  const db = await freshDb();
  try {
    // Code only: no Cloudflare read before the executor's capture, every binding type kept, nothing sent.
    const b = bucket();
    await store(b, OLD, { "cryptophys-platform-api": API_TOML });
    await store(b, NEW, { "cryptophys-platform-api": API_TOML });
    const cf = fakeCloudflare({ "cryptophys-platform-api": { bindings: activeFor(API_TOML) } });
    const { env } = nativeEnv(db, b, cf.log);
    routeFetch(cf);
    const p = passedProposal(db, "cryptophys-platform-api");
    assert.equal((await deployForConsensus(env as never, p.proposal, p.decision, "cryptophys-platform-api", { commit_sha: NEW })).executor, "native:deploy");
    assert.deepEqual(cf.log, [], "eligibility of a code-only change reads no Cloudflare");
    assert.deepEqual(await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 1 });
    assert.deepEqual(cf.log, [
      "GET cryptophys-platform-api deployments", "GET cryptophys-platform-api versions/<id>", "POST cryptophys-platform-api versions",
      "GET cryptophys-platform-api versions/<id>", "POST cryptophys-platform-api deployments", "probe cryptophys-platform-api",
    ]);
    const md = cf.uploads[0].metadata;
    assert.deepEqual(md.keep_bindings, [...KEEP_BINDINGS]);
    assert.deepEqual(["bindings" in md, "limits" in md], [false, false]);
    const code = JSON.parse(requestRow(db).details_json).outcome;
    assert.deepEqual(code.steps, ["cryptophys-platform-api:captured", "cryptophys-platform-api:uploaded", "cryptophys-platform-api:bindings_match", "cryptophys-platform-api:deployed", "cryptophys-platform-api:verified", "desired_recorded"]);
    assert.equal("settings_applied" in code, false);

    // The Forge with an unchanged wrangler.toml: [limits] is carried by the plan and checked in script_runtime.
    reset(db);
    const lb = await forgeBundles(FORGE_TOML);
    const lcf = forgeFake();
    const { result, outcome } = await queueAndRun(db, lb, lcf);
    assert.deepEqual(result, { executed: 1, succeeded: 1 });
    const lmd = lcf.uploads[0].metadata;
    assert.deepEqual([lmd.limits, lmd.keep_bindings], [{ cpu_ms: 300000 }, ["secret_text", "secret_key"]]);
    const active = activeFor(FORGE_TOML).filter((x) => !x.type.startsWith("secret_"));
    assert.deepEqual([...lmd.bindings].sort((x: Binding, y: Binding) => `${x.type}:${x.name}`.localeCompare(`${y.type}:${y.name}`)),
      [...active].sort((x, y) => `${x.type}:${x.name}`.localeCompare(`${y.type}:${y.name}`)), "every active binding verbatim");
    assert.deepEqual(lcf.writes(), ["POST cryptophys-forge versions", "POST cryptophys-forge deployments"], "no schedules or settings: none changed");
    assert.ok(outcome.steps.includes("cryptophys-forge:settings_match"));
    assert.equal(desired(db, "cryptophys-forge"), NEW.slice(0, 12));
  } finally { globalThis.fetch = realFetch; }
});
