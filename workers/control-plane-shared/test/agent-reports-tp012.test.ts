import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  APPROVER_EMAIL, APPROVER_JWT, OPERATOR_EMAIL, OPERATOR_JWT, accessCertsResponse, baseEnv, call, isAccessCerts, migratedDb, req,
} from "./harness.ts";
import { publishAgentReport, type AgentRpcBinding } from "../src/agents.ts";
import recovery from "../../recovery-manager/src/index.ts";
import { runLifecycle } from "../../recovery-manager/src/lifecycle.ts";
import orchestrator from "../../deployment-orchestrator/src/index.ts";

function recorder(outcome: Record<string, unknown> | Error = { outcome: "succeeded" }) {
  const calls: { agentId: string; capability: string; input: any }[] = [];
  const binding: AgentRpcBinding = {
    whoami: async () => ({}),
    observe: async () => ({}),
    syscall: async (agentId, capability, input) => {
      calls.push({ agentId, capability, input });
      if (outcome instanceof Error) throw outcome;
      return outcome as never;
    },
  };
  return { calls, binding };
}

function recoveryEnv(db = migratedDb(), extra: Record<string, unknown> = {}) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  return {
    ...baseEnv("cryptophys-recovery-manager", db),
    APPROVER_IDENTITIES: `${OPERATOR_EMAIL},${APPROVER_EMAIL}`,
    POLICY: {
      evaluate: async (input: Record<string, unknown>) => {
        const { parsePolicyRequest, decide } = await import("../../policy-engine/src/index.ts");
        const parsed = parsePolicyRequest(input);
        if (parsed instanceof Error) throw parsed;
        return decide(policyEnv as never, parsed);
      },
    },
    ...extra,
  };
}

const PLAN = { service_id: "cryptophys-platform-api", plan_version: "1", title: "Roll back Platform API", rationale: "Bad release",
  steps: [{ action: "rollback_worker_version", description: "Roll back to the previous version" }] };

async function newPlan(env: any) {
  // Authored by the deploy workflow's service token (an operator), so the approver may approve it.
  const created = await call(recovery, env, req("POST", "/v1/plans", PLAN));
  assert.equal(created.status, 201);
  return created.body.plan;
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const realFetch = globalThis.fetch;

test("TP-012 migration: both agents gain reports.publish exactly once, tier_max stays 1, idempotent", () => {
  const db = migratedDb();
  for (const id of ["recovery-manager", "deployment-orchestrator"]) {
    const row = db.raw.prepare("SELECT tier_max, capabilities_json FROM agents WHERE agent_id = ?").get(id) as any;
    assert.equal(row.tier_max, 1);
    const cnt = db.raw.prepare("SELECT COUNT(*) AS c FROM json_each(?) WHERE value = 'reports.publish'").get(row.capabilities_json) as any;
    assert.equal(cnt.c, 1, `${id} reports.publish count`);
  }
  // running the UPDATE again does not duplicate
  const sql = readFileSync(new URL("../../control-plane-migrations/0018_grant_reports_publish.sql", import.meta.url), "utf8");
  db.raw.exec(sql);
  for (const id of ["recovery-manager", "deployment-orchestrator"]) {
    const row = db.raw.prepare("SELECT capabilities_json FROM agents WHERE agent_id = ?").get(id) as any;
    const cnt = db.raw.prepare("SELECT COUNT(*) AS c FROM json_each(?) WHERE value = 'reports.publish'").get(row.capabilities_json) as any;
    assert.equal(cnt.c, 1, `${id} reports.publish count after rerun`);
  }
});

test("TP-012 recovery expiry: draft whose window closes publishes one warning report", async () => {
  const db = migratedDb();
  const rec = recorder();
  const env = recoveryEnv(db, { AGENTS: rec.binding });
  const plan = await newPlan(env);
  db.raw.prepare("UPDATE recovery_plans SET approve_by = ? WHERE plan_id = ?").run(new Date(Date.now() - 60_000).toISOString(), plan.plan_id);
  const out = await runLifecycle(env as never, plan.plan_id, plan.plan_id, (await import("./harness.ts")).fakeWorkflow().step(plan.plan_id) as never);
  assert.deepEqual(out.closed, ["draft"]);
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].agentId, "recovery-manager");
  assert.equal(rec.calls[0].capability, "reports.publish");
  assert.equal(rec.calls[0].input.severity, "warning");
  assert.equal(rec.calls[0].input.body.reason, "approval_expired");
  assert.equal(rec.calls[0].input.body.disclaimer, "advisory only; not an order");
  // disclaimer present in actual syscall payload already (publishAgentReport adds it)
});

test("TP-012 recovery overdue: executing plan whose window closes publishes critical report", async () => {
  const db = migratedDb();
  const rec = recorder();
  const env = recoveryEnv(db, { AGENTS: rec.binding });
  const plan = await newPlan(env);
  await call(recovery, env, req("POST", `/v1/plans/${plan.plan_id}/approve`, {}, APPROVER_JWT));
  await call(recovery, env, req("POST", `/v1/plans/${plan.plan_id}/executions`, { phase: "start", operator_acknowledged: true }));
  db.raw.prepare("UPDATE recovery_plans SET finish_by = ? WHERE plan_id = ?").run(new Date(Date.now() - 60_000).toISOString(), plan.plan_id);
  const wf = (await import("./harness.ts")).fakeWorkflow();
  const out = await runLifecycle(env as never, plan.plan_id, plan.plan_id, wf.step(plan.plan_id) as never);
  assert.deepEqual(out.closed, ["executing"]);
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].input.severity, "critical");
  assert.equal(rec.calls[0].input.body.reason, "execution_overdue");
});

test("TP-012 no double report: second run publishes nothing extra", async () => {
  const db = migratedDb();
  const rec = recorder();
  const env = recoveryEnv(db, { AGENTS: rec.binding });
  const plan = await newPlan(env);
  db.raw.prepare("UPDATE recovery_plans SET approve_by = ? WHERE plan_id = ?").run(new Date(Date.now() - 60_000).toISOString(), plan.plan_id);
  const wf = (await import("./harness.ts")).fakeWorkflow();
  await runLifecycle(env as never, plan.plan_id, plan.plan_id, wf.step(plan.plan_id) as never);
  const before = rec.calls.length;
  const out = await runLifecycle(env as never, plan.plan_id, plan.plan_id, wf.step(plan.plan_id) as never);
  assert.deepEqual(out.closed, []);
  assert.equal(rec.calls.length, before);
});

test("TP-012 kernel outage: throwing binding still completes, plan disabled, audit written", async () => {
  const db = migratedDb();
  const rec = recorder(new Error("kernel unavailable"));
  const env = recoveryEnv(db, { AGENTS: rec.binding });
  const plan = await newPlan(env);
  db.raw.prepare("UPDATE recovery_plans SET approve_by = ? WHERE plan_id = ?").run(new Date(Date.now() - 60_000).toISOString(), plan.plan_id);
  const wf = (await import("./harness.ts")).fakeWorkflow();
  const out = await runLifecycle(env as never, plan.plan_id, plan.plan_id, wf.step(plan.plan_id) as never);
  assert.deepEqual(out.closed, ["draft"]);
  const row = db.raw.prepare("SELECT status FROM recovery_plans WHERE plan_id = ?").get(plan.plan_id) as any;
  assert.equal(row.status, "disabled");
  const evts = db.raw.prepare("SELECT event_type FROM audit_events WHERE subject = ?").all(plan.plan_id).map((r: any) => r.event_type);
  assert.ok(evts.includes("recovery.plan_expired"));
});

// Owner 2026-11-14 ("hapus aja, karena roadmap berikutnya kita kembangkan Human Ai Interaction & Collaboration"): the
// manual POST /v1/deployments, whose refusals (ci_not_green, commit_not_current_main) were the Orchestrator's warning
// reports, is removed. Its reports now come from the paths that stay; a failed native rollback is one of them.
const ROLLBACK_SVC = "cryptophys-console";
const ROLLBACK_ACCOUNT = "a".repeat(32);
const ROLLBACK_PLAN = "plan_11111111-1111-1111-1111-111111111111";
const ROLLBACK_DEC = "dec_22222222-2222-2222-2222-222222222222";

async function rollbackEnv(extra: Record<string, unknown> = {}) {
  const { appendAuditEvent } = await import("../src/audit.ts");
  const { DeploymentLock } = await import("../../deployment-orchestrator/src/index.ts");
  const db = migratedDb();
  let prev: string | null = null;
  for (const v of ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]) {
    await appendAuditEvent(db as never, { event_type: "registry.desired_version_set", actor: "ci.access", subject: ROLLBACK_SVC, outcome: "success", payload: { previous: prev, desired_version: v } });
    prev = v;
  }
  db.raw.prepare("UPDATE service_registry SET desired_version = 'bbbbbbbbbbbb' WHERE service_id = ?").run(ROLLBACK_SVC);
  const now = new Date().toISOString();
  db.raw.prepare(`INSERT INTO recovery_plans (plan_id, service_id, plan_version, status, steps_json, approved_by, last_execution_json, created_by, created_at, updated_at)
    VALUES (?, ?, 'bbbbbbbbbbbb', 'executing', '{}', 'owner@example.com', ?, 'agent:supervisor', ?, ?)`).run(ROLLBACK_PLAN, ROLLBACK_SVC, JSON.stringify({ policy_decision_id: ROLLBACK_DEC }), now, now);
  db.raw.prepare(`INSERT INTO policy_decisions (decision_id, subject, action, resource, decision, reason, evidence_json, created_at) VALUES (?, 'ai:recovery-manager', 'recovery.execute', ?, 'allow', 'ok', '{}', ?)`).run(ROLLBACK_DEC, ROLLBACK_PLAN, now);
  const stores = new Map<string, Map<string, unknown>>();
  const lockNs = { idFromName: (n: string) => n, get: (id: unknown) => {
    const key = String(id); if (!stores.has(key)) stores.set(key, new Map()); const data = stores.get(key)!;
    const lock = new DeploymentLock({ storage: { get: async (k: string) => data.get(k) as never, put: async (k: string, v: unknown) => { data.set(k, v); } }, blockConcurrencyWhile: (cb) => cb() });
    return { fetch: (i: RequestInfo | URL, init?: RequestInit) => lock.fetch(new Request(i, init)) };
  } };
  const env = baseEnv("cryptophys-deployment-orchestrator", db, {
    GH_ACTIONS_TOKEN: "gh-token", DEPLOYMENT_LOCK: lockNs, CF_DEPLOY_TOKEN: "deploy-token", CF_ACCOUNT_ID: ROLLBACK_ACCOUNT,
    DRIFT: { probeService: async () => ({ reachable: true, healthy: true, version_tag: "bbbbbbbbbbbb", error: null }) },
    REGISTRY: { recordRollback: async () => { throw new Error("must not record"); } },
    ...extra,
  });
  return { db, env };
}

/** Cloudflare's Workers API with no version tagged for the rollback target: the native rollback fails without a deploy. */
function untaggedCloudflare() {
  const posted: unknown[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    assert.ok(url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${ROLLBACK_ACCOUNT}/workers/scripts/${ROLLBACK_SVC}/`), url);
    if (url.endsWith("/deployments") && (init?.method ?? "GET") === "GET") {
      return Response.json({ success: true, result: { deployments: [{ created_on: "2026-11-08T00:00:00Z", versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }] }] } });
    }
    if (url.endsWith("/deployments") && init?.method === "POST") { posted.push(JSON.parse(String(init.body))); return Response.json({ success: true, result: { id: "dep" } }); }
    if (url.includes("/versions?")) return Response.json({ success: true, result: { items: [{ id: "11111111-1111-4111-8111-111111111111", annotations: { "workers/tag": "bbbbbbbbbbbb" }, metadata: { created_on: "2026-11-07T00:00:00Z" } }] } });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { fetcher, posted };
}

async function failNativeRollback(extra: Record<string, unknown>) {
  const { rollbackForRecovery, runNativeRollbacks } = await import("../../deployment-orchestrator/src/index.ts");
  const { SAFE_MINUTES } = await import("../../deployment-orchestrator/src/native-rollback.ts");
  const { db, env } = await rollbackEnv(extra);
  assert.equal((await rollbackForRecovery(env as never, ROLLBACK_PLAN, ROLLBACK_DEC, ROLLBACK_SVC)).dispatched, true);
  let at = Math.ceil((Date.now() + 1_000) / 60_000) * 60_000;
  while (!SAFE_MINUTES.includes(new Date(at).getUTCMinutes())) at += 60_000;
  const cf = untaggedCloudflare();
  const out = await runNativeRollbacks(env as never, at, cf.fetcher, { delayMs: 0 });
  return { db, env, out, cf };
}

test("TP-012 orchestrator failure: a native rollback that cannot run publishes one critical report; the removed POST reports nothing", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (isAccessCerts(url)) return accessCertsResponse();
    throw new Error(`GitHub must not be called: ${url}`);
  }) as typeof fetch;
  try {
    const rec = recorder();
    const { env, out, cf } = await failNativeRollback({ AGENTS: rec.binding });
    assert.deepEqual(out, { executed: 1, succeeded: 0 });
    assert.equal(cf.posted.length, 0, "production unchanged");
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].agentId, "deployment-orchestrator");
    assert.equal(rec.calls[0].capability, "reports.publish");
    assert.equal(rec.calls[0].input.severity, "critical");
    assert.equal(rec.calls[0].input.body.reason, "no_version_with_tag");
    const { CI_JWT } = await import("./harness.ts");
    const res = await call(orchestrator, env, new Request("https://x/v1/deployments", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": CI_JWT, "content-type": "application/json" },
      body: JSON.stringify({ commit_sha: SHA, confirm_production: "DEPLOY" }),
    }));
    assert.deepEqual([res.status, res.body.error], [405, "method_not_allowed"]);
    assert.equal(rec.calls.length, 1, "the removed manual POST publishes no report");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("TP-012 orchestrator kernel outage: a missing or throwing binding leaves the failed outcome unchanged", async () => {
  // missing binding
  let run = await failNativeRollback({});
  assert.deepEqual(run.out, { executed: 1, succeeded: 0 });
  assert.equal((run.db.raw.prepare("SELECT status FROM deployment_requests").get() as any).status, "failed");

  // throwing binding
  const throwing: AgentRpcBinding = { whoami: async () => ({}), observe: async () => ({}), syscall: async () => { throw new Error("boom"); } };
  run = await failNativeRollback({ AGENTS: throwing });
  assert.deepEqual(run.out, { executed: 1, succeeded: 0 });
  assert.equal((run.db.raw.prepare("SELECT status FROM deployment_requests").get() as any).status, "failed");
  assert.equal((run.db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'deployment.rollback_failed'").get() as any).n, 1, "the failure is audited either way");
});
