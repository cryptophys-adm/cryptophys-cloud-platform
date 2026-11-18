// HAIC H4 (ADR-0017 H4 §5; the owner's answers of 2026-11-18): the autonomy dial. It only lowers a group below its
// ADR-0009 class and raises it back to that class; per group; raise-ready at >= 30 executions in 14 days with >= 95%
// success and no regression; a regression lowers a group one level at once. Enforced where consensus executes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, fakeAi, migratedDb, req } from "./harness.ts";
import {
  AUTONOMY_GROUPS, CATALOG_ACTIONS, GROUP_ACTIONS, RAISE_RULE, actionCeiling, effectiveLevel, groupCeiling, groupOf, groupStats, raiseReady,
  regressions, setLevelProblem, setPhrase, type ExecutionRow,
} from "../src/autonomy-dial.ts";
import { verifyConsensusExecution } from "../src/consensus-exec.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { ownerDecide } from "../../ai-kernel/src/consensus.ts";
import { autoDowngrade, autonomyNotices, setAutonomyLevel } from "../../ai-kernel/src/autonomy.ts";
import { ownerInbox } from "../../ai-kernel/src/owner-inbox.ts";

type Db = ReturnType<typeof migratedDb>;
const NOW = Date.parse("2026-11-18T15:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function kernelEnv(db: Db = migratedDb()) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
  };
  return { env, db, policyEnv };
}
const setMode = (db: Db, mode: string) => db.raw.prepare("UPDATE consensus_controls SET value = ? WHERE control = 'mode'").run(mode);
const last = (db: Db) => db.raw.prepare("SELECT * FROM consensus_proposals ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as any;
const dial = (db: Db, group: string, level: string) => db.raw.prepare("INSERT INTO autonomy_dial (group_id, level, source, set_by, set_at) VALUES (?, ?, 'owner', ?, ?)").run(group, level, APPROVER_EMAIL, iso(NOW - 86_400_000));
const agentStatus = (db: Db, id: string) => (db.raw.prepare("SELECT status FROM agents WHERE agent_id = ?").get(id) as any)?.status;

test("A1. the contract: every catalog action in exactly one group; ceilings are the ADR-0009 classes; the dial never rises above them", () => {
  for (const a of CATALOG_ACTIONS) {
    const homes = Object.entries(GROUP_ACTIONS).filter(([, list]) => list.includes(a)).map(([g]) => g);
    assert.equal(homes.length, 1, `${a} is in ${homes.join(", ") || "no group"}`);
    assert.equal(groupOf(a), homes[0]);
  }
  assert.equal(Object.values(GROUP_ACTIONS).flat().length, CATALOG_ACTIONS.length, "no group lists an unknown action");
  assert.deepEqual([...AUTONOMY_GROUPS], ["deploys", "merges", "recovery", "registry", "agents", "policy", "protected", "trading"]);
  assert.deepEqual([actionCeiling("deploy_commit"), actionCeiling("merge_owner_change"), actionCeiling("rotate_secret"), actionCeiling("withdraw_funds")], ["consensus", "owner_click", "owner_click", null]);
  assert.equal(groupOf("place_trading_order"), "trading");
  assert.deepEqual([groupCeiling("deploys"), groupCeiling("protected"), groupCeiling("trading")], ["consensus", "owner_click", "owner_click"]);
  // effective = min(group level, own ceiling): a critical action never runs on consensus, whatever the group's level.
  assert.deepEqual([effectiveLevel("deploy_commit", null), effectiveLevel("deploy_destructive_migration", "consensus"), effectiveLevel("deploy_commit", "suggest")], ["consensus", "owner_click", "suggest"]);
  // "Hanya turun dari ADR": any level up to the ceiling; never above it.
  assert.equal(setLevelProblem("deploys", "observe"), null);
  assert.equal(setLevelProblem("deploys", "consensus"), null);
  assert.match(String(setLevelProblem("protected", "consensus")), /cannot rise above owner_click/);
  assert.match(String(setLevelProblem("trading", "consensus")), /cannot rise above owner_click/);
  assert.match(String(setLevelProblem("funds", "observe")), /unknown group/);
  assert.equal(setPhrase("deploys", "owner_click"), "SET DEPLOYS OWNER_CLICK");
  assert.equal(criticalPathReason("workers/control-plane-shared/src/autonomy-dial.ts"), "consensus_kill_switch", "the dial's rules are a guard path");
  const db = migratedDb();
  assert.deepEqual(db.raw.prepare("PRAGMA table_info(autonomy_dial)").all().map((c: any) => c.name), ["group_id", "level", "source", "set_by", "set_at", "reason"]);
  assert.ok(db.raw.prepare("PRAGMA table_info(consensus_proposals)").all().some((c: any) => c.name === "autonomy_level"));
  assert.throws(() => db.raw.prepare("INSERT INTO autonomy_dial (group_id, level, source, set_by, set_at) VALUES ('funds', 'consensus', 'owner', 'x', 'y')").run());
});

test("A2. evidence: a rollback after a deploy and three failures in a row are regressions; raise-ready at 30 executions, 95%, no regression", () => {
  const row = (i: number, action: string, status: string, at: number, target = "cryptophys-console"): ExecutionRow => ({ proposal_id: `cns_${i}`, action, target, status, decided_at: iso(at) });
  const deploy = row(1, "deploy_commit", "executed", NOW - 90 * 60_000);
  const rb = row(2, "rollback_worker_version", "executed", NOW - 30 * 60_000);
  assert.deepEqual(regressions([deploy, rb], NOW).map((r) => [r.group, r.kind, r.ref]), [["deploys", "rollback_after_deploy", "cns_1"]]);
  assert.deepEqual(regressions([row(1, "deploy_commit", "executed", NOW - 4 * 3_600_000), rb], NOW), [], "a rollback 3.5 h later is not the deploy's");
  assert.deepEqual(regressions([deploy, row(2, "rollback_worker_version", "executed", NOW - 30 * 60_000, "cryptophys-forge")], NOW), [], "another target");
  const fails = [1, 2, 3].map((i) => row(i, "suspend_agent", "failed", NOW - (4 - i) * 60_000));
  assert.deepEqual(regressions(fails, NOW).map((r) => [r.group, r.kind]), [["agents", "consecutive_failures"]]);
  assert.deepEqual(regressions([...fails, row(9, "resume_agent", "executed", NOW)], NOW), [], "a success ends the run");
  const ok = (n: number, failed = 0) => Array.from({ length: n }, (_, i) => row(100 + i, "merge_change", i < failed ? "failed" : "executed", NOW - (n - i) * 3_600_000));
  assert.equal(raiseReady("merges", "owner_click", groupStats("merges", ok(29), NOW)), null, "29 executions are not enough");
  assert.equal(raiseReady("merges", "owner_click", groupStats("merges", ok(30), NOW)), "consensus");
  assert.equal(raiseReady("merges", "owner_click", groupStats("merges", ok(40, 2), NOW)), "consensus", "38/40 = 95%");
  assert.equal(raiseReady("merges", "owner_click", groupStats("merges", ok(40, 3), NOW)), null, "37/40 < 95%");
  assert.equal(raiseReady("merges", "consensus", groupStats("merges", ok(40), NOW)), null, "already at the ceiling");
  assert.equal(raiseReady("protected", "suggest", { executions: 40, succeeded: 40, success_rate: 1, regressions: 0 }), "owner_click");
  assert.equal(raiseReady("protected", "owner_click", { executions: 40, succeeded: 40, success_rate: 1, regressions: 0 }), null, "critical stays at the owner's click");
  assert.equal(raiseReady("deploys", "owner_click", groupStats("deploys", [...Array.from({ length: 30 }, (_, i) => row(200 + i, "deploy_commit", "executed", NOW - (40 - i) * 3_600_000, `svc-${i}`)), deploy, rb], NOW)), null, "a regression blocks it");
  assert.equal(RAISE_RULE.window_days, 14);
});

test("A3. enforcement: owner_click holds a routine action for the click; the target and the Policy Engine require it; suggest records only", async () => {
  const { env, db, policyEnv } = kernelEnv();
  setMode(db, "deploy");
  dial(db, "agents", "owner_click");
  await syscall(env as never, "supervisor", "consensus.propose", { action: "suspend_agent", target: "platform-api", params: { reason: "test" } });
  const p = last(db);
  assert.deepEqual([p.class, p.status, p.autonomy_level], ["routine", "pending_owner", "owner_click"], p.outcome_json);
  assert.match(p.outcome_json, /autonomy dial: agents is at owner_click/);
  assert.notEqual(agentStatus(db, "platform-api"), "suspended", "nothing runs before the click");
  // Defence in depth: forced to executing without the owner's decision, the target and the Policy Engine both refuse.
  db.raw.prepare("UPDATE consensus_proposals SET status = 'executing' WHERE proposal_id = ?").run(p.proposal_id);
  const pol = await decide(policyEnv as never, parsePolicyRequest({ subject: "owner:x", action: "consensus.execute", resource: `suspend_agent:platform-api`, context: { class: "routine", passed: true, stage: "execute", proposal_id: p.proposal_id } }) as never) as any;
  assert.equal(pol.decision, "deny");
  assert.ok((pol.checks ?? pol.evidence?.checks ?? []).some((c: any) => c.id === "owner_approved" && !c.passed), JSON.stringify(pol));
  db.raw.prepare("UPDATE consensus_proposals SET policy_decision_id = ?, policy_decision = 'allow' WHERE proposal_id = ?").run(pol.decision_id, p.proposal_id);
  db.raw.prepare("UPDATE policy_decisions SET decision = 'allow' WHERE decision_id = ?").run(pol.decision_id);
  await assert.rejects(verifyConsensusExecution(db as never, p.proposal_id, pol.decision_id, "suspend_agent", "platform-api"), /consensus_owner_approval_required/);
  db.raw.prepare("UPDATE consensus_proposals SET status = 'pending_owner' WHERE proposal_id = ?").run(p.proposal_id);
  // The owner's click executes it through the routine path, re-verified with the click on record.
  const res = await ownerDecide(env as never, p.proposal_id, "approve", APPROVER_EMAIL, "ok") as any;
  assert.equal(res.status, "executed", JSON.stringify(res));
  assert.equal(agentStatus(db, "platform-api"), "suspended");
  // suggest: a passed routine action and a passed critical one are recorded, not executed and not put to the owner.
  const two = kernelEnv();
  setMode(two.db, "deploy");
  dial(two.db, "agents", "suggest");
  await syscall(two.env as never, "supervisor", "consensus.propose", { action: "suspend_agent", target: "platform-api", params: { reason: "test" } });
  assert.deepEqual([last(two.db).status, last(two.db).autonomy_level], ["shadow_passed", "suggest"], last(two.db).outcome_json);
  assert.match(last(two.db).outcome_json, /recorded, not executed/);
  await syscall(two.env as never, "supervisor", "consensus.propose", { action: "register_principal", target: "platform-api", params: { access_identity: "ext-agent-client.access" } });
  assert.deepEqual([last(two.db).class, last(two.db).status], ["critical", "shadow_passed"]);
  assert.notEqual(agentStatus(two.db, "platform-api"), "suspended");
  // No row: the ADR-0009 class decides, as before H4.
  const three = kernelEnv();
  setMode(three.db, "deploy");
  await syscall(three.env as never, "supervisor", "consensus.propose", { action: "suspend_agent", target: "platform-api", params: { reason: "test" } });
  assert.deepEqual([last(three.db).status, last(three.db).autonomy_level], ["executed", "consensus"]);
});

test("A4. routes and the regression downgrade: operators read, only the owner sets (with the phrase, up to the ceiling); a regression lowers one level and tells the owner", async () => {
  const { env, db } = kernelEnv();
  const view = await call(kernel, env as never, req("GET", "/v1/autonomy", undefined, OPERATOR_JWT));
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.groups.map((g: any) => [g.group, g.level, g.source]).slice(0, 2), [["deploys", "consensus", "adr"], ["merges", "consensus", "adr"]]);
  assert.equal((await call(kernel, env as never, req("POST", "/v1/autonomy/deploys", { level: "suggest", confirmation: "SET DEPLOYS SUGGEST" }, OPERATOR_JWT))).status, 403);
  assert.equal((await call(kernel, env as never, req("POST", "/v1/autonomy/deploys", { level: "suggest", confirmation: "yes" }, APPROVER_JWT))).body.error, "confirmation_required");
  assert.equal((await call(kernel, env as never, req("POST", "/v1/autonomy/protected", { level: "consensus", confirmation: "SET PROTECTED CONSENSUS" }, APPROVER_JWT))).status, 400);
  const set = await call(kernel, env as never, req("POST", "/v1/autonomy/deploys", { level: "owner_click", confirmation: "SET DEPLOYS OWNER_CLICK", reason: "watch deploys this week" }, APPROVER_JWT));
  assert.deepEqual([set.status, set.body.previous, set.body.level], [200, "consensus", "owner_click"]);
  const ev = db.raw.prepare("SELECT actor, outcome, payload_json FROM audit_events WHERE event_type = 'autonomy.level_set'").get() as any;
  assert.deepEqual([ev.actor.includes(APPROVER_EMAIL), ev.outcome, JSON.parse(ev.payload_json).direction], [true, "owner_click", "lower"]);

  // A rollback 30 min after an executed deploy of the same Worker (both after the owner set the level) lowers deploys one level.
  db.raw.prepare("UPDATE autonomy_dial SET set_at = ? WHERE group_id = 'deploys'").run(iso(Date.now() - 2 * 3_600_000));
  const put = (id: string, action: string, status: string, at: number) => db.raw.prepare(
    `INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, status, outcome_json, created_at, decided_at)
     VALUES (?, 'supervisor', ?, 'cryptophys-console', 'routine', '{}', '{}', 'deploy', 3, 3, 0, 1, ?, '{}', ?, ?)`).run(id, action, status, iso(at), iso(at));
  put("cns_00000000-0000-4000-8000-000000000001", "deploy_commit", "executed", Date.now() - 60 * 60_000);
  put("cns_00000000-0000-4000-8000-000000000002", "rollback_worker_version", "executed", Date.now() - 30 * 60_000);
  const lowered = await autoDowngrade(db as never);
  assert.deepEqual(lowered.map((x) => [x.group, x.from, x.to, x.regression.kind]), [["deploys", "owner_click", "suggest", "rollback_after_deploy"]]);
  assert.deepEqual(await autoDowngrade(db as never), [], "the same regression lowers it once");
  assert.equal((db.raw.prepare("SELECT source FROM autonomy_dial WHERE group_id = 'deploys'").get() as any).source, "auto_downgrade");
  const inbox = await ownerInbox(db as never);
  const item = inbox.items.find((i: any) => i.kind === "autonomy_lowered") as any;
  assert.ok(item, "the owner is told");
  assert.deepEqual([item.urgency, item.page, item.action.route], ["high", "#/autonomy", "kernel.autonomy_set"]);
  // Only the owner raises it again; then the notice is gone.
  await setAutonomyLevel(db as never, APPROVER_EMAIL, "deploys", "owner_click", "SET DEPLOYS OWNER_CLICK", "looked at the rollback");
  assert.deepEqual((await autonomyNotices(db as never)).filter((n) => n.kind === "lowered"), []);
});
