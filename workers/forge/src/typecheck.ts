// ADR-0012 §5c: the type-check. The compiler needs ~190 MB for this repository and a Workers isolate
// has 128 MB, so it cannot run in the Forge itself. Owner decision 2026-11-08 (after a Container was
// tried and withdrawn the same day): it runs on **Workers Builds**, Cloudflare's build service,
// straight from the Artifacts repository (workers/forge-typecheck). Each build runs
// `tsc --noEmit -p workers/control-plane-tsconfig.json` and reports to POST /v1/forge/typecheck-report
// with the CI service token. The Forge check of the same commit takes that report as its typecheck step.
// The same build also builds the Console UI (tsc + Vite, as GitHub CI does) and reports it as
// `console_build`; a failure of either fails the step.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";

const HEX40 = /^[0-9a-f]{40}$/;
const MAX_DIAGNOSTICS_STORED = 50;
const MAX_DIAGNOSTIC_CHARS = 600;
const TOOLCHAIN_PACKAGES = ["typescript", "@types/node"] as const;

export type Toolchain = Record<(typeof TOOLCHAIN_PACKAGES)[number], string>;
/** The Console UI build of the same Workers Builds run (absent in reports from builds before it). */
export interface ConsoleBuildStep { status: "passed" | "failed"; errors: number; diagnostics: string[]; bytes?: number }
export interface TypecheckStep {
  /**
   * `pending`: no build has reported this commit yet (the build runs after the mirror push).
   * `passed` only when the control-plane type-check passed and the Console build (if reported) passed.
   */
  status: "passed" | "failed" | "pending" | "not_configured";
  /** Control-plane type errors; `diagnostics` are theirs. The Console build carries its own. */
  errors?: number; files?: number; diagnostics?: string[]; build_id?: string; toolchain?: Toolchain; reported_at?: string;
  console_build?: ConsoleBuildStep;
}
export type TypecheckLookup = (commit: string) => Promise<TypecheckStep>;

export interface TypecheckReportRow {
  commit_sha: string; conclusion: "success" | "failure"; build_id: string; branch: string | null; files: number | null;
  errors: number; diagnostics: string | null; toolchain: string | null; reported_at: string; console_build?: string | null;
}

function stepFromRow(row: TypecheckReportRow | null | undefined): TypecheckStep {
  if (!row) return { status: "pending" };
  let diagnostics: string[] = [];
  let toolchain: Toolchain | undefined;
  try { const d = JSON.parse(row.diagnostics ?? "[]"); diagnostics = safeDiagnostics(d); } catch { /* stored by recordTypecheckReport */ }
  try { const t = JSON.parse(row.toolchain ?? "null"); if (t && typeof t === "object") toolchain = t as Toolchain; } catch { /* same */ }
  let consoleBuild: ConsoleBuildStep | undefined;
  try {
    const c = JSON.parse(row.console_build ?? "null");
    if (c && typeof c === "object") {
      const raw = c as ConsoleBuildStep;
      consoleBuild = { ...raw, diagnostics: safeDiagnostics(raw.diagnostics) };
    }
  } catch { /* same */ }
  const passed = row.conclusion === "success" && consoleBuild?.status !== "failed";
  return {
    status: passed ? "passed" : "failed", errors: row.errors, files: row.files ?? undefined,
    diagnostics, build_id: row.build_id, toolchain, reported_at: row.reported_at,
    ...(consoleBuild ? { console_build: consoleBuild } : {}),
  };
}

/** The typecheck step of a commit: its Workers Builds report, or `pending` until one arrives. */
export async function typecheckStep(db: D1Database, commit: string): Promise<TypecheckStep> {
  const row = await db.prepare("SELECT * FROM forge_typecheck_reports WHERE commit_sha = ?").bind(commit).first<TypecheckReportRow>();
  return stepFromRow(row);
}

export interface TypecheckReportInput {
  commit?: unknown; conclusion?: unknown; build_id?: unknown; branch?: unknown; files?: unknown; errors?: unknown; diagnostics?: unknown; toolchain?: unknown;
  console_build?: unknown;
}

/** Keep only file, line, and compiler code. Never persist compiler message text or source literals. */
export function safeDiagnostics(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, MAX_DIAGNOSTICS_STORED).map((value) => {
    const line = String(value).replace(/\u001b\[[0-9;]*m/g, "").trim();
    const match = line.match(/^(.+?\(\d+,\d+\): error TS\d+)/);
    if (match) return match[1].slice(0, MAX_DIAGNOSTIC_CHARS);
    if (line === "Console UI build failed; inspect the Workers Builds run for details.") return line;
    return "Diagnostic omitted; inspect the Workers Builds run for details.";
  });
}

/** Validate the Console build part of a report: the same consistency rules as the type-check. */
function consoleBuildFrom(input: unknown): ConsoleBuildStep | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw bad("invalid_console_build");
  const c = input as Record<string, unknown>;
  if (c.conclusion !== "success" && c.conclusion !== "failure") throw bad("invalid_console_build");
  const errors = Number(c.errors ?? 0);
  if (!Number.isInteger(errors) || errors < 0 || errors > 1_000_000) throw bad("invalid_console_build");
  if ((c.conclusion === "success") !== (errors === 0)) throw bad("inconsistent_console_build");
  const bytes = c.bytes === undefined ? undefined : Number(c.bytes);
  if (bytes !== undefined && (!Number.isInteger(bytes) || bytes < 0)) throw bad("invalid_console_build");
  const diagnostics = safeDiagnostics(c.diagnostics);
  return { status: c.conclusion === "success" ? "passed" : "failed", errors, diagnostics, ...(bytes !== undefined ? { bytes } : {}) };
}

function bad(code: string): Error & { status: number } { return Object.assign(new Error(code), { status: 400 }); }

/**
 * Record a Workers Builds type-check result (CI service token only). Validates every field, stores
 * at most 50 diagnostics of 600 characters, audits, and — when the Forge check of that commit has
 * already been recorded — folds the result into that run: its typecheck step, and a failure fails it.
 */
export async function recordTypecheckReport(db: D1Database, input: TypecheckReportInput, actor: string, nowMs = Date.now()): Promise<{ commit: string; conclusion: string; applied_to_run: boolean }> {
  const commit = typeof input.commit === "string" ? input.commit : "";
  if (!HEX40.test(commit)) throw bad("invalid_commit");
  const conclusion = input.conclusion;
  if (conclusion !== "success" && conclusion !== "failure") throw bad("invalid_conclusion");
  const buildId = typeof input.build_id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(input.build_id) ? input.build_id : "";
  if (!buildId) throw bad("invalid_build_id");
  const branch = typeof input.branch === "string" && input.branch.length <= 200 ? input.branch : null;
  const errors = Number(input.errors ?? 0);
  if (!Number.isInteger(errors) || errors < 0 || errors > 1_000_000) throw bad("invalid_errors");
  if (conclusion === "success" && errors !== 0) throw bad("success_with_errors");
  if (conclusion === "failure" && errors === 0) throw bad("failure_without_errors");
  const files = input.files === undefined ? null : Number(input.files);
  if (files !== null && (!Number.isInteger(files) || files < 0)) throw bad("invalid_files");
  const diagnostics = safeDiagnostics(input.diagnostics);
  let toolchain: Toolchain | null = null;
  if (input.toolchain !== undefined) {
    const t = input.toolchain as Record<string, unknown> | null;
    if (!t || typeof t !== "object" || TOOLCHAIN_PACKAGES.some((n) => typeof t[n] !== "string" || !/^\d+\.\d+\.\d+$/.test(t[n] as string))) throw bad("invalid_toolchain");
    toolchain = { typescript: t.typescript as string, "@types/node": t["@types/node"] as string };
  }
  const consoleBuild = consoleBuildFrom(input.console_build);
  const consoleJson = consoleBuild ? JSON.stringify(consoleBuild) : null;
  const reportedAt = new Date(nowMs).toISOString();
  await db.prepare(
    `INSERT INTO forge_typecheck_reports (commit_sha, conclusion, build_id, branch, files, errors, diagnostics, toolchain, reported_at, console_build) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(commit_sha) DO UPDATE SET conclusion = excluded.conclusion, build_id = excluded.build_id, branch = excluded.branch, files = excluded.files,
       errors = excluded.errors, diagnostics = excluded.diagnostics, toolchain = excluded.toolchain, reported_at = excluded.reported_at, console_build = excluded.console_build`,
  ).bind(commit, conclusion, buildId, branch, files, errors, JSON.stringify(diagnostics), toolchain ? JSON.stringify(toolchain) : null, reportedAt, consoleJson).run();
  const applied = await applyTypecheckReportToRun(db, commit, stepFromRow({ commit_sha: commit, conclusion, build_id: buildId, branch, files, errors, diagnostics: JSON.stringify(diagnostics), toolchain: toolchain ? JSON.stringify(toolchain) : null, reported_at: reportedAt, console_build: consoleJson }));
  await appendAuditEvent(db, { event_type: "forge.typecheck_reported", actor, subject: commit, outcome: conclusion, payload: { build_id: buildId, errors, files, console_build: consoleBuild?.status ?? null, applied_to_run: applied } });
  return { commit, conclusion, applied_to_run: applied };
}

/** The failure lines a step adds to a check: type errors, then Console build errors. */
export function stepFailures(step: TypecheckStep): string[] {
  return [
    ...(step.diagnostics ?? []).map((d) => `typecheck ${d}`),
    ...(step.console_build?.status === "failed" ? step.console_build.diagnostics.map((d) => `console-build ${d}`) : []),
  ];
}

/** Fold a report into an already recorded Forge check: set steps.typecheck; a failure fails the run. */
export async function applyTypecheckReportToRun(db: D1Database, commit: string, step: TypecheckStep): Promise<boolean> {
  const run = await db.prepare("SELECT status, steps, failures FROM forge_check_runs WHERE commit_sha = ?").bind(commit).first<{ status: string; steps: string | null; failures: string | null }>();
  if (!run || run.status === "running") return false;
  let steps: Record<string, unknown> = {};
  let failures: string[] = [];
  try { steps = JSON.parse(run.steps ?? "{}") ?? {}; } catch { steps = {}; }
  try { const f = JSON.parse(run.failures ?? "[]"); if (Array.isArray(f)) failures = f.map(String); } catch { failures = []; }
  failures = failures.filter((f) => !f.startsWith("typecheck ") && !f.startsWith("console-build "));
  if (step.status === "failed") failures.push(...stepFailures(step));
  const status = step.status === "failed" && run.status === "passed" ? "failed" : run.status;
  await db.prepare("UPDATE forge_check_runs SET steps = ?, failures = ?, status = ? WHERE commit_sha = ?")
    .bind(JSON.stringify({ ...steps, typecheck: step }), JSON.stringify(failures.slice(0, 50)), status, commit).run();
  return true;
}
