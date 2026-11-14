// Owner 2026-11-14 ("setuju dan kerjakan"): the Auditor classifies denials (expected guard outcomes vs unexpected,
// against a 7-day baseline), its digest may not call expected guard outcomes a problem, the Supervisor does not call
// consensus.propose into a full rate window, and a warning its agent reported resolved is not shown as open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, fakeAi, fakeWorkflow, migratedDb } from "./harness.ts";
import { verifySyscallDecision } from "../src/capabilities.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { proposeFromAgent } from "../../recovery-manager/src/index.ts";
import {
  EXPECTED_DENIAL_CHECKS, classifyDenials, denialReasonCodes, isExpectedDenial, type DenialRow,
} from "../../ai-kernel/src/denials.ts";
import { draftAuditDigestTask, runAuditCycle, templateAuditDigest, type AuditObservation } from "../../ai-kernel/src/auditor.ts";
import { consensusProposeWindow, runCycle } from "../../ai-kernel/src/supervisor.ts";
import { observe, verifyAudit } from "../../ai-kernel/src/syscall.ts";

type Db = ReturnType<typeof migratedDb>;

function memory() {
  const m = new Map<string, unknown>();
  return { m, async get<T>(k: string) { return m.get(k) as T | undefined; }, async put(k: string, v: unknown) { m.set(k, structuredClone(v)); } };
}

function kernelEnv(db: Db = migratedDb(), extra: Record<string, unknown> = {}) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const recoveryEnv = { ...baseEnv("cryptophys-recovery-manager", db), RECOVERY_LIFECYCLE: fakeWorkflow().binding };
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async (agentId: string, decisionId: string, input: Record<string, unknown>) => { await verifySyscallDecision(db, decisionId, agentId, "recovery.propose"); return proposeFromAgent(recoveryEnv as never, agentId, input); } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    ...extra,
  };
  return { env, db };
}

let seq = 0;
/** A denied policy decision `hoursAgo` before `at`, recorded the way the Policy Engine records one. */
function deny(db: Db, at: number, hoursAgo: number, subject: string, action: string, resource: string, reason: string) {
  const id = `dec_${String(++seq).padStart(8, "0")}-0000-4000-8000-000000000000`;
  db.raw.prepare("INSERT INTO policy_decisions (decision_id, subject, action, resource, decision, reason, evidence_json, created_at) VALUES (?, ?, ?, ?, 'deny', ?, '{}', ?)")
    .run(id, subject, action, resource, reason, new Date(at - hoursAgo * 3_600_000).toISOString());
  const agent = /^agent:(.+)$/.exec(subject)?.[1];
  if (agent && action === "agent.syscall") {
    db.raw.prepare("INSERT INTO agent_actions (action_id, agent_id, capability, tier, decision_id, outcome, input_json, result_json, created_at) VALUES (?, ?, ?, 1, ?, 'denied', '{}', ?, ?)")
      .run(`act_${seq}`, agent, resource, id, JSON.stringify({ reason }), new Date(at - hoursAgo * 3_600_000).toISOString());
  }
}

/** The measured production day (2026-11-14, 24 h): every denial a guard working as designed. */
function measuredDay(db: Db, at: number) {
  for (let i = 0; i < 19; i++) deny(db, at, 0.5 + i, "agent:supervisor", "agent.syscall", "consensus.propose", "failed: rate_limit");
  for (let i = 0; i < 9; i++) deny(db, at, 1 + i, "agent:auditor", "agent.syscall", "memory.remember", "failed: power_mode_survival");
  for (let i = 0; i < 4; i++) deny(db, at, 2 + i, "agent:signal-analyst", "agent.syscall", "memory.remember", "failed: power_mode_survival");
  deny(db, at, 3, "agent:aether-curator", "agent.syscall", "knowledge.propose", "failed: power_mode_survival");
  for (let i = 0; i < 4; i++) deny(db, at, 4 + i, CI_CLIENT_ID, "deploy", "cryptophys-platform-api", "failed: ci_green");
  deny(db, at, 6, "agent:supervisor", "consensus.execute", "merge_change:fg-x", "failed: consensus_passed");
}

const row = (reason: string, recent: number, count: number, subject = "agent:supervisor", action = "agent.syscall"): DenialRow => ({ subject, action, reason, recent, count });

// ---------------------------------------------------------------- (a) classification

test("A1. the expected set is the four guard check ids; a denial is expected only when every failed check is", () => {
  assert.deepEqual([...EXPECTED_DENIAL_CHECKS], ["power_mode_survival", "rate_limit", "ci_green", "consensus_passed"]);
  assert.deepEqual(denialReasonCodes("failed: rate_limit, power_mode_survival"), ["rate_limit", "power_mode_survival"]);
  for (const r of ["failed: rate_limit", "failed: power_mode_survival", "failed: ci_green", "failed: consensus_passed", "failed: rate_limit, power_mode_survival"]) {
    assert.equal(isExpectedDenial(r), true, r);
  }
  for (const r of [
    "failed: capability_granted", "failed: tier_within_agent_limit", "failed: external_tier_limit", "failed: capability_not_prohibited",
    "failed: not_prohibited", "failed: not_human_only", "failed: capability_known", "failed: rate_limit, capability_granted",
    "failed: target_rate_limit", "failed: some_check_added_tomorrow", "policy_unavailable", "",
  ]) assert.equal(isExpectedDenial(r), false, r);
});

test("A2. a day of survival mode and rate limits is expected only: no warning, metrics per reason and subject", () => {
  const m = classifyDenials([
    row("failed: rate_limit", 1, 19),
    row("failed: power_mode_survival", 1, 9, "agent:auditor"),
    row("failed: power_mode_survival", 1, 4, "agent:signal-analyst"),
    row("failed: power_mode_survival", 1, 1, "agent:aether-curator"),
    row("failed: ci_green", 1, 4, CI_CLIENT_ID, "deploy"),
    row("failed: consensus_passed", 1, 1, "agent:supervisor", "consensus.execute"),
  ]);
  assert.deepEqual([m.total_24h, m.expected_24h, m.unexpected_24h, m.warn, m.verdict], [38, 38, 0, false, "expected_only"]);
  assert.deepEqual(m.by_reason.map((r) => [r.reason, r.expected, r.count_24h]), [
    ["rate_limit", true, 19], ["power_mode_survival", true, 14], ["ci_green", true, 4], ["consensus_passed", true, 1],
  ]);
  assert.deepEqual(m.by_subject.find((s) => s.subject === "agent:supervisor"), { subject: "agent:supervisor", expected_24h: 20, unexpected_24h: 0 });
  assert.match(m.interpretation[0], /^Expected guard outcomes: 38 in 24 h/);
  assert.match(m.interpretation[1], /^Unexpected refusals: 0 in 24 h .*Nothing to review\.$/);
  assert.doesNotMatch(m.interpretation.join(" "), /_/, "operator text carries no codes");
});

test("A3. unexpected denials: zero baseline warns, a new reason code warns, the 2x baseline rule decides otherwise", () => {
  // Zero baseline and one unexpected denial: warning.
  const one = classifyDenials([row("failed: capability_granted", 1, 1)]);
  assert.deepEqual([one.unexpected_24h, one.baseline_daily_unexpected, one.warn, one.verdict], [1, 0, true, "new_reason"]);
  // A steady unexpected baseline (7/day for 7 days) and 8 today: within the baseline, no warning.
  const steady = classifyDenials([row("failed: capability_granted", 0, 49), row("failed: capability_granted", 1, 8)]);
  assert.deepEqual([steady.baseline_daily_unexpected, steady.delta_unexpected_vs_baseline, steady.warn, steady.verdict], [7, 1, false, "within_baseline"]);
  // 14 today (2x the baseline): warning.
  const doubled = classifyDenials([row("failed: capability_granted", 0, 49), row("failed: capability_granted", 1, 14)]);
  assert.deepEqual([doubled.delta_unexpected_vs_baseline, doubled.warn, doubled.verdict], [7, true, "above_baseline"]);
  // A NEW reason code warns even when the total stays well within the baseline.
  const fresh = classifyDenials([row("failed: capability_granted", 0, 49), row("failed: capability_granted", 1, 6), row("failed: brand_new_check", 1, 1)]);
  assert.deepEqual([fresh.unexpected_24h, fresh.new_unexpected_reasons, fresh.warn, fresh.verdict], [7, ["brand_new_check"], true, "new_reason"]);
  // A mixed denial (an expected and an unexpected check) is unexpected.
  const mixed = classifyDenials([row("failed: rate_limit, tier_within_agent_limit", 1, 2)]);
  assert.deepEqual([mixed.expected_24h, mixed.unexpected_24h, mixed.warn], [0, 2, true]);
  // However many expected denials there are, against any baseline, they never warn.
  const flood = classifyDenials([row("failed: rate_limit", 0, 7), row("failed: rate_limit", 1, 500)]);
  assert.deepEqual([flood.baseline_daily_expected, flood.delta_expected_vs_baseline, flood.warn], [1, 499, false]);
});

test("A4. the Auditor: the measured survival/rate-limit day produces no warning; its daily digest carries the metrics", async () => {
  const { env, db } = kernelEnv();
  const mem = memory();
  const now = Date.now();
  measuredDay(db, now);
  const obs = await verifyAudit(env as never, now) as unknown as AuditObservation;
  assert.deepEqual([obs.denials!.expected_24h, obs.denials!.unexpected_24h, obs.denials!.warn], [38, 0, false]);
  assert.equal(obs.counts_24h.denied_agent_syscalls, 33, "the raw counts stay: 19 + 9 + 4 + 1 agent syscall denials");
  assert.deepEqual(obs.denials!.by_agent.find((a) => a.agent_id === "auditor"), { agent_id: "auditor", denied: 9, denied_expected: 9, denied_unexpected: 0, failed: 0 });
  assert.deepEqual(obs.counts_24h.policy_denies_by_action, [{ action: "agent.syscall", count: 33 }, { action: "consensus.execute", count: 1 }, { action: "deploy", count: 4 }]);

  // An ordinary hourly cycle: no report at all (before, more than 3 denied syscalls was a warning).
  const hourly = new Date(now); hourly.setUTCHours(5, 37, 0, 0);
  const quiet = await runAuditCycle(env as never, mem, "scheduled", hourly.getTime());
  assert.equal(quiet.findings[0].action, "none");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_reports WHERE agent_id = 'auditor'").get() as any).n, 0);

  // The 00:37 UTC cycle: an info digest whose body carries the denial metrics and their interpretation.
  const daily = new Date(now); daily.setUTCHours(0, 37, 0, 0);
  const d = await runAuditCycle(env as never, mem, "scheduled", daily.getTime());
  assert.deepEqual([d.findings[0].action, d.findings[0].severity], ["reports.publish", "info"]);
  const report = db.raw.prepare("SELECT severity, body_json FROM agent_reports WHERE agent_id = 'auditor'").get() as any;
  const body = JSON.parse(report.body_json);
  assert.equal(report.severity, "info");
  assert.deepEqual([body.denials.expected_24h, body.denials.unexpected_24h, body.denials.verdict], [38, 0, "expected_only"]);
  assert.deepEqual(body.denials.expected_reasons, ["power_mode_survival", "rate_limit", "ci_green", "consensus_passed"]);
  assert.deepEqual(body.metrics, body.denials.interpretation);
  assert.ok(!body.trigger_reasons.some((r: string) => /denied|denial/.test(r)));
});

test("A5. the Auditor warns on an unexpected denial (new reason, zero baseline), and the reason names it", async () => {
  const { env, db } = kernelEnv();
  const mem = memory();
  const now = Date.now();
  measuredDay(db, now);
  deny(db, now, 1, "agent:xauusd-reasoner", "agent.syscall", "recovery.propose", "failed: capability_granted, tier_within_agent_limit");
  const cycle = await runAuditCycle(env as never, mem, "scheduled", now);
  assert.deepEqual([cycle.findings[0].action, cycle.findings[0].severity], ["reports.publish", "warning"]);
  const body = JSON.parse((db.raw.prepare("SELECT body_json FROM agent_reports WHERE agent_id = 'auditor'").get() as any).body_json);
  assert.deepEqual(body.trigger_reasons, ["unexpected_denials:1", "new_denial_reason_capability_granted:1", "new_denial_reason_tier_within_agent_limit:1"]);
  assert.deepEqual([body.denials.expected_24h, body.denials.unexpected_24h], [38, 1]);
});

// ---------------------------------------------------------------- (b) the digest validator

function observation(unexpected: number): AuditObservation {
  const rows = [row("failed: rate_limit", 1, 19), row("failed: power_mode_survival", 1, 14, "agent:auditor")];
  if (unexpected) rows.push(row("failed: capability_granted", 1, unexpected));
  return {
    observed_at: "2026-11-14T09:37:00.000Z", since: "2026-11-13T09:37:00.000Z",
    chain: { valid: true, events_checked: 1200, head_hash: "abc1234567890", first_invalid_event_id: null, reason: null } as never,
    valid: true, events_checked: 1200,
    counts_24h: {
      agent_actions_by_agent: [{ agent_id: "supervisor", denied: 19, failed: 0 }], denied_agent_syscalls: 33 + unexpected, failed_agent_syscalls: 0,
      policy_denies_by_action: [{ action: "agent.syscall", count: 33 + unexpected }],
      governance_audit_events: { "agent.suspended": 0, "agent.resumed": 0, "kernel.agents_enabled": 0 }, agent_recovery_plans: 0,
    },
    denials: classifyDenials(rows),
  };
}

test("B1. with zero unexpected denials the digest may not call guard outcomes a problem or send the owner to the Supervisor's instructions", () => {
  const task = draftAuditDigestTask(observation(0));
  assert.match(task.instructions, /never call them a problem/);
  const bad = [
    { headline: "Auditor detects an increase in denied system calls", summary: "Audit chain valid.", items: ["33 denied"] },
    { headline: "Audit chain valid", summary: "33 requests were refused. Review the Supervisor's instructions.", items: ["Chain valid"] },
    { headline: "Audit chain valid", summary: "The audit log is intact.", items: ["Consider reviewing the supervisor instructions"] },
    { headline: "Audit chain valid", summary: "The audit log is intact.", items: ["Denied syscalls are a concern and need attention"] },
    { headline: "Audit chain valid", summary: "Unusual spike of refused requests from the supervisor.", items: ["ok"] },
  ];
  for (const draft of bad) {
    assert.equal(task.validate(draft), null, JSON.stringify(draft));
    assert.equal(task.diagnose!(draft), "expected_denials_called_a_problem", JSON.stringify(draft));
  }
  // Metric readings pass, including a negated claim.
  const good = {
    headline: "Audit chain valid; 33 expected guard outcomes, 0 unexpected refusals",
    summary: "Expected guard outcomes 33 in 24 h (rate limit 19, survival mode 14). Unexpected refusals 0; no problem to review.",
    items: ["Rate limit 19 (baseline 0/day)", "Survival mode throttle 14", "Unexpected refusals: 0"],
  };
  assert.ok(task.validate(good));
  // The deterministic template passes its own validator.
  assert.ok(task.validate(templateAuditDigest(observation(0), "info", ["daily_0037_utc_digest"])));
});

test("B2. with unexpected denials the same words are allowed (the rule guards expected outcomes only); chain checks still apply", () => {
  const task = draftAuditDigestTask(observation(3));
  assert.ok(task.validate({ headline: "3 unexpected refusals: review the agent's configuration", summary: "An increase in denied requests (capability not granted).", items: ["capability granted 3"] }));
  assert.equal(task.validate({ headline: "Chain is broken", summary: "s", items: ["x"] }), null);
  const t = templateAuditDigest(observation(3), "warning", ["unexpected_denials:3", "new_denial_reason_capability_granted:3"]);
  assert.match(t.headline, /^Needs a look: 3 unexpected refusal\(s\) by policy/);
  assert.doesNotMatch([t.headline, t.summary, ...t.items].join(" "), /syscall|_/);
  assert.ok(task.validate(t));
});

// ---------------------------------------------------------------- (c) the Supervisor's consensus.propose window

function persistentDrift(db: Db, svc = "cryptophys-platform-api") {
  db.raw.prepare("UPDATE service_registry SET desired_version = 'aaaaaaaaaaaa' WHERE service_id = ?").run(svc);
  for (const [id, minutes] of [["a", 20], ["b", 5]] as const) {
    db.raw.prepare(`INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at) VALUES (?, ?, 'd', 'o', 1, ?, ?)`)
      .run(`obs_${svc}_${id}`, svc, JSON.stringify({ reasons: ["version_mismatch"], desired_version: "aaaaaaaaaaaa", probe: { version_tag: "bbbbbbbbbbbb" } }), new Date(Date.now() - minutes * 60_000).toISOString());
  }
}
function consume(db: Db, n: number, minutesAgo: number[]) {
  for (let i = 0; i < n; i++) {
    db.raw.prepare("INSERT INTO agent_syscall_consumptions (decision_id, agent_id, capability, consumed_at) VALUES (?, 'supervisor', 'consensus.propose', ?)")
      .run(`dec_window_${++seq}`, new Date(Date.now() - minutesAgo[i] * 60_000).toISOString());
  }
}
const proposeRows = (db: Db) => db.raw.prepare("SELECT outcome FROM agent_actions WHERE agent_id = 'supervisor' AND capability = 'consensus.propose'").all() as any[];
const proposeDecisions = (db: Db) => db.raw.prepare("SELECT decision, reason FROM policy_decisions WHERE subject = 'agent:supervisor' AND resource = 'consensus.propose'").all() as any[];

test("C1. the window counts consumed syscalls in the last hour (denied attempts never count) and reopens when the oldest is an hour old", async () => {
  const db = migratedDb();
  const now = Date.now();
  consume(db, 3, [50, 30, 10]);
  db.raw.prepare("INSERT INTO agent_actions (action_id, agent_id, capability, tier, decision_id, outcome, input_json, result_json, created_at) VALUES ('act_d', 'supervisor', 'consensus.propose', 1, null, 'denied', '{}', '{\"reason\":\"failed: rate_limit\"}', ?)").run(new Date(now - 60_000).toISOString());
  const open = await consensusProposeWindow(db as never, "supervisor", now);
  assert.deepEqual([open.used, open.limit, open.full, open.reopens_at], [3, 4, false, null]);
  db.raw.prepare("INSERT INTO agent_syscall_consumptions (decision_id, agent_id, capability, consumed_at) VALUES ('dec_window_x', 'supervisor', 'consensus.propose', ?)").run(new Date(now - 70 * 60_000).toISOString());
  assert.equal((await consensusProposeWindow(db as never, "supervisor", now)).used, 3, "a consumption older than an hour has left the window");
  consume(db, 1, [5]);
  const full = await consensusProposeWindow(db as never, "supervisor", now);
  assert.deepEqual([full.used, full.full], [4, true]);
  const oldest = db.raw.prepare("SELECT MIN(consumed_at) AS t FROM agent_syscall_consumptions WHERE consumed_at >= ?").get(new Date(now - 3_600_000).toISOString()) as any;
  assert.equal(full.reopens_at, new Date(Date.parse(oldest.t) + 3_600_000).toISOString());
});

test("C2. a full window: the Supervisor skips consensus.propose (no denied syscall), records one finding, still proposes the recovery plan", async () => {
  const { env, db } = kernelEnv();
  persistentDrift(db);
  persistentDrift(db, "cryptophys-platform-registry");
  consume(db, 4, [50, 40, 30, 20]);
  const cycle = await runCycle(env as never, memory(), "scheduled");
  const windows = cycle.findings.filter((f) => f.kind === "rate_window");
  assert.equal(windows.length, 1, "one finding per cycle, however many proposals wait");
  assert.match(String(windows[0].why), /^consensus\.propose window full until \d\d:\d\d UTC \(4 of 4 in the last hour\)/);
  assert.equal(windows[0].reopens_at, new Date(Date.parse((db.raw.prepare("SELECT MIN(consumed_at) AS t FROM agent_syscall_consumptions").get() as any).t) + 3_600_000).toISOString());
  assert.deepEqual(proposeRows(db), [], "no consensus.propose syscall recorded, denied or otherwise");
  assert.deepEqual(proposeDecisions(db), [], "the Policy Engine was not asked");
  assert.equal(cycle.actions.filter((a) => a.capability === "consensus.propose").length, 0);
  assert.equal(cycle.findings.filter((f) => f.kind === "drift" && f.action === "recovery.propose").length, 2, "what is proposed is unchanged: the recovery plans still go out");
});

test("C3. an open window: the Supervisor proposes as before (the Policy Engine stays the authority)", async () => {
  const { env, db } = kernelEnv();
  persistentDrift(db);
  consume(db, 3, [50, 40, 30]);
  const cycle = await runCycle(env as never, memory(), "scheduled");
  assert.equal(cycle.findings.filter((f) => f.kind === "rate_window").length, 0);
  assert.equal(proposeRows(db).length, 1);
  assert.equal(proposeDecisions(db)[0].decision, "allow");
});

// ---------------------------------------------------------------- (d) resolved alerts are not shown as open

const NOW = Date.UTC(2026, 10, 14, 9, 0, 0);
function report(db: Db, agent: string, severity: string, subject: string, body: Record<string, unknown>, hoursAgo: number) {
  const id = "rep_" + (++seq);
  db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, created_at) VALUES (?, ?, 'xauusd_digest', ?, ?, ?, 'deterministic', ?)")
    .run(id, agent, severity, subject, JSON.stringify(body), new Date(NOW - hoursAgo * 3_600_000).toISOString());
  return id;
}
const CANON = "Aether's canon is not indexed 2 hours after a change";

test("D1. a warning its agent reported resolved is dropped from the overview; an unresolved one stays; resolved in 24 h is counted", async () => {
  const db = migratedDb();
  // 03:55 opened, 04:56 resolved (the measured case), the same alert key as the risk manager sends it.
  report(db, "xauusd-risk-manager", "warning", CANON, { alert_key: "aether_canon_index", alert_kind: "aether_sync", state: "open" }, 5.08);
  report(db, "xauusd-risk-manager", "info", `Resolved: ${CANON}`, { alert_key: "aether_canon_index", alert_kind: "aether_sync", state: "resolved" }, 4.07);
  const open = report(db, "xauusd-risk-manager", "warning", "Market data is stale", { alert_key: "market_data", state: "open" }, 3);
  const plain = report(db, "auditor", "warning", "Needs a look", { trigger_reasons: ["unexpected_denials:2"] }, 2);
  // Another agent's "resolution" of the same key does not close this agent's alert.
  const foreign = report(db, "hud-prophet", "warning", "Prophet alert", { alert_key: "shared_key", state: "open" }, 2.5);
  report(db, "xauusd-moderator", "info", "Resolved: Prophet alert", { alert_key: "shared_key", state: "resolved" }, 1.5);
  // Opened, resolved, opened again: the newer warning is open.
  report(db, "xauusd-risk-manager", "warning", "Parity off", { alert_key: "parity", state: "open" }, 8);
  report(db, "xauusd-risk-manager", "info", "Resolved: Parity off", { alert_key: "parity", state: "resolved" }, 7);
  const reopened = report(db, "xauusd-risk-manager", "warning", "Parity off", { alert_key: "parity", state: "open" }, 1);

  const ov: any = await observe(baseEnv("cryptophys-ai-kernel", db) as never, NOW);
  const listed = ov.agent_reports_24h.latest_attention.map((r: any) => r.report_id);
  assert.ok(!ov.agent_reports_24h.latest_attention.some((r: any) => r.subject === CANON), "the resolved canon warning is not listed");
  assert.deepEqual(new Set(listed), new Set([open, plain, foreign, reopened]));
  assert.equal(ov.agent_reports_24h.counts.warning, 4, "open warnings only");
  assert.equal(ov.agent_reports_24h.warnings_resolved_24h, 2, "resolved in last 24 h: the canon alert and the first parity alert");
});

test("D2. criticals are untouched by a resolution report (only an approver's acknowledgement closes them)", async () => {
  const db = migratedDb();
  const crit = report(db, "xauusd-risk-manager", "critical", "Engine down", { alert_key: "engine", state: "open" }, 3);
  report(db, "xauusd-risk-manager", "info", "Resolved: Engine down", { alert_key: "engine", state: "resolved" }, 2);
  const ov: any = await observe(baseEnv("cryptophys-ai-kernel", db) as never, NOW);
  assert.equal(ov.agent_reports_24h.counts.critical, 1);
  assert.deepEqual(ov.agent_reports_24h.latest_attention.map((r: any) => r.report_id), [crit]);
  assert.deepEqual(ov.agent_reports_24h.latest_critical.map((r: any) => r.report_id), [crit]);
  assert.equal(ov.agent_reports_24h.warnings_resolved_24h, 0);
});
