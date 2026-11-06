import type { BaseEnv, D1Database } from "../../control-plane-shared/src/types.ts";
import { publishAgentReport, type AgentRpcBinding } from "../../control-plane-shared/src/agents.ts";
import {
  ACTOR, COMMIT_SHA, SERVICE_ID, errorResponse, healthResponse, json, limitParam, newId, nowIso, readJsonObject, redact,
  serviceMetadata, stringField, type JsonObject,
} from "../../control-plane-shared/src/http.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { boundedString, engineFor, type AiTask } from "../../control-plane-shared/src/ai-engine.ts";
import { readinessResponse } from "../../control-plane-shared/src/readiness.ts";
import { accessGate, requireOperator } from "../../control-plane-shared/src/access.ts";
import { agentSyscallChecks } from "../../control-plane-shared/src/capabilities.ts";

export type Env = BaseEnv & { AGENTS?: AgentRpcBinding };

const SERVICE = "cryptophys-policy-engine";
export const ACTIONS = ["deploy", "recovery.execute", "registry.update", "agent.syscall", "consensus.execute"] as const;
export type PolicyAction = (typeof ACTIONS)[number];

export interface PolicyCheck { id: string; passed: boolean; detail: string }
export interface PolicyResult { decision: "allow" | "deny"; reason: string; checks: PolicyCheck[] }

const check = (id: string, passed: boolean, detail: string): PolicyCheck => ({ id, passed, detail });

/** Deterministic rule evaluation. AI is never consulted here. */
export async function evaluatePolicy(db: D1Database, action: string, resource: string, context: JsonObject): Promise<PolicyResult> {
  const checks: PolicyCheck[] = [];
  if (action === "deploy") {
    const svc = await db.prepare("SELECT status, environment FROM service_registry WHERE service_id = ?")
      .bind(resource).first<{ status: string; environment: string }>();
    checks.push(check("service_registered", Boolean(svc), "target Worker must exist in the Platform Registry"));
    checks.push(check("service_enabled", Boolean(svc) && svc!.status !== "disabled", "disabled services cannot be deployed"));
    checks.push(check("production_environment", svc?.environment === "production", "registry environment must be production"));
    checks.push(check("commit_sha_valid", typeof context.commit_sha === "string" && COMMIT_SHA.test(context.commit_sha), "full lowercase 40-character commit SHA"));
    checks.push(check("explicit_confirmation", context.confirm_production === "DEPLOY", "confirm_production must equal DEPLOY"));
    checks.push(check("ci_green", context.ci_green === true, "commit statuses and the latest run of every GitHub Actions workflow must be successful"));
  } else if (action === "recovery.execute") {
    const plan = await db.prepare("SELECT status, created_by, approved_by FROM recovery_plans WHERE plan_id = ?")
      .bind(resource).first<{ status: string; created_by: string | null; approved_by: string | null }>();
    checks.push(check("plan_exists", Boolean(plan), "recovery plan must exist"));
    checks.push(check("plan_approved", plan?.status === "approved", "plan status must be approved"));
    checks.push(check("separation_of_duties", Boolean(plan?.approved_by) && Boolean(plan?.created_by) && plan!.approved_by !== plan!.created_by,
      "approver must differ from the plan author"));
    checks.push(check("operator_acknowledged", context.operator_acknowledged === true, "the executing operator must acknowledge the blast radius"));
  } else if (action === "registry.update") {
    const m = (context.metadata ?? {}) as JsonObject;
    checks.push(check("service_id_valid", SERVICE_ID.test(resource), "service_id must be a lowercase identifier"));
    for (const key of ["owner", "purpose", "data_classification"]) {
      checks.push(check(`metadata_${key}`, typeof m[key] === "string" && Boolean((m[key] as string).trim()), `metadata.${key} is mandatory`));
    }
  } else if (action === "agent.syscall") {
    // AI Worker OS (ADR-0007): the resource is the capability; the subject must be agent:<id>.
    // Over HTTP the subject is the caller's Access identity, so a person cannot pose as an agent.
    checks.push(...(await agentSyscallChecks(db, String(context.__subject ?? ""), resource)));
  } else if (action === "consensus.execute") {
    // ADR-0009: the Policy Engine is a veto on every consensus outcome, whatever the vote.
    // The resource is "<action>:<target>"; the kernel passes the class it computed.
    const cls = String(context.class ?? "");
    const [act, ...rest] = resource.split(":");
    const target = rest.join(":");
    checks.push(check("class_known", cls === "routine" || cls === "critical", "class must be routine or critical"));
    checks.push(check("not_prohibited", cls !== "prohibited" && !/trad(e|ing)|order|wallet|withdraw|transfer|swap/i.test(resource), "prohibited actions never execute"));
    checks.push(check("consensus_passed", context.passed === true, "a simple majority of eligible voters must approve"));
    const ks = await db.prepare("SELECT value FROM kernel_controls WHERE control = 'agents_enabled'").first<{ value: string }>();
    checks.push(check("agents_enabled", ks?.value === "1", "the global agent kill switch must be on"));
    const now = Date.now();
    const hour = new Date(now - 3_600_000).toISOString();
    const day = new Date(now - 86_400_000).toISOString();
    const sameTarget = await db.prepare(
      "SELECT COUNT(*) AS n FROM consensus_proposals WHERE target = ? AND action = ? AND status IN ('executing','executed','shadow_passed') AND decided_at >= ?",
    ).bind(target, act, hour).first<{ n: number }>();
    checks.push(check("target_rate_limit", (sameTarget?.n ?? 0) === 0, "at most one executed action per action and target per hour"));
    const platform = await db.prepare(
      "SELECT COUNT(*) AS n FROM consensus_proposals WHERE action IN ('deploy_commit','rollback_worker_version','redeploy_desired_version') AND status IN ('executing','executed','shadow_passed') AND decided_at >= ?",
    ).bind(day).first<{ n: number }>();
    checks.push(check("platform_daily_limit", !["deploy_commit", "rollback_worker_version", "redeploy_desired_version"].includes(act) || (platform?.n ?? 0) < 6,
      "at most 6 deploys or rollbacks per day across the platform"));
  } else {
    checks.push(check("known_action", false, `action must be one of ${ACTIONS.join(", ")}`));
  }
  const failed = checks.filter((c) => !c.passed);
  return {
    decision: failed.length === 0 ? "allow" : "deny",
    reason: failed.length === 0 ? "all policy checks passed" : `failed: ${failed.map((c) => c.id).join(", ")}`,
    checks,
  };
}

interface Explanation { explanation: string }
const explainTask: AiTask<Explanation> = {
  name: "explain_decision",
  instructions:
    'Explain a deterministic policy decision to an operator. Return {"explanation": at most 500 characters}. ' +
    "Do not suggest that the decision could be different; you cannot change it.",
  maxInputChars: 6000,
  maxOutputTokens: 250,
  validate(output) {
    const explanation = boundedString((output as Record<string, unknown>)?.explanation, 500);
    return explanation ? { explanation } : null;
  },
};

export interface PolicyRequest { subject: string; action: string; resource: string; context: JsonObject }
export interface PolicyDecision extends PolicyResult { decision_id: string; action: string; resource: string }

/** Validate a policy request from any caller (HTTP body or RPC argument). */
export function parsePolicyRequest(b: JsonObject): PolicyRequest | Error {
  const subject = stringField(b, "subject", 128);
  const action = stringField(b, "action", 40);
  const resource = stringField(b, "resource", 200);
  for (const v of [subject, action, resource]) if (v instanceof Error) return v;
  if (!ACTOR.test(subject as string)) return new Error("subject contains unsupported characters");
  const context = (b.context ?? {}) as JsonObject;
  if (typeof context !== "object" || context === null || Array.isArray(context)) return new Error("context must be an object");
  return { subject: subject as string, action: action as string, resource: resource as string, context };
}

/** Evaluate, persist the decision with its evidence, and append it to the audit chain. */
export async function decide(env: Env, req: PolicyRequest): Promise<PolicyDecision> {
  // The subject is passed to the agent rules out of band; it is never read from caller context.
  const result = await evaluatePolicy(env.DB, req.action, req.resource, { ...req.context, __subject: req.subject });
  const decisionId = newId("dec");
  const evidence = { checks: result.checks, context: redact(req.context) };
  await env.DB.prepare(
    `INSERT INTO policy_decisions (decision_id, subject, action, resource, decision, reason, evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(decisionId, req.subject, req.action, req.resource, result.decision, result.reason, JSON.stringify(evidence), nowIso()).run();
  await appendAuditEvent(env.DB, {
    event_type: "policy.decision",
    actor: req.subject,
    subject: req.resource,
    outcome: result.decision,
    payload: { decision_id: decisionId, action: req.action, reason: result.reason },
  });
  if (result.decision === "deny" && req.action !== "agent.syscall" && req.context.deploy_verification !== true) {
    await publishAgentReport(env.AGENTS, "policy-engine", {
      kind: "platform_digest", severity: "warning",
      subject: `Policy denied ${req.action} on ${req.resource.slice(0, 100)}`,
      body: {
        decision_id: decisionId, action: req.action, resource: req.resource, reason: result.reason, subject: req.subject,
        failed_checks: result.checks.filter((c) => !c.passed).map((c) => c.id),
      },
    });
  }
  return { decision_id: decisionId, action: req.action, resource: req.resource, ...result };
}

async function evaluate(request: Request, env: Env, url: URL, actor: string): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  // Over HTTP the subject is the verified Access identity, never a self-declared name.
  const parsed = parsePolicyRequest({ ...body.value, subject: actor });
  if (parsed instanceof Error) return errorResponse(400, "invalid_request", parsed.message);
  const decision = await decide(env, parsed);
  const response: JsonObject = { ...decision };
  if (url.searchParams.get("advisory") === "true") {
    const { decision_id: _id, ...explained } = decision;
    response.advisory = await engineFor(env, SERVICE, [explainTask.name]).run(explainTask, explained, decision.decision_id);
  }
  return json(response, 200);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const blocked = await accessGate(request, env);
    if (blocked) return blocked;
    const path = url.pathname;
    if (request.method === "GET" || request.method === "HEAD") {
      if (path === "/health" || path === "/healthz") return healthResponse(env);
      if (path === "/ready" || path === "/readyz") return readinessResponse(env);
      if (path === "/") {
        return serviceMetadata(env, "Deterministic deployment, recovery, registry and agent syscall policy decisions", [
          "POST /v1/evaluate", "GET /v1/decisions", "GET /v1/decisions/{decision_id}",
        ]);
      }
    }
    if (!path.startsWith("/v1/")) return errorResponse(404, "not_found");
    const operator = await requireOperator(request, env);
    if (!operator.ok) return operator.response;
    try {
      if (path === "/v1/evaluate") return request.method === "POST" ? await evaluate(request, env, url, operator.actor) : errorResponse(405, "method_not_allowed");
      if (path === "/v1/decisions" && request.method === "GET") {
        const filters: string[] = [];
        const params: unknown[] = [];
        for (const key of ["subject", "resource", "action"]) {
          const value = url.searchParams.get(key);
          if (value) { filters.push(`${key} = ?`); params.push(value.slice(0, 200)); }
        }
        const rows = await env.DB.prepare(
          `SELECT * FROM policy_decisions ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`,
        ).bind(...params, limitParam(url)).all<Record<string, unknown>>();
        return json({ decisions: rows.results.map((r) => ({ ...r, evidence_json: undefined, evidence: JSON.parse(String(r.evidence_json)) })) });
      }
      const match = /^\/v1\/decisions\/(dec_[0-9a-f-]{36})$/.exec(path);
      if (match && request.method === "GET") {
        const row = await env.DB.prepare("SELECT * FROM policy_decisions WHERE decision_id = ?").bind(match[1]).first<Record<string, unknown>>();
        return row ? json({ decision: { ...row, evidence_json: undefined, evidence: JSON.parse(String(row.evidence_json)) } }) : errorResponse(404, "not_found");
      }
      return errorResponse(404, "not_found");
    } catch (err) {
      const id = newId("err");
      console.error(JSON.stringify({ service: SERVICE, error_id: id, message: String((err as Error)?.message ?? err) }));
      return errorResponse(500, "internal_error", undefined, { error_id: id });
    }
  },
};
