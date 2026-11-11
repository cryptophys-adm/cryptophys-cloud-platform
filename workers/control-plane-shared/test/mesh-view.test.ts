// Owner 2026-11-11: "halaman AI Mesh masih statis belum autonomous dan dinamis". GET /v1/mesh shows
// what each agent did in the last 24 h (syscalls, council votes, reports), the census history and the
// self-registration proposals, all read from the database; nothing is estimated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { migratedDb } from "./harness.ts";
import { meshView } from "../../ai-kernel/src/mesh-view.ts";

const NOW = Date.UTC(2026, 10, 11, 1, 0, 0);
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

test("M1. liveness per agent comes from actions, votes and reports in the last 24 h", async () => {
  const db = migratedDb();
  // A suspended agent (signal-engine was the seeded one until 0047 dismantled it).
  db.raw.prepare("UPDATE agents SET status = 'suspended' WHERE agent_id = 'hud-prophet'").run();
  const action = db.raw.prepare(`INSERT INTO agent_actions (action_id, agent_id, capability, tier, decision_id, outcome, input_json, result_json, created_at) VALUES (?, ?, ?, 1, NULL, ?, '{}', '{}', ?)`);
  action.run("act_1", "supervisor", "platform.observe", "succeeded", iso(10));
  action.run("act_2", "supervisor", "consensus.propose", "succeeded", iso(5));
  action.run("act_3", "auditor", "reports.publish", "denied", iso(300));
  action.run("act_old", "auditor", "reports.publish", "succeeded", iso(60 * 30)); // outside the window
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES ('cns_${"1".repeat(36)}', 'supervisor', 'register_engine', 'cryptophys-forge', 'routine', '{}', '{}', 'deploy', 8, 8, 0, 1, NULL, 'allow', 'executed', '{"executed":true}', ?, ?)`).run(iso(20), iso(19));
  db.raw.prepare(`INSERT INTO consensus_votes (proposal_id, voter_agent_id, vote, reason, created_at) VALUES ('cns_${"1".repeat(36)}', 'policy-engine', 'approve', 'ok', ?)`).run(iso(19));

  const v: any = await meshView({ DB: db } as never, NOW);
  const byId = Object.fromEntries(v.agents.map((a: any) => [a.agent_id, a]));
  assert.equal(byId.supervisor.actions_24h, 2);
  assert.equal(byId.supervisor.last_capability, "consensus.propose");
  assert.equal(byId.supervisor.liveness, "active");
  assert.equal(byId.auditor.actions_24h, 1, "an action older than 24 h is not counted");
  assert.equal(byId.auditor.liveness, "recent");
  assert.equal(byId["policy-engine"].votes_24h, 1);
  assert.equal(byId["policy-engine"].liveness, "active");
  assert.equal(byId["hud-prophet"].liveness, "suspended");
  assert.ok(v.agents.some((a: any) => a.liveness === "idle"), "an agent with no activity is idle, not active");
  assert.equal(v.activity.length, 3);
  assert.equal(v.activity[0].capability, "consensus.propose");
  assert.equal(v.registrations.length, 1);
  assert.equal(v.registrations[0].action, "register_engine");
  assert.deepEqual(v.registrations[0].outcome, { executed: true });
});

test("M2. without activity, census or registrations the view answers with empty lists", async () => {
  const db = migratedDb();
  const v: any = await meshView({ DB: db } as never, NOW);
  assert.ok(v.agents.length > 0);
  assert.equal(v.activity.length, 0);
  assert.equal(v.census.length, 0);
  assert.equal(v.registrations.length, 0);
  assert.ok(v.agents.every((a: any) => a.actions_24h === 0 && a.last_seen_at === null));
});
