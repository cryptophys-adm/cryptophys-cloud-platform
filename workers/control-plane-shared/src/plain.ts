// Plain-English wording for operators (owner request 2026-11-07: "operator kebingungan" with
// machine-like agent output; reports in English). Deterministic, no AI: every internal code the
// operator can see maps to a short sentence. Used by agent report titles and by the Console.
// Unknown codes fall back to the code with underscores turned into spaces, never to nothing.

const SERVICE_NAMES: Record<string, string> = {
  "cryptophys-ai-kernel": "AI Kernel",
  "cryptophys-audit-ledger": "Audit Ledger",
  "cryptophys-console": "Cerebrum Console",
  "cryptophys-deployment-orchestrator": "Deployment Orchestrator",
  "cryptophys-drift-detector": "Drift Detector",
  "cryptophys-forge": "Forge",
  "cryptophys-home": "Home (retired)",
  "cryptophys-platform-api": "Platform API",
  "cryptophys-platform-registry": "Platform Registry",
  "cryptophys-policy-engine": "Policy Engine",
  "cryptophys-recovery-manager": "Recovery Manager",
  "cryptophys-aether": "Aether",
};

/** "cryptophys-policy-engine" -> "Policy Engine"; other ids get readable words. */
export function serviceName(id: string | null | undefined): string {
  if (!id) return "the platform";
  if (SERVICE_NAMES[id]) return SERVICE_NAMES[id];
  return id.replace(/^cryptophys-/, "").split("-")
    .map((w) => (w === "xauusd" ? "XAUUSD" : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
}

/** Policy checks, drift reasons and deployment rejections, as sentences. */
export const REASON_TEXT: Record<string, string> = {
  // Policy Engine checks
  agents_enabled: "the agents' kill switch is off",
  ci_green: "the commit's automated checks have not all passed",
  class_known: "the action type is not recognised",
  commit_sha_valid: "the commit reference is not a full commit ID",
  consensus_passed: "the agents did not reach a majority",
  explicit_confirmation: "the confirmation word was missing or wrong",
  known_action: "the action is not one the platform allows",
  not_prohibited: "the action is prohibited (anything that moves funds)",
  trading_is_critical: "a trading action needs the owner's click (critical class)",
  trading_capability_privileged: "a trading capability must be tier 2 or above",
  operator_acknowledged: "an operator has not acknowledged the plan",
  owner_approved: "an owner has not approved it yet",
  plan_approved: "the recovery plan is not approved",
  plan_exists: "the recovery plan does not exist",
  platform_daily_limit: "the daily limit of deploys or rollbacks is reached; it can run tomorrow",
  production_environment: "the target is not a production service",
  separation_of_duties: "the person who wrote the plan cannot also approve it",
  service_enabled: "the service is disabled",
  service_id_valid: "the service name is not valid",
  service_registered: "the service is not in the Platform Registry",
  target_rate_limit: "this service was already changed in the last hour; it will be retried after that",
  // Drift reasons
  version_mismatch: "the running version differs from the expected version",
  observed_version_unavailable: "the service is healthy but did not report its version (for example after a settings or secret change)",
  desired_version_unset: "no expected version is recorded for this service",
  health_check_failed: "the health check failed",
  no_observation_binding: "the Drift Detector has no connection to this service",
  // Deployment rejections
  ci_not_green: "the commit's automated checks have not all passed",
  commit_not_current_main: "only the latest commit on main can be deployed",
  production_confirmation_required: "the production confirmation word was missing",
  duplicate_production_deployment_request: "the same deployment was already requested",
  github_ci_lookup_failed: "GitHub could not be asked about the checks; it will be retried",
  github_ref_lookup_failed: "GitHub could not be asked for the latest commit; it will be retried",
  production_dispatch_failed: "GitHub did not start the deploy workflow",
  // Agent syscall outcomes and AI status
  rate_limit: "the agent asked too often and was slowed down",
  embed_daily_budget_exhausted: "the daily AI memory budget is used up; it resets at 00:00 UTC",
  daily_budget_exhausted: "the daily AI budget is used up; a fixed template was used instead",
  deterministic: "written from a fixed template (no AI)",
  invalid_output: "the AI answer was unusable; a fixed template was used instead",
  unavailable: "AI was not available; a fixed template was used instead",
};

const words = (code: string) => code.replace(/[_:]+/g, " ").trim();

/** One code -> sentence fragment. */
export function explainCode(code: string): string {
  const c = code.trim();
  return REASON_TEXT[c] ?? words(c);
}

/**
 * A reason string as the services write it ("failed: target_rate_limit, ci_green",
 * "all policy checks passed", "observed_version_unavailable") -> a sentence.
 */
export function explainReason(reason: string | null | undefined): string {
  if (!reason) return "";
  const r = reason.trim();
  if (/^all policy checks passed$/i.test(r)) return "All safety checks passed.";
  const failed = /^failed:\s*(.+)$/i.exec(r);
  const codes = (failed ? failed[1] : r).split(/[,;]\s*/).filter(Boolean);
  if (codes.every((c) => /^[a-z0-9_:]+$/.test(c))) {
    const text = codes.map(explainCode).join("; ");
    return `${failed ? "Blocked: " : ""}${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
  }
  return r;
}

const ACTION_TEXT: Record<string, string> = {
  deploy_commit: "deploy the latest code to",
  rollback_worker_version: "roll back",
  redeploy_desired_version: "redeploy the expected version of",
  observe_drift: "check for drift on",
  suspend_agent: "pause the agent",
  resume_agent: "resume the agent",
  retire_agent: "dismantle the idle agent",
  register_principal: "register an external agent for",
  register_agent: "register the new agent",
  register_privileged_agent: "register the new privileged agent",
  register_engine: "register a new AI engine on",
  admit_voter: "give a council seat to",
  set_policy_parameter: "change the policy parameter",
  retire_worker: "retire",
  "consensus.execute": "carry out",
  "recovery.execute": "run the recovery plan for",
  deploy: "deploy",
};

/** "deploy_commit" + "cryptophys-policy-engine" -> "deploy the latest code to Policy Engine". */
export function describeAction(action: string, target?: string | null): string {
  const verb = ACTION_TEXT[action] ?? words(action);
  return target ? `${verb} ${target.startsWith("cryptophys-") || target.startsWith("xauusd-") ? serviceName(target) : target}` : verb;
}

/** "deploy_commit:cryptophys-x" style resources. */
export function describeResource(resource: string): string {
  const i = resource.indexOf(":");
  return i > 0 ? describeAction(resource.slice(0, i), resource.slice(i + 1)) : describeAction(resource);
}
