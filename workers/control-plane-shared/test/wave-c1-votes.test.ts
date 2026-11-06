// Wave C, C1: each control-plane Worker casts its own consensus vote over RPC, from its own reads
// of its domain; an unreachable voter abstains (counts against).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, fakeAi, fakeWorkflow, migratedDb } from "./harness.ts";
import { verifySyscallDecision } from "../src/capabilities.ts";
import { castDomainVote } from "../src/consensus-vote.ts";
import { castVote, type Evidence, type Proposal, type Voter } from "../src/consensus-rules.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { proposeFromAgent } from "../../recovery-manager/src/index.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { gatherEvidence } from "../../ai-kernel/src/consensus.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const RPC_VOTERS = ["platform-api", "deployment-orchestrator", "platform-registry", "policy-engine", "drift-detector", "audit-ledger", "recovery-manager"] as const;
const bindingName = (v: string) => `VOTE_${v.toUpperCase().replace(/-/g, "_")}`;

function kernelEnv(db: Db, votes: Record<string, unknown>) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const recoveryEnv = { ...baseEnv("cryptophys-recovery-manager", db), RECOVERY_LIFECYCLE: fakeWorkflow().binding };
  return {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async (a: string, d: string, i: Record<string, unknown>) => { await verifySyscallDecision(db, d, a, "recovery.propose"); return proposeFromAgent(recoveryEnv as never, a, i); } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    ...votes,
  };
}

/** A VoteRpc binding as each Worker exposes it: votes only as itself, from its own reads. */
function voteRpc(db: Db, own: string, calls: string[]) {
  return { vote: async (voter: string, proposal: Proposal, snapshot: Evidence) => {
    calls.push(voter);
    if (voter !== own) throw new Error("wrong_voter");
    return castDomainVote(db as never, voter as Voter, proposal, snapshot);
  } };
}

const lastVotes = (db: Db) => {
  const p = db.raw.prepare("SELECT proposal_id, evidence_json FROM consensus_proposals ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as any;
  return { via: JSON.parse(p.evidence_json).votes_via, votes: Object.fromEntries((db.raw.prepare("SELECT voter_agent_id, vote, reason FROM consensus_votes WHERE proposal_id = ?").all(p.proposal_id) as any[]).map((v) => [v.voter_agent_id, v])) };
};

test("C1. the seven Worker voters vote over RPC; the kernel-hosted auditor votes locally", async () => {
  const db = migratedDb();
  const calls: string[] = [];
  const env = kernelEnv(db, Object.fromEntries(RPC_VOTERS.map((v) => [bindingName(v), voteRpc(db, v, calls)])));
  const r = await syscall(env as never, "supervisor", "consensus.propose", { action: "observe_drift", target: "platform" });
  assert.equal(r.outcome, "succeeded");
  assert.deepEqual(calls.sort(), [...RPC_VOTERS].sort());
  assert.deepEqual(lastVotes(db).via, { rpc: 7, kernel: 1, unreachable: 0 });
});

test("C1. a voter that does not answer abstains, which counts against the proposal", async () => {
  const db = migratedDb();
  const calls: string[] = [];
  const bindings: Record<string, unknown> = Object.fromEntries(RPC_VOTERS.map((v) => [bindingName(v), voteRpc(db, v, calls)]));
  for (const v of ["platform-registry", "policy-engine", "drift-detector", "audit-ledger", "recovery-manager"]) bindings[bindingName(v)] = { vote: async () => { throw new Error("down"); } };
  const env = kernelEnv(db, bindings);
  await syscall(env as never, "supervisor", "consensus.propose", { action: "observe_drift", target: "platform" });
  const { via, votes } = lastVotes(db);
  assert.equal(via.unreachable, 5);
  assert.equal(votes["drift-detector"].vote, "abstain");
  assert.match(votes["drift-detector"].reason, /voter unreachable/);
  const p = db.raw.prepare("SELECT passed, status FROM consensus_proposals ORDER BY rowid DESC LIMIT 1").get() as any;
  assert.equal(p.passed, 0, "3 of 8 approvals is not a majority");
});

test("C1. each Worker re-reads its own domain: the registry and drift voters see live state, not the snapshot", async () => {
  const db = migratedDb();
  const snapshot = await gatherEvidence({ DB: db } as never, "registry_enable_service", "cryptophys-policy-engine");
  const proposal: Proposal = { action: "registry_enable_service", target: "cryptophys-policy-engine", params: {}, class: "routine" };
  // The snapshot says the service is disabled, the registry now says it is registered: the registry voter rejects.
  const stale: Evidence = { ...snapshot, registry: { ...snapshot.registry, "cryptophys-policy-engine": { status: "disabled", desired_version: null } } };
  assert.equal(castVote("platform-registry", proposal, stale).vote, "approve", "the snapshot alone would approve");
  assert.equal((await castDomainVote(db as never, "platform-registry", proposal, stale)).vote, "reject");
  // The kill switch is always re-read.
  db.raw.prepare("UPDATE kernel_controls SET value = '0' WHERE control = 'agents_enabled'").run();
  assert.match((await castDomainVote(db as never, "audit-ledger", proposal, snapshot)).reason, /kill switch/);
});

test("C1. wiring: every voting Worker exports VoteRpc and votes only as itself; the kernel binds all seven", () => {
  const toml = readFileSync(new URL("workers/ai-kernel/wrangler.toml", ROOT), "utf8");
  for (const v of RPC_VOTERS) {
    assert.match(toml, new RegExp(`binding = "${bindingName(v)}"\\nservice = "cryptophys-${v}"\\nentrypoint = "VoteRpc"`), v);
    const w = readFileSync(new URL(`workers/${v}/src/worker.ts`, ROOT), "utf8");
    assert.match(w, /export class VoteRpc extends WorkerEntrypoint/, v);
    assert.match(w, new RegExp(`if \\(voter !== "${v}"\\) throw new Error\\("wrong_voter"\\)`), v);
  }
});
