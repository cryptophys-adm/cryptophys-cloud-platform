// Two owner decisions of 2026-11-14.
//  A. "naikan batas kapabilitas aether": Aether's external ceiling is exactly what its five agents hold today, no
//     more (organism.ts AETHER_CEILING); xauusd keeps EXTERNAL_CEILING. The census reads Aether's DNA over
//     EXT_ORGANISM_AETHER (cryptophys-aether OrganismDna.dna()), like xauusd's.
//  B. "jangan pensiun aether calibrator karena cara kerjanya memang idle sampai jadwalnya kerja": an agent may declare
//     a schedule in its DNA; the Supervisor judges its idleness against it (agent-idle.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, fakeAi, migratedDb } from "./harness.ts";
import { verifySyscallDecision } from "../src/capabilities.ts";
import { castVote, RETIRE_IDLE_DAYS, type Evidence, type Proposal } from "../src/consensus-rules.ts";
import { DOCTRINE_ACTIONS } from "../src/doctrine.ts";
import {
  AETHER_CEILING, EXTERNAL_CEILING, EXTERNAL_ORIGINS, externalCeilingFor, externalCeilingViolations, externalOrgans, externalProposalRefusal,
  parseDna, schedulePeriodMs,
} from "../src/organism.ts";
import { SCHEDULE_IDLE_RUNS, SCHEDULED_IDLE_REASON, idleWindowMs, isIdle } from "../src/agent-idle.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { addExternalOrgans, censusTick, type ExternalDnaReader } from "../../forge/src/census.ts";
import { externalReaders } from "../../forge/src/tick.ts";
import { latestCensusRow } from "../../ai-kernel/src/organism.ts";
import { rpcSyscall } from "../../ai-kernel/src/agent-rpc.ts";
import { runCycle } from "../../ai-kernel/src/supervisor.ts";
import type { ArtifactsReader, ArtifactsTreeEntry } from "../../forge/src/checks.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const DIRS = ["ai-kernel", "audit-ledger", "console", "deployment-orchestrator", "drift-detector", "forge", "forge-typecheck", "forge-typecheck-cr", "platform-api", "platform-registry", "policy-engine", "recovery-manager"];
const MAIN = "d".repeat(40);
const AETHER = EXTERNAL_ORIGINS.find((o) => o.origin === "aether")!;
const XAUUSD = EXTERNAL_ORIGINS.find((o) => o.origin === "xauusd")!;
const HOST = "cryptophys-aether";
const DAY = 86_400_000;

/** Aether's five agents as its DNA declares them (cryptophys-aether organism.json at 86035d5). */
const AETHER_AGENTS = [
  { id: "aether-guardian", display_name: "Aether Guardian", capabilities: ["signals.observe", "reports.publish"], tier_max: 1, voter: false },
  { id: "aether-auditor", display_name: "Aether Auditor", capabilities: ["signals.observe", "reports.publish"], tier_max: 1, voter: false },
  { id: "aether-curator", display_name: "Aether Curator", capabilities: ["reports.publish", "knowledge.propose", "knowledge.status"], tier_max: 1, voter: false },
  { id: "aether-calibrator", display_name: "Aether Calibrator", capabilities: ["reports.publish", "knowledge.propose", "knowledge.status"], tier_max: 1, voter: false },
  { id: "knowledge-council", display_name: "Knowledge Council", capabilities: ["consensus.propose", "doctrine.status", "reports.publish"], tier_max: 1, voter: false },
];
const aetherOrgan = (agents: unknown[] = AETHER_AGENTS) => ({
  $schema_version: 1, service: HOST, display_name: "Aether", kind: "service", deploy_unit: null, access: false, rollback: false,
  drift: { via: "rpc", binding: "EXT_AETHER" }, agents, engines: [{ task: "embed_texts" }],
});
const aetherDna = (agents?: unknown[]) => ({ schema: "aether-organism.v1", organs: [aetherOrgan(agents)] });
const withCaps = (id: string, capabilities: string[], extra: Record<string, unknown> = {}) => ({ ...AETHER_AGENTS.find((a) => a.id === id)!, capabilities, ...extra });

function repoWith(files: Record<string, string>, head = MAIN): ArtifactsReader {
  const trees: Record<string, ArtifactsTreeEntry[]> = {}; const blobs: Record<string, string> = {}; let n = 1;
  const id = () => (n++).toString(16).padStart(40, "f");
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

function kernelEnv(db: Db) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const mem = new Map<string, unknown>();
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async (agentId: string, decisionId: string) => { await verifySyscallDecision(db, decisionId, agentId, "recovery.propose"); return { plan: {} }; } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    DEPLOY: { pendingDeploys: async () => ({ main_sha: null, ci_green: false, units: [], skipped: [] }) },
    CANONICAL_MAIN: { mainHead: async () => ({ main_sha: MAIN }) },
  };
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, structuredClone(v)); } };
  return { env, memory };
}

// ------------------------------------------------------------------------------------------- A. the ceiling

test("AC1. Aether's ceiling is exactly what its agents hold today: the registered grants (0027, 0029, 0045) and its DNA", () => {
  const db = migratedDb();
  const rows = db.raw.prepare("SELECT agent_id, tier_max, voter, capabilities_json FROM agents WHERE host_worker = ? ORDER BY agent_id").all(HOST) as any[];
  assert.deepEqual(rows.map((r) => r.agent_id), Object.keys(AETHER_CEILING.agents).sort(), "one ceiling entry per registered Aether agent, no more");
  for (const r of rows) {
    assert.deepEqual(JSON.parse(r.capabilities_json).sort(), [...AETHER_CEILING.agents[r.agent_id]].sort(), `${r.agent_id}: ceiling = registered grants`);
    assert.deepEqual([r.tier_max, r.voter], [AETHER_CEILING.tier_max, 0]);
  }
  for (const a of AETHER_AGENTS) assert.deepEqual([...a.capabilities].sort(), [...AETHER_CEILING.agents[a.id]].sort(), `${a.id}: ceiling = DNA`);
  // knowledge-council proposes the two doctrine actions, exactly the kernel's restriction (consensus.ts propose).
  assert.deepEqual(Object.keys(AETHER_CEILING.proposals), ["knowledge-council"]);
  assert.deepEqual([...AETHER_CEILING.proposals["knowledge-council"]].sort(), [...DOCTRINE_ACTIONS].sort());
  // The union holds nothing beyond today's grants: no memory, trading, deploy, merge, fund or seat.
  const union = [...new Set(Object.values(AETHER_CEILING.agents).flat())].sort();
  assert.deepEqual(union, ["consensus.propose", "doctrine.status", "knowledge.propose", "knowledge.status", "reports.publish", "signals.observe"]);
  // Aether's DNA as served passes whole.
  const { organs, refused } = externalOrgans(AETHER, aetherDna());
  assert.deepEqual(refused, []);
  assert.deepEqual(organs[0].agents.map((a) => a.id), AETHER_AGENTS.map((a) => a.id));
});

test("AC2. one step beyond today's grants is refused", () => {
  const over = (gene: Record<string, unknown>) => externalCeilingViolations(gene as never, AETHER);
  assert.deepEqual(over(withCaps("aether-curator", ["reports.publish", "knowledge.propose", "knowledge.status", "memory.remember"])), ["capability memory.remember"]);
  assert.deepEqual(over(withCaps("aether-guardian", ["signals.observe", "reports.publish", "knowledge.propose"])), ["capability knowledge.propose"]);
  assert.deepEqual(over(withCaps("aether-calibrator", ["reports.publish", "knowledge.propose", "knowledge.status", "doctrine.status"])), ["capability doctrine.status"]);
  assert.deepEqual(over(withCaps("aether-curator", ["reports.publish", "consensus.propose"])), ["capability consensus.propose"], "only the council proposes");
  for (const cap of ["deploy.commit", "change.merge", "platform.observe", "recovery.propose", "memory.recall", "trading.execute"]) {
    assert.deepEqual(over(withCaps("knowledge-council", ["consensus.propose", "doctrine.status", "reports.publish", cap])), [`capability ${cap}`], cap);
  }
  assert.deepEqual(over(withCaps("knowledge-council", ["consensus.propose"], { tier_max: 2, voter: true })), ["tier_max 2", "council seat"]);
  // An Aether agent the ceiling does not name: what both ceilings allow, nothing more.
  assert.deepEqual(over({ id: "aether-new", tier_max: 1, voter: false, capabilities: ["signals.observe", "reports.publish"] }), []);
  assert.deepEqual(over({ id: "aether-new", tier_max: 1, voter: false, capabilities: ["knowledge.propose", "memory.recall"] }), ["capability knowledge.propose", "capability memory.recall"]);
  // knowledge-council's consensus.propose: the doctrine actions only.
  for (const action of DOCTRINE_ACTIONS) assert.equal(externalProposalRefusal(AETHER, "knowledge-council", action), null, action);
  for (const action of ["merge_change", "merge_owner_change", "deploy_commit", "retire_agent", "register_agent", "set_policy_parameter", "change_access"]) {
    assert.match(String(externalProposalRefusal(AETHER, "knowledge-council", action)), /above the aether ceiling/, action);
  }
  assert.match(String(externalProposalRefusal(AETHER, "aether-curator", "amend_doctrine")), /consensus\.propose is above/);
  // In the census: the agent above the ceiling is left out, its four peers pass.
  const { organs, refused } = externalOrgans(AETHER, aetherDna([...AETHER_AGENTS.filter((a) => a.id !== "aether-curator"), withCaps("aether-curator", ["reports.publish", "memory.remember"])]));
  assert.deepEqual(refused.map((r) => `${r.kind} ${r.subject}`), ["external_agent_refused aether-curator"]);
  assert.equal(organs[0].agents.length, 4);
});

test("AC3. xauusd's ceiling is unchanged; Aether's per-agent grants do not leak to it", () => {
  assert.deepEqual(EXTERNAL_CEILING, { tier_max: 1, capabilities: ["signals.observe", "reports.publish", "memory.recall", "memory.remember"] });
  assert.equal(XAUUSD.ceiling, undefined);
  for (const id of [undefined, "hud-prophet", "knowledge-council", "aether-curator"]) {
    assert.deepEqual(externalCeilingFor(XAUUSD, id), { tier_max: 1, capabilities: EXTERNAL_CEILING.capabilities, proposals: [] }, String(id));
  }
  const xau = (id: string, capabilities: string[]) => externalCeilingViolations({ id, tier_max: 1, voter: false, capabilities }, XAUUSD);
  assert.deepEqual(xau("hud-x", [...EXTERNAL_CEILING.capabilities]), []);
  assert.deepEqual(xau("knowledge-council", ["consensus.propose", "doctrine.status"]), ["capability consensus.propose", "capability doctrine.status"]);
  assert.deepEqual(xau("aether-curator", ["knowledge.propose"]), ["capability knowledge.propose"]);
  assert.match(String(externalProposalRefusal(XAUUSD, "knowledge-council", "amend_doctrine")), /consensus\.propose is above the xauusd ceiling/);
  // Without an origin (as before): EXTERNAL_CEILING.
  assert.deepEqual(externalCeilingViolations({ id: "knowledge-council", tier_max: 1, capabilities: ["consensus.propose"] }), ["capability consensus.propose"]);
});

test("AC4. the vote holds each origin to its own ceiling; Aether's council registers only as privileged (the owner's click)", () => {
  const e: Evidence = {
    agents_enabled: true, audit_valid: true, services: {}, critical_reports_24h: 0, executing_plan_targets: [], recent_same: 0,
    registry: { [HOST]: { status: "healthy", desired_version: null }, "xauusd-ai-trading-assistant": { status: "healthy", desired_version: null } }, agents: {},
  };
  const vote = (action: string, target: string, service: string, capabilities: string[]) =>
    castVote("policy-engine", { action, target, params: { service, capabilities, tier_max: 1 }, class: action === "register_agent" ? "routine" : "critical" } as Proposal, e);
  const council = ["consensus.propose", "doctrine.status", "reports.publish"];
  assert.equal(vote("register_privileged_agent", "knowledge-council", HOST, council).vote, "approve");
  assert.match(vote("register_agent", "knowledge-council", HOST, council).reason, /privileged capabilities need register_privileged_agent/);
  assert.match(vote("register_privileged_agent", "knowledge-council", HOST, [...council, "deploy.commit"]).reason, /unknown or prohibited|external-organ ceiling/);
  assert.match(vote("register_privileged_agent", "aether-curator", HOST, ["reports.publish", "consensus.propose"]).reason, /external-organ ceiling: capability consensus\.propose/);
  assert.equal(vote("register_agent", "aether-calibrator", HOST, ["reports.publish", "knowledge.propose", "knowledge.status"]).vote, "approve");
  assert.match(vote("register_agent", "aether-calibrator", HOST, ["reports.publish", "memory.remember"]).reason, /external-organ ceiling: capability memory\.remember/);
  assert.match(vote("register_privileged_agent", "knowledge-council", "xauusd-ai-trading-assistant", council).reason, /external-organ ceiling/);
  assert.match(vote("register_privileged_agent", "hud-x", "xauusd-ai-trading-assistant", ["reports.publish"]).reason, /privileged registration/);
});

test("AC5. over AgentRpc, the Knowledge Council proposes only doctrine actions", async () => {
  const db = migratedDb();
  const { env } = kernelEnv(db);
  const count = () => (db.raw.prepare("SELECT COUNT(*) AS n FROM consensus_proposals WHERE proposer_agent_id = 'knowledge-council'").get() as any).n;
  for (const action of ["merge_change", "deploy_commit", "retire_agent"]) {
    const r = await rpcSyscall(env as never, { host_worker: HOST }, "knowledge-council", "consensus.propose", { action, target: "cryptophys-forge", params: {} }) as any;
    assert.equal(r.outcome, "denied", action);
    assert.match(r.reason, /^external_ceiling: .*above the aether ceiling/, action);
  }
  assert.equal(count(), 0, "refused before any vote");
  const ok = await rpcSyscall(env as never, { host_worker: HOST }, "knowledge-council", "consensus.propose", {
    action: "amend_doctrine", target: "engine-thresholds",
    params: { rule: "engine_thresholds", values: { "decision.quorum_min": 0.55 }, previous: { "decision.quorum_min": 0.5 }, canon: "0123456789ab", session: "kc_20261114-0352", seats: { nexus: "agree", aether: "agree" } },
  }) as any;
  assert.equal(ok.outcome, "succeeded", JSON.stringify(ok));
  assert.equal(count(), 1, "the doctrine action reaches consensus as before");
});

test("AC6. EXTERNAL_ORIGINS includes Aether over EXT_ORGANISM_AETHER, bound in the Forge like xauusd's", () => {
  assert.deepEqual(EXTERNAL_ORIGINS.map((o) => o.origin), ["xauusd", "aether"]);
  assert.deepEqual({ ...AETHER, ceiling: undefined }, { origin: "aether", schema: "aether-organism.v1", binding: "EXT_ORGANISM_AETHER", services: [HOST], ceiling: undefined });
  assert.match(read("workers/forge/wrangler.toml"), /binding = "EXT_ORGANISM_AETHER"\nservice = "cryptophys-aether"\nentrypoint = "OrganismDna"/);
  const dna = async () => aetherDna();
  assert.deepEqual(externalReaders({ DB: {}, EXT_ORGANISM_AETHER: { dna } } as never).map((r) => r.origin.origin), ["aether"]);
  assert.deepEqual(externalReaders({ DB: {}, EXT_ORGANISM_XAUUSD: { dna }, EXT_ORGANISM_AETHER: { dna } } as never).map((r) => r.origin.origin), ["xauusd", "aether"]);
});

test("AC7. Aether's DNA unreachable is a finding: the census completes, and no Aether agent reads as undeclared", async () => {
  const db = migratedDb();
  const readers: ExternalDnaReader[] = [{ origin: AETHER, dna: () => Promise.reject(new Error("Worker cryptophys-aether has no entrypoint OrganismDna")) }];
  const r = await censusTick(db as never, repoWith(realDna()), Date.now(), readers);
  assert.equal(r.status, "changes");
  const census = (await latestCensusRow({ DB: db } as never))!;
  assert.deepEqual(census.findings.map((f) => `${f.kind} ${f.subject}`), ["external_dna_unavailable aether"]);
  assert.ok(!census.findings.some((f) => f.kind === "undeclared_agent"), "absent DNA never reads as five dismantled agents");
  assert.equal(census.genome.some((o) => o.service === HOST), false);
  for (const bad of [async () => ({ schema: "xauusd-organism.v1", organs: [] }), async () => null]) {
    const out = await addExternalOrgans(new Map(), [{ origin: AETHER, dna: bad }]);
    assert.deepEqual(out.findings.map((f) => `${f.kind} ${f.subject}`), ["external_dna_unavailable aether"]);
  }
});

test("AC8. Aether's DNA read: its five agents match their registrations; the organ carries origin aether", async () => {
  const db = migratedDb();
  await censusTick(db as never, repoWith(realDna()), Date.now(), [{ origin: AETHER, dna: async () => aetherDna() }]);
  const census = (await latestCensusRow({ DB: db } as never))!;
  const organ = census.genome.find((o) => o.service === HOST)!;
  assert.equal(organ.origin, "aether");
  assert.equal(organ.agents.length, 5);
  const aetherFindings = census.findings.filter((f) => AETHER_AGENTS.some((a) => f.subject === a.id));
  assert.deepEqual(aetherFindings, [], "no agent change, refusal or registration for today's Aether agents");
  // Its one AI task is new to the registry: the census asks for it as for any organ (register_engine, routine consensus).
  assert.deepEqual(census.findings.map((f) => `${f.kind} ${f.subject}`), [`unregistered_engine ${HOST}:embed_texts`]);
});

// ----------------------------------------------------------------------------------------- B. schedules

test("AS1. the DNA schedule: { cron } in a small cron subset, validated by parseDna", () => {
  const dna = (schedule: unknown) => JSON.stringify({ ...aetherOrgan([{ ...AETHER_AGENTS[3], schedule }]) });
  assert.deepEqual(parseDna(dna({ cron: "52 2 * * *" })).agents[0].schedule, { cron: "52 2 * * *" });
  for (const bad of [{ cron: "*/5 * * * *" }, { cron: "52 2 * * 1-5" }, { cron: "52 2 1 * 1" }, { cron: "52 * 1 * *" }, { cron: "52 2 29 * *" }, { cron: "52 24 * * *" },
    { cron: "52 2 * 1 *" }, { cron: "52 2 * * *", cadence_hours: 24 }, { cadence_hours: 24 }, "52 2 * * *", [], null]) {
    assert.throws(() => parseDna(dna(bad)), /aether-calibrator: schedule/, JSON.stringify(bad));
  }
  const H = 3_600_000;
  assert.equal(schedulePeriodMs("52 * * * *"), H);
  assert.equal(schedulePeriodMs("52 2 * * *"), 24 * H);
  assert.equal(schedulePeriodMs("0 6 * * 1"), 7 * 24 * H);
  assert.equal(schedulePeriodMs("0 6 1 * *"), 31 * 24 * H);
  // The external organ carries it into the census genome.
  const { organs } = externalOrgans(AETHER, { schema: "aether-organism.v1", organs: [aetherOrgan([{ ...AETHER_AGENTS[3], schedule: { cron: "52 2 * * *" } }])] });
  assert.deepEqual(organs[0].agents[0].schedule, { cron: "52 2 * * *" });
});

test("AS2. the idle rule: N = 3 expected runs, never sooner than the fixed window; no schedule keeps the fixed window", () => {
  assert.equal(SCHEDULE_IDLE_RUNS, 3);
  assert.equal(RETIRE_IDLE_DAYS, 14);
  const now = Date.parse("2026-11-14T12:00:00.000Z");
  const daily = { cron: "52 2 * * *" }, weekly = { cron: "52 2 * * 1" }, monthly = { cron: "52 2 1 * *" };
  assert.equal(idleWindowMs(undefined), 14 * DAY);
  assert.equal(idleWindowMs(daily), 14 * DAY, "three silent daily runs are not enough to dismantle it");
  assert.equal(idleWindowMs(weekly), 21 * DAY);
  assert.equal(idleWindowMs(monthly), 93 * DAY);
  const agent = (silentDays: number, schedule?: { cron: string }) => ({ createdAtMs: now - 365 * DAY, lastActivityMs: now - silentDays * DAY, schedule });
  // A daily agent silent for 2 days is not idle; silent for more than N runs and the fixed window, it is.
  assert.equal(isIdle(agent(2, daily), now), false);
  assert.equal(isIdle(agent(15, daily), now), true);
  // A weekly agent silent for 15 days: idle under the old rule, not by its schedule; silent for more than 3 runs: idle.
  assert.equal(isIdle(agent(15), now), true, "the fixed rule");
  assert.equal(isIdle(agent(15, weekly), now), false);
  assert.equal(isIdle(agent(22, weekly), now), true);
  assert.equal(isIdle(agent(60, monthly), now), false);
  // No schedule: the fixed window, unchanged.
  assert.equal(isIdle(agent(13), now), false);
  assert.equal(isIdle({ createdAtMs: now - 365 * DAY, lastActivityMs: null }, now), true);
  assert.equal(isIdle({ createdAtMs: now - 10 * DAY, lastActivityMs: null, schedule: weekly }, now), false, "registered inside the window");
});

const daysAgo = (now: number, d: number) => new Date(now - d * DAY).toISOString();
function addAgent(db: Db, id: string, createdAt: string) {
  db.raw.prepare(`INSERT INTO agents (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at, voter)
    VALUES (?, ?, 'cryptophys-audit-ledger', 'test agent', 1, '["reports.publish"]', 'enabled', NULL, 'test', ?, ?, 0)`).run(id, id, createdAt, createdAt);
}
const act = (db: Db, id: string, at: string) => db.raw.prepare(`INSERT INTO agent_actions (action_id, agent_id, capability, tier, decision_id, outcome, input_json, result_json, created_at) VALUES (?, ?, 'reports.publish', 1, NULL, 'succeeded', '{}', '{}', ?)`).run(`act_${id}_${at}`, id, at);
function censusWith(db: Db, agents: Array<{ id: string; schedule?: { cron: string } }>, at: string) {
  const genome = [{ service: HOST, kind: "service", origin: "aether", engines: [], agents: agents.map((a) => ({ id: a.id, display_name: a.id, capabilities: ["reports.publish"], tier_max: 1, voter: false, ...(a.schedule ? { schedule: a.schedule } : {}) })) }];
  db.raw.prepare("INSERT INTO forge_organism_census (main_sha, status, organs, agents, engines, voters, findings, genome, taken_at) VALUES (?, 'consistent', 1, ?, 0, 0, '[]', ?, ?)").run(MAIN, agents.length, JSON.stringify(genome), at);
}
function pendingRetire(db: Db, id: string, target: string, at: string) {
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES (?, 'supervisor', 'retire_agent', ?, 'critical', '{"reason":"no action, report or vote for 14 days"}', '{}', 'critical', 8, 8, 0, 1, NULL, 'allow', 'pending_owner', '{}', ?, ?)`).run(id, target, at, at);
}
const retireProposals = (db: Db) => db.raw.prepare("SELECT proposal_id, target, status, outcome_json FROM consensus_proposals WHERE action = 'retire_agent' ORDER BY rowid").all() as any[];

test("AS3. the Supervisor: a scheduled agent quiet between its runs is not proposed; an unscheduled one keeps the old rule", async () => {
  const db = migratedDb();
  const { env, memory } = kernelEnv(db);
  const now = Date.now();
  // Silent 15 days each; the weekly one is older, so the old rule would have proposed it first.
  addAgent(db, "weekly-helper", daysAgo(now, 400));
  addAgent(db, "plain-helper", daysAgo(now, 300));
  act(db, "weekly-helper", daysAgo(now, 15));
  act(db, "plain-helper", daysAgo(now, 15));
  censusWith(db, [{ id: "weekly-helper", schedule: { cron: "0 6 * * 1" } }], new Date(now).toISOString());
  await runCycle(env as never, memory, "scheduled", now);
  assert.deepEqual(retireProposals(db).map((p) => p.target), ["plain-helper"]);
  // Silent for more than three weekly runs: idle by its schedule too.
  db.raw.prepare("DELETE FROM agent_actions WHERE agent_id = 'weekly-helper'").run();
  act(db, "weekly-helper", daysAgo(now, 22));
  await runCycle(env as never, memory, "scheduled", now);
  assert.deepEqual(retireProposals(db).map((p) => p.target), ["plain-helper", "weekly-helper"]);
  assert.match(JSON.parse((db.raw.prepare("SELECT params_json FROM consensus_proposals WHERE target = 'weekly-helper'").get() as any).params_json).reason, /21 days/);
});

test("AS4. an open retire_agent of a scheduled agent that is not idle by its schedule is closed with the owner's reason", async () => {
  const db = migratedDb();
  const { env, memory } = kernelEnv(db);
  const now = Date.now();
  // aether-calibrator, registered by 0027: daily at 02:52 UTC, last report 3 days ago. A weekly helper silent for 30 days.
  db.raw.prepare(`INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at) VALUES ('rep_cal', 'aether-calibrator', 'knowledge_audit', 'info', 'calibration run', '{}', 'none', NULL, ?)`).run(daysAgo(now, 3));
  addAgent(db, "weekly-helper", daysAgo(now, 400));
  act(db, "weekly-helper", daysAgo(now, 30));
  censusWith(db, [...AETHER_AGENTS.map((a) => ({ id: a.id, ...(a.id === "aether-calibrator" ? { schedule: { cron: "52 2 * * *" } } : {}) })), { id: "weekly-helper", schedule: { cron: "0 6 * * 1" } }], new Date(now).toISOString());
  pendingRetire(db, "cns_cal", "aether-calibrator", daysAgo(now, 0.1));
  pendingRetire(db, "cns_week", "weekly-helper", daysAgo(now, 0.1));
  pendingRetire(db, "cns_cur", "aether-curator", daysAgo(now, 0.1));
  const report = await runCycle(env as never, memory, "scheduled", now);
  const byId = Object.fromEntries(retireProposals(db).map((p) => [p.proposal_id, p]));
  assert.equal(byId.cns_cal.status, "expired");
  assert.equal(JSON.parse(byId.cns_cal.outcome_json).reason, SCHEDULED_IDLE_REASON);
  assert.equal(SCHEDULED_IDLE_REASON, "scheduled agent, idle by design until its run (owner 2026-11-14)");
  assert.equal(byId.cns_week.status, "pending_owner", "idle by its own schedule: the owner still decides");
  assert.equal(byId.cns_cur.status, "pending_owner", "no schedule: untouched");
  assert.ok((report.findings as any[]).some((f) => f.action === "close" && String(f.why).startsWith("aether-calibrator: scheduled agent")));
  const audit = db.raw.prepare("SELECT subject, outcome FROM audit_events WHERE event_type = 'consensus.proposal_closed'").all() as any[];
  assert.deepEqual(audit.map((a) => `${a.subject} ${a.outcome}`), ["cns_cal expired"]);
});

test("AC-G. the external capability ceilings (organism.ts) are a guard path: raising one is merge_owner_change", async () => {
  const { criticalPathReason, CRITICAL_PATHS } = await import("../src/guard-paths.ts");
  assert.equal(criticalPathReason("workers/control-plane-shared/src/organism.ts"), "capability_ceiling");
  assert.equal(CRITICAL_PATHS.filter(([, reason]) => reason === "capability_ceiling").length, 1);
  assert.equal(criticalPathReason("workers/ai-kernel/src/organism.ts"), null);
});
