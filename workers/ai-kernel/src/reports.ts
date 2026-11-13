/**
 * Generic agent_reports store (TP-006, ADR-0007). Owned by the AI Kernel and written only
 * through the policy-gated reports.publish syscall, which re-verifies the Policy Engine
 * decision id before inserting.
 */
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { newId, nowIso, type JsonObject } from "../../control-plane-shared/src/http.ts";
import { verifySyscallDecision } from "../../control-plane-shared/src/capabilities.ts";
import { appendAuditEventWithMutation, AuditMutationConflictError } from "../../control-plane-shared/src/audit.ts";

export const REPORT_KINDS = ["signal_digest", "audit_digest", "platform_digest", "xauusd_digest", "hud_digest", "knowledge_audit"] as const;
export const REPORT_SEVERITIES = ["info", "warning", "critical"] as const;
export const MAX_REPORT_BODY_BYTES = 16 * 1024;
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

/** An approver's acknowledgement of a critical report (migration 0053), as the API shows it. */
export interface Acknowledgement { acknowledged_by: string; reason: string; acknowledged_at: string }

export function presentReport(r: ReportRow, acknowledgement: Acknowledgement | null = null): JsonObject {
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
    acknowledgement: acknowledgement ? { ...acknowledgement } : null,
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
  if (new TextEncoder().encode(bodyJson).byteLength > MAX_REPORT_BODY_BYTES) throw new Error("report_body_too_large");
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
    clauses.push("r.agent_id = ?");
    params.push(filters.agent_id);
  }
  if (filters.kind) {
    clauses.push("r.kind = ?");
    params.push(filters.kind);
  }
  const n = typeof filters.limit === "number" && Number.isInteger(filters.limit) && filters.limit >= 1 && filters.limit <= 100 ? filters.limit : 20;
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  // Before migration 0053 there is no acknowledgement to show: every report reads as not acknowledged.
  const acks = await acknowledgementsReadable(db);
  const rows = await db.prepare(
    acks
      ? `SELECT r.*, a.acknowledged_by AS ack_by, a.reason AS ack_reason, a.acknowledged_at AS ack_at FROM agent_reports r
         LEFT JOIN agent_report_acknowledgements a ON a.report_id = r.report_id ${where} ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?`
      : `SELECT r.* FROM agent_reports r ${where} ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?`,
  ).bind(...params, n).all<ReportRow & { ack_by?: string | null; ack_reason?: string | null; ack_at?: string | null }>();
  return {
    reports: rows.results.map((r) => {
      const { ack_by, ack_reason, ack_at, ...row } = r;
      return presentReport(row, ack_by && ack_reason && ack_at ? { acknowledged_by: ack_by, reason: ack_reason, acknowledged_at: ack_at } : null);
    }),
  };
}

// ---------------------------------------------------------------- acknowledgements (ADR-0009 amendment 2026-11-13)
// Owner 2026-11-13 ("Tambah tombol 'acknowledge'"): an approver, a person, may acknowledge a critical report as
// handled. An acknowledged critical report is no longer open, so it stops counting toward the consensus baseline
// ("a critical report is open in the last 24 h"). Unacknowledged critical reports block exactly as before;
// warnings and info cannot be acknowledged (they do not block). The report itself is never changed.

export const ACK_REASON_MIN = 10;
export const ACK_REASON_MAX = 500;
export const REPORT_ID_RE = /^rpt_[0-9a-f-]{36}$/;

export class ReportAcknowledgeError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

/** The typed phrase, as the Console renders its `ACKNOWLEDGE {id13}` template (a trailing separator dropped). */
export function acknowledgePhrase(reportId: string): string {
  return `ACKNOWLEDGE ${reportId.slice(0, 13).replace(/[-_.:]+$/, "")}`;
}

/**
 * True when migration 0053's table can be read. Before it exists nothing counts as acknowledged, so every
 * critical report keeps blocking: a missing table never opens the brake.
 */
export async function acknowledgementsReadable(db: D1Database): Promise<boolean> {
  try {
    await db.prepare("SELECT report_id FROM agent_report_acknowledgements LIMIT 1").first();
    return true;
  } catch {
    return false;
  }
}

async function readAcknowledgement(db: D1Database, reportId: string): Promise<Acknowledgement | null> {
  return db.prepare("SELECT acknowledged_by, reason, acknowledged_at FROM agent_report_acknowledgements WHERE report_id = ?")
    .bind(reportId).first<Acknowledgement>();
}

/**
 * POST /v1/reports/{id}/acknowledge. The caller has already been checked to be an approver (never a service
 * token); `actor` is that person's Access identity. Idempotent: a report that is already acknowledged returns
 * the existing acknowledgement, and no second audit event is written.
 */
export async function acknowledgeReport(db: D1Database, reportId: string, actor: string, confirmRaw: unknown, reasonRaw: unknown): Promise<JsonObject> {
  if (!/^[^@\s]{1,100}@[^@\s]{1,100}$/.test(actor)) throw new ReportAcknowledgeError(403, "person_required", "acknowledging a report needs a person's Access identity");
  const report = await db.prepare("SELECT report_id, agent_id, kind, severity, subject, created_at FROM agent_reports WHERE report_id = ?")
    .bind(reportId).first<{ report_id: string; agent_id: string; kind: string; severity: string; subject: string; created_at: string }>();
  if (!report) throw new ReportAcknowledgeError(404, "not_found", "unknown report");
  if (report.severity !== "critical") throw new ReportAcknowledgeError(409, "not_critical", "only a critical report can be acknowledged; warnings and info do not block");
  const phrase = acknowledgePhrase(reportId);
  if (confirmRaw !== phrase) throw new ReportAcknowledgeError(400, "confirmation_required", `type the exact confirmation ${phrase}`);
  const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";
  if (reason.length < ACK_REASON_MIN || reason.length > ACK_REASON_MAX) {
    throw new ReportAcknowledgeError(400, "invalid_reason", `reason must be ${ACK_REASON_MIN}-${ACK_REASON_MAX} characters`);
  }
  const existing = await readAcknowledgement(db, reportId);
  if (existing) return { report_id: reportId, acknowledgement: existing, already_acknowledged: true };
  try {
    // The acknowledgement and its audit event commit together, or neither does. The insert writes nothing when
    // another request acknowledged the report first; the audit event then fails and nothing is committed.
    await appendAuditEventWithMutation(db, {
      event_type: "report.acknowledged", actor, subject: `report:${reportId}`, outcome: "acknowledged",
      payload: { report_id: reportId, agent_id: report.agent_id, kind: report.kind, subject: report.subject, reason },
    }, (event) => db.prepare(
      `INSERT INTO agent_report_acknowledgements (report_id, acknowledged_by, reason, acknowledged_at)
       SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM agent_reports WHERE report_id = ? AND severity = 'critical')
         AND NOT EXISTS (SELECT 1 FROM agent_report_acknowledgements WHERE report_id = ?)`,
    ).bind(reportId, actor, reason, event.created_at, reportId, reportId));
  } catch (err) {
    if (!(err instanceof AuditMutationConflictError)) throw err;
    const raced = await readAcknowledgement(db, reportId);
    if (raced) return { report_id: reportId, acknowledgement: raced, already_acknowledged: true };
    throw new ReportAcknowledgeError(409, "acknowledge_conflict", "the report changed while this request was in progress; reload and retry");
  }
  const created = await readAcknowledgement(db, reportId);
  return { report_id: reportId, acknowledgement: created, already_acknowledged: false };
}
