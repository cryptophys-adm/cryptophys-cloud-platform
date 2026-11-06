// Autonomous recovery (owner decision 2026-11-06): after one approval click, the plan's
// lifecycle Workflow runs every step itself and records a pipeline the Console shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_JWT, APPROVER_EMAIL, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, fakeWorkflow, migratedDb, req } from "./harness.ts";
import { verifyAuditChain } from "../src/audit.ts";
import recovery from "../../recovery-manager/src/index.ts";
import { runLifecycle } from "../../recovery-manager/src/lifecycle.ts";
import { AI_EXECUTOR } from "../../recovery-manager/src/autonomous.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { DeploymentLock, deployForRecovery, runStatus } from "../../deployment-orchestrator/src/index.ts";

type Db = ReturnType<typeof migratedDb>;
const MAIN = "abcdef1234567890abcdef1234567890abcdef12";
const realFetch = globalThis.fetch;

function lockNamespace() {
  const stores = new Map<string, Map<string, unknown>>();
  return {
    idFromName: (n: string) => n,
    get: (id: unknown) => {
      const key = String(id);
      if (!stores.has(key)) stores.set(key, new Map());
      const data = stores.get(key)!;
      const lock = new DeploymentLock({ storage: { get: async (k: string) => data.get(k) as never, put: async (k: string, v: unknown) => { data.set(k, v); } }, blockConcurrencyWhile: (cb) => cb() });
      return { fetch: (input: RequestInfo | URL, init?: RequestInit) => lock.fetch(new Request(input, init)) };
    },
  };
}

/** Fake GitHub: current main, green CI, and a deploy run that finishes on the first poll. */
function github(db: Db, opts: { main?: string; conclusion?: string; onPoll?: () => void } = {}) {
  const dispatched: { workflow: string; body: any }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("access/certs")) return (await import("./harness.ts")).accessCertsResponse();
    if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: opts.main ?? MAIN } });
    if (/\/commits\/[0-9a-f]{40}\/status$/.test(url)) return Response.json({ state: "success", total_count: 0 });
    if (url.includes("/actions/runs?head_sha=")) {
      const runs = ["Validate", "Validate Control Plane Workers"].map((name, i) => ({ workflow_id: i + 1, name, event: "push", head_branch: "main", status: "completed", conclusion: "success", run_number: 1 }));
      return Response.json({ total_count: runs.length, workflow_runs: runs });
    }
    const d = /\/actions\/workflows\/([a-z-]+\.yml)\/dispatches$/.exec(url);
    if (d && init?.method === "POST") { dispatched.push({ workflow: d[1], body: JSON.parse(String(init.body)) }); return new Response(null, { status: 204 }); }
    if (/\/actions\/workflows\/[a-z-]+\.yml\/runs\?event=workflow_dispatch/.test(url)) {
      opts.onPoll?.();
      return Response.json({ workflow_runs: dispatched.length ? [{ id: 42, run_number: 7, status: "completed", conclusion: opts.conclusion ?? "success", html_url: "https://github.com/x/actions/runs/42" }] : [] });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return dispatched;
}

function envFor(db: Db = migratedDb(), extra: Record<string, unknown> = {}) {
  const wf = fakeWorkflow();
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const orch = baseEnv("cryptophys-deployment-orchestrator", db, { GH_ACTIONS_TOKEN: "gh-token", DEPLOYMENT_LOCK: lockNamespace() });
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-recovery-manager", db),
    APPROVER_IDENTITIES: `${OPERATOR_EMAIL},${APPROVER_EMAIL}`,
    RECOVERY_LIFECYCLE: wf.binding,
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    DEPLOY: {
      deployForRecovery: (planId: string, dec: string, svc: string, v: string) => deployForRecovery(orch as never, planId, dec, svc, v),
      runStatus: (w: string, sha: string) => runStatus(orch as never, w, sha),
    },
    ...extra,
  };
  return { env, db, wf };
}

function observe(db: Db, serviceId: string, drifted: boolean, tag = MAIN.slice(0, 12)) {
  db.raw.prepare(`INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at)
    VALUES (?, ?, 'd', 'o', ?, ?, ?)`).run(`obs_${Math.random().toString(16).slice(2)}`, serviceId, drifted ? 1 : 0,
    JSON.stringify({ reasons: drifted ? ["version_mismatch"] : [], probe: { version_tag: drifted ? "000000000000" : tag } }), new Date().toISOString());
}

async function approvedPlan(env: Record<string, unknown>, steps: { action: string; description: string }[], version = MAIN.slice(0, 12), serviceId = "cryptophys-console") {
  const created = await call(recovery, env, req("POST", "/v1/plans", { service_id: serviceId, plan_version: version, title: "Recover", rationale: "test", steps }, OPERATOR_JWT));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const approved = await call(recovery, env, req("POST", `/v1/plans/${created.body.plan.plan_id}/approve`, {}, APPROVER_JWT));
  assert.equal(approved.body.plan.status, "approved");
  return created.body.plan.plan_id as string;
}

const run = (env: Record<string, unknown>, wf: ReturnType<typeof fakeWorkflow>, id: string) => runLifecycle(env as never, id, id, wf.step(id) as never);
const planRow = (db: Db, id: string) => { const r = db.raw.prepare("SELECT status, last_execution_json FROM recovery_plans WHERE plan_id = ?").get(id) as any; return { status: r.status, exec: JSON.parse(r.last_execution_json ?? "{}") }; };
const stages = (db: Db, id: string) => (planRow(db, id).exec.pipeline ?? []).map((s: any) => `${s.id}:${s.status}`);

test("1. after one approval click the AI runs the whole plan: policy, steps, verification, finish, audited", async () => {
  const { env, db, wf } = envFor();
  try {
    const dispatched = github(db, { onPoll: () => observe(db, "cryptophys-console", false) });
    observe(db, "cryptophys-console", true);
    const id = await approvedPlan(env, [
      { action: "redeploy_commit", description: "Redeploy the desired version" },
      { action: "manual", description: "Confirm health and drift" },
    ]);
    const out = await run(env, wf, id);
    assert.equal(out.final_status, "completed");
    const { status, exec } = planRow(db, id);
    assert.equal(status, "completed");
    assert.equal(exec.autonomous, true);
    assert.equal(exec.executed_by, AI_EXECUTOR);
    assert.equal(exec.approved_by, APPROVER_EMAIL);
    assert.deepEqual(stages(db, id), ["approval:succeeded", "policy:succeeded", "step-1:succeeded", "step-2:skipped", "verify:succeeded"]);
    assert.equal(exec.pipeline[2].link, "https://github.com/x/actions/runs/42");
    assert.deepEqual(dispatched, [{ workflow: "deploy-console.yml", body: { ref: "main", inputs: { confirm_production: "DEPLOY", commit_sha: MAIN } } }]);
    const trail = db.raw.prepare("SELECT event_type, actor FROM audit_events WHERE subject = ? AND event_type LIKE 'recovery.%' ORDER BY rowid").all(id).map((r: any) => `${r.event_type}:${r.actor}`);
    assert.deepEqual(trail, [`recovery.plan_created:${OPERATOR_EMAIL}`, `recovery.plan_approved:${APPROVER_EMAIL}`, `recovery.execution_started:${AI_EXECUTOR}`, `recovery.execution_finished:${AI_EXECUTOR}`]);
    const req0 = db.raw.prepare("SELECT requested_by, approval_id, status FROM deployment_requests").get() as any;
    assert.deepEqual({ ...req0 }, { requested_by: `recovery:${id}`, approval_id: id, status: "running" });
    assert.equal((await verifyAuditChain(db as never)).valid, true);
  } finally { globalThis.fetch = realFetch; }
});

test("2. a stale plan never deploys an old commit: an in-sync service is skipped, nothing is dispatched", async () => {
  const { env, db, wf } = envFor();
  try {
    const dispatched = github(db);
    observe(db, "cryptophys-console", false);
    const id = await approvedPlan(env, [{ action: "redeploy_commit", description: "Redeploy 59db4cf" }], "59db4cf695fa");
    await run(env, wf, id);
    assert.deepEqual(stages(db, id), ["approval:succeeded", "policy:succeeded", "step-1:skipped", "verify:succeeded"]);
    assert.match(planRow(db, id).exec.pipeline[2].detail, /Already in sync/);
    assert.equal(planRow(db, id).status, "completed");
    assert.deepEqual(dispatched, []);
  } finally { globalThis.fetch = realFetch; }
});

test("3. a drifted service whose plan names an old commit fails safely; later stages are cancelled", async () => {
  const { env, db, wf } = envFor();
  try {
    const dispatched = github(db);
    observe(db, "cryptophys-console", true);
    const id = await approvedPlan(env, [
      { action: "redeploy_commit", description: "Redeploy 59db4cf" },
      { action: "manual", description: "Confirm" },
    ], "59db4cf695fa");
    await run(env, wf, id);
    assert.deepEqual(stages(db, id), ["approval:succeeded", "policy:succeeded", "step-1:failed", "step-2:cancelled", "verify:cancelled"]);
    assert.match(planRow(db, id).exec.pipeline[2].detail, /version_not_current_main/);
    assert.equal(planRow(db, id).status, "failed");
    assert.deepEqual(dispatched, []);
  } finally { globalThis.fetch = realFetch; }
});

test("4. a failed deploy run fails the plan (the deploy workflow rolled back itself)", async () => {
  const { env, db, wf } = envFor();
  try {
    github(db, { conclusion: "failure" });
    observe(db, "cryptophys-console", true);
    const id = await approvedPlan(env, [{ action: "redeploy_commit", description: "Redeploy" }]);
    await run(env, wf, id);
    assert.deepEqual(stages(db, id), ["approval:succeeded", "policy:succeeded", "step-1:failed", "verify:cancelled"]);
    assert.match(planRow(db, id).exec.pipeline[2].detail, /rolled back automatically/);
    assert.equal(planRow(db, id).status, "failed");
  } finally { globalThis.fetch = realFetch; }
});

test("5. steps needing credentials no Worker holds are blocked; disable_service runs in the registry", async () => {
  const { env, db, wf } = envFor();
  observe(db, "cryptophys-console", false);
  const id = await approvedPlan(env, [{ action: "disable_service", description: "Disable" }, { action: "rotate_secret", description: "Rotate" }]);
  await run(env, wf, id);
  assert.deepEqual(stages(db, id), ["approval:succeeded", "policy:succeeded", "step-1:succeeded", "step-2:blocked", "verify:cancelled"]);
  assert.equal((db.raw.prepare("SELECT status FROM service_registry WHERE service_id = 'cryptophys-console'").get() as any).status, "disabled");
  assert.equal(planRow(db, id).status, "failed");
});

test("6. no policy allow, no execution; a forged or stale decision is refused by the orchestrator", async () => {
  const { env, db, wf } = envFor(migratedDb(), { POLICY: { evaluate: async () => { throw new Error("down"); } } });
  const id = await approvedPlan(env, [{ action: "manual", description: "x" }]);
  await run(env, wf, id);
  assert.equal(planRow(db, id).status, "failed");
  assert.deepEqual(stages(db, id).slice(0, 2), ["approval:succeeded", "policy:failed"]);
  const orch = baseEnv("cryptophys-deployment-orchestrator", db, { GH_ACTIONS_TOKEN: "t", DEPLOYMENT_LOCK: lockNamespace() });
  await assert.rejects(deployForRecovery(orch as never, id, "dec_00000000-0000-0000-0000-000000000000", "cryptophys-console", MAIN.slice(0, 12)), /plan_not_executing/);
});

test("7. a plan a person started by hand keeps the legacy path; the lifecycle does not run it again", async () => {
  const { env, db, wf } = envFor();
  const id = await approvedPlan(env, [{ action: "manual", description: "x" }]);
  await call(recovery, env, req("POST", `/v1/plans/${id}/executions`, { phase: "start", operator_acknowledged: true }));
  await run(env, wf, id);
  assert.equal(planRow(db, id).status, "executing");
  assert.equal(planRow(db, id).exec.autonomous, undefined);
});

test("8. Console: approved and executing plans show the AI pipeline; no manual start for autonomous plans", () => {
  const src = readFileSync(new URL("../../console/ui/src/pages/RecoveryDetail.tsx", import.meta.url), "utf8");
  assert.match(src, /Pipeline/);
  assert.doesNotMatch(src, /recovery\.execute_start/);
  assert.match(src, /last_execution\?\.autonomous|autonomous/);
});
