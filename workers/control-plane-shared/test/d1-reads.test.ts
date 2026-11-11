// Owner 2026-11-11: "asses juga penggunaan high usage di D1 row read". The latest drift observation
// per service was read with a correlated MAX over the whole table (24,480 rows per call at 12,240
// observations) by the Kernel's observe (every Supervisor cycle and every Console overview poll),
// the Drift Detector's GET /v1/drift and the owner notices. It now goes through the
// (service_id, observed_at) index per registered service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { migratedDb } from "./harness.ts";
import { observe } from "../../ai-kernel/src/syscall.ts";

function obs(db: any, id: string, service: string, drifted: boolean, at: string) {
  db.raw.prepare(`INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at)
    VALUES (?, ?, 'd', 'o', ?, ?, ?)`).run(id, service, drifted ? 1 : 0, JSON.stringify({ reasons: drifted ? ["version_mismatch"] : [], desired_version: "a".repeat(12), probe: { version_tag: drifted ? "b".repeat(12) : "a".repeat(12) } }), at);
}

test("D1. observe returns the latest observation of each registered service, and persistence from the last two", async () => {
  const db = migratedDb();
  const services = (db.raw.prepare("SELECT service_id FROM service_registry ORDER BY service_id").all() as any[]).map((r) => r.service_id);
  const [a, b] = services;
  for (let i = 0; i < 50; i++) obs(db, `obs_a_${i}`, a, i % 2 === 0, new Date(Date.UTC(2026, 10, 10, 0, i)).toISOString());
  obs(db, "obs_b_old", b, false, "2026-11-10T00:00:00.000Z");
  obs(db, "obs_b_mid", b, true, "2026-11-10T01:00:00.000Z");
  obs(db, "obs_b_new", b, true, "2026-11-10T02:00:00.000Z");
  const v: any = await observe({ DB: db } as never, Date.UTC(2026, 10, 10, 3, 0));
  const byId = Object.fromEntries(v.services.map((s: any) => [s.service_id, s]));
  assert.equal(byId[a].observed_at, new Date(Date.UTC(2026, 10, 10, 0, 49)).toISOString(), "the newest of 50 observations");
  assert.equal(byId[a].drifted, false);
  assert.equal(byId[b].drifted, true);
  assert.equal(byId[b].persistent, true, "the two most recent observations both drifted");
  assert.equal(v.services.length, 2, "services never observed are not listed");
  // drift_observations.service_id references service_registry, so reading through the registry loses no row.
  assert.throws(() => obs(db, "obs_x", "not-a-registered-service", true, "2026-11-10T03:00:00.000Z"), /FOREIGN KEY/);
});

test("D2. migration 0046 indexes the time-window and event-type reads", () => {
  const db = migratedDb();
  const idx = new Set((db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as any[]).map((r) => r.name));
  for (const n of ["idx_agent_actions_created", "idx_agent_reports_created", "idx_consensus_votes_created", "idx_audit_events_type_created"]) assert.ok(idx.has(n), n);
  const plan = (sql: string) => (db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as any[]).map((r) => r.detail).join(" | ");
  assert.match(plan("SELECT agent_id FROM agent_reports WHERE created_at >= '2026-11-10'"), /idx_agent_reports_created/);
  assert.match(plan("SELECT agent_id, capability, tier, outcome, created_at FROM agent_actions WHERE created_at >= '2026-11-10' ORDER BY created_at DESC LIMIT 500"), /idx_agent_actions_created/);
  assert.match(plan("SELECT voter_agent_id, COUNT(*) AS n, MAX(created_at) AS last_at FROM consensus_votes WHERE created_at >= '2026-11-10' GROUP BY voter_agent_id"), /idx_consensus_votes_created/);
  assert.match(plan("SELECT actor FROM audit_events WHERE event_type = 'metabolism.power_mode_changed' ORDER BY created_at DESC LIMIT 20"), /idx_audit_events_type_created/);
  assert.match(plan(`SELECT o.service_id FROM service_registry r JOIN drift_observations o ON o.observation_id = (
    SELECT i.observation_id FROM drift_observations i WHERE i.service_id = r.service_id ORDER BY i.observed_at DESC, i.rowid DESC LIMIT 1)`), /idx_drift_service_observed/);
});

test("D3. without migration 0046 the same reads return the same rows (indexes change cost, not results)", async () => {
  const { meshView } = await import("../../ai-kernel/src/mesh-view.ts");
  const seed = (db: any) => {
    const services = (db.raw.prepare("SELECT service_id FROM service_registry ORDER BY service_id").all() as any[]).map((r) => r.service_id);
    for (let i = 0; i < 6; i++) obs(db, `obs_${i}`, services[i % 2], i % 3 === 0, new Date(Date.UTC(2026, 10, 10, 0, i)).toISOString());
    const act = db.raw.prepare(`INSERT INTO agent_actions (action_id, agent_id, capability, tier, decision_id, outcome, input_json, result_json, created_at) VALUES (?, 'supervisor', 'platform.observe', 0, NULL, 'succeeded', '{}', '{}', ?)`);
    for (let i = 0; i < 5; i++) act.run(`act_${i}`, new Date(Date.UTC(2026, 10, 10, 1, i)).toISOString());
  };
  const withIdx = migratedDb();
  const without = migratedDb();
  for (const n of ["idx_agent_actions_created", "idx_agent_reports_created", "idx_consensus_votes_created", "idx_audit_events_type_created"]) without.raw.prepare(`DROP INDEX ${n}`).run();
  seed(withIdx); seed(without);
  const now = Date.UTC(2026, 10, 10, 2, 0);
  const strip = (v: any) => ({ ...v, observed_at: undefined });
  assert.deepEqual(strip(await meshView({ DB: without } as never, now)), strip(await meshView({ DB: withIdx } as never, now)));
  assert.deepEqual((await observe({ DB: without } as never, now) as any).services, (await observe({ DB: withIdx } as never, now) as any).services);
});
