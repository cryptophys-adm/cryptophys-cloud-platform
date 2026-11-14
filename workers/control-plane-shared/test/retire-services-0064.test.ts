// Owner 2026-11-14: cryptophys-signal-engine (disabled by 0020, TP-018) and cryptophys-home (disabled by 0055,
// ADR-0010 amendment) are retired for good by migration 0064. Neither Worker exists on the account any more.
// Their registry rows stay as the parent of their history, marked retired (retired.ts); the Drift Detector no
// longer probes, records or heartbeats them, the platform views leave them out, and the census counts neither.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { baseEnv, call, migratedDb, req } from "./harness.ts";
import { isRetiredService, notRetiredSql, RETIRED_AT_KEY } from "../src/retired.ts";
import { unitForService } from "../src/deploy-units.ts";
import { serviceName } from "../src/plain.ts";
import drift, { externalTargets, observe, targets } from "../../drift-detector/src/index.ts";
import { observe as kernelObserve } from "../../ai-kernel/src/syscall.ts";
import { unhandledProblems } from "../../ai-kernel/src/owner-inbox.ts";
import { compare } from "../../forge/src/census.ts";
import { genomeFrom } from "../src/organism.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const RETIRED = ["cryptophys-home", "cryptophys-signal-engine"];
const AT = "2026-11-14T12:00:00.000Z";

function driftEnv(db: ReturnType<typeof migratedDb>, probes: string[]) {
  const healthy = (id: string) => ({ health: async () => { probes.push(id); return { status: "ok", version: { id: "v", tag: "aaaaaaaaaaaa" } }; } });
  const ok = (id: string) => ({ fetch: async () => { probes.push(id); return Response.json({ status: "ok" }); } });
  return {
    ...baseEnv("cryptophys-drift-detector", db, { CF_VERSION_METADATA: { id: "self", tag: "aaaaaaaaaaaa" } }),
    SVC_PLATFORM_API: healthy("platform-api"), SVC_DEPLOYMENT_ORCHESTRATOR: healthy("orchestrator"), SVC_PLATFORM_REGISTRY: healthy("registry"),
    SVC_POLICY_ENGINE: healthy("policy"), SVC_AUDIT_LEDGER: healthy("audit"), SVC_RECOVERY_MANAGER: healthy("recovery"),
    SVC_AI_KERNEL: healthy("kernel"), SVC_CONSOLE: healthy("console"), SVC_FORGE: healthy("forge"),
    // Bindings of the retired Workers, as an old config would have had them: they must never be called.
    SVC_SIGNAL_ENGINE: healthy("signal-engine"), SVC_HOME: healthy("home"),
    EXT_XAUUSD_AI: ok("x-ai"), EXT_XAUUSD_NEWS: ok("x-news"), EXT_XAUUSD_PULL_ADAPTER: ok("x-pull"), EXT_XAUUSD_NEXUS: ok("x-nexus"),
    EXT_AETHER: ok("aether"), EXT_XAUUSD_OMEGA: ok("omega"),
  } as any;
}

test("R64-1. migration 0064 marks exactly the two disabled rows retired and keeps every other key", () => {
  const db = migratedDb();
  const rows = db.raw.prepare("SELECT * FROM service_registry ORDER BY service_id").all() as any[];
  const retired = rows.filter((r) => isRetiredService(r)).map((r) => r.service_id);
  assert.deepEqual(retired, RETIRED);
  for (const id of RETIRED) {
    const r = rows.find((x) => x.service_id === id);
    const m = JSON.parse(r.metadata_json);
    assert.deepEqual([r.status, r.desired_version, r.observed_version, r.updated_at], ["disabled", null, null, AT], id);
    assert.deepEqual([m[RETIRED_AT_KEY], m.retired_by], [AT, "migration:0064"], id);
    assert.match(m.retired_reason, /Worker deleted$/, id);
    assert.deepEqual([m.owner, m.data_classification], ["cryptophys-adm", "internal"], `${id} keeps its ownership metadata`);
  }
  assert.equal(JSON.parse(rows.find((r) => r.service_id === "cryptophys-signal-engine").metadata_json).source, "workers/signal-engine");
  assert.equal(JSON.parse(rows.find((r) => r.service_id === "cryptophys-home").metadata_json).source, "workers/home");
  // The rule in SQL and in code agree on every row.
  const notRetired = (db.raw.prepare(`SELECT service_id FROM service_registry WHERE ${notRetiredSql()} ORDER BY service_id`).all() as any[]).map((r) => r.service_id);
  assert.deepEqual(notRetired, rows.filter((r) => !isRetiredService(r)).map((r) => r.service_id));
  assert.equal(notRetired.length + RETIRED.length, rows.length);
});

test("R64-2. the retirement marker: only a disabled row with a non-empty retired_at; malformed metadata is not retired", () => {
  const db = migratedDb();
  const cases: Array<[string, string, boolean]> = [
    ["disabled", `{"retired_at":"${AT}"}`, true],
    ["registered", `{"retired_at":"${AT}"}`, false],
    ["disabled", "{}", false],
    ["disabled", '{"retired_at":""}', false],
    ["disabled", '{"retired_at":1}', false],
    ["disabled", '{"retired_at":null}', false],
    ["disabled", "not json", false],
  ];
  for (const [status, metadata, expected] of cases) {
    assert.equal(isRetiredService({ status, metadata_json: metadata }), expected, `${status} ${metadata}`);
    const sql = db.raw.prepare(`SELECT ${notRetiredSql()} AS live FROM (SELECT ? AS status, ? AS metadata_json)`).get(status, metadata) as any;
    assert.equal(sql.live, expected ? 0 : 1, `SQL: ${status} ${metadata}`);
  }
  assert.match(notRetiredSql("r."), /r\.status = 'disabled'/);
});

test("R64-3. the Drift Detector neither probes nor records nor heartbeats a retired service; a merely disabled one is still recorded", async () => {
  const db = migratedDb();
  // History from before the retirement: kept, never extended.
  db.raw.prepare("INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at) VALUES ('obs-home-old', 'cryptophys-home', 'd', 'o', 0, '{\"reasons\":[\"disabled\"]}', '2026-11-13T12:15:00.000Z')").run();
  db.raw.prepare("INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at) VALUES ('obs-se-old', 'cryptophys-signal-engine', 'd', 'o', 0, '{\"reasons\":[\"disabled\"]}', '2026-11-05T14:15:00.000Z')").run();
  // A disabled service that is not retired (as a recovery plan or the council would leave it).
  db.raw.prepare("UPDATE service_registry SET status = 'disabled' WHERE service_id = 'cryptophys-aether'").run();
  const probes: string[] = [];
  const env = driftEnv(db, probes);
  for (const trigger of ["scheduled", "manual", "scheduled"]) {
    const r = await observe(env, trigger, "test");
    assert.deepEqual(r.services.filter((s) => RETIRED.includes(s.service_id)), [], `${trigger}: not in the run`);
    const aether = r.services.find((s) => s.service_id === "cryptophys-aether");
    assert.deepEqual([aether?.status, aether?.reasons, aether?.drifted], ["disabled", ["disabled"], false], "a disabled, not retired, service is still recorded");
    assert.equal(r.drifted, 0);
  }
  assert.equal(probes.includes("signal-engine") || probes.includes("home") || probes.includes("aether"), false, "no disabled or retired Worker is probed");
  const history = db.raw.prepare("SELECT observation_id FROM drift_observations WHERE service_id IN ('cryptophys-home', 'cryptophys-signal-engine') ORDER BY observation_id").all() as any[];
  assert.deepEqual(history.map((h) => h.observation_id), ["obs-home-old", "obs-se-old"], "history kept, nothing added");
  const heartbeat = db.raw.prepare(`SELECT DISTINCT updated_at FROM service_registry WHERE NOT ${notRetiredSql()}`).all() as any[];
  assert.deepEqual(heartbeat.map((h) => h.updated_at), [AT], "no heartbeat after 0064");
  const audit = db.raw.prepare("SELECT payload_json FROM audit_events WHERE event_type = 'drift.observation'").all() as any[];
  assert.ok(audit.length > 0);
  for (const a of audit) for (const id of RETIRED) assert.equal(a.payload_json.includes(id), false, `the drift audit never names ${id}`);

  // GET /v1/drift lists the observed services only; a retired one's history stays readable by id.
  const latest = await call(drift, env, req("GET", "/v1/drift"));
  assert.equal(latest.status, 200);
  assert.deepEqual(latest.body.services.filter((s: any) => RETIRED.includes(s.service_id)), []);
  assert.ok(latest.body.services.some((s: any) => s.service_id === "cryptophys-aether"));
  const old = await call(drift, env, req("GET", "/v1/drift/cryptophys-home"));
  assert.deepEqual(old.body.observations.map((o: any) => o.observation_id), ["obs-home-old"]);
});

test("R64-4. the kernel's platform view and the owner's production problems leave retired services out", async () => {
  const db = migratedDb();
  db.raw.prepare("INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at) VALUES ('obs-home-old', 'cryptophys-home', 'd', 'o', 1, '{\"reasons\":[\"no_observation_binding\"]}', '2026-11-13T00:00:00.000Z')").run();
  await observe(driftEnv(db, []), "scheduled", "cryptophys-drift-detector");
  const view = await kernelObserve(baseEnv("cryptophys-ai-kernel", db) as never, Date.now());
  const ids = (view.services as any[]).map((s) => s.service_id);
  assert.equal(ids.some((id) => RETIRED.includes(id)), false, "a stale drifted row of a retired service is not in the view");
  assert.ok(ids.includes("cryptophys-console") && ids.includes("cryptophys-aether"));
  const problems = await unhandledProblems(db as never, Date.parse(AT) + 3 * 3_600_000);
  assert.equal(JSON.stringify(problems).includes("cryptophys-home") || JSON.stringify(problems).includes("cryptophys-signal-engine"), false, "never stale, never missing");
});

test("R64-5. the census and the DNA: neither is declared, deployed or observed, so nothing is counted or found", async () => {
  const dirs = readdirSync(new URL("workers/", ROOT), { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(new URL(`workers/${d.name}/organism.json`, ROOT)));
  const genome = genomeFrom(dirs.map((d) => ({ path: `workers/${d.name}/organism.json`, text: read(`workers/${d.name}/organism.json`) })));
  for (const id of RETIRED) {
    assert.equal(genome.has(id), false, `${id} has no DNA`);
    assert.equal(unitForService(id), null, `${id} has no deploy unit`);
    assert.equal(id in targets({} as never) || id in externalTargets({} as never), false, `${id} has no drift target`);
    assert.equal(existsSync(new URL(`workers/${id.replace(/^cryptophys-/, "")}`, ROOT)), false, `${id} has no source`);
  }
  assert.deepEqual([serviceName("cryptophys-home"), serviceName("cryptophys-signal-engine")].every((n) => n.length > 0), true, "historical rows still read as words");
  const db = migratedDb();
  const findings = await compare(db as never, genome);
  assert.deepEqual(findings.filter((f) => RETIRED.some((id) => f.subject.includes(id) || f.detail.includes(id))), []);
  assert.equal(genome.size, dirs.length, "the census counts the DNA's organs only");
});
