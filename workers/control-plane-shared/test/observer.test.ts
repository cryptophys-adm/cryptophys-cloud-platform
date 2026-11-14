// The account-wide Observer (owner 2026-11-14: "setuju"; "gak perlu shadow, langsung production"). Senses from the
// GraphQL Analytics API (fixtures: test/fixtures/observer-graphql.json; no network), anomalies against the 7-day
// baseline, deploy correlation, the Supervisor's rollback proposal with every safeguard, the account inventory, and
// "no data, no finding".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { CI_CLIENT_ID, OPERATOR_EMAIL, APPROVER_EMAIL, OUTSIDER_JWT, baseEnv, call, fakeAi, migratedDb, req } from "./harness.ts";
import {
  CPU_LIMIT_MS, GRAPHQL_URL, OBSERVABILITY_PERMISSION, OBSERVER_CRON, PLAN_DEFAULT_CPU_MS, THRESHOLDS, TRADING_WORKERS,
  cpuWarning, lastCompleteHour, latestDeploy, loadSpike, parseWorkers, rateAnomaly, readSenses, rollbackCapable, rollbackGate,
  runSenses, sinceDeploy, storeFindings, sweepObserver, type Finding, type RollbackCandidate, type Vital,
} from "../src/observer.ts";
import { DECLARED_RESOURCES, LISTS, compareInventory, previewOf, runInventory, type KnownOrganism, type ListKey } from "../src/observer-inventory.ts";
import { appendAuditEvent } from "../src/audit.ts";
import { EXTERNAL_ORIGINS } from "../src/organism.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { runCycle } from "../../ai-kernel/src/supervisor.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const FIX = JSON.parse(readFileSync(new URL("./fixtures/observer-graphql.json", import.meta.url), "utf8"));
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OBS_ENV = { CF_ANALYTICS_TOKEN: "analytics-token", CF_ACCOUNT_ID: ACCOUNT };
const HOUR = 3_600_000;
const OLD = "aaaaaaaaaaaa";
const NEW = "bbbbbbbbbbbb";
const EXTERNAL = Object.fromEntries(EXTERNAL_ORIGINS.map((o) => [o.origin, o.services]));

type Answer = unknown | (() => Response);
/** A fake Cloudflare API: GraphQL by dataset, the telemetry query, and the account lists. Records every call. */
function fakeCf(over: Record<string, Answer> = {}) {
  const calls: string[] = [];
  const answer = (key: string, fallback: unknown) => {
    const v = Object.hasOwn(over, key) ? over[key] : fallback;
    return typeof v === "function" ? (v as () => Response)() : Response.json(v);
  };
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    assert.equal((init?.headers as Record<string, string>)?.authorization, "Bearer analytics-token", "every call uses the Observer's token");
    if (url === GRAPHQL_URL) {
      const q = String(JSON.parse(String(init!.body)).query);
      const key = q.includes("workersInvocationsAdaptive") ? "workers" : q.includes("d1QueriesAdaptiveGroups") ? "d1_queries" : q.includes("d1AnalyticsAdaptiveGroups") ? "d1"
        : q.includes("kvOperationsAdaptiveGroups") ? "kv" : q.includes("durableObjectsInvocationsAdaptiveGroups") ? "do" : "ai";
      calls.push(`graphql:${key}`);
      return answer(key, FIX[key]);
    }
    if (url.endsWith("/workers/observability/telemetry/query")) { calls.push("observability"); return answer("observability", FIX.observability); }
    const path = url.replace(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/`, "");
    const key = (Object.keys(LISTS) as ListKey[]).find((k) => LISTS[k].path === path);
    assert.ok(key, `unexpected ${url}`);
    calls.push(`list:${key}`);
    return answer(`list:${key}`, { success: true, result: key === "r2" ? { buckets: [] } : [] });
  };
  return { fetcher, calls };
}
const gqlError = (message: string) => () => Response.json({ data: null, errors: [{ message }] });
const empty = { data: { viewer: { accounts: [{ w: [], s: [], g: [] }] } } };

const vital = (subject: string, hour: string, v: Partial<Vital> = {}): Vital => ({
  subject, kind: "worker", hour, requests: 1000, errors: 10, rows_read: null, rows_written: null, neurons: null,
  cpu_p50_ms: 1, cpu_p99_ms: 5, wall_p50_ms: null, wall_p99_ms: null, exceeded_cpu: 0, exceeded_memory: 0, exceptions: 5, sample: {}, ...v,
});
/** `hours` baseline hours before `hour`, about 1 % errors (alternating 9 and 11 per 1000). */
const history = (subject: string, hour: string, hours: number, v: Partial<Vital> = {}) =>
  Array.from({ length: hours }, (_, i) => vital(subject, new Date(Date.parse(hour) - (i + 1) * HOUR).toISOString(), { errors: i % 2 ? 9 : 11, exceptions: i % 2 ? 4 : 6, ...v }));
function seedVitals(db: Db, rows: Vital[]) {
  const st = db.raw.prepare(`INSERT INTO observer_vitals (subject, kind, hour, requests, errors, rows_read, rows_written, neurons, cpu_p50_ms, cpu_p99_ms, exceptions, exceeded_cpu, exceeded_memory, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) st.run(r.subject, r.kind, r.hour, r.requests, r.errors, r.rows_read, r.rows_written, r.neurons, r.cpu_p50_ms, r.cpu_p99_ms, r.exceptions, r.exceeded_cpu, r.exceeded_memory, r.hour);
}
const findings = (db: Db) => db.raw.prepare("SELECT * FROM observer_findings ORDER BY worker, metric").all() as any[];
const proposals = (db: Db, action = "rollback_worker_version") => db.raw.prepare("SELECT * FROM consensus_proposals WHERE action = ? ORDER BY created_at, rowid").all(action) as any[];

/** A deploy of cryptophys-console from OLD to NEW, recorded now (the audit chain's own clock). */
async function deployConsole(db: Db, actor = "ci:deploy-console") {
  db.raw.prepare("UPDATE service_registry SET desired_version = ? WHERE service_id = 'cryptophys-console'").run(NEW);
  await appendAuditEvent(db, { event_type: "registry.desired_version_set", actor, subject: "cryptophys-console", outcome: "success", payload: { previous: OLD, desired_version: NEW } });
}

// ---------------------------------------------------------------------------------------------------- senses

test("OB1. senses: per-Worker requests, errors, CPU and wall quantiles in ms, and the invocation status counts", () => {
  const hour = "2026-11-14T10:00:00.000Z";
  const w = parseWorkers(FIX.workers.data.viewer.accounts[0], hour);
  assert.deepEqual(w.map((v) => v.subject), ["cryptophys-console", "cryptophys-forge", "cryptophys-policy-engine", "xauusd-omega"], "a script with no request has no vitals row");
  const c = w[0];
  assert.deepEqual([c.requests, c.errors, c.cpu_p50_ms, c.cpu_p99_ms, c.wall_p99_ms], [1000, 300, 1.2, 8.5, 250]);
  assert.deepEqual([c.exceptions, c.exceeded_cpu, c.exceeded_memory], [270, 20, 10]);
  assert.equal(w[1].exceeded_cpu, 2, "exceededResources (the older status name) counts as exceeded CPU");
  assert.equal(w[1].cpu_p99_ms, 250_000);
  assert.equal(c.sample.subrequests, 1200);
});

test("OB2. anomaly against the 7-day baseline: a real spike is found; small traffic and every minimum keep quiet", () => {
  const hour = "2026-11-14T10:00:00.000Z";
  const past = history("cryptophys-console", hour, 96);
  const a = rateAnomaly("error_rate", vital("cryptophys-console", hour, { requests: 1000, errors: 300 }), past)!;
  assert.equal(a.metric, "error_rate");
  assert.equal(a.value, 0.3);
  assert.equal(a.baseline_7d, 0.01);
  assert.ok(a.z! >= THRESHOLDS.MIN_Z, `z ${a.z}`);
  assert.deepEqual([a.sample.requests, a.sample.errors, a.sample.baseline_hours, a.sample.baseline_days], [1000, 300, 96, 4]);
  // Small traffic: 150 requests with 100 errors (67 %) is under the 200-request minimum.
  assert.equal(rateAnomaly("error_rate", vital("w", hour, { requests: 150, errors: 100 }), past), null, "small traffic never triggers");
  // 19 errors in 300 requests: under the 20-error minimum.
  assert.equal(rateAnomaly("error_rate", vital("w", hour, { requests: 300, errors: 19 }), past), null);
  // 4 % is under the 5 % floor.
  assert.equal(rateAnomaly("error_rate", vital("w", hour, { requests: 2000, errors: 80 }), past), null);
  // 10 % against a 4 % baseline is only 2.5x.
  assert.equal(rateAnomaly("error_rate", vital("w", hour, { requests: 1000, errors: 100 }), history("w", hour, 48, { errors: 40 })), null);
  // A noisy baseline (std 10 points) keeps z under 3 for a 30 % hour against 10 % mean... and ratio 3 holds.
  const noisy = Array.from({ length: 48 }, (_, i) => vital("w", new Date(Date.parse(hour) - (i + 1) * HOUR).toISOString(), { errors: i % 2 ? 0 : 200 }));
  assert.equal(rateAnomaly("error_rate", vital("w", hour, { requests: 1000, errors: 300 }), noisy), null, "z under 3");
  // Exceptions are judged the same way.
  assert.equal(rateAnomaly("exception_rate", vital("cryptophys-console", hour, { requests: 1000, exceptions: 270 }), past)?.metric, "exception_rate");
  // Without a baseline the spike is reported with z null (and never acted on).
  const fresh = rateAnomaly("error_rate", vital("new-worker", hour, { requests: 1000, errors: 300 }), [])!;
  assert.deepEqual([fresh.z, fresh.baseline_7d, fresh.sample.baseline_hours], [null, null, 0]);
});

test("OB3. CPU early warning at 80 % of the Worker's limit; D1 load spike names the query", () => {
  const hour = "2026-11-14T10:00:00.000Z";
  const forge = cpuWarning(vital("cryptophys-forge", hour, { cpu_p99_ms: 250_000, requests: 300 }), [], new Set(["cryptophys-forge"]))!;
  assert.deepEqual([forge.metric, forge.sample.limit_ms, forge.sample.limit_source], ["cpu_p99_near_limit", 300_000, "wrangler"]);
  assert.equal(cpuWarning(vital("cryptophys-forge", hour, { cpu_p99_ms: 200_000, requests: 300 }), [], new Set()), null, "67 % of 300 s is no warning");
  const console = cpuWarning(vital("cryptophys-console", hour, { cpu_p99_ms: 25_000 }), [], new Set(["cryptophys-console"]))!;
  assert.deepEqual([console.sample.limit_ms, console.sample.limit_source], [PLAN_DEFAULT_CPU_MS, "plan_default"]);
  assert.equal(cpuWarning(vital("xauusd-omega", hour, { cpu_p99_ms: 25_000 }), [], new Set())!.sample.limit_source, "plan_default_assumed");
  assert.equal(cpuWarning(vital("cryptophys-console", hour, { cpu_p99_ms: 25_000, requests: 5 }), [], new Set()), null, "too few requests");
  const d1 = (h: string, rows: number): Vital => ({ ...vital("d1:d1-uuid-1", h, { requests: 500 }), kind: "d1", rows_read: rows, rows_written: 10 });
  const past = Array.from({ length: 72 }, (_, i) => d1(new Date(Date.parse(hour) - (i + 1) * HOUR).toISOString(), 10_000 + (i % 3) * 1000));
  const spike = loadSpike(d1(hour, 900_000), past, [{ database: "d1-uuid-1", query: "SELECT agent_id FROM agent_actions WHERE created_at >= ?", rows_read: 800_000, rows_written: 0, count: 4000 }])!;
  assert.equal(spike.metric, "d1_load");
  assert.match(spike.detail, /agent_actions/);
  assert.equal((spike.sample.top_queries as any[]).length, 1);
  assert.equal(loadSpike(d1(hour, 40_000), past), null, "under the D1 minimum of 50,000 rows an hour");
  assert.equal(loadSpike(d1(hour, 900_000), past.slice(0, 3)), null, "no z without 6 baseline hours");
});

test("OB4. no data, no finding: a failing dataset is recorded as an error, an empty one as no_data, and nothing is invented", async () => {
  const db = migratedDb();
  const now = Date.parse("2026-11-14T11:27:00.000Z");
  // Every dataset refused: an unavailable run, no vitals, no findings.
  const all = fakeCf(Object.fromEntries(["workers", "d1", "d1_queries", "kv", "do", "ai"].map((k) => [k, gqlError(`unknown field on ${k}`)])));
  const r1 = await runSenses({ ...OBS_ENV, DB: db }, now, all.fetcher);
  assert.equal(r1.outcome, "unavailable");
  assert.match(String(r1.datasets!.workers), /^error: unknown field/);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM observer_vitals").get() as any).n, 0);
  assert.equal(findings(db).length, 0);
  // Empty answers: no_data, no rows; one missing dataset (the DO one) does not stop the others.
  const some = fakeCf({ workers: empty, d1: empty, d1_queries: empty, kv: empty, ai: empty, do: gqlError("not available on this account") });
  const r2 = await runSenses({ ...OBS_ENV, DB: db }, now + HOUR, some.fetcher);
  assert.equal(r2.outcome, "recorded");
  assert.deepEqual([r2.datasets!.workers, r2.datasets!.d1, r2.datasets!.kv, r2.datasets!.ai], ["no_data", "no_data", "no_data", "no_data"]);
  assert.match(String(r2.datasets!.do), /^error: not available/);
  assert.equal(r2.vitals, 0);
  assert.equal(findings(db).length, 0);
  assert.ok(!some.calls.includes("observability"), "no telemetry call without an error to explain");
  // Not configured: nothing is read or written.
  const none = fakeCf();
  assert.equal((await runSenses({ DB: db }, now, none.fetcher)).outcome, "not_configured");
  assert.deepEqual(none.calls, []);
  // The run rows: unavailable then partial; the view says so.
  const runs = db.raw.prepare("SELECT status FROM observer_runs ORDER BY ran_at").all() as any[];
  assert.deepEqual(runs.map((r) => r.status), ["unavailable", "partial"]);
});

test("OB5. one hourly run: vitals stored, findings with the deploy they follow, top errors, trading report only, no duplicate on retry", async () => {
  const db = migratedDb();
  await deployConsole(db);
  const deployedAt = Date.now();
  const now = deployedAt + 70 * 60_000;
  const hour = lastCompleteHour(now);
  seedVitals(db, [...history("cryptophys-console", hour, 96), ...history("xauusd-omega", hour, 96, { requests: 800, errors: 4, exceptions: 2 })]);
  seedVitals(db, Array.from({ length: 72 }, (_, i) => ({ ...vital("d1:d1-uuid-1", new Date(Date.parse(hour) - (i + 1) * HOUR).toISOString(), { requests: 500, errors: null, exceptions: null, cpu_p50_ms: null, cpu_p99_ms: null }), kind: "d1" as const, rows_read: 10_000 + (i % 3) * 1000, rows_written: 10 })));
  db.raw.prepare("INSERT INTO forge_organism_census (main_sha, status, organs, agents, engines, voters, findings, genome, taken_at) VALUES (?, 'consistent', 2, 0, 0, 0, '[]', ?, ?)")
    .run("c".repeat(40), JSON.stringify([{ service: "cryptophys-console", kind: "service" }, { service: "cryptophys-forge", kind: "service" }]), new Date(now).toISOString());
  const cf = fakeCf();
  const r = await runSenses({ ...OBS_ENV, DB: db }, now, cf.fetcher);
  assert.equal(r.outcome, "recorded");
  assert.deepEqual(cf.calls.filter((c) => c.startsWith("graphql")).sort(), ["graphql:ai", "graphql:d1", "graphql:d1_queries", "graphql:do", "graphql:kv", "graphql:workers"], "six GraphQL calls an hour");
  assert.ok(cf.calls.includes("observability"));
  const subjects = (db.raw.prepare("SELECT subject, kind FROM observer_vitals WHERE hour = ? ORDER BY subject").all(hour) as any[]).map((v) => `${v.kind}:${v.subject}`).sort();
  assert.deepEqual(subjects, ["ai:ai:@cf/google/gemma-4-26b-a4b-it", "d1:d1:d1-uuid-1", "do:do:do-ns-1", "kv:kv:kv-1", "worker:cryptophys-console", "worker:cryptophys-forge", "worker:cryptophys-policy-engine", "worker:xauusd-omega"]);
  const f = Object.fromEntries(findings(db).map((x) => [`${x.worker} ${x.metric}`, x]));
  const spike = f["cryptophys-console error_rate"];
  assert.ok(spike, Object.keys(f).join(", "));
  assert.deepEqual(JSON.parse(spike.since_deploy_json), { version: NEW, deployed_at: (await latestDeploy(db, "cryptophys-console"))!.deployed_at });
  assert.equal(spike.report_only, 0, "a platform Worker with a deploy unit can be rolled back");
  assert.equal(JSON.parse(spike.sample_json).top_errors[0].message, "TypeError: Cannot read properties of undefined (reading 'services')");
  assert.ok(f["cryptophys-console exception_rate"]);
  assert.equal(f["xauusd-omega error_rate"].report_only, 1, "a trading Worker is report only");
  assert.equal(f["xauusd-omega error_rate"].since_deploy_json, null, "no deploy recorded for an external Worker");
  assert.equal(f["cryptophys-forge cpu_p99_near_limit"].kind, "early_warning");
  assert.equal(JSON.parse(f["cryptophys-forge cpu_p99_near_limit"].sample_json).limit_source, "wrangler");
  assert.match(f["d1:d1-uuid-1 d1_load"].detail, /agent_actions/);
  assert.equal(f["cryptophys-policy-engine error_rate"], undefined, "150 requests: small traffic, no finding");
  const count = findings(db).length;
  await runSenses({ ...OBS_ENV, DB: db }, now + 60_000, fakeCf().fetcher);
  assert.equal(findings(db).length, count, "a retried run of the same hour adds no finding");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM observer_runs WHERE kind = 'senses'").get() as any).n, 1);
});

test("OB6. Workers Observability without the permission: one capability finding naming it, and no call again for 24 h", async () => {
  const db = migratedDb();
  const now = Date.parse("2026-11-14T11:27:00.000Z");
  const refused = fakeCf({ observability: () => new Response("{}", { status: 403 }) });
  const r = await runSenses({ ...OBS_ENV, DB: db }, now, refused.fetcher);
  assert.equal(r.datasets!.observability, "error: http 403");
  const cap = findings(db).find((x) => x.metric === "observability_permission_missing");
  assert.ok(cap);
  assert.equal(cap.kind, "capability");
  assert.equal(JSON.parse(cap.sample_json).permission, OBSERVABILITY_PERMISSION);
  assert.match(cap.detail, /Workers Observability > Read/);
  assert.equal(OBSERVABILITY_PERMISSION, "Account > Workers Observability > Read");
  const again = fakeCf({ observability: () => new Response("{}", { status: 403 }) });
  await runSenses({ ...OBS_ENV, DB: db }, now + HOUR, again.fetcher);
  assert.ok(!again.calls.includes("observability"), "the capability check skips the call for 24 h");
  const later = fakeCf();
  await runSenses({ ...OBS_ENV, DB: db }, now + 25 * HOUR, later.fetcher);
  assert.ok(later.calls.includes("observability"), "checked again after 24 h");
});

test("OB7. deploy correlation: the most recent version change, rollbacks marked, attached only within 24 h before the hour's end", async () => {
  const db = migratedDb();
  assert.equal(await latestDeploy(db, "cryptophys-console"), null);
  await deployConsole(db);
  const d = (await latestDeploy(db, "cryptophys-console"))!;
  assert.deepEqual([d.version, d.previous, d.rollback], [NEW, OLD, false]);
  const at = Date.parse(d.deployed_at);
  assert.deepEqual(sinceDeploy(d, lastCompleteHour(at + 70 * 60_000)), { version: NEW, deployed_at: d.deployed_at });
  assert.equal(sinceDeploy(d, lastCompleteHour(at - 2 * HOUR)), null, "an hour before the deploy is not after it");
  assert.equal(sinceDeploy(d, lastCompleteHour(at + 30 * HOUR)), null, "more than 24 h later");
  await appendAuditEvent(db, { event_type: "registry.desired_version_set", actor: "rollback:dep_1", subject: "cryptophys-console", outcome: "success", payload: { previous: NEW, desired_version: OLD } });
  assert.equal((await latestDeploy(db, "cryptophys-console"))!.rollback, true);
});

// ---------------------------------------------------------------------------------------------- the gate

function candidate(over: Partial<RollbackCandidate> = {}, finding: Partial<RollbackCandidate["finding"]> = {}, sample: Record<string, unknown> = {}): RollbackCandidate {
  const deployedAt = "2026-11-14T10:20:00.000Z";
  return {
    finding: {
      worker: "cryptophys-console", metric: "error_rate", bucket: "2026-11-14T10:00:00.000Z", value: 0.3, baseline_7d: 0.01, z: 40,
      since_deploy: { version: NEW, deployed_at: deployedAt }, sample: { requests: 1000, errors: 300, baseline_days: 4, baseline_hours: 96, ...sample }, ...finding,
    },
    deploy: { worker: "cryptophys-console", version: NEW, previous: OLD, deployed_at: deployedAt, actor: "ci:deploy", rollback: false },
    desired_version: NEW, recent_rollback_proposal: false, brake_open: false, now: Date.parse("2026-11-14T11:37:00.000Z"), ...over,
  };
}

test("OB8. rollback gate: proposes to the previous version only when every safeguard holds", () => {
  const ok = rollbackGate(candidate());
  assert.equal(ok.propose, true);
  assert.equal(ok.propose && ok.version, OLD);
  assert.deepEqual(ok.propose && (ok.evidence as any).deployed, { version: NEW, deployed_at: "2026-11-14T10:20:00.000Z" });
  const refuse = (c: RollbackCandidate, re: RegExp, reportOnly = false) => {
    const g = rollbackGate(c);
    assert.equal(g.propose, false, `expected a refusal matching ${re}`);
    if (!g.propose) { assert.match(g.reason, re); assert.equal(g.report_only, reportOnly, g.reason); }
  };
  // (i) baseline
  refuse(candidate({}, {}, { baseline_days: 2.9 }), /baseline of 2.9 days/);
  refuse(candidate({}, {}, { baseline_hours: 20 }), /baseline/);
  // (ii) minimums and z
  refuse(candidate({}, {}, { requests: 199 }), /minimum requests/);
  refuse(candidate({}, {}, { errors: 19 }), /minimum requests or errors/);
  refuse(candidate({}, { value: 0.049 }), /rate under the minimum/);
  refuse(candidate({}, { value: 0.06, baseline_7d: 0.03 }), /3x the baseline/);
  refuse(candidate({}, { z: null }), /z under/);
  refuse(candidate({}, { z: 2.9 }), /z under/);
  // (iii) the window, and only the Worker's most recent deploy
  refuse(candidate({}, { bucket: "2026-11-14T13:00:00.000Z" }), /outside the 2 h/);
  assert.equal(rollbackGate(candidate({}, { bucket: "2026-11-14T12:00:00.000Z" })).propose, true, "12:00-13:00 overlaps the 2 h after a 10:20 deploy");
  refuse(candidate({}, { bucket: "2026-11-14T08:00:00.000Z" }), /outside the 2 h/);
  refuse(candidate({ now: Date.parse("2026-11-14T13:21:00.000Z") }), /more than 3 h/);
  refuse(candidate({ deploy: { ...candidate().deploy!, version: "cccccccccccc", deployed_at: "2026-11-14T10:50:00.000Z" } }), /most recent deploy/);
  refuse(candidate({ desired_version: OLD }), /no longer the recorded version/);
  refuse(candidate({ deploy: { ...candidate().deploy!, rollback: true } }), /was a rollback/);
  refuse(candidate({}, { since_deploy: null }), /no deploy/);
  refuse(candidate({ deploy: null }), /no deploy/);
  refuse(candidate({ deploy: { ...candidate().deploy!, previous: null } }), /no previous version/);
  // (iv) cooldown, (v) the brake
  refuse(candidate({ recent_rollback_proposal: true }), /last 6 h/);
  refuse(candidate({ brake_open: true }), /brake holds/);
  // Only error or exception spikes
  refuse(candidate({}, { metric: "cpu_p99_near_limit" }), /only an error or exception spike/);
  assert.equal(rollbackGate(candidate({}, { metric: "exception_rate" }, { exceptions: 270 })).propose, true);
  // Report only: trading Workers, Aether, the kernel itself, anything without a platform deploy unit
  for (const w of TRADING_WORKERS) refuse(candidate({}, { worker: w }), /trading Worker: report only/, true);
  refuse(candidate({}, { worker: "cryptophys-aether" }), /observed-only/, true);
  refuse(candidate({}, { worker: "cryptophys-ai-kernel" }), /AI Kernel/, true);
  refuse(candidate({}, { worker: "xauusd-nexus-dashboard" }), /no platform deploy unit/, true);
  refuse(candidate({}, { worker: "cryptophys-home" }), /no platform deploy unit/, true);
  assert.deepEqual(["cryptophys-console", "cryptophys-forge", "cryptophys-policy-engine", "cryptophys-ai-kernel", "xauusd-omega"].map(rollbackCapable), [true, true, true, false, false]);
});

// ---------------------------------------------------------------------------------- the Supervisor (production)

function kernelEnv(db: Db, policy?: (input: Record<string, unknown>) => Promise<unknown>) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const rollbacks: unknown[][] = [];
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: policy ?? (async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); }) },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    DEPLOY: { pendingDeploys: async () => ({ main_sha: null, units: [], skipped: [] }), rollbackForConsensus: async (...a: unknown[]) => { rollbacks.push(a); return { dispatched: true, executor: "test" }; } },
  };
  const mem = new Map<string, unknown>();
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, structuredClone(v)); } };
  return { env, memory, rollbacks };
}

/** A real spike of cryptophys-console in the hour after its deploy, sensed from the fixtures; returns the cycle's clock. */
async function spikeAfterDeploy(db: Db, baselineHours = 96): Promise<number> {
  await deployConsole(db);
  const deployedAt = Date.now();
  const now = deployedAt + 70 * 60_000;
  seedVitals(db, history("cryptophys-console", lastCompleteHour(now), baselineHours));
  const r = await runSenses({ ...OBS_ENV, DB: db }, now, fakeCf().fetcher);
  assert.ok(r.findings!.some((f) => f.worker === "cryptophys-console" && f.metric === "error_rate"));
  return now + 10 * 60_000;
}
const observerFindings = (cycle: { findings: any[] }) => cycle.findings.filter((f) => f.kind === "observer");

test("OB9. Supervisor: a spike right after a platform Worker's deploy becomes one rollback proposal through consensus, with its evidence", async () => {
  const db = migratedDb();
  const { env, memory } = kernelEnv(db);
  const at = await spikeAfterDeploy(db);
  const cycle = await runCycle(env as never, memory, "scheduled", at);
  const ps = proposals(db);
  assert.equal(ps.length, 1, JSON.stringify(observerFindings(cycle)));
  assert.equal(ps[0].target, "cryptophys-console");
  assert.equal(ps[0].proposer_agent_id, "supervisor");
  const params = JSON.parse(ps[0].params_json);
  assert.equal(params.version, OLD, "back to the previous recorded version (what the Orchestrator's executor requires)");
  assert.equal(params.evidence.metric, "error_rate");
  assert.deepEqual(params.evidence.deployed.version, NEW);
  assert.ok(params.evidence.z >= 3 && params.evidence.requests === 1000 && params.evidence.errors === 300);
  assert.equal(ps[0].status, "shadow_passed", "voted, tallied and policy-checked like every proposal (shadow records only)");
  const votes = db.raw.prepare("SELECT voter_agent_id, vote FROM consensus_votes WHERE proposal_id = ?").all(ps[0].proposal_id) as any[];
  assert.ok(votes.length >= 8 && votes.filter((v) => v.vote === "approve").length * 2 > votes.length, "a council majority");
  assert.ok(observerFindings(cycle).some((f) => f.action === "consensus.propose"));
  // The next cycle: the 6 h cooldown (and the Policy Engine voter's own 6 h rule) holds; nothing new.
  await runCycle(env as never, memory, "scheduled", at + 15 * 60_000);
  assert.equal(proposals(db).length, 1, "at most one rollback proposal per target per 6 h");
});

test("OB10. deploy mode: the passed proposal runs the Orchestrator's rollback; a Policy Engine veto stops it", async () => {
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  const { env, memory, rollbacks } = kernelEnv(db);
  const at = await spikeAfterDeploy(db);
  await runCycle(env as never, memory, "scheduled", at);
  assert.equal(rollbacks.length, 1);
  assert.equal(rollbacks[0][2], "cryptophys-console");
  assert.equal((rollbacks[0][3] as any).version, OLD);
  // A veto: the same evidence, but the Policy Engine denies; nothing executes.
  const db2 = migratedDb();
  db2.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  const vetoed = kernelEnv(db2, async () => ({ decision: "deny", decision_id: "pol_test", reason: "failed: target_rate_limit" }));
  // The syscall itself is policy-gated too: allow the consensus.propose syscall, deny consensus.execute.
  const policyEnv = baseEnv("cryptophys-policy-engine", db2);
  (vetoed.env.POLICY as any).evaluate = async (input: Record<string, unknown>) => {
    if (input.action === "consensus.execute") return { decision: "deny", decision_id: "pol_test", reason: "failed: target_rate_limit" };
    const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p);
  };
  const at2 = await spikeAfterDeploy(db2);
  await runCycle(vetoed.env as never, vetoed.memory, "scheduled", at2);
  const ps = proposals(db2);
  assert.equal(ps.length, 1);
  assert.equal(ps[0].status, "shadow_blocked", "the Policy Engine still decides");
  assert.equal(vetoed.rollbacks.length, 0);
});

test("OB11. Supervisor safeguards: baseline under 3 days, the brake, the rate window and an operator wake propose nothing", async () => {
  // (i) 48 h of baseline: the finding is reported, no proposal.
  const db = migratedDb();
  const k = kernelEnv(db);
  const at = await spikeAfterDeploy(db, 48);
  const c = await runCycle(k.env as never, k.memory, "scheduled", at);
  assert.equal(proposals(db).length, 0);
  assert.ok(observerFindings(c).some((f) => /no rollback: baseline of/.test(f.why)), JSON.stringify(observerFindings(c)));
  // (v) the brake: an open critical report.
  const db2 = migratedDb();
  const k2 = kernelEnv(db2);
  const at2 = await spikeAfterDeploy(db2);
  db2.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at) VALUES ('rpt_brake', 'deployment-orchestrator', 'platform_digest', 'critical', 'x', '{}', 'not_used', NULL, ?)").run(new Date().toISOString());
  const c2 = await runCycle(k2.env as never, k2.memory, "scheduled", at2);
  assert.equal(proposals(db2).length, 0);
  assert.ok(observerFindings(c2).some((f) => /brake holds/.test(f.why)));
  // Once acknowledged, the next scheduled cycle proposes it (still inside the window).
  db2.raw.prepare("INSERT INTO agent_report_acknowledgements (report_id, acknowledged_by, reason, acknowledged_at) VALUES ('rpt_brake', 'owner@example.com', 'handled already', ?)").run(new Date().toISOString());
  await runCycle(k2.env as never, k2.memory, "scheduled", at2 + 15 * 60_000);
  assert.equal(proposals(db2).length, 1, "proposed once the brake is off");
  // The rate window: consensus.propose used 4 times in the last hour.
  const db3 = migratedDb();
  const k3 = kernelEnv(db3);
  const at3 = await spikeAfterDeploy(db3);
  for (let i = 0; i < 4; i++) db3.raw.prepare("INSERT INTO agent_syscall_consumptions (decision_id, agent_id, capability, consumed_at) VALUES (?, 'supervisor', 'consensus.propose', ?)").run(`pol_${i}`, new Date(Date.now() - (i + 1) * 60_000).toISOString());
  const c3 = await runCycle(k3.env as never, k3.memory, "scheduled", at3);
  assert.equal(proposals(db3).length, 0);
  assert.ok(c3.findings.some((f: any) => f.kind === "rate_window"));
  // An operator wake reports, never proposes.
  const db4 = migratedDb();
  const k4 = kernelEnv(db4);
  const at4 = await spikeAfterDeploy(db4);
  const c4 = await runCycle(k4.env as never, k4.memory, "operator", at4);
  assert.equal(proposals(db4).length, 0);
  assert.ok(observerFindings(c4).some((f) => /scheduled cycles only/.test(f.why)));
});

test("OB12. trading Workers and Aether are reported only: never a rollback proposal, whatever the spike", async () => {
  const db = migratedDb();
  const k = kernelEnv(db);
  const now = Date.now();
  const hour = lastCompleteHour(now);
  const spike = (worker: string): Finding => ({
    worker, metric: "error_rate", kind: "anomaly", severity: "warning", bucket: hour, value: 0.5, baseline_7d: 0.01, z: 50,
    since_deploy: { version: NEW, deployed_at: new Date(now - 30 * 60_000).toISOString() }, sample: { requests: 5000, errors: 2500, baseline_days: 7, baseline_hours: 168 },
    detail: `${worker} spike`, report_only: true,
  });
  await storeFindings(db, [...TRADING_WORKERS, "cryptophys-aether"].map(spike), new Date(now).toISOString());
  const c = await runCycle(k.env as never, k.memory, "scheduled", now + 60_000);
  assert.equal(proposals(db).length, 0);
  const why = observerFindings(c).map((f) => `${f.service_id}: ${f.why}`);
  for (const w of TRADING_WORKERS) assert.ok(why.some((x) => x.startsWith(`${w}:`) && /trading Worker: report only/.test(x)), w);
  assert.ok(why.some((x) => x.startsWith("cryptophys-aether:") && /report only/.test(x)));
  assert.ok(observerFindings(c).every((f) => f.action === "none"));
});

test("OB13. a commit the Observer rolled back is not deployed again by the deploy loop", async () => {
  const db = migratedDb();
  const k = kernelEnv(db);
  const main = NEW + "0".repeat(28);
  (k.env.DEPLOY as any).pendingDeploys = async () => ({ main_sha: main, units: [{ unit: "console", workflow: "deploy-console.yml", target: "cryptophys-console", reason: "changed" }], skipped: [] });
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES ('cns_rb', 'supervisor', 'rollback_worker_version', 'cryptophys-console', 'routine', ?, '{}', 'deploy', 8, 7, 1, 1, NULL, 'allow', 'executed', '{}', ?, ?)`)
    .run(JSON.stringify({ version: OLD, evidence: { deployed: { version: NEW, deployed_at: new Date().toISOString() } } }), new Date().toISOString(), new Date().toISOString());
  const c = await runCycle(k.env as never, k.memory, "scheduled");
  assert.equal(proposals(db, "deploy_commit").length, 0);
  assert.ok(c.findings.some((f: any) => f.kind === "deploy" && /rolled back on cryptophys-console by the Observer/.test(f.why)));
});

// ---------------------------------------------------------------------------------------------- inventory

const known = (over: Partial<KnownOrganism> = {}): KnownOrganism => ({
  declared: new Set(["cryptophys-console", "cryptophys-forge", "cryptophys-forge-typecheck", "xauusd-omega", "xauusd-ai-trading-assistant"]),
  stubs: new Set(["cryptophys-forge-typecheck"]), unknown_origins: new Set(), disabled: new Set(["cryptophys-home"]), census_at: "2026-11-14T10:04:00.000Z", ...over,
});
const scripts = (...names: string[]) => ({ status: "ok" as const, items: names.map((n) => ({ id: n, name: n })) });
const kinds = (fs: Finding[]) => fs.map((f) => `${f.metric} ${f.worker}`).sort();

test("OB14. inventory: undeclared Worker with traffic, preview copies and retiring Workers ignored, Aether report only", () => {
  const fs = compareInventory({
    known: known(),
    lists: { scripts: scripts("cryptophys-console", "cryptophys-forge", "cryptophys-forge-typecheck", "xauusd-omega", "xauusd-ai-trading-assistant", "rogue-worker", "cryptophys-console-preview", "cryptophys-forge-pr-12", "cryptophys-home", "cryptophys-aether") },
    traffic7d: new Map([["cryptophys-console", 9000], ["cryptophys-forge", 100], ["xauusd-omega", 10], ["xauusd-ai-trading-assistant", 10], ["rogue-worker", 42], ["cryptophys-console-preview", 30], ["cryptophys-forge-pr-12", 3], ["cryptophys-home", 1], ["cryptophys-aether", 500]]),
    senses_cover_7d: true, day: "2026-11-14",
  });
  assert.deepEqual(kinds(fs), ["undeclared_worker cryptophys-aether", "undeclared_worker rogue-worker"]);
  const aether = fs.find((f) => f.worker === "cryptophys-aether")!;
  assert.deepEqual([aether.severity, aether.report_only], ["info", true]);
  assert.match(aether.detail, /report only/);
  assert.equal(fs.find((f) => f.worker === "rogue-worker")!.severity, "warning");
  assert.equal(previewOf("cryptophys-console-staging", known().declared), "cryptophys-console");
  assert.equal(previewOf("rogue-worker-preview", known().declared), null, "a preview of an undeclared Worker is not excused");
});

test("OB15. inventory: orphaned declaration, idle Worker (only with 7 days of senses, never a build stub), and a token without the list permission", () => {
  const base = { known: known(), traffic7d: new Map([["cryptophys-console", 9000], ["xauusd-omega", 10], ["xauusd-ai-trading-assistant", 5]]), day: "2026-11-14" };
  const fs = compareInventory({ ...base, lists: { scripts: scripts("cryptophys-console", "cryptophys-forge", "cryptophys-forge-typecheck", "xauusd-omega", "xauusd-ai-trading-assistant", "dead-worker") }, senses_cover_7d: true });
  assert.deepEqual(kinds(fs), ["idle_worker cryptophys-forge", "idle_worker dead-worker"]);
  const gone = compareInventory({ ...base, lists: { scripts: scripts("cryptophys-console", "cryptophys-forge-typecheck", "xauusd-omega", "xauusd-ai-trading-assistant") }, senses_cover_7d: false });
  assert.deepEqual(kinds(gone), ["orphaned_declaration cryptophys-forge"], "no idle finding before the Observer has 7 days of senses");
  // External DNA unread: its organs are neither orphaned nor undeclared.
  const unread = compareInventory({ ...base, known: known({ declared: new Set(["cryptophys-console"]), unknown_origins: new Set(EXTERNAL.xauusd) }), lists: { scripts: scripts("cryptophys-console", "xauusd-omega") }, traffic7d: new Map([["cryptophys-console", 1], ["xauusd-omega", 10]]), senses_cover_7d: true });
  assert.deepEqual(kinds(unread), []);
  // No scripts list: nothing is orphaned (absence from analytics is no proof), and the missing permission is named.
  const refused = compareInventory({ ...base, lists: { scripts: { status: "permission_missing", http: 403 } }, senses_cover_7d: false });
  assert.deepEqual(kinds(refused), ["inventory_permission_missing:scripts account"]);
  assert.equal(refused[0].kind, "capability");
  assert.equal(refused[0].sample.permission, "Account > Workers Scripts > Read");
});

test("OB16. inventory: storage resources against what this repository's wrangler.toml files bind (informational until storage DNA exists)", () => {
  const fs = compareInventory({
    known: known(), traffic7d: new Map([["cryptophys-console", 1], ["cryptophys-forge", 1], ["xauusd-omega", 1], ["xauusd-ai-trading-assistant", 1]]), senses_cover_7d: false, day: "2026-11-14",
    lists: {
      d1: { status: "ok", items: [{ id: "u1", name: "cryptophys-control-plane" }, { id: "u2", name: "xauusd-trades" }] },
      r2: { status: "ok", items: [{ id: "cryptophys-forge-bundles", name: "cryptophys-forge-bundles" }] },
      kv: { status: "ok", items: [{ id: "k1", name: "XAUUSD_CACHE" }] },
      queues: { status: "unavailable", reason: "http_500" },
      durable_objects: { status: "ok", items: [{ id: "n1", name: "SupervisorAgent", script: "cryptophys-ai-kernel" }, { id: "n2", name: "Room", script: "xauusd-omega" }, { id: "n3", name: "Stray", script: "mystery" }] },
    },
  });
  assert.deepEqual(kinds(fs), ["orphaned_declaration r2:cryptophys-d1-backups", "undeclared_resource d1:xauusd-trades", "undeclared_resource do:SupervisorAgent", "undeclared_resource do:Stray", "undeclared_resource kv:XAUUSD_CACHE"].sort());
  for (const f of fs.filter((x) => x.metric === "undeclared_resource")) assert.equal(f.severity, "info");
});

test("OB17. runInventory: reads the DNA union from the census, writes on change only, and skips a refused list for 24 h", async () => {
  const db = migratedDb();
  const now = Date.parse("2026-11-14T11:57:00.000Z");
  const cf0 = fakeCf();
  assert.equal((await runInventory({ ...OBS_ENV, DB: db }, now, cf0.fetcher, EXTERNAL)).outcome, "no_census", "without a census nothing is compared");
  assert.deepEqual(cf0.calls, []);
  db.raw.prepare("INSERT INTO forge_organism_census (main_sha, status, organs, agents, engines, voters, findings, genome, taken_at) VALUES (?, 'changes', 2, 0, 0, 0, ?, ?, ?)").run(
    "d".repeat(40), JSON.stringify([{ kind: "external_dna_unavailable", subject: "xauusd", detail: "timeout" }]),
    JSON.stringify([{ service: "cryptophys-console", kind: "service" }, { service: "cryptophys-forge-typecheck", kind: "build-stub" }]), new Date(now - HOUR).toISOString());
  seedVitals(db, [vital("rogue-worker", new Date(now - 5 * HOUR).toISOString(), { requests: 12 }), vital("xauusd-omega", new Date(now - 5 * HOUR).toISOString())]);
  const cf = fakeCf({
    "list:scripts": { success: true, result: [{ id: "cryptophys-console" }, { id: "cryptophys-forge-typecheck" }, { id: "rogue-worker" }, { id: "xauusd-omega" }] },
    "list:d1": () => new Response("{}", { status: 403 }),
    "list:r2": { success: true, result: { buckets: [{ name: "cryptophys-d1-backups" }, { name: "cryptophys-forge-bundles" }] } },
  });
  const r = await runInventory({ ...OBS_ENV, DB: db }, now, cf.fetcher, EXTERNAL);
  assert.equal(r.outcome, "recorded");
  assert.deepEqual(cf.calls.sort(), ["list:d1", "list:durable_objects", "list:kv", "list:queues", "list:r2", "list:scripts"]);
  const f = (db.raw.prepare("SELECT worker, metric FROM observer_findings ORDER BY worker, metric").all() as any[]).map((x) => `${x.metric} ${x.worker}`);
  assert.deepEqual(f, ["inventory_permission_missing:d1 account", "undeclared_worker rogue-worker"], "xauusd-omega: its origin's DNA was not read, so it is not undeclared");
  // Unchanged 30 minutes later: no new run row; the refused D1 list is not asked again.
  const cf2 = fakeCf({ "list:scripts": { success: true, result: [{ id: "cryptophys-console" }, { id: "cryptophys-forge-typecheck" }, { id: "rogue-worker" }, { id: "xauusd-omega" }] },
    "list:r2": { success: true, result: { buckets: [{ name: "cryptophys-d1-backups" }, { name: "cryptophys-forge-bundles" }] } } });
  assert.equal((await runInventory({ ...OBS_ENV, DB: db }, now + 30 * 60_000, cf2.fetcher, EXTERNAL)).outcome, "unchanged");
  assert.ok(!cf2.calls.includes("list:d1"));
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM observer_runs WHERE kind = 'inventory'").get() as any).n, 1);
});

// ---------------------------------------------------------------------------------- retention and config

test("OB18. retention in code: vitals 30 days, findings 90 days", async () => {
  const db = migratedDb();
  const now = Date.parse("2026-11-14T03:27:00.000Z");
  const iso = (days: number) => new Date(now - days * 86_400_000).toISOString();
  seedVitals(db, [vital("a", iso(31)), vital("a", iso(29))]);
  await storeFindings(db, [{ worker: "a", metric: "m", kind: "anomaly", severity: "warning", bucket: iso(91), value: 1, baseline_7d: null, z: null, since_deploy: null, sample: {}, detail: "old", report_only: true }], iso(91));
  await storeFindings(db, [{ worker: "a", metric: "m", kind: "anomaly", severity: "warning", bucket: iso(60), value: 1, baseline_7d: null, z: null, since_deploy: null, sample: {}, detail: "kept", report_only: true }], iso(60));
  await sweepObserver(db, now);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM observer_vitals").get() as any).n, 1);
  assert.deepEqual(findings(db).map((x) => x.detail), ["kept"]);
});

test("OB19. config: the Observer runs in the Platform API at :27/:57, off every other cron; CPU limits and declared resources equal the wrangler files", () => {
  const toml = read("workers/platform-api/wrangler.toml");
  assert.match(toml, new RegExp(`crons = \\["${OBSERVER_CRON.replace(/\*/g, "\\*")}"\\]`));
  const minutes = (s: string) => s.split(",").map(Number);
  const used = new Set([
    ...minutes(/crons = \["([\d,]+) /.exec(read("workers/ai-kernel/wrangler.toml"))![1]),
    ...minutes(/crons = \["([\d,]+) /.exec(read("workers/deployment-orchestrator/wrangler.toml"))![1]),
    ...minutes(/crons = \["([\d,]+) /.exec(read("workers/forge/wrangler.toml"))![1]),
    0, 15, 30, 45, 13,
  ]);
  for (const m of minutes(OBSERVER_CRON.split(" ")[0])) assert.ok(!used.has(m), `minute ${m} is used by another cron`);
  const dirs = readdirSync(new URL("workers/", ROOT), { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(new URL(`workers/${d.name}/wrangler.toml`, ROOT))).map((d) => d.name);
  const limits: Record<string, number> = {}; const d1 = new Set<string>(); const r2 = new Set<string>(); const kv = new Set<string>(); const queues = new Set<string>();
  for (const dir of dirs) {
    const t = read(`workers/${dir}/wrangler.toml`);
    const name = /^name = "([a-z0-9-]+)"/m.exec(t)![1];
    const cpu = /\[limits\][^[]*?cpu_ms = (\d+)/.exec(t);
    if (cpu) limits[name] = Number(cpu[1]);
    for (const m of t.matchAll(/^database_name = "([a-z0-9-]+)"/gm)) d1.add(m[1]);
    for (const m of t.matchAll(/^bucket_name = "([a-z0-9-]+)"/gm)) r2.add(m[1]);
    if (/\[\[kv_namespaces\]\]/.test(t)) kv.add(dir);
    if (/\[\[queues\./.test(t)) queues.add(dir);
  }
  assert.deepEqual(limits, CPU_LIMIT_MS, "CPU_LIMIT_MS equals the wrangler [limits]");
  assert.deepEqual([...d1].sort(), [...DECLARED_RESOURCES.d1]);
  // The D1 backups bucket is written by the Recovery Manager (its R2 binding); every bucket a wrangler file binds is declared.
  for (const b of r2) assert.ok(DECLARED_RESOURCES.r2.includes(b), b);
  assert.deepEqual([kv.size, queues.size], [DECLARED_RESOURCES.kv.length, DECLARED_RESOURCES.queues.length]);
  // The Platform API's DNA needs no change: crons are not DNA, and it already holds the token and AGENTS.
  assert.match(toml, /binding = "AGENTS"\nservice = "cryptophys-ai-kernel"\nentrypoint = "AgentRpc"/);
});

test("OB20. GET /v1/observer is operator-only and read-only; the cron runs senses at :27 and the inventory at both minutes", async () => {
  const db = migratedDb();
  const { default: api, runObserver } = await import("../../platform-api/src/index.ts");
  const env: any = { ...baseEnv("cryptophys-platform-api", db), PLATFORM_NAME: "cryptophys-cloud-platform", PLATFORM_ENVIRONMENT: "production", DB: db };
  assert.equal((await call(api, env, req("GET", "/v1/observer", undefined, OUTSIDER_JWT))).status, 403);
  const empty = await call(api, env, req("GET", "/v1/observer"));
  assert.equal(empty.status, 200);
  assert.deepEqual([empty.body.schema, empty.body.configured, empty.body.available, empty.body.organs, empty.body.anomalies, empty.body.last_senses, empty.body.estimates],
    ["observer.v1", false, true, [], [], null, null], "nothing measured: empty lists and nulls, never a number");
  assert.equal((await call(api, env, req("POST", "/v1/observer"))).status, 405);
  // Unconfigured cron: nothing is called.
  const idle = fakeCf();
  const r0 = await runObserver(env, Date.parse("2026-11-14T11:27:00.000Z"), idle.fetcher);
  assert.deepEqual([(r0.senses as any).outcome, (r0.inventory as any).outcome], ["not_configured", "not_configured"]);
  assert.deepEqual(idle.calls, []);
  // Configured: :27 senses and publishes one advisory warning report as agent platform-api; :57 only the inventory.
  const published: any[] = [];
  const live: any = { ...env, ...OBS_ENV, AGENTS: { syscall: async (agent: string, cap: string, input: any) => { published.push({ agent, cap, input }); return { outcome: "succeeded" }; } } };
  const cf = fakeCf();
  const r1 = await runObserver(live, Date.parse("2026-11-14T11:27:00.000Z"), cf.fetcher);
  assert.equal((r1.senses as any).outcome, "recorded");
  assert.equal(published.length, 1);
  assert.deepEqual([published[0].agent, published[0].cap, published[0].input.kind, published[0].input.severity], ["platform-api", "reports.publish", "platform_digest", "warning"], "advisory: a warning, never critical (never the brake)");
  const cf57 = fakeCf();
  const r2 = await runObserver(live, Date.parse("2026-11-14T11:57:00.000Z"), cf57.fetcher);
  assert.equal(r2.senses, undefined);
  assert.ok(!cf57.calls.some((c) => c.startsWith("graphql")), "no GraphQL call at :57");
  const view = await call(api, live, req("GET", "/v1/observer"));
  assert.equal(view.body.configured, true);
  const consoleOrgan = view.body.organs.find((o: any) => o.worker === "cryptophys-console");
  assert.equal(consoleOrgan.measured.error_rate, 0.3);
  assert.equal(consoleOrgan.measured.cpu_p99_ms, 8.5);
  assert.equal(view.body.estimates.rows_per_request.measured, false, "rows per request is labelled estimated");
  assert.ok(view.body.anomalies.some((a: any) => a.worker === "cryptophys-console" && a.metric === "error_rate"));
  assert.equal(view.body.last_senses.status, "ok");
});

test("OB21. readSenses: one hour, one call per dataset, the hour's bounds in the variables", async () => {
  const seen: any[] = [];
  const fetcher = async (url: string, init?: RequestInit) => { seen.push(JSON.parse(String(init!.body)).variables); return Response.json(empty); };
  const s = await readSenses("t", ACCOUNT, "2026-11-14T10:00:00.000Z", fetcher);
  assert.equal(seen.length, 6);
  assert.deepEqual(seen[0], { a: ACCOUNT, s: "2026-11-14T10:00:00Z", e: "2026-11-14T10:59:59Z" });
  assert.deepEqual(s.vitals, []);
});
