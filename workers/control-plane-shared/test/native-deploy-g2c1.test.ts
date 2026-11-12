// ADR-0012 G2c-1: the native deploy (G2b) also applies additive D1 migrations, uploads multi-module Workers, and
// carries recovery redeploys, all from the Forge's bundles. Anything it cannot prove stays on the GitHub workflow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { APPROVER_EMAIL, APPROVER_JWT, OPERATOR_EMAIL, accessCertsResponse, baseEnv, call, fakeWorkflow, forgeSees, isAccessCerts, migratedDb, req } from "./harness.ts";
import { DEPLOY_UNITS, unitForService } from "../src/deploy-units.ts";
import { DESTRUCTIVE_SQL, destructiveMigration, splitSqlStatements, sqlWithoutComments, stripSqlComments, unsupportedStatement } from "../src/migration-rules.ts";
import { storeBundles, renameImports, moduleTypeOf, type BuiltModule, type BundleBucket } from "../../forge/src/bundles.ts";
import { lockfileSource, lockLocation, untar, type ExternalSource } from "../../forge/src/externals.ts";
import { DeploymentLock, deployForConsensus, deployForRecovery, requestStatus, runNativeExecutors, runStatus } from "../../deployment-orchestrator/src/index.ts";
import { SAFE_MINUTES } from "../../deployment-orchestrator/src/native-rollback.ts";
import { nativeDeployEligible } from "../../deployment-orchestrator/src/native-deploy.ts";
import { recordNativeDeploy, recordRollback } from "../../platform-registry/src/index.ts";
import recovery from "../../recovery-manager/src/index.ts";
import { runLifecycle } from "../../recovery-manager/src/lifecycle.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const ACCOUNT = "a".repeat(32);
const OLD = "0a".repeat(20);
const NEW = "1b".repeat(20);
const CONTROL_PLANE = unitForService("cryptophys-policy-engine")!;
const CONSOLE = unitForService("cryptophys-console")!;
const realFetch = globalThis.fetch;
const enc = new TextEncoder();

// The repository's migrations: the running version has all of them, and the harness ledger lists all of them.
const MIG_DIR = "workers/control-plane-migrations/";
const REPO_MIGRATIONS = readdirSync(new URL(MIG_DIR, ROOT)).filter((f) => f.endsWith(".sql")).sort();
const REPO_SQL: Record<string, string> = Object.fromEntries(REPO_MIGRATIONS.map((f) => [f, read(MIG_DIR + f)]));
const ADDITIVE = { "0099_g2c1_probe.sql": "-- G2c-1 probe\nCREATE TABLE g2c1_probe (id TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT 'a;b');\nCREATE INDEX idx_g2c1_probe_note ON g2c1_probe(note);\n" };

const nextSafeMinute = (after: number): number => {
  const first = Math.ceil(after / 60_000) * 60_000;
  for (let i = 0; i < 60; i++) {
    const candidate = first + i * 60_000;
    if (SAFE_MINUTES.includes(new Date(candidate).getUTCMinutes())) return candidate;
  }
  throw new Error("no safe minute found");
};

// ---------------------------------------------------------------- the Forge's bundles (R2, text and bytes)
function bucket() {
  const objects = new Map<string, { value: string | Uint8Array; uploaded: Date; type?: string }>();
  const b = {
    objects,
    async put(key: string, value: string | Uint8Array, options?: { httpMetadata?: { contentType?: string } }) { objects.set(key, { value, uploaded: new Date(), type: options?.httpMetadata?.contentType }); return {}; },
    async get(key: string) {
      const o = objects.get(key);
      if (!o) return null;
      const bytes = typeof o.value === "string" ? enc.encode(o.value) : o.value;
      return { text: async () => typeof o.value === "string" ? o.value : new TextDecoder().decode(o.value), arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer };
    },
    async list({ prefix = "", cursor, limit = 1000 }: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      return { objects: page.map((key) => ({ key, uploaded: objects.get(key)!.uploaded })), truncated: start + limit < keys.length, cursor: String(start + limit) };
    },
    async delete(keys: string | string[]) { for (const k of [keys].flat()) objects.delete(k); },
  };
  return b satisfies BundleBucket;
}
type Bucket = ReturnType<typeof bucket>;

const toml = (name: string, extra = "") => `name = "${name}"\nmain = "src/worker.ts"\ncompatibility_date = "2026-11-01"\ncompatibility_flags = ["nodejs_compat"]\n${extra}`;
const moduleText = (name: string, commit: string) => `export default { fetch() { return new Response("${name} ${commit.slice(0, 12)}"); } };`;

// A multi-module console: WebAssembly, a Text rule, a Data rule and an ES module, imported as a bundle would.
const RULES = `[[rules]]\ntype = "Text"\nglobs = ["**/*.txt"]\nfallthrough = true\n\n[[rules]]\ntype = "Data"\nglobs = ["**/*.bin"]\n`;
const EXT = {
  "workers/console/node_modules/pkg/engine.wasm": new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
  "workers/console/node_modules/pkg/notes.txt": enc.encode("text module\n"),
  "workers/console/node_modules/pkg/blob.bin": new Uint8Array([1, 2, 3, 250, 251]),
  "workers/console/node_modules/pkg/lib.js": enc.encode("export const answer = 42;\n"),
};
const SPEC = (p: string) => "../../" + p.slice("workers/".length);
const multiText = (commit: string) => [
  `import engine from ${JSON.stringify(SPEC("workers/console/node_modules/pkg/engine.wasm"))};`,
  `import notes from ${JSON.stringify(SPEC("workers/console/node_modules/pkg/notes.txt"))};`,
  `import blob from ${JSON.stringify(SPEC("workers/console/node_modules/pkg/blob.bin"))};`,
  `import { answer } from ${JSON.stringify(SPEC("workers/console/node_modules/pkg/lib.js"))};`,
  // A template literal that looks like an import (the Forge's runner entry has these) is not an import.
  "const entry = `\nimport wasm from \"./sql-wasm.wasm\";\n`;",
  `export default { fetch() { return new Response("console ${commit.slice(0, 12)} " + [engine, notes, blob, answer, entry].length); } };`,
].join("\n");
const externals = (files: Record<string, Uint8Array>): ExternalSource => async (paths) => new Map(paths.filter((p) => files[p]).map((p) => [p, files[p]]));

type Tweak = { toml?: string; omit?: boolean; multi?: boolean };
async function bundlesFor(b: Bucket, commit: string, opts: { tweaks?: Record<string, Tweak>; sql?: Record<string, string> | "names-only"; files?: Record<string, Uint8Array> } = {}) {
  const built: BuiltModule[] = [];
  for (const u of DEPLOY_UNITS) for (const name of u.services) {
    const t = opts.tweaks?.[name] ?? {};
    if (t.omit) continue;
    const dir = `workers/${name.replace("cryptophys-", "")}`;
    if (t.multi) {
      const paths = Object.keys(EXT).sort();
      built.push({ dir, text: multiText(commit), toml: toml(name, RULES + (t.toml ?? "")), external: paths, specifiers: Object.fromEntries(paths.map((p) => [p, [SPEC(p)]])) });
    } else {
      built.push({ dir, text: moduleText(name, commit), toml: toml(name, t.toml ?? ""), external: [] });
    }
  }
  const sql = opts.sql === "names-only" ? null : opts.sql ?? REPO_SQL;
  const names = opts.sql === "names-only" ? REPO_MIGRATIONS : Object.keys(sql!);
  await storeBundles(b, commit, built, Date.now(), names, { ...(sql ? { migrationSql: sql } : {}), externals: externals(opts.files ?? EXT) });
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
  const proposal = `cns_${String(n).padStart(8, "0")}-3333-4333-8333-333333333333`;
  const decision = `dec_${String(n).padStart(8, "0")}-4444-4444-8444-444444444444`;
  const at = new Date().toISOString();
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES (?, 'supervisor', 'deploy_commit', ?, 'routine', ?, '{}', 'deploy', 8, 8, 0, 1, ?, 'allow', 'executing', NULL, ?, ?)`).run(proposal, target, JSON.stringify({ commit_sha: NEW }), decision, at, at);
  db.raw.prepare(`INSERT INTO policy_decisions (decision_id, subject, action, resource, decision, reason, evidence_json, created_at) VALUES (?, 'ai:kernel', 'consensus.execute', ?, 'allow', 'ok', '{}', ?)`)
    .run(decision, `deploy_commit:${target}`, at);
  return { proposal, decision };
}
async function scenario(files: string[] = ["workers/console/src/index.ts", "workers/policy-engine/src/index.ts"]) {
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  db.raw.prepare("UPDATE service_registry SET desired_version = ?").run(OLD.slice(0, 12));
  await forgeSees(db, { main: NEW, files, ready: true });
  const b = bucket();
  return { db, b };
}

// ---------------------------------------------------------------- a fake Workers Versions/Deployments API (every multipart part)
const BINDINGS = [
  { type: "d1", name: "DB", id: "db-uuid" },
  { type: "secret_text", name: "ACCESS_GROUPS_TOKEN" },
  { type: "service", name: "AGENTS", service: "cryptophys-ai-kernel", entrypoint: "AgentRpc", props: { host_worker: "x" } },
  { type: "version_metadata", name: "CF_VERSION_METADATA" },
];
type Part = { field: string; filename: string; type: string; bytes: Uint8Array };
function fakeCloudflare(services: string[], observe: () => unknown = () => null) {
  const scripts = new Map<string, { active: { version_id: string; percentage: number }[]; versions: Map<string, { bindings: unknown[]; tag?: string }> }>();
  let v = 0;
  const uuid = () => `${String(++v).padStart(8, "0")}-0000-4000-8000-000000000000`;
  for (const s of services) { const id = uuid(); scripts.set(s, { active: [{ version_id: id, percentage: 100 }], versions: new Map([[id, { bindings: structuredClone(BINDINGS) }]]) }); }
  const calls: { call: string; seen: unknown }[] = [];
  const uploads: { script: string; metadata: any; parts: Part[] }[] = [];
  const deployments: { script: string; body: any }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const m = new RegExp(`^https://api\\.cloudflare\\.com/client/v4/accounts/${ACCOUNT}/workers/scripts/([a-z0-9-]+)/(.*)$`).exec(url);
    assert.ok(m, `unexpected ${url}`);
    const [, script, rest] = m!;
    const s = scripts.get(script);
    assert.ok(s, `unknown script ${script}`);
    const method = init?.method ?? "GET";
    calls.push({ call: `${method} ${script} ${rest.replace(/[0-9a-f-]{36}/, "<id>")}`, seen: observe() });
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
      const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
      const parts: Part[] = [];
      for (const [field, value] of form.entries()) {
        if (field === "metadata") continue;
        const file = value as File;
        parts.push({ field, filename: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
      }
      uploads.push({ script, metadata, parts });
      const latest = [...s!.versions.values()].at(-1)!;
      const id = uuid();
      s!.versions.set(id, { bindings: structuredClone(latest.bindings), tag: metadata.annotations["workers/tag"] });
      return Response.json({ success: true, result: { id, number: v } });
    }
    const vm = /^versions\/([0-9a-f-]{36})$/.exec(rest);
    if (vm && method === "GET") {
      const ver = s!.versions.get(vm[1]);
      return ver ? Response.json({ success: true, result: { id: vm[1], resources: { bindings: ver.bindings } } }) : Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  return { fetcher, calls, uploads, deployments, scripts };
}

function nativeEnv(db: Db, b: Bucket | undefined, extra: Record<string, unknown> = {}) {
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
// Only the Access certs (the harness's in-process identity provider) may be fetched; GitHub never.
const noGitHub = () => {
  globalThis.fetch = (async (i: RequestInfo | URL) => {
    if (isAccessCerts(String(i))) return accessCertsResponse();
    throw new Error(`GitHub must not be called: ${String(i)}`);
  }) as typeof fetch;
};
const desired = (db: Db, svc: string) => (db.raw.prepare("SELECT desired_version FROM service_registry WHERE service_id = ?").get(svc) as any).desired_version;
const ledger = (db: Db) => (db.raw.prepare("SELECT name FROM d1_migrations ORDER BY id").all() as any[]).map((r) => r.name as string);
const tableExists = (db: Db, name: string) => Boolean(db.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const elig = (db: Db, b: Bucket, unit = CONTROL_PLANE) => nativeDeployEligible({ DB: db as never, BUNDLES: b }, unit, NEW);
const why = (e: Awaited<ReturnType<typeof elig>>) => e.eligible ? ["eligible", e.migrations.map((m) => m.file)] : [e.reason, e.service ?? null, e.file ?? null];

// ---------------------------------------------------------------- tests
test("G2c1-1. migration rules: the Forge's DESTRUCTIVE_SQL, a splitter that reproduces every repository migration, unsupported statements", () => {
  // The Orchestrator applies only what the Forge would let through without the owner.
  const forge = read("workers/forge/src/changes.ts");
  const ours = read("workers/control-plane-shared/src/migration-rules.ts");
  for (const re of [/const DESTRUCTIVE_SQL = (\/.+\/[a-z]*);/, /const stripSqlComments = (.+);/]) {
    assert.equal(re.exec(ours)![1], re.exec(forge)![1], `the Forge's owner-only rule: ${re.source}`);
  }
  assert.equal(String(DESTRUCTIVE_SQL), /const DESTRUCTIVE_SQL = (\/.+\/[a-z]*);/.exec(forge)![1]);
  assert.equal(stripSqlComments("a -- b\nc /* d */ e"), "a \nc  e");
  // Every repository migration, split and run one statement at a time in one transaction, gives the schema a
  // plain exec of the file gives (comments inside a CREATE statement included).
  const plain = new DatabaseSync(":memory:");
  const split = new DatabaseSync(":memory:");
  for (const f of REPO_MIGRATIONS) {
    plain.exec(REPO_SQL[f]);
    const statements = splitSqlStatements(REPO_SQL[f]);
    assert.ok(statements.length > 0, f);
    split.exec("BEGIN");
    for (const s of statements) split.prepare(s).run();
    split.exec("COMMIT");
  }
  const schema = (db: DatabaseSync) => JSON.stringify(db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all());
  assert.equal(schema(split), schema(plain));
  // Quotes, comments and trigger bodies never end a statement early.
  assert.deepEqual(splitSqlStatements("INSERT INTO t VALUES ('a;b', \"c;d\", `e;f`, [g;h]); -- x;y\n/* z; */ SELECT 'it''s;';"),
    ["INSERT INTO t VALUES ('a;b', \"c;d\", `e;f`, [g;h])", "-- x;y\n/* z; */ SELECT 'it''s;'"], "comments are kept inside the statement that follows them");
  assert.deepEqual(splitSqlStatements("CREATE TRIGGER tr BEFORE UPDATE ON t BEGIN SELECT CASE WHEN 1 THEN RAISE(ABORT, 'no;') END; UPDATE t SET a = 1; END;\nSELECT 1;\n-- only a comment\n"),
    ["CREATE TRIGGER tr BEFORE UPDATE ON t BEGIN SELECT CASE WHEN 1 THEN RAISE(ABORT, 'no;') END; UPDATE t SET a = 1; END", "SELECT 1"]);
  assert.throws(() => splitSqlStatements("SELECT 'open"), /unterminated_quote/);
  assert.throws(() => splitSqlStatements("CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1;"), /unterminated_trigger/);
  assert.equal(sqlWithoutComments("SELECT 1; -- a\n/* b */ SELECT 2;"), "SELECT 1;\nSELECT 2");
  // Statements a D1 batch cannot run as the file means them.
  for (const s of ["PRAGMA foreign_keys = OFF", "BEGIN TRANSACTION", "COMMIT", "ATTACH 'x' AS y", "-- c\nVACUUM"]) assert.ok(unsupportedStatement([s]), s);
  assert.equal(unsupportedStatement(["CREATE TABLE t (a)", "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END"]), null);
  // Destructive: the Forge's reading, and a `--` inside a string does not hide the rest of the line.
  for (const sql of ["DROP TABLE t;", "DELETE FROM agents;", "UPDATE agents SET enabled = 0;", "ALTER TABLE t RENAME TO u;", "INSERT INTO t VALUES ('--'); DROP TABLE t;"]) assert.equal(destructiveMigration(sql), true, sql);
  for (const sql of ["CREATE TABLE t (a);", "-- DROP TABLE t in a comment\nCREATE INDEX i ON t(a);", ADDITIVE["0099_g2c1_probe.sql"]]) assert.equal(destructiveMigration(sql), false, sql);
});

test("G2c1-2. the Forge stores each migration's SQL and hash, and every extra module with its type under the name the bundle imports", async () => {
  const b = bucket();
  await bundlesFor(b, NEW, { tweaks: { "cryptophys-console": { multi: true } }, sql: { ...REPO_SQL, ...ADDITIVE } });
  const manifest = JSON.parse(String(b.objects.get(`bundles/${NEW}/manifest.json`)!.value));
  assert.deepEqual(manifest.migrations, [...REPO_MIGRATIONS, "0099_g2c1_probe.sql"]);
  assert.deepEqual(manifest.migration_files.map((f: any) => f.file), manifest.migrations, "migrations stays, migration_files is added");
  const probe = manifest.migration_files.at(-1);
  assert.match(probe.sha256, /^[0-9a-f]{64}$/);
  assert.equal(b.objects.get(`bundles/${NEW}/migrations/0099_g2c1_probe.sql`)!.value, ADDITIVE["0099_g2c1_probe.sql"]);
  const consoleEntry = manifest.workers.find((w: any) => w.name === "cryptophys-console");
  assert.equal(consoleEntry.single_module, false);
  assert.equal(consoleEntry.limits, false);
  assert.deepEqual(consoleEntry.modules.map((m: any) => [m.name, m.type, m.bytes]), [
    ["workers/console/node_modules/pkg/blob.bin", "application/octet-stream", 5],
    ["workers/console/node_modules/pkg/engine.wasm", "application/wasm", 8],
    ["workers/console/node_modules/pkg/lib.js", "application/javascript+module", 26],
    ["workers/console/node_modules/pkg/notes.txt", "text/plain", 12],
  ]);
  for (const m of consoleEntry.modules) {
    const stored = b.objects.get(`bundles/${NEW}/cryptophys-console/${m.name}`)!;
    assert.deepEqual(stored.value, EXT[m.name as keyof typeof EXT]);
    assert.equal(stored.type, m.type);
  }
  // The stored bundle imports each module under its stored name; the original specifiers are gone.
  const text = String(b.objects.get(`bundles/${NEW}/cryptophys-console.mjs`)!.value);
  for (const p of Object.keys(EXT)) {
    assert.ok(text.includes(`from ${JSON.stringify("./" + p)}`), p);
    assert.ok(!text.includes(JSON.stringify(SPEC(p))), p);
  }
  assert.ok(text.includes('import wasm from "./sql-wasm.wasm";'), "a template literal is left as it is");
  // A file that cannot be resolved or typed leaves the Worker multi-module (modules_error, no modules).
  const missing = bucket();
  await bundlesFor(missing, NEW, { tweaks: { "cryptophys-console": { multi: true } }, files: { ...EXT, "workers/console/node_modules/pkg/engine.wasm": undefined as never } });
  const m2 = JSON.parse(String(missing.objects.get(`bundles/${NEW}/manifest.json`)!.value)).workers.find((w: any) => w.name === "cryptophys-console");
  assert.equal(m2.modules, undefined);
  assert.match(m2.modules_error, /^external_unresolved: workers\/console\/node_modules\/pkg\/engine\.wasm$/);
  assert.equal(moduleTypeOf("x/a.js", ["./a.js"], "", enc.encode("module.exports = 1;")), null, "CommonJS is not typed");
  assert.equal(moduleTypeOf("x/a.txt", ["./a.txt"], RULES, new Uint8Array([0xff, 0xfe])), null, "a Text module must be UTF-8");
  assert.throws(() => renameImports('import a from "./x.wasm";', [{ name: "n/x.wasm", specifiers: ["../other.wasm"] }]), /import_rewrite_failed/);
  // [limits] is recorded (a version upload does not carry it).
  const lim = bucket();
  await bundlesFor(lim, NEW, { tweaks: { "cryptophys-console": { toml: "[limits]\ncpu_ms = 300000\n" } } });
  assert.equal(JSON.parse(String(lim.objects.get(`bundles/${NEW}/manifest.json`)!.value)).workers.find((w: any) => w.name === "cryptophys-console").limits, true);
  // Without the SQL at hand, migration_files is left out (G2b readers see what they saw before).
  const old = bucket();
  await bundlesFor(old, NEW, { sql: "names-only" });
  const m3 = JSON.parse(String(old.objects.get(`bundles/${NEW}/manifest.json`)!.value));
  assert.deepEqual([m3.migrations.length, "migration_files" in m3], [REPO_MIGRATIONS.length, false]);
});

// A gzipped tar like an npm package (package/…, a pax long path).
async function tgz(files: Record<string, Uint8Array>, longPath?: { path: string; bytes: Uint8Array }): Promise<Uint8Array> {
  const blocks: Uint8Array[] = [];
  const header = (name: string, size: number, type: string) => {
    const h = new Uint8Array(512);
    h.set(enc.encode(name.slice(0, 100)), 0);
    h.set(enc.encode("0000644\0"), 100);
    h.set(enc.encode(size.toString(8).padStart(11, "0") + "\0"), 124);
    h.set(enc.encode("00000000000\0"), 136);
    h[156] = type.charCodeAt(0);
    h.set(enc.encode("ustar\0" + "00"), 257);
    return h;
  };
  const body = (bytes: Uint8Array) => { const out = new Uint8Array(Math.ceil(bytes.length / 512) * 512); out.set(bytes); return out; };
  for (const [name, bytes] of Object.entries(files)) { blocks.push(header("package/" + name, bytes.length, "0"), body(bytes)); }
  if (longPath) {
    const rec = (s: string) => { let len = s.length + 3; while (String(len).length + 1 + s.length + 1 !== len) len = String(len).length + 1 + s.length + 1; return `${len} ${s}\n`; };
    const pax = enc.encode(rec(`path=package/${longPath.path}`));
    blocks.push(header("PaxHeader/x", pax.length, "x"), body(pax), header("package/truncated-name", longPath.bytes.length, "0"), body(longPath.bytes));
  }
  blocks.push(new Uint8Array(1024));
  const stream = new Blob(blocks as BlobPart[]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const sri = async (bytes: Uint8Array) => "sha512-" + Buffer.from(await crypto.subtle.digest("SHA-512", bytes as BufferSource)).toString("base64");

test("G2c1-3. extra modules come from the package the commit's lockfile pins, checked against its integrity", async () => {
  assert.deepEqual(lockLocation("workers/control-plane-shared/node_modules/esbuild-wasm/esbuild.wasm"), { root: "workers/control-plane-shared", key: "node_modules/esbuild-wasm", file: "esbuild.wasm" });
  assert.deepEqual(lockLocation("w/node_modules/a/node_modules/@s/b/dist/x.js"), { root: "w", key: "node_modules/a/node_modules/@s/b", file: "dist/x.js" });
  assert.equal(lockLocation("w/src/a.wasm"), null, "not a package file");
  assert.equal(lockLocation("w/node_modules/a/../b/x.js"), null);
  const long = "dist/" + "d".repeat(120) + "/deep.js";
  const pkg = await tgz({ "esbuild.wasm": EXT["workers/console/node_modules/pkg/engine.wasm"], "esm/browser.js": EXT["workers/console/node_modules/pkg/lib.js"], "README.md": enc.encode("x") }, { path: long, bytes: enc.encode("export {};") });
  const lock = (integrity: string, resolved = "https://registry.npmjs.org/esbuild-wasm/-/esbuild-wasm-0.28.2.tgz") =>
    JSON.stringify({ packages: { "node_modules/esbuild-wasm": { version: "0.28.2", resolved, integrity } } });
  const fetched: string[] = [];
  const fetcher = (async (u: RequestInfo | URL) => { fetched.push(String(u)); return new Response(pkg as BodyInit); }) as typeof fetch;
  const paths = ["w/node_modules/esbuild-wasm/esbuild.wasm", "w/node_modules/esbuild-wasm/esm/browser.js", `w/node_modules/esbuild-wasm/${long}`, "w/node_modules/esbuild-wasm/missing.js", "w/node_modules/other/x.js"];
  const got = await lockfileSource({ "w/package-lock.json": lock(await sri(pkg)) }, fetcher)(paths);
  assert.deepEqual([...got.keys()].sort(), paths.slice(0, 3).sort(), "a file not in the package, or a package not in the lockfile, is unresolved");
  assert.deepEqual(got.get(paths[0]), EXT["workers/console/node_modules/pkg/engine.wasm"]);
  assert.equal(new TextDecoder().decode(got.get(paths[2])), "export {};", "a pax long path");
  assert.deepEqual(fetched, ["https://registry.npmjs.org/esbuild-wasm/-/esbuild-wasm-0.28.2.tgz"], "one fetch per package");
  // A tarball that is not the one the lockfile pins is never read.
  await assert.rejects(lockfileSource({ "w/package-lock.json": lock("sha512-" + "A".repeat(86) + "==") }, fetcher)(paths.slice(0, 1)), /integrity_mismatch/);
  // Only the npm registry.
  assert.equal((await lockfileSource({ "w/package-lock.json": lock(await sri(pkg), "https://example.com/x.tgz") }, fetcher)(paths.slice(0, 1))).size, 0);
  // untar keeps only what was asked for.
  const only = await untar(new Blob([pkg as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")), (p) => p === "README.md");
  assert.deepEqual([...only.keys()], ["README.md"]);
  // The Forge's own lockfile pins the packages its Worker imports.
  const real = JSON.parse(read("workers/control-plane-shared/package-lock.json")).packages;
  for (const k of ["node_modules/esbuild-wasm", "node_modules/sql.js"]) {
    assert.match(real[k].resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(real[k].integrity, /^sha512-/);
  }
});

test("G2c1-4. eligibility for migrations: additive ones for the Control Plane, against the D1 ledger; anything else stays on GitHub", async () => {
  const cases: Array<[string, (db: Db, b: Bucket) => Promise<void> | void, unknown[]]> = [
    ["code only (G2b)", async (_db, b) => { await bundlesFor(b, NEW); }, ["eligible", []]],
    ["an additive migration", async (_db, b) => { await bundlesFor(b, NEW, { sql: { ...REPO_SQL, ...ADDITIVE } }); }, ["eligible", ["0099_g2c1_probe.sql"]]],
    ["already applied (the ledger lists the target's files)", async (db, b) => {
      await bundlesFor(b, NEW, { sql: { ...REPO_SQL, ...ADDITIVE } });
      db.raw.prepare("INSERT INTO d1_migrations (name) VALUES ('0099_g2c1_probe.sql')").run();
    }, ["eligible", []]],
    ["a destructive migration", async (_db, b) => { await bundlesFor(b, NEW, { sql: { ...REPO_SQL, "0099_drop.sql": "DROP TABLE g2c1_x;" } }); }, ["destructive_migration", "cryptophys-policy-engine", "0099_drop.sql"]],
    ["a data rewrite", async (_db, b) => { await bundlesFor(b, NEW, { sql: { ...REPO_SQL, "0099_upd.sql": "UPDATE agents SET enabled = 0;" } }); }, ["destructive_migration", "cryptophys-policy-engine", "0099_upd.sql"]],
    ["an applied migration edited", async (_db, b) => {
      await bundlesFor(b, NEW, { sql: { ...REPO_SQL, [REPO_MIGRATIONS[3]]: REPO_SQL[REPO_MIGRATIONS[3]] + "\n-- edited\n", ...ADDITIVE } });
    }, ["destructive_migration", "cryptophys-policy-engine", REPO_MIGRATIONS[3]]],
    ["an applied migration removed", async (_db, b) => {
      const sql = { ...REPO_SQL, ...ADDITIVE }; delete (sql as Record<string, string>)[REPO_MIGRATIONS[1]];
      await bundlesFor(b, NEW, { sql });
    }, ["destructive_migration", "cryptophys-policy-engine", REPO_MIGRATIONS[1]]],
    ["a new file that sorts before an applied one", async (_db, b) => { await bundlesFor(b, NEW, { sql: { ...REPO_SQL, "0000_early.sql": "CREATE TABLE g2c1_e (a);" } }); }, ["migration_out_of_order", "cryptophys-policy-engine", "0000_early.sql"]],
    ["a statement a D1 batch cannot run", async (_db, b) => { await bundlesFor(b, NEW, { sql: { ...REPO_SQL, "0099_pragma.sql": "PRAGMA foreign_keys = OFF;\nCREATE TABLE g2c1_p (a);" } }); }, ["migration_unsupported_statement", "cryptophys-policy-engine", "0099_pragma.sql"]],
    ["the stored SQL differs from the manifest", async (_db, b) => {
      await bundlesFor(b, NEW, { sql: { ...REPO_SQL, ...ADDITIVE } });
      b.objects.get(`bundles/${NEW}/migrations/0099_g2c1_probe.sql`)!.value = "CREATE TABLE g2c1_other (a);";
    }, ["migration_hash_mismatch", "cryptophys-policy-engine", "0099_g2c1_probe.sql"]],
    ["the stored SQL is missing", async (_db, b) => {
      await bundlesFor(b, NEW, { sql: { ...REPO_SQL, ...ADDITIVE } });
      b.objects.delete(`bundles/${NEW}/migrations/0099_g2c1_probe.sql`);
    }, ["migration_missing", "cryptophys-policy-engine", "0099_g2c1_probe.sql"]],
    ["the D1 ledger does not list the running files", async (db, b) => {
      await bundlesFor(b, NEW, { sql: { ...REPO_SQL, ...ADDITIVE } });
      db.raw.prepare("DELETE FROM d1_migrations WHERE name = ?").run(REPO_MIGRATIONS.at(-1)!);
    }, ["d1_migrations_mismatch", "cryptophys-policy-engine", null]],
    ["the D1 ledger is unreadable", async (db, b) => {
      await bundlesFor(b, NEW, { sql: { ...REPO_SQL, ...ADDITIVE } });
      db.raw.exec("DROP TABLE d1_migrations");
    }, ["d1_migrations_unreadable", "cryptophys-policy-engine", null]],
    ["a target manifest without migration_files (G2b)", async (_db, b) => {
      await bundlesFor(b, NEW, { sql: "names-only" });
      // names-only lists the repository files; add one more name so the lists differ.
      const m = JSON.parse(String(b.objects.get(`bundles/${NEW}/manifest.json`)!.value)); m.migrations.push("0099_x.sql");
      b.objects.get(`bundles/${NEW}/manifest.json`)!.value = JSON.stringify(m);
    }, ["new_migration", "cryptophys-policy-engine", null]],
  ];
  for (const [label, arrange, expected] of cases) {
    const { db, b } = await scenario();
    await bundlesFor(b, OLD);
    await arrange(db, b);
    assert.deepEqual(why(await elig(db, b)), expected, label);
  }
  // Only the Control Plane applies migrations: another unit waits until the ledger lists the target's files.
  const { db, b } = await scenario();
  await bundlesFor(b, OLD);
  await bundlesFor(b, NEW, { sql: { ...REPO_SQL, ...ADDITIVE } });
  assert.deepEqual(why(await elig(db, b, CONSOLE)), ["new_migration", "cryptophys-console", null]);
  db.raw.prepare("INSERT INTO d1_migrations (name) VALUES ('0099_g2c1_probe.sql')").run();
  assert.deepEqual(why(await elig(db, b, CONSOLE)), ["eligible", []], "after the Control Plane applied it");
  // A running version without migration_files (built before G2c-1) cannot prove the applied files are unchanged.
  const pre = await scenario();
  await bundlesFor(pre.b, OLD, { sql: "names-only" });
  await bundlesFor(pre.b, NEW, { sql: { ...REPO_SQL, ...ADDITIVE } });
  assert.deepEqual(why(await elig(pre.db, pre.b)), ["new_migration", "cryptophys-policy-engine", null]);
});

test("G2c1-5. an additive migration is applied through D1, recorded in d1_migrations as wrangler records it, before any Worker deploys", async () => {
  const { db, b } = await scenario(["workers/control-plane-migrations/0099_g2c1_probe.sql"]);
  await bundlesFor(b, OLD);
  await bundlesFor(b, NEW, { sql: { ...REPO_SQL, ...ADDITIVE } });
  const { env, reports } = nativeEnv(db, b);
  noGitHub();
  try {
    const before = db.raw.prepare("SELECT MAX(id) AS id FROM d1_migrations").get() as any;
    const { proposal, decision } = passedProposal(db, "cryptophys-policy-engine");
    const r = await deployForConsensus(env as never, proposal, decision, "cryptophys-policy-engine", { commit_sha: NEW });
    assert.equal(r.executor, "native:deploy");
    const queued = JSON.parse((db.raw.prepare("SELECT payload_json FROM audit_events WHERE event_type = 'deployment.native_deploy_queued'").get() as any).payload_json);
    assert.deepEqual(queued.migrations, ["0099_g2c1_probe.sql"]);
    assert.equal(tableExists(db, "g2c1_probe"), false, "queueing applies nothing");
    const cf = fakeCloudflare([...CONTROL_PLANE.services], () => ({ table: tableExists(db, "g2c1_probe"), ledger: ledger(db).includes("0099_g2c1_probe.sql") }));
    assert.deepEqual(await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 1 });
    // Applied before the first Cloudflare call; the ledger row is wrangler's: the next id, the file name, CURRENT_TIMESTAMP.
    assert.deepEqual(cf.calls[0].seen, { table: true, ledger: true });
    const row = db.raw.prepare("SELECT id, name, applied_at FROM d1_migrations WHERE name = '0099_g2c1_probe.sql'").get() as any;
    assert.equal(row.id, before.id + 1);
    assert.match(row.applied_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.deepEqual(ledger(db), [...REPO_MIGRATIONS, "0099_g2c1_probe.sql"]);
    assert.ok(db.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_g2c1_probe_note'").get(), "every statement of the file");
    assert.equal((db.raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'g2c1_probe'").get() as any).sql, "CREATE TABLE g2c1_probe (id TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT 'a;b')");
    const audit = db.raw.prepare("SELECT subject, outcome, payload_json FROM audit_events WHERE event_type = 'deployment.native_migration_applied'").all() as any[];
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0].subject, audit[0].outcome, JSON.parse(audit[0].payload_json).statements, JSON.parse(audit[0].payload_json).request_id], ["0099_g2c1_probe.sql", "applied", 2, r.request_id]);
    const outcome = JSON.parse((db.raw.prepare("SELECT status, details_json FROM deployment_requests").get() as any).details_json).outcome;
    assert.deepEqual(outcome.migrations_applied, ["0099_g2c1_probe.sql"]);
    assert.equal(outcome.steps[0], "migration:0099_g2c1_probe.sql:applied");
    assert.match(outcome.restore_point_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(cf.uploads.map((u) => u.script), [...CONTROL_PLANE.services]);
    for (const s of CONTROL_PLANE.services) assert.equal(desired(db, s), NEW.slice(0, 12));
    assert.equal(reports.length, 0);
    // Run again (a replayed request is refused by its claim): the ledger's UNIQUE name also refuses a second apply.
    await assert.rejects(db.batch([db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind("0099_g2c1_probe.sql")]), /UNIQUE/);
  } finally { globalThis.fetch = realFetch; }
});

test("G2c1-6. a migration that fails stops before any Worker deploys: its batch is rolled back, the request fails, the owner gets a critical report", async () => {
  const FAIL = "CREATE TABLE g2c1_partial (id INTEGER);\nINSERT INTO g2c1_no_such_table (x) VALUES (1);\n";
  for (const [label, sql, applied] of [
    ["the only migration fails", { "0099_fails.sql": FAIL }, []],
    ["the second of two fails", { "0098_ok.sql": "CREATE TABLE g2c1_ok (id INTEGER);", "0099_fails.sql": FAIL }, ["0098_ok.sql"]],
  ] as const) {
    const { db, b } = await scenario();
    await bundlesFor(b, OLD);
    await bundlesFor(b, NEW, { sql: { ...REPO_SQL, ...sql } });
    const { env, reports } = nativeEnv(db, b);
    noGitHub();
    try {
      const { proposal, decision } = passedProposal(db, "cryptophys-policy-engine");
      assert.equal((await deployForConsensus(env as never, proposal, decision, "cryptophys-policy-engine", { commit_sha: NEW })).executor, "native:deploy", label);
      const cf = fakeCloudflare([...CONTROL_PLANE.services]);
      assert.deepEqual(await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 0 }, label);
      assert.deepEqual(cf.calls, [], `${label}: no Worker is touched`);
      assert.equal(tableExists(db, "g2c1_partial"), false, `${label}: the failed file's batch is rolled back`);
      assert.equal(ledger(db).includes("0099_fails.sql"), false);
      assert.deepEqual(ledger(db).filter((f) => !REPO_MIGRATIONS.includes(f)), [...applied], `${label}: earlier files stay applied (forward-only)`);
      assert.equal(tableExists(db, "g2c1_ok"), applied.length > 0);
      const row = db.raw.prepare("SELECT status, details_json FROM deployment_requests").get() as any;
      assert.equal(row.status, "failed");
      const outcome = JSON.parse(row.details_json).outcome;
      assert.match(outcome.reason, /^migration_failed: 0099_fails\.sql: /);
      assert.deepEqual([outcome.migration_failed, outcome.migrations_applied, outcome.production_changed, outcome.restored], ["0099_fails.sql", [...applied], applied.length > 0, true]);
      for (const s of CONTROL_PLANE.services) assert.equal(desired(db, s), OLD.slice(0, 12), "nothing recorded");
      assert.equal(reports.length, 1);
      assert.equal(reports[0].severity, "critical");
      assert.equal(reports[0].body.migration_failed, "0099_fails.sql");
      assert.deepEqual(reports[0].body.migrations_applied, [...applied]);
      assert.match(reports[0].body.action_required, /owner/);
      assert.match(reports[0].body.d1_restore_point_at, /^\d{4}-/);
      assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'deployment.native_migration_failed' AND subject = '0099_fails.sql'").get() as any).n, 1);
    } finally { globalThis.fetch = realFetch; }
  }
});

test("G2c1-7. a migration that is not additive keeps the GitHub workflow, with the reason in the audit", async () => {
  const { db, b } = await scenario();
  await bundlesFor(b, OLD);
  await bundlesFor(b, NEW, { sql: { ...REPO_SQL, "0099_drop.sql": "DROP TABLE agent_memories;" } });
  const { env } = nativeEnv(db, b, { GH_ACTIONS_TOKEN: "gh" });
  const dispatched: any[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: NEW } });
    const m = /\/actions\/workflows\/([a-z-]+\.yml)\/dispatches$/.exec(url);
    if (m && init?.method === "POST") { dispatched.push(m[1]); return new Response(null, { status: 204 }); }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  try {
    const { proposal, decision } = passedProposal(db, "cryptophys-policy-engine");
    const r = await deployForConsensus(env as never, proposal, decision, "cryptophys-policy-engine", { commit_sha: NEW });
    assert.equal(r.workflow, "deploy-control-plane.yml");
    assert.deepEqual(dispatched, ["deploy-control-plane.yml"]);
    const ev = JSON.parse((db.raw.prepare("SELECT payload_json FROM audit_events WHERE event_type = 'deployment.dispatched'").get() as any).payload_json);
    assert.deepEqual(ev.native_deploy, { reason: "destructive_migration", service: "cryptophys-policy-engine", file: "0099_drop.sql" });
    assert.equal(tableExists(db, "agent_memories"), true, "nothing applied natively");
  } finally { globalThis.fetch = realFetch; }
});

test("G2c1-8. a multi-module Worker uploads every module as its own part, with its type, under the name the bundle imports", async () => {
  const { db, b } = await scenario();
  await bundlesFor(b, OLD, { tweaks: { "cryptophys-console": { multi: true } } });
  await bundlesFor(b, NEW, { tweaks: { "cryptophys-console": { multi: true } } });
  assert.deepEqual(why(await elig(db, b, CONSOLE)), ["eligible", []]);
  const { env } = nativeEnv(db, b);
  noGitHub();
  try {
    const { proposal, decision } = passedProposal(db, "cryptophys-console");
    assert.equal((await deployForConsensus(env as never, proposal, decision, "cryptophys-console", { commit_sha: NEW })).executor, "native:deploy");
    const cf = fakeCloudflare([...CONSOLE.services]);
    assert.deepEqual(await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 1 });
    assert.equal(cf.uploads.length, 1);
    const u = cf.uploads[0];
    const mainText = String(b.objects.get(`bundles/${NEW}/cryptophys-console.mjs`)!.value);
    assert.equal(u.metadata.main_module, "cryptophys-console.mjs");
    assert.deepEqual(u.parts.map((p) => [p.field, p.filename, p.type]), [
      ["cryptophys-console.mjs", "cryptophys-console.mjs", "application/javascript+module"],
      ["workers/console/node_modules/pkg/blob.bin", "workers/console/node_modules/pkg/blob.bin", "application/octet-stream"],
      ["workers/console/node_modules/pkg/engine.wasm", "workers/console/node_modules/pkg/engine.wasm", "application/wasm"],
      ["workers/console/node_modules/pkg/lib.js", "workers/console/node_modules/pkg/lib.js", "application/javascript+module"],
      ["workers/console/node_modules/pkg/notes.txt", "workers/console/node_modules/pkg/notes.txt", "text/plain"],
    ]);
    assert.equal(new TextDecoder().decode(u.parts[0].bytes), mainText);
    for (const p of u.parts.slice(1)) {
      assert.deepEqual(p.bytes, EXT[p.field as keyof typeof EXT], p.field);
      // The name of each part is exactly the specifier the main module imports it by (relative to the root).
      assert.ok(mainText.includes(`from ${JSON.stringify("./" + p.field)}`), p.field);
    }
    assert.equal(desired(db, "cryptophys-console"), NEW.slice(0, 12));
  } finally { globalThis.fetch = realFetch; }
  // Missing or different modules, a manifest without them, or [limits]: ineligible.
  const cases: Array<[string, (b: Bucket) => Promise<void> | void, string]> = [
    ["a module missing in R2", (b) => { b.objects.delete(`bundles/${NEW}/cryptophys-console/workers/console/node_modules/pkg/engine.wasm`); }, "module_missing"],
    ["a module's bytes differ", (b) => { b.objects.get(`bundles/${NEW}/cryptophys-console/workers/console/node_modules/pkg/lib.js`)!.value = enc.encode("export const answer = 43;\n"); }, "module_hash_mismatch"],
    ["the bundle does not import a module by its name", (b) => {
      const key = `bundles/${NEW}/manifest.json`;
      const m = JSON.parse(String(b.objects.get(key)!.value));
      const w = m.workers.find((x: any) => x.name === "cryptophys-console");
      const text = String(b.objects.get(`bundles/${NEW}/cryptophys-console.mjs`)!.value).replace('"./workers/console/node_modules/pkg/notes.txt"', '"./notes.txt"');
      b.objects.get(`bundles/${NEW}/cryptophys-console.mjs`)!.value = text;
      return crypto.subtle.digest("SHA-256", enc.encode(text)).then((d) => {
        w.sha256 = Buffer.from(d).toString("hex"); w.bytes = enc.encode(text).length; b.objects.get(key)!.value = JSON.stringify(m);
      });
    }, "module_not_imported"],
    ["the Forge could not store every module", async (b) => { await bundlesFor(b, NEW, { tweaks: { "cryptophys-console": { multi: true } }, files: {} }); }, "multi_module"],
  ];
  for (const [label, arrange, reason] of cases) {
    const s = await scenario();
    await bundlesFor(s.b, OLD, { tweaks: { "cryptophys-console": { multi: true } } });
    await bundlesFor(s.b, NEW, { tweaks: { "cryptophys-console": { multi: true } } });
    await arrange(s.b);
    assert.deepEqual(why(await elig(s.db, s.b, CONSOLE)), [reason, "cryptophys-console", null], label);
  }
  const lim = await scenario();
  await bundlesFor(lim.b, OLD, { tweaks: { "cryptophys-console": { toml: "[limits]\ncpu_ms = 300000\n" } } });
  await bundlesFor(lim.b, NEW, { tweaks: { "cryptophys-console": { toml: "[limits]\ncpu_ms = 300000\n" } } });
  assert.deepEqual(why(await elig(lim.db, lim.b, CONSOLE)), ["limits", "cryptophys-console", null], "[limits] is not carried by a version upload");
  // The Forge's own Worker has [limits], so it stays on its workflow until G2c-2.
  assert.match(read("workers/forge/wrangler.toml"), /^\[limits\]/m);
});

// ---------------------------------------------------------------- recovery redeploys
function observe(db: Db, serviceId: string, drifted: boolean) {
  db.raw.prepare(`INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at)
    VALUES (?, ?, 'd', 'o', ?, ?, ?)`).run(`obs_${Math.random().toString(16).slice(2)}`, serviceId, drifted ? 1 : 0,
    JSON.stringify({ reasons: drifted ? ["version_mismatch"] : [], probe: { version_tag: drifted ? OLD.slice(0, 12) : NEW.slice(0, 12) } }), new Date().toISOString());
}

test("G2c1-9. a recovery redeploy goes native when eligible, and the plan's lifecycle follows the request to its end", async () => {
  const { db, b } = await scenario();
  await bundlesFor(b, OLD);
  await bundlesFor(b, NEW);
  const { env: orch } = nativeEnv(db, b);
  const cf = fakeCloudflare([...CONSOLE.services]);
  const wf = fakeWorkflow();
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const statuses: string[] = [];
  let executed = false;
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-recovery-manager", db),
    APPROVER_IDENTITIES: `${OPERATOR_EMAIL},${APPROVER_EMAIL}`,
    RECOVERY_LIFECYCLE: wf.binding,
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    DEPLOY: {
      deployForRecovery: async (planId: string, dec: string, svc: string, v: string) => {
        const first = await deployForRecovery(orch as never, planId, dec, svc, v);
        // A retried step (an ambiguous first answer) is not queued twice, and gets the same request to follow.
        const retried = await deployForRecovery(orch as never, planId, dec, svc, v);
        assert.deepEqual([first.dispatched, retried.dispatched, retried.reason, retried.request_id], [true, false, "already_dispatched", first.request_id]);
        return retried;
      },
      runStatus: (w: string, sha: string) => { throw new Error(`a native request is not followed through GitHub (${w}, ${sha})`); },
      requestStatus: async (id: string) => {
        const s = await requestStatus(orch as never, id);
        statuses.push(String(s.status));
        // The Orchestrator's cron runs the queued request between two polls; the Drift Detector then observes it.
        if (!executed) { executed = true; await runNativeExecutors(orch as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }); observe(db, "cryptophys-console", false); }
        return s;
      },
    },
  };
  noGitHub();
  try {
    // The registry wants the commit (a recovery plan redeploys the desired version); production drifted from it.
    db.raw.prepare("UPDATE service_registry SET desired_version = ? WHERE service_id = 'cryptophys-console'").run(NEW.slice(0, 12));
    observe(db, "cryptophys-console", true);
    const created = await call(recovery, env, req("POST", "/v1/plans", { service_id: "cryptophys-console", plan_version: NEW.slice(0, 12), title: "Recover", rationale: "test", steps: [{ action: "redeploy_commit", description: "Redeploy" }] }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.plan.plan_id as string;
    const approved = await call(recovery, env, req("POST", `/v1/plans/${id}/approve`, {}, APPROVER_JWT));
    assert.equal(approved.body?.plan?.status, "approved", JSON.stringify(approved.body));
    const out = await runLifecycle(env as never, id, id, wf.step(id) as never);
    assert.equal(out.final_status, "completed");
    const exec = JSON.parse((db.raw.prepare("SELECT last_execution_json FROM recovery_plans WHERE plan_id = ?").get(id) as any).last_execution_json);
    assert.deepEqual(exec.pipeline.map((s: any) => `${s.id}:${s.status}`), ["approval:succeeded", "policy:succeeded", "step-1:succeeded", "verify:succeeded"]);
    assert.match(exec.pipeline[2].detail, /^native deploy of 1b1b1b1b1b1b succeeded \(request dep_/);
    assert.deepEqual(statuses.slice(0, 2), ["queued", "completed"], "queued, then finished");
    const row = db.raw.prepare("SELECT request_id, requested_by, approval_id, idempotency_key, status, details_json FROM deployment_requests").get() as any;
    assert.deepEqual([row.requested_by, row.approval_id, row.idempotency_key, row.status], [`recovery:${id}`, id, `recovery:${CONSOLE.workflow}:${NEW}`, "succeeded"]);
    const details = JSON.parse(row.details_json);
    assert.deepEqual([details.executor, details.plan_id, details.proposal_id, details.workflow], ["native:deploy", id, undefined, undefined]);
    assert.equal(cf.uploads.length, 1);
    assert.equal(desired(db, "cryptophys-console"), NEW.slice(0, 12));
    assert.deepEqual(await requestStatus(orch as never, row.request_id), { found: true, status: "completed", conclusion: "success", request_id: row.request_id, executor: "native:deploy", reason: null });
    // The same plan's commit is not queued twice.
    const again = await deployForRecovery(orch as never, id, exec.policy_decision_id, "cryptophys-console", NEW.slice(0, 12)).catch((e: Error) => ({ error: e.message }));
    assert.ok("error" in again || again.dispatched === false);
  } finally { globalThis.fetch = realFetch; }
});

test("G2c1-10. requestStatus reports failures and only the Orchestrator's own requests; an ineligible recovery redeploy keeps the workflow", async () => {
  const { db, b } = await scenario();
  await bundlesFor(b, OLD);
  await bundlesFor(b, NEW, { tweaks: { "cryptophys-console": { toml: "workers_dev = true\n" } } });
  const id = (k: number) => `dep_${String(k).repeat(8)}-5555-4555-8555-555555555555`;
  const insert = (k: number, status: string, details: object) => db.raw.prepare(
    `INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
     VALUES (?, 'cryptophys-console', ?, 'x', ?, NULL, ?, ?, ?, ?)`).run(id(k), NEW, status, id(k), JSON.stringify(details), new Date().toISOString(), new Date().toISOString());
  insert(1, "failed", { executor: "native:deploy", outcome: { reason: "bindings_differ" } });
  insert(2, "running", { executor: "native:rollback" });
  insert(3, "running", { workflow: "deploy-console.yml" });
  assert.deepEqual(await requestStatus({ DB: db as never }, id(1)), { found: true, status: "completed", conclusion: "failure", request_id: id(1), executor: "native:deploy", reason: "bindings_differ" });
  assert.deepEqual(await requestStatus({ DB: db as never }, id(2)), { found: true, status: "in_progress", conclusion: null, request_id: id(2), executor: "native:rollback", reason: null });
  assert.deepEqual(await requestStatus({ DB: db as never }, id(3)), { found: false }, "a GitHub request is followed through runStatus");
  assert.deepEqual(await requestStatus({ DB: db as never }, "dep_nope"), { found: false });
  // Ineligible (a wrangler.toml change the G2c-2 plan refuses): the recovery redeploy dispatches the unit's workflow exactly as before.
  const plan = `plan_${"6".repeat(8)}-6666-4666-8666-666666666666`;
  const dec = `dec_${"7".repeat(8)}-7777-4777-8777-777777777777`;
  const at = new Date().toISOString();
  db.raw.prepare(`INSERT INTO recovery_plans (plan_id, service_id, plan_version, status, steps_json, last_execution_json, created_at, updated_at) VALUES (?, 'cryptophys-console', ?, 'executing', '{"steps":[]}', ?, ?, ?)`)
    .run(plan, NEW.slice(0, 12), JSON.stringify({ policy_decision_id: dec }), at, at);
  db.raw.prepare(`INSERT INTO policy_decisions (decision_id, subject, action, resource, decision, reason, evidence_json, created_at) VALUES (?, 'ai:recovery-manager', 'recovery.execute', ?, 'allow', 'ok', '{}', ?)`).run(dec, plan, at);
  const { env } = nativeEnv(db, b, { GH_ACTIONS_TOKEN: "gh" });
  const dispatched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: NEW } });
    const m = /\/actions\/workflows\/([a-z-]+\.yml)\/dispatches$/.exec(url);
    if (m && init?.method === "POST") { dispatched.push(m[1]); return new Response(null, { status: 204 }); }
    if (/\/actions\/workflows\/deploy-console\.yml\/runs/.test(url)) return Response.json({ workflow_runs: [{ id: 9, run_number: 1, status: "completed", conclusion: "success", html_url: "https://github.com/x/runs/9" }] });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  try {
    const r = await deployForRecovery(env as never, plan, dec, "cryptophys-console", NEW.slice(0, 12));
    assert.deepEqual([r.dispatched, r.workflow, r.executor], [true, "deploy-console.yml", undefined]);
    assert.deepEqual(dispatched, ["deploy-console.yml"]);
    const ev = JSON.parse((db.raw.prepare("SELECT payload_json FROM audit_events WHERE event_type = 'deployment.dispatched'").get() as any).payload_json);
    assert.deepEqual(ev.native_deploy, { reason: "routing_changed", service: "cryptophys-console" });
    assert.equal((await runStatus(env as never, "deploy-console.yml", NEW)).conclusion, "success", "and the lifecycle follows the workflow run as before");
  } finally { globalThis.fetch = realFetch; }
});

test("G2c1-11. unchanged G2b: a single-module code-only deploy uploads one part, applies no migration, and wiring", async () => {
  const { db, b } = await scenario();
  await bundlesFor(b, OLD);
  await bundlesFor(b, NEW);
  const { env } = nativeEnv(db, b);
  noGitHub();
  try {
    const ledgerBefore = ledger(db);
    const { proposal, decision } = passedProposal(db, "cryptophys-console");
    await deployForConsensus(env as never, proposal, decision, "cryptophys-console", { commit_sha: NEW });
    const cf = fakeCloudflare([...CONSOLE.services]);
    assert.deepEqual(await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 1 });
    assert.deepEqual(cf.uploads[0].parts.map((p) => [p.field, p.type]), [["cryptophys-console.mjs", "application/javascript+module"]]);
    assert.deepEqual(ledger(db), ledgerBefore);
    const outcome = JSON.parse((db.raw.prepare("SELECT details_json FROM deployment_requests").get() as any).details_json).outcome;
    assert.equal("migrations_applied" in outcome, false);
    assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type LIKE 'deployment.native_migration_%'").get() as any).n, 0);
  } finally { globalThis.fetch = realFetch; }
  // Wiring: the recovery binding can follow a native request; the Forge stores SQL and modules from its tick.
  assert.match(read("workers/deployment-orchestrator/src/worker.ts"), /async requestStatus\(requestId: string\) \{\n\s+return requestStatus\(await resolved\(this\.env\), requestId\);/);
  assert.match(read("workers/recovery-manager/src/autonomous.ts"), /requestStatus\?\(requestId: string\)/);
  assert.match(read("workers/forge/src/checks.ts"), /migrationSql: migrationSqlOf\(snapshot\), externals: lockfileSource\(snapshot\)/);
  assert.equal(unitForService("cryptophys-policy-engine")!.unit, "control-plane", "the migrating unit");
});
