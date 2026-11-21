// Owner decision 2026-11-13 ("Batasi User/Owner hanya untuk critical dan permintaan approval only"): every loop that
// needs a person surfaces in one Console panel, the Owner page (#/owner), and the owner is contacted only for those
// items. This module is the one reading of "what needs the owner": the owner notices (owner-notices.ts) and the
// Console's GET /v1/owner/inbox both use it, so an email or Telegram message and the panel always list the same items.
//
//   approvals         - recovery plans in draft (Recovery Manager; an approver approves or disables them),
//                       critical consensus proposals in pending_owner (ADR-0009 phase 4; approve or reject),
//                       pending learned-knowledge proposals that need the owner (TP-028; approve for shadow testing
//                       or reject). Text kinds run by themselves with an optional veto (#310) and are not listed:
//                       knowledgeNeedsOwner() in control-plane-shared/src/knowledge-kinds.ts is the one rule;
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
import { AUTONOMOUS_KNOWLEDGE_KINDS } from "../../control-plane-shared/src/knowledge-kinds.ts";
import { failedPlanResolution } from "../../control-plane-shared/src/recovery-resolution.ts";
import { LAST_TWO_OBSERVATIONS_SQL, isPersistentDrift, persistentDriftSince } from "../../control-plane-shared/src/drift-state.ts";
import { resolvedLaterSql } from "./syscall.ts";
import { stallDetail, stallState } from "../../control-plane-shared/src/deploy-stall.ts";
import { latestGitBackupVerify } from "../../control-plane-shared/src/git-backup.ts";
import { readIdentitySource } from "../../control-plane-shared/src/identity-source.ts";
import { OOB_DETECTED, openCodeUpload } from "../../control-plane-shared/src/provenance.ts";
import { RANKING, rankInbox } from "../../control-plane-shared/src/owner-inbox-rank.ts";
import { draftsAwaitingOwner } from "./proposals.ts";
import { autonomyNotices } from "./autonomy.ts";

/** At most this many items of each kind are listed (the owner notices have always used 50). */
export const INBOX_LIMIT = 50;
/** deploy_no_path: a refusal on every deploy path is listed this long (the stall alarm covers a longer stall). */
export const NO_PATH_WINDOW_MS = 24 * 3_600_000;
/** Open critical reports are read from this window, as for the consensus brake. */
export const CRITICAL_WINDOW_MS = 24 * 3_600_000;

/**
 * A service the Drift Detector has not observed for this long (45 min, three missed runs) is stale. "Observed" is the
 * heartbeat service_registry.updated_at, which every run sets; drift rows are recorded only on change (0061).
 */
export const STALE_MS = 45 * 60_000;
/**
 * A heartbeat or observation time may be this far after `now` and still count as current (2026-11-18): `now` is the
 * cron's scheduledTime, and a pass that ran for minutes read the Drift Detector's newer writes as "in the future", so
 * all 17 services were reported stale at 16:30 (a false alarm). One Drift Detector period (every 15 min); a time further ahead,
 * or unreadable, still fails closed.
 */
export const FUTURE_SKEW_MS = 15 * 60_000;
/** The Workers the Supervisor never plans for: itself (supervisor.ts skips SERVICE) and the observer of every drift. */
export const SELF_SERVICES: readonly string[] = ["cryptophys-ai-kernel", "cryptophys-drift-detector"];
/**
 * A persistent drift counts as unhandled only once it has lasted this long (persistentDriftSince() in
 * drift-state.ts: since the older of two drifted rows, or since the drifted row a later run confirmed): the
 * Supervisor (every 15 minutes) has then had at least one cycle to propose a plan, so a drift that just became
 * persistent does not email the owner and close again half an hour later.
 */
export const HANDLING_GRACE_MS = 30 * 60_000;
/** A deploy, redeploy or rollback proposal for the service that executes now or executed this recently handles it. */
export const DEPLOY_HANDLING_WINDOW_MS = 2 * 3_600_000;
/** A recovery plan that failed or expired this recently is reported. */
export const RECOVERY_FAILURE_WINDOW_MS = 24 * 3_600_000;
/** A succeeded break-glass deploy is listed this long (or until it is reported resolved). */
export const BREAK_GLASS_WINDOW_MS = 24 * 3_600_000;

export type ProblemCode = "out_of_band_deploy" | "self_unhealthy" | "observations_stale" | "drift_unhandled" | "recovery_failed" | "critical_advisory" | "build_minutes_exhausted" | "break_glass_deployed" | "deploys_stalled" | "git_backup_unverified" | "executor_deploy_failed" | "identity_source_invalid" | "deploy_no_path";
/** out_of_band_deploy: a code upload outside the platform is looked for this far back (it stays listed while it is the Worker's newest provenance event). */
export const OUT_OF_BAND_WINDOW_MS = 30 * 24 * 3_600_000;
/** The Orchestrator's own failed native deploy of its unit is listed this long, unless a later deploy of it succeeded. */
export const EXECUTOR_FAILURE_WINDOW_MS = 24 * 3_600_000;
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
    "SELECT proposal_id, action, target, proposer_agent_id, approvals, rejections, eligible, params_json, created_at FROM consensus_proposals WHERE status = 'pending_owner' ORDER BY created_at LIMIT ?",
  ).bind(INBOX_LIMIT).all<{ proposal_id: string; action: string; target: string; proposer_agent_id: string; approvals: number; rejections: number; eligible: number; params_json: string | null; created_at: string }>();
  let knowledge: { proposal_id: string; item_id: string; item_version: number; kind: string; proposer_agent_id: string; item_json: string; created_at: string }[] = [];
  try {
    knowledge = (await db.prepare(
      `SELECT proposal_id, item_id, item_version, kind, proposer_agent_id, item_json, created_at FROM knowledge_proposals
       WHERE status = 'pending' AND kind NOT IN (${AUTONOMOUS_KNOWLEDGE_KINDS.map(() => "?").join(", ")}) ORDER BY created_at LIMIT ?`,
    ).bind(...AUTONOMOUS_KNOWLEDGE_KINDS, INBOX_LIMIT).all<{ proposal_id: string; item_id: string; item_version: number; kind: string; proposer_agent_id: string; item_json: string; created_at: string }>()).results;
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
      // Gate 9: a change_access proposal lists what it changes, so the owner approves exactly that plan.
      changes: changesOf(c.params_json),
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

/**
 * HAIC H1.5c (docs/design/HAIC-H0-H1.md §2.2, §4.4): the councils that wait for the owner's pick, soonest deadline first.
 * A council's window is 72 h (expired afterwards, no default option); `since` is when it began to wait. Before the
 * councils table exists (migration 0079) there are none.
 */
export async function councilsAwaitingOwner(db: D1Database, now = Date.now()): Promise<{ session_id: string; topic: string; since: string | null; deadline: string }[]> {
  try {
    const rows = await db.prepare("SELECT session_id, topic, updated_at, deadline FROM councils WHERE state = 'awaiting_owner' AND deadline > ? ORDER BY deadline LIMIT ?")
      .bind(iso(now), INBOX_LIMIT).all<{ session_id: string; topic: string; updated_at: string | null; deadline: string }>();
    return rows.results.map((r) => ({ session_id: r.session_id, topic: r.topic, since: r.updated_at ?? null, deadline: r.deadline }));
  } catch (err) {
    if (/no such table/i.test(String((err as Error)?.message ?? err))) return [];
    throw err;
  }
}

/**
 * HAIC H1.5d (Q9): the councils agents proposed that wait for the owner to begin them, soonest deadline first (a
 * proposal is dismissed as expired after 7 days). Before migration 0080 there are none.
 */
export async function councilProposals(db: D1Database, now = Date.now()): Promise<{ session_id: string; topic: string; proposed_by: string; trigger_kind: string; refs: string[]; since: string; deadline: string }[]> {
  try {
    const rows = await db.prepare("SELECT session_id, topic, created_by, trigger_kind, evidence_refs_json, created_at, deadline FROM councils WHERE state = 'proposed' AND deadline > ? ORDER BY deadline LIMIT ?")
      .bind(iso(now), INBOX_LIMIT).all<{ session_id: string; topic: string; created_by: string; trigger_kind: string; evidence_refs_json: string | null; created_at: string; deadline: string }>();
    return rows.results.map((r) => {
      let refs: string[] = [];
      try { const a = JSON.parse(r.evidence_refs_json ?? "[]"); refs = Array.isArray(a) ? a.filter((x): x is string => typeof x === "string").slice(0, 10) : []; } catch { refs = []; }
      return { session_id: r.session_id, topic: r.topic, proposed_by: r.created_by, trigger_kind: r.trigger_kind, refs, since: r.created_at, deadline: r.deadline };
    });
  } catch (err) {
    if (/no such (table|column)/i.test(String((err as Error)?.message ?? err))) return [];
    throw err;
  }
}

/** GET /v1/owner/inbox: the Owner page's sections and their ranked items (HAIC H0b), from D1 only. Operators may read it; only approvers act. */
export async function ownerInbox(db: D1Database, now = Date.now()) {
  const approvals = await pendingApprovals(db);
  const critical = await openCriticalReportRows(db, now, INBOX_LIMIT);
  const problems = await unhandledProblems(db, now);
  const councils = await councilsAwaitingOwner(db, now);
  const proposals = await councilProposals(db, now);
  const drafts = await draftsAwaitingOwner(db, now);
  const autonomy = await autonomyNotices(db, now);
  let mode: string | null = null;
  try { mode = (await db.prepare("SELECT value FROM consensus_controls WHERE control = 'mode'").first<{ value: string }>())?.value ?? null; } catch { mode = null; }
  const n = approvals.recovery_plans.length + approvals.consensus.length + approvals.knowledge.length;
  return {
    schema: "owner-inbox.v1" as const,
    observed_at: iso(now),
    /** A critical proposal can be approved only in mode deploy or critical (OWNER_CLICK_MODES); the panel shows the mode, never a default. */
    consensus_mode: mode,
    approvals,
    critical_reports: critical,
    production_problems: problems,
    // HAIC H1.5c: additive, like items[]; the three sections above are unchanged.
    councils,
    // HAIC H1.5d: councils agents proposed, for the owner to begin or dismiss.
    council_proposals: proposals,
    // HAIC H2: typed proposal drafts that wait for the owner's confirmation.
    typed_proposals: drafts,
    // HAIC H4: a group of actions a regression lowered, or one whose evidence is ready to be raised.
    autonomy,
    counts: { approvals: n, critical_reports: critical.length, production_problems: problems.length, councils: councils.length, council_proposals: proposals.length, typed_proposals: drafts.length, autonomy: autonomy.length },
    // HAIC H0b (docs/design/HAIC-H0-H1.md §2.4): the same items, ranked, additively; the sections above are unchanged.
    items: rankInbox({ approvals, critical_reports: critical, production_problems: problems, councils, council_proposals: proposals, typed_proposals: drafts, autonomy }, now),
    ranking: RANKING,
  };
}

/** The bounded `changes` list a proposal's params carry (change_access), or an empty list. */
function changesOf(paramsJson: unknown): string[] {
  const p = parse(paramsJson);
  return Array.isArray(p?.changes) ? (p!.changes as unknown[]).filter((c): c is string => typeof c === "string").slice(0, 12).map((c) => c.slice(0, 120)) : [];
}

function reasonsOf(evidenceJson: unknown): string[] {
  const ev = parse(evidenceJson);
  return Array.isArray(ev?.reasons) ? (ev!.reasons as unknown[]).filter((r): r is string => typeof r === "string") : [];
}

/**
 * Production problems no agent is handling. Each condition is one line item, and each closes a case where a broken
 * production reached the owner through neither an approval nor a critical report (ADR-0009 amendment 2026-11-13):
 *
 *  1. self_unhealthy: the AI Kernel or the Drift Detector itself is persistently drifted or unhealthy (two runs in a
 *     row drifted, isPersistentDrift() as in syscall.ts observe()); the Supervisor never plans for its own Worker.
 *  2. observations_stale: a registered service has no observation for STALE_MS (registered at least that long ago),
 *     or the Drift Detector's heartbeat for it (service_registry.updated_at) is older, unreadable or in the future,
 *     or its latest row's time is unreadable or in the future: the Drift Detector stopped.
 *  3. drift_unhandled: a service is persistently drifted or unhealthy (the Supervisor's own exclusions apply: an
 *     untagged healthy version, an unset desired version alone), past HANDLING_GRACE_MS, and agents are switched off,
 *     or no recovery plan for it is draft, approved or executing and no deploy, redeploy or rollback proposal for it
 *     is executing or executed within DEPLOY_HANDLING_WINDOW_MS. A draft plan is not a problem: it is an approval.
 *  4. recovery_failed: a recovery plan failed, or its approval window expired or lapsed, in the last 24 hours
 *     (deploy-verification plans authored by a service token are not recovery), unless it is resolved since
 *     (recovery-resolution.ts: a later deploy of its unit succeeded, or its Worker is healthy and in sync again).
 *  5. critical_advisory: an npm advisory of severity critical in a runtime lockfile (high stays console-only).
 *  6. build_minutes_exhausted: the month's measured Workers Builds minutes are at or over the budget (80% stays
 *     console-only).
 *  7. break_glass_deployed (hardening (d), owner 2026-11-14 "Ya, begitu"): a break-glass deploy (force_redeploy_unit)
 *     succeeded in the last 24 hours. The Orchestrator's report of it is a warning, so it does not hold the consensus
 *     brake; the owner still hears of it here. One item per request (subject: the report's alert_key
 *     break_glass:<request_id>); it closes after 24 hours or when the Orchestrator reports it resolved. A failed one
 *     is a critical report instead (critical_reports).
 *  8. deploys_stalled (owner 2026-11-14): main's head passed the Forge checks, a deploy unit does not run it, the plan
 *     lists a unit or a skip, and no deploy_commit has executed for more than 2 hours, or that episode's alarm is still
 *     open (control-plane-shared/src/deploy-stall.ts). The subject is the episode (deploy_stall:<last executed
 *     deploy_commit>), so the owner gets one message when it opens and one when a deploy ends it, not one per run or
 *     per new main commit. The Observer's report of it is a warning: a critical one would hold the brake.
 *  9. git_backup_unverified (gate 8, owner 2026-11-15): the newest daily verify of a stored git bundle
 *     (forge/src/bundle-verify.ts, migration 0072) failed: the off-Artifacts copy of the repository is unusable or
 *     is not the one recorded. One item per bundle (subject: its run id); it closes when a later verify succeeds.
 *     A backup that is only stale stays on the Console (owner 2026-11-13); this is not a stale backup.
 * 10. executor_deploy_failed (cut-over gate, owner 2026-11-15 "1 setuju"): the newest deploy of the Deployment
 *     Orchestrator's own unit that the Orchestrator executed (native:deploy or native:break-glass) failed in the last
 *     24 hours and no later deploy of it succeeded. Its fix cannot go through it: the item points to the rescue path,
 *     a break-glass plan for cryptophys-deployment-orchestrator, which the Recovery Manager runs without the
 *     Orchestrator (control-plane-shared/src/executor-rescue.ts). A desired version recorded for the Orchestrator since
 *     closes it. The subject is the failed request, so one message.
 *  A succeeded rescue deploy is a break_glass_deployed item too (its warning report comes from the Recovery Manager).
 * 11. identity_source_invalid (owner 2026-11-16, migration 0073): the row of D1 `platform_identities`, the owner's
 *     operator and approver emails, is not one the Console's save would write (control-plane-shared/src/identity-source.ts:
 *     an email that is not valid, duplicates, the two lists differ, an unknown source). The native deploy then deploys
 *     nothing from it and carries every Worker's active identity lists, so an owner's edit would silently not apply;
 *     this item says so. One item (subject: the table); it closes when an owner saves a valid list. No row and the seed
 *     are not problems: the deploys carry the deployed lists, as before.
 * 12. deploy_no_path (owner 2026-11-19, after the deploy of ddfa6d3 was refused at 00:22 on both paths): a consensus
 *     deploy of a unit was refused by the native deploy and by the GitHub path (audit deployment.no_path) in the last
 *     NO_PATH_WINDOW_MS, and none of its Workers has had a desired version recorded since. The Supervisor's retries fail
 *     the same way, and the stall alarm waits 2 hours, so the owner hears of it at once, with both reasons and the way
 *     out (docs/OPERATIONS.md "Deploy with no path"). One item per unit and commit (subject no_path:<unit>:<sha12>).
 */
export async function unhandledProblems(db: D1Database, now = Date.now()): Promise<ProductionProblem[]> {
  const self: ProductionProblem[] = [], stale: ProductionProblem[] = [], drift: ProductionProblem[] = [];
  const services = (await db.prepare("SELECT service_id, created_at, updated_at FROM service_registry WHERE status != 'disabled' ORDER BY service_id")
    .all<{ service_id: string; created_at: string | null; updated_at: string | null }>()).results;
  let agentsOn = true;
  try { agentsOn = await agentsEnabled(db); } catch { agentsOn = false; }
  for (const s of services) {
    const obs = (await db.prepare(LAST_TWO_OBSERVATIONS_SQL)
      .bind(s.service_id).all<{ drifted: number; streak: number; evidence_json: string; observed_at: string }>()).results;
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
    const seenAt = Date.parse(String(s.updated_at ?? ""));
    const ahead = now + FUTURE_SKEW_MS;
    if (!Number.isFinite(latestAt) || latestAt > ahead || !Number.isFinite(seenAt) || seenAt > ahead || now - seenAt > STALE_MS) {
      const seen = Number.isFinite(latestAt) && latestAt <= ahead ? s.updated_at : obs[0].observed_at;
      stale.push({ code: "observations_stale", subject: s.service_id, detail: `${name}: not observed since ${seen}; the Drift Detector may have stopped`, since: seen, link: "#/infrastructure" });
      continue;
    }
    if (!isPersistentDrift(obs)) continue;
    // The Supervisor's exclusions (supervisor.ts): a healthy service whose only finding is a missing version tag, or
    // a service with no desired version and nothing else wrong, is not a recovery case.
    if (onlyUntaggedVersion({ reasons }) || (reasons.length === 1 && reasons[0] === "desired_version_unset")) continue;
    const since = persistentDriftSince(obs)!;
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

  // Orchestrator finding A (owner 2026-11-19): a failed plan whose Worker is healthy and in sync again, or whose unit a
  // later deploy fixed, needs no one; it is dropped instead of lingering for the whole 24 hours.
  const failedPlans = (await db.prepare(
    `SELECT plan_id, service_id, status, disabled_reason, updated_at FROM recovery_plans
     WHERE (status = 'failed' OR (status = 'disabled' AND disabled_reason IN ('approval_expired', 'approval_lapsed')))
       AND updated_at >= ? AND (created_by IS NULL OR created_by NOT LIKE '%.access')
     ORDER BY updated_at DESC LIMIT ?`,
  ).bind(iso(now - RECOVERY_FAILURE_WINDOW_MS), INBOX_LIMIT).all<{ plan_id: string; service_id: string; status: string; disabled_reason: string | null; updated_at: string }>()).results;
  const unresolved: typeof failedPlans = [];
  for (const p of failedPlans) if (!(await failedPlanResolution(db, p))) unresolved.push(p);
  const recovery: ProductionProblem[] = unresolved
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

  let breakGlass: ProductionProblem[] = [];
  try {
    breakGlass = ((await db.prepare(
      `SELECT r.subject, r.created_at, json_extract(r.body_json, '$.alert_key') AS alert_key, json_extract(r.body_json, '$.plan_id') AS plan_id FROM agent_reports r
       WHERE r.agent_id IN ('deployment-orchestrator', 'recovery-manager') AND r.severity = 'warning' AND json_extract(r.body_json, '$.break_glass') = 1
         AND json_extract(r.body_json, '$.alert_key') IS NOT NULL AND r.created_at >= ? AND r.created_at <= ? AND NOT ${resolvedLaterSql("r")}
       ORDER BY r.created_at DESC LIMIT ?`,
    ).bind(iso(now - BREAK_GLASS_WINDOW_MS), iso(now), INBOX_LIMIT).all<{ subject: string; created_at: string; alert_key: string; plan_id: string | null }>()).results ?? [])
      .filter((r, i, all) => all.findIndex((x) => x.alert_key === r.alert_key) === i)
      .map((r) => ({
        code: "break_glass_deployed" as const, subject: String(r.alert_key),
        detail: `${r.subject.slice(0, 160)} at ${r.created_at}: the deploy planner was bypassed for this unit; this item closes by itself after 24 hours`,
        since: r.created_at, link: typeof r.plan_id === "string" && /^plan_[0-9a-f-]{36}$/.test(r.plan_id) ? `#/recovery/${r.plan_id}` : "#/pipelines",
      }));
  } catch { breakGlass = []; }

  let stalls: ProductionProblem[] = [];
  try {
    const st = await stallState(db, now);
    const subject = st.verdict.alert_key ?? st.open[0]?.alert_key;
    if (st.active && subject) stalls = [{ code: "deploys_stalled", subject, detail: stallDetail(st.verdict), since: st.verdict.stall_since ?? st.open[0]?.created_at ?? null, link: "#/pipelines" }];
  } catch { stalls = []; }

  let backups: ProductionProblem[] = [];
  try {
    const v = await latestGitBackupVerify(db);
    if (v && v.verify_status === "failed") {
      const reason = typeof v.details?.reason === "string" ? v.details.reason : "unknown";
      backups = [{
        code: "git_backup_unverified", subject: v.run_id,
        detail: `Git backup ${v.r2_key ?? v.run_id} (main ${v.main_sha.slice(0, 12)}) failed git bundle verify at ${v.verified_at}: ${reason}; the off-Artifacts copy of the repository may be unusable`.slice(0, 600),
        since: v.verified_at, link: "#/code",
      }];
    }
  } catch { backups = []; }

  let executor: ProductionProblem[] = [];
  try {
    const last = await db.prepare(
      `SELECT request_id, status, requested_version, created_at, json_extract(details_json, '$.executor') AS executor, json_extract(details_json, '$.outcome.reason') AS reason
         FROM deployment_requests WHERE service_id = 'cryptophys-deployment-orchestrator' AND status IN ('succeeded', 'failed')
          AND (json_extract(details_json, '$.executor') IN ('native:deploy', 'native:break-glass', 'rescue:deployment-orchestrator'))
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).first<{ request_id: string; status: string; requested_version: string; created_at: string; executor: string; reason: string | null }>();
    const at = last ? Date.parse(last.created_at) : Number.NaN;
    // A desired version recorded for it since (a deploy workflow the owner ran, for example) closes the item as well.
    const since = last ? await db.prepare(
      "SELECT 1 AS x FROM audit_events WHERE subject = 'cryptophys-deployment-orchestrator' AND event_type = 'registry.desired_version_set' AND created_at > ? LIMIT 1",
    ).bind(last.created_at).first() : null;
    if (last && !since && last.status === "failed" && last.executor !== "rescue:deployment-orchestrator" && Number.isFinite(at) && at <= now && now - at <= EXECUTOR_FAILURE_WINDOW_MS) {
      executor = [{
        code: "executor_deploy_failed", subject: last.request_id,
        detail: `The Deployment Orchestrator's own deploy of ${String(last.requested_version).slice(0, 12)} failed (${String(last.reason ?? "unknown").slice(0, 120)}); a fix to it cannot go through it. Write a break-glass plan for cryptophys-deployment-orchestrator: the Recovery Manager deploys it without the Orchestrator (OPERATIONS, rescue deploy)`,
        since: last.created_at, link: "#/recovery",
      }];
    }
  } catch { executor = []; }

  let noPath: ProductionProblem[] = [];
  try {
    const rows = (await db.prepare(
      `SELECT subject, created_at, payload_json FROM audit_events WHERE event_type = 'deployment.no_path' AND created_at >= ? AND created_at <= ?
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).bind(iso(now - NO_PATH_WINDOW_MS), iso(now), INBOX_LIMIT).all<{ subject: string; created_at: string; payload_json: string | null }>()).results ?? [];
    const seen = new Set<string>();
    for (const r of rows) {
      let p: { unit?: unknown; commit_sha?: unknown; github_gate?: unknown; native_deploy?: { reason?: unknown; service?: unknown } | null } = {};
      try { p = JSON.parse(r.payload_json ?? "{}") ?? {}; } catch { continue; }
      const unit = typeof p.unit === "string" ? p.unit.slice(0, 60) : "";
      const sha = typeof p.commit_sha === "string" && /^[0-9a-f]{40}$/.test(p.commit_sha) ? p.commit_sha : "";
      if (!unit || !sha) continue;
      const key = `no_path:${unit}:${sha.slice(0, 12)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const later = await db.prepare(
        "SELECT 1 AS x FROM audit_events WHERE subject = ? AND event_type = 'registry.desired_version_set' AND created_at > ? LIMIT 1",
      ).bind(r.subject, r.created_at).first();
      if (later) continue;
      const native = typeof p.native_deploy?.reason === "string" ? p.native_deploy.reason.slice(0, 80) + (typeof p.native_deploy.service === "string" ? ` on ${serviceName(p.native_deploy.service)}` : "") : "not recorded";
      const github = typeof p.github_gate === "string" ? p.github_gate.slice(0, 80) : "not recorded";
      noPath.push({
        code: "deploy_no_path", subject: key,
        detail: `The deploy of ${unit} at ${sha.slice(0, 12)} has no path: the native deploy refused it (${native}) and so did the GitHub path (${github}); the Supervisor's retries fail the same way. Unblock it once with a break-glass plan (Recovery, one step force_redeploy_unit at main's full head) or by bringing GitHub main up to main, then fix the cause (OPERATIONS.md "Deploy with no path")`.slice(0, 600),
        since: r.created_at, link: "#/recovery",
      });
    }
  } catch { noPath = []; }

  // 13. out_of_band_deploy (owner 2026-11-21, control-plane-shared/src/provenance.ts): a platform Worker runs code the
  //     platform did not deploy (the Orchestrator's, or for the Orchestrator the Recovery Manager's, provenance check
  //     found a code upload without the tag of a platform deploy, and no later check found a platform version). Listed
  //     at once, with no grace period and whatever plan is open: the owner hears that a Worker was replaced. One item
  //     per Worker; it closes when the Worker runs a platform version again (deployment.out_of_band_cleared).
  let outOfBand: ProductionProblem[] = [];
  try {
    const rows = (await db.prepare(
      `SELECT subject, outcome, created_at, payload_json FROM audit_events WHERE event_type = ? AND created_at >= ? AND created_at <= ?
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).bind(OOB_DETECTED, iso(now - OUT_OF_BAND_WINDOW_MS), iso(now), INBOX_LIMIT).all<{ subject: string; outcome: string; created_at: string; payload_json: string | null }>()).results ?? [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.subject)) continue;
      seen.add(r.subject);
      const open = await openCodeUpload(db, r.subject);
      if (!open) continue;
      outOfBand.push({
        code: "out_of_band_deploy", subject: r.subject,
        detail: `${serviceName(r.subject)} runs code that the platform did not deploy: version ${open.version_id.slice(0, 8)} became active at ${open.deployed_at ?? "an unknown time"}${open.source ? ` by ${open.source}` : ""}, outside the consensus deploy. If it was not you, treat the account's credentials as exposed. Restore the Worker with a deploy of main (a break-glass plan for the AI Kernel or the Orchestrator), or bring the change to main`.slice(0, 600),
        since: open.deployed_at ?? open.detected_at, link: "#/infrastructure",
      });
    }
  } catch { outOfBand = []; }

  let identities: ProductionProblem[] = [];
  const src = await readIdentitySource(db);
  if (src.status === "invalid") {
    identities = [{
      code: "identity_source_invalid", subject: "platform_identities",
      detail: `The operator and approver email list (revision ${src.revision ?? "unknown"}) is not valid (${src.reason}); the deploys keep each Worker's current identity lists and apply nothing from it. Save a valid list on the Users page`,
      since: src.updated_at, link: "#/users",
    }];
  }

  return [...outOfBand, ...self, ...stale, ...drift, ...recovery, ...advisories, ...builds, ...breakGlass, ...stalls, ...noPath, ...backups, ...executor, ...identities];
}
