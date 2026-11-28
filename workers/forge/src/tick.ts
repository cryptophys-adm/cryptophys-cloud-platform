// The Forge cron tick (ADR-0012 phases 3-4). Three independent steps, each isolated so one failing
// never stops the others, and each failure is audited (forge.tick_failed) instead of only logged:
//   1. the deploy plan for main's head (cheap; shadow comparison with the Orchestrator);
//   2. the check of an unchecked open change request head: in platform-work the one waiting longest, in platform (the
//      GitHub pull request mirrors) the newest (changes.ts nextChangeHead);
//   3. the check of main's head: a new head, or its daily run (skipped when step 2 used most of the tick);
//   and, with CF_BUILDS_API_TOKEN, the change-request type-checks from their secret-free builds (cr-builds.ts)
//   and, once an hour, the account's measured Workers Builds minutes (build-usage.ts, owner 2026-11-12);
//   and, once a day per head of main, the npm dependency audit (dependency-audit.ts, ADR-0012 G5).
//   and the branches pushed to the work repository platform-work, as change requests (work-repo.ts, G4);
//   and, once per UTC day per head of main, a git bundle of platform to R2 (git-backup.ts, ADR-0012 gate 8);
//   and, once per UTC day, `git bundle verify` in code of the newest stored bundle (bundle-verify.ts, gate 8);
//   and the type-check source of forge-sourced change requests: their head copied to cr/<cr_id> of platform
//   (transfer.ts, gate 6); and the G3a merge spike on the scratch repository until it has succeeded once (gate 5).
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { checksTick, tickWith, type ArtifactsReader, type CheckDeps, type TestReportPolicy, type TickOutcome } from "./checks.ts";
import { nextChangeHead } from "./changes.ts";
import { planTick } from "./deploy-plan.ts";
import type { BundleTextReader } from "../../control-plane-shared/src/executor-first.ts";
import { censusTick, type ExternalDnaReader } from "./census.ts";
import { EXTERNAL_ORIGINS } from "../../control-plane-shared/src/organism.ts";
import { crBuildsTick } from "./cr-builds.ts";
import { buildUsageTick } from "./build-usage.ts";
import { dependencyAuditTick } from "./dependency-audit.ts";
import { WORK_REPO, workBranchesTick } from "./work-repo.ts";
import { gitBackupTick, type GitBackupBucket } from "./git-backup.ts";
import { gitBackupVerifyTick, type VerifyBucket } from "./bundle-verify.ts";
import { crSourcesTick } from "./transfer.ts";
import { githubMirrorTick } from "./github-mirror.ts";
import { councilSyncTick } from "./council-sync.ts";
import { councilAllowlistTick } from "./council-allowlist.ts";
import { mergeSpikeUntilProven } from "./merge.ts";

export const CHECK_BUDGET_MS = 120_000;
/** CI-WB: the most change request heads one tick finds waiting for their test report before it stops looking. */
export const MAX_WAITING_PICKS = 3;
export interface TickEnv {
  DB: D1Database; ARTIFACTS?: { get(name: string): Promise<ArtifactsReader>; list?: import("./work-repo.ts").WorkRepoBinding["list"] }; CF_BUILDS_API_TOKEN?: string; CR_TYPECHECK_WORKER?: string;
  /** ADR-0012 G2a: the R2 bucket for the modules of passed main commits (bundles.ts). */
  BUNDLES?: import("./bundles.ts").BundleBucket;
  /** Owner 2026-11-12: the XAUUSD organs' DNA (xauusd-ai-trading-assistant OrganismDna, dna() only). */
  EXT_ORGANISM_XAUUSD?: { dna(): Promise<unknown> };
  /** Owner 2026-11-14: Aether's DNA (cryptophys-aether OrganismDna, dna() only), held to Aether's ceiling. */
  EXT_ORGANISM_AETHER?: { dna(): Promise<unknown> };
  /** Owner 2026-11-15/16: cryptophys-cta's DNA (OrganismDna, dna() only), held to the general external ceiling. */
  EXT_ORGANISM_CTA?: { dna(): Promise<unknown> };
  /** Owner 2026-11-22 ("sinkron otomatis"): the GitHub mirror's token (Forge secret), read only by github-mirror.ts. */
  GITHUB_MIRROR_TOKEN?: string;
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

/**
 * The change request checks of one repository: the next head due, and when it is waiting for its Workers Builds test
 * report (CI-WB), the next one after it, up to MAX_WAITING_PICKS, so one head's wait blocks no other (non-blocking).
 */
async function changeTick(env: TickEnv, repoName: string, deps: (commit: string) => Promise<CheckDeps>, nowMs: () => number, pickRepo: "platform" | typeof WORK_REPO, reports?: TestReportPolicy): Promise<TickOutcome & { waiting?: string[] }> {
  const skip = new Set<string>();
  for (;;) {
    const r = await tickWith(env, repoName, deps, nowMs, (repo) => nextChangeHead(env.DB, repo, nowMs(), pickRepo, skip), "change", reports);
    if (r.outcome !== "waiting_for_test_report") return skip.size ? { ...r, waiting: [...skip] } : r;
    skip.add(r.commit);
    if (skip.size >= MAX_WAITING_PICKS) return { outcome: "up_to_date", waiting: [...skip] };
  }
}

export async function forgeTick(env: TickEnv, repoName: string, deps: ((commit: string) => Promise<CheckDeps>) | null, nowMs = () => Date.now(), opts: { reports?: TestReportPolicy } = {}): Promise<Record<string, unknown>> {
  const steps: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try { steps[name] = await fn(); } catch (e) {
      const error = String((e as Error)?.message ?? e).slice(0, 300);
      steps[name] = { outcome: "failed", error };
      await appendAuditEvent(env.DB, { event_type: "forge.tick_failed", actor: "system:forge-checks", subject: name, outcome: "failed", payload: { error } }).catch(() => undefined);
    }
  };
  // Gate 2026-11-15 (executor first): the planner reads main's bundles, which only the R2 binding's get reads.
  const bundleReader = typeof (env.BUNDLES as { get?: unknown } | undefined)?.get === "function" ? env.BUNDLES as unknown as BundleTextReader : undefined;
  const deployPlan = async () => {
    const repo = await env.ARTIFACTS!.get(repoName);
    try { return await planTick(env.DB, repo, nowMs(), bundleReader); } finally { repo[Symbol.dispose]?.(); }
  };
  if (env.ARTIFACTS) await step("deploy_plan", deployPlan);
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
  if (env.ARTIFACTS && typeof env.ARTIFACTS.list === "function") {
    await step("work_branches", () => workBranchesTick(env as never, nowMs()));
    // Gate 6 (2026-11-13): a forge-sourced request's head goes to cr/<cr_id> of platform, where its type-check builds.
    await step("cr_sources", () => crSourcesTick(env as never));
    // Gate 5: the G3a spike, on the scratch repository only, until one run has succeeded (then a no-op).
    await step("merge_spike", () => mergeSpikeUntilProven(env as never, nowMs()));
  }
  // Owner 2026-11-22 ("opsi a", "sinkron otomatis"): GitHub's main follows canonical main, by fast-forward only (no-op without the token).
  if (env.ARTIFACTS && env.GITHUB_MIRROR_TOKEN) await step("github_mirror", () => githubMirrorTick(env as never, nowMs()));
  // CB1 (owner 2026-11-28: "sementara B dulu", ADR-0014 §13): the council ledger into the Forge's data repository
  // `council` (council-sync.ts; pinned to that repository, every commit checked before main moves).
  if (env.ARTIFACTS) await step("council_sync", () => councilSyncTick(env as never, nowMs()));
  // CB2b: xauusd's council_owned_keys differing from council main's allowlist becomes a branch and a pending row the
  // Supervisor proposes as merge_council_allowlist (the owner's click); main never moves here.
  if (env.ARTIFACTS && env.EXT_ORGANISM_XAUUSD) await step("council_allowlist", () => councilAllowlistTick(env as never, nowMs()));
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
  if (env.BUNDLES) {
    // Gate 8 (owner 2026-11-15): once per UTC day, after the backup, the newest stored bundle read back from R2 and
    // verified in code (header, pack checksum, every object, refs and connectivity, SHA-256 against its row).
    await step("git_backup_verify", () => gitBackupVerifyTick({ DB: env.DB, BUNDLES: env.BUNDLES as unknown as VerifyBucket }, nowMs()));
  }
  // Main's head first (2026-11-14): every deploy waits for the main check of the head it deploys
  // (forge-gate forge_main_check_pending), so a steady stream of change requests must not starve it. Change
  // requests are checked after it in the same tick, unless the main check used the tick's budget; then next tick.
  const started = nowMs();
  // CI-WB: a head waiting for its Workers Builds test report returns at once (waiting_for_test_report), unclaimed.
  await step("main_checks", () => checksTick(env, repoName, deps, nowMs, opts.reports));
  // A plan that waited for main's bundles (executor first) is planned again as soon as the main check stored them.
  if (env.ARTIFACTS && (steps.deploy_plan as { waiting?: boolean } | undefined)?.waiting) await step("deploy_plan_after_checks", deployPlan);
  const main = steps.main_checks as { outcome?: string } | undefined;
  if (main?.outcome === "checked" && nowMs() - started > CHECK_BUDGET_MS) { steps.change_checks = { outcome: "deferred" }; return steps; }
  await step("change_checks", async () => {
    // GitHub-sourced heads are read from platform (cr/<n>); only when none waits, a forge-sourced head from
    // platform-work (G4). Its type-check has no source yet: recorded as not_configured (ADR-0012 §5j).
    if (!deps) return { outcome: "not_configured" };
    const github = await changeTick(env, repoName, deps, nowMs, "platform", opts.reports);
    if (github.outcome !== "up_to_date") return github;
    const waiting = await env.DB.prepare("SELECT 1 AS waiting FROM forge_change_requests WHERE status = 'open' AND repo = ? AND blocked_reason IS NULL LIMIT 1").bind(WORK_REPO).first();
    if (!waiting) return github;
    const work = await changeTick(env, WORK_REPO, workDeps(deps), nowMs, WORK_REPO, opts.reports);
    if (work.outcome === "up_to_date") return github.waiting || work.waiting ? { ...github, waiting: [...(github.waiting ?? []), ...(work.waiting ?? [])] } : github;
    return { ...work, repo: WORK_REPO };
  });
  return steps;
}
