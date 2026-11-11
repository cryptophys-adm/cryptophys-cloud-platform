// ADR-0012 §5d (owner 2026-11-11, "langkah B"): change requests are type-checked on a Workers Builds project
// with no build secrets; the Forge reads each build's result line through the Workers Builds API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migratedDb } from "./harness.ts";
import { crBuildsTick, resultFromLogs, CR_TYPECHECK_WORKER } from "../../forge/src/cr-builds.ts";
import { criticalReasons } from "../../forge/src/changes.ts";
import { resultLine, RESULT_MARKER } from "../../forge-typecheck/typecheck-and-report.mjs";
import { secretFreeEnv } from "../../forge-typecheck-cr/typecheck-and-report.mjs";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const HEAD = "a".repeat(40);
const OTHER = "c".repeat(40);
const ACCOUNT = "f".repeat(32);
const TAG = "e".repeat(32);

function openChange(db: ReturnType<typeof migratedDb>, number: number, head: string) {
  db.raw.prepare(`INSERT INTO forge_change_requests (cr_id, source, number, branch, source_branch, title, author, head_sha, base_sha, github_ci, status, changed_paths, critical, created_at, updated_at)
    VALUES (?, 'github', ?, ?, 'claude/x', 't', 'cryptophys-adm', ?, ?, 'success', 'open', '[]', '[]', ?, ?)`).run(`gh-${number}`, number, `cr/${number}`, head, "b".repeat(40), new Date().toISOString(), new Date().toISOString());
}

const RESULT = { commit: HEAD, build_id: "uuid-1", branch: "cr/7", conclusion: "success", errors: 0, diagnostics: [], toolchain: { typescript: "7.0.0", "@types/node": "22.10.0" }, console_build: { conclusion: "success", errors: 0, diagnostics: [], bytes: 900000 } };

function buildsApi({ logsFor = {} as Record<string, unknown>, builds = [] as unknown[], previews = [] as unknown[], previewBuilds = {} as Record<string, unknown[]> } = {}) {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push(url);
    assert.equal((init?.headers as Record<string, string>)?.authorization, "Bearer test-token");
    const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
    if (url.endsWith("/accounts?per_page=5")) return ok([{ id: ACCOUNT }]);
    if (url.endsWith(`/accounts/${ACCOUNT}/workers/scripts`)) return ok([{ id: "cryptophys-forge", tag: "x".repeat(32) }, { id: CR_TYPECHECK_WORKER, tag: TAG }]);
    if (url.includes(`/builds/workers/${TAG}/builds`)) return ok(builds);
    if (url.endsWith(`/builds/workers/${TAG}/previews`)) return ok(previews);
    const pb = url.match(new RegExp(`/builds/workers/${TAG}/previews/([^/]+)/builds$`));
    if (pb) return ok(previewBuilds[pb[1]] ?? []);
    const m = url.match(/\/builds\/builds\/([^/]+)\/logs$/);
    if (m) return ok(logsFor[m[1]] ?? { lines: [] });
    return new Response(JSON.stringify({ success: false }), { status: 404 });
  };
  return { calls, fetchImpl };
}

test("B1. the build prints one secret-free result line; the CR build script strips every credential", () => {
  const line = resultLine(RESULT);
  assert.ok(line.startsWith(RESULT_MARKER));
  assert.deepEqual(JSON.parse(line.slice(RESULT_MARKER.length)), RESULT);
  const env = secretFreeEnv({ CF_ACCESS_CLIENT_ID: "id", CF_ACCESS_CLIENT_SECRET: "secret", FORGE_URL: "https://f", WORKERS_CI_BRANCH: "cr/7" });
  assert.deepEqual(env, { WORKERS_CI_BRANCH: "cr/7" });
  const toml = read("workers/forge-typecheck-cr/wrangler.toml");
  assert.match(toml, /^name = "cryptophys-forge-typecheck-cr"$/m);
  assert.match(toml, /^workers_dev = false$/m);
  assert.match(toml, /^preview_urls = false$/m, "no Preview or version of change-request code gets a public URL");
  assert.match(toml, /^\[previews\]\s*$/m, "wrangler preview needs the block");
  assert.doesNotMatch(toml, /^\[\[?previews\./m, "the previews block stays empty: no binding, variable or secret");
  assert.doesNotMatch(toml, /\[\[(d1_databases|kv_namespaces|services|r2_buckets)\]\]|\[vars\]/, "the stub has no binding and no variable");
  assert.equal(JSON.parse(read("workers/forge-typecheck-cr/package.json")).scripts.build, "node typecheck-and-report.mjs");
});

test("B2. the result line is found in nested build logs; the last one wins; other lines are ignored", () => {
  const logs = { lines: [["2026-11-11T05:00:00Z", "npm ci"], ["2026-11-11T05:01:00Z", `${RESULT_MARKER}{"commit":"${OTHER}"}`], ["2026-11-11T05:02:00Z", resultLine(RESULT)]] };
  assert.equal(resultFromLogs(logs)?.commit, HEAD);
  assert.equal(resultFromLogs({ lines: [["t", `${RESULT_MARKER}{not json`]] }), null);
  assert.equal(resultFromLogs(null), null);
});

test("B3. without the token the step does nothing; with it, the newest finished build of cr/<n> whose line names the head is recorded", async () => {
  const db = migratedDb();
  assert.deepEqual(await crBuildsTick({ DB: db as never }), { outcome: "not_configured" });
  openChange(db, 7, HEAD);
  openChange(db, 8, OTHER);
  const { fetchImpl, calls } = buildsApi({
    builds: [
      { build_uuid: "uuid-1", status: "stopped", build_outcome: "success", created_on: "2026-11-11T05:00:00Z", build_trigger_metadata: { branch: "cr/7", commit_hash: HEAD } },
      { build_uuid: "uuid-0", status: "stopped", build_outcome: "fail", created_on: "2026-11-11T04:00:00Z", build_trigger_metadata: { branch: "cr/7", commit_hash: HEAD } },
      { build_uuid: "uuid-8", status: "running", build_outcome: null, created_on: "2026-11-11T05:05:00Z", build_trigger_metadata: { branch: "cr/8", commit_hash: OTHER } },
    ],
    logsFor: { "uuid-1": { lines: [["t", resultLine(RESULT)]] } },
  });
  const out = await crBuildsTick({ DB: db as never, CF_BUILDS_API_TOKEN: "test-token" }, Date.now(), fetchImpl as never);
  assert.equal(out.outcome, "recorded", JSON.stringify(out));
  assert.deepEqual(out.recorded, [{ number: 7, commit: HEAD, conclusion: "success" }]);
  const row = db.raw.prepare("SELECT conclusion, build_id, branch FROM forge_typecheck_reports WHERE commit_sha = ?").get(HEAD) as any;
  assert.deepEqual({ ...row }, { conclusion: "success", build_id: "uuid-1", branch: "cr/7" });
  assert.ok(!calls.some((u) => u.includes("uuid-0") || u.includes("uuid-8")), "only the newest finished build is read");
  assert.equal((await crBuildsTick({ DB: db as never, CF_BUILDS_API_TOKEN: "test-token" }, Date.now(), fetchImpl as never)).outcome, "waiting", "cr/8 is still building; cr/7 is done");
});

test("B4. a line whose commit is not the head is never recorded (an older or forged build)", async () => {
  const db = migratedDb();
  openChange(db, 7, HEAD);
  const { fetchImpl } = buildsApi({
    builds: [{ build_uuid: "uuid-1", status: "stopped", build_outcome: "success", created_on: "2026-11-11T05:00:00Z", build_trigger_metadata: { branch: "cr/7" } }],
    logsFor: { "uuid-1": { lines: [["t", resultLine({ ...RESULT, commit: OTHER })]] } },
  });
  const out = await crBuildsTick({ DB: db as never, CF_BUILDS_API_TOKEN: "test-token" }, Date.now(), fetchImpl as never);
  assert.equal(out.outcome, "waiting");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM forge_typecheck_reports").get()!.n, 0);
});

test("B5. a change to the type-check harness is the owner's (its build runs that very code)", async () => {
  const repo = { readBlob: async () => null } as never;
  for (const path of ["workers/forge-typecheck/typecheck-and-report.mjs", "workers/forge-typecheck-cr/typecheck-and-report.mjs", "workers/control-plane-tsconfig.json", "workers/forge/src/cr-builds.ts", "workers/control-plane-shared/package-lock.json", "workers/console/ui/vite.config.ts", "workers/console/ui/tsconfig.json"]) {
    const reasons = await criticalReasons(repo, [{ path, change: "modified", base: "x", head: "y" } as never], false);
    assert.ok(reasons.some((r) => r.startsWith("typecheck_harness:")), path);
  }
  assert.deepEqual(await criticalReasons(repo, [{ path: "workers/forge/src/checks.ts", change: "modified", base: "x", head: "y" } as never], false), []);
});

test("B6. a Preview build missing from the Worker's list is read from the branch's Preview (live 2026-11-11)", async () => {
  const db = migratedDb();
  openChange(db, 7, HEAD);
  openChange(db, 9, OTHER); // no Preview yet: nothing is read for it
  const { fetchImpl, calls } = buildsApi({
    builds: [{ build_uuid: "uuid-main", status: "stopped", build_outcome: "success", created_on: "2026-11-11T05:00:00Z", build_trigger_metadata: { branch: "main", commit_hash: "d".repeat(40) } }],
    previews: [{ preview_id: "pv7", branch: "cr/7" }, { preview_id: "pv5", branch: "cr/5" }],
    previewBuilds: {
      pv7: [
        { build_uuid: "uuid-old", status: "stopped", build_outcome: "fail", created_on: "2026-11-11T04:00:00Z", build_trigger_metadata: { commit_hash: OTHER } },
        { build_uuid: "uuid-1", status: "stopped", build_outcome: "success", created_on: "2026-11-11T05:00:00Z", build_trigger_metadata: { commit_hash: HEAD } },
      ],
    },
    logsFor: { "uuid-1": { lines: [["t", resultLine(RESULT)]] } },
  });
  const out = await crBuildsTick({ DB: db as never, CF_BUILDS_API_TOKEN: "test-token" }, Date.now(), fetchImpl as never);
  assert.equal(out.outcome, "recorded", JSON.stringify(out));
  assert.equal(out.via_preview, 1);
  assert.deepEqual(out.recorded, [{ number: 7, commit: HEAD, conclusion: "success" }]);
  assert.equal((db.raw.prepare("SELECT branch FROM forge_typecheck_reports WHERE commit_sha = ?").get(HEAD) as any).branch, "cr/7");
  assert.equal(calls.filter((u) => u.endsWith("/previews")).length, 1, "the Preview list is read once per tick");
  assert.ok(!calls.some((u) => u.includes("uuid-old")), "a build of another commit is never read");
});
