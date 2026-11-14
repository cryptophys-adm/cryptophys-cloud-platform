/**
 * Deploy units and the rules that turn "what changed" into "what to deploy, in which order".
 * Shared by the Deployment Orchestrator (which compares commits through the GitHub API) and the
 * Forge (ADR-0012 phase 4, shadow: the same plan from the Artifacts repository, no GitHub), so the
 * two plans differ only in where the changed files come from. Each production workflow deploys a
 * fixed set of Workers from the exact main commit; a unit is pending when files under its paths
 * changed since the version recorded in the registry. Console and Platform API import the
 * shared library. cryptophys-home was retired on 2026-11-13 (ADR-0010 amendment) and has no unit.
 */
import type { D1Database } from "./types.ts";

export const SHARED_SRC = "workers/control-plane-shared/src/";
export const MIGRATIONS_DIR = "workers/control-plane-migrations/";
/** ADR-0016 T0: the AI Kernel bundles the organism's vision and serves it (GET /v1/vision), so a change to it redeploys the kernel. */
export const VISION_FILE = "organism/vision.json";
export const DEPLOY_UNITS = [
  // Deploy the orchestrator first: the following Control Plane deployment binds the kernel to DeployRpc.
  { unit: "deployment-orchestrator", workflow: "deploy-deployment-orchestrator.yml", services: ["cryptophys-deployment-orchestrator"], paths: ["workers/deployment-orchestrator/", SHARED_SRC] },
  {
    unit: "control-plane", workflow: "deploy-control-plane.yml",
    services: ["cryptophys-policy-engine", "cryptophys-audit-ledger", "cryptophys-platform-registry", "cryptophys-recovery-manager", "cryptophys-drift-detector", "cryptophys-ai-kernel"],
    paths: ["workers/policy-engine/", "workers/audit-ledger/", "workers/platform-registry/", "workers/recovery-manager/", "workers/drift-detector/", "workers/ai-kernel/", MIGRATIONS_DIR, SHARED_SRC, VISION_FILE],
  },
  // Directory prefixes include manifests, lockfiles, bundler config and static assets, not just source files.
  { unit: "console", workflow: "deploy-console.yml", services: ["cryptophys-console"], paths: ["workers/console/", SHARED_SRC] },
  { unit: "platform-api", workflow: "deploy-platform-api.yml", services: ["cryptophys-platform-api"], paths: ["workers/platform-api/", SHARED_SRC] },
  // ADR-0012 phase 1b: the Forge (platform source on Cloudflare Artifacts).
  { unit: "forge", workflow: "deploy-forge.yml", services: ["cryptophys-forge"], paths: ["workers/forge/", SHARED_SRC] },
] as const;
export type DeployUnit = (typeof DEPLOY_UNITS)[number];

export function unitForService(serviceId: string): DeployUnit | null {
  return DEPLOY_UNITS.find((u) => (u.services as readonly string[]).includes(serviceId)) ?? null;
}

export function unitChanged(unit: DeployUnit, files: string[]): boolean {
  return files.some((f) => unit.paths.some((p) => f === p || f.startsWith(p)));
}

export const isMigration = (f: string) => f.startsWith(MIGRATIONS_DIR) && f.endsWith(".sql");

export interface PlannedUnit { unit: string; workflow: string; target: string; reason: string }
export interface Skip { unit: string; reason: string }

/** A unit's registry state: skipped (not registered, disabled or unknown version), or the desired versions behind `tag`. */
export async function unitRegistryState(db: D1Database, unit: DeployUnit, tag: string): Promise<{ skip: string } | { behind: string[] }> {
  const rows = await db.prepare(
    `SELECT service_id, status, desired_version FROM service_registry WHERE service_id IN (${unit.services.map(() => "?").join(", ")})`,
  ).bind(...unit.services).all<{ service_id: string; status: string; desired_version: string | null }>();
  const results = rows.results ?? [];
  if (results.length !== unit.services.length || results.some((r) => r.status === "disabled")) return { skip: "not_registered_or_disabled" };
  const behind = [...new Set(results.map((r) => r.desired_version).filter((v) => v !== tag))] as Array<string | null>;
  if (behind.some((v) => !v || !/^[0-9a-f]{7,40}$/.test(v))) return { skip: "desired_version_unknown" };
  return { behind: behind as string[] };
}

/**
 * The ordering rules over the pending units:
 * - a new D1 migration is applied only by the Control Plane deploy, and every Worker's readiness
 *   requires the newest migration: deploy the Control Plane first, alone (2026-11-07, migration 0026);
 * - DeployRpc must exist before the AI Kernel is redeployed with its new service binding: never
 *   propose the Control Plane (or another unit) in the same cycle as the orchestrator.
 */
export function orderPending(pending: PlannedUnit[], newMigration: boolean, skippedIn: Skip[]): { units: PlannedUnit[]; skipped: Skip[] } {
  const skipped = [...skippedIn];
  const controlPlane = pending.find((u) => u.unit === "control-plane");
  if (newMigration) {
    if (controlPlane) {
      for (const u of pending) if (u.unit !== "control-plane") skipped.push({ unit: u.unit, reason: "control_plane_migration_first" });
      return { units: [controlPlane], skipped };
    }
    // Never deploy another unit if the migration-bearing Control Plane cannot be verified.
    // It may already be current (no skip recorded); otherwise fail closed on disabled,
    // unregistered, unknown-version or compare-failed Control Plane state.
    if (skipped.some((s) => s.unit === "control-plane")) {
      skipped.push({ unit: "*", reason: "new_migration_control_plane_unavailable" });
      return { units: [], skipped };
    }
  }
  const orchestrator = pending.find((u) => u.unit === "deployment-orchestrator");
  if (orchestrator) {
    for (const u of pending) if (u.unit !== "deployment-orchestrator") skipped.push({ unit: u.unit, reason: "deployment_orchestrator_must_complete_first" });
    return { units: [orchestrator], skipped };
  }
  return { units: [...pending], skipped };
}

/** The registry inputs of a plan: every unit's desired versions. Two plans are comparable only when these match. */
export async function registryFingerprint(db: D1Database): Promise<string> {
  const services = DEPLOY_UNITS.flatMap((u) => [...u.services]);
  const rows = await db.prepare(`SELECT service_id, status, desired_version FROM service_registry WHERE service_id IN (${services.map(() => "?").join(", ")}) ORDER BY service_id`)
    .bind(...services).all<{ service_id: string; status: string; desired_version: string | null }>();
  return (rows.results ?? []).map((r) => `${r.service_id}=${r.status === "disabled" ? "disabled" : r.desired_version ?? "-"}`).join(",");
}

// ADR-0012 phase 4, shadow: both paths record their plan for the same main commit and registry
// inputs; whichever records second compares them.
export type PlanSide = "forge" | "github";

export async function recordPlanSide(db: D1Database, side: PlanSide, mainSha: string, fingerprint: string, plan: { units: PlannedUnit[]; skipped: Skip[] }, nowMs = Date.now()): Promise<void> {
  const at = new Date(nowMs).toISOString();
  const units = JSON.stringify(plan.units.map((u) => u.unit));
  const skipped = JSON.stringify(plan.skipped.slice(0, 30));
  const cols = side === "forge" ? ["forge_units", "forge_skipped", "forge_at"] : ["github_units", "github_skipped", "github_at"];
  await db.prepare(
    `INSERT INTO forge_deploy_plans (main_sha, fingerprint, ${cols.join(", ")}) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(main_sha, fingerprint) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}`,
  ).bind(mainSha, fingerprint.slice(0, 2000), units, skipped, at).run();
  await db.prepare(
    `UPDATE forge_deploy_plans SET agrees = CASE WHEN forge_units = github_units THEN 1 ELSE 0 END
     WHERE main_sha = ? AND fingerprint = ? AND forge_units IS NOT NULL AND github_units IS NOT NULL`,
  ).bind(mainSha, fingerprint.slice(0, 2000)).run();
}
