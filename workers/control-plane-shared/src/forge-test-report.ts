// CI-WB (2026-11-25; owner: "ok jalankan rekomendasimu"): the control-plane test suite runs natively on Workers Builds,
// in the same build as the type-check (workers/forge-typecheck/typecheck-and-report.mjs), and the Forge takes its result
// instead of running the suite in Dynamic Workers. A build of main posts it (POST /v1/forge/test-report, the CI service
// token only); a change request build has no secrets and prints it as one log line (FORGE_TEST_RESULT {...}), which the
// Forge reads through the Workers Builds API (forge/src/cr-builds.ts). Both are validated here, strictly, before anything
// is stored: the shape, every size, the SHA formats, and the consistency of the counts. A report carries no test output
// and no error text: only the test files the build ran, the counts, and the file and name of at most 50 failed tests.
//
// This file is a guard path (ci_harness): what a report may claim decides whether a Forge check runs any test at all.

export const TEST_RESULT_MARKER = "FORGE_TEST_RESULT ";
/** The runner a check row names when its tests came from a Workers Builds report (forge_check_runs.runner). */
export const TEST_REPORT_RUNNER = "workers-builds/1";
export const MAX_TEST_REPORT_BYTES = 128 * 1024;
export const MAX_TEST_REPORT_FILES = 1_000;
export const MAX_TEST_REPORT_FAILURES = 50;
export const MAX_TEST_NAME_CHARS = 300;
const MAX_COUNT = 1_000_000;
const HEX40 = /^[0-9a-f]{40}$/;
/** A top-level control-plane test file, as runner/core.ts testFiles lists it. */
export const TEST_REPORT_FILE = /^workers\/control-plane-shared\/test\/[A-Za-z0-9._-]+\.test\.ts$/;
const BUILD_UUID = /^[A-Za-z0-9_-]{1,64}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
const NODE_VERSION = /^v?\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const KEYS = new Set(["confirm", "commit", "tree", "build_uuid", "branch", "files", "pass", "fail", "skip", "failures", "duration_ms", "node"]);

export interface TestReportFailure { file: string | null; name: string }
export interface TestReport {
  commit: string; tree: string | null; build_uuid: string; branch: string | null;
  /** The test files the build ran: sorted, unique, each a top-level control-plane test file. */
  files: string[];
  pass: number; fail: number; skip: number;
  /** At most 50: a failed test's file (null for a failure of the runner itself) and name. Never its message. */
  failures: TestReportFailure[];
  duration_ms: number | null; node: string | null;
}

function bad(code: string): Error & { status: number } { return Object.assign(new Error(code), { status: 400 }); }

const count = (v: unknown, code: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_COUNT) throw bad(code);
  return v;
};

/** A test name as stored: control characters removed, spaces collapsed, at most MAX_TEST_NAME_CHARS. */
export function cleanTestName(name: unknown): string {
  return String(name ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEST_NAME_CHARS);
}

/**
 * Validate a test report. `confirm: "required"` is the route (the body must carry confirm "REPORT"); `"absent"` is a build
 * log line, which carries none. Throws a 400 error naming the first problem; returns the report as stored.
 */
export function validateTestReport(input: unknown, opts: { confirm: "required" | "absent" }): TestReport {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("invalid_test_report");
  const o = input as Record<string, unknown>;
  let size = 0;
  try { size = new TextEncoder().encode(JSON.stringify(o)).length; } catch { throw bad("invalid_test_report"); }
  if (size > MAX_TEST_REPORT_BYTES) throw bad("test_report_too_large");
  for (const k of Object.keys(o)) if (!KEYS.has(k)) throw bad("unknown_field");
  if (opts.confirm === "required" ? o.confirm !== "REPORT" : o.confirm !== undefined) throw bad("confirmation_required");
  const commit = typeof o.commit === "string" ? o.commit : "";
  if (!HEX40.test(commit)) throw bad("invalid_commit");
  let tree: string | null = null;
  if (o.tree !== undefined && o.tree !== null) {
    if (typeof o.tree !== "string" || !HEX40.test(o.tree)) throw bad("invalid_tree");
    tree = o.tree;
  }
  if (typeof o.build_uuid !== "string" || !BUILD_UUID.test(o.build_uuid)) throw bad("invalid_build_uuid");
  let branch: string | null = null;
  if (o.branch !== undefined && o.branch !== null) {
    if (typeof o.branch !== "string" || !BRANCH.test(o.branch) || o.branch.includes("..")) throw bad("invalid_branch");
    branch = o.branch;
  }
  if (!Array.isArray(o.files) || o.files.length === 0 || o.files.length > MAX_TEST_REPORT_FILES) throw bad("invalid_files");
  const files: string[] = [];
  for (const f of o.files) {
    if (typeof f !== "string" || !TEST_REPORT_FILE.test(f)) throw bad("invalid_files");
    if (files.length && files[files.length - 1] >= f) throw bad("files_not_sorted_unique");
    files.push(f);
  }
  const pass = count(o.pass, "invalid_pass");
  const fail = count(o.fail, "invalid_fail");
  const skip = count(o.skip, "invalid_skip");
  if (pass + fail + skip === 0) throw bad("no_tests_counted");
  if (!Array.isArray(o.failures) || o.failures.length > MAX_TEST_REPORT_FAILURES) throw bad("invalid_failures");
  const known = new Set(files);
  const failures: TestReportFailure[] = o.failures.map((x) => {
    if (!x || typeof x !== "object" || Array.isArray(x)) throw bad("invalid_failures");
    const r = x as Record<string, unknown>;
    if (Object.keys(r).some((k) => k !== "file" && k !== "name")) throw bad("invalid_failures");
    const file = r.file === null ? null : typeof r.file === "string" && known.has(r.file) ? r.file : undefined;
    if (file === undefined) throw bad("failure_file_not_reported");
    if (typeof r.name !== "string") throw bad("invalid_failures");
    const name = cleanTestName(r.name);
    if (!name) throw bad("invalid_failures");
    return { file, name };
  });
  if ((fail === 0) !== (failures.length === 0)) throw bad(fail === 0 ? "failures_without_fail" : "fail_without_failures");
  if (failures.length > fail) throw bad("more_failures_than_fail");
  let duration: number | null = null;
  if (o.duration_ms !== undefined && o.duration_ms !== null) {
    if (typeof o.duration_ms !== "number" || !Number.isInteger(o.duration_ms) || o.duration_ms < 0 || o.duration_ms > 6 * 3_600_000) throw bad("invalid_duration_ms");
    duration = o.duration_ms;
  }
  let node: string | null = null;
  if (o.node !== undefined && o.node !== null) {
    if (typeof o.node !== "string" || !NODE_VERSION.test(o.node)) throw bad("invalid_node");
    node = o.node;
  }
  return { commit, tree, build_uuid: o.build_uuid, branch, files, pass, fail, skip, failures, duration_ms: duration, node };
}

/** A failed test as a check row lists it, in the Dynamic Workers runner's form (`file :: name`), with no message. */
export function testReportFailureLine(f: TestReportFailure): string {
  return f.file ? `${f.file.split("/").pop()} :: ${f.name}` : `test runner :: ${f.name}`;
}

/** Whether two test-file lists are the same set (both sorted and deduplicated first). */
export function sameTestFiles(a: readonly string[], b: readonly string[]): boolean {
  const x = [...new Set(a)].sort(); const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
