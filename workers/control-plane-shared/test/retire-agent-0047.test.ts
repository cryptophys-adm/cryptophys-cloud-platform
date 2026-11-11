// Owner 2026-11-11: "hardening juga untuk dismantle dan delete agent yang sudah tidak berkontribusi".
// Migration 0047 dismantles the seven idle agents; retire_agent and the Supervisor's idle rule do it from now on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, fakeAi, fakeWorkflow, migratedDb } from "./harness.ts";
import { verifySyscallDecision } from "../src/capabilities.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { proposeFromAgent } from "../../recovery-manager/src/index.ts";
import { runCycle } from "../../ai-kernel/src/supervisor.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { RETIRE_IDLE_DAYS } from "../src/consensus-rules.ts";

const MIGRATIONS = new URL("../../control-plane-migrations/", import.meta.url);
const DISMANTLED = ["signal-engine", "xauusd-news-analyst", "xauusd-technical-analyst", "hud-gabfx-price-action", "hud-grid-bot-protocol", "hud-playbook-execution", "hud-r37-funnel"];

function kernelEnv(db = migratedDb()) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const recoveryEnv = { ...baseEnv("cryptophys-recovery-manager", db), RECOVERY_LIFECYCLE: fakeWorkflow().binding };
  const mem = new Map<string, unknown>();
  const env = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async (a: string, d: string, i: Record<string, unknown>) => { await verifySyscallDecision(db, d, a, "recovery.propose"); return proposeFromAgent(recoveryEnv as never, a, i); } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
  };
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, structuredClone(v)); } };
  return { env, db, memory };
}

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
function addAgent(db: ReturnType<typeof migratedDb>, id: string, { host = "cryptophys-audit-ledger", createdDaysAgo = RETIRE_IDLE_DAYS + 6, voter = 0 } = {}) {
  db.raw.prepare(`INSERT INTO agents (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at, voter)
    VALUES (?, ?, ?, 'test agent', 1, '["reports.publish"]', 'enabled', NULL, 'test', ?, ?, ?)`).run(id, id, host, daysAgo(createdDaysAgo), daysAgo(createdDaysAgo), voter);
}
const act = (db: ReturnType<typeof migratedDb>, id: string, at: string) => db.raw.prepare(`INSERT INTO agent_actions (action_id, agent_id, capability, tier, decision_id, outcome, input_json, result_json, created_at) VALUES (?, ?, 'reports.publish', 1, NULL, 'succeeded', '{}', '{}', ?)`).run(`act_${id}_${at}`, id, at);
const agent = (db: ReturnType<typeof migratedDb>, id: string) => db.raw.prepare("SELECT status, status_reason FROM agents WHERE agent_id = ?").get(id) as any;
const setMode = (db: ReturnType<typeof migratedDb>, mode: string) => db.raw.prepare("UPDATE consensus_controls SET value = ? WHERE control = 'mode'").run(mode);
const retireProposals = (db: ReturnType<typeof migratedDb>) => db.raw.prepare("SELECT target, status, outcome_json FROM consensus_proposals WHERE action = 'retire_agent' ORDER BY rowid").all() as any[];

test("A1. 0047 and 0048 dismantle the nine idle agents and keep the Aether agents and the active XAUUSD agents", () => {
  const db = migratedDb();
  for (const id of [...DISMANTLED, "xauusd-analyst", "xauusd-counselor"]) assert.equal(agent(db, id), undefined, id);
  for (const id of ["xauusd-reasoner", "xauusd-risk-manager", "xauusd-moderator", "hud-prophet", "aether-curator", "aether-calibrator"]) assert.equal(agent(db, id)?.status, "enabled", id);
});

test("A2. 0047 never deletes an agent that any row refers to", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files.filter((f) => f < "0047")) raw.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  raw.prepare(`INSERT INTO agent_actions (action_id, agent_id, capability, tier, decision_id, outcome, input_json, result_json, created_at) VALUES ('act_x', 'hud-r37-funnel', 'reports.publish', 1, NULL, 'succeeded', '{}', '{}', '2026-11-10T00:00:00.000Z')`).run();
  raw.exec(readFileSync(new URL(files.find((f) => f.startsWith("0047"))!, MIGRATIONS), "utf8"));
  const left = (raw.prepare(`SELECT agent_id FROM agents WHERE agent_id IN (${DISMANTLED.map(() => "?").join(", ")})`).all(...DISMANTLED) as any[]).map((r) => r.agent_id);
  assert.deepEqual(left, ["hud-r37-funnel"]);
});

test("A3. retire_agent by consensus: an agent nothing refers to is deleted and audited; one with history is kept, suspended as retired", async () => {
  const { env, db } = kernelEnv();
  setMode(db, "routine");
  addAgent(db, "idle-helper");
  addAgent(db, "busy-helper");
  act(db, "busy-helper", daysAgo(30));
  await syscall(env as never, "supervisor", "consensus.propose", { action: "retire_agent", target: "idle-helper", params: { reason: "idle" } });
  await syscall(env as never, "supervisor", "consensus.propose", { action: "retire_agent", target: "busy-helper", params: { reason: "idle" } });
  const [a, b] = retireProposals(db);
  assert.equal(a.status, "executed", a.outcome_json);
  assert.equal(agent(db, "idle-helper"), undefined, "deleted");
  assert.equal(b.status, "executed", b.outcome_json);
  assert.equal(agent(db, "busy-helper").status, "suspended");
  assert.match(agent(db, "busy-helper").status_reason, /^retired: /);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE agent_id = 'busy-helper'").get() as any).n, 1, "its history stays");
  const events = (db.raw.prepare("SELECT event_type, outcome FROM audit_events WHERE event_type IN ('agent.retired', 'agent.suspended') ORDER BY rowid").all() as any[]).map((e) => `${e.event_type}:${e.outcome}`);
  assert.deepEqual(events, ["agent.retired:deleted", "agent.suspended:suspended"]);
  assert.equal((await verifyAuditChain(db as never)).valid, true);
});

test("A4. kernel agents, council seats and agents of the exempt hosts are never retired (the vote and the executor both refuse)", async () => {
  const { env, db } = kernelEnv();
  setMode(db, "routine");
  addAgent(db, "seat-helper", { voter: 1 });
  for (const target of ["supervisor", "seat-helper", "hud-prophet", "aether-curator"]) {
    await syscall(env as never, "supervisor", "consensus.propose", { action: "retire_agent", target, params: { reason: "test" } });
  }
  assert.ok(retireProposals(db).every((p) => p.status !== "executed"), JSON.stringify(retireProposals(db)));
  for (const id of ["supervisor", "seat-helper", "hud-prophet", "aether-curator"]) assert.equal(agent(db, id)?.status, "enabled", id);
});

test("A5. the Supervisor proposes one idle agent per cycle, at most once a week; active, young and exempt agents are not proposed", async () => {
  const { env, db, memory } = kernelEnv();
  addAgent(db, "idle-helper");
  addAgent(db, "young-helper", { createdDaysAgo: RETIRE_IDLE_DAYS - 2 });
  addAgent(db, "active-helper");
  act(db, "active-helper", daysAgo(1));
  await runCycle(env as never, memory, "scheduled");
  let ps = retireProposals(db);
  assert.deepEqual(ps.map((p) => p.target), ["idle-helper"]);
  assert.equal(ps[0].status, "shadow_passed", "shadow mode only records it");
  assert.equal(agent(db, "idle-helper").status, "enabled");
  await runCycle(env as never, memory, "scheduled");
  ps = retireProposals(db);
  assert.equal(ps.length, 1, "not proposed again within a week");
  await runCycle(env as never, memory, "operator");
  assert.equal(retireProposals(db).length, 1, "operator wakes never propose");
});
