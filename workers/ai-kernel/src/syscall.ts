/**
 * The AI Worker OS syscall gate (ADR-0007). Every agent action goes through syscall():
 *  - tier 0 (observe) is checked here against the shared capability catalog and not persisted;
 *  - tier >= 1 needs an allow from the Policy Engine (persisted and audited), is dispatched to
 *    the owning Worker over RPC with the decision id (which the target re-verifies), and is
 *    recorded in agent_actions and the audit chain whatever the outcome.
 * The kernel fails closed: no policy answer, no action.
 */
import type { BaseEnv } from "../../control-plane-shared/src/types.ts";
import type { JsonObject } from "../../control-plane-shared/src/http.ts";
import { CAPABILITIES, agentSyscallChecks, agentsEnabled } from "../../control-plane-shared/src/capabilities.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { newId, nowIso } from "../../control-plane-shared/src/http.ts";

export interface PolicyRpcBinding {
  evaluate(input: { subject: string; action: string; resource: string; context: Record<string, unknown> }):
    Promise<{ decision: "allow" | "deny"; decision_id: string; reason: string }>;
}
export interface RecoveryRpcBinding { propose(agentId: string, decisionId: string, input: Record<string, unknown>): Promise<JsonObject> }
export interface SignalRpcBinding { reingest(agentId: string, decisionId: string): Promise<{ run_id: string; series: number; failed: number }> }

export interface SyscallEnv extends BaseEnv {
  POLICY: PolicyRpcBinding;
  RECOVERY: RecoveryRpcBinding;
  SIGNALS: SignalRpcBinding;
}

export type SyscallResult =
  | { outcome: "succeeded"; capability: string; tier: number; decision_id: string | null; result: JsonObject }
  | { outcome: "denied" | "failed"; capability: string; tier: number; decision_id: string | null; reason: string };

/** Tier 0: a consistent read of the platform state the agents reason about. */
export async function observe(env: BaseEnv, now = Date.now()): Promise<JsonObject> {
  const latest = await env.DB.prepare(
    `SELECT o.service_id, o.drifted, o.evidence_json, o.observed_at FROM drift_observations o
     WHERE o.observed_at = (SELECT MAX(i.observed_at) FROM drift_observations i WHERE i.service_id = o.service_id)
     ORDER BY o.service_id`,
  ).all<{ service_id: string; drifted: number; evidence_json: string; observed_at: string }>();
  const services = [];
  for (const r of latest.results) {
    const ev = JSON.parse(r.evidence_json) as JsonObject;
    // Persistent drift: the two most recent observations of the service both drifted.
    const lastTwo = await env.DB.prepare("SELECT drifted FROM drift_observations WHERE service_id = ? ORDER BY observed_at DESC LIMIT 2")
      .bind(r.service_id).all<{ drifted: number }>();
    services.push({
      service_id: r.service_id, drifted: r.drifted === 1, observed_at: r.observed_at,
      persistent: lastTwo.results.length === 2 && lastTwo.results.every((x) => x.drifted === 1),
      reasons: (ev.reasons as string[] | undefined) ?? [], desired_version: (ev.desired_version as string | null | undefined) ?? null,
      observed_version: ((ev.probe as JsonObject | undefined)?.version_tag as string | null | undefined) ?? null,
    });
  }
  const runs = await env.DB.prepare(
    "SELECT run_id, trigger, started_at, series_total, series_failed FROM signal_ingest_runs ORDER BY started_at DESC LIMIT 4",
  ).all<{ run_id: string; trigger: string; started_at: string; series_total: number; series_failed: number }>();
  const plans = await env.DB.prepare(
    "SELECT plan_id, service_id, status, created_by, created_at FROM recovery_plans WHERE created_by LIKE 'agent:%' AND status IN ('draft','approved','executing') ORDER BY created_at DESC LIMIT 50",
  ).all<JsonObject>();
  return {
    observed_at: new Date(now).toISOString(),
    services,
    ingest_runs: runs.results,
    open_agent_plans: plans.results,
    agents_enabled: await agentsEnabled(env.DB),
  };
}

async function dispatch(env: SyscallEnv, capability: string, agentId: string, decisionId: string, input: JsonObject): Promise<JsonObject> {
  switch (capability) {
    case "recovery.propose": return { plan: await env.RECOVERY.propose(agentId, decisionId, input) };
    case "signals.reingest": return { run: await env.SIGNALS.reingest(agentId, decisionId) };
    default: throw new Error("capability_not_dispatchable");
  }
}

async function record(env: SyscallEnv, agentId: string, capability: string, tier: number, decisionId: string | null, outcome: string, input: JsonObject, result: JsonObject): Promise<string> {
  const actionId = newId("act");
  await env.DB.prepare(
    `INSERT INTO agent_actions (action_id, agent_id, capability, tier, decision_id, outcome, input_json, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(actionId, agentId, capability, tier, decisionId, outcome, JSON.stringify(input).slice(0, 8000), JSON.stringify(result).slice(0, 8000), nowIso()).run();
  await appendAuditEvent(env.DB, {
    event_type: "agent.action", actor: `agent:${agentId}`, subject: capability, outcome,
    payload: { action_id: actionId, tier, decision_id: decisionId, result },
  });
  return actionId;
}

export async function syscall(env: SyscallEnv, agentId: string, capability: string, input: JsonObject = {}): Promise<SyscallResult> {
  const cap = Object.hasOwn(CAPABILITIES, capability) ? CAPABILITIES[capability] : undefined;
  const tier = cap?.tier ?? 3;
  if (tier === 0) {
    const failed = (await agentSyscallChecks(env.DB, `agent:${agentId}`, capability)).filter((c) => !c.passed);
    if (failed.length) return { outcome: "denied", capability, tier, decision_id: null, reason: `failed: ${failed.map((c) => c.id).join(", ")}` };
    return { outcome: "succeeded", capability, tier, decision_id: null, result: await observe(env) };
  }
  let decision: { decision: string; decision_id: string; reason: string };
  try {
    decision = await env.POLICY.evaluate({ subject: `agent:${agentId}`, action: "agent.syscall", resource: capability, context: { tier } });
  } catch {
    return { outcome: "denied", capability, tier, decision_id: null, reason: "policy_unavailable" };
  }
  if (decision.decision !== "allow") {
    // An unregistered agent cannot be recorded in agent_actions (foreign key); the policy decision is still audited.
    const known = await env.DB.prepare("SELECT 1 AS x FROM agents WHERE agent_id = ?").bind(agentId).first();
    if (known) await record(env, agentId, capability, tier, decision.decision_id, "denied", input, { reason: decision.reason });
    return { outcome: "denied", capability, tier, decision_id: decision.decision_id, reason: decision.reason };
  }
  try {
    const result = await dispatch(env, capability, agentId, decision.decision_id, input);
    await record(env, agentId, capability, tier, decision.decision_id, "succeeded", input, result);
    return { outcome: "succeeded", capability, tier, decision_id: decision.decision_id, result };
  } catch (err) {
    const reason = String((err as Error)?.message ?? err).slice(0, 300);
    await record(env, agentId, capability, tier, decision.decision_id, "failed", input, { reason });
    return { outcome: "failed", capability, tier, decision_id: decision.decision_id, reason };
  }
}
