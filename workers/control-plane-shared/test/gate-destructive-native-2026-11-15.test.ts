// Cut-over gate (owner 2026-11-15, "1 setuju"): "a migration the Forge marks destructive has no native path"
// (docs/GITHUB-CUTOVER.md, open before step 6). On 2026-11-15 migration 0069 went through deploy-control-plane.yml,
// which logs a pre-migration D1 bookmark; after step 6 that workflow is gone.
//
// Now a Control Plane deploy whose pending migrations include destructive ones is the critical consensus action
// deploy_destructive_migration (the owner's click), never a routine deploy_commit. After the click the native deploy
// reads and records D1's Time Travel bookmark (request details and the audit event deployment.restore_point_recorded)
// before any migration runs, applies only the named destructive files, and reports the bookmark on failure. It never
// restores D1 itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, accessCertsResponse, baseEnv, fakeAi, forgeSees, isAccessCerts, migratedDb, lastReviewedRecord } from "./harness.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { DEPLOY_UNITS, unitForService } from "../src/deploy-units.ts";
import { castVote, classify, CONSENSUS_ACTIONS, destructiveDeployVote, type Evidence } from "../src/consensus-rules.ts";
import { D1_BOOKMARK_PERMISSION, DESTRUCTIVE_DEPLOY_ACTION, RESTORE_POINT_EVENT, destructiveDeployParams, restoreCommand } from "../src/destructive-deploy.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import { storeBundles, type BuiltModule, type BundleBucket } from "../../forge/src/bundles.ts";
import {
  DeploymentLock, DESTRUCTIVE_DEPLOY_EXECUTOR, deployDestructiveForConsensus, deployForConsensus, destructiveLockName, destructiveMigrationsPending,
  pendingDeploys, runNativeExecutors,
} from "../../deployment-orchestrator/src/index.ts";
import { SAFE_MINUTES } from "../../deployment-orchestrator/src/native-rollback.ts";
import { nativeDeployEligible, readManifest } from "../../deployment-orchestrator/src/native-deploy.ts";
import { d1DatabaseId } from "../../deployment-orchestrator/src/d1-restore-point.ts";
import { recordNativeDeploy, recordRollback } from "../../platform-registry/src/index.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { ownerDecide, PHASE4_EXECUTABLE } from "../../ai-kernel/src/consensus.ts";
import { runCycle } from "../../ai-kernel/src/supervisor.ts";
import { pendingApprovals } from "../../ai-kernel/src/owner-inbox.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const ACCOUNT = "a".repeat(32);
const OLD = "0a".repeat(20);
const NEW = "1b".repeat(20);
const CONTROL_PLANE = unitForService("cryptophys-policy-engine")!;
const TARGET = CONTROL_PLANE.services[0];
const realFetch = globalThis.fetch;
const enc = new TextEncoder();

const MIG_DIR = "workers/control-plane-migrations/";
const REPO_MIGRATIONS = readdirSync(new URL(MIG_DIR, ROOT)).filter((f) => f.endsWith(".sql")).sort();
const REPO_SQL: Record<string, string> = Object.fromEntries(REPO_MIGRATIONS.map((f) => [f, read(MIG_DIR + f)]));
const ADDITIVE = { "0990_gate_probe.sql": "-- additive probe\nCREATE TABLE gate_probe (id TEXT PRIMARY KEY);\n" };
const DROP = { "0991_gate_drop.sql": "-- destructive probe\nCREATE TABLE gate_tmp (id TEXT);\nDROP TABLE gate_tmp;\n" };
const REWRITE = { "0992_gate_rewrite.sql": "-- destructive probe\nUPDATE consensus_controls SET updated_by = updated_by WHERE control = 'mode';\n" };

const ORCH_VERSION = "0ccccccc-0000-4000-8000-000000000001";
const D1_ID = "0d1d1d1d-0000-4000-8000-000000000001";
const BOOKMARK = "00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683";

const sha256 = async (t: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const nextSafeMinute = (after: number): number => {
  const first = Math.ceil(after / 60_000) * 60_000;
  for (let i = 0; i < 60; i++) { const c = first + i * 60_000; if (SAFE_MINUTES.includes(new Date(c).getUTCMinutes())) return c; }
  throw new Error("no safe minute found");
};

// ---------------------------------------------------------------- the Forge's bundles (R2)
function bucket() {
  const objects = new Map<string, string | Uint8Array>();
  const b = {
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
async function bundlesFor(b: Bucket, commit: string, sql: Record<string, string>) {
  const built: BuiltModule[] = [];
  for (const u of DEPLOY_UNITS) for (const name of u.services) {
    if (name === "cryptophys-console") continue;
    built.push({ dir: `workers/${name.replace("cryptophys-", "")}`, text: `export default { fetch() { return new Response("${name} ${commit.slice(0, 12)}"); } };`, toml: toml(name), external: [] });
  }
  await storeBundles(b, commit, built, Date.now(), Object.keys(sql), { migrationSql: sql, externals: async () => new Map() });
}

// ---------------------------------------------------------------- the lock, Cloudflare (Workers and D1 Time Travel)
function lockNs() {
  const stores = new Map<string, Map<string, unknown>>();
  return { stores, idFromName: (n: string) => n, get: (id: unknown) => {
    const key = String(id); if (!stores.has(key)) stores.set(key, new Map()); const data = stores.get(key)!;
    const lock = new DeploymentLock({ storage: { get: async (k: string) => data.get(k) as never, put: async (k: string, v: unknown) => { data.set(k, v); }, delete: async (k: string) => data.delete(k) }, blockConcurrencyWhile: (cb) => cb() });
    return { fetch: (i: RequestInfo | URL, init?: RequestInit) => lock.fetch(new Request(i, init)) };
  } };
}
const BINDINGS = [{ type: "d1", name: "DB", id: D1_ID }, { type: "version_metadata", name: "CF_VERSION_METADATA" }];
/** `bookmark`: what the Time Travel endpoint answers (ok, 403 for a token without D1 Read, or a 500). */
function fakeCloudflare(services: readonly string[]) {
  const scripts = new Map<string, { active: { version_id: string; percentage: number }[]; versions: Map<string, { bindings: unknown[] }> }>();
  let v = 0;
  const uuid = () => `${String(++v).padStart(8, "0")}-0000-4000-8000-000000000000`;
  for (const s of services) { const id = uuid(); scripts.set(s, { active: [{ version_id: id, percentage: 100 }], versions: new Map([[id, { bindings: structuredClone(BINDINGS) }]]) }); }
  scripts.set("cryptophys-deployment-orchestrator", { active: [{ version_id: ORCH_VERSION, percentage: 100 }], versions: new Map([[ORCH_VERSION, { bindings: structuredClone(BINDINGS) }]]) });
  const state = { bookmark: "ok" as "ok" | "forbidden" | "error" };
  const calls: string[] = [];
  const uploads: string[] = [];
  const deployments: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const d1 = new RegExp(`^https://api\\.cloudflare\\.com/client/v4/accounts/${ACCOUNT}/d1/database/([0-9a-f-]+)/time_travel/bookmark$`).exec(url);
    if (d1) {
      assert.equal(method, "GET", "the bookmark is only ever read; nothing restores D1");
      assert.equal(d1[1], D1_ID, "the database of the Orchestrator's own DB binding");
      calls.push("d1:bookmark");
      if (state.bookmark === "forbidden") return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });
      if (state.bookmark === "error") return Response.json({ success: false, errors: [{ code: 7500 }] }, { status: 500 });
      return Response.json({ success: true, result: { bookmark: BOOKMARK } });
    }
    const m = new RegExp(`^https://api\\.cloudflare\\.com/client/v4/accounts/${ACCOUNT}/workers/scripts/([a-z0-9-]+)/(.*)$`).exec(url);
    assert.ok(m, `unexpected ${url}`);
    const [, script, rest] = m!;
    const s = scripts.get(script);
    assert.ok(s, `unexpected script ${script}`);
    if (rest === "deployments" && method === "GET") return Response.json({ success: true, result: { deployments: [{ created_on: "2026-11-15T00:00:00Z", versions: s!.active }] } });
    if (rest === "deployments" && method === "POST") { calls.push(`deploy:${script}`); deployments.push(script); s!.active = JSON.parse(String(init!.body)).versions; return Response.json({ success: true, result: { id: "dep" } }); }
    if (rest === "versions" && method === "POST") {
      calls.push(`upload:${script}`); uploads.push(script);
      const id = uuid();
      s!.versions.set(id, { bindings: structuredClone(BINDINGS) });
      return Response.json({ success: true, result: { id, number: v } });
    }
    const vm = /^versions\/([0-9a-f-]{36})$/.exec(rest);
    if (vm && method === "GET") return Response.json({ success: true, result: { id: vm[1], resources: { bindings: s!.versions.get(vm[1])!.bindings } } });
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  return { fetcher, calls, uploads, deployments, state };
}
type Cf = ReturnType<typeof fakeCloudflare>;

function orchestrator(db: Db, b: Bucket, live = true) {
  const reports: any[] = [];
  const env = baseEnv("cryptophys-deployment-orchestrator", db, {
    GH_ACTIONS_TOKEN: "", DEPLOYMENT_LOCK: lockNs(), CF_DEPLOY_TOKEN: "deploy-token", CF_ACCOUNT_ID: ACCOUNT, BUNDLES: b,
    CF_VERSION_METADATA: { id: ORCH_VERSION, tag: OLD.slice(0, 12) },
    DRIFT: { probeService: async () => ({ reachable: true, healthy: true, version_tag: live ? NEW.slice(0, 12) : OLD.slice(0, 12), error: null }) },
    REGISTRY: { recordRollback: (id: string) => recordRollback({ DB: db } as never, id), recordNativeDeploy: (id: string) => recordNativeDeploy({ DB: db } as never, id) },
    AGENTS: { syscall: async (agent: string, _cap: string, input: any) => {
      reports.push({ agent, ...input });
      db.raw.prepare(`INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
        .run(`rpt_${crypto.randomUUID()}`, agent, input.kind, input.severity, input.subject, JSON.stringify(input.body), input.ai_status ?? "ok", new Date().toISOString());
      return { outcome: "succeeded" };
    } },
  });
  return { env, reports };
}

/** The AI Kernel wired to the Orchestrator the way DeployRpc is (worker.ts). */
function kernel(db: Db, orch: Record<string, unknown>, cf: Cf) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const mem = new Map<string, unknown>();
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async () => ({}) },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    DEPLOY: {
      pendingDeploys: () => pendingDeploys(orch as never),
      deployForConsensus: (id: string, dec: string, target: string, params: Record<string, unknown>) => deployForConsensus(orch as never, id, dec, target, params),
      retireForConsensus: async () => { throw new Error("not in this test"); },
      destructiveMigrations: (sha: string) => destructiveMigrationsPending(orch as never, sha),
      deployDestructiveForConsensus: (id: string, dec: string, target: string, params: Record<string, unknown>) => deployDestructiveForConsensus(orch as never, id, dec, target, params, cf.fetcher),
    },
  };
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, structuredClone(v)); } };
  return { env, memory };
}

const noFetch = () => {
  globalThis.fetch = (async (i: RequestInfo | URL) => {
    if (isAccessCerts(String(i))) return accessCertsResponse();
    throw new Error(`no network call expected: ${String(i)}`);
  }) as typeof fetch;
};

/** Production runs OLD; main is NEW with `extra` migrations; the Forge planned the Control Plane for NEW. */
async function setup(extra: Record<string, string>) {
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  db.raw.prepare("UPDATE service_registry SET desired_version = ?").run(OLD.slice(0, 12));
  const b = bucket();
  await bundlesFor(b, OLD, REPO_SQL);
  await bundlesFor(b, NEW, { ...REPO_SQL, ...extra });
  await forgeSees(db, { main: NEW, files: Object.keys(extra).map((f) => MIG_DIR + f), ready: true });
  return { db, b };
}
const ledger = (db: Db) => (db.raw.prepare("SELECT name FROM d1_migrations ORDER BY id").all() as any[]).map((r) => r.name as string);
const tableExists = (db: Db, name: string) => Boolean(db.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const events = (db: Db, prefix: string) => (db.raw.prepare("SELECT event_type, payload_json FROM audit_events WHERE event_type LIKE ? ORDER BY rowid").all(`${prefix}%`) as any[])
  .map((r) => ({ type: r.event_type as string, payload: JSON.parse(r.payload_json) }));
const proposals = (db: Db, action?: string) => (db.raw.prepare("SELECT * FROM consensus_proposals ORDER BY created_at, rowid").all() as any[]).filter((p) => !action || p.action === action);
const requests = (db: Db) => db.raw.prepare("SELECT request_id, service_id, requested_by, idempotency_key, status, details_json FROM deployment_requests ORDER BY created_at").all() as any[];
const desired = (db: Db, svc: string) => (db.raw.prepare("SELECT desired_version FROM service_registry WHERE service_id = ?").get(svc) as any).desired_version;
async function named(b: Bucket, ...files: string[]) {
  const m = (await readManifest(b, NEW))!;
  return files.map((file) => ({ file, sha256: m.migration_files!.find((f) => f.file === file)!.sha256 }));
}
const aged = (db: Db, id: string) => db.raw.prepare("UPDATE consensus_proposals SET created_at = ? WHERE proposal_id = ?").run(new Date(Date.now() - 7 * 3_600_000).toISOString(), id);
/** A deploy_destructive_migration the Supervisor proposes (the council votes, the Policy Engine checks): pending_owner. */
async function propose(env: Record<string, unknown>, db: Db, files: Array<{ file: string; sha256: string }>) {
  const r = await syscall(env as never, "supervisor", "consensus.propose", { action: DESTRUCTIVE_DEPLOY_ACTION, target: TARGET, params: { commit_sha: NEW, unit: "control-plane", destructive_migrations: files } });
  assert.equal(r.outcome, "succeeded", JSON.stringify(r));
  const p = proposals(db, DESTRUCTIVE_DEPLOY_ACTION).at(-1);
  assert.equal(p.status, "pending_owner", p.outcome_json);
  return p.proposal_id as string;
}

// ---------------------------------------------------------------- tests
test("GD-1. deploy_destructive_migration is critical and every seat checks its params; deploy_commit stays routine", () => {
  assert.equal(classify(DESTRUCTIVE_DEPLOY_ACTION), "critical");
  assert.equal(classify("deploy_commit"), "routine");
  assert.equal(CONSENSUS_ACTIONS[DESTRUCTIVE_DEPLOY_ACTION].target, "service");
  assert.ok(PHASE4_EXECUTABLE.has(DESTRUCTIVE_DEPLOY_ACTION), "the owner's click has an executor");
  const ok = { commit_sha: NEW, unit: "control-plane", destructive_migrations: [{ file: "0991_gate_drop.sql", sha256: "c".repeat(64) }] };
  assert.ok(!("problem" in destructiveDeployParams(ok)));
  for (const [bad, why] of [
    [{ ...ok, commit_sha: NEW.slice(0, 12) }, /full 40-hex/],
    [{ ...ok, unit: "console" }, /control-plane unit/],
    [{ ...ok, destructive_migrations: [] }, /1 to 10/],
    [{ ...ok, destructive_migrations: [{ file: "0991_gate_drop.sql" }] }, /sha256/],
    [{ ...ok, destructive_migrations: [{ file: "../x.sql", sha256: "c".repeat(64) }] }, /NNNN_name/],
    [{ ...ok, destructive_migrations: [ok.destructive_migrations[0], ok.destructive_migrations[0]] }, /twice/],
    [{ ...ok, destructive_migrations: [{ file: "0992_b.sql", sha256: "c".repeat(64) }, { file: "0991_a.sql", sha256: "c".repeat(64) }] }, /file order/],
  ] as const) {
    const p = destructiveDeployParams(bad as never);
    assert.ok("problem" in p, JSON.stringify(bad)); assert.match((p as { problem: string }).problem, why);
  }
  const e: Evidence = { agents_enabled: true, audit_valid: true, services: {}, registry: { [TARGET]: { status: "registered", desired_version: OLD.slice(0, 12) } }, agents: {}, critical_reports_24h: 0, executing_plan_targets: [], recent_same: 0 };
  const p = (params: Record<string, unknown>, target = TARGET) => ({ action: DESTRUCTIVE_DEPLOY_ACTION, target, params, class: "critical" as const });
  for (const voter of ["platform-api", "deployment-orchestrator", "platform-registry", "policy-engine", "drift-detector", "audit-ledger", "recovery-manager", "supervisor", "auditor"]) {
    assert.equal(castVote(voter, p(ok), e).vote, "approve", voter);
    assert.equal(castVote(voter, p({ ...ok, destructive_migrations: [] }), e).vote, "reject", `${voter}: malformed`);
    assert.equal(castVote(voter, p(ok, "cryptophys-console"), e).vote, "reject", `${voter}: not a Control Plane Worker`);
    assert.equal(castVote(voter, p(ok), { ...e, critical_reports_24h: 1 }).vote, "reject", `${voter}: the brake holds it too`);
  }
  assert.equal(destructiveDeployVote({ action: "deploy_commit", target: TARGET, params: {}, class: "routine" }), null);
});

test("GD-2. a destructive pending migration produces an owner-click proposal, not a routine deploy", async () => {
  const { db, b } = await setup({ ...ADDITIVE, ...DROP });
  const cf = fakeCloudflare([...CONTROL_PLANE.services]);
  const { env: orch } = orchestrator(db, b);
  const { env, memory } = kernel(db, orch, cf);
  noFetch();
  try {
    // The routine native deploy refuses it, as before the gate.
    const routine = await nativeDeployEligible({ DB: db as never, BUNDLES: b }, CONTROL_PLANE, NEW);
    assert.deepEqual(routine.eligible ? null : [routine.reason, routine.file], ["destructive_migration", "0991_gate_drop.sql"]);
    assert.deepEqual(await destructiveMigrationsPending(orch as never, NEW), { ok: true, commit_sha: NEW, migrations: await named(b, "0991_gate_drop.sql") });

    const cycle = await runCycle(env as never, memory, "scheduled");
    assert.ok(cycle.findings.some((f: any) => f.kind === "deploy" && /destructive migrations need the owner: 0991_gate_drop\.sql/.test(f.why ?? "")), JSON.stringify(cycle.findings.filter((f: any) => f.kind === "deploy")));
    assert.equal(proposals(db, "deploy_commit").length, 0, "no routine deploy_commit");
    const ps = proposals(db, DESTRUCTIVE_DEPLOY_ACTION);
    assert.equal(ps.length, 1);
    assert.deepEqual([ps[0].target, ps[0].class, ps[0].status], [TARGET, "critical", "pending_owner"]);
    const params = JSON.parse(ps[0].params_json);
    assert.deepEqual([params.commit_sha, params.unit, params.destructive_migrations], [NEW, "control-plane", await named(b, "0991_gate_drop.sql")]);
    assert.equal(params.destructive_migrations[0].sha256, await sha256(DROP["0991_gate_drop.sql"]), "the owner approves exactly that SQL");
    // Nothing moved: no request, no migration, no Cloudflare call.
    assert.deepEqual([requests(db).length, ledger(db).length, cf.calls.length], [0, REPO_MIGRATIONS.length, 0]);
    // The Owner page lists it, with what it applies, and the click has an executor.
    const inbox = (await pendingApprovals(db as never)).consensus;
    assert.deepEqual(inbox.map((c) => [c.action, c.executable]), [[DESTRUCTIVE_DEPLOY_ACTION, true]]);
    assert.match((inbox[0] as unknown as { changes: string[] }).changes[0], /^apply destructive migration 0991_gate_drop\.sql \(sha256 [0-9a-f]{12}\) after recording a D1 Time Travel bookmark$/);
    // The next cycle does not propose it again while it waits for the owner.
    await runCycle(env as never, memory, "scheduled");
    assert.deepEqual([proposals(db, DESTRUCTIVE_DEPLOY_ACTION).length, proposals(db, "deploy_commit").length], [1, 0]);
  } finally { globalThis.fetch = realFetch; }
});

test("GD-3. after the owner's click the bookmark is read and recorded before any migration runs, and only the named destructive files apply", async () => {
  const { db, b } = await setup({ ...ADDITIVE, ...DROP });
  const cf = fakeCloudflare([...CONTROL_PLANE.services]);
  const { env: orch, reports } = orchestrator(db, b);
  const { env, memory } = kernel(db, orch, cf);
  noFetch();
  try {
    await runCycle(env as never, memory, "scheduled");
    const id = proposals(db, DESTRUCTIVE_DEPLOY_ACTION)[0].proposal_id;
    const decided = await ownerDecide(env as never, id, "approve", APPROVER_EMAIL, "0991 reviewed") as any;
    assert.equal(decided.status, "executed", JSON.stringify(decided));
    assert.deepEqual([decided.outcome.result.dispatched, decided.outcome.result.executor, decided.outcome.result.destructive_migrations], [true, DESTRUCTIVE_DEPLOY_EXECUTOR, ["0991_gate_drop.sql"]]);
    assert.deepEqual(cf.calls, ["d1:bookmark"], "the click checks the bookmark can be read; nothing else moves");
    assert.deepEqual(ledger(db).length, REPO_MIGRATIONS.length);
    const [row] = requests(db);
    assert.deepEqual([row.requested_by, row.idempotency_key, row.status, JSON.parse(row.details_json).executor],
      [`consensus:${id}`, `${destructiveLockName(CONTROL_PLANE, NEW)}:${id}`, "approved", DESTRUCTIVE_DEPLOY_EXECUTOR]);

    cf.calls.length = 0;
    assert.deepEqual(await runNativeExecutors(orch as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 1 });
    // The bookmark first, then the Workers: no upload before it (the migrations run between, through D1).
    assert.equal(cf.calls[0], "d1:bookmark");
    assert.equal(cf.calls.filter((c) => c === "d1:bookmark").length, 1);
    assert.deepEqual(cf.uploads, [...CONTROL_PLANE.services]);
    const types = events(db, "deployment.").map((e) => e.type);
    const at = (t: string) => types.indexOf(t);
    assert.ok(at(RESTORE_POINT_EVENT) >= 0 && at(RESTORE_POINT_EVENT) < at("deployment.native_migration_applied"), types.join(", "));
    const recorded = events(db, RESTORE_POINT_EVENT);
    assert.equal(recorded.length, 1);
    assert.deepEqual([recorded[0].payload.bookmark, recorded[0].payload.database_id, recorded[0].payload.destructive_migrations, recorded[0].payload.restore],
      [BOOKMARK, D1_ID, ["0991_gate_drop.sql"], restoreCommand(BOOKMARK)]);
    // Only main's pending files apply: the additive one and the named destructive one, in order.
    assert.deepEqual(ledger(db).slice(REPO_MIGRATIONS.length), ["0990_gate_probe.sql", "0991_gate_drop.sql"]);
    assert.ok(tableExists(db, "gate_probe"));
    assert.equal(tableExists(db, "gate_tmp"), false);
    const done = requests(db)[0];
    const details = JSON.parse(done.details_json);
    assert.equal(done.status, "succeeded");
    assert.deepEqual([details.restore_point.bookmark, details.outcome.restore_point.bookmark, details.outcome.migrations_applied], [BOOKMARK, BOOKMARK, ["0990_gate_probe.sql", "0991_gate_drop.sql"]]);
    assert.ok(details.outcome.steps.indexOf("d1:restore_point_recorded") < details.outcome.steps.indexOf("migration:0991_gate_drop.sql:applied"));
    for (const s of CONTROL_PLANE.services) assert.equal(desired(db, s), NEW.slice(0, 12));
    assert.equal(events(db, "deployment.destructive_deploy_succeeded").length, 1);
    assert.equal(reports.filter((r) => r.severity === "critical").length, 0);
    assert.equal((await verifyAuditChain(db as never)).valid, true);
  } finally { globalThis.fetch = realFetch; }
});

test("GD-4. destructive files the approval does not name, with other SQL, or no longer pending are refused before anything is queued", async () => {
  const { db, b } = await setup({ ...DROP, ...REWRITE });
  const cf = fakeCloudflare([...CONTROL_PLANE.services]);
  const { env: orch } = orchestrator(db, b);
  const { env } = kernel(db, orch, cf);
  noFetch();
  try {
    const refusedWith = async (files: Array<{ file: string; sha256: string }>, reason: RegExp) => {
      const id = await propose(env, db, files);
      const decided = await ownerDecide(env as never, id, "approve", APPROVER_EMAIL, "ok") as any;
      assert.equal(decided.status, "failed");
      assert.match(decided.outcome.error, reason);
      aged(db, id); // the policy voter rejects the same action and target proposed within 6 h
      return events(db, "deployment.destructive_refused").at(-1)!.payload;
    };
    // 0992 is destructive and not named.
    let r = await refusedWith(await named(b, "0991_gate_drop.sql"), /destructive_deploy_refused: destructive_migration$/);
    assert.deepEqual([r.reason, r.file], ["destructive_migration", "0992_gate_rewrite.sql"]);
    // The SQL the owner approved is not the SQL main has.
    r = await refusedWith([{ file: "0991_gate_drop.sql", sha256: "c".repeat(64) }, (await named(b, "0992_gate_rewrite.sql"))[0]], /named_migration_sha256_mismatch/);
    assert.equal(r.file, "0991_gate_drop.sql");
    // A named file that is not a pending destructive migration.
    r = await refusedWith([...await named(b, "0991_gate_drop.sql", "0992_gate_rewrite.sql"), { file: "0999_gate_missing.sql", sha256: "d".repeat(64) }], /named_migration_not_pending_destructive/);
    assert.equal(r.file, "0999_gate_missing.sql");
    assert.deepEqual([requests(db).length, ledger(db).length, cf.calls.length], [0, REPO_MIGRATIONS.length, 0], "nothing queued, applied or called");

    // Both named: queued. If main gains another destructive file before the cron runs, the run refuses it, moves nothing.
    const id = await propose(env, db, await named(b, "0991_gate_drop.sql", "0992_gate_rewrite.sql"));
    assert.equal(((await ownerDecide(env as never, id, "approve", APPROVER_EMAIL, "ok")) as any).status, "executed");
    const req = requests(db)[0];
    const details = JSON.parse(req.details_json);
    // An edited request (a third file added to the approval) fails its signature and runs nothing.
    const forged = { ...details, destructive_migrations: [...details.destructive_migrations, { file: "0993_more.sql", sha256: "e".repeat(64) }] };
    db.raw.prepare("UPDATE deployment_requests SET details_json = ? WHERE request_id = ?").run(JSON.stringify(forged), req.request_id);
    cf.calls.length = 0;
    assert.deepEqual(await runNativeExecutors(orch as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 0, succeeded: 0 });
    assert.match(JSON.parse(requests(db)[0].details_json).outcome.reason, /invalid_destructive_deploy_signature/);
    assert.deepEqual([cf.calls, ledger(db).length], [[], REPO_MIGRATIONS.length]);
    // The lock is free again, so a new approval for the commit can run.
    assert.equal(((orch as any).DEPLOYMENT_LOCK.stores.get(destructiveLockName(CONTROL_PLANE, NEW)) as Map<string, unknown>).size, 0);
  } finally { globalThis.fetch = realFetch; }
});

test("GD-5. a bookmark read failure refuses the deploy before any change and names the token permission", async () => {
  const { db, b } = await setup({ ...DROP });
  const cf = fakeCloudflare([...CONTROL_PLANE.services]);
  const { env: orch, reports } = orchestrator(db, b);
  const { env } = kernel(db, orch, cf);
  noFetch();
  try {
    // At the click: CF_DEPLOY_TOKEN may not read D1 (403). Nothing is queued; the audit names the permission.
    cf.state.bookmark = "forbidden";
    const first = await propose(env, db, await named(b, "0991_gate_drop.sql"));
    const decided = await ownerDecide(env as never, first, "approve", APPROVER_EMAIL, "ok") as any;
    assert.equal(decided.status, "failed");
    assert.match(decided.outcome.error, /destructive_deploy_refused: restore_point_unavailable/);
    const refused = events(db, "deployment.destructive_refused").at(-1)!.payload;
    assert.equal(refused.permission, D1_BOOKMARK_PERMISSION);
    assert.match(refused.error, /^d1_permission_missing: Account → D1 → Read/);
    assert.deepEqual([requests(db).length, cf.uploads.length, ledger(db).length], [0, 0, REPO_MIGRATIONS.length]);

    // At run time: the bookmark could be read at the click, not at the SAFE minute. The deploy stops before the migration.
    aged(db, first);
    cf.state.bookmark = "ok";
    const second = await propose(env, db, await named(b, "0991_gate_drop.sql"));
    assert.equal(((await ownerDecide(env as never, second, "approve", APPROVER_EMAIL, "ok")) as any).status, "executed");
    cf.state.bookmark = "error";
    cf.calls.length = 0;
    assert.deepEqual(await runNativeExecutors(orch as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 0 });
    assert.deepEqual(cf.calls, ["d1:bookmark"], "no upload, no deploy");
    assert.deepEqual([ledger(db).length, tableExists(db, "gate_tmp"), events(db, RESTORE_POINT_EVENT).length, events(db, "deployment.native_migration_applied").length], [REPO_MIGRATIONS.length, false, 0, 0]);
    const outcome = JSON.parse(requests(db)[0].details_json).outcome;
    assert.match(outcome.reason, /^restore_point_unavailable: cloudflare_d1_api_500/);
    assert.deepEqual([outcome.production_changed, outcome.restored, outcome.migrations_applied], [false, true, []]);
    for (const s of CONTROL_PLANE.services) assert.equal(desired(db, s), OLD.slice(0, 12));
    const critical = reports.filter((r) => r.severity === "critical");
    assert.equal(critical.length, 1);
    assert.match(critical[0].subject, /^Destructive migration deploy of control-plane at 1b1b1b1b1b1b failed$/);
    assert.match(critical[0].body.action_required, /nothing in production changed\. CF_DEPLOY_TOKEN needs Account → D1 → Read/);
    assert.equal(critical[0].body.d1_restore_point, null);
  } finally { globalThis.fetch = realFetch; }
});

test("GD-6. a failure after the destructive migration reports the bookmark and how to restore; D1 is never restored automatically", async () => {
  const { db, b } = await setup({ ...DROP });
  const cf = fakeCloudflare([...CONTROL_PLANE.services]);
  const { env: orch, reports } = orchestrator(db, b, false); // the new version never verifies live
  const { env } = kernel(db, orch, cf);
  noFetch();
  try {
    const id = await propose(env, db, await named(b, "0991_gate_drop.sql"));
    assert.equal(((await ownerDecide(env as never, id, "approve", APPROVER_EMAIL, "ok")) as any).status, "executed");
    cf.calls.length = 0;
    assert.deepEqual(await runNativeExecutors(orch as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 0 });
    // The migration stays (forward-only, no restore); the Worker that moved is restored.
    assert.equal(ledger(db).at(-1), "0991_gate_drop.sql");
    assert.equal(cf.calls.filter((c) => c === "d1:bookmark").length, 1, "only read, never a restore call");
    const critical = reports.filter((r) => r.severity === "critical");
    assert.equal(critical.length, 1, JSON.stringify(critical.map((c) => [c.agent, c.subject])));
    assert.deepEqual([critical[0].body.d1_restore_point.bookmark, critical[0].body.d1_restore_command, critical[0].body.restored], [BOOKMARK, restoreCommand(BOOKMARK), true]);
    assert.match(critical[0].body.action_required, new RegExp(`restore point recorded before the first destructive migration: ${BOOKMARK}.*not restored automatically`));
    assert.equal(JSON.parse(requests(db)[0].details_json).restore_point.bookmark, BOOKMARK);
  } finally { globalThis.fetch = realFetch; }
});

test("GD-7. a routine non-destructive deploy is unchanged: deploy_commit by consensus, no owner click, no bookmark", async () => {
  const { db, b } = await setup({ ...ADDITIVE });
  const cf = fakeCloudflare([...CONTROL_PLANE.services]);
  const { env: orch } = orchestrator(db, b);
  const { env, memory } = kernel(db, orch, cf);
  noFetch();
  try {
    assert.deepEqual(await destructiveMigrationsPending(orch as never, NEW), { ok: true, commit_sha: NEW, migrations: [] });
    await runCycle(env as never, memory, "scheduled");
    assert.equal(proposals(db, DESTRUCTIVE_DEPLOY_ACTION).length, 0);
    const [p] = proposals(db, "deploy_commit");
    assert.deepEqual([p.target, p.class, p.status], [TARGET, "routine", "executed"]);
    const [row] = requests(db);
    assert.equal(JSON.parse(row.details_json).executor, "native:deploy");
    assert.deepEqual(await runNativeExecutors(orch as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 1 });
    assert.ok(!cf.calls.includes("d1:bookmark"), "no Time Travel read for an additive migration");
    assert.equal(events(db, RESTORE_POINT_EVENT).length, 0);
    const details = JSON.parse(requests(db)[0].details_json);
    assert.deepEqual([details.restore_point, details.outcome.restore_point, details.outcome.migrations_applied], [undefined, undefined, ["0990_gate_probe.sql"]]);
    for (const s of CONTROL_PLANE.services) assert.equal(desired(db, s), NEW.slice(0, 12));
  } finally { globalThis.fetch = realFetch; }
});

test("GD-8. wiring: DeployRpc, the kernel binding, the Console's click, the bookmark reader and the docs", () => {
  const worker = read("workers/deployment-orchestrator/src/worker.ts");
  assert.match(worker, /async destructiveMigrations\(commitSha: string\)/);
  assert.match(worker, /async deployDestructiveForConsensus\(/);
  assert.match(read("workers/ai-kernel/src/syscall.ts"), /deployDestructiveForConsensus\?\(/);
  assert.match(read("workers/console/ui/src/pages/Consensus.tsx"), /"deploy_destructive_migration"/);
  assert.match(read("workers/platform-registry/src/index.ts"), /native:destructive-deploy/);
  assert.equal(d1DatabaseId(BINDINGS), D1_ID);
  assert.equal(d1DatabaseId([{ type: "d1", name: "OTHER", id: D1_ID }]), null);
  assert.equal(d1DatabaseId([{ type: "d1", name: "DB", id: "__CONTROL_PLANE_D1_DATABASE_ID__" }]), null);
  const ops = read("docs/OPERATIONS.md");
  assert.match(ops, /deploy_destructive_migration/);
  assert.match(ops, /deployment\.restore_point_recorded/);
  assert.match(ops, /D1 → Read/);
  assert.match(read("docs/GITHUB-CUTOVER.md"), /deploy_destructive_migration/);
  // The 2026-11-15 entry of the "Last reviewed" line (newer entries come first).
  assert.match(lastReviewedRecord(), /(?:^Last reviewed: |\); )2026-11-15 \([^\n]*deploy_destructive_migration/);
  // The rules every seat applies stay with the owner (guard paths).
  assert.equal(criticalPathReason("workers/control-plane-shared/src/consensus-rules.ts"), "consensus_kill_switch");
});
