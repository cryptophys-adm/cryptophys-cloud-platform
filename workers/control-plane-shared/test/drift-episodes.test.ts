// Drift reports once per episode (owner, 2026-11-08). A secret change left the Orchestrator running an
// untagged version for two hours, and the Drift Detector wrote the same warning on every 15-minute
// run: eight reports for one event. Now a scheduled run reports when drift starts or changes, and
// again only after two hours of the same drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, migratedDb } from "./harness.ts";
import { DRIFT_REMINDER_MS, observe } from "../../drift-detector/src/index.ts";

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
    EXT_XAUUSD_AI: ok, EXT_XAUUSD_NEWS: ok, EXT_XAUUSD_PULL_ADAPTER: ok, EXT_XAUUSD_NEXUS: ok, EXT_AETHER: ok,
  };
  for (const name of ["SVC_PLATFORM_API", "SVC_PLATFORM_REGISTRY", "SVC_POLICY_ENGINE", "SVC_AUDIT_LEDGER", "SVC_RECOVERY_MANAGER", "SVC_AI_KERNEL", "SVC_CONSOLE", "SVC_HOME", "SVC_FORGE"]) env[name] = healthy(() => TAG);
  db.raw.exec(`UPDATE service_registry SET desired_version = '${TAG}' WHERE service_id LIKE 'cryptophys-%' AND service_id NOT IN ('cryptophys-aether', 'cryptophys-signal-engine')`);
  db.raw.exec("UPDATE service_registry SET status = 'disabled' WHERE service_id = 'cryptophys-signal-engine'");
  return { db, env, reports, setTag: (t: string | null) => { orchestratorTag = t; } };
}

/** Move every recorded observation back in time, as if `ms` had passed since. */
function age(db: ReturnType<typeof migratedDb>, ms: number) {
  db.raw.prepare("SELECT rowid, observed_at AS t FROM drift_observations").all().forEach((r: any) => {
    db.raw.prepare("UPDATE drift_observations SET observed_at = ? WHERE rowid = ?").run(new Date(Date.parse(r.t) - ms).toISOString(), r.rowid);
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
