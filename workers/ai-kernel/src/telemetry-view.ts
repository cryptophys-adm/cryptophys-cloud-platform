// GET /v1/telemetry (ADR-0015 decision 6, phase 3, step 4; owner 2026-11-22). The Console's Telemetry tab, in the shape
// the frontend session specified: hourly buckets over 24 h or 7 days, syscalls by agent or by capability, or the
// kernel's cron jobs. Read only, display only: nothing decides from it. Counts are weighted by _sample_interval; a
// bucket with no point is null, never 0, and a rate over nothing is null. Cached for 60 s per window and group.
import { AGENT_RUNTIME, AGENT_RUNTIME_SCHEMA_VERSION, CONTROL_PLANE, CONTROL_PLANE_SCHEMA_VERSION } from "./analytics/datasets.ts";
import { hourIso, num, readerConfigured, runSql, TelemetryReadError, type AnalyticsReadEnv, type Fetch, type Row } from "./analytics/read.ts";

export const TELEMETRY_WINDOWS = { "24h": 24, "7d": 168 } as const;
export const TELEMETRY_GROUPS = ["agent", "capability", "job"] as const;
export type TelemetryWindow = keyof typeof TELEMETRY_WINDOWS;
export type TelemetryGroup = (typeof TELEMETRY_GROUPS)[number];
export const TELEMETRY_CACHE_S = 60;
export const BUCKET_S = 3600;
/** The kernel's cron jobs, in the order the Console shows them (index.ts trackJob names). */
export const JOB_ORDER = ["supervisor_cycle", "signal_analyst_cycle", "auditor_cycle", "adr_steward_cycle", "evolution_intake", "evolver_cycle", "autonomy_downgrade", "council_proposals", "owner_notices", "report_relay"] as const;

export class TelemetryRequestError extends Error {}

const cache = new Map<string, { at: number; body: Record<string, unknown> }>();
/** For tests: start with an empty cache. */
export function clearTelemetryCache(): void { cache.clear(); }

export function parseTelemetryParams(params: URLSearchParams): { window: TelemetryWindow; group: TelemetryGroup } {
  const w = params.get("window") ?? "24h";
  const g = params.get("group") ?? "agent";
  if (!(w in TELEMETRY_WINDOWS)) throw new TelemetryRequestError("invalid_window");
  if (!(TELEMETRY_GROUPS as readonly string[]).includes(g)) throw new TelemetryRequestError("invalid_group");
  return { window: w as TelemetryWindow, group: g as TelemetryGroup };
}

/** The hour buckets of the window, oldest first, ending with the current hour. */
export function hourBuckets(nowMs: number, hours: number): string[] {
  const current = Math.floor(nowMs / 3_600_000) * 3_600_000;
  return Array.from({ length: hours }, (_, i) => new Date(current - (hours - 1 - i) * 3_600_000).toISOString());
}

/** A DateTime from the SQL API ("2026-11-22 02:42:15") as ISO, or null. */
function tsIso(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(v);
  return m ? `${m[1]}T${m[2]}.000Z` : null;
}
const rate = (part: number | null, whole: number | null): number | null => (part === null || whole === null || whole <= 0 ? null : part / whole);
const sumOrNull = (vs: Array<number | null>): number | null => (vs.some((v) => v !== null) ? vs.reduce<number>((s, v) => s + (v ?? 0), 0) : null);

export async function telemetryView(env: AnalyticsReadEnv, params: URLSearchParams, nowMs = Date.now(), fetchImpl?: Fetch): Promise<Record<string, unknown>> {
  const { window, group } = parseTelemetryParams(params);
  const hours = TELEMETRY_WINDOWS[window];
  const buckets = hourBuckets(nowMs, hours);
  const head = { window, group, bucket_s: BUCKET_S, from: buckets[0], to: new Date(nowMs).toISOString(), cache_s: TELEMETRY_CACHE_S, sampled: true, buckets };
  if (!readerConfigured(env)) return { ...head, configured: false, generated_at: new Date(nowMs).toISOString() };
  const key = `${window}:${group}`;
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < TELEMETRY_CACHE_S * 1000) return hit.body;

  const run = (sql: string) => runSql(env, sql, fetchImpl);
  const since = `timestamp > NOW() - INTERVAL '${hours}' HOUR`;
  const at = new Map(buckets.map((b, i) => [b, i]));
  const align = (rows: Row[], value: (r: Row) => number | null): Array<number | null> => {
    const out: Array<number | null> = buckets.map(() => null);
    for (const r of rows) { const i = at.get(hourIso(r.h) ?? ""); if (i !== undefined) out[i] = value(r); }
    return out;
  };
  const deploysOf = (rows: Row[]) => {
    const list = rows.map((r) => ({ at: tsIso(r.at), deploy_version: String(r.v ?? "") })).filter((d) => d.at && d.deploy_version && d.deploy_version !== "unknown").sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return list.map((d, i) => ({ ...d, previous: i ? list[i - 1].deploy_version : null }));
  };

  let body: Record<string, unknown>;
  if (group === "job") {
    const from = `FROM ${CONTROL_PLANE.dataset} WHERE blob1 = '${CONTROL_PLANE_SCHEMA_VERSION}' AND ${since}`;
    const [perBucket, totals, deploys, first] = await Promise.all([
      run(`SELECT toStartOfHour(timestamp) AS h, blob3 AS k, SUM(_sample_interval) AS n, sumIf(_sample_interval, blob4 = 'failed') AS f ${from} GROUP BY h, k`),
      run(`SELECT blob3 AS k, index1 AS service, SUM(_sample_interval) AS n, sumIf(_sample_interval, blob4 = 'failed') AS f, quantileExactWeighted(0.5)(double1, _sample_interval) AS p50, quantileExactWeighted(0.95)(double1, _sample_interval) AS p95 ${from} GROUP BY k, service`),
      run(`SELECT blob5 AS v, min(timestamp) AS at ${from} GROUP BY v`),
      run(`SELECT min(timestamp) AS at FROM ${CONTROL_PLANE.dataset} WHERE blob1 = '${CONTROL_PLANE_SCHEMA_VERSION}' AND timestamp > NOW() - INTERVAL '90' DAY`),
    ]);
    const order = (k: string) => { const i = (JOB_ORDER as readonly string[]).indexOf(k); return i === -1 ? JOB_ORDER.length : i; };
    const jobs = totals.map((t) => {
      const k = String(t.k ?? "");
      const mine = perBucket.filter((r) => r.k === k);
      return { subject: k, service: String(t.service ?? ""), runs: num(t.n) ?? 0, failed: num(t.f) ?? 0, duration_ms: { p50: num(t.p50), p95: num(t.p95) }, runs_by_bucket: align(mine, (r) => num(r.n)), failed_by_bucket: align(mine, (r) => num(r.f)) };
    }).sort((a, b) => order(a.subject) - order(b.subject) || a.subject.localeCompare(b.subject));
    const runs = sumOrNull(jobs.map((j) => j.runs));
    body = {
      ...head, configured: true, generated_at: new Date(nowMs).toISOString(), first_point_at: tsIso(first[0]?.at), deploys: deploysOf(deploys),
      summary: { runs: runs ?? 0, failed: jobs.reduce((s, j) => s + j.failed, 0) },
      summary_by_bucket: { runs: buckets.map((_, i) => sumOrNull(jobs.map((j) => j.runs_by_bucket[i]))), failed: buckets.map((_, i) => sumOrNull(jobs.map((j) => j.failed_by_bucket[i]))) },
      jobs,
    };
  } else {
    const k = group === "agent" ? "index1" : "blob3";
    const from = `FROM ${AGENT_RUNTIME.dataset} WHERE blob1 = '${AGENT_RUNTIME_SCHEMA_VERSION}' AND ${since}`;
    const counts = `SUM(_sample_interval) AS n, sumIf(_sample_interval, blob4 = 'denied') AS d, sumIf(_sample_interval, blob4 = 'failed') AS f`;
    const lat = `quantileExactWeighted(0.5)(double2, _sample_interval) AS p50, quantileExactWeighted(0.95)(double2, _sample_interval) AS p95`;
    const [perBucket, totals, latByBucket, overall, deploys, first] = await Promise.all([
      run(`SELECT toStartOfHour(timestamp) AS h, ${k} AS k, ${counts} ${from} GROUP BY h, k`),
      run(`SELECT ${k} AS k, ${counts}, ${lat} ${from} GROUP BY k`),
      run(`SELECT toStartOfHour(timestamp) AS h, quantileExactWeighted(0.95)(double2, _sample_interval) AS p95 ${from} GROUP BY h`),
      run(`SELECT ${counts}, ${lat} ${from}`),
      run(`SELECT blob5 AS v, min(timestamp) AS at ${from} GROUP BY v`),
      run(`SELECT min(timestamp) AS at FROM ${AGENT_RUNTIME.dataset} WHERE blob1 = '${AGENT_RUNTIME_SCHEMA_VERSION}' AND timestamp > NOW() - INTERVAL '90' DAY`),
    ]);
    const keys = [...new Set(totals.map((t) => String(t.k ?? "")))];
    const series = keys.map((key) => {
      const mine = perBucket.filter((r) => r.k === key);
      return { key, syscalls: align(mine, (r) => num(r.n)), denied: align(mine, (r) => num(r.d)), failed: align(mine, (r) => num(r.f)) };
    });
    const totalsOut = totals.map((t) => {
      const n = num(t.n) ?? 0, d = num(t.d) ?? 0, f = num(t.f) ?? 0;
      return { key: String(t.k ?? ""), syscalls: n, denied: d, failed: f, deny_rate: rate(d, n), fail_rate: rate(f, n), latency_ms: { p50: num(t.p50), p95: num(t.p95) } };
    }).sort((a, b) => b.syscalls - a.syscalls || a.key.localeCompare(b.key));
    const o = overall[0] ?? {};
    const n = num(o.n), d = num(o.d), f = num(o.f);
    body = {
      ...head, configured: true, generated_at: new Date(nowMs).toISOString(), first_point_at: tsIso(first[0]?.at), deploys: deploysOf(deploys),
      summary: { syscalls: n ?? 0, denied: d ?? 0, failed: f ?? 0, deny_rate: rate(d, n), fail_rate: rate(f, n), latency_ms: { p50: num(o.p50), p95: num(o.p95) } },
      summary_by_bucket: {
        syscalls: buckets.map((_, i) => sumOrNull(series.map((s) => s.syscalls[i]))),
        denied: buckets.map((_, i) => sumOrNull(series.map((s) => s.denied[i]))),
        failed: buckets.map((_, i) => sumOrNull(series.map((s) => s.failed[i]))),
        latency_p95_ms: align(latByBucket, (r) => num(r.p95)),
      },
      series,
      totals: totalsOut,
    };
  }
  cache.set(key, { at: nowMs, body });
  return body;
}

export { TelemetryReadError };
