/**
 * AI Worker OS capability catalog (ADR-0007). The single source of truth for what an agent
 * syscall may do, at which autonomy tier. Shared by the Policy Engine (which decides) and the
 * AI Kernel (which dispatches); an agent cannot widen it.
 *
 *  Tier 0 observe   read-only; authorized in the kernel against this catalog, not persisted.
 *  Tier 1 propose   creates a draft that a human must approve (e.g. a recovery plan).
 *  Tier 2 act       reversible, bounded action; allowed by policy with a rate limit and kill switch.
 *  Tier 3 human     irreversible (deploy, secrets, data deletion); never allowed for an agent.
 * Trading, orders, wallets and fund movements are prohibited at every tier (ADR-0005 §3).
 */
import type { D1Database } from "./types.ts";

export type Tier = 0 | 1 | 2 | 3;
export interface Capability { tier: Tier; reversible: boolean; description: string; max_per_hour?: number }

export const CAPABILITIES: Record<string, Capability> = {
  "platform.observe": { tier: 0, reversible: true, description: "Read drift, recovery plans, agent state and the 24 h report summary" },
  "signals.observe": { tier: 0, reversible: true, description: "Read the latest XAUUSD advisory decisions from xauusd-ai-trading-assistant" },
  "audit.verify": { tier: 0, reversible: true, description: "Verify the audit hash chain and count 24-hour governance events" },
  "memory.recall": { tier: 0, reversible: true, description: "Recall up to 5 semantically similar memories owned by the calling agent" },
  "recovery.propose": { tier: 1, reversible: true, description: "Create a draft recovery plan; a human approver must approve it", max_per_hour: 6 },
  "reports.publish": { tier: 1, reversible: true, description: "Publish an advisory agent report to agent_reports", max_per_hour: 4 },
  "memory.remember": { tier: 1, reversible: true, description: "Store a bounded memory row in D1 and vector in Vectorize", max_per_hour: 12 },
  "consensus.propose": { tier: 1, reversible: true, description: "Propose a platform action to the control-plane consensus (ADR-0009); voting and the Policy Engine decide", max_per_hour: 4 },
  "deploy.release": { tier: 3, reversible: false, description: "Deploy a new Worker version (GitHub Actions with human gates only)" },
  "secrets.rotate": { tier: 3, reversible: false, description: "Rotate or replace a secret (human only)" },
  "data.delete": { tier: 3, reversible: false, description: "Delete or rewrite stored data (human only)" },
};

/** Prohibited at every tier, whatever an agent's registry entry says. */
export const PROHIBITED_CAPABILITY = /trad(e|ing)|order|broker|exchange[._-]?account|wallet|withdraw|transfer|sign[._-]?tx|swap|mev/i;

export const AGENT_SUBJECT = /^agent:([a-z0-9-]{2,40})$/;

export interface AgentRow {
  agent_id: string;
  display_name: string;
  host_worker: string;
  purpose: string;
  tier_max: number;
  capabilities_json: string;
  status: string;
  status_reason: string | null;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface AgentPrincipalRow {
  access_identity: string;
  agent_id: string;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
}

export interface CapabilityCheck { id: string; passed: boolean; detail: string }

export const getAgent = (db: D1Database, agentId: string) =>
  db.prepare("SELECT * FROM agents WHERE agent_id = ?").bind(agentId).first<AgentRow>();

export const getActivePrincipalByIdentity = (db: D1Database, accessIdentity: string) =>
  db.prepare("SELECT * FROM agent_principals WHERE access_identity = ? AND revoked_at IS NULL").bind(accessIdentity).first<AgentPrincipalRow>();

export async function hasActivePrincipal(db: D1Database, agentId: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS x FROM agent_principals WHERE agent_id = ? AND revoked_at IS NULL LIMIT 1").bind(agentId).first<{ x: number }>();
  return Boolean(row);
}

export async function agentsEnabled(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT value FROM kernel_controls WHERE control = 'agents_enabled'").first<{ value: string }>();
  return row?.value === "1";
}

/**
 * The deterministic syscall checks. The Policy Engine runs them for tier >= 1 (persisted and
 * audited); the kernel runs the same function for tier 0 reads. AI is never consulted.
 */
export async function agentSyscallChecks(db: D1Database, subject: string, capability: string, now = Date.now()): Promise<CapabilityCheck[]> {
  const checks: CapabilityCheck[] = [];
  const add = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
  const m = AGENT_SUBJECT.exec(subject);
  add("subject_is_agent", Boolean(m), "subject must be agent:<agent_id>");
  const agent = m ? await getAgent(db, m[1]) : null;
  add("agent_registered", Boolean(agent), "the agent must be registered in the agents table");
  add("agent_enabled", agent?.status === "enabled", "the agent must not be suspended");
  add("agents_enabled", await agentsEnabled(db), "the global agent kill switch must be on");
  const cap = Object.hasOwn(CAPABILITIES, capability) ? CAPABILITIES[capability] : undefined;
  add("capability_known", Boolean(cap), "capability must be in the catalog");
  add("capability_not_prohibited", !PROHIBITED_CAPABILITY.test(capability), "trading, orders, wallets and fund movements are prohibited");
  let granted: unknown = [];
  try { granted = JSON.parse(agent?.capabilities_json ?? "[]"); } catch { granted = []; }
  add("capability_granted", Array.isArray(granted) && granted.includes(capability), "capability must be granted to this agent");
  add("tier_within_agent_limit", Boolean(cap) && Boolean(agent) && cap!.tier <= agent!.tier_max, "capability tier must not exceed the agent's tier_max");
  if (agent && (await hasActivePrincipal(db, agent.agent_id))) {
    add("external_tier_limit", Boolean(cap) && cap!.tier <= 1, "agents with an active external principal may only use tier <= 1 capabilities");
  }
  add("not_human_only", Boolean(cap) && cap!.tier < 3, "tier 3 capabilities require a human");
  if (cap?.max_per_hour && agent) {
    const since = new Date(now - 3_600_000).toISOString();
    const used = await db.prepare(
      "SELECT COUNT(*) AS n FROM agent_syscall_consumptions WHERE agent_id = ? AND capability = ? AND consumed_at >= ?",
    ).bind(agent.agent_id, capability, since).first<{ n: number }>();
    add("rate_limit", (used?.n ?? 0) < cap.max_per_hour, `at most ${cap.max_per_hour} consumed syscalls per hour`);
  }
  return checks;
}

/**
 * Defence in depth for syscall targets (RecoveryRpc): the target re-checks that
 * the Policy Engine recorded an allow for exactly this agent and capability in the last five
 * minutes, and that the decision has not been used for an action already.
 */
export async function verifySyscallDecision(db: D1Database, decisionId: unknown, agentId: string, capability: string, now = Date.now()): Promise<void> {
  if (typeof decisionId !== "string" || !/^dec_[0-9a-f-]{36}$/.test(decisionId)) throw new Error("policy_decision_required");
  const cap = CAPABILITIES[capability];
  if (!cap || cap.tier === 0 || cap.tier >= 3 || !cap.max_per_hour || PROHIBITED_CAPABILITY.test(capability)) {
    throw new Error("policy_decision_invalid");
  }
  const row = await db.prepare("SELECT subject, action, resource, decision, created_at FROM policy_decisions WHERE decision_id = ?")
    .bind(decisionId).first<{ subject: string; action: string; resource: string; decision: string; created_at: string }>();
  const age = row ? now - Date.parse(row.created_at) : Number.NaN;
  if (!row || row.decision !== "allow" || row.action !== "agent.syscall" || row.subject !== `agent:${agentId}`
    || row.resource !== capability || !Number.isFinite(age) || age < 0 || age > 300_000) {
    throw new Error("policy_decision_invalid");
  }

  // Re-check the live agent grant and kill switch. The INSERT below repeats those checks in
  // the same atomic statement that consumes the decision, closing the check/dispatch race.
  const failed = (await agentSyscallChecks(db, `agent:${agentId}`, capability, now)).filter((c) => !c.passed);
  if (failed.length) throw new Error(`policy_decision_revoked: ${failed.map((c) => c.id).join(",")}`);

  const nowAt = new Date(now).toISOString();
  const cutoff = new Date(now - 300_000).toISOString();
  const consumed = await db.prepare(
    `INSERT OR IGNORE INTO agent_syscall_consumptions (decision_id, agent_id, capability, consumed_at)
     SELECT ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM policy_decisions p
       WHERE p.decision_id = ? AND p.subject = ? AND p.action = 'agent.syscall'
         AND p.resource = ? AND p.decision = 'allow' AND p.created_at >= ? AND p.created_at <= ?
     )
     AND EXISTS (
       SELECT 1 FROM agents a
       WHERE a.agent_id = ? AND a.status = 'enabled' AND a.tier_max >= ?
         AND EXISTS (SELECT 1 FROM json_each(a.capabilities_json) j WHERE j.value = ?)
         AND NOT (? > 1 AND EXISTS (SELECT 1 FROM agent_principals ap WHERE ap.agent_id = a.agent_id AND ap.revoked_at IS NULL))
     )
     AND EXISTS (SELECT 1 FROM kernel_controls k WHERE k.control = 'agents_enabled' AND k.value = '1')
     AND (SELECT COUNT(*) FROM agent_syscall_consumptions c
          WHERE c.agent_id = ? AND c.capability = ? AND c.consumed_at >= ?) < ?`,
  ).bind(
    decisionId, agentId, capability, nowAt,
    decisionId, `agent:${agentId}`, capability, cutoff, nowAt,
    agentId, cap.tier, capability, cap.tier,
    agentId, capability, new Date(now - 3_600_000).toISOString(), cap.max_per_hour,
  ).run();
  if ((consumed.meta.changes ?? 0) !== 1) {
    const used = await db.prepare("SELECT 1 AS x FROM agent_syscall_consumptions WHERE decision_id = ?").bind(decisionId).first();
    if (used) throw new Error("policy_decision_already_used");
    throw new Error("policy_decision_revoked_or_rate_limited");
  }
}

/** Step actions a recovery plan may name (the Recovery Manager validates them; nothing runs them automatically). */
export const RECOVERY_STEP_ACTIONS = ["rollback_worker_version", "redeploy_commit", "disable_service", "restore_d1_bookmark", "rotate_secret", "manual"] as const;
