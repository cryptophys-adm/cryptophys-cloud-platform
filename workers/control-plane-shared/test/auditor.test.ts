// TP-007: Platform Auditor agent (tier 1), audit.verify, runAuditCycle, HTTP and MCP.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, fakeAi, fakeWorkflow, migratedDb, req,
} from "./harness.ts";
import { appendAuditEvent, verifyAuditChain } from "../src/audit.ts";
import { CAPABILITIES, verifySyscallDecision } from "../src/capabilities.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { proposeFromAgent } from "../../recovery-manager/src/index.ts";
import kernel from "../../ai-kernel/src/index.ts";
import {
  AUDITOR_ID, AuditorCycleQueue, draftAuditDigestTask, runAuditCycle, templateAuditDigest,
} from "../../ai-kernel/src/auditor.ts";
import { SIGNAL_ANALYST_ID, runSignalCycle } from "../../ai-kernel/src/signal-analyst.ts";
import { runCycle } from "../../ai-kernel/src/supervisor.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";

type Db = ReturnType<typeof migratedDb>;

function memory() {
  const m = new Map<string, unknown>();
  return { m, async get<T>(k: string) { return m.get(k) as T | undefined; }, async put(k: string, v: unknown) { m.set(k, structuredClone(v)); } };
}

function auditorEnv(db: Db = migratedDb(), extra: Record<string, unknown> = {}) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const recoveryEnv = { ...baseEnv("cryptophys-recovery-manager", db), RECOVERY_LIFECYCLE: fakeWorkflow().binding };
  const supMem = memory();
  const sigMem = memory();
  const audMem = memory();
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, {
      OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`,
      APPROVER_IDENTITIES: APPROVER_EMAIL,
    }),
    POLICY: {
      evaluate: async (input: Record<string, unknown>) => {
        const parsed = parsePolicyRequest(input);
        if (parsed instanceof Error) throw parsed;
        return decide(policyEnv as never, parsed);
      },
    },
    RECOVERY: {
      propose: async (agentId: string, decisionId: string, input: Record<string, unknown>) => {
        await verifySyscallDecision(db, decisionId, agentId, "recovery.propose");
        return proposeFromAgent(recoveryEnv as never, agentId, input);
      },
    },
    SIGNALS: {
      reingest: async (agentId: string, decisionId: string) => {
        await verifySyscallDecision(db, decisionId, agentId, "signals.reingest");
        return { run_id: "sig_test", series: 6, failed: 0 };
      },
    },
    ...extra,
  };
  env.SUPERVISOR = {
    idFromName: (n: string) => n,
    get: () => ({ cycle: (t: "scheduled" | "operator") => runCycle(env as never, supMem, t), status: async () => (await supMem.get("last_cycle")) ?? null }),
  };
  env.SIGNAL_ANALYST = {
    idFromName: (n: string) => n,
    get: () => ({ cycle: (t: "scheduled" | "operator") => runSignalCycle(env as never, sigMem, t), status: async () => (await sigMem.get("last_cycle")) ?? null }),
  };
  if (!("AUDITOR" in extra)) {
    env.AUDITOR = {
      idFromName: (n: string) => n,
      get: () => ({ cycle: (t: "scheduled" | "operator") => runAuditCycle(env as never, audMem, t), status: async () => (await audMem.get("last_cycle")) ?? null }),
    };
  }
  if (!("MEMORY" in extra)) {
    env.MEMORY = { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) };
  }
  return { env, db, supMem, sigMem, audMem };
}

test("AuditorCycleQueue serializes concurrent cycles and recovers after rejection", async () => {
  const queue = new AuditorCycleQueue();
  let active = 0;
  let maxActive = 0;
  const order: number[] = [];
  const tasks = [1, 2, 3].map((n) => queue.run(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(n);
    active--;
    return n;
  }));
  assert.deepEqual(await Promise.all(tasks), [1, 2, 3]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, [1, 2, 3]);
  await assert.rejects(queue.run(async () => { throw new Error("auditor queue error"); }), /auditor queue error/);
  assert.equal(await queue.run(async () => 99), 99);
});

// ---------------------------------------------------------------- AC 1: Tampered chain -> critical report, deterministic valid:false preserved even when AI lies

test("tampered audit chain produces a critical report with deterministic valid:false preserved even when AI claims chain is valid", async () => {
  const { env, db, audMem } = auditorEnv(migratedDb(), {
    AI: fakeAi({
      response: JSON.stringify({
        headline: "Audit chain is valid and verified",
        summary: "The audit hash chain is valid with no tampering detected across all events.",
        items: ["Audit chain is valid and intact"],
        chain_valid: true,
      }),
    }),
  });
  assert.equal(CAPABILITIES["audit.verify"].tier, 0);
  const seeded = db.raw.prepare("SELECT tier_max, status, capabilities_json FROM agents WHERE agent_id = ?").get(AUDITOR_ID) as any;
  assert.deepEqual([seeded.tier_max, seeded.status, JSON.parse(seeded.capabilities_json)], [1, "enabled", ["audit.verify", "reports.publish", "memory.recall", "memory.remember"]]);

  const e1 = await appendAuditEvent(db, { event_type: "test.one", actor: "op@example.com", subject: "svc", outcome: "ok", payload: { step: 1 } });
  await appendAuditEvent(db, { event_type: "test.two", actor: "op@example.com", subject: "svc", outcome: "ok", payload: { step: 2 } });

  // Tamper directly with event e1 in the DB (after dropping the append-only trigger, as control-plane.test.ts does).
  db.raw.exec("DROP TRIGGER audit_events_no_update");
  db.raw.prepare("UPDATE audit_events SET payload_json = '{\"step\":999}' WHERE event_id = ?").run(e1.event_id);
  assert.equal((await verifyAuditChain(db)).valid, false);

  const cycle = await runAuditCycle(env as never, audMem, "scheduled", Date.parse("2026-11-04T14:37:00.000Z"));
  assert.equal(cycle.findings.length, 1);
  assert.equal(cycle.findings[0].outcome, "succeeded");
  assert.equal(cycle.findings[0].ai, "invalid_output", "AI output contradicting deterministic chain validity must be rejected");

  const report = db.raw.prepare("SELECT * FROM agent_reports WHERE agent_id = 'auditor' ORDER BY created_at DESC LIMIT 1").get() as any;
  assert.ok(report);
  assert.equal(report.kind, "audit_digest");
  assert.equal(report.severity, "critical");
  assert.equal(report.ai_status, "invalid_output");
  const body = JSON.parse(report.body_json);
  assert.equal(body.valid, false);
  assert.equal(body.chain.valid, false);
  assert.equal(body.chain.first_invalid_event_id, e1.event_id);
  assert.equal(typeof body.events_checked, "number");

  // Also verify draftAuditDigestTask validator rejects false-negative claim when chain IS valid.
  const validTask = draftAuditDigestTask({
    observed_at: "2026-11-04T14:37:00.000Z",
    since: "2026-11-03T14:37:00.000Z",
    chain: { valid: true, events_checked: 2, head_hash: "abc1234567890", first_invalid_event_id: null, reason: null },
    valid: true,
    events_checked: 2,
    counts_24h: {
      agent_actions_by_agent: [],
      denied_agent_syscalls: 0,
      failed_agent_syscalls: 0,
      policy_denies_by_action: [],
      governance_audit_events: { "agent.suspended": 0, "agent.resumed": 0, "kernel.agents_enabled": 0 },
      agent_recovery_plans: 0,
    },
  });
  assert.equal(
    validTask.validate({
      headline: "Audit chain is invalid and tampered",
      summary: "Tampering detected in the audit chain.",
      items: ["Chain is broken"],
    }),
    null,
  );
  const tmpl = templateAuditDigest(
    {
      observed_at: "2026-11-04T14:37:00.000Z",
      since: "2026-11-03T14:37:00.000Z",
      chain: { valid: true, events_checked: 2, head_hash: "abc1234567890", first_invalid_event_id: null, reason: null },
      valid: true,
      events_checked: 2,
      counts_24h: {
        agent_actions_by_agent: [],
        denied_agent_syscalls: 0,
        failed_agent_syscalls: 0,
        policy_denies_by_action: [],
        governance_audit_events: { "agent.suspended": 0, "agent.resumed": 0, "kernel.agents_enabled": 0 },
        agent_recovery_plans: 0,
      },
    },
    "info",
    ["daily_0037_utc_digest"],
  );
  assert.ok(validTask.validate(tmpl));
});

// ---------------------------------------------------------------- AC 2: >= 4 denied syscalls -> warning; quiet hour -> no report except at 00:37 UTC

test("four or more denied syscalls in 24h produce a warning; a quiet hour produces no report except at 00:37 UTC", async () => {
  const aiResponse = {
    headline: "Governance review: audit chain verified across all events",
    summary: "Audit hash chain is valid. Governance review completed for the last 24 hours.",
    items: ["Chain valid across all events", "Reviewed 24-hour governance activity"],
  };
  const { env, db, audMem } = auditorEnv(migratedDb(), { AI: fakeAi({ response: JSON.stringify(aiResponse) }) });

  // Quiet non-00:37 hour -> no report.
  const quiet = await runAuditCycle(env as never, audMem, "scheduled", Date.parse("2026-11-04T02:37:00.000Z"));
  assert.equal(quiet.findings[0].action, "none");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_reports WHERE agent_id = 'auditor'").get() as any).n, 0);

  // Quiet 00:37 UTC hour -> daily info report.
  const daily = await runAuditCycle(env as never, audMem, "scheduled", Date.parse("2026-11-04T00:37:00.000Z"));
  assert.equal(daily.findings[0].action, "reports.publish");
  assert.equal(daily.findings[0].outcome, "succeeded");
  const infoReport = db.raw.prepare("SELECT severity, body_json FROM agent_reports WHERE agent_id = 'auditor' ORDER BY created_at DESC LIMIT 1").get() as any;
  assert.equal(infoReport.severity, "info");
  assert.equal(JSON.parse(infoReport.body_json).valid, true);

  // Generate 4 denied syscalls in the last 24h (by calling an ungranted capability).
  for (let i = 0; i < 4; i++) {
    const denied = await syscall(env as never, SIGNAL_ANALYST_ID, "signals.reingest");
    assert.equal(denied.outcome, "denied");
  }

  // Now even on a non-00:37 hour, 4 denied syscalls in 24h trigger a warning report.
  const warnCycle = await runAuditCycle(env as never, audMem, "scheduled", Date.now());
  assert.equal(warnCycle.findings[0].action, "reports.publish");
  assert.equal(warnCycle.findings[0].outcome, "succeeded");
  const warnRows = db.raw.prepare("SELECT severity, body_json FROM agent_reports WHERE agent_id = 'auditor' ORDER BY rowid DESC").all() as any[];
  assert.equal(warnRows.length, 2);
  assert.equal(warnRows[0].severity, "warning");
  const warnBody = JSON.parse(warnRows[0].body_json);
  assert.equal(warnBody.counts_24h.denied_agent_syscalls, 4);
  assert.equal(warnBody.counts_24h.agent_actions_by_agent[0].agent_id, SIGNAL_ANALYST_ID);
  assert.equal(warnBody.counts_24h.agent_actions_by_agent[0].denied, 4);
});

// ---------------------------------------------------------------- AC 3: Auditor cannot call recovery.propose, signals.reingest, or platform.observe

test("auditor cannot call recovery.propose, signals.reingest or platform.observe", async () => {
  const { env, db } = auditorEnv();
  const prop = await syscall(env as never, AUDITOR_ID, "recovery.propose", {
    service_id: "cryptophys-platform-api",
    title: "Unauthorized proposal",
    rationale: "Auditor must never propose recovery",
    steps: [{ action: "manual", description: "No" }],
  });
  assert.equal(prop.outcome, "denied");
  assert.match(prop.reason, /capability_granted/);

  const reingest = await syscall(env as never, AUDITOR_ID, "signals.reingest");
  assert.equal(reingest.outcome, "denied");
  assert.match(reingest.reason, /tier_within_agent_limit/);
  assert.match(reingest.reason, /capability_granted/);

  const obs = await syscall(env as never, AUDITOR_ID, "platform.observe");
  assert.equal(obs.outcome, "denied");
  assert.match(obs.reason, /capability_granted/);

  // Verify audit chain remains valid after recording the denied syscalls.
  assert.equal((await verifyAuditChain(db)).valid, true);
});

// ---------------------------------------------------------------- AC 4: Suspended agent or kill switch off -> cycle skipped

test("runAuditCycle skips when auditor is suspended or the global kill switch is off", async () => {
  const { env, db, audMem } = auditorEnv();
  db.raw.prepare("UPDATE agents SET status = 'suspended' WHERE agent_id = ?").run(AUDITOR_ID);
  const s1 = await runAuditCycle(env as never, audMem, "scheduled");
  assert.equal(s1.skipped, "agent_suspended");

  db.raw.prepare("UPDATE agents SET status = 'enabled' WHERE agent_id = ?").run(AUDITOR_ID);
  db.raw.prepare("UPDATE kernel_controls SET value = '0' WHERE control = 'agents_enabled'").run();
  const s2 = await runAuditCycle(env as never, audMem, "scheduled");
  assert.equal(s2.skipped, "agents_disabled");
});

// ---------------------------------------------------------------- AC 5: Readiness fails without AUDITOR; MCP wake_agent & HTTP wake work

test("readiness fails without AUDITOR binding; MCP wake_agent and HTTP wake with auditor return a cycle report", async () => {
  const { env } = auditorEnv();

  // Readiness succeeds with AUDITOR and fails when AUDITOR is undefined or absent.
  const ready = await call(kernel, env, req("GET", "/ready"));
  assert.deepEqual([ready.status, ready.body.checks.auditor_binding], [200, true]);
  const unready = await call(kernel, { ...env, AUDITOR: undefined }, req("GET", "/ready"));
  assert.deepEqual([unready.status, unready.body.checks.auditor_binding], [503, false]);
  const { AUDITOR: _auditor, ...withoutAuditor } = env;
  const absent = await call(kernel, withoutAuditor, req("GET", "/ready"));
  assert.deepEqual([absent.status, absent.body.checks.auditor_binding], [503, false]);

  // HTTP POST /v1/agents/auditor/wake
  const wokeHttp = await call(kernel, env, req("POST", "/v1/agents/auditor/wake", {}, OPERATOR_JWT));
  assert.equal(wokeHttp.status, 200);
  assert.equal(wokeHttp.body.agent_id, AUDITOR_ID);
  assert.equal(wokeHttp.body.trigger, "operator");

  // MCP wake_agent with auditor
  const mcpWake = await call(
    kernel,
    env,
    req("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wake_agent", arguments: { agent_id: AUDITOR_ID } } }, OPERATOR_JWT),
  );
  assert.equal(mcpWake.status, 200);
  const parsed = JSON.parse(mcpWake.body.result.content[0].text);
  assert.equal(parsed.agent_id, AUDITOR_ID);
  assert.equal(parsed.trigger, "operator");

  // Scheduled handler runs auditor on minute 37.
  const waited: Promise<unknown>[] = [];
  await kernel.scheduled(
    { scheduledTime: Date.parse("2026-11-04T00:37:00.000Z"), cron: "7,22,37,52 * * * *" },
    env as never,
    { waitUntil: (p: Promise<unknown>) => { waited.push(p); } },
  );
  await Promise.all(waited);
  const statusRes = await call(kernel, env, req("GET", "/v1/agents/auditor", undefined, OPERATOR_JWT));
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.body.last_cycle.trigger, "scheduled");
});
