/**
 * Generic agent_reports store (TP-006, ADR-0007). Owned by the AI Kernel and written only
 * through the policy-gated reports.publish syscall, which re-verifies the Policy Engine
 * decision id before inserting.
 */
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { newId, nowIso, type JsonObject } from "../../control-plane-shared/src/http.ts";
import { verifySyscallDecision } from "../../control-plane-shared/src/capabilities.ts";

export const REPORT_KINDS = ["signal_digest", "audit_digest", "platform_digest", "xauusd_digest", "hud_digest"] as const;
export const REPORT_SEVERITIES = ["info", "warning", "critical"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export type ReportSeverity = (typeof REPORT_SEVERITIES)[number];

export interface ReportRow {
  report_id: string;
  agent_id: string;
  kind: ReportKind;
  severity: ReportSeverity;
  subject: string;
  body_json: string;
  ai_status: string;
  decision_id: string | null;
  created_at: string;
}

export function presentReport(r: ReportRow): JsonObject {
  return {
    report_id: r.report_id,
    agent_id: r.agent_id,
    kind: r.kind,
    severity: r.severity,
    subject: r.subject,
    body: JSON.parse(r.body_json) as JsonObject,
    ai_status: r.ai_status,
    decision_id: r.decision_id,
    created_at: r.created_at,
  };
}

export async function publishReport(
  db: D1Database,
  agentId: string,
  decisionId: unknown,
  input: Record<string, unknown>,
): Promise<JsonObject> {
  await verifySyscallDecision(db, decisionId, agentId, "reports.publish");
  const kind = String(input.kind ?? "");
  const severity = String(input.severity ?? "");
  const subject = String(input.subject ?? "").trim().slice(0, 200);
  const aiStatus = String(input.ai_status ?? "unknown").slice(0, 40);
  const body = input.body;
  if (!(REPORT_KINDS as readonly string[]).includes(kind)) throw new Error("invalid_report_kind");
  if (!(REPORT_SEVERITIES as readonly string[]).includes(severity)) throw new Error("invalid_report_severity");
  if (!subject) throw new Error("invalid_report_subject");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_report_body");
  const reportId = newId("rpt");
  const createdAt = nowIso();
  const bodyJson = JSON.stringify(body);
  await db.prepare(
    `INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(reportId, agentId, kind, severity, subject, bodyJson, aiStatus, decisionId as string, createdAt).run();
  return {
    report_id: reportId,
    agent_id: agentId,
    kind,
    severity,
    subject,
    body: body as JsonObject,
    ai_status: aiStatus,
    decision_id: decisionId as string,
    created_at: createdAt,
  };
}

export async function listReports(
  db: D1Database,
  filters: { agent_id?: string | null; kind?: string | null; limit?: number } = {},
): Promise<JsonObject> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.agent_id) {
    clauses.push("agent_id = ?");
    params.push(filters.agent_id);
  }
  if (filters.kind) {
    clauses.push("kind = ?");
    params.push(filters.kind);
  }
  const n = typeof filters.limit === "number" && Number.isInteger(filters.limit) && filters.limit >= 1 && filters.limit <= 100 ? filters.limit : 20;
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await db.prepare(
    `SELECT * FROM agent_reports ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).bind(...params, n).all<ReportRow>();
  return { reports: rows.results.map(presentReport) };
}
