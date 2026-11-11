// ADR-0009 phase 2: execution of reversible routine actions, behind the consensus mode gate.
// Production stays in shadow mode; these tests switch the mode in a local D1 only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, fakeAi, fakeWorkflow, migratedDb } from "./harness.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { verifySyscallDecision } from "../src/capabilities.ts";
import { CONSENSUS_EXECUTION_WINDOW_MS, verifyConsensusExecution } from "../src/consensus-exec.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { proposeFromAgent } from "../../recovery-manager/src/index.ts";
import { applyConsensus } from "../../platform-registry/src/index.ts";
import { observeForConsensus } from "../../drift-detector/src/index.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { PHASE2_EXECUTABLE } from "../../ai-kernel/src/consensus.ts";

type Db = ReturnType<typeof migratedDb>;

function kernelEnv(db: Db = migratedDb(), extra: Record<string, unknown> = {}) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const recoveryEnv = { ...baseEnv("cryptophys-recovery-manager", db), RECOVERY_LIFECYCLE: fakeWorkflow().binding };
  const registryEnv = baseEnv("cryptophys-platform-registry", db);
  const calls: string[] = [];
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async (agentId: string, decisionId: string, input: Record<string, unknown>) => { await verifySyscallDecision(db, decisionId, agentId, "recovery.propose"); return proposeFromAgent(recoveryEnv as never, agentId, input); } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    REGISTRY: {
      applyConsensus: async (id: string, dec: string, action: string, target: string, params: Record<string, unknown>) => {
        calls.push(`registry:${action}:${target}`);
        return applyConsensus(registryEnv as never, id, dec, action, target, params);
      },
    },
    DRIFT: {
      // The real observe() probes every service binding; the kernel-side contract is the re-verification.
      observeForConsensus: async (id: string, dec: string) => {
        calls.push("drift:observe");
        await verifyConsensusExecution(db as never, id, dec, "observe_drift", "platform");
        return { run_id: "drift_test", drifted: 0, services: 15 };
      },
    },
    ...extra,
  };
  return { env, db, calls };
}

const setMode = (db: Db, mode: string) => db.raw.prepare("UPDATE consensus_controls SET value = ? WHERE control = 'mode'").run(mode);
const proposals = (db: Db) => db.raw.prepare("SELECT * FROM consensus_proposals ORDER BY created_at, rowid").all() as any[];
const last = (db: Db) => proposals(db).at(-1);
const agentStatus = (db: Db, id: string) => ({ ...(db.raw.prepare("SELECT status, updated_by FROM agents WHERE agent_id = ?").get(id) as any) });
const service = (db: Db, id: string) => (db.raw.prepare("SELECT status, desired_version FROM service_registry WHERE service_id = ?").get(id) as any);

test("1. the phase 2 executable set is routine, reversible, and has no deploy", () => {
  assert.deepEqual([...PHASE2_EXECUTABLE].sort(), ["amend_doctrine", "observe_drift", "register_agent", "register_engine", "registry_disable_service", "registry_enable_service", "resume_agent", "set_desired_version", "set_policy_parameter", "suspend_agent"]);
  for (const a of PHASE2_EXECUTABLE) assert.doesNotMatch(a, /deploy|rollback|restore|secret|retire|access/);
});

test("2. shadow mode (production): a passed routine action is recorded and never executed", async () => {
  const { env, db, calls } = kernelEnv();
  const r = await syscall(env as never, "supervisor", "consensus.propose", { action: "suspend_agent", target: "platform-api", params: { reason: "test" } });
  assert.equal(r.outcome, "succeeded");
  const p = last(db);
  assert.equal(p.status, "shadow_passed");
  assert.equal(JSON.parse(p.outcome_json).executed, false);
  assert.equal(agentStatus(db, "platform-api").status, "enabled");
  assert.deepEqual(calls, []);
});

test("3. routine mode: suspend then resume an agent; each is executed, attributed to its proposal and audited", async () => {
  const { env, db } = kernelEnv();
  setMode(db, "routine");
  await syscall(env as never, "supervisor", "consensus.propose", { action: "suspend_agent", target: "platform-api", params: { reason: "misbehaving" } });
  let p = last(db);
  assert.equal(p.status, "executed", p.outcome_json);
  assert.equal(JSON.parse(p.outcome_json).executed, true);
  assert.deepEqual(agentStatus(db, "platform-api"), { status: "suspended", updated_by: `consensus:${p.proposal_id}` });
  await syscall(env as never, "supervisor", "consensus.propose", { action: "resume_agent", target: "platform-api" });
  p = last(db);
  assert.equal(p.status, "executed", p.outcome_json);
  assert.equal(agentStatus(db, "platform-api").status, "enabled");
  const events = db.raw.prepare("SELECT event_type, outcome FROM audit_events WHERE event_type IN ('consensus.executed', 'agent.suspended', 'agent.resumed') ORDER BY rowid").all().map((e: any) => `${e.event_type}:${e.outcome}`);
  assert.deepEqual(events, ["agent.suspended:suspended", "consensus.executed:executed", "agent.resumed:enabled", "consensus.executed:executed"]);
  assert.equal((await verifyAuditChain(db as never)).valid, true);
});

test("4. routine mode: registry actions run in the Platform Registry, which re-verifies the proposal", async () => {
  const { env, db, calls } = kernelEnv();
  setMode(db, "routine");
  await syscall(env as never, "supervisor", "consensus.propose", { action: "set_desired_version", target: "cryptophys-policy-engine", params: { version: "abcdef123456" } });
  assert.equal(last(db).status, "executed", last(db).outcome_json);
  assert.equal(service(db, "cryptophys-policy-engine").desired_version, "abcdef123456");
  await syscall(env as never, "supervisor", "consensus.propose", { action: "observe_drift", target: "platform" });
  assert.equal(last(db).status, "executed", last(db).outcome_json);
  assert.deepEqual(calls, ["registry:set_desired_version:cryptophys-policy-engine", "drift:observe"]);
  const actor = (db.raw.prepare("SELECT actor FROM audit_events WHERE event_type = 'registry.desired_version_set'").get() as any).actor;
  assert.match(actor, /^consensus:cns_/);
});

test("5. routine mode: deploys and redeploys are not executed in phase 2; critical actions do not reach the owner outside mode critical", async () => {
  const { env, db } = kernelEnv();
  setMode(db, "routine");
  db.raw.prepare("UPDATE service_registry SET desired_version = 'aaaaaaaaaaaa' WHERE service_id = 'cryptophys-platform-api'").run();
  await syscall(env as never, "supervisor", "consensus.propose", { action: "redeploy_desired_version", target: "cryptophys-platform-api" });
  const redeploy = last(db);
  assert.notEqual(redeploy.status, "executed");
  assert.notEqual(redeploy.status, "executing");
  assert.equal(JSON.parse(redeploy.outcome_json).executed, false);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM deployment_requests").get() as any).n, 0);
  await syscall(env as never, "supervisor", "consensus.propose", { action: "rotate_secret", target: "cryptophys-platform-api" });
  // Phase 4: critical actions reach the owner only in mode "critical"; in routine mode they are recorded only.
  assert.ok(["shadow_passed", "rejected", "shadow_blocked"].includes(last(db).status), last(db).status);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM consensus_proposals WHERE status = 'pending_owner'").get() as any).n, 0);
  assert.ok(proposals(db).every((p) => p.status !== "executing"));
});

test("6. an executor failure is recorded as failed, never as executed", async () => {
  const { env, db } = kernelEnv(migratedDb(), { REGISTRY: undefined });
  setMode(db, "routine");
  await syscall(env as never, "supervisor", "consensus.propose", { action: "registry_disable_service", target: "cryptophys-policy-engine" });
  const p = last(db);
  assert.equal(p.status, "failed");
  assert.match(JSON.parse(p.outcome_json).error, /registry_binding_missing/);
  assert.equal(service(db, "cryptophys-policy-engine").status === "disabled", false);
});

test("7. target Workers refuse without a live, matching, allowed, fresh consensus", async () => {
  const { env, db } = kernelEnv();
  setMode(db, "routine");
  // A kernel without the executor binding leaves the proposal 'failed'; we then craft states directly.
  await syscall(env as never, "supervisor", "consensus.propose", { action: "set_desired_version", target: "cryptophys-policy-engine", params: { version: "abcdef123456" } });
  const p = last(db);
  const registryEnv = baseEnv("cryptophys-platform-registry", db);
  const reset = () => db.raw.prepare("UPDATE consensus_proposals SET status = 'executing' WHERE proposal_id = ?").run(p.proposal_id);
  reset();
  // Malformed ids.
  await assert.rejects(applyConsensus(registryEnv as never, "nope", p.policy_decision_id, p.action, p.target, {}), /consensus_proposal_required/);
  await assert.rejects(applyConsensus(registryEnv as never, p.proposal_id, "nope", p.action, p.target, {}), /consensus_decision_required/);
  // Action or target swapped.
  await assert.rejects(applyConsensus(registryEnv as never, p.proposal_id, p.policy_decision_id, "registry_disable_service", p.target, {}), /consensus_not_executable/);
  await assert.rejects(applyConsensus(registryEnv as never, p.proposal_id, p.policy_decision_id, p.action, "cryptophys-audit-ledger", {}), /consensus_not_executable/);
  // A decision from another proposal.
  db.raw.prepare("UPDATE consensus_proposals SET policy_decision_id = 'dec_00000000-0000-0000-0000-000000000000' WHERE proposal_id = ?").run(p.proposal_id);
  await assert.rejects(applyConsensus(registryEnv as never, p.proposal_id, p.policy_decision_id, p.action, p.target, {}), /consensus_not_executable/);
  db.raw.prepare("UPDATE consensus_proposals SET policy_decision_id = ? WHERE proposal_id = ?").run(p.policy_decision_id, p.proposal_id);
  // Stale decision (beyond the 10-minute window).
  await assert.rejects(verifyConsensusExecution(db as never, p.proposal_id, p.policy_decision_id, p.action, p.target, Date.now() + CONSENSUS_EXECUTION_WINDOW_MS + 60_000), /consensus_decision_invalid/);
  // Kill switch off.
  db.raw.prepare("UPDATE kernel_controls SET value = '0' WHERE control = 'agents_enabled'").run();
  await assert.rejects(applyConsensus(registryEnv as never, p.proposal_id, p.policy_decision_id, p.action, p.target, {}), /consensus_kill_switch/);
  db.raw.prepare("UPDATE kernel_controls SET value = '1' WHERE control = 'agents_enabled'").run();
  // Already executed: no replay.
  db.raw.prepare("UPDATE consensus_proposals SET status = 'executed' WHERE proposal_id = ?").run(p.proposal_id);
  await assert.rejects(applyConsensus(registryEnv as never, p.proposal_id, p.policy_decision_id, p.action, p.target, {}), /consensus_not_executable/);
  // Back in shadow mode, nothing runs anywhere, including the real Drift Detector entrypoint.
  reset();
  setMode(db, "shadow");
  await assert.rejects(applyConsensus(registryEnv as never, p.proposal_id, p.policy_decision_id, p.action, p.target, {}), /consensus_shadow_mode/);
  await assert.rejects(observeForConsensus(baseEnv("cryptophys-drift-detector", db) as never, p.proposal_id, p.policy_decision_id), /consensus_shadow_mode/);
});

test("13. set_policy_parameter executes by consensus alone and is audited with the write (owner 2026-11-10)", async () => {
  const { env, db } = kernelEnv();
  db.raw.prepare("UPDATE consensus_controls SET value = 'routine' WHERE control = 'mode'").run();
  const r = await syscall(env as never, "supervisor", "consensus.propose", { action: "set_policy_parameter", target: "daily-deploy-limit", params: { value: 12 } });
  assert.equal(r.outcome, "succeeded");
  const p = last(db);
  assert.equal(p.status, "executed", p.outcome_json);
  assert.equal((db.raw.prepare("SELECT value FROM policy_parameters WHERE name = 'daily-deploy-limit'").get() as any).value, 12);
  const audit = db.raw.prepare("SELECT outcome, payload_json FROM audit_events WHERE event_type = 'policy.parameter_changed'").get() as any;
  assert.equal(audit.outcome, "12");
  assert.equal(JSON.parse(audit.payload_json).previous, 10);
  const bad = await syscall(env as never, "supervisor", "consensus.propose", { action: "set_policy_parameter", target: "target-actions-per-hour", params: { value: 99 } });
  assert.equal(bad.outcome, "succeeded");
  assert.notEqual(last(db).status, "executed", "a value outside the hard bounds never executes");
  assert.equal((db.raw.prepare("SELECT value FROM policy_parameters WHERE name = 'target-actions-per-hour'").get() as any).value, 1);
});
