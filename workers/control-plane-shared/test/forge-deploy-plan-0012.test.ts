// ADR-0012 phase 4, shadow: the deploy plan. For the same main commit and registry inputs, the
// Forge computes the pending deploy units from the Artifacts repository and the Orchestrator from the
// GitHub compare API, with the same shared rules (deploy-units.ts). Both record their side in
// forge_deploy_plans; whichever records second compares them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OPERATOR_JWT, OUTSIDER_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import forge, { FORGE_MIGRATIONS } from "../../forge/src/index.ts";
import { forgePlan, listDeployPlans, planTick } from "../../forge/src/deploy-plan.ts";
import { pendingDeploys } from "../../deployment-orchestrator/src/index.ts";
import { DEPLOY_UNITS, orderPending, recordPlanSide, registryFingerprint } from "../src/deploy-units.ts";
import type { ArtifactsReader, ArtifactsTreeEntry } from "../../forge/src/checks.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const OLD_SHA = "0".repeat(40);
const MAIN = "1".repeat(40);
const realFetch = globalThis.fetch;

/** An Artifacts repo whose main history is [MAIN, OLD_SHA]; MAIN adds or edits `changed` on top of OLD. */
function repoWith(changed: string[]): ArtifactsReader {
  const base: Record<string, string> = { "README.md": "x", "workers/console/ui/src/App.tsx": "a", "workers/control-plane-shared/src/http.ts": "h" };
  const head: Record<string, string> = { ...base };
  for (const p of changed) head[p] = (head[p] ?? "") + " changed";
  const trees: Record<string, ArtifactsTreeEntry[]> = {}; const blobs: Record<string, string> = {}; let n = 1;
  const id = () => (n++).toString(16).padStart(40, "f");
  function build(files: Record<string, string>): string {
    const here: Record<string, Record<string, string>> = {}; const entries: ArtifactsTreeEntry[] = [];
    for (const [p, t] of Object.entries(files)) {
      const i = p.indexOf("/");
      if (i < 0) { const h = "b" + [...t].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("").padEnd(39, "0").slice(0, 39); blobs[h] = t; entries.push({ name: p, type: "blob", mode: "100644", hash: h }); }
      else (here[p.slice(0, i)] ??= {})[p.slice(i + 1)] = t;
    }
    for (const [d, sub] of Object.entries(here)) entries.push({ name: d, type: "tree", mode: "40000", hash: build(sub) });
    const key = JSON.stringify(entries.sort((a, b) => a.name.localeCompare(b.name)));
    const existing = Object.entries(trees).find(([, e]) => JSON.stringify(e) === key);
    if (existing) return existing[0];
    const h = id(); trees[h] = entries; return h;
  }
  const roots: Record<string, string> = { [OLD_SHA]: build(base), [MAIN]: build(head) };
  return {
    async readCommit(h) { return roots[h] ? { hash: h, treeHash: roots[h] } : null; },
    async readTree(h) { return trees[h] ?? null; },
    async readBlob(h) { return h in blobs ? new Blob([blobs[h]]) : null; },
    async log(opts) { return [{ hash: MAIN }, { hash: OLD_SHA }].slice(0, opts?.limit ?? 2); },
  };
}

/** GitHub fake for pendingDeploys: main, green CI, and a compare that lists `files`. */
function github(files: string[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: MAIN } });
    if (/\/commits\/[0-9a-f]{40}\/status$/.test(url)) return Response.json({ state: "success", total_count: 1 });
    if (url.includes("/actions/runs?head_sha=")) {
      const runs = ["Validate", "Validate Control Plane Workers"].map((name, i) => ({ workflow_id: i + 1, name, event: "push", head_branch: "main", status: "completed", conclusion: "success", run_number: 1 }));
      return Response.json({ total_count: runs.length, workflow_runs: runs });
    }
    if (url.includes("/compare/")) return Response.json({ status: "ahead", files: files.map((filename) => ({ filename })) });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
}
const behind = (db: Db) => db.raw.prepare("UPDATE service_registry SET desired_version = ?").run(OLD_SHA.slice(0, 12));
const orchestratorEnv = (db: Db) => baseEnv("cryptophys-deployment-orchestrator", db, { GH_ACTIONS_TOKEN: "gh-token" });
/** The Forge's check of a commit of main (forge_check_runs), with every gate's step. */
function checked(db: Db, sha: string, status: "passed" | "failed") {
  const steps = JSON.stringify({ typecheck: { status: "passed", errors: 0, console_build: { status: "passed" } } });
  const at = new Date().toISOString();
  db.raw.prepare(`INSERT OR REPLACE INTO forge_check_runs (commit_sha, status, runner, files, pass, fail, skip, failures, started_at, finished_at, duration_ms, steps, guard_status, source)
    VALUES (?, ?, 'forge-runner/1', 1, 1, 0, 0, '[]', ?, ?, 1, ?, 'clean', 'main')`).run(sha, status, at, at, steps);
}
const row = (db: Db) => db.raw.prepare("SELECT forge_units, github_units, agrees FROM forge_deploy_plans").all().map((r: any) => ({ ...r }));

test("DP1. the shared ordering rules: migration first and alone; orchestrator first; fail closed when the Control Plane is unavailable", () => {
  const u = (unit: string) => ({ unit, workflow: `${unit}.yml`, target: unit, reason: "x" });
  assert.deepEqual(orderPending([u("console"), u("control-plane")], true, []).units.map((x) => x.unit), ["control-plane"]);
  assert.deepEqual(orderPending([u("console"), u("deployment-orchestrator")], false, []).units.map((x) => x.unit), ["deployment-orchestrator"]);
  assert.deepEqual(orderPending([u("console")], true, [{ unit: "control-plane", reason: "desired_version_unknown" }]),
    { units: [], skipped: [{ unit: "control-plane", reason: "desired_version_unknown" }, { unit: "*", reason: "new_migration_control_plane_unavailable" }] });
  assert.deepEqual(orderPending([u("console"), u("platform-api")], false, []).units.map((x) => x.unit), ["console", "platform-api"]);
  assert.equal(DEPLOY_UNITS.length, 5, "six units until cryptophys-home was retired (2026-11-13)");
});

test("DP2. G1 (owner 2026-11-12): the Orchestrator's pending deploys are the Forge's plan from Artifacts, gated by the Forge's checks", async () => {
  for (const [files, expected] of [
    [["workers/console/ui/src/App.tsx"], ["console"]],
    [["workers/control-plane-shared/src/http.ts"], ["deployment-orchestrator"]],
    [["workers/control-plane-migrations/0099_x.sql", "workers/console/ui/src/App.tsx"], ["control-plane"]],
    [["README.md"], []],
  ] as Array<[string[], string[]]>) {
    const db = migratedDb();
    behind(db);
    const repo = repoWith(files);
    const forgeSide = await forgePlan(db as never, repo, MAIN);
    assert.deepEqual(forgeSide.units.map((x) => x.unit), expected, files.join());
    assert.deepEqual(await planTick(db as never, repo), { outcome: "recorded", main_sha: MAIN, units: expected });
    // Before the Forge has checked main's head, nothing is pending.
    let pending = await pendingDeploys(orchestratorEnv(db) as never);
    assert.deepEqual([pending.main_sha, pending.ci_green, pending.units, pending.skipped], [MAIN, false, [], [{ unit: "*", reason: "forge_checks_pending" }]]);
    checked(db, MAIN, "passed");
    pending = await pendingDeploys(orchestratorEnv(db) as never);
    assert.equal(pending.ci_green, true);
    assert.deepEqual(pending.units, forgeSide.units, files.join());
    assert.deepEqual(pending.skipped, forgeSide.skipped, files.join());
    assert.equal((await planTick(db as never, repo)).outcome, "up_to_date", "once per main commit and registry inputs");
    checked(db, MAIN, "failed");
    pending = await pendingDeploys(orchestratorEnv(db) as never);
    assert.deepEqual([pending.ci_green, pending.units.length, pending.skipped], [false, 0, [{ unit: "*", reason: "forge_checks_not_ready" }]]);
  }
});

test("DP2b. a Forge built with another deploy-unit list (a unit retired or added) still drives the Orchestrator while its inputs hold (2026-11-13)", async () => {
  const db = migratedDb();
  behind(db);
  const repo = repoWith(["workers/console/ui/src/App.tsx"]);
  await planTick(db as never, repo);
  checked(db, MAIN, "passed");
  // As on 2026-11-13: the Forge (built before #316) wrote its fingerprint with cryptophys-home, which the
  // Orchestrator's unit list no longer has, so an exact match never comes.
  const fp = await registryFingerprint(db as never);
  db.raw.prepare("UPDATE forge_deploy_plans SET fingerprint = ? WHERE main_sha = ?").run(`${fp},cryptophys-home=disabled`.split(",").sort().join(","), MAIN);
  let pending = await pendingDeploys(orchestratorEnv(db) as never);
  assert.deepEqual(pending.units.map((u) => u.unit), ["console"], "every input the Forge planned from is unchanged");
  // One of those inputs changes (a deploy recorded a new desired version): the plan no longer holds.
  db.raw.prepare("UPDATE service_registry SET desired_version = 'cccccccccccc' WHERE service_id = 'cryptophys-console'").run();
  pending = await pendingDeploys(orchestratorEnv(db) as never);
  assert.deepEqual([pending.units, pending.skipped], [[], [{ unit: "*", reason: "forge_plan_pending" }]]);
  // A service it names that has no row, or an unparsable fingerprint, fails closed.
  const { fingerprintStillHolds } = await import("../src/forge-gate.ts");
  assert.equal(await fingerprintStillHolds(db as never, "cryptophys-nope=aaaaaaaaaaaa"), false);
  assert.equal(await fingerprintStillHolds(db as never, "not a fingerprint"), false);
  assert.equal(await fingerprintStillHolds(db as never, ""), false);
  assert.equal(await fingerprintStillHolds(db as never, "x".repeat(2000)), false, "a truncated fingerprint is never trusted");
});

test("DP3. a different answer is a disagreement; new registry inputs are a new comparison; an unknown base fails closed", async () => {
  const db = migratedDb();
  behind(db);
  const repo = repoWith(["workers/console/ui/src/App.tsx"]);
  await planTick(db as never, repo);
  await recordPlanSide(db as never, "github", MAIN, await registryFingerprint(db as never), { units: [{ unit: "platform-api", workflow: "w", target: "t", reason: "r" }], skipped: [] });
  assert.deepEqual(row(db), [{ forge_units: '["console"]', github_units: '["platform-api"]', agrees: 0 }]);
  // A deploy changed the registry: the same commit is compared again under the new inputs.
  db.raw.prepare("UPDATE service_registry SET desired_version = ? WHERE service_id = 'cryptophys-console'").run(MAIN.slice(0, 12));
  assert.deepEqual(await planTick(db as never, repo), { outcome: "recorded", main_sha: MAIN, units: [] });
  assert.equal(row(db).length, 2);
  const listed = await listDeployPlans(db as never, 10);
  assert.deepEqual(listed.parity, { target: 10, consecutive: 0, compared: 1, disagreements: [MAIN.slice(0, 12)] });
  // A desired version that is not in main's recent history cannot be diffed: skipped, as a failed compare is.
  db.raw.prepare("UPDATE service_registry SET desired_version = ? WHERE service_id = 'cryptophys-platform-api'").run("abcdefabcdef");
  const plan = await forgePlan(db as never, repo, MAIN);
  assert.ok(plan.skipped.some((s) => s.unit === "platform-api" && s.reason === "compare_failed_or_diverged"));
});

test("DP4. GET /v1/forge/deploy-plans for operators; wiring: migration 0038 required, Console route, Orchestrator records its side without ever failing on it", async () => {
  const db = migratedDb();
  behind(db);
  await planTick(db as never, repoWith(["workers/console/ui/src/App.tsx"]));
  const env = baseEnv("cryptophys-forge", db);
  const r = await call(forge, env, req("GET", "/v1/forge/deploy-plans?limit=5", undefined, OPERATOR_JWT));
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.plans[0].forge_units, r.body.plans[0].github_units, r.body.parity.target], [["console"], null, 10]);
  assert.equal((await call(forge, env, req("GET", "/v1/forge/deploy-plans", undefined, OUTSIDER_JWT))).status, 403);
  assert.ok((FORGE_MIGRATIONS as readonly string[]).includes("0038_forge_deploy_plans.sql"));
  assert.match(read("workers/console/src/index.ts"), /"\/v1\/forge\/deploy-plans"/);
  assert.match(read("workers/deployment-orchestrator/src/index.ts"), /return forgePendingDeploys\(env\.DB\)/);
  assert.doesNotMatch(read("workers/deployment-orchestrator/src/index.ts"), /\/compare\//, "G1: no GitHub compare in deploy decisions");
  // Without the table the Orchestrator answers, and nothing is pending.
  const bare = migratedDb();
  behind(bare);
  bare.raw.prepare("DROP TABLE forge_deploy_plans").run();
  assert.deepEqual(await pendingDeploys(orchestratorEnv(bare) as never), { main_sha: null, ci_green: false, units: [], skipped: [{ unit: "*", reason: "forge_unavailable" }] });
});

test("DP5. G1: the newest planned commit is main's head, however long a unit waits for a deploy slot", async () => {
  const db = migratedDb();
  behind(db);
  await planTick(db as never, repoWith(["workers/console/ui/src/App.tsx"]), Date.now() - 6 * 3_600_000);
  checked(db, MAIN, "passed");
  const p = await pendingDeploys(orchestratorEnv(db) as never);
  assert.deepEqual([p.main_sha, p.units.map((u) => u.unit)], [MAIN, ["console"]], "an unchanged plan from 6 h ago still decides");
});
