// Owner 2026-11-12 ("apakah pembatasan sudah sesuai batas free tier build cloudflare?" → "ya kerjakan opsi 2"):
// the Workers Builds minutes this account uses this month, measured from the builds the Forge collects
// (workers/forge/src/build-usage.ts, migration 0049), against the free-tier allowance.
//
// Measured only (AGENTS.md, Console truthfulness): a build counts with its measured duration, from its start
// (initializing, else running, else created) to its stop, rounded up to whole minutes per build. Cloudflare does
// not publish its rounding, so rounding up per build is the conservative reading. A build without both times is
// counted as unmeasured, never guessed (its month is that of its creation). The month is the UTC calendar month; the billing cycle may differ.
import type { D1Database } from "./types.ts";

/** Workers Builds included build minutes a month (developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing, 2026-10-28). */
export const BUILD_MINUTES_INCLUDED = { free: 3000, paid: 6000 } as const;
/** The budget the platform holds itself to: the free-tier allowance (owner 2026-11-12), although the account is on Workers Paid. */
export const BUILD_MINUTES_BUDGET = BUILD_MINUTES_INCLUDED.free;
/** Warn when the month's measured minutes, or their projection to the month's end, reach this share of the budget. */
export const BUILD_WARN_RATIO = 0.8;
/** A collection older than this (three missed hourly runs) makes the figure stale. */
export const BUILD_USAGE_STALE_MS = 3 * 3_600_000;

export type BuildUsageStatus = "no_data" | "stale" | "ok" | "warning" | "over";

export interface BuildUsage {
  schema: "build-usage.v1";
  month: string;
  month_start: string;
  budget_minutes: number;
  included_minutes: typeof BUILD_MINUTES_INCLUDED;
  warn_ratio: number;
  minutes: number;
  builds: number;
  unmeasured_builds: number;
  avg_minutes: number | null;
  projected_minutes: number | null;
  status: BuildUsageStatus;
  by_worker: Array<{ worker: string; builds: number; minutes: number; unmeasured: number }>;
  by_day: Array<{ day: string; builds: number; minutes: number }>;
  last_collection: { collected_at: string; outcome: string; workers: number; builds_seen: number; builds_new: number; error: string | null } | null;
  observed_at: string;
}

export function monthStart(nowMs: number): Date {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function daysInMonth(start: Date): number {
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Status from measured minutes and their linear projection; the projection needs a day of the month to be meaningful. */
export function usageStatus(minutes: number, projected: number | null, budget = BUILD_MINUTES_BUDGET): "ok" | "warning" | "over" {
  if (minutes >= budget) return "over";
  if (minutes >= budget * BUILD_WARN_RATIO || (projected !== null && projected >= budget * BUILD_WARN_RATIO)) return "warning";
  return "ok";
}

/** The month's measured build minutes. Returns null before migration 0049 exists. Read-only. */
export async function buildUsage(db: D1Database, nowMs = Date.now()): Promise<BuildUsage | null> {
  const start = monthStart(nowMs);
  const startIso = start.toISOString();
  let rows: Array<{ worker: string; builds: number; minutes: number | null; unmeasured: number }>;
  let days: Array<{ day: string; builds: number; minutes: number | null }>;
  let last: BuildUsage["last_collection"] = null;
  try {
    rows = (await db.prepare(
      `SELECT worker, COUNT(*) AS builds, SUM(billed_minutes) AS minutes, SUM(CASE WHEN billed_minutes IS NULL THEN 1 ELSE 0 END) AS unmeasured
         FROM forge_builds WHERE COALESCE(stopped_on, created_on) >= ? GROUP BY worker ORDER BY minutes DESC, worker`,
    ).bind(startIso).all<{ worker: string; builds: number; minutes: number | null; unmeasured: number }>()).results ?? [];
    days = (await db.prepare(
      `SELECT substr(COALESCE(stopped_on, created_on), 1, 10) AS day, COUNT(*) AS builds, SUM(billed_minutes) AS minutes
         FROM forge_builds WHERE COALESCE(stopped_on, created_on) >= ? GROUP BY day ORDER BY day`,
    ).bind(startIso).all<{ day: string; builds: number; minutes: number | null }>()).results ?? [];
    last = await db.prepare("SELECT collected_at, outcome, workers, builds_seen, builds_new, error FROM forge_build_collections ORDER BY collected_at DESC LIMIT 1")
      .first<NonNullable<BuildUsage["last_collection"]>>() ?? null;
  } catch {
    return null;
  }
  const minutes = rows.reduce((s, r) => s + (r.minutes ?? 0), 0);
  const builds = rows.reduce((s, r) => s + r.builds, 0);
  const unmeasured = rows.reduce((s, r) => s + r.unmeasured, 0);
  const measured = builds - unmeasured;
  const elapsedDays = (nowMs - start.getTime()) / 86_400_000;
  const projected = elapsedDays >= 1 ? Math.round((minutes / elapsedDays) * daysInMonth(start)) : null;
  let status: BuildUsageStatus;
  if (!last) status = "no_data";
  else if (nowMs - Date.parse(last.collected_at) > BUILD_USAGE_STALE_MS) status = "stale";
  else status = usageStatus(minutes, projected);
  return {
    schema: "build-usage.v1",
    month: startIso.slice(0, 7),
    month_start: startIso,
    budget_minutes: BUILD_MINUTES_BUDGET,
    included_minutes: BUILD_MINUTES_INCLUDED,
    warn_ratio: BUILD_WARN_RATIO,
    minutes,
    builds,
    unmeasured_builds: unmeasured,
    avg_minutes: measured > 0 ? Math.round((minutes / measured) * 10) / 10 : null,
    projected_minutes: projected,
    status,
    by_worker: rows.map((r) => ({ worker: r.worker, builds: r.builds, minutes: r.minutes ?? 0, unmeasured: r.unmeasured })),
    by_day: days.map((d) => ({ day: d.day, builds: d.builds, minutes: d.minutes ?? 0 })),
    last_collection: last,
    observed_at: new Date(nowMs).toISOString(),
  };
}
