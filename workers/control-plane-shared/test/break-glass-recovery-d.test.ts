// Hardening (d), 2026-11-14 (owner-approved): the break-glass recovery step force_redeploy_unit. The deploy planner had
// stopped planning any unit and no consensus path could deploy anything, its own fix included. An owner-approved
// recovery plan now deploys ONE unit at main's head natively from the Forge's bundles, applying the migrations D1 has
// not applied, without the planner and without a drift precondition, through the deploy lock, live verification and
// restore on failure, audited and reported to the owner's Telegram.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_JWT, OPERATOR_EMAIL, OPERATOR_JWT, accessCertsResponse, baseEnv, call, fakeWorkflow, isAccessCerts, migratedDb, req } from "./harness.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { DEPLOY_UNITS, unitForService } from "../src/deploy-units.ts";
import { OWNER_ONLY_STEP_ACTIONS, RECOVERY_STEP_ACTIONS } from "../src/capabilities.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import { approvedBreakGlassPlan, breakGlassPlanProblem, isPersonActor } from "../src/break-glass.ts";
import { forgeMainHead } from "../src/forge-gate.ts";
import { storeBundles, type BuiltModule, type BundleBucket } from "../../forge/src/bundles.ts";
import { DeploymentLock, deployForRecovery, forceDeployForRecovery, requestStatus, runNativeExecutors } from "../../deployment-orchestrator/src/index.ts";
import { SAFE_MINUTES } from "../../deployment-orchestrator/src/native-rollback.ts";
import { nativeDeployEligible, readManifest, readMigration } from "../../deployment-orchestrator/src/native-deploy.ts";
import { BREAK_GLASS_EXECUTOR, BREAK_GLASS_NOTICE_MS, resolveBreakGlassNotices, breakGlassChoice, breakGlassLockName, breakGlassRequestKey, pendingMigrations, recoveryMainHead } from "../../deployment-orchestrator/src/recovery-deploy.ts";
import { recordNativeDeploy, recordRollback } from "../../platform-registry/src/index.ts";
import recovery, { proposeFromAgent } from "../../recovery-manager/src/index.ts";
import { runLifecycle } from "../../recovery-manager/src/lifecycle.ts";
import { decide, evaluatePolicy, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { AI_DRAFT_STEP_ACTIONS, draftTask } from "../../ai-kernel/src/supervisor.ts";
import { reconcileNotices } from "../../ai-kernel/src/owner-notices.ts";
import { openCriticalReportRows, unhandledProblems } from "../../ai-kernel/src/owner-inbox.ts";
import { observe } from "../../ai-kernel/src/syscall.ts";
import { openCriticalReports } from "../../ai-kernel/src/consensus.ts";
import { baseline } from "../src/consensus-rules.ts";

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

const MIG_DIR = "workers/control-plane-migrations/";
const REPO_MIGRATIONS = readdirSync(new URL(MIG_DIR, ROOT)).filter((f) => f.endsWith(".sql")).sort();
const REPO_SQL: Record<string, string> = Object.fromEntries(REPO_MIGRATIONS.map((f) => [f, read(MIG_DIR + f)]));
const ADDITIVE = { "0990_break_glass_probe.sql": "-- additive probe\nCREATE TABLE break_glass_probe (id TEXT PRIMARY KEY);\n" };
const DESTRUCTIVE = { "0991_break_glass_drop.sql": "-- destructive probe\nCREATE TABLE break_glass_tmp (id TEXT);\nDROP TABLE break_glass_tmp;\n" };

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
async function bundlesFor(b: Bucket, commit: string, sql: Record<string, string> = REPO_SQL) {
  const built: BuiltModule[] = [];
  for (const u of DEPLOY_UNITS) for (const name of u.services) {
    // A Worker with static assets (the Console) is left out of the bundles: none of these tests deploys it.
    if (name === "cryptophys-console") continue;
    built.push({ dir: `workers/${name.replace("cryptophys-", "")}`, text: `export default { fetch() { return new Response("${name} ${commit.slice(0, 12)}"); } };`, toml: toml(name), external: [] });
  }
  await storeBundles(b, commit, built, Date.now(), Object.keys(sql), { migrationSql: sql, externals: async () => new Map() });
}

// ---------------------------------------------------------------- D1, the lock, Cloudflare
function lockNs() {
  const stores = new Map<string, Map<string, unknown>>();
  return { stores, idFromName: (n: string) => n, get: (id: unknown) => {
    const key = String(id); if (!stores.has(key)) stores.set(key, new Map()); const data = stores.get(key)!;
    const lock = new DeploymentLock({ storage: { get: async (k: string) => data.get(k) as never, put: async (k: string, v: unknown) => { data.set(k, v); }, delete: async (k: string) => data.delete(k) }, blockConcurrencyWhile: (cb) => cb() });
    return { fetch: (i: RequestInfo | URL, init?: RequestInit) => lock.fetch(new Request(i, init)) };
  } };
}
/** The Forge checked `sha` as main (a ready main check run); the planner recorded nothing: it is broken. */
function mainChecked(db: Db, sha: string, ready = true, at = new Date().toISOString()) {
  const steps = JSON.stringify({ typecheck: { status: ready ? "passed" : "failed", errors: 0, console_build: { status: "passed" } } });
  db.raw.prepare(`INSERT OR REPLACE INTO forge_check_runs (commit_sha, status, runner, files, pass, fail, skip, failures, started_at, finished_at, duration_ms, steps, guard_status, source)
    VALUES (?, ?, 'forge-runner/1', 1, 1, 0, 0, '[]', ?, ?, 1, ?, 'clean', 'main')`).run(sha, ready ? "passed" : "failed", at, at, steps);
}
const BINDINGS = [{ type: "d1", name: "DB", id: "db-uuid" }, { type: "version_metadata", name: "CF_VERSION_METADATA" }];
function fakeCloudflare(services: readonly string[]) {
  const scripts = new Map<string, { active: { version_id: string; percentage: number }[]; versions: Map<string, { bindings: unknown[] }> }>();
  let v = 0;
  const uuid = () => `${String(++v).padStart(8, "0")}-0000-4000-8000-000000000000`;
  for (const s of services) { const id = uuid(); scripts.set(s, { active: [{ version_id: id, percentage: 100 }], versions: new Map([[id, { bindings: structuredClone(BINDINGS) }]]) }); }
  const uploads: { script: string; text: string }[] = [];
  const deployments: { script: string; body: any }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const m = new RegExp(`^https://api\\.cloudflare\\.com/client/v4/accounts/${ACCOUNT}/workers/scripts/([a-z0-9-]+)/(.*)$`).exec(String(input));
    assert.ok(m, `unexpected ${String(input)}`);
    const [, script, rest] = m!;
    const s = scripts.get(script);
    assert.ok(s, `a script outside the unit was called: ${script}`);
    const method = init?.method ?? "GET";
    if (rest === "deployments" && method === "GET") return Response.json({ success: true, result: { deployments: [{ created_on: "2026-11-14T00:00:00Z", versions: s!.active }] } });
    if (rest === "deployments" && method === "POST") { const body = JSON.parse(String(init!.body)); deployments.push({ script, body }); s!.active = body.versions; return Response.json({ success: true, result: { id: "dep" } }); }
    if (rest === "versions" && method === "POST") {
      const form = init!.body as FormData;
      const part = [...form.entries()].find(([f]) => f !== "metadata")![1] as File;
      uploads.push({ script, text: await part.text() });
      const id = uuid();
      s!.versions.set(id, { bindings: structuredClone(BINDINGS) });
      return Response.json({ success: true, result: { id, number: v } });
    }
    const vm = /^versions\/([0-9a-f-]{36})$/.exec(rest);
    if (vm && method === "GET") return Response.json({ success: true, result: { id: vm[1], resources: { bindings: s!.versions.get(vm[1])!.bindings } } });
    throw new Error(`unexpected ${method} ${String(input)}`);
  }) as typeof fetch;
  return { fetcher, uploads, deployments, scripts };
}
/** The Orchestrator; reports go to agent_reports as the kernel's reports.publish writes them. */
function orchestrator(db: Db, b: Bucket, probeTag: (svc: string) => string = () => NEW.slice(0, 12)) {
  const reports: any[] = [];
  const lock = lockNs();
  const env = baseEnv("cryptophys-deployment-orchestrator", db, {
    GH_ACTIONS_TOKEN: "", DEPLOYMENT_LOCK: lock, CF_DEPLOY_TOKEN: "deploy-token", CF_ACCOUNT_ID: ACCOUNT, BUNDLES: b,
    DRIFT: { probeService: async (svc: string) => ({ reachable: true, healthy: true, version_tag: probeTag(svc), error: null }) },
    REGISTRY: { recordRollback: (id: string) => recordRollback({ DB: db } as never, id), recordNativeDeploy: (id: string) => recordNativeDeploy({ DB: db } as never, id) },
    AGENTS: { syscall: async (agent: string, _cap: string, input: any) => {
      reports.push({ agent, ...input });
      db.raw.prepare(`INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
        .run(`rpt_${crypto.randomUUID()}`, agent, input.kind, input.severity, input.subject, JSON.stringify(input.body), input.ai_status, new Date().toISOString());
      return { outcome: "succeeded" };
    } },
  });
  return { env, reports, lock };
}
const noFetch = () => {
  globalThis.fetch = (async (i: RequestInfo | URL) => {
    if (isAccessCerts(String(i))) return accessCertsResponse();
    throw new Error(`no network call expected: ${String(i)}`);
  }) as typeof fetch;
};
async function setup(newSql: Record<string, string> = { ...REPO_SQL, ...ADDITIVE }) {
  const db = migratedDb();
  db.raw.prepare("UPDATE service_registry SET desired_version = ?").run(OLD.slice(0, 12));
  const b = bucket();
  await bundlesFor(b, OLD);
  await bundlesFor(b, NEW, newSql);
  mainChecked(db, OLD, true, new Date(Date.now() - 3_600_000).toISOString());
  mainChecked(db, NEW);
  return { db, b };
}
let k = 0;
/** An approved break-glass plan already executing, with its own recovery.execute allow (as the lifecycle leaves it). */
function executingPlan(db: Db, opts: { service?: string; version?: string; destructive?: string[]; created_by?: string; approved_by?: string } = {}) {
  k++;
  const plan = `plan_${String(k).padStart(8, "0")}-6666-4666-8666-666666666666`;
  const dec = `dec_${String(k).padStart(8, "0")}-7777-4777-8777-777777777777`;
  const at = new Date().toISOString();
  const steps = { title: "Break glass", rationale: "the planner is down", steps: [{ action: "force_redeploy_unit", description: "Deploy the unit at main", ...(opts.destructive ? { destructive_migrations: opts.destructive } : {}) }] };
  db.raw.prepare(`INSERT INTO recovery_plans (plan_id, service_id, plan_version, status, steps_json, approved_by, last_execution_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'executing', ?, ?, ?, ?, ?, ?)`).run(plan, opts.service ?? "cryptophys-policy-engine", opts.version ?? NEW, JSON.stringify(steps), opts.approved_by ?? APPROVER_EMAIL,
    JSON.stringify({ policy_decision_id: dec }), opts.created_by ?? OPERATOR_EMAIL, at, at);
  db.raw.prepare(`INSERT INTO policy_decisions (decision_id, subject, action, resource, decision, reason, evidence_json, created_at) VALUES (?, 'ai:recovery-manager', 'recovery.execute', ?, 'allow', 'ok', '{}', ?)`).run(dec, plan, at);
  return { plan, dec, service: opts.service ?? "cryptophys-policy-engine" };
}
const ledger = (db: Db) => (db.raw.prepare("SELECT name FROM d1_migrations ORDER BY id").all() as any[]).map((r) => r.name as string);
const tableExists = (db: Db, name: string) => Boolean(db.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const events = (db: Db, prefix: string) => (db.raw.prepare("SELECT event_type, payload_json FROM audit_events WHERE event_type LIKE ? ORDER BY rowid").all(`${prefix}%`) as any[])
  .map((r) => ({ type: r.event_type as string, payload: JSON.parse(r.payload_json) }));
const requests = (db: Db) => db.raw.prepare("SELECT request_id, service_id, requested_by, idempotency_key, status, details_json FROM deployment_requests").all() as any[];
/** The consensus brake as the kernel computes it for a routine proposal: baseline() over its own overview. */
async function brake(db: Db): Promise<string | null> {
  const ov = await observe(baseEnv("cryptophys-ai-kernel", db) as never) as any;
  return baseline({ agents_enabled: true, audit_valid: true, services: {}, registry: {}, agents: {}, critical_reports_24h: openCriticalReports(ov.agent_reports_24h), executing_plan_targets: [], recent_same: 0 });
}
/** Every registered service observed in sync just now, so the notices list only what the test is about. */
function observeAll(db: Db) {
  const at = new Date().toISOString();
  for (const r of db.raw.prepare("SELECT service_id, desired_version FROM service_registry WHERE status != 'disabled'").all() as any[]) {
    db.raw.prepare(`INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at) VALUES (?, ?, 'd', 'd', 0, ?, ?)`)
      .run(`obs_${crypto.randomUUID()}`, r.service_id, JSON.stringify({ reasons: [], probe: { version_tag: r.desired_version } }), at);
    db.raw.prepare("UPDATE service_registry SET updated_at = ? WHERE service_id = ?").run(at, r.service_id);
  }
}
const desired = (db: Db, svc: string) => (db.raw.prepare("SELECT desired_version FROM service_registry WHERE service_id = ?").get(svc) as any).desired_version;

/** Gate 2026-11-15: the Orchestrator's own version (its D1 binding) and D1's Time Travel bookmark, in front of `inner`. */
const TT_DB = "0d1d1d1d-0000-4000-8000-000000000001";
const TT_VERSION = "0ccccccc-0000-4000-8000-000000000001";
const TT_BOOKMARK = "00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683";
function timeTravel(inner: typeof fetch) {
  const reads: string[] = [];
  const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input);
    if (u === `${base}/workers/scripts/cryptophys-deployment-orchestrator/deployments`) return Response.json({ success: true, result: { deployments: [{ created_on: "2026-11-15T00:00:00Z", versions: [{ version_id: TT_VERSION, percentage: 100 }] }] } });
    if (u === `${base}/workers/scripts/cryptophys-deployment-orchestrator/versions/${TT_VERSION}`) return Response.json({ success: true, result: { id: TT_VERSION, resources: { bindings: [{ type: "d1", name: "DB", id: TT_DB }] } } });
    if (u === `${base}/d1/database/${TT_DB}/time_travel/bookmark`) { reads.push(u); return Response.json({ success: true, result: { bookmark: TT_BOOKMARK } }); }
    return inner(input, init);
  }) as typeof fetch;
  return { fetcher, reads };
}

// ---------------------------------------------------------------- tests
test("BG-1. force_redeploy_unit is owner-run: AI drafts never carry it, agents and service tokens never write it, the plan is one unit at one full commit", async () => {
  assert.ok((RECOVERY_STEP_ACTIONS as readonly string[]).includes("force_redeploy_unit"));
  assert.ok(OWNER_ONLY_STEP_ACTIONS.includes("force_redeploy_unit"));
  assert.ok(!(AI_DRAFT_STEP_ACTIONS as readonly string[]).includes("force_redeploy_unit"), "never in an AI draft");
  assert.doesNotMatch(draftTask.instructions, /force_redeploy_unit/, "the AI is never told the step exists");
  const drafted = draftTask.validate({ title: "t", rationale: "r", steps: [{ action: "force_redeploy_unit", description: "force" }, { action: "manual", description: "check" }] }) as any;
  assert.deepEqual(drafted.steps.map((s: any) => s.action), ["manual"], "an AI draft that names it loses the step");
  assert.equal(draftTask.validate({ title: "t", rationale: "r", steps: [{ action: "force_redeploy_unit", description: "force" }] }), null);

  const db = migratedDb();
  const wf = fakeWorkflow();
  const env = { ...baseEnv("cryptophys-recovery-manager", db), APPROVER_IDENTITIES: `${OPERATOR_EMAIL},${APPROVER_EMAIL}`, RECOVERY_LIFECYCLE: wf.binding };
  const body = (extra: Record<string, unknown> = {}) => ({ service_id: "cryptophys-forge", plan_version: NEW, title: "Break glass", rationale: "planner down",
    steps: [{ action: "force_redeploy_unit", description: "Deploy the Forge at main" }], ...extra });
  // The Supervisor (or any agent) through RecoveryRpc.propose: refused.
  await assert.rejects(proposeFromAgent(env as never, "supervisor", body()), /break_glass_refused: force_redeploy_unit is owner-run/);
  // The deploy workflow's service token: refused. A person with the approver role: accepted.
  assert.equal((await call(recovery, env, req("POST", "/v1/plans", body(), CI_JWT))).status, 403);
  for (const [extra, msg] of [
    [{ plan_version: NEW.slice(0, 12) }, /full 40-hex commit/],
    [{ steps: [{ action: "force_redeploy_unit", description: "a" }, { action: "force_redeploy_unit", description: "b" }] }, /at most one/],
    [{ steps: [{ action: "force_redeploy_unit", description: "a" }, { action: "redeploy_commit", description: "b" }] }, /only manual notes/],
    [{ steps: [{ action: "force_redeploy_unit", description: "a", destructive_migrations: ["drop everything"] }] }, /destructive_migrations must list/],
    [{ steps: [{ action: "redeploy_commit", description: "a", destructive_migrations: ["0991_x.sql"] }] }, /only a force_redeploy_unit step/],
  ] as const) {
    const r = await call(recovery, env, req("POST", "/v1/plans", body(extra), OPERATOR_JWT));
    assert.ok(r.status === 400 || r.status === 403, JSON.stringify(r.body));
    assert.match(String(r.body?.message ?? r.body?.error?.message ?? JSON.stringify(r.body)), msg);
  }
  const ok = await call(recovery, env, req("POST", "/v1/plans", body({ steps: [{ action: "force_redeploy_unit", description: "Deploy", destructive_migrations: ["0991_break_glass_drop.sql"] }, { action: "manual", description: "Watch" }] }), OPERATOR_JWT));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.plan.status, "draft", "it waits for the owner's click");
  assert.deepEqual(ok.body.plan.plan.steps[0].destructive_migrations, ["0991_break_glass_drop.sql"]);
  const created = events(db, "recovery.plan_created").at(-1)!;
  assert.deepEqual([created.payload.break_glass, created.payload.destructive_migrations], [true, ["0991_break_glass_drop.sql"]]);
  // Pure rules, and the guard paths that keep them the owner's.
  assert.equal(isPersonActor("agent:supervisor"), false);
  assert.equal(isPersonActor("ci-client.access"), false);
  assert.equal(isPersonActor("owner@cryptophys.work"), true);
  assert.equal(breakGlassPlanProblem({ plan_version: NEW, created_by: "agent:supervisor", steps: [{ action: "force_redeploy_unit", description: "x" }] }), "break_glass_person_author");
  assert.equal(criticalPathReason("workers/control-plane-shared/src/break-glass.ts"), "break_glass");
  assert.equal(criticalPathReason("workers/deployment-orchestrator/src/recovery-deploy.ts"), "break_glass");
  assert.equal(criticalPathReason("workers/policy-engine/src/index.ts"), "policy_engine");
});

test("BG-2. the Policy Engine allows the break-glass plan only after a person other than its author approved it", async () => {
  const db = migratedDb();
  const at = new Date().toISOString();
  const insert = (id: string, status: string, createdBy: string, approvedBy: string | null, version = NEW) => db.raw.prepare(
    `INSERT INTO recovery_plans (plan_id, service_id, plan_version, status, steps_json, approved_by, created_by, created_at, updated_at) VALUES (?, 'cryptophys-forge', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, version, status, JSON.stringify({ steps: [{ action: "force_redeploy_unit", description: "x" }] }), approvedBy, createdBy, at, at);
  const evaluate = async (id: string) => evaluatePolicy(db as never, "recovery.execute", id, { operator_acknowledged: true, autonomous: true });
  const failed = (r: Awaited<ReturnType<typeof evaluate>>) => r.checks.filter((c) => !c.passed).map((c) => c.id);
  insert("plan_draft", "draft", OPERATOR_EMAIL, null);
  insert("plan_owner", "approved", OPERATOR_EMAIL, APPROVER_EMAIL);
  insert("plan_agent_author", "approved", "agent:supervisor", APPROVER_EMAIL);
  insert("plan_token_author", "approved", "ci-client.access", APPROVER_EMAIL);
  insert("plan_agent_approver", "approved", OPERATOR_EMAIL, "agent:auditor");
  insert("plan_short", "approved", OPERATOR_EMAIL, APPROVER_EMAIL, NEW.slice(0, 12));
  assert.deepEqual(failed(await evaluate("plan_draft")), ["plan_approved", "separation_of_duties", "break_glass_owner_approved"], "no click, no deploy");
  const allowed = await evaluate("plan_owner");
  assert.equal(allowed.decision, "allow", JSON.stringify(allowed.checks));
  assert.ok(allowed.checks.some((c) => c.id === "break_glass_owner_approved" && c.passed));
  for (const id of ["plan_agent_author", "plan_token_author", "plan_agent_approver", "plan_short"]) {
    const r = await evaluate(id);
    assert.equal(r.decision, "deny", id);
    assert.deepEqual(failed(r), ["break_glass_owner_approved"], id);
  }
  assert.match((await evaluate("plan_agent_approver")).checks.find((c) => c.id === "break_glass_owner_approved")!.detail, /break_glass_person_approver/);
  // A plan without the step is judged as before (no new check).
  db.raw.prepare(`INSERT INTO recovery_plans (plan_id, service_id, plan_version, status, steps_json, approved_by, created_by, created_at, updated_at) VALUES ('plan_plain', 'cryptophys-forge', 'abc1234', 'approved', '{"steps":[{"action":"redeploy_commit","description":"x"}]}', ?, ?, ?, ?)`)
    .run(APPROVER_EMAIL, OPERATOR_EMAIL, at, at);
  assert.ok(!(await evaluate("plan_plain")).checks.some((c) => c.id === "break_glass_owner_approved"));
  assert.deepEqual(approvedBreakGlassPlan({ plan_version: NEW, created_by: OPERATOR_EMAIL, approved_by: OPERATOR_EMAIL, steps_json: JSON.stringify({ steps: [{ action: "force_redeploy_unit", description: "x" }] }) }),
    { ok: false, reason: "break_glass_person_approver" }, "the author never approves their own break-glass plan");
});

test("BG-3. end to end with the planner down: the owner's click deploys exactly the control-plane unit from main head's bundles, applies D1's pending migration, verified, audited; a success is a warning on Telegram that leaves the brake off", async () => {
  const { db, b } = await setup();
  // The incident: the planner recorded nothing for main's head, so the normal paths have no head at all.
  assert.deepEqual(await forgeMainHead(db as never), { sha: null, reason: "forge_plan_missing" });
  assert.deepEqual(await recoveryMainHead(db as never), { sha: NEW, reason: "forge_main_check" });
  const { env: orch, reports } = orchestrator(db, b);
  const cf = fakeCloudflare([...CONTROL_PLANE.services]);
  const wf = fakeWorkflow();
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  let executed = false;
  const observeInSync = () => {
    db.raw.prepare(`INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at) VALUES (?, 'cryptophys-policy-engine', 'd', 'o', 0, ?, ?)`)
      .run(`obs_${crypto.randomUUID()}`, JSON.stringify({ reasons: [], probe: { version_tag: NEW.slice(0, 12) } }), new Date().toISOString());
    db.raw.prepare("UPDATE service_registry SET updated_at = ? WHERE service_id = 'cryptophys-policy-engine'").run(new Date().toISOString());
  };
  // No drift precondition: the service is observed in sync before the plan.
  observeInSync();
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-recovery-manager", db),
    APPROVER_IDENTITIES: `${OPERATOR_EMAIL},${APPROVER_EMAIL}`,
    RECOVERY_LIFECYCLE: wf.binding,
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    DEPLOY: {
      deployForRecovery: () => { throw new Error("the break-glass step never takes the planner-bound path"); },
      runStatus: () => { throw new Error("no GitHub workflow"); },
      forceDeployForRecovery: async (planId: string, dec: string, svc: string, v: string) => {
        const first = await forceDeployForRecovery(orch as never, planId, dec, svc, v);
        // A retried step is not queued twice and follows the same request.
        const again = await forceDeployForRecovery(orch as never, planId, dec, svc, v);
        assert.deepEqual([first.dispatched, again.dispatched, again.reason, again.request_id], [true, false, "already_dispatched", first.request_id]);
        return first;
      },
      requestStatus: async (id: string) => {
        const s = await requestStatus(orch as never, id);
        if (!executed) { executed = true; await runNativeExecutors(orch as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }); observeInSync(); }
        return s;
      },
    },
  };
  noFetch();
  try {
    const created = await call(recovery, env, req("POST", "/v1/plans", { service_id: "cryptophys-policy-engine", plan_version: NEW, title: "Break glass", rationale: "the planner plans nothing",
      steps: [{ action: "force_redeploy_unit", description: "Deploy control-plane at main" }] }, OPERATOR_JWT));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.plan.plan_id as string;
    // Before the click nothing runs: the lifecycle waits for the approval.
    const approved = await call(recovery, env, req("POST", `/v1/plans/${id}/approve`, {}, APPROVER_JWT));
    assert.equal(approved.body?.plan?.status, "approved", JSON.stringify(approved.body));
    const out = await runLifecycle(env as never, id, id, wf.step(id) as never);
    assert.equal(out.final_status, "completed");
    const exec = JSON.parse((db.raw.prepare("SELECT last_execution_json FROM recovery_plans WHERE plan_id = ?").get(id) as any).last_execution_json);
    assert.deepEqual(exec.pipeline.map((s: any) => `${s.id}:${s.status}`), ["approval:succeeded", "policy:succeeded", "step-1:succeeded", "verify:succeeded"]);
    assert.match(exec.pipeline[2].detail, /^break-glass deploy of control-plane at 1b1b1b1b1b1b succeeded \(request dep_/);

    // Exactly one unit, from main head's bundles: every control-plane Worker, nothing else.
    assert.deepEqual(cf.uploads.map((u) => u.script), [...CONTROL_PLANE.services]);
    for (const u of cf.uploads) assert.match(u.text, new RegExp(`${u.script} ${NEW.slice(0, 12)}`));
    for (const s of CONTROL_PLANE.services) assert.equal(desired(db, s), NEW.slice(0, 12));
    for (const u of DEPLOY_UNITS.filter((x) => x.unit !== "control-plane")) for (const s of u.services) assert.equal(desired(db, s), OLD.slice(0, 12), `${s} untouched`);
    // D1's pending migration (main has it, d1_migrations does not) was applied first.
    assert.ok(tableExists(db, "break_glass_probe"));
    assert.equal(ledger(db).at(-1), "0990_break_glass_probe.sql");
    const rows = requests(db);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].requested_by, rows[0].idempotency_key, rows[0].status, JSON.parse(rows[0].details_json).executor], [`recovery:${id}`, breakGlassRequestKey(CONTROL_PLANE, NEW, id), "succeeded", BREAK_GLASS_EXECUTOR]);

    // Audited end to end, and the chain still verifies.
    const types = events(db, "").map((e) => e.type);
    for (const t of ["recovery.plan_created", "recovery.plan_approved", "recovery.execution_started", "deployment.break_glass_queued", "deployment.native_migration_applied", "deployment.break_glass_succeeded", "recovery.execution_finished"]) {
      assert.ok(types.includes(t), `audited: ${t}`);
    }
    const queued = events(db, "deployment.break_glass_queued")[0].payload;
    assert.deepEqual([queued.plan_id, queued.unit, queued.commit_sha, queued.migrations], [id, "control-plane", NEW, ["0990_break_glass_probe.sql"]]);
    assert.equal(events(db, "deployment.break_glass_succeeded")[0].payload.plan_id, id);
    assert.equal((await verifyAuditChain(db as never)).valid, true);

    // The owner hears of a success through a WARNING: no critical report, so the consensus brake stays off.
    const report = reports.find((r) => r.body?.break_glass);
    assert.ok(report, "a break-glass report");
    assert.deepEqual([report.agent, report.severity, report.subject, report.body.alert_key, report.body.state],
      ["deployment-orchestrator", "warning", "Break-glass deploy of control-plane at 1b1b1b1b1b1b succeeded", `break_glass:${rows[0].request_id}`, "open"]);
    assert.equal(reports.filter((r) => r.severity === "critical").length, 0);
    assert.deepEqual(await openCriticalReportRows(db as never), []);
    assert.equal(await brake(db), null, "a routine proposal still passes baseline()");
    // The Owner page lists it as a production problem (break_glass_deployed), once per request.
    const items = (await unhandledProblems(db as never)).filter((p) => p.code === "break_glass_deployed");
    assert.deepEqual(items.map((p) => [p.subject, p.link]), [[`break_glass:${rows[0].request_id}`, `#/recovery/${id}`]]);
    assert.match(items[0].detail, /^Break-glass deploy of control-plane at 1b1b1b1b1b1b succeeded at /);
    // Telegram: one production_unhandled message carrying it, no critical_reports message; a second run sends nothing.
    observeAll(db);
    const telegram: any[] = [];
    const notices = { DB: db, OWNER_TELEGRAM: { notify: async (n: any) => { telegram.push(n); return { sent: true }; } } };
    await reconcileNotices(notices as never);
    assert.equal(telegram.length, 1, JSON.stringify(telegram.map((t) => t.title)));
    assert.match(telegram[0].title, /^A production problem no agent is handling: 1 item\(s\)$/);
    assert.ok(telegram[0].lines.some((l: string) => l.startsWith("Break-glass deploy of control-plane at 1b1b1b1b1b1b succeeded")));
    await reconcileNotices(notices as never);
    assert.equal(telegram.length, 1, "deduplicated");
    // After 24 hours the Orchestrator reports it resolved ("Resolved:", same alert_key), and the notice closes.
    assert.equal(await resolveBreakGlassNotices(db as never, (orch as any).AGENTS, Date.now() - 1), 0, "not before 24 hours");
    assert.equal(await resolveBreakGlassNotices(db as never, (orch as any).AGENTS, Date.now() + BREAK_GLASS_NOTICE_MS + 60_000), 1);
    assert.equal(await resolveBreakGlassNotices(db as never, (orch as any).AGENTS, Date.now() + BREAK_GLASS_NOTICE_MS + 60_000), 0, "once");
    const resolved = reports.at(-1);
    assert.deepEqual([resolved.severity, resolved.subject, resolved.body.alert_key, resolved.body.state], ["info", "Resolved: Break-glass deploy of control-plane at 1b1b1b1b1b1b succeeded", report.body.alert_key, "resolved"]);
    assert.deepEqual((await unhandledProblems(db as never)).filter((p) => p.code === "break_glass_deployed"), []);
    observeAll(db);
    await reconcileNotices(notices as never);
    assert.deepEqual([telegram.length, telegram[1]?.change], [2, "closed"]);
  } finally { globalThis.fetch = realFetch; }
});

test("BG-4. pending migrations come from D1's applied state, not from the running version's list", async () => {
  // The running version's bundle lacks the newest repository migration, which D1 has applied: the normal native plan
  // refuses (the ledger matches neither list), the break-glass plan applies only what D1 lacks.
  const older = Object.fromEntries(Object.entries(REPO_SQL).slice(0, -1));
  const db = migratedDb();
  db.raw.prepare("UPDATE service_registry SET desired_version = ?").run(OLD.slice(0, 12));
  const b = bucket();
  await bundlesFor(b, OLD, older);
  await bundlesFor(b, NEW, { ...REPO_SQL, ...ADDITIVE });
  mainChecked(db, NEW);
  const normal = await nativeDeployEligible({ DB: db as never, BUNDLES: b }, CONTROL_PLANE, NEW);
  assert.deepEqual(normal.eligible ? null : normal.reason, "d1_migrations_mismatch");
  const choice = await breakGlassChoice({ DB: db as never, BUNDLES: b }, CONTROL_PLANE, NEW, []);
  assert.ok(choice.ok, JSON.stringify(choice));
  assert.deepEqual(choice.ok && choice.migrations.map((m) => [m.file, m.destructive]), [["0990_break_glass_probe.sql", false]]);
  assert.deepEqual(choice.ok && choice.services.map((s) => s.service), [...CONTROL_PLANE.services]);
  // Nothing pending when D1 already lists every file of main.
  const manifest = (await readManifest(b, NEW))!;
  db.raw.prepare("INSERT INTO d1_migrations (name) VALUES ('0990_break_glass_probe.sql')").run();
  assert.deepEqual(await pendingMigrations(db as never, b, NEW, manifest.migration_files!, []), { migrations: [] });
  // A file D1 applied that main does not have, or a pending file older than the last applied one, is refused.
  db.raw.prepare("INSERT INTO d1_migrations (name) VALUES ('0995_not_in_main.sql')").run();
  assert.deepEqual(await pendingMigrations(db as never, b, NEW, manifest.migration_files!, []), { reason: "d1_migration_not_in_main", file: "0995_not_in_main.sql" });
  db.raw.prepare("DELETE FROM d1_migrations WHERE name IN ('0995_not_in_main.sql', ?)").run(REPO_MIGRATIONS[3]);
  assert.deepEqual(await pendingMigrations(db as never, b, NEW, manifest.migration_files!, []), { reason: "migration_out_of_order", file: REPO_MIGRATIONS[3] });
  // Only the Control Plane applies migrations (SSOT): another unit waits until it has.
  db.raw.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(REPO_MIGRATIONS[3]);
  db.raw.prepare("DELETE FROM d1_migrations WHERE name = '0990_break_glass_probe.sql'").run();
  const forge = unitForService("cryptophys-forge")!;
  assert.deepEqual(await breakGlassChoice({ DB: db as never, BUNDLES: b }, forge, NEW, []), { ok: false, reason: "migrations_pending_deploy_control_plane_first", file: "0990_break_glass_probe.sql" });
  // main's head is the Forge's newest main check: an older commit, or a head whose checks are not ready, is refused.
  assert.deepEqual(await breakGlassChoice({ DB: db as never, BUNDLES: b }, CONTROL_PLANE, OLD, []), { ok: false, reason: "commit_not_current_main", head: NEW });
  mainChecked(db, NEW, false);
  assert.deepEqual(await breakGlassChoice({ DB: db as never, BUNDLES: b }, CONTROL_PLANE, NEW, []), { ok: false, reason: "forge_checks_not_ready" });
});

test("BG-5. a destructive pending migration is refused unless the owner-approved plan names it", async () => {
  const { db, b } = await setup({ ...REPO_SQL, ...DESTRUCTIVE });
  const { env } = orchestrator(db, b);
  noFetch();
  try {
    const unnamed = executingPlan(db);
    await assert.rejects(forceDeployForRecovery(env as never, unnamed.plan, unnamed.dec, unnamed.service, NEW), /break_glass_refused: destructive_migration_not_named/);
    assert.equal(requests(db).length, 0, "nothing queued");
    const refused = events(db, "deployment.break_glass_refused")[0].payload;
    assert.deepEqual([refused.reason, refused.file, refused.plan_id], ["destructive_migration_not_named", "0991_break_glass_drop.sql", unnamed.plan]);
    // A named file that is not pending (or not destructive) means the plan no longer matches main and D1.
    const wrong = executingPlan(db, { destructive: ["0991_break_glass_drop.sql", "0999_other.sql"] });
    await assert.rejects(forceDeployForRecovery(env as never, wrong.plan, wrong.dec, wrong.service, NEW), /named_migration_not_pending_destructive/);
    // Named: queued, then applied by the executor, and recorded in the ledger as wrangler does.
    const named = executingPlan(db, { destructive: ["0991_break_glass_drop.sql"] });
    const q = await forceDeployForRecovery(env as never, named.plan, named.dec, named.service, NEW);
    assert.deepEqual([q.dispatched, q.executor, q.migrations], [true, BREAK_GLASS_EXECUTOR, ["0991_break_glass_drop.sql"]]);
    assert.deepEqual(events(db, "deployment.break_glass_queued")[0].payload.destructive_migrations, ["0991_break_glass_drop.sql"]);
    const cf = fakeCloudflare([...CONTROL_PLANE.services]);
    // Gate 2026-11-15: a named destructive migration runs only after D1's Time Travel bookmark is read and recorded.
    const tt = timeTravel(cf.fetcher);
    assert.deepEqual(await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 1_000), tt.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 1 });
    assert.equal(ledger(db).at(-1), "0991_break_glass_drop.sql");
    assert.equal(tableExists(db, "break_glass_tmp"), false);
    assert.equal(tt.reads.length, 1, "one bookmark read");
    const recorded = events(db, "deployment.restore_point_recorded");
    assert.deepEqual(recorded.map((e) => [e.payload.bookmark, e.payload.destructive_migrations]), [[TT_BOOKMARK, ["0991_break_glass_drop.sql"]]]);
    const types = events(db, "deployment.").map((e) => e.type);
    assert.ok(types.indexOf("deployment.restore_point_recorded") < types.indexOf("deployment.native_migration_applied"), "the bookmark is recorded before the migration");
    assert.equal(JSON.parse(requests(db).find((r) => r.status === "succeeded")!.details_json).restore_point.bookmark, TT_BOOKMARK);
    // The normal native deploy still never applies it.
    const file = (await readManifest(b, NEW))!.migration_files!.find((f) => f.file === "0991_break_glass_drop.sql")!;
    assert.deepEqual(await readMigration(b, NEW, file), { reason: "destructive_migration" });
  } finally { globalThis.fetch = realFetch; }
});

test("BG-6. it fails cleanly while the deploy lock is held or another deploy of the unit is under way", async () => {
  const { db, b } = await setup();
  const { env, lock } = orchestrator(db, b);
  noFetch();
  try {
    // The lock of this unit and commit is held (another break-glass request in flight).
    await lock.get(lock.idFromName(breakGlassLockName(CONTROL_PLANE, NEW))).fetch("https://lock.internal/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha: NEW }) });
    const p = executingPlan(db);
    await assert.rejects(forceDeployForRecovery(env as never, p.plan, p.dec, p.service, NEW), /break_glass_refused: deploy_lock_held/);
    assert.equal(requests(db).length, 0, "nothing queued, nothing uploaded");
    assert.equal(ledger(db).includes("0990_break_glass_probe.sql"), false, "no migration applied");
    assert.equal(events(db, "deployment.break_glass_refused").at(-1)!.payload.reason, "deploy_lock_held");
    // Another deploy of a Worker of the unit is queued: the break-glass deploy does not race it.
    await lock.get(lock.idFromName(breakGlassLockName(CONTROL_PLANE, NEW))).fetch("https://lock.internal/release", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha: NEW }) });
    const at = new Date().toISOString();
    db.raw.prepare(`INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
      VALUES ('dep_00000001-5555-4555-8555-555555555555', 'cryptophys-ai-kernel', ?, 'consensus:x', 'running', NULL, 'k', '{}', ?, ?)`).run(NEW, at, at);
    await assert.rejects(forceDeployForRecovery(env as never, p.plan, p.dec, p.service, NEW), /break_glass_refused: unit_deploy_in_progress/);
    assert.equal(requests(db).length, 1);
    // Without native credentials there is no fallback: it refuses rather than dispatching a workflow.
    const bare = { ...env, CF_DEPLOY_TOKEN: undefined };
    await assert.rejects(forceDeployForRecovery(bare as never, p.plan, p.dec, p.service, NEW), /native_deploy_not_configured/);
    // A plan that is not executing, or a decision that is not its own, is refused before anything is read.
    await assert.rejects(forceDeployForRecovery(env as never, p.plan, `dec_${"9".repeat(8)}-7777-4777-8777-777777777777`, p.service, NEW), /plan_not_executing/);
    // The planner-bound redeploy still has no head while the planner is down (what the step bypasses).
    await assert.rejects(deployForRecovery(env as never, p.plan, p.dec, p.service, NEW), /forge_plan_missing/);
  } finally { globalThis.fetch = realFetch; }
});

test("BG-7. a failed live verification restores every changed Worker, fails the plan's step, engages the brake and reaches the owner", async () => {
  const { db, b } = await setup();
  // The AI Kernel never reports the new tag: the deploy of the last Worker of the unit is not live.
  const { env, reports, lock } = orchestrator(db, b, (svc) => svc === "cryptophys-ai-kernel" ? OLD.slice(0, 12) : NEW.slice(0, 12));
  noFetch();
  try {
    const p = executingPlan(db);
    const q = await forceDeployForRecovery(env as never, p.plan, p.dec, p.service, NEW);
    const cf = fakeCloudflare([...CONTROL_PLANE.services]);
    const before = new Map([...cf.scripts].map(([s, v]) => [s, structuredClone(v.active)]));
    assert.deepEqual(await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 0 });
    const row = requests(db)[0];
    const outcome = JSON.parse(row.details_json).outcome;
    assert.deepEqual([row.status, outcome.reason, outcome.service, outcome.restored], ["failed", "not_live_at_tag", "cryptophys-ai-kernel", true]);
    for (const [s, active] of before) assert.deepEqual(cf.scripts.get(s)!.active, active, `${s} restored to its captured deployment`);
    for (const s of CONTROL_PLANE.services) assert.equal(desired(db, s), OLD.slice(0, 12), "nothing recorded as desired");
    assert.deepEqual(outcome.migrations_applied, ["0990_break_glass_probe.sql"], "migrations are forward-only and reported");
    assert.deepEqual(await requestStatus(env as never, String(q.request_id)), { found: true, status: "completed", conclusion: "failure", request_id: q.request_id, executor: BREAK_GLASS_EXECUTOR, reason: "not_live_at_tag" });
    assert.equal(events(db, "deployment.break_glass_failed").length, 1);
    const report = reports.find((r) => r.body?.break_glass);
    assert.deepEqual([report.severity, report.subject, report.body.restored], ["critical", "Break-glass deploy of control-plane at 1b1b1b1b1b1b failed (not_live_at_tag)", true]);
    assert.equal(reports.filter((r) => r.severity === "critical").length, 1, "one report, not the generic one as well");
    // A failure engages the brake until an approver acknowledges it, and reaches Telegram as a critical report.
    assert.equal(await brake(db), "a critical report is open in the last 24 h");
    assert.deepEqual((await unhandledProblems(db as never)).filter((p) => p.code === "break_glass_deployed"), [], "not listed as a success");
    observeAll(db);
    const telegram: any[] = [];
    await reconcileNotices({ DB: db, OWNER_TELEGRAM: { notify: async (n: any) => { telegram.push(n); return { sent: true }; } } } as never);
    const msg = telegram.find((n) => /critical agent report/.test(n.title));
    assert.ok(msg, JSON.stringify(telegram.map((t) => t.title)));
    assert.ok(msg.lines.some((l: string) => l.includes("deployment-orchestrator: Break-glass deploy of control-plane at 1b1b1b1b1b1b failed (not_live_at_tag)")));
    // The lock was freed: the owner can approve another plan for the same commit.
    const again = await lock.get(lock.idFromName(breakGlassLockName(CONTROL_PLANE, NEW))).fetch("https://lock.internal/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha: NEW }) });
    assert.equal((await again.json() as any).claimed, false);
  } finally { globalThis.fetch = realFetch; }
});

test("BG-8. at run time the evidence is checked again: an edited request or a moved main refuses, moves nothing, and is reported", async () => {
  const { db, b } = await setup();
  const { env, reports } = orchestrator(db, b);
  noFetch();
  try {
    // An edited request (a destructive migration added to its signed details in D1) never runs.
    const t = executingPlan(db);
    const tq = await forceDeployForRecovery(env as never, t.plan, t.dec, t.service, NEW);
    const stored = JSON.parse((db.raw.prepare("SELECT details_json FROM deployment_requests WHERE request_id = ?").get(String(tq.request_id)) as any).details_json);
    db.raw.prepare("UPDATE deployment_requests SET details_json = ? WHERE request_id = ?").run(JSON.stringify({ ...stored, destructive_migrations: ["0991_break_glass_drop.sql"] }), String(tq.request_id));
    const cf0 = fakeCloudflare([...CONTROL_PLANE.services]);
    assert.deepEqual(await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 1_000), cf0.fetcher, { delayMs: 0 }), { executed: 0, succeeded: 0 });
    assert.equal(JSON.parse((db.raw.prepare("SELECT details_json FROM deployment_requests WHERE request_id = ?").get(String(tq.request_id)) as any).details_json).outcome.reason, "invalid_break_glass_signature");
    assert.equal(cf0.uploads.length, 0);

    const p = executingPlan(db);
    const pq = await forceDeployForRecovery(env as never, p.plan, p.dec, p.service, NEW);
    // main moved on before the SAFE minute.
    mainChecked(db, "2c".repeat(20), true, new Date(Date.now() + 1_000).toISOString());
    const cf = fakeCloudflare([...CONTROL_PLANE.services]);
    assert.deepEqual(await runNativeExecutors(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 0, succeeded: 0 });
    assert.equal(cf.uploads.length, 0);
    assert.equal(ledger(db).includes("0990_break_glass_probe.sql"), false);
    const row = requests(db).find((r) => r.request_id === pq.request_id);
    assert.deepEqual([row.status, JSON.parse(row.details_json).outcome.reason], ["failed", "refused: commit_not_current_main"]);
    assert.match(reports.find((r) => r.body?.break_glass).subject, /was refused \(refused: commit_not_current_main\)$/);
  } finally { globalThis.fetch = realFetch; }
  // Wiring: the RPC entrypoint, the Recovery Manager's binding, the Registry accepting the executor.
  assert.match(read("workers/deployment-orchestrator/src/worker.ts"), /async forceDeployForRecovery\(planId: string, decisionId: string, serviceId: string, version: string\) \{\n\s+return forceDeployForRecovery\(await resolved\(this\.env\), planId, decisionId, serviceId, version\);/);
  assert.match(read("workers/recovery-manager/src/autonomous.ts"), /case "force_redeploy_unit": \{/);
  assert.match(read("workers/platform-registry/src/index.ts"), /details\.executor !== "native:break-glass"/);
});
