// The Forge cron tick (ADR-0012 phases 3-4). Three independent steps, each isolated so one failing
// never stops the others, and each failure is audited (forge.tick_failed) instead of only logged:
//   1. the deploy plan for main's head (cheap; shadow comparison with the Orchestrator);
//   2. the check of the oldest unchecked open change request head;
//   3. the check of the oldest unchecked commit of main (skipped when step 2 used most of the tick);
//   and, with CF_BUILDS_API_TOKEN, the change-request type-checks from their secret-free builds (cr-builds.ts)
//   and, once an hour, the account's measured Workers Builds minutes (build-usage.ts, owner 2026-11-12).
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { checksTick, tickWith, type ArtifactsReader, type CheckDeps } from "./checks.ts";
import { nextChangeHead } from "./changes.ts";
import { planTick } from "./deploy-plan.ts";
import { censusTick, type ExternalDnaReader } from "./census.ts";
import { EXTERNAL_ORIGINS } from "../../control-plane-shared/src/organism.ts";
import { crBuildsTick } from "./cr-builds.ts";
import { buildUsageTick } from "./build-usage.ts";

export const CHECK_BUDGET_MS = 120_000;
export interface TickEnv {
  DB: D1Database; ARTIFACTS?: { get(name: string): Promise<ArtifactsReader> }; CF_BUILDS_API_TOKEN?: string; CR_TYPECHECK_WORKER?: string;
  /** ADR-0012 G2a: the R2 bucket for the modules of passed main commits (bundles.ts). */
  BUNDLES?: import("./bundles.ts").BundleBucket;
  /** Owner 2026-11-12: the XAUUSD organs' DNA (xauusd-ai-trading-assistant OrganismDna, dna() only). */
  EXT_ORGANISM_XAUUSD?: { dna(): Promise<unknown> };
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
  // Owner 2026-11-12: the account's Workers Builds minutes against the free-tier budget (hourly; read only).
  if (env.CF_BUILDS_API_TOKEN) await step("build_usage", () => buildUsageTick(env, nowMs()));
  const started = nowMs();
  await step("change_checks", () => tickWith(env, repoName, deps, nowMs, (repo) => nextChangeHead(env.DB, repo, nowMs()), "change"));
  const change = steps.change_checks as { outcome?: string } | undefined;
  if (change?.outcome === "checked" && nowMs() - started > CHECK_BUDGET_MS) steps.main_checks = { outcome: "deferred" };
  else await step("main_checks", () => checksTick(env, repoName, deps, nowMs));
  return steps;
}
