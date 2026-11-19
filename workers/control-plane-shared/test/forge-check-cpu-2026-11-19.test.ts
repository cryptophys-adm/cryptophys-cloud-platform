// Forge check CPU (owner 2026-11-19: "setuju semua", then "All 3 as proposed"; the coordinator's additions 4-6 the same
// day). A change request that touches only documentation runs no test; a tree that already passed in full is not run
// again; a change request runs only the test files its change can affect; a request's later heads wait for their turn
// in the merge queue; a commit is not run twice under the same runner; each run records its Dynamic Workers. The merge
// gate accepts a reduced run only under the exact rule, and main's own run, the deploy gate's, is always full.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CI_CLIENT_ID, migratedDb } from "./harness.ts";
import { changeVerdict, nextChangeHead, QUEUE_HOLD_MS, registerChange, verdictOf } from "../../forge/src/changes.ts";
import { checkOf, tickWith, type ArtifactsReader, type ArtifactsTreeEntry, type CheckDeps, type CheckSummary } from "../../forge/src/checks.ts";
import { affectedTests, depHit, readTestDeps, TEST_DEPS_PREFIX } from "../../forge/src/check-plan.ts";
import { runnerFingerprint, runSuite, type EsbuildLike, type ShimSources } from "../../forge/src/runner/core.ts";
import { coverageAccepted, coverageOfSteps, forgeReady, isDocsOnlyPath, isReady, needsFullSuite, type Coverage } from "../src/forge-gate.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const sha = (c: string) => c.repeat(40);
const T = "workers/control-plane-shared/test/";

/** An Artifacts repo of several commits; trees are content-addressed, so an equal tree has an equal hash. */
function repoOf(commits: Record<string, Record<string, string>>): ArtifactsReader {
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
  return Object.assign({
    async readCommit(h: string) { return roots[h] ? { hash: h, treeHash: roots[h] } : null; },
    async readTree(h: string) { return trees[h] ?? null; },
    async readBlob(h: string) { return h in blobs ? new Blob([blobs[h]]) : null; },
    async log() { return []; },
  }, { add, roots });
}

/** An R2 bucket with get (the test dependency records are read back). */
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

/** esbuild through the real snapshot plugin: follows `from "..."` imports, so the plugin traces what each bundle resolves. */
function pluginBundler(builds: string[]): EsbuildLike {
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
      await visit((o.entryPoints as string[])[0], "", "entry-point");
      return { outputFiles: [{ text: out, contents: new TextEncoder().encode(out) }], errors: [], warnings: [] };
    },
  };
}

interface Log { builds: string[]; ran: string[][] }
/** Suite deps: every test passes (or the files in `fail`), with the node:fs reads in `reads`; the type-check passed. */
function depsOf(log: Log, opts: { fingerprint?: string; fail?: string[]; reads?: Record<string, string[]> } = {}) {
  return async (): Promise<CheckDeps> => ({
    esbuild: pluginBundler(log.builds), shims: {} as ShimSources, sqlJs: "glue", sqlWasm: null,
    ...(opts.fingerprint ? { fingerprint: opts.fingerprint } : {}),
    async runWorker(code) {
      const files = (code.modules["files.json"] as { json: string[] }).json;
      log.ran.push(files);
      return { files: files.map((file) => ({ file, reads: opts.reads?.[file] ?? [], results: [{ name: "t", status: opts.fail?.includes(file) ? "fail" : "pass" }] })) };
    },
    typecheck: async () => ({ status: "passed", errors: 0, console_build: { status: "passed", errors: 0, diagnostics: [] } }),
  });
}

const MAIN = sha("1");
const BASE_FILES: Record<string, string> = {
  "README.md": "# platform\n",
  "docs/SSOT.md": "# SSOT\n",
  "architecture/adr/0020-x.md": "# ADR\n",
  "architecture/adr/progress/0020.json": "{}\n",
  "workers/demo/wrangler.toml": 'name = "cryptophys-demo"\nmain = "src/index.ts"\n',
  "workers/demo/src/index.ts": 'import { a } from "./a.ts";\nexport default { a };\n',
  "workers/demo/src/a.ts": "export const a = 1;\n",
  "workers/demo/src/b.ts": "export const b = 2;\n",
  "workers/demo/data/one.json": "{}\n",
  "workers/control-plane-shared/src/lib.ts": "export const lib = 1;\n",
  [T + "a.test.ts"]: 'import { a } from "../../demo/src/a.ts";\n',
  [T + "b.test.ts"]: 'import { b } from "../../demo/src/b.ts";\n',
  [T + "c.test.ts"]: "// reads workers/demo/data/ through node:fs\n",
};
const READS = { [T + "c.test.ts"]: ["workers/demo/data/"] };
const ALL_TESTS = [T + "a.test.ts", T + "b.test.ts", T + "c.test.ts"];

/** A database whose main head MAIN passed a full run (its test dependencies stored), and a change request helper. */
async function world(extra: Record<string, Record<string, string>> = {}) {
  const db = migratedDb();
  const repo = repoOf({ [MAIN]: BASE_FILES, ...extra }) as ArtifactsReader & { add(s: string, f: Record<string, string>): void; roots: Record<string, string> };
  const b = bucket();
  const env = { DB: db as never, ARTIFACTS: { get: async () => repo }, BUNDLES: b as never };
  let now = Date.parse("2026-11-19T09:04:00Z");
  const clock = () => now;
  const log: Log = { builds: [], ran: [] };
  const main = await tickWith(env, "platform", depsOf(log, { reads: READS }), clock, async () => MAIN, "main");
  assert.equal((main as { status: string }).status, "passed");
  assert.ok(b.objects.has(`${TEST_DEPS_PREFIX}${MAIN}.json`), "main's full run records each test file's dependencies");
  let n = 0;
  const open = async (head: string, files: Record<string, string>, opts: { forge?: boolean; base?: string } = {}) => {
    repo.add(head, files);
    n++;
    await registerChange(db as never, repo, { number: n, source_branch: `claude/x-${n}`, title: "t", author: "a", head_sha: head, base_sha: opts.base ?? MAIN }, CI_CLIENT_ID, now + n);
    if (opts.forge) db.raw.prepare("UPDATE forge_change_requests SET repo = 'platform-work', source = 'forge', github_ci = NULL WHERE head_sha = ?").run(head);
    return `gh-${n}`;
  };
  const checkChange = async (head: string, deps = depsOf(log, { reads: READS })) => {
    log.ran.length = 0; log.builds.length = 0;
    now += 60_000;
    return tickWith(env, "platform", deps, clock, async () => head, "change") as Promise<{ outcome: string; status?: string; coverage?: string }>;
  };
  const row = (head: string) => db.raw.prepare("SELECT status, guard_status, steps, source, files, pass FROM forge_check_runs WHERE commit_sha = ?").get(head) as { status: string; guard_status: string; steps: string; source: string; files: number; pass: number };
  const verdict = async (crId: string) => {
    const r = db.raw.prepare("SELECT * FROM forge_change_requests WHERE cr_id = ?").get(crId) as never as { head_sha: string; critical: string };
    return changeVerdict(r as never, await checkOf(db as never, r.head_sha), JSON.parse(r.critical ?? "[]"), now);
  };
  return { db, repo, b, env, log, clock, tick: (ms: number) => { now += ms; }, at: () => now, open, checkChange, row, verdict };
}

// ---------------------------------------------------------------------------------------------------------------
// The rule, as the gate reads it.

test("CPU1. docs only means docs/**/*.md (not docs/contracts/), architecture/adr/*.md and root *.md; nothing else", () => {
  for (const p of ["README.md", "AGENTS.md", "docs/SSOT.md", "docs/design/EVOLVER.md", "architecture/adr/0020-trading.md"]) assert.equal(isDocsOnlyPath(p), true, p);
  for (const p of [
    "architecture/adr/progress/0020.json", "architecture/adr/progress/notes.md", "docs/contracts/x.md", "docs/contracts/fixture.json", "docs/data.json",
    "organism/vision.json", "organism/notes.md", "workers/forge/README.md", "workers/control-plane-migrations/0086_x.sql", "docs/x.mdx", "docs/../workers/a.md", "docs/SSOT.md.ts",
  ]) assert.equal(isDocsOnlyPath(p), false, p);
  for (const p of ["workers/control-plane-shared/src/lib.ts", "workers/control-plane-shared/package.json", "package-lock.json", "workers/control-plane-tsconfig.json",
    "workers/console/ui/tsconfig.app.json", "workers/forge/src/runner/core.ts", "workers/forge/src/checks.ts", "workers/forge/src/check-plan.ts", "tools/forge-runner/run.mjs",
    "workers/control-plane-migrations/0086_x.sql", "workers/demo/wrangler.toml", ".github/workflows/ci.yml"]) assert.equal(needsFullSuite(p), true, p);
  for (const p of ["workers/demo/src/a.ts", "workers/control-plane-shared/test/a.test.ts", "docs/SSOT.md"]) assert.equal(needsFullSuite(p), false, p);
});

test("CPU2. the gate: each reduced coverage is accepted only under its rule, only for a change request, never for a deploy", () => {
  const change = { commit: sha("a"), source: "change", tree: sha("e") };
  const ok: Coverage[] = [
    { mode: "full" },
    { mode: "docs_only", base: MAIN, paths: ["docs/SSOT.md", "README.md"] },
    { mode: "partial", base: MAIN, files: 1, of: 3, changed: ["workers/demo/src/a.ts"] },
    { mode: "reused", from: sha("b"), tree: sha("e") },
  ];
  for (const c of ok) assert.equal(coverageAccepted(c, change, "merge"), true, c.mode);
  // Negative: a docs change with one .ts file, a progress manifest, a partial run that touched shared code, a reused
  // result of another tree, any reduced run of main, and every reduced run for a deploy.
  assert.equal(coverageAccepted({ mode: "docs_only", base: MAIN, paths: ["docs/SSOT.md", "workers/demo/src/a.ts"] }, change, "merge"), false, "docs plus one .ts file");
  assert.equal(coverageAccepted({ mode: "docs_only", base: MAIN, paths: ["architecture/adr/progress/0020.json"] }, change, "merge"), false, "a progress manifest");
  assert.equal(coverageAccepted({ mode: "partial", base: MAIN, files: 2, of: 3, changed: ["workers/control-plane-shared/src/lib.ts"] }, change, "merge"), false, "shared code needs the full suite");
  assert.equal(coverageAccepted({ mode: "reused", from: sha("b"), tree: sha("f") }, change, "merge"), false, "a reused result for a different tree is refused");
  assert.equal(coverageAccepted({ mode: "reused", from: sha("b"), tree: sha("e") }, { ...change, tree: null }, "merge"), false, "a run without its tree");
  assert.equal(coverageAccepted({ mode: "reused", from: sha("a"), tree: sha("e") }, change, "merge"), false, "a run cannot reuse itself");
  assert.equal(coverageAccepted({ mode: "invalid" }, change, "merge"), false);
  for (const c of ok.slice(1)) {
    assert.equal(coverageAccepted(c, { ...change, source: "main" }, "merge"), false, `a ${c.mode} run of main is never accepted`);
    assert.equal(coverageAccepted(c, change, "deploy"), false, `a ${c.mode} run never deploys`);
  }
  assert.equal(coverageAccepted({ mode: "full" }, { ...change, source: "main" }, "deploy"), true);
  // The marker as stored: absent is a run from before markers (full); anything malformed is invalid.
  assert.deepEqual(coverageOfSteps(null), { mode: "full" });
  assert.deepEqual(coverageOfSteps(JSON.stringify({ tests: {} })), { mode: "full" });
  for (const bad of [{ mode: "skipped" }, { mode: "docs_only", base: MAIN, paths: [] }, { mode: "partial", base: MAIN, files: 3, of: 3, changed: ["x"] }, { mode: "reused", from: "x", tree: sha("e") }, "full"]) {
    assert.deepEqual(coverageOfSteps(JSON.stringify({ coverage: bad })), { mode: "invalid" }, JSON.stringify(bad));
  }
  assert.deepEqual(coverageOfSteps("{not json"), { mode: "invalid" });
  assert.equal(isReady("passed", "clean", { status: "passed", console_build: "passed" }, false), false, "isReady requires the coverage verdict");
});

test("CPU3. the merge verdict refuses a check whose coverage does not cover the head", () => {
  const base: CheckSummary = {
    commit: sha("a"), status: "passed", runner: "r", files: 0, pass: 0, fail: 0, skip: 0, failures: [], started_at: "2026-11-19T07:00:00.000Z", finished_at: "2026-11-19T07:02:00.000Z", duration_ms: 1,
    bundles: { workers: 1, failed: 0 }, guard_status: "clean", typecheck: { status: "passed", errors: 0, build_id: "b", console_build: "passed" }, ready: true, github: null, agrees: null,
    source: "change", tree: sha("e"),
  };
  const now = Date.parse("2026-11-19T08:00:00Z");
  assert.deepEqual(verdictOf({ ...base, coverage: { mode: "docs_only", base: MAIN, paths: ["docs/SSOT.md"] } }, [], now), { verdict: "would_merge", reasons: [] });
  assert.deepEqual(verdictOf({ ...base, coverage: { mode: "reused", from: sha("b"), tree: sha("e") } }, [], now), { verdict: "would_merge", reasons: [] });
  assert.deepEqual(verdictOf({ ...base, coverage: { mode: "reused", from: sha("b"), tree: sha("f") } }, [], now), { verdict: "blocked", reasons: ["the check's coverage (reused) does not cover this head"] });
  assert.equal(verdictOf({ ...base, coverage: { mode: "docs_only", base: MAIN, paths: ["docs/SSOT.md", "workers/demo/src/a.ts"] } }, [], now).verdict, "blocked");
  assert.equal(verdictOf({ ...base, source: "main", coverage: { mode: "partial", base: MAIN, files: 1, of: 3, changed: ["workers/demo/src/a.ts"] } }, [], now).verdict, "blocked", "partial on main");
  assert.equal(verdictOf({ ...base, source: undefined, coverage: { mode: "docs_only", base: MAIN, paths: ["docs/SSOT.md"] } }, [], now).verdict, "blocked", "an unknown source is not a change request");
  assert.equal(verdictOf({ ...base, coverage: { mode: "invalid" } }, [], now).verdict, "blocked");
});

// ---------------------------------------------------------------------------------------------------------------
// 1. Documentation only.

test("CPU4. a docs-only change request runs no test and no bundle, scans only its documents, and may merge", async () => {
  const w = await world();
  const head = sha("a");
  const cr = await w.open(head, { ...BASE_FILES, "docs/SSOT.md": "# SSOT, revised\n", "README.md": "# platform!\n", "architecture/adr/0020-x.md": "# ADR, amended\n" });
  const out = await w.checkChange(head);
  assert.deepEqual([out.status, out.coverage], ["passed", "docs_only"]);
  assert.deepEqual(w.log.ran, [], "no test Worker");
  assert.deepEqual(w.log.builds, [], "no esbuild build: no test bundle, no Worker bundle");
  const r = w.row(head);
  const steps = JSON.parse(r.steps);
  assert.deepEqual(steps.coverage, { mode: "docs_only", base: MAIN, paths: ["README.md", "architecture/adr/0020-x.md", "docs/SSOT.md"] });
  assert.deepEqual(steps.tests, { files: 0, pass: 0, fail: 0, skip: 0 });
  assert.equal(steps.secrets.files, 3, "only the three changed documents are scanned");
  assert.deepEqual(steps.bundles, JSON.parse(w.row(MAIN).steps).bundles, "the base's Worker bundles");
  assert.equal(steps.typecheck.status, "passed", "the type-check is still the commit's own and still required");
  assert.deepEqual(await w.verdict(cr), { verdict: "would_merge", reasons: [] });
  // The deploy gate never takes it: pending until main's own full run.
  assert.deepEqual(await forgeReady(w.db as never, head), { ready: false, reason: "forge_checks_pending", status: "passed" });
});

test("CPU5. a secret in a document is still found; a docs change plus one .ts file, or a progress manifest, runs tests", async () => {
  const w = await world();
  const secret = "gh" + "p_" + "Q7w2".repeat(9);
  const leak = sha("a");
  await w.open(leak, { ...BASE_FILES, "docs/SSOT.md": `token ${secret}\n` });
  await w.checkChange(leak);
  const r = w.row(leak);
  assert.equal(r.guard_status, "findings");
  assert.ok(!r.steps.includes(secret));

  const mixed = sha("b");
  await w.open(mixed, { ...BASE_FILES, "docs/SSOT.md": "# new\n", "workers/control-plane-shared/src/lib.ts": "export const lib = 2;\n" });
  const m = await w.checkChange(mixed);
  assert.equal(m.coverage, undefined, "docs plus one .ts file under shared code: the full suite");
  assert.deepEqual(w.log.ran.flat().sort(), ALL_TESTS);
  assert.deepEqual(JSON.parse(w.row(mixed).steps).coverage, { mode: "full" });

  const manifest = sha("c");
  await w.open(manifest, { ...BASE_FILES, "architecture/adr/progress/0020.json": '{"gates":[]}\n' });
  await w.checkChange(manifest);
  assert.notEqual(JSON.parse(w.row(manifest).steps).coverage.mode, "docs_only", "a progress manifest is not documentation");

  // A docs-only change on a base that has no passed full run runs the full suite.
  const unchecked = sha("d");
  w.repo.add(unchecked, BASE_FILES);
  const onUnchecked = sha("e");
  await w.open(onUnchecked, { ...BASE_FILES, "docs/SSOT.md": "# x\n" }, { base: unchecked });
  const u = await w.checkChange(onUnchecked);
  assert.equal(u.coverage, undefined);
  assert.equal(w.log.ran.flat().length, 3);
});

// ---------------------------------------------------------------------------------------------------------------
// 2. A tree already checked.

test("CPU6. a rebase that leaves the tree byte-identical reuses the passed result; a different tree or runner runs again", async () => {
  const w = await world();
  const first = sha("a");
  const files = { ...BASE_FILES, "workers/control-plane-shared/src/lib.ts": "export const lib = 3;\n" };
  await w.open(first, files);
  await w.checkChange(first);
  assert.equal(w.log.ran.flat().length, 3, "the first head runs in full");
  const again = sha("b");
  const cr = await w.open(again, files);
  assert.equal((w.repo as never as { roots: Record<string, string> }).roots[again], (w.repo as never as { roots: Record<string, string> }).roots[first], "the same tree");
  const out = await w.checkChange(again);
  assert.deepEqual([out.status, out.coverage], ["passed", "reused"]);
  assert.deepEqual(w.log.ran, []);
  assert.deepEqual(w.log.builds, []);
  const steps = JSON.parse(w.row(again).steps);
  assert.deepEqual(steps.coverage, { mode: "reused", from: first, tree: steps.tree });
  assert.deepEqual(steps.tests, JSON.parse(w.row(first).steps).tests);
  assert.deepEqual(await w.verdict(cr), { verdict: "would_merge", reasons: [] });
  // Another runner fingerprint: the same tree runs again.
  const third = sha("c");
  await w.open(third, files);
  await w.checkChange(third, depsOf(w.log, { reads: READS, fingerprint: "rf1-another-runner" }));
  assert.equal(w.log.ran.flat().length, 3);
  assert.equal(JSON.parse(w.row(third).steps).coverage.mode, "full");
  // A reused marker naming another tree is refused by the gate, whatever the status says.
  w.db.raw.prepare("UPDATE forge_check_runs SET steps = json_set(steps, '$.coverage.tree', ?) WHERE commit_sha = ?").run(sha("9"), again);
  assert.equal((await checkOf(w.db as never, again))!.ready, false);
  assert.equal((await w.verdict(cr)).verdict, "blocked");
  // A failed tree is never reused.
  const failing = { ...BASE_FILES, "workers/control-plane-shared/src/lib.ts": "export const lib = 4;\n" };
  await w.open(sha("d"), failing);
  await w.checkChange(sha("d"), depsOf(w.log, { reads: READS, fail: [T + "a.test.ts"] }));
  await w.open(sha("f"), failing);
  await w.checkChange(sha("f"));
  assert.equal(w.log.ran.flat().length, 3, "a tree that failed is run again");
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Only the affected tests.

test("CPU7. a change request runs only the test files its change can affect: imports, node:fs reads, new test files", async () => {
  const w = await world();
  const deps = JSON.parse(w.b.objects.get(`${TEST_DEPS_PREFIX}${MAIN}.json`)!.value);
  assert.ok(deps.deps[T + "a.test.ts"].includes("workers/demo/src/a.ts"), "the bundle's resolved imports");
  assert.ok(deps.deps[T + "c.test.ts"].includes("workers/demo/data/"), "the node:fs listing");
  const one = sha("a");
  const cr = await w.open(one, { ...BASE_FILES, "workers/demo/src/a.ts": "export const a = 10;\n" });
  const out = await w.checkChange(one);
  assert.deepEqual([out.status, out.coverage], ["passed", "partial"]);
  assert.deepEqual(w.log.ran, [[T + "a.test.ts"]], "only the test that imports the changed file");
  assert.deepEqual(JSON.parse(w.row(one).steps).coverage, { mode: "partial", base: MAIN, files: 1, of: 3, changed: ["workers/demo/src/a.ts"] });
  assert.ok(w.log.builds.includes("workers/demo/src/index.ts"), "the Worker bundles still run in full");
  assert.deepEqual(await w.verdict(cr), { verdict: "would_merge", reasons: [] });
  assert.equal((await forgeReady(w.db as never, one)).ready, false, "a partial run never deploys");

  const data = sha("b");
  await w.open(data, { ...BASE_FILES, "workers/demo/data/two.json": "[]\n" });
  await w.checkChange(data);
  assert.deepEqual(w.log.ran, [[T + "c.test.ts"]], "a file added in a directory a test lists");

  const added = sha("c");
  await w.open(added, { ...BASE_FILES, [T + "d.test.ts"]: "// new\n" });
  await w.checkChange(added);
  assert.deepEqual(w.log.ran, [[T + "d.test.ts"]], "a test file the base did not have");

  const none = sha("d");
  await w.open(none, { ...BASE_FILES, "workers/other/src/x.ts": "export {};\n" });
  const n = await w.checkChange(none);
  assert.deepEqual([n.status, n.coverage, w.log.ran], ["passed", "partial", []], "no test can be affected: none runs");

  // In doubt, the full suite: a runner, wrangler, migration or package change, or no dependency record of the base.
  for (const [i, path] of ["workers/forge/src/runner/core.ts", "workers/demo/wrangler.toml", "workers/control-plane-migrations/0086_x.sql", "workers/demo/package.json"].entries()) {
    const head = (i + 5).toString(16).repeat(40);
    await w.open(head, { ...BASE_FILES, [path]: BASE_FILES[path] ? BASE_FILES[path] + "\n" : "x\n" });
    const r = await w.checkChange(head);
    assert.equal(r.coverage, undefined, path);
    assert.equal(w.log.ran.flat().length, 3, path);
  }
  w.b.objects.delete(`${TEST_DEPS_PREFIX}${MAIN}.json`);
  const nodeps = sha("e");
  await w.open(nodeps, { ...BASE_FILES, "workers/demo/src/b.ts": "export const b = 20;\n" });
  await w.checkChange(nodeps);
  assert.equal(w.log.ran.flat().length, 3, "no dependency record: full");
});

test("CPU8. the selection: a dependency is a path, a listed directory or everything; a file with no record always runs", () => {
  assert.equal(depHit("a/b.ts", "a/b.ts"), true);
  assert.equal(depHit("a/", "a/b/c.ts"), true);
  assert.equal(depHit("a/", "ab/c.ts"), false);
  assert.equal(depHit("*", "anything"), true);
  assert.equal(depHit("a/b.ts", "a/b.tsx"), false);
  const deps = { "t/a.test.ts": ["t/a.test.ts", "src/a.ts"], "t/b.test.ts": ["*"] };
  assert.deepEqual(affectedTests(["t/a.test.ts", "t/b.test.ts", "t/c.test.ts"], deps, ["src/z.ts"]), ["t/b.test.ts", "t/c.test.ts"]);
  assert.deepEqual(affectedTests(["t/a.test.ts"], deps, ["t/a.test.ts"]), ["t/a.test.ts"]);
});

test("CPU9. the runner records what each file reads: resolved imports (every candidate tried), node:fs reads, everything when unreported", async () => {
  const snapshot = { [T + "a.test.ts"]: 'import { x } from "../src/x";\n', "workers/control-plane-shared/src/x.ts": "export const x = 1;\n", [T + "b.test.ts"]: "" };
  const r = await runSuite({
    esbuild: pluginBundler([]), shims: {} as ShimSources, sqlJs: "", sqlWasm: null,
    async runWorker(code) {
      const files = (code.modules["files.json"] as { json: string[] }).json;
      return { files: files.map((file) => ({ file, ...(file.endsWith("a.test.ts") ? { reads: ["docs/SSOT.md", "workers/demo/"] } : {}), results: [{ name: "t", status: "pass" }] })) };
    },
  }, snapshot);
  assert.deepEqual(r.deps![T + "a.test.ts"], [T + "a.test.ts", "docs/SSOT.md", "workers/control-plane-shared/src/x", "workers/control-plane-shared/src/x.ts", "workers/demo/"].sort(),
    "a file added at an earlier candidate (src/x) would change the bundle, so it is a dependency too");
  assert.deepEqual(r.deps![T + "b.test.ts"], ["*", T + "b.test.ts"].sort(), "a Worker that reported no reads may depend on anything");
  assert.equal(typeof r.worker_wall_ms, "number");
  // The node:fs shim records reads, listings and existence checks of the snapshot.
  const shim = await import("data:text/javascript," + encodeURIComponent(read("workers/forge/src/runner/shims/node-fs.js")));
  const g = globalThis as Record<string, unknown>;
  g.__VFS = { "docs/a.md": "a", "workers/x/y.ts": "y" };
  g.__FS_READS = new Set<string>();
  try {
    assert.equal(shim.readFileSync("/repo/docs/a.md", "utf8"), "a");
    assert.deepEqual(shim.readdirSync("/repo/workers/x"), ["y.ts"]);
    assert.equal(shim.existsSync("/repo/docs/missing.md"), false);
    assert.throws(() => shim.readFileSync("/repo/docs/gone.md"), /ENOENT/);
    assert.throws(() => shim.readdirSync(""), /ENOENT/, "a listing of the root (recorded as everything)");
    assert.deepEqual([...(g.__FS_READS as Set<string>)].sort(), ["*", "docs/a.md", "docs/gone.md", "docs/missing.md", "docs/missing.md/", "workers/x/"]);
  } finally { g.__VFS = undefined; g.__FS_READS = undefined; }
  const core = read("workers/forge/src/runner/core.ts");
  assert.match(core, /const reads = globalThis\.__FS_READS = new Set\(\);/);
  assert.match(core, /globalThis\.__FS_READS\.add\("\*"\); return env\.BUNDLER\.bundleWorker\(dir, payload\.commit\)/, "a test that bundles a Worker through the Forge depends on everything");
});

test("CPU10. main's own run is always full: a partial or docs-only change run of the merged head is replaced by a full run", async () => {
  const w = await world();
  const head = sha("a");
  await w.open(head, { ...BASE_FILES, "workers/demo/src/a.ts": "export const a = 11;\n" });
  await w.checkChange(head);
  assert.equal(JSON.parse(w.row(head).steps).coverage.mode, "partial");
  // The Forge fast-forwards main to the head; the next tick checks it as main, with every test file.
  w.log.ran.length = 0;
  w.tick(15 * 60_000);
  const out = await tickWith(w.env, "platform", depsOf(w.log, { reads: READS }), w.clock, async () => head, "main");
  assert.equal(out.outcome, "checked");
  assert.deepEqual(w.log.ran.flat().sort(), ALL_TESTS, "a partial change run gives main nothing to reuse");
  const r = w.row(head);
  assert.deepEqual([r.source, JSON.parse(r.steps).coverage], ["main", { mode: "full" }]);
  assert.equal((await forgeReady(w.db as never, head)).ready, true);
  // A partial marker on a row of main is never accepted, whatever wrote it.
  w.db.raw.prepare("UPDATE forge_check_runs SET steps = json_set(steps, '$.coverage', json(?)) WHERE commit_sha = ?").run(JSON.stringify({ mode: "partial", base: MAIN, files: 1, of: 3, changed: ["workers/demo/src/a.ts"] }), head);
  assert.equal((await forgeReady(w.db as never, head)).ready, false);
  assert.equal((await checkOf(w.db as never, head))!.ready, false);
});

// ---------------------------------------------------------------------------------------------------------------
// 4. The merge queue.

test("CPU11. a later head waits for its turn in the merge queue; the registration run and the head-of-queue run do run", async () => {
  const w = await world();
  const A1 = sha("a"); const R1 = sha("b"); const R2 = sha("c");
  const pick = () => nextChangeHead(w.db as never, w.repo, w.at(), "platform-work");
  const run = async () => tickWith(w.env, "platform-work", depsOf(w.log, { reads: READS }), w.clock, () => pick(), "change");
  const a = await w.open(A1, { ...BASE_FILES, "workers/demo/src/a.ts": "export const a = 2;\n" }, { forge: true });
  const r = await w.open(R1, { ...BASE_FILES, "workers/demo/src/b.ts": "export const b = 3;\n" }, { forge: true });
  assert.equal(await pick(), A1);
  await run();
  assert.equal(await pick(), R1, "R's registration run, although A is ahead and passed");
  await run();
  assert.equal(JSON.parse(w.row(R1).steps).cr_id, r);
  assert.equal(await pick(), null);
  // R is rebased while A, ahead of it, may merge any minute: no run of the intermediate head.
  w.repo.add(R2, { ...BASE_FILES, "workers/demo/src/b.ts": "export const b = 4;\n" });
  w.tick(60_000);
  w.db.raw.prepare("UPDATE forge_change_requests SET head_sha = ?, updated_at = ? WHERE cr_id = ?").run(R2, new Date(w.at()).toISOString(), r);
  assert.equal(await pick(), null, "an intermediate rebase does not run");
  assert.equal((await w.verdict(r)).verdict, "pending", "and no result covers it, so it cannot merge");
  // A merges: R is at the head of the queue, and its head runs.
  w.db.raw.prepare("UPDATE forge_change_requests SET status = 'merged' WHERE cr_id = ?").run(a);
  assert.equal(await pick(), R2, "the head-of-queue run");
  // The hold lapses after QUEUE_HOLD_MS, and a blocked request ahead holds nothing.
  w.db.raw.prepare("UPDATE forge_change_requests SET status = 'open' WHERE cr_id = ?").run(a);
  assert.equal(await pick(), null);
  w.tick(QUEUE_HOLD_MS);
  assert.equal(await pick(), R2, "a request that has not merged within the hold no longer holds the queue");
  w.tick(-QUEUE_HOLD_MS);
  w.db.raw.prepare("UPDATE forge_check_runs SET status = 'failed', fail = 1 WHERE commit_sha = ?").run(A1);
  assert.equal(await pick(), R2, "a blocked request ahead does not hold the queue");
  assert.match(read("workers/ai-kernel/src/supervisor.ts"), /WHERE status = 'open' AND source = 'forge' AND blocked_reason IS NULL AND history_blocked_reason IS NULL ORDER BY updated_at ASC/, "the Supervisor's merge order, which the queue mirrors");
});

// ---------------------------------------------------------------------------------------------------------------
// 5. The same commit, the same runner.

test("CPU12. main's run of a merged head takes the same commit's full test results under the same runner; a new runner runs again", async () => {
  const w = await world();
  const head = sha("a");
  await w.open(head, { ...BASE_FILES, "workers/control-plane-shared/src/lib.ts": "export const lib = 9;\n" });
  await w.checkChange(head);
  assert.equal(w.log.ran.flat().length, 3);
  w.log.ran.length = 0; w.log.builds.length = 0;
  w.tick(15 * 60_000);
  const out = await tickWith(w.env, "platform", depsOf(w.log, { reads: READS }), w.clock, async () => head, "main");
  assert.equal((out as { status: string }).status, "passed");
  assert.deepEqual(w.log.ran, [], "the same commit and runner: the tests are not run twice");
  assert.ok(w.log.builds.includes("workers/demo/src/index.ts"), "the Worker bundles are built for the deploy");
  assert.ok(w.b.objects.has(`bundles/${head}/manifest.json`), "and stored");
  const steps = JSON.parse(w.row(head).steps);
  assert.deepEqual([steps.coverage, steps.tests_reused.commit, steps.tests.files], [{ mode: "full" }, head, 3]);
  assert.equal((await forgeReady(w.db as never, head)).ready, true);
  // A changed runner fingerprint: the same commit runs again.
  const other = sha("b");
  await w.open(other, { ...BASE_FILES, "workers/control-plane-shared/src/lib.ts": "export const lib = 8;\n" });
  await w.checkChange(other);
  w.log.ran.length = 0;
  w.tick(15 * 60_000);
  await tickWith(w.env, "platform", depsOf(w.log, { reads: READS, fingerprint: "rf1-new-esbuild" }), w.clock, async () => other, "main");
  assert.deepEqual(w.log.ran.flat().sort(), ALL_TESTS, "a new runner runs the commit again");
  // The daily run of main always runs the suite (clock-dependent tests, owner 2026-11-14).
  w.log.ran.length = 0;
  w.tick(24 * 3_600_000);
  await tickWith(w.env, "platform", depsOf(w.log, { reads: READS }), w.clock, async () => head, "main");
  assert.deepEqual(w.log.ran.flat().sort(), ALL_TESTS);
  // The fingerprint is a function of the runner: equal toolchains, equal prints; any part changed, a new one.
  const tc = { esbuild: { version: "0.28.2", build: async () => ({ errors: [], warnings: [] }) }, shims: { test: "t" } as never, sqlJs: "glue", limits: { cpuMs: 60_000 } };
  assert.equal(await runnerFingerprint(tc), await runnerFingerprint({ ...tc }));
  for (const changed of [{ ...tc, esbuild: { ...tc.esbuild, version: "0.29.0" } }, { ...tc, sqlJs: "glue2" }, { ...tc, limits: { cpuMs: 30_000 } }, { ...tc, shims: { test: "t2" } as never }]) {
    assert.notEqual(await runnerFingerprint(changed), await runnerFingerprint(tc));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 6. What a run cost.

test("CPU13. each run records its Dynamic Workers (groups, distinct ids, loads) and their wall time, shown in the check summary", async () => {
  const w = await world();
  const steps = JSON.parse(w.row(MAIN).steps);
  assert.deepEqual(steps.workers, { groups: 1, bundles: 1, loads: 1 });
  assert.equal(typeof steps.worker_wall_ms, "number", "the Worker Loader exposes no CPU time: the summed request wall time");
  assert.match(steps.fingerprint, /^rf1-[0-9a-f]{32}$/);
  assert.equal(steps.tree, (w.repo as never as { roots: Record<string, string> }).roots[MAIN]);
  const summary = (await checkOf(w.db as never, MAIN))!;
  assert.deepEqual(summary.workers, { groups: 1, ids: 1, loads: 1, wall_ms: steps.worker_wall_ms });
  assert.deepEqual([summary.coverage, summary.coverage_accepted, summary.source], [{ mode: "full" }, true, "main"]);
  const record = await readTestDeps(w.b, MAIN);
  assert.deepEqual([record?.commit, record?.fingerprint], [MAIN, steps.fingerprint]);
});

test("CPU14. docs/SSOT.md describes the rule; none of the files it lives in is a guard path", async () => {
  const { criticalPathReason } = await import("../src/guard-paths.ts");
  for (const p of ["workers/control-plane-shared/src/forge-gate.ts", "workers/forge/src/check-plan.ts", "workers/forge/src/checks.ts", "workers/forge/src/changes.ts",
    "workers/forge/src/bundles.ts", "workers/forge/src/runner/core.ts", "workers/forge/src/runner/shims/node-fs.js"]) assert.equal(criticalPathReason(p), null, p);
  const line = read("docs/SSOT.md").split("\n").find((l) => l.startsWith("Last reviewed: "))!;
  assert.match(line, /^Last reviewed: 2026-11-16 \(Forge check CPU, 2026-11-19 \(owner: "setuju semua", "All 3 as proposed"/);
  assert.match(line, /docs_only[\s\S]*reused[\s\S]*partial[\s\S]*a run of main is always full[\s\S]*CPU1–CPU14/);
  assert.match(read("docs/SSOT.md"), /\| Forge checks \| Each new `main` commit \(and once a UTC day\): the full suite[^\n]*steps\.coverage/);
});
