// ADR-0012 phase 3: Forge checks. The control-plane test suite is checked against main's head (each new head; since
// CI-WB, 2026-11-25, no longer again once per UTC day) and change request heads, from the Artifacts repo, with no GitHub:
//   1. snapshot: the commit's tree read through the Artifacts binding (readCommit/readTree/readBlob);
//   2. tests: since CI-WB the result of the native run in the commit's Workers Builds build (test-report.ts), taken only
//      for its exact commit and only when its test files are the snapshot's; with no report two ticks after the head was
//      first seen, the suite runs in ONE Dynamic Worker (Worker Loader, no network access; runner/core.ts runSuite
//      `single`), in groups only when that Worker is over a size limit; esbuild-wasm bundles in the Forge isolate;
//   3. bundles of every Worker and the secret scan, in the Forge isolate, as before;
//   4. type-check: reported by Workers Builds (typecheck.ts; the compiler does not fit in an isolate);
//   5. record: one row per commit in D1 (forge_check_runs), plus an audit event.
// Results are informational until the Forge and GitHub CI agree on 20 consecutive commits (ADR §5c).
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { migrationSqlOf, migrationsOf, storeBundles, pruneBundles, type BuiltModule, type BundleBucket } from "./bundles.ts";
import { lockfileSource } from "./externals.ts";
import { MAX_FILE_BYTES, SKIP_DIRS, bundleAllWorkers, runSuite, runnerFingerprint, scanSecrets, snapshotPathAllowed, testFiles, type BundleStep, type SecretFinding, type Snapshot, type SuiteDeps, type SuiteResult, type WorkerStats } from "./runner/core.ts";
import { coverageAccepted, coverageOfSteps, isReady, treeOfSteps, type Coverage } from "../../control-plane-shared/src/forge-gate.ts";
import { TEST_DEPS_PREFIX, TEST_DEPS_SCHEMA, affectedTests, planChange, sameCommitTests, type ChangePlan, type DepsReader, type PriorRow } from "./check-plan.ts";
import { applyTypecheckReportToRun, safeDiagnostics, stepFailures, typecheckStep, type TypecheckLookup, type TypecheckStep } from "./typecheck.ts";
import { noteTestReportWait, testReportOf, type StoredTestReport } from "./test-report.ts";
import { TEST_REPORT_RUNNER, sameTestFiles, testReportFailureLine } from "../../control-plane-shared/src/forge-test-report.ts";

/** What one check needs: the test-suite toolchain and the type-check lookup (Workers Builds reports). */
export interface CheckDeps extends SuiteDeps { typecheck?: TypecheckLookup; /** The runner fingerprint; computed from the toolchain when absent. */ fingerprint?: string }

const HEX40 = /^[0-9a-f]{40}$/;
export const RUNNER_ID = "forge-runner/1";
/** A run that has not finished after this long is treated as lost and may be retried. */
export const STALE_RUN_MS = 30 * 60_000;
export const MAX_SNAPSHOT_FILES = 5_000;
export const MAX_SNAPSHOT_BYTES = 20_000_000;
const MAX_FAILURES_STORED = 50;
const CONCURRENCY = 16;

export interface ArtifactsTreeEntry { name: string; mode: string; hash: string; type: "tree" | "blob" | "symlink" | "gitlink" | "exec" }
export interface ArtifactsReader {
  readCommit(hash: string): Promise<{ hash: string; treeHash: string } | null>;
  readTree(hash: string): Promise<ArtifactsTreeEntry[] | null>;
  readBlob(hash: string): Promise<Blob | null>;
  log(opts?: { ref?: string; limit?: number }): Promise<Array<Record<string, unknown>>>;
  [Symbol.dispose]?(): void;
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

/**
 * The text files of a commit, as the runner sees a checkout: no node_modules, .git or build output,
 * no binary files, nothing over 2 MB. Symlinks and submodules are left out.
 */
export async function snapshotFromArtifacts(repo: ArtifactsReader, commit: string): Promise<{ snapshot: Snapshot; files: number; bytes: number }> {
  if (!HEX40.test(commit)) throw new Error("invalid_commit");
  const meta = await repo.readCommit(commit);
  if (!meta || meta.hash !== commit || !HEX40.test(meta.treeHash)) throw new Error("commit_not_found");
  const blobs: Array<{ path: string; hash: string }> = [];
  let level: Array<{ prefix: string; hash: string }> = [{ prefix: "", hash: meta.treeHash }];
  while (level.length > 0) {
    const nextLevel: typeof level = [];
    await pool(level, CONCURRENCY, async ({ prefix, hash }) => {
      const entries = await repo.readTree(hash);
      if (!entries) throw new Error("tree_not_found");
      for (const e of entries) {
        if (!e.name || e.name === "." || e.name === ".." || e.name.includes("/") || !HEX40.test(e.hash)) throw new Error("invalid_tree_entry");
        const path = prefix + e.name;
        if (e.type === "tree") { if (!SKIP_DIRS.has(e.name)) nextLevel.push({ prefix: path + "/", hash: e.hash }); }
        else if ((e.type === "blob" || e.type === "exec") && snapshotPathAllowed(path)) blobs.push({ path, hash: e.hash });
      }
    });
    level = nextLevel;
    if (blobs.length > MAX_SNAPSHOT_FILES) throw new Error("snapshot_too_large");
  }
  const snapshot: Snapshot = {};
  let bytes = 0;
  await pool(blobs, CONCURRENCY, async ({ path, hash }) => {
    const blob = await repo.readBlob(hash);
    if (!blob) throw new Error("blob_not_found");
    if (blob.size >= MAX_FILE_BYTES) return;
    bytes += blob.size;
    if (bytes > MAX_SNAPSHOT_BYTES) throw new Error("snapshot_too_large");
    snapshot[path] = await blob.text();
  });
  const sorted: Snapshot = {};
  for (const k of Object.keys(snapshot).sort()) sorted[k] = snapshot[k];
  return { snapshot: sorted, files: blobs.length, bytes };
}

/** The last snapshot taken in this isolate, for the bundler entrypoint the test Workers call back. */
let lastSnapshot: { commit: string; snapshot: Snapshot } | null = null;
export function cachedSnapshot(commit: string): Snapshot | null {
  return lastSnapshot?.commit === commit ? lastSnapshot.snapshot : null;
}

/**
 * One commit's checks. `status` covers what GitHub CI also runs (the tests and the Worker bundles), so
 * the two can be compared. The guards (secret scan) are reported apart, in `guard_status`; the merge
 * gate of phase 4 requires both.
 */
export interface CheckSteps {
  tests: { files: number; pass: number; fail: number; skip: number; isolated?: number };
  bundles: { workers: number; failed: BundleStep["failed"]; bundles: BundleStep["bundles"] };
  secrets: { files: number; findings: SecretFinding[] };
  /** Absent in runs recorded before the type-check step; `pending` until the build of the commit reports. */
  typecheck?: TypecheckStep;
  /**
   * The run's Dynamic Workers (2026-11-14; absent before): groups run, distinct test Worker ids (content
   * addresses) and Worker Loader `get` calls, isolated reruns included. Informational; never part of the verdict.
   */
  workers?: WorkerStats;
  /**
   * Forge check CPU (2026-11-19). What the tests covered (forge-gate.ts Coverage; absent before: full), the commit's git
   * tree, the runner fingerprint, the change request the run was for, the summed wall time of the run's test Worker
   * requests (the Worker Loader exposes no CPU time), and, when a run of main took its test results from the same
   * commit's full change request run under the same fingerprint, where they came from.
   */
  coverage?: Coverage;
  tree?: string;
  fingerprint?: string;
  cr_id?: string;
  worker_wall_ms?: number;
  tests_reused?: { from: "change"; commit: string; finished_at: string | null };
  /**
   * CI-WB (2026-11-25): the tests are the commit's Workers Builds report (test-report.ts), not a run of the Forge; then
   * `workers` is all zero and the row's runner is TEST_REPORT_RUNNER.
   */
  test_report?: { build_uuid: string; source: "workers_builds" };
}
export interface CheckRun extends SuiteResult {
  commit: string; status: "passed" | "failed"; guard_status: "clean" | "findings"; steps: CheckSteps;
  duration_ms: number; snapshot_files: number; snapshot_bytes: number;
  /** forge_check_runs.runner when it is not RUNNER_ID (a run whose tests came from Workers Builds). */
  runner?: string;
}

/**
 * How a check limits its tests (2026-11-19): `partial` runs only the head's test files a change can affect, given the
 * base's dependency record; `reuseTests` takes the test results of the same commit's full change run (a run of main).
 */
export interface CheckOptions {
  partial?: { base: string; changed: string[]; deps: Record<string, string[]> };
  reuseTests?: PriorRow;
  tree?: string; fingerprint?: string; crId?: string;
  /** CI-WB: the commit's Workers Builds test report; the suite is not run (it wins over `partial` and `reuseTests`). */
  testReport?: StoredTestReport;
  /** CI-WB: a suite the Forge does run runs in one Dynamic Worker (runner/core.ts runSuite `single`). */
  singleWorker?: boolean;
}

const NOT_TEST_FAILURE = /^(bundle |secret |typecheck |console-build )/;

/** Snapshot, bundle and run one commit. Test failures are a result; only infrastructure errors throw. */
export async function checkCommit(repo: ArtifactsReader, commit: string, deps: (commit: string) => Promise<CheckDeps>, now = () => Date.now(), only?: string[], built?: BuiltModule[], opts: CheckOptions = {}): Promise<CheckRun> {
  const started = now();
  const snap = await snapshotFromArtifacts(repo, commit);
  lastSnapshot = { commit, snapshot: snap.snapshot };
  const suite = await deps(commit);
  const fingerprint = opts.fingerprint ?? suite.fingerprint ?? await runnerFingerprint(suite);
  let coverage: Coverage = { mode: "full" };
  let selected = only;
  const report = opts.testReport;
  if (!selected && opts.partial && !report) {
    const all = testFiles(snap.snapshot);
    const affected = affectedTests(all, opts.partial.deps, opts.partial.changed);
    if (affected.length < all.length) {
      selected = affected;
      coverage = { mode: "partial", base: opts.partial.base, files: affected.length, of: all.length, changed: opts.partial.changed };
    }
  }
  let suiteResult: SuiteResult;
  const reused = report ? undefined : opts.reuseTests;
  if (report) {
    // CI-WB: the build's own run of this commit. Only for this exact commit (and tree), and only when the build ran
    // exactly the snapshot's test files: a report of fewer, more or other files would pass tests that never ran.
    if (report.commit !== commit) throw new Error("test_report_commit_mismatch");
    if (report.tree && opts.tree && report.tree !== opts.tree) throw new Error(`test_report_tree_mismatch: the report is of tree ${report.tree.slice(0, 12)}, the commit's is ${opts.tree.slice(0, 12)}`);
    const own = testFiles(snap.snapshot);
    if (!sameTestFiles(report.files, own)) {
      const theirs = new Set(report.files); const ours = new Set(own);
      const missing = own.filter((f) => !theirs.has(f)); const extra = report.files.filter((f) => !ours.has(f));
      throw new Error(`test_report_files_mismatch: the build ran ${report.files.length} test files, the snapshot has ${own.length}`
        + `${missing.length ? `; not run: ${missing.slice(0, 3).map((f) => f.split("/").pop()).join(", ")}${missing.length > 3 ? ", ..." : ""}` : ""}`
        + `${extra.length ? `; not in the snapshot: ${extra.slice(0, 3).map((f) => f.split("/").pop()).join(", ")}${extra.length > 3 ? ", ..." : ""}` : ""}`);
    }
    suiteResult = { files: report.files.length, pass: report.pass, fail: report.fail, skip: report.skip, failures: report.failures.map(testReportFailureLine), workers: { groups: 0, bundles: 0, loads: 0 } };
  } else if (reused) {
    // The same commit, the same runner: its full change run's test results (coordinator 2026-11-19, item 5).
    let tests: CheckSteps["tests"] | undefined;
    let priorFailures: string[] = [];
    try { tests = (JSON.parse(reused.steps ?? "null") as { tests?: CheckSteps["tests"] } | null)?.tests; } catch { tests = undefined; }
    try { const f = JSON.parse(reused.failures ?? "[]"); if (Array.isArray(f)) priorFailures = f.map(String).filter((x) => !NOT_TEST_FAILURE.test(x)); } catch { priorFailures = []; }
    if (!tests || !Number.isInteger(tests.files) || tests.files <= 0) throw new Error("reused_tests_unreadable");
    suiteResult = { files: tests.files, pass: tests.pass, fail: tests.fail, skip: tests.skip, failures: priorFailures, ...(tests.isolated ? { isolated: tests.isolated } : {}) };
  } else {
    suiteResult = await runSuite(suite, snap.snapshot, selected, commit, opts.singleWorker ? { single: true } : {});
  }
  const { workers, worker_wall_ms: wallMs, ...result } = suiteResult;
  if (result.files === 0 && coverage.mode !== "partial") throw new Error("no_test_files");
  const bundles = await bundleAllWorkers(suite.esbuild, snap.snapshot, built ? (dir, m) => { built.push({ dir, ...m }); } : undefined);
  const secrets = scanSecrets(snap.snapshot);
  // A type error fails the check, as it fails GitHub CI. A report that has not arrived yet leaves the
  // step `pending`; recordTypecheckReport folds it into this run when it comes (phase 4's gate requires "passed").
  const typecheck: TypecheckStep = suite.typecheck ? await suite.typecheck(commit) : { status: "not_configured" };
  const failures = [
    ...result.failures, ...bundles.failed.map((b) => `bundle ${b.dir}: ${b.error}`),
    ...stepFailures(typecheck),
    ...secrets.findings.map((f) => `secret ${f.rule} at ${f.path}:${f.line}`),
  ];
  return {
    ...result, failures, commit,
    status: result.fail === 0 && bundles.failed.length === 0 && typecheck.status !== "failed" ? "passed" : "failed",
    guard_status: secrets.findings.length === 0 ? "clean" : "findings",
    steps: {
      tests: { files: result.files, pass: result.pass, fail: result.fail, skip: result.skip, ...(result.isolated ? { isolated: result.isolated } : {}) },
      bundles: { workers: bundles.workers, failed: bundles.failed, bundles: bundles.bundles },
      secrets,
      typecheck,
      ...(workers ? { workers } : {}),
      coverage, ...(opts.tree ? { tree: opts.tree } : {}), fingerprint, ...(opts.crId ? { cr_id: opts.crId } : {}),
      ...(wallMs !== undefined ? { worker_wall_ms: wallMs } : {}),
      ...(reused ? { tests_reused: { from: "change" as const, commit: reused.commit_sha, finished_at: reused.finished_at } } : {}),
      ...(report ? { test_report: { build_uuid: report.build_uuid, source: "workers_builds" as const } } : {}),
    },
    duration_ms: now() - started, snapshot_files: Object.keys(snap.snapshot).length, snapshot_bytes: snap.bytes,
    ...(report ? { runner: TEST_REPORT_RUNNER } : {}),
  };
}

/**
 * A change request head whose tree passed a full run of the same runner (`reused`), or whose change is documentation
 * only (`docs_only`): no snapshot, no test, no Worker bundle. The type-check is the commit's own report.
 */
async function checkWithoutTests(repo: ArtifactsReader, commit: string, suite: CheckDeps, plan: Extract<ChangePlan, { kind: "reused" | "docs_only" }>, opts: { tree: string; fingerprint: string; crId?: string }, now: () => number): Promise<CheckRun> {
  const started = now();
  const typecheck: TypecheckStep = suite.typecheck ? await suite.typecheck(commit) : { status: "not_configured" };
  const source = plan.kind === "reused" ? plan.from : plan.baseRun;
  const prior = JSON.parse(source.steps ?? "null") as Partial<CheckSteps> | null;
  const bundles = prior?.bundles;
  if (!bundles || !Array.isArray(bundles.failed) || !Array.isArray(bundles.bundles)) throw new Error("prior_bundles_unreadable");
  let tests: CheckSteps["tests"] = { files: 0, pass: 0, fail: 0, skip: 0 };
  let secrets: CheckSteps["secrets"];
  let coverage: Coverage;
  if (plan.kind === "reused") {
    if (!prior?.tests || !prior.secrets) throw new Error("prior_steps_unreadable");
    tests = prior.tests;
    secrets = prior.secrets;
    coverage = { mode: "reused", from: plan.from.commit_sha, tree: plan.tree };
  } else {
    // Only the changed documents are new; the base's run scanned the rest clean.
    const texts: Snapshot = {};
    for (const c of plan.changes) {
      if (c.change === "deleted" || !c.head || !snapshotPathAllowed(c.path)) continue;
      const blob = await repo.readBlob(c.head);
      if (!blob) throw new Error("blob_not_found");
      if (blob.size < MAX_FILE_BYTES) texts[c.path] = await blob.text();
    }
    secrets = scanSecrets(texts);
    coverage = { mode: "docs_only", base: plan.base, paths: [...new Set(plan.changes.map((c) => c.path))].sort() };
  }
  const failures = [...stepFailures(typecheck), ...secrets.findings.map((f) => `secret ${f.rule} at ${f.path}:${f.line}`)];
  return {
    files: tests.files, pass: tests.pass, fail: tests.fail, skip: tests.skip, failures, commit,
    status: tests.fail === 0 && bundles.failed.length === 0 && typecheck.status !== "failed" ? "passed" : "failed",
    guard_status: secrets.findings.length === 0 ? "clean" : "findings",
    steps: { tests, bundles, secrets, typecheck, coverage, tree: opts.tree, fingerprint: opts.fingerprint, ...(opts.crId ? { cr_id: opts.crId } : {}) },
    duration_ms: now() - started, snapshot_files: 0, snapshot_bytes: 0,
  };
}

export interface CheckRow {
  commit_sha: string; status: string; runner: string; files: number | null; pass: number | null; fail: number | null; skip: number | null;
  failures: string | null; started_at: string; finished_at: string | null; duration_ms: number | null;
  steps: string | null; guard_status: string | null;
}

/** 00:00 UTC of the day `nowMs` falls in. */
export function utcDayStart(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Pick the commit of main to check: main's head, when it has no run, its run was lost (still "running" after
 * 30 minutes) or ended in error 30 minutes ago or more, or it was checked only as a change request head.
 * Returns null otherwise. Older commits are never checked: a newer head superseded them, and only the head is
 * deployed (forge-gate.ts) or merged onto (owner, 2026-11-14: one run of the suite per head, not per commit).
 *
 * After the cut-over (ADR-0012 G6) the Forge fast-forwards main to a change request's head, which already has a
 * passed run with source 'change'. Only a run of main stores the commit's Worker bundles (G2a), so without a
 * second run every merged commit had no bundles and the native deploy refused it (no_bundle; 2026-11-13).
 *
 * The daily run (owner, 2026-11-14) is dropped (CI-WB, 2026-11-25; owner: "ok jalankan rekomendasimu"): a finished run of
 * main of the head (passed or failed) is final while the head is unchanged. The same commit is the same tree, and the
 * runner is in the repository, so the same fingerprint; re-running it every day only re-billed every test Worker. Lost and
 * errored runs are still retried.
 */
export async function nextCommit(db: D1Database, repo: ArtifactsReader, nowMs: number): Promise<string | null> {
  const log = await repo.log({ ref: "main", limit: 1 });
  const head = typeof log[0]?.hash === "string" ? log[0].hash : "";
  if (!HEX40.test(head)) return null;
  const row = await db.prepare("SELECT status, started_at, finished_at, source FROM forge_check_runs WHERE commit_sha = ?").bind(head)
    .first<Pick<CheckRow, "status" | "started_at" | "finished_at"> & { source: CheckSource | null }>();
  if (!row) return head;
  if (row.status === "running" || row.status === "error") return Date.parse(row.started_at) < nowMs - STALE_RUN_MS ? head : null;
  if (row.source === "change") return head;
  return null;
}

/** What a check was of (migration 0039): a commit of main, or a change request head. */
export type CheckSource = "main" | "change";

/**
 * Claim a commit for this tick. False if another tick holds a live run of it; a run lost or ended in error is taken
 * over once it is STALE_RUN_MS old (2026-11-17). A run of main also takes over a
 * finished run of the same commit as a change request head (nextCommit), so that the commit's bundles are stored.
 * A finished run of main is never taken over (CI-WB, 2026-11-25: no daily run of an unchanged head).
 */
export async function claim(db: D1Database, commit: string, nowMs: number, source: CheckSource = "main"): Promise<boolean> {
  const startedAt = new Date(nowMs).toISOString();
  const staleBefore = new Date(nowMs - STALE_RUN_MS).toISOString();
  const r = await db.prepare(
    `INSERT INTO forge_check_runs (commit_sha, status, runner, started_at, source) VALUES (?, 'running', ?, ?, ?)
     ON CONFLICT(commit_sha) DO UPDATE SET status = 'running', runner = excluded.runner, started_at = excluded.started_at, source = excluded.source,
       files = NULL, pass = NULL, fail = NULL, skip = NULL, failures = NULL, finished_at = NULL, duration_ms = NULL, steps = NULL, guard_status = NULL
     WHERE (forge_check_runs.status IN ('running', 'error') AND forge_check_runs.started_at < ?)
        OR (excluded.source = 'main' AND forge_check_runs.source = 'change' AND forge_check_runs.status <> 'running')`,
  ).bind(commit, RUNNER_ID, startedAt, source, staleBefore).run();
  return (r.meta?.changes ?? 0) > 0;
}

function storedFailures(failures: string[]): string {
  return JSON.stringify(failures.slice(0, MAX_FAILURES_STORED).map((f) => f.slice(0, 600)));
}

async function applyStoredTypecheckReport(db: D1Database, commit: string): Promise<void> {
  const step = await typecheckStep(db, commit);
  if (step.status !== "pending") await applyTypecheckReportToRun(db, commit, step);
}

export async function record(db: D1Database, run: CheckRun | { commit: string; status: "error"; error: string; duration_ms: number }, nowMs: number): Promise<void> {
  const finishedAt = new Date(nowMs).toISOString();
  if (run.status === "error") {
    await db.prepare("UPDATE forge_check_runs SET status = 'error', failures = ?, finished_at = ?, duration_ms = ? WHERE commit_sha = ?")
      .bind(storedFailures([run.error]), finishedAt, run.duration_ms, run.commit).run();
    await applyStoredTypecheckReport(db, run.commit);
    return;
  }
  await db.prepare("UPDATE forge_check_runs SET status = ?, runner = ?, files = ?, pass = ?, fail = ?, skip = ?, failures = ?, finished_at = ?, duration_ms = ?, steps = ?, guard_status = ? WHERE commit_sha = ?")
    .bind(run.status, run.runner ?? RUNNER_ID, run.files, run.pass, run.fail, run.skip, storedFailures(run.failures), finishedAt, run.duration_ms, JSON.stringify(run.steps), run.guard_status, run.commit).run();
  await applyStoredTypecheckReport(db, run.commit);
}

export interface ScheduledEnv { DB: D1Database; ARTIFACTS?: { get(name: string): Promise<ArtifactsReader> }; BUNDLES?: BundleBucket & DepsReader }
export type TickOutcome =
  | { outcome: "not_configured" | "up_to_date" | "busy" }
  | { outcome: "checked"; commit: string; status: string; pass?: number; fail?: number; coverage?: string; tests?: "workers_builds" }
  /** CI-WB: the head has no Workers Builds test report yet and has waited less than the policy's waitMs; nothing was claimed. */
  | { outcome: "waiting_for_test_report"; commit: string; waited_ms: number };

/**
 * CI-WB (2026-11-25): where a check's tests come from. With a policy, a head whose tests must run takes its commit's Workers
 * Builds report (test-report.ts); without one it waits `waitMs` from when the Forge first saw it so (two ticks, ≈30 min:
 * test-report.ts TEST_REPORT_WAIT_MS), unclaimed, so the rest of the tick goes on; then the suite runs in one Dynamic
 * Worker. Without a policy (the local harness, and the checks' own older tests) a check runs the suite at once, in groups.
 */
export interface TestReportPolicy { waitMs: number }

/** One cron tick: check main's head, when nextCommit says it is due. */
export async function checksTick(env: ScheduledEnv, repoName: string, deps: ((commit: string) => Promise<CheckDeps>) | null, nowMs = () => Date.now(), reports?: TestReportPolicy): Promise<TickOutcome> {
  return tickWith(env, repoName, deps, nowMs, (repo) => nextCommit(env.DB, repo, nowMs()), "main", reports);
}

/** What a check of one commit is decided from, before any test is bundled. */
interface Prepared { suite: CheckDeps; fingerprint: string; tree?: string; crId?: string; plan: ChangePlan; reuseTests?: PriorRow }

async function prepare(env: ScheduledEnv, repo: ArtifactsReader, commit: string, deps: (commit: string) => Promise<CheckDeps>, source: CheckSource, prior: PriorRow | null): Promise<Prepared> {
  const suite = await deps(commit);
  const fingerprint = suite.fingerprint ?? await runnerFingerprint(suite);
  const meta = await repo.readCommit(commit);
  const tree = meta && HEX40.test(meta.treeHash) ? meta.treeHash : undefined;
  const cr = source === "change"
    ? await env.DB.prepare("SELECT cr_id FROM forge_change_requests WHERE head_sha = ? AND status = 'open' ORDER BY updated_at DESC, rowid DESC LIMIT 1").bind(commit).first<{ cr_id: string }>()
    : null;
  // A change request head: reused, docs-only, partial or full (check-plan.ts). A run of main is always full.
  const plan: ChangePlan = source === "change" && tree ? await planChange(env.DB, repo, env.BUNDLES, commit, tree, fingerprint) : { kind: "full", why: "main" };
  // A run of main taking over the same commit's change run reuses its full test results; a lost or failed run (not
  // finished) runs the suite (check-plan.ts sameCommitTests).
  const reuseTests = source === "main" ? sameCommitTests(prior, commit, fingerprint) ?? undefined : undefined;
  return { suite, fingerprint, tree, crId: cr?.cr_id, plan, reuseTests };
}

/** Claim, check, record and audit one commit picked by `pick` (a commit of main, or a change request head). */
export async function tickWith(env: ScheduledEnv, repoName: string, deps: ((commit: string) => Promise<CheckDeps>) | null, nowMs: () => number, pick: (repo: ArtifactsReader) => Promise<string | null>, source: CheckSource = "main", reports?: TestReportPolicy): Promise<TickOutcome> {
  if (!env.ARTIFACTS || !deps) return { outcome: "not_configured" };
  const repo = await env.ARTIFACTS.get(repoName);
  try {
    const commit = await pick(repo);
    if (!commit) return { outcome: "up_to_date" };
    // A run of main may take its test results from the same commit's finished change run (2026-11-19, item 5): read it
    // before the claim replaces the row.
    const prior = source === "main"
      ? await env.DB.prepare("SELECT commit_sha, status, guard_status, files, pass, fail, skip, failures, steps, source, finished_at FROM forge_check_runs WHERE commit_sha = ?").bind(commit).first<PriorRow>()
      : null;
    // CI-WB: with a report policy the check is decided before the claim, so a head still waiting for its Workers Builds
    // report is left unclaimed (no row, no 'running' state) and costs this tick nothing more. A failure to decide is
    // recorded as the run's error after the claim, as before.
    let prepared: Prepared | undefined;
    let prepError: unknown;
    let report: StoredTestReport | null = null;
    if (reports) {
      try { prepared = await prepare(env, repo, commit, deps, source, prior); } catch (e) { prepError = e ?? new Error("prepare_failed"); }
      if (prepared && (prepared.plan.kind === "full" || prepared.plan.kind === "partial")) {
        report = await testReportOf(env.DB, commit);
        if (!report && !prepared.reuseTests) {
          const since = await noteTestReportWait(env.DB, commit, nowMs());
          const waited = nowMs() - since;
          if (waited < reports.waitMs) return { outcome: "waiting_for_test_report", commit, waited_ms: waited };
        }
      }
    }
    if (!(await claim(env.DB, commit, nowMs(), source))) return { outcome: "busy" };
    const started = nowMs();
    let status: string;
    let runner = RUNNER_ID;
    let counts: { pass?: number; fail?: number; coverage?: string; tests?: "workers_builds" } = {};
    try {
      if (prepError !== undefined) throw prepError;
      // ADR-0012 G2a: a commit of main keeps the Worker modules its check bundled, for the deploy.
      const built: BuiltModule[] | undefined = source === "main" && env.BUNDLES ? [] : undefined;
      const { suite, fingerprint, tree, crId, plan, reuseTests } = prepared ?? await prepare(env, repo, commit, deps, source, prior);
      const base = { tree, fingerprint, crId };
      const run = plan.kind === "reused" || plan.kind === "docs_only"
        ? await checkWithoutTests(repo, commit, suite, plan, { tree: tree!, fingerprint, crId }, nowMs)
        : await checkCommit(repo, commit, async () => suite, nowMs, undefined, built, {
          ...base, partial: plan.kind === "partial" ? plan : undefined, reuseTests,
          ...(report ? { testReport: report } : {}), ...(reports ? { singleWorker: true } : {}),
        });
      // The full run's per-file dependencies, for the partial runs of change requests based on this commit.
      // Only a passed, clean run is ever a base (check-plan.ts), so a failed one stores nothing.
      if (env.BUNDLES && run.deps && run.status === "passed" && run.guard_status === "clean" && run.steps.coverage?.mode === "full" && !run.steps.tests_reused && tree) {
        try {
          await env.BUNDLES.put(`${TEST_DEPS_PREFIX}${commit}.json`, JSON.stringify({ schema: TEST_DEPS_SCHEMA, commit, tree, fingerprint, deps: run.deps }), { httpMetadata: { contentType: "application/json" } });
        } catch { /* only an optimisation: a missing record runs the next change request in full */ }
      }
      status = run.status;
      runner = run.runner ?? RUNNER_ID;
      counts = { pass: run.pass, fail: run.fail, ...(run.steps.test_report ? { tests: "workers_builds" as const } : {}) };
      // The run is recorded after its bundles are stored (2026-11-16): a passed row of main is the deploy gate
      // (forgeReady), and the deploy of 4001de2 decided between the two writes found no bundle and fell back to
      // the GitHub workflow (no_bundle). Until the row is written it stays 'running': forge_checks_pending.
      if (built && env.BUNDLES && run.status === "passed" && run.guard_status === "clean") {
        try {
          // G2b: the commit's D1 migrations, from the snapshot this check ran on.
          const snapshot = cachedSnapshot(commit);
          if (!snapshot) throw new Error("snapshot_unavailable");
          // G2c-1: and their SQL, and the extra modules of a multi-module Worker from the packages its lockfile pins.
          const manifest = await storeBundles(env.BUNDLES, commit, built, nowMs(), migrationsOf(Object.keys(snapshot)), { migrationSql: migrationSqlOf(snapshot), externals: lockfileSource(snapshot) });
          await appendAuditEvent(env.DB, { event_type: "forge.bundles_stored", actor: "system:forge-checks", subject: commit, outcome: "stored", payload: { workers: manifest.workers.length, single_module: manifest.workers.filter((w) => w.single_module).length, modules_stored: manifest.workers.filter((w) => w.modules).length, modules_failed: manifest.workers.filter((w) => w.modules_error).map((w) => `${w.name}: ${w.modules_error}`) } });
          await pruneBundles(env.BUNDLES, nowMs());
        } catch (e) {
          // Storing is for the deploy; a failure never changes the check's result.
          await appendAuditEvent(env.DB, { event_type: "forge.bundles_failed", actor: "system:forge-checks", subject: commit, outcome: "failed", payload: { error: String((e as Error)?.message ?? e).slice(0, 200) } }).catch(() => undefined);
        }
      }
      await record(env.DB, run, nowMs());
      if (run.steps.coverage && run.steps.coverage.mode !== "full") counts = { ...counts, coverage: run.steps.coverage.mode };
    } catch (e) {
      status = "error";
      await record(env.DB, { commit, status: "error", error: String((e as Error)?.message ?? e).slice(0, 300), duration_ms: nowMs() - started }, nowMs());
    }
    await appendAuditEvent(env.DB, { event_type: "forge.checks_completed", actor: "system:forge-checks", subject: commit, outcome: status, payload: { runner, ...counts } });
    return { outcome: "checked", commit, status, ...counts };
  } finally {
    repo[Symbol.dispose]?.();
  }
}

export interface CheckSummary {
  commit: string; status: string; runner: string; files: number | null; pass: number | null; fail: number | null; skip: number | null;
  failures: string[]; started_at: string; finished_at: string | null; duration_ms: number | null;
  /** Bundles and guards: Worker count and failures, secret-scan outcome (null for runs before 0033). */
  bundles: { workers: number; failed: number } | null; guard_status: string | null;
  /**
   * The Workers Builds step (null for runs before it existed): `status` covers both parts, `errors`
   * the control-plane type errors, `console_build` the Console UI build (null before builds reported it).
   */
  typecheck: { status: string; errors: number | null; build_id: string | null; console_build: "passed" | "failed" | null } | null;
  /**
   * Every gate passed: tests and bundles, no secret, control-plane types, Console UI build. Phase 4's
   * merge gate and the deploy proposals require it; a pending or older-format step is not ready.
   */
  ready: boolean;
  /** The GitHub CI conclusion for the same commit, and whether the two agree (null while either is missing). */
  github: "success" | "failure" | null; agrees: boolean | null;
  /**
   * 2026-11-19: what the tests covered (full for runs before markers), whether the gate accepts that coverage for a
   * merge (`ready` already requires it), the run's source and git tree, and its Dynamic Workers: groups, distinct
   * Worker ids, Worker Loader requests and their summed wall time (CPU time is not exposed by the loader).
   */
  coverage?: Coverage; coverage_accepted?: boolean; source?: string | null; tree?: string | null;
  workers?: { groups: number; ids: number; loads: number; wall_ms: number | null } | null;
}

/** ADR-0012 §5c: the Forge checks must agree with GitHub CI on this many consecutive commits. */
export const PARITY_TARGET = 20;
const PARITY_WINDOW = 100;

export interface Parity { target: number; consecutive: number; compared: number; disagreements: string[] }

/** Agreement: the Forge passed and GitHub CI succeeded, or the Forge failed and GitHub CI failed. */
export function agreement(status: string, github: string | null): boolean | null {
  if (!github || status === "running") return null;
  if (status === "error") return false;
  return (status === "passed") === (github === "success");
}

/** Consecutive agreements, newest first, over commits that have both results. */
export function parity(rows: Array<{ commit: string; agrees: boolean | null }>): Parity {
  let consecutive = 0;
  let broken = false;
  let compared = 0;
  const disagreements: string[] = [];
  for (const r of rows) {
    if (r.agrees === null) continue;
    compared++;
    if (r.agrees && !broken) consecutive++;
    if (!r.agrees) { broken = true; disagreements.push(r.commit); }
  }
  return { target: PARITY_TARGET, consecutive, compared, disagreements: disagreements.slice(0, 20) };
}

type JoinedRow = CheckRow & { github: "success" | "failure" | null; source?: string | null };

function stepsWorkers(steps: string | null): CheckSummary["workers"] {
  try {
    const p = JSON.parse(steps ?? "null") as { workers?: WorkerStats; worker_wall_ms?: unknown } | null;
    if (!p?.workers) return null;
    return { groups: Number(p.workers.groups ?? 0), ids: Number(p.workers.bundles ?? 0), loads: Number(p.workers.loads ?? 0), wall_ms: typeof p.worker_wall_ms === "number" ? p.worker_wall_ms : null };
  } catch { return null; }
}

function stepsBundles(steps: string | null): { workers: number; failed: number } | null {
  try {
    const parsed = JSON.parse(steps ?? "null") as { bundles?: { workers?: number; failed?: unknown[] } } | null;
    return parsed?.bundles ? { workers: Number(parsed.bundles.workers ?? 0), failed: (parsed.bundles.failed ?? []).length } : null;
  } catch { return null; }
}

function stepsTypecheck(steps: string | null): CheckSummary["typecheck"] {
  try {
    const t = (JSON.parse(steps ?? "null") as { typecheck?: TypecheckStep } | null)?.typecheck;
    if (!t) return null;
    const cb = t.console_build?.status;
    return { status: String(t.status), errors: typeof t.errors === "number" ? t.errors : null, build_id: t.build_id ?? null, console_build: cb === "passed" || cb === "failed" ? cb : null };
  } catch { return null; }
}

/** The gate (control-plane-shared/src/forge-gate.ts): the Orchestrator's deploy decisions read the same one (ADR-0012 G1). */
export { isReady } from "../../control-plane-shared/src/forge-gate.ts";

function summary(r: JoinedRow): CheckSummary {
  let failures: string[] = [];
  try { const parsed = JSON.parse(r.failures ?? "[]"); if (Array.isArray(parsed)) failures = parsed.map(String); } catch { /* stored by record(); never malformed */ }
  failures = failures.map((failure) => {
    const prefix = failure.startsWith("typecheck ") ? "typecheck " : failure.startsWith("console-build ") ? "console-build " : "";
    return prefix ? `${prefix}${safeDiagnostics([failure.slice(prefix.length)])[0]}` : failure;
  });
  const typecheck = stepsTypecheck(r.steps);
  const coverage = coverageOfSteps(r.steps);
  const tree = treeOfSteps(r.steps);
  const covered = coverageAccepted(coverage, { commit: r.commit_sha, source: r.source ?? "main", tree }, "merge");
  return {
    commit: r.commit_sha, status: r.status, runner: r.runner, files: r.files, pass: r.pass, fail: r.fail, skip: r.skip, failures,
    started_at: r.started_at, finished_at: r.finished_at, duration_ms: r.duration_ms,
    bundles: stepsBundles(r.steps), guard_status: r.guard_status ?? null, typecheck,
    ready: isReady(r.status, r.guard_status ?? null, typecheck, covered),
    github: r.github ?? null, agrees: agreement(r.status, r.github ?? null),
    coverage, coverage_accepted: covered, source: r.source ?? "main", tree, workers: stepsWorkers(r.steps),
  };
}

/** The check of one commit (a change request head or a commit of main), or null if none was recorded. */
export async function checkOf(db: D1Database, commit: string): Promise<CheckSummary | null> {
  const r = await db.prepare(
    `SELECT r.*, g.conclusion AS github FROM forge_check_runs r LEFT JOIN forge_ci_reports g ON g.commit_sha = r.commit_sha WHERE r.commit_sha = ?`,
  ).bind(commit).first<JoinedRow>();
  return r ? summary(r) : null;
}

export async function listChecks(db: D1Database, limit: number): Promise<{ checks: CheckSummary[]; parity: Parity }> {
  const n = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
  // Change request heads (current and earlier ones) are listed with their change request, not as commits of main.
  const rows = await db.prepare(
    `SELECT r.*, g.conclusion AS github FROM forge_check_runs r LEFT JOIN forge_ci_reports g ON g.commit_sha = r.commit_sha
     WHERE coalesce(r.source, 'main') = 'main' AND r.commit_sha NOT IN (SELECT head_sha FROM forge_change_requests WHERE status = 'open')
     ORDER BY r.started_at DESC LIMIT ?`,
  ).bind(Math.max(n, PARITY_WINDOW)).all<JoinedRow>();
  const all = (rows.results ?? []).map(summary);
  return { checks: all.slice(0, n), parity: parity(all) };
}

/** GitHub CI's conclusion for a commit of main (forge-ci-report.yml). A re-run replaces it. */
export async function recordCiReport(db: D1Database, input: { commit: unknown; conclusion: unknown; workflow_run_id: unknown }, actor: string, nowMs = Date.now()): Promise<{ commit: string; conclusion: string }> {
  const commit = typeof input.commit === "string" ? input.commit : "";
  const conclusion = input.conclusion;
  const runId = typeof input.workflow_run_id === "string" || typeof input.workflow_run_id === "number" ? String(input.workflow_run_id) : "";
  if (!HEX40.test(commit)) throw Object.assign(new Error("invalid_commit"), { status: 400 });
  if (conclusion !== "success" && conclusion !== "failure") throw Object.assign(new Error("invalid_conclusion"), { status: 400 });
  if (!/^\d{1,20}$/.test(runId)) throw Object.assign(new Error("invalid_workflow_run_id"), { status: 400 });
  await db.prepare(
    `INSERT INTO forge_ci_reports (commit_sha, conclusion, workflow_run_id, reported_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(commit_sha) DO UPDATE SET conclusion = excluded.conclusion, workflow_run_id = excluded.workflow_run_id, reported_at = excluded.reported_at`,
  ).bind(commit, conclusion, runId, new Date(nowMs).toISOString()).run();
  await appendAuditEvent(db, { event_type: "forge.ci_reported", actor, subject: commit, outcome: conclusion, payload: { workflow_run_id: runId } });
  return { commit, conclusion };
}
