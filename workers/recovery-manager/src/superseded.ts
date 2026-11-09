/**
 * Stale redeploy plans (2026-11-09). The supervisor drafts "redeploy the desired version X" when a
 * service drifts. If the drift is fixed some other way (a normal deploy, a newer desired version),
 * the draft stays approvable for its whole 72 h window and asks a person to redeploy a version that
 * is no longer wanted. The orchestrator would refuse it (`version_not_current_main`), so this is not
 * a rollback risk, but it is noise on the owner's approval list.
 *
 * A draft redeploy plan is retired (status `disabled`, with an audit event) when:
 *   - `superseded`: the service's desired version has moved past the plan's version, or
 *   - `drift_resolved`: the plan's version is still desired and the service already runs it.
 * Approval refuses such a plan, and the hourly sweep retires the rest. Plans without a
 * redeploy_commit step are never touched: their version is not a deploy target.
 */
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { nowIso } from "../../control-plane-shared/src/http.ts";

export type SupersededReason = "superseded" | "drift_resolved";

interface PlanLike { plan_id: string; service_id: string; plan_version: string; status: string; steps_json: string }
interface RegistryLike { desired_version: string | null; observed_version: string | null }

const norm = (v: string | null | undefined): string => (typeof v === "string" ? v.trim().toLowerCase().slice(0, 12) : "");
/** Two version tags name the same commit when one is a prefix of the other (both at least 7 hex). */
export function sameVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = norm(a); const y = norm(b);
  return x.length >= 7 && y.length >= 7 && /^[0-9a-f]+$/.test(x) && /^[0-9a-f]+$/.test(y) && (x.startsWith(y) || y.startsWith(x));
}

function redeploys(stepsJson: string): boolean {
  try {
    const steps = (JSON.parse(stepsJson) as { steps?: Array<{ action?: string }> })?.steps;
    return Array.isArray(steps) && steps.some((s) => s?.action === "redeploy_commit");
  } catch { return false; }
}

/** Why a draft redeploy plan is no longer needed, or null if it still is (or is not a redeploy plan). */
export function supersededReason(plan: PlanLike, reg: RegistryLike | null): SupersededReason | null {
  if (plan.status !== "draft" || !reg || !redeploys(plan.steps_json)) return null;
  if (!norm(reg.desired_version) || !norm(plan.plan_version)) return null;
  if (!sameVersion(plan.plan_version, reg.desired_version)) return "superseded";
  if (sameVersion(reg.observed_version, reg.desired_version)) return "drift_resolved";
  return null;
}

async function registryOf(db: D1Database, serviceId: string): Promise<RegistryLike | null> {
  return db.prepare("SELECT desired_version, observed_version FROM service_registry WHERE service_id = ?").bind(serviceId).first<RegistryLike>();
}

export async function planSuperseded(db: D1Database, plan: PlanLike): Promise<SupersededReason | null> {
  if (plan.status !== "draft" || !redeploys(plan.steps_json)) return null;
  return supersededReason(plan, await registryOf(db, plan.service_id));
}

/** Disable a draft plan that is no longer needed. True only if this call changed it. */
export async function retirePlan(db: D1Database, plan: PlanLike, reason: SupersededReason, actor: string): Promise<boolean> {
  const result = await db.prepare("UPDATE recovery_plans SET status = 'disabled', disabled_reason = ?, updated_at = ? WHERE plan_id = ? AND status = 'draft'")
    .bind(reason, nowIso(), plan.plan_id).run();
  if ((result.meta.changes ?? 0) !== 1) return false;
  const reg = await registryOf(db, plan.service_id);
  await appendAuditEvent(db, {
    event_type: "recovery.plan_superseded", actor, subject: plan.plan_id, outcome: "disabled",
    payload: { service_id: plan.service_id, plan_version: plan.plan_version, reason, desired_version: reg?.desired_version ?? null, observed_version: reg?.observed_version ?? null },
  });
  return true;
}

/** The hourly sweep: retire every draft redeploy plan that is superseded or whose drift is resolved. */
export async function retireSupersededDrafts(db: D1Database): Promise<{ checked: number; retired: Array<{ plan_id: string; reason: SupersededReason }> }> {
  const rows = await db.prepare("SELECT plan_id, service_id, plan_version, status, steps_json FROM recovery_plans WHERE status = 'draft' ORDER BY created_at LIMIT 200").all<PlanLike>();
  const retired: Array<{ plan_id: string; reason: SupersededReason }> = [];
  const plans = rows.results ?? [];
  for (const plan of plans) {
    const reason = await planSuperseded(db, plan);
    if (reason && await retirePlan(db, plan, reason, "system:recovery-sweep")) retired.push({ plan_id: plan.plan_id, reason });
  }
  return { checked: plans.length, retired };
}
