/**
 * Consensus autonomy (ADR-0009). A control-plane agent proposes a platform action; the other
 * eligible control-plane agents vote; a simple majority plus a Policy Engine allow passes it.
 *
 * Phase 1 is shadow mode: proposals are classified, voted, tallied and policy-checked, and
 * everything is recorded and audited, but nothing executes. Later phases execute routine
 * actions (and critical ones after an owner click) through the platform's existing paths.
 *
 * Votes are deterministic: each voter applies the checks of its own domain to one evidence
 * snapshot taken at proposal time. AI is never consulted for a vote.
 */
import type { JsonObject } from "../../control-plane-shared/src/http.ts";
import { newId, nowIso } from "../../control-plane-shared/src/http.ts";
import { appendAuditEvent, appendAuditEventWithMutation, AuditMutationConflictError, verifyAuditChainIncremental } from "../../control-plane-shared/src/audit.ts";
import { PROHIBITED_CAPABILITY, verifySyscallDecision } from "../../control-plane-shared/src/capabilities.ts";
import type { SyscallEnv } from "./syscall.ts";
import {
  CONSENSUS_ACTIONS, KERNEL_AGENTS, TARGET, VOTERS, castVote, classify, councilSeats,
  type ConsensusClass, type ConsensusMode, type Evidence, type Proposal, type ServiceState, type Vote, type Voter,
} from "../../control-plane-shared/src/consensus-rules.ts";
export { CONSENSUS_ACTIONS, VOTERS, castVote, classify, type ConsensusClass, type ConsensusMode, type Evidence, type Proposal, type Vote, type Voter };
import { observe } from "./syscall.ts";
import { addAgentPrincipal, retireAgent, setAgentStatus } from "./kernel.ts";
import { verifyConsensusExecution } from "../../control-plane-shared/src/consensus-exec.ts";
import { executeRegistration } from "./organism.ts";
import { isPolicyParameter, readPolicyParameter, validPolicyValue } from "../../control-plane-shared/src/policy-params.ts";
import { DOCTRINE_ACTIONS, DOCTRINE_COUNCIL_AGENT, doctrineProblem } from "../../control-plane-shared/src/doctrine.ts";

/**
 * Owner 2026-11-11: Cerebrum executes the Knowledge Council's doctrine amendment. It records the
 * amendment (doctrine_amendments, migration 0045) with its audit event; Aether reads the executed
 * amendments through doctrine.status and applies only those.
 */
async function recordDoctrineAmendment(env: SyscallEnv, proposalId: string, decisionId: string, p: Proposal, actor: string): Promise<JsonObject> {
  await verifyConsensusExecution(env.DB, proposalId, decisionId, p.action, p.target);
  const problem = doctrineProblem(p.action, p.target, p.params);
  if (problem) throw new Error(`invalid_doctrine_amendment: ${problem}`);
  const at = nowIso();
  const rule = String(p.params.rule);
  await appendAuditEventWithMutation(env.DB, {
    event_type: "doctrine.amended", actor, subject: `doctrine:${rule}`, outcome: p.action,
    payload: { proposal_id: proposalId, rule, values: p.params.values, previous: p.params.previous, canon: p.params.canon, session: p.params.session },
  }, () => env.DB.prepare(
    `INSERT INTO doctrine_amendments (amendment_id, rule_id, action, values_json, previous_json, canon, session_id, executed_by, executed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(proposalId, rule, p.action, JSON.stringify(p.params.values), JSON.stringify(p.params.previous), String(p.params.canon), String(p.params.session), actor, at));
  return { rule, values: p.params.values, executed_at: at };
}

/** Owner 2026-11-10: the council changes a Policy Engine parameter, only inside its hard bounds; audited with the write. */
async function setPolicyParameter(env: SyscallEnv, proposalId: string, decisionId: string, p: Proposal, actor: string): Promise<JsonObject> {
  await verifyConsensusExecution(env.DB, proposalId, decisionId, p.action, p.target);
  if (!isPolicyParameter(p.target)) throw new Error("unknown_policy_parameter");
  const value = p.params.value;
  if (!validPolicyValue(p.target, value)) throw new Error("value_outside_hard_bounds");
  const previous = await readPolicyParameter(env.DB, p.target);
  await appendAuditEventWithMutation(env.DB, {
    event_type: "policy.parameter_changed", actor, subject: `policy:${p.target}`, outcome: String(value),
    payload: { proposal_id: proposalId, parameter: p.target, previous, value },
  }, () => env.DB.prepare(
    `INSERT INTO policy_parameters (name, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(p.target, value, actor, nowIso()));
  return { parameter: p.target, previous, value };
}

/** ADR-0013 phase 3 registrations: routine ones run in phase 2's set, seats and privileged agents after an owner click. */
const ROUTINE_REGISTRATIONS = ["register_agent", "register_engine", "set_policy_parameter"];
const CRITICAL_REGISTRATIONS = ["register_privileged_agent", "admit_voter"];


export async function consensusMode(env: SyscallEnv): Promise<ConsensusMode> {
  const row = await env.DB.prepare("SELECT value FROM consensus_controls WHERE control = 'mode'").first<{ value: ConsensusMode }>();
  return row?.value ?? "shadow";
}


export async function gatherEvidence(env: SyscallEnv, action: string, target: string, now = Date.now()): Promise<Evidence> {
  const ov = await observe(env, now) as unknown as {
    agents_enabled: boolean; services: ServiceState[]; agent_reports_24h?: { counts?: { critical?: number } };
  };
  const chain = await verifyAuditChainIncremental(env.DB);
  const reg = await env.DB.prepare("SELECT service_id, status, desired_version FROM service_registry").all<{ service_id: string; status: string; desired_version: string | null }>();
  // ADR-0013: the council is data (agents.voter, migration 0041). Before 0041 is applied the founding
  // seats stand in, so a deploy that ships this code ahead of its migration keeps voting.
  let ag: { results: Array<{ agent_id: string; status: string; host_worker: string; voter: number }> };
  try {
    ag = await env.DB.prepare("SELECT agent_id, status, host_worker, voter FROM agents").all<{ agent_id: string; status: string; host_worker: string; voter: number }>();
  } catch {
    const legacy = await env.DB.prepare("SELECT agent_id, status, host_worker FROM agents").all<{ agent_id: string; status: string; host_worker: string }>();
    ag = { results: legacy.results.map((a) => ({ ...a, voter: (VOTERS as readonly string[]).includes(a.agent_id) ? 1 : 0 })) };
  }
  const plans = await env.DB.prepare("SELECT service_id FROM recovery_plans WHERE status = 'executing'").all<{ service_id: string }>();
  const same = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM consensus_proposals WHERE action = ? AND target = ? AND created_at >= ?",
  ).bind(action, target, new Date(now - 6 * 3_600_000).toISOString()).first<{ n: number }>();
  return {
    agents_enabled: ov.agents_enabled,
    audit_valid: chain.valid,
    services: Object.fromEntries(ov.services.map((s) => [s.service_id, s])),
    registry: Object.fromEntries(reg.results.map((r) => [r.service_id, { status: r.status, desired_version: r.desired_version }])),
    agents: Object.fromEntries(ag.results.map((a) => [a.agent_id, { status: a.status, host_worker: a.host_worker, voter: a.voter === 1 }])),
    critical_reports_24h: ov.agent_reports_24h?.counts?.critical ?? 0,
    executing_plan_targets: plans.results.map((p) => p.service_id),
    recent_same: same?.n ?? 0,
  };
}


/** Routine actions with an executor in phase 2 (reversible; no deploys). Deploys come in phase 3. */
export const PHASE2_EXECUTABLE = new Set(["observe_drift", "set_desired_version", "registry_disable_service", "registry_enable_service", "suspend_agent", "resume_agent", "amend_doctrine", ...ROUTINE_REGISTRATIONS]);
/** Phase 3 adds deploys of CI-green main commits, executed only in the 'deploy' (or later) mode. */
export const PHASE3_EXECUTABLE = new Set([...PHASE2_EXECUTABLE, "deploy_commit", "rollback_worker_version"]);

/** What the current mode lets the kernel execute. Shadow executes nothing. */
export function executableIn(mode: ConsensusMode): Set<string> {
  if (mode === "routine") return PHASE2_EXECUTABLE;
  if (mode === "deploy" || mode === "critical") return PHASE3_EXECUTABLE;
  return new Set();
}

/** Run one passed routine action through its owning path. Targets re-verify the proposal. */
async function executeAction(env: SyscallEnv, proposalId: string, decisionId: string, p: Proposal): Promise<JsonObject> {
  const actor = `consensus:${proposalId}`;
  switch (p.action) {
    case "suspend_agent":
    case "resume_agent": {
      if (KERNEL_AGENTS.has(p.target)) throw new Error("kernel_agent_internal");
      await verifyConsensusExecution(env.DB, proposalId, decisionId, p.action, p.target);
      const status = p.action === "suspend_agent" ? "suspended" : "enabled";
      const reason = String(p.params.reason ?? `consensus ${proposalId}`).slice(0, 200);
      return { agent: await setAgentStatus(env as never, p.target, status, actor, reason) };
    }
    case "set_desired_version":
    case "registry_disable_service":
    case "registry_enable_service":
      if (!env.REGISTRY) throw new Error("registry_binding_missing");
      return await env.REGISTRY.applyConsensus(proposalId, decisionId, p.action, p.target, p.params);
    case "rollback_worker_version":
      if (!env.DEPLOY?.rollbackForConsensus) throw new Error("deploy_binding_missing");
      return await env.DEPLOY.rollbackForConsensus(proposalId, decisionId, p.target, p.params);
    case "deploy_commit":
      if (!env.DEPLOY) throw new Error("deploy_binding_missing");
      return await env.DEPLOY.deployForConsensus(proposalId, decisionId, p.target, p.params);
    case "observe_drift":
      if (!env.DRIFT) throw new Error("drift_binding_missing");
      return await env.DRIFT.observeForConsensus(proposalId, decisionId);
    case "register_agent":
    case "register_engine":
      return await executeRegistration(env, proposalId, decisionId, p, actor, (id) => canVote(env, id));
    case "set_policy_parameter":
      return await setPolicyParameter(env, proposalId, decisionId, p, actor);
    case "amend_doctrine":
      return await recordDoctrineAmendment(env, proposalId, decisionId, p, actor);
    default:
      throw new Error("no_executor");
  }
}

export interface ProposeResult extends JsonObject {
  proposal_id: string; class: ConsensusClass; mode: ConsensusMode; eligible: number; approvals: number; rejections: number;
  passed: boolean; policy_decision: "allow" | "deny" | null; status: string;
}

/** Validate, vote, tally, policy-check and record a proposal. Called through syscall("consensus.propose"). */
export async function propose(env: SyscallEnv, proposer: string, decisionId: string, input: JsonObject, now = Date.now()): Promise<ProposeResult> {
  await verifySyscallDecision(env.DB, decisionId, proposer, "consensus.propose", now);
  const action = String(input.action ?? "");
  const target = String(input.target ?? "");
  const params = input.params && typeof input.params === "object" && !Array.isArray(input.params) ? input.params as JsonObject : {};
  const cls = classify(action);
  if (!cls) throw new Error("unknown_action");
  if (!TARGET.test(target)) throw new Error("invalid_target");
  if (JSON.stringify(params).length > 2000) throw new Error("params_too_large");
  const p: Proposal = { action, target, params, class: cls };
  // The Knowledge Council proposes doctrine amendments and nothing else; no other agent amends doctrine.
  if (DOCTRINE_ACTIONS.has(action) !== (proposer === DOCTRINE_COUNCIL_AGENT)) throw new Error(proposer === DOCTRINE_COUNCIL_AGENT ? "council_doctrine_only" : "doctrine_council_only");
  if (DOCTRINE_ACTIONS.has(action)) {
    const problem = doctrineProblem(action, target, params);
    if (problem) throw new Error(`invalid_doctrine_amendment: ${problem}`);
  }

  const evidence = await gatherEvidence(env, action, target, now);
  const eligible = councilSeats(evidence).filter((id) => id !== proposer);
  const votes = await collectVotes(env, eligible, p, evidence);
  const approvals = votes.filter((x) => x.vote === "approve").length;
  const rejections = votes.filter((x) => x.vote === "reject").length;
  const passed = cls !== "prohibited" && approvals * 2 > eligible.length;

  let policy: { decision: "allow" | "deny"; decision_id: string; reason: string } | null = null;
  if (cls !== "prohibited") {
    try {
      policy = await env.POLICY.evaluate({ subject: `agent:${proposer}`, action: "consensus.execute", resource: `${action}:${target}`, context: { class: cls, passed } });
    } catch {
      policy = null;
    }
  }
  const mode = await consensusMode(env);
  const allowed = passed && policy?.decision === "allow";
  const executable = allowed && cls === "routine" && executableIn(mode).has(action);
  let status = !allowed ? (cls === "prohibited" || !passed ? "rejected" : "shadow_blocked")
    : mode === "shadow" ? "shadow_passed"
    : cls === "critical" ? (mode === "critical" ? "pending_owner" : "shadow_passed")
    : executable ? "executing"
    : "shadow_passed"; // a passed routine action with no executor yet (deploys arrive in phase 3)
  let outcome: JsonObject = {
    executed: false,
    reason: mode === "shadow" ? "shadow mode: phase 1 records only"
      : cls === "critical" && allowed ? (mode === "critical" ? "waiting for an owner approval click" : "critical actions reach the owner only in mode critical")
      : allowed && !executable ? `no executor for ${action} in this phase` : "not executed",
  };

  const proposalId = newId("cns");
  const at = new Date(now).toISOString();
  const evidenceSummary: JsonObject = {
    agents_enabled: evidence.agents_enabled, audit_valid: evidence.audit_valid, critical_reports_24h: evidence.critical_reports_24h,
    target_service: evidence.services[target] as unknown as JsonObject ?? null, target_registry: evidence.registry[target] as unknown as JsonObject ?? null,
    policy_reason: policy?.reason ?? "policy_unavailable",
    votes_via: { rpc: votes.filter((v) => v.via === "rpc").length, kernel: votes.filter((v) => v.via === "kernel").length, unreachable: votes.filter((v) => v.via === "unreachable").length },
  };
  await env.DB.prepare(
    `INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible,
       approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(proposalId, proposer, action, target, cls, JSON.stringify(params), JSON.stringify(evidenceSummary), mode, eligible.length,
    approvals, rejections, passed ? 1 : 0, policy?.decision_id ?? null, policy?.decision ?? null, status,
    JSON.stringify(outcome), at, nowIso()).run();
  for (const x of votes) {
    await env.DB.prepare("INSERT INTO consensus_votes (proposal_id, voter_agent_id, vote, reason, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(proposalId, x.voter, x.vote, x.reason, at).run();
  }
  if (executable) {
    try {
      const result = await executeAction(env, proposalId, policy!.decision_id, p);
      status = "executed";
      outcome = { executed: true, result };
    } catch (err) {
      status = "failed";
      outcome = { executed: false, error: String((err as Error)?.message ?? err).slice(0, 300) };
    }
    await env.DB.prepare("UPDATE consensus_proposals SET status = ?, outcome_json = ?, decided_at = ? WHERE proposal_id = ?")
      .bind(status, JSON.stringify(outcome), nowIso(), proposalId).run();
    await appendAuditEvent(env.DB, {
      event_type: "consensus.executed", actor: `agent:${proposer}`, subject: `${action}:${target}`, outcome: status,
      payload: { proposal_id: proposalId, policy_decision_id: policy!.decision_id, outcome },
    });
  }
  await appendAuditEvent(env.DB, {
    event_type: "consensus.tallied", actor: `agent:${proposer}`, subject: `${action}:${target}`, outcome: status,
    payload: { proposal_id: proposalId, class: cls, mode, eligible: eligible.length, approvals, rejections, passed, policy: policy?.decision ?? null, policy_decision_id: policy?.decision_id ?? null },
  });
  return { proposal_id: proposalId, class: cls, mode, eligible: eligible.length, approvals, rejections, passed, policy_decision: policy?.decision ?? null, status };
}

export async function listProposals(env: SyscallEnv, limit = 50): Promise<JsonObject> {
  const rows = await env.DB.prepare("SELECT * FROM consensus_proposals ORDER BY created_at DESC, rowid DESC LIMIT ?").bind(Math.min(Math.max(limit, 1), 200)).all<Record<string, unknown>>();
  const mode = await consensusMode(env);
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const stats = await env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM consensus_proposals WHERE created_at >= ? GROUP BY status",
  ).bind(since).all<{ status: string; n: number }>();
  return {
    mode,
    stats_24h: Object.fromEntries(stats.results.map((s) => [s.status, s.n])),
    proposals: rows.results.map((r) => ({ ...r, params: JSON.parse(String(r.params_json)), evidence: JSON.parse(String(r.evidence_json)), outcome: r.outcome_json ? JSON.parse(String(r.outcome_json)) : null, params_json: undefined, evidence_json: undefined, outcome_json: undefined, passed: r.passed === 1 })),
  };
}

export async function getProposal(env: SyscallEnv, id: string): Promise<JsonObject | null> {
  const r = await env.DB.prepare("SELECT * FROM consensus_proposals WHERE proposal_id = ?").bind(id).first<Record<string, unknown>>();
  if (!r) return null;
  const votes = await env.DB.prepare("SELECT voter_agent_id, vote, reason, created_at FROM consensus_votes WHERE proposal_id = ? ORDER BY voter_agent_id").bind(id).all();
  const owner = await env.DB.prepare("SELECT decision, decided_by, reason, created_at FROM consensus_owner_decisions WHERE proposal_id = ?").bind(id).first<JsonObject>();
  return { owner_decision: owner ?? null, proposal: { ...r, params: JSON.parse(String(r.params_json)), evidence: JSON.parse(String(r.evidence_json)), outcome: r.outcome_json ? JSON.parse(String(r.outcome_json)) : null, params_json: undefined, evidence_json: undefined, outcome_json: undefined, passed: r.passed === 1 }, votes: votes.results };
}

/**
 * ADR-0009 phase 4: critical actions. After consensus and a Policy Engine allow, a critical
 * proposal waits (status pending_owner, mode 'critical' only) for one click by a person in
 * APPROVER_IDENTITIES. Approval re-runs the Policy Engine with the owner decision on record,
 * then executes through the owning path, which re-verifies everything again.
 *
 * Executors exist only where the platform already owns the operation:
 *  - register_principal: the kernel's own principal registry (params.access_identity);
 *  - retire_worker: the Deployment Orchestrator dispatches the narrow Retire Worker workflow,
 *    which deletes only Workers in its RETIRABLE list whose source is gone from main;
 *  - retire_agent (owner 2026-11-11, ADR-0013 §3): the kernel deletes an agent no row refers to, or
 *    suspends it as retired; kernel agents, council seats and exempt hosts are refused.
 * Restoring D1, rotating secrets, changing Access and turning agents back on stay manual:
 * they need credentials no Worker holds, or already have a direct approver control.
 */
export const OWNER_DECISION_WINDOW_MS = 24 * 3_600_000;
export const PHASE4_EXECUTABLE = new Set(["register_principal", "retire_worker", "retire_agent", "amend_constitution", ...CRITICAL_REGISTRATIONS]);

export class OwnerDecisionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(`${code}: ${message}`); this.status = status; this.code = code; }
}

async function executeCritical(env: SyscallEnv, proposalId: string, decisionId: string, p: { action: string; target: string; params: JsonObject }, approver: string): Promise<JsonObject> {
  await verifyConsensusExecution(env.DB, proposalId, decisionId, p.action, p.target);
  if (p.action === "register_principal") {
    const res = await addAgentPrincipal(env as never, p.target, p.params.access_identity, `owner:${approver} via consensus:${proposalId}`);
    if (res.status >= 400) throw new Error(String(res.body.error ?? `principal_failed_${res.status}`));
    return res.body;
  }
  if (p.action === "retire_worker") {
    if (!env.DEPLOY) throw new Error("deploy_binding_missing");
    return await env.DEPLOY.retireForConsensus(proposalId, decisionId, p.target);
  }
  if (p.action === "retire_agent") {
    return await retireAgent(env as never, p.target, `owner:${approver} via consensus:${proposalId}`, String(p.params.reason ?? `consensus ${proposalId}`).slice(0, 200));
  }
  if (p.action === "amend_constitution") {
    return await recordDoctrineAmendment(env, proposalId, decisionId, { ...p, class: "critical" }, `owner:${approver} via consensus:${proposalId}`);
  }
  if (CRITICAL_REGISTRATIONS.includes(p.action)) {
    return await executeRegistration(env, proposalId, decisionId, p, `owner:${approver} via consensus:${proposalId}`, (id) => canVote(env, id));
  }
  throw new Error("manual_only");
}

export async function ownerDecide(env: SyscallEnv, proposalId: string, decision: "approve" | "reject", approver: string, reasonRaw: unknown, now = Date.now()): Promise<JsonObject> {
  if (!/^cns_[0-9a-f-]{36}$/.test(proposalId)) throw new OwnerDecisionError(404, "not_found", "unknown proposal");
  // A person decides: Access service tokens (CI, agents) are never owners.
  if (!/^[^@\s]{1,100}@[^@\s]{1,100}$/.test(approver)) throw new OwnerDecisionError(403, "person_required", "an owner decision needs a person's Access identity");
  const reason = typeof reasonRaw === "string" && reasonRaw.trim() ? reasonRaw.trim().slice(0, 500) : null;
  const p = await env.DB.prepare("SELECT proposal_id, proposer_agent_id, action, target, class, params_json, passed, status, created_at FROM consensus_proposals WHERE proposal_id = ?")
    .bind(proposalId).first<{ proposal_id: string; proposer_agent_id: string; action: string; target: string; class: string; params_json: string; passed: number; status: string; created_at: string }>();
  if (!p) throw new OwnerDecisionError(404, "not_found", "unknown proposal");
  if (p.class !== "critical" || p.status !== "pending_owner") throw new OwnerDecisionError(409, "not_pending_owner", `proposal is ${p.status}`);
  if (now - Date.parse(p.created_at) > OWNER_DECISION_WINDOW_MS) {
    await env.DB.prepare("UPDATE consensus_proposals SET status = 'expired', decided_at = ? WHERE proposal_id = ? AND status = 'pending_owner'").bind(nowIso(), proposalId).run();
    throw new OwnerDecisionError(409, "expired", "the 24 h owner window has passed; the agents must propose again");
  }
  const subject = `${p.action}:${p.target}`;
  if (decision === "approve") {
    if ((await consensusMode(env)) !== "critical") throw new OwnerDecisionError(409, "mode_not_critical", "critical actions execute only in consensus mode 'critical'");
    if (!PHASE4_EXECUTABLE.has(p.action)) throw new OwnerDecisionError(409, "manual_only", `${p.action} has no platform executor; carry it out by its runbook and reject this proposal`);
  }
  try {
    await env.DB.prepare("INSERT INTO consensus_owner_decisions (proposal_id, decision, decided_by, reason, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(proposalId, decision, approver, reason, nowIso()).run();
  } catch {
    throw new OwnerDecisionError(409, "already_decided", "this proposal already has an owner decision");
  }
  await appendAuditEvent(env.DB, {
    event_type: decision === "approve" ? "consensus.owner_approved" : "consensus.owner_rejected",
    actor: approver, subject, outcome: decision, payload: { proposal_id: proposalId, reason },
  });
  if (decision === "reject") {
    const outcome = { executed: false, owner_rejected_by: approver, reason };
    await env.DB.prepare("UPDATE consensus_proposals SET status = 'rejected', outcome_json = ?, decided_at = ? WHERE proposal_id = ?")
      .bind(JSON.stringify(outcome), nowIso(), proposalId).run();
    return { proposal_id: proposalId, status: "rejected", outcome };
  }
  // Fresh Policy Engine decision with the owner approval on record (the tally-time decision is older than 10 min).
  let policy: { decision: "allow" | "deny"; decision_id: string; reason: string } | null = null;
  try {
    policy = await env.POLICY.evaluate({ subject: `owner:${approver}`, action: "consensus.execute", resource: subject,
      context: { class: "critical", passed: p.passed === 1, stage: "execute", proposal_id: proposalId } });
  } catch { policy = null; }
  if (policy?.decision !== "allow") {
    const outcome = { executed: false, error: `policy_denied: ${policy?.reason ?? "policy_unavailable"}`, approved_by: approver };
    await env.DB.prepare("UPDATE consensus_proposals SET status = 'failed', outcome_json = ?, policy_decision_id = ?, policy_decision = ?, decided_at = ? WHERE proposal_id = ?")
      .bind(JSON.stringify(outcome), policy?.decision_id ?? null, policy?.decision ?? null, nowIso(), proposalId).run();
    await appendAuditEvent(env.DB, { event_type: "consensus.executed", actor: approver, subject, outcome: "failed", payload: { proposal_id: proposalId, outcome } });
    return { proposal_id: proposalId, status: "failed", outcome };
  }
  await env.DB.prepare("UPDATE consensus_proposals SET status = 'executing', policy_decision_id = ?, policy_decision = 'allow', decided_at = ? WHERE proposal_id = ?")
    .bind(policy.decision_id, nowIso(), proposalId).run();
  let status = "executed";
  let outcome: JsonObject;
  try {
    outcome = { executed: true, approved_by: approver, result: await executeCritical(env, proposalId, policy.decision_id, { action: p.action, target: p.target, params: JSON.parse(p.params_json) }, approver) };
  } catch (err) {
    status = "failed";
    outcome = { executed: false, approved_by: approver, error: String((err as Error)?.message ?? err).slice(0, 300) };
  }
  await env.DB.prepare("UPDATE consensus_proposals SET status = ?, outcome_json = ?, decided_at = ? WHERE proposal_id = ?")
    .bind(status, JSON.stringify(outcome), nowIso(), proposalId).run();
  await appendAuditEvent(env.DB, { event_type: "consensus.executed", actor: approver, subject, outcome: status, payload: { proposal_id: proposalId, policy_decision_id: policy.decision_id, outcome } });
  return { proposal_id: proposalId, status, outcome };
}

/** Pending owner decisions lapse after 24 h; the scheduled supervisor cycle sweeps them. */
export async function expireOwnerProposals(env: SyscallEnv, now = Date.now()): Promise<number> {
  const res = await env.DB.prepare("UPDATE consensus_proposals SET status = 'expired', decided_at = ? WHERE status = 'pending_owner' AND created_at < ?")
    .bind(nowIso(), new Date(now - OWNER_DECISION_WINDOW_MS).toISOString()).run();
  return res.meta.changes ?? 0;
}

/**
 * Wave B: the shadow agreement report, the evidence for promoting the consensus mode (ADR-0009
 * phase 1 criterion: every shadow_passed proposal matches what a person would have done).
 *
 * For each proposal older than its scoring delay, did people do the same thing on their own?
 *  - deploy_commit X@S: the registry recorded S as X's desired version within 24 h (a person,
 *    or a deploy workflow a person dispatched, deployed it).
 *  - redeploy_desired_version / rollback_worker_version X: X was observed in sync within 2 h.
 *  - other actions: a non-agent audit event on X within 24 h.
 * agree = (passed and people acted) or (not passed and people did not); a passed proposal people
 * did not act on is a false positive; a refused one they acted on, a false negative.
 */
const SCORE_DELAY_MS: Record<string, number> = { deploy_commit: 24 * 3_600_000, redeploy_desired_version: 2 * 3_600_000, rollback_worker_version: 2 * 3_600_000 };
const DEFAULT_SCORE_DELAY_MS = 24 * 3_600_000;

export async function agreementReport(env: SyscallEnv, days = 7, now = Date.now()): Promise<JsonObject> {
  const window = Math.min(Math.max(Math.trunc(days) || 7, 1), 30);
  const since = new Date(now - window * 86_400_000).toISOString();
  const rows = await env.DB.prepare(
    "SELECT proposal_id, action, target, class, status, passed, params_json, created_at FROM consensus_proposals WHERE created_at >= ? AND class != 'prohibited' ORDER BY created_at DESC LIMIT 500",
  ).bind(since).all<{ proposal_id: string; action: string; target: string; class: string; status: string; passed: number; params_json: string; created_at: string }>();
  const counts = { agree: 0, false_positive: 0, false_negative: 0, pending: 0 };
  const byAction: Record<string, { agree: number; false_positive: number; false_negative: number; pending: number }> = {};
  const items: JsonObject[] = [];
  for (const p of rows.results) {
    const created = Date.parse(p.created_at);
    const delay = SCORE_DELAY_MS[p.action] ?? DEFAULT_SCORE_DELAY_MS;
    const passed = p.passed === 1 && p.status !== "rejected" && p.status !== "shadow_blocked";
    let verdict: keyof typeof counts;
    let evidence = "";
    if (now - created < delay) {
      verdict = "pending";
      evidence = `scored after ${Math.round(delay / 3_600_000)} h`;
    } else {
      const end = new Date(created + delay).toISOString();
      let acted = false;
      if (p.action === "deploy_commit") {
        const sha = String((JSON.parse(p.params_json) as JsonObject).commit_sha ?? "").slice(0, 12);
        const ev = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'registry.desired_version_set' AND subject = ? AND created_at BETWEEN ? AND ? AND instr(payload_json, ?) > 0",
        ).bind(p.target, p.created_at, end, sha || "-").first<{ n: number }>();
        acted = (ev?.n ?? 0) > 0;
        evidence = acted ? `${p.target} reached ${sha} within 24 h` : `${p.target} did not reach ${sha} within 24 h`;
      } else if (p.action === "redeploy_desired_version" || p.action === "rollback_worker_version") {
        const ok = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM drift_observations WHERE service_id = ? AND drifted = 0 AND observed_at BETWEEN ? AND ?",
        ).bind(p.target, p.created_at, end).first<{ n: number }>();
        acted = (ok?.n ?? 0) > 0;
        evidence = acted ? `${p.target} back in sync within 2 h` : `${p.target} still drifted after 2 h`;
      } else {
        const ev = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM audit_events WHERE (subject = ? OR subject = ?) AND actor NOT LIKE 'agent:%' AND actor NOT LIKE 'consensus:%' AND actor NOT LIKE 'workflow:%' AND created_at BETWEEN ? AND ?",
        ).bind(p.target, `agent:${p.target}`, p.created_at, end).first<{ n: number }>();
        acted = (ev?.n ?? 0) > 0;
        evidence = acted ? "a person acted on the target within 24 h" : "no person acted on the target within 24 h";
      }
      verdict = passed === acted ? "agree" : passed ? "false_positive" : "false_negative";
    }
    counts[verdict]++;
    (byAction[p.action] ??= { agree: 0, false_positive: 0, false_negative: 0, pending: 0 })[verdict]++;
    if (items.length < 50) items.push({ proposal_id: p.proposal_id, action: p.action, target: p.target, status: p.status, verdict, evidence, created_at: p.created_at });
  }
  const scored = counts.agree + counts.false_positive + counts.false_negative;
  return {
    window_days: window,
    since,
    total: rows.results.length,
    scored,
    ...counts,
    agreement_rate: scored ? Math.round((counts.agree / scored) * 1000) / 1000 : null,
    by_action: byAction as unknown as JsonObject,
    items,
  };
}

/**
 * Wave C (C1): each control-plane Worker votes in its own code, over RPC, from its own reads of
 * its domain (VoteRpc, control-plane-shared/src/consensus-vote.ts). The kernel-hosted voters
 * (supervisor, auditor) vote here. A Worker without a binding falls back to the kernel's rule on
 * the snapshot; a Worker that does not answer within 8 s, or answers out of shape, abstains,
 * which counts against the proposal.
 */
const VOTE_BINDINGS: Record<string, keyof SyscallEnv> = {
  "platform-api": "VOTE_PLATFORM_API",
  "deployment-orchestrator": "VOTE_DEPLOYMENT_ORCHESTRATOR",
  "platform-registry": "VOTE_PLATFORM_REGISTRY",
  "policy-engine": "VOTE_POLICY_ENGINE",
  "drift-detector": "VOTE_DRIFT_DETECTOR",
  "audit-ledger": "VOTE_AUDIT_LEDGER",
  "recovery-manager": "VOTE_RECOVERY_MANAGER",
};
export const VOTE_TIMEOUT_MS = 8_000;

/**
 * Whether a seat can vote through reviewed code: its Worker's VoteRpc is bound in this deployment, or
 * it is a founding seat with its own rule in castVote (the kernel-hosted supervisor and auditor).
 */
export function canVote(env: SyscallEnv, agentId: string): boolean {
  const name = VOTE_BINDINGS[agentId];
  return name ? Boolean(env[name]) : (VOTERS as readonly string[]).includes(agentId);
}

export async function collectVotes(env: SyscallEnv, eligible: Voter[], p: Proposal, evidence: Evidence): Promise<(Vote & { via: "rpc" | "kernel" | "unreachable" })[]> {
  return Promise.all(eligible.map(async (voter) => {
    const name = VOTE_BINDINGS[voter];
    const binding = name ? (env[name] as { vote(v: string, p: JsonObject, e: JsonObject): Promise<JsonObject> } | undefined) : undefined;
    // ADR-0013: a seat admitted after the founders votes only through its own Worker. Without a
    // binding it abstains and is reported; the kernel never casts a vote on its behalf.
    if (!binding && !(VOTERS as readonly string[]).includes(voter)) {
      return { voter, vote: "abstain" as const, reason: "seat has no vote binding in this deployment", via: "unreachable" as const };
    }
    if (!binding) return { ...castVote(voter, p, evidence), via: "kernel" as const };
    try {
      const out = await Promise.race([
        binding.vote(voter, p as unknown as JsonObject, evidence as unknown as JsonObject),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), VOTE_TIMEOUT_MS)),
      ]) as { voter?: unknown; vote?: unknown; reason?: unknown };
      if (out?.voter !== voter || !["approve", "reject", "abstain"].includes(String(out.vote)) || typeof out.reason !== "string") throw new Error("malformed vote");
      return { voter, vote: out.vote as Vote["vote"], reason: out.reason.slice(0, 300), via: "rpc" as const };
    } catch (err) {
      return { voter, vote: "abstain" as const, reason: `voter unreachable: ${String((err as Error)?.message ?? err).slice(0, 120)}`, via: "unreachable" as const };
    }
  }));
}

/**
 * Owner decision 2026-11-06 ("Align + promote to deploy now"): the consensus mode is changed by a
 * person, never by an agent or a migration. Raising it (more autonomy) needs an approver who is a
 * person; lowering it toward shadow is an emergency brake any operator may pull. Every change is
 * audited. Changing the rules, voters or classes stays prohibited (ADR-0009 §1).
 */
export const MODE_ORDER: ConsensusMode[] = ["shadow", "routine", "deploy", "critical"];

export async function setConsensusMode(env: SyscallEnv, modeRaw: unknown, actor: string, actorType: "user" | "service_token", isApprover: boolean, confirmationRaw: unknown, reasonRaw: unknown): Promise<JsonObject> {
  const mode = String(modeRaw ?? "") as ConsensusMode;
  if (!MODE_ORDER.includes(mode)) throw new OwnerDecisionError(400, "invalid_mode", `mode must be one of ${MODE_ORDER.join(", ")}`);
  const current = await consensusMode(env);
  const reason = typeof reasonRaw === "string" && reasonRaw.trim() ? reasonRaw.trim().slice(0, 300) : null;
  const currentIndex = MODE_ORDER.indexOf(current);
  const targetIndex = MODE_ORDER.indexOf(mode);
  const raising = targetIndex > currentIndex;
  const lowering = targetIndex < currentIndex;
  if (lowering && mode !== "shadow") throw new OwnerDecisionError(400, "invalid_transition", "lowering the consensus mode must use the shadow emergency brake");
  if (raising) {
    if (!isApprover) throw new OwnerDecisionError(403, "approver_required", "raising the consensus mode needs an approver");
    if (actorType !== "user" || !/^[^@\s]{1,100}@[^@\s]{1,100}$/.test(actor)) throw new OwnerDecisionError(403, "person_required", "raising the consensus mode needs a person's Access identity");
  }
  if (mode !== current) {
    const requiredConfirmation = raising ? "RAISE MODE" : mode === "shadow" ? "SHADOW" : null;
    if (requiredConfirmation && confirmationRaw !== requiredConfirmation) {
      throw new OwnerDecisionError(400, "confirmation_required", `mode change requires the exact confirmation ${requiredConfirmation}`);
    }
    try {
      await appendAuditEventWithMutation(
        env.DB,
        { event_type: "consensus.mode_changed", actor, subject: "consensus", outcome: mode, payload: { previous: current, mode, reason } },
        (event) => env.DB.prepare("UPDATE consensus_controls SET value = ?, updated_by = ?, updated_at = ? WHERE control = 'mode' AND value = ?").bind(mode, actor, event.created_at, current),
      );
    } catch (err) {
      if (err instanceof AuditMutationConflictError) {
        throw new OwnerDecisionError(409, "mode_changed_concurrently", "consensus mode changed while this request was in progress; reload and retry");
      }
      throw err;
    }
  }
  return { previous: current, mode, changed: mode !== current };
}
