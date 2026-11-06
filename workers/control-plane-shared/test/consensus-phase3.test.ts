// ADR-0009 phase 3: consensus deploys of CI-green main commits, with automatic rollback in the
// deploy workflows. Production stays in shadow mode; these tests switch the mode in a local D1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, fakeAi, fakeWorkflow, migratedDb } from "./harness.ts";
import { verifySyscallDecision } from "../src/capabilities.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { proposeFromAgent } from "../../recovery-manager/src/index.ts";
import { ciGreen, DEPLOY_UNITS, DeploymentLock, deployForConsensus, pendingDeploys, unitChanged, unitForService } from "../../deployment-orchestrator/src/index.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { runCycle } from "../../ai-kernel/src/supervisor.ts";
import { PHASE2_EXECUTABLE, executableIn } from "../../ai-kernel/src/consensus.ts";

type Db = ReturnType<typeof migratedDb>;
const MAIN = "1".repeat(40);
const OLD = "0".repeat(12);
const realFetch = globalThis.fetch;

interface GitHubFake {
  main: string;
  ciConclusion: string;
  controlPlaneConclusion: string;
  statusState: string;
  statusCount: number;
  omitWorkflow?: string;
  files: string[];
  dispatched: { workflow: string; body: any }[];
}
function github(state: Partial<GitHubFake> = {}): GitHubFake {
  const gh: GitHubFake = {
    main: MAIN, ciConclusion: "success", controlPlaneConclusion: "success",
    statusState: "success", statusCount: 1,
    files: ["workers/console/ui/src/App.tsx"], dispatched: [], ...state
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: gh.main } });
    if (/\/commits\/[0-9a-f]{40}\/status$/.test(url)) return Response.json({ state: gh.statusState, total_count: gh.statusCount });
    if (url.includes("/actions/runs?head_sha=")) {
      assert.match(url, /event=push/, "only push-event CI counts for consensus deploys");
      const runs = [
        { workflow_id: 1, name: "Validate", event: "push", head_branch: "main", status: "completed", conclusion: gh.ciConclusion, run_number: 3 },
        { workflow_id: 2, name: "Validate Control Plane Workers", event: "push", head_branch: "main", status: "completed", conclusion: gh.controlPlaneConclusion, run_number: 3 },
      ].filter((r) => r.name !== gh.omitWorkflow);
      return Response.json({ total_count: runs.length, workflow_runs: runs });
    }
    if (url.includes("/compare/")) return Response.json({ status: "ahead", files: gh.files.map((filename) => ({ filename })) });
    const m = /\/actions\/workflows\/([a-z-]+\.yml)\/dispatches$/.exec(url);
    if (m && init?.method === "POST") { gh.dispatched.push({ workflow: m[1], body: JSON.parse(String(init.body)) }); return new Response(null, { status: 204 }); }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return gh;
}
function lockNamespace() {
  const stores = new Map<string, Map<string, unknown>>();
  return {
    idFromName: (n: string) => n,
    get: (id: unknown) => {
      const key = String(id);
      if (!stores.has(key)) stores.set(key, new Map());
      const data = stores.get(key)!;
      const lock = new DeploymentLock({ storage: { get: async (k: string) => data.get(k) as never, put: async (k: string, v: unknown) => { data.set(k, v); } }, blockConcurrencyWhile: (cb) => cb() });
      return { fetch: (input: RequestInfo | URL, init?: RequestInit) => lock.fetch(new Request(input, init)) };
    },
  };
}

function orchestratorEnv(db: Db) {
  return baseEnv("cryptophys-deployment-orchestrator", db, { GH_ACTIONS_TOKEN: "gh-token", DEPLOYMENT_LOCK: lockNamespace() });
}

function kernelEnv(db: Db = migratedDb()) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const recoveryEnv = { ...baseEnv("cryptophys-recovery-manager", db), RECOVERY_LIFECYCLE: fakeWorkflow().binding };
  const orch = orchestratorEnv(db);
  const mem = new Map<string, unknown>();
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async (agentId: string, decisionId: string, input: Record<string, unknown>) => { await verifySyscallDecision(db, decisionId, agentId, "recovery.propose"); return proposeFromAgent(recoveryEnv as never, agentId, input); } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    DEPLOY: {
      pendingDeploys: () => pendingDeploys(orch as never),
      deployForConsensus: (id: string, dec: string, target: string, params: Record<string, unknown>) => deployForConsensus(orch as never, id, dec, target, params),
    },
  };
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, structuredClone(v)); } };
  return { env, db, memory };
}

const setMode = (db: Db, mode: string) => db.raw.prepare("UPDATE consensus_controls SET value = ? WHERE control = 'mode'").run(mode);
const behind = (db: Db) => db.raw.prepare("UPDATE service_registry SET desired_version = ?").run(OLD);
const proposals = (db: Db) => db.raw.prepare("SELECT * FROM consensus_proposals ORDER BY created_at, rowid").all() as any[];

test("1. modes: shadow executes nothing, routine runs phase 2 only, deploy adds deploy_commit", () => {
  assert.equal(executableIn("shadow").size, 0);
  assert.equal(executableIn("routine").has("deploy_commit"), false);
  assert.deepEqual([...executableIn("routine")], [...PHASE2_EXECUTABLE]);
  assert.equal(executableIn("deploy").has("deploy_commit"), true);
  // Wave B: a rollback to the previous recorded version joins the deploy mode (Rollback Worker workflow).
  assert.equal(executableIn("deploy").has("rollback_worker_version"), true);
  assert.equal(executableIn("routine").has("rollback_worker_version"), false);
  for (const a of ["redeploy_desired_version", "restore_d1_bookmark", "rotate_secret"]) {
    assert.equal(executableIn("critical").has(a), false, a);
  }
});

test("2. deploy units: every registered platform Worker maps to exactly one workflow; paths decide what is pending", () => {
  const all = DEPLOY_UNITS.flatMap((u) => [...u.services]);
  assert.equal(new Set(all).size, all.length);
  assert.equal(unitForService("cryptophys-ai-kernel")?.workflow, "deploy-control-plane.yml");
  assert.equal(unitForService("cryptophys-console")?.workflow, "deploy-console.yml");
  assert.equal(unitForService("xauusd-ai-trading-assistant"), null, "XAUUSD Workers are never deployed by platform consensus");
  assert.equal(DEPLOY_UNITS[0].unit, "deployment-orchestrator", "DeployRpc must be deployed before the Control Plane binding changes");
  const cp = unitForService("cryptophys-policy-engine")!;
  assert.equal(unitChanged(cp, ["docs/SSOT.md", ".github/workflows/deploy-console.yml"]), false);
  assert.equal(unitChanged(cp, ["workers/control-plane-migrations/0024_x.sql"]), true);
  assert.equal(unitChanged(unitForService("cryptophys-home")!, ["workers/control-plane-shared/src/http.ts"]), true);
  assert.equal(unitChanged(unitForService("cryptophys-home")!, ["workers/control-plane-shared/test/x.test.ts"]), false);
  assert.equal(unitChanged(unitForService("cryptophys-console")!, ["workers/console/ui/vite.config.ts"]), true);
  assert.equal(unitChanged(unitForService("cryptophys-console")!, ["workers/console/ui/package.json"]), true);
  assert.equal(unitChanged(unitForService("cryptophys-platform-api")!, ["workers/platform-api/package.json"]), true);
  assert.equal(unitChanged(unitForService("cryptophys-deployment-orchestrator")!, ["workers/deployment-orchestrator/tsconfig.json"]), true);
});

test("3. pendingDeploys: only units with changed files on a CI-green main; red CI yields none", async () => {
  const db = migratedDb();
  behind(db);
  try {
    github();
    let p = await pendingDeploys(orchestratorEnv(db) as never);
    assert.equal(p.ci_green, true);
    assert.deepEqual(p.units.map((u) => u.unit), ["console"]);
    github({ files: ["workers/control-plane-shared/src/http.ts"] });
    p = await pendingDeploys(orchestratorEnv(db) as never);
    // A shared-library change touches every unit; the orchestrator goes first and the rest wait a cycle.
    assert.deepEqual(p.units.map((u) => u.unit), ["deployment-orchestrator"]);
    assert.deepEqual(p.skipped.filter((s) => s.reason === "deployment_orchestrator_must_complete_first").map((s) => s.unit).sort(),
      ["console", "control-plane", "home", "platform-api"]);
    db.raw.prepare("UPDATE service_registry SET desired_version = ? WHERE service_id = 'cryptophys-deployment-orchestrator'").run(MAIN.slice(0, 12));
    p = await pendingDeploys(orchestratorEnv(db) as never);
    assert.deepEqual(p.units.map((u) => u.unit).sort(), ["console", "control-plane", "home", "platform-api"]);
    db.raw.prepare("UPDATE service_registry SET desired_version = ?").run(OLD);
    github({ ciConclusion: "failure" });
    p = await pendingDeploys(orchestratorEnv(db) as never);
    assert.equal(p.ci_green, false);
    assert.equal(p.units.length, 0);
    db.raw.prepare("UPDATE service_registry SET desired_version = ?").run(MAIN.slice(0, 12));
    github();
    assert.equal((await pendingDeploys(orchestratorEnv(db) as never)).units.length, 0, "production already runs main");
  } finally { globalThis.fetch = realFetch; }
});

test("4. supervisor proposes deploy_commit once per unit and commit; shadow records it and dispatches nothing", async () => {
  const { env, db, memory } = kernelEnv();
  behind(db);
  try {
    const gh = github();
    const cycle = await runCycle(env as never, memory, "scheduled");
    assert.ok(cycle.findings.some((f) => f.kind === "deploy" && f.outcome === "succeeded"));
    let ps = proposals(db).filter((p) => p.action === "deploy_commit");
    assert.equal(ps.length, 1);
    assert.equal(ps[0].target, "cryptophys-console");
    assert.equal(JSON.parse(ps[0].params_json).commit_sha, MAIN);
    assert.equal(ps[0].status, "shadow_passed");
    await runCycle(env as never, memory, "scheduled");
    ps = proposals(db).filter((p) => p.action === "deploy_commit");
    assert.equal(ps.length, 1, "the same commit is not proposed twice");
    assert.deepEqual(gh.dispatched, []);
    assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM deployment_requests").get() as any).n, 0);
  } finally { globalThis.fetch = realFetch; }
});

test("5. routine mode still does not deploy", async () => {
  const { env, db } = kernelEnv();
  setMode(db, "routine");
  try {
    const gh = github();
    await syscall(env as never, "supervisor", "consensus.propose", { action: "deploy_commit", target: "cryptophys-console", params: { commit_sha: MAIN } });
    const [p] = proposals(db);
    assert.notEqual(p.status, "executed");
    assert.notEqual(p.status, "executing");
    assert.deepEqual(gh.dispatched, []);
  } finally { globalThis.fetch = realFetch; }
});

test("6. deploy mode: a passed deploy_commit dispatches the unit workflow on main once, recorded and audited", async () => {
  const { env, db } = kernelEnv();
  setMode(db, "deploy");
  try {
    const gh = github();
    await syscall(env as never, "supervisor", "consensus.propose", { action: "deploy_commit", target: "cryptophys-console", params: { commit_sha: MAIN } });
    const p = proposals(db).at(-1);
    assert.equal(p.status, "executed", p.outcome_json);
    assert.deepEqual(gh.dispatched, [{ workflow: "deploy-console.yml", body: { ref: "main", inputs: { confirm_production: "DEPLOY", commit_sha: MAIN } } }]);
    const req = db.raw.prepare("SELECT service_id, requested_version, requested_by, status, approval_id FROM deployment_requests").get() as any;
    assert.deepEqual({ ...req }, { service_id: "cryptophys-console", requested_version: MAIN, requested_by: `consensus:${p.proposal_id}`, status: "running", approval_id: p.proposal_id });
    const ev = db.raw.prepare("SELECT actor, outcome FROM audit_events WHERE event_type = 'deployment.dispatched'").get() as any;
    assert.equal(ev.actor, `consensus:${p.proposal_id}`);
    // The orchestrator refuses a replay of the same proposal and decision.
    await assert.rejects(deployForConsensus(orchestratorEnv(db) as never, p.proposal_id, p.policy_decision_id, "cryptophys-console", { commit_sha: MAIN }), /consensus_not_executable/);
    assert.equal(gh.dispatched.length, 1);
  } finally { globalThis.fetch = realFetch; }
});

test("7. deploy mode: a commit that is not current main, or red CI, fails without dispatching", async () => {
  const { env, db } = kernelEnv();
  setMode(db, "deploy");
  try {
    let gh = github({ main: "2".repeat(40) });
    await syscall(env as never, "supervisor", "consensus.propose", { action: "deploy_commit", target: "cryptophys-home", params: { commit_sha: MAIN } });
    let p = proposals(db).at(-1);
    assert.equal(p.status, "failed");
    assert.match(JSON.parse(p.outcome_json).error, /commit_not_current_main/);
    assert.deepEqual(gh.dispatched, []);
    gh = github({ ciConclusion: "failure" });
    await syscall(env as never, "supervisor", "consensus.propose", { action: "deploy_commit", target: "cryptophys-platform-api", params: { commit_sha: MAIN } });
    p = proposals(db).at(-1);
    assert.equal(p.status, "failed");
    assert.match(JSON.parse(p.outcome_json).error, /ci_not_green/);
    assert.deepEqual(gh.dispatched, []);
  } finally { globalThis.fetch = realFetch; }
});

test("8. wiring: kernel binds DeployRpc; every consensus-deployable workflow captures versions before deploying and rolls back on failure", () => {
  const root = new URL("../../../", import.meta.url);
  const kernelToml = readFileSync(new URL("workers/ai-kernel/wrangler.toml", root), "utf8");
  assert.match(kernelToml, /binding = "DEPLOY"\nservice = "cryptophys-deployment-orchestrator"\nentrypoint = "DeployRpc"/);
  assert.match(readFileSync(new URL("workers/deployment-orchestrator/src/worker.ts", root), "utf8"), /export class DeployRpc extends WorkerEntrypoint/);
  for (const u of DEPLOY_UNITS) {
    const wf = readFileSync(new URL(`.github/workflows/${u.workflow}`, root), "utf8");
    const capture = wf.indexOf("worker-rollback.sh\" capture");
    const deploy = wf.indexOf("npx wrangler deploy");
    const rollback = wf.indexOf("worker-rollback.sh\" restore");
    assert.ok(capture > 0 && deploy > capture && rollback > deploy, `${u.workflow}: capture < deploy < rollback`);
    assert.match(wf, /if: always\(\) && \(failure\(\) \|\| cancelled\(\)\) && steps\.capture\.outcome == 'success'/, u.workflow);
  }
});


test("9. CI gate fails closed unless both main push validations and combined commit status are green", async () => {
  try {
    github({ omitWorkflow: "Validate" });
    assert.equal((await ciGreen("gh-token", MAIN)).green, false, "missing Validate must block");
    github({ omitWorkflow: "Validate Control Plane Workers" });
    assert.equal((await ciGreen("gh-token", MAIN)).green, false, "missing Control Plane validation must block");
    github({ statusState: "pending", statusCount: 1 });
    assert.equal((await ciGreen("gh-token", MAIN)).green, false, "pending combined status must block");
    github({ controlPlaneConclusion: "skipped" });
    assert.equal((await ciGreen("gh-token", MAIN)).green, false, "skipped validation must block");
    github();
    assert.equal((await ciGreen("gh-token", MAIN)).green, true, "complete green evidence should pass");
  } finally { globalThis.fetch = realFetch; }
});

test("10. pendingDeploys dispatches the Deployment Orchestrator before the Control Plane", async () => {
  const db = migratedDb();
  behind(db);
  try {
    github({ files: ["workers/deployment-orchestrator/src/index.ts", "workers/ai-kernel/src/consensus.ts"] });
    const pending = await pendingDeploys(orchestratorEnv(db) as never);
    assert.deepEqual(pending.units.map((u) => u.unit), ["deployment-orchestrator"]);
    assert.ok(pending.skipped.some((u) => u.unit === "control-plane" && u.reason === "deployment_orchestrator_must_complete_first"));
  } finally { globalThis.fetch = realFetch; }
});

test("11. deploy proposals: never on an operator wake; at most one per scheduled cycle; the next unit follows next cycle", async () => {
  const { env, db, memory } = kernelEnv();
  behind(db);
  db.raw.prepare("UPDATE service_registry SET desired_version = ? WHERE service_id = 'cryptophys-deployment-orchestrator'").run(MAIN.slice(0, 12));
  try {
    github({ files: ["workers/control-plane-shared/src/http.ts"] });
    const wake = await runCycle(env as never, memory, "operator");
    assert.equal(proposals(db).length, 0, "an operator wake never proposes deploys");
    assert.ok(wake.findings.some((f) => f.kind === "deploy" && f.why === "deploy proposals run in scheduled cycles only"));
    const first = await runCycle(env as never, memory, "scheduled");
    let ps = proposals(db).filter((p) => p.action === "deploy_commit");
    assert.equal(ps.length, 1);
    assert.equal(first.findings.filter((f) => f.kind === "deploy" && String(f.why ?? "").startsWith("deferred")).length, 3);
    await runCycle(env as never, memory, "scheduled");
    ps = proposals(db).filter((p) => p.action === "deploy_commit");
    assert.equal(ps.length, 2);
    assert.equal(new Set(ps.map((p) => p.target)).size, 2, "a different unit each cycle");
  } finally { globalThis.fetch = realFetch; }
});
