import type { BaseEnv } from "../../control-plane-shared/src/types.ts";
import { publishAgentReport, type AgentRpcBinding } from "../../control-plane-shared/src/agents.ts";
import {
  SERVICE_ID, VERSION_TAG, errorResponse, healthResponse, json, newId, nowIso, readJsonObject,
  serviceMetadata, stringField, type JsonObject,
} from "../../control-plane-shared/src/http.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { boundedString, boundedStringArray, engineFor, type AiTask } from "../../control-plane-shared/src/ai-engine.ts";
import { readinessResponse } from "../../control-plane-shared/src/readiness.ts";
import { accessGate, authenticate, isOwner, requireOperator } from "../../control-plane-shared/src/access.ts";
import { verifyConsensusExecution } from "../../control-plane-shared/src/consensus-exec.ts";
import { disableAccount, listAccounts, resyncLogin, upsertAccount, whoAmI, type AccountsEnv } from "./accounts.ts";

export type Env = AccountsEnv & { AGENTS?: AgentRpcBinding };

const SERVICE = "cryptophys-platform-registry";
const ENVIRONMENTS = ["development", "preview", "production"];
const STATUSES = ["registered", "healthy", "degraded", "unavailable", "disabled"];
const CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"];

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

const tagTask: AiTask<Tagging> = {
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

async function upsertService(request: Request, env: Env, id: string, url: URL, actor: string): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  const b = body.value;
  const displayName = stringField(b, "display_name", 120);
  const environment = stringField(b, "environment", 20);
  const status = stringField(b, "status", 20);
  const endpoint = stringField(b, "endpoint", 300, false);
  for (const v of [displayName, environment, status, endpoint]) if (v instanceof Error) return errorResponse(400, "invalid_request", v.message);
  if (!ENVIRONMENTS.includes(environment as string)) return errorResponse(400, "invalid_request", `environment must be one of ${ENVIRONMENTS.join(", ")}`);
  if (!STATUSES.includes(status as string)) return errorResponse(400, "invalid_request", `status must be one of ${STATUSES.join(", ")}`);
  if (endpoint && !/^https:\/\/[A-Za-z0-9.-]+(\/[\w./-]*)?$/.test(endpoint as string)) return errorResponse(400, "invalid_request", "endpoint must be an https URL");

  const metadata = b.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return errorResponse(400, "invalid_request", "metadata object is required");
  const m = metadata as JsonObject;
  // RESOURCE-OWNERSHIP.md: owner, purpose and data classification are mandatory.
  for (const key of ["owner", "purpose", "data_classification"]) {
    if (typeof m[key] !== "string" || !(m[key] as string).trim()) return errorResponse(400, "invalid_request", `metadata.${key} is required`);
  }
  if (!CLASSIFICATIONS.includes(m.data_classification as string)) {
    return errorResponse(400, "invalid_request", `metadata.data_classification must be one of ${CLASSIFICATIONS.join(", ")}`);
  }
  const metadataJson = JSON.stringify(metadata);
  if (metadataJson.length > 8192) return errorResponse(413, "payload_too_large", "metadata exceeds 8192 characters");

  const existing = await getService(env, id);
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO service_registry (service_id, display_name, endpoint, desired_version, observed_version, environment, status, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
     ON CONFLICT(service_id) DO UPDATE SET display_name = excluded.display_name, endpoint = excluded.endpoint,
       environment = excluded.environment, status = excluded.status, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`,
  ).bind(id, displayName, endpoint ?? null, environment, status, metadataJson, now, now).run();
  await appendAuditEvent(env.DB, {
    event_type: existing ? "registry.service_updated" : "registry.service_registered",
    actor,
    subject: id,
    outcome: "success",
    payload: { environment, status, endpoint: endpoint ?? null, metadata },
  });
  if (existing === null) {
    await publishAgentReport(env.AGENTS, "platform-registry", {
      kind: "platform_digest", severity: "info",
      subject: `Service ${id} registered (${environment})`,
      body: { service_id: id, environment, status, actor },
    });
  } else if (existing.status !== "disabled" && status === "disabled") {
    await publishAgentReport(env.AGENTS, "platform-registry", {
      kind: "platform_digest", severity: "warning",
      subject: `Service ${id} disabled`,
      body: { service_id: id, environment, previous_status: existing.status, actor },
    });
  }
  const saved = await getService(env, id);
  const response: JsonObject = { service: saved ? present(saved) : null };
  if (url.searchParams.get("advisory") === "true" && saved) {
    response.advisory = await engineFor(env, SERVICE, [tagTask.name]).run(tagTask, present(saved), newId("corr"));
  }
  return json(response, existing ? 200 : 201);
}

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
          "GET /v1/services", "GET /v1/services/{service_id}", "PUT /v1/services/{service_id}",
          "PUT /v1/services/{service_id}/desired-version",
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
    const operator = await requireOperator(request, env);
    if (!operator.ok) return operator.response;
    try {
      if (path === "/v1/services" && request.method === "GET") {
        const rows = await env.DB.prepare("SELECT * FROM service_registry ORDER BY service_id").all<ServiceRow>();
        return json({ services: rows.results.map(present) });
      }
      const match = /^\/v1\/services\/([^/]+)(\/desired-version)?$/.exec(path);
      if (!match) return errorResponse(404, "not_found");
      const id = decodeURIComponent(match[1]);
      if (!SERVICE_ID.test(id)) return errorResponse(400, "invalid_service_id");
      if (match[2]) {
        return request.method === "PUT" ? await setDesiredVersion(request, env, id, operator.actor) : errorResponse(405, "method_not_allowed");
      }
      if (request.method === "GET") {
        const row = await getService(env, id);
        return row ? json({ service: present(row) }) : errorResponse(404, "service_not_registered");
      }
      if (request.method === "PUT") return await upsertService(request, env, id, url, operator.actor);
      return errorResponse(405, "method_not_allowed");
    } catch (err) {
      const id = newId("err");
      console.error(JSON.stringify({ service: SERVICE, error_id: id, message: String((err as Error)?.message ?? err) }));
      return errorResponse(500, "internal_error", undefined, { error_id: id });
    }
  },
};
