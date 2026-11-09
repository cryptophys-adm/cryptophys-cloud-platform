// The one route table of the Console UI (TP-024 §1.3 and §4). Every entry equals a
// CONSOLE_ALLOW_LIST row by service, method and path. The table is embedded into the client
// JavaScript with JSON.stringify(UI_ROUTES); the client builds every API call from it.
//
// `confirm` is the typed phrase template, or null. In a template, {id} is the route's first
// path parameter, {id13} its first 13 characters and {sha12} the first 12 of commit_sha.

export interface UiRoute {
  id: string;
  service: string;
  method: string;
  path: string;
  approverOnly: boolean;
  confirm: string | null;
}

const r = (id: string, service: string, method: string, path: string, approverOnly: boolean, confirm: string | null): UiRoute =>
  ({ id, service, method, path, approverOnly, confirm });

export const UI_ROUTES: readonly UiRoute[] = [
  r("platform.overview", "platform", "GET", "/v1/overview", false, null),
  r("forge.status", "forge", "GET", "/v1/forge/status", false, null),
  r("forge.commits", "forge", "GET", "/v1/forge/commits", false, null),
  r("forge.checks", "forge", "GET", "/v1/forge/checks", false, null),
  r("forge.changes", "forge", "GET", "/v1/forge/changes", false, null),
  r("forge.deploy_plans", "forge", "GET", "/v1/forge/deploy-plans", false, null),
  r("kernel.kernel", "kernel", "GET", "/v1/kernel", false, null),
  r("kernel.status", "kernel", "GET", "/v1/status", false, null),
  r("kernel.notices", "kernel", "GET", "/v1/notices", false, null),
  r("kernel.reports", "kernel", "GET", "/v1/reports", false, null),
  r("kernel.agents", "kernel", "GET", "/v1/agents", false, null),
  r("kernel.agent", "kernel", "GET", "/v1/agents/{id}", false, null),
  r("kernel.agent_actions", "kernel", "GET", "/v1/agents/{id}/actions", false, null),
  r("kernel.consensus", "kernel", "GET", "/v1/consensus", false, null),
  r("kernel.consensus_proposal", "kernel", "GET", "/v1/consensus/{id}", false, null),
  r("kernel.consensus_report", "kernel", "GET", "/v1/consensus/report", false, null),
  r("kernel.consensus_mode_raise", "kernel", "POST", "/v1/consensus/mode", true, "RAISE MODE"),
  r("kernel.consensus_mode_shadow", "kernel", "POST", "/v1/consensus/mode", false, "SHADOW"),
  r("kernel.consensus_approve", "kernel", "POST", "/v1/consensus/{id}/approve", true, "APPROVE {id13}"),
  r("kernel.consensus_reject", "kernel", "POST", "/v1/consensus/{id}/reject", true, "REJECT {id13}"),
  // TP-028: learned-knowledge proposals from Aether; an approver approves them for shadow testing or rejects them.
  r("kernel.knowledge", "kernel", "GET", "/v1/knowledge", false, null),
  r("kernel.knowledge_approve", "kernel", "POST", "/v1/knowledge/{id}/approve", true, "APPROVE {id13}"),
  r("kernel.knowledge_reject", "kernel", "POST", "/v1/knowledge/{id}/reject", true, "REJECT {id13}"),
  r("kernel.agents_disabled", "kernel", "POST", "/v1/kernel/agents-enabled", false, "AGENTS OFF"),
  r("kernel.agents_enabled", "kernel", "POST", "/v1/kernel/agents-enabled", true, "AGENTS ON"),
  r("kernel.wake", "kernel", "POST", "/v1/agents/{id}/wake", false, "WAKE {id}"),
  r("kernel.suspend", "kernel", "POST", "/v1/agents/{id}/suspend", false, "SUSPEND {id}"),
  r("kernel.resume", "kernel", "POST", "/v1/agents/{id}/resume", true, "RESUME {id}"),
  r("kernel.principal_add", "kernel", "POST", "/v1/agents/{id}/principals", true, "PRINCIPAL {id}"),
  r("kernel.principal_remove", "kernel", "DELETE", "/v1/agents/{id}/principals/{id}", true, "REVOKE {id}"),
  r("recovery.plans", "recovery", "GET", "/v1/plans", false, null),
  r("recovery.plan", "recovery", "GET", "/v1/plans/{id}", false, null),
  r("recovery.create", "recovery", "POST", "/v1/plans", true, "CREATE PLAN"),
  r("recovery.approve", "recovery", "POST", "/v1/plans/{id}/approve", true, "APPROVE {id13}"),
  r("recovery.disable", "recovery", "POST", "/v1/plans/{id}/disable", false, "DISABLE {id13}"),
  r("registry.services", "registry", "GET", "/v1/services", false, null),
  r("registry.service", "registry", "GET", "/v1/services/{id}", false, null),
  r("registry.upsert", "registry", "PUT", "/v1/services/{id}", true, "UPDATE {id}"),
  r("registry.desired_version", "registry", "PUT", "/v1/services/{id}/desired-version", true, "VERSION {id}"),
  // Users page (owner decision 2026-11-07): owners manage accounts; the server checks the owner and the phrase.
  r("registry.accounts", "registry", "GET", "/v1/accounts", false, null),
  r("registry.account_upsert", "registry", "POST", "/v1/accounts", true, "GRANT"),
  r("registry.account_disable", "registry", "POST", "/v1/accounts/{id}/disable", true, "REVOKE"),
  r("registry.accounts_sync", "registry", "POST", "/v1/accounts/sync-login", true, "SYNC"),
  r("policy.decisions", "policy", "GET", "/v1/decisions", false, null),
  r("policy.decision", "policy", "GET", "/v1/decisions/{id}", false, null),
  r("policy.evaluate", "policy", "POST", "/v1/evaluate", false, null),
  r("drift.list", "drift", "GET", "/v1/drift", false, null),
  r("drift.observe", "drift", "POST", "/v1/observe", false, null),
  r("audit.events", "audit", "GET", "/v1/events", false, null),
  r("audit.event", "audit", "GET", "/v1/events/{id}", false, null),
  r("audit.verify", "audit", "GET", "/v1/verify", false, null),
  r("orchestrator.deployments", "orchestrator", "GET", "/v1/deployments", false, null),
  r("orchestrator.deploy", "orchestrator", "POST", "/v1/deployments", false, "DEPLOY {sha12}"),
];
