import { test } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, call, migratedDb, req } from "./harness.ts";
import { publishAgentReport, type AgentRpcBinding } from "../src/agents.ts";
import policy, { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import registry from "../../platform-registry/src/index.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

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

test("TP-013 policy deny reports, allow silent, no loop, outage safe", async () => {
  // deny reports
  const db = migratedDb();
  const rec = recorder();
  const env: any = baseEnv("cryptophys-policy-engine", db, { AGENTS: rec.binding });
  const ctx = { commit_sha: SHA, confirm_production: "DEPLOY", ci_green: false };
  const parsed = parsePolicyRequest({ subject: "op", action: "deploy", resource: "cryptophys-platform-api", context: ctx });
  assert.ok(!(parsed instanceof Error));
  const decision = await decide(env, parsed as any);
  assert.equal(decision.decision, "deny");
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].agentId, "policy-engine");
  assert.equal(rec.calls[0].capability, "reports.publish");
  assert.equal(rec.calls[0].input.severity, "warning");
  assert.ok(rec.calls[0].input.body.failed_checks.includes("ci_green"));
  assert.equal(rec.calls[0].input.body.disclaimer, "advisory only; not an order");
  assert.equal("context" in rec.calls[0].input.body, false);
  assert.equal(JSON.stringify(rec.calls[0].input.body).includes("detail"), false);

  // allow silent
  const rec2 = recorder();
  const env2: any = baseEnv("cryptophys-policy-engine", migratedDb(), { AGENTS: rec2.binding });
  const ctxOk = { commit_sha: SHA, confirm_production: "DEPLOY", ci_green: true };
  const parsedOk = parsePolicyRequest({ subject: "github-actions", action: "deploy", resource: "cryptophys-platform-api", context: ctxOk });
  assert.ok(!(parsedOk instanceof Error));
  const allow = await decide(env2, parsedOk as any);
  assert.equal(allow.decision, "allow");
  assert.equal(rec2.calls.length, 0);

  // no loop: denied agent.syscall publishes nothing
  const rec3 = recorder();
  const env3: any = baseEnv("cryptophys-policy-engine", migratedDb(), { AGENTS: rec3.binding });
  const parsedLoop = parsePolicyRequest({ subject: "agent:ghost", action: "agent.syscall", resource: "reports.publish", context: {} });
  assert.ok(!(parsedLoop instanceof Error));
  const deniedLoop = await decide(env3, parsedLoop as any);
  assert.equal(deniedLoop.decision, "deny");
  assert.equal(rec3.calls.length, 0);

  // outage: undefined binding
  const dbU = migratedDb();
  const envU: any = baseEnv("cryptophys-policy-engine", dbU); // no AGENTS
  const beforeRows = (dbU.raw.prepare("SELECT COUNT(*) AS n FROM policy_decisions").get() as any).n;
  const beforeAudits = (dbU.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type='policy.decision'").get() as any).n;
  const parsedU = parsePolicyRequest({ subject: "op", action: "deploy", resource: "cryptophys-platform-api", context: { ...ctx } });
  const decU = await decide(envU, parsedU as any);
  assert.equal(decU.decision, "deny");
  assert.equal((dbU.raw.prepare("SELECT COUNT(*) AS n FROM policy_decisions").get() as any).n, beforeRows + 1);
  assert.equal((dbU.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type='policy.decision'").get() as any).n, beforeAudits + 1);

  // outage: throwing binding
  const dbT = migratedDb();
  const throwing: AgentRpcBinding = { whoami: async () => ({}), observe: async () => ({}), syscall: async () => { throw new Error("boom"); } };
  const envT: any = baseEnv("cryptophys-policy-engine", dbT, { AGENTS: throwing });
  const parsedT = parsePolicyRequest({ subject: "op", action: "deploy", resource: "cryptophys-platform-api", context: { ...ctx } });
  const decT = await decide(envT, parsedT as any);
  assert.equal(decT.decision, "deny");
});

test("TP-013 registry new service, disable, no noise, outage safe", async () => {
  const base = { display_name: "News Ingest", environment: "production", status: "registered", metadata: { owner: "x", purpose: "y", data_classification: "internal" } };

  // new service
  const db = migratedDb();
  const rec = recorder();
  const env: any = baseEnv("cryptophys-platform-registry", db, { AGENTS: rec.binding });
  const created = await call(registry, env, req("PUT", "/v1/services/cryptophys-news", base));
  assert.equal(created.status, 201);
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].agentId, "platform-registry");
  assert.equal(rec.calls[0].input.severity, "info");
  assert.equal(rec.calls[0].input.body.service_id, "cryptophys-news");
  assert.equal("metadata" in rec.calls[0].input.body, false);

  // disable
  const rec2 = recorder();
  const env2: any = baseEnv("cryptophys-platform-registry", db, { AGENTS: rec2.binding });
  const updated = await call(registry, env2, req("PUT", "/v1/services/cryptophys-news", { ...base, status: "disabled" }));
  assert.equal(updated.status, 200);
  assert.equal(rec2.calls.length, 1);
  assert.equal(rec2.calls[0].input.severity, "warning");
  assert.equal(rec2.calls[0].input.body.previous_status, "registered");

  // no noise: same status
  const rec3 = recorder();
  const env3: any = baseEnv("cryptophys-platform-registry", db, { AGENTS: rec3.binding });
  await call(registry, env3, req("PUT", "/v1/services/cryptophys-news", { ...base, status: "disabled" }));
  assert.equal(rec3.calls.length, 0);
  // no noise: change to non-disabled
  const rec4 = recorder();
  const env4: any = baseEnv("cryptophys-platform-registry", db, { AGENTS: rec4.binding });
  // service currently disabled; update to degraded (not from healthy? existing disabled -> no report regardless)
  await call(registry, env4, req("PUT", "/v1/services/cryptophys-news", { ...base, status: "degraded" }));
  assert.equal(rec4.calls.length, 0);

  // outage: throwing binding leaves 201 unchanged
  const dbT = migratedDb();
  const throwing: AgentRpcBinding = { whoami: async () => ({}), observe: async () => ({}), syscall: async () => { throw new Error("boom"); } };
  const envT: any = baseEnv("cryptophys-platform-registry", dbT, { AGENTS: throwing });
  const createdT = await call(registry, envT, req("PUT", "/v1/services/cryptophys-news2", base));
  assert.equal(createdT.status, 201);
  const updatedT = await call(registry, envT, req("PUT", "/v1/services/cryptophys-news2", { ...base, status: "disabled" }));
  assert.equal(updatedT.status, 200);
});
