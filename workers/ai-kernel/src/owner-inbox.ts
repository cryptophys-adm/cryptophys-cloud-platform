// Owner decision 2026-11-13 ("Batasi User/Owner hanya untuk critical dan permintaan approval only"): every loop that
// needs a person surfaces in one Console panel, the Owner page (#/owner), and the owner is contacted only for those
// items. This module is the one reading of "what needs the owner": the owner notices (owner-notices.ts) and the
// Console's GET /v1/owner/inbox both use it, so an email or Telegram message and the panel always list the same items.
//
//   approvals         - recovery plans in draft (Recovery Manager; an approver approves or disables them),
//                       critical consensus proposals in pending_owner (ADR-0009 phase 4; approve or reject),
//                       pending learned-knowledge proposals (TP-028; approve for shadow testing or reject);
//   critical_reports  - open critical agent reports of the last 24 hours (not acknowledged; ADR-0009 amendment
//                       2026-11-13). Each one blocks routine consensus until an approver acknowledges it.
//
// Read-only: no expiry sweep, no write. Before migration 0029 (knowledge) or 0053 (acknowledgements) the missing
// table reads as no knowledge proposal and as nothing acknowledged (every critical report open: fail closed).
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { acknowledgementsReadable } from "./reports.ts";
import { OWNER_DECISION_WINDOW_MS, PHASE4_EXECUTABLE } from "./consensus.ts";
import { KNOWLEDGE_REVIEW_WINDOW_MS } from "./knowledge.ts";

/** At most this many items of each kind are listed (the owner notices have always used 50). */
export const INBOX_LIMIT = 50;
/** Open critical reports are read from this window, as for the consensus brake. */
export const CRITICAL_WINDOW_MS = 24 * 3_600_000;

export interface PendingPlan {
  plan_id: string; service_id: string; plan_version: string; created_by: string; created_at: string; approve_by: string | null;
  title: string | null; rationale: string | null; steps: { action: string; description: string }[];
  /** Authored by a service token (the deploy workflow's verification), not by an agent or a person. */
  synthetic: boolean;
}
export interface PendingProposal {
  proposal_id: string; action: string; target: string; proposer_agent_id: string; created_at: string; expires_at: string;
  approvals: number; rejections: number; eligible: number;
  /** The platform can execute it after the owner's click (PHASE4_EXECUTABLE); otherwise it is carried out by runbook and rejected. */
  executable: boolean;
}
export interface PendingKnowledge {
  proposal_id: string; item_id: string; item_version: number; kind: string; proposer_agent_id: string; created_at: string; expires_at: string;
  item: Record<string, unknown> | null;
}
export interface OpenCriticalReport { report_id: string; agent_id: string; kind: string; severity: "critical"; subject: string; created_at: string }
export interface PendingApprovals { recovery_plans: PendingPlan[]; consensus: PendingProposal[]; knowledge: PendingKnowledge[] }

const iso = (ms: number) => new Date(ms).toISOString();
const plus = (at: string, ms: number) => { const t = Date.parse(at); return Number.isFinite(t) ? iso(t + ms) : at; };
function parse(json: unknown): Record<string, unknown> | null {
  try { const v = JSON.parse(String(json ?? "")); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
}

/** Everything that waits for an approver's click, oldest first. */
export async function pendingApprovals(db: D1Database): Promise<PendingApprovals> {
  const plans = await db.prepare(
    "SELECT plan_id, service_id, plan_version, steps_json, created_by, created_at, approve_by FROM recovery_plans WHERE status = 'draft' ORDER BY created_at LIMIT ?",
  ).bind(INBOX_LIMIT).all<{ plan_id: string; service_id: string; plan_version: string; steps_json: string; created_by: string; created_at: string; approve_by: string | null }>();
  const critical = await db.prepare(
    "SELECT proposal_id, action, target, proposer_agent_id, approvals, rejections, eligible, created_at FROM consensus_proposals WHERE status = 'pending_owner' ORDER BY created_at LIMIT ?",
  ).bind(INBOX_LIMIT).all<{ proposal_id: string; action: string; target: string; proposer_agent_id: string; approvals: number; rejections: number; eligible: number; created_at: string }>();
  let knowledge: { proposal_id: string; item_id: string; item_version: number; kind: string; proposer_agent_id: string; item_json: string; created_at: string }[] = [];
  try {
    knowledge = (await db.prepare(
      "SELECT proposal_id, item_id, item_version, kind, proposer_agent_id, item_json, created_at FROM knowledge_proposals WHERE status = 'pending' ORDER BY created_at LIMIT ?",
    ).bind(INBOX_LIMIT).all<{ proposal_id: string; item_id: string; item_version: number; kind: string; proposer_agent_id: string; item_json: string; created_at: string }>()).results;
  } catch { knowledge = []; }
  return {
    recovery_plans: plans.results.map((p) => {
      const plan = parse(p.steps_json);
      const steps = Array.isArray(plan?.steps) ? (plan!.steps as unknown[]).filter((s): s is { action: string; description: string } =>
        Boolean(s) && typeof (s as { action?: unknown }).action === "string" && typeof (s as { description?: unknown }).description === "string") : [];
      return {
        plan_id: p.plan_id, service_id: p.service_id, plan_version: p.plan_version, created_by: p.created_by, created_at: p.created_at, approve_by: p.approve_by ?? null,
        title: typeof plan?.title === "string" ? plan.title : null, rationale: typeof plan?.rationale === "string" ? plan.rationale : null,
        steps: steps.map((s) => ({ action: s.action, description: s.description })),
        synthetic: typeof p.created_by === "string" && p.created_by.endsWith(".access"),
      };
    }),
    consensus: critical.results.map((c) => ({
      proposal_id: c.proposal_id, action: c.action, target: c.target, proposer_agent_id: c.proposer_agent_id, created_at: c.created_at,
      expires_at: plus(c.created_at, OWNER_DECISION_WINDOW_MS),
      approvals: Number(c.approvals ?? 0), rejections: Number(c.rejections ?? 0), eligible: Number(c.eligible ?? 0),
      executable: PHASE4_EXECUTABLE.has(c.action),
    })),
    knowledge: knowledge.map((k) => ({
      proposal_id: k.proposal_id, item_id: k.item_id, item_version: Number(k.item_version), kind: k.kind, proposer_agent_id: k.proposer_agent_id,
      created_at: k.created_at, expires_at: plus(k.created_at, KNOWLEDGE_REVIEW_WINDOW_MS), item: parse(k.item_json),
    })),
  };
}

/**
 * Open critical reports of the last 24 hours, newest first. A report an approver acknowledged (migration 0053) is not
 * open, as for the consensus baseline; before the table exists every one is open.
 */
export async function openCriticalReportRows(db: D1Database, now = Date.now(), limit = 200): Promise<OpenCriticalReport[]> {
  const acks = await acknowledgementsReadable(db);
  const rows = await db.prepare(
    `SELECT r.report_id, r.agent_id, r.kind, r.subject, r.created_at FROM agent_reports r
     ${acks ? "LEFT JOIN agent_report_acknowledgements a ON a.report_id = r.report_id" : ""}
     WHERE r.severity = 'critical' AND r.created_at >= ? AND r.created_at <= ?${acks ? " AND a.report_id IS NULL" : ""}
     ORDER BY r.created_at DESC LIMIT ?`,
  ).bind(iso(now - CRITICAL_WINDOW_MS), iso(now), limit).all<{ report_id: string; agent_id: string; kind: string; subject: string; created_at: string }>();
  return rows.results.map((r) => ({ report_id: r.report_id, agent_id: r.agent_id, kind: r.kind, severity: "critical", subject: r.subject, created_at: r.created_at }));
}

/** GET /v1/owner/inbox: the Owner page's two sections, from D1 only. Operators may read it; only approvers act. */
export async function ownerInbox(db: D1Database, now = Date.now()) {
  const approvals = await pendingApprovals(db);
  const critical = await openCriticalReportRows(db, now, INBOX_LIMIT);
  let mode: string | null = null;
  try { mode = (await db.prepare("SELECT value FROM consensus_controls WHERE control = 'mode'").first<{ value: string }>())?.value ?? null; } catch { mode = null; }
  const n = approvals.recovery_plans.length + approvals.consensus.length + approvals.knowledge.length;
  return {
    schema: "owner-inbox.v1" as const,
    observed_at: iso(now),
    /** A critical proposal can be approved only in mode critical (ADR-0009 phase 4); the panel shows the mode, never a default. */
    consensus_mode: mode,
    approvals,
    critical_reports: critical,
    counts: { approvals: n, critical_reports: critical.length },
  };
}
