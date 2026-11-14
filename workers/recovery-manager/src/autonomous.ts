/**
 * Autonomous execution of an approved recovery plan (owner decision 2026-11-06: "after approve,
 * the AI runs everything in the background; show the pipeline"). It runs inside the plan's
 * lifecycle Workflow, so every stage is durable, retried and resumable.
 *
 * The owner's approval click is the only human step. After it:
 *   1. the Policy Engine must allow recovery.execute (approval, separation of duties);
 *   2. each step runs through its owning path, re-checking the live state first: a redeploy
 *      is skipped when the service is already in sync, so a stale plan never deploys an old
 *      commit;
 *   3. a verification stage waits for a fresh drift observation of the service;
 *   4. the plan finishes as completed or failed, with an audit event and an agent report.
 * Progress is written to last_execution_json.pipeline after every stage, for the Console.
 *
 * Steps that need credentials no Worker holds (restoring D1, rotating secrets) stop the pipeline
 * as "blocked"; the owner carries them out by runbook. A rollback returns the Worker to the
 * version the registry recorded before the current one (Wave B, Rollback Worker workflow).
 */
import type { WorkflowStepLike } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { publishAgentReport } from "../../control-plane-shared/src/agents.ts";
import { nowIso } from "../../control-plane-shared/src/http.ts";
import { deadline, windows, type LifecycleEnv } from "./lifecycle.ts";

export const AI_EXECUTOR = "ai:recovery-manager";

/** The Deployment Orchestrator's recovery surface (DeployRpc). */
export interface RecoveryDeployBinding {
  deployForRecovery(planId: string, decisionId: string, serviceId: string, version: string): Promise<Record<string, unknown>>;
  rollbackForRecovery?(planId: string, decisionId: string, serviceId: string): Promise<Record<string, unknown>>;
  runStatus(workflow: string, commitSha: string): Promise<{ found: boolean; status?: string; conclusion?: string | null; run_id?: number; url?: string }>;
  /** ADR-0012 G2c-1: a request the Orchestrator runs itself (native deploy or rollback), by request id. */
  requestStatus?(requestId: string): Promise<{ found: boolean; status?: string; conclusion?: string | null; reason?: string | null }>;
}

/** What a recovery step follows after asking the Orchestrator: its GitHub workflow run, or its own native request. */
type Followed = { workflow: string; commit_sha: string; executor: string; request_id: string };
const NATIVE_REQUEST = /^dep_[0-9a-f-]{36}$/;
const isNative = (f: Followed) => f.executor.startsWith("native:") && NATIVE_REQUEST.test(f.request_id);

export interface PolicyEvaluator {
  evaluate(input: { subject: string; action: string; resource: string; context: Record<string, unknown> }):
    Promise<{ decision: "allow" | "deny"; decision_id: string; reason: string }>;
}

export interface AutonomousEnv extends LifecycleEnv {
  POLICY?: PolicyEvaluator;
  DEPLOY?: RecoveryDeployBinding;
  /** Poll interval and limits; overridable for tests. */
  RECOVERY_DEPLOY_POLL_SECONDS?: string;
}

export type StageStatus = "pending" | "running" | "succeeded" | "skipped" | "failed" | "blocked" | "cancelled";
export interface Stage { id: string; kind: string; label: string; status: StageStatus; started_at?: string; finished_at?: string; detail?: string; link?: string }

interface Plan { plan_id: string; service_id: string; plan_version: string; status: string; approved_by: string | null; steps_json: string; last_execution_json: string | null }

const DEPLOY_POLLS = 40; // x 30 s = 20 min, longer than any deploy workflow
// A native request waits for a SAFE minute and expires after 45 minutes if it never ran; a claimed one is failed
// after its 30-minute lease. 120 x 30 s = 60 min follows it to an end in practice.
const NATIVE_POLLS = 120;
const VERIFY_POLLS = 6; // x 5 min = 30 min, two drift cron cycles
const HEX = /^[0-9a-f]{7,40}$/;

async function readPlan(env: AutonomousEnv, planId: string): Promise<Plan | null> {
  return env.DB.prepare("SELECT plan_id, service_id, plan_version, status, approved_by, steps_json, last_execution_json FROM recovery_plans WHERE plan_id = ?")
    .bind(planId).first<Plan>();
}

async function savePipeline(env: AutonomousEnv, planId: string, mutate: (exec: Record<string, any>) => void): Promise<Record<string, any>> {
  const p = await readPlan(env, planId);
  const exec = p?.last_execution_json ? JSON.parse(p.last_execution_json) : {};
  mutate(exec);
  exec.updated_at = nowIso();
  await env.DB.prepare("UPDATE recovery_plans SET last_execution_json = ?, updated_at = ? WHERE plan_id = ?").bind(JSON.stringify(exec), nowIso(), planId).run();
  return exec;
}

const setStage = (env: AutonomousEnv, planId: string, id: string, patch: Partial<Stage>) =>
  savePipeline(env, planId, (exec) => {
    const st = (exec.pipeline as Stage[]).find((s) => s.id === id);
    if (st) Object.assign(st, patch);
  });

/**
 * The service's newest drift observation. Rows are recorded on change (0061): observed_at is when that state was first
 * seen, and last_seen_at (service_registry.updated_at, which every Drift Detector run sets) when it was last observed.
 */
async function latestObservation(env: AutonomousEnv, serviceId: string): Promise<{ drifted: number; observed_at: string; last_seen_at: string | null; evidence: Record<string, any> } | null> {
  const row = await env.DB.prepare(
    `SELECT o.drifted, o.observed_at, o.evidence_json, r.updated_at AS last_seen_at FROM drift_observations o
     LEFT JOIN service_registry r ON r.service_id = o.service_id
     WHERE o.service_id = ? ORDER BY o.observed_at DESC, o.rowid DESC LIMIT 1`,
  ).bind(serviceId).first<{ drifted: number; observed_at: string; evidence_json: string; last_seen_at: string | null }>();
  return row ? { drifted: row.drifted, observed_at: row.observed_at, last_seen_at: row.last_seen_at ?? null, evidence: JSON.parse(row.evidence_json || "{}") } : null;
}

const sleep = async (step: WorkflowStepLike, name: string, d: string) => { if (step.sleep) await step.sleep(name, d); };

/** One step. Returns the terminal stage status and a detail line. */
async function runStep(env: AutonomousEnv, plan: Plan, decisionId: string, index: number, action: string, step: WorkflowStepLike): Promise<{ status: StageStatus; detail: string; link?: string }> {
  const id = `step-${index + 1}`;
  switch (action) {
    case "manual":
      return { status: "skipped", detail: "A note for people; the verification stage checks health and drift automatically." };
    case "disable_service":
      return step.do(`${id} disable service`, async () => {
        const res = await env.DB.prepare("UPDATE service_registry SET status = 'disabled', updated_at = ? WHERE service_id = ? AND status != 'disabled'")
          .bind(nowIso(), plan.service_id).run();
        await appendAuditEvent(env.DB, { event_type: "registry.service_status_set", actor: `recovery:${plan.plan_id}`, subject: plan.service_id, outcome: "disabled", payload: { plan_id: plan.plan_id } });
        return { status: "succeeded" as StageStatus, detail: (res.meta.changes ?? 0) ? `${plan.service_id} disabled in the registry` : `${plan.service_id} was already disabled` };
      });
    case "redeploy_commit": {
      const pre = await step.do(`${id} re-check drift`, async () => {
        const obs = await latestObservation(env, plan.service_id);
        return obs ? { drifted: obs.drifted === 1, observed: String(obs.evidence?.probe?.version_tag ?? obs.evidence?.observed_version ?? "unknown"), at: obs.observed_at } : null;
      });
      if (pre && !pre.drifted) return { status: "skipped", detail: `Already in sync (observed ${pre.observed} at ${pre.at}); nothing to redeploy.` };
      if (!HEX.test(plan.plan_version)) return { status: "failed", detail: `plan_version ${plan.plan_version} is not a commit tag` };
      if (!env.DEPLOY) return { status: "blocked", detail: "the Deployment Orchestrator binding is missing" };
      const dispatched = await step.do(`${id} dispatch deploy`, { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } }, async () => {
        try {
          const r = await env.DEPLOY!.deployForRecovery(plan.plan_id, decisionId, plan.service_id, plan.plan_version);
          return { ok: true as const, workflow: String(r.workflow ?? ""), commit_sha: String(r.commit_sha ?? ""), executor: String(r.executor ?? ""), request_id: String(r.request_id ?? ""), error: "" };
        } catch (err) {
          return { ok: false as const, workflow: "", commit_sha: "", executor: "", request_id: "", error: String((err as Error)?.message ?? err).slice(0, 300) };
        }
      });
      if (!dispatched.ok) return { status: "failed", detail: `deploy not dispatched: ${dispatched.error}` };
      // G2c-1: a native redeploy is followed by its request id, not by a workflow run.
      if (isNative(dispatched as Followed)) {
        return followNative(env, step, `${id} deploy`, dispatched as Followed, (ok, reason) => ok
          ? `native deploy of ${dispatched.commit_sha.slice(0, 12)} succeeded (request ${dispatched.request_id})`
          : `native deploy of ${dispatched.commit_sha.slice(0, 12)} failed: ${reason ?? "unknown"} (request ${dispatched.request_id}; changed Workers were restored)`);
      }
      const { workflow, commit_sha: sha } = dispatched;
      for (let i = 1; i <= DEPLOY_POLLS; i++) {
        await sleep(step, `${id} wait deploy ${i}`, `${env.RECOVERY_DEPLOY_POLL_SECONDS ?? "30"} seconds`);
        const run = await step.do(`${id} poll deploy ${i}`, () => env.DEPLOY!.runStatus(workflow, sha));
        if (run.found && run.status === "completed") {
          return run.conclusion === "success"
            ? { status: "succeeded", detail: `${workflow} deployed ${sha.slice(0, 12)}`, link: run.url }
            : { status: "failed", detail: `${workflow} finished ${run.conclusion} (the workflow rolled back automatically)`, link: run.url };
        }
      }
      return { status: "failed", detail: `${workflow} did not finish within ${DEPLOY_POLLS * 30 / 60} minutes` };
    }
    case "rollback_worker_version": {
      const pre = await step.do(`${id} re-check drift`, async () => {
        const obs = await latestObservation(env, plan.service_id);
        return obs ? { drifted: obs.drifted === 1, at: obs.observed_at } : null;
      });
      if (pre && !pre.drifted) return { status: "skipped", detail: `Healthy and in sync at ${pre.at}; no rollback needed.` };
      if (!env.DEPLOY?.rollbackForRecovery) return { status: "blocked", detail: "the Deployment Orchestrator binding has no rollback" };
      const r = await step.do(`${id} dispatch rollback`, { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } }, async () => {
        try {
          const out = await env.DEPLOY!.rollbackForRecovery!(plan.plan_id, decisionId, plan.service_id);
          return { ok: true as const, workflow: String(out.workflow ?? ""), commit_sha: String(out.commit_sha ?? ""), tag: String(out.version_tag ?? ""), executor: String(out.executor ?? ""), request_id: String(out.request_id ?? ""), error: "" };
        } catch (err) {
          return { ok: false as const, workflow: "", commit_sha: "", tag: "", executor: "", request_id: "", error: String((err as Error)?.message ?? err).slice(0, 300) };
        }
      });
      if (!r.ok) return { status: "failed", detail: `rollback not dispatched: ${r.error}` };
      // G2c-1: a native rollback (phase 2) is followed by its request id as well; it has no workflow run.
      if (isNative(r as Followed)) {
        return followNative(env, step, `${id} rollback`, r as Followed, (ok, reason) => ok
          ? `rolled back to ${r.tag} (request ${r.request_id})`
          : `rollback to ${r.tag} failed: ${reason ?? "unknown"} (request ${r.request_id}; restored)`);
      }
      for (let i = 1; i <= DEPLOY_POLLS; i++) {
        await sleep(step, `${id} wait rollback ${i}`, `${env.RECOVERY_DEPLOY_POLL_SECONDS ?? "30"} seconds`);
        const run = await step.do(`${id} poll rollback ${i}`, () => env.DEPLOY!.runStatus(r.workflow, r.commit_sha));
        if (run.found && run.status === "completed") {
          return run.conclusion === "success"
            ? { status: "succeeded", detail: `rolled back to ${r.tag}`, link: run.url }
            : { status: "failed", detail: `rollback to ${r.tag} finished ${run.conclusion} (restored)`, link: run.url };
        }
      }
      return { status: "failed", detail: "the rollback did not finish within 20 minutes" };
    }
    default:
      // restore_d1_bookmark, rotate_secret
      return { status: "blocked", detail: `${action} needs a credential no Worker holds; the owner carries it out by runbook` };
  }
}

/** Poll one of the Orchestrator's native requests until it finishes. */
async function followNative(env: AutonomousEnv, step: WorkflowStepLike, name: string, f: Followed, detail: (ok: boolean, reason: string | null | undefined) => string): Promise<{ status: StageStatus; detail: string }> {
  if (!env.DEPLOY?.requestStatus) return { status: "failed", detail: `the Deployment Orchestrator binding cannot report request ${f.request_id}` };
  for (let i = 1; i <= NATIVE_POLLS; i++) {
    await sleep(step, `${name} wait ${i}`, `${env.RECOVERY_DEPLOY_POLL_SECONDS ?? "30"} seconds`);
    const s = await step.do(`${name} poll ${i}`, () => env.DEPLOY!.requestStatus!(f.request_id));
    if (s.found && s.status === "completed") return s.conclusion === "success" ? { status: "succeeded", detail: detail(true, null) } : { status: "failed", detail: detail(false, s.reason) };
  }
  return { status: "failed", detail: `request ${f.request_id} did not finish within ${NATIVE_POLLS * 30 / 60} minutes` };
}

/**
 * Runs an approved plan to completion. Idempotent per Workflow step name: a replay resumes
 * where it stopped. Returns the final plan status.
 */
export async function executeAutonomously(env: AutonomousEnv, planId: string, instanceId: string, step: WorkflowStepLike): Promise<string> {
  const start = await step.do("autonomous start", async () => {
    const plan = await readPlan(env, planId);
    if (!plan || plan.status !== "approved") return { started: false as const, status: plan?.status ?? "missing" };
    let decision: { decision: string; decision_id: string; reason: string } | null = null;
    try {
      decision = await env.POLICY!.evaluate({ subject: AI_EXECUTOR, action: "recovery.execute", resource: planId,
        context: { operator_acknowledged: true, autonomous: true, approved_by: plan.approved_by } });
    } catch { decision = null; }
    const steps = (JSON.parse(plan.steps_json).steps ?? []) as { action: string; description: string }[];
    const pipeline: Stage[] = [
      { id: "approval", kind: "approval", label: `Approved by ${plan.approved_by ?? "an approver"}`, status: "succeeded", finished_at: nowIso() },
      { id: "policy", kind: "policy", label: "Policy Engine: recovery.execute", status: decision?.decision === "allow" ? "succeeded" : "failed",
        finished_at: nowIso(), detail: decision ? `${decision.decision}: ${decision.reason}` : "policy unavailable" },
      ...steps.map((s, i) => ({ id: `step-${i + 1}`, kind: s.action, label: s.description, status: "pending" as StageStatus })),
      { id: "verify", kind: "verify", label: "Verify health and drift", status: "pending" },
    ];
    const execution = { autonomous: true, phase: decision?.decision === "allow" ? "start" : "finish", executed_by: AI_EXECUTOR, approved_by: plan.approved_by,
      policy_decision_id: decision?.decision_id ?? null, started_at: nowIso(), workflow_instance_id: instanceId, pipeline };
    if (decision?.decision !== "allow") {
      await env.DB.prepare("UPDATE recovery_plans SET status = 'failed', last_execution_json = ?, updated_at = ? WHERE plan_id = ? AND status = 'approved'")
        .bind(JSON.stringify({ ...execution, outcome: "failed", finished_at: nowIso() }), nowIso(), planId).run();
      await appendAuditEvent(env.DB, { event_type: "recovery.execution_finished", actor: AI_EXECUTOR, subject: planId, outcome: "failed", payload: { reason: "policy_denied", policy: decision?.reason ?? "unavailable" } });
      return { started: false as const, status: "failed" };
    }
    const res = await env.DB.prepare("UPDATE recovery_plans SET status = 'executing', last_execution_json = ?, finish_by = ?, updated_at = ? WHERE plan_id = ? AND status = 'approved'")
      .bind(JSON.stringify(execution), deadline(Date.now(), windows(env).finish), nowIso(), planId).run();
    if ((res.meta.changes ?? 0) !== 1) return { started: false as const, status: "changed" };
    await appendAuditEvent(env.DB, { event_type: "recovery.execution_started", actor: AI_EXECUTOR, subject: planId, outcome: "executing",
      payload: { autonomous: true, approved_by: plan.approved_by, policy_decision_id: decision.decision_id, workflow_instance_id: instanceId } });
    return { started: true as const, decision_id: decision.decision_id, service_id: plan.service_id, steps: steps.map((s) => s.action) };
  });
  if (!start.started) return start.status;

  const plan = (await step.do("read approved plan", () => readPlan(env, planId)))!;
  let failed: { id: string; detail: string } | null = null;
  for (const [i, action] of start.steps.entries()) {
    const id = `step-${i + 1}`;
    if (failed) { await step.do(`${id} cancel`, () => setStage(env, planId, id, { status: "cancelled", detail: "an earlier stage did not succeed" })); continue; }
    await step.do(`${id} begin`, () => setStage(env, planId, id, { status: "running", started_at: nowIso() }));
    const out = await runStep(env, plan, start.decision_id, i, action, step);
    await step.do(`${id} end`, () => setStage(env, planId, id, { status: out.status, finished_at: nowIso(), detail: out.detail, ...(out.link ? { link: out.link } : {}) }));
    if (out.status === "failed" || out.status === "blocked") failed = { id, detail: out.detail };
  }

  let verified = false;
  if (failed) {
    await step.do("verify cancel", () => setStage(env, planId, "verify", { status: "cancelled", detail: "an earlier stage did not succeed" }));
  } else {
    await step.do("verify begin", () => setStage(env, planId, "verify", { status: "running", started_at: nowIso() }));
    const since = (await step.do("verify since", async () => ({ at: nowIso() }))).at;
    let detail = "no fresh drift observation within 30 minutes";
    for (let i = 1; i <= VERIFY_POLLS; i++) {
      const obs = await step.do(`verify poll ${i}`, () => latestObservation(env, start.service_id));
      // The deploy workflows observe drift themselves when they finish, so a fresh observation is usually there
      // already. Fresh is the heartbeat (last_seen_at): an unchanged state adds no row (0061), so the newest row's
      // observed_at can be older than any recent run that confirmed it.
      const seen = obs ? obs.last_seen_at ?? obs.observed_at : null;
      const fresh = obs && seen !== null && (Date.parse(seen) >= Date.parse(since) - 15 * 60_000);
      if (fresh && obs!.drifted === 0) { verified = true; detail = `in sync and healthy (observed ${seen}, in sync since ${obs!.observed_at})`; break; }
      if (fresh && obs!.drifted === 1 && i === VERIFY_POLLS) { detail = `still drifted: ${JSON.stringify(obs!.evidence?.reasons ?? [])}`; break; }
      await sleep(step, `verify wait ${i}`, "5 minutes");
    }
    await step.do("verify end", () => setStage(env, planId, "verify", { status: verified ? "succeeded" : "failed", finished_at: nowIso(), detail }));
    if (!verified) failed = { id: "verify", detail };
  }

  return step.do("autonomous finish", async () => {
    const outcome = failed ? "failed" : "completed";
    const exec = await savePipeline(env, planId, (e) => { e.phase = "finish"; e.outcome = outcome; e.finished_at = nowIso(); e.finished_by = AI_EXECUTOR; if (failed) e.failed_stage = failed; });
    await env.DB.prepare("UPDATE recovery_plans SET status = ?, updated_at = ? WHERE plan_id = ? AND status = 'executing'").bind(outcome, nowIso(), planId).run();
    await appendAuditEvent(env.DB, { event_type: "recovery.execution_finished", actor: AI_EXECUTOR, subject: planId, outcome,
      payload: { autonomous: true, failed_stage: failed, stages: (exec.pipeline as Stage[]).map((s) => `${s.id}:${s.status}`) } });
    await publishAgentReport(env.AGENTS, "recovery-manager", {
      kind: "platform_digest", severity: failed ? "warning" : "info",
      subject: `Recovery plan ${planId} ${outcome} autonomously`,
      body: { plan_id: planId, service_id: start.service_id, outcome, failed_stage: failed?.id ?? null, detail: failed?.detail ?? null },
    });
    return outcome;
  });
}
