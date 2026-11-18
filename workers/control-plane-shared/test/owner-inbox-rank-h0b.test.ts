// HAIC H0b (docs/design/HAIC-H0-H1.md §2.2–2.4): the ranked "Needs you" items. The ranking is pure; GET /v1/owner/inbox
// serves it as items[] next to the unchanged owner-inbox.v1 sections. One migratedDb() per test at most.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { UI_ROUTES } from "../../console/src/ui/routes.ts";
import { CONSENSUS_ACTIONS } from "../src/consensus-rules.ts";
import {
  BLOCK_CAP, CONSENSUS_KINDS, PROBLEM_KINDS, RANK_FORMULA, RANKING, consensusKind, rankInbox, scoreParts, type RankInput,
} from "../src/owner-inbox-rank.ts";

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const empty = (): RankInput => ({ approvals: { recovery_plans: [], consensus: [], knowledge: [] }, critical_reports: [], production_problems: [] });

test("H0b-1. the design's worked example: a 20 h old merge_owner_change with 4 h left (≈1155) ranks above a 1 h old critical report (≈469)", () => {
  const input = empty();
  input.approvals.consensus.push({ proposal_id: "cns_merge", action: "merge_owner_change", target: "fg-claude-x", created_at: at(-20), expires_at: at(4), approvals: 7, eligible: 9 });
  input.critical_reports.push({ report_id: "rpt_crit", agent_id: "deployment-orchestrator", subject: "native deploy failed", created_at: at(-1) });
  const items = rankInbox(input, NOW);
  assert.deepEqual(items.map((i) => [i.item_id, i.score]), [["consensus:cns_merge", 1155], ["critical_report:rpt_crit", 469]]);
  assert.deepEqual(items[0].score_parts, { U: 0.7, B: 4.5, A: 1.83, D: 2 });
  assert.deepEqual(items[1].score_parts, { U: 1, B: 4.5, A: 1.04, D: 1 });
  assert.deepEqual(items[0].blocks, ["merges", "deploys"]);
  assert.deepEqual(items[0].metric, { name: "approvals", value: 7, of: 9, unit: "votes" });
  assert.deepEqual(items[0].evidence_refs, ["ev:platform/consensus/cns_merge", "ev:platform/forge.change/fg-claude-x"]);
  assert.deepEqual(items[0].risk, { class: "critical", reversible: true, blast_radius: "change" });
  assert.equal(items[0].deep_link, "#/owner/consensus:cns_merge");
  assert.equal(items[1].metric, null, "no number, no metric: the UI shows —");
});

test("H0b-2. the factors: B capped at 6, A from 1 to 2 over the first day, D by the time left; unreadable times count as none", () => {
  assert.equal(scoreParts("low", ["trading_safety", "cutover_gate", "deploys", "merges"], at(0), null, NOW).B, BLOCK_CAP);
  assert.equal(scoreParts("low", [], at(0), null, NOW).A, 1);
  assert.equal(scoreParts("low", [], at(-12), null, NOW).A, 1.5);
  assert.equal(scoreParts("low", [], at(-72), null, NOW).A, 2);
  assert.equal(scoreParts("low", [], at(1), null, NOW).A, 1, "a time in the future is no age");
  const D = (h: number) => scoreParts("low", [], at(0), at(h), NOW).D;
  assert.deepEqual([D(-2), D(0.5), D(1), D(3), D(6), D(12), D(24), D(30)], [3, 3, 3, 2, 2, 1.5, 1.5, 1], "an expired deadline counts as the nearest");
  assert.deepEqual(scoreParts("high", ["deploys"], "not a time", "not a time", NOW), { U: 0.7, B: 3, A: 1, D: 1, score: 210 });
});

test("H0b-3. the kind tables: every critical consensus action is listed; trading-class actions are trading safety; every production problem code is listed", () => {
  const critical = Object.entries(CONSENSUS_ACTIONS).filter(([, d]) => d.class === "critical").map(([a]) => a).sort();
  assert.deepEqual(Object.keys(CONSENSUS_KINDS).sort(), critical, "a new critical action needs its row in CONSENSUS_KINDS");
  assert.deepEqual(consensusKind("agents_enable"), { urgency: "critical", blocks: ["trading_safety"] });
  assert.deepEqual(consensusKind("place_trading_order"), { urgency: "critical", blocks: ["trading_safety"] }, "TRADING_CAPABILITY wins over the name");
  assert.deepEqual(consensusKind("a_future_action"), { urgency: "normal", blocks: [] }, "an unknown action still lists");
  for (const a of ["change_access", "retire_worker", "deploy_destructive_migration"]) assert.deepEqual(CONSENSUS_KINDS[a], { urgency: "high", blocks: ["cutover_gate", "deploys"] }, a);
  for (const a of ["register_privileged_agent", "admit_voter", "retire_agent", "amend_constitution"]) assert.deepEqual(CONSENSUS_KINDS[a], { urgency: "normal", blocks: [] }, a);
  assert.deepEqual(Object.keys(PROBLEM_KINDS).sort(), ["break_glass_deployed", "build_minutes_exhausted", "critical_advisory", "deploys_stalled", "drift_unhandled", "executor_deploy_failed",
    "git_backup_unverified", "identity_source_invalid", "observations_stale", "recovery_failed", "self_unhealthy"], "owner-inbox.ts ProblemCode, all 11");
  assert.equal(PROBLEM_KINDS.break_glass_deployed.urgency, "normal");
  assert.deepEqual(PROBLEM_KINDS.executor_deploy_failed.blocks, ["deploys", "cutover_gate"]);
});

test("H0b-4. each item's action names an existing Console UI route with the same approver flag; problems have none; nothing performs an action by URL", () => {
  const input = empty();
  input.approvals.consensus.push({ proposal_id: "cns_a", action: "admit_voter", target: "x", created_at: at(-1), expires_at: at(23), approvals: 5, eligible: 8 });
  input.approvals.recovery_plans.push({ plan_id: "plan_a", service_id: "cryptophys-console", title: "Drift", created_at: at(-2), approve_by: at(10) });
  input.approvals.knowledge.push({ proposal_id: "knw_a", item_id: "k-a", item_version: 1, kind: "param_candidate", created_at: at(-3), expires_at: at(300) });
  input.critical_reports.push({ report_id: "rpt_a", agent_id: "observer", subject: "s", created_at: at(-1) });
  input.production_problems.push({ code: "deploys_stalled", subject: "deploy_stall:cns_x", detail: "no deploy for 2 h", since: at(-3), link: "#/pipelines" });
  const items = rankInbox(input, NOW);
  assert.equal(items.length, 5);
  for (const i of items) {
    if (i.action.route === null) { assert.equal(i.source, "production_problem"); assert.equal(i.action.approver_only, false); continue; }
    const route = UI_ROUTES.find((r) => r.id === i.action.route);
    assert.ok(route, `${i.item_id}: ${i.action.route} is a Console UI route`);
    assert.equal(route!.approverOnly, i.action.approver_only, i.action.route!);
    assert.ok(i.deep_link.startsWith("#/owner/") && !/approve|reject|acknowledge/.test(i.deep_link), i.deep_link);
  }
  const problem = items.find((i) => i.source === "production_problem")!;
  assert.deepEqual([problem.page, problem.urgency, problem.item_id], ["#/pipelines", "critical", "production_problem:deploys_stalled:deploy_stall:cns_x"]);
});

test("H0b-5. ties go to the oldest item, then the item id; the order does not depend on the input order", () => {
  const input = empty();
  for (const [id, h] of [["rpt_b", -2], ["rpt_c", -2], ["rpt_a", -2]] as const) input.critical_reports.push({ report_id: id, agent_id: "a", subject: "s", created_at: at(h) });
  input.critical_reports.push({ report_id: "rpt_old", agent_id: "a", subject: "s", created_at: at(-30) });
  const ids = rankInbox(input, NOW).map((i) => i.item_id);
  assert.deepEqual(ids, ["critical_report:rpt_old", "critical_report:rpt_a", "critical_report:rpt_b", "critical_report:rpt_c"]);
  input.critical_reports.reverse();
  assert.deepEqual(rankInbox(input, NOW).map((i) => i.item_id), ids);
});

test("H0b-6. GET /v1/owner/inbox adds items[] and ranking; the owner-inbox.v1 sections and counts are unchanged; reading writes nothing", async () => {
  const db = migratedDb();
  const env = baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL });
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES ('cns_00000000-0000-4000-8000-0000000000b1', 'supervisor', 'merge_owner_change', 'fg-claude-x', 'critical', '{}', '{}', 'deploy', 8, 8, 0, 1, NULL, NULL, 'pending_owner', NULL, ?, ?)`).run(ago(60), ago(59));
  db.raw.prepare(`INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at)
    VALUES ('rpt_00000000-0000-4000-8000-0000000000b1', 'deployment-orchestrator', 'platform_digest', 'critical', 'native deploy failed', '{}', 'deterministic', NULL, ?)`).run(ago(10));
  const events = () => (db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n;
  const before = events();
  const r = await call(kernel, env, req("GET", "/v1/owner/inbox", undefined, OPERATOR_JWT));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body;
  assert.equal(b.schema, "owner-inbox.v1", "additive: the schema moves to v2 only when the old sections go");
  assert.deepEqual(b.ranking, JSON.parse(JSON.stringify(RANKING)));
  assert.equal(b.ranking.formula, RANK_FORMULA);
  const n = b.counts.approvals + b.counts.critical_reports + b.counts.production_problems;
  assert.equal(b.items.length, n, "one item per listed section entry");
  assert.deepEqual(b.items.slice(0, 2).map((i: any) => i.item_id), ["consensus:cns_00000000-0000-4000-8000-0000000000b1", "critical_report:rpt_00000000-0000-4000-8000-0000000000b1"]);
  for (let i = 1; i < b.items.length; i++) assert.ok(b.items[i - 1].score >= b.items[i].score, "sorted by score");
  assert.equal(b.approvals.consensus[0].proposal_id, "cns_00000000-0000-4000-8000-0000000000b1");
  assert.equal(b.critical_reports[0].report_id, "rpt_00000000-0000-4000-8000-0000000000b1");
  assert.equal(events(), before, "reading the inbox writes nothing");
});
