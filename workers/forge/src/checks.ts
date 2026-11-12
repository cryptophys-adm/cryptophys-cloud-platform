// ADR-0012 phase 3: Forge checks. The control-plane test suite runs on Cloudflare against each new
// commit of main in the Artifacts repo, with no GitHub involved:
//   1. snapshot: the commit's tree read through the Artifacts binding (readCommit/readTree/readBlob);
//   2. bundle: esbuild-wasm in the Forge isolate (runner/core.ts);
//   3. run: Dynamic Workers (Worker Loader), with no network access;
//   4. type-check: reported by Workers Builds (typecheck.ts; the compiler does not fit in an isolate);
//   5. record: one row per commit in D1 (forge_check_runs), plus an audit event.
// Results are informational until the Forge and GitHub CI agree on 20 consecutive commits (ADR §5c).
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { migrationsOf, storeBundles, pruneBundles, type BuiltModule, type BundleBucket } from "./bundles.ts";
import { MAX_FILE_BYTES, SKIP_DIRS, bundleAllWorkers, runSuite, scanSecrets, snapshotPathAllowed, type BundleStep, type SecretFinding, type Snapshot, type SuiteDeps, type SuiteResult } from "./runner/core.ts";
import { isReady } from "../../control-plane-shared/src/forge-gate.ts";
import { applyTypecheckReportToRun, safeDiagnostics, stepFailures, typecheckStep, type TypecheckLookup, type TypecheckStep } from "./typecheck.ts";

/** What one check needs: the test-suite toolchain and the type-check lookup (Workers Builds reports). */
export interface CheckDeps extends SuiteDeps { typecheck?: TypecheckLookup }

const HEX40 = /^[0-9a-f]{40}$/;
export const RUNNER_ID = "forge-runner/1";
/** A run that has not finished after this long is treated as lost and may be retried. */
export const STALE_RUN_MS = 30 * 60_000;
/** How many of main's newest commits a tick looks at. It checks the oldest unchecked one. */
export const LOOKBACK_COMMITS = 5;
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
  tests: { files: number; pass: number; fail: number; skip: number };
  bundles: { workers: number; failed: BundleStep["failed"]; bundles: BundleStep["bundles"] };
  secrets: { files: number; findings: SecretFinding[] };
  /** Absent in runs recorded before the type-check step; `pending` until the build of the commit reports. */
  typecheck?: TypecheckStep;
}
export interface CheckRun extends SuiteResult {
  commit: string; status: "passed" | "failed"; guard_status: "clean" | "findings"; steps: CheckSteps;
  duration_ms: number; snapshot_files: number; snapshot_bytes: number;
}

/** Snapshot, bundle and run one commit. Test failures are a result; only infrastructure errors throw. */
export async function checkCommit(repo: ArtifactsReader, commit: string, deps: (commit: string) => Promise<CheckDeps>, now = () => Date.now(), only?: string[], built?: BuiltModule[]): Promise<CheckRun> {
  const started = now();
  const snap = await snapshotFromArtifacts(repo, commit);
  lastSnapshot = { commit, snapshot: snap.snapshot };
  const suite = await deps(commit);
  const result = await runSuite(suite, snap.snapshot, only);
  if (result.files === 0) throw new Error("no_test_files");
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
      tests: { files: result.files, pass: result.pass, fail: result.fail, skip: result.skip },
      bundles: { workers: bundles.workers, failed: bundles.failed, bundles: bundles.bundles },
      secrets,
      typecheck,
    },
    duration_ms: now() - started, snapshot_files: Object.keys(snap.snapshot).length, snapshot_bytes: snap.bytes,
  };
}

export interface CheckRow {
  commit_sha: string; status: string; runner: string; files: number | null; pass: number | null; fail: number | null; skip: number | null;
  failures: string | null; started_at: string; finished_at: string | null; duration_ms: number | null;
  steps: string | null; guard_status: string | null;
}

/**
 * Pick the commit to check: among main's newest commits, the oldest that has no run, or whose run
 * was lost (still "running" after 30 minutes). Returns null when every one has been checked.
 */
export async function nextCommit(db: D1Database, repo: ArtifactsReader, nowMs: number): Promise<string | null> {
  const log = await repo.log({ ref: "main", limit: LOOKBACK_COMMITS });
  const shas = log.map((c) => (typeof c.hash === "string" ? c.hash : "")).filter((h) => HEX40.test(h));
  if (shas.length === 0) return null;
  const placeholders = shas.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT commit_sha, status, started_at FROM forge_check_runs WHERE commit_sha IN (${placeholders})`).bind(...shas).all<Pick<CheckRow, "commit_sha" | "status" | "started_at">>();
  const done = new Map((rows.results ?? []).map((r) => [r.commit_sha, r]));
  for (const sha of [...shas].reverse()) {
    const row = done.get(sha);
    if (!row) return sha;
    if (row.status === "running" && Date.parse(row.started_at) < nowMs - STALE_RUN_MS) return sha;
  }
  return null;
}

/** What a check was of (migration 0039): a commit of main, or a change request head. */
export type CheckSource = "main" | "change";

/** Claim a commit for this tick. False if another tick holds a live run of it. */
export async function claim(db: D1Database, commit: string, nowMs: number, source: CheckSource = "main"): Promise<boolean> {
  const startedAt = new Date(nowMs).toISOString();
  const staleBefore = new Date(nowMs - STALE_RUN_MS).toISOString();
  const r = await db.prepare(
    `INSERT INTO forge_check_runs (commit_sha, status, runner, started_at, source) VALUES (?, 'running', ?, ?, ?)
     ON CONFLICT(commit_sha) DO UPDATE SET status = 'running', runner = excluded.runner, started_at = excluded.started_at, source = excluded.source,
       files = NULL, pass = NULL, fail = NULL, skip = NULL, failures = NULL, finished_at = NULL, duration_ms = NULL, steps = NULL, guard_status = NULL
     WHERE forge_check_runs.status = 'running' AND forge_check_runs.started_at < ?`,
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
  await db.prepare("UPDATE forge_check_runs SET status = ?, files = ?, pass = ?, fail = ?, skip = ?, failures = ?, finished_at = ?, duration_ms = ?, steps = ?, guard_status = ? WHERE commit_sha = ?")
    .bind(run.status, run.files, run.pass, run.fail, run.skip, storedFailures(run.failures), finishedAt, run.duration_ms, JSON.stringify(run.steps), run.guard_status, run.commit).run();
  await applyStoredTypecheckReport(db, run.commit);
}

export interface ScheduledEnv { DB: D1Database; ARTIFACTS?: { get(name: string): Promise<ArtifactsReader> }; BUNDLES?: BundleBucket }
export type TickOutcome = { outcome: "not_configured" | "up_to_date" | "busy" } | { outcome: "checked"; commit: string; status: string; pass?: number; fail?: number };

/** One cron tick: check at most one commit of main. */
export async function checksTick(env: ScheduledEnv, repoName: string, deps: ((commit: string) => Promise<CheckDeps>) | null, nowMs = () => Date.now()): Promise<TickOutcome> {
  return tickWith(env, repoName, deps, nowMs, (repo) => nextCommit(env.DB, repo, nowMs()));
}

/** Claim, check, record and audit one commit picked by `pick` (a commit of main, or a change request head). */
export async function tickWith(env: ScheduledEnv, repoName: string, deps: ((commit: string) => Promise<CheckDeps>) | null, nowMs: () => number, pick: (repo: ArtifactsReader) => Promise<string | null>, source: CheckSource = "main"): Promise<TickOutcome> {
  if (!env.ARTIFACTS || !deps) return { outcome: "not_configured" };
  const repo = await env.ARTIFACTS.get(repoName);
  try {
    const commit = await pick(repo);
    if (!commit) return { outcome: "up_to_date" };
    if (!(await claim(env.DB, commit, nowMs(), source))) return { outcome: "busy" };
    const started = nowMs();
    let status: string;
    let counts: { pass?: number; fail?: number } = {};
    try {
      // ADR-0012 G2a: a commit of main keeps the Worker modules its check bundled, for the deploy.
      const built: BuiltModule[] | undefined = source === "main" && env.BUNDLES ? [] : undefined;
      const run = await checkCommit(repo, commit, deps, nowMs, undefined, built);
      await record(env.DB, run, nowMs());
      status = run.status;
      counts = { pass: run.pass, fail: run.fail };
      if (built && env.BUNDLES && run.status === "passed" && run.guard_status === "clean") {
        try {
          // G2b: the commit's D1 migrations, from the snapshot this check ran on.
          const snapshot = cachedSnapshot(commit);
          if (!snapshot) throw new Error("snapshot_unavailable");
          const manifest = await storeBundles(env.BUNDLES, commit, built, nowMs(), migrationsOf(Object.keys(snapshot)));
          await appendAuditEvent(env.DB, { event_type: "forge.bundles_stored", actor: "system:forge-checks", subject: commit, outcome: "stored", payload: { workers: manifest.workers.length, single_module: manifest.workers.filter((w) => w.single_module).length } });
          await pruneBundles(env.BUNDLES, nowMs());
        } catch (e) {
          // Storing is for the deploy; a failure never changes the check's result.
          await appendAuditEvent(env.DB, { event_type: "forge.bundles_failed", actor: "system:forge-checks", subject: commit, outcome: "failed", payload: { error: String((e as Error)?.message ?? e).slice(0, 200) } }).catch(() => undefined);
        }
      }
    } catch (e) {
      status = "error";
      await record(env.DB, { commit, status: "error", error: String((e as Error)?.message ?? e).slice(0, 300), duration_ms: nowMs() - started }, nowMs());
    }
    await appendAuditEvent(env.DB, { event_type: "forge.checks_completed", actor: "system:forge-checks", subject: commit, outcome: status, payload: { runner: RUNNER_ID, ...counts } });
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

type JoinedRow = CheckRow & { github: "success" | "failure" | null };

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
  return {
    commit: r.commit_sha, status: r.status, runner: r.runner, files: r.files, pass: r.pass, fail: r.fail, skip: r.skip, failures,
    started_at: r.started_at, finished_at: r.finished_at, duration_ms: r.duration_ms,
    bundles: stepsBundles(r.steps), guard_status: r.guard_status ?? null, typecheck,
    ready: isReady(r.status, r.guard_status ?? null, typecheck),
    github: r.github ?? null, agrees: agreement(r.status, r.github ?? null),
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
