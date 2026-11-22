// The Organism page's Telemetry tab (frontend mockup 2026-11-22, owner approved: "lanjutkan semua dan tetap berkoordinasi
// dengan orkestrator"): the part without JSX, so the platform tests run it. Every number comes from GET /v1/telemetry on
// the AI Kernel (route kernel.telemetry). A bucket the API sends as null had no point: it is shown as "—" or a gap, never
// as 0; hours before the dataset's first point are hatched as "no data" (AGENTS.md: measured data only).

export const MISSING = "—";
/** The tail of the series is folded into "Other": the top 3 agents, the top 2 capabilities (by the window's syscalls). */
export const FOLD_TOP = { agent: 3, capability: 2 } as const;
export const OTHER = "Other";
export type TelemetryGroup = keyof typeof FOLD_TOP;
export type TelemetryWindow = "24h" | "7d";
export const WINDOWS: TelemetryWindow[] = ["24h", "7d"];
export const GROUPS: TelemetryGroup[] = ["agent", "capability"];

export type Cells = Array<number | null>;
export interface SeriesRow { key: string; syscalls: Cells; denied: Cells; failed: Cells }
export interface TotalRow { key: string; syscalls: number | null; denied: number | null; failed: number | null; deny_rate: number | null; fail_rate: number | null; latency_ms: { p50: number | null; p95: number | null } }
export interface JobRow { subject: string; service: string; runs: number | null; failed: number | null; duration_ms: { p50: number | null; p95: number | null }; runs_by_bucket: Cells; failed_by_bucket: Cells }
export interface Folded { key: string; label: string; folded: string[]; syscalls: Cells; total: number | null }

export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown): number | null => (isNum(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** An API array aligned with `n` buckets; anything but a number is null (no point). */
export const cells = (v: unknown, n: number): Cells => Array.from({ length: n }, (_, i) => (Array.isArray(v) ? numOrNull(v[i]) : null));
/** A sum over values that may be missing: null when every one is missing (no point), never 0. */
export const sumOrNull = (vs: Cells): number | null => (vs.some(isNum) ? vs.reduce<number>((s, v) => s + (isNum(v) ? v : 0), 0) : null);

export const count = (v: unknown): string => (isNum(v) ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : MISSING);
export const rate = (v: unknown): string => (isNum(v) ? `${(v * 100).toFixed(v > 0 && v < 0.01 ? 2 : 1)} %` : MISSING);
export const ms = (v: unknown): string => (isNum(v) ? `${v.toLocaleString("en-US", { maximumFractionDigits: 1 })} ms` : MISSING);
export const keyLabel = (k: string): string => (k ? k : "(none)");

/** The buckets of a response (ISO hour starts, oldest first) and its bucket length in ms. */
export function bucketsOf(body: any): { buckets: string[]; bucketMs: number } {
  const buckets = Array.isArray(body?.buckets) ? body.buckets.filter((b: unknown) => typeof b === "string") : [];
  return { buckets, bucketMs: (isNum(body?.bucket_s) ? body.bucket_s : 3600) * 1000 };
}

/**
 * How many leading buckets end before the dataset's first point (`first_point_at`): those hours are hatched as
 * "no data". With no first point at all, every bucket is "no data".
 */
export function noDataBuckets(buckets: string[], firstPointAt: unknown, bucketMs: number): number {
  const first = typeof firstPointAt === "string" ? Date.parse(firstPointAt) : Number.NaN;
  if (!Number.isFinite(first)) return buckets.length;
  let n = 0;
  for (const b of buckets) { if (Date.parse(b) + bucketMs <= first) n += 1; else break; }
  return n;
}

export function seriesOf(body: any, n: number): SeriesRow[] {
  return (Array.isArray(body?.series) ? body.series : []).map((s: any) => ({ key: str(s?.key), syscalls: cells(s?.syscalls, n), denied: cells(s?.denied, n), failed: cells(s?.failed, n) }));
}
export function totalsOf(body: any): TotalRow[] {
  return (Array.isArray(body?.totals) ? body.totals : []).map((t: any) => ({ key: str(t?.key), syscalls: numOrNull(t?.syscalls), denied: numOrNull(t?.denied), failed: numOrNull(t?.failed),
    deny_rate: numOrNull(t?.deny_rate), fail_rate: numOrNull(t?.fail_rate), latency_ms: { p50: numOrNull(t?.latency_ms?.p50), p95: numOrNull(t?.latency_ms?.p95) } }));
}
export function jobsOf(body: any, n: number): JobRow[] {
  return (Array.isArray(body?.jobs) ? body.jobs : []).map((j: any) => ({ subject: str(j?.subject), service: str(j?.service), runs: numOrNull(j?.runs), failed: numOrNull(j?.failed),
    duration_ms: { p50: numOrNull(j?.duration_ms?.p50), p95: numOrNull(j?.duration_ms?.p95) }, runs_by_bucket: cells(j?.runs_by_bucket, n), failed_by_bucket: cells(j?.failed_by_bucket, n) }));
}

/** The keys shown as their own series, in the API's order of `totals` (most syscalls first); the rest fold into Other. */
export function topKeys(totals: TotalRow[], group: TelemetryGroup): string[] {
  return totals.slice(0, FOLD_TOP[group]).map((t) => t.key);
}

/**
 * Syscalls per hour by series: the top keys (FOLD_TOP) as they are, the rest summed per bucket into "Other" (null where
 * every folded key had no point). The totals are the API's own `totals`, summed for Other.
 */
export function foldSeries(series: SeriesRow[], totals: TotalRow[], group: TelemetryGroup, n: number): Folded[] {
  const top = topKeys(totals, group);
  const byKey = new Map(series.map((s) => [s.key, s]));
  const out: Folded[] = top.map((k) => ({ key: k, label: keyLabel(k), folded: [], syscalls: byKey.get(k)?.syscalls ?? cells(null, n), total: totals.find((t) => t.key === k)?.syscalls ?? null }));
  const rest = [...new Set([...totals.map((t) => t.key), ...series.map((s) => s.key)])].filter((k) => !top.includes(k));
  if (rest.length) {
    const restSeries = rest.map((k) => byKey.get(k)?.syscalls ?? cells(null, n));
    out.push({ key: `__${OTHER}`, label: `${OTHER} (${rest.length})`, folded: rest, syscalls: Array.from({ length: n }, (_, i) => sumOrNull(restSeries.map((c) => c[i]))),
      total: sumOrNull(totals.filter((t) => rest.includes(t.key)).map((t) => t.syscalls)) });
  }
  return out;
}

export interface DeployMark { at: string; version: string; previous: string | null; x: number }
/** Deploy markers of the window: `x` is the share of the window (0..1) at which the version first wrote a point. */
export function deployMarks(body: any, buckets: string[], bucketMs: number): DeployMark[] {
  if (!buckets.length) return [];
  const from = Date.parse(buckets[0]);
  const span = buckets.length * bucketMs;
  return (Array.isArray(body?.deploys) ? body.deploys : [])
    .map((d: any) => ({ at: str(d?.at), version: str(d?.deploy_version), previous: typeof d?.previous === "string" ? d.previous : null, x: (Date.parse(str(d?.at)) - from) / span }))
    .filter((d: DeployMark) => d.version && Number.isFinite(d.x) && d.x >= 0 && d.x <= 1);
}

export type Tone = "ok" | "late" | "fault" | "off";
/** The header status port's tones: cyan ok, amber late, red fault, grey off (not measured). Green is for bullish only. */
export const TONE_COLOR: Record<Tone, string> = { ok: "#22d3ee", late: "#fbbf24", fault: "#ef4444", off: "#94a3b8" };
/** A share of denied (late) or failed (fault) calls: grey when not measured, cyan at 0. */
export const shareTone = (v: unknown, kind: "denied" | "failed"): Tone => (!isNum(v) ? "off" : v > 0 ? (kind === "failed" ? "fault" : "late") : "ok");

export type CronCell = "nodata" | "none" | "ok" | "fault";
/** One cell of the failed-cron-runs grid: hatched before the first point, empty without a run, cyan when none failed. */
export const cronCell = (runs: number | null, failed: number | null, beforeFirst: boolean): CronCell =>
  beforeFirst ? "nodata" : !isNum(runs) || runs <= 0 ? "none" : isNum(failed) && failed > 0 ? "fault" : "ok";

/** A bucket's start as an axis label: hours for a day, the date at midnight for a week (UTC). */
export function hourLabel(iso: string, week: boolean): string {
  const d = new Date(iso);
  const hh = `${String(d.getUTCHours()).padStart(2, "0")}:00`;
  return week ? `${d.getUTCDate()}/${d.getUTCMonth() + 1}` : hh;
}
export function hourTitle(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1} ${String(d.getUTCHours()).padStart(2, "0")}:00 UTC`;
}
