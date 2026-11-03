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
