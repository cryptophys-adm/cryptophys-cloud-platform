/**
 * ADR-0009 consensus rules, shared by the AI Kernel (tally) and every voting Worker (Wave C, C1:
 * each control-plane Worker casts its own vote over RPC, from its own reads of its domain). Pure
 * functions and constants only: no bindings, no I/O.
 */
import type { JsonObject } from "./http.ts";
import { PROHIBITED_CAPABILITY } from "./capabilities.ts";

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

export const KERNEL_AGENTS = new Set(["supervisor", "signal-analyst", "auditor"]);
export const HEX_VERSION = /^[0-9a-f]{7,40}$/;
export const COMMIT = /^[0-9a-f]{40}$/;
export const TARGET = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function classify(action: string): ConsensusClass | null {
  if (PROHIBITED_CAPABILITY.test(action)) return "prohibited";
  return Object.hasOwn(CONSENSUS_ACTIONS, action) ? CONSENSUS_ACTIONS[action].class : null;
}

export interface ServiceState { service_id: string; drifted: boolean; persistent: boolean; desired_version: string | null; observed_version: string | null }
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

export interface Proposal { action: string; target: string; params: JsonObject; class: ConsensusClass }
export interface Vote { voter: Voter; vote: "approve" | "reject" | "abstain"; reason: string }

/** Safety gate every voter applies before its own domain rule. */
export function baseline(e: Evidence): string | null {
  if (!e.agents_enabled) return "kill switch is engaged";
  if (!e.audit_valid) return "audit chain is not valid";
  if (e.critical_reports_24h > 0) return "a critical report is open in the last 24 h";
  return null;
}

export const DEPLOYISH = new Set(["deploy_commit", "rollback_worker_version", "redeploy_desired_version"]);

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
