// ADR-0012 phase 4, shadow: change requests. Every same-repository pull request is mirrored to the
// Forge as gh-<number> (head on cr/<number>), checked like a commit of main, and given the merge
// verdict the Forge would give under ADR §2.4. GitHub's outcome is frozen next to that verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_JWT, CI_CLIENT_ID, CI_JWT, OPERATOR_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import forge, { FORGE_MIGRATIONS } from "../../forge/src/index.ts";
import { changedPaths, criticalReasons, listChanges, mergeAgreement, mergeParity, nextChangeHead, recordOutcome, registerChange, verdictOf, type Change } from "../../forge/src/changes.ts";
import { listChecks, tickWith, type ArtifactsReader, type ArtifactsTreeEntry, type CheckDeps, type CheckSummary } from "../../forge/src/checks.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const HEAD2 = "c".repeat(40);

/** An Artifacts repo holding several commits, each a full file map; trees are content-addressed so equal subtrees share a hash. */
function repoOf(commits: Record<string, Record<string, string>>): ArtifactsReader & { blobsRead: number } {
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
  for (const [sha, files] of Object.entries(commits)) roots[sha] = build(files);
  const repo = {
    blobsRead: 0,
    async readCommit(h: string) { return roots[h] ? { hash: h, treeHash: roots[h] } : null; },
    async readTree(h: string) { return trees[h] ?? null; },
    async readBlob(h: string) { repo.blobsRead++; return h in blobs ? new Blob([blobs[h]]) : null; },
    async log() { return []; },
  };
  return repo;
}

const BASE_FILES = {
  "README.md": "x",
  "workers/forge/src/a.ts": "export const a = 1;",
  "workers/control-plane-shared/test/x.test.ts": "assert.equal(1, 1);\nassert.ok(true);\n",
  "workers/control-plane-shared/test/gone.test.ts": "assert.ok(1);",
  "workers/control-plane-migrations/0001_initial.sql": "CREATE TABLE t (x TEXT);",
  "docs/old": "file that becomes a directory",
};
const sorted = (cs: Change[]) => cs.map((c) => `${c.change[0].toUpperCase()} ${c.path}`).sort();

test("CR1. changed paths: a tree diff that skips equal subtrees; file<->directory; truncation", async () => {
  const head = Object.fromEntries(Object.entries({ ...BASE_FILES, "workers/forge/src/a.ts": "export const a = 2;", "workers/forge/src/b.ts": "new", "docs/old/inner.md": "now a dir" }).filter(([p]) => p !== "README.md" && p !== "docs/old"));
  const r = repoOf({ [BASE]: BASE_FILES, [HEAD]: head });
  const { changes, truncated } = await changedPaths(r, BASE, HEAD);
  assert.equal(truncated, false);
  assert.deepEqual(sorted(changes), ["A docs/old/inner.md", "A workers/forge/src/b.ts", "D README.md", "D docs/old", "M workers/forge/src/a.ts"]);
  assert.deepEqual((await changedPaths(r, BASE, BASE)).changes, [], "same tree: nothing");
  const cut = await changedPaths(r, BASE, HEAD, 2);
  assert.deepEqual([cut.changes.length, cut.truncated], [2, true]);
  await assert.rejects(changedPaths(r, BASE, HEAD2), /commit_not_mirrored/);
});

async function reasonsFor(head: Record<string, string>): Promise<string[]> {
  const r = repoOf({ [BASE]: BASE_FILES, [HEAD]: head });
  const { changes, truncated } = await changedPaths(r, BASE, HEAD);
  return criticalReasons(r, changes, truncated);
}

test("CR2. owner-only paths (ADR §2.4): auth/Access, policy, consensus/kill switch, secrets, data-rewriting migrations, ADR-0009/0012, weakened tests", async () => {
  assert.deepEqual(await reasonsFor({ ...BASE_FILES, "workers/forge/src/a.ts": "export const a = 3;", "workers/forge/src/c.ts": "x" }), [], "a routine change");
  assert.deepEqual(await reasonsFor({ ...BASE_FILES, "workers/control-plane-shared/src/access.ts": "x" }), ["auth_access: workers/control-plane-shared/src/access.ts"]);
  assert.deepEqual(await reasonsFor({ ...BASE_FILES, ".github/scripts/access-headers.sh": "x" }), ["auth_access: .github/scripts/access-headers.sh"]);
  assert.deepEqual(await reasonsFor({ ...BASE_FILES, "workers/policy-engine/src/index.ts": "x" }), ["policy_engine: workers/policy-engine/src/index.ts"]);
  assert.deepEqual(await reasonsFor({ ...BASE_FILES, "workers/control-plane-shared/src/consensus-exec.ts": "x" }), ["consensus_kill_switch: workers/control-plane-shared/src/consensus-exec.ts"]);
  assert.deepEqual(await reasonsFor({ ...BASE_FILES, "architecture/adr/0012-github-independence.md": "x" }), ["adr_0009_0012: architecture/adr/0012-github-independence.md"]);
  assert.deepEqual(await reasonsFor({ ...BASE_FILES, "architecture/adr/0005-cloudflare-transformation.md": "x" }), [], "other ADRs are routine");
  // Migrations: a new additive one is routine (comments do not count); a destructive or rewritten one is not.
  assert.deepEqual(await reasonsFor({ ...BASE_FILES, "workers/control-plane-migrations/0099_add.sql": "-- we never DELETE FROM anything here\nALTER TABLE t ADD COLUMN y TEXT;" }), []);
  for (const sql of ["DROP TABLE t;", "DELETE FROM t WHERE 1;", "UPDATE t SET x = 'a';", "ALTER TABLE t RENAME TO u;", "ALTER TABLE t DROP COLUMN x;", "/* x */ drop table t;"]) {
    assert.deepEqual(await reasonsFor({ ...BASE_FILES, "workers/control-plane-migrations/0099_x.sql": sql }), ["migration_drops_or_rewrites_data: workers/control-plane-migrations/0099_x.sql"], sql);
  }
  assert.deepEqual(await reasonsFor({ ...BASE_FILES, "workers/control-plane-migrations/0001_initial.sql": "CREATE TABLE t (x TEXT, y TEXT);" }), ["migration_rewritten: workers/control-plane-migrations/0001_initial.sql"]);
  // Secrets handling in workflows and scripts.
  assert.deepEqual(await reasonsFor({ ...BASE_FILES, ".github/workflows/x.yml": "run: npx wrangler secret put TOKEN" }), ["secrets: .github/workflows/x.yml"]);
  assert.deepEqual(await reasonsFor({ ...BASE_FILES, ".github/workflows/x.yml": "run: npx wrangler deploy" }), []);
  // Tests: fewer assertions, or a removed test file.
  assert.deepEqual(await reasonsFor({ ...BASE_FILES, "workers/control-plane-shared/test/x.test.ts": "assert.equal(1, 1);\n" }), ["test_assertions_removed: workers/control-plane-shared/test/x.test.ts (2 -> 1)"]);
  assert.deepEqual(await reasonsFor({ ...BASE_FILES, "workers/control-plane-shared/test/x.test.ts": "assert.equal(1, 1);\nassert.ok(true);\nassert.deepEqual([], []);\n" }), [], "more assertions are fine");
  const { ["workers/control-plane-shared/test/gone.test.ts"]: _gone, ...withoutTest } = BASE_FILES;
  assert.deepEqual(await reasonsFor(withoutTest), ["test_removed: workers/control-plane-shared/test/gone.test.ts"]);
  assert.deepEqual(await criticalReasons(repoOf({}), [], true), ["too_many_changes: more than 2000 paths"]);
});

const check = (over: Partial<CheckSummary> = {}): CheckSummary => ({
  commit: HEAD, status: "passed", runner: "r", files: 1, pass: 10, fail: 0, skip: 0, failures: [], started_at: "2026-11-09T07:00:00.000Z", finished_at: "2026-11-09T07:02:00.000Z", duration_ms: 1,
  bundles: { workers: 12, failed: 0 }, guard_status: "clean", typecheck: { status: "passed", errors: 0, build_id: "b", console_build: "passed" }, ready: true, github: null, agrees: null, ...over,
});

test("CR3. the verdict: pending until every part reported; blocked on any failure; owner paths need the owner; else would merge", () => {
  const now = Date.parse("2026-11-09T07:05:00.000Z");
  assert.equal(verdictOf(null, [], now).verdict, "pending");
  assert.equal(verdictOf(check({ status: "running", started_at: "2026-11-09T07:00:00.000Z" }), [], now).verdict, "pending");
  assert.equal(verdictOf(check({ status: "running", started_at: "2026-11-09T06:00:00.000Z" }), [], now).verdict, "blocked", "a lost run");
  assert.deepEqual(verdictOf(check({ typecheck: { status: "pending", errors: null, build_id: null, console_build: null } }), [], now), { verdict: "pending", reasons: ["the type-check of this head has not reported"] });
  assert.deepEqual(verdictOf(check({ typecheck: { status: "passed", errors: 0, build_id: "b", console_build: null } }), [], now), { verdict: "pending", reasons: ["the Console build of this head has not reported"] });
  assert.equal(verdictOf(check(), null, now).verdict, "pending", "paths not computed");
  assert.deepEqual(verdictOf(check({ status: "failed", fail: 2 }), [], now), { verdict: "blocked", reasons: ["2 tests failed"] });
  assert.deepEqual(verdictOf(check({ guard_status: "findings" }), [], now).reasons, ["secret scan found a secret"]);
  assert.deepEqual(verdictOf(check({ status: "failed", typecheck: { status: "failed", errors: 3, build_id: "b", console_build: "passed" } }), [], now).reasons, ["the type-check failed"]);
  assert.deepEqual(verdictOf(check({ status: "failed", typecheck: { status: "failed", errors: 0, build_id: "b", console_build: "failed" } }), [], now).reasons, ["the Console build failed"]);
  assert.deepEqual(verdictOf(check({ status: "error" }), [], now).reasons, ["the check run did not complete"]);
  assert.deepEqual(verdictOf(check(), ["auth_access: x"], now), { verdict: "needs_owner", reasons: ["auth_access: x"] });
  assert.deepEqual(verdictOf(check(), [], now), { verdict: "would_merge", reasons: [] });
  assert.equal(mergeAgreement("would_merge"), true);
  assert.equal(mergeAgreement("needs_owner"), true, "the owner merging an owner-path change agrees");
  assert.equal(mergeAgreement("blocked"), false);
  assert.equal(mergeAgreement("pending"), null, "the Forge had not decided: not compared");
});

function forgeEnv(db: ReturnType<typeof migratedDb>, repo: ArtifactsReader) {
  return { ...baseEnv("cryptophys-forge", db), ARTIFACTS: { list: async () => ({ repos: [{ name: "platform", status: "ready" }] }), get: async () => repo } };
}
const REG = { confirm: "REGISTER", number: 247, source_branch: "claude/gracious-brown-tkc4e8", title: "forge: change requests", author: "cryptophys-adm", head_sha: HEAD, base_sha: BASE, github_ci: "success" };
function recordCheck(db: ReturnType<typeof migratedDb>, sha: string, status = "passed", consoleBuild = "passed") {
  const steps = { tests: { files: 1, pass: 10, fail: 0, skip: 0 }, bundles: { workers: 12, failed: [], bundles: [] }, secrets: { files: 1, findings: [] },
    typecheck: { status: consoleBuild === "failed" ? "failed" : "passed", errors: 0, diagnostics: [], build_id: "b", console_build: { status: consoleBuild, errors: consoleBuild === "failed" ? 1 : 0, diagnostics: [] } } };
  db.raw.prepare("INSERT OR REPLACE INTO forge_check_runs (commit_sha, status, runner, files, pass, fail, skip, failures, started_at, finished_at, duration_ms, steps, guard_status) VALUES (?, ?, 'r', 1, 10, 0, 0, '[]', ?, ?, 1, ?, 'clean')")
    .run(sha, status, new Date().toISOString(), new Date().toISOString(), JSON.stringify(steps));
}

test("CR4. POST /v1/forge/changes: CI service token with REGISTER; paths and owner reasons computed; a new head recomputes them", async () => {
  const db = migratedDb();
  const repo = repoOf({ [BASE]: BASE_FILES, [HEAD]: { ...BASE_FILES, "workers/forge/src/b.ts": "x" }, [HEAD2]: { ...BASE_FILES, "workers/control-plane-shared/src/access.ts": "x" } });
  const env = forgeEnv(db, repo);
  assert.equal((await call(forge, env, req("POST", "/v1/forge/changes", REG, OPERATOR_JWT))).body.error, "service_token_required");
  assert.equal((await call(forge, env, req("POST", "/v1/forge/changes", REG, APPROVER_JWT))).status, 403);
  assert.equal((await call(forge, env, req("POST", "/v1/forge/changes", { ...REG, confirm: "yes" }, CI_JWT))).body.error, "confirmation_required");
  for (const [field, value, code] of [["number", 0, "invalid_number"], ["source_branch", "a b", "invalid_source_branch"], ["title", "", "invalid_title"], ["author", "x y", "invalid_author"],
    ["head_sha", "x", "invalid_head_sha"], ["base_sha", "x", "invalid_base_sha"], ["github_ci", "cancelled", "invalid_github_ci"]] as const) {
    const r = await call(forge, env, req("POST", "/v1/forge/changes", { ...REG, [field]: value }, CI_JWT));
    assert.deepEqual([r.status, r.body.error], [400, code], field);
  }
  assert.equal((await call(forge, env, req("POST", "/v1/forge/changes", { ...REG, head_sha: "d".repeat(40) }, CI_JWT))).body.error, "commit_not_mirrored");
  const ok = await call(forge, env, req("POST", "/v1/forge/changes", REG, CI_JWT));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.change.cr_id, ok.body.change.branch, ok.body.change.status, JSON.parse(ok.body.change.changed_paths), JSON.parse(ok.body.change.critical)],
    ["gh-247", "cr/247", "open", ["A workers/forge/src/b.ts"], []]);
  const moved = await call(forge, env, req("POST", "/v1/forge/changes", { ...REG, head_sha: HEAD2 }, CI_JWT));
  assert.deepEqual(JSON.parse(moved.body.change.critical), ["auth_access: workers/control-plane-shared/src/access.ts"]);
  const audits = db.raw.prepare("SELECT outcome FROM audit_events WHERE event_type = 'forge.change_registered' ORDER BY rowid").all().map((a: any) => a.outcome);
  assert.deepEqual(audits, ["head_changed", "head_changed"]);
  const listed = await call(forge, env, req("GET", "/v1/forge/changes", undefined, OPERATOR_JWT));
  assert.deepEqual([listed.body.changes[0].verdict, listed.body.changes[0].reasons], ["pending", ["checks have not finished"]]);
});

test("CR5. outcome: GitHub's merge is frozen next to the Forge verdict; parity counts agreements; closed is not compared; idempotent", async () => {
  const db = migratedDb();
  const repo = repoOf({ [BASE]: BASE_FILES, [HEAD]: { ...BASE_FILES, "workers/forge/src/b.ts": "x" } });
  const env = forgeEnv(db, repo);
  const reg = async (n: number, head = HEAD) => (await call(forge, env, req("POST", "/v1/forge/changes", { ...REG, number: n, head_sha: head }, CI_JWT))).body.change;
  await reg(1); await reg(2); await reg(3); await reg(4);
  recordCheck(db, HEAD);
  const out = (n: number, merged: boolean, sha: string | null = merged ? "e".repeat(40) : null) => call(forge, env, req("POST", "/v1/forge/changes/outcome", { confirm: "REPORT", number: n, merged, merge_sha: sha }, CI_JWT));
  assert.equal((await out(1, true, "nope")).body.error, "invalid_merge_sha");
  assert.equal((await out(99, true)).status, 404);
  assert.equal((await call(forge, env, req("POST", "/v1/forge/changes/outcome", { confirm: "REPORT", number: 1, merged: true, merge_sha: "e".repeat(40) }, OPERATOR_JWT))).body.error, "service_token_required");
  const m1 = await out(1, true);
  assert.deepEqual([m1.body.change.status, m1.body.change.verdict_at_outcome, m1.body.change.agrees], ["merged", "would_merge", 1]);
  assert.equal((await out(1, true)).status, 200, "idempotent");
  assert.equal((await out(1, false)).body.error, "change_already_decided");
  const c2 = await out(2, false);
  assert.deepEqual([c2.body.change.status, c2.body.change.agrees], ["closed", null]);
  // A failing check: GitHub merged what the Forge blocked -> disagreement.
  recordCheck(db, HEAD, "failed", "failed");
  // Explicit, increasing outcome times: in workerd Date.now() does not advance within a request.
  const later = Date.now() + 60_000;
  const m3 = await recordOutcome(db as never, { number: 3, merged: true, merge_sha: "e".repeat(40) }, CI_CLIENT_ID, later);
  assert.deepEqual([m3.verdict_at_outcome, m3.agrees], ["blocked", 0]);
  // No check at all: the Forge was late; not compared.
  db.raw.prepare("DELETE FROM forge_check_runs").run();
  const m4 = await recordOutcome(db as never, { number: 4, merged: true, merge_sha: "e".repeat(40) }, CI_CLIENT_ID, later + 1_000);
  assert.deepEqual([m4.verdict_at_outcome, m4.agrees, (await out(4, true)).body.change.agrees], ["pending", null, null]);
  assert.equal((await registerChange(db as never, repo, { ...REG, number: 1 }, CI_CLIENT_ID).catch((e) => e.message)), "change_already_merged");
  const { parity } = await listChanges(db as never, 10);
  assert.deepEqual(parity, { target: 10, consecutive: 0, compared: 2, late: 1, disagreements: ["gh-3"] });
  assert.deepEqual(mergeParity([{ cr_id: "a", status: "merged", agrees: 1 }, { cr_id: "b", status: "closed", agrees: null }, { cr_id: "c", status: "merged", agrees: 1 }, { cr_id: "d", status: "merged", agrees: 0 }]),
    { target: 10, consecutive: 2, compared: 3, late: 0, disagreements: ["d"] });
});

test("CR6. the tick checks open change request heads first; their runs stay out of main's checks list and parity", async () => {
  const db = migratedDb();
  const repo = repoOf({ [BASE]: BASE_FILES, [HEAD]: { ...BASE_FILES, "workers/control-plane-shared/test/a.test.ts": "x" } });
  await registerChange(db as never, repo, REG, CI_CLIENT_ID);
  assert.equal(await nextChangeHead(db as never, repo, Date.now()), HEAD);
  const deps = async (): Promise<CheckDeps> => ({
    esbuild: { async build() { return { outputFiles: [{ text: "x", contents: new Uint8Array() }], errors: [], warnings: [] }; } },
    shims: {} as never, sqlJs: "", sqlWasm: null,
    async runWorker(code) { return { files: (code.modules["files.json"] as { json: string[] }).json.map((file) => ({ file, results: [{ name: "t", status: "pass" }] })) }; },
  });
  const env = { DB: db as never, ARTIFACTS: { get: async () => repo } };
  const out = await tickWith(env, "platform", deps, () => Date.now(), (r) => nextChangeHead(db as never, r, Date.now()));
  assert.deepEqual([out.outcome, (out as { commit: string }).commit], ["checked", HEAD]);
  assert.equal(await nextChangeHead(db as never, repo, Date.now()), null, "checked once");
  assert.deepEqual((await listChecks(db as never, 10)).checks, [], "an open change request head is not a commit of main");
  const listed = (await listChanges(db as never, 10)).changes[0];
  assert.deepEqual([listed.check?.status, listed.verdict], ["passed", "pending"], "the type-check of the head has not reported");
});

test("CR7. wiring: workflows from the default branch only, forks ignored, outcome from the main mirror; migration 0037 required", () => {
  const wf = read(".github/workflows/forge-change-request.yml");
  assert.match(wf, /workflow_run:\n\s+workflows: \["Validate Control Plane Workers"\]/);
  assert.match(wf, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/, "same-repository pull requests only");
  assert.match(wf, /environment: production/);
  assert.match(wf, /persist-credentials: false/);
  assert.match(wf, /refs\/heads\/cr\/\$\{PR_NUMBER\}/);
  assert.doesNotMatch(wf, /npm (ci|install|run|test)|node |npx /, "nothing from the pull request runs");
  const mirror = read(".github/workflows/mirror-to-forge.yml");
  assert.match(mirror, /\/v1\/forge\/changes\/outcome/);
  assert.match(mirror, /:refs\/heads\/cr\/\$1/);
  assert.ok((FORGE_MIGRATIONS as readonly string[]).includes("0037_forge_change_requests.sql"));
  assert.match(read("workers/console/src/index.ts"), /"\/v1\/forge\/changes"/);
});

test("CR8. checks record their source; earlier change request heads never appear among main's checks (migration 0039 backfill)", async () => {
  const db = migratedDb();
  const repo = repoOf({ [BASE]: BASE_FILES, [HEAD]: { ...BASE_FILES, "workers/forge/src/b.ts": "x" }, [HEAD2]: { ...BASE_FILES, "workers/forge/src/c.ts": "y" } });
  await registerChange(db as never, repo, REG, CI_CLIENT_ID);
  const deps = async (): Promise<CheckDeps> => ({
    esbuild: { async build() { return { outputFiles: [{ text: "x", contents: new Uint8Array() }], errors: [], warnings: [] }; } },
    shims: {} as never, sqlJs: "", sqlWasm: null,
    async runWorker(code) { return { files: (code.modules["files.json"] as { json: string[] }).json.map((file) => ({ file, results: [{ name: "t", status: "pass" }] })) }; },
  });
  const env = { DB: db as never, ARTIFACTS: { get: async () => repo } };
  await tickWith(env, "platform", deps, () => Date.now(), (r) => nextChangeHead(db as never, r, Date.now()), "change");
  assert.equal((db.raw.prepare("SELECT source FROM forge_check_runs WHERE commit_sha = ?").get(HEAD) as any).source, "change");
  // The change request moves to a new head: the earlier head is no longer open, and still not a commit of main.
  await registerChange(db as never, repo, { ...REG, head_sha: HEAD2 }, CI_CLIENT_ID);
  assert.deepEqual((await listChecks(db as never, 10)).checks, []);
  // Backfill of rows recorded before 0039: GitHub CI or a main type-check report means main; otherwise a change request head since 06:30.
  const ins = db.raw.prepare("INSERT INTO forge_check_runs (commit_sha, status, runner, started_at) VALUES (?, 'passed', 'r', ?)");
  ins.run("1".repeat(40), "2026-11-09T07:00:00.000Z"); ins.run("2".repeat(40), "2026-11-09T07:00:00.000Z"); ins.run("3".repeat(40), "2026-11-09T07:00:00.000Z"); ins.run("4".repeat(40), "2026-11-08T07:00:00.000Z");
  db.raw.prepare("INSERT INTO forge_ci_reports (commit_sha, conclusion, workflow_run_id, reported_at) VALUES (?, 'success', '1', ?)").run("1".repeat(40), "2026-11-09T07:01:00.000Z");
  db.raw.prepare("INSERT INTO forge_typecheck_reports (commit_sha, conclusion, build_id, branch, errors, reported_at) VALUES (?, 'success', 'b', 'main', 0, ?)").run("2".repeat(40), "2026-11-09T07:01:00.000Z");
  const migration = read("workers/control-plane-migrations/0039_forge_check_source.sql");
  db.raw.exec(migration.slice(migration.indexOf("UPDATE forge_check_runs")));
  const sources = Object.fromEntries((db.raw.prepare("SELECT substr(commit_sha, 1, 1) c, source FROM forge_check_runs WHERE commit_sha IN (?, ?, ?, ?)").all("1".repeat(40), "2".repeat(40), "3".repeat(40), "4".repeat(40)) as any[]).map((r) => [r.c, r.source]));
  assert.deepEqual(sources, { 1: "main", 2: "main", 3: "change", 4: "main" });
  assert.deepEqual((await listChecks(db as never, 10)).checks.map((c) => c.commit[0]).sort(), ["1", "2", "4"]);
});
