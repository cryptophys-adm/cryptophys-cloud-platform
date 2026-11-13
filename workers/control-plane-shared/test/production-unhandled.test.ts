// Coordinator 2026-11-13, after the owner-channel review: the cases where a broken production reached the owner
// through neither an approval nor a critical report are critical in the owner's sense, so they get their own
// owner-channel topic, production_unhandled ("A production problem no agent is handling"), from
// ai-kernel/src/owner-inbox.ts unhandledProblems(). One test per condition, plus the negative: a persistent drift
// with a draft recovery plan does not fire, because it already reaches the owner as an approval.
// One migratedDb() per test at most (the Forge runs these under sql.js, whose wasm heap never shrinks).
import { test } from "node:test";
import assert from "node:assert/strict";
import { migratedDb } from "./harness.ts";
import { HANDLING_GRACE_MS, STALE_MS, unhandledProblems } from "../../ai-kernel/src/owner-inbox.ts";
import { OWNER_CHANNEL_TOPICS, OWNER_PANEL_URL, channelOf, collectNotices, reconcileNotices } from "../../ai-kernel/src/owner-notices.ts";

type Db = ReturnType<typeof migratedDb>;
const NOW = Date.parse("2026-11-20T03:22:00Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000, H = 3_600_000;
let seq = 0;

function observe(db: Db, service: string, drifted: boolean, msAgo: number, reasons: string[] = []) {
  db.raw.prepare("INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at) VALUES (?, ?, 'h', ?, ?, ?, ?)")
    .run(`obs_${seq++}`, service, drifted ? "x" : "h", drifted ? 1 : 0, JSON.stringify({ reasons }), at(msAgo));
}
/** Every non-disabled registered service observed in sync twice, 20 and 5 minutes ago. */
function healthy(db: Db): string[] {
  const ids = (db.raw.prepare("SELECT service_id FROM service_registry WHERE status != 'disabled'").all() as { service_id: string }[]).map((s) => s.service_id);
  for (const id of ids) { observe(db, id, false, 20 * MIN); observe(db, id, false, 5 * MIN); }
  return ids;
}
/** A persistent drift: the service's observations replaced by two drifted ones, the older one `sinceMs` ago. */
function persistentDrift(db: Db, service: string, sinceMs: number, reasons = ["version_mismatch"]) {
  db.raw.prepare("DELETE FROM drift_observations WHERE service_id = ?").run(service);
  observe(db, service, true, sinceMs, reasons);
  observe(db, service, true, 2 * MIN, reasons);
}
const codes = async (db: Db) => (await unhandledProblems(db as never, NOW)).map((p) => `${p.code}:${p.subject}`);
function plan(db: Db, id: string, status: string, updatedAgo: number, extra: { reason?: string; by?: string } = {}) {
  db.raw.prepare(`INSERT INTO recovery_plans (plan_id, service_id, plan_version, status, steps_json, approved_by, last_execution_json, created_by, created_at, updated_at, disabled_reason)
    VALUES (?, 'cryptophys-console', 'aaaaaaaaaaaa', ?, '{"title":"t","rationale":"r","steps":[]}', NULL, NULL, ?, ?, ?, ?)`)
    .run(id, status, extra.by ?? "agent:supervisor", at(updatedAgo + H), at(updatedAgo), extra.reason ?? null);
}

test("P0. a healthy platform has no production problem, and the topic is on the owner channel", async () => {
  const db = migratedDb();
  healthy(db);
  assert.deepEqual(await codes(db), []);
  assert.deepEqual([...OWNER_CHANNEL_TOPICS], ["owner_attention", "critical_reports", "production_unhandled"]);
  assert.equal(channelOf("production_unhandled"), "owner");
  const n = (await collectNotices(db as never, NOW)).find((x) => x.topic === "production_unhandled")!;
  assert.deepEqual([n.active, n.channel, n.link], [false, "owner", OWNER_PANEL_URL]);
});

test("P1. condition 1: the AI Kernel or the Drift Detector itself persistently drifted or unhealthy (the Supervisor skips its own Worker)", async () => {
  const db = migratedDb();
  healthy(db);
  persistentDrift(db, "cryptophys-ai-kernel", 3 * MIN);
  persistentDrift(db, "cryptophys-drift-detector", 3 * MIN, ["health_check_failed"]);
  assert.deepEqual(await codes(db), ["self_unhealthy:cryptophys-ai-kernel", "self_unhealthy:cryptophys-drift-detector"], "no grace: no agent will handle it");
  // One drifted observation is not persistent, and a healthy Worker with only a missing version tag is not a problem.
  observe(db, "cryptophys-ai-kernel", false, MIN);
  observe(db, "cryptophys-drift-detector", true, MIN, ["observed_version_unavailable"]);
  observe(db, "cryptophys-drift-detector", true, MIN / 2, ["observed_version_unavailable"]);
  assert.deepEqual(await codes(db), []);
});

test("P2. condition 2: observations stale or missing for STALE_MS: the Drift Detector stopped", async () => {
  const db = migratedDb();
  healthy(db);
  observe(db, "cryptophys-policy-engine", false, STALE_MS + 10 * MIN);
  db.raw.prepare("DELETE FROM drift_observations WHERE service_id = 'cryptophys-policy-engine' AND observed_at > ?").run(at(STALE_MS + 5 * MIN));
  const reg = db.raw.prepare("INSERT INTO service_registry (service_id, display_name, environment, status, desired_version, metadata_json, created_at, updated_at) VALUES (?, ?, 'production', 'registered', NULL, '{}', ?, ?)");
  reg.run("cryptophys-new", "New", at(10 * MIN), at(10 * MIN));
  reg.run("cryptophys-old", "Old", at(2 * H), at(2 * H));
  assert.deepEqual(await codes(db), ["observations_stale:cryptophys-old", "observations_stale:cryptophys-policy-engine"],
    "a service registered 10 minutes ago is not missing yet; one registered 2 hours ago is");
  const p = (await unhandledProblems(db as never, NOW)).find((x) => x.subject === "cryptophys-policy-engine")!;
  assert.match(p.detail, /not observed since .*the Drift Detector may have stopped/);
});

test("P3. condition 3: a persistent drift with agents off, or with no plan and no deploy under way, past the Supervisor's grace", async () => {
  const db = migratedDb();
  healthy(db);
  persistentDrift(db, "cryptophys-console", HANDLING_GRACE_MS + 5 * MIN);
  persistentDrift(db, "cryptophys-policy-engine", HANDLING_GRACE_MS - 10 * MIN);
  assert.deepEqual(await codes(db), ["drift_unhandled:cryptophys-console"], "the younger drift is still within the Supervisor's grace");
  // A deploy that executed 3 hours ago does not handle it; one executed 30 minutes ago does.
  const proposal = db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES (?, 'supervisor', 'redeploy_desired_version', 'cryptophys-console', 'routine', '{}', '{}', 'deploy', 8, 8, 0, 1, NULL, 'allow', ?, NULL, ?, ?)`);
  proposal.run("cns_old", "executed", at(3 * H), at(3 * H));
  assert.deepEqual(await codes(db), ["drift_unhandled:cryptophys-console"]);
  proposal.run("cns_new", "executed", at(30 * MIN), at(30 * MIN));
  assert.deepEqual(await codes(db), []);
  // With agents switched off, the drift is unhandled whatever is open.
  db.raw.prepare("UPDATE kernel_controls SET value = '0' WHERE control = 'agents_enabled'").run();
  const p = await unhandledProblems(db as never, NOW);
  assert.deepEqual(p.map((x) => `${x.code}:${x.subject}`), ["drift_unhandled:cryptophys-console"]);
  assert.match(p[0].detail, /agents are switched off/);
});

test("P3-negative. a persistent drift with a draft recovery plan does not fire: it already reaches the owner as an approval", async () => {
  const db = migratedDb();
  healthy(db);
  persistentDrift(db, "cryptophys-console", 2 * H);
  plan(db, "plan_draft", "draft", 0);
  assert.deepEqual(await codes(db), []);
  const notices = await collectNotices(db as never, NOW);
  assert.equal(notices.find((n) => n.topic === "production_unhandled")!.active, false);
  assert.equal(notices.find((n) => n.topic === "owner_attention")!.active, true, "the owner hears of it as an approval");
  // Approved and executing plans handle it too.
  db.raw.prepare("UPDATE recovery_plans SET status = 'executing'").run();
  assert.deepEqual(await codes(db), []);
});

test("P4. condition 4: a recovery plan failed, expired or lapsed in the last 24 hours", async () => {
  const db = migratedDb();
  healthy(db);
  plan(db, "plan_failed", "failed", H);
  plan(db, "plan_expired", "disabled", 2 * H, { reason: "approval_expired" });
  plan(db, "plan_lapsed", "disabled", 3 * H, { reason: "approval_lapsed" });
  plan(db, "plan_old", "failed", 25 * H);
  plan(db, "plan_superseded", "disabled", H, { reason: "superseded" });
  plan(db, "plan_check", "failed", H, { by: "ci-client.access" });
  assert.deepEqual(await codes(db), ["recovery_failed:plan_failed", "recovery_failed:plan_expired", "recovery_failed:plan_lapsed"],
    "older than 24 h, retired as superseded, and deploy-verification plans are not reported");
  const p = (await unhandledProblems(db as never, NOW))[0];
  assert.deepEqual([p.link, /failed at/.test(p.detail)], ["#/recovery/plan_failed", true]);
});

test("P5. condition 5: a critical advisory in a runtime lockfile; high and tooling-only stay console-only", async () => {
  const db = migratedDb();
  healthy(db);
  db.raw.prepare("INSERT INTO forge_dependency_audits (run_id, main_sha, ran_at, status) VALUES ('dep_1', ?, ?, 'ok')").run("a".repeat(40), at(H));
  const finding = db.raw.prepare("INSERT INTO forge_dependency_findings (run_id, package, version, advisory_id, severity, title, url, vulnerable_versions, lockfiles, runtime) VALUES ('dep_1', ?, '1.0.0', ?, ?, 't', NULL, '<2', '[\"workers/console/ui/package-lock.json\"]', ?)");
  finding.run("high-runtime", "100", "high", 1);
  finding.run("critical-tooling", "101", "critical", 0);
  assert.deepEqual(await codes(db), []);
  finding.run("critical-runtime", "102", "critical", 1);
  assert.deepEqual(await codes(db), ["critical_advisory:102"]);
});

test("P6. condition 6: Workers Builds minutes at or over the budget; 80% stays console-only", async () => {
  const db = migratedDb();
  healthy(db);
  db.raw.prepare("INSERT INTO forge_build_collections (collected_at, outcome, workers, builds_seen, builds_new) VALUES (?, 'collected', 1, 2, 2)").run(at(10 * MIN));
  const build = db.raw.prepare("INSERT INTO forge_builds (build_uuid, worker, created_on, stopped_on, duration_s, billed_minutes, seen_at) VALUES (?, 'cryptophys-forge-typecheck', ?, ?, 60, ?, ?)");
  build.run("b1", at(2 * H), at(2 * H - MIN), 2999, at(0));
  assert.deepEqual(await codes(db), [], "2999 of 3000 is the console-only build_minutes notice");
  build.run("b2", at(H), at(H - MIN), 1, at(0));
  assert.deepEqual(await codes(db), ["build_minutes_exhausted:2026-11"]);
});

test("P7. production_unhandled is emailed and sent to Telegram with the Owner page link, once per set of problems, and resolved", async () => {
  const db = migratedDb();
  healthy(db);
  persistentDrift(db, "cryptophys-ai-kernel", 3 * MIN);
  const mail: any[] = [];
  const tg: any[] = [];
  const env = { DB: db, APPROVER_IDENTITIES: "owner@example.com", NOTIFY_FROM: "alerts@notify.example.com",
    OWNER_EMAIL: { send: async (m: any) => { mail.push(m); return {}; } }, OWNER_TELEGRAM: { notify: async (n: any) => { tg.push(n); return { sent: true }; } } };
  const topic = async () => (await reconcileNotices(env as never, NOW)).find((r) => r.topic === "production_unhandled")!;
  assert.deepEqual(await topic(), { topic: "production_unhandled", change: "opened", delivery: "sent" });
  assert.match(mail[0].subject, /^\[Cryptophys\] A production problem no agent is handling: 1 item\(s\)$/);
  assert.match(mail[0].text, /AI Kernel is drifted or unhealthy \(version_mismatch\)/);
  assert.match(mail[0].text, /#\/owner$/m);
  assert.deepEqual([tg.length, tg[0].link], [1, OWNER_PANEL_URL]);
  observe(db, "cryptophys-ai-kernel", true, MIN, ["version_mismatch"]);
  assert.equal((await topic()).change, "unchanged", "a newer observation of the same problem sends nothing");
  observe(db, "cryptophys-ai-kernel", false, MIN / 2);
  assert.deepEqual(await topic(), { topic: "production_unhandled", change: "closed", delivery: "sent" });
  assert.match(mail[1].subject, /^\[Cryptophys\] Resolved: /);
  assert.equal(tg.at(-1).change, "closed");
});
