/**
 * The account-wide Observer (owner 2026-11-14: "setuju"; "gak perlu shadow, langsung production").
 *
 * Senses. Once an hour (cryptophys-platform-api, cron :27) the Observer reads the last complete UTC hour from the
 * Cloudflare GraphQL Analytics API, with the owner's read-only analytics token that GET /v1/usage already uses
 * (CF_ANALYTICS_TOKEN or CF_BILLING_TOKEN, CF_ACCOUNT_ID). One HTTP call per dataset, so a dataset the token or the
 * account does not have fails alone and is recorded as "no data", never as a number:
 *   - workersInvocationsAdaptive, per scriptName: requests, errors, subrequests; quantiles cpuTime and wallTime
 *     p50/p99 (microseconds, stored in ms); and per (scriptName, status) the requests, which give the
 *     exceededCpu / exceededMemory / scriptThrewException counts;
 *   - d1AnalyticsAdaptiveGroups per databaseId: rowsRead, rowsWritten, readQueries + writeQueries;
 *     d1QueriesAdaptiveGroups: the five queries reading the most rows (named in a D1 load advisory);
 *   - kvOperationsAdaptiveGroups per namespaceId: operations;
 *   - durableObjectsInvocationsAdaptiveGroups per namespaceId (and scriptName): requests, errors, wall time;
 *   - aiInferenceAdaptiveGroups per modelId: neurons.
 * Top error messages per Worker come from the Workers Observability telemetry query API; a token without that
 * permission (401/403) is recorded once a day as the finding observability_permission_missing, and the call is not
 * repeated for 24 h (the capability check). No secret is ever asked for, stored or logged.
 *
 * Storage (migration 0063, additive). One compact vitals row per Worker (and per D1 database, KV namespace, Durable
 * Object namespace and AI model) and hour; findings only for anomalies, early warnings, inventory differences and
 * missing capabilities. Retention in code: vitals and runs 30 days, findings 90 days.
 *
 * Findings are metrics: {worker, metric, value, baseline_7d, z, since_deploy: {version, deployed_at} | null, sample}.
 * The Supervisor (ai-kernel/src/observer-watch.ts) reads them; a rollback is proposed only through consensus and only
 * when rollbackGate() below lets it (baseline, minimums, post-deploy window, cooldown, brake, platform Workers only,
 * never a trading Worker). Nothing here is estimated unless it says so (rows per request at account level).
 */
import type { D1Database } from "./types.ts";
import { unitForService } from "./deploy-units.ts";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ObserverEnv {
  CF_ANALYTICS_TOKEN?: string;
  CF_BILLING_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  DB?: D1Database;
}

export const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const ACCOUNT = /^[0-9a-f]{32}$/;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The Platform API's cron: senses at :27 (the last complete hour), the inventory at :27 and :57. */
export const OBSERVER_CRON = "27,57 * * * *";
export const SENSES_MINUTE = 27;

/** Retention (done in code, once a day in the 03:27 UTC run). */
export const VITALS_RETENTION_DAYS = 30;
export const FINDINGS_RETENTION_DAYS = 90;
export const RUNS_RETENTION_DAYS = 30;

/**
 * Detection and rollback thresholds. Every one is a minimum that must hold together with the others, so a quiet
 * Worker (a few requests an hour) can never trigger anything on a handful of errors.
 */
export const THRESHOLDS = Object.freeze({
  /** z is computed only with this many baseline hours (each with >= RATE_HOUR_MIN_REQUESTS requests). */
  MIN_BASELINE_HOURS: 6,
  RATE_HOUR_MIN_REQUESTS: 20,
  /** A rate's standard deviation is never taken below this (0.5 percentage points), so a flat baseline cannot make any blip a huge z. */
  RATE_STD_FLOOR: 0.005,
  /** Error or exception spike: all of these in one hour. */
  MIN_REQUESTS: 200,
  MIN_ERRORS: 20,
  MIN_ERROR_RATE: 0.05,
  MIN_RATIO: 3,
  MIN_Z: 3,
  /** The baseline the Supervisor needs before it may propose a rollback (findings are reported before that). */
  ROLLBACK_BASELINE_DAYS: 3,
  ROLLBACK_BASELINE_HOURS: 24,
  /** The anomaly's hour must overlap the first 2 h after the Worker's most recent deploy... */
  POST_DEPLOY_WINDOW_MS: 2 * HOUR_MS,
  /** ...and the proposal is made at most 3 h after the deploy (the window plus one sensing interval). */
  PROPOSAL_DEADLINE_MS: 3 * HOUR_MS,
  /** At most one rollback proposal per target per 6 h (the Policy Engine voter's own "same action in 6 h" rule agrees). */
  ROLLBACK_COOLDOWN_MS: 6 * HOUR_MS,
  /** A deploy is attached to a Worker finding (since_deploy) when it happened at most 24 h before the hour's end. */
  SINCE_DEPLOY_MS: 24 * HOUR_MS,
  /** CPU early warning: p99 at or above 80 % of the Worker's CPU limit, with at least 20 requests in the hour. */
  CPU_WARN_RATIO: 0.8,
  CPU_MIN_REQUESTS: 20,
  /** Load spikes (advisory only): at least this much in the hour, 3x the baseline mean and z >= 3. */
  LOAD_MIN: Object.freeze({ d1: 50_000, kv: 2_000, do: 2_000, ai: 2_000 }),
  /** idle_worker: no traffic for 7 days, reported only once the Observer itself has 7 days of senses. */
  IDLE_DAYS: 7,
});

/**
 * Workers the platform only observes and never acts on. Trading Workers are report only: no rollback is ever
 * proposed for them, whatever the evidence (owner 2026-11-14; no autonomy is widened). Aether is report only too.
 */
export const TRADING_WORKERS: ReadonlySet<string> = new Set(["xauusd-ai-trading-assistant", "xauusd-omega", "xauusd-tradingview-pull-adapter"]);
export const REPORT_ONLY_WORKERS: ReadonlySet<string> = new Set([...TRADING_WORKERS, "cryptophys-aether"]);
/** The Supervisor's own Worker: like drift, it never proposes rolling back the kernel that judges it. */
export const SELF_WORKER = "cryptophys-ai-kernel";

/**
 * CPU limits per invocation. The account is on Workers Paid (docs/SSOT.md), whose default is 30,000 ms; a Worker of
 * this repository with [limits] cpu_ms in its wrangler.toml has that instead (a test keeps this map equal to the
 * wrangler files). Workers outside this repository: the plan default, labelled as assumed.
 */
export const PLAN_DEFAULT_CPU_MS = 30_000;
export const CPU_LIMIT_MS: Readonly<Record<string, number>> = Object.freeze({ "cryptophys-forge": 300_000 });
export function cpuLimit(worker: string, repoWorkers: ReadonlySet<string>): { limit_ms: number; source: "wrangler" | "plan_default" | "plan_default_assumed" } {
  if (Object.hasOwn(CPU_LIMIT_MS, worker)) return { limit_ms: CPU_LIMIT_MS[worker], source: "wrangler" };
  return { limit_ms: PLAN_DEFAULT_CPU_MS, source: repoWorkers.has(worker) ? "plan_default" : "plan_default_assumed" };
}

// ---------------------------------------------------------------------------------------------------- senses

export type VitalKind = "worker" | "d1" | "kv" | "do" | "ai";
export interface Vital {
  subject: string;
  kind: VitalKind;
  hour: string;
  requests: number | null;
  errors: number | null;
  rows_read: number | null;
  rows_written: number | null;
  neurons: number | null;
  cpu_p50_ms: number | null;
  cpu_p99_ms: number | null;
  wall_p50_ms: number | null;
  wall_p99_ms: number | null;
  exceeded_cpu: number | null;
  exceeded_memory: number | null;
  exceptions: number | null;
  sample: Record<string, unknown>;
}

export type DatasetStatus = "ok" | "no_data" | `error: ${string}`;
export interface Senses {
  hour: string;
  vitals: Vital[];
  datasets: Record<string, DatasetStatus>;
  top_queries: Array<{ database: string; query: string; rows_read: number; rows_written: number; count: number | null }>;
}

const filterHour = "filter:{datetimeHour_geq:$s,datetimeHour_leq:$s}";
const H = "query($a:string!,$s:Time!,$e:Time!)";
const acct = (body: string) => `${H}{viewer{accounts(filter:{accountTag:$a}){${body}}}}`;
/** The queries (one HTTP call each). Field names as the GraphQL Analytics API documents them; see the module comment. */
export const OBSERVER_QUERIES = Object.freeze({
  workers: acct(
    "w:workersInvocationsAdaptive(limit:1000,filter:{datetime_geq:$s,datetime_leq:$e}){sum{requests errors subrequests}quantiles{cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99}dimensions{scriptName}}" +
    "s:workersInvocationsAdaptive(limit:5000,filter:{datetime_geq:$s,datetime_leq:$e}){sum{requests}dimensions{scriptName status}}",
  ),
  d1: acct(`g:d1AnalyticsAdaptiveGroups(limit:1000,${filterHour}){sum{readQueries writeQueries rowsRead rowsWritten}dimensions{databaseId}}`),
  d1_queries: acct(`g:d1QueriesAdaptiveGroups(limit:5,${filterHour},orderBy:[sum_rowsRead_DESC]){count sum{rowsRead rowsWritten}dimensions{databaseId query}}`),
  kv: acct(`g:kvOperationsAdaptiveGroups(limit:1000,${filterHour}){sum{requests}dimensions{namespaceId actionType}}`),
  do: acct(`g:durableObjectsInvocationsAdaptiveGroups(limit:1000,${filterHour}){sum{requests errors wallTime}dimensions{namespaceId scriptName}}`),
  ai: acct(`g:aiInferenceAdaptiveGroups(limit:200,${filterHour}){sum{totalNeurons}dimensions{modelId}}`),
});

async function gql(fetcher: Fetch, token: string, query: string, variables: Record<string, unknown>): Promise<Record<string, any>> {
  const res = await fetcher(GRAPHQL_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json().catch(() => null)) as { data?: any; errors?: Array<{ message?: string }> } | null;
  if (!res.ok || !body) throw new Error(`graphql_http_${res.status}`);
  if (body.errors?.length) throw new Error(String(body.errors[0]?.message ?? "graphql_error").slice(0, 160));
  return body.data?.viewer?.accounts?.[0] ?? {};
}

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const nz = (v: unknown): number => n(v) ?? 0;
const ms = (us: unknown): number | null => { const v = n(us); return v === null ? null : Math.round(v / 10) / 100; };
const blankVital = (subject: string, kind: VitalKind, hour: string): Vital => ({
  subject, kind, hour, requests: null, errors: null, rows_read: null, rows_written: null, neurons: null,
  cpu_p50_ms: null, cpu_p99_ms: null, wall_p50_ms: null, wall_p99_ms: null, exceeded_cpu: null, exceeded_memory: null, exceptions: null, sample: {},
});

/** Invocation status -> the vitals counter it adds to (Workers Analytics status values; anything else counts nowhere). */
export function statusCounter(status: string): "exceeded_cpu" | "exceeded_memory" | "exceptions" | null {
  if (/^exceeded(Cpu|Resources)$/i.test(status)) return "exceeded_cpu";
  if (/^exceededMemory$/i.test(status)) return "exceeded_memory";
  if (/exception/i.test(status)) return "exceptions";
  return null;
}

/** Per-script vitals from the workers query (exported for tests; the fixtures are this shape). */
export function parseWorkers(data: Record<string, any>, hour: string): Vital[] {
  const out = new Map<string, Vital>();
  for (const r of Array.isArray(data.w) ? data.w : []) {
    const script = String(r?.dimensions?.scriptName ?? "").trim();
    if (!script) continue;
    const v = out.get(script) ?? blankVital(script, "worker", hour);
    v.requests = (v.requests ?? 0) + nz(r?.sum?.requests);
    v.errors = (v.errors ?? 0) + nz(r?.sum?.errors);
    const q = r?.quantiles ?? {};
    v.cpu_p50_ms = ms(q.cpuTimeP50); v.cpu_p99_ms = ms(q.cpuTimeP99); v.wall_p50_ms = ms(q.wallTimeP50); v.wall_p99_ms = ms(q.wallTimeP99);
    if (n(r?.sum?.subrequests) !== null) v.sample.subrequests = nz(r.sum.subrequests);
    out.set(script, v);
  }
  for (const r of Array.isArray(data.s) ? data.s : []) {
    const v = out.get(String(r?.dimensions?.scriptName ?? "").trim());
    if (!v) continue;
    v.exceeded_cpu ??= 0; v.exceeded_memory ??= 0; v.exceptions ??= 0;
    const c = statusCounter(String(r?.dimensions?.status ?? ""));
    if (c) v[c] = (v[c] ?? 0) + nz(r?.sum?.requests);
  }
  return [...out.values()].filter((v) => (v.requests ?? 0) > 0).sort((a, b) => a.subject.localeCompare(b.subject));
}

function parseGroups(rows: unknown, kind: Exclude<VitalKind, "worker">, hour: string): Vital[] {
  const out = new Map<string, Vital>();
  for (const r of Array.isArray(rows) ? rows as any[] : []) {
    const d = r?.dimensions ?? {}; const s = r?.sum ?? {};
    const id = String(kind === "d1" ? d.databaseId ?? "" : kind === "ai" ? d.modelId ?? "" : d.namespaceId ?? "").trim();
    if (!id) continue;
    const subject = `${kind}:${id}`;
    const v = out.get(subject) ?? blankVital(subject, kind, hour);
    if (kind === "d1") {
      v.rows_read = (v.rows_read ?? 0) + nz(s.rowsRead);
      v.rows_written = (v.rows_written ?? 0) + nz(s.rowsWritten);
      v.requests = (v.requests ?? 0) + nz(s.readQueries) + nz(s.writeQueries);
    } else if (kind === "kv") {
      v.requests = (v.requests ?? 0) + nz(s.requests);
      const action = String(d.actionType ?? "other");
      const ops = (v.sample.ops ?? {}) as Record<string, number>;
      ops[action] = (ops[action] ?? 0) + nz(s.requests);
      v.sample.ops = ops;
    } else if (kind === "do") {
      v.requests = (v.requests ?? 0) + nz(s.requests);
      v.errors = (v.errors ?? 0) + nz(s.errors);
      if (n(s.wallTime) !== null) v.sample.wall_time_ms = Math.round(((v.sample.wall_time_ms as number | undefined) ?? 0) + nz(s.wallTime) / 1000);
      if (d.scriptName) v.sample.script = String(d.scriptName).slice(0, 63);
    } else {
      v.neurons = Math.round(((v.neurons ?? 0) + nz(s.totalNeurons)) * 100) / 100;
    }
    out.set(subject, v);
  }
  return [...out.values()].filter((v) => (v.requests ?? 0) > 0 || (v.neurons ?? 0) > 0 || (v.rows_read ?? 0) > 0 || (v.rows_written ?? 0) > 0)
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

/** The start of the last complete UTC hour before `now`. */
export const lastCompleteHour = (now: number) => new Date(Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS).toISOString();

export function observerCredentials(env: ObserverEnv): { token: string; account: string } | null {
  const token = (env.CF_ANALYTICS_TOKEN || env.CF_BILLING_TOKEN)?.trim();
  const account = env.CF_ACCOUNT_ID?.trim().toLowerCase();
  return token && account && ACCOUNT.test(account) ? { token, account } : null;
}

/** Read one hour of every dataset. A dataset that errors is recorded as such and adds nothing. */
export async function readSenses(token: string, account: string, hour: string, fetcher: Fetch): Promise<Senses> {
  const s = hour;
  const e = new Date(Date.parse(hour) + HOUR_MS - 1000).toISOString().replace(".000Z", "Z");
  const vars = { a: account, s: s.replace(".000Z", "Z"), e };
  const datasets: Senses["datasets"] = {};
  const vitals: Vital[] = [];
  let top: Senses["top_queries"] = [];
  const run = async (key: keyof typeof OBSERVER_QUERIES) => {
    try { return await gql(fetcher, token, OBSERVER_QUERIES[key], vars); } catch (err) { datasets[key] = `error: ${String((err as Error)?.message ?? err).slice(0, 160)}`; return null; }
  };
  const [w, d1, d1q, kv, dobj, ai] = await Promise.all([run("workers"), run("d1"), run("d1_queries"), run("kv"), run("do"), run("ai")]);
  const add = (key: string, rows: Vital[] | null) => {
    if (rows === null) return;
    datasets[key] = rows.length ? "ok" : "no_data";
    vitals.push(...rows);
  };
  add("workers", w ? parseWorkers(w, hour) : null);
  add("d1", d1 ? parseGroups(d1.g, "d1", hour) : null);
  add("kv", kv ? parseGroups(kv.g, "kv", hour) : null);
  add("do", dobj ? parseGroups(dobj.g, "do", hour) : null);
  add("ai", ai ? parseGroups(ai.g, "ai", hour) : null);
  if (d1q) {
    top = (Array.isArray(d1q.g) ? d1q.g : []).map((r: any) => ({
      database: String(r?.dimensions?.databaseId ?? ""), query: String(r?.dimensions?.query ?? "").replace(/\s+/g, " ").slice(0, 200),
      rows_read: nz(r?.sum?.rowsRead), rows_written: nz(r?.sum?.rowsWritten), count: n(r?.count),
    })).filter((q: { database: string; query: string }) => q.database && q.query);
    datasets.d1_queries = top.length ? "ok" : "no_data";
  }
  return { hour, vitals, datasets, top_queries: top };
}

// ------------------------------------------------------------------------------------- Workers Observability

/** The API token permission the telemetry query needs (Cloudflare dashboard, API token permission groups). */
export const OBSERVABILITY_PERMISSION = "Account > Workers Observability > Read";
export const observabilityUrl = (account: string) => `https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`;

export type TopErrors = { status: "ok"; by_worker: Record<string, Array<{ message: string; count: number }>> }
  | { status: "permission_missing"; http: number } | { status: "unavailable"; reason: string };

/** Top error messages per Worker for the hour (at most 3 per Worker, 160 characters each). */
export async function readTopErrors(token: string, account: string, hour: string, fetcher: Fetch): Promise<TopErrors> {
  const from = Date.parse(hour);
  let res: Response;
  try {
    res = await fetcher(observabilityUrl(account), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        queryId: "observer-top-errors", view: "calculations", limit: 30,
        timeframe: { from, to: from + HOUR_MS },
        parameters: {
          filters: [{ key: "$workers.outcome", operation: "neq", type: "string", value: "ok" }],
          calculations: [{ operator: "count" }],
          groupBys: [{ type: "string", value: "$workers.scriptName" }, { type: "string", value: "$metadata.message" }],
          limit: 30,
        },
      }),
    });
  } catch (err) {
    return { status: "unavailable", reason: String((err as Error)?.message ?? err).slice(0, 120) };
  }
  if (res.status === 401 || res.status === 403) { await res.body?.cancel(); return { status: "permission_missing", http: res.status }; }
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok || !body || body.success === false) return { status: "unavailable", reason: `observability_http_${res.status}` };
  const aggregates: any[] = body?.result?.calculations?.[0]?.aggregates ?? [];
  const by: Record<string, Array<{ message: string; count: number }>> = {};
  for (const a of Array.isArray(aggregates) ? aggregates : []) {
    const groups: Array<{ key?: string; value?: unknown }> = Array.isArray(a?.groups) ? a.groups : [];
    const script = String(groups.find((g) => g.key === "$workers.scriptName")?.value ?? "").trim();
    const message = String(groups.find((g) => g.key === "$metadata.message")?.value ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    const count = n(a?.count) ?? n(a?.value) ?? 0;
    if (!script || !message || count <= 0) continue;
    (by[script] ??= []).push({ message, count });
  }
  for (const k of Object.keys(by)) by[k] = by[k].sort((x, y) => y.count - x.count).slice(0, 3);
  return { status: "ok", by_worker: by };
}

// ---------------------------------------------------------------------------------------------- detection

export interface SinceDeploy { version: string; deployed_at: string }
export interface Finding {
  worker: string;
  metric: string;
  kind: "anomaly" | "early_warning" | "inventory" | "capability";
  severity: "info" | "warning";
  bucket: string;
  value: number | null;
  baseline_7d: number | null;
  z: number | null;
  since_deploy: SinceDeploy | null;
  sample: Record<string, unknown>;
  detail: string;
  report_only: boolean;
}

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };

/** The baseline of a rate (errors or exceptions per request) over the 7 days before the hour. */
export function rateBaseline(history: Vital[], pick: (v: Vital) => number | null): { mean: number | null; std: number | null; hours: number; days: number } {
  const usable = history.filter((v) => (v.requests ?? 0) >= THRESHOLDS.RATE_HOUR_MIN_REQUESTS && pick(v) !== null);
  const total = history.reduce((a, v) => a + (v.requests ?? 0), 0);
  const bad = history.reduce((a, v) => a + (pick(v) ?? 0), 0);
  const first = history.length ? Math.min(...history.map((v) => Date.parse(v.hour))) : null;
  const last = history.length ? Math.max(...history.map((v) => Date.parse(v.hour))) : null;
  const days = first !== null && last !== null ? round((last + HOUR_MS - first) / DAY_MS, 2) : 0;
  return {
    mean: total > 0 ? bad / total : null,
    std: usable.length >= THRESHOLDS.MIN_BASELINE_HOURS ? std(usable.map((v) => (pick(v) ?? 0) / (v.requests as number))) : null,
    hours: usable.length, days,
  };
}

/**
 * Error or exception spike of one Worker in one hour, against its own 7-day baseline. Null unless every minimum
 * holds: >= 200 requests, >= 20 errors (exceptions), a rate >= 5 %, >= 3x the baseline rate and, when a baseline of
 * at least 6 usable hours exists, z >= 3. Without such a baseline the finding is still reported, with z null (the
 * Supervisor never acts on it).
 */
export function rateAnomaly(metric: "error_rate" | "exception_rate", current: Vital, history: Vital[]): Omit<Finding, "since_deploy" | "report_only"> | null {
  const pick = metric === "error_rate" ? (v: Vital) => v.errors : (v: Vital) => v.exceptions;
  const requests = current.requests ?? 0;
  const bad = pick(current);
  if (bad === null || requests < THRESHOLDS.MIN_REQUESTS || bad < THRESHOLDS.MIN_ERRORS) return null;
  const rate = bad / requests;
  if (rate < THRESHOLDS.MIN_ERROR_RATE) return null;
  const b = rateBaseline(history, pick);
  if (b.mean !== null && rate < THRESHOLDS.MIN_RATIO * b.mean) return null;
  const z = b.std !== null && b.mean !== null ? (rate - b.mean) / Math.max(b.std, THRESHOLDS.RATE_STD_FLOOR) : null;
  if (z !== null && z < THRESHOLDS.MIN_Z) return null;
  const label = metric === "error_rate" ? "errors" : "exceptions";
  return {
    worker: current.subject, metric, kind: "anomaly", severity: "warning", bucket: current.hour,
    value: round(rate), baseline_7d: b.mean === null ? null : round(b.mean), z: z === null ? null : round(z, 2),
    sample: { requests, [label]: bad, baseline_hours: b.hours, baseline_days: b.days, ratio: b.mean ? round(rate / b.mean, 2) : null },
    detail: `${current.subject}: ${bad} ${label} in ${requests} requests (${(rate * 100).toFixed(1)} %) in the hour from ${current.hour.slice(11, 16)} UTC; baseline ${b.mean === null ? "none yet" : `${(b.mean * 100).toFixed(2)} % over ${b.hours} h`}`,
  };
}

/** CPU early warning: p99 at or above 80 % of the Worker's limit. */
export function cpuWarning(current: Vital, history: Vital[], repoWorkers: ReadonlySet<string>): Omit<Finding, "since_deploy" | "report_only"> | null {
  if (current.cpu_p99_ms === null || (current.requests ?? 0) < THRESHOLDS.CPU_MIN_REQUESTS) return null;
  const { limit_ms, source } = cpuLimit(current.subject, repoWorkers);
  if (current.cpu_p99_ms < THRESHOLDS.CPU_WARN_RATIO * limit_ms) return null;
  const past = history.map((v) => v.cpu_p99_ms).filter((v): v is number => v !== null);
  const base = past.length ? mean(past) : null;
  const sd = past.length >= THRESHOLDS.MIN_BASELINE_HOURS ? std(past) : null;
  return {
    worker: current.subject, metric: "cpu_p99_near_limit", kind: "early_warning", severity: "warning", bucket: current.hour,
    value: current.cpu_p99_ms, baseline_7d: base === null ? null : round(base, 2), z: sd && base !== null ? round((current.cpu_p99_ms - base) / Math.max(sd, 1), 2) : null,
    sample: { requests: current.requests, limit_ms, limit_source: source, ratio: round(current.cpu_p99_ms / limit_ms, 3) },
    detail: `${current.subject}: CPU p99 ${current.cpu_p99_ms} ms is ${Math.round((current.cpu_p99_ms / limit_ms) * 100)} % of its ${limit_ms} ms limit (${source.replace(/_/g, " ")})`,
  };
}

/** D1 / KV / Durable Object / AI load spike of one resource (advisory). Missing hours in the window count as zero. */
export function loadSpike(current: Vital, history: Vital[], topQueries: Senses["top_queries"] = []): Omit<Finding, "since_deploy" | "report_only"> | null {
  if (current.kind === "worker") return null;
  const kind = current.kind;
  const val = (v: Vital) => (kind === "d1" ? v.rows_read : kind === "ai" ? v.neurons : v.requests) ?? 0;
  const value = val(current);
  if (value < THRESHOLDS.LOAD_MIN[kind]) return null;
  if (!history.length) return null;
  const first = Math.min(...history.map((v) => Date.parse(v.hour)));
  const hours = Math.max(1, Math.round((Date.parse(current.hour) - first) / HOUR_MS));
  if (hours < THRESHOLDS.MIN_BASELINE_HOURS) return null;
  const byHour = new Map(history.map((v) => [v.hour, val(v)]));
  const series = Array.from({ length: hours }, (_, i) => byHour.get(new Date(first + i * HOUR_MS).toISOString()) ?? 0);
  const m = mean(series); const sd = std(series);
  if (value < THRESHOLDS.MIN_RATIO * m) return null;
  const z = (value - m) / Math.max(sd, 1);
  if (z < THRESHOLDS.MIN_Z) return null;
  const unit = kind === "d1" ? "rows read" : kind === "ai" ? "neurons" : kind === "kv" ? "operations" : "requests";
  const id = current.subject.slice(kind.length + 1);
  const queries = kind === "d1" ? topQueries.filter((q) => q.database === id).slice(0, 3) : [];
  const script = typeof current.sample.script === "string" ? current.sample.script : null;
  return {
    worker: current.subject, metric: `${kind}_load`, kind: "anomaly", severity: "warning", bucket: current.hour,
    value, baseline_7d: round(m, 2), z: round(z, 2),
    sample: { unit, baseline_hours: hours, ...(queries.length ? { top_queries: queries } : {}), ...(script ? { script } : {}), ...(current.rows_written !== null ? { rows_written: current.rows_written } : {}) },
    detail: `${current.subject}: ${value.toLocaleString("en-US")} ${unit} in the hour from ${current.hour.slice(11, 16)} UTC, ${round(value / Math.max(m, 1), 1)}x its 7-day mean`
      + (queries.length ? `; most rows read by: ${queries[0].query.slice(0, 120)}` : "") + (script ? `; Worker ${script}` : ""),
  };
}

// ------------------------------------------------------------------------------------------------ deploys

export interface DeployRecord { worker: string; version: string; previous: string | null; deployed_at: string; actor: string; rollback: boolean }

/**
 * The most recent change of a Worker's recorded version (registry.desired_version_set in the audit chain: every
 * deploy workflow, native deploy and rollback records one). `rollback` is true when that change was a rollback.
 */
export async function latestDeploy(db: D1Database, worker: string): Promise<DeployRecord | null> {
  const row = await db.prepare(
    "SELECT actor, payload_json, created_at FROM audit_events WHERE event_type = 'registry.desired_version_set' AND subject = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).bind(worker).first<{ actor: string; payload_json: string; created_at: string }>();
  if (!row) return null;
  let p: { previous?: unknown; desired_version?: unknown } = {};
  try { p = JSON.parse(row.payload_json); } catch { return null; }
  if (typeof p.desired_version !== "string" || !p.desired_version) return null;
  return {
    worker, version: p.desired_version, previous: typeof p.previous === "string" && /^[0-9a-f]{12}$/.test(p.previous) ? p.previous : null,
    deployed_at: row.created_at, actor: row.actor, rollback: /^rollback:/.test(row.actor),
  };
}

/** Recent deploys of all Workers (the Console's timeline marks). */
export async function recentDeploys(db: D1Database, since: string, limit = 60): Promise<DeployRecord[]> {
  const rows = (await db.prepare(
    "SELECT subject, actor, payload_json, created_at FROM audit_events WHERE event_type = 'registry.desired_version_set' AND created_at >= ? ORDER BY created_at DESC LIMIT ?",
  ).bind(since, limit).all<{ subject: string; actor: string; payload_json: string; created_at: string }>()).results ?? [];
  const out: DeployRecord[] = [];
  for (const r of rows) {
    let p: { previous?: unknown; desired_version?: unknown } = {};
    try { p = JSON.parse(r.payload_json); } catch { continue; }
    if (typeof p.desired_version !== "string") continue;
    out.push({ worker: r.subject, version: p.desired_version, previous: typeof p.previous === "string" ? p.previous : null, deployed_at: r.created_at, actor: r.actor, rollback: /^rollback:/.test(r.actor) });
  }
  return out;
}

export function sinceDeploy(deploy: DeployRecord | null, hour: string): SinceDeploy | null {
  if (!deploy) return null;
  const end = Date.parse(hour) + HOUR_MS; const at = Date.parse(deploy.deployed_at);
  return at < end && end - at <= THRESHOLDS.SINCE_DEPLOY_MS ? { version: deploy.version, deployed_at: deploy.deployed_at } : null;
}

// --------------------------------------------------------------------------------------------- the gate

export interface RollbackCandidate {
  finding: Pick<Finding, "worker" | "metric" | "bucket" | "value" | "baseline_7d" | "z" | "since_deploy" | "sample">;
  /** The Worker's most recent version change, read now. */
  deploy: DeployRecord | null;
  /** service_registry.desired_version, read now. */
  desired_version: string | null;
  /** A rollback_worker_version proposal for this target within the cooldown (any status). */
  recent_rollback_proposal: boolean;
  /** Open critical reports (the consensus brake); unreadable counts as open. */
  brake_open: boolean;
  now: number;
}
export type GateResult = { propose: true; version: string; evidence: Record<string, unknown> } | { propose: false; report_only: boolean; reason: string };

/** Whether the platform can roll the Worker back today: a deploy unit of this repository, and not the kernel itself. */
export const rollbackCapable = (worker: string) => worker !== SELF_WORKER && !REPORT_ONLY_WORKERS.has(worker) && unitForService(worker) !== null;

/**
 * Every safeguard before a rollback proposal (production, no shadow phase; owner 2026-11-14). The consensus, the
 * brake (checked again by every voter), the Supervisor's rate window and the Policy Engine still apply after this.
 */
export function rollbackGate(c: RollbackCandidate): GateResult {
  const f = c.finding;
  const no = (reason: string, report_only = false): GateResult => ({ propose: false, report_only, reason });
  if (TRADING_WORKERS.has(f.worker)) return no("trading Worker: report only, never rolled back by the platform", true);
  if (REPORT_ONLY_WORKERS.has(f.worker)) return no("observed-only Worker: report only", true);
  if (f.worker === SELF_WORKER) return no("the AI Kernel is not rolled back by its own Supervisor: report only", true);
  if (!rollbackCapable(f.worker)) return no("no platform deploy unit: the platform cannot roll this Worker back; report only", true);
  if (f.metric !== "error_rate" && f.metric !== "exception_rate") return no("only an error or exception spike can lead to a rollback");
  const s = f.sample as { requests?: number; errors?: number; exceptions?: number; baseline_days?: number; baseline_hours?: number };
  if ((s.baseline_days ?? 0) < THRESHOLDS.ROLLBACK_BASELINE_DAYS || (s.baseline_hours ?? 0) < THRESHOLDS.ROLLBACK_BASELINE_HOURS) {
    return no(`baseline of ${s.baseline_days ?? 0} days / ${s.baseline_hours ?? 0} h is under ${THRESHOLDS.ROLLBACK_BASELINE_DAYS} days / ${THRESHOLDS.ROLLBACK_BASELINE_HOURS} h; reported only`);
  }
  const bad = f.metric === "error_rate" ? s.errors : s.exceptions;
  if ((s.requests ?? 0) < THRESHOLDS.MIN_REQUESTS || (bad ?? 0) < THRESHOLDS.MIN_ERRORS) return no("under the minimum requests or errors");
  if (f.value === null || f.value < THRESHOLDS.MIN_ERROR_RATE) return no("rate under the minimum");
  if (f.baseline_7d === null || f.value < THRESHOLDS.MIN_RATIO * f.baseline_7d) return no("rate under 3x the baseline");
  if (f.z === null || f.z < THRESHOLDS.MIN_Z) return no("z under the minimum");
  const d = c.deploy;
  if (!d || !f.since_deploy) return no("no deploy of this Worker before the spike");
  if (d.rollback) return no("the Worker's most recent change was a rollback");
  if (d.version !== f.since_deploy.version || d.deployed_at !== f.since_deploy.deployed_at) return no("the spike is not about the Worker's most recent deploy");
  if (c.desired_version !== d.version) return no("the most recent deploy is no longer the recorded version");
  const at = Date.parse(d.deployed_at); const start = Date.parse(f.bucket);
  if (!(start + HOUR_MS > at && start < at + THRESHOLDS.POST_DEPLOY_WINDOW_MS)) return no("the spike is outside the 2 h after the deploy");
  if (c.now - at > THRESHOLDS.PROPOSAL_DEADLINE_MS) return no("more than 3 h since the deploy");
  if (!d.previous) return no("no previous version recorded to roll back to");
  if (c.recent_rollback_proposal) return no("a rollback of this Worker was proposed in the last 6 h");
  if (c.brake_open) return no("a critical report is open: the brake holds");
  return {
    propose: true, version: d.previous,
    evidence: {
      metric: f.metric, value: f.value, baseline_7d: f.baseline_7d, z: f.z, hour: f.bucket,
      requests: s.requests ?? null, [f.metric === "error_rate" ? "errors" : "exceptions"]: bad ?? null,
      baseline_days: s.baseline_days ?? null, deployed: { version: d.version, deployed_at: d.deployed_at }, rollback_to: d.previous,
    },
  };
}

// -------------------------------------------------------------------------------------------- storage

export async function loadHistory(db: D1Database, hour: string): Promise<Map<string, Vital[]>> {
  const from = new Date(Date.parse(hour) - THRESHOLDS.IDLE_DAYS * DAY_MS).toISOString();
  const rows = (await db.prepare(
    `SELECT subject, kind, hour, requests, errors, rows_read, rows_written, neurons, cpu_p50_ms, cpu_p99_ms, wall_p50_ms, wall_p99_ms,
       exceeded_cpu, exceeded_memory, exceptions FROM observer_vitals WHERE hour >= ? AND hour < ?`,
  ).bind(from, hour).all<Omit<Vital, "sample">>()).results ?? [];
  const map = new Map<string, Vital[]>();
  for (const r of rows) (map.get(r.subject) ?? map.set(r.subject, []).get(r.subject)!).push({ ...r, sample: {} });
  return map;
}

export async function storeVitals(db: D1Database, vitals: Vital[], at: string): Promise<void> {
  if (!vitals.length) return;
  const stmts = vitals.map((v) => db.prepare(
    `INSERT INTO observer_vitals (subject, kind, hour, requests, errors, rows_read, rows_written, neurons, cpu_p50_ms, cpu_p99_ms, wall_p50_ms, wall_p99_ms,
       exceeded_cpu, exceeded_memory, exceptions, sample_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (subject, hour) DO UPDATE SET requests = excluded.requests, errors = excluded.errors, rows_read = excluded.rows_read,
       rows_written = excluded.rows_written, neurons = excluded.neurons, cpu_p50_ms = excluded.cpu_p50_ms, cpu_p99_ms = excluded.cpu_p99_ms,
       wall_p50_ms = excluded.wall_p50_ms, wall_p99_ms = excluded.wall_p99_ms, exceeded_cpu = excluded.exceeded_cpu,
       exceeded_memory = excluded.exceeded_memory, exceptions = excluded.exceptions, sample_json = excluded.sample_json, recorded_at = excluded.recorded_at`,
  ).bind(v.subject, v.kind, v.hour, v.requests, v.errors, v.rows_read, v.rows_written, v.neurons, v.cpu_p50_ms, v.cpu_p99_ms, v.wall_p50_ms, v.wall_p99_ms,
    v.exceeded_cpu, v.exceeded_memory, v.exceptions, JSON.stringify(v.sample).slice(0, 2000), at));
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
}

/** Insert findings; one per (worker, metric, bucket), so a retried run adds nothing. Returns the ones that were new. */
export async function storeFindings(db: D1Database, findings: Finding[], at: string): Promise<Finding[]> {
  const fresh: Finding[] = [];
  for (const f of findings) {
    const r = await db.prepare(
      `INSERT INTO observer_findings (finding_id, worker, metric, kind, severity, bucket, value, baseline_7d, z, since_deploy_json, sample_json, detail, report_only, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (worker, metric, bucket) DO NOTHING`,
    ).bind(`obs_${crypto.randomUUID()}`, f.worker, f.metric, f.kind, f.severity, f.bucket, f.value, f.baseline_7d, f.z,
      f.since_deploy ? JSON.stringify(f.since_deploy) : null, JSON.stringify(f.sample).slice(0, 2000), f.detail.slice(0, 500), f.report_only ? 1 : 0, at).run();
    if ((r.meta?.changes ?? 0) > 0) fresh.push(f);
  }
  return fresh;
}

export interface StoredFinding extends Finding { finding_id: string; created_at: string }
export async function readFindings(db: D1Database, sinceIso: string, where = "1 = 1", binds: unknown[] = [], limit = 100): Promise<StoredFinding[]> {
  const rows = (await db.prepare(
    `SELECT * FROM observer_findings WHERE created_at >= ? AND ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).bind(sinceIso, ...binds, limit).all<Record<string, any>>()).results ?? [];
  const parse = (v: unknown, d: unknown) => { try { return v ? JSON.parse(String(v)) : d; } catch { return d; } };
  return rows.map((r) => ({
    finding_id: r.finding_id, worker: r.worker, metric: r.metric, kind: r.kind, severity: r.severity, bucket: r.bucket,
    value: r.value, baseline_7d: r.baseline_7d, z: r.z, since_deploy: parse(r.since_deploy_json, null), sample: parse(r.sample_json, {}),
    detail: r.detail, report_only: r.report_only === 1, created_at: r.created_at,
  }));
}

export async function recordRun(db: D1Database, run: { kind: "senses" | "inventory"; bucket: string; ran_at: string; status: string; datasets: unknown; findings?: unknown; digest?: string | null }): Promise<void> {
  await db.prepare(
    `INSERT INTO observer_runs (run_id, kind, bucket, ran_at, status, datasets_json, findings_json, digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (kind, bucket) DO UPDATE SET ran_at = excluded.ran_at, status = excluded.status, datasets_json = excluded.datasets_json,
       findings_json = excluded.findings_json, digest = excluded.digest`,
  ).bind(`obr_${crypto.randomUUID()}`, run.kind, run.bucket, run.ran_at, run.status, JSON.stringify(run.datasets ?? {}).slice(0, 4000),
    JSON.stringify(run.findings ?? []).slice(0, 16000), run.digest ?? null).run();
}

/** Retention, once a day: vitals and runs 30 days, findings 90 days. */
export async function sweepObserver(db: D1Database, now: number): Promise<void> {
  await db.prepare("DELETE FROM observer_vitals WHERE hour < ?").bind(new Date(now - VITALS_RETENTION_DAYS * DAY_MS).toISOString()).run();
  await db.prepare("DELETE FROM observer_runs WHERE ran_at < ?").bind(new Date(now - RUNS_RETENTION_DAYS * DAY_MS).toISOString()).run();
  await db.prepare("DELETE FROM observer_findings WHERE created_at < ?").bind(new Date(now - FINDINGS_RETENTION_DAYS * DAY_MS).toISOString()).run();
}

/** Has a capability finding of this metric been recorded in the last 24 h (then the call is not repeated)? */
export async function capabilityMissingRecently(db: D1Database, metric: string, now: number): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS x FROM observer_findings WHERE kind = 'capability' AND metric = ? AND created_at >= ? LIMIT 1")
    .bind(metric, new Date(now - DAY_MS).toISOString()).first();
  return Boolean(row);
}

// ----------------------------------------------------------------------------------------------- the run

export interface SensesOutcome {
  outcome: "not_configured" | "recorded" | "unavailable";
  hour?: string;
  vitals?: number;
  findings?: Finding[];
  datasets?: Record<string, string>;
}

/** Workers of this repository (the census genome's platform organs), for the CPU limit's source label. */
export async function repoWorkers(db: D1Database): Promise<Set<string>> {
  const row = await db.prepare("SELECT genome FROM forge_organism_census ORDER BY taken_at DESC LIMIT 1").first<{ genome: string | null }>().catch(() => null);
  try {
    const g = JSON.parse(row?.genome ?? "[]") as Array<{ service?: string; origin?: string }>;
    return new Set(g.filter((d) => d && !d.origin && typeof d.service === "string").map((d) => d.service as string));
  } catch { return new Set(); }
}

/**
 * One hourly sensing run: read the last complete hour, store the vitals, detect against the stored baseline, store
 * the findings. Missing data adds no finding.
 */
export async function runSenses(env: ObserverEnv, now: number, fetcher: Fetch): Promise<SensesOutcome> {
  const creds = observerCredentials(env);
  if (!creds || !env.DB) return { outcome: "not_configured" };
  const db = env.DB;
  const hour = lastCompleteHour(now);
  const at = new Date(now).toISOString();
  const senses = await readSenses(creds.token, creds.account, hour, fetcher);
  const workers = senses.vitals.filter((v) => v.kind === "worker");
  // Top error messages only when a Worker had errors, and not while the token is known to lack the permission.
  if (workers.some((v) => (v.errors ?? 0) > 0)) {
    if (await capabilityMissingRecently(db, "observability_permission_missing", now)) {
      senses.datasets.observability = "error: permission missing (checked again after 24 h)";
    } else {
      const top = await readTopErrors(creds.token, creds.account, hour, fetcher);
      if (top.status === "ok") {
        senses.datasets.observability = Object.keys(top.by_worker).length ? "ok" : "no_data";
        for (const v of workers) if (top.by_worker[v.subject]) v.sample.top_errors = top.by_worker[v.subject];
      } else if (top.status === "permission_missing") {
        senses.datasets.observability = `error: http ${top.http}`;
        await storeFindings(db, [{
          worker: "account", metric: "observability_permission_missing", kind: "capability", severity: "info", bucket: at.slice(0, 10),
          value: null, baseline_7d: null, z: null, since_deploy: null, sample: { http: top.http, permission: OBSERVABILITY_PERMISSION, api: "workers/observability/telemetry/query" },
          detail: `The Observer's token may not read Workers Observability (HTTP ${top.http}); top error messages need the permission ${OBSERVABILITY_PERMISSION} on the same token (owner)`,
          report_only: true,
        }], at);
      } else {
        senses.datasets.observability = `error: ${top.reason}`;
      }
    }
  }
  const allFailed = Object.entries(senses.datasets).filter(([k]) => k !== "observability").every(([, s]) => s.startsWith("error"));
  if (allFailed) {
    await recordRun(db, { kind: "senses", bucket: hour, ran_at: at, status: "unavailable", datasets: senses.datasets });
    return { outcome: "unavailable", hour, datasets: senses.datasets };
  }
  const history = await loadHistory(db, hour);
  const repo = await repoWorkers(db);
  const findings: Finding[] = [];
  for (const v of senses.vitals) {
    const past = history.get(v.subject) ?? [];
    if (v.kind === "worker") {
      const deploy = await latestDeploy(db, v.subject);
      const since = sinceDeploy(deploy, v.hour);
      const reportOnly = !rollbackCapable(v.subject);
      for (const metric of ["error_rate", "exception_rate"] as const) {
        const a = rateAnomaly(metric, v, past);
        if (a) findings.push({ ...a, since_deploy: since, report_only: reportOnly, sample: { ...a.sample, ...(v.sample.top_errors ? { top_errors: v.sample.top_errors } : {}) } });
      }
      const cpu = cpuWarning(v, past, repo);
      if (cpu) findings.push({ ...cpu, since_deploy: since, report_only: true });
    } else {
      const l = loadSpike(v, past, senses.top_queries);
      if (l) findings.push({ ...l, since_deploy: null, report_only: true });
    }
  }
  await storeVitals(db, senses.vitals, at);
  const fresh = await storeFindings(db, findings, at);
  const failed = Object.values(senses.datasets).some((s) => s.startsWith("error"));
  await recordRun(db, { kind: "senses", bucket: hour, ran_at: at, status: failed ? "partial" : "ok", datasets: senses.datasets, findings: fresh.map((f) => ({ worker: f.worker, metric: f.metric })) });
  return { outcome: "recorded", hour, vitals: senses.vitals.length, findings: fresh, datasets: senses.datasets };
}

// ------------------------------------------------------------------------------------------- the view

/** GET /v1/observer: vitals per organ (48 h), resources, findings (7 days), deploys (7 days), the last runs. */
export async function observerView(env: ObserverEnv, now = Date.now()): Promise<Record<string, unknown>> {
  const configured = Boolean(observerCredentials(env));
  const base = { schema: "observer.v1", observed_at: new Date(now).toISOString(), configured, cron: OBSERVER_CRON, thresholds: THRESHOLDS,
    source: "Cloudflare GraphQL Analytics API (measured); Workers Observability (top errors, when the token may read it)" };
  if (!env.DB) return { ...base, available: false, organs: [], resources: [], anomalies: [], deploys: [], last_senses: null, last_inventory: null, estimates: null };
  const db = env.DB;
  try {
    const since48 = new Date(Math.floor(now / HOUR_MS) * HOUR_MS - 48 * HOUR_MS).toISOString();
    const rows = (await db.prepare(
      `SELECT subject, kind, hour, requests, errors, rows_read, rows_written, neurons, cpu_p50_ms, cpu_p99_ms, wall_p99_ms, exceeded_cpu, exceeded_memory, exceptions
       FROM observer_vitals WHERE hour >= ? ORDER BY hour ASC LIMIT 5000`,
    ).bind(since48).all<Record<string, any>>()).results ?? [];
    const group = new Map<string, Record<string, any>[]>();
    for (const r of rows) (group.get(r.subject) ?? group.set(r.subject, []).get(r.subject)!).push(r);
    const organs: unknown[] = []; const resources: unknown[] = [];
    for (const [subject, series] of group) {
      const last = series[series.length - 1];
      const kind = String(last.kind);
      if (kind === "worker") {
        organs.push({
          worker: subject, last_hour: last.hour,
          measured: { requests: last.requests, errors: last.errors, error_rate: last.requests ? round(last.errors / last.requests) : null, cpu_p99_ms: last.cpu_p99_ms, exceptions: last.exceptions, exceeded_cpu: last.exceeded_cpu, exceeded_memory: last.exceeded_memory },
          series: series.map((s) => ({ hour: s.hour, requests: s.requests, error_rate: s.requests ? round(s.errors / s.requests) : null, cpu_p99_ms: s.cpu_p99_ms })),
        });
      } else {
        resources.push({
          subject, kind, last_hour: last.hour,
          measured: { requests: last.requests, rows_read: last.rows_read, rows_written: last.rows_written, neurons: last.neurons, rows_per_query: kind === "d1" && last.requests ? round(last.rows_read / last.requests, 1) : null },
          series: series.map((s) => ({ hour: s.hour, value: kind === "d1" ? s.rows_read : kind === "ai" ? s.neurons : s.requests })),
        });
      }
    }
    // Estimated (labelled so): the account's D1 rows read per Worker request in the last measured hour. D1 is not
    // attributed to a Worker by the analytics, so no per-Worker figure is shown.
    const lastHour = rows.length ? rows[rows.length - 1].hour : null;
    const inHour = rows.filter((r) => r.hour === lastHour);
    const req = inHour.filter((r) => r.kind === "worker").reduce((a, r) => a + (r.requests ?? 0), 0);
    const read = inHour.filter((r) => r.kind === "d1").reduce((a, r) => a + (r.rows_read ?? 0), 0);
    const estimates = lastHour && req > 0 && inHour.some((r) => r.kind === "d1")
      ? { rows_per_request: { value: round(read / req, 2), hour: lastHour, measured: false, basis: "estimated: all D1 rows read on the account divided by all Worker requests in the hour" } }
      : null;
    const since7 = new Date(now - 7 * DAY_MS).toISOString();
    const anomalies = await readFindings(db, since7, "1 = 1", [], 200);
    const deploys = await recentDeploys(db, since7, 100);
    const lastRun = async (kind: string) => {
      const r = await db.prepare("SELECT bucket, ran_at, status, datasets_json, findings_json FROM observer_runs WHERE kind = ? ORDER BY ran_at DESC LIMIT 1").bind(kind).first<Record<string, string>>();
      if (!r) return null;
      const parse = (v: string, d: unknown) => { try { return JSON.parse(v); } catch { return d; } };
      return { bucket: r.bucket, ran_at: r.ran_at, status: r.status, datasets: parse(r.datasets_json, {}), findings: parse(r.findings_json, []) };
    };
    return { ...base, available: true, organs, resources, estimates, anomalies, deploys, last_senses: await lastRun("senses"), last_inventory: await lastRun("inventory") };
  } catch (err) {
    return { ...base, available: false, error: String((err as Error)?.message ?? err).slice(0, 160), organs: [], resources: [], anomalies: [], deploys: [], last_senses: null, last_inventory: null, estimates: null };
  }
}
