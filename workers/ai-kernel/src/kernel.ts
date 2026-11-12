/** Kernel operations shared by the HTTP API and the MCP tools (ADR-0007). */
import type { OwnerTelegramBinding, SendEmailBinding } from "./owner-notices.ts";
import type { OmegaHealthBinding } from "./execution-hosts.ts";
import type { JsonObject } from "../../control-plane-shared/src/http.ts";
import { nowIso } from "../../control-plane-shared/src/http.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { KERNEL_AGENTS, RETIRE_EXEMPT_HOSTS } from "../../control-plane-shared/src/consensus-rules.ts";
import { CAPABILITIES, agentsEnabled, getAgent, type AgentPrincipalRow, type AgentRow } from "../../control-plane-shared/src/capabilities.ts";
import { AGENT_ID, type CycleReport, type KernelEnv } from "./supervisor.ts";
import { SIGNAL_ANALYST_ID } from "./signal-analyst.ts";
import { AUDITOR_ID } from "./auditor.ts";

export interface SupervisorStub { cycle(trigger: "scheduled" | "operator"): Promise<CycleReport>; status(): Promise<CycleReport | null> }
export interface SupervisorNamespace { idFromName(name: string): unknown; get(id: unknown): SupervisorStub }

export interface KernelHttpEnv extends KernelEnv {
  SUPERVISOR: SupervisorNamespace;
  SIGNAL_ANALYST?: SupervisorNamespace;
  AUDITOR?: SupervisorNamespace;
  APPROVER_IDENTITIES?: string;
  /** ADR-0012 phase 2: optional send_email binding and sender for owner notices. */
  OWNER_EMAIL?: SendEmailBinding;
  /** Owner 2026-11-11: the owner's Telegram, through the xauusd AI Worker's OwnerNotifier (it holds the bot). */
  OWNER_TELEGRAM?: OwnerTelegramBinding;
  NOTIFY_FROM?: string;
  /** Owner 2026-11-12: Omega's VPS bridge and EA liveness for the AI Mesh (xauusd OmegaHealth, read-only). */
  XAUUSD_OMEGA_HEALTH?: OmegaHealthBinding;
}

const AGENT_ID_RE = /^[a-z0-9-]{2,40}$/;

export function present(a: AgentRow): JsonObject {
  const capabilities = JSON.parse(a.capabilities_json) as string[];
  return { ...a, capabilities_json: undefined, capabilities: capabilities.map((c) => ({ capability: c, tier: CAPABILITIES[c]?.tier ?? null })) };
}

export async function listAgents(env: KernelHttpEnv): Promise<JsonObject> {
  const rows = await env.DB.prepare("SELECT * FROM agents ORDER BY tier_max DESC, agent_id").all<AgentRow>();
  return { agents_enabled: await agentsEnabled(env.DB), agents: rows.results.map(present) };
}

export async function listActions(env: KernelHttpEnv, agentId: string, limit: number): Promise<JsonObject> {
  if (!AGENT_ID_RE.test(agentId)) throw new Error("invalid agent_id");
  const n = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 20;
  const rows = await env.DB.prepare("SELECT * FROM agent_actions WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?").bind(agentId, n).all<Record<string, string>>();
  return { agent_id: agentId, actions: rows.results.map((r) => ({ ...r, input_json: undefined, result_json: undefined, input: JSON.parse(r.input_json), result: JSON.parse(r.result_json) })) };
}

export async function listAgentPrincipals(env: KernelHttpEnv, agentId: string): Promise<AgentPrincipalRow[]> {
  if (!AGENT_ID_RE.test(agentId)) throw new Error("invalid agent_id");
  const rows = await env.DB.prepare(
    "SELECT access_identity, agent_id, created_by, created_at, revoked_at FROM agent_principals WHERE agent_id = ? ORDER BY created_at DESC",
  ).bind(agentId).all<AgentPrincipalRow>();
  return rows.results;
}

export const KERNEL_HOST = "cryptophys-ai-kernel";

export async function addAgentPrincipal(
  env: KernelHttpEnv,
  agentId: string,
  accessIdentityRaw: unknown,
  actor: string,
): Promise<{ status: number; body: JsonObject }> {
  if (!AGENT_ID_RE.test(agentId)) return { status: 400, body: { error: "invalid_request", message: "invalid agent_id" } };
  const accessIdentity = typeof accessIdentityRaw === "string" ? accessIdentityRaw.trim() : "";
  if (!accessIdentity || accessIdentity.length > 200 || accessIdentity.includes("/")) {
    return { status: 400, body: { error: "invalid_request", message: "access_identity must be a non-empty string (<= 200 chars)" } };
  }
  const agent = await getAgent(env.DB, agentId);
  if (!agent) return { status: 404, body: { error: "not_found", message: "agent not found" } };
  if (agent.host_worker === KERNEL_HOST) {
    return { status: 400, body: { error: "kernel_agent_internal", message: "agents hosted by the AI Kernel cannot have external principals" } };
  }
  if (agent.tier_max > 1) {
    return { status: 400, body: { error: "external_tier_limit", message: "principals can only be registered for agents with tier_max <= 1" } };
  }
  const existing = await env.DB.prepare(
    "SELECT access_identity, agent_id, created_by, created_at, revoked_at FROM agent_principals WHERE access_identity = ?",
  ).bind(accessIdentity).first<AgentPrincipalRow>();
  if (existing && existing.revoked_at === null && existing.agent_id !== agentId) {
    return { status: 409, body: { error: "principal_already_bound", message: "access_identity is already bound to another agent" } };
  }
  const createdAt = nowIso();
  await env.DB.prepare(
    `INSERT INTO agent_principals (access_identity, agent_id, created_by, created_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(access_identity) DO UPDATE SET
       agent_id = excluded.agent_id,
       created_by = excluded.created_by,
       created_at = excluded.created_at,
       revoked_at = NULL`,
  ).bind(accessIdentity, agentId, actor, createdAt).run();
  await appendAuditEvent(env.DB, {
    event_type: "agent.principal_added",
    actor,
    subject: `agent:${agentId}`,
    outcome: "added",
    payload: { access_identity: accessIdentity, agent_id: agentId },
  });
  return {
    status: 201,
    body: {
      principal: {
        access_identity: accessIdentity,
        agent_id: agentId,
        created_by: actor,
        created_at: createdAt,
        revoked_at: null,
      },
    },
  };
}

export async function revokeAgentPrincipal(
  env: KernelHttpEnv,
  agentId: string,
  accessIdentityRaw: string,
  actor: string,
): Promise<{ status: number; body: JsonObject }> {
  if (!AGENT_ID_RE.test(agentId)) return { status: 400, body: { error: "invalid_request", message: "invalid agent_id" } };
  const accessIdentity = accessIdentityRaw.trim();
  if (!accessIdentity) return { status: 400, body: { error: "invalid_request", message: "invalid access_identity" } };
  const existing = await env.DB.prepare(
    "SELECT access_identity, agent_id, created_by, created_at, revoked_at FROM agent_principals WHERE agent_id = ? AND access_identity = ?",
  ).bind(agentId, accessIdentity).first<AgentPrincipalRow>();
  if (!existing) return { status: 404, body: { error: "not_found", message: "principal not found" } };
  const revokedAt = existing.revoked_at ?? nowIso();
  if (existing.revoked_at === null) {
    await env.DB.prepare(
      "UPDATE agent_principals SET revoked_at = ? WHERE agent_id = ? AND access_identity = ? AND revoked_at IS NULL",
    ).bind(revokedAt, agentId, accessIdentity).run();
    await appendAuditEvent(env.DB, {
      event_type: "agent.principal_revoked",
      actor,
      subject: `agent:${agentId}`,
      outcome: "revoked",
      payload: { access_identity: accessIdentity, agent_id: agentId, revoked_at: revokedAt },
    });
  }
  return {
    status: 200,
    body: {
      principal: {
        ...existing,
        revoked_at: revokedAt,
      },
    },
  };
}

const supervisor = (env: KernelHttpEnv) => env.SUPERVISOR.get(env.SUPERVISOR.idFromName(AGENT_ID));
const signalAnalyst = (env: KernelHttpEnv) => {
  if (!env.SIGNAL_ANALYST) throw new Error("signal_analyst_binding_missing");
  return env.SIGNAL_ANALYST.get(env.SIGNAL_ANALYST.idFromName(SIGNAL_ANALYST_ID));
};
const auditor = (env: KernelHttpEnv) => {
  if (!env.AUDITOR) throw new Error("auditor_binding_missing");
  return env.AUDITOR.get(env.AUDITOR.idFromName(AUDITOR_ID));
};

export async function wakeAgent(env: KernelHttpEnv, agentId: string): Promise<CycleReport | JsonObject> {
  if (agentId === AGENT_ID) return supervisor(env).cycle("operator");
  if (agentId === SIGNAL_ANALYST_ID) return signalAnalyst(env).cycle("operator");
  if (agentId === AUDITOR_ID) return auditor(env).cycle("operator");
  throw new Error("unknown runnable agent");
}

export async function agentStatus(env: KernelHttpEnv, agentId: string): Promise<JsonObject | null> {
  const agent = AGENT_ID_RE.test(agentId) ? await getAgent(env.DB, agentId) : null;
  if (!agent) return null;
  const last = agentId === AGENT_ID
    ? await supervisor(env).status()
    : agentId === SIGNAL_ANALYST_ID && env.SIGNAL_ANALYST
      ? await signalAnalyst(env).status()
      : agentId === AUDITOR_ID && env.AUDITOR
        ? await auditor(env).status()
        : null;
  const principals = await listAgentPrincipals(env, agentId);
  return {
    agent: present(agent),
    last_cycle: last as unknown as JsonObject,
    principals: principals as unknown as JsonObject[],
  };
}

/** Suspending is any operator's right; resuming is checked by the caller (approver only). */
export async function setAgentStatus(env: KernelHttpEnv, agentId: string, status: "enabled" | "suspended", actor: string, reason: string): Promise<JsonObject> {
  if (!AGENT_ID_RE.test(agentId)) throw new Error("invalid agent_id");
  const res = await env.DB.prepare("UPDATE agents SET status = ?, status_reason = ?, updated_by = ?, updated_at = ? WHERE agent_id = ?")
    .bind(status, reason.slice(0, 300) || null, actor, nowIso(), agentId).run();
  if ((res.meta.changes ?? 0) !== 1) throw new Error("agent not found");
  await appendAuditEvent(env.DB, { event_type: status === "enabled" ? "agent.resumed" : "agent.suspended", actor, subject: `agent:${agentId}`, outcome: status, payload: { reason } });
  return present((await getAgent(env.DB, agentId))!);
}

/** Every table that refers to an agent id (migrations 0010-0029); a referenced agent is kept as a tombstone. */
export const AGENT_REFERENCES: ReadonlyArray<readonly [string, string]> = [
  ["agent_actions", "agent_id"], ["agent_syscall_consumptions", "agent_id"], ["agent_reports", "agent_id"],
  ["agent_memories", "agent_id"], ["agent_principals", "agent_id"], ["consensus_proposals", "proposer_agent_id"],
  ["consensus_votes", "voter_agent_id"], ["knowledge_proposals", "proposer_agent_id"],
];

/**
 * Dismantles an agent (owner 2026-11-11: "dismantle dan delete agent yang sudah tidak berkontribusi"). An agent
 * no record refers to is deleted; one with history is suspended with a "retired:" reason, so the audit trail
 * and every row that names it stay intact, and resume_agent can still bring it back.
 */
export async function retireAgent(env: KernelHttpEnv, agentId: string, actor: string, reason: string): Promise<JsonObject> {
  if (!AGENT_ID_RE.test(agentId)) throw new Error("invalid agent_id");
  const agent = await getAgent(env.DB, agentId);
  if (!agent) throw new Error("agent not found");
  // Enforced here, whatever the vote: kernel agents, council seats and the exempt hosts are never retired.
  const row = agent as unknown as { host_worker?: string; voter?: number };
  if (KERNEL_AGENTS.has(agentId)) throw new Error("kernel_agent_internal");
  if (Number(row.voter ?? 0) === 1) throw new Error("council_seat_not_retired");
  if (RETIRE_EXEMPT_HOSTS.has(String(row.host_worker ?? ""))) throw new Error("host_exempt_from_retirement");
  let referenced = false;
  for (const [table, column] of AGENT_REFERENCES) {
    if (await env.DB.prepare(`SELECT 1 AS x FROM ${table} WHERE ${column} = ? LIMIT 1`).bind(agentId).first()) { referenced = true; break; }
  }
  const why = `retired: ${reason}`.slice(0, 300);
  if (referenced) {
    const kept = await setAgentStatus(env, agentId, "suspended", actor, why);
    return { agent_id: agentId, outcome: "suspended", reason: why, agent: kept };
  }
  const res = await env.DB.prepare("DELETE FROM agents WHERE agent_id = ?").bind(agentId).run();
  if ((res.meta.changes ?? 0) !== 1) throw new Error("agent not found");
  await appendAuditEvent(env.DB, { event_type: "agent.retired", actor, subject: `agent:${agentId}`, outcome: "deleted", payload: { reason: why, host_worker: row.host_worker ?? null } });
  return { agent_id: agentId, outcome: "deleted", reason: why };
}

export async function setAgentsEnabled(env: KernelHttpEnv, enabled: boolean, actor: string): Promise<JsonObject> {
  await env.DB.prepare("UPDATE kernel_controls SET value = ?, updated_by = ?, updated_at = ? WHERE control = 'agents_enabled'")
    .bind(enabled ? "1" : "0", actor, nowIso()).run();
  await appendAuditEvent(env.DB, { event_type: "kernel.agents_enabled", actor, subject: "kernel", outcome: enabled ? "enabled" : "disabled", payload: {} });
  return { agents_enabled: await agentsEnabled(env.DB) };
}
