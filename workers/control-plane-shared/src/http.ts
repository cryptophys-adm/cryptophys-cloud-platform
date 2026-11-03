import type { BaseEnv } from "./types.ts";

export const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { ...JSON_HEADERS, ...extra } });
}

export function errorResponse(status: number, error: string, detail?: string, extra: Record<string, unknown> = {}): Response {
  return json({ error, ...(detail ? { detail } : {}), ...extra }, status);
}

export const MAX_BODY_BYTES = 32 * 1024;

export type JsonObject = Record<string, unknown>;
export type BodyResult = { ok: true; value: JsonObject } | { ok: false; response: Response };

/** Parse a bounded JSON object body. Rejects non-JSON, oversized, and non-object payloads. */
export async function readJsonObject(request: Request, maxBytes = MAX_BODY_BYTES): Promise<BodyResult> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    return { ok: false, response: errorResponse(415, "unsupported_media_type", "Content-Type must be application/json") };
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return { ok: false, response: errorResponse(413, "payload_too_large") };
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    return { ok: false, response: errorResponse(413, "payload_too_large") };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, response: errorResponse(400, "invalid_json") };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, response: errorResponse(400, "invalid_body", "Body must be a JSON object") };
  }
  return { ok: true, value: value as JsonObject };
}

/** Constant-time comparison of a presented bearer token with the configured secret. */
export function bearerMatches(request: Request, secret: string | undefined): boolean {
  const supplied = request.headers.get("authorization") ?? "";
  if (!secret || !supplied.startsWith("Bearer ")) return false;
  const a = new TextEncoder().encode(supplied.slice(7));
  const b = new TextEncoder().encode(secret);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Returns an error Response when the request is not authorized as an administrator, otherwise null. */
export function requireAdmin(request: Request, env: BaseEnv): Response | null {
  if (!env.ADMIN_TOKEN) return errorResponse(503, "not_configured", "ADMIN_TOKEN secret is not configured");
  if (!bearerMatches(request, env.ADMIN_TOKEN)) return errorResponse(401, "unauthorized");
  return null;
}

export const nowIso = (): string => new Date().toISOString();
export const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;

export const SERVICE_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const COMMIT_SHA = /^[0-9a-f]{40}$/;
export const VERSION_TAG = /^[0-9a-f]{7,40}$/;
export const ACTOR = /^[A-Za-z0-9._@:-]{1,128}$/;

export function stringField(body: JsonObject, key: string, max: number, required = true): string | undefined | Error {
  const value = body[key];
  if (value === undefined || value === null) return required ? new Error(`${key} is required`) : undefined;
  if (typeof value !== "string") return new Error(`${key} must be a string`);
  const trimmed = value.trim();
  if (required && trimmed.length === 0) return new Error(`${key} must not be empty`);
  if (trimmed.length > max) return new Error(`${key} must be at most ${max} characters`);
  return trimmed;
}

export function limitParam(url: URL, fallback = 50, max = 200): number {
  const raw = Number(url.searchParams.get("limit") ?? fallback);
  if (!Number.isInteger(raw) || raw < 1) return fallback;
  return Math.min(raw, max);
}

const SECRET_KEY = /(token|secret|password|authorization|api[_-]?key|credential|cookie)/i;
const SECRET_VALUE = /(Bearer\s+[A-Za-z0-9._~+/=-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;

/** Deep-copies a value replacing secret-looking keys and token-shaped strings with "[redacted]". */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[redacted]");
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value as JsonObject)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    return out;
  }
  return value;
}

export function serviceMetadata(env: BaseEnv, capability: string, endpoints: string[]): Response {
  return json({
    service: env.SERVICE_NAME,
    environment: env.SERVICE_ENVIRONMENT,
    contract_version: env.API_CONTRACT_VERSION,
    capability,
    status: "operational",
    authentication: "Authorization: Bearer <ADMIN_TOKEN> required for every /v1 endpoint",
    endpoints,
  });
}

export interface HealthBody {
  status: "ok";
  service: string;
  environment: string;
  contract_version: string;
  version: { id: string; tag: string | null } | null;
}

/** Liveness payload, served over HTTP (/health) and over RPC (HealthRpc.health()). */
export function healthBody(env: Pick<BaseEnv, "SERVICE_NAME" | "SERVICE_ENVIRONMENT" | "API_CONTRACT_VERSION" | "CF_VERSION_METADATA">): HealthBody {
  return {
    status: "ok",
    service: env.SERVICE_NAME,
    environment: env.SERVICE_ENVIRONMENT,
    contract_version: env.API_CONTRACT_VERSION,
    version: env.CF_VERSION_METADATA ? { id: env.CF_VERSION_METADATA.id, tag: env.CF_VERSION_METADATA.tag ?? null } : null,
  };
}

export function healthResponse(env: BaseEnv): Response {
  return json(healthBody(env));
}
