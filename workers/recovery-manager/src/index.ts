import type { BaseEnv } from "../../control-plane-shared/src/types.ts";
import {
  ACTOR, SERVICE_ID, bearerMatches, errorResponse, healthResponse, json, limitParam, newId, nowIso, readJsonObject,
  requireAdmin, serviceMetadata, stringField, type JsonObject,
} from "../../control-plane-shared/src/http.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { boundedString, boundedStringArray, engineFor, type AiTask } from "../../control-plane-shared/src/ai-engine.ts";
import { readinessResponse } from "../../control-plane-shared/src/readiness.ts";
import { accessGate } from "../../control-plane-shared/src/access.ts";

/** The Policy Engine's RPC surface (workers/policy-engine/src/worker.ts PolicyRpc). */
export interface PolicyRpcBinding {
  evaluate(input: { subject: string; action: string; resource: string; context: Record<string, unknown> }):
    Promise<{ decision: "allow" | "deny"; decision_id: string; reason: string }>;
}

export interface Env extends BaseEnv {
  /** Separate secret held by approvers; plan authors (ADMIN_TOKEN) cannot approve. */
  APPROVER_TOKEN?: string;
  /** RPC service binding to cryptophys-policy-engine (entrypoint PolicyRpc); execution requires its allow decision. */
  POLICY: PolicyRpcBinding;
}

const SERVICE = "cryptophys-recovery-manager";
const STEP_ACTIONS = ["rollback_worker_version", "redeploy_commit", "disable_service", "restore_d1_bookmark", "rotate_secret", "manual"];

interface PlanRow {
  plan_id: string;
  service_id: string;
  plan_version: string;
  status: string;
  steps_json: string;
  approved_by: string | null;
  last_execution_json: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface Draft { options: string[]; blast_radius: string }
const draftTask: AiTask<Draft> = {
  name: "draft_recovery_options",
  instructions:
    'Given a recovery plan and its evidence, list risks or alternative recovery options for a human reviewer. Return ' +
    '{"options": up to 5 strings of at most 200 characters, "blast_radius": at most 300 characters}. Do not claim anything was executed.',
  maxInputChars: 8000,
  maxOutputTokens: 400,
  validate(output) {
    const o = output as Record<string, unknown>;
    const options = boundedStringArray(o?.options, 5, 200);
    const blast = boundedString(o?.blast_radius, 300);
    return options && blast ? { options, blast_radius: blast } : null;
  },
};

function present(row: PlanRow): JsonObject {
  const { steps_json, last_execution_json, ...rest } = row;
  return { ...rest, plan: JSON.parse(steps_json), last_execution: last_execution_json ? JSON.parse(last_execution_json) : null };
}

const getPlan = (env: Env, id: string) => env.DB.prepare("SELECT * FROM recovery_plans WHERE plan_id = ?").bind(id).first<PlanRow>();

function validateSteps(value: unknown): { action: string; description: string }[] | Error {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return new Error("steps must contain 1-20 entries");
  const steps: { action: string; description: string }[] = [];
  for (const raw of value) {
    const s = raw as JsonObject;
    if (!s || typeof s !== "object") return new Error("each step must be an object");
    if (!STEP_ACTIONS.includes(s.action as string)) return new Error(`step.action must be one of ${STEP_ACTIONS.join(", ")}`);
    if (typeof s.description !== "string" || !s.description.trim() || s.description.length > 500) {
      return new Error("step.description must be 1-500 characters");
    }
    steps.push({ action: s.action as string, description: s.description.trim() });
  }
  return steps;
}

async function createPlan(request: Request, env: Env, url: URL): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  const b = body.value;
  const serviceId = stringField(b, "service_id", 63);
  const planVersion = stringField(b, "plan_version", 40);
  const title = stringField(b, "title", 160);
  const rationale = stringField(b, "rationale", 2000);
  const createdBy = stringField(b, "created_by", 128);
  for (const v of [serviceId, planVersion, title, rationale, createdBy]) if (v instanceof Error) return errorResponse(400, "invalid_request", v.message);
  if (!SERVICE_ID.test(serviceId as string)) return errorResponse(400, "invalid_request", "service_id is invalid");
  if (!ACTOR.test(createdBy as string)) return errorResponse(400, "invalid_request", "created_by contains unsupported characters");
  const steps = validateSteps(b.steps);
  if (steps instanceof Error) return errorResponse(400, "invalid_request", steps.message);
  const svc = await env.DB.prepare("SELECT 1 AS ok FROM service_registry WHERE service_id = ?").bind(serviceId).first();
  if (!svc) return errorResponse(404, "service_not_registered");

  const planId = newId("plan");
  const now = nowIso();
  const plan = { title, rationale, steps };
  await env.DB.prepare(
    `INSERT INTO recovery_plans (plan_id, service_id, plan_version, status, steps_json, approved_by, last_execution_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', ?, NULL, NULL, ?, ?, ?)`,
  ).bind(planId, serviceId, planVersion, JSON.stringify(plan), createdBy, now, now).run();
  await appendAuditEvent(env.DB, {
    event_type: "recovery.plan_created", actor: createdBy as string, subject: planId, outcome: "draft",
    payload: { service_id: serviceId, plan_version: planVersion, step_actions: steps.map((s) => s.action) },
  });
  const saved = (await getPlan(env, planId))!;
  const response: JsonObject = { plan: present(saved) };
  if (url.searchParams.get("advisory") === "true") {
    response.advisory = await engineFor(env, SERVICE, [draftTask.name]).run(draftTask, present(saved), planId);
  }
  return json(response, 201);
}

async function approvePlan(request: Request, env: Env, plan: PlanRow): Promise<Response> {
  if (!env.APPROVER_TOKEN) return errorResponse(503, "not_configured", "APPROVER_TOKEN secret is not configured");
  if (!bearerMatches(request, env.APPROVER_TOKEN)) return errorResponse(401, "unauthorized", "approval requires the approver credential");
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  const approver = stringField(body.value, "approved_by", 128);
  if (approver instanceof Error) return errorResponse(400, "invalid_request", approver.message);
  if (!ACTOR.test(approver as string)) return errorResponse(400, "invalid_request", "approved_by contains unsupported characters");
  if (plan.status !== "draft") return errorResponse(409, "invalid_state", `plan is ${plan.status}, only draft plans can be approved`);
  if (approver === plan.created_by) return errorResponse(403, "separation_of_duties", "the plan author cannot approve their own plan");
  const result = await env.DB.prepare(
    "UPDATE recovery_plans SET status = 'approved', approved_by = ?, updated_at = ? WHERE plan_id = ? AND status = 'draft'",
  ).bind(approver, nowIso(), plan.plan_id).run();
  if ((result.meta.changes ?? 0) !== 1) return errorResponse(409, "invalid_state", "plan changed concurrently");
  await appendAuditEvent(env.DB, { event_type: "recovery.plan_approved", actor: approver as string, subject: plan.plan_id, outcome: "approved", payload: {} });
  return json({ plan: present((await getPlan(env, plan.plan_id))!) });
}

async function recordExecution(request: Request, env: Env, plan: PlanRow): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  const b = body.value;
  const executor = stringField(b, "executed_by", 128);
  const phase = stringField(b, "phase", 10);
  const notes = stringField(b, "notes", 2000, false);
  for (const v of [executor, phase, notes]) if (v instanceof Error) return errorResponse(400, "invalid_request", v.message);
  if (!ACTOR.test(executor as string)) return errorResponse(400, "invalid_request", "executed_by contains unsupported characters");

  if (phase === "start") {
    // The Policy Engine is authoritative: no execution starts without its recorded allow decision.
    let decision: { decision: string; decision_id: string; reason: string };
    try {
      decision = await env.POLICY.evaluate({
        subject: executor as string, action: "recovery.execute", resource: plan.plan_id,
        context: { operator_acknowledged: b.operator_acknowledged === true },
      });
    } catch {
      // Fail closed: without a recorded allow decision nothing starts.
      return errorResponse(503, "policy_unavailable", "the Policy Engine could not be reached");
    }
    if (decision?.decision !== "allow") {
      return errorResponse(403, "policy_denied", decision?.reason ?? "policy denied", { decision_id: decision?.decision_id ?? null });
    }
    const execution = { phase: "start", executed_by: executor, policy_decision_id: decision.decision_id, started_at: nowIso(), notes: notes ?? null };
    const result = await env.DB.prepare(
      "UPDATE recovery_plans SET status = 'executing', last_execution_json = ?, updated_at = ? WHERE plan_id = ? AND status = 'approved'",
    ).bind(JSON.stringify(execution), nowIso(), plan.plan_id).run();
    if ((result.meta.changes ?? 0) !== 1) return errorResponse(409, "invalid_state", "plan is no longer approved");
    await appendAuditEvent(env.DB, { event_type: "recovery.execution_started", actor: executor as string, subject: plan.plan_id, outcome: "executing", payload: execution });
  } else if (phase === "finish") {
    const outcome = b.outcome;
    if (outcome !== "completed" && outcome !== "failed") return errorResponse(400, "invalid_request", "outcome must be completed or failed");
    if (plan.status !== "executing") return errorResponse(409, "invalid_state", `plan is ${plan.status}, expected executing`);
    const previous = plan.last_execution_json ? JSON.parse(plan.last_execution_json) : {};
    const execution = { ...previous, phase: "finish", finished_by: executor, outcome, finished_at: nowIso(), finish_notes: notes ?? null };
    const result = await env.DB.prepare(
      "UPDATE recovery_plans SET status = ?, last_execution_json = ?, updated_at = ? WHERE plan_id = ? AND status = 'executing'",
    ).bind(outcome, JSON.stringify(execution), nowIso(), plan.plan_id).run();
    if ((result.meta.changes ?? 0) !== 1) return errorResponse(409, "invalid_state", "plan changed concurrently");
    await appendAuditEvent(env.DB, { event_type: "recovery.execution_finished", actor: executor as string, subject: plan.plan_id, outcome: outcome as string, payload: execution });
  } else {
    return errorResponse(400, "invalid_request", "phase must be start or finish");
  }
  return json({ plan: present((await getPlan(env, plan.plan_id))!) });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const blocked = await accessGate(request, env);
    if (blocked) return blocked;
    const path = url.pathname;
    if (request.method === "GET" || request.method === "HEAD") {
      if (path === "/health" || path === "/healthz") return healthResponse(env);
      if (path === "/ready" || path === "/readyz") {
        return readinessResponse(env, { approver_token_configured: Boolean(env.APPROVER_TOKEN), policy_binding: Boolean(env.POLICY) });
      }
      if (path === "/") {
        return serviceMetadata(env, "Reviewed recovery plans with separated approval and policy-gated, operator-recorded execution", [
          "POST /v1/plans", "GET /v1/plans", "GET /v1/plans/{plan_id}", "POST /v1/plans/{plan_id}/approve (approver credential)",
          "POST /v1/plans/{plan_id}/executions", "POST /v1/plans/{plan_id}/disable",
        ]);
      }
    }
    if (!path.startsWith("/v1/")) return errorResponse(404, "not_found");
    const match = /^\/v1\/plans\/(plan_[0-9a-f-]{36})(?:\/(approve|executions|disable))?$/.exec(path);
    try {
      // Approval authenticates with the approver credential instead of ADMIN_TOKEN.
      if (match?.[2] === "approve") {
        if (request.method !== "POST") return errorResponse(405, "method_not_allowed");
        const plan = await getPlan(env, match[1]);
        if (!plan) {
          return bearerMatches(request, env.APPROVER_TOKEN) ? errorResponse(404, "not_found") : errorResponse(401, "unauthorized");
        }
        return await approvePlan(request, env, plan);
      }
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      if (path === "/v1/plans" && request.method === "POST") return await createPlan(request, env, url);
      if (path === "/v1/plans" && request.method === "GET") {
        const filters: string[] = [];
        const params: unknown[] = [];
        for (const key of ["service_id", "status"]) {
          const value = url.searchParams.get(key);
          if (value) { filters.push(`${key} = ?`); params.push(value.slice(0, 63)); }
        }
        const rows = await env.DB.prepare(
          `SELECT * FROM recovery_plans ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`,
        ).bind(...params, limitParam(url)).all<PlanRow>();
        return json({ plans: rows.results.map(present) });
      }
      if (!match) return errorResponse(404, "not_found");
      const plan = await getPlan(env, match[1]);
      if (!plan) return errorResponse(404, "not_found");
      if (!match[2]) return request.method === "GET" ? json({ plan: present(plan) }) : errorResponse(405, "method_not_allowed");
      if (request.method !== "POST") return errorResponse(405, "method_not_allowed");
      if (match[2] === "executions") return await recordExecution(request, env, plan);
      // disable
      const body = await readJsonObject(request);
      if (!body.ok) return body.response;
      const actor = stringField(body.value, "actor", 128);
      if (actor instanceof Error || !ACTOR.test(actor as string)) return errorResponse(400, "invalid_request", "actor is required");
      if (plan.status === "executing") return errorResponse(409, "invalid_state", "an executing plan must be finished first");
      await env.DB.prepare("UPDATE recovery_plans SET status = 'disabled', updated_at = ? WHERE plan_id = ?").bind(nowIso(), plan.plan_id).run();
      await appendAuditEvent(env.DB, { event_type: "recovery.plan_disabled", actor: actor as string, subject: plan.plan_id, outcome: "disabled", payload: { previous_status: plan.status } });
      return json({ plan: present((await getPlan(env, plan.plan_id))!) });
    } catch (err) {
      const id = newId("err");
      console.error(JSON.stringify({ service: SERVICE, error_id: id, message: String((err as Error)?.message ?? err) }));
      return errorResponse(500, "internal_error", undefined, { error_id: id });
    }
  },
};
