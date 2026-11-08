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

test("TP-012 orchestrator rejection: ci_not_green returns 409 and publishes one warning report", async () => {
  const { fakeWorkflow } = await import("./harness.ts");
  // setup github fetch
  const github = { mainSha: SHA, runs: [{ workflow_id: 1, name: "Validate", status: "completed", conclusion: "failure", run_number: 7 }] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("access/certs")) return (await import("./harness.ts")).accessCertsResponse();
    if (url.endsWith("/git/ref/heads/main")) return new Response(JSON.stringify({ object: { sha: github.mainSha } }), { status: 200 });
    if (url.endsWith("/status")) return new Response(JSON.stringify({ state: "success", total_count: 0 }), { status: 200 });
    if (url.includes("/actions/runs?head_sha=")) return new Response(JSON.stringify({ total_count: github.runs.length, workflow_runs: github.runs }), { status: 200 });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  try {
    const rec = recorder();
    const db = migratedDb();
    const e: any = {
      SERVICE_NAME: "cryptophys-deployment-orchestrator",
      SERVICE_ENVIRONMENT: "production",
      API_CONTRACT_VERSION: "v1",
      GH_ACTIONS_TOKEN: "gh-token",
      DEPLOY_ALLOWED_IDENTITIES: "ci-client.access",
      DEPLOYMENT_LOCK: (await import("../../deployment-orchestrator/src/index.ts")).DeploymentLock ? { idFromName: (n: string) => n, get: (id: any) => {
        const data = new Map();
        const lock = new ((require("../../deployment-orchestrator/src/index.ts")).DeploymentLock)({ storage: { get: async (k: string) => data.get(k), put: async (k: string, v: any) => { data.set(k, v); } }, blockConcurrencyWhile: (cb: any) => cb() });
        return { fetch: (input: any, init: any) => lock.fetch(new Request(input, init)) };
      } } : null,
      DB: db,
      AI: { calls: [], reply: { response: "{}" }, async run() { return { response: "{}" }; } },
      AI_MODEL: "m",
      ACCESS_TEAM_DOMAIN: "cryptophys.cloudflareaccess.com",
      ACCESS_AUD: "test-audience-tag",
      AGENTS: rec.binding,
    };
    // CI_JWT
    const { CI_JWT } = await import("./harness.ts");
    const res = await call(orchestrator, e, new Request("https://x/v1/deployments", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": CI_JWT, "content-type": "application/json" },
      body: JSON.stringify({ commit_sha: SHA, confirm_production: "DEPLOY" }),
    }));
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "ci_not_green");
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].agentId, "deployment-orchestrator");
    assert.equal(rec.calls[0].input.severity, "warning");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("TP-012 orchestrator kernel outage: missing/throwing binding leaves 409 unchanged", async () => {
  // missing binding
  const github = { mainSha: SHA, runs: [{ workflow_id: 1, name: "Validate", status: "completed", conclusion: "failure", run_number: 7 }] };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("access/certs")) return (await import("./harness.ts")).accessCertsResponse();
    if (url.endsWith("/git/ref/heads/main")) return new Response(JSON.stringify({ object: { sha: github.mainSha } }), { status: 200 });
    if (url.endsWith("/status")) return new Response(JSON.stringify({ state: "success", total_count: 0 }), { status: 200 });
    if (url.includes("/actions/runs?head_sha=")) return new Response(JSON.stringify({ total_count: github.runs.length, workflow_runs: github.runs }), { status: 200 });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  try {
    const db = migratedDb();
    const { CI_JWT } = await import("./harness.ts");
    const base = {
      SERVICE_NAME: "cryptophys-deployment-orchestrator",
      SERVICE_ENVIRONMENT: "production",
      API_CONTRACT_VERSION: "v1",
      GH_ACTIONS_TOKEN: "gh-token",
      DEPLOY_ALLOWED_IDENTITIES: "ci-client.access",
      DEPLOYMENT_LOCK: { idFromName: (n: string) => n, get: (id: any) => {
        const data = new Map();
        return { fetch: async (input: any, init: any) => new Response(JSON.stringify({ acquired: true }), { status: 200 }) };
      } },
      DB: db,
      AI: { calls: [], reply: { response: "{}" }, async run() { return { response: "{}" }; } },
      AI_MODEL: "m",
      ACCESS_TEAM_DOMAIN: "cryptophys.cloudflareaccess.com",
      ACCESS_AUD: "test-audience-tag",
    };
    // missing
    let e: any = { ...base };
    let res = await call(orchestrator, e, new Request("https://x/v1/deployments", {
      method: "POST", headers: { "cf-access-jwt-assertion": CI_JWT, "content-type": "application/json" },
      body: JSON.stringify({ commit_sha: SHA, confirm_production: "DEPLOY" }),
    }));
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "ci_not_green");

    // throwing binding
    const throwing: AgentRpcBinding = { whoami: async () => ({}), observe: async () => ({}), syscall: async () => { throw new Error("boom"); } };
    e = { ...base, AGENTS: throwing };
    res = await call(orchestrator, e, new Request("https://x/v1/deployments", {
      method: "POST", headers: { "cf-access-jwt-assertion": CI_JWT, "content-type": "application/json" },
      body: JSON.stringify({ commit_sha: SHA, confirm_production: "DEPLOY" }),
    }));
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "ci_not_green");
  } finally {
    globalThis.fetch = realFetch;
  }
});
