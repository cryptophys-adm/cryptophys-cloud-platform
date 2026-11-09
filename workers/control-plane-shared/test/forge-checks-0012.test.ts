// ADR-0012 phase 3: Forge checks. The control-plane suite runs on Cloudflare against each new commit
// of main, from an Artifacts snapshot, in Dynamic Workers. tools/forge-runner runs this same code in
// local workerd; these tests pin its pure parts and its bookkeeping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CI_JWT, OPERATOR_JWT, OUTSIDER_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import forge, { REPO } from "../../forge/src/index.ts";
import { LOOKBACK_COMMITS, PARITY_TARGET, RUNNER_ID, STALE_RUN_MS, agreement, checksTick, claim, parity, snapshotFromArtifacts, type ArtifactsReader, type ArtifactsTreeEntry } from "../../forge/src/checks.ts";
import {
  FILES_PER_WORKER, MAX_FILE_BYTES, deferTopLevel, groupFiles, runSuite, runnerEntry, snapshotPathAllowed, tally, testFiles, testWorkerCode,
  type EsbuildLike, type ShimSources, type SuiteDeps, type TestWorkerCode,
} from "../../forge/src/runner/core.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const h = (c: string) => c.repeat(40);

/** A fake Artifacts repo: a commit whose tree has every kind of entry the snapshot must handle. */
function fakeRepo(opts: { commits?: string[]; blobs?: Record<string, string> } = {}) {
  const blobs: Record<string, string> = {
    ...opts.blobs,
    [h("1")]: "export const a = 1;\n",
    [h("2")]: "# readme\n",
    [h("3")]: "binary-ish",
    [h("4")]: "x".repeat(MAX_FILE_BYTES),
    [h("5")]: "#!/bin/sh\necho ok\n",
    [h("6")]: "module.exports = {};\n",
    [h("7")]: "test('x', () => {});\n",
  };
  const e = (name: string, type: ArtifactsTreeEntry["type"], hash: string): ArtifactsTreeEntry => ({ name, type, hash, mode: type === "tree" ? "40000" : "100644" });
  const trees: Record<string, ArtifactsTreeEntry[]> = {
    [h("a")]: [e("README.md", "blob", h("2")), e("workers", "tree", h("b")), e("node_modules", "tree", h("c")), e("logo.png", "blob", h("3")),
      e("big.json", "blob", h("4")), e("run.sh", "exec", h("5")), e("link", "symlink", h("9")), e("vendor", "gitlink", h("8"))],
    [h("b")]: [e("src.ts", "blob", h("1")), e("dist", "tree", h("c")), e("control-plane-shared", "tree", h("d"))],
    [h("c")]: [e("pkg.js", "blob", h("6"))],
    [h("d")]: [e("test", "tree", h("e"))],
    [h("e")]: [e("one.test.ts", "blob", h("7"))],
  };
  const commits = opts.commits ?? [h("0")];
  const reads = { trees: 0, blobs: 0, disposed: 0 };
  const repo: ArtifactsReader & { list(): Promise<unknown>; info(): Promise<unknown> } = {
    async readCommit(hash) { return commits.includes(hash) ? { hash, treeHash: h("a") } : null; },
    async readTree(hash) { reads.trees++; return trees[hash] ?? null; },
    async readBlob(hash) { reads.blobs++; return hash in blobs ? new Blob([blobs[hash]]) : null; },
    async log(o) { return commits.slice(0, o?.limit ?? 50).map((hash) => ({ hash })); },
    [Symbol.dispose]() { reads.disposed++; },
    async list() { return {}; },
    async info() { return null; },
  };
  return { repo, trees, reads };
}

test("FC1. a snapshot is the commit's text files, as a checkout would have them", async () => {
  const { repo, reads } = fakeRepo();
  const snap = await snapshotFromArtifacts(repo, h("0"));
  assert.deepEqual(Object.keys(snap.snapshot), ["README.md", "run.sh", "workers/control-plane-shared/test/one.test.ts", "workers/src.ts"],
    "no node_modules or dist, no binary files, no file of 2 MB or more, no symlinks or submodules");
  assert.equal(snap.snapshot["workers/src.ts"], "export const a = 1;\n");
  assert.equal(reads.trees, 4, "skipped directories are never read");
  await assert.rejects(snapshotFromArtifacts(repo, "nothex"), /invalid_commit/);
  await assert.rejects(snapshotFromArtifacts(repo, h("f")), /commit_not_found/);
});

test("FC2. a tree entry that could escape the snapshot is refused", async () => {
  for (const name of ["..", ".", "a/b", ""]) {
    const { repo, trees } = fakeRepo();
    trees[h("a")] = [{ name, type: "blob", hash: h("1"), mode: "100644" }];
    await assert.rejects(snapshotFromArtifacts(repo, h("0")), /invalid_tree_entry/, JSON.stringify(name));
  }
});

test("FC3. the runner core: paths, test files, groups and the deferred module body", () => {
  assert.equal(snapshotPathAllowed("workers/x/src/a.ts"), true);
  assert.equal(snapshotPathAllowed("workers/x/node_modules/a.js"), false);
  assert.equal(snapshotPathAllowed("ui/dist/index.html"), false);
  assert.equal(snapshotPathAllowed("docs/logo.png"), false);
  const snap = { "workers/control-plane-shared/test/b.test.ts": "", "workers/control-plane-shared/test/a.test.ts": "", "workers/control-plane-shared/test/harness.ts": "", "workers/control-plane-shared/test/fixtures/x.test.ts": "" };
  assert.deepEqual(testFiles(snap), ["workers/control-plane-shared/test/a.test.ts", "workers/control-plane-shared/test/b.test.ts"]);
  const groups = groupFiles(Array.from({ length: 43 }, (_, i) => String(i)));
  assert.equal(groups.length, 11, "43 files in 11 test Workers of at most 4, under the 32 Worker invocations one request may make");
  assert.equal(FILES_PER_WORKER, 4, "groups of 8 ran sql.js out of memory (2026-11-09)");
  assert.ok(groups.every((g) => g.length <= FILES_PER_WORKER));
  const entry = runnerEntry(["x/a.test.ts"]);
  assert.match(entry, /cleanupSqlite/);
  assert.match(entry, /sqlite_open_after/);
  const deferred = deferTopLevel('import assert from "node:assert/strict";\nconst k = Date.now();\ntest("x", () => {});\nexport {\n  k\n};\n');
  assert.match(deferred, /^import assert from "node:assert\/strict";\nexport async function __load\(\) \{\nconst k = Date\.now\(\);/);
  assert.doesNotMatch(deferred, /export \{/);
});

test("FC4. one test Worker per group, without network access, with the bundler callback", async () => {
  const snapshot: Record<string, string> = {};
  for (let i = 0; i < 10; i++) snapshot[`workers/control-plane-shared/test/t${String(i).padStart(2, "0")}.test.ts`] = "x";
  const loaded: TestWorkerCode[] = [];
  const esbuild: EsbuildLike = {
    async build(o) {
      const entry = (o.entryPoints as string[])[0];
      if (entry.endsWith("t03.test.ts")) throw new Error("Build failed: syntax error");
      return { outputFiles: [{ text: `test(${JSON.stringify(entry)});\n`, contents: new Uint8Array() }], errors: [], warnings: [] };
    },
  };
  const deps: SuiteDeps = {
    esbuild, shims: {} as ShimSources, sqlJs: "export default 1;", sqlWasm: "WASM", bundler: "BUNDLER-STUB",
    async runWorker(code) {
      loaded.push(code);
      const files = code.modules["files.json"] as { json: string[] };
      if (files.json.includes("workers/control-plane-shared/test/t09.test.ts")) throw new Error("Worker exceeded CPU limit");
      return { files: files.json.map((file) => ({ file, results: file.endsWith("/t00.test.ts") ? [{ name: "a", status: "pass" }, { name: "b", status: "fail", error: "boom" }] : [{ name: "a", status: "pass" }, { name: "s", status: "skip" }] })) };
    },
  };
  const r = await runSuite(deps, snapshot);
  assert.equal(loaded.length, 3, "10 files: three Workers (3, 4, 2); one file did not bundle");
  for (const code of loaded) {
    assert.equal(code.globalOutbound, null, "tests have no network access");
    assert.deepEqual(code.env, { BUNDLER: "BUNDLER-STUB" });
    assert.equal(code.mainModule, "entry.js");
    assert.equal((code.modules["snapshot.json.txt"] as { text: string }).text, JSON.stringify(snapshot));
  }
  assert.equal(r.files, 10);
  assert.equal(r.pass, 7);
  assert.equal(r.skip, 6);
  assert.equal(r.fail, 1 + 1 + 2, "one failed test, one bundle error, two files of a Worker that crashed");
  assert.ok(r.failures.some((f) => f.startsWith("t03.test.ts: BUNDLE")));
  assert.ok(r.failures.some((f) => f.startsWith("t09.test.ts: RUN Worker exceeded CPU limit")));
  assert.ok(r.failures.some((f) => f === "t00.test.ts :: b: boom"));
});

test("FC5b. a SQL.js database left open by a file fails the suite", () => {
  const r = tally({ files: 0, pass: 0, fail: 0, skip: 0, failures: [] }, ["x/a.test.ts"], {
    files: [{ file: "x/a.test.ts", results: [{ name: "ok", status: "pass" }], sqlite_open_after: 1, sqlite_close_errors: 0 }],
  });
  assert.deepEqual(r, {
    files: 1, pass: 1, fail: 1, skip: 0,
    failures: ["a.test.ts: SQLITE cleanup left 1 database(s) open (0 close errors)"],
  });
});

test("FC5. a file the test Worker did not report, or could not load, fails", () => {
  const r = tally({ files: 0, pass: 0, fail: 0, skip: 0, failures: [] }, ["x/a.test.ts", "x/b.test.ts"], { files: [{ file: "x/a.test.ts", load_error: "SyntaxError" }] });
  assert.deepEqual(r, { files: 2, pass: 0, fail: 2, skip: 0, failures: ["a.test.ts: LOAD SyntaxError", "b.test.ts: RUN no report from the test Worker"] });
  const code = testWorkerCode([{ file: "x/a.test.ts", code: "export async function __load() {}" }], { snapshotText: "{}", sqlJs: "s", sqlWasm: "w" });
  assert.deepEqual(Object.keys(code.modules).sort(), ["entry.js", "files.json", "snapshot.json.txt", "sql-wasm.wasm", "sql.js", "test-a_test_ts.js"]);
  assert.match(runnerEntry(["x/a.test.ts"]), /"x\/a\.test\.ts": \(\) => import\("\.\/test-a_test_ts\.js"\)/);
});

/** Suite deps that pass every file, recording which commits were run. */
function passingDeps(ran: string[], fail = 0) {
  return async (commit: string): Promise<SuiteDeps> => {
    ran.push(commit);
    return {
      esbuild: { async build() { return { outputFiles: [{ text: "x", contents: new Uint8Array() }], errors: [], warnings: [] }; } },
      shims: {} as ShimSources, sqlJs: "", sqlWasm: null,
      async runWorker(code) {
        const files = (code.modules["files.json"] as { json: string[] }).json;
        return { files: files.map((file) => ({ file, results: [{ name: "t", status: fail ? "fail" : "pass", error: fail ? "nope" : undefined }] })) };
      },
    };
  };
}

test("FC6. each tick checks the oldest unchecked commit of main, once, and audits it", async () => {
  const db = migratedDb();
  const newestFirst = [h("3"), h("2"), h("1")];
  const { repo, reads } = fakeRepo({ commits: newestFirst });
  const env = { DB: db, ARTIFACTS: { get: async (name: string) => { assert.equal(name, REPO); return repo; } } };
  const ran: string[] = [];
  let now = Date.parse("2026-11-08T09:04:00Z");
  const clock = () => now;
  assert.deepEqual(await checksTick(env, REPO, passingDeps(ran), clock), { outcome: "checked", commit: h("1"), status: "passed", pass: 1, fail: 0 });
  now += 15 * 60_000;
  assert.equal((await checksTick(env, REPO, passingDeps(ran, 1), clock) as { status: string }).status, "failed");
  now += 15 * 60_000;
  await checksTick(env, REPO, passingDeps(ran), clock);
  assert.deepEqual(ran, [h("1"), h("2"), h("3")], "oldest first, one per tick");
  assert.deepEqual(await checksTick(env, REPO, passingDeps(ran), clock), { outcome: "up_to_date" });
  assert.equal(reads.disposed, 4, "the repo handle is released on every tick");
  const rows = db.raw.prepare("SELECT commit_sha, status, runner, files, pass, fail, failures FROM forge_check_runs ORDER BY started_at").all() as any[];
  assert.deepEqual(rows.map((r) => [r.commit_sha, r.status, r.runner, r.files, r.pass, r.fail]), [
    [h("1"), "passed", RUNNER_ID, 1, 1, 0], [h("2"), "failed", RUNNER_ID, 1, 0, 1], [h("3"), "passed", RUNNER_ID, 1, 1, 0],
  ]);
  assert.deepEqual(JSON.parse(rows[1].failures), ["one.test.ts :: t: nope"]);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'forge.checks_completed'").get() as any).n, 3);
  assert.equal(LOOKBACK_COMMITS, 5);
});

test("FC7. a run in progress is not taken twice; a lost one is retried after 30 minutes", async () => {
  const db = migratedDb();
  const t0 = Date.parse("2026-11-08T09:04:00Z");
  assert.equal(await claim(db, h("1"), t0), true);
  assert.equal(await claim(db, h("1"), t0 + 60_000), false, "a live run is not claimed again");
  const { repo } = fakeRepo({ commits: [h("1")] });
  const env = { DB: db, ARTIFACTS: { get: async () => repo } };
  const ran: string[] = [];
  assert.deepEqual(await checksTick(env, REPO, passingDeps(ran), () => t0 + 60_000), { outcome: "up_to_date" });
  const later = t0 + STALE_RUN_MS + 60_000;
  assert.equal((await checksTick(env, REPO, passingDeps(ran), () => later) as { status: string }).status, "passed");
  assert.deepEqual(ran, [h("1")]);
});

test("FC8. an infrastructure error is recorded as an error, not as a test failure", async () => {
  const db = migratedDb();
  const { repo, trees } = fakeRepo({ commits: [h("1")] });
  delete trees[h("d")];
  const out = await checksTick({ DB: db, ARTIFACTS: { get: async () => repo } }, REPO, passingDeps([]), () => Date.parse("2026-11-08T09:04:00Z"));
  assert.deepEqual(out, { outcome: "checked", commit: h("1"), status: "error" });
  const row = db.raw.prepare("SELECT status, failures, files FROM forge_check_runs").get() as any;
  assert.equal(row.status, "error");
  assert.deepEqual(JSON.parse(row.failures), ["tree_not_found"]);
  assert.equal(row.files, null);
  assert.deepEqual(await checksTick({ DB: db }, REPO, passingDeps([])), { outcome: "not_configured" });
});

test("FC9. GET /v1/forge/checks lists runs for operators only", async () => {
  const db = migratedDb();
  const { repo } = fakeRepo({ commits: [h("1")] });
  await checksTick({ DB: db, ARTIFACTS: { get: async () => repo } }, REPO, passingDeps([], 1), () => Date.parse("2026-11-08T09:04:00Z"));
  const e = baseEnv("cryptophys-forge", db, { ARTIFACTS: {} });
  const r = await call(forge, e, req("GET", "/v1/forge/checks?limit=5", undefined, OPERATOR_JWT));
  assert.equal(r.status, 200);
  assert.equal(r.body.checks.length, 1);
  assert.equal(r.body.checks[0].commit, h("1"));
  assert.equal(r.body.checks[0].status, "failed");
  assert.deepEqual(r.body.checks[0].failures, ["one.test.ts :: t: nope"]);
  assert.equal((await call(forge, e, req("GET", "/v1/forge/checks", undefined, OUTSIDER_JWT))).status, 403);
});

test("FC10. Forge config: cron off the other minutes, Worker Loader, toolchain kept out of the Node path", () => {
  const toml = read("workers/forge/wrangler.toml");
  const minutes = (s: string) => s.split(",").map(Number);
  const forgeCron = /crons = \["([\d,]+) \* \* \* \*"\]/.exec(toml)?.[1];
  assert.equal(forgeCron, "4,19,34,49");
  const others = new Set([
    ...minutes(/crons = \["([\d,]+) /.exec(read("workers/ai-kernel/wrangler.toml"))![1]),
    ...minutes(/crons = \["([\d,]+) /.exec(read("workers/deployment-orchestrator/wrangler.toml"))![1]),
    0, 15, 30, 45, 13, // drift detector (*/15), recovery manager
  ]);
  for (const m of minutes(forgeCron!)) assert.ok(!others.has(m), `minute ${m} is already used by another cron`);
  assert.match(toml, /\[\[worker_loaders\]\]\s*\nbinding = "LOADER"/);
  assert.match(toml, /type = "Text"\s*\nglobs = \["\*\*\/shims\/node-\*\.js", "\*\*\/sql\.js\/dist\/sql-wasm\.js"\]/);
  // Wrangler matches rule globs against the specifier, so the imports must keep these shapes.
  const assets = read("workers/forge/src/runner/assets.js");
  for (const n of ["test", "sqlite", "fs", "os", "child_process"]) assert.match(assets, new RegExp(`from "\\./shims/node-${n}\\.js"`));
  assert.match(assets, /from "[^"]*\/sql\.js\/dist\/sql-wasm\.js"/);
  for (const f of ["index.ts", "checks.ts", "runner/core.ts"]) assert.doesNotMatch(read("workers/forge/src/" + f), /assets\.js|runtime\.ts/, f + " must not load the wasm toolchain");
  assert.match(read("workers/forge/src/worker.ts"), /export class ForgeBundler extends WorkerEntrypoint/);
});

test("FC11. GitHub CI reports come from the CI service token only, validated and audited", async () => {
  const db = migratedDb();
  const e = baseEnv("cryptophys-forge", db, { ARTIFACTS: {} });
  const report = (body: unknown, jwt = CI_JWT) => call(forge, e, req("POST", "/v1/forge/ci-report", body, jwt));
  const ok = { confirm: "REPORT", commit: h("1"), conclusion: "success", workflow_run_id: 42465870987 };
  assert.equal((await report(ok, OPERATOR_JWT)).status, 403, "a person cannot write a CI result");
  assert.equal((await report(ok, OUTSIDER_JWT)).status, 403);
  assert.equal((await report({ ...ok, confirm: "yes" })).status, 400);
  for (const bad of [{ commit: "abc" }, { conclusion: "cancelled" }, { workflow_run_id: "1; DROP" }]) {
    assert.equal((await report({ ...ok, ...bad })).status, 400, JSON.stringify(bad));
  }
  const r = await report(ok);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { commit: h("1"), conclusion: "success" });
  assert.equal((await report({ ...ok, conclusion: "failure", workflow_run_id: "43" })).status, 200, "a re-run replaces the result");
  assert.deepEqual(db.raw.prepare("SELECT conclusion, workflow_run_id FROM forge_ci_reports").all().map((r: any) => ({ ...r })), [{ conclusion: "failure", workflow_run_id: "43" }]);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'forge.ci_reported'").get() as any).n, 2);
});

test("FC12. parity counts consecutive agreements, newest first, over commits with both results", () => {
  assert.equal(agreement("passed", "success"), true);
  assert.equal(agreement("failed", "failure"), true);
  assert.equal(agreement("failed", "success"), false);
  assert.equal(agreement("error", "success"), false, "a Forge error never counts as agreement");
  assert.equal(agreement("passed", null), null);
  assert.equal(agreement("running", "success"), null);
  const p = parity([
    { commit: "n1", agrees: true }, { commit: "n2", agrees: null }, { commit: "n3", agrees: true },
    { commit: "o1", agrees: false }, { commit: "o2", agrees: true },
  ]);
  assert.deepEqual(p, { target: PARITY_TARGET, consecutive: 2, compared: 4, disagreements: ["o1"] });
  assert.equal(PARITY_TARGET, 20);
});

test("FC13. GET /v1/forge/checks shows GitHub CI next to each Forge check, and the parity", async () => {
  const db = migratedDb();
  const { repo } = fakeRepo({ commits: [h("2"), h("1")] });
  const env = { DB: db, ARTIFACTS: { get: async () => repo } };
  let now = Date.parse("2026-11-08T09:04:00Z");
  await checksTick(env, REPO, passingDeps([]), () => now);
  now += 15 * 60_000;
  await checksTick(env, REPO, passingDeps([]), () => now);
  const e = baseEnv("cryptophys-forge", db, { ARTIFACTS: {} });
  for (const [commit, conclusion] of [[h("1"), "success"], [h("2"), "failure"]]) {
    await call(forge, e, req("POST", "/v1/forge/ci-report", { confirm: "REPORT", commit, conclusion, workflow_run_id: 7 }, CI_JWT));
  }
  const r = await call(forge, e, req("GET", "/v1/forge/checks", undefined, OPERATOR_JWT));
  assert.deepEqual(r.body.checks.map((c: any) => [c.commit, c.status, c.github, c.agrees]), [[h("2"), "passed", "failure", false], [h("1"), "passed", "success", true]]);
  assert.deepEqual(r.body.parity, { target: 20, consecutive: 0, compared: 2, disagreements: [h("2")] });
});

test("FC14. the CI report workflow: main pushes only, read-only permissions, validated payload", () => {
  const wf = read(".github/workflows/forge-ci-report.yml");
  assert.match(wf, /workflows: \["Validate Control Plane Workers"\]\n\s+types: \[completed\]\n\s+branches: \[main\]/);
  assert.match(wf, /github\.event\.workflow_run\.event == 'push'/, "pull request runs are never reported");
  assert.match(wf, /conclusion == 'success' \|\| github\.event\.workflow_run\.conclusion == 'failure'/);
  assert.match(wf, /permissions:\n  contents: read\n  actions: read\n\n/, "no write permission");
  assert.doesNotMatch(wf, /ref: \$\{\{ github\.event\.workflow_run/, "the workflow never checks out the code under test");
  assert.match(wf, /persist-credentials: false/);
  assert.ok(wf.includes('[[ "$1" =~ ^[0-9a-f]{40}$ && "$3" =~ ^[0-9]{1,20}$ ]]'), "the commit and run id are validated before use");
  assert.match(wf, /\/v1\/forge\/ci-report/);
  assert.match(read(".github/workflows/ops-dispatch.yml"), /forge-ci-report\.yml\) ref=main ;;/);
  assert.equal(read("workers/control-plane-shared/test/../../control-plane-migrations/0032_forge_ci_reports.sql").includes("CHECK (conclusion IN ('success', 'failure'))"), true);
});

test("FC15. Worker bundles honour Wrangler's module rules and keep wasm and node_modules imports external", async () => {
  const { globToRegExp, moduleRules, snapshotPlugin } = await import("../../forge/src/runner/core.ts");
  assert.ok(globToRegExp("**/shims/node-*.js").test("./shims/node-test.js"), "matched against the specifier, as Wrangler does");
  assert.ok(!globToRegExp("**/shims/node-*.js").test("./shims/other.js"));
  assert.ok(globToRegExp("**/sql.js/dist/sql-wasm.js").test("../../../control-plane-shared/node_modules/sql.js/dist/sql-wasm.js"));
  const rules = moduleRules(read("workers/forge/wrangler.toml"));
  assert.deepEqual(rules.map((r) => r.type), ["Text", "Text"]);
  // Drive the plugin's resolver directly, as esbuild would.
  const external = new Set<string>();
  const resolvers: Array<{ filter: RegExp; f: (a: any) => any }> = [];
  const loaders: Array<{ filter: RegExp; namespace?: string; f: (a: any) => any }> = [];
  snapshotPlugin({ "w/src/shims/node-test.js": "export default 1;", "w/src/a.ts": "x" }, { worker: { rules, external } })
    .setup({ onResolve: (o, f) => resolvers.push({ filter: o.filter, f }), onLoad: (o, f) => loaders.push({ ...o, f }) });
  const resolve = (path: string, importer = "w/src/assets.js") => resolvers.find((r) => r.filter.test(path))!.f({ path, importer, kind: "import-statement" });
  assert.deepEqual(resolve("cloudflare:workers"), { path: "cloudflare:workers", external: true });
  assert.deepEqual(resolve("../../../cps/node_modules/esbuild-wasm/esbuild.wasm", "w/src/runner/assets.js"), { path: "../../../cps/node_modules/esbuild-wasm/esbuild.wasm", external: true });
  assert.deepEqual(resolve("./shims/node-test.js"), { path: "w/src/shims/node-test.js", namespace: "forge-snapshot", pluginData: "text" });
  assert.deepEqual(resolve("./a.ts"), { path: "w/src/a.ts", namespace: "forge-snapshot", pluginData: undefined });
  assert.deepEqual([...external], ["cps/node_modules/esbuild-wasm/esbuild.wasm"]);
  const load = loaders.find((l) => l.namespace === "forge-snapshot")!.f;
  assert.equal(load({ path: "w/src/shims/node-test.js", pluginData: "text" }).loader, "text");
  assert.equal(load({ path: "w/src/a.ts" }).loader, "ts");
});

test("FC16. the secret scan finds well-known credential formats and records only rule, path and line", async () => {
  const { scanSecrets, MAX_SECRET_FINDINGS } = await import("../../forge/src/runner/core.ts");
  // Built at run time, so this file never contains a credential-shaped string itself.
  const gh = "gh" + "p_" + "A1b2".repeat(9);
  const key = "-----BEGIN " + "PRIVATE KEY-----";
  const aws = "AK" + "IA" + "ABCDEFGHIJKLMNOP";
  const snap = { "a.ts": `const t = "${gh}";\nok\n`, "keys/id": `x\n${key}\n`, "cfg.env": `id=${aws}`, "clean.md": "nothing to see" };
  const r = scanSecrets(snap);
  assert.equal(r.files, 4);
  assert.deepEqual(r.findings, [
    { rule: "github_token", path: "a.ts", line: 1 },
    { rule: "private_key", path: "keys/id", line: 2 },
    { rule: "aws_access_key", path: "cfg.env", line: 1 },
  ]);
  assert.ok(!JSON.stringify(r).includes(gh) && !JSON.stringify(r).includes(aws), "the matched text is never kept");
  const many: Record<string, string> = {};
  for (let i = 0; i < 80; i++) many[`f${i}`] = key;
  assert.equal(scanSecrets(many).findings.length, MAX_SECRET_FINDINGS);
  // The repository itself is clean.
  assert.deepEqual(scanSecrets({ "core.ts": read("workers/forge/src/runner/core.ts"), "this.ts": read("workers/control-plane-shared/test/forge-checks-0012.test.ts") }).findings, []);
});

test("FC17. a run records its steps; a bundle failure fails it, a secret finding flags the guard", async () => {
  const h2 = (c: string) => c.repeat(20);
  const db = migratedDb();
  const secret = "gh" + "p_" + "Z9y8".repeat(9);
  const { repo, trees } = fakeRepo({ commits: [h("1")], blobs: { [h2("b1")]: 'main = "src/index.ts"\n', [h2("b2")]: "name = \"no-main\"\n", [h2("b3")]: "export default {};\n", [h2("b4")]: `token = "${secret}"\n` } });
  const e = (name: string, type: ArtifactsTreeEntry["type"], hash: string): ArtifactsTreeEntry => ({ name, type, hash, mode: type === "tree" ? "40000" : "100644" });
  trees[h("b")].push(e("good", "tree", h2("c1")), e("bad", "tree", h2("c2")));
  trees[h2("c1")] = [e("wrangler.toml", "blob", h2("b1")), e("src", "tree", h2("c3"))];
  trees[h2("c3")] = [e("index.ts", "blob", h2("b3"))];
  trees[h2("c2")] = [e("wrangler.toml", "blob", h2("b2"))];
  trees[h("a")].push(e("leak.env", "blob", h2("b4")));
  const built: string[] = [];
  const deps = async (): Promise<SuiteDeps> => ({
    esbuild: { async build(o) { built.push(String((o.entryPoints as string[] | undefined)?.[0] ?? "stdin")); return { outputFiles: [{ text: "x", contents: new Uint8Array(10) }], errors: [], warnings: [] }; } },
    shims: {} as ShimSources, sqlJs: "", sqlWasm: null,
    async runWorker(code) {
      return { files: (code.modules["files.json"] as { json: string[] }).json.map((file) => ({ file, results: [{ name: "t", status: "pass" }] })) };
    },
  });
  await checksTick({ DB: db, ARTIFACTS: { get: async () => repo } }, REPO, deps, () => Date.parse("2026-11-08T12:04:00Z"));
  const row = db.raw.prepare("SELECT status, guard_status, steps, failures FROM forge_check_runs").get() as any;
  const steps = JSON.parse(row.steps);
  assert.deepEqual(steps.tests, { files: 1, pass: 1, fail: 0, skip: 0 });
  assert.equal(steps.bundles.workers, 2, "every workers/<name>/wrangler.toml in the commit");
  assert.deepEqual(steps.bundles.bundles, [{ dir: "workers/good", bytes: 10, external: [] }]);
  assert.deepEqual(steps.bundles.failed, [{ dir: "workers/bad", error: "wrangler.toml in workers/bad has no main" }]);
  assert.ok(built.includes("workers/good/src/index.ts"));
  assert.equal(row.status, "failed", "a Worker that does not bundle fails the run");
  assert.deepEqual(steps.secrets.findings, [{ rule: "github_token", path: "leak.env", line: 1 }]);
  assert.equal(row.guard_status, "findings");
  assert.ok(!row.steps.includes(secret) && !row.failures.includes(secret), "the credential itself is never stored");
  assert.ok(JSON.parse(row.failures).includes("secret github_token at leak.env:1"));
  const listed = await call(forge, baseEnv("cryptophys-forge", db, { ARTIFACTS: {} }), req("GET", "/v1/forge/checks", undefined, OPERATOR_JWT));
  assert.deepEqual(listed.body.checks[0].bundles, { workers: 2, failed: 1 });
  assert.equal(listed.body.checks[0].guard_status, "findings");
});

test("FC19. the SQL.js shim tracks databases and the runner releases test-owned handles after each test", () => {
  const shim = read("workers/forge/src/runner/shims/node-sqlite.js");
  const core = read("workers/forge/src/runner/core.ts");
  assert.match(shim, /__SQL_DATABASES/);
  assert.match(shim, /databases\.add\(this\)/);
  assert.match(shim, /databases\.delete\(this\)/);
  assert.match(core, /const keepSqlite = new Set\(globalThis\.__SQL_DATABASES \?\? \[\]\)/);
  assert.match(core, /cleanupSqlite\(keepSqlite\)/);
});

test("FC18. the Forge is not ready before its own migrations are applied; other Workers do not wait for them", async () => {
  const { FORGE_MIGRATIONS } = await import("../../forge/src/index.ts");
  const { schemaReady } = await import("../src/readiness.ts");
  const db = migratedDb();
  const e = baseEnv("cryptophys-forge", db, { ARTIFACTS: {} });
  assert.equal((await call(forge, e, req("GET", "/ready", undefined, OPERATOR_JWT))).body.checks.database_schema, true);
  db.raw.prepare("DELETE FROM d1_migrations WHERE name = ?").run(FORGE_MIGRATIONS[2]);
  const r = await call(forge, e, req("GET", "/ready", undefined, OPERATOR_JWT));
  assert.equal(r.status, 503);
  assert.equal(r.body.checks.database_schema, false);
  assert.equal(await schemaReady(e as never), true, "the shared requirement is unchanged");
});
