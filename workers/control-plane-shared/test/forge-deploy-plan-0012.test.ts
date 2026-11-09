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
const row = (db: Db) => db.raw.prepare("SELECT forge_units, github_units, agrees FROM forge_deploy_plans").all().map((r: any) => ({ ...r }));

test("DP1. the shared ordering rules: migration first and alone; orchestrator first; fail closed when the Control Plane is unavailable", () => {
  const u = (unit: string) => ({ unit, workflow: `${unit}.yml`, target: unit, reason: "x" });
  assert.deepEqual(orderPending([u("console"), u("control-plane")], true, []).units.map((x) => x.unit), ["control-plane"]);
  assert.deepEqual(orderPending([u("console"), u("deployment-orchestrator")], false, []).units.map((x) => x.unit), ["deployment-orchestrator"]);
  assert.deepEqual(orderPending([u("console")], true, [{ unit: "control-plane", reason: "desired_version_unknown" }]),
    { units: [], skipped: [{ unit: "control-plane", reason: "desired_version_unknown" }, { unit: "*", reason: "new_migration_control_plane_unavailable" }] });
  assert.deepEqual(orderPending([u("console"), u("home")], false, []).units.map((x) => x.unit), ["console", "home"]);
  assert.equal(DEPLOY_UNITS.length, 6);
});

test("DP2. the Forge plan from Artifacts equals the Orchestrator's GitHub plan for the same changes, and they are recorded as agreeing", async () => {
  try {
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
      github(files);
      const githubSide = await pendingDeploys(orchestratorEnv(db) as never);
      assert.deepEqual(forgeSide.units.map((x) => x.unit), expected, files.join());
      assert.deepEqual(forgeSide.units, githubSide.units, files.join());
      assert.deepEqual(forgeSide.skipped, githubSide.skipped, files.join());
      // The Orchestrator recorded its side; the Forge tick records its own and compares.
      assert.deepEqual(row(db), [{ forge_units: null, github_units: JSON.stringify(expected), agrees: null }]);
      assert.deepEqual(await planTick(db as never, repo), { outcome: "recorded", main_sha: MAIN, units: expected });
      assert.deepEqual(row(db), [{ forge_units: JSON.stringify(expected), github_units: JSON.stringify(expected), agrees: 1 }]);
      assert.equal((await planTick(db as never, repo)).outcome, "up_to_date", "once per main commit and registry inputs");
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("DP3. a different answer is a disagreement; new registry inputs are a new comparison; an unknown base fails closed", async () => {
  const db = migratedDb();
  behind(db);
  const repo = repoWith(["workers/console/ui/src/App.tsx"]);
  await planTick(db as never, repo);
  await recordPlanSide(db as never, "github", MAIN, await registryFingerprint(db as never), { units: [{ unit: "home", workflow: "w", target: "t", reason: "r" }], skipped: [] });
  assert.deepEqual(row(db), [{ forge_units: '["console"]', github_units: '["home"]', agrees: 0 }]);
  // A deploy changed the registry: the same commit is compared again under the new inputs.
  db.raw.prepare("UPDATE service_registry SET desired_version = ? WHERE service_id = 'cryptophys-console'").run(MAIN.slice(0, 12));
  assert.deepEqual(await planTick(db as never, repo), { outcome: "recorded", main_sha: MAIN, units: [] });
  assert.equal(row(db).length, 2);
  const listed = await listDeployPlans(db as never, 10);
  assert.deepEqual(listed.parity, { target: 10, consecutive: 0, compared: 1, disagreements: [MAIN.slice(0, 12)] });
  // A desired version that is not in main's recent history cannot be diffed: skipped, as a failed compare is.
  db.raw.prepare("UPDATE service_registry SET desired_version = ? WHERE service_id = 'cryptophys-home'").run("abcdefabcdef");
  const plan = await forgePlan(db as never, repo, MAIN);
  assert.ok(plan.skipped.some((s) => s.unit === "home" && s.reason === "compare_failed_or_diverged"));
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
  assert.match(read("workers/deployment-orchestrator/src/index.ts"), /try \{ await recordPlanSide\(env\.DB, "github"/);
  // Without the table (before migration 0038 is applied) the Orchestrator still answers.
  const bare = migratedDb();
  behind(bare);
  bare.raw.prepare("DROP TABLE forge_deploy_plans").run();
  try {
    github(["workers/console/ui/src/App.tsx"]);
    assert.deepEqual((await pendingDeploys(orchestratorEnv(bare) as never)).units.map((u) => u.unit), ["console"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
