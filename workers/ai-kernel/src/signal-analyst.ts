/**
 * The Signal Analyst agent (TP-017, ADR-0007): a deterministic reader of the XAUUSD advisory decisions of
 * xauusd-ai-trading-assistant. Since 2026-11-15 (owner) it reports the trading organ's health in metric form
 * instead of relaying each decision; Nexus and xauusd's own Telegram heartbeat relay the decisions themselves.
 *
 * What it publishes (all `xauusd_digest`, `ai_status: "deterministic"`, no AI call, never a price level):
 *  - warnings, unchanged in kind and subject: the source is unavailable, the decisions list is empty, the analysis
 *    is stale; and, since 2026-11-15 as a report of its own, a BUY<->SELL flip, once per flipped candle;
 *  - one metric snapshot (`body.schema = "trading_organ_health.v1"`, info), when its values change materially or
 *    at the 6 h heartbeat (see `snapshotChanges` and `shouldPublishSnapshot`). ADR-0016 T1 (the self-model) and
 *    the Strategist read this snapshot; the Console overview shows it as chips.
 *
 * `signals.observe` returns the newest `limit` decisions (newest first, at most 50 in the kernel; this agent asks
 * for 50) with no time window. The 24 h metrics therefore come from a rolling window this agent keeps in its own
 * Durable Object storage (`xauusd_window`, the last 48 h of decisions), merged from every observation, and the
 * 7-day baselines come from one sample per UTC hour (`organ_health_samples`, 7 days).
 */
import type { JsonObject } from "../../control-plane-shared/src/http.ts";
import { agentsEnabled, getAgent } from "../../control-plane-shared/src/capabilities.ts";
import { rememberOutcomeForAgent } from "./memory.ts";
import { syscall } from "./syscall.ts";
import type { CycleReport, KernelEnv, Memory } from "./supervisor.ts";

export const SIGNAL_ANALYST_ID = "signal-analyst";
export const DISCLAIMER = "advisory only; not an order";
/** Throttle of the unavailable and empty warnings. */
export const DIGEST_INTERVAL_MS = 6 * 3_600_000;
/** The longest a snapshot goes without being published again, even with no material change. */
export const SNAPSHOT_HEARTBEAT_MS = 6 * 3_600_000;
export const SNAPSHOT_SCHEMA = "trading_organ_health.v1";
/** Decisions asked of signals.observe per cycle (its kernel maximum). */
export const OBSERVE_LIMIT = 50;
/** A baseline needs this many earlier hourly samples (one day) within 7 days; fewer gives baseline_7d and z null. */
export const MIN_BASELINE_SAMPLES = 24;
/**
 * At most this many flip warnings per cycle (the newest), so a long outage does not replay a burst of flips and the
 * snapshot keeps room in reports.publish's limit of 4 an hour (capabilities.ts).
 */
export const MAX_FLIP_WARNINGS_PER_CYCLE = 2;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WINDOW_KEEP_MS = 2 * DAY_MS;
const SAMPLE_HOURS = 7 * 24;

/** Serializes overlapping invocations of this agent's Durable Object cycle, including awaits. */
export class SignalAnalystCycleQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export interface XauusdDecision {
  candle_key: string;
  candle_open_ms: number;
  decided_at: string | null;
  decision: "BUY" | "SELL" | "WAIT" | "NO_TRADE" | "UNKNOWN";
  confidence: number | null;
  // No entry, stop or target: the kernel never holds a price level (owner rule, 2026-11-07).
  risk_reward: number | null;
  reasoning: string;
}

/** One window of xauusd's outcome scores, as signals.observe validates it (counts and rates, or null). */
export interface OutcomeWindow {
  n_directional: number | null;
  hit: number | null;
  miss: number | null;
  /** hit / (hit + miss), or null with no scored directional decision. */
  hit_rate: number | null;
  wait_n: number | null;
  wait_accuracy: number | null;
}

/** xauusd's `outcome_summary` (8a27029), validated by signals.observe; null when absent, null or invalid. */
export interface OutcomeSummary {
  scoring_version: string;
  subject: string;
  timeframe: string | null;
  windows: { "7d": OutcomeWindow | null; "30d": OutcomeWindow | null };
  as_of: string | null;
}

export interface XauusdObservation {
  source: string;
  observed_at: string;
  available: boolean;
  stale?: boolean;
  error?: string;
  endpoint_used?: string;
  latest: XauusdDecision | null;
  recent: XauusdDecision[];
  outcome_summary?: OutcomeSummary | null;
}

/** One decision as the rolling window keeps it: no reasoning, no ratio, no level. */
export interface WindowDecision {
  open_ms: number;
  /** Bar minutes, from the candle key (15 or 60). */
  tf: number;
  decision: string;
  confidence: number | null;
}

/** The metrics of one snapshot, in this order (the hourly samples store their values in it). */
export const ORGAN_HEALTH_METRICS = [
  "decisions_24h",
  "share_buy_24h",
  "share_sell_24h",
  "share_wait_24h",
  "share_no_trade_24h",
  "latest_decision_age_bars",
  "flips_24h",
  "confidence_mean_24h",
  "confidence_p50_24h",
  "confidence_min_24h",
  "confidence_max_24h",
  "hit_rate_7d",
  "hit_rate_30d",
  "staleness_incidents_24h",
  "staleness_incidents_7d",
] as const;
export type OrganHealthMetricName = (typeof ORGAN_HEALTH_METRICS)[number];

/**
 * The hit rates come from xauusd's `outcome_summary` (served with the decisions since xauusd 8a27029):
 *  - "ok": the window has a hit rate;
 *  - "no_scored_data": the summary is there but nothing directional is scored yet (n_directional 0, hit_rate null),
 *    for example while the market is closed or for a new subject;
 *  - "unavailable_source_field": the summary (or the window) is absent or null (an older deploy, a failed scorecard
 *    read, or a summary for another subject than the decisions'). No value is ever invented.
 */
export const UNAVAILABLE_SOURCE_FIELD = "unavailable_source_field";
export const NO_SCORED_DATA = "no_scored_data";
export const HIT_RATE_OK = "ok";
export type HitRateStatus = typeof HIT_RATE_OK | typeof NO_SCORED_DATA | typeof UNAVAILABLE_SOURCE_FIELD;
const HIT_RATE_WINDOWS: Readonly<Record<string, "7d" | "30d">> = { hit_rate_7d: "7d", hit_rate_30d: "30d" };
/** The outcome subject of each decisions endpoint (signals.observe's endpoint_used). */
export const OUTCOME_SUBJECT: Readonly<Record<string, string>> = { engine: "engine:15", legacy: "chain:h1" };

export interface OrganHealthMetric {
  metric: OrganHealthMetricName;
  value: number | null;
  baseline_7d: number | null;
  z: number | null;
  /** Hit rates only. */
  status?: HitRateStatus;
  /** Hit rates with a summary only: the window's scoring context. */
  n_directional?: number | null;
  hit?: number | null;
  miss?: number | null;
  wait_accuracy?: number | null;
  subject?: string;
  as_of?: string | null;
}

/** The summary when it belongs to the endpoint the decisions came from; otherwise null. */
export function outcomeForSource(summary: OutcomeSummary | null | undefined, endpointUsed: string | undefined): OutcomeSummary | null {
  if (!summary || typeof summary !== "object" || !summary.windows || typeof summary.windows !== "object") return null;
  const expected = OUTCOME_SUBJECT[endpointUsed ?? "engine"];
  return expected && summary.subject === expected ? summary : null;
}

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function outcomeWindow(summary: OutcomeSummary | null, metric: string): OutcomeWindow | null {
  const name = HIT_RATE_WINDOWS[metric];
  const w = name && summary ? summary.windows[name] : null;
  return w && typeof w === "object" ? w : null;
}

/** A hit rate's status (see UNAVAILABLE_SOURCE_FIELD). */
export function hitRateStatus(summary: OutcomeSummary | null, metric: "hit_rate_7d" | "hit_rate_30d"): HitRateStatus {
  const w = outcomeWindow(summary, metric);
  if (!w) return UNAVAILABLE_SOURCE_FIELD;
  return numOrNull(w.hit_rate) !== null ? HIT_RATE_OK : NO_SCORED_DATA;
}

/** One hourly sample: the UTC hour index and the values in ORGAN_HEALTH_METRICS order. */
export interface OrganHealthSample { h: number; v: (number | null)[] }
interface SampleStore { schema: string; samples: OrganHealthSample[] }

interface LastSnapshot { at: number; stale: boolean; values: Record<string, { value: number | null; z: number | null; status?: string }> }

interface MemoryState {
  last_empty_report_at?: number;
  last_stale_candle_key?: string;
  last_unavailable_report_at?: number;
  /** Open time of the newest candle a flip warning was published for (or seen when the window started). */
  last_flip_open_ms?: number;
  /** Staleness incidents (detection times, ms), kept 7 days. */
  stale_incidents?: number[];
  last_incident_candle_key?: string;
  in_empty_episode?: boolean;
  last_snapshot?: LastSnapshot;
  // Before 2026-11-15 (the decision digest); read by nothing now, left to age out.
  last_candle_key?: string;
  last_decision?: string;
  last_digest_at?: number;
}

function isoMs(ms: number): string {
  return new Date(ms).toISOString();
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function flipBuySell(prev: string | undefined, next: string): boolean {
  return (prev === "BUY" && next === "SELL") || (prev === "SELL" && next === "BUY");
}

function tfOfKey(key: string): number {
  return /:15:\d+$/.test(key) ? 15 : 60;
}

function tfLabel(tf: number): string {
  return tf === 15 ? "M15" : "H1";
}

function toWindowDecision(d: XauusdDecision): WindowDecision {
  return {
    open_ms: d.candle_open_ms,
    tf: tfOfKey(d.candle_key),
    decision: String(d.decision),
    confidence: typeof d.confidence === "number" && Number.isFinite(d.confidence) ? d.confidence : null,
  };
}

/** Merges observed decisions into the window (same candle: the newer reading wins), drops what is older than 48 h. */
export function mergeWindow(window: WindowDecision[], observed: XauusdDecision[], now: number): { window: WindowDecision[]; added: WindowDecision[] } {
  const byKey = new Map<string, WindowDecision>();
  for (const w of window) byKey.set(`${w.tf}:${w.open_ms}`, w);
  const added: WindowDecision[] = [];
  for (const d of observed) {
    if (!d || typeof d.candle_open_ms !== "number" || !Number.isFinite(d.candle_open_ms)) continue;
    const w = toWindowDecision(d);
    const key = `${w.tf}:${w.open_ms}`;
    if (!byKey.has(key)) added.push(w);
    byKey.set(key, w);
  }
  const merged = [...byKey.values()]
    .filter((w) => w.open_ms + w.tf * 60_000 > now - WINDOW_KEEP_MS)
    .sort((a, b) => a.tf - b.tf || a.open_ms - b.open_ms);
  return { window: merged, added: added.sort((a, b) => a.open_ms - b.open_ms) };
}

/** The flips among the newly added decisions: a BUY<->SELL change from the previous candle of the same timeframe. */
export function newFlips(window: WindowDecision[], added: WindowDecision[]): { at: WindowDecision; previous: WindowDecision }[] {
  const out: { at: WindowDecision; previous: WindowDecision }[] = [];
  for (const a of added) {
    const series = window.filter((w) => w.tf === a.tf);
    const i = series.findIndex((w) => w.open_ms === a.open_ms);
    if (i <= 0) continue;
    const prev = series[i - 1];
    if (flipBuySell(prev.decision, a.decision)) out.push({ at: a, previous: prev });
  }
  return out;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/**
 * The metric values (pure). The 24 h set is every decision of the latest decision's timeframe whose bar closed
 * after now - 24 h. Shares are of that count (UNKNOWN counts in the total only). A flip is a BUY<->SELL change
 * between consecutive decisions of the set. The age is (now - the latest bar's close) / the bar length.
 */
export function organHealthValues(
  window: WindowDecision[],
  latest: { open_ms: number; tf: number } | null,
  incidents: number[],
  now: number,
  outcome: OutcomeSummary | null = null,
): Record<OrganHealthMetricName, number | null> {
  const hitRate = (m: string) => { const v = numOrNull(outcomeWindow(outcome, m)?.hit_rate); return v === null ? null : r3(v); };
  const tf = latest?.tf ?? window[window.length - 1]?.tf ?? 60;
  const barMs = tf * 60_000;
  const day = window
    .filter((w) => w.tf === tf && w.open_ms + barMs > now - DAY_MS)
    .sort((a, b) => a.open_ms - b.open_ms);
  const n = day.length;
  const share = (d: string) => (n ? r3(day.filter((w) => w.decision === d).length / n) : null);
  let flips = 0;
  for (let i = 1; i < n; i++) if (flipBuySell(day[i - 1].decision, day[i].decision)) flips++;
  const conf = day.map((w) => w.confidence).filter((c): c is number => typeof c === "number").sort((a, b) => a - b);
  const age = latest ? r2(Math.max(0, now - (latest.open_ms + latest.tf * 60_000)) / (latest.tf * 60_000)) : null;
  return {
    decisions_24h: n,
    share_buy_24h: share("BUY"),
    share_sell_24h: share("SELL"),
    share_wait_24h: share("WAIT"),
    share_no_trade_24h: share("NO_TRADE"),
    latest_decision_age_bars: age,
    flips_24h: flips,
    confidence_mean_24h: conf.length ? r3(conf.reduce((s, c) => s + c, 0) / conf.length) : null,
    confidence_p50_24h: conf.length ? r3(median(conf)) : null,
    confidence_min_24h: conf.length ? r3(conf[0]) : null,
    confidence_max_24h: conf.length ? r3(conf[conf.length - 1]) : null,
    hit_rate_7d: hitRate("hit_rate_7d"),
    hit_rate_30d: hitRate("hit_rate_30d"),
    staleness_incidents_24h: incidents.filter((t) => t > now - DAY_MS && t <= now).length,
    staleness_incidents_7d: incidents.filter((t) => t > now - 7 * DAY_MS && t <= now).length,
  };
}

/**
 * Each metric with its 7-day baseline (the mean of the earlier hourly samples of the last 7 days, the current hour
 * excluded) and z ((value - mean) / population standard deviation). Fewer than MIN_BASELINE_SAMPLES samples with a
 * value, or no value now, gives null; a flat baseline gives z 0 when the value equals it and null otherwise.
 */
export function withBaselines(
  values: Record<OrganHealthMetricName, number | null>,
  samples: OrganHealthSample[],
  now: number,
  outcome: OutcomeSummary | null = null,
): OrganHealthMetric[] {
  const hour = Math.floor(now / HOUR_MS);
  const prior = samples.filter((s) => s.h < hour && s.h >= hour - SAMPLE_HOURS);
  return ORGAN_HEALTH_METRICS.map((metric, i) => {
    const value = values[metric];
    const xs = prior.map((s) => s.v[i]).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    let baseline: number | null = null;
    let z: number | null = null;
    if (xs.length >= MIN_BASELINE_SAMPLES) {
      const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
      baseline = r3(mean);
      if (value !== null) z = sd > 1e-9 ? r2((value - mean) / sd) : Math.abs(value - mean) < 1e-9 ? 0 : null;
    }
    const m: OrganHealthMetric = { metric, value, baseline_7d: baseline, z };
    if (metric === "hit_rate_7d" || metric === "hit_rate_30d") {
      m.status = hitRateStatus(outcome, metric);
      const w = outcomeWindow(outcome, metric);
      if (w && outcome) {
        m.n_directional = numOrNull(w.n_directional);
        m.hit = numOrNull(w.hit);
        m.miss = numOrNull(w.miss);
        m.wait_accuracy = numOrNull(w.wait_accuracy);
        m.subject = outcome.subject;
        m.as_of = typeof outcome.as_of === "string" ? outcome.as_of : null;
      }
    }
    return m;
  });
}

/** Records this hour's sample (replacing an earlier one of the same hour) and drops samples older than 7 days. */
export function recordSample(samples: OrganHealthSample[], values: Record<OrganHealthMetricName, number | null>, now: number): OrganHealthSample[] {
  const hour = Math.floor(now / HOUR_MS);
  const kept = samples.filter((s) => s.h !== hour && s.h > hour - SAMPLE_HOURS - 1);
  kept.push({ h: hour, v: ORGAN_HEALTH_METRICS.map((m) => values[m]) });
  return kept.sort((a, b) => a.h - b.h);
}

const COUNT_METRICS: ReadonlySet<string> = new Set(["flips_24h", "staleness_incidents_24h", "staleness_incidents_7d"]);
/** Shares, confidence statistics and hit rates: a move of at least this much (absolute) is material. */
export const MATERIAL_RATIO_DELTA = 0.05;
/** |z| at or above this is an anomaly; a metric that newly reaches it is material. */
export const MATERIAL_Z = 3;

/**
 * The metrics that changed materially since the last published snapshot (pure):
 *  - a value appeared or disappeared (null <-> number);
 *  - flips_24h or a staleness incident count changed at all;
 *  - decisions_24h moved by at least max(2, 10 % of the last value);
 *  - a share, confidence statistic or hit rate moved by at least 0.05;
 *  - a metric's |z| newly reached 3;
 *  - a hit rate's status changed (unavailable_source_field, no_scored_data, ok; a snapshot from before the statuses
 *    counts as unavailable_source_field, which is all it could be);
 *  - the staleness flag of the observation changed ("stale").
 * latest_decision_age_bars grows every cycle by design, so only its staleness (the flag) and its z count.
 */
export function snapshotChanges(last: LastSnapshot | undefined, metrics: OrganHealthMetric[], stale: boolean): string[] {
  if (!last) return ["first"];
  const changed: string[] = [];
  if (last.stale !== stale) changed.push("stale");
  for (const m of metrics) {
    const prev = last.values[m.metric];
    const prevValue = prev ? prev.value : null;
    const prevZ = prev ? prev.z : null;
    let material = false;
    if ((prevValue === null) !== (m.value === null)) material = true;
    else if (prevValue !== null && m.value !== null) {
      const d = Math.abs(m.value - prevValue);
      if (COUNT_METRICS.has(m.metric)) material = d > 0;
      else if (m.metric === "decisions_24h") material = d >= Math.max(2, 0.1 * prevValue);
      else if (m.metric !== "latest_decision_age_bars") material = d >= MATERIAL_RATIO_DELTA - 1e-9;
    }
    if (m.status !== undefined && prev) {
      const prevStatus = prev.status ?? (m.metric in HIT_RATE_WINDOWS ? UNAVAILABLE_SOURCE_FIELD : undefined);
      if (prevStatus !== m.status) material = true;
    }
    const anomalous = m.z !== null && Math.abs(m.z) >= MATERIAL_Z;
    const wasAnomalous = prevZ !== null && Math.abs(prevZ) >= MATERIAL_Z;
    if (anomalous && !wasAnomalous) material = true;
    if (material) changed.push(m.metric);
  }
  return changed;
}

/** The publish rule: the first snapshot, any material change, or SNAPSHOT_HEARTBEAT_MS since the last one. */
export function shouldPublishSnapshot(last: LastSnapshot | undefined, changed: string[], now: number): "first" | "change" | "heartbeat" | null {
  if (!last) return "first";
  if (changed.length > 0) return "change";
  if (now - last.at >= SNAPSHOT_HEARTBEAT_MS) return "heartbeat";
  return null;
}

export async function runSignalCycle(
  env: KernelEnv,
  memory: Memory,
  trigger: "scheduled" | "operator",
  now = Date.now(),
): Promise<CycleReport> {
  const report: CycleReport = { agent_id: SIGNAL_ANALYST_ID, trigger, cycle_at: new Date(now).toISOString(), findings: [], actions: [] };
  const agent = await getAgent(env.DB, SIGNAL_ANALYST_ID);
  if (!agent || agent.status !== "enabled" || !(await agentsEnabled(env.DB))) {
    report.skipped = !agent ? "agent_not_registered" : agent.status !== "enabled" ? "agent_suspended" : "agents_disabled";
    await memory.put("last_cycle", report);
    return report;
  }

  const observed = await syscall(env, SIGNAL_ANALYST_ID, "signals.observe", { now, limit: OBSERVE_LIMIT });
  report.actions.push(observed);
  if (observed.outcome !== "succeeded") {
    await memory.put("last_cycle", report);
    return report;
  }
  const obs = observed.result as unknown as XauusdObservation;

  const mem = (await memory.get<MemoryState>("xauusd_state")) ?? {};
  const save = () => memory.put("xauusd_state", mem);
  const publish = (severity: "info" | "warning", subject: string, body: JsonObject) =>
    syscall(env, SIGNAL_ANALYST_ID, "reports.publish", { kind: "xauusd_digest", severity, subject: subject.slice(0, 200), ai_status: "deterministic", body });

  // Unavailable
  if (!obs.available) {
    const err = obs.error ?? "xauusd_unreachable";
    const last = mem.last_unavailable_report_at ?? 0;
    if (now - last >= DIGEST_INTERVAL_MS) {
      const published = await publish("warning", `XAUUSD decisions unavailable (${err})`, { error: err, source: obs.source, disclaimer: DISCLAIMER });
      report.actions.push(published);
      if (published.outcome === "succeeded") {
        mem.last_unavailable_report_at = now;
        await save();
      }
    }
    await memory.put("last_cycle", report);
    return report;
  }

  const latest = obs.latest;
  const recent = Array.isArray(obs.recent) ? obs.recent : [];

  // Staleness incidents: a stale latest decision (once per candle) or the start of an empty episode.
  const incidents = (mem.stale_incidents ?? []).filter((t) => t > now - 7 * DAY_MS);
  if (obs.stale && latest && mem.last_incident_candle_key !== latest.candle_key) {
    incidents.push(now);
    mem.last_incident_candle_key = latest.candle_key;
  }
  if (!latest && !mem.in_empty_episode) incidents.push(now);
  mem.in_empty_episode = !latest;
  mem.stale_incidents = incidents;
  await save();

  // Stale report
  if (obs.stale && latest) {
    if (mem.last_stale_candle_key !== latest.candle_key) {
      const minutesSinceClose = Math.round((now - (latest.candle_open_ms + 3_600_000)) / 60_000);
      const published = await publish("warning", `XAUUSD analysis stale: no decision since candle ${isoMs(latest.candle_open_ms)}`, {
        last_candle_key: latest.candle_key,
        last_decided_at: latest.decided_at,
        minutes_since_close: minutesSinceClose,
        source: obs.source,
        disclaimer: DISCLAIMER,
      });
      report.actions.push(published);
      if (published.outcome === "succeeded") {
        mem.last_stale_candle_key = latest.candle_key;
        await save();
      }
    }
  }
  if (!latest) {
    const last = mem.last_empty_report_at ?? 0;
    if (now - last >= DIGEST_INTERVAL_MS) {
      const published = await publish("warning", "XAUUSD decisions empty", { source: obs.source, disclaimer: DISCLAIMER });
      report.actions.push(published);
      if (published.outcome === "succeeded") {
        mem.last_empty_report_at = now;
        await save();
      }
    }
  }

  // The rolling window, and a warning per BUY<->SELL flip (once per flipped candle).
  const stored = await memory.get<WindowDecision[]>("xauusd_window");
  const firstWindow = !Array.isArray(stored);
  const { window, added } = mergeWindow(firstWindow ? [] : stored, recent, now);
  await memory.put("xauusd_window", window);
  if (firstWindow || mem.last_flip_open_ms === undefined) {
    // No flip history before the window existed: start at the newest candle seen (once one is seen).
    if (window.length > 0) {
      mem.last_flip_open_ms = Math.max(...window.map((w) => w.open_ms));
      await save();
    }
  } else {
    const flips = newFlips(window, added).filter((f) => f.at.open_ms > (mem.last_flip_open_ms ?? 0)).slice(-MAX_FLIP_WARNINGS_PER_CYCLE);
    for (const f of flips) {
      const key = `OANDA:XAUUSD:${f.at.tf}:${f.at.open_ms}`;
      const source = recent.find((d) => d.candle_key === key);
      const subject = `XAUUSD ${tfLabel(f.at.tf)} flip ${f.previous.decision} -> ${f.at.decision} (confidence ${f.at.confidence ?? "n/a"}) for candle ${isoMs(f.at.open_ms)}`;
      const published = await publish("warning", subject, {
        candle_key: key,
        decision: f.at.decision,
        previous_decision: f.previous.decision,
        previous_candle_key: `OANDA:XAUUSD:${f.previous.tf}:${f.previous.open_ms}`,
        confidence: f.at.confidence,
        decided_at: source?.decided_at ?? null,
        source: obs.source,
        disclaimer: DISCLAIMER,
      });
      report.actions.push(published);
      if (published.outcome !== "succeeded") break;
      mem.last_flip_open_ms = f.at.open_ms;
      await save();
      const reportId = String(((published.result.report as JsonObject | undefined)?.report_id) ?? "");
      await rememberOutcomeForAgent(env, SIGNAL_ANALYST_ID, "xauusd_digest", subject, reportId || null, report);
    }
  }

  // The metric snapshot: one sample per UTC hour, published on a material change or at the heartbeat.
  const latestW = latest ? toWindowDecision(latest) : null;
  const outcome = outcomeForSource(obs.outcome_summary, obs.endpoint_used);
  const values = organHealthValues(window, latestW, incidents, now, outcome);
  const store = await memory.get<SampleStore>("organ_health_samples");
  const samples = store && store.schema === SNAPSHOT_SCHEMA && Array.isArray(store.samples) ? store.samples : [];
  const metrics = withBaselines(values, samples, now, outcome);
  await memory.put("organ_health_samples", { schema: SNAPSHOT_SCHEMA, samples: recordSample(samples, values, now) });

  const stale = Boolean(obs.stale);
  const changed = snapshotChanges(mem.last_snapshot, metrics, stale);
  const reason = shouldPublishSnapshot(mem.last_snapshot, changed, now);
  if (reason) {
    const tf = latestW?.tf ?? window[window.length - 1]?.tf ?? 60;
    const subject = `Trading organ health (XAUUSD ${tfLabel(tf)}): ${values.decisions_24h} decisions in 24 h, ${values.flips_24h} flips, ${values.staleness_incidents_24h} staleness incidents`;
    const oldest = window.filter((w) => w.tf === tf)[0];
    const published = await publish("info", subject, {
      schema: SNAPSHOT_SCHEMA,
      organ: "xauusd-ai-trading-assistant",
      observed_at: isoMs(now),
      bar_minutes: tf,
      stale,
      publish_reason: reason,
      changed: reason === "change" ? changed : [],
      metrics: metrics as unknown as JsonObject[],
      window: {
        observe_limit: OBSERVE_LIMIT,
        decisions_held: window.filter((w) => w.tf === tf).length,
        oldest_candle_at: oldest ? isoMs(oldest.open_ms) : null,
      },
      // The newest decision's stance only (no reasoning, no ratio, no level), for the overview's xauusd_latest.
      latest: latest ? { candle_key: latest.candle_key, decision: latest.decision, confidence: latest.confidence, decided_at: latest.decided_at } : null,
      source: obs.source,
      disclaimer: DISCLAIMER,
    });
    report.actions.push(published);
    if (published.outcome === "succeeded") {
      mem.last_snapshot = { at: now, stale, values: Object.fromEntries(metrics.map((m) => [m.metric, m.status ? { value: m.value, z: m.z, status: m.status } : { value: m.value, z: m.z }])) };
      await save();
      const reportId = String(((published.result.report as JsonObject | undefined)?.report_id) ?? "");
      await rememberOutcomeForAgent(env, SIGNAL_ANALYST_ID, "xauusd_digest", subject, reportId || null, report);
    }
  }

  await memory.put("last_cycle", report);
  return report;
}
