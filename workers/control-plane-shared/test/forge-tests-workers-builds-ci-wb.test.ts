// CI-WB (2026-11-25; owner: "ok jalankan rekomendasimu"): Forge tests on Workers Builds, Dynamic Workers only as a
// one-per-run fallback, no daily rerun of an unchanged head. The control-plane suite runs natively in the commit's
// Workers Builds build (workers/forge-typecheck/typecheck-and-report.mjs); a build of main posts the result
// (POST /v1/forge/test-report, the CI service token), a change request build prints FORGE_TEST_RESULT {...}, which the
// Forge reads through the Workers Builds API (cr-builds.ts). A Forge check takes a report of its exact commit whose test
// files are its snapshot's, and runs no test Worker; a report of other files is an error, never a pass. With no report
// two ticks after the head was first seen, the suite runs in ONE Dynamic Worker (groups only over a size limit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_JWT, CI_CLIENT_ID, CI_JWT, OPERATOR_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import forge from "../../forge/src/index.ts";
import { changeVerdict, registerChange } from "../../forge/src/changes.ts";
import { RUNNER_ID, checkOf, checksTick, tickWith, type ArtifactsReader, type ArtifactsTreeEntry, type CheckDeps, type TestReportPolicy } from "../../forge/src/checks.ts";
import { forgeTick } from "../../forge/src/tick.ts";
import { crBuildsTick, resultFromLogs, CR_TYPECHECK_WORKER, TEST_RESULT_MARKER as CR_TEST_MARKER } from "../../forge/src/cr-builds.ts";
import { TEST_REPORT_WAIT_MS, recordTestReport, testReportOf } from "../../forge/src/test-report.ts";
import { MAX_SINGLE_WORKER_BYTES, TEST_WORKER_ID_PREFIX, isLoaderSizeLimitError, runSuite, type EsbuildLike, type ShimSources, type SuiteDeps } from "../../forge/src/runner/core.ts";
import { MAX_TEST_REPORT_BYTES, TEST_REPORT_RUNNER, TEST_RESULT_MARKER, cleanTestName, sameTestFiles, testReportFailureLine, validateTestReport } from "../src/forge-test-report.ts";
import { forgeReady, isReady } from "../src/forge-gate.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import {
  TEST_ENV_STRIPPED, nodeRunsTests, postTestReport, resultLine, summarizeTestRun, testEnv, testFilesIn, testFlagsOf, testResultLine,
} from "../../forge-typecheck/typecheck-and-report.mjs";
import forgeTestReporter from "../../forge-typecheck/test-reporter.mjs";
import { crBuildEnv } from "../../forge-typecheck-cr/typecheck-and-report.mjs";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const sha = (c: string) => c.repeat(40);
const T = "workers/control-plane-shared/test/";
const MIN = 60_000;
const POLICY: TestReportPolicy = { waitMs: TEST_REPORT_WAIT_MS };

/** An Artifacts repo of several commits; trees are content-addressed, so an equal tree has an equal hash. */
function repoOf(commits: Record<string, Record<string, string>>, head?: () => string | null) {
  const trees: Record<string, ArtifactsTreeEntry[]> = {}; const blobs: Record<string, string> = {}; const roots: Record<string, string> = {};
  const hash = (s: string) => { let h = 0n; for (const ch of s) h = (h * 131n + BigInt(ch.codePointAt(0)!)) % (1n << 160n); return h.toString(16).padStart(40, "0"); };
  function build(files: Record<string, string>): string {
    const here: Record<string, Record<string, string>> = {}; const entries: ArtifactsTreeEntry[] = [];
    for (const [p, text] of Object.entries(files)) {
      const i = p.indexOf("/");
      if (i < 0) { const h = hash("blob:" + text); blobs[h] = text; entries.push({ name: p, type: "blob", mode: "100644", hash: h }); }
      else (here[p.slice(0, i)] ??= {})[p.slice(i + 1)] = text;
    }
    for (const [dir, sub] of Object.entries(here)) entries.push({ name: dir, type: "tree", mode: "40000", hash: build(sub) });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const h = hash("tree:" + entries.map((e) => `${e.type} ${e.name} ${e.hash}`).join("\n")); trees[h] = entries; return h;
  }
  const add = (s: string, files: Record<string, string>) => { roots[s] = build(files); };
  for (const [s, files] of Object.entries(commits)) add(s, files);
  const repo: ArtifactsReader = {
    async readCommit(h: string) { return roots[h] ? { hash: h, treeHash: roots[h] } : null; },
    async readTree(h: string) { return trees[h] ?? null; },
    async readBlob(h: string) { return h in blobs ? new Blob([blobs[h]]) : null; },
    async log() { const h = head?.(); return h ? [{ hash: h }] : []; },
  };
  return Object.assign(repo, { add, roots });
}

function bucket() {
  const objects = new Map<string, { value: string; uploaded: Date }>();
  return {
    objects,
    async put(key: string, value: string) { objects.set(key, { value, uploaded: new Date() }); return {}; },
    async get(key: string) { const o = objects.get(key); return o ? { text: async () => o.value } : null; },
    async list({ prefix = "" }: { prefix?: string } = {}) { return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, uploaded: objects.get(key)!.uploaded })), truncated: false }; },
    async delete(keys: string | string[]) { for (const k of [keys].flat()) objects.delete(k); },
  };
}

/** esbuild through the snapshot plugin: follows `from "..."` imports; `pad` makes every test bundle that many bytes larger. */
function pluginBundler(builds: string[], pad = 0): EsbuildLike {
  type Resolve = (a: { path: string; importer: string; kind: string }) => any;
  type Load = (a: { path: string; pluginData?: unknown }) => any;
  return {
    async build(o) {
      builds.push(String((o.entryPoints as string[] | undefined)?.[0] ?? "stdin"));
      const resolvers: Array<[{ filter: RegExp; namespace?: string }, Resolve]> = [];
      const loaders: Array<[{ filter: RegExp; namespace?: string }, Load]> = [];
      for (const p of (o.plugins ?? []) as Array<{ setup(b: unknown): void }>) p.setup({ onResolve: (f: any, cb: Resolve) => resolvers.push([f, cb]), onLoad: (f: any, cb: Load) => loaders.push([f, cb]) });
      if (!o.entryPoints) return { outputFiles: [{ text: "glue", contents: new Uint8Array(4) }], errors: [], warnings: [] };
      const seen = new Set<string>();
      let out = "";
      const visit = async (path: string, importer: string, kind: string) => {
        let r: any;
        for (const [f, cb] of resolvers) if (!f.namespace && f.filter.test(path)) { r = await cb({ path, importer, kind }); if (r) break; }
        if (r.errors) throw new Error(r.errors[0].text);
        if (r.external || seen.has(r.path)) return;
        seen.add(r.path);
        const [, load] = loaders.find(([f]) => f.namespace === r.namespace && f.filter.test(r.path))!;
        const contents = (await load({ path: r.path, pluginData: r.pluginData })).contents as string;
        for (const m of contents.matchAll(/from "([^"]+)"/g)) await visit(m[1], r.path, "import-statement");
        out += `// ${r.path}\n${contents}\n`;
      };
      const entry = (o.entryPoints as string[])[0];
      await visit(entry, "", "entry-point");
      if (pad && entry.endsWith(".test.ts")) out += "//" + "x".repeat(pad) + "\n";
      return { outputFiles: [{ text: out, contents: new TextEncoder().encode(out) }], errors: [], warnings: [] };
    },
  };
}

interface Log { builds: string[]; ran: string[][]; ids: string[] }
const newLog = (): Log => ({ builds: [], ran: [], ids: [] });
/** Suite deps whose every Worker load is recorded (the Worker Loader spy); the type-check and Console build passed. */
function depsOf(log: Log, opts: { fail?: string[]; workerError?: (files: string[]) => string | null; pad?: number } = {}) {
  return async (): Promise<CheckDeps> => ({
    esbuild: pluginBundler(log.builds, opts.pad), shims: {} as ShimSources, sqlJs: "glue", sqlWasm: null, fingerprint: "rf1-test",
    async runWorker(code, request) {
      const files = (code.modules["files.json"] as { json: string[] }).json;
      log.ran.push(files); log.ids.push(request.id);
      const err = opts.workerError?.(files);
      if (err) throw new Error(err);
      return { files: files.map((file) => ({ file, reads: [], results: [{ name: "t", status: opts.fail?.includes(file) ? "fail" : "pass" }] })) };
    },
    typecheck: async () => ({ status: "passed", errors: 0, console_build: { status: "passed", errors: 0, diagnostics: [] } }),
  });
}

const MAIN = sha("1");
const FILES: Record<string, string> = {
  "README.md": "# platform\n",
  "workers/demo/wrangler.toml": 'name = "cryptophys-demo"\nmain = "src/index.ts"\n',
  "workers/demo/src/index.ts": 'import { a } from "./a.ts";\nexport default { a };\n',
  "workers/demo/src/a.ts": "export const a = 1;\n",
  "workers/demo/src/b.ts": "export const b = 2;\n",
  [T + "a.test.ts"]: 'import { a } from "../../demo/src/a.ts";\n',
  [T + "b.test.ts"]: 'import { b } from "../../demo/src/b.ts";\n',
  [T + "c.test.ts"]: "// c\n",
};
const TESTS = [T + "a.test.ts", T + "b.test.ts", T + "c.test.ts"];

/** A report as the build posts it (route) or prints it (log line: no confirm). */
const report = (over: Record<string, unknown> = {}) => ({ confirm: "REPORT", commit: MAIN, build_uuid: "build-1", branch: "main", files: TESTS, pass: 30, fail: 0, skip: 1, failures: [], duration_ms: 95_000, node: "v22.20.0", ...over });

function world(head: string | null = MAIN) {
  const db = migratedDb();
  let current = head;
  const repo = repoOf({ [MAIN]: FILES }, () => current);
  const b = bucket();
  const env = { DB: db as never, ARTIFACTS: { get: async () => repo }, BUNDLES: b as never };
  let now = Date.parse("2026-11-25T09:04:00Z");
  const clock = () => now;
  const row = (c: string) => db.raw.prepare("SELECT * FROM forge_check_runs WHERE commit_sha = ?").get(c) as any;
  let n = 0;
  const open = async (h: string, files: Record<string, string>) => {
    repo.add(h, files);
    n++;
    await registerChange(db as never, repo, { number: n, source_branch: `claude/x-${n}`, title: "t", author: "a", head_sha: h, base_sha: MAIN }, CI_CLIENT_ID, now + n);
    return `gh-${n}`;
  };
  const verdict = async (crId: string) => {
    const r = db.raw.prepare("SELECT * FROM forge_change_requests WHERE cr_id = ?").get(crId) as any;
    return changeVerdict(r, await checkOf(db as never, r.head_sha), JSON.parse(r.critical ?? "[]"), now);
  };
  return { db, repo, b, env, clock, row, open, verdict, tick: (ms: number) => { now += ms; }, setHead: (h: string) => { current = h; } };
}

// ---------------------------------------------------------------------------------------------------------------
// 1. The report and its validator.

test("WB1. the validator takes a well-formed report and refuses every malformed shape, size and SHA", () => {
  const ok = validateTestReport(report(), { confirm: "required" });
  assert.deepEqual(ok, { commit: MAIN, tree: null, build_uuid: "build-1", branch: "main", files: TESTS, pass: 30, fail: 0, skip: 1, failures: [], duration_ms: 95_000, node: "v22.20.0" });
  const { confirm: _c, ...line } = report({ tree: sha("e"), fail: 2, failures: [{ file: T + "b.test.ts", name: "B1.\u0007 a\n test" }, { file: null, name: "node --test exited 1" }] });
  const fromLog = validateTestReport(line, { confirm: "absent" });
  assert.deepEqual([fromLog.tree, fromLog.failures], [sha("e"), [{ file: T + "b.test.ts", name: "B1. a test" }, { file: null, name: "node --test exited 1" }]], "names are cleaned of control characters");
  assert.deepEqual(fromLog.failures.map(testReportFailureLine), ["b.test.ts :: B1. a test", "test runner :: node --test exited 1"]);
  const code = (input: unknown, confirm: "required" | "absent" = "required") => { try { validateTestReport(input, { confirm }); return "accepted"; } catch (e) { assert.equal((e as { status?: number }).status, 400); return (e as Error).message; } };
  assert.equal(code({ ...report(), confirm: undefined }), "confirmation_required", "the route needs confirm REPORT");
  assert.equal(code(report({ confirm: "yes" })), "confirmation_required");
  assert.equal(code(report(), "absent"), "confirmation_required", "a log line carries no confirm");
  assert.equal(code(line, "absent"), "accepted");
  assert.equal(code(null), "invalid_test_report");
  assert.equal(code([report()]), "invalid_test_report");
  assert.equal(code(report({ deps: {} })), "unknown_field", "nothing but the listed fields (no dependency record from a build)");
  assert.equal(code(report({ output: "..." })), "unknown_field");
  for (const commit of ["x", sha("A"), MAIN.slice(1), 1]) assert.equal(code(report({ commit })), "invalid_commit", String(commit));
  assert.equal(code(report({ tree: "abc" })), "invalid_tree");
  for (const build_uuid of ["", "a b", "x".repeat(65), 7]) assert.equal(code(report({ build_uuid })), "invalid_build_uuid", String(build_uuid));
  assert.equal(code(report({ branch: "cr/../main" })), "invalid_branch");
  assert.equal(code(report({ branch: "a b" })), "invalid_branch");
  assert.equal(code(report({ files: [] })), "invalid_files");
  assert.equal(code(report({ files: ["workers/control-plane-shared/test/sub/a.test.ts"] })), "invalid_files", "only top-level test files");
  assert.equal(code(report({ files: ["workers/control-plane-shared/src/a.ts"] })), "invalid_files");
  assert.equal(code(report({ files: ["../x.test.ts"] })), "invalid_files");
  assert.equal(code(report({ files: [TESTS[1], TESTS[0]] })), "files_not_sorted_unique");
  assert.equal(code(report({ files: [TESTS[0], TESTS[0]] })), "files_not_sorted_unique");
  assert.equal(code(report({ files: Array.from({ length: 1001 }, (_, i) => `${T}f${String(i).padStart(4, "0")}.test.ts`) })), "invalid_files", "at most 1000 files");
  for (const [k, v] of [["pass", -1], ["fail", 1.5], ["skip", "1"], ["pass", 1_000_001]] as const) assert.equal(code(report({ [k]: v })), `invalid_${k}`, `${k}=${v}`);
  assert.equal(code(report({ pass: 0, skip: 0 })), "no_tests_counted");
  assert.equal(code(report({ fail: 1 })), "fail_without_failures", "a failure is named");
  assert.equal(code(report({ failures: [{ file: TESTS[0], name: "t" }] })), "failures_without_fail");
  assert.equal(code(report({ fail: 1, failures: [{ file: TESTS[0], name: "t" }, { file: TESTS[1], name: "u" }] })), "more_failures_than_fail");
  assert.equal(code(report({ fail: 1, failures: [{ file: T + "z.test.ts", name: "t" }] })), "failure_file_not_reported", "a failure is in a reported file");
  assert.equal(code(report({ fail: 1, failures: [{ file: TESTS[0], name: "t", error: "boom" }] })), "invalid_failures", "never an error message");
  assert.equal(code(report({ fail: 1, failures: [{ file: TESTS[0], name: "\u0001" }] })), "invalid_failures");
  assert.equal(code(report({ fail: 60, failures: Array.from({ length: 51 }, () => ({ file: TESTS[0], name: "t" })) })), "invalid_failures", "at most 50 failures");
  assert.equal(code(report({ duration_ms: -1 })), "invalid_duration_ms");
  assert.equal(code(report({ node: "22; rm" })), "invalid_node");
  assert.equal(code(report({ fail: 50, failures: Array.from({ length: 50 }, () => ({ file: TESTS[0], name: "n".repeat(3000) })) })), "test_report_too_large", `over ${MAX_TEST_REPORT_BYTES} bytes`);
  assert.equal(cleanTestName("x".repeat(400)).length, 300);
  assert.equal(sameTestFiles([TESTS[1], TESTS[0]], [TESTS[0], TESTS[1]]), true);
  assert.equal(sameTestFiles(TESTS, TESTS.slice(1)), false);
  assert.equal(TEST_RESULT_MARKER, CR_TEST_MARKER);
});

test("WB2. POST /v1/forge/test-report: the CI service token with REPORT only; a person or a wrong confirm is refused", async () => {
  const db = migratedDb();
  const env = { ...baseEnv("cryptophys-forge", db), ARTIFACTS: undefined };
  const ok = await call(forge, env, req("POST", "/v1/forge/test-report", report(), CI_JWT));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { commit: MAIN, pass: 30, fail: 0, skip: 1, files: 3 });
  const stored = (await testReportOf(db as never, MAIN))!;
  assert.deepEqual([stored.origin, stored.files, stored.build_uuid, stored.pass], ["ci_report", TESTS, "build-1", 30]);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'forge.test_reported'").get() as any).n, 1);
  const operator = await call(forge, env, req("POST", "/v1/forge/test-report", report(), OPERATOR_JWT));
  assert.deepEqual([operator.status, operator.body.error], [403, "service_token_required"], "a person (an operator) is not the build");
  assert.equal((await call(forge, env, req("POST", "/v1/forge/test-report", report(), APPROVER_JWT))).status, 403);
  assert.equal((await call(forge, env, req("POST", "/v1/forge/test-report", report(), null))).status, 403, "no Access identity");
  const wrong = await call(forge, env, req("POST", "/v1/forge/test-report", report({ confirm: "yes" }), CI_JWT));
  assert.deepEqual([wrong.status, wrong.body.error], [400, "confirmation_required"]);
  assert.equal((await call(forge, env, req("POST", "/v1/forge/test-report", report({ commit: "x" }), CI_JWT))).body.error, "invalid_commit");
  const big = await call(forge, env, req("POST", "/v1/forge/test-report", { ...report(), pad: "x".repeat(MAX_TEST_REPORT_BYTES) }, CI_JWT));
  assert.equal(big.status, 413);
  // A later report of the same commit replaces it.
  await call(forge, env, req("POST", "/v1/forge/test-report", report({ build_uuid: "build-2", pass: 29, fail: 1, failures: [{ file: TESTS[2], name: "C1" }] }), CI_JWT));
  assert.deepEqual([(await testReportOf(db as never, MAIN))!.build_uuid, (await testReportOf(db as never, MAIN))!.fail], ["build-2", 1]);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM forge_test_reports").get() as any).n, 1);
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The change request build's log line.

const ACCOUNT = "f".repeat(32);
const TAG = "e".repeat(32);
function openChangeRow(db: ReturnType<typeof migratedDb>, number: number, head: string, at = new Date().toISOString()) {
  db.raw.prepare(`INSERT INTO forge_change_requests (cr_id, source, number, branch, source_branch, title, author, head_sha, base_sha, github_ci, status, changed_paths, critical, created_at, updated_at)
    VALUES (?, 'github', ?, ?, 'claude/x', 't', 'cryptophys-adm', ?, ?, 'success', 'open', '[]', '[]', ?, ?)`).run(`gh-${number}`, number, `cr/${number}`, head, "b".repeat(40), at, at);
}
function buildsApi(logsFor: Record<string, unknown>, builds: unknown[]) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
    if (url.endsWith("/accounts?per_page=5")) return ok([{ id: ACCOUNT }]);
    if (url.endsWith(`/accounts/${ACCOUNT}/workers/scripts`)) return ok([{ id: CR_TYPECHECK_WORKER, tag: TAG }]);
    if (url.includes(`/builds/workers/${TAG}/builds`)) return ok(builds);
    if (url.endsWith(`/builds/workers/${TAG}/previews`)) return ok([]);
    const m = url.match(/\/builds\/builds\/([^/]+)\/logs$/);
    if (m) return ok(logsFor[m[1]] ?? { lines: [] });
    return new Response(JSON.stringify({ success: false }), { status: 404 });
  };
  return { calls, fetchImpl };
}
const TC = (commit: string) => ({ commit, build_id: "x", branch: "cr/1", conclusion: "success", errors: 0, diagnostics: [], toolchain: { typescript: "7.0.2", "@types/node": "22.10.0" }, console_build: { conclusion: "success", errors: 0, diagnostics: [], bytes: 1 } });
const testLine = (commit: string, over: Record<string, unknown> = {}) => { const { confirm: _c, ...r } = report({ commit, branch: "cr/1", ...over }); return testResultLine(r); };
const build = (uuid: string, branch: string, commit: string) => ({ build_uuid: uuid, status: "stopped", build_outcome: "success", created_on: "2026-11-25T09:00:00Z", build_trigger_metadata: { branch, commit_hash: commit } });

test("WB3. a change request build's FORGE_TEST_RESULT is read from the same log as its type-check line, within the per-tick cap", async () => {
  const db = migratedDb();
  const H = sha("a");
  openChangeRow(db, 1, H);
  const logs = { lines: [["t", "npm ci"], ["t", resultLine(TC(H))], ["t", `${TEST_RESULT_MARKER}{"commit":"${sha("c")}"}`], ["t", testLine(H)]] };
  assert.equal(resultFromLogs(logs, TEST_RESULT_MARKER)?.commit, H, "the last test line wins; the type-check line is not it");
  assert.equal(resultFromLogs(logs)?.commit, H);
  const api = buildsApi({ "u-1": logs }, [build("u-1", "cr/1", H)]);
  const out = await crBuildsTick({ DB: db as never, CF_BUILDS_API_TOKEN: "t" }, Date.now(), api.fetchImpl as never) as any;
  assert.equal(out.outcome, "recorded");
  assert.deepEqual(out.tests_recorded, [{ number: 1, commit: H, fail: 0 }]);
  assert.equal(out.recorded.length, 1, "and the type-check, from the same read");
  assert.equal(api.calls.filter((u) => u.endsWith("/logs")).length, 1, "one log read serves both lines");
  const stored = (await testReportOf(db as never, H))!;
  assert.deepEqual([stored.origin, stored.build_uuid, stored.branch], ["cr_build_log", "u-1", "cr/1"], "the build id is the Builds UUID it was read from");
  const again = await crBuildsTick({ DB: db as never, CF_BUILDS_API_TOKEN: "t" }, Date.now(), api.fetchImpl as never);
  assert.equal(again.outcome, "up_to_date", "both reports are in");

  // The cap: twelve change requests, each with a finished build. 3 listing requests + at most 6 log reads (9 per tick).
  const many = migratedDb();
  const logsFor: Record<string, unknown> = {}; const builds: unknown[] = [];
  for (let i = 1; i <= 12; i++) {
    const h = i.toString(16).padStart(40, "0");
    openChangeRow(many, i, h, new Date(Date.parse("2026-11-25T09:00:00Z") + i * MIN).toISOString());
    logsFor[`u-${i}`] = { lines: [["t", resultLine(TC(h))], ["t", testLine(h)]] };
    builds.push(build(`u-${i}`, `cr/${i}`, h));
  }
  const capped = buildsApi(logsFor, builds);
  const first = await crBuildsTick({ DB: many as never, CF_BUILDS_API_TOKEN: "t" }, Date.now(), capped.fetchImpl as never) as any;
  assert.equal(capped.calls.length, 9, "never more than 9 requests a tick");
  assert.equal(first.tests_recorded.length, 6);
  assert.equal((many.raw.prepare("SELECT COUNT(*) AS n FROM forge_test_reports").get() as any).n, 6);
});

test("WB3b. a log with no test line (a build from before CI-WB) is read once for it; a line of another commit or a malformed one is never recorded", async () => {
  const db = migratedDb();
  const H = sha("a");
  openChangeRow(db, 1, H);
  const api = buildsApi({ "u-1": { lines: [["t", resultLine(TC(H))]] } }, [build("u-1", "cr/1", H)]);
  const first = await crBuildsTick({ DB: db as never, CF_BUILDS_API_TOKEN: "t" }, Date.now(), api.fetchImpl as never) as any;
  assert.deepEqual([first.recorded.length, first.tests_recorded.length, first.test_lines_missing], [1, 0, 1]);
  const second = await crBuildsTick({ DB: db as never, CF_BUILDS_API_TOKEN: "t" }, Date.now(), api.fetchImpl as never);
  assert.equal(second.outcome, "up_to_date", "the head is not listed again for its test line alone");
  assert.equal(api.calls.filter((u) => u.endsWith("/logs")).length, 1);
  // Another commit's line, or an invalid one: nothing stored, the type-check still recorded.
  const other = migratedDb();
  openChangeRow(other, 1, H);
  openChangeRow(other, 2, sha("b"));
  const forged = buildsApi({
    "u-1": { lines: [["t", resultLine(TC(H))], ["t", testLine(sha("c"))]] },
    "u-2": { lines: [["t", resultLine(TC(sha("b")))], ["t", testLine(sha("b"), { files: [TESTS[1], TESTS[0]] })]] },
  }, [build("u-1", "cr/1", H), build("u-2", "cr/2", sha("b"))]);
  const out = await crBuildsTick({ DB: other as never, CF_BUILDS_API_TOKEN: "t" }, Date.now(), forged.fetchImpl as never) as any;
  assert.deepEqual([out.recorded.length, out.tests_recorded.length, out.test_lines_invalid], [2, 0, ["2: files_not_sorted_unique"]]);
  assert.equal((other.raw.prepare("SELECT COUNT(*) AS n FROM forge_test_reports").get() as any).n, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// 3. The check with a report, a mismatched report, and none.

test("WB4. a check with its commit's report runs no test Worker; the row is the same shape, from workers-builds/1, and ready", async () => {
  const w = world();
  await recordTestReport(w.db as never, report(), "ci_report", CI_CLIENT_ID);
  const log = newLog();
  const out = await tickWith(w.env, "platform", depsOf(log), w.clock, async () => MAIN, "main", POLICY);
  assert.deepEqual(out, { outcome: "checked", commit: MAIN, status: "passed", pass: 30, fail: 0, tests: "workers_builds" });
  assert.deepEqual(log.ran, [], "the Worker Loader is never called");
  assert.ok(!log.builds.some((b) => b.endsWith(".test.ts")), "no test file is bundled");
  assert.ok(log.builds.includes("workers/demo/src/index.ts"), "the Worker bundles are still built in the isolate");
  const row = w.row(MAIN);
  assert.deepEqual([row.status, row.runner, row.files, row.pass, row.fail, row.skip, row.guard_status], ["passed", TEST_REPORT_RUNNER, 3, 30, 0, 1, "clean"]);
  const steps = JSON.parse(row.steps);
  assert.deepEqual(steps.tests, { files: 3, pass: 30, fail: 0, skip: 1 });
  assert.deepEqual(steps.workers, { groups: 0, bundles: 0, loads: 0 });
  assert.deepEqual(steps.coverage, { mode: "full" });
  assert.deepEqual(steps.test_report, { build_uuid: "build-1", source: "workers_builds" });
  assert.equal(steps.tests_reused, undefined);
  assert.equal(steps.tree, w.repo.roots[MAIN]);
  assert.ok(w.b.objects.has(`bundles/${MAIN}/manifest.json`), "the bundles of a passed main commit are stored for the deploy");
  const summary = (await checkOf(w.db as never, MAIN))!;
  assert.equal(summary.ready, true);
  assert.equal(isReady(summary.status, summary.guard_status, summary.typecheck), true);
  assert.deepEqual(await forgeReady(w.db as never, MAIN), { ready: true, reason: "forge_ready", status: "passed" });
  // A failed report fails the check with the failed tests named, never their messages.
  const failing = world();
  await recordTestReport(failing.db as never, report({ pass: 29, fail: 1, failures: [{ file: TESTS[1], name: "B2. the thing" }] }), "ci_report", CI_CLIENT_ID);
  await tickWith(failing.env, "platform", depsOf(newLog()), failing.clock, async () => MAIN, "main", POLICY);
  assert.deepEqual([failing.row(MAIN).status, JSON.parse(failing.row(MAIN).failures)], ["failed", ["b.test.ts :: B2. the thing"]]);
  assert.equal((await forgeReady(failing.db as never, MAIN)).ready, false);
});

test("WB5. a report whose test files are not the snapshot's is an error, never a pass; the change request is not mergeable", async () => {
  const w = world();
  const H = sha("a");
  const cr = await w.open(H, { ...FILES, "workers/demo/src/b.ts": "export const b = 3;\n" });
  await recordTestReport(w.db as never, report({ commit: H, files: TESTS.slice(0, 2) }), "ci_report", CI_CLIENT_ID);
  const log = newLog();
  const out = await tickWith(w.env, "platform", depsOf(log), w.clock, async () => H, "change", POLICY);
  assert.deepEqual(out, { outcome: "checked", commit: H, status: "error" });
  assert.deepEqual(log.ran, [], "and no test Worker runs in its place");
  const failures = JSON.parse(w.row(H).failures);
  assert.match(failures[0], /^test_report_files_mismatch: the build ran 2 test files, the snapshot has 3; not run: c\.test\.ts$/);
  const summary = (await checkOf(w.db as never, H))!;
  assert.deepEqual([summary.status, summary.ready], ["error", false]);
  const v = await w.verdict(cr);
  assert.equal(v.verdict, "blocked", "merge_change is not proposed");
  assert.ok(v.reasons.includes("the check run did not complete"));
  // More files than the snapshot, and a report of another tree, are refused the same way.
  const more = world();
  await recordTestReport(more.db as never, report({ files: [...TESTS, T + "d.test.ts"] }), "ci_report", CI_CLIENT_ID);
  await tickWith(more.env, "platform", depsOf(newLog()), more.clock, async () => MAIN, "main", POLICY);
  assert.match(JSON.parse(more.row(MAIN).failures)[0], /^test_report_files_mismatch: .*; not in the snapshot: d\.test\.ts$/);
  assert.equal((await forgeReady(more.db as never, MAIN)).ready, false);
  const tree = world();
  await recordTestReport(tree.db as never, report({ tree: sha("e") }), "ci_report", CI_CLIENT_ID);
  await tickWith(tree.env, "platform", depsOf(newLog()), tree.clock, async () => MAIN, "main", POLICY);
  assert.match(JSON.parse(tree.row(MAIN).failures)[0], /^test_report_tree_mismatch/);
  // The matching report of the same head merges as a routine change.
  const fine = world();
  const crOk = await fine.open(H, { ...FILES, "workers/demo/src/b.ts": "export const b = 3;\n" });
  await recordTestReport(fine.db as never, report({ commit: H, tree: fine.repo.roots[H] }), "ci_report", CI_CLIENT_ID);
  assert.equal((await tickWith(fine.env, "platform", depsOf(newLog()), fine.clock, async () => H, "change", POLICY) as any).status, "passed");
  assert.deepEqual((await fine.verdict(crOk)).verdict, "would_merge");
});

test("WB6. no report: the head waits two ticks unclaimed, then ONE Dynamic Worker runs the suite, with a stable content id", async () => {
  const w = world();
  const log = newLog();
  const tick = () => tickWith(w.env, "platform", depsOf(log), w.clock, async () => MAIN, "main", POLICY);
  assert.deepEqual(await tick(), { outcome: "waiting_for_test_report", commit: MAIN, waited_ms: 0 });
  assert.equal(w.row(MAIN), undefined, "nothing claimed: no row, no 'running' state");
  assert.equal((await forgeReady(w.db as never, MAIN)).reason, "forge_checks_pending");
  w.tick(15 * MIN);
  assert.deepEqual(await tick(), { outcome: "waiting_for_test_report", commit: MAIN, waited_ms: 15 * MIN });
  assert.deepEqual(log.ran, []);
  w.tick(15 * MIN);
  assert.equal((await tick() as any).status, "passed", "two ticks after it was first seen, the fallback");
  assert.deepEqual(log.ran, [TESTS], "exactly one Worker Loader get, with every file");
  assert.match(log.ids[0], new RegExp(`^${TEST_WORKER_ID_PREFIX}[0-9a-f]{64}$`));
  const steps = JSON.parse(w.row(MAIN).steps);
  assert.deepEqual(steps.workers, { groups: 1, bundles: 1, loads: 1, mode: "single" });
  assert.deepEqual([w.row(MAIN).runner, steps.coverage, steps.test_report], [RUNNER_ID, { mode: "full" }, undefined]);
  // A second commit whose test bundles are identical (only the README changed) loads the same Worker id.
  const NEXT = sha("2");
  w.repo.add(NEXT, { ...FILES, "README.md": "# platform, again\n" });
  w.tick(15 * MIN);
  const next = () => tickWith(w.env, "platform", depsOf(log), w.clock, async () => NEXT, "main", { waitMs: 0 });
  assert.equal((await next() as any).status, "passed");
  assert.deepEqual([log.ids.length, log.ids[1]], [2, log.ids[0]], "an unchanged suite keeps its one Worker");
  // A report that arrives during the wait is used, and nothing runs.
  const late = world();
  const lateLog = newLog();
  const lateTick = () => tickWith(late.env, "platform", depsOf(lateLog), late.clock, async () => MAIN, "main", POLICY);
  assert.equal((await lateTick()).outcome, "waiting_for_test_report");
  await recordTestReport(late.db as never, report(), "ci_report", CI_CLIENT_ID);
  late.tick(15 * MIN);
  assert.equal((await lateTick() as any).tests, "workers_builds");
  assert.deepEqual(lateLog.ran, []);
});

test("WB6b. the one Worker: an isolate crash reruns each file alone; a Loader size limit (or a bundle over the cap) falls back to groups", async () => {
  const five = Object.fromEntries(["a", "b", "c", "d", "e"].map((x) => [`${T}${x}.test.ts`, `// ${x}\n`]));
  const files = Object.keys(five).sort();
  const deps = (log: Log, opts: Parameters<typeof depsOf>[1]) => depsOf(log, opts)() as Promise<SuiteDeps>;
  // A crash of the whole-suite isolate (not a size limit): every file alone, as for a group.
  const crash = newLog();
  const crashed = await runSuite(await deps(crash, { workerError: (f) => (f.length > 1 ? "Worker exceeded memory limit." : null) }), five, undefined, MAIN, { single: true });
  assert.deepEqual([crashed.pass, crashed.fail, crashed.isolated, crashed.workers], [5, 0, 5, { groups: 1, bundles: 6, loads: 6, mode: "single" }]);
  // The Loader refuses the one Worker as too large: the run goes on in groups of FILES_PER_WORKER, every test once.
  const big = newLog();
  const grouped = await runSuite(await deps(big, { workerError: (f) => (f.length === 5 ? "Script too large: 11 MB exceeds the Workers size limit" : null) }), five, undefined, MAIN, { single: true });
  assert.deepEqual(big.ran, [files, files.slice(0, 4), files.slice(4)]);
  assert.deepEqual([grouped.files, grouped.pass, grouped.fail, grouped.isolated, grouped.workers], [5, 5, 0, undefined, { groups: 3, bundles: 3, loads: 3, mode: "grouped_after_size_limit" }]);
  assert.ok(Object.keys(grouped.deps ?? {}).length === 5, "every file's dependencies are still recorded");
  // Bundles over MAX_SINGLE_WORKER_BYTES are never loaded as one Worker.
  const huge = newLog();
  const capped = await runSuite(await deps(huge, { pad: Math.ceil(MAX_SINGLE_WORKER_BYTES / 4) }), five, undefined, MAIN, { single: true });
  assert.deepEqual(huge.ran, [files.slice(0, 4), files.slice(4)], "straight to groups");
  assert.deepEqual([capped.pass, capped.workers?.mode], [5, "grouped_after_size_limit"]);
  assert.equal(huge.builds.filter((b) => b.endsWith(".test.ts")).length, 5, "a bundle made for the one Worker is reused by its group, not made twice");
  assert.equal(isLoaderSizeLimitError("Worker exceeded CPU time limit."), false);
  assert.equal(isLoaderSizeLimitError("script_too_large"), true);
  // Without `single` (the local harness) the run is grouped as before, with no mode.
  const plain = newLog();
  assert.deepEqual((await runSuite(await deps(plain, {}), five, undefined, MAIN)).workers, { groups: 2, bundles: 2, loads: 2 });
});

test("WB7. an unchanged main head is not re-run at 00:00 UTC; a new head and a lost run still are", async () => {
  const w = world();
  await recordTestReport(w.db as never, report(), "ci_report", CI_CLIENT_ID);
  const deps = depsOf(newLog());
  const main = () => checksTick(w.env, "platform", deps, w.clock, POLICY) as Promise<any>;
  assert.equal((await main()).status, "passed");
  w.tick(Date.parse("2026-11-26T00:04:00Z") - Date.parse("2026-11-25T09:19:00Z") + 15 * MIN);
  assert.deepEqual(await main(), { outcome: "up_to_date" }, "the first tick after 00:00 UTC leaves the unchanged head alone");
  w.tick(24 * 3_600_000);
  assert.deepEqual(await main(), { outcome: "up_to_date" });
  const NEXT = sha("2");
  w.repo.add(NEXT, FILES);
  w.setHead(NEXT);
  await recordTestReport(w.db as never, report({ commit: NEXT }), "ci_report", CI_CLIENT_ID);
  assert.deepEqual((await main()).commit, NEXT, "a new head is checked");
  // A lost run (still 'running' after STALE_RUN_MS) is taken over.
  w.db.raw.prepare("UPDATE forge_check_runs SET status = 'running', finished_at = NULL WHERE commit_sha = ?").run(NEXT);
  w.tick(15 * MIN);
  assert.deepEqual(await main(), { outcome: "up_to_date" }, "a live run is left alone");
  w.tick(30 * MIN);
  assert.equal((await main()).status, "passed", "a stale run is retried");
});

test("WB8. waiting blocks nothing: main's waiting head and a waiting change request leave the tick to the next head due", async () => {
  const w = world(MAIN);
  const X = sha("a"); const Y = sha("b");
  await w.open(Y, { ...FILES, "workers/demo/src/b.ts": "export const b = 4;\n" });
  w.tick(MIN);
  await w.open(X, { ...FILES, "workers/demo/src/b.ts": "export const b = 5;\n" }); // the newest: picked first, and waiting
  await recordTestReport(w.db as never, report({ commit: Y }), "ci_report", CI_CLIENT_ID);
  const log = newLog();
  // The tick's other steps (deploy plan, census, audits, backups) get no network here: they fail alone, as FT1 shows.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("no network in this test"); }) as typeof fetch;
  let steps: Record<string, unknown>;
  try { steps = await forgeTick(w.env as never, "platform", depsOf(log), w.clock, { reports: POLICY }); } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(steps.main_checks, { outcome: "waiting_for_test_report", commit: MAIN, waited_ms: 0 }, "main's head has no report yet");
  assert.deepEqual(steps.change_checks, { outcome: "checked", commit: Y, status: "passed", pass: 30, fail: 0, tests: "workers_builds", waiting: [X] });
  assert.deepEqual(log.ran, [], "no Dynamic Worker for any of them");
  assert.equal(w.row(X), undefined);
});

// ---------------------------------------------------------------------------------------------------------------
// 4. The build script and its reporter (their pure parts; no network, no test run).

test("WB9. the build script: the test script's own command, the top-level test files, a summary with no message, secret-free", async () => {
  const pkg = JSON.parse(read("workers/control-plane-shared/package.json"));
  assert.deepEqual(testFlagsOf(pkg.scripts.test), ["--test", "--experimental-sqlite", "--disable-warning=ExperimentalWarning"], "the same command as npm test");
  assert.throws(() => testFlagsOf("vitest run"), /not of the form/);
  assert.throws(() => testFlagsOf("node --test --test-reporter=spec test/*.test.ts"), /unexpected flag/);
  assert.throws(() => testFlagsOf("node --test --import=$(curl x) test/*.test.ts"), /unexpected flag/);
  assert.deepEqual(testFilesIn(["b.test.ts", "harness.ts", "a.test.ts", "fixtures", "c.test.tsx"]), [T + "a.test.ts", T + "b.test.ts"]);
  assert.deepEqual(["v22.5.0", "v22.20.0", "v24.1.0", "v22.4.1", "v20.18.0", "x"].map(nodeRunsTests), [true, true, true, false, false, false], "node:sqlite needs Node 22.5+");
  assert.deepEqual(TEST_ENV_STRIPPED, ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "FORGE_URL"]);
  assert.deepEqual(testEnv({ CF_ACCESS_CLIENT_ID: "i", CF_ACCESS_CLIENT_SECRET: "s", FORGE_URL: "u", PATH: "/bin" }), { PATH: "/bin" }, "the tests never see the build secrets");
  const repoRoot = "/build/repo";
  const abs = (f: string) => `${repoRoot}/${f}`;
  const ev = (event: string, file: string | null, name: string, extra: Record<string, unknown> = {}) => JSON.stringify({ event, kind: "test", file, name, nesting: 0, skip: false, todo: false, ...extra });
  const lines = [
    ev("pass", abs(TESTS[0]), "A1"), ev("pass", abs(TESTS[0]), "A2", { skip: true }), ev("pass", abs(TESTS[1]), "B1", { todo: true }),
    ev("fail", abs(TESTS[1]), "B2. it\nbroke"), ev("fail", abs(TESTS[2]), "c suite", { kind: "suite" }), ev("fail", abs(TESTS[1]), "b suite", { kind: "suite" }),
    "not json", ev("fail", "/elsewhere/x.test.ts", "outside"),
  ].join("\n");
  const r = summarizeTestRun({ lines, status: 1, files: TESTS, repoRoot, commit: MAIN, tree: sha("e"), buildUuid: "u-1", branch: "main", durationMs: 1234.4, node: "v22.20.0" })!;
  assert.deepEqual(r, {
    commit: MAIN, tree: sha("e"), build_uuid: "u-1", branch: "main", files: TESTS, pass: 1, fail: 3, skip: 2,
    failures: [{ file: TESTS[1], name: "B2. it broke" }, { file: null, name: "outside" }, { file: TESTS[2], name: "c suite" }], duration_ms: 1234, node: "v22.20.0",
  }, "a suite counts only when its file has no failed test");
  assert.equal(summarizeTestRun({ lines: "", status: 1, files: TESTS, repoRoot, commit: MAIN, buildUuid: "u", durationMs: 0 }), null, "no reporter output: no result");
  const crashed = summarizeTestRun({ lines: ev("pass", abs(TESTS[0]), "A1"), status: 7, files: TESTS, repoRoot, commit: MAIN, buildUuid: "u", durationMs: 0 })!;
  assert.deepEqual([crashed.fail, crashed.failures], [1, [{ file: null, name: "node --test exited 7" }]], "a non-zero exit is never a pass");
  // The line round-trips: printed by the build, found in its log by the Forge, valid for the Forge's validator.
  const printed = testResultLine(r);
  assert.ok(printed.startsWith(TEST_RESULT_MARKER));
  assert.deepEqual(validateTestReport(resultFromLogs({ lines: [["t", printed]] }, TEST_RESULT_MARKER), { confirm: "absent" }).failures, r.failures);
  // The reporter writes only kind, file, name and outcome; never a message.
  async function* events() {
    yield { type: "test:start", data: { name: "A1" } };
    yield { type: "test:pass", data: { name: "A1", nesting: 0, file: abs(TESTS[0]), details: { duration_ms: 1, type: "test" } } };
    yield { type: "test:fail", data: { name: "B2", nesting: 1, file: abs(TESTS[1]), details: { error: new Error("ghp_secretish message"), type: "test" } } };
    yield { type: "test:pass", data: { name: "S", nesting: 0, file: abs(TESTS[2]), skip: "later", details: { type: "suite" } } };
    yield { type: "test:stdout", data: { message: "printed by a test" } };
  }
  let out = "";
  for await (const chunk of forgeTestReporter(events())) out += chunk;
  assert.deepEqual(out.trim().split("\n").map((l) => JSON.parse(l)), [
    { event: "pass", kind: "test", file: abs(TESTS[0]), name: "A1", nesting: 0, skip: false, todo: false },
    { event: "fail", kind: "test", file: abs(TESTS[1]), name: "B2", nesting: 1, skip: false, todo: false },
    { event: "pass", kind: "suite", file: abs(TESTS[2]), name: "S", nesting: 0, skip: true, todo: false },
  ]);
  assert.doesNotMatch(out, /ghp_|printed by a test/);
});

test("WB9b. the build posts its result like the type-check: no redirect followed, an answer for another commit is a failure", async () => {
  const body = { commit: MAIN, pass: 1 };
  let init: any = null;
  const redirect = async (_u: URL, i: RequestInit) => { init = i; return new Response(null, { status: 302 }); };
  await assert.rejects(postTestReport(redirect, "https://forge.example/", "id", "s", body), /refused the CI service token \(HTTP 302/);
  assert.equal(init.redirect, "manual");
  assert.deepEqual(JSON.parse(init.body).confirm, "REPORT");
  await assert.rejects(postTestReport(async () => Response.json({ commit: sha("c") }), "https://forge.example/", "id", "s", body), /did not record the test result/);
  const ok = async (u: URL) => { assert.equal(String(u), "https://forge.example/v1/forge/test-report"); return Response.json({ commit: MAIN, pass: 1, fail: 0, skip: 0, files: 3 }); };
  assert.deepEqual(await postTestReport(ok, "https://forge.example", "id", "s", body), { commit: MAIN, pass: 1, fail: 0, skip: 0, files: 3 });
  // The script: the type-check report goes first; the tests run after it, and their failure exits only after both reports.
  const script = read("workers/forge-typecheck/typecheck-and-report.mjs");
  const main = script.slice(script.indexOf("const selfUrl"));
  assert.ok(main.indexOf("await report(body, env)") < main.indexOf("runTests(shared, commit, tree, env)"), "the type-check report is posted before the tests run");
  assert.ok(main.indexOf("console.log(testResultLine(tests))") < main.indexOf("await reportTests(tests, env)"), "the line is printed before the post");
  assert.match(main, /process\.exit\(tc\.status === 0 && uiBuild\.status === 0 && !testsFailed \? 0 : 1\);/);
  assert.match(read("workers/forge-typecheck-cr/typecheck-and-report.mjs"), /FORGE_TEST_RESULT/);
  assert.match(main, /if \(env\.FORGE_SKIP_TESTS === "1"\) \{/);
  // The change-request project: secret-free always; its production build of main runs no test (the main project reports them).
  assert.deepEqual(crBuildEnv({ CF_ACCESS_CLIENT_ID: "i", CF_ACCESS_CLIENT_SECRET: "s", FORGE_URL: "u", WORKERS_CI_BRANCH: "cr/7", FORGE_SKIP_TESTS: "1" }), { WORKERS_CI_BRANCH: "cr/7" }, "a change request's build always runs its tests");
  assert.deepEqual(crBuildEnv({ CF_ACCESS_CLIENT_SECRET: "s", WORKERS_CI_BRANCH: "main" }), { WORKERS_CI_BRANCH: "main", FORGE_SKIP_TESTS: "1" });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. Guard paths, migration and documentation.

test("WB10. the route, the validator and the build scripts are the owner's; the check code is not", () => {
  for (const p of ["workers/forge/src/test-report.ts", "workers/control-plane-shared/src/forge-test-report.ts"]) assert.equal(criticalPathReason(p), "ci_harness", p);
  for (const p of ["workers/forge-typecheck/typecheck-and-report.mjs", "workers/forge-typecheck-cr/typecheck-and-report.mjs", "workers/forge-typecheck/test-reporter.mjs",
    "workers/forge-typecheck/package.json", "workers/forge-typecheck-cr/package.json", "workers/forge-typecheck/wrangler.toml", "workers/forge/src/cr-builds.ts"]) assert.equal(criticalPathReason(p), "typecheck_harness", p);
  for (const p of ["workers/forge/src/checks.ts", "workers/forge/src/runner/core.ts", "workers/forge/src/tick.ts"]) assert.equal(criticalPathReason(p), null, p);
  assert.match(read("workers/forge/src/index.ts"), /"0089_forge_test_reports\.sql"\] as const;/, "the Forge is not ready before its tables exist");
  const sql = read("workers/control-plane-migrations/0089_forge_test_reports.sql");
  const code = sql.split("\n").map((l) => l.split("--")[0]).join("\n").toUpperCase();
  assert.doesNotMatch(code, /\b(DROP|DELETE|UPDATE|INSERT|ALTER)\b/, "additive only");
  assert.match(read("workers/control-plane-migrations/test_migrations.py"), /PASS: 0089 forge_test_reports/);
});

test("WB11. docs: SSOT line 5, the Forge checks row, ADR-0012's amendment and the READMEs say what runs where", () => {
  const ssot = read("docs/SSOT.md");
  const line = ssot.split("\n").find((l) => l.startsWith("Last reviewed: "))!;
  assert.match(line, /^Last reviewed: 2026-11-16 \((?:[^\n]*; )?CI-WB, 2026-11-25 \(owner: "ok jalankan rekomendasimu"; Forge tests on Workers Builds, Dynamic Workers only as a one-per-run fallback, no daily rerun of an unchanged head\); /);
  assert.match(ssot, /\| Forge checks \| Each new `main` commit: the full suite from the commit's Workers Builds run[^\n]*`test_report_files_mismatch`/);
  const adr = read("architecture/adr/0012-github-independence.md");
  assert.match(adr, /\*\*Amended 2026-11-25 \(CI-WB, owner: "ok jalankan rekomendasimu"\)\.\*\*[^\n]*POST \/v1\/forge\/test-report[^\n]*FORGE_TEST_RESULT[^\n]*one Dynamic Worker/);
  assert.match(adr, /\*\*Amended 2026-11-25 \(CI-WB\)\.\*\* The daily run is dropped/);
  const readme = read("workers/forge/README.md");
  for (const s of ["POST /v1/forge/test-report", "FORGE_TEST_RESULT", "workers-builds/1", "test_report_files_mismatch", "no daily"]) assert.ok(readme.includes(s), s);
  assert.ok(read("workers/forge-typecheck/README.md").includes("/v1/forge/test-report"));
});
