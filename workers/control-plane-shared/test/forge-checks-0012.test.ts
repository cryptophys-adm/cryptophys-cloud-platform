// ADR-0012 phase 3: Forge checks. The control-plane suite runs on Cloudflare against each new commit
// of main, from an Artifacts snapshot, in Dynamic Workers. tools/forge-runner runs this same code in
// local workerd; these tests pin its pure parts and its bookkeeping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CI_JWT, OPERATOR_JWT, OUTSIDER_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import forge, { REPO } from "../../forge/src/index.ts";
import { PARITY_TARGET, RUNNER_ID, STALE_RUN_MS, agreement, checksTick, claim, parity, snapshotFromArtifacts, utcDayStart, type ArtifactsReader, type ArtifactsTreeEntry } from "../../forge/src/checks.ts";
import {
  FILES_PER_WORKER, MAX_FILE_BYTES, RUNNER_ENTRY, TEST_WORKER_ID_PREFIX, bundleTest, deferTopLevel, groupFiles, runSuite, runnerEntry, snapshotPathAllowed, tally, testFiles, testWorkerCode, testWorkerId,
  type EsbuildLike, type ShimSources, type SuiteDeps, type TestWorkerCode, type TestWorkerRequest,
} from "../../forge/src/runner/core.ts";
import { forgeReady } from "../src/forge-gate.ts";

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
  const requests: TestWorkerRequest[] = [];
  const esbuild: EsbuildLike = {
    async build(o) {
      const entry = (o.entryPoints as string[])[0];
      if (entry.endsWith("t03.test.ts")) throw new Error("Build failed: syntax error");
      return { outputFiles: [{ text: `test(${JSON.stringify(entry)});\n`, contents: new Uint8Array() }], errors: [], warnings: [] };
    },
  };
  const deps: SuiteDeps = {
    esbuild, shims: {} as ShimSources, sqlJs: "export default 1;", sqlWasm: "WASM", bundler: "BUNDLER-STUB", limits: { cpuMs: 60_000 },
    async runWorker(code, request) {
      loaded.push(code);
      requests.push(request);
      const files = code.modules["files.json"] as { json: string[] };
      if (files.json.includes("workers/control-plane-shared/test/t09.test.ts")) throw new Error("Worker exceeded CPU limit");
      return { files: files.json.map((file) => ({ file, results: file.endsWith("/t00.test.ts") ? [{ name: "a", status: "pass" }, { name: "b", status: "fail", error: "boom" }] : [{ name: "a", status: "pass" }, { name: "s", status: "skip" }] })) };
    },
  };
  const r = await runSuite(deps, snapshot, undefined, h("c"));
  assert.equal(loaded.length, 3 + 2, "10 files: three Workers (3, 4, 2), one file did not bundle; the crashed group reruns alone");
  for (const [i, code] of loaded.entries()) {
    assert.equal(code.globalOutbound, null, "tests have no network access");
    assert.deepEqual(code.limits, { cpuMs: 60_000 }, "the CPU limit is part of the code");
    assert.deepEqual(code.env, { BUNDLER: "BUNDLER-STUB" });
    assert.equal(code.mainModule, "entry.js");
    assert.equal(code.modules["snapshot.json.txt"], undefined, "the snapshot is not in the Worker's code");
    assert.ok(!JSON.stringify(code.modules).includes(h("c")), "nor is the commit");
    assert.equal(requests[i].id, await testWorkerId(code), "the Worker is addressed by its code");
    assert.deepEqual(JSON.parse(requests[i].body), { commit: h("c"), snapshot }, "the run's data comes in the request");
  }
  assert.deepEqual(r.workers, { groups: 3, bundles: 5, loads: 5 }, "three groups, two isolated reruns: five distinct Workers, five requests");
  assert.deepEqual(loaded.slice(3).map((c) => (c.modules["files.json"] as { json: string[] }).json.length), [1, 1]);
  assert.equal(r.files, 10);
  assert.equal(r.pass, 8, "t08 passes once it runs without t09");
  assert.equal(r.skip, 7);
  assert.equal(r.fail, 1 + 1 + 1, "one failed test, one bundle error, the file whose own Worker crashed");
  assert.equal(r.isolated, 2);
  assert.ok(r.failures.some((f) => f.startsWith("t03.test.ts: BUNDLE")));
  assert.ok(r.failures.some((f) => f.startsWith("t09.test.ts: RUN Worker exceeded CPU limit")));
  assert.ok(!r.failures.some((f) => f.startsWith("t08.test.ts")));
  assert.ok(r.failures.some((f) => f === "t00.test.ts :: b: boom"));
});

test("FC4b. a group whose Worker exceeds the memory limit reruns each file alone; every test still runs", async () => {
  const snapshot: Record<string, string> = {};
  for (let i = 0; i < 4; i++) snapshot[`workers/control-plane-shared/test/h${i}.test.ts`] = "x";
  const sizes: number[] = [];
  const deps: SuiteDeps = {
    esbuild: { async build() { return { outputFiles: [{ text: "x", contents: new Uint8Array() }], errors: [], warnings: [] }; } },
    shims: {} as ShimSources, sqlJs: "", sqlWasm: null,
    async runWorker(code) {
      const files = (code.modules["files.json"] as { json: string[] }).json;
      sizes.push(files.length);
      if (files.length > 2) throw new Error("Worker exceeded memory limit.");
      return { files: files.map((file) => ({ file, results: [{ name: "t", status: file.endsWith("h2.test.ts") ? "fail" : "pass", error: "real" }] })) };
    },
  };
  const r = await runSuite(deps, snapshot);
  assert.deepEqual(sizes, [4, 1, 1, 1, 1]);
  assert.deepEqual({ files: r.files, pass: r.pass, fail: r.fail, isolated: r.isolated }, { files: 4, pass: 3, fail: 1, isolated: 4 });
  assert.deepEqual(r.failures, ["h2.test.ts :: t: real"], "a real failure still fails; the memory error is gone");
  const single: SuiteDeps = { ...deps, async runWorker() { throw new Error("Worker exceeded memory limit."); } };
  const one = await runSuite(single, { "workers/control-plane-shared/test/solo.test.ts": "x" });
  assert.deepEqual({ fail: one.fail, isolated: one.isolated }, { fail: 1, isolated: undefined }, "a single file is not retried");
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
  const code = testWorkerCode([{ file: "x/a.test.ts", code: "export async function __load() {}" }], { sqlJs: "s", sqlWasm: "w" });
  assert.deepEqual(Object.keys(code.modules).sort(), ["entry.js", "files.json", "sql-wasm.wasm", "sql.js", "test-a_test_ts.js"]);
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

test("FC6. each tick checks main's head, once, and audits it; commits a newer head superseded are never checked (2026-11-14)", async () => {
  const db = migratedDb();
  const commits = [h("3"), h("2"), h("1")];
  const { repo, reads } = fakeRepo({ commits });
  const env = { DB: db, ARTIFACTS: { get: async (name: string) => { assert.equal(name, REPO); return repo; } } };
  const ran: string[] = [];
  let now = Date.parse("2026-11-08T09:04:00Z");
  const clock = () => now;
  assert.deepEqual(await checksTick(env, REPO, passingDeps(ran), clock), { outcome: "checked", commit: h("3"), status: "passed", pass: 1, fail: 0 });
  now += 15 * 60_000;
  assert.deepEqual(await checksTick(env, REPO, passingDeps(ran), clock), { outcome: "up_to_date" }, "the head is checked once");
  // main moves twice between two ticks: h("5") supersedes h("4").
  commits.unshift(h("5"), h("4"));
  now += 15 * 60_000;
  assert.deepEqual(await checksTick(env, REPO, passingDeps(ran, 1), clock), { outcome: "checked", commit: h("5"), status: "failed", pass: 0, fail: 1 });
  now += 15 * 60_000;
  assert.deepEqual(await checksTick(env, REPO, passingDeps(ran), clock), { outcome: "up_to_date" }, "a failed head is not run again the same day");
  commits.unshift(h("6"));
  now += 15 * 60_000;
  assert.equal((await checksTick(env, REPO, passingDeps(ran), clock) as { commit: string }).commit, h("6"));
  assert.deepEqual(ran, [h("3"), h("5"), h("6")], "only heads, one run each; h(1), h(2) and h(4) never run");
  assert.equal(reads.disposed, 5, "the repo handle is released on every tick");
  const rows = db.raw.prepare("SELECT commit_sha, status, runner, files, pass, fail, failures, steps FROM forge_check_runs ORDER BY started_at").all() as any[];
  assert.deepEqual(rows.map((r) => [r.commit_sha, r.status, r.runner, r.files, r.pass, r.fail]), [
    [h("3"), "passed", RUNNER_ID, 1, 1, 0], [h("5"), "failed", RUNNER_ID, 1, 0, 1], [h("6"), "passed", RUNNER_ID, 1, 1, 0],
  ]);
  assert.deepEqual(JSON.parse(rows[1].failures), ["one.test.ts :: t: nope"]);
  assert.deepEqual(JSON.parse(rows[0].steps).workers, { groups: 1, bundles: 1, loads: 1 }, "the run's Dynamic Workers are recorded");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'forge.checks_completed'").get() as any).n, 3);
});

test("FC6b. main's head runs again once per UTC day, whatever its last result; readiness reads pending while it runs (2026-11-14)", async () => {
  assert.equal(utcDayStart(Date.parse("2026-11-09T23:59:59.999Z")), Date.parse("2026-11-09T00:00:00Z"));
  const db = migratedDb();
  const { repo } = fakeRepo({ commits: [h("1")] });
  const env = { DB: db, ARTIFACTS: { get: async () => repo } };
  const ran: string[] = [];
  const at = (iso: string) => () => Date.parse(iso);
  const outcome = async (iso: string, fail = 0) => {
    const r = await checksTick(env, REPO, passingDeps(ran, fail), at(iso)) as { outcome: string; status?: string };
    return r.outcome === "checked" ? r.status : r.outcome;
  };
  assert.equal(await outcome("2026-11-08T09:04:00Z"), "passed");
  assert.equal(await outcome("2026-11-08T23:49:00Z"), "up_to_date", "not again the same UTC day");
  assert.equal(await outcome("2026-11-09T00:04:00Z"), "passed", "the first tick of the next UTC day runs it again");
  assert.equal((db.raw.prepare("SELECT started_at FROM forge_check_runs WHERE commit_sha = ?").get(h("1")) as any).started_at, "2026-11-09T00:04:00.000Z");
  assert.equal(await outcome("2026-11-09T00:19:00Z"), "up_to_date", "once a day");
  assert.equal(await outcome("2026-11-09T23:49:00Z"), "up_to_date");
  assert.equal(await outcome("2026-11-10T00:04:00Z", 1), "failed", "a clock-dependent failure shows on the day it happens");
  assert.equal(await outcome("2026-11-10T12:04:00Z"), "up_to_date");
  assert.equal(await outcome("2026-11-11T00:04:00Z"), "passed", "a failed head runs again the next day as well");
  assert.deepEqual(ran, [h("1"), h("1"), h("1"), h("1")]);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'forge.checks_completed'").get() as any).n, 4);
  // The claim: only a run of main takes over a run that finished before today; never a live one.
  assert.equal(await claim(db, h("1"), Date.parse("2026-11-11T12:00:00Z")), false, "finished today");
  assert.equal(await claim(db, h("1"), Date.parse("2026-11-12T00:04:00Z"), "change"), false, "a change request run never takes over a finished run");
  assert.equal((await forgeReady(db, h("1"))).reason, "forge_checks_not_ready", "before the daily run (these fake runs have no type-check)");
  assert.equal(await claim(db, h("1"), Date.parse("2026-11-12T00:04:00Z")), true);
  assert.deepEqual(await forgeReady(db, h("1")), { ready: false, reason: "forge_checks_pending", status: "running" }, "the documented window: pending while the daily run runs");
  assert.equal(await claim(db, h("1"), Date.parse("2026-11-12T00:10:00Z")), false, "the live daily run is not taken twice");
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

test("FC7b. a commit of main checked only as a change request head is checked again as main, once (cut-over, 2026-11-13)", async () => {
  const db = migratedDb();
  const t0 = Date.parse("2026-11-13T23:04:00Z");
  // The change request's head passed as a change; the Forge then fast-forwarded main to it.
  assert.equal(await claim(db, h("1"), t0, "change"), true);
  db.raw.prepare("UPDATE forge_check_runs SET status = 'passed', finished_at = ? WHERE commit_sha = ?").run(new Date(t0 + 120_000).toISOString(), h("1"));
  assert.equal(await claim(db, h("1"), t0 + 180_000, "change"), false, "another change run does not take it over");
  const { repo } = fakeRepo({ commits: [h("1")] });
  const env = { DB: db, ARTIFACTS: { get: async () => repo } };
  const ran: string[] = [];
  const later = t0 + 15 * 60_000;
  assert.deepEqual(await checksTick(env, REPO, passingDeps(ran), () => later), { outcome: "checked", commit: h("1"), status: "passed", pass: 1, fail: 0 });
  const row = db.raw.prepare("SELECT status, source, started_at FROM forge_check_runs WHERE commit_sha = ?").get(h("1")) as any;
  assert.deepEqual([row.status, row.source, row.started_at], ["passed", "main", new Date(later).toISOString()]);
  assert.deepEqual(await checksTick(env, REPO, passingDeps(ran), () => later + 15 * 60_000), { outcome: "up_to_date" }, "once");
  assert.deepEqual(ran, [h("1")]);
  // A live change run is never taken over by main.
  assert.equal(await claim(db, h("2"), later, "change"), true);
  assert.equal(await claim(db, h("2"), later + 60_000, "main"), false);
});

test("FC7c. main's head checked as a change request is checked as main; the older commit the merge brought is not (2026-11-14)", async () => {
  const db = migratedDb();
  const t0 = Date.parse("2026-11-14T04:49:00Z");
  // A merge brought two commits: h("2") (older, never checked) and the head h("3") (checked as a change request).
  assert.equal(await claim(db, h("3"), t0, "change"), true);
  db.raw.prepare("UPDATE forge_check_runs SET status = 'passed', finished_at = ? WHERE commit_sha = ?").run(new Date(t0).toISOString(), h("3"));
  const { repo } = fakeRepo({ commits: [h("3"), h("2")] });
  const env = { DB: db, ARTIFACTS: { get: async () => repo } };
  const ran: string[] = [];
  assert.equal((await checksTick(env, REPO, passingDeps(ran), () => t0 + 60_000) as { commit: string }).commit, h("3"), "the head, as main");
  assert.deepEqual(await checksTick(env, REPO, passingDeps(ran), () => t0 + 16 * 60_000), { outcome: "up_to_date" }, "the superseded commit is not checked");
  assert.deepEqual(ran, [h("3")]);
  assert.equal(db.raw.prepare("SELECT 1 FROM forge_check_runs WHERE commit_sha = ?").get(h("2")), undefined);
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
  const commits = [h("1")];
  const { repo } = fakeRepo({ commits });
  const env = { DB: db, ARTIFACTS: { get: async () => repo } };
  let now = Date.parse("2026-11-08T09:04:00Z");
  await checksTick(env, REPO, passingDeps([]), () => now);
  commits.unshift(h("2")); // main's next head
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

/**
 * A small stand-in for esbuild that drives the Forge's own snapshot plugin: it resolves and loads every
 * relative import from the snapshot (as esbuild does) and concatenates the modules it reached.
 */
function pluginBundler(): EsbuildLike {
  type Resolve = (a: { path: string; importer: string; kind: string }) => any;
  type Load = (a: { path: string; pluginData?: unknown }) => any;
  return {
    async build(o) {
      const resolvers: Array<[{ filter: RegExp; namespace?: string }, Resolve]> = [];
      const loaders: Array<[{ filter: RegExp; namespace?: string }, Load]> = [];
      for (const p of o.plugins as Array<{ setup(b: unknown): void }>) p.setup({ onResolve: (f: any, cb: Resolve) => resolvers.push([f, cb]), onLoad: (f: any, cb: Load) => loaders.push([f, cb]) });
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
      await visit((o.entryPoints as string[])[0], "", "entry-point");
      return { outputFiles: [{ text: out, contents: new Uint8Array() }], errors: [], warnings: [] };
    },
  };
}

test("FC20. a test Worker is addressed by its code: equal bundles keep the id across commits, a bundled source change makes a new one (2026-11-14)", async () => {
  const T = "workers/control-plane-shared/test/";
  const base: Record<string, string> = {
    // (The module-URL token is assembled, so that this file survives the same rewrite when the Forge bundles it.)
    [T + "a.test.ts"]: `import assert from "node:assert/strict";\nimport { f } from "../src/lib.ts";\nassert.equal(f(), 1);\nconst here = ${["import", "meta", "url"].join(".")};\n`,
    [T + "b.test.ts"]: 'import { g } from "../src/other.ts";\ng();\n',
    "workers/control-plane-shared/src/lib.ts": "export const f = () => 1;\n",
    "workers/control-plane-shared/src/other.ts": "export const g = () => 2;\n",
    "README.md": "first\n",
  };
  const run = async (snapshot: Record<string, string>, commit: string, limits = { cpuMs: 60_000 }) => {
    const seen: Array<{ code: TestWorkerCode; request: TestWorkerRequest }> = [];
    const deps: SuiteDeps = {
      esbuild: pluginBundler(), shims: {} as ShimSources, sqlJs: "sql.js glue", sqlWasm: "WASM", bundler: "BUNDLER-STUB", limits,
      async runWorker(code, request) {
        seen.push({ code, request });
        return { files: (code.modules["files.json"] as { json: string[] }).json.map((file) => ({ file, results: [{ name: "t", status: "pass" }] })) };
      },
    };
    const result = await runSuite(deps, snapshot, undefined, commit);
    assert.equal(result.pass, 2, "every test file runs on every run");
    return { seen, result };
  };
  const first = await run(base, h("1"));
  assert.equal(first.seen.length, 1);
  const { code, request } = first.seen[0];
  assert.match(request.id, new RegExp("^" + TEST_WORKER_ID_PREFIX + "[0-9a-f]{64}$"));
  assert.match(code.modules["test-a_test_ts.js"] as string, /export const f = \(\) => 1;/, "the code under test is bundled");
  assert.match(code.modules["test-a_test_ts.js"] as string, /"file:\/\/\/repo\/workers\/control-plane-shared\/test\/a\.test\.ts"/);
  assert.doesNotMatch(JSON.stringify(code.modules), /first|README/, "files the tests do not import stay out of the code");

  // A later commit: other files changed, the tests' imports did not. Same code, same id; the new data comes in the request.
  const later = { ...base, "README.md": "second\n", "workers/forge/src/x.ts": "export const y = 3;\n" };
  const second = await run(later, h("2"));
  assert.deepEqual(second.seen[0].code, code);
  assert.equal(second.seen[0].request.id, request.id);
  assert.deepEqual(JSON.parse(second.seen[0].request.body), { commit: h("2"), snapshot: later });
  assert.deepEqual(JSON.parse(request.body), { commit: h("1"), snapshot: base });
  assert.deepEqual(second.result.workers, { groups: 1, bundles: 1, loads: 1 });

  // A source a test imports changed: a new Worker. So does a new CPU limit.
  const changed = await run({ ...base, "workers/control-plane-shared/src/other.ts": "export const g = () => 3;\n" }, h("3"));
  assert.notEqual(changed.seen[0].request.id, request.id);
  assert.notEqual((await run(base, h("1"), { cpuMs: 30_000 })).seen[0].request.id, request.id);
  // The id covers every part of the code: the outbound, the compatibility date, a module.
  assert.notEqual(await testWorkerId({ ...code, compatibilityDate: "2026-01-01" }), request.id);
  assert.notEqual(await testWorkerId({ ...code, modules: { ...code.modules, "sql.js": "other glue" } }), request.id);
  assert.notEqual(await testWorkerId({ ...code, env: undefined }), request.id);
  assert.equal(await testWorkerId(structuredClone({ ...code, env: undefined })), await testWorkerId({ ...code, env: undefined }), "deterministic");
  // bundleTest is a function of the snapshot files a test reaches.
  assert.equal(await bundleTest(pluginBundler(), later, {} as ShimSources, T + "a.test.ts"), await bundleTest(pluginBundler(), base, {} as ShimSources, T + "a.test.ts"));
});

test("FC21. the test Worker reads the run from its request and is loaded by id with the Worker Loader's get (2026-11-14)", () => {
  assert.match(RUNNER_ENTRY, /const payload = await request\.json\(\);/);
  assert.match(RUNNER_ENTRY, /globalThis\.__VFS = payload\.snapshot;/);
  assert.match(RUNNER_ENTRY, /env\.BUNDLER\.bundleWorker\(dir, payload\.commit\)/);
  assert.doesNotMatch(RUNNER_ENTRY, /snapshot\.json|snapshotText/, "no snapshot module");
  assert.match(RUNNER_ENTRY, /queue = run\.catch/, "a warm Worker runs one request at a time");
  assert.match(RUNNER_ENTRY, /finally \{ globalThis\.__VFS = undefined; globalThis\.__SQL = undefined; globalThis\.__SQL_DATABASES = undefined;/, "and keeps nothing of a run");
  const runtime = read("workers/forge/src/runner/runtime.ts");
  assert.match(runtime, /loader\.get\(request\.id, async \(\) => code\)/);
  assert.doesNotMatch(runtime, /loader\.load\(/, "load() makes a new billed Worker on every call");
  assert.match(runtime, /limits: \{ cpuMs: TEST_WORKER_CPU_MS \}/);
  assert.match(runtime, /code\.globalOutbound !== null \|\| code\.limits\?\.cpuMs !== TEST_WORKER_CPU_MS/, "an unconfined test Worker is refused");
  assert.match(runtime, /method: "POST"[^\n]*body: request\.body/);
  const worker = read("workers/forge/src/worker.ts");
  assert.match(worker, /bundler\(\{ props: \{\} \}\)/, "the bundler binding carries no commit");
  assert.match(worker, /if \(!\/\^\[0-9a-f\]\{40\}\$\/\.test\(commit\)\) throw new Error\("invalid_commit"\);/);
});
