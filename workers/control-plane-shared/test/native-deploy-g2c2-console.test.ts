// ADR-0012 G2c-2 (§5l), integration step 6: the Console's static assets on the native deploy path. The Forge keeps
// the Console build of a main commit (console-dist.ts); the Orchestrator deploys the Console natively only when that
// build is stored and matches, its [assets] table is unchanged, its index.html passes the deploy workflow's CSP check
// (no inline script) and the Nexus zone route is reported for the script (read only, with the deploy token). The
// assets are uploaded before the version (or kept with keep_assets when the running build is the same and the active
// version is the script's latest upload); a version of the Console never goes up without one of the two.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accessCertsResponse, baseEnv, forgeSees, isAccessCerts, migratedDb } from "./harness.ts";
import { unitForService } from "../src/deploy-units.ts";
import { storeBundles, type BuiltModule, type BundleBucket } from "../../forge/src/bundles.ts";
import { storeConsoleDist, validateConsoleDist } from "../../forge/src/console-dist.ts";
import { DeploymentLock, deployForConsensus, runNativeExecutors } from "../../deployment-orchestrator/src/index.ts";
import { CloudflareWorkers, KEEP_BINDINGS, SAFE_MINUTES } from "../../deployment-orchestrator/src/native-rollback.ts";
import { executeNativeDeploy, nativeDeployEligible, ZONE_ROUTES, zoneRouteRefusal, type PlannedService } from "../../deployment-orchestrator/src/native-deploy.ts";
import { AssetsUploader, indexHtmlRefusal } from "../../deployment-orchestrator/src/assets-upload.ts";
import { bindingsFromToml, parseToml } from "../../deployment-orchestrator/src/config-diff.ts";
import { recordNativeDeploy, recordRollback } from "../../platform-registry/src/index.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const API = "https://api.cloudflare.com/client/v4";
const ACCOUNT = "a".repeat(32);
const OLD = "0e".repeat(20);
const NEW = "4f".repeat(20);
const CONSOLE = unitForService("cryptophys-console")!;
const SVC = "cryptophys-console";
const NEXUS_ROUTE = "nexus.cryptophys.work/console*";
const SESSION = "eyJzZXNzaW9u.eyJ1cGxvYWQ.c2ln";
const DONE = "eyJjb21wbGV0ZQ.eyJkb25l.c2ln";
const realFetch = globalThis.fetch;
const enc = new TextEncoder();
const CONSOLE_TOML = read("workers/console/wrangler.toml");
const edit = (text: string, from: string, to: string) => { assert.ok(text.includes(from), from); return text.replace(from, to); };

/** The shape of the real Vite output (workers/console/ui/dist/index.html): external module script and stylesheet only. */
const INDEX = `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<title>Cerebrum · Console</title>
  <script type="module" crossorigin src="./assets/index-Be6iN7hk.js"></script>
  <link rel="stylesheet" crossorigin href="./assets/index-F2RAMB9p.css">
</head>
<body>
<div id="root"></div>
</body>
</html>
`;
const dist = (js: string, index = INDEX) => ({
  "index.html": { text: index, type: "text/html; charset=utf-8" },
  "assets/index-Be6iN7hk.js": { text: js, type: "text/javascript" },
  "assets/index-F2RAMB9p.css": { text: "body{background:#000}", type: "text/css" },
});

const nextSafeMinute = (after: number): number => {
  const first = Math.ceil(after / 60_000) * 60_000;
  for (let i = 0; i < 60; i++) {
    const candidate = first + i * 60_000;
    if (SAFE_MINUTES.includes(new Date(candidate).getUTCMinutes())) return candidate;
  }
  throw new Error("no safe minute found");
};

// ---------------------------------------------------------------- the Forge's bucket (R2), written by the Forge's own code
function bucket() {
  const objects = new Map<string, { value: string | Uint8Array; uploaded: Date }>();
  const b = {
    objects,
    async put(key: string, value: string | Uint8Array) { objects.set(key, { value, uploaded: new Date() }); return {}; },
    async get(key: string) {
      const o = objects.get(key);
      if (!o) return null;
      const bytes = typeof o.value === "string" ? enc.encode(o.value) : o.value;
      return { text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer };
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
async function storeCommit(b: Bucket, db: Db, commit: string, toml: string, files: ReturnType<typeof dist> | null) {
  const built: BuiltModule[] = [{ dir: "workers/console", text: `export default { fetch() { return new Response("console ${commit.slice(0, 12)}"); } };`, toml, external: [] }];
  await storeBundles(b, commit, built, Date.now(), ["0001_init.sql"]);
  if (!files) return;
  const valid = await validateConsoleDist({ commit, files: Object.entries(files).map(([path, f]) => ({ path, content_base64: Buffer.from(f.text).toString("base64"), content_type: f.type })) });
  await storeConsoleDist({ DB: db as never, BUNDLES: b }, valid, "service:ci");
}

// ---------------------------------------------------------------- a fake Workers API: scripts list, assets, versions, deployments
type Binding = { type: string; name: string; [k: string]: unknown };
interface Version { bindings: Binding[]; runtime: Record<string, unknown>; tag?: string; assets: { jwt?: string; config?: unknown; kept_from?: string } | null }
interface FakeOpts {
  /** The routes the script list reports for the Console: absent field (`undefined`), null, or a list. */
  routes?: Array<{ id: string; pattern: string; script?: string }> | null | "omit";
  /** Hashes Cloudflare already holds (no bucket asks for them). */
  held?: (hash: string) => boolean;
  /** Upload another version after the active one, never deployed. */
  newerUpload?: boolean;
  before?: (call: string, n: number) => void;
}
function activeBindings(): Binding[] {
  const declared = bindingsFromToml(parseToml(CONSOLE_TOML)!).bindings!.map((x) => x.type === "service" ? { ...x, environment: "production" } : { ...x });
  return [...declared,
    { type: "plain_text", name: "ACCESS_TEAM_DOMAIN", text: "team.cloudflareaccess.com" }, { type: "plain_text", name: "ACCESS_AUD", text: "aud-production" },
    { type: "plain_text", name: "OPERATOR_IDENTITIES", text: "ops@example.com" }, { type: "plain_text", name: "APPROVER_IDENTITIES", text: "owner@example.com" }];
}
function fakeCloudflare(opts: FakeOpts = {}) {
  let v = 0;
  const uuid = () => `${String(++v).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const first = uuid();
  const versions = new Map<string, Version>([[first, { bindings: activeBindings(), runtime: { compatibility_date: "2026-11-01", compatibility_flags: [] }, tag: OLD.slice(0, 12), assets: { jwt: "old.assets.jwt" } }]]);
  const order = [first];
  if (opts.newerUpload) { const id = uuid(); versions.set(id, { ...structuredClone(versions.get(first)!), tag: "ffffffffffff", assets: { jwt: "other.assets.jwt" } }); order.push(id); }
  const s = { active: [{ version_id: first, percentage: 100 }], versions, order };
  const log: string[] = [];
  const counts = new Map<string, number>();
  const uploads: any[] = [];
  const manifests: any[] = [];
  const parts: string[][] = [];
  const writes = () => log.filter((c) => /^(POST|PUT|PATCH) /.test(c));
  const routes = opts.routes === undefined ? [{ id: "r1", pattern: NEXUS_ROUTE, script: SVC }] : opts.routes;
  const fetcher = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    // The runtime's global fetch throws "Illegal invocation" unless it is called as a plain function.
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return (async () => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const auth = new Headers(init?.headers).get("authorization");
      const ok = (result: unknown, status = 200) => Response.json({ success: true, errors: [], result }, { status });
      let call: string;
      let rest = "";
      if (url === `${API}/accounts/${ACCOUNT}/workers/assets/upload?base64=true`) call = `${method} assets/upload`;
      else {
        const m = new RegExp(`^${API.replace(/\./g, "\\.")}/accounts/${ACCOUNT}/workers/scripts(?:/([a-z0-9-]+)/(.*))?$`).exec(url);
        assert.ok(m, `unexpected ${url}`);
        call = m[1] ? `${method} ${m[1]} ${m[2].replace(/[0-9a-f-]{36}/, "<id>")}` : `${method} scripts`;
        rest = m[2] ?? "";
        assert.ok(!m[1] || m[1] === SVC, url);
      }
      const n = (counts.get(call) ?? 0) + 1;
      counts.set(call, n);
      log.push(call);
      opts.before?.(call, n);
      if (call === "POST assets/upload") {
        assert.equal(auth, `Bearer ${SESSION}`, "bucket uploads carry the session JWT, never the deploy token");
        const form = init!.body as FormData;
        parts.push([...form.keys()]);
        return ok({ jwt: DONE }, 201);
      }
      assert.equal(auth, "Bearer deploy-token");
      if (call === "GET scripts") {
        const item: Record<string, unknown> = { id: SVC, has_assets: true };
        if (routes !== "omit") item.routes = routes;
        return ok([{ id: "cryptophys-platform-api", routes: [] }, item]);
      }
      if (rest === "assets-upload-session" && method === "POST") {
        const body = JSON.parse(String(init!.body));
        manifests.push(body.manifest);
        const missing = Object.values(body.manifest as Record<string, { hash: string }>).map((x) => x.hash).filter((h) => !opts.held?.(h));
        return ok({ jwt: SESSION, buckets: missing.length ? [missing] : [] });
      }
      if (rest === "deployments" && method === "GET") return ok({ deployments: [{ created_on: "2026-11-12T00:00:00Z", versions: s.active }] });
      if (rest === "deployments" && method === "POST") { s.active = JSON.parse(String(init!.body)).versions; return ok({ id: "dep" }); }
      if (rest === "versions?per_page=1") return ok({ items: [{ id: s.order.at(-1) }] });
      if (rest === "versions" && method === "POST") {
        const form = init!.body as FormData;
        const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
        uploads.push(metadata);
        const latest = s.versions.get(s.order.at(-1)!)!;
        const kept = latest.bindings.filter((x) => metadata.keep_bindings.includes(x.type));
        const sent = (metadata.bindings ?? []) as Binding[];
        const id = uuid();
        s.versions.set(id, {
          bindings: [...sent, ...kept.filter((k) => !sent.some((x) => x.name === k.name))],
          runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags ?? [] },
          tag: metadata.annotations["workers/tag"],
          assets: metadata.assets ? { ...metadata.assets } : metadata.keep_assets === true && latest.assets ? { ...latest.assets, kept_from: s.order.at(-1) } : null,
        });
        s.order.push(id);
        return ok({ id });
      }
      const vm = /^versions\/([0-9a-f-]{36})$/.exec(rest);
      if (vm && method === "GET") {
        const ver = s.versions.get(vm[1]);
        return ver ? ok({ id: vm[1], resources: { bindings: ver.bindings, script_runtime: ver.runtime } }) : Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
      }
      throw new Error(`unexpected ${method} ${url}`);
    })();
  } as typeof fetch;
  return { fetcher, log, uploads, manifests, parts, writes, s };
}
type Fake = ReturnType<typeof fakeCloudflare>;

// ---------------------------------------------------------------- D1, proposals, the Orchestrator's env
function lockNs() {
  const stores = new Map<string, Map<string, unknown>>();
  return { idFromName: (n: string) => n, get: (id: unknown) => {
    const key = String(id); if (!stores.has(key)) stores.set(key, new Map()); const data = stores.get(key)!;
    const lock = new DeploymentLock({ storage: { get: async (k: string) => data.get(k) as never, put: async (k: string, val: unknown) => { data.set(k, val); }, delete: async (k: string) => data.delete(k) }, blockConcurrencyWhile: (cb) => cb() });
    return { fetch: (i: RequestInfo | URL, init?: RequestInit) => lock.fetch(new Request(i, init)) };
  } };
}
let n = 0;
function passedProposal(db: Db): { proposal: string; decision: string } {
  n++;
  const proposal = `cns_${String(n).padStart(8, "0")}-7777-4777-8777-777777777777`;
  const decision = `dec_${String(n).padStart(8, "0")}-8888-4888-8888-888888888888`;
  const at = new Date().toISOString();
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES (?, 'supervisor', 'deploy_commit', ?, 'routine', ?, '{}', 'deploy', 8, 8, 0, 1, ?, 'allow', 'executing', NULL, ?, ?)`).run(proposal, SVC, JSON.stringify({ commit_sha: NEW }), decision, at, at);
  db.raw.prepare(`INSERT INTO policy_decisions (decision_id, subject, action, resource, decision, reason, evidence_json, created_at) VALUES (?, 'ai:kernel', 'consensus.execute', ?, 'allow', 'ok', '{}', ?)`)
    .run(decision, `deploy_commit:${SVC}`, at);
  return { proposal, decision };
}
async function freshDb(): Promise<Db> {
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  db.raw.prepare("UPDATE service_registry SET desired_version = ?").run(OLD.slice(0, 12));
  await forgeSees(db, { main: NEW, files: ["workers/console/src/index.ts", "workers/console/ui/src/App.tsx"], ready: true });
  return db;
}
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
/** Global fetch for the queue-time eligibility (the deploy token's reads) and, when given, GitHub's dispatch. */
function routeFetch(cf: Fake, github?: { dispatched: string[] }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (isAccessCerts(url)) return accessCertsResponse();
    if (url.startsWith("https://api.cloudflare.com/")) { const f = cf.fetcher; return f(input, init); }
    if (github && url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: NEW } });
    const m = /\/actions\/workflows\/([a-z-]+\.yml)\/dispatches$/.exec(url);
    if (github && m && init?.method === "POST") { github.dispatched.push(m[1]); return new Response(null, { status: 204 }); }
    throw new Error(`GitHub must not be called: ${url}`);
  }) as typeof fetch;
}
const desired = (db: Db) => (db.raw.prepare("SELECT desired_version FROM service_registry WHERE service_id = ?").get(SVC) as any).desired_version;
const requestRow = (db: Db) => db.raw.prepare("SELECT request_id, status, details_json FROM deployment_requests").get() as any;
const lastAudit = (db: Db, type: string) => JSON.parse((db.raw.prepare("SELECT payload_json FROM audit_events WHERE event_type = ? ORDER BY rowid DESC LIMIT 1").get(type) as any).payload_json);

async function queueAndRun(db: Db, b: Bucket, cf: Fake) {
  const { env, reports } = nativeEnv(db, b, cf.log);
  routeFetch(cf);
  const { proposal, decision } = passedProposal(db);
  const queued = await deployForConsensus(env as never, proposal, decision, SVC, { commit_sha: NEW });
  assert.equal(queued.executor, "native:deploy");
  const queueLog = cf.log.splice(0);
  const result = await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 });
  const row = requestRow(db);
  return { queueLog, result, row, outcome: JSON.parse(row.details_json).outcome, reports };
}

// ---------------------------------------------------------------- tests
test("G2c2C-1. the clients call fetch as a plain function; the index.html check is the workflow's, stricter; the route constant is the workflow's", async () => {
  // AssetsUploader (the regression #308 fixed in CloudflareWorkers): a global-style fetch called as a method throws.
  const seen: unknown[] = [];
  const strict = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    seen.push(this);
    if (this !== undefined) throw new TypeError("Illegal invocation");
    const url = String(input);
    if (url.endsWith("/assets-upload-session")) return Promise.resolve(Response.json({ success: true, result: { jwt: SESSION, buckets: [JSON.parse(String(init!.body)) && Object.values(JSON.parse(String(init!.body)).manifest).map((m: any) => m.hash)] } }));
    if (url.endsWith("/workers/assets/upload?base64=true")) return Promise.resolve(Response.json({ success: true, result: { jwt: DONE } }, { status: 201 }));
    if (url === `${API}/accounts/${ACCOUNT}/workers/scripts`) return Promise.resolve(Response.json({ success: true, result: [{ id: SVC, routes: [{ id: "r", pattern: NEXUS_ROUTE, script: SVC }] }] }));
    if (url.endsWith(`/scripts/${SVC}/versions?per_page=1`)) return Promise.resolve(Response.json({ success: true, result: { items: [{ id: "00000001-0000-4000-8000-000000000000" }] } }));
    return Promise.reject(new Error(`unexpected ${url}`));
  } as typeof fetch;
  const files = { "index.html": { text: INDEX, contentType: "text/html" } };
  assert.equal((await new AssetsUploader("t", ACCOUNT, strict).upload(SVC, files)).jwt, DONE);
  const cf = new CloudflareWorkers("t", ACCOUNT, strict);
  assert.equal((await cf.assetsUploader().upload(SVC, files)).jwt, DONE);
  assert.deepEqual(await cf.scriptRoutes(SVC), [{ pattern: NEXUS_ROUTE, script: SVC }]);
  assert.equal(await cf.latestVersionId(SVC), "00000001-0000-4000-8000-000000000000");
  assert.ok(seen.length >= 6 && seen.every((x) => x === undefined), "every call made as a plain function");

  // index.html: the real Vite output passes; the workflow's grep cases and the stricter ones refuse.
  assert.equal(indexHtmlRefusal(INDEX), null);
  assert.equal(indexHtmlRefusal(`<script type="module" src="/a.js">\n</script>`), null, "whitespace inside an external script is no inline script");
  for (const [html, reason] of [
    ["<head><script>alert(1)</script></head>", "inline_script"],
    [`<script type="module">import "./a.js"</script>`, "inline_script"],
    [`<SCRIPT type="module">\nimport "./a.js"\n</SCRIPT>`, "inline_script"],
    [`<script type="module" src="/a.js">x</script>`, "inline_script"],
    [`<script type="module" src="/a.js">`, "inline_script"],
    [`<script data-src="/a.js"></script>`, "inline_script"],
    [`<img src="x" onerror="alert(1)">`, "inline_event_handler"],
    [`<a href="javascript:alert(1)">x</a>`, "inline_script"],
  ] as const) assert.equal(indexHtmlRefusal(html), reason, html);

  // The route the native path verifies is exactly the one deploy-console.yml attaches (it never attaches one itself).
  const wf = read(".github/workflows/deploy-console.yml");
  assert.match(wf, new RegExp(`ROUTE_PATTERN: ${NEXUS_ROUTE.replace(/[.*]/g, "\\$&")}\\n\\s+SCRIPT: ${SVC}\\n`));
  assert.deepEqual(ZONE_ROUTES, { [SVC]: [NEXUS_ROUTE] });
  assert.match(wf, /grep -Eq '<script>\|<script \[\^>\]\*>\[\^<\]' dist\/index\.html/, "the workflow check indexHtmlRefusal repeats");
  // The route check is fail closed: unreadable, not reported, or another script.
  assert.equal(await zoneRouteRefusal({ scriptRoutes: async () => { throw new Error("cloudflare_api_403_10000"); } }, SVC), "route_unverifiable");
  assert.equal(await zoneRouteRefusal({ scriptRoutes: async () => null }, SVC), "route_unverifiable");
  assert.equal(await zoneRouteRefusal({}, SVC), "route_unverifiable");
  assert.equal(await zoneRouteRefusal({ scriptRoutes: async () => [{ pattern: NEXUS_ROUTE, script: "cryptophys-home" }] }, SVC), `route_missing:${NEXUS_ROUTE}`);
  assert.equal(await zoneRouteRefusal({ scriptRoutes: async () => [{ pattern: NEXUS_ROUTE, script: null }] }, SVC), null);
});

test("G2c2C-2. the Console deploys natively: assets uploaded before the version, sent as assets metadata; unchanged assets are kept", async () => {
  const db = await freshDb();
  try {
    // 1. The UI changed: the running commit's stored build differs, so every file Cloudflare asks for is uploaded.
    const b = bucket();
    await storeCommit(b, db, OLD, CONSOLE_TOML, dist("console.log('old')"));
    await storeCommit(b, db, NEW, CONSOLE_TOML, dist("console.log('new')"));
    const cf = fakeCloudflare({ held: () => false });
    const { queueLog, result, row, outcome, reports } = await queueAndRun(db, b, cf);
    assert.deepEqual(result, { executed: 1, succeeded: 1 });
    assert.deepEqual(queueLog, ["GET scripts"], "queueing read only the script list (the route); the config is unchanged");
    const queued = lastAudit(db, "deployment.native_deploy_queued");
    assert.deepEqual(queued.assets, { [SVC]: { mode: "upload", running_dist: "different", files: 3, total_bytes: queued.assets[SVC].total_bytes } });
    assert.deepEqual(cf.log, [
      "GET scripts", // eligibility again at execution
      `GET ${SVC} deployments`, `GET ${SVC} versions/<id>`, // capture; the active binding set
      "GET scripts", `POST ${SVC} assets-upload-session`, "POST assets/upload", // the route again, then the assets first
      `POST ${SVC} versions`, `GET ${SVC} versions/<id>`, `POST ${SVC} deployments`, `probe ${SVC}`,
    ]);
    assert.deepEqual(Object.keys(cf.manifests[0]).sort(), ["/assets/index-Be6iN7hk.js", "/assets/index-F2RAMB9p.css", "/index.html"]);
    assert.equal(cf.parts[0].length, 3);
    const md = cf.uploads[0];
    assert.deepEqual(md.assets, { jwt: DONE, config: { not_found_handling: "single-page-application", run_worker_first: true } }, "the completion token and the [assets] routing config");
    assert.equal("keep_assets" in md, false);
    assert.deepEqual(md.bindings, [{ type: "assets", name: "ASSETS" }]);
    assert.deepEqual(md.keep_bindings, [...KEEP_BINDINGS]);
    const live = cf.s.versions.get(cf.s.active[0].version_id)!;
    assert.deepEqual([live.tag, live.assets?.jwt], [NEW.slice(0, 12), DONE]);
    assert.equal(row.status, "succeeded");
    assert.deepEqual(outcome.steps, [`${SVC}:captured`, `${SVC}:route_verified`, `${SVC}:assets_uploaded`, `${SVC}:uploaded`, `${SVC}:bindings_match`, `${SVC}:deployed`, `${SVC}:verified`, "desired_recorded"]);
    assert.deepEqual(outcome.assets, { [SVC]: { mode: "upload", uploaded: 3, buckets: 1 } });
    assert.equal(desired(db), NEW.slice(0, 12));
    assert.equal(reports.length, 0);

    // 2. The UI did not change (the same stored build): keep_assets is never used, because it is not verified
    //    that it keeps run_worker_first. The build is uploaded again with its config sent explicitly; Cloudflare
    //    already holds every file, so no bucket is sent.
    reset(db);
    const same = bucket();
    await storeCommit(same, db, OLD, CONSOLE_TOML, dist("console.log('same')"));
    await storeCommit(same, db, NEW, CONSOLE_TOML, dist("console.log('same')"));
    const kcf = fakeCloudflare({ held: () => true });
    const kept = await queueAndRun(db, same, kcf);
    assert.deepEqual(kept.result, { executed: 1, succeeded: 1 });
    assert.equal("keep_assets" in kcf.uploads[0], false, "keep_assets is never sent");
    assert.deepEqual(kcf.uploads[0].assets, { jwt: SESSION, config: { not_found_handling: "single-page-application", run_worker_first: true } }, "run_worker_first is sent explicitly");
    assert.deepEqual(kept.outcome.assets, { [SVC]: { mode: "upload", uploaded: 0, buckets: 0, keep_refused: "run_worker_first_unverified" } });
    assert.ok(kept.outcome.steps.includes(`${SVC}:assets_uploaded`));
    assert.equal(kept.outcome.steps.includes(`${SVC}:assets_kept`), false);

    // 4. A configuration change of the Console (a new var): the planned bindings carry the assets binding, and the
    //    assets still go first.
    reset(db);
    const cfg = bucket();
    const target = edit(CONSOLE_TOML, 'API_CONTRACT_VERSION = "v1"\n', 'API_CONTRACT_VERSION = "v1"\nNATIVE_CONSOLE_PROBE = "on"\n');
    await storeCommit(cfg, db, OLD, CONSOLE_TOML, dist("console.log('old')"));
    await storeCommit(cfg, db, NEW, target, dist("console.log('new')"));
    const pcf = fakeCloudflare({ held: () => false });
    const planned = await queueAndRun(db, cfg, pcf);
    assert.deepEqual(planned.result, { executed: 1, succeeded: 1 });
    const pmd = pcf.uploads[0];
    assert.deepEqual(pmd.keep_bindings, ["secret_text", "secret_key"]);
    assert.ok(pmd.bindings.some((x: Binding) => x.type === "assets" && x.name === "ASSETS"), "the assets binding is part of the plan");
    assert.ok(pmd.bindings.some((x: Binding) => x.name === "NATIVE_CONSOLE_PROBE" && x.text === "on"));
    assert.equal(pmd.assets.jwt, DONE);
    assert.ok(pcf.log.indexOf("POST assets/upload") < pcf.log.indexOf(`POST ${SVC} versions`));
    assert.deepEqual(planned.outcome.steps.slice(0, 4), [`${SVC}:captured`, `${SVC}:planned`, `${SVC}:route_verified`, `${SVC}:assets_uploaded`]);
  } finally { globalThis.fetch = realFetch; }
});

test("G2c2C-3. every Console refusal keeps the GitHub workflow, with its reason in the native_deploy audit payload", async () => {
  const db = await freshDb();
  const html = (commit: string) => `bundles/${commit}/console-dist/index.html`;
  type Case = { label: string; toml?: string; files?: ReturnType<typeof dist> | null; arrange?: (b: Bucket) => void; cf?: FakeOpts; expect: Record<string, string>; reads: string[] };
  const cases: Case[] = [
    { label: "no stored Console build", files: null, expect: { reason: "console_dist_missing", service: SVC, file: `bundles/${NEW}/console-dist.json` }, reads: [] },
    { label: "a stored file that does not match its sha256", arrange: (b) => { b.objects.get(`bundles/${NEW}/console-dist/assets/index-F2RAMB9p.css`)!.value = "body{background:#fff}"; },
      expect: { reason: "console_dist_hash_mismatch", service: SVC, file: `bundles/${NEW}/console-dist/assets/index-F2RAMB9p.css` }, reads: [] },
    { label: "a stored file missing", arrange: (b) => { b.objects.delete(`bundles/${NEW}/console-dist/assets/index-Be6iN7hk.js`); },
      expect: { reason: "console_dist_missing", service: SVC, file: `bundles/${NEW}/console-dist/assets/index-Be6iN7hk.js` }, reads: [] },
    { label: "an inline script in index.html (CSP script-src 'self')", files: dist("x", INDEX.replace("</head>", "<script>window.boot=1</script>\n</head>")),
      expect: { reason: "inline_script", service: SVC, file: html(NEW) }, reads: [] },
    { label: "an [assets] change", toml: edit(CONSOLE_TOML, "run_worker_first = true", "run_worker_first = false"), expect: { reason: "assets_config_changed", service: SVC }, reads: [] },
    { label: "the script list does not report routes", cf: { routes: "omit" }, expect: { reason: "route_unverifiable", service: SVC }, reads: ["GET scripts"] },
    { label: "the script list reports routes without the Nexus route", cf: { routes: [{ id: "r2", pattern: "console.cryptophys.work/*", script: SVC }] },
      expect: { reason: `route_missing:${NEXUS_ROUTE}`, service: SVC }, reads: ["GET scripts"] },
  ];
  try {
    for (const c of cases) {
      reset(db);
      const b = bucket();
      await storeCommit(b, db, OLD, CONSOLE_TOML, dist("console.log('old')"));
      await storeCommit(b, db, NEW, c.toml ?? CONSOLE_TOML, c.files === undefined ? dist("console.log('new')") : c.files);
      c.arrange?.(b);
      const cf = fakeCloudflare(c.cf);
      const github = { dispatched: [] as string[] };
      routeFetch(cf, github);
      const { env } = nativeEnv(db, b, cf.log, { GH_ACTIONS_TOKEN: "gh" });
      const { proposal, decision } = passedProposal(db);
      const r = await deployForConsensus(env as never, proposal, decision, SVC, { commit_sha: NEW });
      assert.equal(r.workflow, "deploy-console.yml", c.label);
      assert.deepEqual(github.dispatched, ["deploy-console.yml"], c.label);
      const ev = lastAudit(db, "deployment.dispatched");
      assert.equal(ev.request_id, r.request_id, c.label);
      assert.deepEqual(ev.native_deploy, c.expect, c.label);
      assert.deepEqual(cf.log, c.reads, `${c.label}: Cloudflare reads`);
      assert.deepEqual(cf.writes(), [], `${c.label}: nothing written to Cloudflare`);
    }
    // Without a reader that can list routes (the G2b and G2c-1 callers), the Console keeps the G2b answer.
    const b = bucket();
    await storeCommit(b, db, OLD, CONSOLE_TOML, dist("a"));
    await storeCommit(b, db, NEW, CONSOLE_TOML, dist("b"));
    assert.deepEqual(await nativeDeployEligible({ DB: db as never, BUNDLES: b }, CONSOLE, NEW), { eligible: false, reason: "assets", service: SVC });
  } finally { globalThis.fetch = realFetch; }
});

test("G2c2C-4. a version of the Console never goes up without its assets; a route gone at execution stops before any upload", async () => {
  const db = await freshDb();
  try {
    const b = bucket();
    await storeCommit(b, db, OLD, CONSOLE_TOML, dist("console.log('old')"));
    await storeCommit(b, db, NEW, CONSOLE_TOML, dist("console.log('new')"));
    // The executor given a plan without the assets decision refuses before any write.
    const e = await nativeDeployEligible({ DB: db as never, BUNDLES: b }, CONSOLE, NEW, new CloudflareWorkers("deploy-token", ACCOUNT, fakeCloudflare().fetcher));
    assert.ok(e.eligible);
    const cf = fakeCloudflare();
    const withoutAssets: PlannedService[] = e.services.map(({ assets: _drop, ...rest }) => rest);
    const log: string[] = [];
    const run = await executeNativeDeploy(new CloudflareWorkers("deploy-token", ACCOUNT, cf.fetcher), {
      DRIFT: { probeService: async () => { log.push("probe"); return { reachable: true, healthy: true, version_tag: NEW.slice(0, 12), error: null }; } },
      REGISTRY: { recordRollback: async () => ({ desired_version: "" }) }, BUNDLES: b, DB: db as never,
    }, "dep_00000000-0000-4000-8000-000000000000", NEW, withoutAssets, { delayMs: 0 });
    assert.deepEqual([run.ok, run.reason, run.production_changed], [false, "assets_upload_missing", false]);
    assert.deepEqual(cf.writes(), [], "no version, no deployment");
    // The client refuses a version that both keeps and sends assets, and a planned config without the assets binding.
    const client = new CloudflareWorkers("deploy-token", ACCOUNT, cf.fetcher);
    const md = { main_module: "cryptophys-console.mjs", compatibility_date: "2026-11-01", compatibility_flags: [], tag: NEW.slice(0, 12), message: "m" };
    await assert.rejects(client.uploadVersion(SVC, "cryptophys-console.mjs", "x", { ...md, assets: { keep: true, binding: "ASSETS", jwt: DONE } as never }), /invalid_assets_upload/);
    await assert.rejects(client.uploadVersion(SVC, "cryptophys-console.mjs", "x", { ...md, assets: { jwt: "not a jwt", config: {}, binding: "ASSETS" } }), /assets_jwt_invalid/);
    await assert.rejects(client.uploadVersion(SVC, "cryptophys-console.mjs", "x", { ...md, config: { bindings: [], keep_bindings: ["secret_text"] }, assets: { keep: true, binding: "ASSETS" } }), /invalid_assets_upload/);
    assert.deepEqual(cf.writes(), []);

    // The route disappears between the executor's eligibility check and its capture: the check right before the
    // assets refuses, and nothing is uploaded.
    reset(db);
    let routesGone = false;
    const rcf = fakeCloudflare({ held: () => false, before: (call, k) => { if (call === "GET scripts" && k === 3) routesGone = true; } });
    const routes = [{ id: "r1", pattern: NEXUS_ROUTE, script: SVC }];
    const original = rcf.fetcher;
    const gone = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await original(input, init);
      if (!routesGone || String(input) !== `${API}/accounts/${ACCOUNT}/workers/scripts`) return res;
      return Response.json({ success: true, result: [{ id: SVC, routes: routes.filter((r) => r.pattern !== NEXUS_ROUTE) }] });
    }) as typeof fetch;
    const { result, row, outcome, reports } = await queueAndRun(db, b, { ...rcf, fetcher: gone });
    assert.deepEqual(result, { executed: 1, succeeded: 0 });
    assert.equal(row.status, "failed");
    assert.equal(outcome.reason, `route_missing:${NEXUS_ROUTE}`);
    assert.deepEqual(rcf.writes(), [], "no assets session, no version, no deployment");
    assert.deepEqual([outcome.production_changed, outcome.restored], [false, true]);
    assert.equal(desired(db), OLD.slice(0, 12));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].body.reason, `route_missing:${NEXUS_ROUTE}`);
  } finally { globalThis.fetch = realFetch; }
});
