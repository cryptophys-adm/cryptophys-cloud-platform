// The one reader of the kernel's Analytics Engine datasets (ADR-0015 decision 6, phase 3, step 4; owner 2026-11-22:
// "sesuai rekomendasimu" for a read-only Account Analytics token). It serves the Console's Telemetry tab and nothing
// else: no decision, vote, budget or gate reads it (test analytics-engine-legal AL3 holds TELEMETRY_READERS to
// telemetry-view.ts). Every query is fixed in code; the only inputs are a window of hours from a closed list.
//
// Secrets (set by the owner on cryptophys-ai-kernel): CF_ANALYTICS_TOKEN (Account Analytics Read) and
// CF_ANALYTICS_ACCOUNT_ID. The token goes only to api.cloudflare.com, in the Authorization header; it is never logged,
// stored or returned.
export const ANALYTICS_SQL_HOST = "api.cloudflare.com";
export const QUERY_TIMEOUT_MS = 10_000;

export interface AnalyticsReadEnv { CF_ANALYTICS_TOKEN?: string; CF_ANALYTICS_ACCOUNT_ID?: string }
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type Row = Record<string, string | number | null>;

export class TelemetryReadError extends Error {}

const ACCOUNT = /^[0-9a-f]{32}$/;

export function readerConfigured(env: AnalyticsReadEnv): boolean {
  return typeof env.CF_ANALYTICS_TOKEN === "string" && env.CF_ANALYTICS_TOKEN.length > 0 && ACCOUNT.test(env.CF_ANALYTICS_ACCOUNT_ID ?? "");
}

/** Run one fixed SELECT through the Workers Analytics Engine SQL API; rows as the API returns them (FORMAT JSON). */
export async function runSql(env: AnalyticsReadEnv, sql: string, fetchImpl: Fetch = (i, init) => fetch(i, init)): Promise<Row[]> {
  if (!readerConfigured(env)) throw new TelemetryReadError("telemetry_not_configured");
  if (!/^\s*SELECT\s/i.test(sql) || /;\s*\S/.test(sql)) throw new TelemetryReadError("select_only");
  const url = `https://${ANALYTICS_SQL_HOST}/client/v4/accounts/${env.CF_ANALYTICS_ACCOUNT_ID}/analytics_engine/sql`;
  let res: Response;
  try {
    const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(QUERY_TIMEOUT_MS) : undefined;
    res = await fetchImpl(url, { method: "POST", redirect: "manual", body: `${sql.trim()} FORMAT JSON`, headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "content-type": "text/plain" }, ...(signal ? { signal } : {}) });
  } catch {
    throw new TelemetryReadError("telemetry_unreachable");
  }
  if (res.status !== 200) throw new TelemetryReadError(`telemetry_http_${res.status}`);
  let body: unknown;
  try { body = await res.json(); } catch { throw new TelemetryReadError("telemetry_malformed"); }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new TelemetryReadError("telemetry_malformed");
  return data as Row[];
}

/** A number from a SQL value (the API returns UInt64 sums as strings); null when absent or not finite. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** An hour bucket from toStartOfHour ("2026-11-22 03:00:00", UTC) as ISO. */
export function hourIso(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):00:00/.exec(v);
  return m ? `${m[1]}T${m[2]}:00:00.000Z` : null;
}
