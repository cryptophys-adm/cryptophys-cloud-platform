// Cut-over gate of 2026-11-15 (owner, "1 setuju"): a fix to the deploy executor reaches production without depending on
// the executor being fixed. That day the native Control Plane deploy failed three times on a read-after-upload 404; the
// fix lived in the Deployment Orchestrator, which executes every deploy, and the planner deployed the Control Plane
// first because a D1 migration was pending. Two parts:
//   1. executor first: when main changes the orchestrator unit it is planned first, alone, also while a migration is
//      pending, as long as the pending migrations name nothing the orchestrator's bundled code reads (both planners
//      and the orchestrator's own executor agree);
//   2. the rescue executor: an owner-approved break-glass plan for the Orchestrator's Worker is deployed by the
//      Recovery Manager itself, with its own credential and its own small Cloudflare client, never by the Orchestrator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, OPERATOR_EMAIL, OPERATOR_JWT, accessCertsResponse, baseEnv, call, fakeWorkflow, isAccessCerts, migratedDb, req } from "./harness.ts";
import { DEPLOY_UNITS, EXECUTOR_FIRST_NOTE, orderPending, unitForService, type PlannedUnit } from "../src/deploy-units.ts";
import { EXECUTOR_FIRST_BUNDLE_PENDING, ORCHESTRATOR_SERVICE, executorFirstVerdict, identifiersUsed, migrationIdentifiers } from "../src/executor-first.ts";
import {
  RESCUE_EXECUTOR, RESCUE_KEEP_BINDINGS, RESCUE_MINUTES, RESCUE_TOKEN, RescueCloudflare, executeRescueDeploy, msToRescueMinute, rescueChoice, rescueForRecovery, rescueMissing, rescueRequestKey,
} from "../src/executor-rescue.ts";
import { REQUIRED_MIGRATION } from "../src/readiness.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { storeBundles, type BuiltModule, type BundleBucket } from "../../forge/src/bundles.ts";
import { forgePlan, planTick } from "../../forge/src/deploy-plan.ts";
import type { ArtifactsReader, ArtifactsTreeEntry } from "../../forge/src/checks.ts";
import { nativeDeployEligible } from "../../deployment-orchestrator/src/native-deploy.ts";
import { KEEP_BINDINGS, SAFE_MINUTES } from "../../deployment-orchestrator/src/native-rollback.ts";
import { recordNativeDeploy } from "../../platform-registry/src/index.ts";
import recovery from "../../recovery-manager/src/index.ts";
import { runLifecycle } from "../../recovery-manager/src/lifecycle.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { unhandledProblems } from "../../ai-kernel/src/owner-inbox.ts";
import { rpcSyscall } from "../../ai-kernel/src/agent-rpc.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const ACCOUNT = "a".repeat(32);
const OLD = "0a".repeat(20);
const NEW = "1b".repeat(20);
const tag = (s: string) => s.slice(0, 12);
// The clock frozen at one instant, as node:test's mock.timers does for Date (the Forge's node:test shim has no mock):
// Date.now() and new Date() read it, every other use of Date is unchanged.
const RealDate = Date;
function freezeDate(ms: number): void {
  class Frozen extends RealDate {
    constructor(...a: unknown[]) { if (a.length === 0) super(ms); else super(...(a as [string])); }
    static override now(): number { return ms; }
  }
  globalThis.Date = Frozen as DateConstructor;
}
function restoreDate(): void { globalThis.Date = RealDate; }
/** The text of a file and of every repository file it reaches through relative imports (node:, cloudflare: and packages excluded). */
function sourceGraph(entry: string): string {
  const seen = new Set<string>(); const parts: string[] = []; const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = read(file); parts.push(src);
    for (const m of src.matchAll(/(?:^|[\s;])(?:import|export)\b[^;'"]*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']|\bimport\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const spec = m[1] ?? m[2];
      const next = new URL(spec, new URL(file, ROOT)).pathname.slice(ROOT.pathname.length);
      if (!seen.has(next)) queue.push(next);
    }
  }
  return parts.join("\n");
}
const ORCH = unitForService(ORCHESTRATOR_SERVICE)!;
const enc = new TextEncoder();
const realFetch = globalThis.fetch;
const MIG_DIR = "workers/control-plane-migrations/";
const REPO_MIGRATIONS = readdirSync(new URL(MIG_DIR, ROOT)).filter((f) => f.endsWith(".sql")).sort();
const REPO_SQL: Record<string, string> = Object.fromEntries(REPO_MIGRATIONS.map((f) => [f, read(MIG_DIR + f)]));
const PROBE = "0990_executor_probe.sql";
const PROBE_SQL = { [PROBE]: "-- a migration the orchestrator does not read\nCREATE TABLE executor_probe (id TEXT PRIMARY KEY);\nALTER TABLE executor_probe ADD COLUMN probe_note TEXT;\n" };

// ---------------------------------------------------------------- the Forge's bundles (R2)
function bucket() {
  const objects = new Map<string, string | Uint8Array>();
  const b = {
    objects,
    async put(key: string, value: string | Uint8Array) { objects.set(key, value); return {}; },
    async get(key: string) {
      const o = objects.get(key);
      if (o === undefined) return null;
      const bytes = typeof o === "string" ? enc.encode(o) : o;
      return { text: async () => typeof o === "string" ? o : new TextDecoder().decode(o), arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer };
    },
    async list({ prefix = "", cursor, limit = 1000 }: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      return { objects: keys.slice(start, start + limit).map((key) => ({ key, uploaded: new Date() })), truncated: start + limit < keys.length, cursor: String(start + limit) };
    },
    async delete(keys: string | string[]) { for (const k of [keys].flat()) objects.delete(k); },
  };
  return b satisfies BundleBucket;
}
type Bucket = ReturnType<typeof bucket>;
const toml = (name: string) => `name = "${name}"\nmain = "src/worker.ts"\ncompatibility_date = "2026-11-01"\ncompatibility_flags = ["nodejs_compat"]\n`;
/** Every Worker but the Console (static assets), each module naming its Worker and commit; `orchestratorReads` is appended to the orchestrator's. */
async function bundlesFor(b: Bucket, commit: string, sql: Record<string, string>, opts: { orchestratorReads?: string; orchestratorToml?: string } = {}) {
  const built: BuiltModule[] = [];
  for (const u of DEPLOY_UNITS) for (const name of u.services) {
    if (name === "cryptophys-console") continue;
    const extra = name === ORCHESTRATOR_SERVICE && opts.orchestratorReads ? `\nconst q = "SELECT * FROM ${opts.orchestratorReads}";` : "";
    built.push({ dir: `workers/${name.replace("cryptophys-", "")}`, text: `export default { fetch() { return new Response("${name} ${tag(commit)}"); } };${extra}`,
      toml: name === ORCHESTRATOR_SERVICE && opts.orchestratorToml ? opts.orchestratorToml : toml(name), external: [] });
  }
  await storeBundles(b, commit, built, Date.now(), Object.keys(sql), { migrationSql: sql, externals: async () => new Map() });
}
function mainChecked(db: Db, sha: string, ready = true, at = new Date().toISOString()) {
  const steps = JSON.stringify({ typecheck: { status: ready ? "passed" : "failed", errors: 0, console_build: { status: "passed" } } });
  db.raw.prepare(`INSERT OR REPLACE INTO forge_check_runs (commit_sha, status, runner, files, pass, fail, skip, failures, started_at, finished_at, duration_ms, steps, guard_status, source)
    VALUES (?, ?, 'forge-runner/1', 1, 1, 0, 0, '[]', ?, ?, 1, ?, 'clean', 'main')`).run(sha, ready ? "passed" : "failed", at, at, steps);
}
const desired = (db: Db, svc: string) => (db.raw.prepare("SELECT desired_version FROM service_registry WHERE service_id = ?").get(svc) as any).desired_version;
const events = (db: Db, prefix: string) => (db.raw.prepare("SELECT event_type, payload_json FROM audit_events WHERE event_type LIKE ? ORDER BY rowid").all(`${prefix}%`) as any[])
  .map((r) => ({ type: r.event_type as string, payload: JSON.parse(r.payload_json) }));
const requests = (db: Db) => db.raw.prepare("SELECT request_id, service_id, requested_by, idempotency_key, status, details_json FROM deployment_requests ORDER BY created_at").all() as any[];

// ---------------------------------------------------------------- a two-commit repository for the Forge planner
type Files = Record<string, string>;
function repoOf(commits: Record<string, { parents: string[]; files: Files }>, main: string): ArtifactsReader {
  const trees: Record<string, ArtifactsTreeEntry[]> = {}; const blobs: Record<string, string> = {}; let n = 1;
  const id = (p: string) => p + (n++).toString(16).padStart(39, "0");
  function tree(files: Files): string {
    const here: Record<string, Files> = {}; const entries: ArtifactsTreeEntry[] = [];
    for (const [p, t] of Object.entries(files)) {
      const i = p.indexOf("/");
      if (i < 0) { const h = Object.entries(blobs).find(([, v]) => v === t)?.[0] ?? id("b"); blobs[h] = t; entries.push({ name: p, type: "blob", mode: "100644", hash: h }); }
      else (here[p.slice(0, i)] ??= {})[p.slice(i + 1)] = t;
    }
    for (const [d, sub] of Object.entries(here)) entries.push({ name: d, type: "tree", mode: "40000", hash: tree(sub) });
    const key = JSON.stringify(entries.sort((a, b) => a.name.localeCompare(b.name)));
    const existing = Object.entries(trees).find(([, e]) => JSON.stringify(e) === key);
    if (existing) return existing[0];
    const h = id("e"); trees[h] = entries; return h;
  }
  const roots = Object.fromEntries(Object.entries(commits).map(([sha, c]) => [sha, tree(c.files)]));
  return {
    async readCommit(h) { return commits[h] ? { hash: h, treeHash: roots[h], parents: commits[h].parents } as never : null; },
    async readTree(h) { return trees[h] ?? null; },
    async readBlob(h) { return h in blobs ? new Blob([blobs[h]]) : null; },
    async log(opts) {
      const chain: Array<Record<string, unknown>> = [];
      for (let sha: string | undefined = main; sha; sha = commits[sha]?.parents[0]) chain.push({ hash: sha, parents: commits[sha].parents });
      return chain.slice(0, opts?.limit ?? 30);
    },
  } as ArtifactsReader;
}
const BASE_FILES: Files = {
  ...Object.fromEntries(REPO_MIGRATIONS.map((f) => [MIG_DIR + f, "-- applied"])),
  "workers/deployment-orchestrator/src/index.ts": "orchestrator 0",
  "workers/ai-kernel/src/index.ts": "kernel 0",
  "workers/console/src/index.ts": "console 0",
  "workers/forge/src/tick.ts": "forge 0",
  "workers/platform-api/src/index.ts": "api 0",
};
/** main changes the orchestrator and the kernel; `migration` adds the probe migration too. */
function plannerRepo(migration: boolean): ArtifactsReader {
  const files = { ...BASE_FILES, "workers/deployment-orchestrator/src/index.ts": "orchestrator fix", "workers/ai-kernel/src/index.ts": "kernel 1", ...(migration ? { [MIG_DIR + PROBE]: PROBE_SQL[PROBE] } : {}) };
  return repoOf({ [OLD]: { parents: [], files: BASE_FILES }, [NEW]: { parents: [OLD], files } }, NEW);
}
function plannerDb(): Db {
  const db = migratedDb();
  db.raw.prepare("UPDATE service_registry SET desired_version = ?").run(tag(OLD));
  return db;
}

// ---------------------------------------------------------------- tests
test("GEF-1. a migration is reduced to the identifiers it introduces or changes; unknown shapes are unknown; a mention is a whole word", () => {
  assert.deepEqual(migrationIdentifiers(REPO_SQL["0070_learning_dedup_observe.sql"]), ["dedup_sha256", "idx_agent_memories_dedup", "idx_knowledge_proposals_dedup", "learning_requests"],
    "added columns and plain index names; the tables themselves keep working for old readers");
  assert.deepEqual(migrationIdentifiers(REPO_SQL["0071_forge_linear_history_guard.sql"]), ["history_blocked_reason"]);
  assert.deepEqual(migrationIdentifiers(REPO_SQL["0069_infra_budget_parameter.sql"]), ["policy_parameters", "policy_parameters_0069"], "a table rebuilt and renamed");
  assert.deepEqual(migrationIdentifiers(REPO_SQL["0068_observer_worker_bindings.sql"]), ["observer_worker_bindings"]);
  assert.deepEqual(migrationIdentifiers(`CREATE UNIQUE INDEX IF NOT EXISTS u ON "deployment_requests" (x);`), ["deployment_requests", "u"], "an upsert may rely on a unique index");
  assert.deepEqual(migrationIdentifiers("INSERT OR IGNORE INTO kernel_controls (k) VALUES ('x'); UPDATE agents SET x = 1; DELETE FROM audit_events WHERE 0;"), ["agents", "audit_events", "kernel_controls"]);
  assert.deepEqual(migrationIdentifiers("ALTER TABLE t RENAME COLUMN a TO b; DROP INDEX IF EXISTS i;"), ["a", "b", "i"]);
  assert.deepEqual(migrationIdentifiers("CREATE TRIGGER tr AFTER INSERT ON deployment_requests BEGIN SELECT 1; END;"), ["deployment_requests", "tr"]);
  for (const sql of ["PRAGMA foreign_keys = OFF;", "CREATE VIRTUAL TABLE v USING fts5(x);", "SELECT 1;", "CREATE TABLE \"a-b\" (x);", "CREATE TABLE 'unterminated"]) {
    assert.equal(migrationIdentifiers(sql), null, sql);
  }
  assert.deepEqual(identifiersUsed("SELECT status FROM deployment_requests", ["deployment_requests", "deployment_request", "STATUS", "status_x"]), ["deployment_requests", "status"]);
  assert.deepEqual(identifiersUsed("const learning_requests_total = 1; // dedup_sha256x", ["learning_requests", "dedup_sha256"]), []);
});

test("GEF-2. the real orchestrator: its readiness needs no migration after 0029, and its bundled code reads nothing 0070 or 0071 introduce, but it does read what 0069 rebuilds", async () => {
  // Why the old "Control Plane first while a migration is pending" rule no longer follows from readiness (2026-11-07,
  // 0026: every Worker's readiness required the newest migration): the list ends at 0029 and the Orchestrator adds none.
  assert.equal(REQUIRED_MIGRATION, "0029_knowledge_proposals.sql");
  const orchestrator = read("workers/deployment-orchestrator/src/index.ts");
  assert.match(orchestrator, /database_schema: Boolean\(env\.DB\) && await schemaReady\(env as never\),/, "readiness passes no extra migrations");
  assert.doesNotMatch(orchestrator, /schemaReady\(env[^)]*,\s*\[/);
  const ids = (f: string) => migrationIdentifiers(REPO_SQL[f])!;
  // Everywhere, the Forge run included (it has no packages, so no esbuild): the Worker's source graph, every file its
  // entry point reaches through relative imports. A superset of the bundle, so "reads nothing" here is at least as
  // strict as on the bundle; it also sees code the bundle drops (index.ts imports ai-engine.ts for boundedString only,
  // and ai-engine.ts writes ai_usage.learning_requests, 0070).
  const graph = sourceGraph("workers/deployment-orchestrator/src/worker.ts");
  assert.ok(graph.length > 100_000, "the whole Worker, shared imports included");
  assert.deepEqual(identifiersUsed(graph, ids("0071_forge_linear_history_guard.sql")), []);
  assert.deepEqual(identifiersUsed(graph, ids("0070_learning_dedup_observe.sql")), ["learning_requests"], "the source graph is conservative");
  assert.deepEqual(identifiersUsed(graph, ids("0069_infra_budget_parameter.sql")), ["policy_parameters"], "a dependency is seen");
  assert.ok(identifiersUsed(graph, ["deployment_requests", "forge_check_runs", "d1_migrations"]).length === 3, "the tables it does read are seen");
  // Where esbuild is installed (a checkout with node_modules): the bundle itself, as the planner reads it from main's
  // bundles. The specifier is not a literal so the Forge's snapshot bundler leaves the import to run time.
  const pkg = "esbuild";
  const esbuild = await import(pkg).catch(() => null) as null | { build: (o: object) => Promise<{ outputFiles: { text: string }[] }> };
  if (!esbuild) return;
  const out = await esbuild.build({ entryPoints: [new URL("workers/deployment-orchestrator/src/worker.ts", ROOT).pathname], bundle: true, format: "esm", write: false, external: ["cloudflare:workers"], platform: "neutral", logLevel: "silent" });
  const text = out.outputFiles[0].text;
  assert.ok(text.length > 100_000, "the whole Worker, shared imports included");
  assert.deepEqual(identifiersUsed(text, ids("0071_forge_linear_history_guard.sql")), []);
  assert.deepEqual(identifiersUsed(text, ids("0070_learning_dedup_observe.sql")), [], "the bundle drops what it does not use");
  assert.deepEqual(identifiersUsed(text, ids("0069_infra_budget_parameter.sql")), ["policy_parameters"], "a dependency is seen");
  assert.ok(identifiersUsed(text, ["deployment_requests", "forge_check_runs", "d1_migrations"]).length === 3, "the tables it does read are seen");
});

test("GEF-3. orderPending: executor first with a pending migration only when proven; otherwise the rules before the gate", () => {
  const u = (unit: string): PlannedUnit => ({ unit, workflow: `deploy-${unit}.yml`, target: unit, reason: `main x changes ${unit}` });
  const all = [u("deployment-orchestrator"), u("control-plane"), u("console")];
  // No migration: the orchestrator first, alone (unchanged).
  assert.deepEqual(orderPending(all, false, []), { units: [u("deployment-orchestrator")],
    skipped: [{ unit: "control-plane", reason: "deployment_orchestrator_must_complete_first" }, { unit: "console", reason: "deployment_orchestrator_must_complete_first" }] });
  // A migration, not proven: the Control Plane first, alone (unchanged; the default).
  assert.deepEqual(orderPending(all, true, []).units.map((x) => x.unit), ["control-plane"]);
  assert.deepEqual(orderPending(all, true, [], false), orderPending(all, true, []));
  // A migration, proven independent: the orchestrator first, alone, with the reason saying so.
  const first = orderPending(all, true, [], true);
  assert.deepEqual(first.units.map((x) => [x.unit, x.reason]), [["deployment-orchestrator", `main x changes deployment-orchestrator; ${EXECUTOR_FIRST_NOTE}`]]);
  assert.deepEqual(first.skipped, [{ unit: "control-plane", reason: "deployment_orchestrator_must_complete_first" }, { unit: "console", reason: "deployment_orchestrator_must_complete_first" }]);
  // Proven, but the orchestrator is not pending: the Control Plane first as before.
  assert.deepEqual(orderPending([u("control-plane"), u("console")], true, [], true).units.map((x) => x.unit), ["control-plane"]);
  // Proven, and the Control Plane cannot be deployed: the orchestrator still goes (it needs none of the migrations).
  assert.deepEqual(orderPending([u("deployment-orchestrator"), u("console")], true, [{ unit: "control-plane", reason: "desired_version_unknown" }], true).units.map((x) => x.unit), ["deployment-orchestrator"]);
  assert.deepEqual(orderPending([u("deployment-orchestrator"), u("console")], true, [{ unit: "control-plane", reason: "desired_version_unknown" }]).units, [], "not proven: fail closed as before");
});

test("GEF-4. the Forge planner, with and without a pending migration, reading main's bundles; the orchestrator's own executor accepts exactly what the planner proved", async () => {
  // No pending migration: the orchestrator first (unchanged, no bundle read needed).
  let db = plannerDb();
  let b = bucket();
  let plan = await forgePlan(db as never, plannerRepo(false), NEW, b);
  assert.deepEqual(plan.units.map((x) => x.unit), ["deployment-orchestrator"]);
  assert.deepEqual(plan.skipped, [{ unit: "control-plane", reason: "deployment_orchestrator_must_complete_first" }]);

  // A pending migration the orchestrator does not read: the orchestrator first, alone, also before the Control Plane.
  db = plannerDb();
  b = bucket();
  await bundlesFor(b, OLD, REPO_SQL);
  await bundlesFor(b, NEW, { ...REPO_SQL, ...PROBE_SQL });
  plan = await forgePlan(db as never, plannerRepo(true), NEW, b);
  assert.deepEqual(plan.units.map((x) => [x.unit, x.reason]), [["deployment-orchestrator", `main ${tag(NEW)} changes deployment-orchestrator; ${EXECUTOR_FIRST_NOTE}`]]);
  assert.deepEqual(plan.skipped, [{ unit: "control-plane", reason: "deployment_orchestrator_must_complete_first" }]);
  // Parity: the orchestrator's own native deploy accepts the same commit with the migration pending, and applies none.
  const eligible = await nativeDeployEligible({ DB: db as never, BUNDLES: b }, ORCH, NEW);
  assert.ok(eligible.eligible, JSON.stringify(eligible));
  assert.deepEqual(eligible.eligible && eligible.migrations, []);
  // The Control Plane, deployed next, still applies it.
  const cp = await nativeDeployEligible({ DB: db as never, BUNDLES: b }, unitForService("cryptophys-ai-kernel")!, NEW);
  assert.deepEqual(cp.eligible && cp.migrations.map((m) => m.file), [PROBE]);
  // Once the orchestrator runs main, the Control Plane follows with the migration.
  db.raw.prepare("UPDATE service_registry SET desired_version = ? WHERE service_id = ?").run(tag(NEW), ORCHESTRATOR_SERVICE);
  plan = await forgePlan(db as never, plannerRepo(true), NEW, b);
  assert.deepEqual(plan.units.map((x) => x.unit), ["control-plane"]);

  // A pending migration the orchestrator reads: the Control Plane first, as before, and the skip says why.
  db = plannerDb();
  b = bucket();
  await bundlesFor(b, OLD, REPO_SQL);
  await bundlesFor(b, NEW, { ...REPO_SQL, ...PROBE_SQL }, { orchestratorReads: "executor_probe" });
  plan = await forgePlan(db as never, plannerRepo(true), NEW, b);
  assert.deepEqual(plan.units.map((x) => x.unit), ["control-plane"]);
  assert.deepEqual(plan.skipped, [
    { unit: "deployment-orchestrator", reason: `executor_first_not_proven:orchestrator_reads_migration:${PROBE}` },
    { unit: "deployment-orchestrator", reason: "control_plane_migration_first" },
  ]);
  const refused = await nativeDeployEligible({ DB: db as never, BUNDLES: b }, ORCH, NEW);
  assert.deepEqual(refused.eligible ? null : refused.reason, "new_migration", "the executor refuses what the planner did not prove");
  assert.deepEqual(await executorFirstVerdict(b, NEW, [PROBE]), { state: "dependent", reason: "orchestrator_reads_migration", file: PROBE, uses: ["executor_probe"] });

  // Main's bundles not stored yet (its checks run after the plan): nothing is planned, and it is planned again once they are.
  db = plannerDb();
  b = bucket();
  await bundlesFor(b, OLD, REPO_SQL);
  const repo = plannerRepo(true);
  const first = await planTick(db as never, repo, Date.now(), b);
  assert.deepEqual([first.outcome, first.units, first.waiting], ["recorded", [], true]);
  const row = db.raw.prepare("SELECT forge_units, forge_skipped FROM forge_deploy_plans WHERE main_sha = ?").get(NEW) as any;
  assert.deepEqual(JSON.parse(row.forge_units), []);
  assert.deepEqual(JSON.parse(row.forge_skipped).map((s: any) => s.reason), [EXECUTOR_FIRST_BUNDLE_PENDING, EXECUTOR_FIRST_BUNDLE_PENDING]);
  await bundlesFor(b, NEW, { ...REPO_SQL, ...PROBE_SQL });
  const again = await planTick(db as never, repo, Date.now() + 1, b);
  assert.deepEqual([again.outcome, again.units, again.waiting], ["recorded", ["deployment-orchestrator"], undefined]);
  assert.equal((await planTick(db as never, repo, Date.now() + 2, b)).outcome, "up_to_date", "planned once it is decided");
  // The tick plans again right after main's checks when the first plan waited.
  const tick = read("workers/forge/src/tick.ts");
  assert.match(tick, /deploy_plan as \{ waiting\?: boolean \} \| undefined\)\?\.waiting\) await step\("deploy_plan_after_checks", deployPlan\)/);
  assert.ok(tick.indexOf('step("main_checks"') < tick.indexOf('step("deploy_plan_after_checks"'));

  // Without a bundle binding, or with D1's ledger unreadable, nothing changes from the rules before the gate.
  db = plannerDb();
  plan = await forgePlan(db as never, plannerRepo(true), NEW);
  assert.deepEqual(plan.units.map((x) => x.unit), ["control-plane"]);
  assert.deepEqual(plan.skipped, [{ unit: "deployment-orchestrator", reason: "control_plane_migration_first" }]);
});

// ---------------------------------------------------------------- the rescue executor
const SECRET = "rescue-token";
const BINDINGS = [{ type: "d1", name: "DB", id: "db-uuid" }, { type: "version_metadata", name: "CF_VERSION_METADATA" }, { type: "secret_text", name: "CF_DEPLOY_TOKEN" }];
/** The Workers API for the Orchestrator's script only; anything else, or another token, fails the test. */
function fakeCloudflare(opts: { uploadedBindings?: unknown[]; uploadedReads404?: number } = {}) {
  let v = 0;
  const uuid = () => `${String(++v).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const first = uuid();
  const versions = new Map<string, unknown[]>([[first, structuredClone(BINDINGS)]]);
  const state = { active: [{ version_id: first, percentage: 100 }] as Array<{ version_id: string; percentage: number }>, first };
  const uploads: { text: string; metadata: any }[] = [];
  const deployments: any[] = [];
  let reads404 = opts.uploadedReads404 ?? 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const m = new RegExp(`^https://api\\.cloudflare\\.com/client/v4/accounts/${ACCOUNT}/workers/scripts/([a-z0-9-]+)/(.*)$`).exec(String(input));
    assert.ok(m, `unexpected ${String(input)}`);
    assert.equal(m![1], ORCHESTRATOR_SERVICE, "the rescue executor addresses only the Orchestrator's script");
    assert.equal((init?.headers as Record<string, string>)?.authorization, `Bearer ${SECRET}`, "with the rescue credential, never CF_DEPLOY_TOKEN");
    const rest = m![2];
    const method = init?.method ?? "GET";
    if (rest === "deployments" && method === "GET") return Response.json({ success: true, result: { deployments: [{ created_on: "2026-11-15T00:00:00Z", versions: state.active }] } });
    if (rest === "deployments" && method === "POST") { const body = JSON.parse(String(init!.body)); deployments.push(body); state.active = body.versions; return Response.json({ success: true, result: { id: "dep" } }); }
    if (rest === "versions" && method === "POST") {
      const form = init!.body as FormData;
      const metadata = JSON.parse(await (form.get("metadata") as File).text());
      const part = form.get(`${ORCHESTRATOR_SERVICE}.mjs`) as File;
      uploads.push({ text: await part.text(), metadata });
      const id = uuid();
      versions.set(id, structuredClone(opts.uploadedBindings ?? BINDINGS));
      return Response.json({ success: true, result: { id } });
    }
    const vm = /^versions\/([0-9a-f-]{36})$/.exec(rest);
    if (vm && method === "GET") {
      if (vm[1] !== first && reads404 > 0) { reads404--; return Response.json({ success: false, errors: [{ code: 100146 }] }, { status: 404 }); }
      return Response.json({ success: true, result: { id: vm[1], resources: { bindings: versions.get(vm[1]) } } });
    }
    throw new Error(`unexpected ${method} ${String(input)}`);
  }) as typeof fetch;
  return { fetcher, uploads, deployments, state };
}
const nextSafeMinute = (after: number): number => {
  const start = Math.ceil(after / 60_000) * 60_000;
  for (let i = 0; i < 60; i++) { const c = start + i * 60_000; if ((SAFE_MINUTES as number[]).includes(new Date(c).getUTCMinutes())) return c + 5_000; }
  throw new Error("no safe minute");
};
/** The Recovery Manager's env with the rescue executor configured. The Orchestrator's DeployRpc fails the test if touched. */
function recoveryEnv(db: Db, b: Bucket, opts: { probeTag?: string; configured?: boolean; agents?: { syscall(agent: string, cap: string, input: any): Promise<any> } } = {}) {
  const wf = fakeWorkflow();
  const reports: any[] = [];
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const orchestratorUsed: string[] = [];
  const deploy = new Proxy({}, { get: (_t, name) => { if (name === "then") return undefined; return () => { orchestratorUsed.push(String(name)); throw new Error(`the Orchestrator's ${String(name)} must not be used`); }; } });
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-recovery-manager", db),
    APPROVER_IDENTITIES: `${OPERATOR_EMAIL},${APPROVER_EMAIL}`,
    RECOVERY_LIFECYCLE: wf.binding,
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    DEPLOY: deploy,
    AGENTS: opts.agents ?? { syscall: async (agent: string, _cap: string, input: any) => {
      reports.push({ agent, ...input });
      db.raw.prepare(`INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
        .run(`rpt_${crypto.randomUUID()}`, agent, input.kind, input.severity, input.subject, JSON.stringify(input.body), input.ai_status, new Date().toISOString());
      return { outcome: "succeeded" };
    } },
    ...(opts.configured === false ? {} : {
      BUNDLES: b,
      DRIFT: { probeService: async (svc: string) => ({ reachable: true, healthy: true, version_tag: svc === ORCHESTRATOR_SERVICE ? (opts.probeTag ?? tag(NEW)) : null, error: null }) },
      REGISTRY: { recordNativeDeploy: (id: string) => recordNativeDeploy({ DB: db } as never, id) },
      CF_ORCHESTRATOR_DEPLOY_TOKEN: SECRET, CF_ACCOUNT_ID: ACCOUNT,
    }),
  };
  return { env, wf, reports, orchestratorUsed };
}
async function rescueSetup(newSql: Record<string, string> = { ...REPO_SQL, ...PROBE_SQL }, opts: { orchestratorReads?: string; orchestratorToml?: string } = {}) {
  const db = migratedDb();
  db.raw.prepare("UPDATE service_registry SET desired_version = ?").run(tag(OLD));
  const b = bucket();
  await bundlesFor(b, OLD, REPO_SQL);
  await bundlesFor(b, NEW, newSql, opts);
  mainChecked(db, OLD, true, new Date(Date.now() - 3_600_000).toISOString());
  mainChecked(db, NEW);
  return { db, b };
}
/** Create (a person) and approve (another person) a break-glass plan through the Recovery Manager's HTTP API. */
async function approvedPlan(env: Record<string, unknown>, service = ORCHESTRATOR_SERVICE, step: Record<string, unknown> = {}) {
  const created = await call(recovery, env, req("POST", "/v1/plans", { service_id: service, plan_version: NEW, title: "Rescue the executor", rationale: "the Orchestrator's own deploy fails",
    steps: [{ action: "force_redeploy_unit", description: "Deploy the Orchestrator at main without the Orchestrator", ...step }] }, OPERATOR_JWT));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.plan.plan_id as string;
  const approved = await call(recovery, env, req("POST", `/v1/plans/${id}/approve`, {}, APPROVER_JWT));
  assert.equal(approved.body?.plan?.status, "approved", JSON.stringify(approved.body));
  return id;
}
function routeFetch(cf: { fetcher: typeof fetch }) {
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    if (isAccessCerts(String(i))) return accessCertsResponse();
    if (String(i).startsWith("https://api.cloudflare.com/")) return cf.fetcher(i, init);
    throw new Error(`no network call expected: ${String(i)}`);
  }) as typeof fetch;
}
/** The Drift Detector observed `svc` in sync at main just now (the plan's verify stage reads it). */
function observeInSync(db: Db, svc: string, version = tag(NEW)) {
  const at = new Date().toISOString();
  db.raw.prepare(`INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at) VALUES (?, ?, 'd', 'd', 0, ?, ?)`)
    .run(`obs_${crypto.randomUUID()}`, svc, JSON.stringify({ reasons: [], probe: { version_tag: version } }), at);
  db.raw.prepare("UPDATE service_registry SET updated_at = ? WHERE service_id = ?").run(at, svc);
}
/** Run `fn` with timers firing at once (the executor's retry pauses), restoring them after. */
async function fastTimers<T>(fn: () => Promise<T>): Promise<T> {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((cb: () => void) => real(cb, 0)) as typeof setTimeout;
  try { return await fn(); } finally { globalThis.setTimeout = real; }
}
const pipeline = (db: Db, id: string) => JSON.parse((db.raw.prepare("SELECT last_execution_json FROM recovery_plans WHERE plan_id = ?").get(id) as any).last_execution_json).pipeline as any[];

test("GEF-5. break-glass of the Orchestrator's Worker: the Recovery Manager deploys it itself from main's bundle, verified live and recorded; the Orchestrator is never used", async () => {
  const { db, b } = await rescueSetup();
  // The Orchestrator's own last deploy of its unit failed: the Owner page points to this path.
  db.raw.prepare(`INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
    VALUES (?, ?, ?, 'consensus:prop_x', 'failed', 'prop_x', ?, ?, ?, ?)`).run(`dep_${crypto.randomUUID()}`, ORCHESTRATOR_SERVICE, NEW, `consensus:deploy-deployment-orchestrator.yml:${NEW}`,
    JSON.stringify({ executor: "native:deploy", unit: "deployment-orchestrator", outcome: { reason: "cloudflare_api_404_100146", restored: true } }), new Date(Date.now() - 600_000).toISOString(), new Date(Date.now() - 600_000).toISOString());
  const blocked = (await unhandledProblems(db as never)).filter((p) => p.code === "executor_deploy_failed");
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].detail, /^The Deployment Orchestrator's own deploy of 1b1b1b1b1b1b failed \(cloudflare_api_404_100146\); .*break-glass plan for cryptophys-deployment-orchestrator/);
  const { env, wf, reports, orchestratorUsed } = recoveryEnv(db, b);
  const cf = fakeCloudflare({ uploadedReads404: 2 });
  routeFetch(cf);
  freezeDate(nextSafeMinute(Date.now()));
  try {
    const id = await approvedPlan(env);
    observeInSync(db, ORCHESTRATOR_SERVICE);
    const out = await fastTimers(() => runLifecycle(env as never, id, id, wf.step(id) as never));
    assert.equal(out.final_status, "completed", JSON.stringify(pipeline(db, id)));
    const stages = pipeline(db, id);
    assert.deepEqual(stages.map((s) => `${s.id}:${s.status}`), ["approval:succeeded", "policy:succeeded", "step-1:succeeded", "verify:succeeded"]);
    assert.match(stages[2].detail, /^rescue deploy of the Orchestrator at 1b1b1b1b1b1b succeeded without the Orchestrator \(request dep_/);
    assert.deepEqual(orchestratorUsed, [], "no DeployRpc call: not the break-glass queue, not requestStatus, nothing");

    // One upload, main's bundle for the Orchestrator, code only: every binding kept, tagged with main.
    assert.equal(cf.uploads.length, 1);
    assert.equal(cf.uploads[0].text, `export default { fetch() { return new Response("${ORCHESTRATOR_SERVICE} ${tag(NEW)}"); } };`);
    assert.deepEqual(cf.uploads[0].metadata.keep_bindings, [...KEEP_BINDINGS]);
    assert.equal(cf.uploads[0].metadata.bindings, undefined, "it sends no binding");
    assert.equal(cf.uploads[0].metadata.annotations["workers/tag"], tag(NEW));
    assert.deepEqual(cf.deployments.map((d) => d.versions.length), [1], "deployed once at 100%, after two 404s on reading the upload back");
    assert.equal(desired(db, ORCHESTRATOR_SERVICE), tag(NEW));
    for (const u of DEPLOY_UNITS.filter((x) => x.unit !== "deployment-orchestrator")) for (const s of u.services) assert.equal(desired(db, s), tag(OLD), `${s} untouched`);
    // The migration the Orchestrator does not read stays pending for the Control Plane's deploy: this path applies none.
    assert.equal(db.raw.prepare("SELECT 1 FROM d1_migrations WHERE name = ?").get(PROBE), undefined);

    const rows = requests(db).filter((r) => JSON.parse(r.details_json).executor === RESCUE_EXECUTOR);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].service_id, rows[0].requested_by, rows[0].idempotency_key, rows[0].status], [ORCHESTRATOR_SERVICE, `recovery:${id}`, rescueRequestKey(NEW, id), "succeeded"]);
    assert.deepEqual(JSON.parse(rows[0].details_json).pending_migrations, [PROBE]);
    const types = events(db, "").map((e) => e.type);
    for (const t of ["recovery.plan_approved", "deployment.rescue_started", "registry.desired_version_set", "deployment.rescue_succeeded", "recovery.execution_finished"]) assert.ok(types.includes(t), t);
    assert.ok(!types.some((t) => t.startsWith("deployment.break_glass") || t.startsWith("deployment.native_deploy")), "nothing of the Orchestrator's own path");
    assert.equal((await verifyAuditChain(db as never)).valid, true);

    // The owner hears of it as a break-glass deploy (a warning: the brake stays off); the executor item closes.
    const report = reports.find((r) => r.body?.rescue);
    assert.deepEqual([report.agent, report.severity, report.body.alert_key, report.body.executor], ["recovery-manager", "warning", `break_glass:${rows[0].request_id}`, RESCUE_EXECUTOR]);
    const items = await unhandledProblems(db as never);
    assert.deepEqual(items.filter((p) => p.code === "break_glass_deployed").map((p) => p.subject), [`break_glass:${rows[0].request_id}`]);
    assert.deepEqual(items.filter((p) => p.code === "executor_deploy_failed"), []);

    // A replayed step never deploys twice: the request row is the one-time claim.
    const dec = JSON.parse((db.raw.prepare("SELECT last_execution_json FROM recovery_plans WHERE plan_id = ?").get(id) as any).last_execution_json).policy_decision_id;
    db.raw.prepare("UPDATE recovery_plans SET status = 'executing' WHERE plan_id = ?").run(id);
    const replay = await rescueForRecovery(env as never, id, dec);
    assert.deepEqual([replay.status, (replay as any).request_id], ["succeeded", rows[0].request_id]);
    assert.equal(cf.uploads.length, 1);
    assert.equal((await rescueForRecovery(env as never, id, "dec_00000000-0000-4000-8000-000000000000")).status, "failed", "another decision id is refused");
  } finally { restoreDate(); globalThis.fetch = realFetch; }
});

test("GEF-6. the rescue deploy restores the captured deployment on failure, and changes nothing before traffic would move", async () => {
  const choice = { ok: true as const, module: `${ORCHESTRATOR_SERVICE}.mjs`, text: "export default {};", compatibility_date: "2026-11-01", compatibility_flags: [], running_tag: tag(OLD), pending_migrations: [] };
  const recorded: string[] = [];
  const registry = { recordNativeDeploy: async (id: string) => { recorded.push(id); return {}; } };
  const noSleep = async () => undefined;
  // Not live at main's tag after the deploy: restored to the captured version, verified, nothing recorded.
  let cf = fakeCloudflare();
  let run = await executeRescueDeploy(new RescueCloudflare(SECRET, ACCOUNT, cf.fetcher), { DRIFT: { probeService: async () => ({ healthy: true, version_tag: tag(OLD) }) }, REGISTRY: registry }, "dep_1", NEW, choice, { sleep: noSleep });
  assert.deepEqual([run.ok, run.reason, run.restored, run.production_changed], [false, "not_live_at_tag", true, true]);
  assert.deepEqual(cf.deployments.map((d) => d.versions[0].version_id), [run.version_id, cf.state.first], "deployed, then the captured version again");
  assert.deepEqual(cf.state.active, [{ version_id: cf.state.first, percentage: 100 }]);
  assert.deepEqual(run.steps, ["captured", "uploaded", "bindings_match", "deployed", "restored"]);
  assert.deepEqual(recorded, []);
  // The uploaded version binds something else: refused before any deploy call.
  cf = fakeCloudflare({ uploadedBindings: [{ type: "d1", name: "DB", id: "another-db" }] });
  run = await executeRescueDeploy(new RescueCloudflare(SECRET, ACCOUNT, cf.fetcher), { DRIFT: { probeService: async () => ({ healthy: true, version_tag: tag(NEW) }) }, REGISTRY: registry }, "dep_2", NEW, choice, { sleep: noSleep });
  assert.deepEqual([run.ok, run.reason, run.restored, run.production_changed, cf.deployments.length], [false, "bindings_differ", true, false, 0]);
  // A 404 on reading the upload back that persists fails it, also before any deploy call.
  cf = fakeCloudflare({ uploadedReads404: 99 });
  run = await executeRescueDeploy(new RescueCloudflare(SECRET, ACCOUNT, cf.fetcher), { DRIFT: { probeService: async () => ({ healthy: true, version_tag: tag(NEW) }) }, REGISTRY: registry }, "dep_3", NEW, choice, { sleep: noSleep });
  assert.deepEqual([run.ok, run.reason, cf.deployments.length], [false, "cloudflare_api_404_100146", 0]);
  // The client cannot address another script, and needs a real account id.
  assert.throws(() => new RescueCloudflare(SECRET, "nope"), /invalid_account_id/);
  await assert.rejects(new RescueCloudflare(SECRET, ACCOUNT, cf.fetcher).upload("cryptophys-ai-kernel.mjs", "x", { compatibility_date: "2026-11-01", compatibility_flags: [], tag: tag(NEW), message: "m" }), /invalid_upload/);

  // Through the plan: the request fails, the owner gets a critical report, the registry is unchanged.
  const { db, b } = await rescueSetup();
  const { env, wf, reports, orchestratorUsed } = recoveryEnv(db, b, { probeTag: tag(OLD) });
  const live = fakeCloudflare();
  routeFetch(live);
  freezeDate(nextSafeMinute(Date.now()));
  try {
    const id = await approvedPlan(env);
    // The live check retries with pauses; they fire at once here.
    assert.equal((await fastTimers(() => runLifecycle(env as never, id, id, wf.step(id) as never))).final_status, "failed");
    assert.match(pipeline(db, id)[2].detail, /failed: not_live_at_tag .*restored\)$/);
    assert.deepEqual(live.state.active, [{ version_id: live.state.first, percentage: 100 }]);
    assert.equal(desired(db, ORCHESTRATOR_SERVICE), tag(OLD));
    const row = requests(db).find((r) => JSON.parse(r.details_json).executor === RESCUE_EXECUTOR);
    assert.deepEqual([row.status, JSON.parse(row.details_json).outcome.restored], ["failed", true]);
    assert.deepEqual(reports.filter((r) => r.body?.rescue).map((r) => r.severity), ["critical"]);
    assert.ok(events(db, "deployment.rescue_failed").length === 1);
    assert.deepEqual(orchestratorUsed, []);
  } finally { restoreDate(); globalThis.fetch = realFetch; }
});

test("GEF-7. refusals change nothing: not configured, a destructive migration named, not main's head, a configuration change, a migration the Orchestrator reads, another deploy under way", async () => {
  // Not configured: the step is blocked and names what the owner sets; nothing is called.
  {
    const { db, b } = await rescueSetup();
    const { env, wf, orchestratorUsed } = recoveryEnv(db, b, { configured: false });
    routeFetch(fakeCloudflare());
    try {
      const id = await approvedPlan(env);
      await runLifecycle(env as never, id, id, wf.step(id) as never);
      const s = pipeline(db, id)[2];
      assert.equal(s.status, "blocked");
      assert.match(s.detail, new RegExp(`secret ${RESCUE_TOKEN}.*secret CF_ACCOUNT_ID.*binding BUNDLES.*binding DRIFT.*binding REGISTRY`));
      assert.deepEqual(orchestratorUsed, [], "blocked, not sent to the Orchestrator instead");
    } finally { globalThis.fetch = realFetch; }
  }
  assert.deepEqual(rescueMissing({ CF_ORCHESTRATOR_DEPLOY_TOKEN: "t", CF_ACCOUNT_ID: ACCOUNT, BUNDLES: bucket(), DRIFT: { probeService: async () => ({ healthy: true, version_tag: null }) }, REGISTRY: { recordNativeDeploy: async () => ({}) } }), []);

  const choose = async (db: Db, b: Bucket, named: string[] = []) => rescueChoice({ DB: db as never, BUNDLES: b }, NEW, named);
  let { db, b } = await rescueSetup();
  assert.ok((await choose(db, b)).ok);
  assert.deepEqual(await choose(db, b, ["0991_x.sql"]), { ok: false, reason: "orchestrator_applies_no_migrations" });
  mainChecked(db, "2c".repeat(20), true, new Date(Date.now() + 1000).toISOString());
  assert.deepEqual(await choose(db, b), { ok: false, reason: "commit_not_current_main" });
  ({ db, b } = await rescueSetup({ ...REPO_SQL, ...PROBE_SQL }, { orchestratorToml: toml(ORCHESTRATOR_SERVICE) + "\n[vars]\nX = \"1\"\n" }));
  assert.deepEqual(await choose(db, b), { ok: false, reason: "config_changed" });
  ({ db, b } = await rescueSetup({ ...REPO_SQL, ...PROBE_SQL }, { orchestratorReads: "executor_probe" }));
  assert.deepEqual(await choose(db, b), { ok: false, reason: "orchestrator_needs_pending_migration:orchestrator_reads_migration", file: PROBE });
  ({ db, b } = await rescueSetup());
  db.raw.prepare(`INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
    VALUES ('dep_busy', 'cryptophys-ai-kernel', ?, 'consensus:p', 'approved', 'p', 'k', '{"executor":"native:deploy"}', ?, ?)`).run(NEW, new Date().toISOString(), new Date().toISOString());
  assert.deepEqual(await choose(db, b), { ok: false, reason: "deploy_in_progress" });

  // Through the plan, a refusal fails the step (the owner hears of a failed plan) and is audited.
  ({ db, b } = await rescueSetup());
  const { env, wf } = recoveryEnv(db, b);
  const cf = fakeCloudflare();
  routeFetch(cf);
  freezeDate(nextSafeMinute(Date.now()));
  try {
    const id = await approvedPlan(env, ORCHESTRATOR_SERVICE, { destructive_migrations: ["0991_some_drop.sql"] });
    assert.equal((await runLifecycle(env as never, id, id, wf.step(id) as never)).final_status, "failed");
    assert.equal(pipeline(db, id)[2].detail, "rescue deploy refused: orchestrator_applies_no_migrations; nothing in production changed");
    assert.deepEqual([cf.uploads.length, cf.deployments.length], [0, 0]);
    assert.equal(events(db, "deployment.rescue_refused").length, 1);
  } finally { restoreDate(); globalThis.fetch = realFetch; }
});

test("GEF-8. outside a deploy minute nothing is read or written; the Registry records a rescue only for the Orchestrator's executing break-glass plan", async () => {
  const { db, b } = await rescueSetup();
  const { env } = recoveryEnv(db, b);
  const unsafe = (() => { const t = Math.ceil(Date.now() / 60_000) * 60_000; for (let i = 0; i < 60; i++) if (!(SAFE_MINUTES as number[]).includes(new Date(t + i * 60_000).getUTCMinutes())) return t + i * 60_000; return t; })();
  assert.equal((await rescueForRecovery(env as never, "plan_x", "dec_x", { now: unsafe })).status, "not_now");
  assert.ok(msToRescueMinute(unsafe) > 0 && msToRescueMinute(unsafe) <= 8 * 60_000);
  assert.equal(msToRescueMinute(nextSafeMinute(Date.now())), 0);
  // The Registry: a rescue row for another Worker, or without the executing plan, records nothing.
  const at = new Date().toISOString();
  const row = (id: string, service: string, plan: string) => db.raw.prepare(`INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`).run(id, service, NEW, `recovery:${plan}`, plan, `k-${id}`, JSON.stringify({ executor: RESCUE_EXECUTOR, plan_id: plan }), at, at);
  row("dep_11111111-1111-4111-8111-111111111111", "cryptophys-ai-kernel", "plan_x");
  await assert.rejects(recordNativeDeploy({ DB: db } as never, "dep_11111111-1111-4111-8111-111111111111"), /rescue_not_the_orchestrator/);
  row("dep_22222222-2222-4222-8222-222222222222", ORCHESTRATOR_SERVICE, "plan_x");
  await assert.rejects(recordNativeDeploy({ DB: db } as never, "dep_22222222-2222-4222-8222-222222222222"), /rescue_plan_invalid/);
  assert.equal(desired(db, ORCHESTRATOR_SERVICE), tag(OLD));
});

test("GEF-9. wiring: the rescue path imports nothing of the Orchestrator, mirrors its constants, is a guard path, and the Recovery Manager binds what it needs", () => {
  // Transitive imports of the rescue executor and of the Recovery Manager's step: never workers/deployment-orchestrator/.
  const seen = new Set<string>();
  const walk = (url: URL) => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const text = readFileSync(url, "utf8");
    for (const m of text.matchAll(/^(?:import|export)\s[^;]*?from\s+"(\.[^"]+)"/gm)) walk(new URL(m[1], url));
  };
  walk(new URL("workers/control-plane-shared/src/executor-rescue.ts", ROOT));
  walk(new URL("workers/recovery-manager/src/autonomous.ts", ROOT));
  const files = [...seen].map((h) => h.slice(ROOT.href.length));
  assert.ok(files.includes("workers/control-plane-shared/src/executor-first.ts"));
  assert.deepEqual(files.filter((f) => f.startsWith("workers/deployment-orchestrator/")), [], "no Orchestrator code on the rescue path");
  // The same deploy minutes and kept binding types as the Orchestrator's executor.
  assert.deepEqual([...RESCUE_MINUTES], [...SAFE_MINUTES]);
  assert.deepEqual([...RESCUE_KEEP_BINDINGS], [...KEEP_BINDINGS]);
  // The owner's rules.
  assert.equal(criticalPathReason("workers/control-plane-shared/src/executor-rescue.ts"), "break_glass");
  assert.equal(criticalPathReason("workers/control-plane-shared/src/break-glass.ts"), "break_glass");
  // The Recovery Manager's bindings for it; the secrets are the owner's and never in the file.
  const wrangler = read("workers/recovery-manager/wrangler.toml");
  assert.match(wrangler, /\[\[r2_buckets\]\]\nbinding = "BUNDLES"\nbucket_name = "cryptophys-forge-bundles"/);
  assert.match(wrangler, /\[\[services\]\]\nbinding = "DRIFT"\nservice = "cryptophys-drift-detector"\nentrypoint = "DriftRpc"/);
  assert.match(wrangler, /\[\[services\]\]\nbinding = "REGISTRY"\nservice = "cryptophys-platform-registry"\nentrypoint = "RegistryRpc"/);
  assert.doesNotMatch(wrangler, /^CF_ORCHESTRATOR_DEPLOY_TOKEN\s*=/m);
  // force_redeploy_unit of the Orchestrator's unit goes to the rescue step before the DeployRpc path is considered.
  const autonomous = read("workers/recovery-manager/src/autonomous.ts");
  const branch = autonomous.indexOf("if (unitForService(plan.service_id)?.unit === ORCHESTRATOR_UNIT) return rescueStep(");
  assert.ok(branch > 0 && branch < autonomous.indexOf("env.DEPLOY?.forceDeployForRecovery"));
  // The runbook names the secret and the drill.
  const ops = read("docs/OPERATIONS.md");
  assert.match(ops, /## Rescue deploy of the Deployment Orchestrator/);
  assert.match(ops, /CF_ORCHESTRATOR_DEPLOY_TOKEN/);
});

test("GEF-10. a rescue report the kernel does not store is never silent: deployment.rescue_report_failed with the reason, and the step's detail says so (incident 2026-11-16)", async () => {
  // plan_b94d06cf (2026-11-16 10:17): the rescue succeeded, but the Recovery Manager's AGENTS call never reached the
  // Policy Engine and nothing recorded why. The kernel's own AgentRpc refusal for a binding without props.host_worker
  // (agent-rpc.ts resolve) is used here, not a stand-in.
  const kernelWithoutProps = (db: Db) => ({ syscall: (agent: string, cap: string, input: any) => rpcSyscall({ DB: db } as never, undefined, agent, cap, input) });
  const stored = (db: Db) => (db.raw.prepare("SELECT COUNT(*) AS n FROM agent_reports WHERE agent_id = 'recovery-manager'").get() as any).n;

  // Succeeded: production is changed and recorded as before; the lost warning (the owner's notice) is audited.
  {
    const { db, b } = await rescueSetup();
    const { env, wf } = recoveryEnv(db, b, { agents: kernelWithoutProps(db) });
    routeFetch(fakeCloudflare());
    freezeDate(nextSafeMinute(Date.now()));
    try {
      const id = await approvedPlan(env);
      observeInSync(db, ORCHESTRATOR_SERVICE);
      assert.equal((await fastTimers(() => runLifecycle(env as never, id, id, wf.step(id) as never))).final_status, "completed", "a lost report never fails the deploy");
      assert.equal(desired(db, ORCHESTRATOR_SERVICE), tag(NEW));
      assert.equal(stored(db), 0);
      const row = requests(db).find((r) => JSON.parse(r.details_json).executor === RESCUE_EXECUTOR);
      const lost = events(db, "deployment.rescue_report_failed");
      assert.deepEqual(lost.map((e) => e.payload), [{ request_id: row.request_id, plan_id: id, commit_sha: NEW, severity: "warning", alert_key: `break_glass:${row.request_id}`,
        rescue_outcome: "succeeded", reason: "caller_identity_missing" }]);
      assert.deepEqual(events(db, "deployment.rescue_").map((e) => e.type), ["deployment.rescue_started", "deployment.rescue_succeeded", "deployment.rescue_report_failed"]);
      assert.match(pipeline(db, id)[2].detail, /succeeded without the Orchestrator \(request dep_[0-9a-f-]+; its report was not stored \(caller_identity_missing\), audited as deployment\.rescue_report_failed\)$/);
      assert.equal((await verifyAuditChain(db as never)).valid, true);
    } finally { restoreDate(); globalThis.fetch = realFetch; }
  }

  // Failed: the critical report (the consensus brake) is lost too; the audit names its severity and a thrown RPC error.
  {
    const { db, b } = await rescueSetup();
    const { env, wf } = recoveryEnv(db, b, { probeTag: tag(OLD), agents: { syscall: async () => { throw new Error("kernel unreachable"); } } });
    routeFetch(fakeCloudflare());
    freezeDate(nextSafeMinute(Date.now()));
    try {
      const id = await approvedPlan(env);
      assert.equal((await fastTimers(() => runLifecycle(env as never, id, id, wf.step(id) as never))).final_status, "failed");
      assert.equal(stored(db), 0);
      const lost = events(db, "deployment.rescue_report_failed");
      assert.deepEqual(lost.map((e) => [e.payload.severity, e.payload.rescue_outcome, e.payload.reason]), [["critical", "failed", "kernel unreachable"]]);
      assert.match(pipeline(db, id)[2].detail, /failed: not_live_at_tag .*restored; its report was not stored \(kernel unreachable\), audited as deployment\.rescue_report_failed\)$/);
    } finally { restoreDate(); globalThis.fetch = realFetch; }
  }

  // A stored report adds nothing: no audit event, the detail as before.
  {
    const { db, b } = await rescueSetup();
    const { env, wf } = recoveryEnv(db, b);
    routeFetch(fakeCloudflare());
    freezeDate(nextSafeMinute(Date.now()));
    try {
      const id = await approvedPlan(env);
      observeInSync(db, ORCHESTRATOR_SERVICE);
      assert.equal((await fastTimers(() => runLifecycle(env as never, id, id, wf.step(id) as never))).final_status, "completed");
      assert.deepEqual(events(db, "deployment.rescue_report_failed"), []);
      assert.match(pipeline(db, id)[2].detail, /succeeded without the Orchestrator \(request dep_[0-9a-f-]+\)$/);
    } finally { restoreDate(); globalThis.fetch = realFetch; }
  }
});
