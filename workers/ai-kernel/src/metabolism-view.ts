/**
 * Read-only view of the digital metabolism for the Console (owner 2026-11-10: "buatkan panel
 * Metabolism di Console"). It shows the live power mode and treasury (observeMetabolism), the
 * recent heartbeat cycles, the treasury ledger, the estimated infrastructure burn per service and
 * the audited power-mode changes. Nothing here writes; every table is optional so the view still
 * answers before migration 0043 is applied.
 *
 * Owner 2026-11-14: `mode` says what the current power mode does: its reason (the newest recorded cycle's, and only
 * when that cycle is in the same mode; otherwise null, shown as "not measured"), the capabilities the Policy Engine
 * blocks in it, the AI budget share, and the monthly budget against the projected month (power-mode.ts).
 */
import type { JsonObject } from "../../control-plane-shared/src/http.ts";
import { powerModeEffects } from "../../control-plane-shared/src/power-mode.ts";
import { POLICY_PARAMETERS } from "../../control-plane-shared/src/policy-params.ts";
import { observeMetabolism, type SyscallEnv } from "./syscall.ts";

async function rows<T>(run: () => Promise<{ results: T[] }>): Promise<T[]> {
  try { return (await run()).results ?? []; } catch { return []; }
}

export async function metabolismView(env: SyscallEnv, now = Date.now()): Promise<JsonObject> {
  const live = await observeMetabolism(env, now);
  const since14d = new Date(now - 14 * 86_400_000).toISOString();
  const cycles = await rows(() => env.DB.prepare(
    `SELECT cycle_id, evaluated_at, market_status, trading_net_pnl_24h, infra_burn_cost_24h, metabolic_ratio, treasury_reserve_usd, runway_days, power_mode, mode_reason
     FROM metabolism_cycles WHERE evaluated_at >= ? ORDER BY evaluated_at DESC LIMIT 200`,
  ).bind(since14d).all<JsonObject>());
  const ledger = await rows(() => env.DB.prepare(
    "SELECT entry_id, entry_type, source, amount_usd, balance_after_usd, created_at FROM treasury_ledger ORDER BY created_at DESC, rowid DESC LIMIT 50",
  ).all<JsonObject>());
  // A cycle's reserve is measured only from the owner's first non-genesis ledger entry on; before it
  // the reserve was the migration's placeholder and its runway is not shown.
  const firstMeasured = (await rows(() => env.DB.prepare(
    "SELECT MIN(created_at) AS at FROM treasury_ledger WHERE source NOT LIKE 'genesis:%'",
  ).all<{ at: string | null }>()))[0]?.at ?? null;
  const cyclesShown = (cycles as Array<Record<string, unknown>>).map((c) => {
    const measured = firstMeasured !== null && String(c.evaluated_at ?? "") >= firstMeasured;
    return measured ? { ...c, treasury_placeholder: false } : { ...c, runway_days: null, treasury_placeholder: true };
  });
  const burn = await rows(() => env.DB.prepare(
    `SELECT service_id, SUM(estimated_cost_usd) AS cost_usd, SUM(worker_requests) AS requests, SUM(ai_neurons) AS ai_neurons
     FROM infra_burn_metrics WHERE period_day >= ? GROUP BY service_id ORDER BY cost_usd DESC`,
  ).bind(since14d.slice(0, 10)).all<JsonObject>());
  const changes = await rows(() => env.DB.prepare(
    "SELECT actor, outcome, payload_json, created_at FROM audit_events WHERE event_type = 'metabolism.power_mode_changed' ORDER BY created_at DESC LIMIT 20",
  ).all<{ actor: string; outcome: string; payload_json: string; created_at: string }>());
  const effectiveMode = typeof live.power_mode === "string" ? live.power_mode : null;
  const newest = (cycles as Array<Record<string, unknown>>)[0] ?? null;
  const reasonCycle = newest && newest.power_mode === effectiveMode ? newest : null;
  const effects = powerModeEffects(effectiveMode, live.power_mode_override);
  const budget = POLICY_PARAMETERS["infra-budget-usd-month"];
  const mode = {
    power_mode: effectiveMode,
    override: typeof live.power_mode_override === "string" && live.power_mode_override !== "none" ? live.power_mode_override : null,
    reason: reasonCycle ? String(reasonCycle.mode_reason ?? "") || null : null,
    reason_at: reasonCycle ? String(reasonCycle.evaluated_at ?? "") || null : null,
    // null when the mode was not reported: the Console shows "not measured", never an empty list.
    blocked_capabilities: effects ? effects.blocked_capabilities : null,
    learning_capabilities: effects ? effects.learning_capabilities : null,
    never_throttled: effects ? effects.never_throttled : null,
    ai_budget: effects ? effects.ai_budget : null,
    budget: {
      parameter: "infra-budget-usd-month",
      usd_month: typeof live.infra_budget_usd_month === "number" ? live.infra_budget_usd_month : null,
      bounds: { min: budget.min, max: budget.max },
      projected_month_usd: typeof live.infra_projected_month_usd === "number" ? live.infra_projected_month_usd : null,
      projection_days: typeof live.infra_projection_days === "number" ? live.infra_projection_days : null,
      burn_usd_day: live.infra_burn_source === "estimate" ? null : (typeof live.infra_burn_cost_24h === "number" ? live.infra_burn_cost_24h : null),
      burn_source: typeof live.infra_burn_source === "string" ? live.infra_burn_source : null,
      method: "daily burn from the Billable Usage API (cycle cost to date / days observed) x days in the UTC month",
    },
  };
  return {
    live,
    mode: mode as unknown as JsonObject,
    cycles: cyclesShown as unknown as JsonObject[],
    ledger: ledger as unknown as JsonObject[],
    burn_14d: burn as unknown as JsonObject[],
    mode_changes: changes.map((c) => {
      let p: Record<string, unknown> = {};
      try { p = JSON.parse(c.payload_json); } catch { p = {}; }
      return { actor: c.actor, mode: c.outcome, previous_mode: String(p.previous_mode ?? ""), reason: String(p.reason ?? ""), at: c.created_at };
    }) as unknown as JsonObject[],
    rules: [
      "Survival throttles AI-heavy work only (AI request budgets at 25%); it never blocks consensus or learning (memory.remember, knowledge.propose).",
      "Learning is the highest mandate: no rate limit, no daily cap, and its AI calls are never refused by an AI budget in any mode (still metered).",
      "Survival starts when the market is closed, the projected month of Cloudflare spend exceeds the monthly budget (infra-budget-usd-month), a deal result under -100 USD in 24 h, or under 7 days of runway.",
      "Growth (doubled AI budgets) applies only with the owner's power_mode_override.",
      "The treasury reads deal results only; nothing places orders or moves funds.",
      "Until the owner records a treasury entry, the reserve is the migration's placeholder and no runway is shown.",
    ] as unknown as JsonObject[],
  };
}
