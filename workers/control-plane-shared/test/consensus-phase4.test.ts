// ADR-0009 phase 4: critical actions wait for one owner click. Production stays in shadow mode;
// these tests switch the mode in a local D1 only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, CI_JWT, OPERATOR_EMAIL, baseEnv, call, fakeAi, fakeWorkflow, migratedDb } from "./harness.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { verifySyscallDecision } from "../src/capabilities.ts";
import { verifyConsensusExecution } from "../src/consensus-exec.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { proposeFromAgent } from "../../recovery-manager/src/index.ts";
import { DeploymentLock, retireForConsensus } from "../../deployment-orchestrator/src/index.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { runCycle } from "../../ai-kernel/src/supervisor.ts";
import { OWNER_DECISION_WINDOW_MS, PHASE4_EXECUTABLE, ownerDecide } from "../../ai-kernel/src/consensus.ts";

type Db = ReturnType<typeof migratedDb>;
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

function kernelEnv(db: Db = migratedDb()) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const recoveryEnv = { ...baseEnv("cryptophys-recovery-manager", db), RECOVERY_LIFECYCLE: fakeWorkflow().binding };
  const orch = baseEnv("cryptophys-deployment-orchestrator", db, { GH_ACTIONS_TOKEN: "gh-token", DEPLOYMENT_LOCK: lockNamespace() });
  const mem = new Map<string, unknown>();
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async (agentId: string, decisionId: string, input: Record<string, unknown>) => { await verifySyscallDecision(db, decisionId, agentId, "recovery.propose"); return proposeFromAgent(recoveryEnv as never, agentId, input); } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    DEPLOY: {
      pendingDeploys: async () => ({ main_sha: null, ci_green: false, units: [], skipped: [] }),
      deployForConsensus: async () => { throw new Error("not in this test"); },
      retireForConsensus: (id: string, dec: string, target: string) => retireForConsensus(orch as never, id, dec, target),
    },
  };
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, structuredClone(v)); } };
  return { env, db, memory };
}

function github() {
  const dispatched: { workflow: string; body: any }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("access/certs")) return (await import("./harness.ts")).accessCertsResponse();
    const m = /\/actions\/workflows\/([a-z-]+\.yml)\/dispatches$/.exec(url);
    if (m && init?.method === "POST") { dispatched.push({ workflow: m[1], body: JSON.parse(String(init.body)) }); return new Response(null, { status: 204 }); }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return dispatched;
}

const setMode = (db: Db, mode: string) => db.raw.prepare("UPDATE consensus_controls SET value = ? WHERE control = 'mode'").run(mode);
const last = (db: Db) => db.raw.prepare("SELECT * FROM consensus_proposals ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as any;
const PRINCIPAL = "ext-agent-client.access";

async function pendingPrincipal(env: Record<string, unknown>, db: Db) {
  setMode(db, "critical");
  const r = await syscall(env as never, "supervisor", "consensus.propose", { action: "register_principal", target: "platform-api", params: { access_identity: PRINCIPAL } });
  assert.equal(r.outcome, "succeeded");
  const p = last(db);
  assert.equal(p.status, "pending_owner", p.outcome_json);
  return p;
}

test("1. migration 0024: one owner decision per proposal, by a person", () => {
  const db = migratedDb();
  const cols = db.raw.prepare("PRAGMA table_info(consensus_owner_decisions)").all().map((c: any) => c.name);
  assert.deepEqual(cols, ["proposal_id", "decision", "decided_by", "reason", "created_at"]);
  assert.deepEqual([...PHASE4_EXECUTABLE].sort(), ["admit_voter", "amend_constitution", "register_principal", "register_privileged_agent", "retire_agent", "retire_worker"]);
});

test("2. critical actions reach the owner only in mode critical; shadow and routine only record them", async () => {
  for (const mode of ["shadow", "routine", "deploy"]) {
    const { env, db } = kernelEnv();
    setMode(db, mode);
    await syscall(env as never, "supervisor", "consensus.propose", { action: "register_principal", target: "platform-api", params: { access_identity: PRINCIPAL } });
    assert.notEqual(last(db).status, "pending_owner", mode);
    await assert.rejects(ownerDecide(env as never, last(db).proposal_id, "approve", APPROVER_EMAIL, null), /not_pending_owner/, mode);
  }
});

test("3. approve: the owner click is recorded, the Policy Engine re-checks with it, the action executes and is audited", async () => {
  const { env, db } = kernelEnv();
  const p = await pendingPrincipal(env, db);
  const res = await ownerDecide(env as never, p.proposal_id, "approve", APPROVER_EMAIL, "looks right");
  assert.equal(res.status, "executed", JSON.stringify(res));
  const row = db.raw.prepare("SELECT status, policy_decision_id FROM consensus_proposals WHERE proposal_id = ?").get(p.proposal_id) as any;
  assert.equal(row.status, "executed");
  assert.notEqual(row.policy_decision_id, p.policy_decision_id, "a fresh policy decision at execution time");
  const dec = db.raw.prepare("SELECT action, resource, decision, evidence_json FROM policy_decisions WHERE decision_id = ?").get(row.policy_decision_id) as any;
  assert.equal(dec.decision, "allow");
  assert.match(dec.evidence_json, /owner_approved/);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_principals WHERE agent_id = 'platform-api' AND access_identity = ?").get(PRINCIPAL) as any).n, 1);
  const owner = db.raw.prepare("SELECT decision, decided_by, reason FROM consensus_owner_decisions WHERE proposal_id = ?").get(p.proposal_id) as any;
  assert.deepEqual({ ...owner }, { decision: "approve", decided_by: APPROVER_EMAIL, reason: "looks right" });
  const events = db.raw.prepare("SELECT event_type, actor FROM audit_events WHERE event_type LIKE 'consensus.%' ORDER BY rowid").all().map((e: any) => `${e.event_type}:${e.actor}`);
  assert.ok(events.includes(`consensus.owner_approved:${APPROVER_EMAIL}`));
  assert.ok(events.includes(`consensus.executed:${APPROVER_EMAIL}`));
  assert.equal((await verifyAuditChain(db as never)).valid, true);
  // A second click (or a replay) is refused.
  await assert.rejects(ownerDecide(env as never, p.proposal_id, "approve", APPROVER_EMAIL, null), /not_pending_owner/);
});

test("4. reject: closes the proposal, nothing executes", async () => {
  const { env, db } = kernelEnv();
  const p = await pendingPrincipal(env, db);
  const res = await ownerDecide(env as never, p.proposal_id, "reject", APPROVER_EMAIL, "not now");
  assert.equal(res.status, "rejected");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_principals WHERE access_identity = ?").get(PRINCIPAL) as any).n, 0);
  await assert.rejects(ownerDecide(env as never, p.proposal_id, "approve", APPROVER_EMAIL, null), /not_pending_owner/);
});

test("5. only a person decides; service tokens never; the window is 24 h; manual-only actions are not approvable", async () => {
  const { env, db } = kernelEnv();
  const p = await pendingPrincipal(env, db);
  await assert.rejects(ownerDecide(env as never, p.proposal_id, "approve", "ci-client.access", null), /person_required/);
  await assert.rejects(ownerDecide(env as never, p.proposal_id, "approve", APPROVER_EMAIL, null, Date.now() + OWNER_DECISION_WINDOW_MS + 60_000), /expired/);
  assert.equal(last(db).status, "expired");
  await syscall(env as never, "supervisor", "consensus.propose", { action: "rotate_secret", target: "cryptophys-platform-api" });
  const manual = last(db);
  assert.equal(manual.status, "pending_owner", manual.outcome_json);
  await assert.rejects(ownerDecide(env as never, manual.proposal_id, "approve", APPROVER_EMAIL, null), /manual_only/);
  assert.equal((await ownerDecide(env as never, manual.proposal_id, "reject", APPROVER_EMAIL, "done by runbook")).status, "rejected");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM consensus_owner_decisions WHERE decision = 'approve'").get() as any).n, 0);
});

test("6. leaving mode critical before the click blocks approval; targets refuse without the owner row", async () => {
  const { env, db } = kernelEnv();
  const p = await pendingPrincipal(env, db);
  setMode(db, "deploy");
  await assert.rejects(ownerDecide(env as never, p.proposal_id, "approve", APPROVER_EMAIL, null), /mode_not_critical/);
  setMode(db, "critical");
  // Even with the proposal forced to executing and a matching allow, the shared check needs the owner's approval row.
  db.raw.prepare("UPDATE consensus_proposals SET status = 'executing' WHERE proposal_id = ?").run(p.proposal_id);
  await assert.rejects(verifyConsensusExecution(db as never, p.proposal_id, p.policy_decision_id, p.action, p.target), /consensus_owner_approval_required/);
});

test("7. retire_worker: an owner-approved retire dispatches the Retire Worker workflow only for a disabled, non-deployable Worker", async () => {
  const { env, db } = kernelEnv();
  setMode(db, "critical");
  try {
    const dispatched = github();
    // An active deploy unit is never retired, even after an owner click.
    await syscall(env as never, "supervisor", "consensus.propose", { action: "retire_worker", target: "cryptophys-console" });
    let p = last(db);
    assert.equal(p.status, "pending_owner", p.outcome_json);
    const refused = await ownerDecide(env as never, p.proposal_id, "approve", APPROVER_EMAIL, null);
    assert.equal(refused.status, "failed");
    assert.match(JSON.stringify(refused.outcome), /worker_is_an_active_deploy_unit/);
    assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM deployment_requests").get() as any).n, 0);
    // The retired Signal Engine (registry status disabled) can be dispatched for deletion.
    await syscall(env as never, "supervisor", "consensus.propose", { action: "retire_worker", target: "cryptophys-signal-engine" });
    p = last(db);
    assert.equal(p.status, "pending_owner", p.outcome_json);
    const r = await ownerDecide(env as never, p.proposal_id, "approve", APPROVER_EMAIL, "TP-018 decision");
    assert.equal(r.status, "executed", JSON.stringify(r));
    assert.deepEqual(dispatched, [{ workflow: "retire-worker.yml", body: { ref: "main", inputs: { worker: "cryptophys-signal-engine", confirm_production: "DELETE" } } }]);
    const req = db.raw.prepare("SELECT service_id, requested_by, status, approval_id FROM deployment_requests").get() as any;
    assert.deepEqual({ ...req }, { service_id: "cryptophys-signal-engine", requested_by: `consensus:${p.proposal_id}`, status: "running", approval_id: p.proposal_id });
  } finally { globalThis.fetch = realFetch; }
});

test("8. HTTP: approvers decide through the kernel; operators and service tokens are refused", async () => {
  const { env, db } = kernelEnv();
  const p = await pendingPrincipal(env, db);
  try {
    github();
    const path = `/v1/consensus/${p.proposal_id}/approve`;
    const ci = await call(kernel, env, new Request(`https://x${path}`, { method: "POST", headers: { "cf-access-jwt-assertion": CI_JWT, "content-type": "application/json" }, body: "{}" }));
    assert.equal(ci.status, 403);
    assert.equal(ci.body.error, "approver_required");
    const ok = await call(kernel, env, new Request(`https://x${path}`, { method: "POST", headers: { "cf-access-jwt-assertion": APPROVER_JWT, "content-type": "application/json" }, body: JSON.stringify({ reason: "ok" }) }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, "executed");
    const again = await call(kernel, env, new Request(`https://x${path}`, { method: "POST", headers: { "cf-access-jwt-assertion": APPROVER_JWT, "content-type": "application/json" }, body: "{}" }));
    assert.equal(again.status, 409);
    const bad = await call(kernel, env, new Request("https://x/v1/consensus/cns_nope/approve", { method: "POST", headers: { "cf-access-jwt-assertion": APPROVER_JWT, "content-type": "application/json" }, body: "{}" }));
    assert.equal(bad.status, 404);
  } finally { globalThis.fetch = realFetch; }
});

test("9. scheduled cycles expire owner decisions older than 24 h", async () => {
  const { env, db, memory } = kernelEnv();
  const p = await pendingPrincipal(env, db);
  db.raw.prepare("UPDATE consensus_proposals SET created_at = ? WHERE proposal_id = ?").run(new Date(Date.now() - OWNER_DECISION_WINDOW_MS - 60_000).toISOString(), p.proposal_id);
  const cycle = await runCycle(env as never, memory, "scheduled");
  assert.ok(cycle.findings.some((f) => f.kind === "consensus" && f.action === "expire"));
  assert.equal((db.raw.prepare("SELECT status FROM consensus_proposals WHERE proposal_id = ?").get(p.proposal_id) as any).status, "expired");
});
