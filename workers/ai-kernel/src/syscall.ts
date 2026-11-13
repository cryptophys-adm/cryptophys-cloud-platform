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
import { acknowledgementsReadable, publishReport } from "./reports.ts";
import { propose as consensusPropose } from "./consensus.ts";
import { proposeKnowledge, knowledgeStatus } from "./knowledge.ts";

export interface PolicyRpcBinding {
  evaluate(input: { subject: string; action: string; resource: string; context: Record<string, unknown> }):
    Promise<{ decision: "allow" | "deny"; decision_id: string; reason: string }>;
}
export interface RecoveryRpcBinding { propose(agentId: string, decisionId: string, input: Record<string, unknown>): Promise<JsonObject> }
/** ADR-0009 phase 2 targets: each re-verifies the consensus proposal and its policy decision. */
export interface RegistryRpcBinding { applyConsensus(proposalId: string, decisionId: string, action: string, target: string, params: Record<string, unknown>): Promise<JsonObject> }
export interface DriftRpcBinding { observeForConsensus(proposalId: string, decisionId: string): Promise<JsonObject> }
/** ADR-0009 phase 3: the Deployment Orchestrator reports pending deploys and dispatches passed deploy_commit actions. */
/** Wave C (C1): a control-plane Worker's own vote entrypoint (VoteRpc). */
export interface VoteRpcBinding { vote(voter: string, proposal: JsonObject, snapshot: JsonObject): Promise<JsonObject> }

export interface DeployRpcBinding {
  pendingDeploys(): Promise<{ main_sha: string | null; ci_green: boolean; units: { unit: string; workflow: string; target: string; reason: string }[]; skipped: { unit: string; reason: string }[] }>;
  deployForConsensus(proposalId: string, decisionId: string, target: string, params: Record<string, unknown>): Promise<JsonObject>;
  retireForConsensus(proposalId: string, decisionId: string, target: string): Promise<JsonObject>;
  rollbackForConsensus?(proposalId: string, decisionId: string, target: string, params: Record<string, unknown>): Promise<JsonObject>;
  /** ADR-0012 G6 gate 9: the Access plan (read only) and an owner-approved change_access. */
  accessPlan?(): Promise<{ configured: boolean; ok: boolean; in_sync?: boolean; digest?: string; changes?: string[]; reason?: string }>;
  accessForConsensus?(proposalId: string, decisionId: string, digest: string): Promise<JsonObject>;
}

export interface SyscallEnv extends BaseEnv {
  XAUUSD_AI?: { fetch(input: string, init?: RequestInit): Promise<Response> };
  POLICY: PolicyRpcBinding;
  RECOVERY: RecoveryRpcBinding;
  MEMORY?: VectorizeBinding;
  REGISTRY?: RegistryRpcBinding;
  DRIFT?: DriftRpcBinding;
  DEPLOY?: DeployRpcBinding;
  /** ADR-0013 §3 (#262): the Forge's head of canonical main, read from Artifacts at call time. */
  CANONICAL_MAIN?: { mainHead(): Promise<{ main_sha: string | null }> };
  VOTE_PLATFORM_API?: VoteRpcBinding;
  VOTE_DEPLOYMENT_ORCHESTRATOR?: VoteRpcBinding;
  VOTE_PLATFORM_REGISTRY?: VoteRpcBinding;
  VOTE_POLICY_ENGINE?: VoteRpcBinding;
  VOTE_DRIFT_DETECTOR?: VoteRpcBinding;
  VOTE_AUDIT_LEDGER?: VoteRpcBinding;
  VOTE_RECOVERY_MANAGER?: VoteRpcBinding;
}

export type SyscallResult =
  | { outcome: "succeeded"; capability: string; tier: number; decision_id: string | null; result: JsonObject }
  | { outcome: "denied" | "failed"; capability: string; tier: number; decision_id: string | null; reason: string };

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Tier 0: a consistent read of the platform state the agents reason about. */
export async function observe(env: BaseEnv, now = Date.now()): Promise<JsonObject> {
  // Latest observation per registered service through the (service_id, observed_at) index: about 3 rows read per service instead of the whole table (2026-11-11: 24,480 rows per call at 12,240 observations).
  const latest = await env.DB.prepare(
    `SELECT o.service_id, o.drifted, o.evidence_json, o.observed_at FROM service_registry r
     JOIN drift_observations o ON o.observation_id = (
       SELECT i.observation_id FROM drift_observations i WHERE i.service_id = r.service_id ORDER BY i.observed_at DESC, i.rowid DESC LIMIT 1)
     ORDER BY r.service_id`,
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
  const plans = await env.DB.prepare(
    "SELECT plan_id, service_id, status, created_by, created_at FROM recovery_plans WHERE created_by LIKE 'agent:%' AND status IN ('draft','approved','executing') ORDER BY created_at DESC LIMIT 50",
  ).all<JsonObject>();

  const since = new Date(now - 24 * 3_600_000).toISOString();
  let agentReports24h: JsonObject;
  try {
    // ADR-0009 amendment 2026-11-13: a critical report an approver acknowledged (migration 0053) is no longer
    // open. counts.critical, latest_critical and critical_fingerprint cover only the open ones, and
    // counts.critical_acknowledged says how many were acknowledged in the window. Before the table exists
    // nothing is acknowledged and every critical report stays open (fail closed).
    const acks = await acknowledgementsReadable(env.DB);
    const ackJoin = acks ? "LEFT JOIN agent_report_acknowledgements a ON a.report_id = r.report_id" : "";
    const open = acks ? "a.report_id IS NULL" : "1 = 1";
    const countRows = await env.DB.prepare(
      `SELECT r.severity AS severity, COUNT(*) AS n, SUM(CASE WHEN ${open} THEN 0 ELSE 1 END) AS acknowledged
       FROM agent_reports r ${ackJoin} WHERE r.created_at > ? GROUP BY r.severity`,
    ).bind(since).all<{ severity: string; n: number; acknowledged: number | null }>();
    const counts = { critical: 0, warning: 0, info: 0, critical_acknowledged: 0 };
    for (const r of countRows.results) {
      if (r.severity === "critical") {
        const acknowledged = Number(r.acknowledged ?? 0);
        counts.critical = Number(r.n) - acknowledged;
        counts.critical_acknowledged = acknowledged;
      } else if (r.severity === "warning" || r.severity === "info") {
        counts[r.severity] = Number(r.n);
      }
    }
    const latestRows = await env.DB.prepare(
      `SELECT r.report_id, r.agent_id, r.kind, r.severity, r.subject, r.created_at FROM agent_reports r ${ackJoin}
       WHERE r.created_at > ? AND (r.severity = 'warning' OR (r.severity = 'critical' AND ${open})) ORDER BY r.created_at DESC, r.rowid DESC LIMIT 5`,
    ).bind(since).all<{ report_id: string; agent_id: string; kind: string; severity: string; subject: string; created_at: string }>();
    const latestAttention = latestRows.results.map((r) => ({
      report_id: r.report_id, agent_id: r.agent_id, kind: r.kind, severity: r.severity,
      subject: String(r.subject).slice(0, 200), created_at: r.created_at,
    }));
    // Keep the public alert's fingerprint complete even when warning reports crowd
    // critical reports out of the five-row latest_attention window.
    const criticalIdSet = await env.DB.prepare(
      `SELECT GROUP_CONCAT(report_id, ',') AS report_ids FROM (SELECT r.report_id AS report_id FROM agent_reports r ${ackJoin}
       WHERE r.created_at > ? AND r.severity = 'critical' AND ${open} ORDER BY r.report_id)`,
    ).bind(since).first<{ report_ids: string | null }>();
    const criticalLatestRows = await env.DB.prepare(
      `SELECT r.report_id, r.agent_id, r.kind, r.created_at FROM agent_reports r ${ackJoin}
       WHERE r.created_at > ? AND r.severity = 'critical' AND ${open} ORDER BY r.created_at DESC, r.rowid DESC LIMIT 5`,
    ).bind(since).all<{ report_id: string; agent_id: string; kind: string; created_at: string }>();
    const criticalFingerprint = await sha256Hex(criticalIdSet?.report_ids ?? "");
    const latestCritical = criticalLatestRows.results.map((r) => ({
      report_id: r.report_id, agent_id: r.agent_id, kind: r.kind, created_at: r.created_at,
    }));
    agentReports24h = {
      since, counts, latest_attention: latestAttention,
      critical_fingerprint: criticalFingerprint, latest_critical: latestCritical,
    };
  } catch (err) {
    console.error(JSON.stringify({ service: "cryptophys-ai-kernel", event: "agent_reports_overview_failed", message: String((err as Error)?.message ?? err) }));
    agentReports24h = {
      since, counts: { critical: 0, warning: 0, info: 0, critical_acknowledged: 0 }, latest_attention: [],
      critical_fingerprint: null, latest_critical: [], error: "reports_unavailable",
    };
  }

  // xauusd_latest
  let xauusdLatest: JsonObject | null | { error: string } = null;
  try {
    const row = await env.DB.prepare(
      "SELECT report_id, created_at, body_json FROM agent_reports WHERE agent_id = 'signal-analyst' AND kind = 'xauusd_digest' AND json_extract(body_json, '$.decision') IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).first<{ report_id: string; created_at: string; body_json: string }>();
    if (row) {
      let body: any = {};
      try { body = JSON.parse(row.body_json); } catch { body = {}; }
      const decisionRaw = body?.decision;
      const decision = ["BUY","SELL","WAIT","NO_TRADE"].includes(decisionRaw) ? decisionRaw : "UNKNOWN";
      const conf = typeof body?.confidence === "number" && body.confidence >= 0 && body.confidence <= 1 ? body.confidence : null;
      xauusdLatest = {
        report_id: row.report_id,
        reported_at: row.created_at,
        candle_key: String(body?.candle_key ?? "").slice(0, 60),
        decision,
        confidence: conf,
        decided_at: String(body?.decided_at ?? "").slice(0, 60),
      };
    }
  } catch (err) {
    console.error(JSON.stringify({ service: "cryptophys-ai-kernel", event: "xauusd_latest_unavailable", message: String((err as Error)?.message ?? err) }));
    xauusdLatest = { error: "xauusd_latest_unavailable" };
  }

  return {
    observed_at: new Date(now).toISOString(),
    services,
    open_agent_plans: plans.results,
    agents_enabled: await agentsEnabled(env.DB),
    agent_reports_24h: agentReports24h,
    xauusd_latest: xauusdLatest,
  };
}

export interface ObserveSignalsOptions {
  now?: number;
  timeoutMs?: number;
  endpoint?: "auto" | "engine" | "legacy" | "deals";
  limit?: number;
  includeDeals?: boolean;
  dealsLimit?: number;
}

export interface NormalizedDeal {
  deal_ticket: number;
  position_ticket: number | null;
  mode: string;
  side: "BUY" | "SELL";
  volume: number;
  profit: number;
  commission: number;
  swap: number;
  net_profit: number;
  reason: string;
  signal_id: string | null;
  opened_ms: number | null;
  closed_ms: number;
  currency: string | null;
}

export interface DealStatsSummary {
  trades: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  net_profit: number;
  profit_factor: number | null;
  average_win: number | null;
  average_loss: number | null;
  max_drawdown: number;
}

function normalizeDecisionItem(raw: any): JsonObject | null {
  if (!raw || typeof raw !== "object") return null;
  const key = typeof raw.decision_key === "string" ? raw.decision_key : typeof raw.candle_key === "string" ? raw.candle_key : "";
  const keyRe = /^OANDA:XAUUSD:(15|60):\d{10,14}$/;
  if (!keyRe.test(key)) return null;
  const openMs = Number(key.split(":").pop());
  if (!Number.isFinite(openMs)) return null;

  const validDecisions = new Set(["BUY", "SELL", "WAIT", "NO_TRADE"]);
  const rawDecision = typeof raw.stance === "string" ? raw.stance : raw.decision;
  const decision = validDecisions.has(rawDecision) ? rawDecision : "UNKNOWN";

  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const pos = (v: unknown) => { const n = num(v); return n !== null && n > 0 ? n : null; };
  const conf = num(raw.confidence);
  const confidence = conf !== null && conf >= 0 && conf <= 1 ? conf : null;

  const decidedAt = typeof raw.decided_at === "string"
    ? raw.decided_at.slice(0, 40)
    : typeof raw.timestamp === "string"
      ? raw.timestamp.slice(0, 40)
      : null;

  const rrr = pos(raw.trade?.rrr) ?? pos(raw.risk_reward);

  let rawReasoning = "";
  if (typeof raw.summary === "string" && raw.summary.trim()) {
    rawReasoning = raw.summary;
  } else if (Array.isArray(raw.reasons) && raw.reasons.length > 0) {
    rawReasoning = raw.reasons.join("; ");
  } else if (typeof raw.reasoning === "string") {
    rawReasoning = raw.reasoning;
  }
  const reasoning = withoutLevels(rawReasoning).slice(0, 300);

  return {
    candle_key: key,
    candle_open_ms: openMs,
    decided_at: decidedAt,
    decision,
    confidence,
    risk_reward: rrr,
    reasoning,
  };
}

function normalizeDeals(body: any): NormalizedDeal[] {
  const rawDeals = Array.isArray(body?.deals) ? body.deals : [];
  const list: NormalizedDeal[] = [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  for (const d of rawDeals) {
    if (!d || typeof d !== "object") continue;
    const ticket = Number.isInteger(d.deal_ticket) ? d.deal_ticket : null;
    if (!ticket) continue;
    const side = String(d.side || "").toUpperCase() === "BUY" ? "BUY" : "SELL";
    const profit = num(d.profit);
    const commission = num(d.commission);
    const swap = num(d.swap);
    list.push({
      deal_ticket: ticket,
      position_ticket: Number.isInteger(d.position_ticket) ? d.position_ticket : null,
      mode: typeof d.mode === "string" ? d.mode : "unknown",
      side,
      volume: typeof d.volume === "number" && d.volume > 0 ? d.volume : 0,
      profit: r2(profit),
      commission: r2(commission),
      swap: r2(swap),
      net_profit: r2(profit + commission + swap),
      reason: typeof d.reason === "string" ? d.reason : "other",
      signal_id: typeof d.signal_id === "string" ? d.signal_id : null,
      opened_ms: typeof d.opened_ms === "number" && d.opened_ms > 0 ? d.opened_ms : null,
      closed_ms: typeof d.closed_ms === "number" && d.closed_ms > 0 ? d.closed_ms : 0,
      currency: typeof d.currency === "string" ? d.currency : null,
    });
  }
  return list;
}

function computeDealStats(deals: NormalizedDeal[]): DealStatsSummary {
  const nets = deals.map((d) => d.net_profit);
  const wins = nets.filter((x) => x > 0);
  const losses = nets.filter((x) => x < 0);
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  let peak = 0, equity = 0, maxDrawdown = 0;
  for (const x of [...nets].reverse()) {
    equity += x;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return {
    trades: nets.length,
    wins: wins.length,
    losses: losses.length,
    win_rate: nets.length ? r2(wins.length / nets.length) : null,
    net_profit: r2(sum(nets)),
    profit_factor: losses.length ? r2(sum(wins) / Math.abs(sum(losses))) : null,
    average_win: wins.length ? r2(sum(wins) / wins.length) : null,
    average_loss: losses.length ? r2(sum(losses) / losses.length) : null,
    max_drawdown: r2(maxDrawdown),
  };
}

async function fetchXauusd(
  binding: { fetch(input: string, init?: RequestInit): Promise<Response> },
  path: string,
  timeoutMs: number,
): Promise<{ ok: true; body: any } | { ok: false; error: string; status?: number }> {
  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await binding.fetch(`https://xauusd.internal${path}`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      } as RequestInit);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    const error = /abort/i.test(msg) ? "xauusd_timeout" : "xauusd_unreachable";
    return { ok: false, error };
  }
  if (!res.ok) {
    return { ok: false, error: `xauusd_http_${res.status}`, status: res.status };
  }
  try {
    const body = await res.json();
    return { ok: true, body };
  } catch {
    return { ok: false, error: "xauusd_invalid_body" };
  }
}

/** Tier 0: latest XAUUSD advisory decisions and execution deals from xauusd-ai-trading-assistant (read-only). */
export async function observeSignals(
  env: BaseEnv & { XAUUSD_AI?: { fetch(input: string, init?: RequestInit): Promise<Response> } },
  nowOrOptions: number | ObserveSignalsOptions = Date.now(),
  timeoutMsArg = 5000,
): Promise<JsonObject> {
  const opts: ObserveSignalsOptions = typeof nowOrOptions === "number" ? { now: nowOrOptions, timeoutMs: timeoutMsArg } : (nowOrOptions ?? {});
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : timeoutMsArg;
  const observedAt = new Date(now).toISOString();
  const limit = Math.max(1, Math.min(50, Number(opts.limit || 6)));

  if (!env.XAUUSD_AI) {
    return { source: "xauusd-ai-trading-assistant", observed_at: observedAt, available: false, error: "xauusd_binding_missing" };
  }

  if (opts.endpoint === "deals") {
    const dealsRes = await fetchXauusd(env.XAUUSD_AI, `/api/deals?limit=${limit}`, timeoutMs);
    if (!dealsRes.ok) {
      return { source: "xauusd-ai-trading-assistant", observed_at: observedAt, available: false, error: dealsRes.error };
    }
    const deals = normalizeDeals(dealsRes.body);
    return {
      source: "xauusd-ai-trading-assistant",
      observed_at: observedAt,
      available: true,
      endpoint_used: "deals",
      deals: deals as unknown as JsonObject[],
      deal_stats: computeDealStats(deals) as unknown as JsonObject,
    };
  }

  let usedEndpoint = "engine";
  let fetchRes: { ok: true; body: any } | { ok: false; error: string; status?: number };

  if (opts.endpoint === "legacy") {
    usedEndpoint = "legacy";
    fetchRes = await fetchXauusd(env.XAUUSD_AI, `/api/decisions?limit=${limit}`, timeoutMs);
  } else {
    fetchRes = await fetchXauusd(env.XAUUSD_AI, `/api/engine/decisions?limit=${limit}`, timeoutMs);
    if (!fetchRes.ok && fetchRes.status === 404) {
      usedEndpoint = "legacy";
      fetchRes = await fetchXauusd(env.XAUUSD_AI, `/api/decisions?limit=${limit}`, timeoutMs);
    }
  }

  if (!fetchRes.ok) {
    return { source: "xauusd-ai-trading-assistant", observed_at: observedAt, available: false, error: fetchRes.error };
  }

  const body = fetchRes.body;
  let rawItems: any[] = [];
  if (Array.isArray(body?.decisions)) {
    rawItems = body.decisions;
  } else if (body?.decision && typeof body.decision === "object") {
    rawItems = [body.decision];
  } else if (Array.isArray(body?.items)) {
    rawItems = body.items;
  }

  const items: JsonObject[] = [];
  for (const raw of rawItems.slice(0, limit)) {
    const item = normalizeDecisionItem(raw);
    if (item) items.push(item);
  }

  const latest = items.length > 0 ? items[0] : null;
  let stale = items.length === 0;
  if (latest) {
    const isM15 = String(latest.candle_key).includes(":15:");
    const barMs = isM15 ? 15 * 60_000 : 3_600_000;
    const staleGraceMs = isM15 ? 45 * 60_000 : 90 * 60_000;
    const closeMs = (latest.candle_open_ms as number) + barMs;
    stale = now - closeMs > staleGraceMs;
  }

  const result: JsonObject = {
    source: "xauusd-ai-trading-assistant",
    observed_at: observedAt,
    available: true,
    stale,
    endpoint_used: usedEndpoint,
    latest: latest as unknown as JsonObject,
    recent: items,
  };

  if (opts.includeDeals) {
    const dealsLimit = Math.max(1, Math.min(200, Number(opts.dealsLimit || 50)));
    const dealsRes = await fetchXauusd(env.XAUUSD_AI, `/api/deals?limit=${dealsLimit}`, timeoutMs);
    if (dealsRes.ok) {
      const deals = normalizeDeals(dealsRes.body);
      result.deals = deals as unknown as JsonObject[];
      result.deal_stats = computeDealStats(deals) as unknown as JsonObject;
    }
  }

  return result;
}

/** Price-like numbers (3+ digits, including grouped thousands and optional decimals) become "[level]". */
export function withoutLevels(text: string): string {
  return text.replace(/\$?(?:\d{1,3}(?:[.,\s_'’]\d{3})+(?:[.,]\d+)?|\d{3,}(?:[.,]\d+)?)/g, "[level]");
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

export function computeMarketStatus(now = Date.now()): "open" | "closed" | "holiday" {
  const date = new Date(now);
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  if (day === 6) return "closed";
  if (day === 5 && hour >= 22) return "closed";
  if (day === 0 && hour < 22) return "closed";
  return "open";
}

/** Tier 0: read digital metabolism, treasury reserve, burn metrics and power mode. */
export async function observeMetabolism(env: SyscallEnv, now = Date.now()): Promise<JsonObject> {
  const observedAt = new Date(now).toISOString();
  const marketStatus = computeMarketStatus(now);

  let powerMode: "survival" | "homeostasis" | "growth" = "homeostasis";
  let powerOverride = "none";
  let autoAdaptation = true;

  try {
    const controls = await env.DB.prepare("SELECT control, value FROM metabolism_controls").all<{ control: string; value: string }>();
    for (const c of controls.results) {
      if (c.control === "power_mode" && ["survival", "homeostasis", "growth"].includes(c.value)) {
        powerMode = c.value as any;
      }
      if (c.control === "power_mode_override") {
        powerOverride = c.value;
      }
      if (c.control === "auto_adaptation_enabled") {
        autoAdaptation = c.value === "1";
      }
    }
  } catch {}

  const effectivePowerMode = (["survival", "homeostasis", "growth"].includes(powerOverride) ? powerOverride : powerMode) as "survival" | "homeostasis" | "growth";

  // The treasury is measured only once the owner has recorded a ledger entry. The genesis seed of
  // migration 0043 (source "genesis:*") is a placeholder (owner 2026-11-10: "itu masih placeholder"):
  // its balance is reported as such, and no runway is derived from it.
  let treasuryReserve: number | null = null;
  let treasurySource: "ledger" | "placeholder" | "none" = "none";
  try {
    const measured = await env.DB.prepare(
      "SELECT balance_after_usd FROM treasury_ledger WHERE source NOT LIKE 'genesis:%' ORDER BY created_at DESC, rowid DESC LIMIT 1"
    ).first<{ balance_after_usd: number }>();
    if (measured && typeof measured.balance_after_usd === "number") {
      treasuryReserve = measured.balance_after_usd;
      treasurySource = "ledger";
    } else {
      const seed = await env.DB.prepare(
        "SELECT balance_after_usd FROM treasury_ledger WHERE source LIKE 'genesis:%' ORDER BY created_at DESC, rowid DESC LIMIT 1"
      ).first<{ balance_after_usd: number }>();
      if (seed && typeof seed.balance_after_usd === "number") {
        treasuryReserve = seed.balance_after_usd;
        treasurySource = "placeholder";
      }
    }
  } catch {}

  let tradingNetPnl24h = 0;
  if (env.XAUUSD_AI) {
    try {
      const dealsRes = await fetchXauusd(env.XAUUSD_AI, "/api/deals?limit=100", 3000);
      if (dealsRes.ok) {
        const deals = normalizeDeals(dealsRes.body);
        const dayAgo = now - 24 * 3600_000;
        const recent24h = deals.filter((d) => d.closed_ms >= dayAgo);
        tradingNetPnl24h = Math.round(recent24h.reduce((sum, d) => sum + d.net_profit, 0) * 100) / 100;
      }
    } catch {}
  }

  let infraBurn24h = 0.15;
  try {
    const dayStr = new Date(now).toISOString().slice(0, 10);
    const burnRow = await env.DB.prepare(
      "SELECT SUM(estimated_cost_usd) AS total_burn FROM infra_burn_metrics WHERE period_day = ?"
    ).bind(dayStr).first<{ total_burn: number }>();
    if (burnRow && typeof burnRow.total_burn === "number" && burnRow.total_burn > 0) {
      infraBurn24h = Math.round(burnRow.total_burn * 100) / 100;
    } else {
      const recentBurn = await env.DB.prepare(
        "SELECT SUM(estimated_cost_usd) AS total_burn FROM infra_burn_metrics WHERE period_day >= ? AND estimated_cost_usd > 0"
      ).bind(new Date(now - 7 * 86_400_000).toISOString().slice(0, 10)).first<{ total_burn: number }>();
      if (recentBurn && typeof recentBurn.total_burn === "number" && recentBurn.total_burn > 0) {
        infraBurn24h = Math.round((recentBurn.total_burn / 7) * 100) / 100;
      } else {
        const aiUsage = await env.DB.prepare(
          "SELECT SUM(requests) AS total_requests FROM ai_usage WHERE day = ?"
        ).bind(dayStr).first<{ total_requests: number }>();
        const requests = aiUsage?.total_requests ?? 0;
        infraBurn24h = Math.round((0.15 + (requests * 0.001)) * 100) / 100;
      }
    }
  } catch {}

  const metabolicRatio = infraBurn24h > 0 ? Math.round((tradingNetPnl24h / infraBurn24h) * 100) / 100 : null;
  const runwayDays = treasurySource === "ledger" && treasuryReserve !== null && infraBurn24h > 0 ? Math.round((treasuryReserve / infraBurn24h) * 10) / 10 : null;

  return {
    source: "cryptophys-digital-metabolism",
    observed_at: observedAt,
    market_status: marketStatus,
    power_mode: effectivePowerMode,
    power_mode_override: powerOverride,
    auto_adaptation_enabled: autoAdaptation,
    treasury_reserve_usd: treasuryReserve,
    treasury_source: treasurySource,
    runway_days: runwayDays,
    infra_burn_cost_24h: infraBurn24h,
    trading_net_pnl_24h: tradingNetPnl24h,
    metabolic_ratio: metabolicRatio,
  };
}

const TIER0_HANDLERS: Record<string, (env: SyscallEnv, input: JsonObject, agentId: string) => Promise<JsonObject>> = {
  "platform.observe": (env) => observe(env),
  "signals.observe": (env, input) => observeSignals(env, {
    now: typeof input.now === "number" ? input.now : Date.now(),
    endpoint: typeof input.endpoint === "string" ? (input.endpoint as any) : undefined,
    includeDeals: input.include_deals === true || input.includeDeals === true,
    limit: typeof input.limit === "number" ? input.limit : undefined,
    dealsLimit: typeof input.deals_limit === "number" ? input.deals_limit : undefined,
  }),
  "metabolism.observe": (env, input) => observeMetabolism(env, typeof input.now === "number" ? input.now : Date.now()),
  "audit.verify": (env, input) => verifyAudit(env, typeof input.now === "number" ? input.now : Date.now()),
  "memory.recall": (env, input, agentId) => recallMemories(env, agentId, input),
  "knowledge.status": (env, input, agentId) => knowledgeStatus(env.DB, agentId, input),
  "doctrine.status": (env, input) => doctrineStatus(env.DB, input),
};

/**
 * Owner 2026-11-11: the doctrine amendments Cerebrum executed (doctrine_amendments, migration 0045),
 * oldest first, after `since` (ISO time). The Knowledge Council applies only these.
 */
async function doctrineStatus(db: SyscallEnv["DB"], input: JsonObject): Promise<JsonObject> {
  const since = typeof input.since === "string" && Number.isFinite(Date.parse(input.since)) ? new Date(Date.parse(input.since)).toISOString() : "1970-01-01T00:00:00.000Z";
  const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 200);
  const rows = await db.prepare(
    "SELECT amendment_id, rule_id, action, values_json, previous_json, canon, session_id, executed_by, executed_at FROM doctrine_amendments WHERE executed_at > ? ORDER BY executed_at, amendment_id LIMIT ?",
  ).bind(since, limit).all<Record<string, string>>();
  return {
    amendments: rows.results.map((r) => ({
      amendment_id: r.amendment_id, rule: r.rule_id, action: r.action, values: JSON.parse(r.values_json), previous: JSON.parse(r.previous_json),
      canon: r.canon, session: r.session_id, executed_by: r.executed_by, executed_at: r.executed_at,
    })),
  };
}

async function dispatch(env: SyscallEnv, capability: string, agentId: string, decisionId: string, input: JsonObject): Promise<JsonObject> {
  switch (capability) {
    case "recovery.propose": return { plan: await env.RECOVERY.propose(agentId, decisionId, input) };
    case "reports.publish": return { report: await publishReport(env.DB, agentId, decisionId, input) };
    case "memory.remember": return { memory: await rememberMemory(env, agentId, decisionId, input) };
    case "consensus.propose": return { proposal: await consensusPropose(env, agentId, decisionId, input) };
    case "knowledge.propose": return { proposal: await proposeKnowledge(env.DB, agentId, decisionId, input) };
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
