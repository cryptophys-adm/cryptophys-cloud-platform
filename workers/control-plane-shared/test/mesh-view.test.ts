// Owner 2026-11-11: "halaman AI Mesh masih statis belum autonomous dan dinamis". GET /v1/mesh shows
// what each agent did in the last 24 h (syscalls, council votes, reports), the census history and the
// self-registration proposals, all read from the database; nothing is estimated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

// Owner 2026-11-12: "bagaimana kita juga ingin menampilkan remote vps atau omega engine dengan EA nya bisa
// termonitor di Ai Mesh". The kernel reads the xauusd AI Worker's OmegaHealth.health() (read-only) and shows
// only known fields of the expected type; a host that does not answer is unreachable, never guessed.
const HEALTH = {
  schema: "omega-health.v1", server_ms: NOW, engine_enabled: true,
  ea: { seen: true, heartbeat_age_ms: 60_000, stale_after_ms: 900_000, connected: true, version: "2.1", mode: "auto", trading_allowed: true, open_positions: 2, reported_control: "active" },
  control: { mode: "active", set_ms: null },
  bridge: { seen: true, synced_age_ms: 20_000, stale_after_ms: 120_000, connected: true, bridge_version: "1.4.0", credentials_stored: true, terminal_connected: true, trade_allowed: true, terminal_state_age_ms: 5_000 },
};

test("M3. execution hosts: Omega's VPS bridge and EA come from OmegaHealth, typed field by field", async () => {
  const { executionHosts } = await import("../../ai-kernel/src/execution-hosts.ts");
  const db = migratedDb();
  const v: any = await meshView({ DB: db, XAUUSD_OMEGA_HEALTH: { health: async () => ({ ...HEALTH, balance: 1234, ea: { ...HEALTH.ea, version: 7, floating_pnl: 12 } }) } } as never, NOW);
  assert.equal(v.execution_hosts.length, 1);
  const h = v.execution_hosts[0];
  assert.equal(h.host_id, "omega");
  assert.equal(h.status, "observed");
  assert.equal(h.liveness, "online");
  assert.equal(h.health.ea.heartbeat_age_ms, 60_000);
  assert.equal(h.health.ea.version, null, "a field of the wrong type is null, not coerced");
  assert.equal(h.health.bridge.terminal_connected, true);
  const text = JSON.stringify(h);
  assert.ok(!text.includes("1234") && !text.includes("floating_pnl") && !text.includes("balance"), "unknown fields never pass through");

  const stale = await executionHosts({ XAUUSD_OMEGA_HEALTH: { health: async () => ({ ...HEALTH, ea: { ...HEALTH.ea, connected: false } }) } }, NOW);
  assert.equal(stale[0].liveness, "degraded");
  const down = await executionHosts({ XAUUSD_OMEGA_HEALTH: { health: async () => ({ ...HEALTH, ea: { seen: false, connected: false }, bridge: { seen: false, connected: false } }) } }, NOW);
  assert.equal(down[0].liveness, "offline");
});

test("M4. execution hosts: no binding, a failure, a timeout or another schema is reported as such", async () => {
  const { executionHosts } = await import("../../ai-kernel/src/execution-hosts.ts");
  const none = await executionHosts({}, NOW);
  assert.deepEqual([none[0].status, none[0].liveness, none[0].health], ["not_bound", null, null]);
  const failed = await executionHosts({ XAUUSD_OMEGA_HEALTH: { health: async () => { throw new Error("boom"); } } }, NOW);
  assert.deepEqual([failed[0].status, failed[0].error], ["unreachable", "rpc_failed"]);
  const slow = await executionHosts({ XAUUSD_OMEGA_HEALTH: { health: () => new Promise(() => {}) } }, NOW, 20);
  assert.deepEqual([slow[0].status, slow[0].error], ["unreachable", "timeout"]);
  const other = await executionHosts({ XAUUSD_OMEGA_HEALTH: { health: async () => ({ schema: "v0", ea: {} }) } }, NOW);
  assert.deepEqual([other[0].status, other[0].error, other[0].health], ["unreachable", "unexpected_schema", null]);
  const v: any = await meshView({ DB: migratedDb() } as never, NOW);
  assert.equal(v.execution_hosts[0].status, "not_bound", "the mesh still answers without the binding");
});

test("M5. the AI Mesh page shows the execution hosts read-only, with a dash for what was not measured", () => {
  const ui = (p: string) => readFileSync(new URL(`../../console/ui/src/${p}`, import.meta.url), "utf8");
  assert.match(ui("pages/Agents.tsx"), /<ExecutionHosts hosts=\{listOf\(mesh\.data, "execution_hosts"\)\}/);
  const c = ui("components/ExecutionHosts.tsx");
  assert.match(c, /return "—"/);
  assert.doesNotMatch(c, /call\(|fetch\(|method: "POST"|onClick/, "no control and no own data path on this panel");
  const toml = readFileSync(new URL("../../ai-kernel/wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /binding = "XAUUSD_OMEGA_HEALTH"\nservice = "xauusd-ai-trading-assistant"\nentrypoint = "OmegaHealth"/);
});
