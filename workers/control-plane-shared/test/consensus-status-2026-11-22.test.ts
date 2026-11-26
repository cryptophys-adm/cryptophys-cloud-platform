// consensus.status (owner 2026-11-22, "ya kerjakan nomor 1 dan semuanya"; requested for Aether's knowledge council):
// tier 0, read only. The calling agent reads the status, the owner's decision and the decision time of its OWN consensus
// proposals (consensus_proposals.proposer_agent_id), at most 50 ids a call. Another agent's id, or an unknown one, reads
// { proposal_id, status: "not_found" }. No params, evidence, votes, outcome, owner identity or owner reason. Only
// AETHER_CEILING grants it, to knowledge-council; EXTERNAL_CEILING is not widened. The grant arrives when Aether's DNA
// declares it: the council also holds the privileged consensus.propose, so the census proposes the critical
// update_privileged_agent_capabilities, which waits for the owner's click (owner 2026-11-22, "Jalur klik owner
// (Rekomendasi)"; CS9-CS11).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, fakeAi, migratedDb, registeredDb, lastReviewedRecord } from "./harness.ts";
import { CAPABILITIES, hourlyLimit, verifySyscallDecision } from "../src/capabilities.ts";
import { isLearningCapability } from "../src/power-mode.ts";
import { PRIVILEGED_UPDATE, VOTERS, castVote, classify, privilegedCapabilities, type Evidence, type Proposal } from "../src/consensus-rules.ts";
import { actionCeiling, groupOf } from "../src/autonomy-dial.ts";
import { describeAction } from "../src/plain.ts";
import { rankInbox } from "../src/owner-inbox-rank.ts";
import { AETHER_CEILING, EXTERNAL_CEILING, EXTERNAL_ORIGINS, XAUUSD_CEILING, externalCeilingFor, externalCeilingViolations } from "../src/organism.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { rpcSyscall } from "../../ai-kernel/src/agent-rpc.ts";
import { OWNER_DECISION_WINDOW_MS, PHASE3_EXECUTABLE, PHASE4_EXECUTABLE, expireOwnerProposals, ownerDecide } from "../../ai-kernel/src/consensus.ts";
import { runCycle } from "../../ai-kernel/src/supervisor.ts";
import { CONSENSUS_STATUS_MAX } from "../../ai-kernel/src/consensus-status.ts";
import { executeRegistration, latestCensusRow, proposalFor } from "../../ai-kernel/src/organism.ts";
import { censusTick } from "../../forge/src/census.ts";
import type { ArtifactsReader, ArtifactsTreeEntry } from "../../forge/src/checks.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const CAP = "consensus.status";
const COUNCIL = "knowledge-council";
const HOST = "cryptophys-aether";
const AETHER_PROPS = { host_worker: HOST };
const NEXUS_PROPS = { host_worker: "xauusd-ai-trading-assistant" };
const AETHER = EXTERNAL_ORIGINS.find((o) => o.origin === "aether")!;
const XAUUSD = EXTERNAL_ORIGINS.find((o) => o.origin === "xauusd")!;
const HOUR = 3_600_000;
let seq = 0;
const cnsId = () => `cns_${(++seq).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;

function setup() {
  const db = registeredDb();
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async (agentId: string, decisionId: string) => { await verifySyscallDecision(db, decisionId, agentId, "recovery.propose"); return { plan: {} }; } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
  };
  const status = async (ids: unknown, agent = COUNCIL, props: unknown = AETHER_PROPS) => await rpcSyscall(env as never, props, agent, CAP, { proposal_ids: ids } as never) as any;
  return { db, env, status };
}
/** Aether's DNA declares the council's consensus.status and the owner's click applies it (CS10 runs that path). */
function grantCouncil(db: Db) {
  db.raw.prepare("UPDATE agents SET capabilities_json = ? WHERE agent_id = ?").run(JSON.stringify([...AETHER_CEILING.agents[COUNCIL]]), COUNCIL);
}
/** A proposal row as consensus.ts records it (propose; then ownerDecide or expireOwnerProposals move its status). */
function proposal(db: Db, o: { proposer?: string; action?: string; target?: string; cls?: string; status?: string; created_at?: string; params?: object } = {}): string {
  const id = cnsId();
  const at = o.created_at ?? new Date(Date.now() - HOUR).toISOString();
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed,
      policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, '{"audit_valid":true}', 'critical', 3, 3, 0, 1, NULL, 'allow', ?, '{"executed":false,"reason":"waiting for an owner approval click"}', ?, ?)`)
    .run(id, o.proposer ?? COUNCIL, o.action ?? "amend_constitution", o.target ?? "constitution", o.cls ?? "critical", JSON.stringify(o.params ?? { rule: "secret-rule", values: { x: 1 } }), o.status ?? "pending_owner", at, at);
  db.raw.prepare("INSERT INTO consensus_votes (proposal_id, voter_agent_id, vote, reason, created_at) VALUES (?, 'supervisor', 'approve', 'a vote reason that must not leak', ?)").run(id, at);
  return id;
}
/** Every table's row count: a read changes none of them. */
function snapshot(db: Db): Record<string, number> {
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  return Object.fromEntries(tables.map(({ name }) => [name, (db.raw.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n]));
}

// ------------------------------------------------------------------------------------------- 1. the catalog and the ceilings

test("CS1. consensus.status is tier 0 and read only; only AETHER_CEILING grants it, to knowledge-council; EXTERNAL_CEILING is not widened", () => {
  const c = CAPABILITIES[CAP];
  assert.deepEqual([c.tier, c.reversible, c.max_per_hour], [0, true, undefined]);
  assert.match(c.description, /calling agent's own consensus proposals/);
  assert.match(c.description, /\(read only\)$/);
  assert.equal(isLearningCapability(CAP), false, "a read is not learning");
  assert.equal(hourlyLimit(CAP), null);
  assert.deepEqual(privilegedCapabilities([CAP]), [], "not privileged");
  // AETHER_CEILING: the council holds it, nobody else does.
  assert.ok(AETHER_CEILING.agents[COUNCIL].includes(CAP));
  assert.deepEqual(Object.entries(AETHER_CEILING.agents).filter(([, caps]) => caps.includes(CAP)).map(([id]) => id), [COUNCIL]);
  assert.deepEqual(externalCeilingFor(AETHER, COUNCIL).capabilities, ["consensus.propose", "doctrine.status", "reports.publish", CAP]);
  assert.deepEqual([...AETHER_CEILING.capabilities], ["signals.observe", "reports.publish"]);
  // EXTERNAL_CEILING and XAUUSD_CEILING are unchanged.
  assert.deepEqual([...EXTERNAL_CEILING.capabilities], ["signals.observe", "reports.publish", "memory.recall", "memory.remember"]);
  assert.ok(!Object.values(XAUUSD_CEILING.agents).some((caps) => caps.includes(CAP)));
  assert.ok(!XAUUSD_CEILING.capabilities.includes(CAP));
  // A gene that puts it on another agent is refused (a census finding, never a proposal).
  const aeth = (id: string, capabilities: string[]) => externalCeilingViolations({ id, tier_max: 1, voter: false, capabilities }, AETHER);
  assert.deepEqual(aeth(COUNCIL, [...AETHER_CEILING.agents[COUNCIL]]), []);
  assert.deepEqual(aeth("aether-curator", ["reports.publish", "knowledge.propose", "knowledge.status", CAP]), [`capability ${CAP}`]);
  assert.deepEqual(aeth("aether-new", ["signals.observe", CAP]), [`capability ${CAP}`]);
  const xau = (id: string, capabilities: string[]) => externalCeilingViolations({ id, tier_max: 1, voter: false, capabilities }, XAUUSD);
  assert.deepEqual(xau("xauusd-moderator", [...EXTERNAL_CEILING.capabilities, "council.decisions.read", CAP]), [`capability ${CAP}`]);
  assert.deepEqual(xau(COUNCIL, [CAP]), [`capability ${CAP}`]);
  // The guard paths this change touches: capabilities.ts and organism.ts (the owner's click).
  assert.equal(criticalPathReason("workers/control-plane-shared/src/capabilities.ts"), "evolution_guard");
  assert.equal(criticalPathReason("workers/control-plane-shared/src/organism.ts"), "capability_ceiling");
  // The owner-click path for a privileged agent's capability change (CS9-CS11).
  assert.equal(criticalPathReason("workers/control-plane-shared/src/consensus-rules.ts"), "consensus_kill_switch");
  assert.equal(criticalPathReason("workers/control-plane-shared/src/autonomy-dial.ts"), "consensus_kill_switch");
  assert.equal(criticalPathReason("architecture/adr/0009-consensus-autonomy.md"), "adr_0009_0012");
  // Review 2026-11-22: the read's scope and the census executors are guard paths too.
  assert.equal(criticalPathReason("workers/ai-kernel/src/consensus-status.ts"), "capability_ceiling");
  assert.equal(criticalPathReason("workers/ai-kernel/src/organism.ts"), "consensus_kill_switch");
  for (const p of ["workers/ai-kernel/src/syscall.ts", "workers/control-plane-shared/test/consensus-status-2026-11-22.test.ts", "workers/control-plane-shared/test/aether-ceiling-schedule.test.ts", "docs/SSOT.md"]) {
    assert.equal(criticalPathReason(p), null, p);
  }
});

// ------------------------------------------------------------------------------------------- 2. the read

test("CS2. once granted, knowledge-council reads its own proposals: status, owner decision, decided_at; never params, votes or the owner's reason", async () => {
  const s = setup();
  grantCouncil(s.db);
  const now = Date.now();
  const pendingAt = new Date(now - 2 * HOUR).toISOString();
  const pending = proposal(s.db, { created_at: pendingAt });
  const rejected = proposal(s.db, { action: "amend_constitution", target: "constitution" });
  const out = await ownerDecide(s.env as never, rejected, "reject", APPROVER_EMAIL, "not this week, the wording is off");
  assert.equal(out.status, "rejected");
  const shadow = proposal(s.db, { action: "amend_doctrine", target: "engine-thresholds", cls: "routine", status: "shadow_passed" });

  const r = await s.status([pending, rejected, shadow, pending]);
  assert.equal(r.outcome, "succeeded", JSON.stringify(r));
  assert.deepEqual([r.tier, r.decision_id], [0, null]);
  const [a, b, c, ...rest] = r.result.proposals;
  assert.equal(rest.length, 0, "a repeated id is answered once, in the order asked");
  const row = (id: string) => s.db.raw.prepare("SELECT decided_at FROM consensus_proposals WHERE proposal_id = ?").get(id) as { decided_at: string };
  assert.deepEqual(a, {
    proposal_id: pending, action: "amend_constitution", target: "constitution", status: "pending_owner", owner_decision: null,
    decided_at: pendingAt, expires_at: new Date(Date.parse(pendingAt) + OWNER_DECISION_WINDOW_MS).toISOString(),
  });
  assert.deepEqual(b, { proposal_id: rejected, action: "amend_constitution", target: "constitution", status: "rejected", owner_decision: "reject", decided_at: row(rejected).decided_at });
  assert.ok(Date.parse(b.decided_at) >= now, "decided_at is the time of the owner's rejection");
  assert.deepEqual(c, { proposal_id: shadow, action: "amend_doctrine", target: "engine-thresholds", status: "shadow_passed", owner_decision: null, decided_at: row(shadow).decided_at });
  const text = JSON.stringify(r.result);
  for (const leak of [APPROVER_EMAIL, "not this week", "secret-rule", "a vote reason", "waiting for an owner", "audit_valid", "params", "votes", "outcome", "evidence"]) {
    assert.ok(!text.includes(leak), `never ${leak}`);
  }
});

test("CS3. a proposal the council made through consensus.propose reads back with the status consensus.ts recorded", async () => {
  const s = setup();
  grantCouncil(s.db);
  const p = await s.status([]);
  assert.deepEqual([p.outcome, p.result], ["succeeded", { proposals: [] }], "no id, no proposal");
  const made = await rpcSyscall(s.env as never, AETHER_PROPS, COUNCIL, "consensus.propose", {
    action: "amend_doctrine", target: "engine-thresholds",
    params: { rule: "engine_thresholds", values: { "decision.quorum_min_intraday": 0.55 }, previous: { "decision.quorum_min_intraday": 0.5 }, canon: "0123456789ab", session: "kc_20261122-0352", seats: { nexus: "agree", aether: "agree" } },
  }) as any;
  assert.equal(made.outcome, "succeeded", JSON.stringify(made));
  const id = made.result.proposal.proposal_id;
  const r = await s.status([id]);
  assert.equal(r.outcome, "succeeded", JSON.stringify(r));
  assert.deepEqual(Object.keys(r.result.proposals[0]).sort(), ["action", "decided_at", "owner_decision", "proposal_id", "status", "target"]);
  assert.deepEqual([r.result.proposals[0].proposal_id, r.result.proposals[0].action, r.result.proposals[0].target, r.result.proposals[0].status, r.result.proposals[0].owner_decision],
    [id, "amend_doctrine", "engine-thresholds", made.result.proposal.status, null]);
});

test("CS4. another agent's proposal, or an unknown id, is not_found; nothing about it is revealed", async () => {
  const s = setup();
  grantCouncil(s.db);
  const mine = proposal(s.db);
  const supervisors = proposal(s.db, { proposer: "supervisor", action: "retire_agent", target: "aether-guardian", params: { reason: "idle" } });
  const curators = proposal(s.db, { proposer: "aether-curator", action: "amend_doctrine", target: "engine-thresholds", cls: "routine", status: "rejected" });
  await ownerDecide(s.env as never, supervisors, "reject", APPROVER_EMAIL, "keep it");
  const unknown = cnsId();
  const r = await s.status([supervisors, mine, curators, unknown]);
  assert.equal(r.outcome, "succeeded", JSON.stringify(r));
  assert.deepEqual(r.result.proposals.map((p: any) => p.status), ["not_found", "pending_owner", "not_found", "not_found"]);
  for (const [i, id] of [[0, supervisors], [2, curators], [3, unknown]] as const) {
    assert.deepEqual(r.result.proposals[i], { proposal_id: id, status: "not_found" }, "exactly the id and not_found");
  }
  const text = JSON.stringify(r.result);
  for (const leak of ["retire_agent", "aether-guardian", "supervisor", "aether-curator", "reject"]) assert.ok(!text.includes(leak), `never ${leak}`);
});

test("CS5. at most 50 ids, each a proposal id (cns_<uuid>); anything else is an error, not an empty answer", async () => {
  const s = setup();
  grantCouncil(s.db);
  assert.equal(CONSENSUS_STATUS_MAX, 50);
  const fifty = Array.from({ length: 50 }, () => cnsId());
  const ok = await s.status(fifty);
  assert.equal(ok.outcome, "succeeded", JSON.stringify(ok));
  assert.equal(ok.result.proposals.length, 50);
  assert.ok(ok.result.proposals.every((p: any) => p.status === "not_found"));
  const over = await s.status([...fifty, cnsId()]);
  assert.equal(over.outcome, "failed");
  assert.match(over.reason, /^too_many_proposal_ids: at most 50/);
  for (const bad of [["cns_x"], ["knw_00000001-0000-4000-8000-000000000000"], [`${cnsId()}' OR 1=1 --`], [42], [null], ["CNS_00000001-0000-4000-8000-000000000000"]]) {
    const r = await s.status(bad);
    assert.deepEqual([r.outcome, r.reason], ["failed", "invalid_proposal_id: cns_<uuid>"], JSON.stringify(bad));
  }
  for (const bad of [undefined, null, "cns_00000001-0000-4000-8000-000000000000", { 0: "x" }]) {
    const r = await s.status(bad);
    assert.deepEqual([r.outcome, r.reason], ["failed", "invalid_proposal_ids: an array of proposal ids"], JSON.stringify(bad));
  }
});

test("CS6. an agent not granted is denied: the council before its DNA declares it, every other Aether, xauusd and kernel agent", async () => {
  const s = setup();
  const mine = proposal(s.db);
  const before = await s.status([mine]);
  assert.equal(before.outcome, "denied", JSON.stringify(before));
  assert.match(before.reason, /capability_granted/);
  grantCouncil(s.db);
  for (const [props, id] of [[AETHER_PROPS, "aether-curator"], [AETHER_PROPS, "aether-calibrator"], [AETHER_PROPS, "aether-guardian"], [AETHER_PROPS, "aether-auditor"], [NEXUS_PROPS, "xauusd-moderator"], [NEXUS_PROPS, "nexus-teacher"]] as const) {
    const r = await s.status([mine], id, props);
    assert.equal(r.outcome, "denied", `${id}: ${JSON.stringify(r)}`);
    assert.match(r.reason, /capability_granted/, id);
  }
  // Only Aether's Worker acts as the council.
  assert.equal((await s.status([mine], COUNCIL, NEXUS_PROPS)).reason, "agent_not_hosted_by_caller");
  for (const id of ["supervisor", "auditor"]) assert.equal((await syscall(s.env as never, id, CAP, { proposal_ids: [mine] })).outcome, "denied", id);
});

test("CS7. an expired owner window reads as status expired, with no owner decision; until the sweep, pending_owner with expires_at in the past", async () => {
  const s = setup();
  grantCouncil(s.db);
  const now = Date.now();
  const lapsed = proposal(s.db, { created_at: new Date(now - 25 * HOUR).toISOString() });
  const clicked = proposal(s.db, { created_at: new Date(now - 26 * HOUR).toISOString() });
  const fresh = proposal(s.db, { created_at: new Date(now - HOUR).toISOString() });
  // Before the Supervisor's sweep the read reports what consensus.ts recorded; it never writes the expiry itself.
  const early = await s.status([lapsed]);
  assert.equal(early.result.proposals[0].status, "pending_owner");
  assert.ok(Date.parse(early.result.proposals[0].expires_at) < now, "the window has passed");
  // A late owner click finds the window passed: ownerDecide records status expired and no decision.
  await assert.rejects(ownerDecide(s.env as never, clicked, "approve", APPROVER_EMAIL, null), /expired/);
  // The scheduled sweep (expireOwnerProposals) expires the other one; the fresh one still waits.
  assert.equal(await expireOwnerProposals(s.env as never), 1);
  const r = await s.status([lapsed, clicked, fresh]);
  assert.equal(r.outcome, "succeeded", JSON.stringify(r));
  const [a, b, c] = r.result.proposals;
  for (const x of [a, b]) {
    assert.deepEqual([x.status, x.owner_decision, "expires_at" in x], ["expired", null, false], JSON.stringify(x));
    assert.ok(Date.parse(x.decided_at) >= now, "decided_at is the time the expiry was recorded");
  }
  assert.deepEqual([c.status, c.owner_decision], ["pending_owner", null]);
  assert.equal(c.expires_at, new Date(Date.parse(String((s.db.raw.prepare("SELECT created_at FROM consensus_proposals WHERE proposal_id = ?").get(fresh) as any).created_at)) + OWNER_DECISION_WINDOW_MS).toISOString());
});

test("CS8. nothing is written: a tier 0 read is not persisted, whether it succeeds, finds nothing, fails or is denied", async () => {
  const s = setup();
  grantCouncil(s.db);
  const mine = proposal(s.db);
  const theirs = proposal(s.db, { proposer: "supervisor" });
  const stale = proposal(s.db, { created_at: new Date(Date.now() - 30 * HOUR).toISOString() });
  const before = snapshot(s.db);
  const rows = () => s.db.raw.prepare("SELECT proposal_id, status, decided_at, outcome_json FROM consensus_proposals ORDER BY proposal_id").all();
  const proposalsBefore = rows();
  assert.equal((await s.status([mine, theirs, stale, cnsId()])).outcome, "succeeded");
  assert.equal((await s.status(Array.from({ length: 51 }, () => cnsId()))).outcome, "failed");
  assert.equal((await s.status([mine], "aether-curator")).outcome, "denied");
  assert.equal((await s.status(["nope"])).outcome, "failed");
  assert.deepEqual(snapshot(s.db), before, "no table gains or loses a row: no agent_actions, no audit event");
  assert.deepEqual(rows(), proposalsBefore, "no proposal changes, not even the stale one's status");
  assert.ok(before.agent_actions !== undefined && before.audit_events !== undefined);
});

// ------------------------------------------------------------------------------------------- 3. how the grant arrives

const DIRS = ["ai-kernel", "audit-ledger", "console", "deployment-orchestrator", "drift-detector", "forge", "forge-typecheck", "forge-typecheck-cr", "platform-api", "platform-registry", "policy-engine", "recovery-manager"];
const MAIN = "c".repeat(40);
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
/** Aether's five agents as its DNA declares them today, with knowledge-council's set replaced. */
function aetherDna(councilCaps: string[]) {
  const agent = (id: string, capabilities: string[]) => ({ id, display_name: id, capabilities, tier_max: 1, voter: false });
  const agents = [
    agent("aether-guardian", ["signals.observe", "reports.publish"]), agent("aether-auditor", ["signals.observe", "reports.publish"]),
    agent("aether-curator", ["reports.publish", "knowledge.propose", "knowledge.status"]), agent("aether-calibrator", ["reports.publish", "knowledge.propose", "knowledge.status"]),
    agent(COUNCIL, councilCaps),
  ];
  return { schema: "aether-organism.v1", organs: [{ $schema_version: 1, service: HOST, display_name: "Aether", kind: "service", deploy_unit: null, access: false, rollback: false, drift: { via: "rpc", binding: "EXT_AETHER" }, agents, engines: [{ task: "embed_texts" }] }] };
}

function cycleEnv(db: Db) {
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
  return { env, memory, policyEnv };
}
const capsOf = (db: Db, id: string) => (JSON.parse((db.raw.prepare("SELECT capabilities_json FROM agents WHERE agent_id = ?").get(id) as any).capabilities_json) as string[]).sort();
const TODAY = ["consensus.propose", "doctrine.status", "reports.publish"];

test("CS9. the owner's click path (owner 2026-11-22, \"Jalur klik owner (Rekomendasi)\"): a privileged agent's capability change is proposed, critical, and the votes keep its guards", async () => {
  const db = registeredDb();
  const declared = [...AETHER_CEILING.agents[COUNCIL]];
  await censusTick(db as never, repoWith(realDna()), Date.now(), [{ origin: AETHER, dna: async () => aetherDna(declared) }]);
  const census = (await latestCensusRow({ DB: db } as never))!;
  const finding = census.findings.find((f) => f.kind === "agent_capabilities_changed" && f.subject === COUNCIL)!;
  assert.ok(finding, census.findings.map((f) => `${f.kind} ${f.subject}`).join("; "));
  assert.ok(!census.findings.some((f) => f.kind === "external_agent_refused"), "within Aether's ceiling");
  // consensus.propose is privileged: the census proposes the critical update, never the routine one.
  assert.deepEqual(privilegedCapabilities(declared), ["consensus.propose"]);
  const prop = proposalFor(census, finding)!;
  assert.deepEqual([prop.action, prop.target, prop.params.service, prop.params.tier_max], [PRIVILEGED_UPDATE, COUNCIL, HOST, 1]);
  assert.deepEqual([...(prop.params.capabilities as string[])].sort(), [...declared].sort());
  assert.equal(classify(PRIVILEGED_UPDATE), "critical");
  assert.equal(classify("update_agent_capabilities"), "routine", "the routine action is unchanged");
  assert.ok(PHASE4_EXECUTABLE.has(PRIVILEGED_UPDATE) && !PHASE3_EXECUTABLE.has(PRIVILEGED_UPDATE), "executed only after the owner's click");
  assert.equal(groupOf(PRIVILEGED_UPDATE), "agents");
  assert.equal(actionCeiling(PRIVILEGED_UPDATE), "owner_click", "the autonomy dial can never make it routine");
  assert.match(describeAction(PRIVILEGED_UPDATE, COUNCIL), /^set, as its DNA declares, the capabilities of the privileged agent /);
  // The owner's inbox: not reversible, since no consensus action gives back a privileged capability the update removes.
  const [item] = rankInbox({ approvals: { recovery_plans: [], consensus: [{ proposal_id: "cns_x", action: PRIVILEGED_UPDATE, target: COUNCIL, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + HOUR).toISOString(), approvals: 5, eligible: 5 }], knowledge: [] }, critical_reports: [], production_problems: [] });
  assert.deepEqual(item.risk, { class: "critical", reversible: false, blast_radius: "agent" });
  // The votes.
  const e = (registered: string[] | undefined): Evidence => ({
    agents_enabled: true, audit_valid: true, services: {}, critical_reports_24h: 0, executing_plan_targets: [], recent_same: 0,
    registry: { [HOST]: { status: "healthy", desired_version: null } },
    agents: { [COUNCIL]: { status: "enabled", host_worker: HOST, voter: false, ...(registered ? { capabilities: registered } : {}) } },
  });
  const vote = (action: string, capabilities: string[], registered: string[] | null = TODAY) =>
    castVote("policy-engine", { action, target: COUNCIL, params: { service: HOST, capabilities, tier_max: 1 }, class: classify(action)! } as Proposal, e(registered ?? undefined));
  assert.equal(vote(PRIVILEGED_UPDATE, declared).vote, "approve");
  assert.match(vote(PRIVILEGED_UPDATE, declared).reason, /the owner decides/);
  assert.equal(vote(PRIVILEGED_UPDATE, ["consensus.propose", "reports.publish"]).vote, "approve", "removing capabilities only narrows");
  // Never as routine; only with the owner's click.
  assert.match(vote("update_agent_capabilities", declared).reason, /privileged capabilities are never updated as routine, only by update_privileged_agent_capabilities with the owner's click: consensus\.propose/);
  // A privileged capability the agent does not hold is never added by an update.
  assert.match(vote(PRIVILEGED_UPDATE, declared, ["doctrine.status", "reports.publish"]).reason, /a privileged capability the agent does not hold is never added by an update: consensus\.propose/);
  assert.match(vote(PRIVILEGED_UPDATE, declared, null).reason, /registered capabilities are unknown/, "fails closed");
  // A capability outside the ceiling, or a forbidden one, is still refused.
  assert.match(vote(PRIVILEGED_UPDATE, [...declared, "memory.recall"]).reason, /above the external-organ ceiling: capability memory\.recall/);
  const tier2 = vote(PRIVILEGED_UPDATE, [...declared, "code.propose"]);
  assert.deepEqual([tier2.vote, /never added by an update: code\.propose/.test(tier2.reason)], ["reject", true], tier2.reason);
  assert.match(vote(PRIVILEGED_UPDATE, [...declared, "deploy.release"]).reason, /unknown or prohibited/);
  // A set with no privileged capability is the routine action's.
  assert.match(vote(PRIVILEGED_UPDATE, ["doctrine.status", "reports.publish", CAP]).reason, /no privileged capability: update_agent_capabilities is the routine action/);
});

test("CS10. the council's grant: the Supervisor proposes it, it waits as pending_owner, refuses to run without the click and applies after it", async () => {
  const db = registeredDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  const { env, memory, policyEnv } = cycleEnv(db);
  const declared = [...AETHER_CEILING.agents[COUNCIL]];
  const t0 = Date.now();
  const reader = [{ origin: AETHER, dna: async () => aetherDna(declared) }];
  await censusTick(db as never, repoWith(realDna()), t0 - 60_000, reader);
  await runCycle(env as never, memory, "scheduled", t0);
  const rows = db.raw.prepare("SELECT * FROM consensus_proposals WHERE target = ? AND action IN ('update_agent_capabilities', ?) ORDER BY rowid").all(COUNCIL, PRIVILEGED_UPDATE) as any[];
  assert.equal(rows.length, 1, JSON.stringify(rows.map((r) => [r.action, r.status])));
  const [p] = rows;
  assert.deepEqual([p.action, p.class, p.status, p.passed], [PRIVILEGED_UPDATE, "critical", "pending_owner", 1], p.outcome_json);
  assert.deepEqual(capsOf(db, COUNCIL), TODAY, "nothing changes before the click");
  // Without the owner's approval: the Policy Engine denies, and the executor refuses even when forced to executing.
  const pol = await decide(policyEnv as never, parsePolicyRequest({ subject: "owner:x", action: "consensus.execute", resource: `${PRIVILEGED_UPDATE}:${COUNCIL}`, context: { class: "critical", passed: true, stage: "execute", proposal_id: p.proposal_id } }) as never) as any;
  assert.equal(pol.decision, "deny");
  assert.ok((pol.checks ?? pol.evidence?.checks ?? []).some((c: any) => c.id === "owner_approved" && !c.passed), JSON.stringify(pol));
  db.raw.prepare("UPDATE consensus_proposals SET status = 'executing', policy_decision_id = ?, policy_decision = 'allow' WHERE proposal_id = ?").run(pol.decision_id, p.proposal_id);
  db.raw.prepare("UPDATE policy_decisions SET decision = 'allow' WHERE decision_id = ?").run(pol.decision_id);
  await assert.rejects(executeRegistration(env as never, p.proposal_id, pol.decision_id, { action: PRIVILEGED_UPDATE, target: COUNCIL, params: JSON.parse(p.params_json) }, "test", () => false), /consensus_owner_approval_required/);
  assert.deepEqual(capsOf(db, COUNCIL), TODAY);
  db.raw.prepare("UPDATE consensus_proposals SET status = 'pending_owner', policy_decision_id = ?, policy_decision = ? WHERE proposal_id = ?").run(p.policy_decision_id, p.policy_decision, p.proposal_id);
  // Before the click the council is not granted the read.
  const before = await rpcSyscall(env as never, AETHER_PROPS, COUNCIL, CAP, { proposal_ids: [] }) as any;
  assert.match(before.reason, /capability_granted/);
  // The owner's click: executed through the critical path, audited; the council now reads its proposals.
  const out = await ownerDecide(env as never, p.proposal_id, "approve", APPROVER_EMAIL, null);
  assert.equal(out.status, "executed", JSON.stringify(out));
  assert.deepEqual(capsOf(db, COUNCIL), [...declared].sort());
  const audit = db.raw.prepare("SELECT actor, payload_json FROM audit_events WHERE event_type = 'agent.capabilities_updated' AND subject = ?").all(`agent:${COUNCIL}`) as any[];
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0].payload_json).previous.sort(), TODAY);
  assert.match(audit[0].actor, new RegExp(`^owner:${APPROVER_EMAIL.replace(/[.]/g, "\\.")} via consensus:`));
  const after = await rpcSyscall(env as never, AETHER_PROPS, COUNCIL, CAP, { proposal_ids: [p.proposal_id] }) as any;
  assert.equal(after.outcome, "succeeded", JSON.stringify(after));
  // The Supervisor proposed the update, not the council: the council's read does not reveal it.
  assert.deepEqual(after.result.proposals, [{ proposal_id: p.proposal_id, status: "not_found" }]);
  // The census settles.
  await censusTick(db as never, repoWith(realDna()), t0 + 31 * 60_000, reader);
  assert.ok(!(await latestCensusRow({ DB: db } as never))!.findings.some((f) => f.kind === "agent_capabilities_changed" && f.subject === COUNCIL), "the census settles");
});

/**
 * A proposal forced to executing with the owner's approval and an allow on record: what the executor itself refuses,
 * whatever the votes said.
 */
async function forceExec(db: Db, env: unknown, action: string, params: Record<string, unknown>) {
  const id = cnsId();
  const at = new Date().toISOString();
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES (?, 'supervisor', ?, ?, ?, ?, '{}', 'deploy', 1, 1, 0, 1, NULL, 'allow', 'executing', '{}', ?, ?)`).run(id, action, COUNCIL, classify(action), JSON.stringify(params), at, at);
  db.raw.prepare("INSERT INTO consensus_owner_decisions (proposal_id, decision, decided_by, reason, created_at) VALUES (?, 'approve', ?, NULL, ?)").run(id, APPROVER_EMAIL, at);
  const pol = await decide(baseEnv("cryptophys-policy-engine", db) as never, parsePolicyRequest({ subject: `owner:${APPROVER_EMAIL}`, action: "consensus.execute", resource: `${action}:${COUNCIL}`, context: { class: classify(action), passed: true, stage: "execute", proposal_id: id } }) as never) as any;
  db.raw.prepare("UPDATE policy_decisions SET decision = 'allow' WHERE decision_id = ?").run(pol.decision_id);
  db.raw.prepare("UPDATE consensus_proposals SET policy_decision_id = ? WHERE proposal_id = ?").run(pol.decision_id, id);
  return executeRegistration(env as never, id, pol.decision_id, { action, target: COUNCIL, params }, "test", () => false);
}
/** A census row written as given, without the census's own checks in front (status changes, one agent_capabilities_changed). */
function rawCensus(db: Db, councilCaps: string[]) {
  const genome = [{ service: HOST, kind: "service", origin: "aether", engines: ["embed_texts"], agents: [{ id: COUNCIL, display_name: COUNCIL, capabilities: councilCaps, tier_max: 1, voter: false }] }];
  const findings = [{ kind: "agent_capabilities_changed", subject: COUNCIL, detail: `agent ${COUNCIL}: test` }];
  db.raw.prepare("INSERT INTO forge_organism_census (main_sha, status, organs, agents, engines, voters, findings, genome, taken_at) VALUES (?, 'changes', 1, 1, 1, 0, ?, ?, ?)")
    .run(MAIN, JSON.stringify(findings), JSON.stringify(genome), new Date(Date.now() - 60_000).toISOString());
  return { service: HOST, capabilities: councilCaps, tier_max: 1, main_sha: MAIN };
}
const deployMode = (db: Db) => db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
const councilProposals = (db: Db) => db.raw.prepare("SELECT action, status FROM consensus_proposals WHERE target = ? AND action IN ('update_agent_capabilities', ?)").all(COUNCIL, PRIVILEGED_UPDATE) as any[];

test("CS11. the executor holds the guards too: no new privileged capability; the routine action never applies a privileged set, even to an agent that holds it", async () => {
  // The council registered without consensus.propose: its DNA asking for it back is a new privileged capability.
  const db = registeredDb();
  deployMode(db);
  const { env } = cycleEnv(db);
  db.raw.prepare("UPDATE agents SET capabilities_json = ? WHERE agent_id = ?").run(JSON.stringify(["doctrine.status", "reports.publish"]), COUNCIL);
  const declared = [...AETHER_CEILING.agents[COUNCIL]];
  await censusTick(db as never, repoWith(realDna()), Date.now() - 60_000, [{ origin: AETHER, dna: async () => aetherDna(declared) }]);
  const params = { service: HOST, capabilities: declared, tier_max: 1, main_sha: (await latestCensusRow({ DB: db } as never))!.main_sha };
  await assert.rejects(forceExec(db, env, PRIVILEGED_UPDATE, params), /new_privileged_capability/);
  await assert.rejects(forceExec(db, env, "update_agent_capabilities", params), /privileged_needs_owner/);
  assert.deepEqual(capsOf(db, COUNCIL), ["doctrine.status", "reports.publish"], "nothing applied");
  // The council registered as today (it holds consensus.propose): the routine action still never applies the set.
  const db2 = registeredDb();
  deployMode(db2);
  const { env: env2 } = cycleEnv(db2);
  await censusTick(db2 as never, repoWith(realDna()), Date.now() - 60_000, [{ origin: AETHER, dna: async () => aetherDna(declared) }]);
  const params2 = { service: HOST, capabilities: declared, tier_max: 1, main_sha: (await latestCensusRow({ DB: db2 } as never))!.main_sha };
  await assert.rejects(forceExec(db2, env2, "update_agent_capabilities", params2), /privileged_needs_owner/);
  assert.deepEqual(capsOf(db2, COUNCIL), TODAY, "unchanged");
});

test("CS11b. the Supervisor does not propose an update that adds a privileged capability: it waits as a finding, cycle after cycle", async () => {
  const db = registeredDb();
  deployMode(db);
  const { env, memory } = cycleEnv(db);
  db.raw.prepare("UPDATE agents SET capabilities_json = ? WHERE agent_id = ?").run(JSON.stringify(["doctrine.status", "reports.publish"]), COUNCIL);
  const t0 = Date.now();
  await censusTick(db as never, repoWith(realDna()), t0 - 60_000, [{ origin: AETHER, dna: async () => aetherDna([...AETHER_CEILING.agents[COUNCIL]]) }]);
  for (const at of [t0, t0 + 25 * HOUR]) {
    const report = await runCycle(env as never, memory, "scheduled", at) as any;
    assert.ok((report.findings as any[]).some((f) => f.service_id === COUNCIL && f.action === "none"
      && f.why === "capability update of knowledge-council waits: consensus.propose is a new privileged capability; an update never adds one"), JSON.stringify(report.findings));
  }
  assert.deepEqual(councilProposals(db), [], "never proposed, so never rejected 8-0 and never holding the cycle's registration slot");
  assert.deepEqual(capsOf(db, COUNCIL), ["doctrine.status", "reports.publish"]);
});

test("CS11c. without the census in front: the executor's own ceiling, host and class checks; the Supervisor's unknown-capability wait", async () => {
  const declared = [...AETHER_CEILING.agents[COUNCIL]];
  // Above the ceiling (a census that let it through): the executor refuses.
  const db1 = registeredDb(); deployMode(db1);
  await assert.rejects(forceExec(db1, cycleEnv(db1).env, PRIVILEGED_UPDATE, rawCensus(db1, [...declared, "memory.recall"])), /external_ceiling/);
  // The registered agent's host differs from its DNA's.
  const db2 = registeredDb(); deployMode(db2);
  db2.raw.prepare("UPDATE agents SET host_worker = 'cryptophys-forge' WHERE agent_id = ?").run(COUNCIL);
  await assert.rejects(forceExec(db2, cycleEnv(db2).env, PRIVILEGED_UPDATE, rawCensus(db2, declared)), /host_differs_from_dna/);
  // A set with no privileged capability is never applied by the critical action.
  const db3 = registeredDb(); deployMode(db3);
  await assert.rejects(forceExec(db3, cycleEnv(db3).env, PRIVILEGED_UPDATE, rawCensus(db3, ["doctrine.status", "reports.publish", CAP])), /not_privileged/);
  for (const db of [db1, db2, db3]) assert.deepEqual(capsOf(db, COUNCIL), TODAY, "nothing applied");
  // A capability unknown to the running kernel: the privileged update waits as a finding, like a registration.
  const db4 = registeredDb(); deployMode(db4);
  const { env, memory } = cycleEnv(db4);
  rawCensus(db4, [...declared, "future.read"]);
  const report = await runCycle(env as never, memory, "scheduled", Date.now()) as any;
  assert.ok((report.findings as any[]).some((f) => f.service_id === COUNCIL && f.why === "registration of knowledge-council waits: future.read is unknown to the running kernel (its deploy is pending)"), JSON.stringify(report.findings));
  assert.deepEqual(councilProposals(db4), []);
});

test("CS11d. a voter fails closed on an action its code does not know", () => {
  const e: Evidence = {
    agents_enabled: true, audit_valid: true, services: {}, critical_reports_24h: 0, executing_plan_targets: [], recent_same: 0, registry: {}, agents: {},
  };
  assert.equal(classify("rotate_everything"), null);
  for (const voter of [...VOTERS, "supervisor"]) {
    const v = castVote(voter as never, { action: "rotate_everything", target: "platform", params: {}, class: "routine" } as Proposal, e);
    assert.deepEqual([v.vote, v.reason], ["reject", "unknown action for this voter's code"], voter);
  }
  // A known action still reaches the voter's own rule.
  assert.notEqual(castVote("policy-engine", { action: "observe_drift", target: "platform", params: {}, class: "routine" } as Proposal, e).reason, "unknown action for this voter's code");
});

test("CS11e. read-backs: expires_at counts from created_at, not decided_at; an executed and a failed-after-approval proposal", async () => {
  const s = setup();
  grantCouncil(s.db);
  const now = Date.now();
  const createdAt = new Date(now - 3 * HOUR).toISOString();
  const decidedAt = new Date(now - HOUR).toISOString();
  const waiting = proposal(s.db, { created_at: createdAt });
  s.db.raw.prepare("UPDATE consensus_proposals SET decided_at = ? WHERE proposal_id = ?").run(decidedAt, waiting);
  const executed = proposal(s.db, { status: "executed" });
  const failed = proposal(s.db, { status: "failed" });
  for (const id of [executed, failed]) s.db.raw.prepare("INSERT INTO consensus_owner_decisions (proposal_id, decision, decided_by, reason, created_at) VALUES (?, 'approve', ?, 'go', ?)").run(id, APPROVER_EMAIL, decidedAt);
  const r = await s.status([waiting, executed, failed]);
  assert.equal(r.outcome, "succeeded", JSON.stringify(r));
  const [w, x, f] = r.result.proposals;
  assert.deepEqual([w.status, w.decided_at, w.expires_at], ["pending_owner", decidedAt, new Date(Date.parse(createdAt) + OWNER_DECISION_WINDOW_MS).toISOString()]);
  assert.deepEqual([x.status, x.owner_decision, "expires_at" in x], ["executed", "approve", false]);
  assert.deepEqual([f.status, f.owner_decision, "expires_at" in f], ["failed", "approve", false]);
  assert.ok(!JSON.stringify(r.result).includes(APPROVER_EMAIL));
});

test("CS12. the SSOT: line 5 carries the consensus.status entry and the owner-click rule; the external origins row names the council's read; ADR-0009 records the amendment", () => {
  const ssot = read("docs/SSOT.md");
  const line5 = lastReviewedRecord();
  // The repository's convention: the entry may follow later entries on line 5.
  assert.match(line5, /^Last reviewed: 2026-11-16 \((?:[^\n]*; )?consensus\.status, 2026-11-22/);
  assert.ok(line5.includes(`consensus.status, 2026-11-22 (owner: "ya kerjakan nomor 1 dan semuanya"; requested for Aether's knowledge council): `));
  for (const want of ["`consensus.status`", "`knowledge-council`", "`not_found`", "`expired`", "guard path", "`update_privileged_agent_capabilities`", "\"Jalur klik owner (Rekomendasi)\"", "`merge_owner_change`", "unknown action for this voter's code", "`ai-kernel/src/organism.ts`", "`ai-kernel/src/consensus-status.ts`"]) assert.ok(line5.includes(want), want);
  assert.match(read("architecture/adr/0009-consensus-autonomy.md"), /^## Amendment 2026-11-22: a privileged agent's capability change waits for the owner's click\n\nOwner 2026-11-22, "Jalur klik owner \(Rekomendasi\)"/m);
  assert.match(ssot, /\*\*External origins[^\n]*`aether-curator` may also hold the read-only `corrections\.read`[^\n]*`knowledge-council` the read-only `consensus\.status`/);
});
