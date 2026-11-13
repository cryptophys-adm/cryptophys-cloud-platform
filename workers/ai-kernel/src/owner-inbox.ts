// Owner decision 2026-11-13 ("Batasi User/Owner hanya untuk critical dan permintaan approval only"): every loop that
// needs a person surfaces in one Console panel, the Owner page (#/owner), and the owner is contacted only for those
// items. This module is the one reading of "what needs the owner": the owner notices (owner-notices.ts) and the
// Console's GET /v1/owner/inbox both use it, so an email or Telegram message and the panel always list the same items.
//
//   approvals         - recovery plans in draft (Recovery Manager; an approver approves or disables them),
//                       critical consensus proposals in pending_owner (ADR-0009 phase 4; approve or reject),
//                       pending learned-knowledge proposals (TP-028; approve for shadow testing or reject);
//   critical_reports  - open critical agent reports of the last 24 hours (not acknowledged; ADR-0009 amendment
//                       2026-11-13). Each one blocks routine consensus until an approver acknowledges it;
//   production_problems - production problems no agent is handling (coordinator 2026-11-13, closing the gaps the
//                       owner-channel review found): see unhandledProblems() below.
//
// Read-only: no expiry sweep, no write. Before migration 0029 (knowledge) or 0053 (acknowledgements) the missing
// table reads as no knowledge proposal and as nothing acknowledged (every critical report open: fail closed).
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { acknowledgementsReadable } from "./reports.ts";
import { OWNER_DECISION_WINDOW_MS, PHASE4_EXECUTABLE } from "./consensus.ts";
import { KNOWLEDGE_REVIEW_WINDOW_MS } from "./knowledge.ts";
import { onlyUntaggedVersion } from "./supervisor.ts";
import { agentsEnabled } from "../../control-plane-shared/src/capabilities.ts";
import { DEPLOYISH } from "../../control-plane-shared/src/consensus-rules.ts";
import { buildUsage } from "../../control-plane-shared/src/build-usage.ts";
import { dependencyAudit } from "../../control-plane-shared/src/dependency-audit.ts";
import { serviceName } from "../../control-plane-shared/src/plain.ts";

/** At most this many items of each kind are listed (the owner notices have always used 50). */
export const INBOX_LIMIT = 50;
/** Open critical reports are read from this window, as for the consensus brake. */
export const CRITICAL_WINDOW_MS = 24 * 3_600_000;

/** Observations older than this (45 min, three missed Drift Detector runs) count as stale. */
export const STALE_MS = 45 * 60_000;
/** The Workers the Supervisor never plans for: itself (supervisor.ts skips SERVICE) and the observer of every drift. */
export const SELF_SERVICES: readonly string[] = ["cryptophys-ai-kernel", "cryptophys-drift-detector"];
/**
 * A persistent drift counts as unhandled only once the older of its two drifted observations is this old: the
 * Supervisor (every 15 minutes) has then had at least one cycle to propose a plan, so a drift that just became
 * persistent does not email the owner and close again half an hour later.
 */
export const HANDLING_GRACE_MS = 30 * 60_000;
/** A deploy, redeploy or rollback proposal for the service that executes now or executed this recently handles it. */
export const DEPLOY_HANDLING_WINDOW_MS = 2 * 3_600_000;
/** A recovery plan that failed or expired this recently is reported. */
export const RECOVERY_FAILURE_WINDOW_MS = 24 * 3_600_000;

export type ProblemCode = "self_unhealthy" | "observations_stale" | "drift_unhandled" | "recovery_failed" | "critical_advisory" | "build_minutes_exhausted";
export interface ProductionProblem {
  code: ProblemCode;
  /** What the problem is about: a service id, a plan id, an advisory id or a month. */
  subject: string;
  detail: string;
  since: string | null;
  /** The Console page with the evidence (a hash route). */
  link: string;
}

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
  const problems = await unhandledProblems(db, now);
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
    production_problems: problems,
    counts: { approvals: n, critical_reports: critical.length, production_problems: problems.length },
  };
}

function reasonsOf(evidenceJson: unknown): string[] {
  const ev = parse(evidenceJson);
  return Array.isArray(ev?.reasons) ? (ev!.reasons as unknown[]).filter((r): r is string => typeof r === "string") : [];
}

/**
 * Production problems no agent is handling. Each condition is one line item, and each closes a case where a broken
 * production reached the owner through neither an approval nor a critical report (ADR-0009 amendment 2026-11-13):
 *
 *  1. self_unhealthy: the AI Kernel or the Drift Detector itself is persistently drifted or unhealthy (the last two
 *     observations drifted, as in syscall.ts observe()); the Supervisor never plans for its own Worker.
 *  2. observations_stale: a registered service has no observation for STALE_MS (registered at least that long ago),
 *     or its latest one is older, unreadable or in the future: the Drift Detector stopped.
 *  3. drift_unhandled: a service is persistently drifted or unhealthy (the Supervisor's own exclusions apply: an
 *     untagged healthy version, an unset desired version alone), past HANDLING_GRACE_MS, and agents are switched off,
 *     or no recovery plan for it is draft, approved or executing and no deploy, redeploy or rollback proposal for it
 *     is executing or executed within DEPLOY_HANDLING_WINDOW_MS. A draft plan is not a problem: it is an approval.
 *  4. recovery_failed: a recovery plan failed, or its approval window expired or lapsed, in the last 24 hours
 *     (deploy-verification plans authored by a service token are not recovery).
 *  5. critical_advisory: an npm advisory of severity critical in a runtime lockfile (high stays console-only).
 *  6. build_minutes_exhausted: the month's measured Workers Builds minutes are at or over the budget (80% stays
 *     console-only).
 */
export async function unhandledProblems(db: D1Database, now = Date.now()): Promise<ProductionProblem[]> {
  const self: ProductionProblem[] = [], stale: ProductionProblem[] = [], drift: ProductionProblem[] = [];
  const services = (await db.prepare("SELECT service_id, created_at FROM service_registry WHERE status != 'disabled' ORDER BY service_id")
    .all<{ service_id: string; created_at: string | null }>()).results;
  let agentsOn = true;
  try { agentsOn = await agentsEnabled(db); } catch { agentsOn = false; }
  for (const s of services) {
    const obs = (await db.prepare("SELECT drifted, evidence_json, observed_at FROM drift_observations WHERE service_id = ? ORDER BY observed_at DESC, rowid DESC LIMIT 2")
      .bind(s.service_id).all<{ drifted: number; evidence_json: string; observed_at: string }>()).results;
    const name = serviceName(s.service_id);
    if (!obs.length) {
      const registered = Date.parse(String(s.created_at ?? ""));
      if (!Number.isFinite(registered) || now - registered > STALE_MS) {
        stale.push({ code: "observations_stale", subject: s.service_id, detail: `${name}: never observed by the Drift Detector`, since: s.created_at ?? null, link: "#/infrastructure" });
      }
      continue;
    }
    const reasons = reasonsOf(obs[0].evidence_json);
    if (reasons.includes("disabled")) continue;
    const latestAt = Date.parse(obs[0].observed_at);
    if (!Number.isFinite(latestAt) || latestAt > now || now - latestAt > STALE_MS) {
      stale.push({ code: "observations_stale", subject: s.service_id, detail: `${name}: not observed since ${obs[0].observed_at}; the Drift Detector may have stopped`, since: obs[0].observed_at, link: "#/infrastructure" });
      continue;
    }
    const persistent = obs.length === 2 && obs.every((o) => o.drifted === 1);
    if (!persistent) continue;
    // The Supervisor's exclusions (supervisor.ts): a healthy service whose only finding is a missing version tag, or
    // a service with no desired version and nothing else wrong, is not a recovery case.
    if (onlyUntaggedVersion({ reasons }) || (reasons.length === 1 && reasons[0] === "desired_version_unset")) continue;
    const since = obs[1].observed_at;
    const why = reasons.join(", ") || "drifted";
    if (SELF_SERVICES.includes(s.service_id)) {
      self.push({ code: "self_unhealthy", subject: s.service_id, detail: `${name} is drifted or unhealthy (${why}); the agents do not recover their own Worker`, since, link: "#/infrastructure" });
      continue;
    }
    const sinceAt = Date.parse(since);
    if (Number.isFinite(sinceAt) && now - sinceAt < HANDLING_GRACE_MS) continue;
    if (!agentsOn) {
      drift.push({ code: "drift_unhandled", subject: s.service_id, detail: `${name} is drifted or unhealthy (${why}) and the agents are switched off`, since, link: "#/" });
      continue;
    }
    const plan = await db.prepare("SELECT 1 AS x FROM recovery_plans WHERE service_id = ? AND status IN ('draft','approved','executing') LIMIT 1").bind(s.service_id).first();
    if (plan) continue;
    const deploy = await db.prepare(
      `SELECT 1 AS x FROM consensus_proposals WHERE target = ? AND action IN (${[...DEPLOYISH].map(() => "?").join(",")})
       AND (status = 'executing' OR (status = 'executed' AND COALESCE(decided_at, created_at) >= ?)) LIMIT 1`,
    ).bind(s.service_id, ...DEPLOYISH, iso(now - DEPLOY_HANDLING_WINDOW_MS)).first();
    if (deploy) continue;
    drift.push({ code: "drift_unhandled", subject: s.service_id, detail: `${name} is drifted or unhealthy (${why}) and no recovery plan or deploy is under way`, since, link: "#/infrastructure" });
  }

  const recovery: ProductionProblem[] = (await db.prepare(
    `SELECT plan_id, service_id, status, disabled_reason, updated_at FROM recovery_plans
     WHERE (status = 'failed' OR (status = 'disabled' AND disabled_reason IN ('approval_expired', 'approval_lapsed')))
       AND updated_at >= ? AND (created_by IS NULL OR created_by NOT LIKE '%.access')
     ORDER BY updated_at DESC LIMIT ?`,
  ).bind(iso(now - RECOVERY_FAILURE_WINDOW_MS), INBOX_LIMIT).all<{ plan_id: string; service_id: string; status: string; disabled_reason: string | null; updated_at: string }>()).results
    .map((p) => ({
      code: "recovery_failed" as const, subject: p.plan_id,
      detail: `Recovery plan for ${serviceName(p.service_id)} ${p.status === "failed" ? "failed" : p.disabled_reason === "approval_lapsed" ? "was approved but never started (lapsed)" : "expired without an approval"} at ${p.updated_at}`,
      since: p.updated_at, link: `#/recovery/${p.plan_id}`,
    }));

  const audit = await dependencyAudit(db, now);
  const advisories: ProductionProblem[] = [];
  for (const f of (audit?.findings ?? []).filter((x) => x.runtime && x.severity === "critical")) {
    if (advisories.some((a) => a.subject === f.advisory_id)) continue;
    advisories.push({ code: "critical_advisory", subject: f.advisory_id, detail: `${f.package}@${f.version}: critical, ${f.title ?? f.advisory_id} in ${f.lockfiles.join(", ")}`, since: audit?.last_ok_run?.ran_at ?? null, link: "#/code" });
  }

  const u = await buildUsage(db, now);
  const builds: ProductionProblem[] = u && u.minutes >= u.budget_minutes ? [{
    code: "build_minutes_exhausted", subject: u.month,
    detail: `Workers Builds minutes: ${u.minutes} of ${u.budget_minutes} used in ${u.month}; the type-check and the Forge's ready verdict, and so the deploys, depend on these builds`,
    since: null, link: "#/code",
  }] : [];

  return [...self, ...stale, ...drift, ...recovery, ...advisories, ...builds];
}
