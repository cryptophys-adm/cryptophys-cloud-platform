// 2026-11-17 (owner "ya"): the least recently deployed unit is proposed first, so a unit last in DEPLOY_UNITS order
// (the Forge) is not starved while every merge makes the Control Plane pending again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CI_CLIENT_ID, OPERATOR_EMAIL, APPROVER_EMAIL, baseEnv, fakeAi, migratedDb } from "./harness.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { runCycle } from "../../ai-kernel/src/supervisor.ts";
import { criticalPathReason } from "../src/guard-paths.ts";

type Db = ReturnType<typeof migratedDb>;
const MAIN = "a".repeat(40);
const UNITS = [
  { unit: "control-plane", workflow: "deploy-control-plane.yml", target: "cryptophys-policy-engine", reason: "main changed the unit" },
  { unit: "console", workflow: "deploy-console.yml", target: "cryptophys-console", reason: "main changed the unit" },
  { unit: "forge", workflow: "deploy-forge.yml", target: "cryptophys-forge", reason: "main changed the unit" },
];

function kernelEnv(db: Db) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const mem = new Map<string, unknown>();
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async () => ({}) },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    DEPLOY: {
      pendingDeploys: async () => ({ main_sha: MAIN, ci_green: true, units: UNITS, skipped: [] }),
      deployForConsensus: async () => ({ dispatched: true }),
    },
  };
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, structuredClone(v)); } };
  return { env, memory };
}

function deployed(db: Db, id: string, target: string, hoursAgo: number) {
  const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES (?, 'supervisor', 'deploy_commit', ?, 'routine', '{}', '{}', 'shadow', 8, 8, 0, 1, 'allow', 'shadow_passed', '{}', ?, ?)`).run(id, target, at, at);
}
const proposedTargets = (db: Db) => (db.raw.prepare("SELECT target FROM consensus_proposals WHERE action = 'deploy_commit' AND proposal_id NOT LIKE 'cns_seed%' ORDER BY created_at, rowid").all() as any[]).map((r) => r.target);

test("DO1. with three units free to go, the one deployed longest ago is proposed first, not the first in DEPLOY_UNITS order", async () => {
  const db = migratedDb();
  // Shadow mode: proposals are recorded, nothing executes; counted as ran for the hour and order checks.
  deployed(db, "cns_seed1", "cryptophys-policy-engine", 2);
  deployed(db, "cns_seed2", "cryptophys-console", 3);
  deployed(db, "cns_seed3", "cryptophys-forge", 9);
  const { env, memory } = kernelEnv(db);
  await runCycle(env as never, memory, "scheduled", Date.now());
  assert.deepEqual(proposedTargets(db), ["cryptophys-forge"], "the Forge, deployed 9 h ago, goes before the Control Plane (2 h)");
});

test("DO2. a unit with no deploy on record goes first", async () => {
  const db = migratedDb();
  deployed(db, "cns_seed1", "cryptophys-policy-engine", 2);
  deployed(db, "cns_seed2", "cryptophys-forge", 2);
  const { env, memory } = kernelEnv(db);
  await runCycle(env as never, memory, "scheduled", Date.now());
  assert.deepEqual(proposedTargets(db), ["cryptophys-console"], "no deploy on record sorts first");
  assert.equal(criticalPathReason("workers/ai-kernel/src/supervisor.ts"), null, "a routine change");
});
