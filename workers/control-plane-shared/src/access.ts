/**
 * Cloudflare Access enforcement inside the Worker (ADR-0004 decision 5, as amended).
 *
 * Every Worker hostname is protected by a Cloudflare Access application. Access
 * forwards authenticated requests with a signed `Cf-Access-Jwt-Assertion` JWT; this
 * module verifies it (RS256 against the team's published keys, audience, issuer,
 * expiry) so that a misconfigured or bypassed edge policy still fails closed.
 *
 * There is no exception: every HTTP request needs a valid JWT. Worker-to-Worker calls
 * use RPC service bindings (`WorkerEntrypoint` classes), which are not reachable over
 * HTTP at all.
 */

export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

export interface AccessIdentity {
  /** Email for people, or the service token's common_name for automation. */
  subject: string;
  type: "user" | "service_token";
}

const CLOCK_SKEW_SECONDS = 60;
const JWKS_TTL_MS = 10 * 60 * 1000;
const TEAM_DOMAIN = /^[a-z0-9-]+\.cloudflareaccess\.com$/;

type Jwk = JsonWebKey & { kid?: string };
let jwksCache: { domain: string; keys: Jwk[]; fetchedAt: number } | null = null;

/** Test hook: forget cached signing keys. */
export function resetAccessKeyCache(): void {
  jwksCache = null;
}


export function accessConfigured(env: AccessEnv): boolean {
  return Boolean(env.ACCESS_AUD && env.ACCESS_TEAM_DOMAIN && TEAM_DOMAIN.test(env.ACCESS_TEAM_DOMAIN));
}

function b64urlBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(input: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlBytes(input)));
  } catch {
    return null;
  }
}

async function signingKeys(domain: string, forceRefresh: boolean): Promise<Jwk[]> {
  if (!forceRefresh && jwksCache && jwksCache.domain === domain && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`access certs HTTP ${res.status}`);
  const body = await res.json() as { keys?: Jwk[] };
  const keys = (body.keys ?? []).filter((k) => k.kty === "RSA");
  jwksCache = { domain, keys, fetchedAt: Date.now() };
  return keys;
}

export type AccessResult = { ok: true; identity: AccessIdentity } | { ok: false; reason: string };

/** Verify a Cloudflare Access JWT. Never throws. */
export async function verifyAccessJwt(token: string, env: AccessEnv, nowSeconds = Math.floor(Date.now() / 1000)): Promise<AccessResult> {
  if (!accessConfigured(env)) return { ok: false, reason: "access_not_configured" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed_token" };
  const header = b64urlJson(parts[0]);
  const claims = b64urlJson(parts[1]);
  if (!header || !claims) return { ok: false, reason: "malformed_token" };
  if (header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, reason: "unsupported_algorithm" };

  const domain = env.ACCESS_TEAM_DOMAIN!;
  let keys: Jwk[];
  try {
    keys = await signingKeys(domain, false);
    if (!keys.some((k) => k.kid === header.kid)) keys = await signingKeys(domain, true); // key rotation
  } catch {
    return { ok: false, reason: "signing_keys_unavailable" };
  }
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: "unknown_signing_key" };

  try {
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signature = b64urlBytes(parts[2]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature as BufferSource,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return { ok: false, reason: "invalid_signature" };
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.ACCESS_AUD)) return { ok: false, reason: "wrong_audience" };
  if (claims.iss !== `https://${domain}`) return { ok: false, reason: "wrong_issuer" };
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) return { ok: false, reason: "expired" };
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds) return { ok: false, reason: "not_yet_valid" };

  if (typeof claims.email === "string" && claims.email) return { ok: true, identity: { subject: claims.email, type: "user" } };
  if (typeof claims.common_name === "string" && claims.common_name) {
    return { ok: true, identity: { subject: claims.common_name, type: "service_token" } };
  }
  return { ok: false, reason: "no_identity" };
}

const denied = (status: number, error: string) =>
  new Response(JSON.stringify({ error }, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });

export type Authentication = { ok: true; identity: AccessIdentity } | { ok: false; response: Response };

/** Verify the request's Access JWT and return the authenticated identity or a denial. */
export async function authenticate(request: Request, env: AccessEnv): Promise<Authentication> {
  if (!accessConfigured(env)) return { ok: false, response: denied(503, "access_not_configured") };
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return { ok: false, response: denied(403, "access_denied") };
  const result = await verifyAccessJwt(token, env);
  if (!result.ok) {
    console.warn(JSON.stringify({ event: "access_denied", reason: result.reason }));
    return { ok: false, response: denied(403, "access_denied") };
  }
  return { ok: true, identity: result.identity };
}

/** Returns a denial Response, or null when the request carries a valid Access JWT. */
export async function accessGate(request: Request, env: AccessEnv): Promise<Response | null> {
  const auth = await authenticate(request, env);
  return auth.ok ? null : auth.response;
}

/**
 * Is the verified identity in a comma-separated allow-list of service-token Client IDs
 * and/or operator emails? Emails compare case-insensitively; an empty list allows nobody.
 */
export function identityAllowed(identity: AccessIdentity, allowList: string | undefined): boolean {
  const allowed = (allowList ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  return allowed.some((entry) => identity.type === "user"
    ? entry.toLowerCase() === identity.subject.toLowerCase()
    : entry === identity.subject);
}

/** The audit/actor name of a verified identity: emails normalized to lower case, Client IDs verbatim. */
export function actorOf(identity: AccessIdentity): string {
  return identity.type === "user" ? identity.subject.toLowerCase() : identity.subject;
}

export type Authorization = { ok: true; identity: AccessIdentity; actor: string } | { ok: false; response: Response };

/**
 * Authenticate the Access JWT and require the identity to be in `allowList`. There is
 * no shared bearer token: the verified identity is both the credential and the actor
 * recorded in the audit chain. An unset list fails closed with 503.
 */
export async function authorize(request: Request, env: AccessEnv, allowList: string | undefined, listName: string): Promise<Authorization> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return auth;
  if (!listConfigured(allowList)) return { ok: false, response: denied(503, `${listName.toLowerCase()}_not_configured`) };
  if (!identityAllowed(auth.identity, allowList)) {
    console.warn(JSON.stringify({ event: "identity_not_authorized", list: listName, type: auth.identity.type }));
    return { ok: false, response: denied(403, "forbidden") };
  }
  return { ok: true, identity: auth.identity, actor: actorOf(auth.identity) };
}

export function listConfigured(allowList: string | undefined): boolean {
  return (allowList ?? "").split(",").some((v) => v.trim().length > 0);
}

// ---------------------------------------------------------------------------------------------
// Roles (owner decision 2026-11-07, migration 0026). The configured identities stay the root of
// trust: APPROVER_IDENTITIES are the owners (people), OPERATOR_IDENTITIES the operators and the CI
// service token. People added in the Cerebrum Console's Users page live in platform_accounts:
// kind 'admin' with a privilege (viewer | operator | approver) may use the control plane, and kind
// 'user' may only sign in to Nexus. A lookup error fails closed (no role).

export type Role = "approver" | "operator" | "viewer" | "user";
export interface RoleEnv extends AccessEnv {
  OPERATOR_IDENTITIES?: string;
  APPROVER_IDENTITIES?: string;
  DB?: { prepare(sql: string): { bind(...v: unknown[]): { first<T>(): Promise<T | null> } } };
}
export interface RoleResolution { role: Role | null; source: "config" | "account" | null; owner: boolean }

/** An owner: a person in APPROVER_IDENTITIES. Only owners manage accounts. */
export function isOwner(identity: AccessIdentity, env: RoleEnv): boolean {
  return identity.type === "user" && identityAllowed(identity, env.APPROVER_IDENTITIES);
}

/** The role a Users page account grants, or null (configured identities are not accounts). */
async function accountRole(env: RoleEnv, identity: AccessIdentity): Promise<Role | null> {
  // Configured identities are authoritative and must never inherit a stale account row.
  if (identity.type !== "user" || !env.DB || isOwner(identity, env) || identityAllowed(identity, env.OPERATOR_IDENTITIES)) return null;
  try {
    const row = await env.DB.prepare("SELECT kind, privilege FROM platform_accounts WHERE email = ? AND status = 'active'")
      .bind(identity.subject.toLowerCase()).first<{ kind: string; privilege: string | null }>();
    if (!row) return null;
    if (row.kind === "user") return "user";
    if (row.privilege === "viewer" || row.privilege === "operator" || row.privilege === "approver") return row.privilege;
  } catch (e) {
    console.warn(JSON.stringify({ event: "role_lookup_failed", message: String((e as Error)?.message ?? e).slice(0, 200) }));
  }
  return null;
}

/** The highest role, for display (whoami). Authorization uses requireOperator / requireApprover. */
export async function roleOf(env: RoleEnv, identity: AccessIdentity): Promise<RoleResolution> {
  if (isOwner(identity, env)) return { role: "approver", source: "config", owner: true };
  if (identityAllowed(identity, env.OPERATOR_IDENTITIES)) return { role: "operator", source: "config", owner: false };
  const role = await accountRole(env, identity);
  return { role, source: role ? "account" : null, owner: false };
}

const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * Operators of the control-plane /v1 APIs: configured operators and owners, plus accounts with the
 * operator or approver privilege. A viewer account may only read (GET/HEAD). An unset
 * OPERATOR_IDENTITIES still fails closed with 503.
 */
export async function requireOperator(request: Request, env: RoleEnv): Promise<Authorization> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return auth;
  if (!listConfigured(env.OPERATOR_IDENTITIES)) return { ok: false, response: denied(503, "operator_identities_not_configured") };
  // Configured: OPERATOR_IDENTITIES only (an approver-only owner is not an operator, as before).
  // Accounts: operator and approver privileges operate; viewer reads.
  let allowed = identityAllowed(auth.identity, env.OPERATOR_IDENTITIES);
  let role: Role | null = allowed ? "operator" : null;
  if (!allowed) {
    role = await accountRole(env, auth.identity);
    allowed = role === "operator" || role === "approver" || (role === "viewer" && READ_METHODS.has(request.method));
  }
  if (!allowed) {
    console.warn(JSON.stringify({ event: "identity_not_authorized", list: "OPERATOR_IDENTITIES", type: auth.identity.type, role }));
    return { ok: false, response: denied(403, "forbidden") };
  }
  return { ok: true, identity: auth.identity, actor: actorOf(auth.identity) };
}

/**
 * Approvers: owners (APPROVER_IDENTITIES) and accounts with the approver privilege. Always a
 * person: an Access service token is never an approver. An unset APPROVER_IDENTITIES fails closed.
 */
export async function requireApprover(request: Request, env: RoleEnv): Promise<Authorization> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return auth;
  if (!listConfigured(env.APPROVER_IDENTITIES)) return { ok: false, response: denied(503, "approver_identities_not_configured") };
  const approver = auth.identity.type === "user"
    && (identityAllowed(auth.identity, env.APPROVER_IDENTITIES) || (await accountRole(env, auth.identity)) === "approver");
  if (!approver) {
    console.warn(JSON.stringify({ event: "identity_not_authorized", list: "APPROVER_IDENTITIES", type: auth.identity.type }));
    return { ok: false, response: denied(403, "forbidden") };
  }
  return { ok: true, identity: auth.identity, actor: actorOf(auth.identity) };
}
