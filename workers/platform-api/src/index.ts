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
import { cloudflareUsage } from "../../control-plane-shared/src/cf-usage.ts";
import { observerView, runSenses, sweepObserver, SENSES_MINUTE, type Finding } from "../../control-plane-shared/src/observer.ts";
import { runInventory } from "../../control-plane-shared/src/observer-inventory.ts";
import { EXTERNAL_ORIGINS } from "../../control-plane-shared/src/organism.ts";
import type { ExecutionContextLike, ScheduledEventLike } from "../../control-plane-shared/src/types.ts";

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
  /** Owner-created, read-only (Account Analytics: Read and Billing: Read) token and the account id for GET /v1/usage. */
  CF_ANALYTICS_TOKEN?: string;
  CF_BILLING_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  /** AI Kernel AgentRpc (host_worker pinned to this Worker): the Observer's advisory report as agent platform-api. */
  AGENTS?: { syscall(agentId: string, capability: string, input: Record<string, unknown>): Promise<Record<string, unknown>> };
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
    "Summarize the state of a Cloudflare Workers platform for its operator from the JSON given: drift per service, open " +
    'agent proposals, whether agents are enabled, the 24 h agent report summary, and the latest XAUUSD advisory decision ' +
    '(state it exactly as given; never add advice). Return {"summary": at most 600 characters, ' +
    '"attention": up to 5 strings of at most 200 characters naming what needs a human}. Use only the data given. ' +
    "Never give trading advice and never claim an action was taken. " +
    "Services without an expected (desired) version, disabled services, and services outside the platform's own deploys " +
    "(for example Aether, the Signal Engine and the XAUUSD services) are normal by design: do not mention them unless they are unhealthy. " +
    "Mention repeated deploy refusals caused by the daily or hourly deploy limits only once, as a single short note. " +
    // Owner 2026-11-14: the kernel lists open warnings only; an alert its agent reported resolved is left out.
    "agent_reports_24h lists open warnings only: never present a resolved alert as open; if warnings_resolved_24h is above 0, " +
    'say at most "resolved in last 24 h: n" once.',

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
      return json({ service: env.PLATFORM_NAME, api_version: env.API_CONTRACT_VERSION, endpoints: ["/health", "/ready", "/v1/overview[?advisory=true]", "/v1/usage", "/v1/observer"],
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
    if (url.pathname === "/v1/usage") {
      // Real Cloudflare usage against the free-plan limits (read only; the token never leaves this Worker).
      const operator = await requireOperator(request, env);
      if (!operator.ok) return operator.response;
      return json(await cloudflareUsage(env));
    }
    if (url.pathname === "/v1/observer") {
      // The account-wide Observer's vitals, findings and deploys (read only, from D1; no Cloudflare call).
      const operator = await requireOperator(request, env);
      if (!operator.ok) return operator.response;
      return json(await observerView(env));
    }
    return json({ error: "not_found" }, 404);
  },

  /** The Observer (owner 2026-11-14): senses at :27 (the last complete hour), the account inventory at :27 and :57. */
  async scheduled(event: ScheduledEventLike, env: Env, ctx: ExecutionContextLike): Promise<void> {
    ctx.waitUntil(runObserver(env, event.scheduledTime || Date.now()));
  },
};

/** The external origins' services (EXT_ORGANISM_*), for the inventory's "DNA not read" rule. */
const EXTERNAL_SERVICES: Record<string, readonly string[]> = Object.fromEntries(EXTERNAL_ORIGINS.map((o) => [o.origin, o.services]));

export async function runObserver(env: Env, now = Date.now(), fetcher: (input: string, init?: RequestInit) => Promise<Response> = (i, init) => fetch(i, init)): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const minute = new Date(now).getUTCMinutes();
  try {
    if (minute >= SENSES_MINUTE && minute < SENSES_MINUTE + 30) {
      const senses = await runSenses(env, now, fetcher);
      out.senses = { outcome: senses.outcome, hour: senses.hour, vitals: senses.vitals, findings: senses.findings?.length ?? 0 };
      if (senses.findings?.length) out.report = await publishAdvisory(env, senses.hour ?? "", senses.findings);
      if (env.DB && new Date(now).getUTCHours() === 3) await sweepObserver(env.DB, now);
    }
  } catch (err) {
    out.senses = { outcome: "failed", error: String((err as Error)?.message ?? err).slice(0, 160) };
  }
  try {
    out.inventory = await runInventory(env, now, fetcher, EXTERNAL_SERVICES);
  } catch (err) {
    out.inventory = { outcome: "failed", error: String((err as Error)?.message ?? err).slice(0, 160) };
  }
  console.log(JSON.stringify({ service: SERVICE, event: "observer_run", ...out }));
  return out;
}

/**
 * One advisory report per sensing hour with new anomalies or early warnings, as this Worker's agent (reports.publish,
 * tier 1, policy-gated by the kernel). Always a warning, never critical: the Observer does not engage the brake.
 */
async function publishAdvisory(env: Env, hour: string, findings: Finding[]): Promise<string> {
  const notable = findings.filter((f) => f.kind === "anomaly" || f.kind === "early_warning");
  if (!notable.length || !env.AGENTS) return "none";
  try {
    const r = await env.AGENTS.syscall("platform-api", "reports.publish", {
      kind: "platform_digest", severity: "warning", ai_status: "not_used",
      subject: `Observer: ${notable.length} anomaly finding(s) in the hour from ${hour.slice(11, 16)} UTC`.slice(0, 200),
      body: {
        source: "observer", hour,
        findings: notable.slice(0, 10).map((f) => ({ worker: f.worker, metric: f.metric, value: f.value, baseline_7d: f.baseline_7d, z: f.z, since_deploy: f.since_deploy, detail: f.detail.slice(0, 300) })),
      },
    });
    return String(r?.outcome ?? "unknown");
  } catch {
    return "unavailable";
  }
}
