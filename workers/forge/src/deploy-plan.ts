// ADR-0012 phase 4, shadow: the deploy plan from the Artifacts repository. Same units, registry
// state and ordering rules as the Deployment Orchestrator (control-plane-shared/src/deploy-units.ts);
// only the changed files come from a tree diff here instead of the GitHub compare API. Each cron
// tick records the plan for main's head under the current registry fingerprint; the Orchestrator
// records its own for the same inputs, and the pair is compared (forge_deploy_plans, migration 0038).
//
// 2026-11-14 hardening (every automatic deploy stuck since main 6db8d31). A unit's desired version was looked
// up only in `log(main)`, which is main's first-parent chain. Branch updates merged main as the SECOND parent,
// so the Control Plane's version 3cd2f94, an ancestor of main, was not on that chain: the plan recorded
// control-plane `compare_failed_or_diverged`, and with a new migration in the diff `orderPending` refused every
// unit (`new_migration_control_plane_unavailable`), the Forge's own fix included. Now:
//   1. a desired version is resolved by ancestry over the whole history: first main's first-parent window, then a
//      breadth-first walk of every parent from main's head, at most PLAN_ANCESTRY_READS commits read. A commit
//      reached by the walk is an ancestor by construction;
//   2. "a migration is pending" is read from D1: a file of main's migrations directory that `d1_migrations` (the
//      ledger wrangler and the Orchestrator's native deploy both write) does not list. It no longer depends on a
//      diff against a deployed version;
//   3. a desired version that is still not resolved (not found within the bound, or not an ancestor of main)
//      plans a full redeploy of that unit from main's head, reason `full_redeploy_unresolved_base`, instead of a
//      skip. The ordering rules are unchanged: the Control Plane first and alone while a migration is pending,
//      then the orchestrator alone. `new_migration_control_plane_unavailable` now comes only from a Control Plane
//      that cannot be deployed at all (unregistered, disabled, or no valid desired version in the registry).
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { DEPLOY_UNITS, MIGRATIONS_DIR, orderPending, recordPlanSide, registryFingerprint, unitChanged, unitRegistryState, type PlannedUnit, type Skip } from "../../control-plane-shared/src/deploy-units.ts";
import { D1_MIGRATIONS_TABLE } from "../../control-plane-shared/src/migration-rules.ts";
import { migrationsOf } from "./bundles.ts";
import { changedPaths } from "./changes.ts";
import type { ArtifactsReader } from "./checks.ts";
import { parentsOf } from "./merge.ts";

const HEX40 = /^[0-9a-f]{40}$/;
export const DEPLOY_PARITY_TARGET = 10;
/** How far back a desired version is looked up in main's first-parent history (one `log` call). */
export const PLAN_HISTORY = 200;
/**
 * The most commits the ancestry walk reads (one `readCommit` each) per plan, for every desired version the
 * first-parent window did not hold. The same bound as merge.ts `isAncestor` (ADR-0012 §5h). A deployed version
 * is normally days old, a few dozen commits away; one that is further, diverged, or unreadable is not resolved
 * and its unit is redeployed in full from main's head, which is always a valid target. The walk runs only when
 * a plan is recorded (once per main head and registry fingerprint).
 */
export const PLAN_ANCESTRY_READS = 500;
/** The reason of a unit planned in full because its desired version is not a resolvable ancestor of main. */
export const FULL_REDEPLOY_UNRESOLVED_BASE = "full_redeploy_unresolved_base";

const hashOf = (c: Record<string, unknown>) => (typeof c.hash === "string" && HEX40.test(c.hash) ? c.hash : "");

/**
 * Each tag (a desired version, 7 to 40 hex) mapped to the full SHA of an ancestor of `mainSha` (or `mainSha`
 * itself) that it prefixes, or null. First main's first-parent window, used only when `log(main)` starts at
 * `mainSha` (so every entry is an ancestor of it); then a breadth-first walk over all parents from `mainSha`,
 * which reaches second parents (merged branches) too. Nearest match first; reads at most `maxReads` commits.
 */
export async function resolveAncestors(repo: Pick<ArtifactsReader, "log" | "readCommit">, mainSha: string, tags: string[], maxReads = PLAN_ANCESTRY_READS):
  Promise<{ resolved: Map<string, string | null>; reads: number; exhausted: boolean }> {
  const resolved = new Map<string, string | null>(tags.map((t) => [t.toLowerCase(), null]));
  const open = () => [...resolved].filter(([, v]) => v === null).map(([t]) => t);
  const match = (sha: string) => { for (const t of open()) if (sha.startsWith(t)) resolved.set(t, sha); };
  if (!HEX40.test(mainSha) || resolved.size === 0) return { resolved, reads: 0, exhausted: false };
  const window = (await repo.log({ ref: "main", limit: PLAN_HISTORY })).map(hashOf).filter(Boolean);
  if (window[0] === mainSha) for (const h of window) match(h);
  match(mainSha);
  let reads = 0;
  const seen = new Set<string>([mainSha]);
  const queue = [mainSha];
  while (queue.length && open().length) {
    if (reads >= maxReads) return { resolved, reads, exhausted: true };
    const sha = queue.shift() as string;
    reads++;
    const commit = await repo.readCommit(sha) as Record<string, unknown> | null;
    for (const parent of parentsOf(commit)) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      match(parent);
      queue.push(parent);
    }
  }
  return { resolved, reads, exhausted: false };
}

/** The D1 migrations ledger (`d1_migrations` names); null when it cannot be read. */
async function appliedMigrations(db: D1Database): Promise<Set<string> | null> {
  try {
    const rows = await db.prepare(`SELECT name FROM ${D1_MIGRATIONS_TABLE}`).all<{ name: string | null }>();
    const names = (rows.results ?? []).map((r) => r.name);
    return names.every((n): n is string => typeof n === "string") ? new Set(names) : null;
  } catch {
    return null;
  }
}

/** The migration files of main's head (`workers/control-plane-migrations/*.sql`, as the bundle manifest lists them). */
export async function migrationFilesAt(repo: Pick<ArtifactsReader, "readCommit" | "readTree">, commit: string): Promise<string[]> {
  const c = await repo.readCommit(commit);
  if (!c) throw new Error("commit_not_mirrored");
  let tree = c.treeHash;
  for (const name of MIGRATIONS_DIR.split("/").filter(Boolean)) {
    const entry = ((await repo.readTree(tree)) ?? []).find((e) => e.name === name && e.type === "tree");
    if (!entry) return [];
    tree = entry.hash;
  }
  const entries = (await repo.readTree(tree)) ?? [];
  return migrationsOf(entries.filter((e) => e.type === "blob" || e.type === "exec").map((e) => MIGRATIONS_DIR + e.name));
}

/** The migrations of main's head that D1 has not applied; null (treated as pending: fail closed) when the ledger cannot be read. */
export async function pendingMigrations(db: D1Database, repo: Pick<ArtifactsReader, "readCommit" | "readTree">, mainSha: string): Promise<string[] | null> {
  const files = await migrationFilesAt(repo, mainSha);
  const applied = await appliedMigrations(db);
  return applied ? files.filter((f) => !applied.has(f)) : null;
}

export async function forgePlan(db: D1Database, repo: ArtifactsReader, mainSha: string): Promise<{ units: PlannedUnit[]; skipped: Skip[] }> {
  const tag = mainSha.slice(0, 12);
  const pending: PlannedUnit[] = [];
  const skipped: Skip[] = [];
  const states: Array<{ unit: (typeof DEPLOY_UNITS)[number]; behind: string[] }> = [];
  for (const unit of DEPLOY_UNITS) {
    const state = await unitRegistryState(db, unit, tag);
    if ("skip" in state) { skipped.push({ unit: unit.unit, reason: state.skip }); continue; }
    if (state.behind.length > 0) states.push({ unit, behind: state.behind });
  }
  const { resolved } = await resolveAncestors(repo, mainSha, [...new Set(states.flatMap((s) => s.behind))]);
  const unapplied = await pendingMigrations(db, repo, mainSha);
  const newMigration = unapplied === null || unapplied.length > 0;
  const plan = (unit: (typeof DEPLOY_UNITS)[number], reason: string) => pending.push({ unit: unit.unit, workflow: unit.workflow, target: unit.services[0], reason });
  for (const { unit, behind } of states) {
    let changed = false;
    let unresolved = false;
    for (const base of behind) {
      const baseSha = resolved.get(base.toLowerCase()) ?? null;
      if (!baseSha) { unresolved = true; break; }
      if (baseSha === mainSha) continue;
      const { changes, truncated } = await changedPaths(repo, baseSha, mainSha);
      if (truncated || unitChanged(unit, changes.map((c) => c.path))) { changed = true; break; }
    }
    if (unresolved) plan(unit, FULL_REDEPLOY_UNRESOLVED_BASE);
    else if (changed) plan(unit, `main ${tag} changes ${unit.unit}`);
    // A migration D1 has not applied is applied only by the Control Plane deploy: a Control Plane behind main
    // deploys even when its own paths are unchanged since its version.
    else if (newMigration && unit.unit === "control-plane") plan(unit, `main ${tag} has a migration D1 has not applied`);
  }
  return orderPending(pending, newMigration, skipped);
}

/** One tick: record the Forge's plan for main's head, once per registry fingerprint. */
export async function planTick(db: D1Database, repo: ArtifactsReader, nowMs = Date.now()): Promise<{ outcome: "recorded" | "up_to_date" | "no_main"; main_sha?: string; units?: string[] }> {
  const head = hashOf((await repo.log({ ref: "main", limit: 1 }))[0] ?? {});
  if (!head) return { outcome: "no_main" };
  const fingerprint = await registryFingerprint(db);
  const have = await db.prepare("SELECT forge_units FROM forge_deploy_plans WHERE main_sha = ? AND fingerprint = ?").bind(head, fingerprint).first<{ forge_units: string | null }>();
  if (have?.forge_units) return { outcome: "up_to_date", main_sha: head };
  const plan = await forgePlan(db, repo, head);
  await recordPlanSide(db, "forge", head, fingerprint, plan, nowMs);
  return { outcome: "recorded", main_sha: head, units: plan.units.map((u) => u.unit) };
}

interface PlanRow { main_sha: string; forge_units: string | null; forge_skipped: string | null; forge_at: string | null; github_units: string | null; github_skipped: string | null; github_at: string | null; agrees: number | null }
const list = (v: string | null) => { try { const a = JSON.parse(v ?? "null"); return Array.isArray(a) ? a : null; } catch { return null; } };

/** Recent plans, newest first, and the consecutive agreements over compared ones. */
export async function listDeployPlans(db: D1Database, limit: number) {
  const n = Math.min(Math.max(Math.trunc(limit) || 10, 1), 50);
  const rows = (await db.prepare(
    "SELECT * FROM forge_deploy_plans ORDER BY max(coalesce(forge_at, ''), coalesce(github_at, '')) DESC LIMIT 100",
  ).all<PlanRow>()).results ?? [];
  let consecutive = 0; let broken = false; let compared = 0;
  const disagreements: string[] = [];
  for (const r of rows) {
    if (r.agrees === null) continue;
    compared++;
    if (r.agrees === 1 && !broken) consecutive++;
    if (r.agrees === 0) { broken = true; disagreements.push(r.main_sha.slice(0, 12)); }
  }
  return {
    plans: rows.slice(0, n).map((r) => ({
      main_sha: r.main_sha, forge_units: list(r.forge_units), forge_skipped: list(r.forge_skipped), forge_at: r.forge_at,
      github_units: list(r.github_units), github_skipped: list(r.github_skipped), github_at: r.github_at, agrees: r.agrees === null ? null : r.agrees === 1,
    })),
    parity: { target: DEPLOY_PARITY_TARGET, consecutive, compared, disagreements: disagreements.slice(0, 20) },
  };
}
