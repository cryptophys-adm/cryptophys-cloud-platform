import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { baseEnv, migratedDb } from "./harness.ts";

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
import { parsePolicyRequest, decide, evaluatePolicy, getActivePowerMode } from "../../policy-engine/src/index.ts";
import { observeMetabolism, computeMarketStatus } from "../../ai-kernel/src/syscall.ts";
import { evaluateMetabolismState, runCycle } from "../../ai-kernel/src/supervisor.ts";

test("P2-M4 computeMarketStatus accurately detects gold market schedule", () => {
  // Friday 23:00 UTC -> closed
  assert.equal(computeMarketStatus(Date.UTC(2026, 10, 6, 23, 0, 0)), "closed");
  // Saturday 12:00 UTC -> closed
  assert.equal(computeMarketStatus(Date.UTC(2026, 10, 7, 12, 0, 0)), "closed");
  // Sunday 15:00 UTC -> closed
  assert.equal(computeMarketStatus(Date.UTC(2026, 10, 8, 15, 0, 0)), "closed");
  // Sunday 23:00 UTC -> open
  assert.equal(computeMarketStatus(Date.UTC(2026, 10, 8, 23, 0, 0)), "open");
  // Tuesday 14:00 UTC -> open
  assert.equal(computeMarketStatus(Date.UTC(2026, 10, 10, 14, 0, 0)), "open");
});

test("P2-M4 observeMetabolism returns treasury balance, burn rate, and ratio", async () => {
  const db = migratedDb();
  const mockXauusd = {
    fetch: async () => new Response(JSON.stringify({
      status: "ok",
      deals: [
        { deal_ticket: 2001, side: "BUY", volume: 0.1, profit: 50.0, commission: -2.0, swap: 0, net_profit: 48.0, closed_ms: Date.now() - 1000 },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  };
  const env: any = {
    ...baseEnv("cryptophys-ai-kernel", db),
    XAUUSD_AI: mockXauusd,
  };

  const obs: any = await observeMetabolism(env, Date.now());
  assert.equal(obs.source, "cryptophys-digital-metabolism");
  assert.equal(obs.power_mode, "homeostasis");
  // Owner 2026-11-11: the genesis seed is a placeholder; it is reported as such and yields no runway.
  assert.equal(obs.treasury_reserve_usd, 500.0, "the migration's placeholder");
  assert.equal(obs.treasury_source, "placeholder");
  assert.ok(obs.infra_burn_cost_24h > 0);
  assert.equal(obs.trading_net_pnl_24h, 48.0);
  assert.ok(obs.metabolic_ratio !== null);
  assert.equal(obs.runway_days, null, "no runway from a placeholder reserve");
});

test("P2-M8 an owner ledger entry makes the treasury measured; cycles before it stay marked placeholder", async () => {
  const { metabolismView } = await import("../../ai-kernel/src/metabolism-view.ts");
  const db = migratedDb();
  const env: any = { ...baseEnv("cryptophys-ai-kernel", db) };
  const t0 = Date.UTC(2026, 10, 10, 14, 0, 0);
  const first: any = await evaluateMetabolismState(env, t0);
  assert.equal(first.runway_days, null);
  assert.doesNotMatch(String(first.reason), /runway: \d/, "no runway figure in the reason");
  (db as any).raw.prepare(`INSERT INTO treasury_ledger (entry_id, entry_type, source, amount_usd, balance_after_usd, metadata_json, created_at)
    VALUES ('trz_owner_1', 'capital_injection', 'owner:reserve', 120, 120, '{}', ?)`).run(new Date(t0 + 60_000).toISOString());
  const obs: any = await observeMetabolism(env, t0 + 120_000);
  assert.equal(obs.treasury_source, "ledger");
  assert.equal(obs.treasury_reserve_usd, 120);
  assert.equal(obs.runway_days, Math.round((120 / obs.infra_burn_cost_24h) * 10) / 10);
  await evaluateMetabolismState(env, t0 + 180_000);
  const v: any = await metabolismView(env, t0 + 240_000);
  const [later, earlier] = v.cycles;
  assert.equal(later.treasury_placeholder, false);
  assert.equal(typeof later.runway_days, "number");
  assert.equal(earlier.treasury_placeholder, true);
  assert.equal(earlier.runway_days, null, "a cycle of the placeholder period shows no runway");
});

test("P2-M4 policy engine throttles non-essential capabilities during Survival Mode", async () => {
  const db = migratedDb();
  const policyEnv = baseEnv("cryptophys-policy-engine", db);

  // Default homeostasis: power mode allows syscalls
  const mode0 = await getActivePowerMode(db);
  assert.equal(mode0, "homeostasis");

  // Switch to survival mode
  await db.prepare("UPDATE metabolism_controls SET value = 'survival' WHERE control = 'power_mode'").run();
  const mode1 = await getActivePowerMode(db);
  assert.equal(mode1, "survival");

  // In survival mode, non-essential Tier 1 syscalls like memory.remember are denied
  const res = await evaluatePolicy(db, "agent.syscall", "memory.remember", { __subject: "agent:signal-analyst" });
  assert.equal(res.decision, "deny");
  const survivalCheck = res.checks.find((c) => c.id === "power_mode_survival");
  assert.ok(survivalCheck, "power_mode_survival check present");
  assert.equal(survivalCheck?.passed, false);

  // Restore homeostasis
  await db.prepare("UPDATE metabolism_controls SET value = 'homeostasis' WHERE control = 'power_mode'").run();
  const mode2 = await getActivePowerMode(db);
  assert.equal(mode2, "homeostasis");
});

test("P2-M4 supervisor evaluates digital metabolism and writes cycle records", async () => {
  const db = migratedDb();
  const env: any = {
    ...baseEnv("cryptophys-ai-kernel", db),
    POLICY: { evaluate: async () => ({ decision: "allow" }) },
    RECOVERY: { propose: async () => ({}) },
    DEPLOY: undefined,
  };
  const memStore = new Map();
  const mem = { get: async (k: string) => memStore.get(k), put: async (k: string, v: any) => { memStore.set(k, v); } };

  // Tuesday noon (market open): homeostasis
  const tOpen = Date.UTC(2026, 10, 10, 14, 0, 0);
  const eval1: any = await evaluateMetabolismState(env, tOpen);
  assert.ok(eval1);
  assert.equal(eval1.power_mode, "homeostasis");

  // Verify record written to metabolism_cycles
  const count = (db as any).raw.prepare("SELECT COUNT(*) AS n FROM metabolism_cycles").get() as any;
  assert.equal(count.n, 1);

  // Run full cycle via supervisor
  const report = await runCycle(env, mem, "operator", tOpen);
  assert.equal(report.agent_id, "supervisor");
  const metaFinding = report.findings.find((f: any) => f.kind === "metabolism");
  assert.ok(metaFinding, "metabolism finding logged in cycle report");

  // Saturday (market closed): supervisor shifts into survival mode
  const tClosed = Date.UTC(2026, 10, 7, 12, 0, 0);
  const evalClosed: any = await evaluateMetabolismState(env, tClosed);
  assert.ok(evalClosed);
  assert.equal(evalClosed.power_mode, "survival");
  assert.equal(evalClosed.mode_changed, true);

  // Verify power_mode updated in D1
  const modeDb = (db as any).raw.prepare("SELECT value FROM metabolism_controls WHERE control = 'power_mode'").get() as any;
  assert.equal(modeDb.value, "survival");
});

test("P2-M9 metabolism_cycles records a change at once, the same state once an hour, and keeps 30 days (2026-11-14)", async () => {
  const db = migratedDb();
  const env: any = { ...baseEnv("cryptophys-ai-kernel", db), POLICY: { evaluate: async () => ({ decision: "allow" }) } };
  const n = () => ((db as any).raw.prepare("SELECT COUNT(*) AS n FROM metabolism_cycles").get() as any).n;
  const t0 = Date.UTC(2026, 10, 10, 14, 8, 0); // Tuesday, market open
  const first: any = await evaluateMetabolismState(env, t0);
  assert.deepEqual([first.recorded, n()], [true, 1]);
  for (const m of [15, 30, 45]) {
    const again: any = await evaluateMetabolismState(env, t0 + m * 60_000);
    assert.deepEqual([again.recorded, again.cycle_id], [false, first.cycle_id], `same state ${m} min later is not recorded`);
  }
  assert.equal(n(), 1);
  const hourly: any = await evaluateMetabolismState(env, t0 + 60 * 60_000);
  assert.deepEqual([hourly.recorded, n()], [true, 2], "the hourly heartbeat");
  // Friday 22:00 UTC the market closes: a change is recorded at once.
  const closed: any = await evaluateMetabolismState(env, Date.UTC(2026, 10, 13, 22, 8, 0));
  assert.deepEqual([closed.recorded, closed.mode_changed, n()], [true, true, 3]);
  // An old row goes with the 03:00 UTC hour's record; the 14 days the Console shows stay.
  (db as any).raw.prepare("INSERT INTO metabolism_cycles (cycle_id, evaluated_at, market_status, trading_net_pnl_24h, infra_burn_cost_24h, metabolic_ratio, treasury_reserve_usd, runway_days, power_mode, mode_reason, actions_json) VALUES ('mtb_old', '2026-10-01T00:00:00.000Z', 'open', 0, 0.15, NULL, 0, NULL, 'homeostasis', 'x', '{}')").run();
  await evaluateMetabolismState(env, Date.UTC(2026, 10, 14, 3, 8, 0));
  assert.equal(((db as any).raw.prepare("SELECT COUNT(*) AS n FROM metabolism_cycles WHERE cycle_id = 'mtb_old'").get() as any).n, 0);
  assert.equal(n(), 4);
});

// Owner 2026-11-10: the power mode may save AI tokens, never block the platform's own safety, and
// never expand budgets from trading results.
test("P2-M5 survival mode never throttles consensus.propose (deploys, rollbacks, suspensions)", async () => {
  const db = migratedDb();
  await db.prepare("UPDATE metabolism_controls SET value = 'survival' WHERE control = 'power_mode'").run();
  const res = await evaluatePolicy(db, "agent.syscall", "consensus.propose", { __subject: "agent:supervisor" });
  assert.equal(res.checks.find((c) => c.id === "power_mode_survival"), undefined);
  assert.equal(res.decision, "allow", res.reason);
  const mem = await evaluatePolicy(db, "agent.syscall", "memory.remember", { __subject: "agent:supervisor" });
  assert.ok(mem.checks.some((c) => c.id === "power_mode_survival" && !c.passed), "memory still throttled");
});

test("P2-M5 the supervisor never enters growth on its own, and every mode change is audited", async () => {
  const db = migratedDb();
  const deals = [{ deal_ticket: 3001, side: "BUY", volume: 0.1, profit: 400, commission: 0, swap: 0, net_profit: 400, closed_ms: Date.UTC(2026, 10, 10, 13, 0, 0) }];
  const env: any = { ...baseEnv("cryptophys-ai-kernel", db), XAUUSD_AI: { fetch: async () => new Response(JSON.stringify({ status: "ok", deals }), { status: 200 }) } };
  const tOpen = Date.UTC(2026, 10, 10, 14, 0, 0);
  const r: any = await evaluateMetabolismState(env, tOpen);
  assert.equal(r.power_mode, "homeostasis");
  assert.match(r.reason, /growth eligible/);
  const mode = (db as any).raw.prepare("SELECT value FROM metabolism_controls WHERE control = 'power_mode'").get() as any;
  assert.equal(mode.value, "homeostasis");

  const closed: any = await evaluateMetabolismState(env, Date.UTC(2026, 10, 14, 12, 0, 0));
  assert.equal(closed.power_mode, "survival");
  const audit = (db as any).raw.prepare("SELECT actor, outcome, payload_json FROM audit_events WHERE event_type = 'metabolism.power_mode_changed'").all() as any[];
  assert.equal(audit.length, 1);
  assert.equal(audit[0].outcome, "survival");
  assert.equal(JSON.parse(audit[0].payload_json).previous_mode, "homeostasis");
});

test("P2-M5 growth budgets apply only as an owner override, survival savings apply automatically", async () => {
  const { AiEngine } = await import("../src/ai-engine.ts");
  const db = migratedDb();
  const reserveCount = async (n: number) => {
    const engine: any = new (AiEngine as any)({ service: "cryptophys-platform-api", ai: { run: async () => ({ response: "{}" }) }, db, dailyLimit: 4, accountDailyLimit: 100 });
    let ok = 0;
    for (let i = 0; i < n; i++) if (await engine.reserve(`2026-11-1${n}`)) ok += 1;
    return ok;
  };
  await db.prepare("UPDATE metabolism_controls SET value = 'growth' WHERE control = 'power_mode'").run();
  assert.equal(await reserveCount(8), 4, "an automatic growth mode does not raise the budget");
  await db.prepare("UPDATE metabolism_controls SET value = 'growth' WHERE control = 'power_mode_override'").run();
  assert.equal(await reserveCount(9), 8, "the owner's growth override doubles it");
  await db.prepare("UPDATE metabolism_controls SET value = 'none' WHERE control = 'power_mode_override'").run();
  await db.prepare("UPDATE metabolism_controls SET value = 'survival' WHERE control = 'power_mode'").run();
  assert.equal(await reserveCount(7), 1, "survival still saves automatically (25%)");
});

test("P2-M6 the Console's metabolism view is read-only and carries live state, cycles, ledger and audited changes", async () => {
  const { metabolismView } = await import("../../ai-kernel/src/metabolism-view.ts");
  const db = migratedDb();
  const env: any = { ...baseEnv("cryptophys-ai-kernel", db) };
  await evaluateMetabolismState(env, Date.UTC(2026, 10, 14, 12, 0, 0));
  const before = (db as any).raw.prepare("SELECT COUNT(*) AS n FROM audit_events").get().n;
  const v: any = await metabolismView(env, Date.UTC(2026, 10, 14, 12, 5, 0));
  assert.equal(v.live.power_mode, "survival");
  assert.equal(v.cycles.length, 1);
  assert.equal(v.ledger[0].entry_type, "capital_injection");
  assert.deepEqual(v.mode_changes.map((c: any) => [c.previous_mode, c.mode]), [["homeostasis", "survival"]]);
  assert.equal((db as any).raw.prepare("SELECT COUNT(*) AS n FROM audit_events").get().n, before, "the view writes nothing");
  assert.match(read("workers/ai-kernel/src/index.ts"), /path === "\/v1\/metabolism" && request\.method === "GET"/);
});

test("P2-M7 supervisor reports billable usage overages from infra_burn_metrics and logs findings", async () => {
  const db = migratedDb();
  const now = Date.UTC(2026, 10, 10, 15, 0, 0);
  (db as any).raw.prepare(
    "INSERT INTO infra_burn_metrics (metric_id, period_day, service_id, ai_neurons, estimated_cost_usd, calculated_at) VALUES ('brn_ai_kernel_20261110', '2026-11-10', 'cryptophys-ai-kernel', 10000, 1.41, '2026-11-10T12:00:00Z')"
  ).run();

  const memoryMap = new Map<string, unknown>();
  const memory = {
    get: async <T>(k: string) => memoryMap.get(k) as T | undefined,
    put: async (k: string, v: unknown) => { memoryMap.set(k, v); },
  };

  const report = await runCycle({ DB: db as never } as never, memory, "operator", now);
  const overageFinding = report.findings.find((f: any) => f.kind === "billable_usage_overage");
  assert.ok(overageFinding);
  assert.equal(overageFinding.service_id, "cryptophys-ai-kernel");
  assert.equal(overageFinding.action, "throttle_free_tier");
  assert.equal(overageFinding.outcome, "throttled");
  assert.match(String(overageFinding.why ?? ""), /1\.41 USD/);
});
