import { test } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, call, migratedDb, req } from "./harness.ts";
import { publishAgentReport, type AgentRpcBinding } from "../src/agents.ts";
import policy, { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import audit from "../../audit-ledger/src/index.ts";
import { appendAuditEvent } from "../src/audit.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function recorder(outcome: Record<string, unknown> | Error = { outcome: "succeeded" }, onCall?: (input: any) => void) {
  const calls: { agentId: string; capability: string; input: any }[] = [];
  const binding: AgentRpcBinding = {
    whoami: async () => ({}),
    observe: async () => ({}),
    syscall: async (agentId, capability, input) => {
      calls.push({ agentId, capability, input });
      if (onCall) onCall(input);
      if (outcome instanceof Error) throw outcome;
      return outcome as never;
    },
  };
  return { calls, binding };
}

test("TP-014 tagged deny is silent but still deny and audited", async () => {
  const db = migratedDb();
  const rec = recorder();
  const env: any = baseEnv("cryptophys-policy-engine", db, { AGENTS: rec.binding });
  const ctx = { commit_sha: SHA, confirm_production: "DEPLOY", ci_green: false, deploy_verification: true };
  const parsed = parsePolicyRequest({ subject: "op", action: "deploy", resource: "cryptophys-platform-api", context: ctx });
  assert.ok(!(parsed instanceof Error));
  const decision = await decide(env, parsed as any);
  assert.equal(decision.decision, "deny");
  assert.match(decision.reason, /ci_green/);
  assert.equal(rec.calls.length, 0);
  const rows = (db.raw.prepare("SELECT COUNT(*) AS n FROM policy_decisions").get() as any).n;
  assert.ok(rows >= 1);
  const audits = (db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type='policy.decision'").get() as any).n;
  assert.ok(audits >= 1);
});

test("TP-014 tag is strict: string 'true' still reports", async () => {
  const db = migratedDb();
  const rec = recorder();
  const env: any = baseEnv("cryptophys-policy-engine", db, { AGENTS: rec.binding });
  const ctx = { commit_sha: SHA, confirm_production: "DEPLOY", ci_green: false, deploy_verification: "true" };
  const parsed = parsePolicyRequest({ subject: "op", action: "deploy", resource: "cryptophys-platform-api", context: ctx });
  assert.ok(!(parsed instanceof Error));
  const decision = await decide(env, parsed as any);
  assert.equal(decision.decision, "deny");
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].input.severity, "warning");
});

test("TP-014 tag cannot change a decision", async () => {
  const db = migratedDb();
  const env: any = baseEnv("cryptophys-policy-engine", db);
  const ctxAllow = { commit_sha: SHA, confirm_production: "DEPLOY", ci_green: true };
  for (const tag of [true, false]) {
    const parsed = parsePolicyRequest({ subject: "op", action: "deploy", resource: "cryptophys-platform-api", context: { ...ctxAllow, deploy_verification: tag } });
    assert.ok(!(parsed instanceof Error));
    const d = await decide(env, parsed as any);
    assert.equal(d.decision, "allow");
  }
});

test("TP-014 untagged deny still publishes; agent.syscall excluded", async () => {
  const db = migratedDb();
  const rec = recorder();
  const env: any = baseEnv("cryptophys-policy-engine", db, { AGENTS: rec.binding });
  const ctx = { commit_sha: SHA, confirm_production: "DEPLOY", ci_green: false };
  const parsed = parsePolicyRequest({ subject: "op", action: "deploy", resource: "cryptophys-platform-api", context: ctx });
  assert.ok(!(parsed instanceof Error));
  await decide(env, parsed as any);
  assert.equal(rec.calls.length, 1);

  const rec2 = recorder();
  const env2: any = baseEnv("cryptophys-policy-engine", migratedDb(), { AGENTS: rec2.binding });
  const parsed2 = parsePolicyRequest({ subject: "agent:ghost", action: "agent.syscall", resource: "reports.publish", context: {} });
  assert.ok(!(parsed2 instanceof Error));
  await decide(env2, parsed2 as any);
  assert.equal(rec2.calls.length, 0);
});

test("TP-014 broken chain reports once", async () => {
  const db = migratedDb();
  await appendAuditEvent(db, { event_type: "test.event", actor: "tester", subject: "s", outcome: "ok", payload: {} });
  db.raw.exec("DROP TRIGGER IF EXISTS audit_events_no_update; DROP TRIGGER IF EXISTS audit_events_no_delete;");
  // tamper first audit event payload
  db.raw.prepare("UPDATE audit_events SET payload_json = '{\"tampered\":true}' WHERE rowid = 1").run();

  const rec = recorder({ outcome: "succeeded" }, (input) => {
    // insert report row to simulate persistence
    db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, created_at) VALUES (?, 'audit-ledger', 'audit_digest', 'critical', ?, '{}', 'deterministic', ?)")
      .run("rep_" + Math.random().toString(36).slice(2), input.subject, new Date().toISOString());
  });
  const env: any = baseEnv("cryptophys-audit-ledger", db, { AGENTS: rec.binding });

  const r1 = await call(audit, env, req("GET", "/v1/verify"));
  assert.equal(r1.body.valid, false);
  const r2 = await call(audit, env, req("GET", "/v1/verify"));
  assert.equal(r2.body.valid, false);
  assert.deepEqual(r1.body, r2.body);
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].agentId, "audit-ledger");
  assert.equal(rec.calls[0].input.kind, "audit_digest");
  assert.equal(rec.calls[0].input.severity, "critical");
  assert.equal("payload" in (rec.calls[0].input.body ?? {}), false);
});

test("TP-014 valid chain is silent", async () => {
  const db = migratedDb();
  const rec = recorder();
  const env: any = baseEnv("cryptophys-audit-ledger", db, { AGENTS: rec.binding });
  const r = await call(audit, env, req("GET", "/v1/verify"));
  assert.equal(r.body.valid, true);
  assert.equal(rec.calls.length, 0);
});

test("TP-014 outage-safe verify", async () => {
  const db = migratedDb();
  await appendAuditEvent(db, { event_type: "test.event", actor: "tester", subject: "s", outcome: "ok", payload: {} });
  db.raw.exec("DROP TRIGGER IF EXISTS audit_events_no_update; DROP TRIGGER IF EXISTS audit_events_no_delete;");
  db.raw.prepare("UPDATE audit_events SET payload_json = '{\"tampered\":true}' WHERE rowid = 1").run();

  // missing binding
  const envMissing: any = baseEnv("cryptophys-audit-ledger", db);
  const rMissing = await call(audit, envMissing, req("GET", "/v1/verify"));
  assert.equal(rMissing.body.valid, false);

  // throwing binding
  const throwing: AgentRpcBinding = { whoami: async () => ({}), observe: async () => ({}), syscall: async () => { throw new Error("boom"); } };
  const envThrow: any = baseEnv("cryptophys-audit-ledger", db, { AGENTS: throwing });
  const rThrow = await call(audit, envThrow, req("GET", "/v1/verify"));
  assert.equal(rThrow.body.valid, false);

  // failing de-dup query
  const wrapped: any = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (sql.includes("agent_reports")) throw new Error("dedup failed");
          return target.prepare(sql);
        };
      }
      return (target as any)[prop];
    },
  });
  const envFail: any = baseEnv("cryptophys-audit-ledger", wrapped, { AGENTS: throwing });
  const rFail = await call(audit, envFail, req("GET", "/v1/verify"));
  assert.equal(rFail.body.valid, false);
});
