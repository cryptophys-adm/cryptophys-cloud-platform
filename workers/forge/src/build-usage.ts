// Owner 2026-11-12 ("ya kerjakan opsi 2"): measure the Workers Builds minutes of the whole account.
//
// Once an hour (any Forge tick at least USAGE_INTERVAL_MS after the last collection), with its own
// CF_BUILDS_API_TOKEN, the Forge lists the account's Workers, then each Worker's builds and the builds of its
// Previews (cr/<n> branches build there), newest first, until it reaches a build it already holds. Each finished
// build is kept with its measured duration (migration 0049); control-plane-shared/src/build-usage.ts sums the
// month against the free-tier budget. The Forge only reads (GET); the token is never logged or stored.
// A Worker that is not connected to Workers Builds answers 404 for its builds and is skipped.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { api, type Fetch } from "./cr-builds.ts";

export const USAGE_INTERVAL_MS = 55 * 60_000;
/** Pages of 50 builds per Worker per collection (the newest 200 builds). */
export const MAX_PAGES = 4;
/** Preview build lists per collection (the change requests updated in the last 48 h first). */
export const MAX_PREVIEW_LISTS = 30;
/** Every Builds API request of one collection. */
export const MAX_REQUESTS = 200;
export const BUILDS_RETENTION_DAYS = 100;
export const COLLECTIONS_RETENTION_DAYS = 30;

export interface BuildUsageEnv { DB: D1Database; CF_BUILDS_API_TOKEN?: string }

type Row = Record<string, unknown>;
const FINISHED = new Set(["stopped", "completed", "success", "failure", "failed", "canceled", "cancelled", "skipped"]);
const ID = /[^A-Za-z0-9_-]/g;

/** A timestamp field of a build, in either spelling the API uses (created_on) or the events use (createdAt). */
function when(b: Row, name: string): string | null {
  const camel = name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  for (const k of [`${name}_on`, `${name}_at`, `${camel}At`, `${camel}On`]) {
    const v = b[k];
    if (typeof v === "string" && Number.isFinite(Date.parse(v))) return new Date(Date.parse(v)).toISOString();
  }
  return null;
}

export interface MeasuredBuild {
  build_uuid: string; status: string | null; outcome: string | null; branch: string | null; commit_sha: string | null;
  created_on: string | null; started_on: string | null; stopped_on: string | null;
  duration_s: number | null; billed_minutes: number | null; queued_s: number | null; finished: boolean;
}

/** The measured fields of one build: its duration from its start (initializing, else running, else created) to its stop. */
export function measure(b: Row): MeasuredBuild | null {
  const uuid = String(b.build_uuid ?? b.buildUuid ?? "").replace(ID, "").slice(0, 64);
  if (!uuid) return null;
  const meta = (b.build_trigger_metadata ?? b.buildTriggerMetadata ?? {}) as Row;
  const status = typeof b.status === "string" ? b.status : null;
  const outcome = typeof (b.build_outcome ?? b.buildOutcome) === "string" ? String(b.build_outcome ?? b.buildOutcome) : null;
  const created = when(b, "created");
  const started = when(b, "initializing") ?? when(b, "running") ?? created;
  const running = when(b, "running");
  const stopped = when(b, "stopped");
  const finished = Boolean(stopped) || Boolean(outcome) || (status !== null && FINISHED.has(status));
  const duration = started && stopped ? Math.max(0, Math.round((Date.parse(stopped) - Date.parse(started)) / 1000)) : null;
  const queued = created && running ? Math.max(0, Math.round((Date.parse(running) - Date.parse(created)) / 1000)) : null;
  const text = (v: unknown, n: number) => (typeof v === "string" && v ? v.slice(0, n) : null);
  return {
    build_uuid: uuid, status, outcome,
    branch: text(meta.branch, 200), commit_sha: text(meta.commit_hash ?? meta.commitHash ?? meta.commit_sha, 64)?.toLowerCase() ?? null,
    created_on: created, started_on: started, stopped_on: stopped,
    duration_s: duration, billed_minutes: duration === null ? null : Math.max(1, Math.ceil(duration / 60)), queued_s: queued, finished,
  };
}

async function store(db: D1Database, worker: string, previewId: string | null, m: MeasuredBuild, nowIso: string): Promise<void> {
  await db.prepare(
    `INSERT INTO forge_builds (build_uuid, worker, preview_id, branch, commit_sha, status, outcome, created_on, started_on, stopped_on, duration_s, billed_minutes, queued_s, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(build_uuid) DO UPDATE SET status = excluded.status, outcome = excluded.outcome, started_on = excluded.started_on,
       stopped_on = excluded.stopped_on, duration_s = excluded.duration_s, billed_minutes = excluded.billed_minutes, queued_s = excluded.queued_s, seen_at = excluded.seen_at`,
  ).bind(m.build_uuid, worker, previewId, m.branch, m.commit_sha, m.status, m.outcome, m.created_on, m.started_on, m.stopped_on, m.duration_s, m.billed_minutes, m.queued_s, nowIso).run();
}

/** One collection of the account's Workers Builds; at most once per USAGE_INTERVAL_MS. Never throws for an unconfigured Forge. */
export async function buildUsageTick(env: BuildUsageEnv, nowMs = Date.now(), fetchImpl: Fetch = fetch): Promise<Record<string, unknown>> {
  const token = env.CF_BUILDS_API_TOKEN?.trim();
  if (!token) return { outcome: "not_configured" };
  const last = await env.DB.prepare("SELECT MAX(collected_at) AS at FROM forge_build_collections").first<{ at: string | null }>();
  if (last?.at && nowMs - Date.parse(last.at) < USAGE_INTERVAL_MS) return { outcome: "not_due", last: last.at };
  const nowIso = new Date(nowMs).toISOString();
  let requests = 0;
  const get = async (path: string) => { requests++; return api(fetchImpl, token, path); };
  let seen = 0, fresh = 0, workers = 0, errors = 0;
  let firstError: string | null = null;
  const fail = (e: unknown) => { errors++; firstError ??= String((e as Error)?.message ?? e).slice(0, 200); };
  const known = new Set(((await env.DB.prepare("SELECT build_uuid FROM forge_builds WHERE stopped_on IS NOT NULL OR outcome IS NOT NULL").all<{ build_uuid: string }>()).results ?? []).map((r) => r.build_uuid));

  /** Record the finished builds of one list; true when the list reached a build already held. */
  const take = async (worker: string, previewId: string | null, list: Row[]): Promise<boolean> => {
    let reachedKnown = false;
    for (const raw of list) {
      const m = measure(raw);
      if (!m) continue;
      seen++;
      if (known.has(m.build_uuid)) { reachedKnown = true; continue; }
      if (!m.finished) continue; // a running build is taken when it has finished
      await store(env.DB, worker, previewId, m, nowIso);
      known.add(m.build_uuid);
      fresh++;
    }
    return reachedKnown;
  };

  try {
    const accounts = await get("/accounts?per_page=5") as Array<{ id?: string }>;
    const account = String(accounts?.[0]?.id ?? "").replace(ID, "");
    if (!account) throw new Error("no_account");
    const scripts = (await get(`/accounts/${account}/workers/scripts`) as Array<{ id?: string; tag?: string }>) ?? [];
    const recentCrs = new Set(((await env.DB.prepare("SELECT number FROM forge_change_requests WHERE updated_at >= ?")
      .bind(new Date(nowMs - 48 * 3_600_000).toISOString()).all<{ number: number }>()).results ?? []).map((r) => `cr/${r.number}`));
    const previewQueue: Array<{ worker: string; tag: string; id: string; recent: boolean }> = [];
    for (const s of scripts) {
      const worker = String(s.id ?? "").slice(0, 100);
      const tag = String(s.tag ?? "").replace(ID, "");
      if (!worker || !tag || requests >= MAX_REQUESTS) continue;
      let connected = true;
      for (let page = 1; page <= MAX_PAGES && requests < MAX_REQUESTS; page++) {
        let list: Row[];
        try { list = ((await get(`/accounts/${account}/builds/workers/${tag}/builds?per_page=50&page=${page}`)) as Row[]) ?? []; } catch (e) {
          if (/builds_api_404/.test(String((e as Error)?.message))) connected = false; else fail(e);
          break;
        }
        if (await take(worker, null, list) || list.length < 50) break;
      }
      if (!connected) continue;
      workers++;
      if (requests >= MAX_REQUESTS) break;
      try {
        const previews = ((await get(`/accounts/${account}/builds/workers/${tag}/previews`)) as Row[]) ?? [];
        for (const p of previews) {
          const id = String(p.preview_id ?? p.id ?? "").replace(ID, "");
          if (id) previewQueue.push({ worker, tag, id, recent: recentCrs.has(String(p.branch ?? "")) });
        }
      } catch (e) { if (!/builds_api_404/.test(String((e as Error)?.message))) fail(e); }
    }
    // Previews with a recently updated change request first, then those never collected.
    const held = new Set(((await env.DB.prepare("SELECT DISTINCT preview_id FROM forge_builds WHERE preview_id IS NOT NULL").all<{ preview_id: string }>()).results ?? []).map((r) => r.preview_id));
    const order = [...previewQueue.filter((p) => p.recent), ...previewQueue.filter((p) => !p.recent && !held.has(p.id))].slice(0, MAX_PREVIEW_LISTS);
    for (const p of order) {
      if (requests >= MAX_REQUESTS) break;
      try { await take(p.worker, p.id, ((await get(`/accounts/${account}/builds/workers/${p.tag}/previews/${p.id}/builds`)) as Row[]) ?? []); } catch (e) { fail(e); }
    }
  } catch (e) {
    fail(e);
    await env.DB.prepare("INSERT OR REPLACE INTO forge_build_collections (collected_at, outcome, workers, builds_seen, builds_new, error) VALUES (?, 'failed', ?, ?, ?, ?)")
      .bind(nowIso, workers, seen, fresh, firstError).run();
    return { outcome: "failed", error: firstError, requests };
  }
  const outcome = errors ? "partial" : "collected";
  await env.DB.prepare("INSERT OR REPLACE INTO forge_build_collections (collected_at, outcome, workers, builds_seen, builds_new, error) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(nowIso, outcome, workers, seen, fresh, firstError).run();
  await env.DB.prepare("DELETE FROM forge_builds WHERE COALESCE(stopped_on, created_on, seen_at) < ?").bind(new Date(nowMs - BUILDS_RETENTION_DAYS * 86_400_000).toISOString()).run();
  await env.DB.prepare("DELETE FROM forge_build_collections WHERE collected_at < ?").bind(new Date(nowMs - COLLECTIONS_RETENTION_DAYS * 86_400_000).toISOString()).run();
  return { outcome, workers, builds_seen: seen, builds_new: fresh, requests, errors };
}

/** The newest collected builds, for the Console. */
export async function recentBuilds(db: D1Database, limit = 15): Promise<unknown[]> {
  const n = Math.max(1, Math.min(50, Math.trunc(limit) || 15));
  try {
    return (await db.prepare(`SELECT build_uuid, worker, branch, commit_sha, outcome, status, created_on, stopped_on, duration_s, billed_minutes, queued_s
      FROM forge_builds ORDER BY COALESCE(stopped_on, created_on) DESC LIMIT ?`).bind(n).all()).results ?? [];
  } catch { return []; }
}
