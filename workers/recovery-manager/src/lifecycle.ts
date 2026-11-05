/**
 * Recovery plan lifecycle, run as a Cloudflare Workflow instance per plan (ADR-0006).
 *
 * D1 stays the source of truth: the HTTP handlers authorize every transition (approver
 * identity, separation of duties, Policy Engine allow) and enforce the stored deadlines. The
 * Workflow adds what a request/response Worker cannot: it wakes up when a window closes and
 * moves a stale plan out of an actionable state, with an audit event, even if nobody calls the
 * API again. Events from the handlers only wake it early; each stage re-reads D1 and never
 * trusts an event payload.
 *
 *   draft     --(approve_by passes)--> disabled / approval_expired
 *   approved  --(execute_by passes)--> disabled / approval_lapsed
 *   executing --(finish_by passes)---> stays executing; recovery.execution_overdue is audited
 *
 * An executing plan is never changed automatically: someone may be mid-recovery, so the
 * Workflow raises it instead of guessing an outcome.
 */
import type { BaseEnv, WorkflowBindingLike, WorkflowStepLike } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { publishAgentReport, type AgentRpcBinding } from "../../control-plane-shared/src/agents.ts";
import { nowIso } from "../../control-plane-shared/src/http.ts";

export interface LifecycleParams { plan_id: string }

export interface LifecycleEnv extends BaseEnv {
  /** AI Kernel agent binding (advisory reports). */
  AGENTS?: AgentRpcBinding;
  /** Workflow binding for RecoveryPlanWorkflow (wrangler [[workflows]]). */
  RECOVERY_LIFECYCLE?: WorkflowBindingLike<LifecycleParams>;
  RECOVERY_APPROVAL_WINDOW_HOURS?: string;
  RECOVERY_EXECUTION_WINDOW_HOURS?: string;
  RECOVERY_FINISH_WINDOW_HOURS?: string;
}

/** Event types the HTTP handlers send to a plan's instance. */
export const EVENTS = { approved: "plan-approved", started: "execution-started", finished: "execution-finished" } as const;

const DEFAULT_HOURS = { approval: 72, execution: 24, finish: 24 };

function hours(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 && n <= 720 ? n : fallback;
}

export function windows(env: LifecycleEnv): { approval: number; execution: number; finish: number } {
  return {
    approval: hours(env.RECOVERY_APPROVAL_WINDOW_HOURS, DEFAULT_HOURS.approval),
    execution: hours(env.RECOVERY_EXECUTION_WINDOW_HOURS, DEFAULT_HOURS.execution),
    finish: hours(env.RECOVERY_FINISH_WINDOW_HOURS, DEFAULT_HOURS.finish),
  };
}

export const deadline = (from: number, h: number): string => new Date(from + h * 3_600_000).toISOString();

/** True when a stored deadline has passed. Plans without one (created before 0009) have no window. */
export const windowClosed = (by: string | null | undefined, now = Date.now()): boolean => Boolean(by) && Date.parse(by as string) <= now;

interface Snapshot { status: string; deadline: string | null; remaining_ms: number }

const STAGES = [
  { status: "draft", column: "approve_by", event: EVENTS.approved },
  { status: "approved", column: "execute_by", event: EVENTS.started },
  { status: "executing", column: "finish_by", event: EVENTS.finished },
] as const;

async function snapshot(env: LifecycleEnv, planId: string): Promise<Snapshot | null> {
  const row = await env.DB.prepare("SELECT status, approve_by, execute_by, finish_by FROM recovery_plans WHERE plan_id = ?")
    .bind(planId).first<{ status: string; approve_by: string | null; execute_by: string | null; finish_by: string | null }>();
  if (!row) return null;
  const stage = STAGES.find((s) => s.status === row.status);
  const by = stage ? row[stage.column] : null;
  return { status: row.status, deadline: by, remaining_ms: by ? Math.max(Date.parse(by) - Date.now(), 1_000) : 0 };
}

/** Closes the window of a plan still in `status`. Returns true only if this call changed it. */
async function closeWindow(env: LifecycleEnv, planId: string, status: string, instanceId: string): Promise<boolean> {
  if (status === "executing") {
    await appendAuditEvent(env.DB, {
      event_type: "recovery.execution_overdue", actor: "workflow:recovery-lifecycle", subject: planId, outcome: "overdue",
      payload: { workflow_instance_id: instanceId, note: "execution was started but never finished; status left unchanged for a human" },
    });
    await publishAgentReport(env.AGENTS, "recovery-manager", {
      kind: "platform_digest", severity: "critical",
      subject: `Recovery plan ${planId} execution overdue`,
      body: { plan_id: planId, previous_status: "executing", reason: "execution_overdue", workflow_instance_id: instanceId, action_required: "a human must finish or abandon the plan" },
    });
    return true;
  }
  const reason = status === "draft" ? "approval_expired" : "approval_lapsed";
  const result = await env.DB.prepare(
    "UPDATE recovery_plans SET status = 'disabled', disabled_reason = ?, updated_at = ? WHERE plan_id = ? AND status = ?",
  ).bind(reason, nowIso(), planId, status).run();
  if ((result.meta.changes ?? 0) !== 1) return false;
  await appendAuditEvent(env.DB, {
    event_type: "recovery.plan_expired", actor: "workflow:recovery-lifecycle", subject: planId, outcome: "disabled",
    payload: { previous_status: status, reason, workflow_instance_id: instanceId },
  });
  await publishAgentReport(env.AGENTS, "recovery-manager", {
    kind: "platform_digest", severity: "warning",
    subject: `Recovery plan ${planId} expired (${reason})`,
    body: { plan_id: planId, previous_status: status, reason, workflow_instance_id: instanceId },
  });
  return true;
}

/** The Workflow body. Every D1 read and write is a named step, so a replay never repeats one. */
export async function runLifecycle(env: LifecycleEnv, planId: string, instanceId: string, step: WorkflowStepLike): Promise<{ plan_id: string; final_status: string; closed: string[] }> {
  const closed: string[] = [];
  let current = await step.do("read plan", () => snapshot(env, planId));
  for (const stage of STAGES) {
    if (!current) return { plan_id: planId, final_status: "missing", closed };
    if (current.status !== stage.status) continue;
    if (!current.deadline) return { plan_id: planId, final_status: current.status, closed };
    try {
      await step.waitForEvent(`await ${stage.event}`, { type: stage.event, timeout: current.remaining_ms });
    } catch {
      // Timed out: the window may have closed. The next step re-reads D1 and decides.
    }
    const after = await step.do(`settle ${stage.status} window`, async () => {
      const s = await snapshot(env, planId);
      if (s && s.status === stage.status && windowClosed(s.deadline)) {
        const changed = await closeWindow(env, planId, stage.status, instanceId);
        return { snapshot: await snapshot(env, planId), closed: changed ? stage.status : null };
      }
      return { snapshot: s, closed: null };
    });
    if (after.closed) closed.push(after.closed);
    if (stage.status === "executing" && after.closed) return { plan_id: planId, final_status: "executing", closed };
    current = after.snapshot;
  }
  return { plan_id: planId, final_status: current?.status ?? "missing", closed };
}

/** Best-effort wake-up of a plan's Workflow; D1 has already recorded the transition. */
export async function notify(env: LifecycleEnv, instanceId: string | null, type: string, payload: Record<string, unknown>): Promise<void> {
  if (!instanceId || !env.RECOVERY_LIFECYCLE) return;
  try {
    await (await env.RECOVERY_LIFECYCLE.get(instanceId)).sendEvent({ type, payload });
  } catch (err) {
    console.error(JSON.stringify({ service: "cryptophys-recovery-manager", event: "lifecycle_notify_failed", instance: instanceId, type, message: String((err as Error)?.message ?? err) }));
  }
}

export async function terminate(env: LifecycleEnv, instanceId: string | null): Promise<void> {
  if (!instanceId || !env.RECOVERY_LIFECYCLE) return;
  try {
    await (await env.RECOVERY_LIFECYCLE.get(instanceId)).terminate();
  } catch (err) {
    console.error(JSON.stringify({ service: "cryptophys-recovery-manager", event: "lifecycle_terminate_failed", instance: instanceId, message: String((err as Error)?.message ?? err) }));
  }
}
