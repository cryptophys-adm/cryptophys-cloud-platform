/**
 * When a failed recovery plan no longer needs anyone (orchestrator finding A, owner "approve all" 2026-11-19).
 *
 * The owner inbox listed a recovery_failed item for 24 hours whatever happened after it, so a plan that failed at
 * 02:29 still asked for attention at 10:00 although the Worker had been healthy and in sync since the next deploy.
 * A failed plan (or one whose approval window expired or lapsed) is resolved once:
 *   deployed  a later deploy of the plan's deploy unit succeeded (deployment_requests, after the plan's end), or
 *   in_sync   the Drift Detector has seen the Worker healthy since the plan's end (service_registry.status and
 *             updated_at, its heartbeat) and the Worker's latest drift row is clean (drift rows are written only on change, 0061).
 * The inbox drops a resolved plan, and the Recovery page shows it as superseded with the reason. Fails open to
 * "not resolved": unreadable evidence keeps the item, as before.
 */
import type { D1Database } from "./types.ts";
import { unitForService } from "./deploy-units.ts";

export type PlanResolutionReason = "deployed" | "in_sync";
export interface PlanResolution { reason: PlanResolutionReason; at: string; detail: string }
interface PlanEnd { service_id: string; updated_at: string }

export async function failedPlanResolution(db: D1Database, plan: PlanEnd): Promise<PlanResolution | null> {
  const ended = Date.parse(plan.updated_at);
  if (!Number.isFinite(ended)) return null;
  const unit = unitForService(plan.service_id);
  const services: string[] = unit ? [...unit.services] : [plan.service_id];
  const deploy = await db.prepare(
    `SELECT request_id, requested_version, COALESCE(updated_at, created_at) AS at FROM deployment_requests
     WHERE service_id IN (${services.map(() => "?").join(", ")}) AND status = 'succeeded' AND created_at > ? ORDER BY created_at LIMIT 1`,
  ).bind(...services, plan.updated_at).first<{ request_id: string; requested_version: string | null; at: string }>();
  if (deploy) {
    return { reason: "deployed", at: deploy.at, detail: `a later deploy of ${unit?.unit ?? plan.service_id} succeeded (${String(deploy.requested_version ?? "").slice(0, 7) || "unknown version"}, ${deploy.request_id})` };
  }
  const seen = await db.prepare("SELECT status, updated_at FROM service_registry WHERE service_id = ?").bind(plan.service_id).first<{ status: string; updated_at: string | null }>();
  const seenAt = Date.parse(seen?.updated_at ?? "");
  if (!seen || seen.status !== "healthy" || !Number.isFinite(seenAt) || seenAt <= ended) return null;
  const latest = await db.prepare("SELECT drifted, observed_at FROM drift_observations WHERE service_id = ? ORDER BY observed_at DESC, rowid DESC LIMIT 1")
    .bind(plan.service_id).first<{ drifted: number; observed_at: string }>();
  if (!latest || Number(latest.drifted) !== 0) return null;
  return { reason: "in_sync", at: seen!.updated_at!, detail: `${plan.service_id} is healthy and in sync (no drift since ${latest.observed_at}; seen ${seen!.updated_at})` };
}

/**
 * Orchestrator finding D: true when a redeploy version is not main's head (the Orchestrator redeploys only main's
 * head, version_not_current_main); false when the version is a prefix of the head, is not a commit, or the head is
 * unreadable (nothing is retired or dropped on missing evidence).
 */
export function notMain(version: string, mainSha: string | null | undefined): boolean {
  const v = version.trim().toLowerCase();
  return typeof mainSha === "string" && /^[0-9a-f]{40}$/i.test(mainSha) && /^[0-9a-f]{7,40}$/.test(v) && !mainSha.toLowerCase().startsWith(v);
}
