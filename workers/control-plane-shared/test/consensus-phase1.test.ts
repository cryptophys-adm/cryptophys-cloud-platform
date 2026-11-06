// ADR-0009 phase 1: shadow consensus. Proposals are classified, voted by the control-plane
// agents, tallied by simple majority, vetoed or allowed by the Policy Engine, recorded and
// audited — and never executed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, OUTSIDER_JWT, baseEnv, call, fakeAi, fakeWorkflow, migratedDb, req,
} from "./harness.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { verifySyscallDecision } from "../src/capabilities.ts";
import { REQUIRED_MIGRATION, schemaReady } from "../src/readiness.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { proposeFromAgent } from "../../recovery-manager/src/index.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { runCycle } from "../../ai-kernel/src/supervisor.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { CONSENSUS_ACTIONS, VOTERS, castVote, classify } from "../../ai-kernel/src/consensus.ts";

type Db = ReturnType<typeof migratedDb>;

function memory() {
  const m = new Map<string, unknown>();
  return { async get<T>(k: string) { return m.get(k) as T | undefined; }, async put(k: string, v: unknown) { m.set(k, structuredClone(v)); } };
}

function kernelEnv(db: Db = migratedDb(), extra: Record<string, unknown> = {}) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const recoveryEnv = { ...baseEnv("cryptophys-recovery-manager", db), RECOVERY_LIFECYCLE: fakeWorkflow().binding };
  const mem = memory();
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async (agentId: string, decisionId: string, input: Record<string, unknown>) => { await verifySyscallDecision(db, decisionId, agentId, "recovery.propose"); return proposeFromAgent(recoveryEnv as never, agentId, input); } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    ...extra,
  };
  return { env, db, mem };
}

function drift(db: Db, serviceId: string, drifted: boolean, minutesAgo: number) {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  db.raw.prepare(`INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at)
    VALUES (?, ?, 'd', 'o', ?, ?, ?)`).run(`obs_${serviceId}_${minutesAgo}`, serviceId, drifted ? 1 : 0,
    JSON.stringify({ reasons: drifted ? ["version_mismatch"] : [], desired_version: "aaaaaaaaaaaa", probe: { version_tag: drifted ? "bbbbbbbbbbbb" : "aaaaaaaaaaaa" } }), at);
}
function persistentDrift(db: Db, svc = "cryptophys-platform-api") {
  db.raw.prepare("UPDATE service_registry SET desired_version = 'aaaaaaaaaaaa' WHERE service_id = ?").run(svc);
  drift(db, svc, true, 20);
  drift(db, svc, true, 5);
}
const proposals = (db: Db) => db.raw.prepare("SELECT * FROM consensus_proposals ORDER BY created_at").all() as any[];
const votes = (db: Db, id: string) => db.raw.prepare("SELECT voter_agent_id, vote FROM consensus_votes WHERE proposal_id = ? ORDER BY voter_agent_id").all(id) as any[];

test("1. migration 0023: consensus tables, shadow mode, supervisor may propose", async () => {
  const db = migratedDb();
  assert.equal(REQUIRED_MIGRATION, "0024_consensus_owner_approval.sql");
  assert.equal(await schemaReady({ DB: db } as never), true);
  assert.deepEqual(db.raw.prepare("SELECT control, value FROM consensus_controls").all().map((r: any) => [r.control, r.value]), [["mode", "shadow"]]);
  const sup = db.raw.prepare("SELECT tier_max, capabilities_json FROM agents WHERE agent_id = 'supervisor'").get() as any;
  assert.equal(sup.tier_max, 1);
  assert.ok(JSON.parse(sup.capabilities_json).includes("consensus.propose"));
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agents WHERE capabilities_json LIKE '%consensus.propose%'").get() as any).n, 1, "only the supervisor proposes in phase 1");
  assert.throws(() => db.raw.prepare("UPDATE consensus_controls SET value = 'autonomous'").run(), /CHECK/);
});

test("2. persistent drift: the supervisor proposes, 8 control-plane agents vote, majority and policy pass, shadow records it", async () => {
  const { env, db, mem } = kernelEnv();
  persistentDrift(db);
  const cycle = await runCycle(env as never, mem, "scheduled");
  assert.ok(cycle.findings.some((f) => f.action === "consensus.propose" && f.outcome === "succeeded"));
  const [p] = proposals(db);
  assert.equal(p.action, "redeploy_desired_version");
  assert.equal(p.target, "cryptophys-platform-api");
  assert.equal(p.proposer_agent_id, "supervisor");
  assert.equal(p.class, "routine");
  assert.equal(p.mode, "shadow");
  assert.equal(p.eligible, 8, "nine voters minus the proposer");
  const v = votes(db, p.proposal_id);
  assert.equal(v.length, 8);
  assert.ok(!v.some((x) => x.voter_agent_id === "supervisor"), "the proposer does not vote");
  assert.ok(!v.some((x) => x.voter_agent_id.startsWith("xauusd") || x.voter_agent_id.startsWith("hud-")), "XAUUSD agents never vote");
  assert.equal(p.approvals, 8);
  assert.equal(p.passed, 1);
  assert.equal(p.policy_decision, "allow");
  assert.equal(p.status, "shadow_passed");
  assert.deepEqual(JSON.parse(p.outcome_json).executed, false);
  const audit = db.raw.prepare("SELECT outcome FROM audit_events WHERE event_type = 'consensus.tallied'").all() as any[];
  assert.deepEqual(audit.map((a) => a.outcome), ["shadow_passed"]);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("3. shadow mode executes nothing: registry, deployments, recovery plans and agents are unchanged", async () => {
  const { env, db, mem } = kernelEnv();
  persistentDrift(db);
  const before = JSON.stringify(db.raw.prepare("SELECT service_id, status, desired_version FROM service_registry ORDER BY service_id").all());
  await runCycle(env as never, mem, "scheduled");
  for (const action of ["suspend_agent", "registry_disable_service"] as const) {
    const target = action === "suspend_agent" ? "platform-api" : "cryptophys-policy-engine";
    const r = await syscall(env as never, "supervisor", "consensus.propose", { action, target });
    assert.equal(r.outcome, "succeeded", action);
  }
  assert.equal(JSON.stringify(db.raw.prepare("SELECT service_id, status, desired_version FROM service_registry ORDER BY service_id").all()), before);
  assert.equal((db.raw.prepare("SELECT status FROM agents WHERE agent_id = 'platform-api'").get() as any).status, "enabled");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM deployment_requests").get() as any).n, 0);
  assert.deepEqual(db.raw.prepare("SELECT DISTINCT status FROM recovery_plans").all().map((r: any) => r.status), ["draft"]);
  assert.ok(proposals(db).every((p) => p.status !== "executed" && p.status !== "executing"));
});

test("4. safety gate: an open critical report or a broken audit chain makes every voter reject", async () => {
  const { env, db } = kernelEnv();
  persistentDrift(db);
  db.raw.prepare(`INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at)
    VALUES ('rpt_x', 'auditor', 'audit_digest', 'critical', 'Audit chain invalid', '{}', 'deterministic', 'dec_x', ?)`).run(new Date().toISOString());
  const r = await syscall(env as never, "supervisor", "consensus.propose", { action: "redeploy_desired_version", target: "cryptophys-platform-api" });
  assert.equal(r.outcome, "succeeded");
  const [p] = proposals(db);
  assert.equal(p.approvals, 0);
  assert.equal(p.passed, 0);
  assert.equal(p.status, "rejected");
  assert.equal(p.policy_decision, "deny", "the Policy Engine also refuses an unpassed consensus");
});

test("5. prohibited and unknown actions: trading never passes; unknown actions are refused", async () => {
  const { env, db } = kernelEnv();
  assert.equal(classify("transfer_funds"), "prohibited");
  assert.equal(classify("place_order"), "prohibited");
  assert.equal(classify("make_coffee"), null);
  const bad = await syscall(env as never, "supervisor", "consensus.propose", { action: "transfer_funds", target: "cryptophys-platform-api" });
  assert.equal(bad.outcome, "succeeded");
  const [p] = proposals(db);
  assert.deepEqual([p.class, p.approvals, p.passed, p.status, p.policy_decision], ["prohibited", 0, 0, "rejected", null]);
  const unknown = await syscall(env as never, "supervisor", "consensus.propose", { action: "make_coffee", target: "cryptophys-platform-api" });
  assert.equal(unknown.outcome, "failed");
  assert.match((unknown as any).reason, /unknown_action/);
  for (const [name, def] of Object.entries(CONSENSUS_ACTIONS)) assert.ok(def.class !== "prohibited", `${name} must not be prohibited`);
});

test("6. rate limits: the same action on the same target again is rejected by the policy voter and vetoed by the Policy Engine", async () => {
  const { env, db } = kernelEnv();
  persistentDrift(db);
  await syscall(env as never, "supervisor", "consensus.propose", { action: "redeploy_desired_version", target: "cryptophys-platform-api" });
  await syscall(env as never, "supervisor", "consensus.propose", { action: "redeploy_desired_version", target: "cryptophys-platform-api" });
  const [, second] = proposals(db);
  const v = votes(db, second.proposal_id);
  assert.equal(v.find((x) => x.voter_agent_id === "policy-engine").vote, "reject");
  assert.equal(second.policy_decision, "deny");
  assert.notEqual(second.status, "shadow_passed");
});

test("7. only the supervisor may propose; an XAUUSD agent or a platform agent is refused by policy", async () => {
  const { env, db } = kernelEnv();
  for (const agent of ["xauusd-moderator", "platform-api"]) {
    const r = await syscall(env as never, agent, "consensus.propose", { action: "observe_drift", target: "platform" });
    assert.equal(r.outcome, "denied", agent);
    assert.match((r as any).reason, /capability_granted/);
  }
  assert.equal(proposals(db).length, 0);
});

test("8. voters are deterministic and domain-specific", () => {
  const e = {
    agents_enabled: true, audit_valid: true, critical_reports_24h: 0, executing_plan_targets: [], recent_same: 0,
    services: { "cryptophys-platform-api": { service_id: "cryptophys-platform-api", drifted: false, persistent: false, desired_version: "aaaaaaaaaaaa", observed_version: "aaaaaaaaaaaa" } },
    registry: { "cryptophys-platform-api": { status: "healthy", desired_version: "aaaaaaaaaaaa" } },
    agents: { "platform-api": { status: "enabled", host_worker: "cryptophys-platform-api" } },
  };
  const p = { action: "redeploy_desired_version", target: "cryptophys-platform-api", params: {}, class: "routine" as const };
  assert.equal(castVote("drift-detector", p, e).vote, "reject", "nothing to remediate when in sync");
  assert.equal(castVote("supervisor", p, e).vote, "reject");
  assert.equal(castVote("deployment-orchestrator", { ...p, action: "deploy_commit", params: { commit_sha: "abc" } }, e).vote, "reject");
  assert.equal(castVote("deployment-orchestrator", { ...p, action: "deploy_commit", params: { commit_sha: "a".repeat(40) } }, e).vote, "approve");
  assert.equal(castVote("supervisor", { ...p, action: "suspend_agent", target: "auditor" }, { ...e, agents: { auditor: { status: "enabled", host_worker: "cryptophys-ai-kernel" } } }).vote, "reject");
  assert.equal(castVote("audit-ledger", p, { ...e, audit_valid: false }).vote, "reject");
  assert.equal(VOTERS.length, 9);
  for (const voter of VOTERS) assert.equal(castVote(voter, p, e).vote, castVote(voter, p, e).vote, "same input, same vote");
});

test("9. HTTP: operators list proposals and read votes; outsiders are refused; ids are validated", async () => {
  const { env, db } = kernelEnv();
  persistentDrift(db);
  await syscall(env as never, "supervisor", "consensus.propose", { action: "redeploy_desired_version", target: "cryptophys-platform-api" });
  const list = await call(kernel, env, req("GET", "/v1/consensus"));
  assert.equal(list.status, 200);
  assert.equal(list.body.mode, "shadow");
  assert.equal(list.body.proposals.length, 1);
  assert.equal(list.body.stats_24h.shadow_passed, 1);
  const id = list.body.proposals[0].proposal_id;
  const one = await call(kernel, env, req("GET", `/v1/consensus/${id}`));
  assert.equal(one.status, 200);
  assert.equal(one.body.votes.length, 8);
  assert.equal((await call(kernel, env, req("GET", "/v1/consensus", undefined, OUTSIDER_JWT))).status, 403);
  assert.equal((await call(kernel, env, req("GET", "/v1/consensus/not-an-id"))).status, 404);
});
