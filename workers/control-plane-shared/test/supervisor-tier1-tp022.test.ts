import { test } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, migratedDb, req, call, signAccessJwt } from "./harness.ts";
import { parsePolicyRequest, decide } from "../../policy-engine/src/index.ts";
import kernel from "../../ai-kernel/src/index.ts";
function kernelEnv(db: any, extra: any = {}) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const env: any = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: "ci-client.access,ops@cryptophys.work,approver@cryptophys.work", APPROVER_IDENTITIES: "approver@cryptophys.work" }),
    POLICY: { evaluate: async (input: any) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as any, p); } },
    RECOVERY: { propose: async () => ({}) },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    ...extra,
  };
  const memStore = new Map();
  const mem = { get: async (k: string) => memStore.get(k), put: async (k: string, v: any) => { memStore.set(k, v); } };
  return { env, db, mem };
}
import { KERNEL_HOST, addAgentPrincipal } from "../../ai-kernel/src/kernel.ts";
import { rpcWhoami, rpcSyscall } from "../../ai-kernel/src/agent-rpc.ts";
import { REQUIRED_MIGRATION, schemaReady } from "../src/readiness.ts";

test("TP-022 migration", async () => {
  const db = migratedDb();
  const sup = db.raw.prepare("SELECT tier_max, capabilities_json, status FROM agents WHERE agent_id='supervisor'").get() as any;
  assert.equal(sup.tier_max, 1);
  assert.equal(sup.status, "enabled");
  assert.deepEqual(JSON.parse(sup.capabilities_json), ["platform.observe", "recovery.propose", "memory.recall", "memory.remember"]);
  const anyTier2OrHigher = db.raw.prepare("SELECT COUNT(*) AS n FROM agents WHERE tier_max >= 2").get() as any;
  assert.equal(anyTier2OrHigher.n, 0, "TP-022 must leave no agent at tier 2 or above");
  assert.equal(REQUIRED_MIGRATION, "0022_register_console_and_home.sql");
  assert.equal(await schemaReady({ DB: db } as any), true);
});

test("TP-022 supervisor still works", async () => {
  // persistent drift produces recovery.propose
  const db = migratedDb();
  const t1 = new Date(Date.now() - 20 * 60_000).toISOString();
  const t2 = new Date(Date.now() - 5 * 60_000).toISOString();
  db.raw.prepare(`INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at)
    VALUES ('o1','cryptophys-platform-api','d','o',1,'{"reasons":["version_mismatch"],"desired_version":"aaaaaaaaaaaa","probe":{"version_tag":"bbbbbbbbbbbb"}}',?),
           ('o2','cryptophys-platform-api','d','o',1,'{"reasons":["version_mismatch"],"desired_version":"aaaaaaaaaaaa","probe":{"version_tag":"bbbbbbbbbbbb"}}',?)`).run(t1, t2);
  const { env, mem } = kernelEnv(db);
  const { runCycle } = await import("../../ai-kernel/src/supervisor.ts");
  const cycle = await runCycle(env as any, mem, "scheduled");
  const propose = cycle.actions.find((a: any) => a.capability === "recovery.propose");
  assert.ok(propose);
  assert.equal(propose.outcome, "succeeded");
});

test("TP-022 no principal for kernel agents", async () => {
  const db = migratedDb();
  const env: any = baseEnv("cryptophys-ai-kernel", db);
  for (const id of ["supervisor", "signal-analyst", "auditor"]) {
    const res = await addAgentPrincipal(env, id, "test@x", "approver@cryptophys.work");
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "kernel_agent_internal");
  }
  // non-kernel works
  const ok = await addAgentPrincipal(env, "platform-api", "test2@x", "approver@cryptophys.work");
  assert.equal(ok.status, 201);
});

test("TP-022 pre-existing principals for every kernel agent are ignored by MCP", async () => {
  const db = migratedDb();
  const env: any = baseEnv("cryptophys-ai-kernel", db);
  for (const [index, id] of ["supervisor", "signal-analyst", "auditor"].entries()) {
    const identity = `stale-${id}.access`;
    db.raw.prepare("INSERT INTO agent_principals (access_identity, agent_id, created_by, created_at, revoked_at) VALUES (?,?,?,?,NULL)")
      .run(identity, id, "admin", new Date().toISOString());
    const jwt = await signAccessJwt({ common_name: identity });
    const denied = await call(
      kernel,
      env,
      req("POST", "/mcp", { jsonrpc: "2.0", id: index + 1, method: "tools/list" }, jwt),
    );
    assert.equal(denied.status, 403, `${id}: stale kernel-hosted principal must not create an MCP session`);
  }
});

test("TP-022 AgentRpc refuses every kernel-hosted agent", async () => {
  const db = migratedDb();
  const env: any = baseEnv("cryptophys-ai-kernel", db);
  for (const id of ["supervisor", "signal-analyst", "auditor"]) {
    const who = await rpcWhoami(env, { host_worker: KERNEL_HOST }, id);
    assert.equal(who.error, "kernel_agent_internal", `${id}: rpcWhoami must refuse kernel-hosted agents`);
    const sys = await rpcSyscall(env, { host_worker: KERNEL_HOST }, id, "platform.observe", {});
    assert.equal(sys.reason, "kernel_agent_internal", `${id}: rpcSyscall must refuse kernel-hosted agents`);
  }
  // Positive control: a normal platform Worker can still reach its own agent.
  const normal = await rpcWhoami(baseEnv("cryptophys-platform-api", db) as any, { host_worker: "cryptophys-platform-api" }, "platform-api");
  assert.equal(normal.agent_id, "platform-api");
});

test("TP-022 tier check still applies", async () => {
  const db = migratedDb();
  // set platform-api tier_max = 2 temporarily
  db.raw.prepare("UPDATE agents SET tier_max = 2 WHERE agent_id = 'platform-api'").run();
  const env: any = baseEnv("cryptophys-platform-api", db);
  const who = await rpcWhoami(env, { host_worker: "cryptophys-platform-api" }, "platform-api");
  assert.equal(who.error, "external_tier_limit");
  const principalRes = await addAgentPrincipal(baseEnv("cryptophys-ai-kernel", db) as any, "platform-api", "tier2@x", "approver@cryptophys.work");
  assert.equal(principalRes.body.error, "external_tier_limit");
});

test("TP-022 KERNEL_HOST exported", async () => {
  assert.equal(KERNEL_HOST, "cryptophys-ai-kernel");
});
