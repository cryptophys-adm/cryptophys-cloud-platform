/** Kernel operations shared by the HTTP API and the MCP tools (ADR-0007). */
import type { JsonObject } from "../../control-plane-shared/src/http.ts";
import { nowIso } from "../../control-plane-shared/src/http.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { CAPABILITIES, agentsEnabled, getAgent, type AgentRow } from "../../control-plane-shared/src/capabilities.ts";
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
  return { agent: present(agent), last_cycle: last as unknown as JsonObject };
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

export async function setAgentsEnabled(env: KernelHttpEnv, enabled: boolean, actor: string): Promise<JsonObject> {
  await env.DB.prepare("UPDATE kernel_controls SET value = ?, updated_by = ?, updated_at = ? WHERE control = 'agents_enabled'")
    .bind(enabled ? "1" : "0", actor, nowIso()).run();
  await appendAuditEvent(env.DB, { event_type: "kernel.agents_enabled", actor, subject: "kernel", outcome: enabled ? "enabled" : "disabled", payload: {} });
  return { agents_enabled: await agentsEnabled(env.DB) };
}
