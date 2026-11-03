import type { BaseEnv, ExecutionContextLike, ScheduledEventLike } from "../../control-plane-shared/src/types.ts";
import {
  errorResponse, healthResponse, json, newId, nowIso, readJsonObject, requireAdmin, serviceMetadata, ACTOR, stringField,
  type JsonObject,
} from "../../control-plane-shared/src/http.ts";
import { appendAuditEvent, canonicalJson, sha256Hex } from "../../control-plane-shared/src/audit.ts";
import { boundedString, boundedStringArray, engineFor, type AiTask } from "../../control-plane-shared/src/ai-engine.ts";
import { readinessResponse } from "../../control-plane-shared/src/readiness.ts";
import { accessGate } from "../../control-plane-shared/src/access.ts";

/** RPC surface every platform Worker exports as `HealthRpc` (src/worker.ts). Not reachable over HTTP. */
export interface HealthRpcBinding {
  health(): Promise<{ status?: string; version?: { id?: string; tag?: string | null } | null }>;
}

export interface Env extends BaseEnv {
  SVC_PLATFORM_API: HealthRpcBinding;
  SVC_DEPLOYMENT_ORCHESTRATOR: HealthRpcBinding;
  SVC_PLATFORM_REGISTRY: HealthRpcBinding;
  SVC_POLICY_ENGINE: HealthRpcBinding;
  SVC_AUDIT_LEDGER: HealthRpcBinding;
  SVC_RECOVERY_MANAGER: HealthRpcBinding;
}

const SERVICE = "cryptophys-drift-detector";
const PROBE_TIMEOUT_MS = 5000;

/** Observation targets: service_id -> service binding (the detector observes itself directly). */
export function targets(env: Env): Record<string, HealthRpcBinding | undefined> {
  return {
    "cryptophys-platform-api": env.SVC_PLATFORM_API,
    "cryptophys-deployment-orchestrator": env.SVC_DEPLOYMENT_ORCHESTRATOR,
    "cryptophys-platform-registry": env.SVC_PLATFORM_REGISTRY,
    "cryptophys-policy-engine": env.SVC_POLICY_ENGINE,
    "cryptophys-audit-ledger": env.SVC_AUDIT_LEDGER,
    "cryptophys-recovery-manager": env.SVC_RECOVERY_MANAGER,
  };
}

interface Probe { reachable: boolean; healthy: boolean; version_tag: string | null; error: string | null }

async function probe(binding: HealthRpcBinding): Promise<Probe> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), PROBE_TIMEOUT_MS);
    });
    const body = await Promise.race([binding.health(), timeout]);
    return {
      reachable: true,
      healthy: body?.status === "ok",
      version_tag: typeof body?.version?.tag === "string" ? body.version.tag : null,
      error: body?.status === "ok" ? null : "health_check_failed",
    };
  } catch (err) {
    return { reachable: false, healthy: false, version_tag: null, error: String((err as Error)?.message) === "timeout" ? "timeout" : "rpc_failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ServiceDrift {
  service_id: string;
  desired_version: string | null;
  observed_version: string | null;
  drifted: boolean;
  managed: boolean;
  reasons: string[];
  status: string;
  observation_id: string;
  probe: Probe;
}

interface RegistryRow { service_id: string; desired_version: string | null; status: string }

/** Compare desired (registry) with observed (live health/version) for every registered service. */
export async function observe(env: Env, trigger: string, actor: string): Promise<{ run_id: string; observed_at: string; services: ServiceDrift[]; drifted: number }> {
  const runId = newId("drift");
  const observedAt = nowIso();
  const rows = await env.DB.prepare("SELECT service_id, desired_version, status FROM service_registry ORDER BY service_id").all<RegistryRow>();
  const map = targets(env);
  const services: ServiceDrift[] = [];
  for (const row of rows.results) {
    let p: Probe;
    if (row.service_id === SERVICE) {
      p = { reachable: true, healthy: true, version_tag: env.CF_VERSION_METADATA?.tag ?? null, error: null };
    } else if (map[row.service_id]) {
      p = await probe(map[row.service_id]!);
    } else {
      p = { reachable: false, healthy: false, version_tag: null, error: "no_observation_binding" };
    }
    const reasons: string[] = [];
    if (!p.healthy) reasons.push(p.error ?? "health_check_failed");
    const managed = Boolean(row.desired_version);
    if (!managed) reasons.push("desired_version_unset");
    else if (!p.version_tag) reasons.push("observed_version_unavailable");
    else if (p.version_tag !== row.desired_version) reasons.push("version_mismatch");
    const drifted = !p.healthy || (managed && p.version_tag !== row.desired_version);
    const status = row.status === "disabled" ? "disabled" : !p.healthy ? "unavailable" : drifted ? "degraded" : "healthy";
    const observationId = newId("obs");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        observationId, row.service_id,
        await sha256Hex(canonicalJson({ desired_version: row.desired_version, healthy: true })),
        await sha256Hex(canonicalJson({ desired_version: p.version_tag, healthy: p.healthy })),
        drifted ? 1 : 0,
        JSON.stringify({ run_id: runId, trigger, reasons, probe: p, desired_version: row.desired_version }),
        observedAt,
      ),
      env.DB.prepare("UPDATE service_registry SET observed_version = ?, status = ?, updated_at = ? WHERE service_id = ?")
        .bind(p.version_tag, status, observedAt, row.service_id),
    ]);
    services.push({ service_id: row.service_id, desired_version: row.desired_version, observed_version: p.version_tag, drifted, managed, reasons, status, observation_id: observationId, probe: p });
  }
  const drifted = services.filter((s) => s.drifted).length;
  await appendAuditEvent(env.DB, {
    event_type: "drift.observation",
    actor,
    subject: "control-plane",
    outcome: drifted ? "drift_detected" : "in_sync",
    payload: { run_id: runId, trigger, drifted: services.filter((s) => s.drifted).map((s) => ({ service_id: s.service_id, reasons: s.reasons })) },
  });
  return { run_id: runId, observed_at: observedAt, services, drifted };
}

interface Summary { summary: string; likely_causes: string[] }
const summaryTask: AiTask<Summary> = {
  name: "summarize_drift",
  instructions:
    'Summarize a computed drift report for operators. Return {"summary": at most 400 characters, "likely_causes": up to 4 strings of at most 160 characters}. ' +
    "Whether drift exists is already decided by the report; do not contradict it.",
  maxInputChars: 8000,
  maxOutputTokens: 300,
  validate(output) {
    const o = output as Record<string, unknown>;
    const summary = boundedString(o?.summary, 400);
    const causes = boundedStringArray(o?.likely_causes, 4, 160);
    return summary && causes ? { summary, likely_causes: causes } : null;
  },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const blocked = await accessGate(request, env);
    if (blocked) return blocked;
    const path = url.pathname;
    if (request.method === "GET" || request.method === "HEAD") {
      if (path === "/health" || path === "/healthz") return healthResponse(env);
      if (path === "/ready" || path === "/readyz") {
        const bindings = Object.values(targets(env)).every(Boolean);
        return readinessResponse(env, { observation_bindings: bindings });
      }
      if (path === "/") {
        return serviceMetadata(env, "Desired-versus-observed version and health comparison (scheduled every 15 minutes)", [
          "POST /v1/observe", "GET /v1/drift", "GET /v1/drift/{service_id}",
        ]);
      }
    }
    if (!path.startsWith("/v1/")) return errorResponse(404, "not_found");
    const denied = requireAdmin(request, env);
    if (denied) return denied;
    try {
      if (path === "/v1/observe" && request.method === "POST") {
        const body = await readJsonObject(request);
        if (!body.ok) return body.response;
        const actor = stringField(body.value, "actor", 128);
        if (actor instanceof Error || !ACTOR.test(actor as string)) return errorResponse(400, "invalid_request", "actor is required");
        const report = await observe(env, "manual", actor as string);
        const response: JsonObject = { ...report };
        if (url.searchParams.get("advisory") === "true") {
          response.advisory = await engineFor(env, SERVICE, [summaryTask.name]).run(summaryTask, report, report.run_id);
        }
        return json(response);
      }
      if (path === "/v1/drift" && request.method === "GET") {
        const rows = await env.DB.prepare(
          `SELECT o.service_id, o.observation_id, o.drifted, o.evidence_json, o.observed_at
           FROM drift_observations o
           WHERE o.observed_at = (SELECT MAX(i.observed_at) FROM drift_observations i WHERE i.service_id = o.service_id)
           ORDER BY o.service_id`,
        ).all<{ service_id: string; observation_id: string; drifted: number; evidence_json: string; observed_at: string }>();
        return json({ services: rows.results.map((r) => ({ ...r, drifted: r.drifted === 1, evidence_json: undefined, evidence: JSON.parse(r.evidence_json) })) });
      }
      const match = /^\/v1\/drift\/([a-z0-9-]{2,63})$/.exec(path);
      if (match && request.method === "GET") {
        const rows = await env.DB.prepare(
          "SELECT observation_id, drifted, evidence_json, observed_at FROM drift_observations WHERE service_id = ? ORDER BY observed_at DESC LIMIT 20",
        ).bind(match[1]).all<{ observation_id: string; drifted: number; evidence_json: string; observed_at: string }>();
        return json({ service_id: match[1], observations: rows.results.map((r) => ({ ...r, drifted: r.drifted === 1, evidence_json: undefined, evidence: JSON.parse(r.evidence_json) })) });
      }
      return errorResponse(404, "not_found");
    } catch (err) {
      const id = newId("err");
      console.error(JSON.stringify({ service: SERVICE, error_id: id, message: String((err as Error)?.message ?? err) }));
      return errorResponse(500, "internal_error", undefined, { error_id: id });
    }
  },

  async scheduled(_event: ScheduledEventLike, env: Env, ctx: ExecutionContextLike): Promise<void> {
    ctx.waitUntil(observe(env, "scheduled", SERVICE).then(() => undefined, (err) => {
      console.error(JSON.stringify({ service: SERVICE, event: "scheduled_observation_failed", message: String((err as Error)?.message ?? err) }));
    }));
  },
};
