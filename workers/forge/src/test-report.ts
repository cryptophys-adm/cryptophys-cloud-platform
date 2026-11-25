// CI-WB (2026-11-25; owner: "ok jalankan rekomendasimu"): the control-plane test suite runs on Workers Builds, in the same
// build as the type-check, and a Forge check takes that result instead of running the suite in Dynamic Workers.
//   - A build of main (workers/forge-typecheck, the CI service token) posts it: POST /v1/forge/test-report
//     {confirm: "REPORT", commit, tree?, build_uuid, branch?, files, pass, fail, skip, failures, duration_ms?, node?}.
//   - A change request build (workers/forge-typecheck-cr) has no secrets: it prints FORGE_TEST_RESULT {...} and the Forge
//     reads the line through the Workers Builds API (cr-builds.ts), with the same validation.
// Both are validated by control-plane-shared/src/forge-test-report.ts and stored in forge_test_reports (migration 0089),
// one row per commit. checks.ts uses a report only for its exact commit (and tree, when the report names one), and only
// when its test files are exactly the test files of the Forge's own snapshot; anything else is an error, never a pass.
// A head with no report waits two ticks (forge_test_report_waits) before the check falls back to Dynamic Workers.
//
// This file is a guard path (ci_harness): its route and its rules decide whether a check runs any test itself.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { actorOf, type AccessIdentity } from "../../control-plane-shared/src/access.ts";
import { errorResponse, json, readJsonObject } from "../../control-plane-shared/src/http.ts";
import { MAX_TEST_REPORT_BYTES, validateTestReport, type TestReport, type TestReportFailure } from "../../control-plane-shared/src/forge-test-report.ts";

/** Two Forge ticks (:04/:19/:34/:49), less a minute of cron jitter: how long a head waits for its report. */
export const TEST_REPORT_WAIT_MS = 29 * 60_000;
/** Wait rows older than this are deleted when a new one is added. */
export const TEST_REPORT_WAIT_RETENTION_MS = 7 * 86_400_000;

export type TestReportOrigin = "ci_report" | "cr_build_log";
export interface StoredTestReport extends TestReport { origin: TestReportOrigin; reported_at: string }

interface Row {
  commit_sha: string; tree_sha: string | null; build_uuid: string; branch: string | null; origin: TestReportOrigin; files_json: string;
  pass: number; fail: number; skip: number; failures_json: string; duration_ms: number | null; node_version: string | null; reported_at: string;
}

/** Before migration 0089 the tables do not exist: the Forge then behaves as if no report ever came. */
const missingTable = (e: unknown) => /no such table/i.test(String((e as Error)?.message ?? e));

/** Store a validated report (a later report of the same commit replaces it) and audit it. */
export async function recordTestReport(db: D1Database, input: unknown, origin: TestReportOrigin, actor: string, nowMs = Date.now()): Promise<{ commit: string; pass: number; fail: number; skip: number; files: number }> {
  const r = validateTestReport(input, { confirm: origin === "ci_report" ? "required" : "absent" });
  const reportedAt = new Date(nowMs).toISOString();
  await db.prepare(
    `INSERT INTO forge_test_reports (commit_sha, tree_sha, build_uuid, branch, origin, files, files_json, pass, fail, skip, failures_json, duration_ms, node_version, reported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(commit_sha) DO UPDATE SET tree_sha = excluded.tree_sha, build_uuid = excluded.build_uuid, branch = excluded.branch, origin = excluded.origin,
       files = excluded.files, files_json = excluded.files_json, pass = excluded.pass, fail = excluded.fail, skip = excluded.skip, failures_json = excluded.failures_json,
       duration_ms = excluded.duration_ms, node_version = excluded.node_version, reported_at = excluded.reported_at`,
  ).bind(r.commit, r.tree, r.build_uuid, r.branch, origin, r.files.length, JSON.stringify(r.files), r.pass, r.fail, r.skip, JSON.stringify(r.failures), r.duration_ms, r.node, reportedAt).run();
  await appendAuditEvent(db, { event_type: "forge.test_reported", actor, subject: r.commit, outcome: r.fail === 0 ? "passed" : "failed", payload: { origin, build_uuid: r.build_uuid, files: r.files.length, pass: r.pass, fail: r.fail, skip: r.skip } });
  return { commit: r.commit, pass: r.pass, fail: r.fail, skip: r.skip, files: r.files.length };
}

/** The stored report of exactly this commit, or null (also before migration 0089). */
export async function testReportOf(db: D1Database, commit: string): Promise<StoredTestReport | null> {
  let row: Row | null;
  try { row = await db.prepare("SELECT * FROM forge_test_reports WHERE commit_sha = ?").bind(commit).first<Row>(); } catch (e) { if (missingTable(e)) return null; throw e; }
  if (!row) return null;
  let files: string[] = []; let failures: TestReportFailure[] = [];
  try { files = (JSON.parse(row.files_json) as unknown[]).map(String); } catch { return null; }
  try { failures = JSON.parse(row.failures_json) as TestReportFailure[]; } catch { failures = []; }
  return {
    commit: row.commit_sha, tree: row.tree_sha, build_uuid: row.build_uuid, branch: row.branch, files, pass: row.pass, fail: row.fail, skip: row.skip,
    failures, duration_ms: row.duration_ms, node: row.node_version, origin: row.origin, reported_at: row.reported_at,
  };
}

/**
 * Note that a head has no report yet and return when the Forge first saw it so (the wait's start). Idempotent per commit.
 * Before migration 0089 there is nowhere to note it: the head counts as having waited long enough.
 */
export async function noteTestReportWait(db: D1Database, commit: string, nowMs: number): Promise<number> {
  try {
    await db.prepare("DELETE FROM forge_test_report_waits WHERE first_seen_at < ?").bind(new Date(nowMs - TEST_REPORT_WAIT_RETENTION_MS).toISOString()).run();
    await db.prepare("INSERT INTO forge_test_report_waits (commit_sha, first_seen_at) VALUES (?, ?) ON CONFLICT(commit_sha) DO NOTHING").bind(commit, new Date(nowMs).toISOString()).run();
    const row = await db.prepare("SELECT first_seen_at FROM forge_test_report_waits WHERE commit_sha = ?").bind(commit).first<{ first_seen_at: string }>();
    const t = Date.parse(row?.first_seen_at ?? "");
    return Number.isFinite(t) ? t : nowMs;
  } catch (e) {
    if (missingTable(e)) return Number.NEGATIVE_INFINITY;
    throw e;
  }
}

/** cr-builds.ts: remember that this build's log has no usable test line, so the next tick does not read it again for one. */
export async function noteTestLogRead(db: D1Database, commit: string, buildUuid: string, nowMs: number): Promise<void> {
  try {
    await db.prepare(`INSERT INTO forge_test_report_waits (commit_sha, first_seen_at, log_build_uuid) VALUES (?, ?, ?)
      ON CONFLICT(commit_sha) DO UPDATE SET log_build_uuid = excluded.log_build_uuid`).bind(commit, new Date(nowMs).toISOString(), buildUuid.slice(0, 64)).run();
  } catch (e) { if (!missingTable(e)) throw e; }
}

/** Whether migration 0089 is applied (cr-builds.ts reads test lines only then). */
export async function testReportsAvailable(db: D1Database): Promise<boolean> {
  try { await db.prepare("SELECT 1 AS x FROM forge_test_reports LIMIT 1").first(); return true; } catch (e) { if (missingTable(e)) return false; throw e; }
}

/** POST /v1/forge/test-report: the CI service token only (the build of main), confirm "REPORT". */
export async function handleTestReport(request: Request, env: { DB: D1Database }, identity: AccessIdentity): Promise<Response> {
  if (identity.type !== "service_token") return errorResponse(403, "service_token_required");
  const body = await readJsonObject(request, MAX_TEST_REPORT_BYTES);
  if (!body.ok) return body.response;
  if (body.value.confirm !== "REPORT") return errorResponse(400, "confirmation_required", 'type "REPORT" to record a test result');
  try {
    return json(await recordTestReport(env.DB, body.value, "ci_report", actorOf(identity)));
  } catch (err) {
    const e = err as Error & { status?: number };
    if (!e.status) throw err;
    return errorResponse(e.status, e.message);
  }
}
