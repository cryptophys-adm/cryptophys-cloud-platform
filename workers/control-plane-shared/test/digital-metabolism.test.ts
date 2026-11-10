import { test } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, migratedDb } from "./harness.ts";
import { parsePolicyRequest, decide, evaluatePolicy, getActivePowerMode } from "../../policy-engine/src/index.ts";
import { observeMetabolism, computeMarketStatus } from "../../ai-kernel/src/syscall.ts";

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
  assert.equal(obs.treasury_reserve_usd, 500.0, "genesis buffer seeded");
  assert.ok(obs.infra_burn_cost_24h > 0);
  assert.equal(obs.trading_net_pnl_24h, 48.0);
  assert.ok(obs.metabolic_ratio !== null);
  assert.ok(obs.runway_days !== null && obs.runway_days > 100);
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
