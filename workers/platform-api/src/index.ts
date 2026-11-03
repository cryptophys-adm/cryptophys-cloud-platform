import { accessGate } from "../../control-plane-shared/src/access.ts";

export interface Env {
  PLATFORM_NAME: string;
  PLATFORM_ENVIRONMENT: string;
  API_CONTRACT_VERSION: string;
  CF_VERSION_METADATA?: { id: string; tag?: string };
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const blocked = await accessGate(request, env);
    if (blocked) return blocked;

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "method_not_allowed" }, 405);
    }

    if (url.pathname === "/health" || url.pathname === "/healthz") {
      return json(platformHealth(env));
    }

    if (url.pathname === "/ready" || url.pathname === "/readyz") {
      return json({ status: "ready", dependencies: [], service: env.PLATFORM_NAME });
    }

    if (url.pathname === "/") {
      return json({ service: env.PLATFORM_NAME, api_version: env.API_CONTRACT_VERSION, endpoints: ["/health", "/ready"], administrative_api: "not_implemented" });
    }

    return json({ error: "not_found" }, 404);
  },
};
