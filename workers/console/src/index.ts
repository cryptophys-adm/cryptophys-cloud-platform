/**
 * cryptophys-console: the operator Console backend-for-frontend (ADR-0008 §3, TP-023).
 *
 * It has no authority of its own. Every request needs the operator's Access JWT, and an
 * allow-listed /api/{service}/… request is forwarded to the platform Worker's fetch handler
 * through a Service Binding carrying that same JWT and nothing else. The target Worker
 * verifies it and enforces the operator rule, approver rule and separation of duties.
 */
import { accessConfigured, accessGate, actorOf, authenticate, identityAllowed, listConfigured, type AccessIdentity } from "../../control-plane-shared/src/access.ts";
import { CONSOLE_ACCESS_HEADER, SWITCH_ACCOUNT_PATH, deniedPage, switchAccountPage, wantsHtml } from "./denied.ts";
import { MAX_BODY_BYTES, healthBody } from "../../control-plane-shared/src/http.ts";

export interface ServiceBinding { fetch(request: Request): Promise<Response> }

/** Workers Static Assets: the built Console SPA (workers/console/ui/dist), served only after the operator check. */
export interface AssetsBinding { fetch(request: Request): Promise<Response> }

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
  /** ADR-0012: the Forge (platform source on Cloudflare Artifacts), read-only from the Console. */
  FORGE?: ServiceBinding;
  /** Aether, the Knowledge Guardian cluster (cryptophys-adm/cryptophys-aether): its read-only overview for the Knowledge page. */
  AETHER?: ServiceBinding;
  ASSETS?: AssetsBinding;
  /** ADR-0010: the one public origin. The Console lives at <NEXUS_ORIGIN>/console/. */
  NEXUS_ORIGIN?: string;
  /** ADR-0010: retired hostnames that redirect to the Nexus mount (comma-separated). */
  LEGACY_HOSTS?: string;
}

/** ADR-0010: the Console is mounted under this path on the Nexus host (Workers route nexus.cryptophys.work/console*). */
export const MOUNT = "/console";

export type ConsoleService = "kernel" | "recovery" | "registry" | "policy" | "drift" | "audit" | "orchestrator" | "platform" | "forge" | "aether";

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
  forge: "FORGE",
  aether: "AETHER",
};

export interface AllowRule { service: ConsoleService; method: string; path: string }

const rows = (service: ConsoleService, method: string, paths: string[]): AllowRule[] => paths.map((path) => ({ service, method, path }));

/**
 * ADR-0008 §3 / TP-023 §3: every route the Console may forward. `{id}` is one safe segment.
 * Nothing else is forwarded: not the kernel's /mcp, not the audit ledger's POST /v1/events.
 */
export const CONSOLE_ALLOW_LIST: readonly AllowRule[] = [
  ...rows("kernel", "GET", ["/v1/kernel", "/v1/status", "/v1/notices", "/v1/owner/inbox", "/v1/reports", "/v1/agents", "/v1/agents/{id}", "/v1/agents/{id}/actions", "/v1/consensus", "/v1/consensus/report", "/v1/consensus/{id}", "/v1/knowledge", "/v1/metabolism", "/v1/mesh"]),
  ...rows("kernel", "POST", ["/v1/kernel/agents-enabled", "/v1/agents/{id}/wake", "/v1/agents/{id}/suspend", "/v1/agents/{id}/resume", "/v1/agents/{id}/principals", "/v1/consensus/{id}/approve", "/v1/consensus/{id}/reject", "/v1/consensus/mode", "/v1/knowledge/{id}/approve", "/v1/knowledge/{id}/reject", "/v1/reports/{id}/acknowledge"]),
  ...rows("kernel", "DELETE", ["/v1/agents/{id}/principals/{id}"]),
  ...rows("recovery", "GET", ["/v1/plans", "/v1/plans/{id}"]),
  // Hardening 2026-11-08: manual START/FINISH of executions left the Console; the AI runs approved plans.
  ...rows("recovery", "POST", ["/v1/plans", "/v1/plans/{id}/approve", "/v1/plans/{id}/disable"]),
  ...rows("registry", "GET", ["/v1/services", "/v1/services/{id}", "/v1/accounts"]),
  ...rows("registry", "POST", ["/v1/accounts", "/v1/accounts/sync-login", "/v1/accounts/{id}/disable"]),
  ...rows("registry", "PUT", ["/v1/services/{id}", "/v1/services/{id}/desired-version"]),
  ...rows("policy", "GET", ["/v1/decisions", "/v1/decisions/{id}"]),
  ...rows("policy", "POST", ["/v1/evaluate"]),
  ...rows("drift", "GET", ["/v1/drift", "/v1/drift/{id}"]),
  ...rows("drift", "POST", ["/v1/observe"]),
  ...rows("audit", "GET", ["/v1/events", "/v1/events/{id}", "/v1/verify"]),
  ...rows("orchestrator", "GET", ["/v1/deployments"]),
  ...rows("orchestrator", "POST", ["/v1/deployments"]),
  ...rows("platform", "GET", ["/v1/overview", "/v1/usage"]),
  // ADR-0012 phase 1b: the Code page reads the Forge (no write route is forwarded); phase 3 adds checks, phase 4 change requests.
  ...rows("aether", "GET", ["/v1/overview"]),
  ...rows("forge", "GET", ["/v1/forge/status", "/v1/forge/commits", "/v1/forge/checks", "/v1/forge/changes", "/v1/forge/deploy-plans", "/v1/forge/census", "/v1/forge/build-usage", "/v1/forge/dependency-audit", "/v1/forge/git-backup"]),
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

/**
 * The SPA shell and its hashed bundles, from Workers Static Assets (run_worker_first, so this
 * runs only after requireOperator). The upstream body and content type are kept; every other
 * header is replaced by the security headers and the strict CSP.
 */
async function uiAsset(request: Request, env: Env, innerPath: string): Promise<Response> {
  if (!env.ASSETS) return json({ error: "ui_unavailable" }, 503);
  const assetUrl = new URL(request.url);
  assetUrl.pathname = innerPath;
  const upstream = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: request.method }));
  const headers = new Headers({ "content-security-policy": CSP });
  const type = upstream.headers.get("content-type");
  if (type) headers.set("content-type", type);
  return withSecurity(new Response(upstream.body, { status: upstream.status, headers }));
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
    ui_assets: Boolean(env.ASSETS),
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

/**
 * Who may open the Cerebrum Console (owner decision 2026-11-07): configured operators and owners,
 * and accounts of kind 'admin' (viewer, operator or approver) from the Users page. Accounts of kind
 * 'user' sign in to Nexus but not the Console. The Console holds no role data of its own: it asks
 * the Platform Registry (/v1/accounts/me) with the caller's own Access JWT. A failed lookup refuses.
 */
export interface ConsoleRole { role: "approver" | "operator" | "viewer"; owner: boolean; source: "config" | "account" }
/** `deniedActor` is set when the caller is signed in but has no Console access (the fallback page). */
type Gate = { ok: true; identity: AccessIdentity; role: ConsoleRole } | { ok: false; response: Response; deniedActor?: string };

async function consoleGate(request: Request, env: Env): Promise<Gate> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return auth;
  if (!listConfigured(env.OPERATOR_IDENTITIES)) return { ok: false, response: json({ error: "operator_identities_not_configured" }, 503) };
  const owner = auth.identity.type === "user" && identityAllowed(auth.identity, env.APPROVER_IDENTITIES);
  if (identityAllowed(auth.identity, env.OPERATOR_IDENTITIES)) {
    return { ok: true, identity: auth.identity, role: { role: owner ? "approver" : "operator", owner, source: "config" } };
  }
  if (owner) return { ok: true, identity: auth.identity, role: { role: "approver", owner: true, source: "config" } };
  if (auth.identity.type === "user" && env.REGISTRY) {
    try {
      const r = await env.REGISTRY.fetch(new Request("https://cryptophys-platform-registry.internal/v1/accounts/me", {
        headers: { "cf-access-jwt-assertion": request.headers.get("cf-access-jwt-assertion") as string },
      }));
      if (r.ok) {
        const me = await r.json() as { role?: string };
        if (me.role === "viewer" || me.role === "operator" || me.role === "approver") {
          return { ok: true, identity: auth.identity, role: { role: me.role, owner: false, source: "account" } };
        }
      }
    } catch {
      // fall through: refuse
    }
  }
  // The header tells the UI that this is the Console's own gate (downstream Workers also answer
  // "forbidden", for role checks); forwarded responses never carry it.
  const denied = json({ error: "forbidden", detail: "the Cerebrum Console is for admin accounts" }, 403);
  denied.headers.set(CONSOLE_ACCESS_HEADER, "denied");
  return { ok: false, deniedActor: actorOf(auth.identity), response: denied };
}

async function forward(request: Request, env: Env, url: URL, innerPath: string, jwt: string, rule: AllowRule): Promise<Response> {
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
  const target = `https://console.internal${innerPath.replace(/^\/api\/[^/]+/, "")}${isGet ? url.search : ""}`;

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

/**
 * ADR-0010 (single subdomain): requests arrive either on the Nexus host under /console/ (a Workers
 * route on nexus.cryptophys.work/console*), on workers.dev (with or without the prefix), or on a
 * retired hostname, which is redirected to the Nexus mount. Returns the path inside the Console,
 * or a response to send as is.
 */
function mount(url: URL, env: Env, method: string): { inner: string } | { response: Response } {
  const raw = url.pathname;
  const legacy = (env.LEGACY_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const isHealth = /^\/(health|healthz|ready|readyz)$/.test(raw);
  if (legacy.includes(url.hostname.toLowerCase()) && !isHealth && env.NEXUS_ORIGIN) {
    // The old hash routes (#/recovery...) survive: browsers re-attach the fragment after a redirect.
    const target = `${env.NEXUS_ORIGIN.replace(/\/$/, "")}${MOUNT}${raw === "/" ? "/" : raw}${url.search}`;
    return { response: new Response(null, { status: method === "GET" || method === "HEAD" ? 301 : 308, headers: { location: target } }) };
  }
  if (raw === MOUNT) return { response: new Response(null, { status: 301, headers: { location: `${MOUNT}/${url.search}` } }) };
  if (raw.startsWith(`${MOUNT}/`)) return { inner: raw.slice(MOUNT.length) };
  return { inner: raw };
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  const mounted = mount(url, env, method);
  if ("response" in mounted) return mounted.response;
  const path = mounted.inner;

  if (path === "/health" || path === "/healthz" || path === "/ready" || path === "/readyz") {
    const blocked = await accessGate(request, env);
    if (blocked) return blocked;
    if (method !== "GET" && method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
    return path.startsWith("/health") ? json(consoleHealth(env)) : readiness(env);
  }

  // Switch account: any signed-in person may sign out, including those the Console refuses.
  if (path === SWITCH_ACCOUNT_PATH) {
    const blocked = await accessGate(request, env);
    if (blocked) return blocked;
    if (method !== "GET" && method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
    return switchAccountPage(url.pathname.startsWith(`${MOUNT}/`) ? MOUNT : "", env.ACCESS_TEAM_DOMAIN, method);
  }

  const operator = await consoleGate(request, env);
  if (!operator.ok) {
    // A signed-in person without Console access who opens a page gets a page, not JSON: who they
    // are, and a way to switch to an account that has access. API calls keep the JSON 403.
    if (operator.deniedActor && !path.startsWith("/api/") && (method === "GET" || method === "HEAD") && wantsHtml(request)) {
      return deniedPage(operator.deniedActor, env.NEXUS_ORIGIN, method, url.pathname.startsWith(`${MOUNT}/`) ? MOUNT : "");
    }
    return operator.response;
  }

  if (!path.startsWith("/api/")) {
    if (method !== "GET" && method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
    return uiAsset(request, env, path);
  }

  // Path safety applies to every /api path before any routing.
  if (path.includes("%")) return json({ error: "invalid_path" }, 400);
  const segments = path.split("/").slice(2);
  if (segments.some((s) => s === "." || s === ".." || !SEGMENT.test(s))) return json({ error: "invalid_path" }, 400);

  if (segments.length === 1 && segments[0] === "whoami") {
    if (method !== "GET") return json({ error: "not_allowed" }, 404);
    return json({
      actor: actorOf(operator.identity),
      type: operator.identity.type,
      role: operator.role.role,
      operator: operator.role.role !== "viewer",
      approver: operator.role.role === "approver" && operator.identity.type === "user",
      owner: operator.role.owner,
      viewer: operator.role.role === "viewer",
    });
  }

  const [service, ...rest] = segments;
  const rule = rest.length > 0 ? matchRule(service, method, rest) : null;
  if (!rule) return json({ error: "not_allowed" }, 404);

  // A viewer reads only; the downstream Worker refuses too, this just fails early and clearly.
  if (operator.role.role === "viewer" && method !== "GET" && method !== "HEAD") return json({ error: "viewer_read_only" }, 403);

  if (method !== "GET" && method !== "HEAD") {
    const origin = request.headers.get("origin");
    if (!origin || origin !== url.origin || request.headers.get("x-cryptophys-console") !== "1") {
      return json({ error: "csrf" }, 403);
    }
  }

  return forward(request, env, url, path, request.headers.get("cf-access-jwt-assertion") as string, rule);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return withSecurity(await handle(request, env));
  },
};
