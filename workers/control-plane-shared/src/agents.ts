/**
 * Client for the AI Kernel's AgentRpc entrypoint (ADR-0007 §1.1, TP-011). A platform Worker
 * binds to it as `AGENTS` with `props = { host_worker = "<its own Worker name>" }`, so it can
 * act only as the agents it hosts, at tier <= 1, through the normal syscall checks.
 *
 * Agent calls are advisory: this helper never throws. A missing binding, a policy denial,
 * a rate limit or a kernel outage is returned as data and logged, and never fails the
 * Worker's own (authoritative) work.
 */
import type { JsonObject } from "./http.ts";

export interface AgentRpcBinding {
  whoami(agentId: string): Promise<JsonObject>;
  observe(agentId: string, capability: string, input?: JsonObject): Promise<JsonObject>;
  syscall(agentId: string, capability: string, input?: JsonObject): Promise<JsonObject>;
}

export type ReportKind = "platform_digest" | "signal_digest" | "audit_digest" | "xauusd_digest" | "hud_digest" | "knowledge_audit";
export interface AgentReport {
  kind: ReportKind;
  severity: "info" | "warning" | "critical";
  subject: string;
  body: JsonObject;
}

export type AgentCallResult = { ok: true; result: JsonObject } | { ok: false; reason: string };

export async function publishAgentReport(binding: AgentRpcBinding | undefined, agentId: string, report: AgentReport): Promise<AgentCallResult> {
  if (!binding) return { ok: false, reason: "agents_binding_missing" };
  try {
    const result = await binding.syscall(agentId, "reports.publish", {
      kind: report.kind, severity: report.severity, subject: report.subject.slice(0, 200),
      ai_status: "deterministic", body: { ...report.body, disclaimer: "advisory only; not an order" },
    });
    if (result?.outcome === "succeeded") return { ok: true, result };
    const reason = String(result?.reason ?? result?.outcome ?? "unknown");
    console.log(JSON.stringify({ event: "agent_report_not_published", agent_id: agentId, reason }));
    return { ok: false, reason };
  } catch (err) {
    const reason = String((err as Error)?.message ?? err).slice(0, 200);
    console.error(JSON.stringify({ event: "agent_report_failed", agent_id: agentId, reason }));
    return { ok: false, reason };
  }
}
