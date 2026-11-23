// ADR-0016 (Telos) T1b (docs/design/TELOS-T1-SELF-MODEL.md §3, §4.1, §6; owner 2026-11-22, "setuju semua"): the pure
// section functions of the daily self-model. What the readers (self-model-read.ts) return in, the Body, Mind, Memory and
// Ecosystem sections out, as measures of organism.self_model.v1 (self-model.ts). No storage, no network, no clock: every
// age is counted back from window_end, so the same readings give the same sections.
//
// - A value is a measure with its source, window and as_of (the newest row that went into it), or null with a reason.
// - A source that could not be read gives its own reason to every value it feeds (source_unavailable, missing_table,
//   budget_exceeded); one that read no row gives no_rows, never 0. A count of 0 is reported only when its source read
//   rows in that window (it is then a measured zero, as_of the newest of those rows).
// - Names (services, agents, subjects, metrics) are labels in bounded lists, never keys, so no row can make a forbidden
//   key. Lists are cut to their top entries and say how many they left out.
// - No price, no money beyond infrastructure cost, no text but names, and no identity (§8).
//
// The KPI inputs of §6 that T1c's bindings read are fixed paths here (SELF_MODEL_KPI_INPUTS).
import { DEPLOY_UNITS } from "./deploy-units.ts";
import { EXTERNAL_ORIGINS } from "./organism.ts";
import type { Measure, NullReason, SectionNode, SourceStatus } from "./self-model.ts";
import {
  ORGAN_HEALTH_METRIC_NAMES, isoTime, newestOf, dayStart,
  type OrganHealthMetric, type SelfModelReadings, type SelfModelWindows, type SourceReading,
} from "./self-model-read.ts";
import { BUILD_MINUTES_BUDGET } from "./build-usage.ts";

type Section = Record<string, SectionNode>;
type Obj = { [key: string]: SectionNode | number };

/**
 * FREE_LIMITS of cf-usage.ts for the four daily allowances the Observer's vitals measure (pinned by the T1b test). KV is
 * left out: the vitals hold KV reads and writes only inside sample_json, which the self-model does not read.
 */
export const SELF_MODEL_FREE_LIMITS = {
  workers_requests: { limit: 100_000, kind: "worker", field: "requests_day", unit: "count" },
  d1_rows_read: { limit: 5_000_000, kind: "d1", field: "rows_read_day", unit: "rows" },
  d1_rows_written: { limit: 100_000, kind: "d1", field: "rows_written_day", unit: "rows" },
  ai_neurons: { limit: 10_000, kind: "ai", field: "neurons_day", unit: "neurons" },
} as const;

/** AUTONOMY_GROUPS of autonomy-dial.ts (pinned by the T1b test; that module is the consensus's own, so it is not imported). */
export const SELF_MODEL_AUTONOMY_GROUPS = ["deploys", "merges", "recovery", "registry", "agents", "policy", "protected", "trading"] as const;

/** The section paths that hold the inputs of each §6 binding (T1c). The T1b test checks each one exists. */
export const SELF_MODEL_KPI_INPUTS: Readonly<Record<string, readonly string[]>> = {
  decision_hit_rate_15m: ["mind.trading_organ.metrics.hit_rate_30d.current", "mind.trading_organ.metrics.hit_rate_30d.status", "mind.trading_organ.metrics.hit_rate_30d.subject"],
  neurons_per_correct_call: ["body.account.ai_neurons_30d", "mind.trading_organ.metrics.hit_rate_30d.hit"],
  infra_cost_usd_month_excl_ai: ["body.cost.mtd_usd.by_service"],
  changes_merged_by_consensus_share: ["body.changes.merged_30d", "body.changes.merged_by_consensus_30d"],
  mean_time_to_rollback_minutes: ["body.deploys.rollbacks_executed_30d", "body.deploys.finding_to_rollback_minutes_mean_30d"],
  uptime_core_workers: ["body.vitals.control_plane_unit.requests_30d", "body.vitals.control_plane_unit.errors_30d"],
  undeclared_components: ["body.inventory.undeclared_worker"],
};

// ---------------------------------------------------------------- measures (§4.1)

const HOUR_MS = 3_600_000;
const round = (n: number, d = 4) => Number(n.toFixed(d)) + 0;

interface MeasureMeta { unit?: string; window?: string; source: string; ref?: string | null }
/** A measured value; null with `unavailable_source_field` when its as_of is not a time, `division_by_zero` for NaN. */
export function measured(value: number | string | boolean, as_of: string | null, meta: MeasureMeta): Measure {
  if (typeof value === "number" && !Number.isFinite(value)) return nul("division_by_zero", meta);
  const at = isoTime(as_of);
  if (at === null) return nul("unavailable_source_field", meta);
  const m: Measure = { value: typeof value === "number" ? round(value) : value, as_of: at, source: meta.source, reason: null };
  if (meta.unit) m.unit = meta.unit;
  if (meta.window) m.window = meta.window;
  if (meta.ref) m.ref = meta.ref;
  return m;
}
/** An honest null. It keeps its unit and window, so a reader sees what was not measured. */
export function nul(reason: NullReason, meta: Partial<MeasureMeta> = {}): Measure {
  const m: Measure = { value: null, reason };
  if (meta.unit) m.unit = meta.unit;
  if (meta.window) m.window = meta.window;
  return m;
}
const STATUS_REASON: Record<SourceStatus, NullReason> = {
  ok: "no_rows", empty: "no_rows", unavailable: "source_unavailable", missing_table: "missing_table", not_built: "not_built", budget_exceeded: "budget_exceeded",
};
/** The reason every value of a source that read nothing, or could not be read, carries. */
export const reasonOf = (s: Pick<SourceReading, "status">): NullReason => STATUS_REASON[s.status];
const ok = <K extends keyof SelfModelReadings>(s: SourceReading<K>): s is SourceReading<K> & { data: NonNullable<SourceReading<K>["data"]> } => s.status === "ok" && s.data !== null;

/** A count in a window whose population (`total` rows, newest at `as_of`) was read; no rows in the window is no_rows. */
function count(n: number, total: number, as_of: string | null, meta: MeasureMeta): Measure {
  return total > 0 ? measured(n, as_of, { unit: "count", ...meta }) : nul("no_rows", { unit: "count", window: meta.window });
}
/** a ÷ b, or division_by_zero; nulls stay null with their reason. */
function ratio(a: number | null, b: number | null, as_of: string | null, meta: MeasureMeta, nullReason: NullReason = "unavailable_source_field"): Measure {
  if (a === null || b === null) return nul(nullReason, { unit: "ratio", window: meta.window });
  if (b === 0) return nul("division_by_zero", { unit: "ratio", window: meta.window });
  return measured(a / b, as_of, { unit: "ratio", ...meta });
}
/** Hours from a row's time back from window_end. */
function age(at: string | null, w: SelfModelWindows, meta: MeasureMeta): Measure {
  const t = at === null ? NaN : Date.parse(at);
  if (!Number.isFinite(t)) return nul("unavailable_source_field", { unit: "h", window: "now" });
  return measured(round((w.endMs - t) / HOUR_MS, 2), at, { unit: "h", window: "now", ...meta });
}
/** A value from a column that may be NULL ("not measured"). */
const opt = (v: number | null, as_of: string | null, meta: MeasureMeta): Measure => (v === null ? nul("unavailable_source_field", meta) : measured(v, as_of, meta));
const TOKEN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
/** A status or mode as a token; anything else (or a run of three digits) is not a status. */
const token = (v: string, as_of: string | null, meta: MeasureMeta): Measure => (TOKEN.test(v) && !/\d{3}/.test(v) ? measured(v, as_of, meta) : nul("unavailable_source_field", meta));
/** A name as a single-line label of at most 120 characters (never a key). */
const label = (v: string): string => (v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 120) || "unnamed");

/** The top `n` of a list with the number left out (§3). */
function top<T>(items: readonly T[], n: number, map: (t: T) => Obj): Obj {
  const out: Obj = { top: items.slice(0, n).map(map) };
  if (items.length > n) out.omitted = items.length - n;
  return out;
}

/** Counts by a name in one window: the total, and each name that has rows. */
function byName(items: readonly { name: string; n: number; newest: string | null }[], key: string, window: string, source: string, cut = 12): Obj {
  const present = items.filter((i) => i.n > 0).sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : 1));
  const total = present.reduce((s, i) => s + i.n, 0);
  const as_of = newestOf(present.map((i) => i.newest));
  return {
    total: count(total, total, as_of, { window, source }),
    ...top(present, cut, (i) => ({ [key]: label(i.name), count: measured(i.n, i.newest, { unit: "count", window, source }) })),
  };
}
const unreadList = (s: SourceReading, window?: string): Obj => ({ total: nul(reasonOf(s), { unit: "count", window }), top: [] });

// ---------------------------------------------------------------- Body (§3)

export function bodySection(r: SelfModelReadings, w: SelfModelWindows): Section {
  const reg = r.service_registry;
  const regRows = ok(reg) ? reg.data.rows : [];
  const regSource = "service_registry";
  const workers: Obj = ok(reg)
    ? {
      total: measured(regRows.length, reg.as_of, { unit: "count", window: "now", source: regSource }),
      ...byName(Object.entries(regRows.reduce<Record<string, { n: number; newest: string | null }>>((acc, x) => {
        const e = acc[x.status] ?? { n: 0, newest: null };
        acc[x.status] = { n: e.n + 1, newest: newestOf([e.newest, x.updated_at]) };
        return acc;
      }, {})).map(([name, v]) => ({ name, ...v })), "status", "now", regSource),
      versions_differ: (() => {
        const known = regRows.filter((x) => x.desired_version && x.observed_version);
        return known.length ? measured(known.filter((x) => x.desired_version !== x.observed_version).length, newestOf(known.map((x) => x.updated_at)), { unit: "count", window: "now", source: regSource })
          : nul("unavailable_source_field", { unit: "count", window: "now" });
      })(),
    }
    : { ...unreadList(reg, "now"), versions_differ: nul(reasonOf(reg), { unit: "count", window: "now" }) };
  const drift = r.drift_observations;
  workers.drifted_now = ok(drift)
    ? measured(drift.data.persistent.length, drift.as_of, { unit: "count", window: "now", source: "drift_observations" })
    : nul(reasonOf(drift), { unit: "count", window: "now" });

  // Deploys: requests by status (7 d, 30 d) and executed rollbacks (30 d).
  const dr = r.deployment_requests;
  const deploys: Obj = ok(dr)
    ? {
      requests_7d: byName(dr.data.by_status.map((x) => ({ name: x.status, n: x.n_7d, newest: x.newest_7d })), "status", "7d", "deployment_requests"),
      requests_30d: byName(dr.data.by_status.map((x) => ({ name: x.status, n: x.n_30d, newest: x.newest })), "status", "30d", "deployment_requests"),
    }
    : { requests_7d: unreadList(dr, "7d"), requests_30d: unreadList(dr, "30d") };
  const cp = r.consensus_proposals;
  if (ok(cp)) {
    const total = cp.data.by_status_class.reduce((s, x) => s + x.n, 0);
    const rb = cp.data.rollbacks;
    deploys.rollbacks_executed_30d = count(rb.length, total, rb.length ? newestOf(rb.map((x) => x.decided_at)) : cp.as_of, { window: "30d", source: "consensus_proposals" });
    // Execution (the executed proposal's decided_at) minus the created_at of the Observer finding its params name.
    const spans = rb.map((x) => (x.finding_at ? (Date.parse(x.decided_at) - Date.parse(x.finding_at)) / 60_000 : NaN)).filter((m) => Number.isFinite(m) && m >= 0);
    deploys.finding_to_rollback_minutes_mean_30d = spans.length
      ? measured(spans.reduce((s, m) => s + m, 0) / spans.length, newestOf(rb.map((x) => x.decided_at)), { unit: "min", window: "30d", source: "consensus_proposals:observer_findings" })
      : nul("no_rows", { unit: "min", window: "30d" });
  } else {
    deploys.rollbacks_executed_30d = nul(reasonOf(cp), { unit: "count", window: "30d" });
    deploys.finding_to_rollback_minutes_mean_30d = nul(reasonOf(cp), { unit: "min", window: "30d" });
  }

  // Changes merged (30 d) and how: an executed merge_change (consensus) or merge_owner_change (the owner's click).
  const cr = r.forge_change_requests;
  const crMeta = { window: "30d", source: "forge_change_requests:consensus_proposals" };
  const changes: Obj = ok(cr)
    ? {
      merged_30d: measured(cr.data.merged, cr.as_of, { unit: "count", ...crMeta }),
      merged_by_consensus_30d: measured(cr.data.by_consensus, cr.as_of, { unit: "count", ...crMeta }),
      merged_by_owner_click_30d: measured(cr.data.by_owner, cr.as_of, { unit: "count", ...crMeta }),
    }
    : Object.fromEntries(["merged_30d", "merged_by_consensus_30d", "merged_by_owner_click_30d"].map((k) => [k, nul(reasonOf(cr), { unit: "count", window: "30d" })]));

  // Vitals of the platform's Workers (24 h, 7 d), and the control-plane unit over 30 days (uptime_core_workers' input).
  const v = r.observer_vitals;
  const platform = new Set<string>(DEPLOY_UNITS.flatMap((u) => [...u.services]));
  const core = new Set<string>(DEPLOY_UNITS.find((u) => u.unit === "control-plane")?.services ?? []);
  const vs = "observer_vitals";
  let vitals: Obj;
  if (ok(v)) {
    const rows = v.data.workers.filter((x) => platform.has(x.subject)).sort((a, b) => (b.req_7d ?? 0) - (a.req_7d ?? 0) || (a.subject < b.subject ? -1 : 1));
    const coreRows = v.data.workers.filter((x) => core.has(x.subject));
    const sumOrNull = (xs: (number | null)[]) => (xs.some((x) => x !== null) ? xs.reduce<number>((s, x) => s + (x ?? 0), 0) : null);
    const coreAsOf = newestOf(coreRows.map((x) => x.newest));
    const coreReq = sumOrNull(coreRows.map((x) => x.req_30d));
    const coreErr = sumOrNull(coreRows.map((x) => x.err_30d));
    vitals = {
      workers: top(rows, 12, (x) => {
        const at24 = x.hours_24h ? x.newest : null;
        const at7 = x.hours_7d ? x.newest : null;
        const w24 = (val: number | null, unit: string) => (at24 === null ? nul("no_rows", { unit, window: "24h" }) : opt(val, at24, { unit, window: "24h", source: vs }));
        const w7 = (val: number | null, unit: string) => (at7 === null ? nul("no_rows", { unit, window: "7d" }) : opt(val, at7, { unit, window: "7d", source: vs }));
        return {
          worker: label(x.subject),
          requests_24h: w24(x.req_24h, "count"),
          error_ratio_24h: at24 === null ? nul("no_rows", { unit: "ratio", window: "24h" }) : ratio(x.err_24h, x.req_24h, at24, { window: "24h", source: vs }),
          cpu_p99_ms_worst_hour_24h: w24(x.cpu_24h, "ms"),
          exceeded_cpu_24h: w24(x.exc_24h, "count"),
          requests_7d: w7(x.req_7d, "count"),
          error_ratio_7d: at7 === null ? nul("no_rows", { unit: "ratio", window: "7d" }) : ratio(x.err_7d, x.req_7d, at7, { window: "7d", source: vs }),
          cpu_p99_ms_worst_hour_7d: w7(x.cpu_7d, "ms"),
          exceeded_cpu_7d: w7(x.exc_7d, "count"),
        };
      }),
      control_plane_unit: {
        requests_30d: coreRows.length ? opt(coreReq, coreAsOf, { unit: "count", window: "30d", source: vs }) : nul("no_rows", { unit: "count", window: "30d" }),
        errors_30d: coreRows.length ? opt(coreErr, coreAsOf, { unit: "count", window: "30d", source: vs }) : nul("no_rows", { unit: "count", window: "30d" }),
      },
    };
  } else {
    vitals = { workers: { top: [] }, control_plane_unit: { requests_30d: nul(reasonOf(v), { unit: "count", window: "30d" }), errors_30d: nul(reasonOf(v), { unit: "count", window: "30d" }) } };
  }

  // The account: the day's use against the free allowances, and the Workers AI neurons over 30 days (§6).
  const account: Obj = {};
  for (const [key, l] of Object.entries(SELF_MODEL_FREE_LIMITS)) {
    const row = ok(v) ? v.data.kinds.find((k) => k.kind === l.kind) : undefined;
    const used = row ? (row[l.field] as number | null) : null;
    const at = row?.newest_day ?? null;
    const reason: NullReason = !ok(v) ? reasonOf(v) : !row || !row.n_day ? "no_rows" : "unavailable_source_field";
    account[key] = used === null || at === null
      ? { used: nul(reason, { unit: l.unit, window: "day" }), share_of_free: nul(reason, { unit: "ratio", window: "day" }) }
      : { used: measured(used, at, { unit: l.unit, window: "day", source: vs }), share_of_free: measured(used / l.limit, at, { unit: "ratio", window: "day", source: vs }) };
  }
  const ai = ok(v) ? v.data.kinds.find((k) => k.kind === "ai") : undefined;
  account.ai_neurons_30d = !ok(v) ? nul(reasonOf(v), { unit: "neurons", window: "30d" })
    : !ai ? nul("no_rows", { unit: "neurons", window: "30d" })
    : opt(ai.neurons_30d, ai.newest, { unit: "neurons", window: "30d", source: vs });

  // Cost: the recorded billable estimate, month to date, per service (infrastructure only, Q6).
  const burn = r.infra_burn_metrics;
  const cost: Obj = ok(burn)
    ? {
      mtd_usd: {
        total: measured(burn.data.by_service.reduce((s, x) => s + x.cost_usd, 0), burn.as_of, { unit: "usd", window: "mtd", source: "infra_burn_metrics" }),
        by_service: burn.data.by_service.slice(0, 12).map((x) => ({ service: label(x.service_id), usd: measured(x.cost_usd, x.newest, { unit: "usd", window: "mtd", source: "infra_burn_metrics" }) })),
      },
    }
    : { mtd_usd: { total: nul(reasonOf(burn), { unit: "usd", window: "mtd" }), by_service: [] } };

  // Build minutes this month against the platform's budget (build-usage.ts BUILD_MINUTES_BUDGET).
  const b = r.forge_builds;
  const builds: Obj = ok(b)
    ? {
      builds_mtd: measured(b.data.builds, b.as_of, { unit: "count", window: "mtd", source: "forge_builds" }),
      unmeasured_builds_mtd: measured(b.data.unmeasured, b.as_of, { unit: "count", window: "mtd", source: "forge_builds" }),
      minutes_mtd: opt(b.data.minutes, b.as_of, { unit: "min", window: "mtd", source: "forge_builds" }),
      share_of_budget_mtd: b.data.minutes === null ? nul("unavailable_source_field", { unit: "ratio", window: "mtd" }) : measured(b.data.minutes / BUILD_MINUTES_BUDGET, b.as_of, { unit: "ratio", window: "mtd", source: "forge_builds" }),
    }
    : Object.fromEntries([["builds_mtd", "count"], ["unmeasured_builds_mtd", "count"], ["minutes_mtd", "min"], ["share_of_budget_mtd", "ratio"]].map(([k, u]) => [k, nul(reasonOf(b), { unit: u, window: "mtd" })]));

  // Anomalies: Observer findings by kind (7 d) and the top 5 by |z|.
  const f = r.observer_findings;
  const anomalies: Obj = ok(f)
    ? {
      by_kind_7d: byName(f.data.by_kind.map((x) => ({ name: x.kind, n: x.n, newest: x.newest })), "kind", "7d", "observer_findings"),
      top_by_z_7d: (() => {
        const node: Obj = {
          top: f.data.top.map((x) => ({
            worker: label(x.worker), metric: label(x.metric), kind: label(x.kind),
            z: measured(x.z, x.created_at, { unit: "z", window: "7d", source: "observer_findings", ref: `ev:platform/observer_finding/${x.finding_id}` }),
          })),
        };
        const withZ = f.data.by_kind.reduce((s, x) => s + x.with_z, 0);
        if (withZ > f.data.top.length) node.omitted = withZ - f.data.top.length;
        return node;
      })(),
    }
    : { by_kind_7d: unreadList(f, "7d"), top_by_z_7d: { top: [] } };

  // Inventory: the newest Observer inventory run's findings by metric (undeclared_components' input).
  const run = r.observer_runs;
  let inventory: Obj;
  const runMeta = (ref: string) => ({ window: "now", source: "observer_runs", ref });
  if (ok(run)) {
    const ref = `ev:platform/observer_runs/${run.data.run_id}#findings`;
    // An unavailable run found nothing because it read nothing; a truncated findings list cannot be counted.
    const usable = run.data.by_metric !== null && run.data.status !== "unavailable";
    const counts = new Map<string, number>(Object.entries(run.data.by_metric ?? {}));
    const n = (metric: string) => (usable ? measured(counts.get(metric) ?? 0, run.as_of, { unit: "count", window: "now", source: "observer_runs" }) : nul("unavailable_source_field", { unit: "count", window: "now" }));
    inventory = {
      status: token(run.data.status, run.as_of, runMeta(ref)),
      age_h: age(run.as_of, w, { source: "observer_runs" }),
      undeclared_worker: n("undeclared_worker"),
      orphaned_declaration: n("orphaned_declaration"),
      by_metric: usable
        ? byName([...counts].map(([name, c]) => ({ name, n: c, newest: run.as_of })), "metric", "now", "observer_runs", 10)
        : { total: nul("unavailable_source_field", { unit: "count", window: "now" }), top: [] },
    };
  } else {
    inventory = { status: nul(reasonOf(run)), age_h: nul(reasonOf(run), { unit: "h", window: "now" }), undeclared_worker: nul(reasonOf(run), { unit: "count", window: "now" }), orphaned_declaration: nul(reasonOf(run), { unit: "count", window: "now" }), by_metric: unreadList(run, "now") };
  }

  // Census: the newest row's status and counts (an invalid census counts nothing).
  const c = r.forge_organism_census;
  let census: Obj;
  if (ok(c)) {
    const ref = `ev:platform/census/${c.data.main_sha}`;
    const meta = { window: "now", source: "forge_organism_census", ref };
    const valid = c.data.status !== "invalid";
    const n = (v: number) => (valid ? measured(v, c.as_of, { unit: "count", window: "now", source: "forge_organism_census" }) : nul("unavailable_source_field", { unit: "count", window: "now" }));
    census = {
      status: token(c.data.status, c.as_of, meta), age_h: age(c.as_of, w, { source: "forge_organism_census" }),
      organs: n(c.data.organs), agents: n(c.data.agents), engines: n(c.data.engines), voters: n(c.data.voters),
      findings: c.data.findings === null ? nul("unavailable_source_field", { unit: "count", window: "now" }) : measured(c.data.findings, c.as_of, { unit: "count", window: "now", source: "forge_organism_census" }),
    };
  } else {
    census = Object.fromEntries(["status", "age_h", "organs", "agents", "engines", "voters", "findings"].map((k) => [k, nul(reasonOf(c))]));
  }

  // Controls: the kill switch, the consensus mode, the power mode and the autonomy dial (point in time).
  const kc = r.kernel_controls, cc = r.consensus_controls, mc = r.metabolism_controls, ad = r.autonomy_dial;
  const control = (s: SourceReading, row: { value: string; updated_at: string } | null | undefined, source: string, asBool = false): Measure => {
    if (s.status !== "ok" || !row) return nul(reasonOf(s), { window: "now" });
    if (asBool) return row.value === "1" || row.value === "0" ? measured(row.value === "1", row.updated_at, { window: "now", source }) : nul("unavailable_source_field", { window: "now" });
    return token(row.value, row.updated_at, { window: "now", source });
  };
  const autonomy: Obj = {};
  for (const g of SELF_MODEL_AUTONOMY_GROUPS) {
    if (ad.status !== "ok" && ad.status !== "empty") { autonomy[g] = nul(reasonOf(ad), { window: "now" }); continue; }
    const row = ad.data?.rows.find((x) => x.group_id === g);
    // No row is the group at its ceiling (migration 0083). The state holds as read at window_end's snapshot.
    autonomy[g] = row ? token(row.level, row.set_at, { window: "now", source: "autonomy_dial" }) : measured("ceiling", w.end, { window: "now", source: "autonomy_dial" });
  }
  const controls: Obj = {
    agents_enabled: control(kc, kc.data?.agents_enabled, "kernel_controls", true),
    consensus_mode: control(cc, cc.data?.mode, "consensus_controls"),
    power_mode: control(mc, mc.data?.power_mode, "metabolism_controls"),
    autonomy,
  };

  return { workers, deploys, changes, vitals, account, cost, builds, anomalies, inventory, census, controls };
}

// ---------------------------------------------------------------- Mind (§3)

const ORGAN_SOURCE = "agent_reports:trading_organ_health.v1";
function organUnit(metric: string): string | undefined {
  if (/^(share_|hit_rate_)/.test(metric)) return "ratio";
  if (/^(decisions|flips|staleness_incidents)_/.test(metric)) return "count";
  if (metric === "latest_decision_age_bars") return "bars";
  return undefined;
}
function organWindow(metric: string): string {
  const m = metric.match(/_(24h|7d|30d)$/);
  return m ? m[1] : "now";
}

/**
 * The trading organ through the whitelist: the 15 named metrics, each with its current value (`current`: a key named
 * `value` would read as a measure), baseline, z, and the hit rates' scoring context.
 */
export function tradingOrganNode(r: SelfModelReadings, w: SelfModelWindows): Obj {
  const t = r.trading_organ_health;
  if (!ok(t)) {
    const reason = reasonOf(t);
    return { report_age_h: nul(reason, { unit: "h", window: "now" }), stale: nul(reason), metrics: Object.fromEntries(ORGAN_HEALTH_METRIC_NAMES.map((name) => [name, { current: nul(reason, { unit: organUnit(name), window: organWindow(name) }) }])) };
  }
  const at = t.as_of;
  const ref = `ev:platform/report/${t.data.report_id}#metrics`;
  const byName = new Map<string, OrganHealthMetric>(t.data.health.metrics.map((m) => [m.metric, m]));
  const metrics: Obj = {};
  for (const name of ORGAN_HEALTH_METRIC_NAMES) {
    const m = byName.get(name);
    const unit = organUnit(name), window = organWindow(name);
    // The report's ref rides on the hit rates (the KPI's input) and on the report's age, not on every number.
    const hit = /^hit_rate_/.test(name);
    const meta = { unit, window, source: ORGAN_SOURCE, ref: hit ? ref : null };
    if (!m) { metrics[name] = { current: nul("unavailable_source_field", { unit, window }) }; continue; }
    const valueReason: NullReason = hit && m.status === "no_scored_data" ? "no_scored_data" : "unavailable_source_field";
    const node: Obj = {
      current: m.value === null ? nul(valueReason, { unit, window }) : measured(m.value, at, meta),
      baseline_7d: m.baseline_7d === null ? nul("unavailable_source_field", { unit, window: "7d" }) : measured(m.baseline_7d, at, { ...meta, window: "7d", ref: null }),
      z: m.z === null ? nul("unavailable_source_field", { unit: "z", window }) : measured(m.z, at, { ...meta, unit: "z", ref: null }),
    };
    if (hit) {
      node.status = m.status ? measured(m.status, at, { window, source: ORGAN_SOURCE, ref }) : nul("unavailable_source_field", { window });
      for (const k of ["n_directional", "hit", "miss"] as const) node[k] = m[k] === undefined || m[k] === null ? nul("unavailable_source_field", { unit: "count", window }) : measured(m[k]!, at, { ...meta, unit: "count", ref: null });
      node.wait_accuracy = m.wait_accuracy === undefined || m.wait_accuracy === null ? nul("unavailable_source_field", { unit: "ratio", window }) : measured(m.wait_accuracy, at, { ...meta, unit: "ratio", ref: null });
      if (typeof m.subject === "string") node.subject = label(m.subject);
    }
    metrics[name] = node;
  }
  return {
    report_age_h: age(at, w, { source: ORGAN_SOURCE, ref }),
    stale: t.data.health.stale === null ? nul("unavailable_source_field") : measured(t.data.health.stale, at, { window: "now", source: ORGAN_SOURCE, ref }),
    metrics,
  };
}

export function mindSection(r: SelfModelReadings, w: SelfModelWindows): Section {
  // AI health: requests and failures per service (7 d), and failures per task and category (7 d).
  const u = r.ai_usage, af = r.ai_failures;
  const ai: Obj = ok(u)
    ? {
      requests_7d: measured(u.data.by_service.reduce((s, x) => s + x.requests, 0), u.as_of, { unit: "count", window: "7d", source: "ai_usage" }),
      failures_7d: measured(u.data.by_service.reduce((s, x) => s + x.failures, 0), u.as_of, { unit: "count", window: "7d", source: "ai_usage" }),
      by_service_7d: top([...u.data.by_service].sort((a, b) => b.requests - a.requests || (a.service_id < b.service_id ? -1 : 1)), 12, (x) => ({
        service: label(x.service_id),
        requests: measured(x.requests, dayStart(x.newest_day), { unit: "count", window: "7d", source: "ai_usage" }),
        failures: measured(x.failures, dayStart(x.newest_day), { unit: "count", window: "7d", source: "ai_usage" }),
      })),
    }
    : { requests_7d: nul(reasonOf(u), { unit: "count", window: "7d" }), failures_7d: nul(reasonOf(u), { unit: "count", window: "7d" }), by_service_7d: { top: [] } };
  ai.failures_by_task_7d = ok(af)
    ? top(af.data.groups, 10, (x) => ({ task: label(x.task), category: label(x.category), count: measured(x.n, dayStart(x.newest_day), { unit: "count", window: "7d", source: "ai_failures" }) }))
    : { top: [], total: nul(reasonOf(af), { unit: "count", window: "7d" }) };

  // Councils (30 d): count by state, calls and spend.
  const co = r.councils;
  const councils: Obj = ok(co)
    ? {
      ...byName(co.data.by_state.map((x) => ({ name: x.state, n: x.n, newest: x.newest })), "state", "30d", "councils"),
      calls: measured(co.data.by_state.reduce((s, x) => s + x.calls, 0), co.as_of, { unit: "count", window: "30d", source: "councils" }),
      spend_usd: measured(co.data.by_state.reduce((s, x) => s + x.usd, 0), co.as_of, { unit: "usd", window: "30d", source: "councils" }),
    }
    : { ...unreadList(co, "30d"), calls: nul(reasonOf(co), { unit: "count", window: "30d" }), spend_usd: nul(reasonOf(co), { unit: "usd", window: "30d" }) };

  // Consensus (30 d): proposals by status and class, and those waiting for the owner.
  const cp = r.consensus_proposals;
  let consensus: Obj;
  if (ok(cp)) {
    const sum = (key: "status" | "class") => {
      const m = new Map<string, { n: number; newest: string | null }>();
      for (const x of cp.data.by_status_class) { const e = m.get(x[key]) ?? { n: 0, newest: null }; m.set(x[key], { n: e.n + x.n, newest: newestOf([e.newest, x.newest]) }); }
      return [...m].map(([name, v]) => ({ name, ...v }));
    };
    const total = cp.data.by_status_class.reduce((s, x) => s + x.n, 0);
    const waiting = cp.data.by_status_class.filter((x) => x.status === "pending_owner");
    consensus = {
      by_status_30d: byName(sum("status"), "status", "30d", "consensus_proposals"),
      by_class_30d: byName(sum("class"), "class", "30d", "consensus_proposals"),
      waiting_owner_30d: count(waiting.reduce((s, x) => s + x.n, 0), total, waiting.length ? newestOf(waiting.map((x) => x.newest)) : cp.as_of, { window: "30d", source: "consensus_proposals" }),
    };
  } else {
    consensus = { by_status_30d: unreadList(cp, "30d"), by_class_30d: unreadList(cp, "30d"), waiting_owner_30d: nul(reasonOf(cp), { unit: "count", window: "30d" }) };
  }

  // Evolver: its mode, intents and evolutions by state (30 d), refusals and AI calls.
  const ec = r.evolver_controls, ei = r.evolution_intents_v2, ev = r.evolutions_v2;
  const evolver: Obj = {
    mode: ec.status === "ok" && ec.data?.mode ? token(ec.data.mode.value, ec.data.mode.updated_at, { window: "now", source: "evolver_controls" }) : nul(reasonOf(ec), { window: "now" }),
    intents_30d: ok(ei) ? byName(ei.data.by_state.map((x) => ({ name: x.state, n: x.n, newest: x.newest })), "state", "30d", "evolution_intents_v2") : unreadList(ei, "30d"),
    evolutions_30d: ok(ev) ? byName(ev.data.by_state.map((x) => ({ name: x.state, n: x.n, newest: x.newest })), "state", "30d", "evolutions_v2") : unreadList(ev, "30d"),
    refused_30d: ok(ev) ? measured(ev.data.by_state.reduce((s, x) => s + x.refused, 0), ev.as_of, { unit: "count", window: "30d", source: "evolutions_v2" }) : nul(reasonOf(ev), { unit: "count", window: "30d" }),
    ai_calls_30d: ok(ev) ? measured(ev.data.by_state.reduce((s, x) => s + x.ai_calls, 0), ev.as_of, { unit: "count", window: "30d", source: "evolutions_v2" }) : nul(reasonOf(ev), { unit: "count", window: "30d" }),
  };

  // The teaching record (teaching-record.ts): score and n per subject, 7 and 30 days.
  const cor = r.corrections;
  const teaching: Obj = ok(cor)
    ? top([...cor.data.teaching].sort((a, b) => b.n_30d - a.n_30d || (a.subject < b.subject ? -1 : 1)), 8, (x) => {
      const win = (n: number, score: number | null, last: string | null, window: string): Obj => ({
        n: last ? measured(n, last, { unit: "count", window, source: "corrections" }) : nul("no_rows", { unit: "count", window }),
        score: score === null || !last ? nul(last ? "no_scored_data" : "no_rows", { unit: "ratio", window }) : measured(score, last, { unit: "ratio", window, source: "corrections" }),
      });
      return { subject: label(x.subject), d7: win(x.n_7d, x.score_7d, x.last_7d, "7d"), d30: win(x.n_30d, x.score_30d, x.last_30d, "30d") };
    })
    : { top: [], total: nul(reasonOf(cor), { unit: "count", window: "30d" }) };

  return { trading_organ: tradingOrganNode(r, w), ai, councils, consensus, evolver, teaching };
}

// ---------------------------------------------------------------- Memory (§3)

export function memorySection(r: SelfModelReadings, w: SelfModelWindows, adrManifestIds?: readonly string[]): Section {
  // The ADR index: the ADR Steward's documents (point in time), and the reading adr_index_live over the ids of the
  // manifests the caller bundles (the kernel bundles architecture/adr/progress/, as the Steward does).
  const a = r.adr_progress;
  const adrMeta = { window: "now", source: "adr_progress" };
  const adr_index: Obj = ok(a)
    ? top(a.data.rows, 24, (x) => ({
      adr: label(x.adr_id),
      status: token(x.status, x.changed_at, { ...adrMeta, ref: `ev:adr/${x.adr_id}` }),
      percent: measured(x.percent, x.changed_at, { unit: "percent", ...adrMeta }),
      percent_proven: measured(x.percent_proven, x.changed_at, { unit: "percent", ...adrMeta }),
      drift_count: opt(x.drift_count, x.changed_at, { unit: "count", ...adrMeta }),
      stale: x.stale === "true" || x.stale === "false" ? measured(x.stale === "true", x.changed_at, adrMeta) : nul("unavailable_source_field", { window: "now" }),
    }))
    : { top: [], total: nul(reasonOf(a), { unit: "count", window: "now" }) };
  adr_index.adr_index_live = adrIndexLive(r, adrManifestIds);
  return {
    adr_index,
    knowledge: knowledgeNode(r, w),
    corrections: correctionsNode(r, w),
    memories: memoriesNode(r),
    learning_watch_7d: learningNode(r),
    // The experience ledger is T3's (ADR-0016 §3): not built.
    experience_ledger: nul("not_built"),
  };
}

/** The reading adr_index_live (adr-evidence.ts): the ADR Steward is enabled and adr_progress holds a row for every manifest. */
export function adrIndexLive(r: SelfModelReadings, manifestIds: readonly string[] | undefined): Measure {
  const a = r.adr_progress, ag = r.agents;
  if (ag.status !== "ok" && ag.status !== "empty") return nul(reasonOf(ag), { window: "now" });
  if (a.status !== "ok" && a.status !== "empty") return nul(reasonOf(a), { window: "now" });
  if (!manifestIds || manifestIds.length === 0) return nul("source_unavailable", { window: "now" });
  const steward = ag.data?.adr_steward;
  if (!steward) return nul("no_rows", { window: "now" });
  const have = new Set((a.data?.rows ?? []).map((x) => x.adr_id));
  const live = steward.status === "enabled" && [...new Set(manifestIds)].every((id) => have.has(id));
  return measured(live, newestOf([steward.updated_at, a.as_of]), { window: "now", source: "agents:adr_progress", ref: "ev:platform/agent/adr-steward#status" });
}

function knowledgeNode(r: SelfModelReadings, w: SelfModelWindows): Obj {
  const k = r.knowledge_proposals, au = r.knowledge_audit;
  const node: Obj = ok(k)
    ? {
      proposals_30d: byName(k.data.by_kind_status.map((x) => ({ name: `${x.kind}:${x.status}`, n: x.n, newest: x.newest })), "kind_status", "30d", "knowledge_proposals"),
      pending_now: measured(k.data.pending.n, k.data.pending.newest ?? k.as_of, { unit: "count", window: "now", source: "knowledge_proposals" }),
    }
    : { proposals_30d: unreadList(k, "30d"), pending_now: nul(reasonOf(k), { unit: "count", window: "now" }) };
  // Aether's newest knowledge_audit report: its subject and time only.
  node.newest_audit = ok(au)
    ? { subject: label(au.data.subject), age_h: age(au.as_of, w, { source: "agent_reports:knowledge_audit", ref: `ev:platform/report/${au.data.report_id}` }) }
    : { age_h: nul(reasonOf(au), { unit: "h", window: "now" }) };
  return node;
}

function correctionsNode(r: SelfModelReadings, w: SelfModelWindows): Obj {
  const c = r.corrections;
  if (!ok(c)) return { d7: unreadList(c, "7d"), d30: unreadList(c, "30d") };
  // Counts by label, source and side; the text and the actor are never read into the document.
  const win = (since: string, window: string): Obj => {
    const rows = c.data.rows.filter((x) => Date.parse(x.created_at) > Date.parse(since));
    const group = (key: "label" | "source" | "side", cut: number) => {
      const m = new Map<string, { n: number; newest: string | null }>();
      for (const x of rows) { const e = m.get(x[key]) ?? { n: 0, newest: null }; m.set(x[key], { n: e.n + 1, newest: newestOf([e.newest, x.created_at]) }); }
      return byName([...m].map(([name, v]) => ({ name, ...v })), key, window, "corrections", cut);
    };
    return { by_label: group("label", 4), by_source: group("source", 8), by_side: group("side", 2) };
  };
  return { d7: win(w.d7, "7d"), d30: win(w.d30, "30d") };
}

function memoriesNode(r: SelfModelReadings): Obj {
  const m = r.agent_memories;
  if (!ok(m)) return { total: nul(reasonOf(m), { unit: "count", window: "now" }), by_agent: { top: [] } };
  return {
    total: measured(m.data.by_agent.reduce((s, x) => s + x.n, 0), m.as_of, { unit: "count", window: "now", source: "agent_memories" }),
    by_agent: top(m.data.by_agent, 10, (x) => ({ agent: label(x.agent_id), count: measured(x.n, x.newest, { unit: "count", window: "now", source: "agent_memories" }) })),
  };
}

function learningNode(r: SelfModelReadings): Obj {
  const f = r.observer_findings;
  if (!ok(f)) return { learning_volume: nul(reasonOf(f), { unit: "count", window: "7d" }), learning_repeat: nul(reasonOf(f), { unit: "count", window: "7d" }) };
  return {
    learning_volume: measured(f.data.by_kind.reduce((s, x) => s + x.learning_volume, 0), f.as_of, { unit: "count", window: "7d", source: "observer_findings" }),
    learning_repeat: measured(f.data.by_kind.reduce((s, x) => s + x.learning_repeat, 0), f.as_of, { unit: "count", window: "7d", source: "observer_findings" }),
  };
}

// ---------------------------------------------------------------- Ecosystem (§3)

export function ecosystemSection(r: SelfModelReadings, w: SelfModelWindows): Section {
  const reg = r.service_registry, c = r.forge_organism_census, v = r.observer_vitals;
  const origins: Obj = {};
  for (const o of EXTERNAL_ORIGINS) {
    const dna_read: Measure = !ok(c) ? nul(reasonOf(c), { window: "now" })
      : c.data.status === "invalid" || c.data.origins_read === null ? nul("unavailable_source_field", { window: "now" })
      : measured(c.data.origins_read.includes(o.origin), c.as_of, { window: "now", source: "forge_organism_census", ref: `ev:platform/census/${c.data.main_sha}` });
    const services = o.services.map((service) => {
      const row = ok(reg) ? reg.data.rows.find((x) => x.service_id === service) : undefined;
      const vit = ok(v) ? v.data.workers.find((x) => x.subject === service) : undefined;
      const regNull = ok(reg) ? "no_rows" : reasonOf(reg);
      const at24 = vit && vit.hours_24h ? vit.newest : null;
      return {
        service: label(service),
        status: row ? token(row.status, row.updated_at, { window: "now", source: "service_registry" }) : nul(regNull, { window: "now" }),
        versions_match: !row ? nul(regNull, { window: "now" })
          : row.desired_version && row.observed_version ? measured(row.desired_version === row.observed_version, row.updated_at, { window: "now", source: "service_registry" })
          : nul("unavailable_source_field", { window: "now" }),
        requests_24h: !ok(v) ? nul(reasonOf(v), { unit: "count", window: "24h" }) : at24 === null ? nul("no_rows", { unit: "count", window: "24h" }) : opt(vit!.req_24h, at24, { unit: "count", window: "24h", source: "observer_vitals" }),
        error_ratio_24h: !ok(v) ? nul(reasonOf(v), { unit: "ratio", window: "24h" }) : at24 === null ? nul("no_rows", { unit: "ratio", window: "24h" }) : ratio(vit!.err_24h, vit!.req_24h, at24, { window: "24h", source: "observer_vitals" }),
      };
    });
    const node: Obj = { dna_read, services };
    if (o.origin === "xauusd") node.trading_organ_age_h = tradingOrganNode(r, w).report_age_h as Measure;
    origins[o.origin] = node;
  }
  const d = r.forge_dependency_audits;
  let dependency_advisories: Obj;
  if (ok(d)) {
    const meta = { window: "now", source: "forge_dependency_audits", ref: `ev:platform/dependency_audit/${d.data.run_id}` };
    // A failed audit's counts are their column defaults, not measurements.
    const n = (x: number) => (d.data.status === "ok" ? measured(x, d.as_of, { unit: "count", window: "now", source: "forge_dependency_audits" }) : nul("unavailable_source_field", { unit: "count", window: "now" }));
    dependency_advisories = { status: token(d.data.status, d.as_of, meta), age_h: age(d.as_of, w, { source: "forge_dependency_audits" }), critical: n(d.data.critical), high: n(d.data.high), moderate: n(d.data.moderate) };
  } else {
    dependency_advisories = Object.fromEntries(["status", "age_h", "critical", "high", "moderate"].map((k) => [k, nul(reasonOf(d))]));
  }
  // No platform source reads these yet (§2.3, Q9): they stay null until a reviewed read-only path exists.
  const outside = nul("source_outside_platform");
  return {
    origins, dependency_advisories,
    workers_ai_models: outside, workers_ai_deprecations: outside, cloudflare_changelog: outside,
    omega_health: outside, market_regime: outside, session_calendar: outside,
  };
}
