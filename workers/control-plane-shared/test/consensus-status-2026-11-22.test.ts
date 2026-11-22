// consensus.status (owner 2026-11-22, "ya kerjakan nomor 1 dan semuanya"; requested for Aether's knowledge council):
// tier 0, read only. The calling agent reads the status, the owner's decision and the decision time of its OWN consensus
// proposals (consensus_proposals.proposer_agent_id), at most 50 ids a call. Another agent's id, or an unknown one, reads
// { proposal_id, status: "not_found" }. No params, evidence, votes, outcome, owner identity or owner reason. Only
// AETHER_CEILING grants it, to knowledge-council; EXTERNAL_CEILING is not widened. The grant arrives when Aether's DNA
// declares it and the census's finding is settled (CS8 pins how the census treats it today).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, fakeAi, migratedDb, registeredDb } from "./harness.ts";
import { CAPABILITIES, hourlyLimit, verifySyscallDecision } from "../src/capabilities.ts";
import { isLearningCapability } from "../src/power-mode.ts";
import { castVote, privilegedCapabilities, type Evidence, type Proposal } from "../src/consensus-rules.ts";
import { AETHER_CEILING, EXTERNAL_CEILING, EXTERNAL_ORIGINS, XAUUSD_CEILING, externalCeilingFor, externalCeilingViolations } from "../src/organism.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { rpcSyscall } from "../../ai-kernel/src/agent-rpc.ts";
import { OWNER_DECISION_WINDOW_MS, expireOwnerProposals, ownerDecide } from "../../ai-kernel/src/consensus.ts";
import { CONSENSUS_STATUS_MAX } from "../../ai-kernel/src/consensus-status.ts";
import { latestCensusRow, proposalFor } from "../../ai-kernel/src/organism.ts";
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
/** Aether's DNA declares the council's consensus.status and the grant is applied (CS8: how the census treats it today). */
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
  // The guard paths this change touches: capabilities.ts and organism.ts (the owner's click); the kernel read is routine.
  assert.equal(criticalPathReason("workers/control-plane-shared/src/capabilities.ts"), "evolution_guard");
  assert.equal(criticalPathReason("workers/control-plane-shared/src/organism.ts"), "capability_ceiling");
  for (const p of ["workers/ai-kernel/src/consensus-status.ts", "workers/ai-kernel/src/syscall.ts", "workers/control-plane-shared/test/consensus-status-2026-11-22.test.ts", "workers/control-plane-shared/test/aether-ceiling-schedule.test.ts", "docs/SSOT.md"]) {
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

test("CS9. Aether's DNA declaring it is a census finding within the ceiling; the council also holds the privileged consensus.propose, so the routine update does not apply it", async () => {
  const db = registeredDb();
  const declared = [...AETHER_CEILING.agents[COUNCIL]];
  await censusTick(db as never, repoWith(realDna()), Date.now(), [{ origin: AETHER, dna: async () => aetherDna(declared) }]);
  const census = (await latestCensusRow({ DB: db } as never))!;
  const finding = census.findings.find((f) => f.kind === "agent_capabilities_changed" && f.subject === COUNCIL)!;
  assert.ok(finding, census.findings.map((f) => `${f.kind} ${f.subject}`).join("; "));
  assert.ok(!census.findings.some((f) => f.kind === "external_agent_refused"), "within Aether's ceiling");
  // consensus.propose is privileged: the census proposes no routine update_agent_capabilities, and a vote refuses one.
  assert.deepEqual(privilegedCapabilities(declared), ["consensus.propose"]);
  assert.equal(proposalFor(census, finding), null);
  const e: Evidence = {
    agents_enabled: true, audit_valid: true, services: {}, critical_reports_24h: 0, executing_plan_targets: [], recent_same: 0,
    registry: { [HOST]: { status: "healthy", desired_version: null } },
    agents: { [COUNCIL]: { status: "enabled", host_worker: HOST, voter: false } },
  };
  const vote = castVote("policy-engine", { action: "update_agent_capabilities", target: COUNCIL, params: { service: HOST, capabilities: declared, tier_max: 1 }, class: "routine" } as Proposal, e);
  assert.equal(vote.vote, "reject");
  assert.match(vote.reason, /privileged capabilities are never updated as routine: consensus\.propose/);
  const caps = JSON.parse((db.raw.prepare("SELECT capabilities_json FROM agents WHERE agent_id = ?").get(COUNCIL) as any).capabilities_json);
  assert.deepEqual(caps.sort(), ["consensus.propose", "doctrine.status", "reports.publish"], "the registry keeps today's grants");
});

// ------------------------------------------------------------------------------------------- 4. the SSOT

test("CS10. the SSOT: line 5 carries the consensus.status entry; the external origins row names the council's read", () => {
  const ssot = read("docs/SSOT.md");
  const line5 = ssot.split("\n")[4];
  // The repository's convention: the entry may follow later entries on line 5.
  assert.match(line5, /^Last reviewed: 2026-11-16 \((?:[^\n]*; )?consensus\.status, 2026-11-22/);
  assert.ok(line5.includes(`consensus.status, 2026-11-22 (owner: "ya kerjakan nomor 1 dan semuanya"; requested for Aether's knowledge council): `));
  for (const want of ["`consensus.status`", "`knowledge-council`", "`not_found`", "`expired`", "guard path"]) assert.ok(line5.includes(want), want);
  assert.match(ssot, /\*\*External origins[^\n]*`aether-curator` may also hold the read-only `corrections\.read`[^\n]*`knowledge-council` the read-only `consensus\.status`/);
});
