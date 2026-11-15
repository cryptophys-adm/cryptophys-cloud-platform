/**
 * Break-glass recovery deploy (owner-approved hardening (d), after the 2026-11-14 incident: the deploy planner stopped
 * planning any unit, so no consensus path could deploy anything, its own fix included).
 *
 * A recovery plan step `force_redeploy_unit` deploys ONE deploy unit (the unit of the plan's service) natively from
 * the Forge's bundles of main's head, applying the D1 migrations that main has and D1 has not applied. It skips the
 * planner (forgePlan / orderPending) and has no drift precondition. Everything else stays: the owner's click (the
 * plan's approval), the Policy Engine's recovery.execute allow, the deploy lock, live verification and restore on
 * failure, the audit chain and a critical report that reaches the owner's Telegram.
 *
 * These are the plan rules every party checks (Recovery Manager when the plan is created, Policy Engine before it
 * runs, Deployment Orchestrator before it queues). Pure functions only.
 *
 * - The plan is written and approved by people: never an agent (`agent:<id>`), never a service token (`*.access`).
 *   AI drafts never contain the step (ai-kernel/src/supervisor.ts AI_DRAFT_STEP_ACTIONS).
 * - plan_version is the full 40-hex commit: the owner approves exactly that commit of main.
 * - One force_redeploy_unit step; other steps are only `manual` notes.
 * - A destructive migration (DESTRUCTIVE_SQL) is applied only when the step names its file in
 *   `destructive_migrations`. A named file that is not a pending destructive migration refuses the deploy.
 * - Gate 4 part B (owner 2026-11-15: after cut-over step 6 there is no GitHub fallback, so a destructive topology change
 *   needs an owner-click native path): a destructive topology change of the deploy (deployment-orchestrator/src/
 *   topology.ts) is applied only when the step names it in `destructive_topology`, one item each (TOPOLOGY_ITEM):
 *     `custom_domain_removal:<host>`, `custom_domain_change:<host>` (a custom domain's zone fields),
 *     `do_migration:<deleted_classes|renamed_classes|transferred_classes>:<worker>:<tag>`, `workflow_removal:<name>`,
 *     `workers_dev_disable:<worker>`, `preview_urls_disable:<worker>`.
 *   An unnamed one keeps its refusal; a named one the deploy does not contain refuses the deploy. A zone route can never
 *   be named: creating or removing one needs Workers Routes Edit, which the deploy token does not hold (owner decision
 *   2026-11-06, ADR-0010).
 *
 * This file is a guard path (guard-paths.ts, break_glass).
 */

export const BREAK_GLASS_STEP = "force_redeploy_unit";
/** A migration file of workers/control-plane-migrations/. */
export const MIGRATION_FILE_NAME = /^[0-9]{4}_[a-z0-9_]{1,80}\.sql$/;
export const MAX_NAMED_DESTRUCTIVE = 10;
const HOSTNAME = "[a-z0-9-]+(?:\\.[a-z0-9-]+)+";
const WORKER_NAME = "[a-z0-9-]{1,63}";
/** One destructive topology item a break-glass plan may name (topology.ts uses the same strings). */
export const TOPOLOGY_ITEM = new RegExp(
  `^(?:custom_domain_(?:removal|change):${HOSTNAME}|do_migration:(?:deleted_classes|renamed_classes|transferred_classes):${WORKER_NAME}:[A-Za-z0-9._-]{1,64}`
  + `|workflow_removal:[A-Za-z0-9_-]{1,64}|(?:workers_dev|preview_urls)_disable:${WORKER_NAME})$`,
);
const COMMIT = /^[0-9a-f]{40}$/;
const PERSON = /^[^@\s:]+@[^@\s:]+\.[^@\s:]+$/;

export interface PlanStep { action: string; description: string; destructive_migrations?: string[]; destructive_topology?: string[] }

/** A person's Access identity (an email), not an agent and not a service token. */
export function isPersonActor(actor: unknown): actor is string {
  return typeof actor === "string" && PERSON.test(actor) && !actor.startsWith("agent:") && !actor.endsWith(".access");
}

/** Validate the optional destructive_migrations field of a raw step; returns the sorted list or an Error. */
export function namedDestructive(raw: unknown): string[] | Error {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_NAMED_DESTRUCTIVE || !raw.every((f) => typeof f === "string" && MIGRATION_FILE_NAME.test(f))) {
    return new Error(`destructive_migrations must list at most ${MAX_NAMED_DESTRUCTIVE} migration file names (NNNN_name.sql)`);
  }
  const files = [...new Set(raw as string[])].sort();
  if (files.length !== raw.length) return new Error("destructive_migrations lists a file twice");
  return files;
}

/** Validate the optional destructive_topology field of a raw step; returns the sorted list or an Error. */
export function namedTopology(raw: unknown): string[] | Error {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_NAMED_DESTRUCTIVE || !raw.every((f) => typeof f === "string" && f.length <= 200 && TOPOLOGY_ITEM.test(f))) {
    return new Error(`destructive_topology must list at most ${MAX_NAMED_DESTRUCTIVE} items (custom_domain_removal:<host>, custom_domain_change:<host>, `
      + "do_migration:<deleted_classes|renamed_classes|transferred_classes>:<worker>:<tag>, workflow_removal:<name>, workers_dev_disable:<worker>, preview_urls_disable:<worker>)");
  }
  const items = [...new Set(raw as string[])].sort();
  if (items.length !== raw.length) return new Error("destructive_topology lists an item twice");
  return items;
}

/** Whether a plan's steps contain the break-glass step. */
export function hasBreakGlassStep(steps: ReadonlyArray<{ action: string }>): boolean {
  return steps.some((s) => s.action === BREAK_GLASS_STEP);
}

/**
 * The plan-shape problem of a plan with a break-glass step, or null: one force_redeploy_unit, only manual notes
 * beside it, a full commit and a person as author. Plans without the step return null.
 */
export function breakGlassPlanProblem(plan: { plan_version: string; created_by: string | null; steps: ReadonlyArray<PlanStep> }): string | null {
  if (!hasBreakGlassStep(plan.steps)) return null;
  if (plan.steps.filter((s) => s.action === BREAK_GLASS_STEP).length !== 1) return "break_glass_one_step";
  if (plan.steps.some((s) => s.action !== BREAK_GLASS_STEP && s.action !== "manual")) return "break_glass_only_manual_beside";
  if (!COMMIT.test(plan.plan_version)) return "break_glass_full_commit";
  if (!isPersonActor(plan.created_by)) return "break_glass_person_author";
  const step = plan.steps.find((s) => s.action === BREAK_GLASS_STEP)!;
  if (namedDestructive(step.destructive_migrations) instanceof Error) return "break_glass_named_migrations_invalid";
  if (namedTopology(step.destructive_topology) instanceof Error) return "break_glass_named_topology_invalid";
  return null;
}

/** The steps of a stored plan (recovery_plans.steps_json), or null when unreadable. */
export function storedSteps(stepsJson: string | null | undefined): PlanStep[] | null {
  try {
    const steps = (JSON.parse(stepsJson ?? "null") as { steps?: unknown } | null)?.steps;
    return Array.isArray(steps) && steps.every((s) => s && typeof s === "object" && typeof (s as PlanStep).action === "string") ? steps as PlanStep[] : null;
  } catch { return null; }
}

/**
 * The full check of a stored, approved break-glass plan, for the Policy Engine and the Orchestrator: the shape, and an
 * approver who is a person other than the author. Returns the named destructive migrations and topology items, or the problem.
 */
export function approvedBreakGlassPlan(row: { plan_version: string; created_by: string | null; approved_by: string | null; steps_json: string | null }):
  { ok: true; destructive_migrations: string[]; destructive_topology: string[] } | { ok: false; reason: string } {
  const steps = storedSteps(row.steps_json);
  if (!steps) return { ok: false, reason: "break_glass_plan_unreadable" };
  if (!hasBreakGlassStep(steps)) return { ok: false, reason: "break_glass_step_missing" };
  const problem = breakGlassPlanProblem({ plan_version: row.plan_version, created_by: row.created_by, steps });
  if (problem) return { ok: false, reason: problem };
  if (!isPersonActor(row.approved_by) || row.approved_by === row.created_by) return { ok: false, reason: "break_glass_person_approver" };
  const step = steps.find((s) => s.action === BREAK_GLASS_STEP)!;
  return { ok: true, destructive_migrations: namedDestructive(step.destructive_migrations) as string[], destructive_topology: namedTopology(step.destructive_topology) as string[] };
}
