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
import { appendAuditEvent, verifyAuditChainIncremental } from "../../control-plane-shared/src/audit.ts";
import { PROHIBITED_CAPABILITY, verifySyscallDecision } from "../../control-plane-shared/src/capabilities.ts";
import type { SyscallEnv } from "./syscall.ts";
import { observe } from "./syscall.ts";
import { addAgentPrincipal, setAgentStatus } from "./kernel.ts";
import { verifyConsensusExecution } from "../../control-plane-shared/src/consensus-exec.ts";

export type ConsensusClass = "routine" | "critical" | "prohibited";
export type ConsensusMode = "shadow" | "routine" | "deploy" | "critical";

/** The action catalog. Anything not listed is refused; ADR-0009 §1 classes. */
export const CONSENSUS_ACTIONS: Record<string, { class: ConsensusClass; target: "service" | "agent" | "platform"; description: string }> = {
  observe_drift: { class: "routine", target: "platform", description: "Run a drift observation now" },
  redeploy_desired_version: { class: "routine", target: "service", description: "Redeploy the registry desired version of a Worker" },
  rollback_worker_version: { class: "routine", target: "service", description: "Roll a Worker back to a version recorded as healthy" },
  deploy_commit: { class: "routine", target: "service", description: "Deploy a CI-green commit from main" },
  set_desired_version: { class: "routine", target: "service", description: "Record a desired version in the Platform Registry" },
  registry_disable_service: { class: "routine", target: "service", description: "Mark a service disabled in the registry" },
  registry_enable_service: { class: "routine", target: "service", description: "Mark a disabled service registered again" },
  suspend_agent: { class: "routine", target: "agent", description: "Suspend a misbehaving agent" },
  resume_agent: { class: "routine", target: "agent", description: "Resume a suspended agent" },
  restore_d1_bookmark: { class: "critical", target: "platform", description: "Restore D1 to a Time Travel bookmark" },
  rotate_secret: { class: "critical", target: "service", description: "Rotate a Worker secret" },
  retire_worker: { class: "critical", target: "service", description: "Retire and delete a Worker" },
  change_access: { class: "critical", target: "platform", description: "Change Cloudflare Access" },
  agents_enable: { class: "critical", target: "platform", description: "Turn agents back on after a kill-switch stop" },
  register_principal: { class: "critical", target: "agent", description: "Register an external agent principal" },
};

/** Control-plane voters (ADR-0009 §2). XAUUSD agents never vote on platform actions. */
export const VOTERS = [
  "platform-api", "deployment-orchestrator", "platform-registry", "policy-engine", "drift-detector",
  "audit-ledger", "recovery-manager", "supervisor", "auditor",
] as const;
export type Voter = (typeof VOTERS)[number];

const KERNEL_AGENTS = new Set(["supervisor", "signal-analyst", "auditor"]);
const HEX_VERSION = /^[0-9a-f]{7,40}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const TARGET = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function classify(action: string): ConsensusClass | null {
  if (PROHIBITED_CAPABILITY.test(action)) return "prohibited";
  return Object.hasOwn(CONSENSUS_ACTIONS, action) ? CONSENSUS_ACTIONS[action].class : null;
}

export async function consensusMode(env: SyscallEnv): Promise<ConsensusMode> {
  const row = await env.DB.prepare("SELECT value FROM consensus_controls WHERE control = 'mode'").first<{ value: ConsensusMode }>();
  return row?.value ?? "shadow";
}

interface ServiceState { service_id: string; drifted: boolean; persistent: boolean; desired_version: string | null; observed_version: string | null }
export interface Evidence {
  agents_enabled: boolean;
  audit_valid: boolean;
  services: Record<string, ServiceState>;
  registry: Record<string, { status: string; desired_version: string | null }>;
  agents: Record<string, { status: string; host_worker: string }>;
  critical_reports_24h: number;
  executing_plan_targets: string[];
  recent_same: number;
}

export async function gatherEvidence(env: SyscallEnv, action: string, target: string, now = Date.now()): Promise<Evidence> {
  const ov = await observe(env, now) as unknown as {
    agents_enabled: boolean; services: ServiceState[]; agent_reports_24h?: { counts?: { critical?: number } };
  };
  const chain = await verifyAuditChainIncremental(env.DB);
  const reg = await env.DB.prepare("SELECT service_id, status, desired_version FROM service_registry").all<{ service_id: string; status: string; desired_version: string | null }>();
  const ag = await env.DB.prepare("SELECT agent_id, status, host_worker FROM agents").all<{ agent_id: string; status: string; host_worker: string }>();
  const plans = await env.DB.prepare("SELECT service_id FROM recovery_plans WHERE status = 'executing'").all<{ service_id: string }>();
  const same = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM consensus_proposals WHERE action = ? AND target = ? AND created_at >= ?",
  ).bind(action, target, new Date(now - 6 * 3_600_000).toISOString()).first<{ n: number }>();
  return {
    agents_enabled: ov.agents_enabled,
    audit_valid: chain.valid,
    services: Object.fromEntries(ov.services.map((s) => [s.service_id, s])),
    registry: Object.fromEntries(reg.results.map((r) => [r.service_id, { status: r.status, desired_version: r.desired_version }])),
    agents: Object.fromEntries(ag.results.map((a) => [a.agent_id, { status: a.status, host_worker: a.host_worker }])),
    critical_reports_24h: ov.agent_reports_24h?.counts?.critical ?? 0,
    executing_plan_targets: plans.results.map((p) => p.service_id),
    recent_same: same?.n ?? 0,
  };
}

export interface Proposal { action: string; target: string; params: JsonObject; class: ConsensusClass }
export interface Vote { voter: Voter; vote: "approve" | "reject" | "abstain"; reason: string }

/** Safety gate every voter applies before its own domain rule. */
function baseline(e: Evidence): string | null {
  if (!e.agents_enabled) return "kill switch is engaged";
  if (!e.audit_valid) return "audit chain is not valid";
  if (e.critical_reports_24h > 0) return "a critical report is open in the last 24 h";
  return null;
}

const DEPLOYISH = new Set(["deploy_commit", "rollback_worker_version", "redeploy_desired_version"]);

/** One voter's deterministic decision, from its own domain. Exported for tests. */
export function castVote(voter: Voter, p: Proposal, e: Evidence): Vote {
  const v = (vote: Vote["vote"], reason: string): Vote => ({ voter, vote, reason: reason.slice(0, 300) });
  if (p.class === "prohibited") return v("reject", "prohibited action");
  const base = baseline(e);
  if (base && p.action !== "agents_enable") return v("reject", base);
  const svc = e.services[p.target];
  const reg = e.registry[p.target];
  const version = String(p.params.version ?? "");
  switch (voter) {
    case "platform-registry":
      if (CONSENSUS_ACTIONS[p.action].target === "service") {
        if (!reg) return v("reject", `${p.target} is not in the registry`);
        if (p.action === "registry_enable_service") return reg.status === "disabled" ? v("approve", "service is disabled; enabling is consistent") : v("reject", "service is not disabled");
        if (reg.status === "disabled" && p.action !== "registry_disable_service") return v("reject", "service is disabled in the registry");
        if (p.action === "set_desired_version" && !HEX_VERSION.test(version)) return v("reject", "version is not a 7-40 hex tag");
        return v("approve", "target is registered and active");
      }
      return v("approve", "no registry objection");
    case "drift-detector":
      if (p.action === "redeploy_desired_version" || p.action === "rollback_worker_version") {
        if (!svc) return v("reject", "no drift observation for the target");
        return svc.drifted ? v("approve", `target drifted${svc.persistent ? " persistently" : ""}`) : v("reject", "target is in sync; nothing to remediate");
      }
      if (p.action === "deploy_commit") {
        const persistent = Object.values(e.services).filter((s) => s.persistent && s.service_id !== p.target);
        return persistent.length ? v("reject", `other services drift persistently: ${persistent.map((s) => s.service_id).join(", ")}`) : v("approve", "platform is stable");
      }
      return v("approve", "no drift objection");
    case "policy-engine":
      if (e.recent_same > 0) return v("reject", "the same action on the same target was proposed in the last 6 h");
      return v("approve", "class and rate limits allow it");
    case "audit-ledger":
      return v("approve", "audit chain verified");
    case "recovery-manager":
      if (e.executing_plan_targets.includes(p.target)) return v("reject", "a recovery plan is executing on the target");
      return v("approve", "no executing recovery plan on the target");
    case "deployment-orchestrator":
      if (p.action === "deploy_commit") return COMMIT.test(String(p.params.commit_sha ?? "")) ? v("approve", "commit is a full SHA") : v("reject", "commit_sha must be a full 40-hex SHA");
      if (p.action === "redeploy_desired_version") return reg?.desired_version ? v("approve", `desired version ${reg.desired_version} is recorded`) : v("reject", "no desired version recorded");
      if (p.action === "rollback_worker_version") return HEX_VERSION.test(version) ? v("approve", "rollback version is a recorded tag") : v("reject", "rollback version must be a 7-40 hex tag");
      return v("approve", "no deployment objection");
    case "supervisor":
      if (p.action === "suspend_agent" || p.action === "resume_agent") {
        const a = e.agents[p.target];
        if (!a) return v("reject", "agent is not registered");
        if (KERNEL_AGENTS.has(p.target)) return v("reject", "kernel-hosted agents are not suspended by consensus");
        return v("approve", `agent is ${a.status}`);
      }
      if (DEPLOYISH.has(p.action) && svc && !svc.drifted && p.action !== "deploy_commit") return v("reject", "target is healthy and in sync");
      return v("approve", "consistent with supervisor observations");
    case "auditor":
      return v("approve", "no critical evidence open");
    case "platform-api":
      return v("approve", "platform overview nominal");
  }
}

/** Routine actions with an executor in phase 2 (reversible; no deploys). Deploys come in phase 3. */
export const PHASE2_EXECUTABLE = new Set(["observe_drift", "set_desired_version", "registry_disable_service", "registry_enable_service", "suspend_agent", "resume_agent"]);
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

  const evidence = await gatherEvidence(env, action, target, now);
  const eligible = VOTERS.filter((id) => id !== proposer && evidence.agents[id]?.status === "enabled");
  const votes = eligible.map((voter) => castVote(voter, p, evidence));
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
 *    which deletes only Workers in its RETIRABLE list whose source is gone from main.
 * Restoring D1, rotating secrets, changing Access and turning agents back on stay manual:
 * they need credentials no Worker holds, or already have a direct approver control.
 */
export const OWNER_DECISION_WINDOW_MS = 24 * 3_600_000;
export const PHASE4_EXECUTABLE = new Set(["register_principal", "retire_worker"]);

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
