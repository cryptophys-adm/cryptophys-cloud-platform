// Owner 2026-11-14: from 2026-11-12 the organism stayed in survival on open-market weekdays, because the Supervisor
// treated $0.20/day of billable burn as "exceeding free tier" while the account is on Workers Paid ($0.40-0.49/day is
// normal). Survival also denied knowledge.propose and memory.remember, so no knowledge proposal was written for three
// days. Now: a monthly budget (policy parameter infra-budget-usd-month, $30), learning allowed in every mode, the
// Console shows the mode, its reason and what it blocks, and the Auditor warns on blocked learning.
// Clock-independent: every Supervisor evaluation passes its own `now`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, fakeAi, fakeWorkflow, migratedDb } from "./harness.ts";
import { verifySyscallDecision } from "../src/capabilities.ts";
import { POLICY_PARAMETERS, readPolicyParameter, validPolicyValue } from "../src/policy-params.ts";
import { castVote } from "../src/consensus-rules.ts";
import { LEARNING_CAPABILITIES, SURVIVAL_AI_BUDGET, SURVIVAL_DENIED_CAPABILITIES, powerModeEffects, survivalDenies } from "../src/power-mode.ts";
import { decide, evaluatePolicy, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { proposeFromAgent } from "../../recovery-manager/src/index.ts";
import { observeMetabolism, syscall, verifyAudit } from "../../ai-kernel/src/syscall.ts";
import { evaluateMetabolismState } from "../../ai-kernel/src/supervisor.ts";
import { metabolismView } from "../../ai-kernel/src/metabolism-view.ts";
import { rpcSyscall } from "../../ai-kernel/src/agent-rpc.ts";
import { KNOWLEDGE_ITEM_VERSION } from "../../ai-kernel/src/knowledge.ts";
import { classifyDenials, type DenialRow } from "../../ai-kernel/src/denials.ts";
import { runAuditCycle, type AuditObservation } from "../../ai-kernel/src/auditor.ts";

type Db = ReturnType<typeof migratedDb>;
const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

// Tuesday 2026-11-10 14:00 UTC (market open; November has 30 days) and Saturday 2026-11-14 12:00 UTC (market closed).
const TUESDAY = Date.UTC(2026, 10, 10, 14, 0, 0);
const SATURDAY = Date.UTC(2026, 10, 14, 12, 0, 0);

function burn(db: Db, day: string, usd: number, service = "cryptophys-platform-api") {
  db.raw.prepare("INSERT INTO infra_burn_metrics (metric_id, period_day, service_id, estimated_cost_usd, calculated_at) VALUES (?, ?, ?, ?, ?)")
    .run(`brn_${service.slice(11, 19)}_${day.replace(/-/g, "")}`, day, service, usd, `${day}T12:00:00.000Z`);
}
const mode = (db: Db) => (db.raw.prepare("SELECT value FROM metabolism_controls WHERE control = 'power_mode'").get() as any).value;
const setMode = (db: Db, m: string) => db.raw.prepare("UPDATE metabolism_controls SET value = ? WHERE control = 'power_mode'").run(m);

function kernelEnv(db: Db = migratedDb()) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const recoveryEnv = { ...baseEnv("cryptophys-recovery-manager", db), RECOVERY_LIFECYCLE: fakeWorkflow().binding };
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async (agentId: string, decisionId: string, input: Record<string, unknown>) => { await verifySyscallDecision(db, decisionId, agentId, "recovery.propose"); return proposeFromAgent(recoveryEnv as never, agentId, input); } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
  };
  return { env, db };
}

// ---------------------------------------------------------------- 1. the budget, not the free tier

test("MB1. a Workers Paid burn ($0.45/day, $13.50 projected) under the $30 budget is homeostasis on an open-market weekday", async () => {
  const db = migratedDb();
  const env: any = baseEnv("cryptophys-ai-kernel", db);
  burn(db, "2026-11-10", 0.30);
  burn(db, "2026-11-10", 0.15, "cryptophys-ai-kernel");
  // Production since 2026-11-12: stuck in survival. The next cycle brings it back, audited.
  setMode(db, "survival");
  const obs: any = await observeMetabolism(env, TUESDAY);
  assert.deepEqual([obs.infra_burn_cost_24h, obs.infra_burn_source, obs.infra_projection_days, obs.infra_projected_month_usd, obs.infra_budget_usd_month], [0.45, "billable_usage", 30, 13.5, 30]);
  const r: any = await evaluateMetabolismState(env, TUESDAY);
  assert.equal(r.market_status, "open");
  assert.equal(r.power_mode, "homeostasis", r.reason);
  assert.equal(mode(db), "homeostasis");
  assert.doesNotMatch(r.reason, /free tier/i);
  const audit = db.raw.prepare("SELECT outcome, payload_json FROM audit_events WHERE event_type = 'metabolism.power_mode_changed'").all() as any[];
  assert.deepEqual(audit.map((a) => [JSON.parse(a.payload_json).previous_mode, a.outcome]), [["survival", "homeostasis"]]);
  // The old rule's case: $0.21/day was survival ("exceeding free tier"); it is $6.30 projected now.
  const db2 = migratedDb();
  burn(db2, "2026-11-10", 0.21);
  assert.equal(((await evaluateMetabolismState(baseEnv("cryptophys-ai-kernel", db2) as never, TUESDAY)) as any).power_mode, "homeostasis");
});

test("MB2. a projected month over the budget is survival, with the projection in the reason; the council's budget is read", async () => {
  const db = migratedDb();
  const env: any = baseEnv("cryptophys-ai-kernel", db);
  burn(db, "2026-11-10", 1.2); // x 30 days = $36 > $30
  const r: any = await evaluateMetabolismState(env, TUESDAY);
  assert.equal(r.power_mode, "survival");
  assert.equal(r.reason, "projected infrastructure spend $36/month ($1.2/day x 30 days) exceeds the $30/month budget: entering survival mode to throttle AI spending");
  assert.doesNotMatch(r.reason, /free tier/i);
  // Exactly the budget is not over it.
  db.raw.prepare("UPDATE infra_burn_metrics SET estimated_cost_usd = 1.0").run();
  assert.equal(((await evaluateMetabolismState(env, TUESDAY + 60_000)) as any).power_mode, "homeostasis", "$30 projected is within $30");
  // A budget the council lowered to $20 makes the same burn survival again; raised to $40, homeostasis.
  db.raw.prepare("UPDATE policy_parameters SET value = 20 WHERE name = 'infra-budget-usd-month'").run();
  const lowered: any = await evaluateMetabolismState(env, TUESDAY + 120_000);
  assert.deepEqual([lowered.power_mode, /exceeds the \$20\/month budget/.test(lowered.reason)], ["survival", true]);
  db.raw.prepare("UPDATE policy_parameters SET value = 40 WHERE name = 'infra-budget-usd-month'").run();
  db.raw.prepare("UPDATE infra_burn_metrics SET estimated_cost_usd = 1.2").run();
  assert.equal(((await evaluateMetabolismState(env, TUESDAY + 180_000)) as any).power_mode, "homeostasis");
});

test("MB3. only a burn read from the Billable Usage API is projected; the newest recent day is used; an estimate never decides", async () => {
  const db = migratedDb();
  const env: any = baseEnv("cryptophys-ai-kernel", db);
  // No billing row at all: the old estimate (0.15 + AI requests x 0.001) stays for the runway, but is not a measurement.
  db.raw.prepare("INSERT INTO ai_usage (service_id, day, requests, failures) VALUES ('cryptophys-ai-kernel', '2026-11-10', 2000, 0)").run();
  const est: any = await observeMetabolism(env, TUESDAY);
  assert.deepEqual([est.infra_burn_source, est.infra_projected_month_usd], ["estimate", null]);
  assert.ok(est.infra_burn_cost_24h * 30 > 30, "the estimate alone would be over the budget");
  assert.equal(((await evaluateMetabolismState(env, TUESDAY)) as any).power_mode, "homeostasis", "an estimate never triggers survival");
  // No row today: the newest of the last 7 days, as is (each row is already the cycle's daily average).
  burn(db, "2026-11-06", 0.9);
  burn(db, "2026-11-08", 0.4);
  const recent: any = await observeMetabolism(env, TUESDAY);
  assert.deepEqual([recent.infra_burn_source, recent.infra_burn_cost_24h, recent.infra_projected_month_usd], ["billable_usage_recent", 0.4, 12]);
  // A 31-day month projects over 31 days.
  burn(db, "2026-12-03", 1.0);
  const dec: any = await observeMetabolism(env, Date.UTC(2026, 11, 3, 14, 0, 0));
  assert.deepEqual([dec.infra_projection_days, dec.infra_projected_month_usd], [31, 31]);
  assert.equal(((await evaluateMetabolismState(env, Date.UTC(2026, 11, 3, 14, 0, 0))) as any).power_mode, "survival", "$31 > $30");
});

// ---------------------------------------------------------------- 2. learning is core

test("MB4. in survival the Policy Engine allows knowledge.propose and memory.remember; AI-heavy work stays throttled", async () => {
  const db = migratedDb();
  setMode(db, "survival");
  for (const [subject, cap] of [["agent:aether-curator", "knowledge.propose"], ["agent:auditor", "memory.remember"], ["agent:signal-analyst", "memory.remember"], ["agent:supervisor", "memory.remember"]]) {
    const res = await evaluatePolicy(db as never, "agent.syscall", cap, { __subject: subject });
    assert.equal(res.decision, "allow", `${subject} ${cap}: ${res.reason}`);
    assert.ok(!res.checks.some((c) => c.id === "power_mode_survival"), `${cap} has no survival check`);
  }
  assert.deepEqual([...LEARNING_CAPABILITIES], ["memory.remember", "knowledge.propose", "corrections.record"]); // corrections.record: HAIC H3e
  // AI-heavy capabilities are denied in survival; learning and consensus.propose never are, even if listed.
  assert.equal(survivalDenies("ai.heavy_draft", ["ai.heavy_draft"]), true);
  assert.equal(survivalDenies("memory.remember", ["memory.remember"]), false);
  assert.equal(survivalDenies("knowledge.propose", ["knowledge.propose"]), false);
  assert.equal(survivalDenies("corrections.record", ["corrections.record"]), false);
  assert.equal(survivalDenies("consensus.propose", ["consensus.propose"]), false);
  assert.ok(!SURVIVAL_DENIED_CAPABILITIES.some((c) => LEARNING_CAPABILITIES.includes(c)));
  // Other AI work (drafts, recall embeddings) reserves from survival's quarter budget. The embeddings memory.remember
  // needs do not since the learning mandate (owner 2026-11-14): test/learning-mandate-2026-11-14.test.ts.
  const { AiEngine } = await import("../src/ai-engine.ts");
  const reserved = async (day: string, n: number) => {
    const engine: any = new (AiEngine as any)({ service: "cryptophys-ai-kernel", ai: { run: async () => ({}) }, db, dailyLimit: 8, accountDailyLimit: 1000 });
    let ok = 0;
    for (let i = 0; i < n; i++) if (await engine.reserve(day)) ok += 1;
    return ok;
  };
  assert.equal(await reserved("2026-11-14", 8), 8 * SURVIVAL_AI_BUDGET.ratio, "survival: a quarter of the daily AI budget");
  setMode(db, "homeostasis");
  assert.equal(await reserved("2026-11-15", 8), 8, "homeostasis: the full budget");
  // The rules the Console shows: nothing blocked by policy today, AI at 25%, learning allowed.
  assert.deepEqual(powerModeEffects("survival"), {
    mode: "survival", blocked_capabilities: [], learning_capabilities: ["memory.remember", "knowledge.propose", "corrections.record"], never_throttled: ["consensus.propose"],
    ai_budget: { ratio: 0.25, max_per_service: 20, max_account: 50 },
  });
  assert.equal(powerModeEffects("growth")!.ai_budget.ratio, 1, "an automatic growth never raises budgets");
  assert.equal(powerModeEffects("growth", "growth")!.ai_budget.ratio, 2);
  assert.equal(powerModeEffects(undefined), null, "an unreported mode has no rules");
  // The Policy Engine source no longer names learning as non-essential.
  assert.doesNotMatch(read("workers/policy-engine/src/index.ts"), /nonEssential|"memory\.remember", "knowledge\.propose"/);
});

test("MB5. weekend market-closed survival throttles AI work but not learning: the curator's proposal is written", async () => {
  const { env, db } = kernelEnv();
  const r: any = await evaluateMetabolismState(env as never, SATURDAY);
  assert.deepEqual([r.market_status, r.power_mode, mode(db)], ["closed", "survival", "survival"]);
  // Learning: the Aether curator's daily proposal and an agent's memory pass the Policy Engine.
  const item = {
    schema: KNOWLEDGE_ITEM_VERSION, item_id: "k-weekend-learning", version: 1, kind: "caution", claim_type: "measured_outcome", label: "learned",
    audience: { agents: ["prophet", "moderator"], charts: ["60"] },
    situation: { chart: "60", session: "london" },
    text: "On the hourly chart in the London session, the prophet agent was wrong in 79% of its decisive calls over 30 days, against 48% in its other situations.",
    evidence: { agent: "prophet", chart: "60", session: "london", window_days: 30, decisive: 14, wrong: 11, wrong_pct: 79, baseline_wrong_pct: 48, baseline_decisive: 20, p_value: 0.03 },
    provenance: { card_ids: Array.from({ length: 12 }, (_, i) => `d:60:${1793000000000 + i * 3_600_000}:0`), canon_sha: "1347833f2e6dd1a47f078181215180e387cc94d30d5ba1c9858718bb3a66eb80", canon_version: "aether.canon.v1", source: "aether" },
  };
  const proposed = await rpcSyscall(env as never, { host_worker: "cryptophys-aether" }, "aether-curator", "knowledge.propose", { item });
  assert.equal(proposed.outcome, "succeeded", JSON.stringify(proposed));
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM knowledge_proposals").get() as any).n, 1, "a knowledge_proposals row is written in survival");
  const remember = await evaluatePolicy(db as never, "agent.syscall", "memory.remember", { __subject: "agent:auditor" });
  assert.equal(remember.decision, "allow", remember.reason);
  // AI-heavy work: the quarter budget applies (the account cap of 50 included).
  const { AiEngine } = await import("../src/ai-engine.ts");
  const engine: any = new (AiEngine as any)({ service: "cryptophys-platform-api", ai: { run: async () => ({}) }, db, dailyLimit: 200, accountDailyLimit: 1000 });
  let ok = 0;
  for (let i = 0; i < 30; i++) if (await engine.reserve("2026-11-14")) ok += 1;
  assert.equal(ok, SURVIVAL_AI_BUDGET.max_per_service, "survival caps a service at 20 AI requests a day");
  // consensus.propose is never throttled.
  const cns = await syscall(env as never, "supervisor", "consensus.propose", { action: "observe_drift", target: "platform", params: {} });
  assert.notEqual(cns.outcome, "denied", JSON.stringify(cns));
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM policy_decisions WHERE decision = 'deny' AND reason LIKE '%power_mode_survival%'").get() as any).n, 0, "no survival denial at all");
});

// ---------------------------------------------------------------- 3. the parameter's bounds

test("MB6. infra-budget-usd-month is bounded (5-50, integer) in code, in the vote, in the executor and in the table", async () => {
  assert.deepEqual(POLICY_PARAMETERS["infra-budget-usd-month"], { default: 30, min: 5, max: 50, description: POLICY_PARAMETERS["infra-budget-usd-month"].description });
  for (const v of [5, 30, 50]) assert.equal(validPolicyValue("infra-budget-usd-month", v), true, String(v));
  for (const v of [4, 51, 0, -30, 30.5, "30", null, 1000]) assert.equal(validPolicyValue("infra-budget-usd-month", v), false, String(v));
  const ev: any = { agents_enabled: true, audit_valid: true, services: {}, registry: {}, agents: {}, critical_reports_24h: 0, executing_plan_targets: [], recent_same: 0 };
  const vote = (value: unknown) => castVote("policy-engine", { action: "set_policy_parameter", target: "infra-budget-usd-month", params: { value }, class: "routine" } as any, ev);
  assert.equal(vote(30).vote, "approve");
  assert.deepEqual([vote(51).vote, vote(51).reason], ["reject", "value must be an integer from 5 to 50"]);
  assert.equal(vote(4).vote, "reject");

  const { env, db } = kernelEnv();
  assert.equal(await readPolicyParameter(db as never, "infra-budget-usd-month"), 30, "migration 0069 seeds the owner's $30");
  assert.equal((db.raw.prepare("SELECT updated_by FROM policy_parameters WHERE name = 'infra-budget-usd-month'").get() as any).updated_by, "migration:0069");
  // The table refuses out-of-range values for the budget, and keeps 1-40 for the other parameters.
  assert.throws(() => db.raw.prepare("UPDATE policy_parameters SET value = 51 WHERE name = 'infra-budget-usd-month'").run(), /CHECK constraint/);
  assert.throws(() => db.raw.prepare("UPDATE policy_parameters SET value = 4 WHERE name = 'infra-budget-usd-month'").run(), /CHECK constraint/);
  assert.throws(() => db.raw.prepare("UPDATE policy_parameters SET value = 41 WHERE name = 'daily-deploy-limit'").run(), /CHECK constraint/);
  assert.throws(() => db.raw.prepare("INSERT INTO policy_parameters (name, value, updated_by, updated_at) VALUES ('free-tier', 1, 'x', 'y')").run(), /CHECK constraint/);
  // A value that bypassed the table and consensus is clamped (before 0069 the row is absent: the default).
  db.raw.prepare("DELETE FROM policy_parameters WHERE name = 'infra-budget-usd-month'").run();
  assert.equal(await readPolicyParameter(db as never, "infra-budget-usd-month"), 30);

  // set_policy_parameter: inside the bounds it executes by consensus and is audited; outside, never.
  db.raw.prepare("UPDATE consensus_controls SET value = 'routine' WHERE control = 'mode'").run();
  const bad = await syscall(env as never, "supervisor", "consensus.propose", { action: "set_policy_parameter", target: "infra-budget-usd-month", params: { value: 75 } });
  assert.equal(bad.outcome, "succeeded", JSON.stringify(bad));
  const badRow = db.raw.prepare("SELECT status FROM consensus_proposals ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as any;
  assert.notEqual(badRow.status, "executed", "a value outside the hard bounds never executes");
  assert.equal(await readPolicyParameter(db as never, "infra-budget-usd-month"), 30);
  const good = await syscall(env as never, "supervisor", "consensus.propose", { action: "set_policy_parameter", target: "infra-budget-usd-month", params: { value: 25 } });
  assert.equal(good.outcome, "succeeded", JSON.stringify(good));
  const goodRow = db.raw.prepare("SELECT status, outcome_json FROM consensus_proposals ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as any;
  assert.equal(goodRow.status, "executed", goodRow.outcome_json);
  assert.equal(await readPolicyParameter(db as never, "infra-budget-usd-month"), 25);
  const audit = db.raw.prepare("SELECT outcome, subject, payload_json FROM audit_events WHERE event_type = 'policy.parameter_changed'").get() as any;
  assert.deepEqual([audit.subject, audit.outcome, JSON.parse(audit.payload_json).previous], ["policy:infra-budget-usd-month", "25", 30]);
  assert.equal(((await observeMetabolism(env as never, TUESDAY)) as any).infra_budget_usd_month, 25, "the metabolism reads the council's value");
});

// ---------------------------------------------------------------- 4. the Auditor

const row = (reason: string, recent: number, count: number, subject: string, learning_capability: string | null = null, action = "agent.syscall"): DenialRow => ({ subject, action, reason, recent, count, learning_capability });

test("MB7. the Auditor counts blocked learning on its own and warns when it is > 0 in a day; the rest is unchanged", async () => {
  const one = classifyDenials([row("failed: rate_limit", 1, 5, "agent:supervisor"), row("failed: power_mode_survival", 1, 1, "agent:aether-curator", "knowledge.propose")]);
  assert.deepEqual([one.expected_24h, one.unexpected_24h, one.learning_blocked_24h, one.total_24h], [5, 0, 1, 6]);
  assert.deepEqual([one.warn, one.learning_warn, one.unexpected_warn, one.verdict], [true, true, false, "learning_blocked"]);
  assert.deepEqual(one.learning_blocked.by_subject, [{ subject: "agent:aether-curator", count_24h: 1 }]);
  assert.deepEqual(one.by_reason.map((r) => r.reason), ["rate_limit"], "the guards' table is unchanged");
  // Any check counts (a rate limit on memory too); an unexpected check stays unexpected as well.
  const mixed = classifyDenials([row("failed: rate_limit", 1, 2, "agent:auditor", "memory.remember"), row("failed: capability_granted", 1, 1, "agent:aether-auditor", "knowledge.propose")]);
  assert.deepEqual([mixed.learning_blocked_24h, mixed.unexpected_24h, mixed.expected_24h, mixed.verdict], [3, 1, 0, "new_reason"]);
  // In the baseline only (older than 24 h): no warning.
  const old = classifyDenials([row("failed: power_mode_survival", 0, 14, "agent:auditor", "memory.remember")]);
  assert.deepEqual([old.learning_blocked_24h, old.learning_blocked.baseline_daily, old.warn, old.verdict], [0, 2, false, "none"]);
  // A denial of another capability with the same guard stays expected.
  const guard = classifyDenials([row("failed: power_mode_survival", 1, 3, "agent:supervisor", null)]);
  assert.deepEqual([guard.expected_24h, guard.learning_blocked_24h, guard.warn], [3, 0, false]);

  // End to end: one blocked knowledge proposal in the last day publishes a warning.
  const { env, db } = kernelEnv();
  const now = Date.now();
  db.raw.prepare("INSERT INTO policy_decisions (decision_id, subject, action, resource, decision, reason, evidence_json, created_at) VALUES ('dec_mb7', 'agent:aether-curator', 'agent.syscall', 'knowledge.propose', 'deny', 'failed: power_mode_survival', '{}', ?)").run(new Date(now - 3_600_000).toISOString());
  db.raw.prepare("INSERT INTO agent_actions (action_id, agent_id, capability, tier, decision_id, outcome, input_json, result_json, created_at) VALUES ('act_mb7', 'aether-curator', 'knowledge.propose', 1, 'dec_mb7', 'denied', '{}', '{\"reason\":\"failed: power_mode_survival\"}', ?)").run(new Date(now - 3_600_000).toISOString());
  const obs = await verifyAudit(env as never, now) as unknown as AuditObservation;
  assert.deepEqual([obs.denials!.learning_blocked_24h, obs.denials!.warn], [1, true]);
  assert.deepEqual(obs.denials!.by_agent, [{ agent_id: "aether-curator", denied: 1, denied_expected: 0, denied_learning: 1, denied_unexpected: 0, failed: 0 }]);
  const hourly = new Date(now); hourly.setUTCHours(7, 37, 0, 0);
  const mem = new Map<string, unknown>();
  const cycle = await runAuditCycle(env as never, { get: async <T>(k: string) => mem.get(k) as T, put: async (k: string, v: unknown) => { mem.set(k, v); } } as never, "scheduled", hourly.getTime());
  assert.deepEqual([cycle.findings[0].action, cycle.findings[0].severity], ["reports.publish", "warning"]);
  const report = db.raw.prepare("SELECT subject, body_json FROM agent_reports WHERE agent_id = 'auditor'").get() as any;
  assert.deepEqual(JSON.parse(report.body_json).trigger_reasons, ["learning_blocked:1"]);
  assert.match(report.subject, /1 learning request\(s\) refused/);
});

// ---------------------------------------------------------------- 5. what the Console reads

test("MB8. GET /v1/metabolism says the mode, its reason and what it blocks; a value not measured is null", async () => {
  const db = migratedDb();
  const env: any = baseEnv("cryptophys-ai-kernel", db);
  // Before any cycle: the mode is read, but its reason is not measured.
  const first: any = await metabolismView(env, SATURDAY);
  assert.equal(first.mode.power_mode, "homeostasis");
  assert.equal(first.mode.reason, null);
  await evaluateMetabolismState(env, SATURDAY);
  const v: any = await metabolismView(env, SATURDAY + 60_000);
  assert.equal(v.mode.power_mode, "survival");
  assert.match(v.mode.reason, /^market closed \(weekend\)/);
  assert.equal(v.mode.reason_at, new Date(SATURDAY).toISOString());
  assert.deepEqual(v.mode.blocked_capabilities, []);
  assert.deepEqual(v.mode.learning_capabilities, ["memory.remember", "knowledge.propose", "corrections.record"]);
  assert.deepEqual(v.mode.ai_budget, { ratio: 0.25, max_per_service: 20, max_account: 50 });
  // No billing reading: the burn and the projection are not measured (null), the budget is.
  assert.deepEqual([v.mode.budget.usd_month, v.mode.budget.projected_month_usd, v.mode.budget.burn_usd_day, v.mode.budget.burn_source], [30, null, null, "estimate"]);
  assert.deepEqual(v.mode.budget.bounds, { min: 5, max: 50 });
  // An owner override the Supervisor has not recorded yet: the mode follows it, the old cycle's reason is not shown.
  db.raw.prepare("UPDATE metabolism_controls SET value = 'homeostasis' WHERE control = 'power_mode_override'").run();
  const o: any = await metabolismView(env, SATURDAY + 120_000);
  assert.deepEqual([o.mode.power_mode, o.mode.override, o.mode.reason], ["homeostasis", "homeostasis", null]);
  // With a billing reading the projection is shown.
  db.raw.prepare("UPDATE metabolism_controls SET value = 'none' WHERE control = 'power_mode_override'").run();
  burn(db, "2026-11-14", 0.45);
  const b: any = await metabolismView(env, SATURDAY + 180_000);
  assert.deepEqual([b.mode.budget.burn_usd_day, b.mode.budget.projected_month_usd, b.mode.budget.projection_days, b.mode.budget.burn_source], [0.45, 13.5, 30, "billable_usage"]);
  assert.ok(b.rules.some((r: string) => /never blocks consensus or learning/.test(r)));
  assert.ok(!JSON.stringify(b.rules).match(/free tier/i));
});
