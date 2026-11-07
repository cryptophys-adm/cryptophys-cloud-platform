// AI Worker OS (ADR-0007): capability catalog, policy syscall gate, syscall targets'
// decision re-verification, the supervisor agent cycle, the kernel HTTP API and MCP.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, CI_JWT, OPERATOR_EMAIL, OPERATOR_JWT, OUTSIDER_JWT, baseEnv, call, fakeAi, fakeWorkflow, migratedDb, req,
} from "./harness.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { CAPABILITIES, agentSyscallChecks, verifySyscallDecision } from "../src/capabilities.ts";
import policy, { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import recovery, { proposeFromAgent } from "../../recovery-manager/src/index.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { runCycle, SerialCycleQueue, templateProposal } from "../../ai-kernel/src/supervisor.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { REQUIRED_MIGRATION, schemaReady } from "../src/readiness.ts";

type Db = ReturnType<typeof migratedDb>;
const SUB = "agent:supervisor";

test("readiness requires the atomic syscall-consumption migration and the newest required migration", async () => {
  const db = migratedDb();
  assert.equal(REQUIRED_MIGRATION, "0027_register_aether.sql");
  assert.equal(await schemaReady({ DB: db } as never), true);
  db.raw.prepare("DELETE FROM d1_migrations WHERE name = '0011_agent_syscall_consumptions.sql'").run();
  assert.equal(await schemaReady({ DB: db } as never), false);
  const db2 = migratedDb();
  db2.raw.prepare("DELETE FROM d1_migrations WHERE name = ?").run(REQUIRED_MIGRATION);
  assert.equal(await schemaReady({ DB: db2 } as never), false);
  const db3 = migratedDb();
  db3.raw.prepare("DELETE FROM d1_migrations WHERE name = ?").run("0017_report_kinds_xauusd_and_hud.sql");
  assert.equal(await schemaReady({ DB: db3 } as never), false, "readiness requires migration 0017");
});

test("0016 & 0017 register 31 tier-1 agents and add platform, XAUUSD, and HUD report kinds without operator impersonation", async () => {
  const { env, db } = kernelEnv();
  const rows = db.raw.prepare("SELECT agent_id, host_worker, tier_max, capabilities_json, status, status_reason FROM agents ORDER BY agent_id").all() as Array<{
    agent_id: string;
    host_worker: string;
    tier_max: number;
    capabilities_json: string;
    status: string;
    status_reason: string | null;
  }>;
  // 3 kernel agents + 8 platform worker AI agents + 7 active XAUUSD agents + 14 XAUUSD HUD agents = 32,
  // plus the 4 Aether agents of 0027 (TP-027, tested in register-aether-tp027.test.ts) = 36 total.
  assert.equal(rows.length, 36);
  assert.equal(rows.filter((r) => r.host_worker === "cryptophys-aether").length, 4);
  const xauusdAgents = rows.filter((r) => r.host_worker === "xauusd-ai-trading-assistant");
  assert.equal(xauusdAgents.length, 21);
  const hudAgents = xauusdAgents.filter((r) => r.agent_id.startsWith("hud-"));
  assert.equal(hudAgents.length, 14);
  for (const r of rows) {
    if (r.agent_id === "signal-engine") {
      assert.equal(r.status, "suspended");
      assert.match(r.status_reason ?? "", /retired/);
    } else {
      assert.equal(r.status, "enabled");
    }
    if (r.agent_id !== "supervisor") {
      assert.equal(r.tier_max, 1, `${r.agent_id} must be capped at tier_max=1`);
      const caps = JSON.parse(r.capabilities_json) as string[];
      assert.ok(caps.includes("reports.publish"), `${r.agent_id} must be able to publish reports`);
    }
    const caps = JSON.parse(r.capabilities_json) as string[];
    assert.ok(caps.length > 0);
    for (const c of caps) {
      assert.ok(Object.hasOwn(CAPABILITIES, c), `${r.agent_id} capability ${c} must exist in CAPABILITIES`);
    }
  }

  // Operator and CI identities must never become an agent by supplying a caller-controlled header.
  // External MCP sessions require a separately registered Access principal; in-account callers
  // use AgentRpc binding props. This PR intentionally does not seed external principals.
  for (const [label, jwt] of [["operator", OPERATOR_JWT], ["CI service token", CI_JWT]] as const) {
    const listed = await call(
      kernel,
      env,
      req("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, jwt, { "x-cryptophys-agent-id": "recovery-manager" }),
    );
    assert.equal(listed.status, 200, label);
    const names = listed.body.result.tools.map((tool: any) => tool.name);
    assert.ok(names.includes("platform_status"), `${label} retains operator tools`);
    assert.ok(!names.includes("agent_whoami"), `${label} cannot obtain agent tools`);
    assert.ok(!names.includes("agent_syscall"), `${label} cannot obtain agent syscalls`);

    const attempted = await call(
      kernel,
      env,
      req("POST", "/mcp", {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "agent_syscall", arguments: { capability: "recovery.propose", input: {} } },
      }, jwt, { "x-cryptophys-agent-id": "recovery-manager" }),
    );
    assert.equal(attempted.body.error.code, -32602, `${label} cannot call an agent syscall`);
  }
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM recovery_plans").get() as any).n, 0,
    "operator-supplied agent headers cannot create agent-authored recovery plans");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_reports").get() as any).n, 0,
    "operator-supplied agent headers cannot publish reports");
});

function memory() {
  const m = new Map<string, unknown>();
  return { m, async get<T>(k: string) { return m.get(k) as T | undefined; }, async put(k: string, v: unknown) { m.set(k, structuredClone(v)); } };
}

/** The kernel env wired like production: real Policy Engine decisions, real Recovery Manager writes. */
function kernelEnv(db: Db = migratedDb(), extra: Record<string, unknown> = {}) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const recoveryEnv = { ...baseEnv("cryptophys-recovery-manager", db), RECOVERY_LIFECYCLE: fakeWorkflow().binding };
  const mem = memory();
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    POLICY: {
      evaluate: async (input: Record<string, unknown>) => {
        const parsed = parsePolicyRequest(input);
        if (parsed instanceof Error) throw parsed;
        return decide(policyEnv as never, parsed);
      },
    },
    // Same as RecoveryRpc.propose in the Workers' worker.ts.
    RECOVERY: {
      propose: async (agentId: string, decisionId: string, input: Record<string, unknown>) => {
        await verifySyscallDecision(db, decisionId, agentId, "recovery.propose");
        return proposeFromAgent(recoveryEnv as never, agentId, input);
      },
    },
    ...extra,
  };
  env.SUPERVISOR = { idFromName: (n: string) => n, get: () => ({ cycle: (t: "scheduled" | "operator") => runCycle(env as never, mem, t), status: async () => (await mem.get("last_cycle")) ?? null }) };
  if (!("SIGNAL_ANALYST" in extra)) {
    env.SIGNAL_ANALYST = { idFromName: (n: string) => n, get: () => ({ cycle: async () => ({ agent_id: "signal-analyst", trigger: "scheduled", ran_at: new Date().toISOString(), findings: [] }), status: async () => null }) };
  }
  if (!("AUDITOR" in extra)) {
    env.AUDITOR = { idFromName: (n: string) => n, get: () => ({ cycle: async () => ({ agent_id: "auditor", trigger: "scheduled", ran_at: new Date().toISOString(), findings: [] }), status: async () => null }) };
  }
  if (!("MEMORY" in extra)) {
    env.MEMORY = { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) };
  }
  return { env, db, mem };
}

function drift(db: Db, serviceId: string, drifted: boolean, minutesAgo: number, reasons = ["version_mismatch"]) {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  db.raw.prepare(`INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at)
    VALUES (?, ?, 'd', 'o', ?, ?, ?)`).run(`obs_${serviceId}_${minutesAgo}`, serviceId, drifted ? 1 : 0,
    JSON.stringify({ reasons: drifted ? reasons : [], desired_version: "aaaaaaaaaaaa", probe: { version_tag: drifted ? "bbbbbbbbbbbb" : "aaaaaaaaaaaa" } }), at);
}
const AI_PLAN = { response: JSON.stringify({ title: "Redeploy Platform API", rationale: "Observed version differs from desired twice.",
  steps: [{ action: "redeploy_commit", description: "Redeploy the desired commit." }, { action: "manual", description: "Verify drift." }] }) };

// ---------------------------------------------------------------- catalog and policy

test("migration 0010 seeds the supervisor at tier 1, the kill switch on, and the kernel in the registry", () => {
  const db = migratedDb();
  const a = db.raw.prepare("SELECT tier_max, status, capabilities_json FROM agents WHERE agent_id = 'supervisor'").get() as any;
  assert.deepEqual([a.tier_max, a.status, JSON.parse(a.capabilities_json)], [1, "enabled", ["platform.observe", "recovery.propose", "memory.recall", "memory.remember", "consensus.propose"]]);
  assert.equal((db.raw.prepare("SELECT value FROM kernel_controls").get() as any).value, "1");
  assert.ok(db.raw.prepare("SELECT 1 FROM service_registry WHERE service_id = 'cryptophys-ai-kernel'").get());
  assert.ok(db.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_syscall_consumptions'").get());
  assert.throws(() => db.raw.prepare("UPDATE agents SET tier_max = 3 WHERE agent_id = 'supervisor'").run(), /CHECK/, "no agent can ever hold tier 3");
  db.raw.prepare("INSERT INTO signal_ingest_runs (run_id, trigger, started_at, finished_at, series_total, series_failed, results_json) VALUES ('r', 'agent', 't', 't', 0, 0, '[]')").run();
});

test("syscall checks: tiers, grants, prohibitions, suspension, kill switch and rate limit", async () => {
  const db = migratedDb();
  const failed = async (subject: string, cap: string) => (await agentSyscallChecks(db, subject, cap)).filter((c) => !c.passed).map((c) => c.id);
  assert.deepEqual(await failed(SUB, "recovery.propose"), []);
  assert.ok((await failed(SUB, "signals.reingest")).includes("capability_known"));
  assert.equal(CAPABILITIES["signals.reingest"], undefined);
  assert.ok((await failed(SUB, "deploy.release")).includes("not_human_only"));
  assert.ok((await failed(SUB, "deploy.release")).includes("capability_granted"));
  assert.ok((await failed(SUB, "trade.execute_order")).includes("capability_not_prohibited"));
  assert.ok((await failed(SUB, "__proto__")).includes("capability_known"));
  assert.ok((await failed("agent:ghost", "platform.observe")).includes("agent_registered"));
  assert.ok((await failed(OPERATOR_EMAIL, "platform.observe")).includes("subject_is_agent"));
  db.raw.prepare("UPDATE agents SET tier_max = 0").run();
  assert.ok((await failed(SUB, "recovery.propose")).includes("tier_within_agent_limit"));
  db.raw.prepare("UPDATE agents SET tier_max = 2, status = 'suspended'").run();
  assert.ok((await failed(SUB, "platform.observe")).includes("agent_enabled"));
  db.raw.prepare("UPDATE agents SET status = 'enabled'").run();
  db.raw.prepare("UPDATE kernel_controls SET value = '0'").run();
  assert.ok((await failed(SUB, "platform.observe")).includes("agents_enabled"));
  db.raw.prepare("UPDATE kernel_controls SET value = '1'").run();
  for (const i of [1, 2, 3, 4, 5, 6]) {
    db.raw.prepare(`INSERT INTO agent_syscall_consumptions (decision_id, agent_id, capability, consumed_at)
      VALUES (?, 'supervisor', 'recovery.propose', ?)`).run(`seed_decision_${i}`, new Date().toISOString());
  }
  assert.ok((await failed(SUB, "recovery.propose")).includes("rate_limit"), `max ${CAPABILITIES["recovery.propose"].max_per_hour}/h`);
});

test("Policy Engine decides agent.syscall; over HTTP a person can never act as an agent", async () => {
  const db = migratedDb();
  const env = baseEnv("cryptophys-policy-engine", db);
  const allow = await decide(env as never, { subject: SUB, action: "agent.syscall", resource: "recovery.propose", context: {} });
  assert.equal(allow.decision, "allow");
  const spoof = await decide(env as never, { subject: SUB, action: "agent.syscall", resource: "deploy.release", context: { __subject: "x" } });
  assert.equal(spoof.decision, "deny");
  const http = await call(policy, env, req("POST", "/v1/evaluate", { subject: SUB, action: "agent.syscall", resource: "recovery.propose" }));
  assert.equal(http.body.decision, "deny", "the HTTP subject is the caller's identity");
  assert.match(http.body.reason, /subject_is_agent/);
});

test("syscall targets accept only a fresh, matching, unused allow decision", async () => {
  const db = migratedDb();
  const env = baseEnv("cryptophys-policy-engine", db);
  const ok = await decide(env as never, { subject: SUB, action: "agent.syscall", resource: "recovery.propose", context: {} });
  await verifySyscallDecision(db, ok.decision_id, "supervisor", "recovery.propose");
  await assert.rejects(verifySyscallDecision(db, ok.decision_id, "supervisor", "recovery.propose"), /already_used/);
  await assert.rejects(verifySyscallDecision(db, undefined, "supervisor", "recovery.propose"), /policy_decision_required/);
  await assert.rejects(verifySyscallDecision(db, ok.decision_id, "supervisor", "memory.remember"), /policy_decision_invalid/);
  await assert.rejects(verifySyscallDecision(db, ok.decision_id, "other-agent", "recovery.propose"), /policy_decision_invalid/);
  await assert.rejects(verifySyscallDecision(db, ok.decision_id, "supervisor", "recovery.propose", Date.now() + 301_000), /policy_decision_invalid/);
  const future = await decide(env as never, { subject: SUB, action: "agent.syscall", resource: "recovery.propose", context: {} });
  await assert.rejects(verifySyscallDecision(db, future.decision_id, "supervisor", "recovery.propose", Date.now() - 1_000), /policy_decision_invalid/);
  const denied = await decide(env as never, { subject: SUB, action: "agent.syscall", resource: "deploy.release", context: {} });
  await assert.rejects(verifySyscallDecision(db, denied.decision_id, "supervisor", "deploy.release"), /policy_decision_invalid/);
});

test("syscall decision consumption is atomic under replay and rate-limit races, and rechecks the kill switch", async () => {
  const db = migratedDb();
  const env = baseEnv("cryptophys-policy-engine", db);
  const replay = await decide(env as never, { subject: SUB, action: "agent.syscall", resource: "recovery.propose", context: {} });
  const replayResults = await Promise.allSettled([
    verifySyscallDecision(db, replay.decision_id, "supervisor", "recovery.propose"),
    verifySyscallDecision(db, replay.decision_id, "supervisor", "recovery.propose"),
  ]);
  assert.equal(replayResults.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(replayResults.filter(r => r.status === "rejected").length, 1);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_syscall_consumptions WHERE decision_id = ?").get(replay.decision_id) as any).n, 1);

  const revoked = await decide(env as never, { subject: SUB, action: "agent.syscall", resource: "recovery.propose", context: {} });
  db.raw.prepare("UPDATE kernel_controls SET value = '0' WHERE control = 'agents_enabled'").run();
  await assert.rejects(verifySyscallDecision(db, revoked.decision_id, "supervisor", "recovery.propose"), /policy_decision_revoked/);

  const rateDb = migratedDb();
  const rateEnv = baseEnv("cryptophys-policy-engine", rateDb);
  const decisions = await Promise.all(Array.from({ length: 7 }, () => decide(rateEnv as never, { subject: SUB, action: "agent.syscall", resource: "recovery.propose", context: {} })));
  assert.ok(decisions.every(d => d.decision === "allow"), "decisions may be minted before concurrent target consumption");
  const results = await Promise.allSettled(decisions.map(d => verifySyscallDecision(rateDb, d.decision_id, "supervisor", "recovery.propose")));
  assert.equal(results.filter(r => r.status === "fulfilled").length, CAPABILITIES["recovery.propose"].max_per_hour);
  assert.equal(results.filter(r => r.status === "rejected").length, decisions.length - CAPABILITIES["recovery.propose"].max_per_hour!);
  assert.equal((rateDb.raw.prepare("SELECT COUNT(*) AS n FROM agent_syscall_consumptions WHERE agent_id = 'supervisor' AND capability = 'recovery.propose'").get() as any).n, CAPABILITIES["recovery.propose"].max_per_hour);
});

test("reports.publish enforces the 16 KiB JSON body limit before inserting", async () => {
  const { env, db } = kernelEnv();
  const oversized = await syscall(env as never, "platform-api", "reports.publish", {
    kind: "platform_digest",
    severity: "info",
    subject: "oversized report",
    ai_status: "ok",
    body: { payload: "x".repeat(16 * 1024) },
  });
  assert.equal(oversized.outcome, "failed");
  assert.equal(oversized.reason, "report_body_too_large");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_reports").get() as any).n, 0);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE capability = 'reports.publish' AND outcome = 'failed'").get() as any).n, 1);
  const auditRow = db.raw.prepare("SELECT input_json FROM agent_actions WHERE capability = 'reports.publish' AND outcome = 'failed'").get() as { input_json: string };
  assert.equal(JSON.parse(auditRow.input_json).truncated, true, "oversized audit input is replaced by a valid truncation marker");
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("denied syscalls are recorded and audited; tier 3 never dispatches", async () => {
  const { env, db } = kernelEnv();
  const r = await syscall(env as never, "supervisor", "deploy.release", { commit: "x" });
  assert.equal(r.outcome, "denied");
  const row = db.raw.prepare("SELECT outcome, tier FROM agent_actions WHERE capability = 'deploy.release'").get() as any;
  assert.deepEqual([row.outcome, row.tier], ["denied", 3]);
  const noPolicy = await syscall({ ...env, POLICY: { evaluate: async () => { throw new Error("down"); } } } as never, "supervisor", "recovery.propose");
  assert.deepEqual([noPolicy.outcome, (noPolicy as any).reason], ["denied", "policy_unavailable"], "fails closed");
  assert.equal((await verifyAuditChain(db)).valid, true);
});

// ---------------------------------------------------------------- supervisor agent

test("SupervisorAgent serializes overlapping cycles and recovers its queue after a failure", async () => {
  const queue = new SerialCycleQueue();
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = queue.run(async () => {
    active++;
    peak = Math.max(peak, active);
    await gate;
    active--;
    return "first";
  });
  const second = queue.run(async () => {
    active++;
    peak = Math.max(peak, active);
    active--;
    return "second";
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(active, 1);
  assert.equal(peak, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.equal(peak, 1);
  const failed = queue.run(async () => { throw new Error("cycle failed"); });
  const after = queue.run(async () => "after");
  await assert.rejects(failed, /cycle failed/);
  assert.equal(await after, "after");
});

test("supervisor: persistent drift -> AI-drafted tier 1 proposal a human can approve", async () => {
  const { env, db, mem } = kernelEnv(migratedDb(), { AI: fakeAi(AI_PLAN) });
  drift(db, "cryptophys-platform-api", true, 20);
  drift(db, "cryptophys-platform-api", true, 5);
  drift(db, "cryptophys-policy-engine", false, 20);
  drift(db, "cryptophys-policy-engine", true, 5); // transient: not persistent
  const report = await runCycle(env as never, mem, "scheduled");
  const kinds = report.findings.map((f) => `${f.kind}:${f.service_id ?? ""}:${f.action}:${f.outcome ?? ""}`);
  assert.deepEqual(kinds, ["drift:cryptophys-platform-api:recovery.propose:succeeded", "drift:cryptophys-platform-api:consensus.propose:succeeded"]);
  const plan = db.raw.prepare("SELECT plan_id, status, created_by, steps_json FROM recovery_plans").get() as any;
  assert.deepEqual([JSON.parse(plan.steps_json).title, plan.status, plan.created_by], ["Redeploy Platform API", "draft", "agent:supervisor"]);

  // Only a person can approve, and separation of duties holds against the agent author.
  const recoveryEnv = { ...baseEnv("cryptophys-recovery-manager", db), APPROVER_IDENTITIES: APPROVER_EMAIL, RECOVERY_LIFECYCLE: fakeWorkflow().binding, POLICY: {} };
  const approved = await call(recovery, recoveryEnv, req("POST", `/v1/plans/${plan.plan_id}/approve`, {}, APPROVER_JWT));
  assert.equal(approved.body.plan.status, "approved");
  const trail = db.raw.prepare("SELECT event_type, actor FROM audit_events WHERE event_type = 'agent.action' ORDER BY rowid").all().map((r: any) => r.actor);
  // recovery.propose, then the same remediation proposed to the shadow consensus (ADR-0009).
  assert.deepEqual(trail, [SUB, SUB]);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("supervisor: no duplicate proposals, template when AI is unavailable, nothing when suspended", async () => {
  const k = kernelEnv(migratedDb(), { AI: fakeAi({ response: "not json" }) });
  drift(k.db, "cryptophys-audit-ledger", true, 20, ["health_check_failed"]);
  drift(k.db, "cryptophys-audit-ledger", true, 5, ["health_check_failed"]);
  const first = await runCycle(k.env as never, k.mem, "scheduled");
  assert.equal(first.findings[0].outcome, "succeeded");
  assert.equal(first.findings[0].ai, "invalid_output");
  const plan = k.db.raw.prepare("SELECT steps_json FROM recovery_plans").get() as any;
  assert.deepEqual(JSON.parse(plan.steps_json).steps.map((s: any) => s.action), ["manual", "rollback_worker_version"], "template proposal");
  assert.deepEqual(templateProposal({ service_id: "x", drifted: true, persistent: true, reasons: ["version_mismatch"], desired_version: "a", observed_version: "b" }).steps[0].action, "redeploy_commit");

  const second = await runCycle(k.env as never, k.mem, "scheduled");
  assert.equal((k.db.raw.prepare("SELECT COUNT(*) AS n FROM recovery_plans").get() as any).n, 1, "open plan -> no duplicate");
  assert.deepEqual(second.findings.map((f) => f.action), ["none"]);

  k.db.raw.prepare("UPDATE agents SET status = 'suspended'").run();
  assert.equal((await runCycle(k.env as never, k.mem, "scheduled")).skipped, "agent_suspended");
  k.db.raw.prepare("UPDATE agents SET status = 'enabled'").run();
  k.db.raw.prepare("UPDATE kernel_controls SET value = '0'").run();
  assert.equal((await runCycle(k.env as never, k.mem, "scheduled")).skipped, "agents_disabled");
});

// ---------------------------------------------------------------- HTTP and MCP

test("kernel HTTP: readiness, agents, suspension by any operator, resumption and kill switch only by an approver", async () => {
  const { env } = kernelEnv();
  assert.equal((await call(kernel, env, req("GET", "/ready"))).body.status, "ready");
  assert.equal((await call(kernel, env, req("GET", "/v1/agents", undefined, OUTSIDER_JWT))).status, 403);
  const agents = await call(kernel, env, req("GET", "/v1/agents"));
  const supAgent = agents.body.agents.find((a: any) => a.agent_id === "supervisor");
  assert.deepEqual(supAgent.capabilities.map((c: any) => c.tier), [0, 1, 0, 1, 1]);
  const suspended = await call(kernel, env, req("POST", "/v1/agents/supervisor/suspend", { reason: "test" }, OPERATOR_JWT));
  assert.equal(suspended.body.agent.status, "suspended");
  assert.equal((await call(kernel, env, req("POST", "/v1/agents/supervisor/resume", {}, OPERATOR_JWT))).status, 403);
  assert.equal((await call(kernel, env, req("POST", "/v1/agents/supervisor/resume", {}, APPROVER_JWT))).body.agent.status, "enabled");
  assert.equal((await call(kernel, env, req("POST", "/v1/kernel/agents-enabled", { enabled: false }))).body.agents_enabled, false);
  assert.equal((await call(kernel, env, req("POST", "/v1/kernel/agents-enabled", { enabled: true }))).status, 403);
  assert.equal((await call(kernel, env, req("POST", "/v1/kernel/agents-enabled", { enabled: true }, APPROVER_JWT))).body.agents_enabled, true);
  const woke = await call(kernel, env, req("POST", "/v1/agents/supervisor/wake", {}));
  assert.equal(woke.body.trigger, "operator");
  assert.equal((await call(kernel, env, req("GET", "/v1/agents/supervisor"))).body.last_cycle.trigger, "operator");
  assert.equal((await call(kernel, env, req("POST", "/v1/agents/ghost/suspend", { reason: "x" }))).status, 404);
});

test("MCP: initialize, tools/list, tools/call; approver-only tools refuse operators", async () => {
  const { env } = kernelEnv();
  const rpc = (body: unknown, jwt = OPERATOR_JWT) => call(kernel, env, req("POST", "/mcp", body, jwt));
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  assert.equal(init.body.result.serverInfo.name, "cryptophys-ai-kernel");
  assert.equal((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const tools = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.ok(tools.body.result.tools.some((t: any) => t.name === "platform_status"));
  assert.ok(tools.body.result.tools.every((t: any) => !/deploy|secret|trade|approve/.test(t.name)), "no tool approves, deploys, rotates or trades");
  const status = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "platform_status", arguments: {} } });
  assert.equal(JSON.parse(status.body.result.content[0].text).agents_enabled, true);
  const resume = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "resume_agent", arguments: { agent_id: "supervisor" } } });
  assert.equal(resume.body.result.isError, true);
  const on = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "set_agents_enabled", arguments: { enabled: true } } });
  assert.equal(on.body.result.isError, true);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 6, method: "nope" })).body.error.code, -32601);
  assert.equal((await call(kernel, env, req("POST", "/mcp", { jsonrpc: "2.0", id: 7, method: "tools/list" }, OUTSIDER_JWT))).status, 403);
});

// ---------------------------------------------------------------- Platform API gateway

test("Platform API gateway: readiness needs its AI, D1 and kernel bindings; overview with an AI summary", async () => {
  const { env: kEnv, db } = kernelEnv();
  const { default: api } = await import("../../platform-api/src/index.ts");
  const { observe } = await import("../../ai-kernel/src/syscall.ts");
  const apiEnv: any = {
    PLATFORM_NAME: "cryptophys-cloud-platform", PLATFORM_ENVIRONMENT: "production", API_CONTRACT_VERSION: "v1",
    ACCESS_TEAM_DOMAIN: (kEnv as any).ACCESS_TEAM_DOMAIN, ACCESS_AUD: (kEnv as any).ACCESS_AUD, OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL}`,
    DB: db, AI: fakeAi({ response: JSON.stringify({ summary: "All services in sync.", attention: [] }) }),
    KERNEL: { overview: () => observe(kEnv as never) },
  };
  const ready = await call(api, apiEnv, req("GET", "/ready"));
  assert.equal(ready.body.status, "ready");
  assert.equal((await call(api, { ...apiEnv, KERNEL: undefined }, req("GET", "/ready"))).status, 503);
  assert.equal((await call(api, { ...apiEnv, AI: undefined }, req("GET", "/ready"))).status, 503);
  assert.equal((await call(api, apiEnv, req("GET", "/v1/overview", undefined, OUTSIDER_JWT))).status, 403);
  const plain = await call(api, apiEnv, req("GET", "/v1/overview"));
  assert.equal(plain.body.overview.agents_enabled, true);
  assert.equal(plain.body.advisory, undefined);
  const advised = await call(api, apiEnv, req("GET", "/v1/overview?advisory=true"));
  assert.deepEqual([advised.body.advisory.status, advised.body.advisory.data.summary], ["ok", "All services in sync."]);
  const down = await call(api, { ...apiEnv, KERNEL: { overview: async () => { throw new Error("x"); } } }, req("GET", "/v1/overview"));
  assert.equal(down.status, 503);
});

test("AgentRpc (no token): a Worker acts only as agents it hosts, at tier_max <= 1, through the normal syscall checks", async () => {
  const { rpcWhoami, rpcObserve, rpcSyscall, callerHostWorker } = await import("../../ai-kernel/src/agent-rpc.ts");
  const { env, db } = kernelEnv();
  const xau = { host_worker: "xauusd-ai-trading-assistant" };
  const api = { host_worker: "cryptophys-platform-api" };

  // The caller identity comes only from binding props; missing or malformed props are refused.
  assert.equal(callerHostWorker(undefined), null);
  assert.equal(callerHostWorker({ host_worker: "Bad Name!" }), null);
  assert.deepEqual(await rpcWhoami(env as never, undefined, "xauusd-analyst"), { error: "caller_identity_missing" });

  const me = await rpcWhoami(env as never, xau, "hud-prophet");
  assert.equal(me.agent_id, "hud-prophet");
  assert.equal(me.access_identity, "rpc:xauusd-ai-trading-assistant");

  // A Worker cannot impersonate another Worker's agent, nor the tier 2 supervisor.
  assert.deepEqual(await rpcWhoami(env as never, api, "xauusd-analyst"), { error: "agent_not_hosted_by_caller" });
  assert.equal((await rpcSyscall(env as never, xau, "platform-api", "platform.observe", {})).reason, "agent_not_hosted_by_caller");
  assert.equal((await rpcSyscall(env as never, { host_worker: "cryptophys-ai-kernel" }, "supervisor", "platform.observe", {})).reason, "kernel_agent_internal");
  assert.equal((await rpcWhoami(env as never, xau, "nope")).error, "agent_not_registered");

  // observe is tier 0 only; a granted tier 0 read goes through (tier 0 reads are not ledgered).
  assert.equal((await rpcObserve(env as never, api, "platform-api", "recovery.propose", {})).reason, "agent_observe_requires_tier_0");
  const ok = await rpcObserve(env as never, api, "platform-api", "platform.observe", {});
  assert.equal(ok.outcome, "succeeded");
  const published = await rpcSyscall(env as never, api, "platform-api", "reports.publish", {
    kind: "platform_digest", severity: "info", subject: "Platform API test digest",
    ai_status: "ok", body: { summary: "bounded report path" },
  });
  assert.equal(published.outcome, "succeeded");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_reports WHERE agent_id = 'platform-api' AND kind = 'platform_digest'").get() as any).n, 1);
  // An ungranted capability is still denied by the normal syscall checks, and that is ledgered.
  assert.equal((await rpcSyscall(env as never, api, "platform-api", "recovery.propose", {})).outcome, "denied");
  const rows = db.raw.prepare("SELECT outcome FROM agent_actions WHERE agent_id = 'platform-api' ORDER BY rowid").all() as Array<{ outcome: string }>;
  assert.deepEqual(rows.map((r) => r.outcome), ["succeeded", "denied"]);
});

test("TP-027 Aether: four tier-1 agents hosted by cryptophys-aether, reachable only through AgentRpc with that host, publishing knowledge_audit reports", async () => {
  const { rpcWhoami, rpcSyscall } = await import("../../ai-kernel/src/agent-rpc.ts");
  const { REPORT_KINDS } = await import("../../ai-kernel/src/reports.ts");
  const { env, db } = kernelEnv();
  const rows = db.raw.prepare("SELECT agent_id, tier_max, capabilities_json, status FROM agents WHERE host_worker = 'cryptophys-aether' ORDER BY agent_id").all() as Array<{ agent_id: string; tier_max: number; capabilities_json: string; status: string }>;
  assert.deepEqual(rows.map((r) => r.agent_id), ["aether-auditor", "aether-calibrator", "aether-curator", "aether-guardian"]);
  for (const r of rows) {
    assert.equal(r.tier_max, 1);
    assert.equal(r.status, "enabled");
    const caps = JSON.parse(r.capabilities_json) as string[];
    assert.ok(caps.includes("reports.publish"));
    for (const c of caps) {
      assert.ok(Object.hasOwn(CAPABILITIES, c), c);
      assert.ok((CAPABILITIES as Record<string, { tier: number }>)[c]!.tier <= 1, `${r.agent_id} ${c} must be tier <= 1`);
    }
  }
  assert.ok((REPORT_KINDS as readonly string[]).includes("knowledge_audit"));

  // The service row exists (it hosts the agents) but stays disabled until the Worker is deployed.
  const svc = db.raw.prepare("SELECT status, metadata_json FROM service_registry WHERE service_id = 'cryptophys-aether'").get() as { status: string; metadata_json: string };
  assert.equal(svc.status, "disabled");
  assert.equal(JSON.parse(svc.metadata_json).health_path, "/health");

  const aether = { host_worker: "cryptophys-aether" };
  const xau = { host_worker: "xauusd-ai-trading-assistant" };
  assert.equal((await rpcWhoami(env as never, aether, "aether-guardian")).access_identity, "rpc:cryptophys-aether");
  // No cross-host impersonation in either direction.
  assert.deepEqual(await rpcWhoami(env as never, xau, "aether-auditor"), { error: "agent_not_hosted_by_caller" });
  assert.deepEqual(await rpcWhoami(env as never, aether, "xauusd-moderator"), { error: "agent_not_hosted_by_caller" });

  const published = await rpcSyscall(env as never, aether, "aether-guardian", "reports.publish", {
    kind: "knowledge_audit", severity: "warning", subject: "Calibration talk in room messages",
    ai_status: "deterministic", body: { summary: "advisory only; not an order", rate_per_100: 57 },
  });
  assert.equal(published.outcome, "succeeded");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_reports WHERE agent_id = 'aether-guardian' AND kind = 'knowledge_audit'").get() as { n: number }).n, 1);
  // A capability Aether was not granted is denied by the normal syscall checks.
  assert.equal((await rpcSyscall(env as never, aether, "aether-curator", "recovery.propose", {})).outcome, "denied");
});
