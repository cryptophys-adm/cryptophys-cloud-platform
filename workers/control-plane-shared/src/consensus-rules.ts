/**
 * ADR-0009 consensus rules, shared by the AI Kernel (tally) and every voting Worker (Wave C, C1:
 * each control-plane Worker casts its own vote over RPC, from its own reads of its domain). Pure
 * functions and constants only: no bindings, no I/O.
 */
import type { JsonObject } from "./http.ts";
import { CAPABILITIES, PROHIBITED_CAPABILITY } from "./capabilities.ts";
import { POLICY_PARAMETERS, isPolicyParameter, validPolicyValue } from "./policy-params.ts";
import { DOCTRINE_ACTIONS, doctrineProblem } from "./doctrine.ts";

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
  // Owner 2026-11-11: "hardening juga untuk dismantle dan delete agent yang sudah tidak berkontribusi".
  retire_agent: { class: "routine", target: "agent", description: "Dismantle an agent that no longer contributes: deleted when no record refers to it, otherwise suspended as retired" },
  restore_d1_bookmark: { class: "critical", target: "platform", description: "Restore D1 to a Time Travel bookmark" },
  rotate_secret: { class: "critical", target: "service", description: "Rotate a Worker secret" },
  retire_worker: { class: "critical", target: "service", description: "Retire and delete a Worker" },
  change_access: { class: "critical", target: "platform", description: "Change Cloudflare Access" },
  agents_enable: { class: "critical", target: "platform", description: "Turn agents back on after a kill-switch stop" },
  register_principal: { class: "critical", target: "agent", description: "Register an external agent principal" },
  // ADR-0013 phase 3: self-registration from the DNA census (owner decisions 2026-11-09).
  register_agent: { class: "routine", target: "agent", description: "Register an agent its Worker's DNA declares (no privileged capability)" },
  register_engine: { class: "routine", target: "service", description: "Register an AI engine (task) its Worker's DNA declares" },
  register_privileged_agent: { class: "critical", target: "agent", description: "Register a DNA-declared agent that asks for a privileged capability" },
  admit_voter: { class: "critical", target: "agent", description: "Give a registered agent a council seat (one per Worker)" },
  // Owner 2026-11-10: the council may change Policy Engine parameters by consensus alone, inside hard bounds in code.
  set_policy_parameter: { class: "routine", target: "platform", description: "Change a council-adjustable Policy Engine parameter within its hard bounds" },
  // Owner 2026-11-11: the Knowledge Council's daily doctrine amendments (control-plane-shared/src/doctrine.ts).
  amend_doctrine: { class: "routine", target: "platform", description: "Amend an operational doctrine rule of the Aether Canon to the measured state, inside its hard bounds" },
  amend_constitution: { class: "critical", target: "platform", description: "Amend a constitutional doctrine rule, or a fact without bounds; one owner approval click" },
};

/**
 * The founding council (ADR-0009 §2). Since ADR-0013 phase 3 the council is data: the agents with
 * agents.voter = 1 (migration 0041 seeds exactly these nine). This list keeps each founder's domain
 * rule below and the identity check of the voting Workers' RPC. XAUUSD agents never vote.
 */
export const VOTERS = [
  "platform-api", "deployment-orchestrator", "platform-registry", "policy-engine", "drift-detector",
  "audit-ledger", "recovery-manager", "supervisor", "auditor",
] as const;
export type Voter = string;

export const KERNEL_AGENTS = new Set(["supervisor", "signal-analyst", "auditor"]);
/**
 * Hosts whose agents are never retired for idleness (owner 2026-11-11):
 *  - cryptophys-aether: still under deployment;
 *  - xauusd-ai-trading-assistant: its agents speak in its own rooms and report to the kernel only on a
 *    change, so kernel idleness says nothing about their contribution; XAUUSD dismantles its own agents
 *    from its room data (outcome scores, bias share), and their identities are removed by migration.
 */
export const RETIRE_EXEMPT_HOSTS = new Set(["cryptophys-aether", "xauusd-ai-trading-assistant"]);
/** An agent registered this long ago with no action, report or vote in this window is proposed for retirement. */
export const RETIRE_IDLE_DAYS = 14;
export const HEX_VERSION = /^[0-9a-f]{7,40}$/;
export const COMMIT = /^[0-9a-f]{40}$/;
export const TARGET = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** A capability is privileged when it is above tier 1, or lets an agent drive the platform (consensus.propose). */
export function privilegedCapabilities(caps: string[]): string[] {
  return caps.filter((c) => !Object.hasOwn(CAPABILITIES, c) || CAPABILITIES[c].tier >= 2 || c === "consensus.propose");
}
/** Capabilities that can never be registered: unknown, prohibited (trading, funds) or tier 3 (human only, ADR-0007). */
export function forbiddenCapabilities(caps: string[]): string[] {
  return caps.filter((c) => !Object.hasOwn(CAPABILITIES, c) || PROHIBITED_CAPABILITY.test(c) || CAPABILITIES[c].tier >= 3);
}
/** The current council: enabled agents holding a seat. */
export function councilSeats(e: Pick<Evidence, "agents">): string[] {
  return Object.entries(e.agents).filter(([, a]) => a.voter && a.status === "enabled").map(([id]) => id).sort();
}
const REGISTRATION = new Set(["register_agent", "register_privileged_agent"]);
const ENGINE_TASK = /^[a-z][a-z0-9_]{2,62}$/;

/** Votes on ADR-0013 registrations, shared by every voter: the facts each one can check. */
function registrationVote(voter: string, p: Proposal, e: Evidence): { vote: Vote["vote"]; reason: string } | null {
  if (REGISTRATION.has(p.action)) {
    if (e.agents[p.target]) return { vote: "reject", reason: "agent is already registered" };
    const host = String(p.params.service ?? "");
    const reg = e.registry[host];
    if (!reg || reg.status === "disabled") return { vote: "reject", reason: `host Worker ${host || "(none)"} is not an active registered service` };
    const caps = Array.isArray(p.params.capabilities) ? p.params.capabilities.map(String) : null;
    if (!caps) return { vote: "reject", reason: "capabilities must be a list" };
    const forbidden = forbiddenCapabilities(caps);
    if (forbidden.length) return { vote: "reject", reason: `unknown or prohibited capabilities: ${forbidden.join(", ")}` };
    const privileged = privilegedCapabilities(caps);
    if (p.action === "register_agent" && privileged.length) return { vote: "reject", reason: `privileged capabilities need register_privileged_agent: ${privileged.join(", ")}` };
    return { vote: "approve", reason: voter === "supervisor" ? "declared in the DNA census" : "registration is consistent" };
  }
  if (p.action === "register_engine") {
    if (!ENGINE_TASK.test(String(p.params.task ?? ""))) return { vote: "reject", reason: "task must be a lowercase identifier" };
    return null; // the registry rule (target service registered and active) and the others apply
  }
  if (DOCTRINE_ACTIONS.has(p.action)) {
    const problem = doctrineProblem(p.action, p.target, p.params);
    if (problem) return { vote: "reject", reason: problem };
    return { vote: "approve", reason: p.action === "amend_doctrine" ? "every amended fact is inside its hard bounds" : "the amendment is well formed; the owner decides" };
  }
  if (p.action === "set_policy_parameter") {
    if (!isPolicyParameter(p.target)) return { vote: "reject", reason: `${p.target} is not a council-adjustable policy parameter` };
    const b = POLICY_PARAMETERS[p.target];
    if (!validPolicyValue(p.target, p.params.value)) return { vote: "reject", reason: `value must be an integer from ${b.min} to ${b.max}` };
    return { vote: "approve", reason: `${p.params.value} is inside the hard bounds ${b.min}-${b.max}` };
  }
  if (p.action === "admit_voter") {
    const a = e.agents[p.target];
    if (!a) return { vote: "reject", reason: "agent is not registered" };
    if (a.status !== "enabled") return { vote: "reject", reason: `agent is ${a.status}` };
    if (a.voter) return { vote: "reject", reason: "agent already holds a seat" };
    const sameHost = Object.entries(e.agents).find(([id, o]) => id !== p.target && o.voter && o.host_worker === a.host_worker);
    if (sameHost) return { vote: "reject", reason: `one seat per Worker: ${sameHost[0]} already holds ${a.host_worker}'s seat` };
    return { vote: "approve", reason: "agent is registered, enabled and its Worker has no seat" };
  }
  return null;
}

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
  agents: Record<string, { status: string; host_worker: string; voter?: boolean }>;
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
  const registration = registrationVote(voter, p, e);
  if (registration) return v(registration.vote, registration.reason);
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
      if (p.action === "retire_agent") {
        const a = e.agents[p.target];
        if (!a) return v("reject", "agent is not registered");
        if (KERNEL_AGENTS.has(p.target)) return v("reject", "kernel-hosted agents are not retired by consensus");
        if (a.voter) return v("reject", "a council seat is not retired by a routine action");
        if (RETIRE_EXEMPT_HOSTS.has(a.host_worker)) return v("reject", `agents of ${a.host_worker} are exempt from retirement`);
        return v("approve", `agent is ${a.status} and holds no seat`);
      }
      if (DEPLOYISH.has(p.action) && svc && !svc.drifted && p.action !== "deploy_commit") return v("reject", "target is healthy and in sync");
      return v("approve", "consistent with supervisor observations");
    case "auditor":
      return v("approve", "no critical evidence open");
    case "platform-api":
      return v("approve", "platform overview nominal");
    default:
      // A seat admitted after the founders (ADR-0013): it applies the shared baseline and rules above.
      return v("approve", "no objection");
  }
}
