// ADR-0012 phase 4, shadow: the deploy plan from the Artifacts repository. Same units, registry
// state and ordering rules as the Deployment Orchestrator (control-plane-shared/src/deploy-units.ts);
// only the changed files come from a tree diff here instead of the GitHub compare API. Each cron
// tick records the plan for main's head under the current registry fingerprint; the Orchestrator
// records its own for the same inputs, and the pair is compared (forge_deploy_plans, migration 0038).
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { DEPLOY_UNITS, isMigration, orderPending, recordPlanSide, registryFingerprint, unitChanged, unitRegistryState, type PlannedUnit, type Skip } from "../../control-plane-shared/src/deploy-units.ts";
import { changedPaths } from "./changes.ts";
import type { ArtifactsReader } from "./checks.ts";

const HEX40 = /^[0-9a-f]{40}$/;
export const DEPLOY_PARITY_TARGET = 10;
/** How far back a desired version is looked up in main's history. */
export const PLAN_HISTORY = 200;

const hashOf = (c: Record<string, unknown>) => (typeof c.hash === "string" && HEX40.test(c.hash) ? c.hash : "");

export async function forgePlan(db: D1Database, repo: ArtifactsReader, mainSha: string): Promise<{ units: PlannedUnit[]; skipped: Skip[] }> {
  const history = (await repo.log({ ref: "main", limit: PLAN_HISTORY })).map(hashOf).filter(Boolean);
  const full = (tag: string) => history.find((h) => h.startsWith(tag.toLowerCase())) ?? null;
  const tag = mainSha.slice(0, 12);
  const pending: PlannedUnit[] = [];
  const skipped: Skip[] = [];
  let newMigration = false;
  for (const unit of DEPLOY_UNITS) {
    const state = await unitRegistryState(db, unit, tag);
    if ("skip" in state) { skipped.push({ unit: unit.unit, reason: state.skip }); continue; }
    if (state.behind.length === 0) continue;
    let changed = false;
    let failed = false;
    for (const base of state.behind) {
      const baseSha = full(base);
      if (!baseSha) { failed = true; break; }
      if (baseSha === mainSha) continue;
      const { changes, truncated } = await changedPaths(repo, baseSha, mainSha);
      const files = changes.map((c) => c.path);
      if (files.some(isMigration)) newMigration = true;
      if (truncated || unitChanged(unit, files)) { changed = true; break; }
    }
    if (failed) { skipped.push({ unit: unit.unit, reason: "compare_failed_or_diverged" }); continue; }
    if (changed) pending.push({ unit: unit.unit, workflow: unit.workflow, target: unit.services[0], reason: `main ${tag} changes ${unit.unit}` });
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
