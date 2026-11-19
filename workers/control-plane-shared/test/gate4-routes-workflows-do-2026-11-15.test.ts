// ADR-0012 G6 gate 4 part B (owner 2026-11-15, "1 setuju"): the changes the G2c-2 plan refused go native where that is
// safe (deployment-orchestrator/src/topology.ts), against a fake Cloudflare API:
//   - a new custom domain is attached after the version is verified live and read back; a failure detaches it again
//     and restores the deployment; removing one, or a zone route the deploy token cannot create, is refused;
//   - an additive Durable Object migration (new_sqlite_classes) deploys through the Script Upload API with
//     { old_tag, new_tag, steps } and is verified (deployment, migration tag, bindings, live tag); a restore across it is
//     refused by Cloudflare and reported as not restored; deleted or renamed classes are refused;
//   - a Workflow update (and a new Workflow) is applied after the live check and read back; an update is put back on a
//     later failure; removing one is refused;
//   - a unit without such changes reads nothing new and deploys exactly as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { APPROVER_EMAIL, OPERATOR_EMAIL, OPERATOR_JWT, accessCertsResponse, baseEnv, call, fakeWorkflow, isAccessCerts, migratedDb, req } from "./harness.ts";
import { approvedBreakGlassPlan, breakGlassPlanProblem, namedTopology } from "../src/break-glass.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import { DeploymentLock, forceDeployForRecovery, runNativeExecutors } from "../../deployment-orchestrator/src/index.ts";
import { SAFE_MINUTES } from "../../deployment-orchestrator/src/native-rollback.ts";
import { DO_IRREVERSIBLE, WORKFLOW_IRREVERSIBLE } from "../../deployment-orchestrator/src/topology.ts";
import { recordNativeDeploy, recordRollback } from "../../platform-registry/src/index.ts";
import recovery, { proposeFromAgent } from "../../recovery-manager/src/index.ts";
import { unitForService, type DeployUnit } from "../src/deploy-units.ts";
import { storeBundles, type BuiltModule, type BundleBucket } from "../../forge/src/bundles.ts";
import { CloudflareWorkers } from "../../deployment-orchestrator/src/native-rollback.ts";
import { executeNativeDeploy, nativeDeployEligible, type PlannedService } from "../../deployment-orchestrator/src/native-deploy.ts";
import { bindingsFromToml, configRefusal, parseToml } from "../../deployment-orchestrator/src/config-diff.ts";
import { topologyDiff } from "../../deployment-orchestrator/src/topology.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const API = "https://api.cloudflare.com/client/v4";
const ACCOUNT = "a".repeat(32);
const OLD = "0e".repeat(20);
const NEW = "4f".repeat(20);
const TAG = NEW.slice(0, 12);
const D1_ID = "d1000000-0000-4000-8000-000000000001";
const enc = new TextEncoder();
const edit = (text: string, from: string, to: string) => { assert.ok(text.includes(from), from); return text.replace(from, to); };

const ORCH = "cryptophys-deployment-orchestrator";
const RECOVERY = "cryptophys-recovery-manager";
const ORCH_UNIT = unitForService(ORCH)!;
// The Recovery Manager deploys with the Control Plane unit; one Worker is enough for the mechanism under test.
const RECOVERY_UNIT = { unit: "recovery-manager-test", workflow: "deploy-control-plane.yml", services: [RECOVERY], paths: [] } as unknown as DeployUnit;
const ORCH_TOML = read("workers/deployment-orchestrator/wrangler.toml");
const RECOVERY_TOML = read("workers/recovery-manager/wrangler.toml");
const ORCH_HOST = "deploy-orchestrator.cryptophys.work";
const NEW_HOST = "deploy-native.cryptophys.work";
const LIFECYCLE = "cryptophys-recovery-lifecycle";
const ROUTES_LINE = `routes = [{ pattern = "${ORCH_HOST}", custom_domain = true }]`;

// ---------------------------------------------------------------- the Forge's bundles (R2)
function bucket() {
  const objects = new Map<string, { value: string | Uint8Array; uploaded: Date }>();
  const b = {
    objects,
    async put(key: string, value: string | Uint8Array) { objects.set(key, { value, uploaded: new Date() }); return {}; },
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
async function scenario(service: string, runningToml: string, targetToml: string) {
  const b = bucket();
  const built = (commit: string, toml: string): BuiltModule[] => [{ dir: `workers/${service.replace("cryptophys-", "")}`, text: moduleText(service, commit), toml, external: [] }];
  await storeBundles(b, OLD, built(OLD, runningToml), Date.now(), ["0001_init.sql"]);
  await storeBundles(b, NEW, built(NEW, targetToml), Date.now(), ["0001_init.sql"]);
  const db = migratedDb();
  db.raw.prepare("UPDATE service_registry SET desired_version = ?").run(OLD.slice(0, 12));
  return { b, db };
}

// ---------------------------------------------------------------- the active version, as wrangler deployed it
type Binding = { type: string; name: string; [k: string]: unknown };
/** A Durable Object namespace id per class, as Cloudflare keeps it across versions. */
const namespaceOf = (cls: string) => [...cls].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(32, "0");
function activeFor(toml: string): Binding[] {
  const declared = bindingsFromToml(parseToml(toml)!).bindings!.map((x) => {
    if (x.type === "d1") return { ...x, id: D1_ID };
    if (x.type === "service") return { ...x, environment: "production" };
    if (x.type === "durable_object_namespace") return { ...x, namespace_id: namespaceOf(String(x.class_name)) };
    return { ...x };
  });
  return [...declared, { type: "plain_text", name: "OPERATOR_IDENTITIES", text: "ops@example.com" }, { type: "secret_text", name: "CF_DEPLOY_TOKEN" }];
}

// ---------------------------------------------------------------- a fake Cloudflare API
interface Version { bindings: Binding[]; runtime: Record<string, unknown>; tag?: string }
interface Script {
  active: { version_id: string; percentage: number }[]; versions: Map<string, Version>; schedules: { cron: string }[]; observability: unknown;
  migration_tag: string | null; routes: Array<{ id: string; pattern: string; script: string }>; subdomain: { enabled: boolean; previews_enabled: boolean };
  /** Versions uploaded before the last Durable Object class change: Cloudflare refuses to deploy them again. */
  beforeLifecycle: Set<string>;
}
interface FakeOpts {
  /** Answer this call with an error status (the n-th time it is made, from 1). */
  fail?: (call: string, n: number) => number | false;
  domains?: Array<{ hostname: string; service: string }>;
  workflows?: Record<string, { class_name: string; script_name: string }>;
}
function fakeCloudflare(initial: Record<string, { bindings: Binding[]; crons?: string[]; migration_tag?: string | null; routes?: Array<{ pattern: string }>; subdomain?: { enabled: boolean; previews_enabled: boolean } }>, opts: FakeOpts = {}) {
  const scripts = new Map<string, Script>();
  let v = 0;
  const uuid = () => `${String(++v).padStart(8, "0")}-0000-4000-8000-000000000000`;
  for (const [name, s] of Object.entries(initial)) {
    const id = uuid();
    scripts.set(name, {
      active: [{ version_id: id, percentage: 100 }], versions: new Map([[id, { bindings: structuredClone(s.bindings), runtime: { compatibility_date: "2026-11-01", compatibility_flags: [] }, tag: OLD.slice(0, 12) }]]),
      schedules: (s.crons ?? []).map((cron) => ({ cron })), observability: { enabled: true }, migration_tag: s.migration_tag ?? null,
      routes: (s.routes ?? []).map((r, i) => ({ id: `route${i}`, pattern: r.pattern, script: name })), beforeLifecycle: new Set(),
      subdomain: s.subdomain ?? { enabled: true, previews_enabled: false },
    });
  }
  let d = 0;
  const domains = (opts.domains ?? []).map((x) => ({ id: `dom${++d}`, ...x, enabled: true }));
  const workflows = new Map(Object.entries(structuredClone(opts.workflows ?? {})).map(([k, w]) => [k, w as Record<string, unknown>]));
  const log: string[] = [];
  const uploads: { kind: "version" | "script"; script: string; metadata: any }[] = [];
  const counts = new Map<string, number>();
  const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
  const err = (status: number, code = 10000) => Response.json({ success: false, errors: [{ code, message: "fake" }], result: null }, { status });
  const newVersion = async (s: Script, script: string, metadata: any): Promise<string> => {
    const latest = [...s.versions.values()].at(-1)!;
    const kept = latest.bindings.filter((x) => metadata.keep_bindings.includes(x.type));
    // Sent bindings as the API reports them back: a service gains environment "production", a DO its namespace_id.
    const sent = (metadata.bindings ?? []).map((x: Binding) => x.type === "service" && x.environment === undefined ? { ...x, environment: "production" }
      : x.type === "durable_object_namespace" ? { ...x, namespace_id: namespaceOf(String(x.class_name)) } : x);
    const id = uuid();
    s.versions.set(id, {
      bindings: metadata.bindings ? [...sent, ...kept.filter((k) => !sent.some((x: Binding) => x.name === k.name))] : structuredClone(kept),
      runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags ?? [], ...(metadata.limits ? { limits: metadata.limits } : {}) },
      tag: metadata.annotations["workers/tag"],
    });
    uploads.push({ kind: metadata.migrations ? "script" : "version", script, metadata });
    return id;
  };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer deploy-token");
    const method = init?.method ?? "GET";
    const path = url.slice(`${API}/accounts/${ACCOUNT}/`.length);
    assert.ok(url.startsWith(`${API}/accounts/${ACCOUNT}/`), url);
    const call = `${method} ${path.replace(/[0-9a-f]{8}-0000-4000-8000-[0-9a-f]{12}/, "<id>")}`;
    const n = (counts.get(call) ?? 0) + 1;
    counts.set(call, n);
    log.push(call);
    const status = opts.fail?.(call, n);
    if (status) return err(status);
    // Workers Custom Domains.
    if (path.startsWith("workers/domains")) {
      const q = new URL(url).searchParams.get("hostname");
      if (method === "GET") return ok(domains.filter((x) => !q || x.hostname === q));
      if (method === "PUT") {
        const body = JSON.parse(String(init!.body));
        const existing = domains.find((x) => x.hostname === body.hostname);
        if (existing) existing.service = body.service; else domains.push({ id: `dom${++d}`, hostname: body.hostname, service: body.service, enabled: true });
        return ok(domains.find((x) => x.hostname === body.hostname));
      }
      const m = /^workers\/domains\/([A-Za-z0-9-]+)$/.exec(path);
      if (method === "DELETE" && m) { const i = domains.findIndex((x) => x.id === m[1]); if (i < 0) return err(404, 100); domains.splice(i, 1); return ok(null); }
    }
    // Workflows.
    const wf = /^workflows\/([A-Za-z0-9_-]+)$/.exec(path);
    if (wf) {
      if (method === "GET") { const w = workflows.get(wf[1]); return w ? ok({ id: "w", name: wf[1], ...w }) : err(404, 10200); }
      if (method === "PUT") { workflows.set(wf[1], JSON.parse(String(init!.body))); return ok({ id: "w", name: wf[1], ...workflows.get(wf[1]) }); }
      if (method === "DELETE") { if (!workflows.delete(wf[1])) return err(404, 10200); return ok({ status: "ok" }); }
    }
    // The account's script list.
    if (path === "workers/scripts" && method === "GET") return ok([...scripts.entries()].map(([id, s]) => ({ id, migration_tag: s.migration_tag ?? undefined, routes: s.routes })));
    const m = /^workers\/scripts\/([a-z0-9-]+)(?:\/(.*))?$/.exec(path);
    assert.ok(m, `unexpected ${method} ${url}`);
    const [, script, rest = ""] = m!;
    const s = scripts.get(script)!;
    assert.ok(s, `unknown script ${script}`);
    if (rest === "" && method === "PUT") {
      // The Script Upload API: uploads and deploys at once, applying the migration (old_tag must match).
      const metadata = JSON.parse(await ((init!.body as FormData).get("metadata") as Blob).text());
      const mig = metadata.migrations;
      if (mig && (mig.old_tag ?? null) !== s.migration_tag) return err(400, 10079);
      const id = await newVersion(s, script, metadata);
      if (mig) { for (const vid of s.versions.keys()) if (vid !== id) s.beforeLifecycle.add(vid); s.migration_tag = mig.new_tag; }
      s.active = [{ version_id: id, percentage: 100 }];
      return ok({ id: script, migration_tag: s.migration_tag });
    }
    if (rest === "versions" && method === "POST") {
      const metadata = JSON.parse(await ((init!.body as FormData).get("metadata") as Blob).text());
      assert.equal(metadata.migrations, undefined, "a version upload never carries migrations");
      return ok({ id: await newVersion(s, script, metadata) });
    }
    if (rest === "deployments" && method === "GET") return ok({ deployments: [{ created_on: "2026-11-15T00:00:00Z", versions: s.active }] });
    if (rest === "deployments" && method === "POST") {
      const versions = JSON.parse(String(init!.body)).versions as { version_id: string }[];
      // Cloudflare refuses a rollback across a Durable Object class change.
      if (versions.some((x) => s.beforeLifecycle.has(x.version_id))) return err(400, 10211);
      s.active = versions as Script["active"];
      return ok({ id: "dep" });
    }
    const vm = /^versions\/([0-9a-f-]{36})$/.exec(rest);
    if (vm && method === "GET") {
      const ver = s.versions.get(vm[1]);
      return ver ? ok({ id: vm[1], resources: { bindings: ver.bindings, script_runtime: ver.runtime } }) : err(404, 10007);
    }
    if (rest === "subdomain" && method === "GET") return ok(s.subdomain);
    if (rest === "subdomain" && method === "POST") { const body = JSON.parse(String(init!.body)); s.subdomain = { enabled: body.enabled, previews_enabled: body.previews_enabled }; return ok(s.subdomain); }
    if (rest === "schedules" && method === "PUT") { s.schedules = JSON.parse(String(init!.body)); return ok({ schedules: s.schedules }); }
    if (rest === "script-settings" && method === "PATCH") { s.observability = JSON.parse(String(init!.body)).observability; return ok({ observability: s.observability }); }
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  const writes = () => log.filter((c) => /^(POST|PUT|PATCH|DELETE) /.test(c));
  return { fetcher, log, writes, uploads, scripts, domains, workflows };
}
type Fake = ReturnType<typeof fakeCloudflare>;

/** The Orchestrator's env for executeNativeDeploy: the Drift Detector reads the active version's tag from the fake. */
function executorEnv(cf: Fake, b: Bucket, db: ReturnType<typeof migratedDb>, opts: { registryFails?: boolean } = {}) {
  const recorded: string[] = [];
  return {
    recorded,
    env: {
      DRIFT: { probeService: async (service: string) => {
        const s = cf.scripts.get(service)!;
        const ver = s.versions.get(s.active[0].version_id)!;
        return { reachable: true, healthy: true, version_tag: ver.tag ?? null, error: null };
      } },
      REGISTRY: {
        recordRollback: async () => ({ desired_version: "" }),
        recordNativeDeploy: async (requestId: string) => { if (opts.registryFails) throw new Error("registry_down"); recorded.push(requestId); return { desired_version: TAG, services: [] }; },
      },
      BUNDLES: b, DB: db as never,
    },
  };
}
const REQ = "dep_00000000-0000-4000-8000-0000000000b4";

async function eligibleAndRun(service: string, unit: DeployUnit, running: string, target: string, cf: Fake, opts: { registryFails?: boolean } = {}) {
  const { b, db } = await scenario(service, running, target);
  const client = new CloudflareWorkers("deploy-token", ACCOUNT, cf.fetcher);
  const e = await nativeDeployEligible({ DB: db as never, BUNDLES: b }, unit, NEW, client);
  if (!e.eligible) return { e, run: null, eligibilityReads: [...cf.log] };
  const eligibilityReads = [...cf.log];
  cf.log.length = 0;
  const { env, recorded } = executorEnv(cf, b, db, opts);
  const run = await executeNativeDeploy(client, env, REQ, NEW, e.services as PlannedService[], { delayMs: 0 });
  return { e, run, eligibilityReads, recorded };
}

// ================================================================ routes and custom domains

test("G4B-1. a new custom domain is attached after the version is verified live, and read back", async () => {
  const target = edit(ORCH_TOML, ROUTES_LINE, `routes = [{ pattern = "${ORCH_HOST}", custom_domain = true }, { pattern = "${NEW_HOST}", custom_domain = true }]`);
  // The G2c-2 plan alone still refuses it; with topology.ts planning it, it is not refused offline.
  assert.equal(configRefusal(ORCH_TOML, target), "routing_changed");
  assert.equal(configRefusal(ORCH_TOML, target, { topology: true }), null);
  const cf = fakeCloudflare({ [ORCH]: { bindings: activeFor(ORCH_TOML), crons: ["2,10,17,25,32,40,47,55 * * * *"], migration_tag: "v1" } }, { domains: [{ hostname: ORCH_HOST, service: ORCH }] });
  const { e, run, eligibilityReads, recorded } = await eligibleAndRun(ORCH, ORCH_UNIT, ORCH_TOML, target, cf);
  assert.ok(e.eligible, JSON.stringify(e));
  assert.deepEqual(e.services[0].config?.topology, [`custom_domain:+${NEW_HOST}`]);
  assert.ok(eligibilityReads.includes(`GET workers/domains?hostname=${NEW_HOST}`), "the live domain list is read at queue time");
  assert.deepEqual(eligibilityReads.filter((c) => /^(POST|PUT|PATCH|DELETE) /.test(c)), [], "eligibility writes nothing");
  assert.ok(run?.ok, JSON.stringify(run));
  assert.deepEqual(run!.steps, [
    `${ORCH}:captured`, `${ORCH}:planned`, `${ORCH}:topology_planned`, `${ORCH}:uploaded`, `${ORCH}:bindings_match`, `${ORCH}:settings_match`,
    `${ORCH}:deployed`, `${ORCH}:verified`, `${ORCH}:custom_domain:${NEW_HOST}_applied`, "desired_recorded",
  ]);
  assert.deepEqual(run!.topology_applied, [`${ORCH}:custom_domain:${NEW_HOST}`]);
  // Order: the version, its deployment, and only then the domain.
  const w = cf.writes();
  assert.deepEqual(w, [`POST workers/scripts/${ORCH}/versions`, `POST workers/scripts/${ORCH}/deployments`, "PUT workers/domains"]);
  assert.deepEqual(cf.domains.map((x) => [x.hostname, x.service]), [[ORCH_HOST, ORCH], [NEW_HOST, ORCH]]);
  assert.equal(cf.uploads[0].kind, "version");
  assert.deepEqual(recorded, [REQ]);
});

test("G4B-2. a custom domain that fails, or a failure after it was attached, is restored: the domain detached, the deployment back", async () => {
  const target = edit(ORCH_TOML, ROUTES_LINE, `routes = [{ pattern = "${ORCH_HOST}", custom_domain = true }, { pattern = "${NEW_HOST}", custom_domain = true }]`);
  const fresh = (fail?: FakeOpts["fail"]) => fakeCloudflare({ [ORCH]: { bindings: activeFor(ORCH_TOML), migration_tag: "v1" } }, { domains: [{ hostname: ORCH_HOST, service: ORCH }], fail });

  // (a) The attach is refused (a token without the permission): nothing to detach, the deployment restored.
  const a = fresh((call) => call === "PUT workers/domains" ? 403 : false);
  const before = a.scripts.get(ORCH)!.active;
  const ra = await eligibleAndRun(ORCH, ORCH_UNIT, ORCH_TOML, target, a);
  assert.ok(ra.e.eligible);
  assert.equal(ra.run!.ok, false);
  assert.match(ra.run!.reason!, /^cloudflare_api_403_/);
  assert.deepEqual([ra.run!.restored, ra.run!.production_changed], [true, true]);
  assert.deepEqual(a.scripts.get(ORCH)!.active, before, "the captured deployment is active again");
  assert.ok(ra.run!.steps.includes(`${ORCH}:custom_domain_detached:${NEW_HOST}`));
  assert.ok(ra.run!.steps.includes(`${ORCH}:restored`));
  assert.deepEqual(a.domains.map((x) => x.hostname), [ORCH_HOST]);

  // (b) The domain is attached and verified, then the registry fails: it is detached first, then the deployment restored.
  const b = fresh();
  const rb = await eligibleAndRun(ORCH, ORCH_UNIT, ORCH_TOML, target, b, { registryFails: true });
  assert.equal(rb.run!.ok, false);
  assert.equal(rb.run!.reason, "registry_down");
  assert.equal(rb.run!.restored, true);
  assert.deepEqual(rb.run!.topology_applied, [`${ORCH}:custom_domain:${NEW_HOST}`]);
  const tail = rb.run!.steps.slice(rb.run!.steps.indexOf(`${ORCH}:custom_domain:${NEW_HOST}_applied`));
  assert.deepEqual(tail, [`${ORCH}:custom_domain:${NEW_HOST}_applied`, `${ORCH}:custom_domain_detached:${NEW_HOST}`, `${ORCH}:restored`]);
  assert.deepEqual(b.domains.map((x) => x.hostname), [ORCH_HOST], "the new hostname is detached again; the existing one is untouched");
  const w = b.writes();
  assert.ok(w.indexOf("PUT workers/domains") < w.findIndex((c) => c.startsWith("DELETE workers/domains/")), "detached after it was attached");
  assert.ok(w.findIndex((c) => c.startsWith("DELETE workers/domains/")) < w.lastIndexOf(`POST workers/scripts/${ORCH}/deployments`), "before the deployment is restored");
});

test("G4B-3. removing a route or a custom domain is refused (owner-run) before any Cloudflare call; a zone route the token cannot create too", async () => {
  // Removing the Orchestrator's custom domain.
  const removed = edit(ORCH_TOML, ROUTES_LINE + "\n", "");
  const cf = fakeCloudflare({ [ORCH]: { bindings: activeFor(ORCH_TOML), migration_tag: "v1" } }, { domains: [{ hostname: ORCH_HOST, service: ORCH }] });
  const r = await eligibleAndRun(ORCH, ORCH_UNIT, ORCH_TOML, removed, cf);
  assert.deepEqual(r.e, { eligible: false, reason: `custom_domain_removal_owner_run:${ORCH_HOST}`, service: ORCH });
  assert.deepEqual(cf.log, [], "decided from the two configs alone");
  // Moving it to another hostname is a removal as well; turning it into a zone route is a change of the route.
  assert.deepEqual(topologyDiff(ORCH_TOML, edit(ORCH_TOML, `pattern = "${ORCH_HOST}"`, `pattern = "${NEW_HOST}"`), ORCH), { reason: `custom_domain_removal_owner_run:${ORCH_HOST}` });
  // Turning it into a zone route needs a zone permission the deploy token does not hold (owner decision 2026-11-06).
  assert.deepEqual(topologyDiff(ORCH_TOML, edit(ORCH_TOML, ", custom_domain = true", ""), ORCH), { reason: `route_change_needs_zone_token:${ORCH_HOST}` });
  assert.deepEqual(topologyDiff(ORCH_TOML, edit(ORCH_TOML, "custom_domain = true }", 'custom_domain = true, zone_name = "cryptophys.work" }'), ORCH), { reason: `route_changed_owner_run:${ORCH_HOST}` });
  const zone = `routes = [{ pattern = "${ORCH_HOST}", custom_domain = true }, { pattern = "nexus.cryptophys.work/deploy*", zone_name = "cryptophys.work" }]`;
  assert.deepEqual(topologyDiff(edit(ORCH_TOML, ROUTES_LINE, zone), ORCH_TOML, ORCH), { reason: "zone_route_removal_owner_run:nexus.cryptophys.work/deploy*" });

  // A new zone route needs Workers Routes Edit (a zone permission the deploy token cannot hold): refused unless live already.
  const added = edit(ORCH_TOML, ROUTES_LINE, zone);
  const z = fakeCloudflare({ [ORCH]: { bindings: activeFor(ORCH_TOML), migration_tag: "v1" } });
  const rz = await eligibleAndRun(ORCH, ORCH_UNIT, ORCH_TOML, added, z);
  assert.deepEqual(rz.e, { eligible: false, reason: "zone_route_needs_zone_token:nexus.cryptophys.work/deploy*", service: ORCH });
  assert.deepEqual(z.writes(), []);
  // Attached by the owner already: accepted, nothing to apply.
  const live = fakeCloudflare({ [ORCH]: { bindings: activeFor(ORCH_TOML), migration_tag: "v1", routes: [{ pattern: "nexus.cryptophys.work/deploy*" }] } });
  const rl = await eligibleAndRun(ORCH, ORCH_UNIT, ORCH_TOML, added, live);
  assert.ok(rl.e.eligible && rl.run?.ok, JSON.stringify(rl.run ?? rl.e));
  assert.deepEqual(rl.e.eligible && rl.e.services[0].config?.topology, ["zone_route:=nexus.cryptophys.work/deploy*"]);
  assert.equal(rl.run!.topology_applied, undefined);
  // A new custom domain already on another Worker would be moved: refused.
  const other = fakeCloudflare({ [ORCH]: { bindings: activeFor(ORCH_TOML), migration_tag: "v1" } }, { domains: [{ hostname: NEW_HOST, service: "cryptophys-console" }] });
  const ro = await eligibleAndRun(ORCH, ORCH_UNIT, ORCH_TOML, edit(ORCH_TOML, ROUTES_LINE, `routes = [{ pattern = "${ORCH_HOST}", custom_domain = true }, { pattern = "${NEW_HOST}", custom_domain = true }]`), other);
  assert.deepEqual(ro.e, { eligible: false, reason: `custom_domain_on_other_worker:${NEW_HOST}`, service: ORCH });
  assert.deepEqual(other.writes(), []);
});

// ================================================================ Durable Object migrations

const JOURNAL = `
[[durable_objects.bindings]]
name = "DEPLOY_JOURNAL"
class_name = "DeployJournal"
`;
const DO_TARGET = edit(ORCH_TOML, 'new_sqlite_classes = ["DeploymentLock"]\n', `new_sqlite_classes = ["DeploymentLock"]\n\n[[migrations]]\ntag = "v2"\nnew_sqlite_classes = ["DeployJournal"]\n${JOURNAL}`);

test("G4B-4. a new_sqlite_classes migration is carried in a Script Upload with old_tag/new_tag/steps and verified; a restore across it is refused", async () => {
  assert.equal(configRefusal(ORCH_TOML, DO_TARGET), "do_migration", "the G2c-2 plan alone refuses it");
  const cf = fakeCloudflare({ [ORCH]: { bindings: activeFor(ORCH_TOML), migration_tag: "v1" } }, { domains: [{ hostname: ORCH_HOST, service: ORCH }] });
  const before = cf.scripts.get(ORCH)!.active;
  const { e, run, eligibilityReads } = await eligibleAndRun(ORCH, ORCH_UNIT, ORCH_TOML, DO_TARGET, cf);
  assert.ok(e.eligible, JSON.stringify(e));
  assert.deepEqual(e.services[0].config?.topology, ["do_migration:v1->v2"]);
  assert.deepEqual(e.services[0].config?.changes.added, ["durable_object_namespace:DEPLOY_JOURNAL"]);
  assert.ok(eligibilityReads.includes("GET workers/scripts"), "the live migration tag is read");
  assert.ok(run?.ok, JSON.stringify(run));
  // One Script Upload (it deploys), no version upload and no separate deployment.
  assert.deepEqual(cf.writes(), [`PUT workers/scripts/${ORCH}`]);
  assert.equal(cf.uploads.length, 1);
  assert.equal(cf.uploads[0].kind, "script");
  const md = cf.uploads[0].metadata;
  assert.deepEqual(md.migrations, { old_tag: "v1", new_tag: "v2", steps: [{ new_sqlite_classes: ["DeployJournal"] }] });
  assert.deepEqual(md.keep_bindings, ["secret_text", "secret_key"]);
  assert.ok(md.bindings.some((x: Binding) => x.type === "durable_object_namespace" && x.name === "DEPLOY_JOURNAL" && x.class_name === "DeployJournal" && x.namespace_id === undefined));
  assert.deepEqual(md.observability, { enabled: true }, "the script-level settings of the target config are sent with it");
  assert.equal(md.annotations["workers/tag"], TAG);
  assert.equal(cf.scripts.get(ORCH)!.migration_tag, "v2");
  assert.deepEqual(run!.do_migrations, [`${ORCH}:v2`]);
  assert.deepEqual(run!.steps, [
    `${ORCH}:captured`, `${ORCH}:planned`, `${ORCH}:topology_planned`, `${ORCH}:do_migration_deployed`, `${ORCH}:bindings_match`, `${ORCH}:settings_match`,
    `${ORCH}:verified`, "desired_recorded",
  ]);
  assert.notDeepEqual(cf.scripts.get(ORCH)!.active, before);

  // A later failure tries to restore the captured deployment; Cloudflare refuses a rollback across the class change, so
  // the run says so (restored: false, a critical report) and the migrated version stays live (forward-only).
  const f = fakeCloudflare({ [ORCH]: { bindings: activeFor(ORCH_TOML), migration_tag: "v1" } });
  const rf = await eligibleAndRun(ORCH, ORCH_UNIT, ORCH_TOML, DO_TARGET, f, { registryFails: true });
  assert.equal(rf.run!.ok, false);
  assert.deepEqual([rf.run!.reason, rf.run!.restored, rf.run!.production_changed], ["registry_down", false, true]);
  assert.deepEqual(rf.run!.do_migrations, [`${ORCH}:v2`]);
  assert.equal(f.scripts.get(ORCH)!.migration_tag, "v2");
  assert.ok(f.writes().includes(`POST workers/scripts/${ORCH}/deployments`), "the restore was attempted");

  // The live tag is not the running config's: refused at queue time, nothing written.
  const t = fakeCloudflare({ [ORCH]: { bindings: activeFor(ORCH_TOML), migration_tag: "v0" } });
  const rt = await eligibleAndRun(ORCH, ORCH_UNIT, ORCH_TOML, DO_TARGET, t);
  assert.deepEqual(rt.e, { eligible: false, reason: "do_migration_tag_differs", service: ORCH });
  assert.deepEqual(t.writes(), []);
  // Already applied live (the owner ran it): no migration is sent, the version goes up the usual way.
  const done = fakeCloudflare({ [ORCH]: { bindings: activeFor(ORCH_TOML), migration_tag: "v2" } });
  const rd = await eligibleAndRun(ORCH, ORCH_UNIT, ORCH_TOML, DO_TARGET, done);
  assert.ok(rd.run?.ok, JSON.stringify(rd.run ?? rd.e));
  assert.deepEqual(done.writes(), [`POST workers/scripts/${ORCH}/versions`, `POST workers/scripts/${ORCH}/deployments`]);
  assert.equal(rd.run!.do_migrations, undefined);
});

test("G4B-5. deleted_classes, renamed_classes and transferred_classes are refused (owner-run), and so is a rewritten migration history", async () => {
  const cases: Array<[string, string]> = [
    [`\n[[migrations]]\ntag = "v2"\ndeleted_classes = ["DeploymentLock"]\n`, "do_migration_destructive:deleted_classes:v2"],
    [`\n[[migrations]]\ntag = "v2"\nrenamed_classes = [{ from = "DeploymentLock", to = "Lock" }]\n`, "do_migration_destructive:renamed_classes:v2"],
    [`\n[[migrations]]\ntag = "v2"\ntransferred_classes = [{ from = "A", from_script = "other", to = "B" }]\n`, "do_migration_destructive:transferred_classes:v2"],
  ];
  for (const [extra, reason] of cases) {
    const cf = fakeCloudflare({ [ORCH]: { bindings: activeFor(ORCH_TOML), migration_tag: "v1" } });
    const r = await eligibleAndRun(ORCH, ORCH_UNIT, ORCH_TOML, ORCH_TOML + extra, cf);
    assert.deepEqual(r.e, { eligible: false, reason, service: ORCH }, reason);
    assert.deepEqual(cf.log, [], `${reason}: no Cloudflare call`);
  }
  // An applied entry edited, or the history shortened.
  assert.deepEqual(topologyDiff(ORCH_TOML, edit(ORCH_TOML, 'tag = "v1"', 'tag = "v1b"'), ORCH), { reason: "do_migration_history_changed" });
  assert.deepEqual(topologyDiff(DO_TARGET, ORCH_TOML, ORCH), { reason: "do_migration_history_changed" });
  // A Worker with static assets never takes the Script Upload path.
  const cf = fakeCloudflare({ [ORCH]: { bindings: activeFor(ORCH_TOML), migration_tag: "v1" } });
  const { planTopology } = await import("../../deployment-orchestrator/src/topology.ts");
  assert.deepEqual(await planTopology(new CloudflareWorkers("deploy-token", ACCOUNT, cf.fetcher), ORCH, ORCH_TOML, DO_TARGET, { assets: true }), { reason: "do_migration_with_assets" });
});

// ================================================================ Workflows

const RETENTION = 'success_retention = "30 days"';
const WF_TARGET = edit(RECOVERY_TOML, RETENTION, 'success_retention = "14 days"');

test("G4B-6. a Workflow update is applied after the live check and read back; a new Workflow is created; an update is put back on failure", async () => {
  assert.equal(configRefusal(RECOVERY_TOML, WF_TARGET), "workflow_changed", "the G2c-2 plan alone refuses it");
  const live = { [LIFECYCLE]: { class_name: "RecoveryPlanWorkflow", script_name: RECOVERY } };
  const cf = fakeCloudflare({ [RECOVERY]: { bindings: activeFor(RECOVERY_TOML), crons: ["13 * * * *"] } }, { workflows: live });
  const { e, run } = await eligibleAndRun(RECOVERY, RECOVERY_UNIT, RECOVERY_TOML, WF_TARGET, cf);
  assert.ok(e.eligible, JSON.stringify(e));
  assert.deepEqual(e.services[0].config?.topology, [`workflow:update:${LIFECYCLE}`]);
  assert.deepEqual(e.services[0].config?.changes, { added: [], removed: [], changed: [], settings: [] }, "the Workflow binding itself is unchanged");
  assert.ok(run?.ok, JSON.stringify(run));
  assert.deepEqual(cf.writes(), [`POST workers/scripts/${RECOVERY}/versions`, `POST workers/scripts/${RECOVERY}/deployments`, `PUT workflows/${LIFECYCLE}`]);
  assert.deepEqual(cf.workflows.get(LIFECYCLE), { class_name: "RecoveryPlanWorkflow", script_name: RECOVERY, default_retention: { success_retention: "14 days", error_retention: "30 days" } });
  assert.deepEqual(run!.topology_applied, [`${RECOVERY}:workflow:${LIFECYCLE}`]);
  assert.ok(run!.steps.indexOf(`${RECOVERY}:verified`) < run!.steps.indexOf(`${RECOVERY}:workflow:${LIFECYCLE}_applied`));

  // A failure after the update puts the running definition back, then restores the deployment.
  const f = fakeCloudflare({ [RECOVERY]: { bindings: activeFor(RECOVERY_TOML) } }, { workflows: live });
  const rf = await eligibleAndRun(RECOVERY, RECOVERY_UNIT, RECOVERY_TOML, WF_TARGET, f, { registryFails: true });
  assert.deepEqual([rf.run!.ok, rf.run!.restored], [false, true]);
  assert.ok(rf.run!.steps.includes(`${RECOVERY}:workflow_restored:${LIFECYCLE}`));
  assert.deepEqual(f.workflows.get(LIFECYCLE), { class_name: "RecoveryPlanWorkflow", script_name: RECOVERY, default_retention: { success_retention: "30 days", error_retention: "30 days" } });

  // A new Workflow (live 404) is created; its binding is planned and verified like any binding.
  const NEW_WF = `\n[[workflows]]\nname = "cryptophys-recovery-drill"\nbinding = "RECOVERY_DRILL"\nclass_name = "RecoveryDrillWorkflow"\n`;
  const c = fakeCloudflare({ [RECOVERY]: { bindings: activeFor(RECOVERY_TOML) } }, { workflows: live });
  const rc = await eligibleAndRun(RECOVERY, RECOVERY_UNIT, RECOVERY_TOML, RECOVERY_TOML + NEW_WF, c);
  assert.ok(rc.run?.ok, JSON.stringify(rc.run ?? rc.e));
  assert.deepEqual(rc.e.eligible && rc.e.services[0].config?.topology, ["workflow:create:cryptophys-recovery-drill"]);
  assert.deepEqual(rc.e.eligible && rc.e.services[0].config?.changes.added, ["workflow:RECOVERY_DRILL"]);
  assert.deepEqual(c.workflows.get("cryptophys-recovery-drill"), { class_name: "RecoveryDrillWorkflow", script_name: RECOVERY });
  const sent = c.uploads[0].metadata.bindings.find((x: Binding) => x.name === "RECOVERY_DRILL");
  assert.deepEqual(sent, { type: "workflow", name: "RECOVERY_DRILL", workflow_name: "cryptophys-recovery-drill", class_name: "RecoveryDrillWorkflow" });

  // The live Workflow is not what the running config says: refused, nothing written.
  const d = fakeCloudflare({ [RECOVERY]: { bindings: activeFor(RECOVERY_TOML) } }, { workflows: { [LIFECYCLE]: { class_name: "SomethingElse", script_name: RECOVERY } } });
  const rd = await eligibleAndRun(RECOVERY, RECOVERY_UNIT, RECOVERY_TOML, WF_TARGET, d);
  assert.deepEqual(rd.e, { eligible: false, reason: `workflow_live_differs:${LIFECYCLE}`, service: RECOVERY });
  assert.deepEqual(d.writes(), []);
});

test("G4B-7. removing a Workflow, or one of another script, is refused before any Cloudflare call", async () => {
  const start = RECOVERY_TOML.indexOf("[[workflows]]");
  const end = RECOVERY_TOML.indexOf("error_retention", start);
  const without = RECOVERY_TOML.slice(0, start) + RECOVERY_TOML.slice(RECOVERY_TOML.indexOf("\n", end) + 1);
  const cf = fakeCloudflare({ [RECOVERY]: { bindings: activeFor(RECOVERY_TOML) } });
  const r = await eligibleAndRun(RECOVERY, RECOVERY_UNIT, RECOVERY_TOML, without, cf);
  assert.deepEqual(r.e, { eligible: false, reason: `workflow_removal_owner_run:${LIFECYCLE}`, service: RECOVERY });
  assert.deepEqual(cf.log, []);
  assert.deepEqual(topologyDiff(RECOVERY_TOML, edit(RECOVERY_TOML, 'class_name = "RecoveryPlanWorkflow"', 'class_name = "RecoveryPlanWorkflow"\nscript_name = "cryptophys-ai-kernel"'), RECOVERY),
    { reason: `workflow_other_script:${LIFECYCLE}` });
});

// ================================================================ no such change: unchanged

test("G4B-8. a unit with no route, Durable Object or Workflow change reads nothing new and deploys exactly as before", async () => {
  // Every committed config: no topology change against itself.
  for (const w of ["ai-kernel", "audit-ledger", "console", "deployment-orchestrator", "drift-detector", "forge", "platform-api", "platform-registry", "policy-engine", "recovery-manager"]) {
    const toml = read(`workers/${w}/wrangler.toml`);
    const d = topologyDiff(toml, toml, `cryptophys-${w}`);
    assert.ok("diff" in d && !d.diff.changed, w);
  }
  // A [vars] change of the Orchestrator (it has a custom domain and a Durable Object, both unchanged).
  const target = edit(ORCH_TOML, 'AI_DAILY_REQUEST_LIMIT = "80"', 'AI_DAILY_REQUEST_LIMIT = "70"');
  const cf = fakeCloudflare({ [ORCH]: { bindings: activeFor(ORCH_TOML), migration_tag: "v1" } }, { domains: [{ hostname: ORCH_HOST, service: ORCH }] });
  const { e, run, eligibilityReads } = await eligibleAndRun(ORCH, ORCH_UNIT, ORCH_TOML, target, cf);
  assert.ok(e.eligible && run?.ok, JSON.stringify(run ?? e));
  assert.equal(e.services[0].config?.topology, undefined);
  assert.deepEqual(eligibilityReads, [`GET workers/scripts/${ORCH}/deployments`, `GET workers/scripts/${ORCH}/versions/<id>`], "no domain, script list or Workflow read");
  assert.deepEqual(cf.log.filter((c) => /workers\/domains|workflows\/|^GET workers\/scripts$/.test(c)), []);
  assert.deepEqual(run!.steps, [
    `${ORCH}:captured`, `${ORCH}:planned`, `${ORCH}:uploaded`, `${ORCH}:bindings_match`, `${ORCH}:settings_match`, `${ORCH}:deployed`, `${ORCH}:verified`, "desired_recorded",
  ]);
  assert.equal(run!.topology_applied, undefined);
  assert.equal(run!.do_migrations, undefined);
  assert.deepEqual(cf.writes(), [`POST workers/scripts/${ORCH}/versions`, `POST workers/scripts/${ORCH}/deployments`]);
  // Code only (the same config): the G2b path, untouched.
  const same = fakeCloudflare({ [ORCH]: { bindings: activeFor(ORCH_TOML), migration_tag: "v1" } });
  const rs = await eligibleAndRun(ORCH, ORCH_UNIT, ORCH_TOML, ORCH_TOML, same);
  assert.ok(rs.run?.ok, JSON.stringify(rs.run ?? rs.e));
  assert.deepEqual(rs.eligibilityReads, []);
  assert.deepEqual(rs.run!.steps, [`${ORCH}:captured`, `${ORCH}:uploaded`, `${ORCH}:bindings_match`, `${ORCH}:deployed`, `${ORCH}:verified`, "desired_recorded"]);
});

// ================================================================ owner-click: the break-glass plan names destructive topology

const MIG_DIR = "workers/control-plane-migrations/";
const REPO_SQL: Record<string, string> = Object.fromEntries(readdirSync(new URL(MIG_DIR, ROOT)).filter((f) => f.endsWith(".sql")).sort().map((f) => [f, read(MIG_DIR + f)]));
const realFetch = globalThis.fetch;
const nextSafeMinute = (after: number): number => {
  const first = Math.ceil(after / 60_000) * 60_000;
  for (let i = 0; i < 60; i++) { const c = first + i * 60_000; if (SAFE_MINUTES.includes(new Date(c).getUTCMinutes())) return c; }
  throw new Error("no safe minute");
};
type Db = ReturnType<typeof migratedDb>;
function mainChecked(db: Db, sha: string, at = new Date().toISOString()) {
  const steps = JSON.stringify({ typecheck: { status: "passed", errors: 0, console_build: { status: "passed" } } });
  db.raw.prepare(`INSERT OR REPLACE INTO forge_check_runs (commit_sha, status, runner, files, pass, fail, skip, failures, started_at, finished_at, duration_ms, steps, guard_status, source)
    VALUES (?, 'passed', 'forge-runner/1', 1, 1, 0, 0, '[]', ?, ?, 1, ?, 'clean', 'main')`).run(sha, at, at, steps);
}
function lockNs() {
  const stores = new Map<string, Map<string, unknown>>();
  return { idFromName: (n: string) => n, get: (id: unknown) => {
    const key = String(id); if (!stores.has(key)) stores.set(key, new Map()); const data = stores.get(key)!;
    const lock = new DeploymentLock({ storage: { get: async (k: string) => data.get(k) as never, put: async (k: string, v: unknown) => { data.set(k, v); }, delete: async (k: string) => data.delete(k) }, blockConcurrencyWhile: (cb) => cb() });
    return { fetch: (i: RequestInfo | URL, init?: RequestInit) => lock.fetch(new Request(i, init)) };
  } };
}
/** main moved from OLD to NEW for the Orchestrator's unit; the planner is not involved (break-glass). */
async function bgSetup(service: string, runningToml: string, targetToml: string) {
  const db = migratedDb();
  db.raw.prepare("UPDATE service_registry SET desired_version = ?").run(OLD.slice(0, 12));
  const b = bucket();
  for (const [commit, toml] of [[OLD, runningToml], [NEW, targetToml]] as const) {
    await storeBundles(b, commit, [{ dir: `workers/${service.replace("cryptophys-", "")}`, text: moduleText(service, commit), toml, external: [] }], Date.now(), Object.keys(REPO_SQL),
      { migrationSql: REPO_SQL, externals: async () => new Map() });
  }
  mainChecked(db, OLD, new Date(Date.now() - 3_600_000).toISOString());
  mainChecked(db, NEW);
  return { db, b };
}
function orchestratorEnv(db: Db, b: Bucket, cf: Fake) {
  const reports: any[] = [];
  const env = baseEnv(ORCH, db, {
    GH_ACTIONS_TOKEN: "", DEPLOYMENT_LOCK: lockNs(), CF_DEPLOY_TOKEN: "deploy-token", CF_ACCOUNT_ID: ACCOUNT, BUNDLES: b,
    DRIFT: { probeService: async (svc: string) => {
      const s = cf.scripts.get(svc)!;
      return { reachable: true, healthy: true, version_tag: s.versions.get(s.active[0].version_id)!.tag ?? null, error: null };
    } },
    REGISTRY: { recordRollback: (id: string) => recordRollback({ DB: db } as never, id), recordNativeDeploy: (id: string) => recordNativeDeploy({ DB: db } as never, id) },
    AGENTS: { syscall: async (agent: string, _cap: string, input: any) => { reports.push({ agent, ...input }); return { outcome: "succeeded" }; } },
  });
  return { env, reports };
}
let k = 0;
/** An approved break-glass plan already executing (as the Recovery Manager's lifecycle leaves it), naming `topology`. */
function executingPlan(db: Db, service: string, topology?: string[], migrations?: string[]) {
  k++;
  const plan = `plan_${String(k).padStart(8, "0")}-6666-4666-8666-666666666666`;
  const dec = `dec_${String(k).padStart(8, "0")}-7777-4777-8777-777777777777`;
  const at = new Date().toISOString();
  const steps = { title: "Break glass", rationale: "destructive topology", steps: [{ action: "force_redeploy_unit", description: "Deploy the unit at main",
    ...(migrations ? { destructive_migrations: migrations } : {}), ...(topology ? { destructive_topology: topology } : {}) }] };
  db.raw.prepare(`INSERT INTO recovery_plans (plan_id, service_id, plan_version, status, steps_json, approved_by, last_execution_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'executing', ?, ?, ?, ?, ?, ?)`).run(plan, service, NEW, JSON.stringify(steps), APPROVER_EMAIL, JSON.stringify({ policy_decision_id: dec }), OPERATOR_EMAIL, at, at);
  db.raw.prepare(`INSERT INTO policy_decisions (decision_id, subject, action, resource, decision, reason, evidence_json, created_at) VALUES (?, 'ai:recovery-manager', 'recovery.execute', ?, 'allow', 'ok', '{}', ?)`).run(dec, plan, at);
  return { plan, dec };
}
const auditOf = (db: Db, prefix: string) => (db.raw.prepare("SELECT rowid, event_type, subject, payload_json FROM audit_events WHERE event_type LIKE ? ORDER BY rowid").all(`${prefix}%`) as any[])
  .map((r) => ({ rowid: Number(r.rowid), type: r.event_type as string, subject: r.subject as string, payload: JSON.parse(r.payload_json) }));
const status = (db: Db) => (db.raw.prepare("SELECT status, details_json FROM deployment_requests").all() as any[]).map((r) => ({ status: r.status as string, outcome: JSON.parse(r.details_json).outcome }));
async function withFetch<T>(cf: Fake, fn: () => Promise<T>): Promise<T> {
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => isAccessCerts(String(i)) ? accessCertsResponse() : cf.fetcher(i, init)) as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}
const WITHOUT_DOMAIN = edit(ORCH_TOML, ROUTES_LINE + "\n", "");
const REMOVAL = `custom_domain_removal:${ORCH_HOST}`;

test("G4B-9. a named custom domain removal is applied by the owner-approved break-glass deploy, audited before and after", async () => {
  const { db, b } = await bgSetup(ORCH, ORCH_TOML, WITHOUT_DOMAIN);
  const cf = fakeCloudflare({ [ORCH]: { bindings: activeFor(ORCH_TOML), migration_tag: "v1" } }, { domains: [{ hostname: ORCH_HOST, service: ORCH }] });
  const { env, reports } = orchestratorEnv(db, b, cf);
  const { plan, dec } = executingPlan(db, ORCH, [REMOVAL]);
  await withFetch(cf, async () => {
    const q = await forceDeployForRecovery(env as never, plan, dec, ORCH, NEW);
    assert.equal(q.dispatched, true, JSON.stringify(q));
    assert.deepEqual(auditOf(db, "deployment.break_glass_queued")[0].payload.destructive_topology, [REMOVAL]);
    assert.deepEqual(cf.writes(), [], "queueing writes nothing");
    assert.deepEqual(await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 1 });
  });
  assert.deepEqual(cf.domains, [], "the custom domain is detached");
  const [row] = status(db);
  assert.equal(row.status, "succeeded");
  assert.deepEqual(row.outcome.destructive_topology_applied, [REMOVAL]);
  assert.ok(row.outcome.steps.indexOf(`${ORCH}:verified`) < row.outcome.steps.indexOf(`${ORCH}:custom_domain_detach:${ORCH_HOST}_applied`), "after the live check");
  const applying = auditOf(db, "deployment.destructive_topology_applying");
  const applied = auditOf(db, "deployment.destructive_topology_applied");
  assert.deepEqual([applying.length, applied.length], [1, 1]);
  assert.deepEqual([applying[0].payload.item, applying[0].payload.restore_possible, applied[0].payload.item], [REMOVAL, true, REMOVAL]);
  assert.ok(applying[0].rowid < applied[0].rowid);
  assert.deepEqual(reports.map((r) => r.severity), ["warning"]);
  assert.deepEqual(reports[0].body.destructive_topology_applied, [REMOVAL]);
});

test("G4B-10. an unnamed destructive item is still refused with its reason; a named item the deploy does not contain refuses the deploy", async () => {
  // Unnamed: the plan names nothing (or something else).
  const { db, b } = await bgSetup(ORCH, ORCH_TOML, WITHOUT_DOMAIN);
  const cf = fakeCloudflare({ [ORCH]: { bindings: activeFor(ORCH_TOML), migration_tag: "v1" } }, { domains: [{ hostname: ORCH_HOST, service: ORCH }] });
  const { env } = orchestratorEnv(db, b, cf);
  for (const named of [undefined, ["workflow_removal:cryptophys-recovery-lifecycle"]]) {
    const { plan, dec } = executingPlan(db, ORCH, named);
    await withFetch(cf, async () => {
      await assert.rejects(forceDeployForRecovery(env as never, plan, dec, ORCH, NEW), new RegExp(`break_glass_refused: custom_domain_removal_owner_run:${ORCH_HOST.replace(/\./g, "\\.")}`));
    });
  }
  assert.deepEqual(cf.writes(), []);
  assert.equal(status(db).length, 0, "nothing queued");
  assert.deepEqual(auditOf(db, "deployment.break_glass_refused").map((e) => e.payload.reason), [`custom_domain_removal_owner_run:${ORCH_HOST}`, `custom_domain_removal_owner_run:${ORCH_HOST}`]);

  // Named but absent: main's change does not remove the domain (only a var changes), or the item names another one.
  const other = await bgSetup(ORCH, ORCH_TOML, edit(ORCH_TOML, 'AI_DAILY_REQUEST_LIMIT = "80"', 'AI_DAILY_REQUEST_LIMIT = "70"'));
  const cf2 = fakeCloudflare({ [ORCH]: { bindings: activeFor(ORCH_TOML), migration_tag: "v1" } }, { domains: [{ hostname: ORCH_HOST, service: ORCH }] });
  const o = orchestratorEnv(other.db, other.b, cf2);
  const absent = executingPlan(other.db, ORCH, [REMOVAL]);
  await withFetch(cf2, async () => {
    await assert.rejects(forceDeployForRecovery(o.env as never, absent.plan, absent.dec, ORCH, NEW), /break_glass_refused: named_topology_not_pending/);
  });
  const refused = auditOf(other.db, "deployment.break_glass_refused").at(-1)!.payload;
  assert.deepEqual([refused.reason, refused.item], ["named_topology_not_pending", REMOVAL]);
  assert.deepEqual(cf2.writes(), []);
  // The routine path never takes a name: the same removal is refused there whatever a plan says.
  assert.deepEqual(await nativeDeployEligible({ DB: db as never, BUNDLES: b }, ORCH_UNIT, NEW, new CloudflareWorkers("deploy-token", ACCOUNT, cf.fetcher)),
    { eligible: false, reason: `custom_domain_removal_owner_run:${ORCH_HOST}`, service: ORCH });
});

test("G4B-11. a named deleted Durable Object class: the restore-impossible audit comes first, then the Script Upload; the owner notice says so", async () => {
  const target = edit(edit(ORCH_TOML, '[[durable_objects.bindings]]\nname = "DEPLOYMENT_LOCK"\nclass_name = "DeploymentLock"\n', ""),
    'new_sqlite_classes = ["DeploymentLock"]\n', 'new_sqlite_classes = ["DeploymentLock"]\n\n[[migrations]]\ntag = "v2"\ndeleted_classes = ["DeploymentLock"]\n');
  const ITEM = `do_migration:deleted_classes:${ORCH}:v2`;
  const { db, b } = await bgSetup(ORCH, ORCH_TOML, target);
  let auditedBeforeUpload: boolean | null = null;
  const cf = fakeCloudflare({ [ORCH]: { bindings: activeFor(ORCH_TOML), migration_tag: "v1" } }, {
    domains: [{ hostname: ORCH_HOST, service: ORCH }],
    fail: (call) => {
      if (call === `PUT workers/scripts/${ORCH}`) auditedBeforeUpload = auditOf(db, "deployment.destructive_topology_irreversible").some((e) => e.payload.item === ITEM);
      return false;
    },
  });
  const { env, reports } = orchestratorEnv(db, b, cf);
  // Unnamed: refused with its reason, before any Cloudflare write.
  const unnamed = executingPlan(db, ORCH);
  await withFetch(cf, async () => {
    await assert.rejects(forceDeployForRecovery(env as never, unnamed.plan, unnamed.dec, ORCH, NEW), /break_glass_refused: do_migration_destructive:deleted_classes:v2/);
  });
  const { plan, dec } = executingPlan(db, ORCH, [ITEM]);
  await withFetch(cf, async () => {
    assert.equal((await forceDeployForRecovery(env as never, plan, dec, ORCH, NEW)).dispatched, true);
    assert.deepEqual(await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 1 });
  });
  assert.equal(auditedBeforeUpload, true, "the irreversible audit exists when the Script Upload is sent");
  const md = cf.uploads.find((u) => u.kind === "script")!.metadata;
  assert.deepEqual(md.migrations, { old_tag: "v1", new_tag: "v2", steps: [{ deleted_classes: ["DeploymentLock"] }] });
  assert.ok(!md.bindings.some((x: Binding) => x.name === "DEPLOYMENT_LOCK"), "the deleted class is no longer bound");
  assert.equal(cf.scripts.get(ORCH)!.migration_tag, "v2");
  const ev = auditOf(db, "deployment.destructive_topology_irreversible");
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].payload.item, ev[0].payload.restore_possible, ev[0].payload.irreversible], [ITEM, false, DO_IRREVERSIBLE]);
  const [row] = status(db);
  assert.deepEqual([row.status, row.outcome.destructive_topology_applied, row.outcome.do_migrations], ["succeeded", [ITEM], [`${ORCH}:v2`]]);
  assert.deepEqual(row.outcome.irreversible, [`${ITEM}: ${DO_IRREVERSIBLE}`]);
  // The owner notice (warning on success) carries it in its text and its fields.
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].body.irreversible, [`${ITEM}: ${DO_IRREVERSIBLE}`]);
  assert.match(reports[0].body.explanation, /Irreversible, whatever the outcome: .*refuses a rollback across a Durable Object class change/);
});

test("G4B-12. a named Workflow removal says its instances are lost; turning workers.dev off needs its name, turning previews on does not", async () => {
  const start = RECOVERY_TOML.indexOf("[[workflows]]");
  const end = RECOVERY_TOML.indexOf("error_retention", start);
  const without = RECOVERY_TOML.slice(0, start) + RECOVERY_TOML.slice(RECOVERY_TOML.indexOf("\n", end) + 1);
  const target = edit(without, "workers_dev = true", "workers_dev = false");
  const ITEMS = [`workflow_removal:${LIFECYCLE}`, `workers_dev_disable:${RECOVERY}`];
  assert.deepEqual(namedTopology(ITEMS), [...ITEMS].sort());
  // Unnamed: each keeps its own reason (the configs are read in a fixed order).
  assert.deepEqual(topologyDiff(RECOVERY_TOML, target, RECOVERY), { reason: `workers_dev_disable_owner_run:${RECOVERY}` });
  assert.deepEqual(topologyDiff(RECOVERY_TOML, target, RECOVERY, [ITEMS[1]]), { reason: `workflow_removal_owner_run:${LIFECYCLE}` });
  const d = topologyDiff(RECOVERY_TOML, target, RECOVERY, ITEMS);
  assert.ok("diff" in d && d.diff.destructive.join() === [...ITEMS].sort().join());

  const { db, b } = await bgSetup(RECOVERY, RECOVERY_TOML, target);
  const cf = fakeCloudflare({ [RECOVERY]: { bindings: activeFor(RECOVERY_TOML), subdomain: { enabled: true, previews_enabled: false } } },
    { workflows: { [LIFECYCLE]: { class_name: "RecoveryPlanWorkflow", script_name: RECOVERY } } });
  const { reports } = orchestratorEnv(db, b, cf);
  // The Recovery Manager deploys with the Control Plane unit: a plan for that unit needs every one of its Workers' bundles.
  const unit = unitForService(RECOVERY)!;
  const one = { ...unit, services: [RECOVERY] } as unknown as DeployUnit;
  const e = await nativeDeployEligible({ DB: db as never, BUNDLES: b }, one, NEW, new CloudflareWorkers("deploy-token", ACCOUNT, cf.fetcher), { destructiveTopology: ITEMS });
  assert.ok(e.eligible, JSON.stringify(e));
  assert.deepEqual(e.services[0].config?.destructive, [...ITEMS].sort());
  const run = await executeNativeDeploy(new CloudflareWorkers("deploy-token", ACCOUNT, cf.fetcher), executorEnv(cf, b, db).env, REQ, NEW, e.services, { delayMs: 0, destructiveTopology: ITEMS });
  assert.ok(run.ok, JSON.stringify(run));
  assert.equal(cf.workflows.has(LIFECYCLE), false, "deleted");
  assert.deepEqual(cf.scripts.get(RECOVERY)!.subdomain, { enabled: false, previews_enabled: false });
  assert.deepEqual(run.destructive_topology_applied, ITEMS, "in the order applied: the Workflow, then workers.dev");
  assert.deepEqual(run.irreversible, [`workflow_removal:${LIFECYCLE}: ${WORKFLOW_IRREVERSIBLE}`]);
  const ev = auditOf(db, "deployment.destructive_topology_irreversible");
  assert.deepEqual(ev.map((x) => [x.payload.item, x.payload.irreversible]), [[`workflow_removal:${LIFECYCLE}`, WORKFLOW_IRREVERSIBLE]]);
  assert.match(WORKFLOW_IRREVERSIBLE, /instances/);
  assert.deepEqual(auditOf(db, "deployment.destructive_topology_applying").map((x) => x.payload.item), [`workers_dev_disable:${RECOVERY}`]);
  assert.equal(reports.length, 0);

  // Turning previews on is additive: the routine deploy applies it after the live check and puts it back on failure.
  const on = edit(RECOVERY_TOML, "preview_urls = false", "preview_urls = true");
  const p = fakeCloudflare({ [RECOVERY]: { bindings: activeFor(RECOVERY_TOML), subdomain: { enabled: true, previews_enabled: false } } }, { workflows: { [LIFECYCLE]: { class_name: "RecoveryPlanWorkflow", script_name: RECOVERY } } });
  const rp = await eligibleAndRun(RECOVERY, RECOVERY_UNIT, RECOVERY_TOML, on, p);
  assert.ok(rp.run?.ok, JSON.stringify(rp.run ?? rp.e));
  assert.deepEqual(p.scripts.get(RECOVERY)!.subdomain, { enabled: true, previews_enabled: true });
  assert.deepEqual(rp.run!.topology_applied, [`${RECOVERY}:subdomain`]);
  const pf = fakeCloudflare({ [RECOVERY]: { bindings: activeFor(RECOVERY_TOML), subdomain: { enabled: true, previews_enabled: false } } });
  const rpf = await eligibleAndRun(RECOVERY, RECOVERY_UNIT, RECOVERY_TOML, on, pf, { registryFails: true });
  assert.deepEqual([rpf.run!.ok, rpf.run!.restored], [false, true]);
  assert.deepEqual(pf.scripts.get(RECOVERY)!.subdomain, { enabled: true, previews_enabled: false });
  // A key absent on one side stays routing_changed (wrangler's default depends on the routes).
  assert.equal(configRefusal(RECOVERY_TOML, edit(RECOVERY_TOML, "preview_urls = false\n", ""), { topology: true }), "routing_changed");
});

test("G4B-13. destructive_topology is validated: never from an agent or a service token, only on force_redeploy_unit, only known items, approved by another person", async () => {
  const db = migratedDb();
  const wf = fakeWorkflow();
  const env = { ...baseEnv(RECOVERY, db), APPROVER_IDENTITIES: `${OPERATOR_EMAIL},${APPROVER_EMAIL}`, RECOVERY_LIFECYCLE: wf.binding };
  const step = (extra: Record<string, unknown>) => ({ action: "force_redeploy_unit", description: "Deploy the Orchestrator at main", ...extra });
  const body = (steps: unknown[]) => ({ service_id: ORCH, plan_version: NEW, title: "Break glass", rationale: "remove the old domain", steps });
  // An agent (the Supervisor through RecoveryRpc.propose) cannot write it, with or without names.
  await assert.rejects(proposeFromAgent(env as never, "supervisor", body([step({ destructive_topology: [REMOVAL] })])), /break_glass_refused: force_redeploy_unit is owner-run/);
  assert.equal(breakGlassPlanProblem({ plan_version: NEW, created_by: "agent:supervisor", steps: [step({ destructive_topology: [REMOVAL] }) as never] }), "break_glass_person_author");
  assert.equal(breakGlassPlanProblem({ plan_version: NEW, created_by: "ci-client.access", steps: [step({ destructive_topology: [REMOVAL] }) as never] }), "break_glass_person_author");
  for (const [steps, msg] of [
    [[step({ destructive_topology: ["zone_route_removal:nexus.cryptophys.work/x*"] })], /destructive_topology must list/],
    [[step({ destructive_topology: [REMOVAL, REMOVAL] })], /destructive_topology (must list|lists an item twice)/],
    [[step({ destructive_topology: "custom_domain_removal:x.y" })], /destructive_topology must list/],
    [[{ action: "redeploy_commit", description: "a", destructive_topology: [REMOVAL] }], /only a force_redeploy_unit step may name destructive_topology/],
  ] as const) {
    const r = await call(recovery, env, req("POST", "/v1/plans", body(steps as unknown as unknown[]), OPERATOR_JWT));
    assert.ok(r.status === 400 || r.status === 403, JSON.stringify(r.body));
    assert.match(JSON.stringify(r.body), msg);
  }
  const ok = await call(recovery, env, req("POST", "/v1/plans", body([step({ destructive_topology: [`do_migration:deleted_classes:${ORCH}:v2`, REMOVAL] })]), OPERATOR_JWT));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.plan.plan.steps[0].destructive_topology, [`custom_domain_removal:${ORCH_HOST}`, `do_migration:deleted_classes:${ORCH}:v2`]);
  const stepsJson = JSON.stringify(ok.body.plan.plan);
  // The author cannot approve it; another person can, and then the names reach the Orchestrator.
  assert.deepEqual(approvedBreakGlassPlan({ plan_version: NEW, created_by: OPERATOR_EMAIL, approved_by: OPERATOR_EMAIL, steps_json: stepsJson }), { ok: false, reason: "break_glass_person_approver" });
  assert.deepEqual(approvedBreakGlassPlan({ plan_version: NEW, created_by: OPERATOR_EMAIL, approved_by: APPROVER_EMAIL, steps_json: stepsJson }),
    { ok: true, destructive_migrations: [], destructive_topology: [`custom_domain_removal:${ORCH_HOST}`, `do_migration:deleted_classes:${ORCH}:v2`] });
  // The rules stay the owner's: both files are guard paths.
  assert.equal(criticalPathReason("workers/control-plane-shared/src/break-glass.ts"), "break_glass");
  assert.equal(criticalPathReason("workers/deployment-orchestrator/src/recovery-deploy.ts"), "break_glass");
});
