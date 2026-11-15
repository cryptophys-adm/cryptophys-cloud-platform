// The deploy stall alarm (owner 2026-11-14). The incident of that day: from about 15:00 UTC main kept moving and its
// Forge checks were green, but no deploy ran for over 6 hours; the Forge's plan listed no unit (forge_units "[]",
// forge_skipped control-plane compare_failed_or_diverged and * new_migration_control_plane_unavailable), and nothing told
// the owner. The alarm (control-plane-shared/src/deploy-stall.ts) runs in the Platform API's Observer, publishes a
// WARNING report as agent platform-api through the real kernel syscall (never critical: that is the consensus brake),
// and reaches the owner's Telegram through the owner notice production_unhandled.
//
// Clock-independent: every time is relative to NOW (the test's start) and passed as `now`; the kernel stamps reports
// with its own clock, which only moves forward from NOW. One migratedDb() per test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CI_CLIENT_ID, OPERATOR_EMAIL, APPROVER_EMAIL, baseEnv, migratedDb } from "./harness.ts";
import { DEPLOY_UNITS, recordPlanSide, registryFingerprint, type Skip } from "../src/deploy-units.ts";
import { STALL_AFTER_MS, deployStall, openStallAlarms, stallReport, stallState } from "../src/deploy-stall.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { rpcSyscall } from "../../ai-kernel/src/agent-rpc.ts";
import { observe } from "../../ai-kernel/src/syscall.ts";
import { unhandledProblems } from "../../ai-kernel/src/owner-inbox.ts";
import { reconcileNotices } from "../../ai-kernel/src/owner-notices.ts";
import { deployStallAlarm, runObserver } from "../../platform-api/src/index.ts";

type Db = ReturnType<typeof migratedDb>;
const NOW = Math.floor(Date.now() / 60_000) * 60_000;
const MIN = 60_000, H = 3_600_000;
const at = (ms: number) => new Date(NOW + ms).toISOString();
const OLD = "a".repeat(40), H1 = "b".repeat(40), H2 = "c".repeat(40), H3 = "d".repeat(40);
const INCIDENT_SKIPS: Skip[] = [{ unit: "control-plane", reason: "compare_failed_or_diverged" }, { unit: "*", reason: "new_migration_control_plane_unavailable" }];
const SERVICES = DEPLOY_UNITS.flatMap((u) => [...u.services]);
let seq = 0;

/** Every deploy unit's Workers run `sha` (registry desired_version is its 12-character tag). */
const run = (db: Db, sha: string, unit?: string) => {
  const ids = unit ? [...DEPLOY_UNITS.find((u) => u.unit === unit)!.services] : SERVICES;
  for (const id of ids) db.raw.prepare("UPDATE service_registry SET desired_version = ? WHERE service_id = ?").run(sha.slice(0, 12), id);
};
/** The Forge's check of a main commit: every gate passed (or still running). */
function checked(db: Db, sha: string, status: "passed" | "running" = "passed") {
  const steps = JSON.stringify({ typecheck: { status: "passed", errors: 0, console_build: { status: "passed" } } });
  db.raw.prepare(`INSERT OR REPLACE INTO forge_check_runs (commit_sha, status, runner, files, pass, fail, skip, failures, started_at, finished_at, duration_ms, steps, guard_status, source)
    VALUES (?, ?, 'forge-runner/1', 1, 1, 0, 0, '[]', ?, ?, 1, ?, 'clean', 'main')`).run(sha, status, at(-H), at(-H), steps);
}
/** The Forge's plan for main's head under the current registry fingerprint, recorded `ms` from NOW. */
async function plan(db: Db, sha: string, ms: number, units: string[] = [], skipped: Skip[] = []) {
  await recordPlanSide(db as never, "forge", sha, await registryFingerprint(db as never),
    { units: units.map((u) => ({ unit: u, workflow: `${u}.yml`, target: u, reason: "x" })), skipped }, NOW + ms);
}
/** A deploy_commit that executed `ms` from NOW. */
function deployed(db: Db, sha: string, unit: string, ms: number): string {
  const id = `cns_stall_${seq++}`;
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, status, outcome_json, created_at, decided_at)
    VALUES (?, 'supervisor', 'deploy_commit', ?, 'routine', ?, '{}', 'deploy', 9, 9, 0, 1, 'executed', '{"executed":true}', ?, ?)`)
    .run(id, DEPLOY_UNITS.find((u) => u.unit === unit)!.services[0], JSON.stringify({ commit_sha: sha, unit }), at(ms - MIN), at(ms));
  return id;
}
/** The incident: OLD deployed 7 h ago; main moved to H1 (green) 6 h ago and the Forge planned no unit. */
async function incident(db: Db) {
  run(db, OLD);
  const id = deployed(db, OLD, "control-plane", -7 * H);
  checked(db, H1);
  await plan(db, H1, -6 * H, [], INCIDENT_SKIPS);
  return id;
}

/** The Platform API's env, whose AGENTS binding is the kernel's AgentRpc pinned to cryptophys-platform-api. */
function platformEnv(db: Db) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const kernel = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
  };
  const calls: { agent: string; capability: string; input: any }[] = [];
  const env: any = {
    ...baseEnv("cryptophys-platform-api", db), PLATFORM_NAME: "cryptophys-cloud-platform", PLATFORM_ENVIRONMENT: "production", DB: db,
    AGENTS: { syscall: async (agent: string, capability: string, input: any) => { calls.push({ agent, capability, input }); return rpcSyscall(kernel as never, { host_worker: "cryptophys-platform-api" }, agent, capability, input); } },
  };
  return { env, calls, kernel };
}
const reports = (db: Db) => db.raw.prepare("SELECT report_id, agent_id, kind, severity, subject, body_json FROM agent_reports WHERE json_extract(body_json, '$.source') = 'deploy_stall' ORDER BY created_at, rowid").all()
  .map((r: any) => ({ ...r, body: JSON.parse(r.body_json) }));
const stallProblems = async (db: Db, ms: number) => (await unhandledProblems(db as never, NOW + ms)).filter((p) => p.code === "deploys_stalled");
/** Every registered service observed in sync, its heartbeat a minute before `ms`: no other production problem. */
function fresh(db: Db, ms: number) {
  const ids = (db.raw.prepare("SELECT service_id FROM service_registry WHERE status != 'disabled'").all() as { service_id: string }[]).map((s) => s.service_id);
  for (const id of ids) {
    if (!db.raw.prepare("SELECT 1 FROM drift_observations WHERE service_id = ?").get(id)) {
      db.raw.prepare("INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at) VALUES (?, ?, 'h', 'h', 0, '{\"reasons\":[]}', ?)")
        .run(`obs_stall_${seq++}`, id, at(-20 * MIN));
    }
    db.raw.prepare("UPDATE service_registry SET updated_at = ? WHERE service_id = ?").run(at(ms - MIN), id);
  }
}
function telegram(db: Db) {
  const sent: any[] = [];
  const env = { DB: db, OWNER_NOTICE_CHANNELS: "telegram", OWNER_TELEGRAM: { notify: async (n: any) => { sent.push(n); return { sent: true }; } } };
  const reconcile = async (ms: number) => { fresh(db, ms); return (await reconcileNotices(env as never, NOW + ms)).find((r) => r.topic === "production_unhandled")!; };
  return { sent, reconcile };
}

test("DS1. no alarm while deploys are current: every unit runs main's head, or the head changed nothing a unit deploys", async () => {
  const db = migratedDb();
  const { env, calls } = platformEnv(db);
  // A head the Forge has not planned yet, and a head whose checks still run: never an alarm, whatever the deploy age.
  assert.equal((await deployStall(db as never, NOW)).reason, "main_unknown");
  run(db, OLD);
  deployed(db, OLD, "console", -9 * H);
  checked(db, OLD);
  await plan(db, OLD, -9 * H);
  const current = await deployStall(db as never, NOW);
  assert.deepEqual([current.stalled, current.reason, current.units_behind], [false, "units_current", []]);
  // A README commit 5 h ago: every unit is behind by version, but the plan lists no unit and no skip, so nothing is due.
  checked(db, H1);
  await plan(db, H1, -5 * H);
  const readme = await deployStall(db as never, NOW);
  assert.deepEqual([readme.stalled, readme.reason, readme.units_behind.length], [false, "nothing_due", DEPLOY_UNITS.length]);
  // A disabled unit's skip is a decision, not a fault.
  checked(db, H2);
  await plan(db, H2, -4 * H, [], [{ unit: "forge", reason: "not_registered_or_disabled" }]);
  assert.equal((await deployStall(db as never, NOW)).reason, "nothing_due");
  // A red head (checks running) is not a stall either.
  checked(db, H3, "running");
  await plan(db, H3, -3 * H, [], INCIDENT_SKIPS);
  assert.equal((await deployStall(db as never, NOW)).reason, "main_not_green");
  assert.deepEqual(await deployStallAlarm(env, NOW).then((r) => [r.outcome, r.raised]), ["main_not_green", undefined]);
  assert.deepEqual([calls.length, reports(db).length, (await stallProblems(db, 0)).length], [0, 0, 0]);
});

test("DS2. no alarm before 2 h: the clock starts at the first plan with work after the last deploy, not at the deploy", async () => {
  const db = migratedDb();
  const { env, calls } = platformEnv(db);
  run(db, OLD);
  deployed(db, OLD, "control-plane", -9 * H); // a quiet night: the last deploy is 9 h old
  checked(db, H1);
  await plan(db, H1, -110 * MIN, ["console"]); // the morning's first commit, planned 110 minutes ago, not deployed yet
  const v = await deployStall(db as never, NOW);
  assert.deepEqual([v.stalled, v.reason, v.stalled_for_min, v.last_deploy_age_min, v.stall_since], [false, "waiting", 110, 540, at(-110 * MIN)]);
  assert.equal((await deployStallAlarm(env, NOW)).raised, undefined);
  assert.deepEqual([calls.length, (await stallProblems(db, 0)).length], [0, 0]);
  // Exactly at the threshold it still waits; one Observer run later (:57) it is a stall.
  assert.equal((await deployStall(db as never, NOW + STALL_AFTER_MS - 110 * MIN)).reason, "waiting");
  const later = await deployStall(db as never, NOW + 30 * MIN);
  assert.deepEqual([later.stalled, later.stalled_for_min, later.pending.units], [true, 140, ["console"]]);
  // A deploy_commit that executed 1 h ago resets the clock even with work pending.
  deployed(db, OLD, "platform-api", -H);
  assert.equal((await deployStall(db as never, NOW + 30 * MIN)).reason, "waiting");
});

test("DS3. after 2 h: one warning report in metric form with the plan's skip reasons, a Telegram message, and the brake untouched", async () => {
  const db = migratedDb();
  const { env, calls, kernel } = platformEnv(db);
  const lastId = await incident(db);
  const r = await deployStallAlarm(env, NOW);
  assert.deepEqual([r.outcome, r.raised, r.alert_key], ["stalled", "succeeded", `deploy_stall:${lastId}`], JSON.stringify(r));
  assert.deepEqual(calls.map((c) => [c.agent, c.capability, c.input.kind, c.input.severity]), [["platform-api", "reports.publish", "platform_digest", "warning"]]);
  const [rep] = reports(db);
  assert.equal(rep.agent_id, "platform-api");
  assert.equal(rep.severity, "warning", "never critical: a critical report is the consensus brake and would block the deploys that end the stall");
  assert.match(rep.subject, /^Deploys stalled 6\.0 h: main bbbbbbbbbbbb green, 5 unit\(s\) behind; control-plane compare_failed_or_diverged, \* new_migration_control_plane_unavailable/);
  const b = rep.body;
  assert.deepEqual([b.source, b.state, b.alert_key, b.metric, b.value, b.threshold], ["deploy_stall", "open", `deploy_stall:${lastId}`, "deploy_stall_minutes", 360, 120]);
  assert.deepEqual([b.main_sha, b.main_ready, b.forge_units, b.forge_skipped], [H1, true, [], INCIDENT_SKIPS]);
  assert.deepEqual([b.last_deploy.proposal_id, b.last_deploy.commit_sha, b.last_deploy.unit, b.last_deploy_age_min], [lastId, OLD, "control-plane", 420]);
  assert.deepEqual(b.units_behind.map((u: any) => u.unit), DEPLOY_UNITS.map((u) => u.unit));
  assert.deepEqual(b.units_behind[0].runs, [OLD.slice(0, 12)]);
  assert.deepEqual(b.pending, { units: [], skipped: INCIDENT_SKIPS });
  // The brake is not engaged: no critical report, and the kernel's overview counts none (every voter's baseline holds).
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_reports WHERE severity = 'critical'").get() as any).n, 0);
  const ov: any = await observe(kernel as never, NOW + MIN);
  assert.deepEqual([ov.agent_reports_24h.counts.critical, ov.agent_reports_24h.counts.warning], [0, 1]);
  // The owner: production_unhandled on the Owner page and in one Telegram message naming the reasons.
  const [p] = await stallProblems(db, MIN);
  assert.deepEqual([p.subject, p.since, p.link], [`deploy_stall:${lastId}`, at(-6 * H), "#/pipelines"]);
  assert.match(p.detail, /main bbbbbbbbbbbb passed the Forge checks, but the last deploy_commit executed 7\.0 h ago \(control-plane aaaaaaaaaaaa\)/);
  assert.match(p.detail, /control-plane compare_failed_or_diverged, \* new_migration_control_plane_unavailable/);
  const tg = telegram(db);
  assert.deepEqual(await tg.reconcile(MIN), { topic: "production_unhandled", change: "opened", delivery: "sent" });
  assert.equal(tg.sent.length, 1);
  assert.equal(tg.sent[0].change, "opened");
  assert.ok(tg.sent[0].lines.some((l: string) => /Deploys stalled: main bbbbbbbbbbbb/.test(l) && /compare_failed_or_diverged/.test(l)));
  // The cron runs it at :27 and :57 without the analytics token (D1 and AGENTS only).
  const cron = await runObserver(env, NOW + 2 * MIN);
  assert.equal((cron.deploy_stall as any).outcome, "stalled");
  assert.equal(stallReport(await deployStall(db as never, NOW)).severity, "warning");
});

test("DS4. deduplicated: one open alarm per stall episode, also when main moves on during the stall", async () => {
  const db = migratedDb();
  const { env, calls } = platformEnv(db);
  await incident(db);
  const tg = telegram(db);
  await deployStallAlarm(env, NOW);
  assert.equal((await tg.reconcile(MIN)).change, "opened");
  // The next Observer run (:57): the episode's alarm is open, so nothing is published.
  assert.deepEqual(await deployStallAlarm(env, NOW + 30 * MIN).then((r) => [r.outcome, r.raised, r.resolved]), ["stalled", undefined, undefined]);
  // main moves on (H2, green, the same skips): still the same episode, no second report and no second Telegram message.
  checked(db, H2);
  await plan(db, H2, 40 * MIN, [], INCIDENT_SKIPS);
  const moved = await deployStall(db as never, NOW + H);
  assert.deepEqual([moved.stalled, moved.main_sha], [true, H2]);
  assert.equal((await deployStallAlarm(env, NOW + H)).raised, undefined);
  assert.equal((await tg.reconcile(H + MIN)).change, "unchanged");
  assert.deepEqual([calls.length, reports(db).length, tg.sent.length, (await openStallAlarms(db as never, NOW + H)).length], [1, 1, 1, 1]);
  assert.equal((await stallProblems(db, H)).length, 1);
});

test("DS5. resolved automatically once a deploy executes (a red head does not close it); a later stall is a new episode", async () => {
  const db = migratedDb();
  const { env, kernel } = platformEnv(db);
  const firstId = await incident(db);
  const tg = telegram(db);
  await deployStallAlarm(env, NOW);
  await tg.reconcile(MIN);
  // A new head whose checks still run: the stall is not over, so the alarm and the notice stay open.
  checked(db, H2, "running");
  await plan(db, H2, 10 * MIN, [], INCIDENT_SKIPS);
  const red = await stallState(db as never, NOW + 20 * MIN);
  assert.deepEqual([red.verdict.reason, red.active, red.raise, red.resolve.length], ["main_not_green", true, false, 0]);
  assert.equal((await deployStallAlarm(env, NOW + 20 * MIN)).resolved, undefined);
  assert.equal((await tg.reconcile(22 * MIN)).change, "unchanged");
  // The planner is fixed and a deploy_commit executes: the next Observer run resolves the alarm with the same key.
  checked(db, H2);
  run(db, H2, "control-plane");
  const deployId = deployed(db, H2, "control-plane", 40 * MIN);
  const r = await deployStallAlarm(env, NOW + 57 * MIN);
  assert.deepEqual(r.resolved, [`deploy_stall:${firstId}:succeeded`]);
  assert.equal(r.raised, undefined, "the new episode has not waited 2 h");
  const [opened, resolved] = reports(db);
  assert.deepEqual([resolved.severity, resolved.body.state, resolved.body.alert_key, resolved.body.resolution, resolved.body.opened_report_id],
    ["info", "resolved", opened.body.alert_key, "deploy_executed", opened.report_id]);
  assert.match(resolved.subject, /^Resolved: deploys stalled \(deploy_commit control-plane cccccccccccc executed at /);
  assert.deepEqual(await openStallAlarms(db as never, NOW + H), []);
  // The kernel's reports overview reads the same convention: the warning is resolved, not open.
  const ov: any = await observe(kernel as never, NOW + H);
  assert.deepEqual([ov.agent_reports_24h.counts.warning, ov.agent_reports_24h.warnings_resolved_24h], [0, 1]);
  // The owner notice closes: one "closed" Telegram message.
  assert.deepEqual(await tg.reconcile(H), { topic: "production_unhandled", change: "closed", delivery: "sent" });
  assert.deepEqual(tg.sent.map((m) => m.change), ["opened", "closed"]);
  assert.equal((await deployStallAlarm(env, NOW + 87 * MIN)).resolved, undefined, "resolved once");
  // The other units still wait on H2: two hours after that deploy it is a new episode with its own key.
  const again = await deployStallAlarm(env, NOW + 40 * MIN + STALL_AFTER_MS + 30 * MIN);
  assert.deepEqual([again.outcome, again.raised, again.alert_key], ["stalled", "succeeded", `deploy_stall:${deployId}`]);
  assert.deepEqual(reports(db).map((x) => [x.severity, x.body.alert_key]), [
    ["warning", `deploy_stall:${firstId}`], ["info", `deploy_stall:${firstId}`], ["warning", `deploy_stall:${deployId}`],
  ]);
});

test("DS6. the documentation names the alarm, its severity and its Telegram path", () => {
  const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
  const ssot = read("docs/SSOT.md");
  assert.match(ssot, /deploys_stalled/);
  assert.match(ssot, /deploy stall alarm/i);
  assert.match(read("docs/OPERATIONS.md"), /deploy stall alarm/i);
});
