/**
 * cryptophys-platform-api: the public gateway of the AI Worker OS (ADR-0007).
 *
 * It owns its own AI engine (architecture/AI-ENGINE-REQUIREMENT.md): GET /v1/overview returns
 * the kernel's platform view (drift, ingestion, agent proposals, kill switch) over RPC, and
 * ?advisory=true adds a schema-validated AI summary. The overview itself never depends on AI.
 */
import { accessGate, accessConfigured, listConfigured, requireOperator } from "../../control-plane-shared/src/access.ts";
import { boundedString, boundedStringArray, engineFor, type AiTask } from "../../control-plane-shared/src/ai-engine.ts";
import { schemaReady } from "../../control-plane-shared/src/readiness.ts";
import type { AiBinding, D1Database } from "../../control-plane-shared/src/types.ts";

/** The kernel's read-only RPC surface (workers/ai-kernel/src/worker.ts KernelRpc). */
export interface KernelRpcBinding { overview(): Promise<Record<string, unknown>> }

export interface Env {
  PLATFORM_NAME: string;
  PLATFORM_ENVIRONMENT: string;
  API_CONTRACT_VERSION: string;
  CF_VERSION_METADATA?: { id: string; tag?: string };
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  OPERATOR_IDENTITIES?: string;
  DB?: D1Database;
  AI?: AiBinding;
  AI_MODEL?: string;
  AI_DAILY_REQUEST_LIMIT?: string;
  AI_ACCOUNT_DAILY_REQUEST_LIMIT?: string;
  KERNEL?: KernelRpcBinding;
}

const SERVICE = "cryptophys-platform-api";
const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: jsonHeaders });
}

/** Liveness payload, served over HTTP (/health) and over RPC (HealthRpc.health()). */
export function platformHealth(env: Env) {
  return {
    status: "ok" as const,
    service: env.PLATFORM_NAME,
    environment: env.PLATFORM_ENVIRONMENT,
    contract_version: env.API_CONTRACT_VERSION,
    version: env.CF_VERSION_METADATA ? { id: env.CF_VERSION_METADATA.id, tag: env.CF_VERSION_METADATA.tag ?? null } : null,
  };
}

interface Summary { summary: string; attention: string[] }
export const overviewTask: AiTask<Summary> = {
  name: "summarize_platform_overview",
  instructions:
    "Summarize the state of a Cloudflare Workers platform for its operator from the JSON given: drift per service, signal " +
    'ingestion runs, open agent proposals and whether agents are enabled. Return {"summary": at most 600 characters, ' +
    '"attention": up to 5 strings of at most 200 characters naming what needs a human}. Use only the data given. ' +
    "Never give trading advice and never claim an action was taken.",
  maxInputChars: 8000,
  maxOutputTokens: 400,
  validate(output) {
    const o = output as Record<string, unknown>;
    const summary = boundedString(o?.summary, 600);
    const attention = boundedStringArray(o?.attention, 5, 200);
    return summary && attention ? { summary, attention } : null;
  },
};

async function readiness(env: Env): Promise<Response> {
  const checks = {
    production_environment: env.PLATFORM_ENVIRONMENT === "production",
    database_schema: env.DB ? await schemaReady({ DB: env.DB } as never) : false,
    operator_identities_configured: listConfigured(env.OPERATOR_IDENTITIES),
    ai_binding: Boolean(env.AI),
    access_configured: accessConfigured(env),
    kernel_binding: Boolean(env.KERNEL),
  };
  const ready = Object.values(checks).every(Boolean);
  return json({ status: ready ? "ready" : "not_ready", service: env.PLATFORM_NAME, production_ready: ready, checks }, ready ? 200 : 503);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const blocked = await accessGate(request, env);
    if (blocked) return blocked;

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "method_not_allowed" }, 405);
    }
    if (url.pathname === "/health" || url.pathname === "/healthz") return json(platformHealth(env));
    if (url.pathname === "/ready" || url.pathname === "/readyz") return readiness(env);
    if (url.pathname === "/") {
      return json({ service: env.PLATFORM_NAME, api_version: env.API_CONTRACT_VERSION, endpoints: ["/health", "/ready", "/v1/overview[?advisory=true]"],
        operating_system: "AI Worker OS (ADR-0007): agents and the MCP front door live in cryptophys-ai-kernel" });
    }
    if (url.pathname === "/v1/overview") {
      const operator = await requireOperator(request, env);
      if (!operator.ok) return operator.response;
      if (!env.KERNEL) return json({ error: "kernel_unavailable" }, 503);
      let overview: Record<string, unknown>;
      try {
        overview = await env.KERNEL.overview();
      } catch {
        return json({ error: "kernel_unavailable" }, 503);
      }
      const body: Record<string, unknown> = { overview };
      if (url.searchParams.get("advisory") === "true" && env.DB) {
        body.advisory = await engineFor({ ...env, DB: env.DB }, SERVICE, [overviewTask.name]).run(overviewTask, overview, `overview:${Date.now()}`);
      }
      return json(body);
    }
    return json({ error: "not_found" }, 404);
  },
};
