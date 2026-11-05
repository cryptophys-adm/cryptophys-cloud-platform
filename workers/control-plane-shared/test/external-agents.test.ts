// TP-009: External agents through MCP with their own Access identity (agent_principals, external_tier_limit, agent_whoami, agent_observe, agent_syscall).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, fakeWorkflow, migratedDb, req, signAccessJwt,
} from "./harness.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { verifySyscallDecision } from "../src/capabilities.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { proposeFromAgent } from "../../recovery-manager/src/index.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { AUDITOR_ID, runAuditCycle } from "../../ai-kernel/src/auditor.ts";
import { DISCLAIMER, runSignalCycle } from "../../ai-kernel/src/signal-analyst.ts";
const SIGNAL_ANALYST_ID = "platform-api";
import { runCycle } from "../../ai-kernel/src/supervisor.ts";

type Db = ReturnType<typeof migratedDb>;

const EXTERNAL_CLIENT_ID = "external-agent-1.access";
const EXTERNAL_JWT = await signAccessJwt({ common_name: EXTERNAL_CLIENT_ID });

function memory() {
  const m = new Map<string, unknown>();
  return { m, async get<T>(k: string) { return m.get(k) as T | undefined; }, async put(k: string, v: unknown) { m.set(k, structuredClone(v)); } };
}

function externalTestEnv(db: Db = migratedDb(), extra: Record<string, unknown> = {}) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const recoveryEnv = { ...baseEnv("cryptophys-recovery-manager", db), RECOVERY_LIFECYCLE: fakeWorkflow().binding };
  const supMem = memory();
  const sigMem = memory();
  const audMem = memory();
  const reingests: string[] = [];
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, {
      OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`,
      APPROVER_IDENTITIES: APPROVER_EMAIL,
    }),
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
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
        await verifySyscallDecision(db, decisionId, agentId, "reports.publish");
        reingests.push(decisionId);
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
  env.AUDITOR = {
    idFromName: (n: string) => n,
    get: () => ({ cycle: (t: "scheduled" | "operator") => runAuditCycle(env as never, audMem, t), status: async () => (await audMem.get("last_cycle")) ?? null }),
  };
  return { env, db, reingests };
}

// ---------------------------------------------------------------- AC 1: Unregistered service token gets 403 on /mcp; registered principal gets an agent session with only the three agent tools

test("unregistered service token gets 403 on /mcp; registered principal gets an agent session and tools/list shows only the three agent tools", async () => {
  const { env } = externalTestEnv();

  // Unregistered service token is rejected with 403 on /mcp.
  const deniedMcp = await call(
    kernel,
    env,
    req("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, EXTERNAL_JWT),
  );
  assert.equal(deniedMcp.status, 403);

  // Approver binds EXTERNAL_CLIENT_ID to signal-analyst (tier_max = 1).
  const added = await call(
    kernel,
    env,
    req("POST", `/v1/agents/${SIGNAL_ANALYST_ID}/principals`, { access_identity: EXTERNAL_CLIENT_ID }, APPROVER_JWT),
  );
  assert.equal(added.status, 201);
  assert.equal(added.body.principal.access_identity, EXTERNAL_CLIENT_ID);
  assert.equal(added.body.principal.agent_id, SIGNAL_ANALYST_ID);
  assert.equal(added.body.principal.revoked_at, null);

  // GET /v1/agents/signal-analyst lists the agent's principals for an operator.
  const statusRes = await call(kernel, env, req("GET", `/v1/agents/${SIGNAL_ANALYST_ID}`, undefined, OPERATOR_JWT));
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.body.principals.length, 1);
  assert.equal(statusRes.body.principals[0].access_identity, EXTERNAL_CLIENT_ID);

  // Registered principal still cannot access /v1/* HTTP routes (MCP only).
  assert.equal((await call(kernel, env, req("GET", "/v1/agents", undefined, EXTERNAL_JWT))).status, 403);

  // Registered principal gets an agent session on /mcp and tools/list shows only the three agent tools.
  const listRes = await call(
    kernel,
    env,
    req("POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" }, EXTERNAL_JWT),
  );
  assert.equal(listRes.status, 200);
  const toolNames = listRes.body.result.tools.map((t: any) => t.name);
  assert.deepEqual(toolNames, ["agent_whoami", "agent_observe", "agent_syscall"]);

  // agent_whoami returns the bound agent's identity, tier_max, and granted capabilities.
  const whoamiRes = await call(
    kernel,
    env,
    req("POST", "/mcp", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "agent_whoami", arguments: {} } }, EXTERNAL_JWT),
  );
  assert.equal(whoamiRes.status, 200);
  const whoami = JSON.parse(whoamiRes.body.result.content[0].text);
  assert.equal(whoami.agent_id, SIGNAL_ANALYST_ID);
  assert.equal(whoami.tier_max, 1);
  assert.equal(whoami.access_identity, EXTERNAL_CLIENT_ID);
  assert.ok(whoami.capabilities.some((c: any) => c.capability === "signals.observe" && c.tier === 0));
});

// ---------------------------------------------------------------- AC 2: Agent session cannot call operator tools even by name

test("an agent session cannot call operator tools such as set_agents_enabled, resume_agent or suspend_agent, even by name", async () => {
  const { env, db } = externalTestEnv();
  await call(
    kernel,
    env,
    req("POST", `/v1/agents/${SIGNAL_ANALYST_ID}/principals`, { access_identity: EXTERNAL_CLIENT_ID }, APPROVER_JWT),
  );

  for (const [idx, toolCall] of [
    { name: "set_agents_enabled", arguments: { enabled: false } },
    { name: "resume_agent", arguments: { agent_id: "supervisor" } },
    { name: "suspend_agent", arguments: { agent_id: "supervisor", reason: "attempt from external agent" } },
    { name: "wake_agent", arguments: { agent_id: "supervisor" } },
  ].entries()) {
    const res = await call(
      kernel,
      env,
      req("POST", "/mcp", { jsonrpc: "2.0", id: idx + 1, method: "tools/call", params: toolCall }, EXTERNAL_JWT),
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.error.code, -32602);
    assert.match(res.body.error.message, /unknown tool/);
  }

  // Verify neither kernel_controls nor supervisor status was modified.
  assert.equal((db.raw.prepare("SELECT value FROM kernel_controls WHERE control = 'agents_enabled'").get() as any).value, "1");
  assert.equal((db.raw.prepare("SELECT status FROM agents WHERE agent_id = 'supervisor'").get() as any).status, "enabled");
});

// ---------------------------------------------------------------- AC 3: Tier-2 capability through agent_syscall is denied with external_tier_limit even for a tier_max 2 agent; tier-1 capability is allowed when granted, recorded and audited

test("a tier-2 capability through agent_syscall is denied with external_tier_limit even for a tier_max 2 agent, while a granted tier-1 capability is allowed, recorded and audited", async () => {
  const { env, db, reingests } = externalTestEnv();

  // Bind EXTERNAL_CLIENT_ID to signal-analyst (tier_max = 1) via the approver API.
  const added = await call(
    kernel,
    env,
    req("POST", `/v1/agents/${SIGNAL_ANALYST_ID}/principals`, { access_identity: EXTERNAL_CLIENT_ID }, APPROVER_JWT),
  );
  assert.equal(added.status, 201);

  // Tier-0 observe works through agent_observe.
  const obsRes = await call(
    kernel,
    env,
    req("POST", "/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "agent_observe", arguments: { capability: "signals.observe" } },
    }, EXTERNAL_JWT),
  );
  assert.equal(JSON.parse(obsRes.body.result.content[0].text).outcome, "succeeded");

  // Calling a tier-1 capability through agent_observe is rejected (tier 0 only).
  const wrongTool = await call(
    kernel,
    env,
    req("POST", "/mcp", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "agent_observe", arguments: { capability: "reports.publish" } },
    }, EXTERNAL_JWT),
  );
  assert.equal(wrongTool.body.result.isError, true);
  assert.equal(JSON.parse(wrongTool.body.result.content[0].text).reason, "agent_observe_requires_tier_0");

  // Granted tier-1 capability (reports.publish) through agent_syscall is allowed, recorded in agent_actions, and audited as agent:signal-analyst.
  const pubRes = await call(
    kernel,
    env,
    req("POST", "/mcp", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "agent_syscall",
        arguments: {
          capability: "reports.publish",
          input: {
            kind: "signal_digest",
            severity: "info",
            subject: "External Signal Analyst digest",
            ai_status: "ok",
            body: { headline: "External digest", disclaimer: DISCLAIMER },
          },
        },
      },
    }, EXTERNAL_JWT),
  );
  const pubPayload = JSON.parse(pubRes.body.result.content[0].text);
  assert.equal(pubPayload.outcome, "succeeded");
  assert.equal(pubPayload.result.report.agent_id, SIGNAL_ANALYST_ID);

  const actionRow = db.raw.prepare(
    "SELECT agent_id, capability, tier, outcome FROM agent_actions WHERE agent_id = ? AND capability = 'reports.publish'",
  ).get(SIGNAL_ANALYST_ID) as any;
  assert.deepEqual([actionRow.agent_id, actionRow.capability, actionRow.tier, actionRow.outcome], [SIGNAL_ANALYST_ID, "reports.publish", 1, "succeeded"]);

  const auditRow = db.raw.prepare(
    "SELECT actor, subject, outcome FROM audit_events WHERE event_type = 'agent.action' AND actor = ?",
  ).get(`agent:${SIGNAL_ANALYST_ID}`) as any;
  assert.deepEqual([auditRow.actor, auditRow.subject, auditRow.outcome], [`agent:${SIGNAL_ANALYST_ID}`, "reports.publish", "succeeded"]);

  // Now elevate signal-analyst in D1 to tier_max = 2 and grant a tier-1 capability while elevated to prove external_tier_limit blocks tier 2 even for a tier_max 2 agent!
  db.raw.prepare(
    `UPDATE agents
     SET tier_max = 2, capabilities_json = '["signals.observe","reports.publish"]'
     WHERE agent_id = ?`,
  ).run(SIGNAL_ANALYST_ID);

  const tier2Res = await call(
    kernel,
    env,
    req("POST", "/mcp", {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "agent_syscall", arguments: { capability: "deploy.release", input: {} } },
    }, EXTERNAL_JWT),
  );
  assert.equal(tier2Res.body.result.isError, true);
  const tier2Payload = JSON.parse(tier2Res.body.result.content[0].text);
  assert.equal(tier2Payload.outcome, "denied");
  assert.match(tier2Payload.reason, /external_tier_limit/);
  assert.equal(reingests.length, 0);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

// ---------------------------------------------------------------- AC 4: A revoked principal gets 403

test("a revoked principal gets 403 on /mcp and revocation is audited", async () => {
  const { env, db } = externalTestEnv();
  const added = await call(
    kernel,
    env,
    req("POST", `/v1/agents/${"platform-api"}/principals`, { access_identity: EXTERNAL_CLIENT_ID }, APPROVER_JWT),
  );
  assert.equal(added.status, 201);

  // Active principal works on /mcp.
  const okMcp = await call(
    kernel,
    env,
    req("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, EXTERNAL_JWT),
  );
  assert.equal(okMcp.status, 200);

  // Operator (non-approver) cannot revoke a principal.
  const opRevoke = await call(
    kernel,
    env,
    req("DELETE", `/v1/agents/${"platform-api"}/principals/${encodeURIComponent(EXTERNAL_CLIENT_ID)}`, undefined, OPERATOR_JWT),
  );
  assert.equal(opRevoke.status, 403);

  // Approver revokes the principal.
  const revoked = await call(
    kernel,
    env,
    req("DELETE", `/v1/agents/${"platform-api"}/principals/${encodeURIComponent(EXTERNAL_CLIENT_ID)}`, undefined, APPROVER_JWT),
  );
  assert.equal(revoked.status, 200);
  assert.ok(revoked.body.principal.revoked_at);

  // Revoked principal now gets 403 on /mcp.
  const deniedAfterRevoke = await call(
    kernel,
    env,
    req("POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" }, EXTERNAL_JWT),
  );
  assert.equal(deniedAfterRevoke.status, 403);

  const events = db.raw.prepare(
    "SELECT event_type, actor, subject FROM audit_events WHERE event_type IN ('agent.principal_added', 'agent.principal_revoked') ORDER BY rowid",
  ).all() as any[];
  assert.deepEqual(
    events.map((e) => [e.event_type, e.actor, e.subject]),
    [
      ["agent.principal_added", APPROVER_EMAIL, `agent:${"platform-api"}`],
      ["agent.principal_revoked", APPROVER_EMAIL, `agent:${"platform-api"}`],
    ],
  );
  assert.equal((await verifyAuditChain(db)).valid, true);
});

// ---------------------------------------------------------------- AC 5: Registering a principal requires an approver and is refused for an agent with tier_max 2

test("registering a principal requires an approver (operator alone gets 403) and is refused for an agent with tier_max 2", async () => {
  const { env, db } = externalTestEnv();

  // Operator alone gets 403.
  const opTry = await call(
    kernel,
    env,
    req("POST", `/v1/agents/${SIGNAL_ANALYST_ID}/principals`, { access_identity: EXTERNAL_CLIENT_ID }, OPERATOR_JWT),
  );
  assert.equal(opTry.status, 403);

  // Approver attempting to register a principal for supervisor (tier_max = 2) is refused.
  const supTry = await call(
    kernel,
    env,
    req("POST", "/v1/agents/supervisor/principals", { access_identity: EXTERNAL_CLIENT_ID }, APPROVER_JWT),
  );
  assert.equal(supTry.status, 400);
  assert.equal(supTry.body.error, "kernel_agent_internal");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_principals").get() as any).n, 0);
});

// ---------------------------------------------------------------- AC 6: Existing operator MCP behaviour and no-privilege-mixing overlap resolution

test("operator MCP behaviour is unchanged, and an identity that is both an operator and a principal is treated as an operator with a warning", async () => {
  const { env } = externalTestEnv();

  // Bind OPERATOR_EMAIL (who is also in OPERATOR_IDENTITIES) as a principal on signal-analyst.
  const added = await call(
    kernel,
    env,
    req("POST", `/v1/agents/${SIGNAL_ANALYST_ID}/principals`, { access_identity: OPERATOR_EMAIL }, APPROVER_JWT),
  );
  assert.equal(added.status, 201);

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const listRes = await call(
      kernel,
      env,
      req("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, OPERATOR_JWT),
    );
    assert.equal(listRes.status, 200);
    const names = listRes.body.result.tools.map((t: any) => t.name);
    assert.ok(names.includes("platform_status"), "operator tools must be returned when caller is an operator");
    assert.equal(names.includes("agent_whoami"), false, "no privilege mixing: agent tools are not mixed into operator session");
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warnings.some((w) => w.includes("principal_operator_overlap")), "overlap between operator and principal must log a warning");
});
