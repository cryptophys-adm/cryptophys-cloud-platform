// The Forge cron tick (ADR-0012 phases 3-4). Three independent steps, each isolated so one failing
// never stops the others, and each failure is audited (forge.tick_failed) instead of only logged:
//   1. the deploy plan for main's head (cheap; shadow comparison with the Orchestrator);
//   2. the check of the oldest unchecked open change request head;
//   3. the check of the oldest unchecked commit of main (skipped when step 2 used most of the tick);
//   and, with CF_BUILDS_API_TOKEN, the change-request type-checks from their secret-free builds (cr-builds.ts)
//   and, once an hour, the account's measured Workers Builds minutes (build-usage.ts, owner 2026-11-12);
//   and, once a day per head of main, the npm dependency audit (dependency-audit.ts, ADR-0012 G5).
//   and the branches pushed to the work repository platform-work, as change requests (work-repo.ts, G4);
//   and, once per UTC day per head of main, a git bundle of platform to R2 (git-backup.ts, ADR-0012 gate 8).
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { checksTick, tickWith, type ArtifactsReader, type CheckDeps } from "./checks.ts";
import { nextChangeHead } from "./changes.ts";
import { planTick } from "./deploy-plan.ts";
import { censusTick, type ExternalDnaReader } from "./census.ts";
import { EXTERNAL_ORIGINS } from "../../control-plane-shared/src/organism.ts";
import { crBuildsTick } from "./cr-builds.ts";
import { buildUsageTick } from "./build-usage.ts";
import { dependencyAuditTick } from "./dependency-audit.ts";
import { WORK_REPO, workBranchesTick } from "./work-repo.ts";
import { gitBackupTick, type GitBackupBucket } from "./git-backup.ts";

export const CHECK_BUDGET_MS = 120_000;
export interface TickEnv {
  DB: D1Database; ARTIFACTS?: { get(name: string): Promise<ArtifactsReader>; list?: import("./work-repo.ts").WorkRepoBinding["list"] }; CF_BUILDS_API_TOKEN?: string; CR_TYPECHECK_WORKER?: string;
  /** ADR-0012 G2a: the R2 bucket for the modules of passed main commits (bundles.ts). */
  BUNDLES?: import("./bundles.ts").BundleBucket;
  /** Owner 2026-11-12: the XAUUSD organs' DNA (xauusd-ai-trading-assistant OrganismDna, dna() only). */
  EXT_ORGANISM_XAUUSD?: { dna(): Promise<unknown> };
}

/**
 * The check toolchain for a head of platform-work: the same suite, but a type-check that has not reported
 * is `not_configured` rather than `pending`, because no build type-checks platform-work yet (a report that
 * does exist for the same commit is kept).
 */
export function workDeps(deps: (commit: string) => Promise<CheckDeps>): (commit: string) => Promise<CheckDeps> {
  return async (commit) => {
    const d = await deps(commit);
    return {
      ...d,
      typecheck: async (c: string) => {
        const step = d.typecheck ? await d.typecheck(c) : null;
        return step && step.status !== "pending" ? step : { status: "not_configured" };
      },
    };
  };
}

/** The external origins this deployment can read (EXTERNAL_ORIGINS whose binding is bound). */
export function externalReaders(env: TickEnv): ExternalDnaReader[] {
  const bound = env as unknown as Record<string, { dna?: () => Promise<unknown> } | undefined>;
  return EXTERNAL_ORIGINS.flatMap((origin) => {
    const b = bound[origin.binding];
    return typeof b?.dna === "function" ? [{ origin, dna: () => b.dna!() }] : [];
  });
}

export async function forgeTick(env: TickEnv, repoName: string, deps: ((commit: string) => Promise<CheckDeps>) | null, nowMs = () => Date.now()): Promise<Record<string, unknown>> {
  const steps: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try { steps[name] = await fn(); } catch (e) {
      const error = String((e as Error)?.message ?? e).slice(0, 300);
      steps[name] = { outcome: "failed", error };
      await appendAuditEvent(env.DB, { event_type: "forge.tick_failed", actor: "system:forge-checks", subject: name, outcome: "failed", payload: { error } }).catch(() => undefined);
    }
  };
  if (env.ARTIFACTS) {
    await step("deploy_plan", async () => {
      const repo = await env.ARTIFACTS!.get(repoName);
      try { return await planTick(env.DB, repo, nowMs()); } finally { repo[Symbol.dispose]?.(); }
    });
  }
  if (env.ARTIFACTS) {
    // ADR-0013 phase 2: the organism census of main's head (cheap: a few tree and blob reads), with the
    // external organs' DNA read over RPC (owner 2026-11-12).
    await step("census", async () => {
      const repo = await env.ARTIFACTS!.get(repoName);
      try { return await censusTick(env.DB, repo, nowMs(), externalReaders(env)); } finally { repo[Symbol.dispose]?.(); }
    });
  }
  // ADR-0012 §5d: the type-check of open change requests, read from their secret-free Workers Builds (no-op without the token).
  if (env.CF_BUILDS_API_TOKEN) await step("cr_typecheck", () => crBuildsTick(env, nowMs()));
  // ADR-0012 G4: branches pushed to the work repository platform-work become change requests fg-<slug>.
  if (env.ARTIFACTS && typeof env.ARTIFACTS.list === "function") await step("work_branches", () => workBranchesTick(env as never, nowMs()));
  // Owner 2026-11-12: the account's Workers Builds minutes against the free-tier budget (hourly; read only).
  if (env.CF_BUILDS_API_TOKEN) await step("build_usage", () => buildUsageTick(env, nowMs()));
  if (env.ARTIFACTS) {
    // ADR-0012 G5: the npm dependency audit of main's head (once a day per head), replacing Dependabot alerts.
    await step("dependency_audit", async () => {
      const repo = await env.ARTIFACTS!.get(repoName);
      try { return await dependencyAuditTick(env, repo, nowMs()); } finally { repo[Symbol.dispose]?.(); }
    });
  }
  if (env.ARTIFACTS && env.BUNDLES) {
    // ADR-0012 gate 8 (§5m): the off-Artifacts copy of platform, a git bundle in R2 (once per UTC day per head).
    await step("git_backup", async () => {
      const repo = await env.ARTIFACTS!.get(repoName);
      try { return await gitBackupTick({ DB: env.DB, BUNDLES: env.BUNDLES as unknown as GitBackupBucket }, repo as never, nowMs()); } finally { repo[Symbol.dispose]?.(); }
    });
  }
  const started = nowMs();
  await step("change_checks", async () => {
    // GitHub-sourced heads are read from platform (cr/<n>); only when none waits, a forge-sourced head from
    // platform-work (G4). Its type-check has no source yet: recorded as not_configured (ADR-0012 §5j).
    const github = await tickWith(env, repoName, deps, nowMs, (repo) => nextChangeHead(env.DB, repo, nowMs(), "platform"), "change");
    if (github.outcome !== "up_to_date" || !deps) return github;
    const waiting = await env.DB.prepare("SELECT 1 AS waiting FROM forge_change_requests WHERE status = 'open' AND repo = ? AND blocked_reason IS NULL LIMIT 1").bind(WORK_REPO).first();
    if (!waiting) return github;
    const work = await tickWith(env, WORK_REPO, workDeps(deps), nowMs, (repo) => nextChangeHead(env.DB, repo, nowMs(), WORK_REPO), "change");
    return work.outcome === "up_to_date" ? github : { ...work, repo: WORK_REPO };
  });
  const change = steps.change_checks as { outcome?: string } | undefined;
  if (change?.outcome === "checked" && nowMs() - started > CHECK_BUDGET_MS) steps.main_checks = { outcome: "deferred" };
  else await step("main_checks", () => checksTick(env, repoName, deps, nowMs));
  return steps;
}
