import { accessConfigured, accessGate, actorOf, identityAllowed, listConfigured, requireOperator } from "../../control-plane-shared/src/access.ts";
import { healthBody } from "../../control-plane-shared/src/http.ts";
import { INDEX_HTML, APP_CSS, APP_JS } from "./ui.ts";

export interface ServiceBinding { fetch(request: Request): Promise<Response> }

export interface Env {
  SERVICE_NAME: string;
  SERVICE_ENVIRONMENT: string;
  API_CONTRACT_VERSION: string;
  CF_VERSION_METADATA?: { id: string; tag?: string };
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  OPERATOR_IDENTITIES?: string;
  APPROVER_IDENTITIES?: string;
  PLATFORM?: ServiceBinding;
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};
const JSON_TYPE = "application/json; charset=utf-8";

function withSecurity(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

function json(data: unknown, status = 200): Response {
  return withSecurity(new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": JSON_TYPE } }));
}

function asset(body: string, type: string): Response {
  return withSecurity(new Response(body, { headers: { "content-type": type } }));
}

export function homeHealth(env: Env) {
  return healthBody(env);
}

function readiness(env: Env): Response {
  const checks = {
    production_environment: env.SERVICE_ENVIRONMENT === "production",
    access_configured: accessConfigured(env),
    operator_identities_configured: listConfigured(env.OPERATOR_IDENTITIES),
    platform_binding: Boolean(env.PLATFORM),
  };
  const ready = Object.values(checks).every(Boolean);
  return json({ status: ready ? "ready" : "not_ready", service: env.SERVICE_NAME, production_ready: ready, checks }, ready ? 200 : 503);
}

async function forward(request: Request, env: Env, jwt: string): Promise<Response> {
  let status: number;
  let response: Response;
  try {
    const binding = env.PLATFORM;
    if (!binding) throw new Error("binding_missing");
    const upstream = await binding.fetch(new Request("https://platform.internal/v1/overview", { method: "GET", headers: { "cf-access-jwt-assertion": jwt } }));
    status = upstream.status;
    const headers = new Headers();
    headers.set("content-type", JSON_TYPE);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    response = new Response(upstream.body, { status, headers });
  } catch {
    status = 502;
    response = json({ error: "upstream_unavailable", service: "platform" }, 502);
  }
  console.log(JSON.stringify({ event: "home_forward", status }));
  return response;
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/health" || path === "/healthz" || path === "/ready" || path === "/readyz") {
    const blocked = await accessGate(request, env);
    if (blocked) return blocked;
    if (method !== "GET" && method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
    return path.startsWith("/health") ? json(homeHealth(env)) : readiness(env);
  }

  const operator = await requireOperator(request, env);
  if (!operator.ok) return operator.response;

  if (method === "GET") {
    if (path === "/") return withSecurity(new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP } }));
    if (path === "/assets/app.js") return asset(APP_JS, "text/javascript; charset=utf-8");
    if (path === "/assets/app.css") return asset(APP_CSS, "text/css; charset=utf-8");
    if (path.startsWith("/assets/")) return json({ error: "not_found" }, 404);
  }

  if (!path.startsWith("/api/")) {
    if (method !== "GET" && method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
    return json({ error: "not_found" }, 404);
  }

  if (method !== "GET" && method !== "HEAD") return json({ error: "method_not_allowed" }, 405);

  const segments = path.split("/").slice(2);
  if (segments.length === 1 && segments[0] === "whoami") {
    return json({
      actor: actorOf(operator.identity),
      type: operator.identity.type,
      operator: true,
      approver: identityAllowed(operator.identity, env.APPROVER_IDENTITIES),
    });
  }

  if (segments.length === 3 && segments[0] === "platform" && segments[1] === "v1" && segments[2] === "overview") {
    return forward(request, env, request.headers.get("cf-access-jwt-assertion") as string);
  }

  return json({ error: "not_allowed" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return withSecurity(await handle(request, env));
  },
};
