// Owner 2026-11-11: the Knowledge Council proposes doctrine amendments daily and Cerebrum executes them
// (control-plane-shared/src/doctrine.ts, migration 0045). These tests switch the consensus mode in a
// local D1 only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, fakeAi, migratedDb } from "./harness.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { CAPABILITIES } from "../src/capabilities.ts";
import { DOCTRINE_BOUNDS, boundProblem, doctrineActionFor, doctrineProblem } from "../src/doctrine.ts";
import { castVote, classify } from "../src/consensus-rules.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { ownerDecide } from "../../ai-kernel/src/consensus.ts";

type Db = ReturnType<typeof migratedDb>;

function kernelEnv(db: Db = migratedDb()) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
  };
  return { env, db };
}
const setMode = (db: Db, mode: string) => db.raw.prepare("UPDATE consensus_controls SET value = ? WHERE control = 'mode'").run(mode);
const last = (db: Db) => db.raw.prepare("SELECT * FROM consensus_proposals ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as any;
const sc = async (env: unknown, agent: string, cap: string, input: Record<string, unknown>): Promise<any> => syscall(env as never, agent, cap, input as never);
const amendments = (db: Db) => db.raw.prepare("SELECT * FROM doctrine_amendments ORDER BY executed_at").all() as any[];

const SESSION = "kc_20261111-0352";
const routine = (over: Record<string, unknown> = {}) => ({
  action: "amend_doctrine", target: "engine-thresholds",
  params: { rule: "engine_thresholds", values: { "decision.quorum_min": 0.55 }, previous: { "decision.quorum_min": 0.5 }, canon: "0123456789ab", session: SESSION, seats: { nexus: "agree", aether: "agree" }, ...over },
});
const constitutional = () => ({
  action: "amend_constitution", target: "parity-trust-only",
  params: { rule: "parity_trust_only", values: { "parity.approval_candles": 30 }, previous: { "parity.approval_candles": 24 }, canon: "0123456789ab", session: SESSION, seats: { nexus: "agree", aether: "agree" } },
});

test("K1. migration 0045: the amendments table and one tier-1 Knowledge Council hosted by Aether", () => {
  const { db } = kernelEnv();
  const a = db.raw.prepare("SELECT host_worker, tier_max, capabilities_json, status FROM agents WHERE agent_id = 'knowledge-council'").get() as any;
  assert.deepEqual([a.host_worker, a.tier_max, a.status], ["cryptophys-aether", 1, "enabled"]);
  assert.deepEqual(JSON.parse(a.capabilities_json).sort(), ["consensus.propose", "doctrine.status", "reports.publish"]);
  assert.equal(CAPABILITIES["doctrine.status"].tier, 0);
  assert.throws(() => db.raw.prepare("INSERT INTO doctrine_amendments (amendment_id, rule_id, action, values_json, previous_json, canon, session_id, executed_by, executed_at) VALUES ('x', 'r', 'amend_doctrine', '{}', '{}', 'c', 's', 'a', 't')").run(), /CHECK/);
  assert.equal(classify("amend_doctrine"), "routine");
  assert.equal(classify("amend_constitution"), "critical");
});

test("K2. hard bounds: operational facts only, inside their bounds; weights sum to 1", () => {
  assert.equal(boundProblem("decision.quorum_min", 0.55), null);
  assert.match(String(boundProblem("decision.quorum_min", 0.9)), /outside 0.45-0.7/);
  assert.match(String(boundProblem("omega.risk_pct", 3)), /outside/);
  assert.match(String(boundProblem("parity.approval_candles", 30)), /not a council-amendable fact/);
  assert.match(String(boundProblem("decision.trading_mode", "yolo")), /one of/);
  assert.equal(boundProblem("decision.witness_weights", { D1: 0.3, H4: 0.3, H1: 0.2, M15: 0.2 }), null);
  assert.match(String(boundProblem("decision.witness_weights", { D1: 0.5, H4: 0.5 })), /from 0 to 0.3/);
  assert.match(String(boundProblem("decision.witness_weights", { D1: 0.2, H4: 0.2 })), /sum to 1/);
  // The weights in force since 2026-11-13 (xauusd #319): 14 witnesses, CALENDAR and STRATEGY_AGENTS among them.
  const inForce = { D1: 0.1263, H4: 0.1263, H1: 0.1263, M15: 0.0947, NEWS: 0.0632, MACRO: 0.0315, STRATEGY: 0.0632, KEY_LEVELS: 0.0395, REGIME: 0.0395, TREND_TF: 0.0395, MACRO_DRIVERS: 0.0237, SESSION: 0.02, CALENDAR: 0.08, STRATEGY_AGENTS: 0.1263 };
  assert.equal(boundProblem("decision.witness_weights", inForce), null);
  assert.match(String(boundProblem("decision.witness_weights", { ...inForce, STRATEGY_AGENTS: 0.0263, NOPE: 0.1 })), /unknown witness NOPE/);
  assert.equal(doctrineProblem("amend_doctrine", "engine-thresholds", routine().params), null);
  assert.match(String(doctrineProblem("amend_doctrine", "engine-thresholds", routine({ seats: { nexus: "object", aether: "agree" } }).params)), /nexus seat does not agree/);
  assert.match(String(doctrineProblem("amend_doctrine", "engine-thresholds", routine({ seats: { nexus: "agree" } }).params)), /Aether seat must agree/);
  assert.match(String(doctrineProblem("amend_doctrine", "other-rule", routine().params)), /target must be the rule id/);
  assert.match(String(doctrineProblem("amend_doctrine", "engine-thresholds", routine({ previous: {} }).params)), /previous must hold/);
  assert.equal(doctrineProblem("amend_constitution", "parity-trust-only", constitutional().params), null, "unbounded facts are allowed as critical");
  assert.match(String(doctrineProblem("amend_doctrine", "parity-trust-only", constitutional().params)), /not a council-amendable fact/);
  assert.equal(doctrineActionFor(["decision.lean"], false), "amend_doctrine");
  assert.equal(doctrineActionFor(["decision.lean"], true), "amend_constitution");
  assert.equal(doctrineActionFor(["decision.lean", "parity.approval_candles"], false), "amend_constitution");
  for (const [fact, b] of Object.entries(DOCTRINE_BOUNDS)) assert.doesNotMatch(fact, /trad(e|ing)\b|order|wallet|withdraw|transfer|swap/, `${fact} (${b.kind}) passes the Policy Engine's prohibited filter`);
});

test("K3. every voter checks the amendment itself: out of bounds is rejected", () => {
  const evidence = { agents_enabled: true, audit_valid: true, services: {}, registry: {}, agents: {}, critical_reports_24h: 0, executing_plan_targets: [], recent_same: 0 };
  const good = { ...routine(), class: "routine" as const };
  const bad = { ...routine({ values: { "decision.quorum_min": 0.95 } }), class: "routine" as const };
  for (const voter of ["platform-api", "policy-engine", "audit-ledger", "auditor", "supervisor"]) {
    assert.equal(castVote(voter, good as never, evidence).vote, "approve", voter);
    assert.equal(castVote(voter, bad as never, evidence).vote, "reject", voter);
  }
});

test("K4. only the Knowledge Council proposes doctrine amendments, and it proposes nothing else", async () => {
  const { env, db } = kernelEnv();
  setMode(db, "routine");
  const other = await sc(env, "supervisor", "consensus.propose", routine());
  assert.notEqual(other.outcome, "succeeded");
  assert.match(String(other.reason), /doctrine_council_only/);
  const wrong = await sc(env, "knowledge-council", "consensus.propose", { action: "suspend_agent", target: "platform-api", params: { reason: "x" } });
  assert.notEqual(wrong.outcome, "succeeded");
  assert.match(String(wrong.reason), /council_doctrine_only/);
  const invalid = await sc(env, "knowledge-council", "consensus.propose", routine({ values: { "decision.quorum_min": 0.95 } }));
  assert.notEqual(invalid.outcome, "succeeded");
  assert.match(String(invalid.reason), /invalid_doctrine_amendment/);
  assert.equal(amendments(db).length, 0);
});

test("K5. shadow mode records the vote and executes nothing; routine mode executes, audits and serves doctrine.status", async () => {
  const { env, db } = kernelEnv();
  const shadow = await sc(env, "knowledge-council", "consensus.propose", routine());
  assert.equal(shadow.outcome, "succeeded", String(shadow.reason));
  assert.equal(last(db).status, "shadow_passed");
  assert.equal(amendments(db).length, 0);

  setMode(db, "routine");
  // The shadow record of the same amendment costs the policy-engine voter's vote (proposed in the last 6 h); the majority still passes.
  const r = await sc(env, "knowledge-council", "consensus.propose", routine());
  assert.equal(r.outcome, "succeeded", String(r.reason));
  const p = last(db);
  assert.equal(p.status, "executed", p.outcome_json);
  const [a] = amendments(db);
  assert.equal(a.amendment_id, p.proposal_id);
  assert.deepEqual([a.rule_id, a.action, JSON.parse(a.values_json)["decision.quorum_min"], a.session_id], ["engine_thresholds", "amend_doctrine", 0.55, SESSION]);
  assert.equal(a.executed_by, `consensus:${p.proposal_id}`);
  const audit = db.raw.prepare("SELECT event_type, subject FROM audit_events WHERE event_type = 'doctrine.amended'").all() as any[];
  assert.deepEqual(audit.map((e) => e.subject), ["doctrine:engine_thresholds"]);
  assert.equal((await verifyAuditChain(db as never)).valid, true);

  const status = await sc(env, "knowledge-council", "doctrine.status", {});
  assert.equal(status.outcome, "succeeded", String(status.reason));
  const list = (status.result as any).amendments;
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].rule, list[0].values["decision.quorum_min"], list[0].previous["decision.quorum_min"]], ["engine_thresholds", 0.55, 0.5]);
  const after = await sc(env, "knowledge-council", "doctrine.status", { since: list[0].executed_at });
  assert.equal((after.result as any).amendments.length, 0, "a cursor skips what was read");
  const denied = await sc(env, "aether-curator", "doctrine.status", {});
  assert.notEqual(denied.outcome, "succeeded", "only the council holds doctrine.status");
});

test("K6. a constitutional amendment waits for one owner click in mode critical, then Cerebrum executes it", async () => {
  const { env, db } = kernelEnv();
  setMode(db, "critical");
  const r = await sc(env, "knowledge-council", "consensus.propose", constitutional());
  assert.equal(r.outcome, "succeeded", String(r.reason));
  const p = last(db);
  assert.equal(p.status, "pending_owner");
  assert.equal(amendments(db).length, 0);
  const res = await ownerDecide(env as never, p.proposal_id, "approve", APPROVER_EMAIL, "canon follows the registry");
  assert.equal(res.status, "executed", JSON.stringify(res));
  const [a] = amendments(db);
  assert.deepEqual([a.rule_id, a.action], ["parity_trust_only", "amend_constitution"]);
  assert.match(a.executed_by, /^owner:/);
});
