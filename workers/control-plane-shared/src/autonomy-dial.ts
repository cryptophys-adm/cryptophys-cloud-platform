// HAIC H4 (ADR-0017 H4 §5; the owner's answers of 2026-11-18): the autonomy dial, per group of consensus actions.
//
// Four levels: observe → suggest → owner_click (execute after the owner's click) → consensus (execute on consensus).
// The dial is a STRICTER overlay on the ADR-0009 classes (CONSENSUS_ACTIONS); it never changes the catalog:
//   - an action's ceiling is its ADR-0009 class: routine → consensus, critical → owner_click, prohibited → none;
//   - a trading action (TRADING_CAPABILITY) never rises above owner_click (ADR-0017 §5);
//   - the owner's click lowers a group to any level and raises it back, at most to the group's ceiling
//     ("Hanya turun dari ADR"). Raising a critical action to consensus still needs a new ADR and a reviewed change.
//   - an action's effective level is min(its group's level, its own ceiling).
// Raise proposals (owner: "30 eksekusi/14 hari, ≥95%"): a group below its ceiling with at least 30 executions in 14
// days, at least 95% of them succeeded and no regression is shown to the owner as ready to raise; only the owner raises.
// Auto-downgrade (owner: "Ya, turun satu level"): a regression attributed to a group lowers it one level at once.
//
// Pure: no bindings, no I/O, no clock but the `now` given. This file is a guard path (consensus_kill_switch).
import { CONSENSUS_ACTIONS, classify } from "./consensus-rules.ts";
import { TRADING_CAPABILITY } from "./capabilities.ts";

export const AUTONOMY_LEVELS = ["observe", "suggest", "owner_click", "consensus"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
export const LEVEL_RANK: Readonly<Record<AutonomyLevel, number>> = { observe: 0, suggest: 1, owner_click: 2, consensus: 3 };
export const LEVEL_LABEL: Readonly<Record<AutonomyLevel, string>> = {
  observe: "observe", suggest: "suggest", owner_click: "execute after the owner's click", consensus: "execute on consensus",
};
export const isAutonomyLevel = (v: unknown): v is AutonomyLevel => typeof v === "string" && (AUTONOMY_LEVELS as readonly string[]).includes(v);
const lower = (a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel => (LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b);

export const AUTONOMY_GROUPS = ["deploys", "merges", "recovery", "registry", "agents", "policy", "protected", "trading"] as const;
export type AutonomyGroup = (typeof AUTONOMY_GROUPS)[number];
export const isAutonomyGroup = (v: unknown): v is AutonomyGroup => typeof v === "string" && (AUTONOMY_GROUPS as readonly string[]).includes(v);

/** Every action of CONSENSUS_ACTIONS is in exactly one group (a test pins it); a trading action is always "trading". */
export const GROUP_ACTIONS: Readonly<Record<Exclude<AutonomyGroup, "trading">, readonly string[]>> = {
  deploys: ["deploy_commit", "redeploy_desired_version", "deploy_destructive_migration"],
  merges: ["merge_change", "merge_owner_change"],
  recovery: ["rollback_worker_version", "observe_drift"],
  registry: ["set_desired_version", "registry_disable_service", "registry_enable_service", "retire_worker"],
  agents: ["suspend_agent", "resume_agent", "retire_agent", "register_agent", "update_agent_capabilities", "register_engine", "retire_engine", "register_privileged_agent", "update_privileged_agent_capabilities", "admit_voter", "register_principal"],
  policy: ["set_policy_parameter", "amend_doctrine", "amend_constitution"],
  protected: ["restore_d1_bookmark", "rotate_secret", "change_access", "agents_enable"],
};
export const GROUP_LABEL: Readonly<Record<AutonomyGroup, string>> = {
  deploys: "Deploys", merges: "Merges into main", recovery: "Rollback and drift", registry: "Platform Registry",
  agents: "Agents and engines", policy: "Policy and doctrine", protected: "Data, secrets and Access", trading: "Trading",
};

export function groupOf(action: string): AutonomyGroup | null {
  if (TRADING_CAPABILITY.test(action)) return "trading";
  for (const g of Object.keys(GROUP_ACTIONS) as (keyof typeof GROUP_ACTIONS)[]) if (GROUP_ACTIONS[g].includes(action)) return g;
  return null;
}

/** The highest level the ADRs allow an action: its ADR-0009 class; trading at most owner_click; prohibited none. */
export function actionCeiling(action: string): AutonomyLevel | null {
  const cls = classify(action);
  if (!cls || cls === "prohibited") return null;
  if (TRADING_CAPABILITY.test(action)) return "owner_click";
  return cls === "routine" ? "consensus" : "owner_click";
}

/** The highest level the owner can set a group to: the highest ceiling of its actions (trading: owner_click). */
export function groupCeiling(group: AutonomyGroup): AutonomyLevel {
  if (group === "trading") return "owner_click";
  return GROUP_ACTIONS[group].reduce<AutonomyLevel>((top, a) => {
    const c = actionCeiling(a);
    return c && LEVEL_RANK[c] > LEVEL_RANK[top] ? c : top;
  }, "observe");
}

/** An action's effective level, given its group's dial level (absent: the group's ceiling, i.e. today's ADR-0009). */
export function effectiveLevel(action: string, groupLevel: AutonomyLevel | null | undefined): AutonomyLevel | null {
  const ceiling = actionCeiling(action);
  const group = groupOf(action);
  if (!ceiling || !group) return null;
  return lower(ceiling, groupLevel ?? groupCeiling(group));
}

/** Whether the owner may set a group to a level: any level up to the group's ceiling; never above it. */
export function setLevelProblem(group: unknown, level: unknown): string | null {
  if (!isAutonomyGroup(group)) return "unknown group";
  if (!isAutonomyLevel(level)) return `level must be one of ${AUTONOMY_LEVELS.join(", ")}`;
  const ceiling = groupCeiling(group);
  if (LEVEL_RANK[level] > LEVEL_RANK[ceiling]) return `${group} cannot rise above ${ceiling} (ADR-0009 class; a higher level needs a new ADR)`;
  return null;
}

/** The phrase the owner types to set a level, e.g. "SET DEPLOYS OWNER_CLICK". */
export const setPhrase = (group: AutonomyGroup, level: AutonomyLevel) => `SET ${group.toUpperCase()} ${level.toUpperCase()}`;

/** One level down (observe stays observe). */
export function oneLevelDown(level: AutonomyLevel): AutonomyLevel {
  return AUTONOMY_LEVELS[Math.max(0, LEVEL_RANK[level] - 1)];
}

// ---- Evidence ----------------------------------------------------------------------------------------------------------

export const RAISE_RULE = { window_days: 14, min_executions: 30, min_success: 0.95 } as const;
/** A rollback of the same target within this long after an executed deploy is that deploy's regression. */
export const ROLLBACK_ATTRIBUTION_MS = 2 * 3_600_000;
/** This many failed executions in a row, the latest within 24 h, are a regression of their group. */
export const CONSECUTIVE_FAILURES = 3;

/** One executed (or failed) consensus action, as consensus_proposals records it. */
export interface ExecutionRow { proposal_id: string; action: string; target: string; status: string; decided_at: string }

export interface Regression { group: AutonomyGroup; kind: "rollback_after_deploy" | "consecutive_failures"; at: string; ref: string; detail: string }

/**
 * Regressions in the rows (oldest first or any order): a rollback_worker_version executed on a target within 2 h after
 * an executed deploy_commit or redeploy_desired_version of it (the deploys group's), and three failed executions in a
 * row in one group, the latest within 24 h of `now`.
 */
export function regressions(rows: readonly ExecutionRow[], now: number): Regression[] {
  const sorted = [...rows].filter((r) => r.status === "executed" || r.status === "failed").sort((a, b) => a.decided_at.localeCompare(b.decided_at));
  const out: Regression[] = [];
  for (const rb of sorted) {
    if (rb.action !== "rollback_worker_version" || rb.status !== "executed") continue;
    const t = Date.parse(rb.decided_at);
    const deploy = sorted.filter((d) => (d.action === "deploy_commit" || d.action === "redeploy_desired_version") && d.status === "executed" && d.target === rb.target)
      .filter((d) => { const dt = Date.parse(d.decided_at); return dt <= t && t - dt <= ROLLBACK_ATTRIBUTION_MS; }).pop();
    if (deploy) out.push({ group: "deploys", kind: "rollback_after_deploy", at: rb.decided_at, ref: deploy.proposal_id, detail: `${rb.target} was rolled back after the deploy ${deploy.proposal_id}` });
  }
  const byGroup = new Map<AutonomyGroup, ExecutionRow[]>();
  for (const r of sorted) { const g = groupOf(r.action); if (g) byGroup.set(g, [...(byGroup.get(g) ?? []), r]); }
  for (const [g, list] of byGroup) {
    const last = list.slice(-CONSECUTIVE_FAILURES);
    if (last.length === CONSECUTIVE_FAILURES && last.every((r) => r.status === "failed") && now - Date.parse(last[last.length - 1].decided_at) <= 86_400_000) {
      const l = last[last.length - 1];
      out.push({ group: g, kind: "consecutive_failures", at: l.decided_at, ref: l.proposal_id, detail: `the last ${CONSECUTIVE_FAILURES} executions failed (latest ${l.action} on ${l.target})` });
    }
  }
  return out;
}

export interface GroupStats { executions: number; succeeded: number; success_rate: number | null; regressions: number }

/** A group's executions in the raise window (rows already limited to it or not: filtered here). */
export function groupStats(group: AutonomyGroup, rows: readonly ExecutionRow[], now: number): GroupStats {
  const since = now - RAISE_RULE.window_days * 86_400_000;
  const mine = rows.filter((r) => groupOf(r.action) === group && (r.status === "executed" || r.status === "failed") && Date.parse(r.decided_at) >= since);
  const succeeded = mine.filter((r) => r.status === "executed").length;
  const regs = regressions(rows.filter((r) => Date.parse(r.decided_at) >= since), now).filter((x) => x.group === group).length;
  return { executions: mine.length, succeeded, success_rate: mine.length ? succeeded / mine.length : null, regressions: regs };
}

/** Whether a group below its ceiling has the evidence to be proposed for one level up. */
export function raiseReady(group: AutonomyGroup, level: AutonomyLevel, stats: GroupStats): AutonomyLevel | null {
  if (LEVEL_RANK[level] >= LEVEL_RANK[groupCeiling(group)]) return null;
  if (stats.executions < RAISE_RULE.min_executions || (stats.success_rate ?? 0) < RAISE_RULE.min_success || stats.regressions > 0) return null;
  return AUTONOMY_LEVELS[LEVEL_RANK[level] + 1];
}

/** Every catalog action, with its group: used by the test that pins the grouping. */
export const CATALOG_ACTIONS: readonly string[] = Object.keys(CONSENSUS_ACTIONS);
