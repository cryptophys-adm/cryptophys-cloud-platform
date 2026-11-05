/**
 * cryptophys-console: the operator Console backend-for-frontend (ADR-0008 §3, TP-023).
 *
 * It has no authority of its own. Every request needs the operator's Access JWT, and an
 * allow-listed /api/{service}/… request is forwarded to the platform Worker's fetch handler
 * through a Service Binding carrying that same JWT and nothing else. The target Worker
 * verifies it and enforces the operator rule, approver rule and separation of duties.
 */
import { accessConfigured, accessGate, actorOf, identityAllowed, listConfigured, requireOperator } from "../../control-plane-shared/src/access.ts";
import { MAX_BODY_BYTES, healthBody } from "../../control-plane-shared/src/http.ts";
import { APP_CSS, APP_JS, INDEX_HTML } from "./ui.ts";

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
  KERNEL?: ServiceBinding;
  RECOVERY?: ServiceBinding;
  REGISTRY?: ServiceBinding;
  POLICY?: ServiceBinding;
  DRIFT?: ServiceBinding;
  AUDIT?: ServiceBinding;
  ORCHESTRATOR?: ServiceBinding;
  PLATFORM?: ServiceBinding;
}

export type ConsoleService = "kernel" | "recovery" | "registry" | "policy" | "drift" | "audit" | "orchestrator" | "platform";

/** URL service name -> binding name. */
export const SERVICE_BINDINGS: Record<ConsoleService, keyof Env> = {
  kernel: "KERNEL",
  recovery: "RECOVERY",
  registry: "REGISTRY",
  policy: "POLICY",
  drift: "DRIFT",
  audit: "AUDIT",
  orchestrator: "ORCHESTRATOR",
  platform: "PLATFORM",
};

export interface AllowRule { service: ConsoleService; method: string; path: string }

const rows = (service: ConsoleService, method: string, paths: string[]): AllowRule[] => paths.map((path) => ({ service, method, path }));

/**
 * ADR-0008 §3 / TP-023 §3: every route the Console may forward. `{id}` is one safe segment.
 * Nothing else is forwarded: not the kernel's /mcp, not the audit ledger's POST /v1/events.
 */
export const CONSOLE_ALLOW_LIST: readonly AllowRule[] = [
  ...rows("kernel", "GET", ["/v1/kernel", "/v1/status", "/v1/reports", "/v1/agents", "/v1/agents/{id}", "/v1/agents/{id}/actions"]),
  ...rows("kernel", "POST", ["/v1/kernel/agents-enabled", "/v1/agents/{id}/wake", "/v1/agents/{id}/suspend", "/v1/agents/{id}/resume", "/v1/agents/{id}/principals"]),
  ...rows("kernel", "DELETE", ["/v1/agents/{id}/principals/{id}"]),
  ...rows("recovery", "GET", ["/v1/plans", "/v1/plans/{id}"]),
  ...rows("recovery", "POST", ["/v1/plans", "/v1/plans/{id}/approve", "/v1/plans/{id}/executions", "/v1/plans/{id}/disable"]),
  ...rows("registry", "GET", ["/v1/services", "/v1/services/{id}"]),
  ...rows("registry", "PUT", ["/v1/services/{id}", "/v1/services/{id}/desired-version"]),
  ...rows("policy", "GET", ["/v1/decisions", "/v1/decisions/{id}"]),
  ...rows("policy", "POST", ["/v1/evaluate"]),
  ...rows("drift", "GET", ["/v1/drift", "/v1/drift/{id}"]),
  ...rows("drift", "POST", ["/v1/observe"]),
  ...rows("audit", "GET", ["/v1/events", "/v1/events/{id}", "/v1/verify"]),
  ...rows("orchestrator", "POST", ["/v1/deployments"]),
  ...rows("platform", "GET", ["/v1/overview"]),
];

const SEGMENT = /^[A-Za-z0-9._@+:-]{1,128}$/;
const MAX_QUERY_CHARS = 512;
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

function asset(body: string, type: string, extra: Record<string, string> = {}): Response {
  return withSecurity(new Response(body, { headers: { "content-type": type, ...extra } }));
}

/** Liveness payload, served over HTTP (/health) and over RPC (HealthRpc.health()). */
export function consoleHealth(env: Env) {
  return healthBody(env);
}

const bindingNames = Object.values(SERVICE_BINDINGS);

function readiness(env: Env): Response {
  const checks = {
    production_environment: env.SERVICE_ENVIRONMENT === "production",
    access_configured: accessConfigured(env),
    operator_identities_configured: listConfigured(env.OPERATOR_IDENTITIES),
    approver_identities_configured: listConfigured(env.APPROVER_IDENTITIES),
    service_bindings: bindingNames.every((name) => Boolean(env[name])),
  };
  const ready = Object.values(checks).every(Boolean);
  return json({ status: ready ? "ready" : "not_ready", service: env.SERVICE_NAME, production_ready: ready, checks }, ready ? 200 : 503);
}

/** Match concrete segments against the allow-list; returns the rule or null. */
function matchRule(service: string, method: string, segments: string[]): AllowRule | null {
  for (const rule of CONSOLE_ALLOW_LIST) {
    if (rule.service !== service || rule.method !== method) continue;
    const pattern = rule.path.split("/").slice(1);
    if (pattern.length !== segments.length) continue;
    if (pattern.every((p, i) => p === "{id}" || p === segments[i])) return rule;
  }
  return null;
}

async function forward(request: Request, env: Env, url: URL, jwt: string, rule: AllowRule): Promise<Response> {
  const method = request.method;
  const isGet = method === "GET";

  let body: ArrayBuffer | undefined;
  if (!isGet) {
    if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
    if (bytes.byteLength > 0) {
      if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
        return json({ error: "unsupported_media_type" }, 415);
      }
      body = bytes;
    }
  }

  if (isGet && url.search.length > MAX_QUERY_CHARS) return json({ error: "invalid_query" }, 400);

  const headers: Record<string, string> = { "cf-access-jwt-assertion": jwt };
  if (body) headers["content-type"] = "application/json";
  const target = `https://console.internal${url.pathname.replace(/^\/api\/[^/]+/, "")}${isGet ? url.search : ""}`;

  let status: number;
  let response: Response;
  try {
    const binding = env[SERVICE_BINDINGS[rule.service]] as ServiceBinding | undefined;
    if (!binding) throw new Error("binding_missing");
    const upstream = await binding.fetch(new Request(target, { method, headers, body }));
    status = upstream.status;
    response = withSecurity(new Response(upstream.body, { status, headers: { "content-type": JSON_TYPE } }));
  } catch {
    status = 502;
    response = json({ error: "upstream_unavailable", service: rule.service }, 502);
  }
  console.log(JSON.stringify({ event: "console_forward", service: rule.service, method, route: rule.path, status }));
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
    return path.startsWith("/health") ? json(consoleHealth(env)) : readiness(env);
  }

  const operator = await requireOperator(request, env);
  if (!operator.ok) return operator.response;

  if (method === "GET") {
    if (path === "/") return asset(INDEX_HTML, "text/html; charset=utf-8", { "content-security-policy": CSP });
    if (path === "/assets/app.js") return asset(APP_JS, "text/javascript; charset=utf-8");
    if (path === "/assets/app.css") return asset(APP_CSS, "text/css; charset=utf-8");
  }

  if (!path.startsWith("/api/")) return json({ error: "not_found" }, 404);

  // Path safety applies to every /api path before any routing.
  if (path.includes("%")) return json({ error: "invalid_path" }, 400);
  const segments = path.split("/").slice(2);
  if (segments.some((s) => s === "." || s === ".." || !SEGMENT.test(s))) return json({ error: "invalid_path" }, 400);

  if (segments.length === 1 && segments[0] === "whoami") {
    if (method !== "GET") return json({ error: "not_allowed" }, 404);
    return json({
      actor: actorOf(operator.identity),
      type: operator.identity.type,
      operator: true,
      approver: identityAllowed(operator.identity, env.APPROVER_IDENTITIES),
    });
  }

  const [service, ...rest] = segments;
  const rule = rest.length > 0 ? matchRule(service, method, rest) : null;
  if (!rule) return json({ error: "not_allowed" }, 404);

  if (method !== "GET" && method !== "HEAD") {
    const origin = request.headers.get("origin");
    if (!origin || origin !== url.origin || request.headers.get("x-cryptophys-console") !== "1") {
      return json({ error: "csrf" }, 403);
    }
  }

  return forward(request, env, url, request.headers.get("cf-access-jwt-assertion") as string, rule);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return withSecurity(await handle(request, env));
  },
};
