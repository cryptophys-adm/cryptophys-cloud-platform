// Break-glass recovery deploy (hardening (d), owner-approved after the 2026-11-14 incident: the deploy planner stopped
// planning any unit, so no consensus path could deploy anything, its own fix included; the way out needed a GitHub
// workflow the platform is about to retire, ADR-0012 cut-over steps 6-7).
//
// An owner-approved recovery plan with a `force_redeploy_unit` step (control-plane-shared/src/break-glass.ts) asks the
// Orchestrator to deploy ONE deploy unit, the unit of the plan's service, at main's head, natively. Its only inputs are
// the unit and main's head; it never reads the planner (forgePlan / orderPending / forge_deploy_plans):
//   - main's head is the newest commit the Forge checked as main (forge_check_runs, source 'main'), which must be
//     the plan's commit and ready (every Forge gate passed); its bundles are in R2 (G2a);
//   - the Workers are planned by the native deploy's own lower layer (nativeDeployEligible, with the migration plan
//     skipped): bundle, extra modules, configuration plan and static assets, against the version each one runs;
//   - the migrations are D1's applied state against main: every file in main's migration list that the D1 ledger
//     (d1_migrations) does not list, in order. The ledger may list only main's files, and a pending file must sort
//     after the last applied one. Each file's SQL in R2 must match its sha256 and run in a D1 batch. A destructive one
//     (DESTRUCTIVE_SQL: drop, delete, rewrite) is refused unless the owner-approved plan names it. As in the SSOT,
//     only the Control Plane unit applies migrations: another unit with pending migrations is refused until the
//     Control Plane has been deployed.
// The deploy itself is the native deploy's: a signed request the cron runs at a SAFE minute under a one-time claim,
// migrations first (forward-only), then each Worker captured, uploaded, checked, deployed, verified live through the
// Drift Detector and recorded; any failure restores every changed Worker. This file is a guard path (break_glass).
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import type { DeployUnit } from "../../control-plane-shared/src/deploy-units.ts";
import { forgeReady } from "../../control-plane-shared/src/forge-gate.ts";
import { approvedBreakGlassPlan } from "../../control-plane-shared/src/break-glass.ts";
import { publishAgentReport, type AgentRpcBinding } from "../../control-plane-shared/src/agents.ts";
import {
  appliedMigrations, MIGRATING_UNIT, nativeDeployEligible, readManifest, readMigration,
  type BundleReader, type PlannedMigration, type PlannedService, type VersionReader,
} from "./native-deploy.ts";

export const BREAK_GLASS_EXECUTOR = "native:break-glass";
const HEX40 = /^[0-9a-f]{40}$/;

/** The deploy lock of a break-glass deploy: one per unit and commit, released when its request ends. */
export const breakGlassLockName = (unit: DeployUnit, sha: string) => `break-glass:${unit.workflow}:${sha}`;
/** A break-glass request's idempotency key: one request per plan (a later plan for the same commit gets its own). */
export const breakGlassRequestKey = (unit: DeployUnit, sha: string, planId: string) => `${breakGlassLockName(unit, sha)}:${planId}`;

/** main's head as the Forge's checks last saw it, independent of the deploy planner. */
export async function recoveryMainHead(db: D1Database): Promise<{ sha: string | null; reason: string }> {
  const row = await db.prepare("SELECT commit_sha FROM forge_check_runs WHERE source = 'main' ORDER BY started_at DESC, rowid DESC LIMIT 1")
    .first<{ commit_sha: string }>();
  if (!row || !HEX40.test(row.commit_sha)) return { sha: null, reason: "forge_main_check_missing" };
  return { sha: row.commit_sha, reason: "forge_main_check" };
}

/** The approved break-glass plan, re-checked in the Orchestrator's own code (break-glass.ts). */
export async function readBreakGlassPlan(db: D1Database, planId: string): Promise<{ destructive_migrations: string[] }> {
  const row = await db.prepare("SELECT plan_version, created_by, approved_by, steps_json FROM recovery_plans WHERE plan_id = ?")
    .bind(planId).first<{ plan_version: string; created_by: string | null; approved_by: string | null; steps_json: string | null }>();
  if (!row) throw new Error("plan_not_executing");
  const bg = approvedBreakGlassPlan(row);
  if (!bg.ok) throw new Error(bg.reason);
  return { destructive_migrations: bg.destructive_migrations };
}

export interface PendingMigration extends PlannedMigration { destructive: boolean }
export type MigrationRefusal = { reason: string; file?: string };

/**
 * The migrations main has and D1 has not applied, in order, each read and checked from R2. `named` are the destructive
 * files the owner-approved plan names; every named file must be one of the pending destructive migrations.
 */
export async function pendingMigrations(db: D1Database, bundles: BundleReader, commit: string, files: ReadonlyArray<PlannedMigration>, named: readonly string[]):
  Promise<{ migrations: PendingMigration[] } | MigrationRefusal> {
  const ledger = await appliedMigrations(db);
  if (!ledger) return { reason: "d1_migrations_unreadable" };
  const main = new Set(files.map((f) => f.file));
  // A file D1 applied that main does not have: an applied migration removed or renamed (the owner's).
  const unknown = ledger.find((f) => !main.has(f));
  if (unknown) return { reason: "d1_migration_not_in_main", file: unknown };
  const last = ledger.at(-1) ?? "";
  const pending = files.filter((f) => !ledger.includes(f.file));
  const early = pending.find((f) => f.file <= last);
  if (early) return { reason: "migration_out_of_order", file: early.file };
  const out: PendingMigration[] = [];
  for (const f of pending) {
    const r = await readMigration(bundles, commit, f, true);
    if ("reason" in r) return { reason: r.reason, file: f.file };
    if (r.destructive && !named.includes(f.file)) return { reason: "destructive_migration_not_named", file: f.file };
    out.push({ file: f.file, sha256: f.sha256, destructive: r.destructive });
  }
  // A name the owner approved that is not a pending destructive migration: the plan no longer matches D1 or main.
  const stale = named.find((n) => !out.some((m) => m.file === n && m.destructive));
  if (stale) return { reason: "named_migration_not_pending_destructive", file: stale };
  return { migrations: out };
}

export type BreakGlassChoice =
  | { ok: true; services: PlannedService[]; migrations: PendingMigration[] }
  | { ok: false; reason: string; service?: string; file?: string; head?: string | null };

/**
 * Everything the break-glass deploy of `unit` at `sha` needs, read only: main's head, its readiness, the Workers'
 * plan and the pending migrations. Called when the request is queued and again right before it runs.
 */
export async function breakGlassChoice(env: { DB: D1Database; BUNDLES?: BundleReader }, unit: DeployUnit, sha: string, named: readonly string[], cf?: VersionReader): Promise<BreakGlassChoice> {
  if (!env.BUNDLES) return { ok: false, reason: "not_configured" };
  if (!HEX40.test(sha)) return { ok: false, reason: "invalid_commit_sha" };
  const head = await recoveryMainHead(env.DB);
  if (head.sha !== sha) return { ok: false, reason: head.sha ? "commit_not_current_main" : head.reason, head: head.sha };
  const gate = await forgeReady(env.DB, sha);
  if (!gate.ready) return { ok: false, reason: gate.reason };
  let manifest: Awaited<ReturnType<typeof readManifest>>;
  try { manifest = await readManifest(env.BUNDLES, sha); } catch { return { ok: false, reason: "bundle_read_failed" }; }
  if (!manifest) return { ok: false, reason: "no_bundle" };
  if (!manifest.migration_files) return { ok: false, reason: "migrations_unknown" };
  let m: Awaited<ReturnType<typeof pendingMigrations>>;
  try { m = await pendingMigrations(env.DB, env.BUNDLES, sha, manifest.migration_files, named); } catch { return { ok: false, reason: "bundle_read_failed" }; }
  if ("reason" in m) return { ok: false, ...m };
  if (m.migrations.length && unit.unit !== MIGRATING_UNIT) {
    return { ok: false, reason: "migrations_pending_deploy_control_plane_first", file: m.migrations[0].file };
  }
  const e = await nativeDeployEligible(env, unit, sha, cf, { migrations: "skip" });
  if (!e.eligible) return { ok: false, reason: e.reason, ...(e.service ? { service: e.service } : {}), ...(e.file ? { file: e.file } : {}) };
  return { ok: true, services: e.services, migrations: m.migrations };
}

/**
 * Another deploy of this unit that is queued or running (any path but this plan's own request): a break-glass deploy
 * waits for it rather than racing it. Requests older than a native deploy's whole life (75 minutes) are ignored.
 */
export async function unitDeployInProgress(db: D1Database, unit: DeployUnit, planId: string, now = Date.now()): Promise<string | null> {
  const services = [...unit.services] as string[];
  const since = new Date(now - 75 * 60_000).toISOString();
  const row = await db.prepare(
    `SELECT request_id FROM deployment_requests WHERE service_id IN (${services.map(() => "?").join(", ")})
     AND status IN ('approved', 'running') AND requested_by != ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(...services, `recovery:${planId}`, since).first<{ request_id: string }>();
  return row?.request_id ?? null;
}

/**
 * The owner hears of every break-glass deploy, whatever its outcome: a critical report of the Deployment
 * Orchestrator, which the owner notices send to Telegram (critical_reports). Like every critical report it holds
 * routine consensus until an approver acknowledges it on the Owner page.
 */
export async function reportBreakGlass(agents: AgentRpcBinding | undefined, r: {
  request_id: string; plan_id: string; unit: string; commit_sha: string; outcome: "succeeded" | "failed" | "refused";
  reason?: string | null; restored?: boolean; migrations_applied?: string[]; migration_failed?: string | null; restore_point_at?: string | null; steps?: string[];
}) {
  const tag = r.commit_sha.slice(0, 12);
  const what = r.outcome === "succeeded" ? "succeeded" : r.outcome === "refused" ? `was refused (${r.reason ?? "unknown"})` : `failed (${r.reason ?? "unknown"})`;
  return publishAgentReport(agents, "deployment-orchestrator", {
    kind: "platform_digest", severity: "critical",
    subject: `Break-glass deploy of ${r.unit} at ${tag} ${what}`.slice(0, 200),
    body: {
      explanation: `An owner-approved recovery plan (${r.plan_id}) deployed the ${r.unit} unit at main ${tag} without the deploy planner. ` +
        (r.outcome === "succeeded" ? "Every Worker of the unit was verified live." : r.outcome === "refused" ? "Nothing in production changed." : "Every changed Worker was restored; applied migrations stay (forward-only).") +
        " Acknowledge this report on the Owner page to let routine consensus continue.",
      break_glass: true, request_id: r.request_id, plan_id: r.plan_id, unit: r.unit, commit_sha: r.commit_sha, outcome: r.outcome,
      reason: r.reason ?? null, restored: r.restored ?? null, migrations_applied: r.migrations_applied ?? [], migration_failed: r.migration_failed ?? null,
      d1_restore_point_at: r.restore_point_at ?? null, steps: (r.steps ?? []).slice(0, 40),
    },
  });
}
