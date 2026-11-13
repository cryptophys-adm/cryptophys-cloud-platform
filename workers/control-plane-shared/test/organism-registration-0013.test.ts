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
const DIRS = ["ai-kernel", "audit-ledger", "console", "deployment-orchestrator", "drift-detector", "forge", "forge-typecheck", "forge-typecheck-cr", "platform-api", "platform-registry", "policy-engine", "recovery-manager"];
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
  const canonical = { head: MAIN as string | null };
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const mem = new Map<string, unknown>();
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async (agentId: string, decisionId: string) => { await verifySyscallDecision(db, decisionId, agentId, "recovery.propose"); return { plan: {} }; } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    DEPLOY: { pendingDeploys: async () => ({ main_sha: null, ci_green: false, units: [], skipped: [] }) },
    // The Forge's CanonicalMainRpc: the head of canonical main in Artifacts, read at execution time.
    CANONICAL_MAIN: { mainHead: async () => ({ main_sha: canonical.head }) },
  };
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, structuredClone(v)); } };
  return { env, db, memory, canonical };
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
    registry: { "cryptophys-forge": { status: "registered", desired_version: null }, "cryptophys-home": { status: "disabled", desired_version: null } },
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
  assert.equal((await latestCensusRow({ DB: db } as never))!.status, "changes");
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
    action: "register_agent", target: "forge-steward", params: { service: "cryptophys-forge", capabilities: ["platform.observe", "memory.recall"], tier_max: 1, main_sha: MAIN },
  });
  assert.equal(r.outcome, "succeeded");
  const p = last(db);
  assert.equal(p.status, "failed");
  assert.match(p.outcome_json, /capabilities_differ_from_dna/);
  assert.equal(agentRow(db, "forge-steward"), undefined);
  const ghost = await syscall(env as never, "supervisor", "consensus.propose", { action: "register_agent", target: "ghost-agent", params: { service: "cryptophys-forge", capabilities: ["platform.observe"], tier_max: 0, main_sha: MAIN } });
  assert.equal(ghost.outcome, "succeeded");
  assert.match(last(db).outcome_json, /census_finding_missing/);
});

test("R6. a privileged agent is critical: it registers only after consensus and the owner's click", async () => {
  const { env, db, memory } = kernelEnv();
  setMode(db, "routine");
  await censusTick(db as never, repoWith(grownDna(["platform.observe", "consensus.propose"])));
  await runCycle(env as never, memory, "scheduled");
  let p = last(db);
  assert.equal(p.action, "register_privileged_agent");
  assert.equal(p.status, "shadow_passed", "critical actions reach the owner only in mode deploy or critical");
  assert.equal(agentRow(db, "forge-steward"), undefined);

  // Owner 2026-11-13: mode deploy (the mode in production) also asks for the click.
  setMode(db, "deploy");
  await runCycle(env as never, memory, "scheduled", Date.now() + 25 * 3_600_000);
  p = last(db);
  assert.equal(p.action, "register_privileged_agent");
  assert.equal(p.status, "pending_owner", p.outcome_json);
  assert.equal(agentRow(db, "forge-steward"), undefined, "nothing registers before the click");
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

test("R8. a registration cannot execute against a newer census head than the one voted on", async () => {
  const { env, db } = kernelEnv();
  setMode(db, "deploy");
  const dna = grownDna();
  await censusTick(db as never, repoWith(dna, MAIN));
  const policy = env.POLICY as { evaluate: (input: Record<string, unknown>) => Promise<any> };
  const original = policy.evaluate.bind(env.POLICY);
  let refreshed = false;
  policy.evaluate = async (input) => {
    const decision = await original(input);
    if (!refreshed && input.action === "consensus.execute" && input.resource === "register_agent:forge-steward") {
      await censusTick(db as never, repoWith(dna, "b".repeat(40)), Date.now() + CENSUS_REFRESH_MS + 1);
      refreshed = true;
    }
    return decision;
  };
  const r = await syscall(env as never, "supervisor", "consensus.propose", {
    action: "register_agent", target: "forge-steward",
    params: { service: "cryptophys-forge", capabilities: ["platform.observe", "reports.publish"], tier_max: 1, main_sha: MAIN },
  });
  assert.equal(r.outcome, "succeeded");
  assert.equal(last(db).status, "failed");
  assert.match(last(db).outcome_json, /census_head_changed/);
  assert.equal(agentRow(db, "forge-steward"), undefined);
});

test("R9. an engine registration rechecks its host after consensus and policy approval", async () => {
  const { env, db } = kernelEnv();
  setMode(db, "deploy");
  await censusTick(db as never, repoWith(grownDna()));
  const policy = env.POLICY as { evaluate: (input: Record<string, unknown>) => Promise<any> };
  const original = policy.evaluate.bind(env.POLICY);
  let disabled = false;
  policy.evaluate = async (input) => {
    const decision = await original(input);
    if (!disabled && input.action === "consensus.execute" && input.resource === "register_engine:cryptophys-forge") {
      db.raw.prepare("UPDATE service_registry SET status = 'disabled' WHERE service_id = 'cryptophys-forge'").run();
      disabled = true;
    }
    return decision;
  };
  const r = await syscall(env as never, "supervisor", "consensus.propose", {
    action: "register_engine", target: "cryptophys-forge", params: { task: "summarize_census", main_sha: MAIN },
  });
  assert.equal(r.outcome, "succeeded");
  assert.equal(last(db).status, "failed");
  assert.match(last(db).outcome_json, /host_not_active/);
  assert.equal(db.raw.prepare("SELECT 1 FROM engines WHERE service_id = 'cryptophys-forge' AND task = 'summarize_census' AND status = 'enabled'").get(), undefined);
});

test("R10. a failed registration audit rolls back the agent insert", async () => {
  const { env, db } = kernelEnv();
  setMode(db, "deploy");
  await censusTick(db as never, repoWith(grownDna()));
  db.raw.prepare(`CREATE TRIGGER fail_agent_registration_audit BEFORE INSERT ON audit_events
    WHEN NEW.event_type = 'agent.registered'
    BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END`).run();
  const r = await syscall(env as never, "supervisor", "consensus.propose", {
    action: "register_agent", target: "forge-steward",
    params: { service: "cryptophys-forge", capabilities: ["platform.observe", "reports.publish"], tier_max: 1, main_sha: MAIN },
  });
  assert.equal(r.outcome, "succeeded");
  assert.equal(last(db).status, "failed");
  assert.match(last(db).outcome_json, /simulated audit failure/);
  assert.equal(agentRow(db, "forge-steward"), undefined);
  assert.equal(db.raw.prepare("SELECT 1 FROM audit_events WHERE event_type = 'agent.registered' AND subject = 'agent:forge-steward'").get(), undefined);
});


test("R11. an invalid census cannot authorize registration even when its genome summary is present", async () => {
  const { env, db } = kernelEnv();
  setMode(db, "deploy");
  const dna = grownDna();
  await censusTick(db as never, repoWith(dna, MAIN));
  db.raw.prepare("DROP TABLE engines").run();
  await censusTick(db as never, repoWith(dna, MAIN), Date.now() + CENSUS_REFRESH_MS + 1);
  const latest = await latestCensusRow({ DB: db } as never);
  assert.equal(latest?.status, "invalid");
  assert.ok((latest?.genome.length ?? 0) > 0);
  const r = await syscall(env as never, "supervisor", "consensus.propose", {
    action: "register_agent", target: "forge-steward",
    params: { service: "cryptophys-forge", capabilities: ["platform.observe", "reports.publish"], tier_max: 1, main_sha: MAIN },
  });
  assert.equal(r.outcome, "succeeded");
  assert.equal(last(db).status, "failed");
  assert.match(last(db).outcome_json, /census_invalid/);
  assert.equal(agentRow(db, "forge-steward"), undefined);
});


test("R12. a host that becomes unavailable after consensus cannot receive a registration", async () => {
  const { env, db } = kernelEnv();
  setMode(db, "deploy");
  await censusTick(db as never, repoWith(grownDna()));
  const policy = env.POLICY as { evaluate: (input: Record<string, unknown>) => Promise<any> };
  const original = policy.evaluate.bind(env.POLICY);
  let unavailable = false;
  policy.evaluate = async (input) => {
    const decision = await original(input);
    if (!unavailable && input.action === "consensus.execute" && input.resource === "register_agent:forge-steward") {
      db.raw.prepare("UPDATE service_registry SET status = 'unavailable' WHERE service_id = 'cryptophys-forge'").run();
      unavailable = true;
    }
    return decision;
  };
  const r = await syscall(env as never, "supervisor", "consensus.propose", {
    action: "register_agent", target: "forge-steward",
    params: { service: "cryptophys-forge", capabilities: ["platform.observe", "reports.publish"], tier_max: 1, main_sha: MAIN },
  });
  assert.equal(r.outcome, "succeeded");
  assert.equal(last(db).status, "failed");
  assert.match(last(db).outcome_json, /host_not_active/);
  assert.equal(agentRow(db, "forge-steward"), undefined);
});


test("R13. the active-host SQL predicate closes the race after the precheck", async () => {
  const { env, db } = kernelEnv();
  setMode(db, "deploy");
  await censusTick(db as never, repoWith(grownDna()));
  const base = env.DB as any;
  let raced = false;
  env.DB = new Proxy(base, {
    get(target, property) {
      if (property === "batch") return async (statements: any[]) => {
        if (!raced) {
          db.raw.prepare("UPDATE service_registry SET status = 'unavailable' WHERE service_id = 'cryptophys-forge'").run();
          raced = true;
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const r = await syscall(env as never, "supervisor", "consensus.propose", {
    action: "register_agent", target: "forge-steward",
    params: { service: "cryptophys-forge", capabilities: ["platform.observe", "reports.publish"], tier_max: 1, main_sha: MAIN },
  });
  assert.equal(r.outcome, "succeeded");
  assert.equal(raced, true);
  assert.equal(last(db).status, "failed");
  assert.match(last(db).outcome_json, /host_not_active/);
  assert.equal(agentRow(db, "forge-steward"), undefined);
  assert.equal(db.raw.prepare("SELECT 1 FROM audit_events WHERE event_type = 'agent.registered' AND subject = 'agent:forge-steward'").get(), undefined);
});

test("R14. consensus rejects registration against an unavailable host before execution", () => {
  const e: Evidence = {
    agents_enabled: true, audit_valid: true, services: {}, critical_reports_24h: 0, executing_plan_targets: [], recent_same: 0,
    registry: { "cryptophys-forge": { status: "unavailable", desired_version: null } },
    agents: { "forge-steward": { status: "enabled", host_worker: "cryptophys-forge", voter: false } },
  };
  const agent = castVote("supervisor", { action: "register_agent", target: "new-agent", params: { service: "cryptophys-forge", capabilities: ["platform.observe"] }, class: "routine" } as Proposal, e);
  assert.equal(agent.vote, "reject");
  assert.match(agent.reason, /not an active registered service/);
  const engine = castVote("supervisor", { action: "register_engine", target: "cryptophys-forge", params: { task: "summarize_census" }, class: "routine" } as Proposal, e);
  assert.equal(engine.vote, "reject");
  assert.match(engine.reason, /not an active registered service/);
  const seat = castVote("supervisor", { action: "admit_voter", target: "forge-steward", params: {}, class: "critical" } as Proposal, e);
  assert.equal(seat.vote, "reject");
  assert.match(seat.reason, /not an active registered service/);
});

test("R15. a host change after voter precheck cannot admit a seat against a different Worker", async () => {
  const { env, db } = kernelEnv();
  setMode(db, "critical");
  env.VOTE_PLATFORM_API = { vote: async () => ({ voter: "platform-api", vote: "approve", reason: "test binding" }) };
  db.raw.prepare("UPDATE agents SET voter = 0 WHERE agent_id = 'platform-api'").run();
  await censusTick(db as never, repoWith(realDna()));
  const census = await latestCensusRow({ DB: db } as never);
  assert.ok(census?.findings.some((f) => f.kind === "voter_seat_requested" && f.subject === "platform-api"));

  const proposed = await syscall(env as never, "supervisor", "consensus.propose", {
    action: "admit_voter", target: "platform-api", params: { main_sha: MAIN },
  });
  assert.equal(proposed.outcome, "succeeded");
  const proposal = last(db);
  assert.equal(proposal.status, "pending_owner", proposal.outcome_json);
  assert.equal(canVote(env as never, "platform-api"), true);

  const base = env.DB as any;
  let raced = false;
  env.DB = new Proxy(base, {
    get(target, property) {
      if (property === "batch") return async (statements: any[]) => {
        if (!raced) {
          db.raw.prepare("UPDATE agents SET host_worker = 'cryptophys-forge' WHERE agent_id = 'platform-api'").run();
          raced = true;
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const result = await ownerDecide(env as never, proposal.proposal_id, "approve", APPROVER_EMAIL, "test");
  assert.equal(raced, true);
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(agentRow(db, "platform-api").host_worker, "cryptophys-forge", "the simulated concurrent host change occurred");
  assert.equal(agentRow(db, "platform-api").voter, 0, "the seat must not be admitted on a host different from the census");
  assert.equal(
    db.raw.prepare("SELECT 1 FROM audit_events WHERE event_type = 'consensus.voter_admitted' AND subject = 'agent:platform-api'").get(),
    undefined,
    "a rejected host race must not append an admission audit event",
  );
});


test("R16. registration votes fail closed for host states outside the registry schema", () => {
  const e: Evidence = {
    agents_enabled: true, audit_valid: true, services: {}, critical_reports_24h: 0, executing_plan_targets: [], recent_same: 0,
    registry: { "cryptophys-forge": { status: "active", desired_version: null } },
    agents: { "forge-steward": { status: "enabled", host_worker: "cryptophys-forge", voter: false } },
  };
  const proposals: Proposal[] = [
    { action: "register_agent", target: "new-agent", params: { service: "cryptophys-forge", capabilities: ["platform.observe"] }, class: "routine" },
    { action: "register_engine", target: "cryptophys-forge", params: { task: "summarize_census" }, class: "routine" },
    { action: "admit_voter", target: "forge-steward", params: {}, class: "critical" },
  ];
  for (const proposal of proposals) {
    const vote = castVote("supervisor", proposal, e);
    assert.equal(vote.vote, "reject", proposal.action);
    assert.match(vote.reason, /not an active registered service/);
  }
});

const STEWARD = { action: "register_agent", target: "forge-steward", params: { service: "cryptophys-forge", capabilities: ["platform.observe", "reports.publish"], tier_max: 1, main_sha: MAIN } };

test("R17. canonical main moving after the last census stops a registration, though no new census row exists (#262 blocker)", async () => {
  const { env, db, canonical } = kernelEnv();
  setMode(db, "deploy");
  await censusTick(db as never, repoWith(grownDna(), MAIN));
  // A push to main after the census tick: Artifacts main is now another commit, the census still names MAIN.
  canonical.head = "c".repeat(40);
  const r = await syscall(env as never, "supervisor", "consensus.propose", STEWARD);
  assert.equal(r.outcome, "succeeded");
  assert.equal(last(db).status, "failed");
  assert.match(last(db).outcome_json, /census_stale_main_moved/);
  assert.equal(agentRow(db, "forge-steward"), undefined, "nothing is written against a stale census");
  // The census of the new head is taken; a proposal naming it registers the agent.
  await censusTick(db as never, repoWith(grownDna(), canonical.head!), Date.now() + CENSUS_REFRESH_MS + 1);
  await syscall(env as never, "supervisor", "consensus.propose", { ...STEWARD, params: { ...STEWARD.params, main_sha: canonical.head } });
  assert.equal(last(db).status, "executed", last(db).outcome_json);
  assert.equal(agentRow(db, "forge-steward")?.status, "enabled");
});

test("R18. registration fails closed when canonical main cannot be read (no binding, an error, no head)", async () => {
  for (const variant of ["missing", "throws", "null"] as const) {
    const { env, db, canonical } = kernelEnv();
    setMode(db, "deploy");
    await censusTick(db as never, repoWith(grownDna(), MAIN));
    if (variant === "missing") delete env.CANONICAL_MAIN;
    if (variant === "throws") env.CANONICAL_MAIN = { mainHead: async () => { throw new Error("forge unreachable"); } };
    if (variant === "null") canonical.head = null;
    await syscall(env as never, "supervisor", "consensus.propose", STEWARD);
    assert.equal(last(db).status, "failed", variant);
    assert.match(last(db).outcome_json, /canonical_main_unavailable/, variant);
    assert.equal(agentRow(db, "forge-steward"), undefined, variant);
  }
});
