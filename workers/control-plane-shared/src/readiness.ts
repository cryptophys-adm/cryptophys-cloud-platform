import type { BaseEnv } from "./types.ts";
import { json } from "./http.ts";
import { accessConfigured, listConfigured } from "./access.ts";

/** The newest schema migration every service requires before it reports ready. */
export const REQUIRED_MIGRATION = "0020_retire_signal_engine.sql";
const REQUIRED_MIGRATIONS = [
  "0011_agent_syscall_consumptions.sql",
  "0012_agent_reports.sql",
  "0013_auditor_agent.sql",
  "0014_agent_memories.sql",
  "0015_agent_principals.sql",
  "0016_platform_and_xauusd_agents.sql",
  "0018_grant_reports_publish.sql",
  "0019_ai_failures.sql",
  REQUIRED_MIGRATION,
] as const;

export type Checks = Record<string, boolean>;

export async function schemaReady(env: BaseEnv): Promise<boolean> {
  try {
    for (const name of REQUIRED_MIGRATIONS) {
      const row = await env.DB.prepare("SELECT name FROM d1_migrations WHERE name = ?").bind(name).first();
      if (row === null) return false;
    }
    return true;
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
    operator_identities_configured: listConfigured(env.OPERATOR_IDENTITIES),
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
