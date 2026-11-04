// Cloudflare Workflows (ADR-0006): the recovery plan lifecycle and the Signal Engine ingest
// pipeline, run against the real migrations with a fake step engine (harness.fakeWorkflow).
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVER_EMAIL, APPROVER_JWT, OPERATOR_EMAIL, OPERATOR_JWT, accessCertsResponse, baseEnv, call, fakeWorkflow, isAccessCerts, migratedDb, req,
} from "./harness.ts";
import { verifyAuditChain } from "../src/audit.ts";
import recovery from "../../recovery-manager/src/index.ts";
import { runLifecycle, windows } from "../../recovery-manager/src/lifecycle.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { Pacer, scheduleIngest, setPacer } from "../../signal-engine/src/index.ts";
import { SERIES_RETRIES, runIngest } from "../../signal-engine/src/ingest-workflow.ts";

// ---------------------------------------------------------------- recovery lifecycle

function recoveryEnv(db = migratedDb(), wf = fakeWorkflow(), extra: Record<string, unknown> = {}) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  return {
    ...baseEnv("cryptophys-recovery-manager", db),
    APPROVER_IDENTITIES: `${OPERATOR_EMAIL},${APPROVER_EMAIL}`,
    RECOVERY_LIFECYCLE: wf.binding,
    POLICY: {
      evaluate: async (input: Record<string, unknown>) => {
        const parsed = parsePolicyRequest(input);
        if (parsed instanceof Error) throw parsed;
        return decide(policyEnv as never, parsed);
      },
    },
    ...extra,
  };
}
const PLAN = { service_id: "cryptophys-platform-api", plan_version: "1", title: "Roll back Platform API", rationale: "Bad release",
  steps: [{ action: "rollback_worker_version", description: "Roll back to the previous version" }] };
const START = { phase: "start", operator_acknowledged: true };
const past = () => new Date(Date.now() - 60_000).toISOString();

async function newPlan(env: ReturnType<typeof recoveryEnv>) {
  const created = await call(recovery, env, req("POST", "/v1/plans", PLAN, OPERATOR_JWT));
  assert.equal(created.status, 201);
  return created.body.plan;
}
const auditTypes = (db: ReturnType<typeof migratedDb>, id: string) =>
  db.raw.prepare("SELECT event_type FROM audit_events WHERE subject = ? AND event_type LIKE 'recovery.%' ORDER BY rowid").all(id).map((r: any) => r.event_type);

test("windows: defaults, bounds and overrides", () => {
  assert.deepEqual(windows({} as never), { approval: 72, execution: 24, finish: 24 });
  assert.deepEqual(windows({ RECOVERY_APPROVAL_WINDOW_HOURS: "12", RECOVERY_EXECUTION_WINDOW_HOURS: "0", RECOVERY_FINISH_WINDOW_HOURS: "x" } as never),
    { approval: 12, execution: 24, finish: 24 }, "invalid or out-of-range values fall back to the default");
});

test("each plan starts a lifecycle instance with stored deadlines; readiness requires the binding", async () => {
  const wf = fakeWorkflow();
  const env = recoveryEnv(migratedDb(), wf);
  assert.equal((await call(recovery, env, req("GET", "/ready"))).body.checks.lifecycle_workflow, true);
  const without = await call(recovery, { ...env, RECOVERY_LIFECYCLE: undefined }, req("GET", "/ready"));
  assert.deepEqual([without.status, without.body.checks.lifecycle_workflow], [503, false]);

  const plan = await newPlan(env);
  assert.deepEqual(wf.created, [{ id: plan.plan_id, params: { plan_id: plan.plan_id } }]);
  assert.equal(plan.workflow_instance_id, plan.plan_id);
  const hours = (Date.parse(plan.approve_by) - Date.parse(plan.created_at)) / 3_600_000;
  assert.ok(hours > 71.9 && hours <= 72.01, `approval window is 72 h (got ${hours})`);

  // A Workflows outage does not block recovery: the deadline is still stored and enforced.
  const down = recoveryEnv(migratedDb(), fakeWorkflow({ failCreate: true }));
  const p2 = await newPlan(down);
  assert.equal(p2.workflow_instance_id, null);
  assert.ok(p2.approve_by);
});

test("happy path: events wake the instance, nothing is closed, the trail is unchanged", async () => {
  const db = migratedDb();
  const wf = fakeWorkflow();
  const env = recoveryEnv(db, wf);
  const plan = await newPlan(env);
  const approved = await call(recovery, env, req("POST", `/v1/plans/${plan.plan_id}/approve`, {}, APPROVER_JWT));
  assert.equal(approved.body.plan.status, "approved");
  assert.ok(approved.body.plan.execute_by);
  assert.equal((await call(recovery, env, req("POST", `/v1/plans/${plan.plan_id}/executions`, START))).body.plan.status, "executing");
  assert.equal((await call(recovery, env, req("POST", `/v1/plans/${plan.plan_id}/executions`, { phase: "finish", outcome: "completed" }))).body.plan.status, "completed");
  assert.deepEqual(wf.events[plan.plan_id], ["plan-approved", "execution-started", "execution-finished"]);

  const step = wf.step(plan.plan_id);
  const out = await runLifecycle(env as never, plan.plan_id, plan.plan_id, step as never);
  assert.deepEqual(out, { plan_id: plan.plan_id, final_status: "completed", closed: [] });
  assert.deepEqual(step.timedOut, []);
  assert.deepEqual(auditTypes(db, plan.plan_id), ["recovery.plan_created", "recovery.plan_approved", "recovery.execution_started", "recovery.execution_finished"]);
});

test("an unapproved plan expires when its approval window closes, and the handler refuses late approval", async () => {
  const db = migratedDb();
  const wf = fakeWorkflow();
  const env = recoveryEnv(db, wf);
  const plan = await newPlan(env);
  // Still open: the instance waits out the window and changes nothing.
  const early = await runLifecycle(env as never, plan.plan_id, plan.plan_id, wf.step(plan.plan_id) as never);
  assert.equal(early.final_status, "draft");
  assert.deepEqual(early.closed, []);

  // The handlers enforce the stored deadline even before the Workflow runs.
  db.raw.prepare("UPDATE recovery_plans SET approve_by = ? WHERE plan_id = ?").run(past(), plan.plan_id);
  const late = await call(recovery, env, req("POST", `/v1/plans/${plan.plan_id}/approve`, {}, APPROVER_JWT));
  assert.deepEqual([late.status, late.body.error], [409, "approval_window_closed"]);

  const out = await runLifecycle(env as never, plan.plan_id, plan.plan_id, wf.step(plan.plan_id) as never);
  assert.deepEqual(out, { plan_id: plan.plan_id, final_status: "disabled", closed: ["draft"] });
  const row = db.raw.prepare("SELECT status, disabled_reason FROM recovery_plans WHERE plan_id = ?").get(plan.plan_id) as any;
  assert.deepEqual([row.status, row.disabled_reason], ["disabled", "approval_expired"]);
  assert.deepEqual(auditTypes(db, plan.plan_id), ["recovery.plan_created", "recovery.plan_expired"]);
  // Idempotent: a replay finds nothing left to close.
  const again = await runLifecycle(env as never, plan.plan_id, plan.plan_id, wf.step(plan.plan_id) as never);
  assert.deepEqual(again.closed, []);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("an approval lapses when execution does not start in time; execution of a lapsed plan is refused", async () => {
  const db = migratedDb();
  const wf = fakeWorkflow();
  const env = recoveryEnv(db, wf);
  const plan = await newPlan(env);
  await call(recovery, env, req("POST", `/v1/plans/${plan.plan_id}/approve`, {}, APPROVER_JWT));
  db.raw.prepare("UPDATE recovery_plans SET execute_by = ? WHERE plan_id = ?").run(past(), plan.plan_id);
  const refused = await call(recovery, env, req("POST", `/v1/plans/${plan.plan_id}/executions`, START));
  assert.deepEqual([refused.status, refused.body.error], [409, "execution_window_closed"]);

  const out = await runLifecycle(env as never, plan.plan_id, plan.plan_id, wf.step(plan.plan_id) as never);
  assert.deepEqual(out.closed, ["approved"]);
  const row = db.raw.prepare("SELECT status, disabled_reason FROM recovery_plans WHERE plan_id = ?").get(plan.plan_id) as any;
  assert.deepEqual([row.status, row.disabled_reason], ["disabled", "approval_lapsed"]);
});

test("an overdue execution is raised, never resolved automatically", async () => {
  const db = migratedDb();
  const wf = fakeWorkflow();
  const env = recoveryEnv(db, wf);
  const plan = await newPlan(env);
  await call(recovery, env, req("POST", `/v1/plans/${plan.plan_id}/approve`, {}, APPROVER_JWT));
  await call(recovery, env, req("POST", `/v1/plans/${plan.plan_id}/executions`, START));
  db.raw.prepare("UPDATE recovery_plans SET finish_by = ? WHERE plan_id = ?").run(past(), plan.plan_id);
  const out = await runLifecycle(env as never, plan.plan_id, plan.plan_id, wf.step(plan.plan_id) as never);
  assert.deepEqual(out, { plan_id: plan.plan_id, final_status: "executing", closed: ["executing"] });
  assert.equal((db.raw.prepare("SELECT status FROM recovery_plans WHERE plan_id = ?").get(plan.plan_id) as any).status, "executing");
  assert.equal(auditTypes(db, plan.plan_id).at(-1), "recovery.execution_overdue");
  // The operator can still record the outcome.
  const finished = await call(recovery, env, req("POST", `/v1/plans/${plan.plan_id}/executions`, { phase: "finish", outcome: "failed" }));
  assert.equal(finished.body.plan.status, "failed");
});

test("disabling a plan terminates its instance; plans created before 0009 have no window", async () => {
  const db = migratedDb();
  const wf = fakeWorkflow();
  const env = recoveryEnv(db, wf);
  const plan = await newPlan(env);
  const disabled = await call(recovery, env, req("POST", `/v1/plans/${plan.plan_id}/disable`, {}));
  assert.equal(disabled.body.plan.disabled_reason, "operator");
  assert.deepEqual(wf.terminated, [plan.plan_id]);

  const legacy = await newPlan(env);
  db.raw.prepare("UPDATE recovery_plans SET approve_by = NULL WHERE plan_id = ?").run(legacy.plan_id);
  const out = await runLifecycle(env as never, legacy.plan_id, legacy.plan_id, wf.step(legacy.plan_id) as never);
  assert.deepEqual(out, { plan_id: legacy.plan_id, final_status: "draft", closed: [] });
  assert.equal((await call(recovery, env, req("POST", `/v1/plans/${legacy.plan_id}/approve`, {}, APPROVER_JWT))).body.plan.status, "approved");
});

// ---------------------------------------------------------------- signal ingest

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 3, 12, 4);
const realFetch = globalThis.fetch;
beforeEach(() => { setPacer(new Pacer(async () => undefined, () => 0)); });
afterEach(() => { globalThis.fetch = realFetch; });

function krakenRow(i: number): unknown[] {
  const open = NOW - (NOW % H) - (300 - i) * H;
  const c = 60000 + Math.cos(i / 5) * 300 + i;
  return [open / 1000, String(c - 5), String(c + 20), String(c - 25), String(c), String(c), String(1 + (i % 7) / 10), 42];
}
function market(handler: (url: URL) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (isAccessCerts(url)) return accessCertsResponse();
    const u = new URL(url);
    if (u.hostname === "api.alternative.me") return Response.json({ data: [{ value: "40", value_classification: "Fear", timestamp: "1793750400" }] });
    if (u.hostname === "api.coinlore.com") return Response.json([{ total_mcap: 2.9e12, btc_d: "58.4" }]);
    return handler(u);
  }) as typeof fetch;
}
const signalEnv = (db = migratedDb(), extra: Record<string, unknown> = {}) =>
  baseEnv("cryptophys-signal-engine", db, { SYMBOLS: "BTCUSDT,SOLUSDT", TIMEFRAMES: "1h", MARKET_DATA_PROVIDER: "kraken", ...extra });

test("ingest Workflow: one durable step per series, transient failures retried by the step, the run is recorded", async () => {
  const db = migratedDb();
  const wf = fakeWorkflow();
  let solCalls = 0;
  market((url) => {
    // SOL is rate limited on the first two Workflow attempts (each makes the in-step retry too).
    if (url.searchParams.get("pair") === "SOLUSDT" && solCalls++ < 4) return Response.json({ error: ["EGeneral:Too many requests"] });
    return Response.json({ error: [], result: { [url.searchParams.get("pair")!]: [krakenRow(298), krakenRow(299), krakenRow(300)], last: 0 } });
  });
  const step = wf.step("ingest-x");
  const out = await runIngest(signalEnv(db) as never, { now: NOW, trigger: "scheduled" }, "ingest-x", step as never);
  assert.deepEqual(out.failed, 0);
  assert.deepEqual(step.names, ["start", "series BTCUSDT 1h", "derive BTCUSDT", "series SOLUSDT 1h", "derive SOLUSDT", "macro", "record run"]);
  assert.equal(step.attempts["series SOLUSDT 1h"], 3, "two rate-limited attempts, then success");
  assert.equal(step.attempts["series BTCUSDT 1h"], 1, "a stored series is not fetched again");
  const run = db.raw.prepare("SELECT trigger, series_failed, workflow_instance_id FROM signal_ingest_runs").get() as any;
  assert.deepEqual([run.trigger, run.series_failed, run.workflow_instance_id], ["scheduled", 0, "ingest-x"]);
});

test("ingest Workflow: after the last retry the failure is recorded, and non-transient errors are not retried", async () => {
  const db = migratedDb();
  market((url) => url.searchParams.get("pair") === "SOLUSDT"
    ? Response.json({ error: ["EGeneral:Too many requests"] })
    : new Response("gone", { status: 404 }));
  const step = fakeWorkflow().step("ingest-y");
  const out = await runIngest(signalEnv(db) as never, { now: NOW, trigger: "scheduled" }, "ingest-y", step as never);
  assert.equal(out.failed, 2);
  assert.equal(step.attempts["series SOLUSDT 1h"], SERIES_RETRIES.limit + 1);
  assert.equal(step.attempts["series BTCUSDT 1h"], 1, "HTTP 404 is not transient");
  const results = JSON.parse((db.raw.prepare("SELECT results_json FROM signal_ingest_runs").get() as any).results_json);
  assert.deepEqual(results.filter((r: any) => r.symbol !== "MACRO").map((r: any) => r.error),
    ["market_data_http_404", "provider_error: EGeneral:Too many requests"]);
});

test("the cron creates one instance per firing; duplicates are ignored; without the binding it runs inline", async () => {
  const wf = fakeWorkflow();
  const db = migratedDb();
  const id = await scheduleIngest(signalEnv(db, { INGEST_WORKFLOW: wf.binding }) as never, NOW);
  assert.equal(id, "ingest-2026-11-03T12-04-00-000Z");
  assert.deepEqual(wf.created, [{ id, params: { now: NOW, trigger: "scheduled" } }]);
  assert.equal(await scheduleIngest(signalEnv(db, { INGEST_WORKFLOW: wf.binding }) as never, NOW), id, "a duplicate firing is a no-op");
  assert.equal(wf.created.length, 1);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM signal_ingest_runs").get() as any).n, 0, "the Workflow, not the cron, ingests");

  market(() => Response.json({ error: [], result: { XBTUSDT: [krakenRow(299), krakenRow(300)], last: 0 } }));
  const inline = await scheduleIngest(signalEnv(db, { SYMBOLS: "BTCUSDT" }) as never, NOW);
  assert.match(inline, /^sig_/);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM signal_ingest_runs WHERE workflow_instance_id IS NULL").get() as any).n, 1);
});
