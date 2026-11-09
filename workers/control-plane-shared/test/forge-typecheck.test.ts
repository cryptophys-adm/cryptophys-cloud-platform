// ADR-0012 §5c, owner decision 2026-11-08: the type-check runs on Workers Builds from the Artifacts
// repository (workers/forge-typecheck) and reports to the Forge, which folds the result into its
// check of the same commit. A Container was tried and withdrawn the same day.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_JWT, CI_CLIENT_ID, CI_JWT, OPERATOR_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import forge from "../../forge/src/index.ts";
import { checkCommit, listChecks, record, type ArtifactsReader, type ArtifactsTreeEntry, type CheckDeps } from "../../forge/src/checks.ts";
import { recordTypecheckReport, typecheckStep } from "../../forge/src/typecheck.ts";
import { parseDiagnostics, resolveCommit, summarize } from "../../forge-typecheck/typecheck-and-report.mjs";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const SHA = "c".repeat(40);
const TOOLCHAIN = { typescript: "5.9.3", "@types/node": "22.20.5" };
const ok = (over: Record<string, unknown> = {}) => ({ commit: SHA, conclusion: "success", build_id: "b-1", branch: "main", files: 279, errors: 0, diagnostics: [], toolchain: TOOLCHAIN, ...over });

test("TC1. the build script turns tsc output into a report: errors counted, diagnostics text only, capped at 50", () => {
  const out = "workers/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\nsome noise\nworkers/b.ts(3,1): error TS2304: Cannot find name 'x'.\n";
  assert.deepEqual(parseDiagnostics(out), ["workers/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.", "workers/b.ts(3,1): error TS2304: Cannot find name 'x'."]);
  const failed = summarize(2, out, TOOLCHAIN);
  assert.deepEqual([failed.conclusion, failed.errors, failed.diagnostics.length], ["failure", 2, 2]);
  assert.deepEqual(summarize(0, "", TOOLCHAIN), { conclusion: "success", errors: 0, diagnostics: [], toolchain: TOOLCHAIN });
  assert.equal(summarize(1, "crash without TS lines", TOOLCHAIN).errors, 1, "a failed compiler run with no parsable line is still one error");
  const many = Array.from({ length: 80 }, (_, i) => `f${i}.ts(1,1): error TS1: e`).join("\n");
  assert.equal(summarize(1, many, TOOLCHAIN).diagnostics.length, 50);
});

test("TC1b. the build finds its commit: WORKERS_CI_COMMIT_SHA when it is a full SHA, else the checked-out HEAD", () => {
  const head = "a".repeat(40);
  assert.deepEqual(resolveCommit("B".repeat(40), head), { commit: "b".repeat(40), source: "WORKERS_CI_COMMIT_SHA" });
  assert.deepEqual(resolveCommit(undefined, head + "\n"), { commit: head, source: "git rev-parse HEAD" }, "Artifacts builds may not set it");
  assert.deepEqual(resolveCommit("", head), { commit: head, source: "git rev-parse HEAD" });
  assert.deepEqual(resolveCommit("aaaaaaa", head), { commit: head, source: "git rev-parse HEAD" }, "a short SHA that matches HEAD");
  assert.equal(resolveCommit("bbbbbbb", head), null, "a short SHA that contradicts HEAD is refused");
  assert.equal(resolveCommit(undefined, "fatal: not a git repository"), null);
});

test("TC2. recordTypecheckReport validates every field and never accepts an inconsistent result", async () => {
  const db = migratedDb() as never;
  const r = await recordTypecheckReport(db, ok(), CI_CLIENT_ID, Date.parse("2026-11-08T22:00:00Z"));
  assert.deepEqual(r, { commit: SHA, conclusion: "success", applied_to_run: false });
  const step = await typecheckStep(db, SHA);
  assert.deepEqual([step.status, step.errors, step.files, step.build_id, step.toolchain], ["passed", 0, 279, "b-1", TOOLCHAIN]);
  assert.equal((await typecheckStep(db, "d".repeat(40))).status, "pending", "no report yet");
  const rejects: Array<[Record<string, unknown>, RegExp]> = [
    [ok({ commit: "nope" }), /invalid_commit/], [ok({ conclusion: "cancelled" }), /invalid_conclusion/], [ok({ build_id: "a b" }), /invalid_build_id/],
    [ok({ errors: 3 }), /success_with_errors/], [ok({ conclusion: "failure" }), /failure_without_errors/], [ok({ errors: -1 }), /invalid_errors/],
    [ok({ files: 1.5 }), /invalid_files/], [ok({ toolchain: { typescript: "latest" } }), /invalid_toolchain/],
  ];
  for (const [input, re] of rejects) await assert.rejects(recordTypecheckReport(db, input, CI_CLIENT_ID), re);
  // A failure with long diagnostics is stored truncated; a re-run replaces the row.
  const long = ok({ conclusion: "failure", errors: 2, diagnostics: ["x".repeat(1000), "y"], build_id: "b-2" });
  await recordTypecheckReport(db, long, CI_CLIENT_ID);
  const failed = await typecheckStep(db, SHA);
  assert.deepEqual([failed.status, failed.errors, failed.diagnostics?.[0].length, failed.build_id], ["failed", 2, 600, "b-2"]);
  const audits = (db as any).raw.prepare("SELECT outcome FROM audit_events WHERE event_type = 'forge.typecheck_reported' ORDER BY rowid").all().map((a: any) => a.outcome);
  assert.deepEqual(audits, ["success", "failure"]);
});

/** A one-commit Artifacts repo holding the given files. */
function repoWith(files: Record<string, string>): ArtifactsReader {
  const hex = (n: number) => n.toString(16).padStart(40, "0");
  const blobs: Record<string, string> = {}; const trees: Record<string, ArtifactsTreeEntry[]> = {}; const byKey: Record<string, string> = {};
  const root: ArtifactsTreeEntry[] = []; let n = 100;
  for (const [p, text] of Object.entries(files)) {
    const parts = p.split("/"); let level = root; let key = "";
    for (const dir of parts.slice(0, -1)) {
      key += dir + "/";
      if (!byKey[key]) { const h = hex(n++); byKey[key] = h; trees[h] = []; level.push({ name: dir, type: "tree", mode: "40000", hash: h }); }
      level = trees[byKey[key]];
    }
    const h = hex(n++); blobs[h] = text; level.push({ name: parts[parts.length - 1], type: "blob", mode: "100644", hash: h });
  }
  const treeHash = hex(1);
  return {
    async readCommit(hash) { return { hash, treeHash }; },
    async readTree(hash) { return hash === treeHash ? root : trees[hash] ?? null; },
    async readBlob(hash) { return hash in blobs ? new Blob([blobs[hash]]) : null; },
    async log() { return []; },
  };
}
const FILES = { "workers/control-plane-shared/test/a.test.ts": "x" };
function deps(db: unknown) {
  return async (): Promise<CheckDeps> => ({
    esbuild: { async build() { return { outputFiles: [{ text: "x", contents: new Uint8Array() }], errors: [], warnings: [] }; } },
    shims: {} as never, sqlJs: "", sqlWasm: null,
    async runWorker(code) { return { files: (code.modules["files.json"] as { json: string[] }).json.map((file) => ({ file, results: [{ name: "t", status: "pass" }] })) }; },
    typecheck: db ? (c) => typecheckStep(db as never, c) : undefined,
  });
}

test("TC3. a check reads the commit's report: passed, failed (fails the check), pending, or not configured", async () => {
  const db = migratedDb();
  const t0 = Date.parse("2026-11-08T22:00:00Z");
  await recordTypecheckReport(db as never, ok(), CI_CLIENT_ID, t0);
  const passed = await checkCommit(repoWith(FILES), SHA, deps(db));
  assert.deepEqual([passed.status, passed.steps.typecheck?.status], ["passed", "passed"]);
  await recordTypecheckReport(db as never, ok({ conclusion: "failure", errors: 1, diagnostics: ["workers/x.ts(1,1): error TS2322: no"] }), CI_CLIENT_ID, t0);
  const failed = await checkCommit(repoWith(FILES), SHA, deps(db));
  assert.deepEqual([failed.status, failed.fail], ["failed", 0], "the tests passed; the type-check failed the check");
  assert.ok(failed.failures.includes("typecheck workers/x.ts(1,1): error TS2322: no"));
  const pending = await checkCommit(repoWith(FILES), "e".repeat(40), deps(db));
  assert.deepEqual([pending.status, pending.steps.typecheck?.status], ["passed", "pending"], "no report yet: not a pass of the step, not a failure of the check");
  assert.equal((await checkCommit(repoWith(FILES), SHA, deps(null))).steps.typecheck?.status, "not_configured");
});

test("TC4. a report that arrives after the check is folded into the recorded run; a failure fails it; the Console sees it", async () => {
  const db = migratedDb();
  const t0 = Date.parse("2026-11-08T22:00:00Z");
  const run = await checkCommit(repoWith(FILES), SHA, deps(db));
  assert.equal(run.steps.typecheck?.status, "pending");
  db.raw.prepare("INSERT INTO forge_check_runs (commit_sha, status, runner, started_at) VALUES (?, 'running', 'r', ?)").run(SHA, new Date(t0).toISOString());
  await record(db as never, run, t0 + 60_000);
  const late = await recordTypecheckReport(db as never, ok({ conclusion: "failure", errors: 1, diagnostics: ["workers/y.ts(2,2): error TS2304: z"] }), CI_CLIENT_ID, t0 + 120_000);
  assert.equal(late.applied_to_run, true);
  const listed = (await listChecks(db as never, 5)).checks[0];
  assert.deepEqual([listed.status, listed.typecheck], ["failed", { status: "failed", errors: 1, build_id: "b-1" }]);
  assert.deepEqual(listed.failures, ["typecheck workers/y.ts(2,2): error TS2304: z"]);
  // A later success replaces the diagnostics but does not un-fail a run that failed for other reasons.
  db.raw.prepare("UPDATE forge_check_runs SET failures = ? WHERE commit_sha = ?").run(JSON.stringify(["one.test.ts :: t: nope", "typecheck old"]), SHA);
  await recordTypecheckReport(db as never, ok({ build_id: "b-3" }), CI_CLIENT_ID, t0 + 180_000);
  const again = (await listChecks(db as never, 5)).checks[0];
  assert.deepEqual([again.status, again.typecheck?.status, again.failures], ["failed", "passed", ["one.test.ts :: t: nope"]]);
  assert.equal((await recordTypecheckReport(db as never, ok({ commit: "f".repeat(40) }), CI_CLIENT_ID)).applied_to_run, false, "no run yet");
});

test("TC5. POST /v1/forge/typecheck-report: CI service token with REPORT only", async () => {
  const db = migratedDb();
  const env = { ...baseEnv("cryptophys-forge", db), ARTIFACTS: undefined };
  const body = { confirm: "REPORT", ...ok() };
  assert.equal((await call(forge, env, req("POST", "/v1/forge/typecheck-report", body, CI_JWT))).status, 200);
  assert.equal((await call(forge, env, req("POST", "/v1/forge/typecheck-report", body, OPERATOR_JWT))).body.error, "service_token_required");
  assert.equal((await call(forge, env, req("POST", "/v1/forge/typecheck-report", body, APPROVER_JWT))).status, 403);
  assert.equal((await call(forge, env, req("POST", "/v1/forge/typecheck-report", { ...body, confirm: "yes" }, CI_JWT))).body.error, "confirmation_required");
  assert.equal((await call(forge, env, req("POST", "/v1/forge/typecheck-report", { ...body, commit: "x" }, CI_JWT))).status, 400);
});

test("TC6. wiring: no Container remains; the Builds project is the one the README describes; the class is deleted by migration", () => {
  const toml = read("workers/forge/wrangler.toml");
  assert.doesNotMatch(toml, /\[\[containers\]\]/);
  assert.doesNotMatch(toml, /TYPECHECK/);
  assert.match(toml, /tag = "v2-drop-typecheck-container"\ndeleted_classes = \["TypecheckContainer"\]/);
  assert.doesNotMatch(read("workers/forge/src/worker.ts"), /TypecheckContainer|cloudflare:workers".*Container/);
  const project = read("workers/forge-typecheck/wrangler.toml");
  assert.match(project, /^name = "cryptophys-forge-typecheck"$/m);
  assert.match(project, /^workers_dev = false$/m);
  const pkg = JSON.parse(read("workers/forge-typecheck/package.json"));
  assert.equal(pkg.scripts.build, "node typecheck-and-report.mjs");
  const readme = read("workers/forge-typecheck/README.md");
  for (const s of ["Root directory:** `workers/forge-typecheck`", "`node typecheck-and-report.mjs`", "`FORGE_URL`", "`CF_ACCESS_CLIENT_ID`", "/v1/forge/typecheck-report"]) assert.ok(readme.includes(s), s);
  assert.doesNotMatch(read(".github/workflows/validate-control-plane.yml"), /typecheck-container/);
  assert.match(read("workers/forge/src/index.ts"), /"0035_forge_typecheck_reports\.sql"/);
});
