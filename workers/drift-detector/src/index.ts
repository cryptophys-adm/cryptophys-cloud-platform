import { explainCode, serviceName } from "../../control-plane-shared/src/plain.ts";
import type { BaseEnv, ExecutionContextLike, ScheduledEventLike } from "../../control-plane-shared/src/types.ts";
import { verifyConsensusExecution } from "../../control-plane-shared/src/consensus-exec.ts";
import { publishAgentReport, type AgentRpcBinding } from "../../control-plane-shared/src/agents.ts";
import {
  errorResponse, healthResponse, json, newId, nowIso, serviceMetadata,
  type JsonObject,
} from "../../control-plane-shared/src/http.ts";
import { appendAuditEvent, canonicalJson, sha256Hex } from "../../control-plane-shared/src/audit.ts";
import { boundedString, boundedStringArray, engineFor, type AiTask } from "../../control-plane-shared/src/ai-engine.ts";
import { readinessResponse } from "../../control-plane-shared/src/readiness.ts";
import { accessGate, requireOperator } from "../../control-plane-shared/src/access.ts";

/** RPC surface every platform Worker exports as `HealthRpc` (src/worker.ts). Not reachable over HTTP. */
export interface HealthRpcBinding {
  health(): Promise<{ status?: string; version?: { id?: string; tag?: string | null } | null }>;
}

/** Plain service binding to an externally deployed Worker's fetch handler (no RPC entrypoint). */
export interface FetchBinding {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface Env extends BaseEnv {
  /** AI Kernel AgentRpc (ADR-0007 §1.1), pinned to host_worker = cryptophys-drift-detector. */
  AGENTS?: AgentRpcBinding;
  SVC_AI_KERNEL: HealthRpcBinding;
  SVC_CONSOLE: HealthRpcBinding;
  SVC_HOME: HealthRpcBinding;
  /** xauusd Workers, deployed from cryptophys-adm/xauusd-ai-trading-assistant (ADR-0005 decision 7). */
  EXT_XAUUSD_AI: FetchBinding;
  EXT_XAUUSD_NEWS: FetchBinding;
  EXT_XAUUSD_PULL_ADAPTER: FetchBinding;
  EXT_XAUUSD_NEXUS: FetchBinding;
  EXT_AETHER: FetchBinding;
  SVC_PLATFORM_API: HealthRpcBinding;
  SVC_DEPLOYMENT_ORCHESTRATOR: HealthRpcBinding;
  SVC_PLATFORM_REGISTRY: HealthRpcBinding;
  SVC_POLICY_ENGINE: HealthRpcBinding;
  SVC_AUDIT_LEDGER: HealthRpcBinding;
  SVC_RECOVERY_MANAGER: HealthRpcBinding;
}

const SERVICE = "cryptophys-drift-detector";
const PROBE_TIMEOUT_MS = 5000;
export const DRIFT_RETENTION_DAYS = 90;
const RETENTION_BATCH = 2000;
const RETENTION_MAX_BATCHES = 5;

/** Observation targets: service_id -> service binding (the detector observes itself directly). */
export function targets(env: Env): Record<string, HealthRpcBinding | undefined> {
  return {
    "cryptophys-platform-api": env.SVC_PLATFORM_API,
    "cryptophys-deployment-orchestrator": env.SVC_DEPLOYMENT_ORCHESTRATOR,
    "cryptophys-platform-registry": env.SVC_PLATFORM_REGISTRY,
    "cryptophys-policy-engine": env.SVC_POLICY_ENGINE,
    "cryptophys-audit-ledger": env.SVC_AUDIT_LEDGER,
    "cryptophys-recovery-manager": env.SVC_RECOVERY_MANAGER,
    "cryptophys-ai-kernel": env.SVC_AI_KERNEL,
    "cryptophys-console": env.SVC_CONSOLE,
    "cryptophys-home": env.SVC_HOME,
  };
}

/** Externally deployed Workers observed over HTTP through service bindings. */
export function externalTargets(env: Env): Record<string, FetchBinding | undefined> {
  return {
    "xauusd-ai-trading-assistant": env.EXT_XAUUSD_AI,
    "xauusd-fundamental-news-ingestion": env.EXT_XAUUSD_NEWS,
    "xauusd-tradingview-pull-adapter": env.EXT_XAUUSD_PULL_ADAPTER,
    "xauusd-nexus-dashboard": env.EXT_XAUUSD_NEXUS,
    "cryptophys-aether": env.EXT_AETHER,
  };
}

interface Probe { reachable: boolean; healthy: boolean; version_tag: string | null; error: string | null }

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), PROBE_TIMEOUT_MS); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * HTTP health of an external Worker. `/health` must return JSON `status: "ok"`; any other
 * path (a page without a health endpoint) must return 2xx. The version is not observable
 * from outside the Worker, so external services are health-managed only.
 */
async function probeHttp(binding: FetchBinding, path: string): Promise<Probe> {
  try {
    const res = await withTimeout(binding.fetch(`https://drift-probe.internal${path}`, { headers: { accept: "application/json" } }));
    let healthy = res.ok;
    if (healthy && path === "/health") {
      const body = await res.json().catch(() => null) as { status?: unknown } | null;
      healthy = body?.status === "ok";
    } else {
      await res.body?.cancel();
    }
    return { reachable: true, healthy, version_tag: null, error: healthy ? null : res.ok ? "health_check_failed" : `http_${res.status}` };
  } catch (err) {
    return { reachable: false, healthy: false, version_tag: null, error: String((err as Error)?.message) === "timeout" ? "timeout" : "fetch_failed" };
  }
}

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

interface RegistryRow { service_id: string; desired_version: string | null; status: string; metadata_json: string | null }

function healthPath(row: RegistryRow): string {
  try {
    const p = (JSON.parse(row.metadata_json ?? "{}") as { health_path?: unknown }).health_path;
    return typeof p === "string" && /^\/[A-Za-z0-9._\/-]{0,100}$/.test(p) ? p : "/health";
  } catch {
    return "/health";
  }
}

/**
 * ADR-0012 phase 2: read-only probe of one platform Worker, for the Orchestrator's rollback
 * verification (health and reported version tag). Writes nothing.
 */
export async function probeService(env: Env, serviceId: string): Promise<Probe> {
  const binding = targets(env)[serviceId];
  if (!binding) throw new Error("unknown_service");
  return probe(binding);
}

/** ADR-0009 phase 2: a passed observe_drift consensus action, re-verified here before it runs. */
export async function observeForConsensus(env: Env, proposalId: string, decisionId: string): Promise<{ run_id: string; drifted: number; services: number }> {
  await verifyConsensusExecution(env.DB, proposalId, decisionId, "observe_drift", "platform");
  const r = await observe(env, "consensus", `consensus:${proposalId}`);
  return { run_id: r.run_id, drifted: r.drifted, services: r.services.length };
}

/** Compare desired (registry) with observed (live health/version) for every registered service. */
export async function observe(env: Env, trigger: string, actor: string): Promise<{ run_id: string; observed_at: string; services: ServiceDrift[]; drifted: number }> {
  const runId = newId("drift");
  const observedAt = nowIso();
  const rows = await env.DB.prepare("SELECT service_id, desired_version, status, metadata_json FROM service_registry ORDER BY service_id").all<RegistryRow>();
  const map = targets(env);
  const external = externalTargets(env);
  const services: ServiceDrift[] = [];
  for (const row of rows.results) {
    if (row.status === "disabled") {
      const observationId = newId("obs");
      const p = { reachable: true, healthy: true, version_tag: null, error: null };
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          observationId, row.service_id,
          await sha256Hex(canonicalJson({ desired_version: row.desired_version, healthy: true })),
          await sha256Hex(canonicalJson({ desired_version: null, healthy: true })),
          0,
          JSON.stringify({ run_id: runId, trigger, reasons: ["disabled"], probe: p, desired_version: row.desired_version }),
          observedAt,
        ),
        env.DB.prepare("UPDATE service_registry SET observed_version = ?, status = ?, updated_at = ? WHERE service_id = ?")
          .bind(null, "disabled", observedAt, row.service_id),
      ]);
      services.push({ service_id: row.service_id, desired_version: row.desired_version, observed_version: null, drifted: false, managed: Boolean(row.desired_version), reasons: ["disabled"], status: "disabled", observation_id: observationId, probe: p });
      continue;
    }
    let p: Probe;
    if (row.service_id === SERVICE) {
      p = { reachable: true, healthy: true, version_tag: env.CF_VERSION_METADATA?.tag ?? null, error: null };
    } else if (map[row.service_id]) {
      p = await probe(map[row.service_id]!);
    } else if (external[row.service_id]) {
      p = await probeHttp(external[row.service_id]!, healthPath(row));
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
  if (drifted > 0 && trigger === "scheduled") {
    // Advisory: the Drift Detector's own agent (tier 1) reports scheduled drift. Deploy-time
    // observations (manual) are excluded; versions are in flux then. Never blocks observation.
    await publishAgentReport(env.AGENTS, "drift-detector", {
      kind: "platform_digest", severity: "warning",
      subject: driftSubject(services.filter((s) => s.drifted)),
      body: { explanation: services.filter((s) => s.drifted).map((s) => `${serviceName(s.service_id)}: ${s.reasons.map(explainCode).join("; ")}.`).join(" ").slice(0, 500), run_id: runId, observed_at: observedAt, drifted: services.filter((s) => s.drifted).map((s) => ({ service_id: s.service_id, reasons: s.reasons, desired: s.desired_version, observed: s.observed_version })) },
    });
  }
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
        const bindings = [...Object.values(targets(env)), ...Object.values(externalTargets(env))].every(Boolean);
        return readinessResponse(env, { observation_bindings: bindings });
      }
      if (path === "/") {
        return serviceMetadata(env, "Desired-versus-observed version and health comparison (scheduled every 15 minutes)", [
          "POST /v1/observe", "GET /v1/drift", "GET /v1/drift/{service_id}",
        ]);
      }
    }
    if (!path.startsWith("/v1/")) return errorResponse(404, "not_found");
    const operator = await requireOperator(request, env);
    if (!operator.ok) return operator.response;
    try {
      if (path === "/v1/observe" && request.method === "POST") {
        // The actor is the verified Access identity; the request body is not needed.
        const report = await observe(env, "manual", operator.actor);
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

  async scheduled(event: ScheduledEventLike, env: Env, ctx: ExecutionContextLike): Promise<void> {
    ctx.waitUntil(observe(env, "scheduled", SERVICE).then(() => undefined, (err) => {
      console.error(JSON.stringify({ service: SERVICE, event: "scheduled_observation_failed", message: String((err as Error)?.message ?? err) }));
    }));
    const d = new Date(event.scheduledTime);
    if (d.getUTCHours() === 3 && d.getUTCMinutes() === 0) {
      ctx.waitUntil(pruneDriftObservations(env, event.scheduledTime).then(() => undefined, (err) => {
        console.error(JSON.stringify({ service: SERVICE, event: "drift_retention_failed", message: String((err as Error)?.message ?? err) }));
      }));
    }
  },
};


export async function pruneDriftObservations(env: Env, now = Date.now()): Promise<{ deleted: number; cutoff: string; batches: number }> {
  const cutoff = new Date(now - DRIFT_RETENTION_DAYS * 86_400_000).toISOString();
  let deleted = 0;
  let batches = 0;
  for (let i = 0; i < RETENTION_MAX_BATCHES; i++) {
    const res = await env.DB.prepare(
      `DELETE FROM drift_observations WHERE observation_id IN (
         SELECT o.observation_id FROM drift_observations o
         WHERE o.observed_at < ?
           AND (SELECT COUNT(*) FROM drift_observations i WHERE i.service_id = o.service_id AND i.observed_at > o.observed_at) >= 2
         ORDER BY o.observed_at LIMIT ?)`,
    ).bind(cutoff, RETENTION_BATCH).run();
    const n = res.meta.changes ?? 0;
    deleted += n;
    batches++;
    if (n < RETENTION_BATCH) break;
  }
  if (deleted > 0) {
    await appendAuditEvent(env.DB, {
      event_type: "maintenance.retention",
      actor: "cryptophys-drift-detector",
      subject: "drift_observations",
      outcome: "deleted",
      payload: { deleted, cutoff, retention_days: 90, keep_newest_per_service: 2, decision: "owner 2026-11-05" },
    });
  }
  return { deleted, cutoff, batches };
}

/** Plain-English report title (2026-11-07): which services, not just how many. */
export function driftSubject(drifted: { service_id: string }[]): string {
  const names = drifted.map((s) => serviceName(s.service_id));
  const list = names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
  return `${list} ${names.length === 1 ? "is" : "are"} not running the expected version`.slice(0, 200);
}
