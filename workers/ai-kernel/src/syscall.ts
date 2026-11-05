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
import { appendAuditEvent, verifyAuditChain } from "../../control-plane-shared/src/audit.ts";
import { newId, nowIso } from "../../control-plane-shared/src/http.ts";
import { recallMemories, rememberMemory, type VectorizeBinding } from "./memory.ts";
import { publishReport } from "./reports.ts";

export interface PolicyRpcBinding {
  evaluate(input: { subject: string; action: string; resource: string; context: Record<string, unknown> }):
    Promise<{ decision: "allow" | "deny"; decision_id: string; reason: string }>;
}
export interface RecoveryRpcBinding { propose(agentId: string, decisionId: string, input: Record<string, unknown>): Promise<JsonObject> }
export interface SignalRpcBinding { reingest(agentId: string, decisionId: string): Promise<{ run_id: string; series: number; failed: number }> }

export interface SyscallEnv extends BaseEnv {
  XAUUSD_AI?: { fetch(input: string, init?: RequestInit): Promise<Response> };
  POLICY: PolicyRpcBinding;
  RECOVERY: RecoveryRpcBinding;
  SIGNALS: SignalRpcBinding;
  MEMORY?: VectorizeBinding;
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

  const since = new Date(now - 24 * 3_600_000).toISOString();
  let agentReports24h: JsonObject;
  try {
    const countRows = await env.DB.prepare(
      "SELECT severity, COUNT(*) AS n FROM agent_reports WHERE created_at > ? GROUP BY severity",
    ).bind(since).all<{ severity: string; n: number }>();
    const counts = { critical: 0, warning: 0, info: 0 };
    for (const r of countRows.results) {
      if (r.severity === "critical" || r.severity === "warning" || r.severity === "info") {
        counts[r.severity] = Number(r.n);
      }
    }
    const latestRows = await env.DB.prepare(
      "SELECT report_id, agent_id, kind, severity, subject, created_at FROM agent_reports WHERE created_at > ? AND severity IN ('critical','warning') ORDER BY created_at DESC, rowid DESC LIMIT 5",
    ).bind(since).all<{ report_id: string; agent_id: string; kind: string; severity: string; subject: string; created_at: string }>();
    const latestAttention = latestRows.results.map((r) => ({
      report_id: r.report_id, agent_id: r.agent_id, kind: r.kind, severity: r.severity,
      subject: String(r.subject).slice(0, 200), created_at: r.created_at,
    }));
    agentReports24h = { since, counts, latest_attention: latestAttention };
  } catch (err) {
    console.error(JSON.stringify({ service: "cryptophys-ai-kernel", event: "agent_reports_overview_failed", message: String((err as Error)?.message ?? err) }));
    agentReports24h = { since, counts: { critical: 0, warning: 0, info: 0 }, latest_attention: [], error: "reports_unavailable" };
  }

  return {
    observed_at: new Date(now).toISOString(),
    services,
    ingest_runs: runs.results,
    open_agent_plans: plans.results,
    agents_enabled: await agentsEnabled(env.DB),
    agent_reports_24h: agentReports24h,
  };
}

/** Tier 0: latest XAUUSD advisory decisions from xauusd-ai-trading-assistant (read-only). */
export async function observeSignals(env: BaseEnv & { XAUUSD_AI?: { fetch(input: string, init?: RequestInit): Promise<Response> } }, now = Date.now(), timeoutMs = 5000): Promise<JsonObject> {
  const observedAt = new Date(now).toISOString();
  if (!env.XAUUSD_AI) {
    return { source: "xauusd-ai-trading-assistant", observed_at: observedAt, available: false, error: "xauusd_binding_missing" };
  }
  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await env.XAUUSD_AI.fetch("https://xauusd.internal/api/decisions?limit=6", {
        headers: { accept: "application/json" },
        signal: controller.signal,
      } as RequestInit);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    const error = /abort/i.test(msg) ? "xauusd_timeout" : "xauusd_unreachable";
    return { source: "xauusd-ai-trading-assistant", observed_at: observedAt, available: false, error };
  }
  if (!res.ok) {
    return { source: "xauusd-ai-trading-assistant", observed_at: observedAt, available: false, error: `xauusd_http_${res.status}` };
  }
  let body: any;
  try {
    body = await res.json();
  } catch {
    return { source: "xauusd-ai-trading-assistant", observed_at: observedAt, available: false, error: "xauusd_invalid_body" };
  }
  const itemsRaw = Array.isArray(body?.items) ? body.items : [];
  const validDecisions = new Set(["BUY", "SELL", "WAIT", "NO_TRADE"]);
  const keyRe = /^OANDA:XAUUSD:60:\d{10,14}$/;
  const items: JsonObject[] = [];
  for (const raw of itemsRaw.slice(0, 6)) {
    const key = typeof raw?.candle_key === "string" ? raw.candle_key : "";
    if (!keyRe.test(key)) continue;
    const openMs = Number(key.split(":").pop());
    if (!Number.isFinite(openMs)) continue;
    const decision = validDecisions.has(raw?.decision) ? raw.decision : "UNKNOWN";
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const pos = (v: unknown) => { const n = num(v); return n !== null && n > 0 ? n : null; };
    const conf = num(raw?.confidence);
    const confidence = conf !== null && conf >= 0 && conf <= 1 ? conf : null;
    const decidedAt = typeof raw?.timestamp === "string" ? raw.timestamp.slice(0, 40) : null;
    const reasoning = typeof raw?.reasoning === "string" ? raw.reasoning.slice(0, 300) : "";
    items.push({
      candle_key: key,
      candle_open_ms: openMs,
      decided_at: decidedAt,
      decision,
      confidence,
      entry_price: pos(raw?.entry_price),
      stop_loss: pos(raw?.stop_loss),
      take_profit: pos(raw?.take_profit),
      risk_reward: pos(raw?.risk_reward),
      reasoning,
    });
  }
  const latest = items.length > 0 ? items[0] : null;
  let stale = items.length === 0;
  if (latest) {
    const closeMs = (latest.candle_open_ms as number) + 3_600_000;
    stale = now - closeMs > 90 * 60_000;
  }
  return {
    source: "xauusd-ai-trading-assistant",
    observed_at: observedAt,
    available: true,
    stale,
    latest: latest as unknown as JsonObject,
    recent: items,
  };
}

/** Tier 0: verify the audit hash chain and count governance events over the last 24 hours (read-only). */
export async function verifyAudit(env: BaseEnv, now = Date.now()): Promise<JsonObject> {
  const chain = await verifyAuditChain(env.DB);
  const since = new Date(now - 24 * 3_600_000).toISOString();
  const actionRows = await env.DB.prepare(
    `SELECT agent_id, outcome, COUNT(*) AS count FROM agent_actions
     WHERE outcome IN ('denied', 'failed') AND created_at >= ?
     GROUP BY agent_id, outcome ORDER BY agent_id, outcome`,
  ).bind(since).all<{ agent_id: string; outcome: "denied" | "failed"; count: number }>();
  const byAgentMap = new Map<string, { agent_id: string; denied: number; failed: number }>();
  let deniedTotal = 0;
  let failedTotal = 0;
  for (const r of actionRows.results) {
    const cur = byAgentMap.get(r.agent_id) ?? { agent_id: r.agent_id, denied: 0, failed: 0 };
    if (r.outcome === "denied") {
      cur.denied += r.count;
      deniedTotal += r.count;
    } else {
      cur.failed += r.count;
      failedTotal += r.count;
    }
    byAgentMap.set(r.agent_id, cur);
  }
  const policyRows = await env.DB.prepare(
    `SELECT action, COUNT(*) AS count FROM policy_decisions
     WHERE decision = 'deny' AND created_at >= ?
     GROUP BY action ORDER BY action`,
  ).bind(since).all<{ action: string; count: number }>();
  const govRows = await env.DB.prepare(
    `SELECT event_type, COUNT(*) AS count FROM audit_events
     WHERE event_type IN ('agent.suspended', 'agent.resumed', 'kernel.agents_enabled') AND created_at >= ?
     GROUP BY event_type`,
  ).bind(since).all<{ event_type: string; count: number }>();
  const governanceEvents: Record<string, number> = {
    "agent.suspended": 0,
    "agent.resumed": 0,
    "kernel.agents_enabled": 0,
  };
  for (const r of govRows.results) {
    governanceEvents[r.event_type] = r.count;
  }
  const planRow = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM recovery_plans WHERE created_by LIKE 'agent:%' AND created_at >= ?",
  ).bind(since).first<{ count: number }>();

  return {
    observed_at: new Date(now).toISOString(),
    since,
    chain: chain as unknown as JsonObject,
    valid: chain.valid,
    events_checked: chain.events_checked,
    counts_24h: {
      agent_actions_by_agent: [...byAgentMap.values()],
      denied_agent_syscalls: deniedTotal,
      failed_agent_syscalls: failedTotal,
      policy_denies_by_action: policyRows.results,
      governance_audit_events: governanceEvents,
      agent_recovery_plans: planRow?.count ?? 0,
    },
  };
}

const TIER0_HANDLERS: Record<string, (env: SyscallEnv, input: JsonObject, agentId: string) => Promise<JsonObject>> = {
  "platform.observe": (env) => observe(env),
  "signals.observe": (env) => observeSignals(env),
  "audit.verify": (env, input) => verifyAudit(env, typeof input.now === "number" ? input.now : Date.now()),
  "memory.recall": (env, input, agentId) => recallMemories(env, agentId, input),
};

async function dispatch(env: SyscallEnv, capability: string, agentId: string, decisionId: string, input: JsonObject): Promise<JsonObject> {
  switch (capability) {
    case "recovery.propose": return { plan: await env.RECOVERY.propose(agentId, decisionId, input) };
    case "reports.publish": return { report: await publishReport(env.DB, agentId, decisionId, input) };
    case "memory.remember": return { memory: await rememberMemory(env, agentId, decisionId, input) };
    case "signals.reingest": return { run: await env.SIGNALS.reingest(agentId, decisionId) };
    default: throw new Error("capability_not_dispatchable");
  }
}

const MAX_AUDIT_JSON_BYTES = 8_000;

/** Keep the JSON CHECK valid and avoid persisting partial/possibly sensitive oversized payloads. */
function auditJson(value: JsonObject): string {
  const serialized = JSON.stringify(value);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  return bytes <= MAX_AUDIT_JSON_BYTES ? serialized : JSON.stringify({ truncated: true, original_bytes: bytes });
}

async function record(env: SyscallEnv, agentId: string, capability: string, tier: number, decisionId: string | null, outcome: string, input: JsonObject, result: JsonObject): Promise<string> {
  const actionId = newId("act");
  await env.DB.prepare(
    `INSERT INTO agent_actions (action_id, agent_id, capability, tier, decision_id, outcome, input_json, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(actionId, agentId, capability, tier, decisionId, outcome, auditJson(input), auditJson(result), nowIso()).run();
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
    const handler = Object.hasOwn(TIER0_HANDLERS, capability) ? TIER0_HANDLERS[capability] : undefined;
    const failed = (await agentSyscallChecks(env.DB, `agent:${agentId}`, capability)).filter((c) => !c.passed).map((c) => c.id);
    if (!handler) failed.push("tier0_handler_missing");
    if (failed.length) return { outcome: "denied", capability, tier, decision_id: null, reason: `failed: ${failed.join(", ")}` };
    try {
      return { outcome: "succeeded", capability, tier, decision_id: null, result: await handler!(env, input, agentId) };
    } catch (err) {
      return { outcome: "failed", capability, tier, decision_id: null, reason: String((err as Error)?.message ?? err).slice(0, 300) };
    }
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
