/**
 * Read-only view of the digital metabolism for the Console (owner 2026-11-10: "buatkan panel
 * Metabolism di Console"). It shows the live power mode and treasury (observeMetabolism), the
 * recent heartbeat cycles, the treasury ledger, the estimated infrastructure burn per service and
 * the audited power-mode changes. Nothing here writes; every table is optional so the view still
 * answers before migration 0043 is applied.
 */
import type { JsonObject } from "../../control-plane-shared/src/http.ts";
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
  const burn = await rows(() => env.DB.prepare(
    `SELECT service_id, SUM(estimated_cost_usd) AS cost_usd, SUM(worker_requests) AS requests, SUM(ai_neurons) AS ai_neurons
     FROM infra_burn_metrics WHERE period_day >= ? GROUP BY service_id ORDER BY cost_usd DESC`,
  ).bind(since14d.slice(0, 10)).all<JsonObject>());
  const changes = await rows(() => env.DB.prepare(
    "SELECT actor, outcome, payload_json, created_at FROM audit_events WHERE event_type = 'metabolism.power_mode_changed' ORDER BY created_at DESC LIMIT 20",
  ).all<{ actor: string; outcome: string; payload_json: string; created_at: string }>());
  return {
    live,
    cycles: cycles as unknown as JsonObject[],
    ledger: ledger as unknown as JsonObject[],
    burn_14d: burn as unknown as JsonObject[],
    mode_changes: changes.map((c) => {
      let p: Record<string, unknown> = {};
      try { p = JSON.parse(c.payload_json); } catch { p = {}; }
      return { actor: c.actor, mode: c.outcome, previous_mode: String(p.previous_mode ?? ""), reason: String(p.reason ?? ""), at: c.created_at };
    }) as unknown as JsonObject[],
    rules: [
      "Survival throttles only AI spending (memory, knowledge, AI budgets at 25%); it never blocks consensus.",
      "Growth (doubled AI budgets) applies only with the owner's power_mode_override.",
      "The treasury reads deal results only; nothing places orders or moves funds.",
    ] as unknown as JsonObject[],
  };
}
