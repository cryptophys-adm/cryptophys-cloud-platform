/**
 * Real Cloudflare usage against the Workers Free plan limits (owner 2026-11-10: "buatkan panel
 * usage Cloudflare yang asli"). Values come from the Cloudflare GraphQL Analytics API, read with an
 * owner-created, read-only token (Account > Account Analytics > Read) stored as the Worker secrets
 * CF_ANALYTICS_TOKEN and CF_ACCOUNT_ID. Nothing here is estimated or simulated: a metric that cannot
 * be read says so, with the error, instead of showing a number.
 *
 * Free limits (developers.cloudflare.com, read 2026-11-10; all daily limits reset 00:00 UTC):
 *   Workers requests 100,000/day; D1 rows read 5,000,000/day, rows written 100,000/day;
 *   Workers AI 10,000 neurons/day; KV reads 100,000/day, writes 1,000/day.
 */
import type { D1Database } from "./types.ts";

export const FREE_LIMITS = {
  workers_requests: { limit: 100_000, unit: "requests", period: "day", label: "Workers requests" },
  d1_rows_read: { limit: 5_000_000, unit: "rows", period: "day", label: "D1 rows read" },
  d1_rows_written: { limit: 100_000, unit: "rows", period: "day", label: "D1 rows written" },
  ai_neurons: { limit: 10_000, unit: "neurons", period: "day", label: "Workers AI neurons" },
  kv_reads: { limit: 100_000, unit: "reads", period: "day", label: "KV reads" },
  kv_writes: { limit: 1_000, unit: "writes", period: "day", label: "KV writes" },
} as const;
export type MetricKey = keyof typeof FREE_LIMITS;

export interface UsageEnv {
  CF_ANALYTICS_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  DB?: D1Database;
}
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Metric { key: MetricKey; label: string; today: number | null; limit: number; unit: string; pct: number | null; error?: string; history?: Array<{ date: string; value: number }> }

const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
const ACCOUNT = /^[0-9a-f]{32}$/;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function gql(fetcher: Fetch, token: string, query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetcher(GRAPHQL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => null) as { data?: any; errors?: Array<{ message?: string }> } | null;
  if (!res.ok || !body) throw new Error(`graphql_http_${res.status}`);
  if (body.errors?.length) throw new Error(String(body.errors[0]?.message ?? "graphql_error").slice(0, 200));
  return body.data?.viewer?.accounts?.[0] ?? {};
}

const Q = {
  workers: `query($a:string!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){g:workersInvocationsAdaptive(limit:10000,filter:{date_geq:$s,date_leq:$e}){sum{requests errors}dimensions{date scriptName}}}}}`,
  d1: `query($a:string!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){g:d1AnalyticsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){sum{rowsRead rowsWritten}dimensions{date}}}}}`,
  ai: `query($a:string!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){g:aiInferenceAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){sum{totalNeurons}dimensions{date}}}}}`,
  kv: `query($a:string!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){g:kvOperationsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){sum{requests}dimensions{date actionType}}}}}`,
};

function byDate(rows: any[], pick: (r: any) => number, where: (r: any) => boolean = () => true): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows ?? []) {
    if (!where(r)) continue;
    const d = String(r?.dimensions?.date ?? "");
    m.set(d, (m.get(d) ?? 0) + (Number(pick(r)) || 0));
  }
  return m;
}

function metric(key: MetricKey, series: Map<string, number> | null, today: string, dates: string[], error?: string): Metric {
  const l = FREE_LIMITS[key];
  if (!series) return { key, label: l.label, today: null, limit: l.limit, unit: l.unit, pct: null, error };
  const v = series.get(today) ?? 0;
  return { key, label: l.label, today: v, limit: l.limit, unit: l.unit, pct: Math.round((v / l.limit) * 1000) / 10, history: dates.map((d) => ({ date: d, value: series.get(d) ?? 0 })) };
}

let cache: { at: number; account: string; body: Record<string, unknown> } | null = null;
export const USAGE_CACHE_MS = 5 * 60_000;
export function resetUsageCache() { cache = null; }

/** What the platform measures itself (always available): AI requests counted in ai_usage today. */
async function platformCounters(db: D1Database | undefined, today: string) {
  if (!db) return null;
  try {
    const rows = (await db.prepare("SELECT service_id, requests FROM ai_usage WHERE day = ? ORDER BY requests DESC").bind(today).all<{ service_id: string; requests: number }>()).results ?? [];
    return { ai_requests_today: rows.reduce((n, r) => n + Number(r.requests ?? 0), 0), ai_requests_by_service: rows };
  } catch { return null; }
}

export async function cloudflareUsage(env: UsageEnv, now = Date.now(), fetcher: Fetch = (i, init) => fetch(i, init)): Promise<Record<string, unknown>> {
  const today = day(now);
  const dates = Array.from({ length: 7 }, (_, i) => day(now - (6 - i) * 86_400_000));
  const platform = await platformCounters(env.DB, today);
  const token = env.CF_ANALYTICS_TOKEN?.trim();
  const account = env.CF_ACCOUNT_ID?.trim().toLowerCase();
  if (!token || !account || !ACCOUNT.test(account)) {
    return {
      configured: false, observed_at: new Date(now).toISOString(), plan: "Workers Free", limits: FREE_LIMITS, platform,
      setup: "Owner: create an API token with only Account > Account Analytics > Read, then set the secrets CF_ANALYTICS_TOKEN and CF_ACCOUNT_ID (32 hex) on cryptophys-platform-api.",
    };
  }
  if (cache && cache.account === account && now - cache.at < USAGE_CACHE_MS) return { ...cache.body, cached: true, platform };
  const vars = { a: account, s: dates[0], e: today };
  const run = async (q: string) => { try { return { rows: (await gql(fetcher, token, q, vars)).g ?? [] }; } catch (e) { return { error: String((e as Error)?.message ?? e) }; } };
  const [w, d, a, k] = await Promise.all([run(Q.workers), run(Q.d1), run(Q.ai), run(Q.kv)]);
  const isWrite = (r: any) => /write|put|delete/i.test(String(r?.dimensions?.actionType ?? ""));
  const scripts = w.rows
    ? [...byDate(w.rows.filter((r: any) => r?.dimensions?.date === today).map((r: any) => ({ dimensions: { date: r.dimensions.scriptName }, sum: r.sum })), (r) => r.sum?.requests).entries()]
      .map(([script, requests]) => ({ script, requests })).sort((x, y) => y.requests - x.requests)
    : [];
  const errorsToday = w.rows ? byDate(w.rows, (r) => r.sum?.errors).get(today) ?? 0 : null;
  const body: Record<string, unknown> = {
    configured: true, observed_at: new Date(now).toISOString(), plan: "Workers Free", window: { from: dates[0], to: today, resets: "00:00 UTC" },
    metrics: [
      metric("workers_requests", w.rows ? byDate(w.rows, (r) => r.sum?.requests) : null, today, dates, w.error),
      metric("d1_rows_read", d.rows ? byDate(d.rows, (r) => r.sum?.rowsRead) : null, today, dates, d.error),
      metric("d1_rows_written", d.rows ? byDate(d.rows, (r) => r.sum?.rowsWritten) : null, today, dates, d.error),
      metric("ai_neurons", a.rows ? byDate(a.rows, (r) => r.sum?.totalNeurons) : null, today, dates, a.error),
      metric("kv_reads", k.rows ? byDate(k.rows, (r) => r.sum?.requests, (r) => !isWrite(r)) : null, today, dates, k.error),
      metric("kv_writes", k.rows ? byDate(k.rows, (r) => r.sum?.requests, isWrite) : null, today, dates, k.error),
    ],
    workers_today: scripts,
    workers_errors_today: errorsToday,
    source: "Cloudflare GraphQL Analytics API (sampled adaptive datasets)",
  };
  cache = { at: now, account, body };
  return { ...body, platform };
}
