import type { AiBinding, D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { boundedString, boundedStringArray, engineFor, type AiTask } from "../../control-plane-shared/src/ai-engine.ts";
import { schemaReady } from "../../control-plane-shared/src/readiness.ts";
import { accessConfigured, accessGate } from "../../control-plane-shared/src/access.ts";

interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}
export interface Env {
  SERVICE_NAME: string;
  SERVICE_ENVIRONMENT: string;
  API_CONTRACT_VERSION: string;
  GH_ACTIONS_TOKEN: string;
  ORCHESTRATOR_SHARED_SECRET: string;
  DEPLOYMENT_LOCK: DurableObjectNamespaceLike;
  CF_VERSION_METADATA?: { id: string; tag?: string };
  /** Shared control-plane D1: deployment ledger, audit log and AI budget. */
  DB: D1Database;
  /** Dedicated Deployment Orchestrator AI engine (advisory only). */
  AI?: AiBinding;
  AI_MODEL?: string;
  AI_DAILY_REQUEST_LIMIT?: string;
  AI_ACCOUNT_DAILY_REQUEST_LIMIT?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

const SERVICE = "cryptophys-deployment-orchestrator";
const TARGET_SERVICE = "cryptophys-platform-api";
const ACTOR = /^[A-Za-z0-9._@:-]{1,128}$/;

interface RiskSummary { summary: string; risk_level: "low" | "medium" | "high"; notes: string[] }

/** Advisory only: never consulted for authorization, CI gating, locking or dispatch. */
const riskTask: AiTask<RiskSummary> = {
  name: "summarize_deployment_risk",
  instructions:
    'Summarize an already-dispatched production deployment for operators from the supplied evidence. Return ' +
    '{"summary": at most 400 characters, "risk_level": "low" | "medium" | "high", "notes": up to 4 strings of at most 160 characters}.',
  maxInputChars: 8000,
  maxOutputTokens: 300,
  validate(output) {
    const o = output as Record<string, unknown>;
    const summary = boundedString(o?.summary, 400);
    const notes = boundedStringArray(o?.notes, 4, 160);
    const level = o?.risk_level;
    if (!summary || !notes || (level !== "low" && level !== "medium" && level !== "high")) return null;
    return { summary, risk_level: level, notes };
  }
};

/** Best-effort audit for rejections; a failure here must not change the response. */
async function auditQuietly(env: Env, event: Parameters<typeof appendAuditEvent>[1]): Promise<string | null> {
  try {
    return (await appendAuditEvent(env.DB, event)).event_id;
  } catch (err) {
    console.error(JSON.stringify({ service: SERVICE, event: "audit_write_failed", message: String((err as Error)?.message ?? err) }));
    return null;
  }
}

const REPOSITORY = "cryptophys-adm/cryptophys-cloud-platform";
const WORKFLOW = "deploy-platform-api.yml";
const API = "https://api.github.com";
const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers });

async function authorized(request: Request, secret: string): Promise<boolean> {
  const supplied = request.headers.get("authorization") ?? "";
  if (!secret || !supplied.startsWith("Bearer ")) return false;
  const a = new TextEncoder().encode(supplied.slice(7));
  const b = new TextEncoder().encode(secret);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function gh(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(API + path, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + token,
      "x-github-api-version": "2022-11-28",
      "user-agent": "cryptophys-deployment-orchestrator",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers
    }
  });
}

type CommitStatus = { state?: string; total_count?: number };
type WorkflowRun = { workflow_id: number; name: string; status: string; conclusion: string | null; run_number: number; run_attempt?: number };

/** Latest run of each workflow: a superseded failed run does not block a later successful one. */
export function latestRunPerWorkflow(runs: WorkflowRun[]): WorkflowRun[] {
  const latest = new Map<number, WorkflowRun>();
  for (const run of runs) {
    const seen = latest.get(run.workflow_id);
    if (!seen || run.run_number > seen.run_number || (run.run_number === seen.run_number && (run.run_attempt ?? 1) > (seen.run_attempt ?? 1))) {
      latest.set(run.workflow_id, run);
    }
  }
  return [...latest.values()];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const blocked = await accessGate(request, env);
    if (blocked) return blocked;

    if (request.method === "GET" && ["/health", "/healthz"].includes(url.pathname)) {
      return json({
        status: "ok",
        service: env.SERVICE_NAME,
        environment: env.SERVICE_ENVIRONMENT,
        contract_version: env.API_CONTRACT_VERSION,
        version: env.CF_VERSION_METADATA ? { id: env.CF_VERSION_METADATA.id, tag: env.CF_VERSION_METADATA.tag ?? null } : null
      });
    }

    if (request.method === "GET" && ["/ready", "/readyz"].includes(url.pathname)) {
      const checks = {
        production_environment: env.SERVICE_ENVIRONMENT === "production",
        github_token_configured: Boolean(env.GH_ACTIONS_TOKEN),
        shared_secret_configured: Boolean(env.ORCHESTRATOR_SHARED_SECRET),
        deployment_lock_binding: Boolean(env.DEPLOYMENT_LOCK),
        database_schema: Boolean(env.DB) && await schemaReady(env as never),
        ai_binding: Boolean(env.AI),
        access_configured: accessConfigured(env)
      };
      const ready = Object.values(checks).every(Boolean);
      return json({
        status: ready ? "ready" : "not_configured",
        service: env.SERVICE_NAME,
        production_dispatch_enabled: ready,
        checks
      }, ready ? 200 : 503);
    }

    if (url.pathname !== "/v1/deployments") return json({ error: "not_found" }, 404);
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (env.SERVICE_ENVIRONMENT !== "production") {
      return json({ error: "production_worker_required", production_dispatch_enabled: false }, 503);
    }
    if (!(await authorized(request, env.ORCHESTRATOR_SHARED_SECRET))) {
      return json({ error: "unauthorized" }, 401);
    }
    if (!env.GH_ACTIONS_TOKEN || !env.DEPLOYMENT_LOCK || !env.DB) {
      return json({ error: "not_configured", operational: false }, 503);
    }

    let body: { commit_sha?: unknown; confirm_production?: unknown; requested_by?: unknown };
    try {
      body = await request.json() as typeof body;
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const sha = typeof body.commit_sha === "string" ? body.commit_sha : "";
    if (!/^[0-9a-f]{40}$/.test(sha)) return json({ error: "invalid_commit_sha" }, 400);
    if (body.confirm_production !== "DEPLOY") {
      return json({ error: "production_confirmation_required" }, 400);
    }
    const requestedBy = body.requested_by === undefined ? "orchestrator-client" : body.requested_by;
    if (typeof requestedBy !== "string" || !ACTOR.test(requestedBy)) return json({ error: "invalid_requested_by" }, 400);

    const refResponse = await gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/git/ref/heads/main");
    if (!refResponse.ok) {
      return json({ error: "github_ref_lookup_failed", status: refResponse.status }, 502);
    }
    const refData = await refResponse.json() as { object?: { sha?: string } };
    if (refData.object?.sha !== sha) {
      await auditQuietly(env, { event_type: "deployment.rejected", actor: requestedBy, subject: TARGET_SERVICE, outcome: "commit_not_current_main", payload: { commit_sha: sha, main_sha: refData.object?.sha ?? null } });
      return json({ error: "commit_not_current_main", expected_sha: refData.object?.sha ?? null }, 409);
    }

    // CI gate (owner decision, option B): the combined commit status plus the latest GitHub
    // Actions run of every workflow on this commit. Both are readable by a fine-grained PAT
    // (Commit statuses: Read, Actions: Read); the Checks API is not.
    const [statusResponse, workflowRunsResponse] = await Promise.all([
      gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/commits/" + sha + "/status"),
      gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/actions/runs?head_sha=" + sha + "&per_page=100")
    ]);
    if (!statusResponse.ok || !workflowRunsResponse.ok) {
      // Report which lookup failed and GitHub's status so a missing token permission is diagnosable.
      // The gate still fails closed; no token or response body is echoed.
      return json({
        error: "github_ci_lookup_failed",
        lookups: {
          commit_status: { http_status: statusResponse.status, required_permission: "Commit statuses: Read" },
          workflow_runs: { http_status: workflowRunsResponse.status, required_permission: "Actions: Read" }
        }
      }, 502);
    }

    const statusData = await statusResponse.json() as CommitStatus;
    const runsData = await workflowRunsResponse.json() as { total_count?: number; workflow_runs?: WorkflowRun[] };
    const allRuns = runsData.workflow_runs ?? [];
    const runs = latestRunPerWorkflow(allRuns);

    const statusBlocked = (statusData.total_count ?? 0) > 0 && statusData.state !== "success";
    const runsBlocked =
      runs.length === 0 ||
      (runsData.total_count ?? 0) > allRuns.length ||
      runs.some(run => run.status !== "completed" || run.conclusion !== "success");

    if (statusBlocked || runsBlocked) {
      await auditQuietly(env, {
        event_type: "deployment.rejected", actor: requestedBy, subject: TARGET_SERVICE, outcome: "ci_not_green",
        payload: { commit_sha: sha, commit_status: statusData.state ?? "unknown", blocking_workflows: runs.filter((r) => r.status !== "completed" || r.conclusion !== "success").map((r) => r.name) }
      });
      return json({
        error: "ci_not_green",
        commit_status: statusData.state ?? "unknown",
        status_count: statusData.total_count ?? 0,
        workflow_runs_reported: allRuns.length,
        workflow_runs_total: runsData.total_count ?? 0,
        workflows: runs.map(({ name, status, conclusion }) => ({ name, status, conclusion }))
      }, 409);
    }

    // Durable ledger entry first: the (service_id, idempotency_key) UNIQUE constraint is a
    // second duplicate guard alongside the Durable Object lock.
    const requestId = "dep_" + crypto.randomUUID();
    const createdAt = new Date().toISOString();
    try {
      await env.DB.prepare(
        `INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'approved', NULL, ?, ?, ?, ?)`
      ).bind(requestId, TARGET_SERVICE, sha, requestedBy, sha,
        JSON.stringify({ workflow: WORKFLOW, ref: "main", workflows: runs.map(({ name, conclusion }) => ({ name, conclusion })) }),
        createdAt, createdAt).run();
    } catch (err) {
      if (/UNIQUE constraint failed/i.test(String((err as Error)?.message ?? err))) {
        return json({ error: "duplicate_production_deployment_request", commit_sha: sha }, 409);
      }
      return json({ error: "deployment_ledger_unavailable", operational: false }, 503);
    }

    const lockId = env.DEPLOYMENT_LOCK.idFromName("platform-api-production:" + sha);
    const lockResponse = await env.DEPLOYMENT_LOCK.get(lockId).fetch("https://lock.internal/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha })
    });
    const lock = await lockResponse.json() as { claimed?: boolean };
    if (!lockResponse.ok || !lock.claimed) {
      return json({ error: "duplicate_production_deployment_request", commit_sha: sha }, 409);
    }

    // Production workflow has GitHub environment protection; reviewer approval must remain authoritative.
    const dispatch = await gh(
      env.GH_ACTIONS_TOKEN,
      "/repos/" + REPOSITORY + "/actions/workflows/" + WORKFLOW + "/dispatches",
      { method: "POST", body: JSON.stringify({ ref: "main", inputs: { confirm_production: "DEPLOY", commit_sha: sha } }) }
    );
    const finalStatus = dispatch.status === 204 ? "running" : "failed";
    await env.DB.prepare("UPDATE deployment_requests SET status = ?, updated_at = ? WHERE request_id = ?")
      .bind(finalStatus, new Date().toISOString(), requestId).run().catch(() => undefined);
    const auditEventId = await auditQuietly(env, {
      event_type: dispatch.status === 204 ? "deployment.dispatched" : "deployment.dispatch_failed",
      actor: requestedBy, subject: TARGET_SERVICE, outcome: finalStatus,
      payload: { request_id: requestId, commit_sha: sha, workflow: WORKFLOW, github_status: dispatch.status }
    });

    if (dispatch.status !== 204) {
      return json({
        request_id: requestId,
        error: "production_dispatch_failed",
        status: dispatch.status,
        commit_sha: sha,
        manual_reconciliation_required: true
      }, 502);
    }

    const advisory = url.searchParams.get("advisory") === "true"
      ? await engineFor(env, SERVICE, [riskTask.name]).run(riskTask, {
          commit_sha: sha,
          target: TARGET_SERVICE,
          workflows: runs.map(({ name, conclusion }) => ({ name, conclusion })),
          commit_status: statusData.state ?? "unknown"
        }, requestId)
      : undefined;

    return json({
      request_id: requestId,
      audit_event_id: auditEventId,
      status: "production_dispatch_accepted",
      repository: REPOSITORY,
      workflow: WORKFLOW,
      ref: "main",
      requested_commit_sha: sha,
      production_deployment_triggered: true,
      ...(advisory ? { advisory } : {})
    }, 202);
  }
};

export class DeploymentLock {
  private readonly state: DurableObjectStateLike;

  constructor(state: DurableObjectStateLike) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/claim") {
      return json({ error: "not_found" }, 404);
    }
    let body: { sha?: unknown };
    try {
      body = await request.json() as typeof body;
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const sha = typeof body.sha === "string" ? body.sha : "";
    if (!/^[0-9a-f]{40}$/.test(sha)) return json({ error: "invalid_commit_sha" }, 400);

    return this.state.blockConcurrencyWhile(async () => {
      const key = "claimed:" + sha;
      if (await this.state.storage.get(key)) return json({ claimed: false }, 409);
      await this.state.storage.put(key, { sha, claimed_at: new Date().toISOString() });
      return json({ claimed: true }, 201);
    });
  }
}
