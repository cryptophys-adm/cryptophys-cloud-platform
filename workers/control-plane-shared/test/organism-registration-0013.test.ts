// ADR-0013 phase 3: self-registration. The census finds what the DNA declares but the platform does
// not run yet; the Supervisor proposes it; consensus (and, for seats and privileged agents, the
// owner's click) decides; the kernel writes the row, taking the gene from the census, never from the
// proposal. The council is data (agents.voter), seeded by migration 0041 with the founding nine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, fakeAi, migratedDb } from "./harness.ts";
import { verifySyscallDecision } from "../src/capabilities.ts";
import { VOTERS, castVote, councilSeats, forbiddenCapabilities, privilegedCapabilities, type Evidence, type Proposal } from "../src/consensus-rules.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { censusTick, CENSUS_REFRESH_MS } from "../../forge/src/census.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { runCycle } from "../../ai-kernel/src/supervisor.ts";
import { canVote, ownerDecide } from "../../ai-kernel/src/consensus.ts";
import { latestCensusRow, proposalFor } from "../../ai-kernel/src/organism.ts";
import type { ArtifactsReader, ArtifactsTreeEntry } from "../../forge/src/checks.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const DIRS = ["ai-kernel", "audit-ledger", "console", "deployment-orchestrator", "drift-detector", "forge", "forge-typecheck", "home", "platform-api", "platform-registry", "policy-engine", "recovery-manager"];
const MAIN = "a".repeat(40);

function repoWith(files: Record<string, string>, head = MAIN): ArtifactsReader {
  const trees: Record<string, ArtifactsTreeEntry[]> = {}; const blobs: Record<string, string> = {}; let n = 1;
  const id = () => (n++).toString(16).padStart(40, "e");
  function build(f: Record<string, string>): string {
    const here: Record<string, Record<string, string>> = {}; const entries: ArtifactsTreeEntry[] = [];
    for (const [p, t] of Object.entries(f)) {
      const i = p.indexOf("/");
      if (i < 0) { const h = id(); blobs[h] = t; entries.push({ name: p, type: "blob", mode: "100644", hash: h }); }
      else (here[p.slice(0, i)] ??= {})[p.slice(i + 1)] = t;
    }
    for (const [d, sub] of Object.entries(here)) entries.push({ name: d, type: "tree", mode: "40000", hash: build(sub) });
    const h = id(); trees[h] = entries; return h;
  }
  const root = build(files);
  return {
    async readCommit(h) { return h === head ? { hash: h, treeHash: root } : null; },
    async readTree(h) { return trees[h] ?? null; },
    async readBlob(h) { return h in blobs ? new Blob([blobs[h]]) : null; },
    async log() { return [{ hash: head }]; },
  };
}
const realDna = () => Object.fromEntries(DIRS.map((d) => [`workers/${d}/organism.json`, read(`workers/${d}/organism.json`)]));

/** The real DNA, with the Forge growing a new agent (and an engine). */
function grownDna(capabilities = ["platform.observe", "reports.publish"]) {
  const files = realDna();
  const forge = JSON.parse(files["workers/forge/organism.json"]);
  forge.agents = [...forge.agents, { id: "forge-steward", display_name: "Forge Steward", capabilities, tier_max: 1, voter: true }];
  forge.engines = [...forge.engines, { task: "summarize_census" }];
  files["workers/forge/organism.json"] = JSON.stringify(forge);
  return files;
}

function kernelEnv(db: Db = migratedDb()) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const mem = new Map<string, unknown>();
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async (agentId: string, decisionId: string) => { await verifySyscallDecision(db, decisionId, agentId, "recovery.propose"); return { plan: {} }; } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    DEPLOY: { pendingDeploys: async () => ({ main_sha: null, ci_green: false, units: [], skipped: [] }) },
  };
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, structuredClone(v)); } };
  return { env, db, memory };
}
const setMode = (db: Db, mode: string) => db.raw.prepare("UPDATE consensus_controls SET value = ? WHERE control = 'mode'").run(mode);
const last = (db: Db) => db.raw.prepare("SELECT * FROM consensus_proposals ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as any;
const agentRow = (db: Db, id: string) => db.raw.prepare("SELECT * FROM agents WHERE agent_id = ?").get(id) as any;

test("R1. migration 0041 seeds the founding council and the engines the DNA declares, nothing more", async () => {
  const db = migratedDb();
  const seats = (db.raw.prepare("SELECT agent_id FROM agents WHERE voter = 1 ORDER BY agent_id").all() as any[]).map((r) => r.agent_id);
  assert.deepEqual(seats, [...VOTERS].sort());
  const r = await censusTick(db as never, repoWith(realDna()), Date.parse("2026-11-09T12:00:00Z"));
  assert.equal(r.status, "consistent", JSON.stringify(db.raw.prepare("SELECT findings FROM forge_organism_census").get()));
  const engines = db.raw.prepare("SELECT COUNT(*) AS n FROM engines WHERE status = 'enabled'").get() as any;
  const declared = DIRS.reduce((n, d) => n + JSON.parse(read(`workers/${d}/organism.json`)).engines.length, 0);
  assert.equal(engines.n, declared);
});

test("R2. the census reports new engines and seats asked for or no longer asked for", async () => {
  const db = migratedDb();
  db.raw.prepare("DELETE FROM engines WHERE task = 'suggest_tags'").run();
  db.raw.prepare("UPDATE agents SET voter = 0 WHERE agent_id = 'policy-engine'").run();
  db.raw.prepare("UPDATE agents SET voter = 1 WHERE agent_id = 'signal-analyst'").run();
  db.raw.prepare("INSERT INTO engines (service_id, task, status, registered_by, created_at, updated_at) VALUES ('cryptophys-forge', 'ghost_task', 'enabled', 'test', 'x', 'x')").run();
  await censusTick(db as never, repoWith(realDna()));
  const kinds = (await latestCensusRow({ DB: db } as never))!.findings.map((f) => `${f.kind} ${f.subject}`);
  assert.deepEqual(kinds, [
    "undeclared_engine cryptophys-forge:ghost_task",
    "unregistered_engine cryptophys-platform-registry:suggest_tags",
    "voter_seat_requested policy-engine",
    "voter_seat_vacated signal-analyst",
  ]);
  const census = (await latestCensusRow({ DB: db } as never))!;
  assert.deepEqual(proposalFor(census, { kind: "unregistered_engine", subject: "cryptophys-platform-registry:suggest_tags" }), { action: "register_engine", target: "cryptophys-platform-registry", params: { task: "suggest_tags", main_sha: MAIN } });
  assert.deepEqual(proposalFor(census, { kind: "voter_seat_requested", subject: "policy-engine" }), { action: "admit_voter", target: "policy-engine", params: { main_sha: MAIN } });
  assert.equal(proposalFor(census, { kind: "voter_seat_vacated", subject: "signal-analyst" }), null, "a vacated seat is reported, never removed by an agent");
});

test("R3. vote rules: registrations carry no forbidden or hidden privileged capability, and one seat per Worker", () => {
  assert.deepEqual(forbiddenCapabilities(["platform.observe", "deploy.release", "trade.execute", "made.up"]), ["deploy.release", "trade.execute", "made.up"]);
  assert.deepEqual(privilegedCapabilities(["platform.observe", "reports.publish", "consensus.propose"]), ["consensus.propose"]);
  const e: Evidence = {
    agents_enabled: true, audit_valid: true, services: {}, critical_reports_24h: 0, executing_plan_targets: [], recent_same: 0,
    registry: { "cryptophys-forge": { status: "active", desired_version: null }, "cryptophys-home": { status: "disabled", desired_version: null } },
    agents: {
      "platform-api": { status: "enabled", host_worker: "cryptophys-platform-api", voter: true },
      "forge-steward": { status: "enabled", host_worker: "cryptophys-forge", voter: false },
      "forge-twin": { status: "enabled", host_worker: "cryptophys-forge", voter: true },
    },
  };
  const vote = (action: string, target: string, params: Record<string, unknown>) =>
    castVote("supervisor", { action, target, params, class: action === "register_agent" || action === "register_engine" ? "routine" : "critical" } as Proposal, e);
  assert.equal(vote("register_agent", "newbie", { service: "cryptophys-forge", capabilities: ["platform.observe"] }).vote, "approve");
  assert.match(vote("register_agent", "newbie", { service: "cryptophys-forge", capabilities: ["consensus.propose"] }).reason, /register_privileged_agent/);
  assert.equal(vote("register_privileged_agent", "newbie", { service: "cryptophys-forge", capabilities: ["consensus.propose"] }).vote, "approve");
  assert.match(vote("register_privileged_agent", "newbie", { service: "cryptophys-forge", capabilities: ["secrets.rotate"] }).reason, /prohibited/);
  assert.match(vote("register_agent", "newbie", { service: "cryptophys-home", capabilities: [] }).reason, /not an active registered service/);
  assert.match(vote("register_agent", "platform-api", { service: "cryptophys-forge", capabilities: [] }).reason, /already registered/);
  assert.match(vote("register_engine", "cryptophys-forge", { task: "Bad Task" }).reason, /lowercase/);
  assert.match(vote("admit_voter", "forge-steward", {}).reason, /one seat per Worker: forge-twin/);
  assert.match(vote("admit_voter", "platform-api", {}).reason, /already holds a seat/);
  // A seat admitted after the founders applies the shared rules, then has no objection.
  assert.equal(castVote("forge-twin", { action: "observe_drift", target: "cryptophys-forge", params: {}, class: "routine" }, e).vote, "approve");
  assert.deepEqual(councilSeats(e), ["forge-twin", "platform-api"]);
});

test("R4. a new agent and engine in the DNA register themselves by consensus; the seat waits for the owner and needs a vote binding", async () => {
  const { env, db, memory } = kernelEnv();
  setMode(db, "deploy");
  const t0 = Date.now();
  await censusTick(db as never, repoWith(grownDna()), t0);
  assert.deepEqual((await latestCensusRow({ DB: db } as never))!.findings.map((f) => f.kind), ["unregistered_agent", "unregistered_engine"]);

  await runCycle(env as never, memory, "scheduled", t0);
  let p = last(db);
  assert.equal(p.action, "register_agent");
  assert.equal(p.status, "executed", p.outcome_json);
  const a = agentRow(db, "forge-steward");
  assert.equal(a.host_worker, "cryptophys-forge");
  assert.equal(a.voter, 0, "registration never grants a seat");
  assert.equal(a.updated_by, `consensus:${p.proposal_id}`);
  assert.deepEqual(JSON.parse(a.capabilities_json), ["platform.observe", "reports.publish"]);
  assert.ok(db.raw.prepare("SELECT 1 FROM audit_events WHERE event_type = 'agent.registered' AND subject = 'agent:forge-steward'").get());

  await runCycle(env as never, memory, "scheduled", t0);
  p = last(db);
  assert.equal(p.action, "register_engine");
  assert.equal(p.status, "executed", p.outcome_json);
  assert.ok(db.raw.prepare("SELECT 1 FROM engines WHERE service_id = 'cryptophys-forge' AND task = 'summarize_census' AND status = 'enabled'").get());

  // The census of the same head is retaken; what is now live drops out, the seat request remains.
  const r = await censusTick(db as never, repoWith(grownDna()), t0 + CENSUS_REFRESH_MS + 1);
  assert.equal(r.outcome, "refreshed");
  assert.deepEqual((await latestCensusRow({ DB: db } as never))!.findings.map((f) => `${f.kind} ${f.subject}`), ["voter_seat_requested forge-steward"]);

  setMode(db, "critical");
  await runCycle(env as never, memory, "scheduled", t0);
  p = last(db);
  assert.equal(p.action, "admit_voter");
  assert.equal(p.status, "pending_owner", p.outcome_json);
  // Without a reviewed vote binding the seat is refused even after the owner's click.
  assert.equal(canVote(env as never, "forge-steward"), false);
  const out = await ownerDecide(env as never, p.proposal_id, "approve", APPROVER_EMAIL, "test");
  assert.equal(out.status, "failed");
  assert.match(JSON.stringify(out.outcome), /no_vote_binding/);
  assert.equal(agentRow(db, "forge-steward").voter, 0);
});

test("R5. the executor takes the gene from the census: a proposal that differs from the DNA fails", async () => {
  const { env, db } = kernelEnv();
  setMode(db, "deploy");
  await censusTick(db as never, repoWith(grownDna()));
  const r = await syscall(env as never, "supervisor", "consensus.propose", {
    action: "register_agent", target: "forge-steward", params: { service: "cryptophys-forge", capabilities: ["platform.observe", "memory.recall"], tier_max: 1 },
  });
  assert.equal(r.outcome, "succeeded");
  const p = last(db);
  assert.equal(p.status, "failed");
  assert.match(p.outcome_json, /capabilities_differ_from_dna/);
  assert.equal(agentRow(db, "forge-steward"), undefined);
  const ghost = await syscall(env as never, "supervisor", "consensus.propose", { action: "register_agent", target: "ghost-agent", params: { service: "cryptophys-forge", capabilities: ["platform.observe"], tier_max: 0 } });
  assert.equal(ghost.outcome, "succeeded");
  assert.match(last(db).outcome_json, /agent_not_in_dna/);
});

test("R6. a privileged agent is critical: it registers only after consensus and the owner's click", async () => {
  const { env, db, memory } = kernelEnv();
  setMode(db, "deploy");
  await censusTick(db as never, repoWith(grownDna(["platform.observe", "consensus.propose"])));
  await runCycle(env as never, memory, "scheduled");
  let p = last(db);
  assert.equal(p.action, "register_privileged_agent");
  assert.equal(p.status, "shadow_passed", "critical actions reach the owner only in mode critical");
  assert.equal(agentRow(db, "forge-steward"), undefined);

  setMode(db, "critical");
  await runCycle(env as never, memory, "scheduled", Date.now() + 25 * 3_600_000);
  p = last(db);
  assert.equal(p.action, "register_privileged_agent");
  assert.equal(p.status, "pending_owner", p.outcome_json);
  const out = await ownerDecide(env as never, p.proposal_id, "approve", APPROVER_EMAIL, "test");
  assert.equal(out.status, "executed", JSON.stringify(out));
  assert.match(agentRow(db, "forge-steward").updated_by, new RegExp(`^owner:${APPROVER_EMAIL.replace(/[.]/g, "\\.")} via consensus:`));
});

test("R7. the council is read from admitted seats; a seat without a vote binding abstains instead of the kernel voting for it", async () => {
  const { env, db } = kernelEnv();
  setMode(db, "deploy");
  db.raw.prepare("UPDATE agents SET voter = 0 WHERE agent_id = 'recovery-manager'").run();
  db.raw.prepare("UPDATE agents SET voter = 1 WHERE agent_id = 'signal-analyst'").run();
  const r = await syscall(env as never, "supervisor", "consensus.propose", { action: "observe_drift", target: "cryptophys-platform-api", params: {} });
  assert.equal(r.outcome, "succeeded");
  const p = last(db);
  const votes = db.raw.prepare("SELECT voter_agent_id, vote, reason FROM consensus_votes WHERE proposal_id = ? ORDER BY voter_agent_id").all(p.proposal_id) as any[];
  const ids = votes.map((v) => v.voter_agent_id);
  assert.ok(!ids.includes("recovery-manager"), "a vacated seat does not vote");
  assert.ok(!ids.includes("supervisor"), "the proposer does not vote");
  const sa = votes.find((v) => v.voter_agent_id === "signal-analyst");
  assert.equal(sa.vote, "abstain");
  assert.match(sa.reason, /no vote binding/);
  assert.equal(p.eligible, 8);
});
