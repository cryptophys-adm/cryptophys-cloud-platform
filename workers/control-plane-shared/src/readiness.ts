import type { BaseEnv } from "./types.ts";
import { json } from "./http.ts";
import { accessConfigured } from "./access.ts";

/** The newest schema migration every service requires before it reports ready. */
export const REQUIRED_MIGRATION = "0003_control_plane_services.sql";

export type Checks = Record<string, boolean>;

export async function schemaReady(env: BaseEnv): Promise<boolean> {
  try {
    const row = await env.DB.prepare("SELECT name FROM d1_migrations WHERE name = ?").bind(REQUIRED_MIGRATION).first();
    return row !== null;
  } catch {
    return false;
  }
}

/**
 * Readiness = every dependency the service needs to perform its authoritative
 * function. AI is reported but is advisory, so it is checked for binding presence
 * only; quota exhaustion must not make a service unready.
 */
export async function readinessResponse(env: BaseEnv, extra: Checks = {}): Promise<Response> {
  const checks: Checks = {
    production_environment: env.SERVICE_ENVIRONMENT === "production",
    database_schema: await schemaReady(env),
    admin_token_configured: Boolean(env.ADMIN_TOKEN),
    ai_binding: Boolean(env.AI),
    access_configured: accessConfigured(env),
    ...extra,
  };
  const ready = Object.values(checks).every(Boolean);
  return json({
    status: ready ? "ready" : "not_ready",
    service: env.SERVICE_NAME,
    production_ready: ready,
    checks,
  }, ready ? 200 : 503);
}
