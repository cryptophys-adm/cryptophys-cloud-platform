import type { BaseEnv } from "../../control-plane-shared/src/types.ts";
import type { AgentRpcBinding } from "../../control-plane-shared/src/agents.ts";
import {
  SERVICE_ID, VERSION_TAG, errorResponse, healthResponse, json, newId, nowIso, readJsonObject,
  serviceMetadata, stringField, type JsonObject,
} from "../../control-plane-shared/src/http.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { boundedString, boundedStringArray, type AiTask } from "../../control-plane-shared/src/ai-engine.ts";
import { readinessResponse } from "../../control-plane-shared/src/readiness.ts";
import { accessGate, authenticate, isOwner, requireApproverOrServiceOperator, requireOperator } from "../../control-plane-shared/src/access.ts";
import { verifyConsensusExecution } from "../../control-plane-shared/src/consensus-exec.ts";
import { unitForService } from "../../control-plane-shared/src/deploy-units.ts";
import { ORCHESTRATOR_SERVICE, RESCUE_EXECUTOR } from "../../control-plane-shared/src/executor-first.ts";
import { approvedBreakGlassPlan } from "../../control-plane-shared/src/break-glass.ts";
import { disableAccount, listAccounts, resyncLogin, upsertAccount, whoAmI, type AccountsEnv } from "./accounts.ts";

export type Env = AccountsEnv & { AGENTS?: AgentRpcBinding };

const SERVICE = "cryptophys-platform-registry";

interface ServiceRow {
  service_id: string;
  display_name: string;
  endpoint: string | null;
  desired_version: string | null;
  observed_version: string | null;
  environment: string;
  status: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface Tagging { tags: string[]; normalized_description: string }

/**
 * The Registry's own AI engine (AI-ENGINE-REQUIREMENT.md; its DNA declares this task). Advisory only. Its only
 * caller was PUT /v1/services/{id} (`?advisory=true`), removed 2026-11-15 by the owner with the Console's Edit form;
 * the engine stays declared until the owner rewires or retires it (as the Orchestrator's riskTask, 2026-11-14).
 */
export const tagTask: AiTask<Tagging> = {
  name: "suggest_tags",
  instructions:
    'Suggest inventory tags for a registered platform service. Return {"tags": up to 6 lowercase kebab-case strings, ' +
    '"normalized_description": one sentence of at most 200 characters}. Base it only on the supplied record.',
  maxInputChars: 4000,
  maxOutputTokens: 200,
  validate(output) {
    const o = output as Record<string, unknown>;
    const tags = boundedStringArray(o?.tags, 6, 40);
    const description = boundedString(o?.normalized_description, 200);
    if (!tags || !description || !tags.every((t) => /^[a-z0-9][a-z0-9-]*$/.test(t))) return null;
    return { tags, normalized_description: description };
  },
};

function present(row: ServiceRow): JsonObject {
  let metadata: unknown = {};
  try {
    metadata = JSON.parse(row.metadata_json);
  } catch {
    metadata = {};
  }
  const { metadata_json: _ignored, ...rest } = row;
  return { ...rest, metadata };
}

const getService = (env: Env, id: string) =>
  env.DB.prepare("SELECT * FROM service_registry WHERE service_id = ?").bind(id).first<ServiceRow>();

async function setDesiredVersion(request: Request, env: Env, id: string, actor: string): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  const version = stringField(body.value, "desired_version", 40);
  if (version instanceof Error) return errorResponse(400, "invalid_request", version.message);
  if (!VERSION_TAG.test(version as string)) return errorResponse(400, "invalid_request", "desired_version must be a lowercase hex commit identifier (7-40 chars)");
  const existing = await getService(env, id);
  if (!existing) return errorResponse(404, "service_not_registered");
  await env.DB.prepare("UPDATE service_registry SET desired_version = ?, updated_at = ? WHERE service_id = ?")
    .bind(version, nowIso(), id).run();
  await appendAuditEvent(env.DB, {
    event_type: "registry.desired_version_set",
    actor,
    subject: id,
    outcome: "success",
    payload: { previous: existing.desired_version, desired_version: version },
  });
  const saved = await getService(env, id);
  return json({ service: saved ? present(saved) : null });
}

/**
 * ADR-0012 phase 2: record the version a native rollback verified live as the desired version.
 * Accepted only for a native rollback request that the Orchestrator queued and is executing now
 * (status running, executor native:rollback, created within the hour). So this RPC cannot set an
 * arbitrary version.
 */
export async function recordRollback(env: Env, requestId: string): Promise<{ desired_version: string }> {
  if (!/^dep_[0-9a-f-]{36}$/.test(requestId)) throw new Error("invalid_request_id");
  const row = await env.DB.prepare("SELECT service_id, requested_version, status, details_json, created_at FROM deployment_requests WHERE request_id = ?")
    .bind(requestId).first<{ service_id: string; requested_version: string; status: string; details_json: string; created_at: string }>();
  if (!row) throw new Error("rollback_request_not_found");
  let details: { executor?: unknown } = {};
  try { details = JSON.parse(row.details_json || "{}"); } catch { details = {}; }
  if (details.executor !== "native:rollback") throw new Error("not_a_native_rollback");
  if (row.status !== "running") throw new Error("rollback_not_running");
  if (Date.now() - Date.parse(row.created_at) > 3_600_000) throw new Error("rollback_request_expired");
  const version = row.requested_version;
  if (!/^[0-9a-f]{12}$/.test(version)) throw new Error("invalid_version");
  const existing = await getService(env, row.service_id);
  if (!existing) throw new Error("service_not_registered");
  await env.DB.prepare("UPDATE service_registry SET desired_version = ?, updated_at = ? WHERE service_id = ?").bind(version, nowIso(), row.service_id).run();
  await appendAuditEvent(env.DB, {
    event_type: "registry.desired_version_set", actor: `rollback:${requestId}`, subject: row.service_id, outcome: "success",
    payload: { previous: existing.desired_version, desired_version: version },
  });
  return { desired_version: version };
}

/**
 * ADR-0012 G2b: the Orchestrator's native deploy records the commit it verified live, for every Worker of the
 * request's deploy unit (or a break-glass deploy's, hardening (d)). Accepted only for a running native deploy request of the last hour whose requested
 * version is a full commit sha; the desired version is its 12-character tag, as the deploy workflows record it.
 */
export async function recordNativeDeploy(env: Env, requestId: string): Promise<{ desired_version: string; services: string[] }> {
  if (!/^dep_[0-9a-f-]{36}$/.test(requestId)) throw new Error("invalid_request_id");
  const row = await env.DB.prepare("SELECT service_id, requested_version, status, details_json, created_at FROM deployment_requests WHERE request_id = ?")
    .bind(requestId).first<{ service_id: string; requested_version: string; status: string; details_json: string; created_at: string }>();
  if (!row) throw new Error("deploy_request_not_found");
  let details: { executor?: unknown; plan_id?: unknown } = {};
  try { details = JSON.parse(row.details_json || "{}"); } catch { details = {}; }
  // Hardening (d): an owner-approved break-glass deploy (native:break-glass) records its commit the same way.
  // Cut-over gate 2026-11-15: so does the Recovery Manager's rescue deploy, for the Orchestrator's Worker only, and only
  // for the executing, person-approved break-glass plan of that Worker at that commit (checked here, in this Worker).
  const rescue = details.executor === RESCUE_EXECUTOR;
  if (details.executor !== "native:deploy" && details.executor !== "native:break-glass" && !rescue) throw new Error("not_a_native_deploy");
  if (row.status !== "running") throw new Error("deploy_not_running");
  if (rescue) {
    if (row.service_id !== ORCHESTRATOR_SERVICE) throw new Error("rescue_not_the_orchestrator");
    const planId = typeof details.plan_id === "string" ? details.plan_id : "";
    const plan = await env.DB.prepare("SELECT service_id, status, plan_version, created_by, approved_by, steps_json FROM recovery_plans WHERE plan_id = ?").bind(planId)
      .first<{ service_id: string; status: string; plan_version: string; created_by: string | null; approved_by: string | null; steps_json: string | null }>();
    if (!plan || plan.status !== "executing" || plan.service_id !== ORCHESTRATOR_SERVICE || plan.plan_version !== row.requested_version || !approvedBreakGlassPlan(plan).ok) {
      throw new Error("rescue_plan_invalid");
    }
  }
  const age = Date.now() - Date.parse(row.created_at);
  if (!(age >= 0 && age <= 3_600_000)) throw new Error("deploy_request_expired");
  if (!/^[0-9a-f]{40}$/.test(row.requested_version)) throw new Error("invalid_version");
  const unit = unitForService(row.service_id);
  if (!unit) throw new Error("no_deploy_unit_for_service");
  const version = row.requested_version.slice(0, 12);
  const services = [...unit.services] as string[];
  const existing: ServiceRow[] = [];
  for (const id of services) {
    const svc = await getService(env, id);
    if (!svc) throw new Error("service_not_registered");
    existing.push(svc);
  }
  for (const svc of existing) {
    await env.DB.prepare("UPDATE service_registry SET desired_version = ?, updated_at = ? WHERE service_id = ?").bind(version, nowIso(), svc.service_id).run();
    await appendAuditEvent(env.DB, {
      event_type: "registry.desired_version_set", actor: `native-deploy:${requestId}`, subject: svc.service_id, outcome: "success",
      payload: { previous: svc.desired_version, desired_version: version },
    });
  }
  return { desired_version: version, services };
}

/**
 * ADR-0009 phase 2: apply a passed consensus action. The Registry re-verifies the proposal and
 * its Policy Engine decision itself (verifyConsensusExecution) before it writes anything.
 */
export async function applyConsensus(env: Env, proposalId: string, decisionId: string, action: string, target: string, params: Record<string, unknown>): Promise<JsonObject> {
  await verifyConsensusExecution(env.DB, proposalId, decisionId, action, target);
  const existing = await getService(env, target);
  if (!existing) throw new Error("service_not_registered");
  const actor = `consensus:${proposalId}`;
  if (action === "set_desired_version") {
    const version = String(params.version ?? "");
    if (!VERSION_TAG.test(version)) throw new Error("invalid_version");
    await env.DB.prepare("UPDATE service_registry SET desired_version = ?, updated_at = ? WHERE service_id = ?").bind(version, nowIso(), target).run();
    await appendAuditEvent(env.DB, { event_type: "registry.desired_version_set", actor, subject: target, outcome: "success", payload: { previous: existing.desired_version, desired_version: version } });
  } else if (action === "registry_disable_service" || action === "registry_enable_service") {
    const status = action === "registry_disable_service" ? "disabled" : "registered";
    await env.DB.prepare("UPDATE service_registry SET status = ?, updated_at = ? WHERE service_id = ?").bind(status, nowIso(), target).run();
    await appendAuditEvent(env.DB, { event_type: "registry.service_status_set", actor, subject: target, outcome: status, payload: { previous: existing.status } });
  } else {
    throw new Error("action_not_handled_by_registry");
  }
  const saved = await getService(env, target);
  return { service: saved ? present(saved) : null };
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
        return serviceMetadata(env, "Desired inventory and resource ownership metadata", [
          "GET /v1/services", "GET /v1/services/{service_id}",
          "PUT /v1/services/{service_id}/desired-version (approver, or the deploy workflows' service token)",
          "GET /v1/accounts/me (any Access identity)", "GET /v1/accounts", "POST /v1/accounts (owner, GRANT)",
          "POST /v1/accounts/{email}/disable (owner, REVOKE)", "POST /v1/accounts/sync-login (owner, SYNC)",
        ]);
      }
    }
    if (!path.startsWith("/v1/")) return errorResponse(404, "not_found");
    // Users page (2026-11-07). /me answers any valid identity (the Console asks it for every visitor);
    // writes need an owner (checked inside); the list is for owners, operators and viewers.
    if (path === "/v1/accounts" || path.startsWith("/v1/accounts/")) {
      if (path === "/v1/accounts/me" && request.method === "GET") return await whoAmI(request, env);
      const auth = await authenticate(request, env);
      if (!auth.ok) return auth.response;
      try {
        if (path === "/v1/accounts" && request.method === "GET") {
          if (!isOwner(auth.identity, env)) {
            const reader = await requireOperator(request, env);
            if (!reader.ok) return reader.response;
          }
          return await listAccounts(env);
        }
        if (path === "/v1/accounts" && request.method === "POST") return await upsertAccount(request, env, auth.identity);
        if (path === "/v1/accounts/sync-login" && request.method === "POST") return await resyncLogin(request, env, auth.identity);
        const acct = /^\/v1\/accounts\/([^/]{6,254})\/disable$/.exec(path);
        if (acct && request.method === "POST") return await disableAccount(request, env, auth.identity, decodeURIComponent(acct[1]).toLowerCase());
        return errorResponse(404, "not_found");
      } catch (err) {
        console.error(JSON.stringify({ event: "accounts_error", message: String((err as Error)?.message ?? err).slice(0, 200) }));
        return errorResponse(500, "internal_error");
      }
    }
    const match = /^\/v1\/services\/([^/]+)(\/desired-version)?$/.exec(path);
    // Changing what production should run (a desired version) is an approver's act for a person; the deploy
    // workflows (service token: record-desired-version.sh, deploy-control-plane.yml, rollback-worker.yml) record
    // versions as before. Reads stay with operators. A PUT of a bare record keeps the writers' gate and then answers
    // 405 (below), so a caller who may not write is still refused as before.
    const gate = match && request.method === "PUT" ? requireApproverOrServiceOperator : requireOperator;
    const operator = await gate(request, env);
    if (!operator.ok) return operator.response;
    try {
      if (path === "/v1/services" && request.method === "GET") {
        const rows = await env.DB.prepare("SELECT * FROM service_registry ORDER BY service_id").all<ServiceRow>();
        return json({ services: rows.results.map(present) });
      }
      if (!match) return errorResponse(404, "not_found");
      const id = decodeURIComponent(match[1]);
      if (!SERVICE_ID.test(id)) return errorResponse(400, "invalid_service_id");
      if (request.method === "PUT" && match[2]) return await setDesiredVersion(request, env, id, operator.actor);
      // Owner 2026-11-15 ("tombol Edit tidak berfungsi"): PUT /v1/services/{id} is gone. A service record comes from
      // the DNA, the census, migrations and consensus (registry_disable_service / registry_enable_service); a manual
      // edit conflicted with the DNA and created false drift. Nothing else called it.
      if (request.method === "PUT") return errorResponse(405, "method_not_allowed", "service records come from the DNA, the census, migrations and consensus; PUT /v1/services/{id} was removed (owner 2026-11-15)");
      if (match[2]) return errorResponse(405, "method_not_allowed");
      if (request.method === "GET") {
        const row = await getService(env, id);
        return row ? json({ service: present(row) }) : errorResponse(404, "service_not_registered");
      }
      return errorResponse(405, "method_not_allowed");
    } catch (err) {
      const id = newId("err");
      console.error(JSON.stringify({ service: SERVICE, error_id: id, message: String((err as Error)?.message ?? err) }));
      return errorResponse(500, "internal_error", undefined, { error_id: id });
    }
  },
};
