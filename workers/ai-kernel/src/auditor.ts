/**
 * Platform Auditor agent (TP-007, ADR-0007).
 *
 * Hosted by cryptophys-ai-kernel at tier_max = 1. Runs hourly at minute 37:
 *  - Tier 0: reads full audit chain verification and 24-hour governance event counts via audit.verify.
 *  - Deterministic trigger:
 *      * chain invalid -> critical
 *      * > 3 denied agent syscalls in 24h OR any kernel.agents_enabled change in 24h -> warning
 *      * otherwise once daily on the 00:37 UTC cycle -> info
 *  - AI task draft_audit_digest drafts human-readable text; validator rejects any output whose
 *    claim about chain validity contradicts the deterministic verification result.
 *  - Body carries the deterministic verification result and 24h counts verbatim.
 *  - The auditor never fixes anything: it never suspends agents, alters data, or proposes recovery.
 */
import type { JsonObject } from "../../control-plane-shared/src/http.ts";
import { boundedString, engineFor, type AiTask } from "../../control-plane-shared/src/ai-engine.ts";
import { agentsEnabled, getAgent } from "../../control-plane-shared/src/capabilities.ts";
import type { ChainVerification } from "../../control-plane-shared/src/audit.ts";
import type { ReportSeverity } from "./reports.ts";
import { pruneExpiredMemories, recallContextForAgent, rememberOutcomeForAgent } from "./memory.ts";
import type { CycleReport, KernelEnv, Memory } from "./supervisor.ts";
import { syscall } from "./syscall.ts";

export const AUDITOR_ID = "auditor";
const SERVICE = "cryptophys-ai-kernel";

/** Serializes overlapping invocations of the Auditor Durable Object cycle, including awaits. */
export class AuditorCycleQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export interface AgentActionCountByAgent {
  agent_id: string;
  denied: number;
  failed: number;
}

export interface PolicyDenyCountByAction {
  action: string;
  count: number;
}

export interface AuditCounts24h {
  agent_actions_by_agent: AgentActionCountByAgent[];
  denied_agent_syscalls: number;
  failed_agent_syscalls: number;
  policy_denies_by_action: PolicyDenyCountByAction[];
  governance_audit_events: {
    "agent.suspended": number;
    "agent.resumed": number;
    "kernel.agents_enabled": number;
  };
  agent_recovery_plans: number;
}

export interface AuditObservation {
  observed_at: string;
  since: string;
  chain: ChainVerification;
  valid: boolean;
  events_checked: number;
  counts_24h: AuditCounts24h;
}

export interface AuditDigestDraft {
  headline: string;
  summary: string;
  items: string[];
}

function contradictsChainValidity(text: string, deterministicValid: boolean): boolean {
  if (!deterministicValid) {
    // Chain is deterministically INVALID: reject if AI claims the chain is valid/intact/verified/unbroken or no tampering.
    const claimsValid = /\b(?:(?:audit\s+|hash\s+)?chain\s+(?:is\s+|remains\s+)?(?:valid|intact|verified|unbroken|healthy|ok)|all\s+hashes\s+(?:are\s+)?valid|no\s+tamper(?:ing)?(?:\s+detected)?|valid\s*:\s*true)\b/i.test(text);
    const negated = /\b(?:not|never|isn't|is\s+not)\s+(?:valid|intact|verified|unbroken|healthy|ok)\b/i.test(text);
    return claimsValid && !negated;
  }
  // Chain is deterministically VALID: reject if AI claims the chain is invalid/broken/tampered/corrupted.
  const claimsInvalid = /\b(?:(?:audit\s+|hash\s+)?chain\s+(?:is\s+)?(?:invalid|broken|tampered|corrupted|compromised)|tamper(?:ing)?\s+detected|hash\s+mismatch|valid\s*:\s*false)\b/i.test(text);
  const negated = /\b(?:no|not|never|without)\s+(?:invalid|broken|tamper(?:ed|ing)?|corrupted|compromised|hash\s+mismatch)\b/i.test(text);
  return claimsInvalid && !negated;
}

export function draftAuditDigestTask(obs: AuditObservation): AiTask<AuditDigestDraft> {
  return {
    name: "draft_audit_digest",
    instructions:
      "You are the advisory Platform Auditor of the cryptophys control plane. Summarize the deterministic audit chain verification and 24-hour governance counts accurately. " +
      'Return {"headline": at most 160 characters, "summary": at most 800 characters, "items": array of 1..8 strings each at most 200 characters}. ' +
      "Never contradict the deterministic chain validity result.",
    maxInputChars: 6000,
    maxOutputTokens: 500,
    validate(raw): AuditDigestDraft | null {
      if (!raw || typeof raw !== "object") return null;
      const v = raw as Record<string, unknown>;
      const headline = boundedString(v.headline, 160);
      const summary = boundedString(v.summary, 800);
      if (!headline || !summary || !Array.isArray(v.items) || v.items.length < 1) return null;
      // The model often lists more than 8 points; keep the first 8 instead of discarding the whole
      // draft (2026-11-07: items_invalid was the main AI failure). Every kept item is still checked,
      // and the chain-validity checks below run on exactly the text that is published.
      const items: string[] = [];
      for (const rawItem of v.items.slice(0, 8)) {
        const item = boundedString(rawItem, 200);
        if (!item) return null;
        items.push(item);
      }
      if (typeof v.chain_valid === "boolean" && v.chain_valid !== obs.chain.valid) return null;
      const combined = `${headline}\n${summary}\n${items.join("\n")}`;
      if (contradictsChainValidity(combined, obs.chain.valid)) return null;
      return { headline, summary, items };
    },
    diagnose(raw): string {
      if (!raw || typeof raw !== "object") return "unknown";
      const v = raw as Record<string, unknown>;
      const headline = boundedString(v.headline, 160);
      if (!headline) return "headline_invalid";
      const summary = boundedString(v.summary, 800);
      if (!summary) return "summary_invalid";
      if (!Array.isArray(v.items) || v.items.length < 1) return "items_invalid";
      for (const rawItem of v.items.slice(0, 8)) {
        const item = boundedString(rawItem, 200);
        if (!item) return "item_invalid";
      }
      if (typeof v.chain_valid === "boolean" && v.chain_valid !== obs.chain.valid) return "chain_valid_mismatch";
      const combined = `${headline}\n${summary}\n${(v.items as unknown[]).slice(0, 8).join("\n")}`;
      if (contradictsChainValidity(combined, obs.chain.valid)) return "chain_contradiction";
      return "unknown";
    },
  };
}

export function templateAuditDigest(
  obs: AuditObservation,
  severity: ReportSeverity,
  reasons: string[],
): AuditDigestDraft {
  const c = obs.counts_24h;
  // Plain English for operators (2026-11-07); the raw counts stay in the report body.
  const plainReason = (r: string) => {
    const [code, n] = r.split(":");
    if (code === "denied_agent_syscalls") return `${n} agent request(s) were refused by policy`;
    if (code === "failed_agent_syscalls") return `${n} agent request(s) failed`;
    if (code === "kernel_agents_enabled_changed") return "the agents' kill switch was changed";
    if (code === "agent_suspended") return `${n ?? "an"} agent was paused`;
    return code.replace(/_/g, " ") + (n ? ` (${n})` : "");
  };
  const headline = !obs.chain.valid
    ? `CRITICAL: the audit log has been altered (first bad entry: ${obs.chain.first_invalid_event_id ?? "unknown"})`
    : severity === "warning"
      ? `Needs a look: ${reasons.map(plainReason).join("; ")} in the last 24 hours`
      : `Daily audit check: the audit log is intact (${obs.chain.events_checked} entries checked)`;

  const chainLine = obs.chain.valid
    ? `The audit log is intact: all ${obs.chain.events_checked} entries check out.`
    : `The audit log is NOT intact: entry ${obs.chain.first_invalid_event_id ?? "unknown"} does not match (${obs.chain.reason ?? "hash mismatch"}) after ${obs.chain.events_checked} entries.`;

  const gov = c.governance_audit_events;
  const summary =
    `${chainLine} In the last 24 hours, ${c.denied_agent_syscalls} agent request(s) were refused by policy and ${c.failed_agent_syscalls} failed. ` +
    `Agents paused: ${gov["agent.suspended"]}, resumed: ${gov["agent.resumed"]}; kill-switch changes: ${gov["kernel.agents_enabled"]}. ` +
    `Recovery plans written by agents: ${c.agent_recovery_plans}.`.slice(0, 800);

  const items: string[] = [
    obs.chain.valid
      ? `Audit log intact (${obs.chain.events_checked} entries checked)`
      : `Audit log altered at entry ${obs.chain.first_invalid_event_id ?? "unknown"}: ${obs.chain.reason ?? "tampered"}`.slice(0, 200),
    `Agent requests in 24 hours: ${c.denied_agent_syscalls} refused, ${c.failed_agent_syscalls} failed`,
    `Agents paused ${gov["agent.suspended"]}, resumed ${gov["agent.resumed"]}; kill-switch changes ${gov["kernel.agents_enabled"]}`,
    `Recovery plans written by agents in 24 hours: ${c.agent_recovery_plans}`,
  ];
  for (const a of c.agent_actions_by_agent.slice(0, 2)) {
    items.push(`Agent ${a.agent_id}: ${a.denied} refused, ${a.failed} failed`.slice(0, 200));
  }
  for (const p of c.policy_denies_by_action.slice(0, 2)) {
    items.push(`Policy refused "${p.action.replace(/[._]/g, " ")}" ${p.count} time(s)`.slice(0, 200));
  }
  return {
    headline: headline.slice(0, 160),
    summary,
    items: items.slice(0, 8),
  };
}

function evaluateAuditTriggers(
  obs: AuditObservation,
  now: number,
  lastDailyDay: string | undefined,
): { shouldPublish: boolean; severity: ReportSeverity; reasons: string[]; dailyDay?: string } {
  const reasons: string[] = [];
  let severity: ReportSeverity = "info";

  if (!obs.chain.valid) {
    severity = "critical";
    reasons.push("audit_chain_invalid");
  }
  if (obs.counts_24h.denied_agent_syscalls > 3) {
    if (severity !== "critical") severity = "warning";
    reasons.push(`denied_agent_syscalls:${obs.counts_24h.denied_agent_syscalls}`);
  }
  if (obs.counts_24h.governance_audit_events["kernel.agents_enabled"] > 0) {
    if (severity !== "critical") severity = "warning";
    reasons.push(`kernel_agents_enabled_changed:${obs.counts_24h.governance_audit_events["kernel.agents_enabled"]}`);
  }

  const dt = new Date(now);
  const utcDay = dt.toISOString().slice(0, 10);
  const is0037Cycle = dt.getUTCHours() === 0 && dt.getUTCMinutes() === 37;
  if (reasons.length === 0 && is0037Cycle && lastDailyDay !== utcDay) {
    reasons.push("daily_0037_utc_digest");
    return { shouldPublish: true, severity: "info", reasons, dailyDay: utcDay };
  }

  return { shouldPublish: reasons.length > 0, severity, reasons, dailyDay: is0037Cycle ? utcDay : undefined };
}

export async function runAuditCycle(
  env: KernelEnv,
  memory: Memory,
  trigger: "scheduled" | "operator",
  now = Date.now(),
): Promise<CycleReport> {
  const report: CycleReport = { agent_id: AUDITOR_ID, trigger, cycle_at: new Date(now).toISOString(), findings: [], actions: [] };
  const agent = await getAgent(env.DB, AUDITOR_ID);
  if (!agent || agent.status !== "enabled" || !(await agentsEnabled(env.DB))) {
    report.skipped = !agent ? "agent_not_registered" : agent.status !== "enabled" ? "agent_suspended" : "agents_disabled";
    await memory.put("last_cycle", report);
    return report;
  }

  const obsCall = await syscall(env, AUDITOR_ID, "audit.verify", { now });
  report.actions.push(obsCall);
  if (obsCall.outcome !== "succeeded") {
    await memory.put("last_cycle", report);
    return report;
  }
  const obs = obsCall.result as unknown as AuditObservation;
  const lastDailyDay = await memory.get<string>("last_daily_digest_day");

  const dt = new Date(now);
  if (dt.getUTCHours() === 0 && dt.getUTCMinutes() === 37) {
    try {
      await pruneExpiredMemories(env, now);
    } catch {
      report.memory = "unavailable";
    }
  }

  const { shouldPublish, severity, reasons, dailyDay } = evaluateAuditTriggers(obs, now, lastDailyDay);
  if (!shouldPublish) {
    report.findings.push({ kind: "audit", action: "none" });
    await memory.put("last_cycle", report);
    return report;
  }

  const recalled = await recallContextForAgent(env, AUDITOR_ID, `audit ${severity} ${reasons.join(" ")}`, report);
  const task = draftAuditDigestTask(obs);
  const baseInput: JsonObject = {
    severity,
    trigger_reasons: reasons,
    chain: obs.chain as unknown as JsonObject,
    counts_24h: obs.counts_24h as unknown as JsonObject,
  };
  const aiInput = recalled && recalled.length > 0 ? { ...baseInput, context: recalled } : baseInput;
  const ai = await engineFor(env, SERVICE, [task.name]).run(
    task,
    aiInput,
    `${AUDITOR_ID}:${now}`,
  );
  const draft = ai.status === "ok" ? ai.data : templateAuditDigest(obs, severity, reasons);

  const body: JsonObject = {
    headline: draft.headline,
    summary: draft.summary,
    items: draft.items,
    valid: obs.chain.valid,
    events_checked: obs.chain.events_checked,
    chain: obs.chain as unknown as JsonObject,
    counts_24h: obs.counts_24h as unknown as JsonObject,
    trigger_reasons: reasons,
  };

  const pub = await syscall(env, AUDITOR_ID, "reports.publish", {
    kind: "audit_digest",
    severity,
    subject: draft.headline,
    ai_status: ai.status,
    body,
  });
  report.actions.push(pub);
  report.findings.push({
    kind: "audit",
    action: "reports.publish",
    outcome: pub.outcome,
    severity,
    ai: ai.status,
  });

  if (pub.outcome === "succeeded") {
    if (dailyDay) {
      await memory.put("last_daily_digest_day", dailyDay);
    }
    const reportId = String(((pub.result.report as JsonObject | undefined)?.report_id) ?? "");
    await rememberOutcomeForAgent(env, AUDITOR_ID, "audit_digest", draft.headline, reportId || null, report);
  }
  await memory.put("last_cycle", report);
  return report;
}
