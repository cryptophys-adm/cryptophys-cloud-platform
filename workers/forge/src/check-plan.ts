// Forge check CPU (owner 2026-11-19: "setuju semua", then "All 3 as proposed"; the coordinator's additions 4-6 the
// same day). What a check of one commit runs, decided before any test is bundled:
//   1. docs_only  a change request whose every changed path is documentation (forge-gate.ts isDocsOnlyPath) runs no
//                 test: its Worker bundles are its base's (no Worker reads Markdown) and only the changed files are
//                 scanned for secrets (the rest were scanned clean in the base's run);
//   2. reused     a change request whose git tree is byte-identical to a tree that passed a full run of the same runner
//                 (runner/core.ts runnerFingerprint) reuses that result; the type-check stays the commit's own;
//   3. partial    a change request whose changed paths need no full suite (forge-gate.ts FULL_SUITE_PATHS) runs only
//                 the test files whose recorded dependencies (their bundle's resolved paths and the paths they read
//                 through node:fs, in the base's full run) include a changed path, plus every test file the base did
//                 not have;
//   4. full       everything else, and every run of main. A run of main whose commit already has a finished FULL run
//                 as a change request head, under the same runner fingerprint, reuses those test results (the same
//                 commit, coverage full) and still snapshots, bundles, scans and stores the Worker modules; main's
//                 daily run always runs the suite again (clock-dependent tests, owner 2026-11-14).
// Docs-only and partial need a base (the request's base_sha) whose own run passed, clean, with full coverage; partial
// also needs the base's dependency record (R2, TEST_DEPS_PREFIX) under the same fingerprint. Any doubt: full.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { MAX_COVERAGE_PATHS, coverageOfSteps, isDocsOnlyPath, needsFullSuite, treeOfSteps } from "../../control-plane-shared/src/forge-gate.ts";
import { changedPaths } from "./changes.ts";
import type { ArtifactsReader } from "./checks.ts";

import { TEST_DEPS_PREFIX } from "./bundles.ts";

export { TEST_DEPS_PREFIX };
const HEX40 = /^[0-9a-f]{40}$/;
export const TEST_DEPS_SCHEMA = "forge-test-deps.v1";

export interface TestDepsRecord { schema: typeof TEST_DEPS_SCHEMA; commit: string; tree: string; fingerprint: string; deps: Record<string, string[]> }
export interface DepsReader { get?(key: string): Promise<{ text(): Promise<string> } | null> }

/** Whether a changed path hits one recorded dependency: the same path, a path under a listed directory, or "*". */
export function depHit(entry: string, path: string): boolean {
  return entry === "*" || entry === path || (entry.endsWith("/") && path.startsWith(entry));
}

/**
 * The test files a change can affect: every head test file the base did not record, and every one whose recorded
 * dependencies a changed path hits. Sorted; a subset of `headTests`.
 */
export function affectedTests(headTests: string[], baseDeps: Record<string, string[]>, changed: string[]): string[] {
  return headTests.filter((file) => {
    const deps = Object.prototype.hasOwnProperty.call(baseDeps, file) ? baseDeps[file] : null;
    if (!Array.isArray(deps)) return true;
    return changed.some((p) => p === file || deps.some((d) => depHit(String(d), p)));
  }).sort();
}

export async function readTestDeps(bucket: DepsReader | undefined, commit: string): Promise<TestDepsRecord | null> {
  if (!bucket || typeof bucket.get !== "function" || !HEX40.test(commit)) return null;
  try {
    const obj = await bucket.get(`${TEST_DEPS_PREFIX}${commit}.json`);
    if (!obj) return null;
    const r = JSON.parse(await obj.text()) as TestDepsRecord;
    if (r?.schema !== TEST_DEPS_SCHEMA || r.commit !== commit || !HEX40.test(r.tree) || typeof r.fingerprint !== "string" || !r.deps || typeof r.deps !== "object") return null;
    return r;
  } catch { return null; }
}

export interface PriorRow { commit_sha: string; status: string; guard_status: string | null; files: number | null; pass: number | null; fail: number | null; skip: number | null; failures: string | null; steps: string | null; source: string | null; finished_at: string | null }

export type ChangePlan =
  | { kind: "full"; why: string }
  | { kind: "reused"; from: PriorRow; tree: string }
  | { kind: "docs_only"; base: string; baseRun: PriorRow; changes: Array<{ path: string; change: string; head?: string }> }
  | { kind: "partial"; base: string; changed: string[]; deps: Record<string, string[]> };

const fingerprintOf = (steps: string | null): string | null => {
  try { const f = (JSON.parse(steps ?? "null") as { fingerprint?: unknown } | null)?.fingerprint; return typeof f === "string" ? f : null; } catch { return null; }
};
/** A run whose tests ran in full on its own tree (not a reused or reduced one), passed and clean. */
const passedFull = (r: PriorRow | null): r is PriorRow => !!r && r.status === "passed" && r.guard_status === "clean" && (r.fail ?? 0) === 0
  && coverageOfSteps(r.steps).mode === "full";

/** The plan for a change request head: reused, docs_only, partial or full (see the header). Never throws: doubt is full. */
export async function planChange(db: D1Database, repo: ArtifactsReader, bucket: DepsReader | undefined, commit: string, tree: string, fingerprint: string): Promise<ChangePlan> {
  try {
    // 2. The same tree already passed in full under this runner: reuse it.
    const same = await db.prepare(
      `SELECT commit_sha, status, guard_status, files, pass, fail, skip, failures, steps, source, finished_at FROM forge_check_runs
       WHERE commit_sha <> ? AND status = 'passed' AND guard_status = 'clean' AND json_extract(steps, '$.tree') = ? AND json_extract(steps, '$.fingerprint') = ?
         AND coalesce(json_extract(steps, '$.coverage.mode'), 'full') = 'full' AND json_extract(steps, '$.tests_reused') IS NULL
       ORDER BY finished_at DESC LIMIT 1`,
    ).bind(commit, tree, fingerprint).first<PriorRow>();
    if (same && passedFull(same) && treeOfSteps(same.steps) === tree) return { kind: "reused", from: same, tree };

    const cr = await db.prepare("SELECT base_sha FROM forge_change_requests WHERE head_sha = ? AND status = 'open' ORDER BY updated_at DESC, rowid DESC LIMIT 1")
      .bind(commit).first<{ base_sha: string }>();
    const base = cr?.base_sha ?? "";
    if (!HEX40.test(base) || base === commit) return { kind: "full", why: "no_base" };
    const baseRun = await db.prepare("SELECT commit_sha, status, guard_status, files, pass, fail, skip, failures, steps, source, finished_at FROM forge_check_runs WHERE commit_sha = ?")
      .bind(base).first<PriorRow>();
    if (!passedFull(baseRun)) return { kind: "full", why: "base_not_passed_in_full" };
    const { changes, truncated } = await changedPaths(repo, base, commit, MAX_COVERAGE_PATHS);
    if (truncated || changes.length === 0) return { kind: "full", why: truncated ? "too_many_changes" : "no_changes" };
    const paths = [...new Set(changes.map((c) => c.path))].sort();
    // 1. Documentation only.
    if (paths.every(isDocsOnlyPath)) {
      let bundles: unknown = null;
      try { bundles = (JSON.parse(baseRun.steps ?? "null") as { bundles?: unknown } | null)?.bundles ?? null; } catch { bundles = null; }
      if (bundles && typeof bundles === "object") return { kind: "docs_only", base, baseRun, changes };
      return { kind: "full", why: "base_has_no_bundles_step" };
    }
    // 3. Only the affected test files, when nothing changed that needs the full suite.
    if (paths.some(needsFullSuite)) return { kind: "full", why: "full_suite_path" };
    if (fingerprintOf(baseRun.steps) !== fingerprint) return { kind: "full", why: "base_runner_differs" };
    const deps = await readTestDeps(bucket, base);
    if (!deps || deps.fingerprint !== fingerprint || deps.tree !== treeOfSteps(baseRun.steps)) return { kind: "full", why: "base_deps_unavailable" };
    return { kind: "partial", base, changed: paths, deps: deps.deps };
  } catch {
    return { kind: "full", why: "plan_failed" };
  }
}

/**
 * The finished run of a change request head that a run of main of the same commit may take its test results from
 * (coordinator 2026-11-19, item 5: never run the same commit twice under the same runner): a change run of exactly this
 * commit whose tests ran in full (passed or failed), under `fingerprint`. Read before the main run's claim replaces it.
 */
export function sameCommitTests(prior: PriorRow | null, commit: string, fingerprint: string): PriorRow | null {
  if (!prior || prior.commit_sha !== commit || prior.source !== "change" || (prior.status !== "passed" && prior.status !== "failed")) return null;
  if (coverageOfSteps(prior.steps).mode !== "full" || fingerprintOf(prior.steps) !== fingerprint) return null;
  try { if ((JSON.parse(prior.steps ?? "null") as { tests_reused?: unknown } | null)?.tests_reused) return null; } catch { return null; }
  return prior;
}
