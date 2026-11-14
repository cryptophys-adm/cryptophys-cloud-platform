// Drift reports once per episode (owner, 2026-11-08). A secret change left the Orchestrator running an
// untagged version for two hours, and the Drift Detector wrote the same warning on every 15-minute
// run: eight reports for one event. Now a scheduled run reports when drift starts or changes, and
// again only after two hours of the same drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, call, migratedDb, req } from "./harness.ts";
import drift, { DRIFT_REMINDER_MS, observe } from "../../drift-detector/src/index.ts";
import { observe as kernelObserve } from "../../ai-kernel/src/syscall.ts";
import { castDomainVote } from "../src/consensus-vote.ts";
import { driftSignature, isPersistentDrift, persistentDriftSince } from "../src/drift-state.ts";

const TAG = "aaaaaaaaaaaa";

function setup() {
  const db = migratedDb();
  const reports: Array<{ subject: string; body: Record<string, unknown> }> = [];
  let orchestratorTag: string | null = TAG;
  const healthy = (tag: () => string | null) => ({ health: async () => ({ status: "ok", version: tag() ? { id: "v", tag: tag() } : null }) });
  const ok = { fetch: async () => Response.json({ status: "ok" }) };
  const env: any = {
    ...baseEnv("cryptophys-drift-detector", db, { CF_VERSION_METADATA: { id: "self", tag: TAG } }),
    AGENTS: {
      whoami: async () => ({}), observe: async () => ({}),
      syscall: async (_agent: string, capability: string, input: any) => { if (capability === "reports.publish") reports.push({ subject: input.subject, body: input.body }); return { outcome: "succeeded" }; },
    },
    SVC_DEPLOYMENT_ORCHESTRATOR: healthy(() => orchestratorTag),
    EXT_XAUUSD_AI: ok, EXT_XAUUSD_NEWS: ok, EXT_XAUUSD_PULL_ADAPTER: ok, EXT_XAUUSD_NEXUS: ok, EXT_AETHER: ok, EXT_XAUUSD_OMEGA: ok,
  };
  for (const name of ["SVC_PLATFORM_API", "SVC_PLATFORM_REGISTRY", "SVC_POLICY_ENGINE", "SVC_AUDIT_LEDGER", "SVC_RECOVERY_MANAGER", "SVC_AI_KERNEL", "SVC_CONSOLE", "SVC_HOME", "SVC_FORGE"]) env[name] = healthy(() => TAG);
  db.raw.exec(`UPDATE service_registry SET desired_version = '${TAG}' WHERE service_id LIKE 'cryptophys-%' AND service_id NOT IN ('cryptophys-aether', 'cryptophys-signal-engine')`);
  db.raw.exec("UPDATE service_registry SET status = 'disabled' WHERE service_id = 'cryptophys-signal-engine'");
  return { db, env, reports, setTag: (t: string | null) => { orchestratorTag = t; } };
}

/** Move every recorded observation and the registry heartbeat (the time of the last run, 0061) back in time, as if `ms` had passed since. */
function age(db: ReturnType<typeof migratedDb>, ms: number) {
  db.raw.prepare("SELECT rowid, observed_at AS t FROM drift_observations").all().forEach((r: any) => {
    db.raw.prepare("UPDATE drift_observations SET observed_at = ? WHERE rowid = ?").run(new Date(Date.parse(r.t) - ms).toISOString(), r.rowid);
  });
  db.raw.prepare("SELECT service_id, updated_at AS t FROM service_registry").all().forEach((r: any) => {
    db.raw.prepare("UPDATE service_registry SET updated_at = ? WHERE service_id = ?").run(new Date(Date.parse(r.t) - ms).toISOString(), r.service_id);
  });
}

test("DE1. one report when drift starts; the same drift on later runs is not reported again", async () => {
  const { env, reports, setTag } = setup();
  await observe(env, "scheduled", "cryptophys-drift-detector");
  assert.equal(reports.length, 0, "in sync: nothing to report");
  setTag(null); // a dashboard secret change: a new, untagged version
  for (let i = 0; i < 8; i++) await observe(env, "scheduled", "cryptophys-drift-detector");
  assert.equal(reports.length, 1, "eight runs of the same drift: one report");
  assert.equal(reports[0].subject, "Deployment Orchestrator is not running the expected version");
  assert.equal(reports[0].body.episode, "new");
});

test("DE2. a change of reasons is reported; so is the same drift again after two hours", async () => {
  const { db, env, reports, setTag } = setup();
  await observe(env, "scheduled", "cryptophys-drift-detector");
  setTag(null);
  await observe(env, "scheduled", "cryptophys-drift-detector");
  setTag("bbbbbbbbbbbb"); // now a different version: version_mismatch instead of observed_version_unavailable
  await observe(env, "scheduled", "cryptophys-drift-detector");
  assert.deepEqual(reports.map((r) => r.body.episode), ["new", "changed"]);
  await observe(env, "scheduled", "cryptophys-drift-detector");
  assert.equal(reports.length, 2);
  age(db, DRIFT_REMINDER_MS - 60_000);
  await observe(env, "scheduled", "cryptophys-drift-detector");
  assert.equal(reports.length, 2, "not yet two hours since the episode started");
  age(db, 2 * 60_000);
  await observe(env, "scheduled", "cryptophys-drift-detector");
  assert.equal(reports.length, 3, "two hours since the episode started: one reminder");
  await observe(env, "scheduled", "cryptophys-drift-detector");
  assert.equal(reports.length, 3, "and only one");
  assert.equal(reports[2].body.episode, "reminder");
  assert.match(reports[2].subject, /^Still: Deployment Orchestrator is not running the expected version$/);
});

test("DE3. drift that clears and comes back is a new episode; manual runs never report or count", async () => {
  const { db, env, reports, setTag } = setup();
  setTag(null);
  await observe(env, "scheduled", "cryptophys-drift-detector");
  setTag(TAG);
  await observe(env, "scheduled", "cryptophys-drift-detector");
  setTag(null);
  await observe(env, "manual", "operator");
  assert.equal(reports.length, 1, "a deploy-time (manual) observation never reports");
  await observe(env, "scheduled", "cryptophys-drift-detector");
  assert.deepEqual(reports.map((r) => r.body.episode), ["new", "new"], "the previous scheduled run was in sync: a new episode");
  const payloads = db.raw.prepare("SELECT json_extract(payload_json, '$.report') AS report, json_extract(payload_json, '$.trigger') AS trig FROM audit_events WHERE event_type = 'drift.observation' ORDER BY created_at, rowid").all().map((r: any) => [r.trig, r.report]);
  assert.deepEqual(payloads, [["scheduled", "new"], ["scheduled", null], ["manual", null], ["scheduled", "new"]], "every observation records whether it reported");
});

// ---------------------------------------------------------------- owner decision 1 (resource audit 2026-11-14, 0061)
// A drift_observations row only when a service's state changes; the same state raises the row's streak to 2 once;
// service_registry.updated_at (set by every run) is the heartbeat; drift.observation is audited only on a change.

const ORCH = "cryptophys-deployment-orchestrator";
const rowsOf = (db: ReturnType<typeof migratedDb>, svc: string) =>
  db.raw.prepare("SELECT observation_id, drifted, streak, observed_at, json_extract(evidence_json, '$.reasons') AS reasons FROM drift_observations WHERE service_id = ? ORDER BY observed_at, rowid").all(svc) as any[];
const auditCount = (db: ReturnType<typeof migratedDb>) => (db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'drift.observation'").get() as any).n;

test("DE4. eight identical scheduled runs: one row per service (streak 2 after the second run), one audit, a heartbeat on every run", async () => {
  const { db, env } = setup();
  const services = (db.raw.prepare("SELECT service_id FROM service_registry").all() as any[]).map((r) => r.service_id);
  let last = "";
  for (let i = 0; i < 8; i++) {
    last = (await observe(env, "scheduled", "cryptophys-drift-detector")).observed_at;
    const streaks = services.map((s) => rowsOf(db, s).map((r) => r.streak));
    assert.ok(streaks.every((x) => x.length === 1), `run ${i + 1}: one row per service`);
    assert.ok(streaks.every((x) => x[0] === (i === 0 ? 1 : 2)), `run ${i + 1}: streak ${i === 0 ? 1 : 2}`);
    // The heartbeat is the freshness signal: every run sets it for every service.
    const seen = db.raw.prepare("SELECT DISTINCT updated_at FROM service_registry").all() as any[];
    assert.deepEqual(seen.map((r) => r.updated_at), [last], `run ${i + 1}: every heartbeat is this run`);
  }
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM drift_observations").get() as any).n, services.length);
  assert.equal(auditCount(db), 1, "only the first run changed anything");

  // A state change: a new row for that service only, and one audit naming it.
  env.SVC_DEPLOYMENT_ORCHESTRATOR = { health: async () => ({ status: "ok", version: { id: "v", tag: "bbbbbbbbbbbb" } }) };
  const r = await observe(env, "scheduled", "cryptophys-drift-detector");
  assert.deepEqual(rowsOf(db, ORCH).map((x) => [x.drifted, x.streak, x.reasons]), [[0, 2, "[]"], [1, 1, '["version_mismatch"]']]);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM drift_observations").get() as any).n, services.length + 1);
  assert.equal(auditCount(db), 2);
  const audit = db.raw.prepare("SELECT payload_json FROM audit_events WHERE event_type = 'drift.observation' ORDER BY rowid DESC LIMIT 1").get() as any;
  assert.deepEqual(JSON.parse(audit.payload_json).changed, [ORCH]);
  assert.equal(r.services.find((s) => s.service_id === ORCH)!.recorded, true);
  assert.equal(r.services.find((s) => s.service_id === "cryptophys-platform-api")!.recorded, false);
  // The same drift again: streak 2, no row, no audit (no report either: the episode was just reported).
  await observe(env, "scheduled", "cryptophys-drift-detector");
  await observe(env, "scheduled", "cryptophys-drift-detector");
  assert.deepEqual(rowsOf(db, ORCH).map((x) => x.streak), [2, 2]);
  assert.equal(auditCount(db), 2);
});

test("DE5. persistent drift from change-only rows: the kernel, the drift-detector vote and GET /v1/drift agree", async () => {
  const { db, env, setTag } = setup();
  await observe(env, "scheduled", "cryptophys-drift-detector");
  setTag("bbbbbbbbbbbb");
  const first = await observe(env, "scheduled", "cryptophys-drift-detector");
  const persistent = async () => ((await kernelObserve({ DB: db } as never)).services as any[]).find((s) => s.service_id === ORCH);
  const vote = async () => (await castDomainVote(db as never, "drift-detector", { action: "redeploy_desired_version", target: ORCH, params: {}, class: "routine" },
    { agents_enabled: true, audit_valid: true, services: {}, registry: {}, agents: {}, critical_reports_24h: 0, executing_plan_targets: [], recent_same: 0 }));
  let k = await persistent();
  assert.deepEqual([k.drifted, k.persistent], [true, false], "seen once: not persistent");
  assert.equal(k.observed_at, first.observed_at);
  assert.equal(k.last_seen_at, first.observed_at);
  assert.doesNotMatch((await vote()).reason, /persistently/);

  const second = await observe(env, "scheduled", "cryptophys-drift-detector");
  k = await persistent();
  assert.deepEqual([k.drifted, k.persistent], [true, true], "seen on two runs in a row: persistent");
  assert.equal(k.observed_at, first.observed_at, "observed_at is when the state was first seen");
  assert.equal(k.last_seen_at, second.observed_at, "last_seen_at is the heartbeat of the latest run");
  assert.match((await vote()).reason, /persistently/);

  const listed = (await call(drift, env, req("GET", "/v1/drift"))).body.services.find((s: any) => s.service_id === ORCH);
  assert.deepEqual([listed.drifted, listed.streak, listed.observed_at, listed.last_seen_at], [true, 2, first.observed_at, second.observed_at]);
  const history = (await call(drift, env, req("GET", `/v1/drift/${ORCH}`))).body.observations;
  assert.deepEqual(history.map((o: any) => [o.drifted, o.streak]), [[true, 2], [false, 1]], "the in-sync state was seen on one run before the drift");

  // Back in sync: a new row, not persistent; a manual run that sees the same state confirms it without a row.
  setTag(TAG);
  await observe(env, "scheduled", "cryptophys-drift-detector");
  assert.equal((await persistent()).persistent, false);
  await observe(env, "manual", "operator");
  assert.deepEqual(rowsOf(db, ORCH).map((x) => [x.drifted, x.streak]), [[0, 1], [1, 2], [0, 2]]);
});

test("DE6. a drift seen first by a manual run: the next scheduled run records it, reports it as new, and the reminder is audited", async () => {
  const { db, env, reports, setTag } = setup();
  await observe(env, "scheduled", "cryptophys-drift-detector");
  setTag(null);
  await observe(env, "manual", "operator");
  assert.deepEqual(rowsOf(db, ORCH).map((x) => x.drifted), [0, 1]);
  await observe(env, "scheduled", "cryptophys-drift-detector");
  // The scheduled history alone tells the state of every scheduled run, so the episode is new.
  assert.deepEqual(rowsOf(db, ORCH).map((x) => [x.drifted, x.streak]), [[0, 1], [1, 1], [1, 1]]);
  assert.deepEqual(reports.map((r) => r.body.episode), ["new"]);
  assert.equal(((await kernelObserve({ DB: db } as never)).services as any[]).find((s) => s.service_id === ORCH).persistent, true, "two runs in a row drifted");
  await observe(env, "scheduled", "cryptophys-drift-detector");
  const audits = auditCount(db);
  age(db, DRIFT_REMINDER_MS + 60_000);
  await observe(env, "scheduled", "cryptophys-drift-detector");
  assert.deepEqual(reports.map((r) => r.body.episode), ["new", "reminder"]);
  assert.equal(auditCount(db), audits + 1, "a reminder changes no state but is audited with its report");
  const last = db.raw.prepare("SELECT json_extract(payload_json, '$.report') AS report FROM audit_events WHERE event_type = 'drift.observation' ORDER BY rowid DESC LIMIT 1").get() as any;
  assert.equal(last.report, "reminder");
});

test("DE7. drift-state rules: persistent and since read legacy per-run history and change-only history alike; reasons order is no change", () => {
  const row = (drifted: number, streak: number, observed_at: string) => ({ drifted, streak, observed_at });
  // Legacy (before 0061): one row per run, every streak 1.
  assert.equal(isPersistentDrift([row(1, 1, "t2"), row(1, 1, "t1")]), true);
  assert.equal(persistentDriftSince([row(1, 1, "t2"), row(1, 1, "t1")]), "t1");
  assert.equal(isPersistentDrift([row(1, 1, "t2"), row(0, 1, "t1")]), false);
  assert.equal(isPersistentDrift([row(0, 1, "t2"), row(1, 1, "t1")]), false);
  assert.equal(isPersistentDrift([row(1, 1, "t1")]), false);
  assert.equal(isPersistentDrift([]), false);
  // Change-only: the drifted state seen on two runs (streak 2), or drifted after another drifted state.
  assert.equal(isPersistentDrift([row(1, 2, "t2"), row(0, 2, "t1")]), true);
  assert.equal(persistentDriftSince([row(1, 2, "t2"), row(0, 2, "t1")]), "t2");
  assert.equal(isPersistentDrift([row(1, 2, "t1")]), true);
  assert.equal(isPersistentDrift([row(0, 2, "t2"), row(1, 2, "t1")]), false);
  assert.equal(persistentDriftSince([row(0, 2, "t2"), row(1, 2, "t1")]), null);
  assert.equal(isPersistentDrift([{ drifted: 1, observed_at: "t2" }, { drifted: 1, observed_at: "t1" }]), true, "a row read without streak counts as 1");
  assert.equal(driftSignature(1, "d", "o", ["b", "a"]), driftSignature(true, "d", "o", ["a", "b"]));
  assert.notEqual(driftSignature(1, "d", "o", ["a"]), driftSignature(1, "d", "o2", ["a"]));
  assert.notEqual(driftSignature(1, "d", "o", ["timeout"]), driftSignature(1, "d", "o", ["rpc_failed"]));
});
