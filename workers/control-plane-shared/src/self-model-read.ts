// ADR-0016 (Telos) T1b (docs/design/TELOS-T1-SELF-MODEL.md §2.1, §5.2 step 3, §5.4, §5.5; owner 2026-11-22, "setuju
// semua"): the per-source readers of the daily self-model. Read-only and not wired to anything yet (T1d adds the job).
//
// - One source is one table of §2.1 (two for the trading organ and the knowledge audit, which are agent_reports), read by
//   at most two fixed, parameterised SELECTs, each with a LIMIT and on an index of the real migrations
//   (test/self-model-assemble-t1b.test.ts checks every plan). At most 40 statements a run (SELF_MODEL_MAX_STATEMENTS).
// - Every query reads rows with a time at or before window_end (created_at, hour, observed_at, taken_at, decided_at,
//   ran_at, outcome_at, stopped_on, started_at, period_day, day). The exceptions are the point-in-time sources (the
//   registry, the controls, the autonomy dial, adr_progress, the ADR Steward's agent row), read as they are now and
//   marked point_in_time.
// - A source that fails is `unavailable`, one whose table does not exist is `missing_table`, one past its time budget
//   (3 s, or what is left of the run's 20 s) is `budget_exceeded`; the rest go on. A source that read no row is `empty`.
// - The trading organ's body never leaves its reader: it goes through organHealthWhitelist (the presentOrganHealth
//   whitelist of ai-kernel/src/syscall.ts) first, so no price, level or text can reach a section.
// - Identities are read only where a pure function needs them and never returned: corrections' actor and target_ref feed
//   teachingRecord inside the reader, which returns counts and scores only.
//
// It imports no kernel, consensus, trading, policy or AI module, and it writes nothing (test/self-model-boundary-t1.test.ts).
import { DEPLOY_UNITS } from "./deploy-units.ts";
import { isPersistentDrift } from "./drift-state.ts";
import { EXTERNAL_ORIGINS } from "./organism.ts";
import { notRetiredSql } from "./retired.ts";
import type { SourceStatus } from "./self-model.ts";
import { teachingRecord, type TeachingRow } from "./teaching-record.ts";

// ---------------------------------------------------------------- the D1 interface (as adr-evidence.ts uses it)

/** The read-only part of a D1 binding the readers use. A D1Database satisfies it. */
export interface SelfModelStatement {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface SelfModelDb {
  prepare(sql: string): { bind(...values: unknown[]): SelfModelStatement };
}

/** §5.4: at most this many statements a run. */
export const SELF_MODEL_MAX_STATEMENTS = 40;
/** §5.4: the wall budget of one source and of the whole run. */
export const SOURCE_BUDGET_MS = 3_000;
export const RUN_BUDGET_MS = 20_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------- the windows (§5.2 step 2)

/** The bounds every query binds, all derived from the day: ISO times with milliseconds, as the tables store them. */
export interface SelfModelWindows {
  day: string;
  /** 00:00 UTC of the day after `day`, with milliseconds ("YYYY-MM-DDT00:00:00.000Z"). */
  end: string;
  endMs: number;
  /** end − 24 h (the day itself), end − 7 d and end − 30 d. */
  h24: string;
  d7: string;
  d30: string;
  /** The first day of the window in YYYY-MM-DD for day-bucketed tables (the window is that day through `day`). */
  day7: string;
  day30: string;
  /** The first day of the UTC month of `day`, as a day and as a time. */
  monthDay: string;
  monthStart: string;
}

const isoMs = (ms: number) => new Date(ms).toISOString();
/** A time as the document states it: ISO UTC, with milliseconds only when they are not zero (the contract takes both). */
const isoOut = (ms: number) => isoMs(ms).replace(/\.000Z$/, "Z");
const dayOf = (ms: number) => isoMs(ms).slice(0, 10);

/** The windows of one UTC day, or null for a day that is not a calendar date. */
export function selfModelWindows(day: string): SelfModelWindows | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const start = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(start) || dayOf(start) !== day) return null;
  const endMs = start + DAY_MS;
  return {
    day, end: isoMs(endMs), endMs,
    h24: isoMs(endMs - DAY_MS), d7: isoMs(endMs - 7 * DAY_MS), d30: isoMs(endMs - 30 * DAY_MS),
    day7: dayOf(start - 6 * DAY_MS), day30: dayOf(start - 29 * DAY_MS),
    monthDay: `${day.slice(0, 7)}-01`, monthStart: `${day.slice(0, 7)}-01T00:00:00.000Z`,
  };
}

// ---------------------------------------------------------------- the trading organ whitelist (§8)

/** ORGAN_HEALTH_METRICS of ai-kernel/src/signal-analyst.ts (pinned by the T1b test): the only metric names read. */
export const ORGAN_HEALTH_METRIC_NAMES = [
  "decisions_24h", "share_buy_24h", "share_sell_24h", "share_wait_24h", "share_no_trade_24h", "latest_decision_age_bars", "flips_24h",
  "confidence_mean_24h", "confidence_p50_24h", "confidence_min_24h", "confidence_max_24h", "hit_rate_7d", "hit_rate_30d",
  "staleness_incidents_24h", "staleness_incidents_7d",
] as const;
export type OrganHealthMetricName = (typeof ORGAN_HEALTH_METRIC_NAMES)[number];

export interface OrganHealthMetric {
  metric: string;
  value: number | null;
  baseline_7d: number | null;
  z: number | null;
  status?: string;
  n_directional?: number | null;
  hit?: number | null;
  miss?: number | null;
  wait_accuracy?: number | null;
  subject?: string | null;
  as_of?: string | null;
}
export interface OrganHealth { observed_at: string | null; bar_minutes: number | null; stale: boolean | null; metrics: OrganHealthMetric[] }

const finiteOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const HIT_RATE_STATUSES: ReadonlySet<unknown> = new Set(["ok", "no_scored_data", "unavailable_source_field"]);

/**
 * The presentOrganHealth whitelist (ai-kernel/src/syscall.ts), field for field: only the known fields of a
 * trading_organ_health.v1 body, each of the expected type, numbers and names, no text. The T1b test proves it gives
 * what presentOrganHealth gives. This module cannot import the kernel (§8), so it holds its own copy.
 */
export function organHealthWhitelist(bodyJson: string): OrganHealth {
  let body: any = {};
  try { body = JSON.parse(bodyJson); } catch { body = {}; }
  const metrics = (Array.isArray(body?.metrics) ? body.metrics : []).slice(0, 32)
    .filter((m: any) => m && typeof m.metric === "string" && /^[a-z0-9_]{1,40}$/.test(m.metric))
    .map((m: any) => {
      const out: OrganHealthMetric = { metric: m.metric, value: finiteOrNull(m.value), baseline_7d: finiteOrNull(m.baseline_7d), z: finiteOrNull(m.z) };
      if (HIT_RATE_STATUSES.has(m.status)) out.status = m.status;
      if (/^hit_rate_/.test(m.metric)) {
        for (const k of ["n_directional", "hit", "miss", "wait_accuracy"] as const) if (k in m) out[k] = finiteOrNull(m[k]);
        if ("subject" in m) out.subject = typeof m.subject === "string" && /^[a-z0-9:_-]{1,40}$/.test(m.subject) ? m.subject : null;
        if ("as_of" in m) out.as_of = typeof m.as_of === "string" && /^[0-9TZ:.+-]{10,40}$/.test(m.as_of) ? m.as_of : null;
      }
      return out;
    });
  return {
    observed_at: typeof body?.observed_at === "string" ? body.observed_at.slice(0, 40) : null,
    bar_minutes: finiteOrNull(body?.bar_minutes),
    stale: typeof body?.stale === "boolean" ? body.stale : null,
    metrics,
  };
}

// ---------------------------------------------------------------- what the readers return

type Row = Record<string, unknown>;
export interface CountRow { n: number; newest: string | null }
export interface RegistryRow { service_id: string; status: string; desired_version: string | null; observed_version: string | null; updated_at: string }
export interface VitalsWorkerRow {
  subject: string; newest: string; hours_24h: number; hours_7d: number; hours_30d: number;
  req_24h: number | null; err_24h: number | null; cpu_24h: number | null; exc_24h: number | null;
  req_7d: number | null; err_7d: number | null; cpu_7d: number | null; exc_7d: number | null;
  req_30d: number | null; err_30d: number | null;
}
export interface VitalsKindRow {
  kind: string; n: number; newest: string; n_day: number; newest_day: string | null;
  requests_day: number | null; rows_read_day: number | null; rows_written_day: number | null; neurons_day: number | null; neurons_30d: number | null;
}
export interface TeachingSubject {
  subject: string;
  n_7d: number; score_7d: number | null; last_7d: string | null;
  n_30d: number; score_30d: number | null; last_30d: string | null;
}
export interface CorrectionCount { label: string; source: string; side: string; created_at: string }

/** What each source's reader returns: rows already reduced to counts, names and whitelisted numbers. */
export interface SourceData {
  service_registry: { rows: RegistryRow[] };
  drift_observations: { persistent: string[]; services: number; newest: string };
  deployment_requests: { by_status: { status: string; n_7d: number; n_30d: number; newest: string; newest_7d: string | null }[] };
  consensus_proposals: {
    by_status_class: { status: string; class: string; n: number; newest: string }[];
    rollbacks: { proposal_id: string; decided_at: string; finding_at: string | null }[];
  };
  forge_change_requests: { merged: number; by_consensus: number; by_owner: number; newest: string };
  kernel_controls: { agents_enabled: { value: string; updated_at: string } | null };
  consensus_controls: { mode: { value: string; updated_at: string } | null };
  metabolism_controls: { power_mode: { value: string; updated_at: string } | null };
  evolver_controls: { mode: { value: string; updated_at: string } | null };
  autonomy_dial: { rows: { group_id: string; level: string; source: string; set_at: string }[] };
  trading_organ_health: { report_id: string; created_at: string; health: OrganHealth };
  knowledge_audit: { report_id: string; agent_id: string; subject: string; created_at: string };
  observer_vitals: { workers: VitalsWorkerRow[]; kinds: VitalsKindRow[] };
  observer_findings: {
    by_kind: { kind: string; n: number; newest: string; learning_volume: number; learning_repeat: number; with_z: number }[];
    top: { finding_id: string; worker: string; metric: string; kind: string; z: number; created_at: string }[];
  };
  /** The newest inventory run's findings counted by metric; null when its findings_json is not a list (truncated). */
  observer_runs: { run_id: string; ran_at: string; status: string; by_metric: Record<string, number> | null };
  forge_organism_census: { main_sha: string; status: string; organs: number; agents: number; engines: number; voters: number; findings: number | null; taken_at: string; origins_read: string[] | null };
  infra_burn_metrics: { by_service: { service_id: string; days: number; cost_usd: number; newest: string }[] };
  forge_builds: { builds: number; minutes: number | null; unmeasured: number; newest: string };
  forge_dependency_audits: { run_id: string; status: string; critical: number; high: number; moderate: number; ran_at: string };
  ai_usage: { by_service: { service_id: string; days: number; requests: number; failures: number; newest_day: string }[] };
  ai_failures: { groups: { task: string; category: string; n: number; newest_day: string }[] };
  councils: { by_state: { state: string; n: number; calls: number; usd: number; newest: string }[] };
  evolution_intents_v2: { by_state: { state: string; n: number; newest: string }[] };
  evolutions_v2: { by_state: { state: string; n: number; ai_calls: number; refused: number; newest: string }[] };
  corrections: { rows: CorrectionCount[]; teaching: TeachingSubject[] };
  knowledge_proposals: { by_kind_status: { kind: string; status: string; n: number; newest: string }[]; pending: CountRow };
  agent_memories: { by_agent: { agent_id: string; n: number; newest: string }[] };
  adr_progress: { rows: { adr_id: string; status: string; percent: number; percent_proven: number; changed_at: string; drift_count: number | null; stale: string | null }[] };
  agents: { adr_steward: { status: string; updated_at: string } };
}
export type SourceId = keyof SourceData;

/** One source as read: its status and, when it read rows, its data. */
export interface SourceReading<K extends SourceId = SourceId> {
  id: K;
  status: SourceStatus;
  rows: number | null;
  as_of: string | null;
  point_in_time: boolean;
  data: SourceData[K] | null;
}
export type SelfModelReadings = { [K in SourceId]: SourceReading<K> };

// ---------------------------------------------------------------- helpers

/** An ISO UTC time (as isoOut writes it), or null when the text is not a time. */
export function isoTime(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? isoOut(t) : null;
}
/** The newest of a list of times (as ISO with milliseconds), or null. */
export function newestOf(values: readonly unknown[]): string | null {
  let best: number | null = null;
  for (const v of values) {
    const t = typeof v === "string" ? Date.parse(v) : NaN;
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : isoOut(best);
}
/** A day bucket (YYYY-MM-DD) as the time its bucket starts. */
export const dayStart = (d: unknown): string | null => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? isoTime(`${d}T00:00:00Z`) : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : typeof v === "number" && Number.isFinite(v) ? v : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

/** A statement runner that counts and bounds what one run asks of D1. */
class Query {
  statements = 0;
  private readonly db: SelfModelDb;
  constructor(db: SelfModelDb) { this.db = db; }
  private stmt(sql: string, args: unknown[]): SelfModelStatement {
    if (++this.statements > SELF_MODEL_MAX_STATEMENTS) throw new Error(`self_model: more than ${SELF_MODEL_MAX_STATEMENTS} statements`);
    return this.db.prepare(sql).bind(...args);
  }
  async all<T = Row>(sql: string, ...args: unknown[]): Promise<T[]> { return (await this.stmt(sql, args).all<T>()).results ?? []; }
  async first<T = Row>(sql: string, ...args: unknown[]): Promise<T | null> { return (await this.stmt(sql, args).first<T>()) ?? null; }
}

/** What a reader found: its data (null when it read no row), the rows that went into it, and the newest row's time. */
interface ReadResult<K extends SourceId> { data: SourceData[K] | null; rows: number; as_of: string | null }
interface SourceSpec<K extends SourceId> { id: K; point_in_time: boolean; read(q: Query, w: SelfModelWindows): Promise<ReadResult<K>> }
const empty = <K extends SourceId>(): ReadResult<K> => ({ data: null, rows: 0, as_of: null });

const PLATFORM_WORKERS: readonly string[] = DEPLOY_UNITS.flatMap((u) => [...u.services]);
const EXTERNAL_WORKERS: readonly string[] = EXTERNAL_ORIGINS.flatMap((o) => [...o.services]);
/** The Workers whose vitals the self-model reads: the platform's deploy units and the external organs (§3 Body, Ecosystem). */
export const VITALS_SUBJECTS: readonly string[] = [...new Set([...PLATFORM_WORKERS, ...EXTERNAL_WORKERS])].sort();
const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");
/** The length of a JSON list of findings, or null when it is not one. */
function findingsCount(v: unknown): number | null {
  try { const list = JSON.parse(str(v)); return Array.isArray(list) ? list.length : null; } catch { return null; }
}
const controlRow = (r: Row | null) => (r ? { value: str(r.value), updated_at: str(r.updated_at) } : null);

// ---------------------------------------------------------------- the readers (§2.1)

const SOURCES: { [K in SourceId]: SourceSpec<K> } = {
  service_registry: {
    id: "service_registry", point_in_time: true,
    async read(q) {
      const rows = (await q.all<RegistryRow>(
        `SELECT service_id, status, desired_version, observed_version, updated_at FROM service_registry WHERE ${notRetiredSql()} ORDER BY service_id LIMIT 200`,
      )).map((r) => ({ service_id: str(r.service_id), status: str(r.status), desired_version: r.desired_version ?? null, observed_version: r.observed_version ?? null, updated_at: str(r.updated_at) }));
      return rows.length ? { data: { rows }, rows: rows.length, as_of: newestOf(rows.map((r) => r.updated_at)) } : empty();
    },
  },
  drift_observations: {
    id: "drift_observations", point_in_time: false,
    async read(q, w) {
      // The two newest observations at or before window_end of each service that is not retired (drift-state.ts).
      const rows = await q.all<{ service_id: string; drifted: number; streak: number | null; observed_at: string }>(
        `SELECT d.service_id, d.drifted, d.streak, d.observed_at FROM service_registry r JOIN drift_observations d ON d.rowid IN (
           SELECT x.rowid FROM drift_observations x WHERE x.service_id = r.service_id AND x.observed_at <= ? ORDER BY x.observed_at DESC, x.rowid DESC LIMIT 2)
         WHERE ${notRetiredSql("r.")} ORDER BY r.service_id, d.observed_at DESC, d.rowid DESC LIMIT 400`, w.end);
      if (!rows.length) return empty();
      const by = new Map<string, { drifted: number; streak: number | null; observed_at: string }[]>();
      for (const r of rows) {
        const list = by.get(r.service_id) ?? [];
        list.push({ drifted: num(r.drifted), streak: r.streak === null ? null : num(r.streak), observed_at: str(r.observed_at) });
        by.set(r.service_id, list);
      }
      const persistent = [...by].filter(([, list]) => isPersistentDrift(list)).map(([s]) => s).sort();
      return { data: { persistent, services: by.size, newest: newestOf(rows.map((r) => r.observed_at))! }, rows: rows.length, as_of: newestOf(rows.map((r) => r.observed_at)) };
    },
  },
  deployment_requests: {
    id: "deployment_requests", point_in_time: false,
    async read(q, w) {
      const rows = await q.all(
        `SELECT status, COUNT(*) AS n_30d, SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS n_7d, MAX(created_at) AS newest,
                MAX(CASE WHEN created_at > ? THEN created_at END) AS newest_7d
           FROM deployment_requests WHERE created_at > ? AND created_at <= ? GROUP BY status ORDER BY status LIMIT 16`, w.d7, w.d7, w.d30, w.end);
      const by_status = rows.map((r) => ({ status: str(r.status), n_7d: num(r.n_7d), n_30d: num(r.n_30d), newest: str(r.newest), newest_7d: r.newest_7d ? str(r.newest_7d) : null }));
      const n = by_status.reduce((s, r) => s + r.n_30d, 0);
      return n ? { data: { by_status }, rows: n, as_of: newestOf(by_status.map((r) => r.newest)) } : empty();
    },
  },
  consensus_proposals: {
    id: "consensus_proposals", point_in_time: false,
    async read(q, w) {
      const groups = (await q.all(
        `SELECT status, class, COUNT(*) AS n, MAX(created_at) AS newest FROM consensus_proposals WHERE created_at > ? AND created_at <= ?
           GROUP BY status, class ORDER BY status, class LIMIT 40`, w.d30, w.end,
      )).map((r) => ({ status: str(r.status), class: str(r.class), n: num(r.n), newest: str(r.newest) }));
      // Executed rollbacks (ai-kernel/src/observer-watch.ts) with the time of the Observer finding their params name.
      const rollbacks = (await q.all(
        `SELECT p.proposal_id, p.decided_at, f.created_at AS finding_at FROM consensus_proposals p
           LEFT JOIN observer_findings f ON f.finding_id = json_extract(p.params_json, '$.finding_id')
          WHERE p.action = 'rollback_worker_version' AND p.status = 'executed' AND p.decided_at > ? AND p.decided_at <= ?
          ORDER BY p.decided_at, p.proposal_id LIMIT 100`, w.d30, w.end,
      )).map((r) => ({ proposal_id: str(r.proposal_id), decided_at: str(r.decided_at), finding_at: r.finding_at ? str(r.finding_at) : null }));
      const n = groups.reduce((s, r) => s + r.n, 0);
      return n ? { data: { by_status_class: groups, rollbacks }, rows: n, as_of: newestOf([...groups.map((r) => r.newest), ...rollbacks.map((r) => r.decided_at)]) } : empty();
    },
  },
  forge_change_requests: {
    id: "forge_change_requests", point_in_time: false,
    async read(q, w) {
      // A merge by consensus is an executed merge_change proposal on the change request (supervisor.ts); the owner's is merge_owner_change.
      const r = await q.first(
        `SELECT COUNT(*) AS merged,
                SUM(CASE WHEN EXISTS (SELECT 1 FROM consensus_proposals p WHERE p.action = 'merge_change' AND p.target = c.cr_id AND p.status = 'executed' AND p.decided_at <= ?) THEN 1 ELSE 0 END) AS by_consensus,
                SUM(CASE WHEN EXISTS (SELECT 1 FROM consensus_proposals p WHERE p.action = 'merge_owner_change' AND p.target = c.cr_id AND p.status = 'executed' AND p.decided_at <= ?) THEN 1 ELSE 0 END) AS by_owner,
                MAX(c.outcome_at) AS newest
           FROM forge_change_requests c WHERE c.status = 'merged' AND c.outcome_at > ? AND c.outcome_at <= ? LIMIT 1`, w.end, w.end, w.d30, w.end);
      const merged = num(r?.merged);
      return merged ? { data: { merged, by_consensus: num(r?.by_consensus), by_owner: num(r?.by_owner), newest: str(r?.newest) }, rows: merged, as_of: isoTime(r?.newest) } : empty();
    },
  },
  kernel_controls: {
    id: "kernel_controls", point_in_time: true,
    async read(q) {
      const r = controlRow(await q.first("SELECT value, updated_at FROM kernel_controls WHERE control = 'agents_enabled' LIMIT 1"));
      return r ? { data: { agents_enabled: r }, rows: 1, as_of: isoTime(r.updated_at) } : empty();
    },
  },
  consensus_controls: {
    id: "consensus_controls", point_in_time: true,
    async read(q) {
      const r = controlRow(await q.first("SELECT value, updated_at FROM consensus_controls WHERE control = 'mode' LIMIT 1"));
      return r ? { data: { mode: r }, rows: 1, as_of: isoTime(r.updated_at) } : empty();
    },
  },
  metabolism_controls: {
    id: "metabolism_controls", point_in_time: true,
    async read(q) {
      // The power mode only: the treasury currency is money, which the self-model never copies (Q6).
      const r = controlRow(await q.first("SELECT value, updated_at FROM metabolism_controls WHERE control = 'power_mode' LIMIT 1"));
      return r ? { data: { power_mode: r }, rows: 1, as_of: isoTime(r.updated_at) } : empty();
    },
  },
  evolver_controls: {
    id: "evolver_controls", point_in_time: true,
    async read(q) {
      const r = controlRow(await q.first("SELECT value, updated_at FROM evolver_controls WHERE control = 'mode' LIMIT 1"));
      return r ? { data: { mode: r }, rows: 1, as_of: isoTime(r.updated_at) } : empty();
    },
  },
  autonomy_dial: {
    id: "autonomy_dial", point_in_time: true,
    async read(q) {
      const rows = (await q.all("SELECT group_id, level, source, set_at FROM autonomy_dial ORDER BY group_id LIMIT 16"))
        .map((r) => ({ group_id: str(r.group_id), level: str(r.level), source: str(r.source), set_at: str(r.set_at) }));
      // No row means every group is at its ceiling (migration 0083): that is a measured state, so the data is kept.
      return { data: { rows }, rows: rows.length, as_of: newestOf(rows.map((r) => r.set_at)) };
    },
  },
  trading_organ_health: {
    id: "trading_organ_health", point_in_time: false,
    async read(q, w) {
      const r = await q.first<{ report_id: string; created_at: string; body_json: string }>(
        `SELECT report_id, created_at, body_json FROM agent_reports WHERE agent_id = 'signal-analyst' AND kind = 'xauusd_digest'
            AND json_extract(body_json, '$.schema') = 'trading_organ_health.v1' AND created_at <= ? ORDER BY created_at DESC, rowid DESC LIMIT 1`, w.end);
      if (!r) return empty();
      // The body goes through the whitelist here and nowhere else: nothing but the numbers of the 15 named metrics leaves
      // this reader (a metric of another name, such as one carrying a price, is dropped).
      const health = organHealthWhitelist(str(r.body_json));
      const named = new Set<string>(ORGAN_HEALTH_METRIC_NAMES);
      health.metrics = health.metrics.filter((m) => named.has(m.metric));
      return { data: { report_id: str(r.report_id), created_at: str(r.created_at), health }, rows: 1, as_of: isoTime(r.created_at) };
    },
  },
  knowledge_audit: {
    id: "knowledge_audit", point_in_time: false,
    async read(q, w) {
      const r = await q.first(
        "SELECT report_id, agent_id, subject, created_at FROM agent_reports WHERE kind = 'knowledge_audit' AND created_at <= ? ORDER BY created_at DESC, rowid DESC LIMIT 1", w.end);
      return r ? { data: { report_id: str(r.report_id), agent_id: str(r.agent_id), subject: str(r.subject), created_at: str(r.created_at) }, rows: 1, as_of: isoTime(r.created_at) } : empty();
    },
  },
  observer_vitals: {
    id: "observer_vitals", point_in_time: false,
    async read(q, w) {
      // Hour buckets that start before window_end; SUM of a column that is NULL in every hour stays NULL ("not measured").
      const subjects = VITALS_SUBJECTS;
      const workers = (await q.all(
        `SELECT subject, MAX(hour) AS newest,
                COUNT(CASE WHEN hour >= ? THEN 1 END) AS hours_24h, COUNT(CASE WHEN hour >= ? THEN 1 END) AS hours_7d, COUNT(*) AS hours_30d,
                SUM(CASE WHEN hour >= ? THEN requests END) AS req_24h, SUM(CASE WHEN hour >= ? THEN errors END) AS err_24h,
                MAX(CASE WHEN hour >= ? THEN cpu_p99_ms END) AS cpu_24h, SUM(CASE WHEN hour >= ? THEN exceeded_cpu END) AS exc_24h,
                SUM(CASE WHEN hour >= ? THEN requests END) AS req_7d, SUM(CASE WHEN hour >= ? THEN errors END) AS err_7d,
                MAX(CASE WHEN hour >= ? THEN cpu_p99_ms END) AS cpu_7d, SUM(CASE WHEN hour >= ? THEN exceeded_cpu END) AS exc_7d,
                SUM(requests) AS req_30d, SUM(errors) AS err_30d
           FROM observer_vitals WHERE subject IN (${placeholders(subjects.length)}) AND hour >= ? AND hour < ?
          GROUP BY subject ORDER BY subject LIMIT 64`,
        w.h24, w.d7, w.h24, w.h24, w.h24, w.h24, w.d7, w.d7, w.d7, w.d7, ...subjects, w.d30, w.end,
      )).map((r) => ({
        subject: str(r.subject), newest: str(r.newest), hours_24h: num(r.hours_24h), hours_7d: num(r.hours_7d), hours_30d: num(r.hours_30d),
        req_24h: numOrNull(r.req_24h), err_24h: numOrNull(r.err_24h), cpu_24h: numOrNull(r.cpu_24h), exc_24h: numOrNull(r.exc_24h),
        req_7d: numOrNull(r.req_7d), err_7d: numOrNull(r.err_7d), cpu_7d: numOrNull(r.cpu_7d), exc_7d: numOrNull(r.exc_7d),
        req_30d: numOrNull(r.req_30d), err_30d: numOrNull(r.err_30d),
      }));
      // The account by kind: the day's use against the free limits, and the Workers AI neurons over 30 days.
      const kinds = (await q.all(
        `SELECT kind, COUNT(*) AS n, MAX(hour) AS newest, COUNT(CASE WHEN hour >= ? THEN 1 END) AS n_day, MAX(CASE WHEN hour >= ? THEN hour END) AS newest_day,
                SUM(CASE WHEN hour >= ? THEN requests END) AS requests_day, SUM(CASE WHEN hour >= ? THEN rows_read END) AS rows_read_day,
                SUM(CASE WHEN hour >= ? THEN rows_written END) AS rows_written_day, SUM(CASE WHEN hour >= ? THEN neurons END) AS neurons_day,
                SUM(neurons) AS neurons_30d
           FROM observer_vitals WHERE hour >= ? AND hour < ? GROUP BY kind ORDER BY kind LIMIT 8`,
        w.h24, w.h24, w.h24, w.h24, w.h24, w.h24, w.d30, w.end,
      )).map((r) => ({
        kind: str(r.kind), n: num(r.n), newest: str(r.newest), n_day: num(r.n_day), newest_day: r.newest_day ? str(r.newest_day) : null,
        requests_day: numOrNull(r.requests_day), rows_read_day: numOrNull(r.rows_read_day), rows_written_day: numOrNull(r.rows_written_day),
        neurons_day: numOrNull(r.neurons_day), neurons_30d: numOrNull(r.neurons_30d),
      }));
      const n = kinds.reduce((s, r) => s + r.n, 0);
      return n ? { data: { workers, kinds }, rows: n, as_of: newestOf(kinds.map((r) => r.newest)) } : empty();
    },
  },
  observer_findings: {
    id: "observer_findings", point_in_time: false,
    async read(q, w) {
      const by_kind = (await q.all(
        `SELECT kind, COUNT(*) AS n, MAX(created_at) AS newest, SUM(CASE WHEN metric = 'learning_volume' THEN 1 ELSE 0 END) AS learning_volume,
                SUM(CASE WHEN metric = 'learning_repeat' THEN 1 ELSE 0 END) AS learning_repeat, SUM(CASE WHEN z IS NOT NULL THEN 1 ELSE 0 END) AS with_z
           FROM observer_findings WHERE created_at > ? AND created_at <= ? GROUP BY kind ORDER BY kind LIMIT 8`, w.d7, w.end,
      )).map((r) => ({ kind: str(r.kind), n: num(r.n), newest: str(r.newest), learning_volume: num(r.learning_volume), learning_repeat: num(r.learning_repeat), with_z: num(r.with_z) }));
      const n = by_kind.reduce((s, r) => s + r.n, 0);
      if (!n) return empty();
      const top = (await q.all(
        `SELECT finding_id, worker, metric, kind, z, created_at FROM observer_findings WHERE created_at > ? AND created_at <= ? AND z IS NOT NULL
          ORDER BY abs(z) DESC, created_at DESC, finding_id LIMIT 5`, w.d7, w.end,
      )).map((r) => ({ finding_id: str(r.finding_id), worker: str(r.worker), metric: str(r.metric), kind: str(r.kind), z: num(r.z), created_at: str(r.created_at) }));
      return { data: { by_kind, top }, rows: n, as_of: newestOf(by_kind.map((r) => r.newest)) };
    },
  },
  observer_runs: {
    id: "observer_runs", point_in_time: false,
    async read(q, w) {
      const r = await q.first("SELECT run_id, ran_at, status, findings_json FROM observer_runs WHERE kind = 'inventory' AND ran_at <= ? ORDER BY ran_at DESC LIMIT 1", w.end);
      if (!r) return empty();
      // Only the metric of each finding is counted; its worker and detail stay in D1.
      let by_metric: Record<string, number> | null = null;
      try {
        const list = JSON.parse(str(r.findings_json));
        if (Array.isArray(list)) {
          by_metric = {};
          for (const f of list) if (typeof f?.metric === "string") by_metric[f.metric] = (by_metric[f.metric] ?? 0) + 1;
        }
      } catch { by_metric = null; }
      return { data: { run_id: str(r.run_id), ran_at: str(r.ran_at), status: str(r.status), by_metric }, rows: 1, as_of: isoTime(r.ran_at) };
    },
  },
  forge_organism_census: {
    id: "forge_organism_census", point_in_time: false,
    async read(q, w) {
      // The genome stays in D1: only the external origins whose organs it holds come back (forge/src/census.ts summary.origin).
      const r = await q.first(
        `SELECT main_sha, status, organs, agents, engines, voters, findings, taken_at,
                CASE WHEN genome IS NOT NULL AND json_valid(genome) AND json_type(genome) = 'array' THEN (
                  SELECT json_group_array(DISTINCT json_extract(j.value, '$.origin')) FROM json_each(genome) j WHERE json_extract(j.value, '$.origin') IS NOT NULL
                ) END AS origins_read
           FROM forge_organism_census WHERE taken_at <= ? ORDER BY taken_at DESC LIMIT 1`, w.end);
      let originsRead: string[] | null = null;
      try { const v = r?.origins_read ? JSON.parse(str(r.origins_read)) : null; originsRead = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null; } catch { originsRead = null; }
      return r ? {
        data: { main_sha: str(r.main_sha), status: str(r.status), organs: num(r.organs), agents: num(r.agents), engines: num(r.engines), voters: num(r.voters), findings: findingsCount(r.findings), taken_at: str(r.taken_at), origins_read: originsRead },
        rows: 1, as_of: isoTime(r.taken_at),
      } : empty();
    },
  },
  infra_burn_metrics: {
    id: "infra_burn_metrics", point_in_time: false,
    async read(q, w) {
      // The month to date of `day`: only rows that exist count (estimated_cost_usd defaults to 0, §4.1).
      const by_service = (await q.all(
        `SELECT service_id, COUNT(*) AS days, SUM(estimated_cost_usd) AS cost_usd, MAX(calculated_at) AS newest FROM infra_burn_metrics
          WHERE period_day >= ? AND period_day <= ? GROUP BY service_id ORDER BY service_id LIMIT 32`, w.monthDay, w.day,
      )).map((r) => ({ service_id: str(r.service_id), days: num(r.days), cost_usd: num(r.cost_usd), newest: str(r.newest) }));
      const n = by_service.reduce((s, r) => s + r.days, 0);
      return n ? { data: { by_service }, rows: n, as_of: newestOf(by_service.map((r) => r.newest)) } : empty();
    },
  },
  forge_builds: {
    id: "forge_builds", point_in_time: false,
    async read(q, w) {
      const r = await q.first(
        `SELECT COUNT(*) AS builds, SUM(billed_minutes) AS minutes, SUM(CASE WHEN billed_minutes IS NULL THEN 1 ELSE 0 END) AS unmeasured, MAX(stopped_on) AS newest
           FROM forge_builds WHERE stopped_on >= ? AND stopped_on <= ? LIMIT 1`, w.monthStart, w.end);
      const builds = num(r?.builds);
      return builds ? { data: { builds, minutes: numOrNull(r?.minutes), unmeasured: num(r?.unmeasured), newest: str(r?.newest) }, rows: builds, as_of: isoTime(r?.newest) } : empty();
    },
  },
  forge_dependency_audits: {
    id: "forge_dependency_audits", point_in_time: false,
    async read(q, w) {
      const r = await q.first("SELECT run_id, status, critical, high, moderate, ran_at FROM forge_dependency_audits WHERE ran_at <= ? ORDER BY ran_at DESC LIMIT 1", w.end);
      return r ? { data: { run_id: str(r.run_id), status: str(r.status), critical: num(r.critical), high: num(r.high), moderate: num(r.moderate), ran_at: str(r.ran_at) }, rows: 1, as_of: isoTime(r.ran_at) } : empty();
    },
  },
  ai_usage: {
    id: "ai_usage", point_in_time: false,
    async read(q, w) {
      // service_id leads the key: the registry's ids (ai_usage's foreign key) let the day range use it.
      const by_service = (await q.all(
        `SELECT service_id, COUNT(*) AS days, SUM(requests) AS requests, SUM(failures) AS failures, MAX(day) AS newest_day FROM ai_usage
          WHERE service_id IN (SELECT service_id FROM service_registry) AND day >= ? AND day <= ? GROUP BY service_id ORDER BY service_id LIMIT 64`, w.day7, w.day,
      )).map((r) => ({ service_id: str(r.service_id), days: num(r.days), requests: num(r.requests), failures: num(r.failures), newest_day: str(r.newest_day) }));
      const n = by_service.reduce((s, r) => s + r.days, 0);
      return n ? { data: { by_service }, rows: n, as_of: dayStart(by_service.map((r) => r.newest_day).sort().pop()) } : empty();
    },
  },
  ai_failures: {
    id: "ai_failures", point_in_time: false,
    async read(q, w) {
      const groups = (await q.all(
        `SELECT task, category, SUM(count) AS n, MAX(day) AS newest_day FROM ai_failures
          WHERE service_id IN (SELECT service_id FROM service_registry) AND day >= ? AND day <= ? GROUP BY task, category ORDER BY n DESC, task, category LIMIT 200`, w.day7, w.day,
      )).map((r) => ({ task: str(r.task), category: str(r.category), n: num(r.n), newest_day: str(r.newest_day) }));
      return groups.length ? { data: { groups }, rows: groups.length, as_of: dayStart(groups.map((r) => r.newest_day).sort().pop()) } : empty();
    },
  },
  councils: {
    id: "councils", point_in_time: false,
    async read(q, w) {
      const by_state = (await q.all(
        `SELECT state, COUNT(*) AS n, SUM(spent_calls) AS calls, SUM(spent_usd) AS usd, MAX(created_at) AS newest FROM councils
          WHERE created_at > ? AND created_at <= ? GROUP BY state ORDER BY state LIMIT 16`, w.d30, w.end,
      )).map((r) => ({ state: str(r.state), n: num(r.n), calls: num(r.calls), usd: num(r.usd), newest: str(r.newest) }));
      const n = by_state.reduce((s, r) => s + r.n, 0);
      return n ? { data: { by_state }, rows: n, as_of: newestOf(by_state.map((r) => r.newest)) } : empty();
    },
  },
  evolution_intents_v2: {
    id: "evolution_intents_v2", point_in_time: false,
    async read(q, w) {
      const by_state = (await q.all(
        "SELECT state, COUNT(*) AS n, MAX(created_at) AS newest FROM evolution_intents_v2 WHERE created_at > ? AND created_at <= ? GROUP BY state ORDER BY state LIMIT 16", w.d30, w.end,
      )).map((r) => ({ state: str(r.state), n: num(r.n), newest: str(r.newest) }));
      const n = by_state.reduce((s, r) => s + r.n, 0);
      return n ? { data: { by_state }, rows: n, as_of: newestOf(by_state.map((r) => r.newest)) } : empty();
    },
  },
  evolutions_v2: {
    id: "evolutions_v2", point_in_time: false,
    async read(q, w) {
      const by_state = (await q.all(
        `SELECT state, COUNT(*) AS n, SUM(ai_calls) AS ai_calls, SUM(CASE WHEN json_valid(refusals_json) AND json_array_length(refusals_json) > 0 THEN 1 ELSE 0 END) AS refused,
                MAX(started_at) AS newest FROM evolutions_v2 WHERE started_at > ? AND started_at <= ? GROUP BY state ORDER BY state LIMIT 16`, w.d30, w.end,
      )).map((r) => ({ state: str(r.state), n: num(r.n), ai_calls: num(r.ai_calls), refused: num(r.refused), newest: str(r.newest) }));
      const n = by_state.reduce((s, r) => s + r.n, 0);
      return n ? { data: { by_state }, rows: n, as_of: newestOf(by_state.map((r) => r.newest)) } : empty();
    },
  },
  corrections: {
    id: "corrections", point_in_time: false,
    async read(q, w) {
      // actor and target_ref feed teachingRecord here and are dropped: the reader returns counts and scores only.
      const raw = await q.all(
        `SELECT actor, target_ref, subject, label, rating, category, weight, source, side, created_at FROM corrections
          WHERE side IN ('cerebrum', 'nexus') AND created_at > ? AND created_at <= ? ORDER BY created_at, correction_id LIMIT 2000`, w.d30, w.end);
      if (!raw.length) return empty();
      const teachingRows: TeachingRow[] = raw.map((r) => ({
        actor: str(r.actor), target_ref: str(r.target_ref), subject: str(r.subject), label: str(r.label),
        rating: r.rating === "up" || r.rating === "down" ? r.rating : null, category: r.category === null || r.category === undefined ? null : str(r.category),
        weight: num(r.weight), created_at: str(r.created_at),
      }));
      const teaching = teachingRecord(teachingRows, w.endMs).map((t) => ({
        subject: t.subject,
        n_7d: t.windows["7d"].n, score_7d: t.windows["7d"].score, last_7d: t.windows["7d"].last_at,
        n_30d: t.windows["30d"].n, score_30d: t.windows["30d"].score, last_30d: t.windows["30d"].last_at,
      }));
      const rows = raw.map((r) => ({ label: str(r.label), source: str(r.source), side: str(r.side), created_at: str(r.created_at) }));
      return { data: { rows, teaching }, rows: rows.length, as_of: newestOf(rows.map((r) => r.created_at)) };
    },
  },
  knowledge_proposals: {
    id: "knowledge_proposals", point_in_time: false,
    async read(q, w) {
      const by_kind_status = (await q.all(
        `SELECT kind, status, COUNT(*) AS n, MAX(created_at) AS newest FROM knowledge_proposals
          WHERE status IN ('pending', 'approved', 'rejected', 'expired') AND created_at > ? AND created_at <= ?
          GROUP BY kind, status ORDER BY kind, status LIMIT 16`, w.d30, w.end,
      )).map((r) => ({ kind: str(r.kind), status: str(r.status), n: num(r.n), newest: str(r.newest) }));
      const p = await q.first("SELECT COUNT(*) AS n, MAX(created_at) AS newest FROM knowledge_proposals WHERE status = 'pending' AND created_at <= ? LIMIT 1", w.end);
      const pending = { n: num(p?.n), newest: p?.newest ? str(p.newest) : null };
      const n = by_kind_status.reduce((s, r) => s + r.n, 0);
      return n || pending.n ? { data: { by_kind_status, pending }, rows: n + pending.n, as_of: newestOf([...by_kind_status.map((r) => r.newest), pending.newest]) } : empty();
    },
  },
  agent_memories: {
    id: "agent_memories", point_in_time: false,
    async read(q, w) {
      const by_agent = (await q.all(
        "SELECT agent_id, COUNT(*) AS n, MAX(created_at) AS newest FROM agent_memories WHERE created_at <= ? GROUP BY agent_id ORDER BY n DESC, agent_id LIMIT 64", w.end,
      )).map((r) => ({ agent_id: str(r.agent_id), n: num(r.n), newest: str(r.newest) }));
      const n = by_agent.reduce((s, r) => s + r.n, 0);
      return n ? { data: { by_agent }, rows: n, as_of: newestOf(by_agent.map((r) => r.newest)) } : empty();
    },
  },
  adr_progress: {
    id: "adr_progress", point_in_time: true,
    async read(q) {
      const rows = (await q.all(
        `SELECT adr_id, status, percent, percent_proven, changed_at,
                CASE WHEN json_type(body_json, '$.drift') = 'array' THEN json_array_length(body_json, '$.drift') END AS drift_count,
                json_type(body_json, '$.stale') AS stale
           FROM adr_progress ORDER BY adr_id LIMIT 100`,
      )).map((r) => ({ adr_id: str(r.adr_id), status: str(r.status), percent: num(r.percent), percent_proven: num(r.percent_proven), changed_at: str(r.changed_at), drift_count: numOrNull(r.drift_count), stale: r.stale ? str(r.stale) : null }));
      return rows.length ? { data: { rows }, rows: rows.length, as_of: newestOf(rows.map((r) => r.changed_at)) } : empty();
    },
  },
  agents: {
    id: "agents", point_in_time: true,
    async read(q) {
      const r = await q.first("SELECT status, updated_at FROM agents WHERE agent_id = 'adr-steward' LIMIT 1");
      return r ? { data: { adr_steward: { status: str(r.status), updated_at: str(r.updated_at) } }, rows: 1, as_of: isoTime(r.updated_at) } : empty();
    },
  },
};

/** The sources in the order they are read and listed (at most 64, the contract's bound). */
export const SELF_MODEL_SOURCE_IDS = Object.keys(SOURCES) as SourceId[];

// ---------------------------------------------------------------- one run of the readers (§5.2 step 3, §5.5)

export interface ReadOptions {
  /** Milliseconds now; Date.now by default. Only the budgets use it: no value depends on it. */
  clock?: () => number;
  sourceBudgetMs?: number;
  runBudgetMs?: number;
}

const BUDGET = Symbol("budget");
const isMissingTable = (e: unknown) => /no such table/i.test(String((e as Error)?.message ?? e));

/** Read every source once, in order. A failed, missing or slow source is marked and the rest go on. */
export async function readSelfModelSources(db: SelfModelDb, windows: SelfModelWindows, options: ReadOptions = {}): Promise<{ readings: SelfModelReadings; statements: number }> {
  const clock = options.clock ?? Date.now;
  const sourceBudget = options.sourceBudgetMs ?? SOURCE_BUDGET_MS;
  const runBudget = options.runBudgetMs ?? RUN_BUDGET_MS;
  const started = clock();
  const q = new Query(db);
  const readings = {} as Record<SourceId, SourceReading>;
  for (const id of SELF_MODEL_SOURCE_IDS) {
    const spec = SOURCES[id] as SourceSpec<SourceId>;
    const base = { id, point_in_time: spec.point_in_time };
    const left = Math.min(sourceBudget, runBudget - (clock() - started));
    if (left <= 0) { readings[id] = { ...base, status: "budget_exceeded", rows: null, as_of: null, data: null }; continue; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        spec.read(q, windows),
        new Promise<typeof BUDGET>((resolve) => { timer = setTimeout(() => resolve(BUDGET), left); }),
      ]);
      if (result === BUDGET) readings[id] = { ...base, status: "budget_exceeded", rows: null, as_of: null, data: null };
      // An ok source names the time of its newest row; rows whose times do not parse cannot be placed in the window.
      else if (result.rows > 0 && result.data !== null) {
        readings[id] = result.as_of !== null ? { ...base, status: "ok", rows: result.rows, as_of: result.as_of, data: result.data } : { ...base, status: "unavailable", rows: null, as_of: null, data: null };
      }
      // An empty read keeps its data only where no row is itself a state (the autonomy dial's ceiling).
      else readings[id] = { ...base, status: "empty", rows: 0, as_of: null, data: result.data };
    } catch (e) {
      readings[id] = { ...base, status: isMissingTable(e) ? "missing_table" : "unavailable", rows: null, as_of: null, data: null };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return { readings: readings as SelfModelReadings, statements: q.statements };
}
