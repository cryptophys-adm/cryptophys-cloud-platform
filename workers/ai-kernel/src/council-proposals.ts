// HAIC H1.5d (docs/design/HAIC-H0-H1.md §4.1; owner answer Q9 of 2026-11-16): agents propose councils when there is
// evidence for one; a proposal is an owner inbox item, and only the owner begins it. Deterministic: no AI call, a few
// bounded SELECTs once an hour, never a price. Three sources:
//   - an Observer finding cluster: 3 or more warning anomalies or early warnings of one metric on one Worker in 24 h
//     (observer_findings), proposed by the Observer's agent, platform-api;
//   - a KPI regression of the trading organ: in the Signal Analyst's newest trading_organ_health.v1 snapshot, a metric
//     with |z| >= 3, or a hit rate whose status changed since the snapshot before; proposed by signal-analyst;
//   - a census finding that persists: in the newest organism census and in every census before it for 24 h or more
//     (forge_organism_census); proposed by the auditor (governance).
// Dedup (§4.1): a proposal of the same topic (council.ts topicKey) is not made again for 7 days unless it brings
// evidence refs the last one did not have; and, narrower than the design, never while one of the same topic is still
// proposed, nor within 24 h of the last one. At most 3 proposals wait at once and 2 are made a UTC day. With the agents'
// kill switch on, nothing is proposed. Each proposal is audited as council.proposed by its Durable Object.
import { agentsEnabled } from "../../control-plane-shared/src/capabilities.ts";
import { isDuplicateProposal, topicKey } from "../../control-plane-shared/src/council.ts";
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import type { ProposalInput } from "./council.ts";
import type { CouncilStub } from "./kernel.ts";

export const PROPOSAL_LIMITS = {
  max_pending: 3,
  max_new_per_utc_day: 2,
  min_repropose_ms: 24 * 3_600_000,
  cluster_min: 3,
  cluster_window_ms: 24 * 3_600_000,
  z_threshold: 3,
  census_persist_ms: 24 * 3_600_000,
} as const;
export type Candidate = Omit<ProposalInput, "session_id">;

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const fmt = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : "—");
const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,80}$/;

export interface ObserverRow { finding_id: string; worker: string; metric: string; kind: string; value: number | null; baseline_7d: number | null; z: number | null; created_at: string }
/** Observer clusters: per Worker and metric, the warnings of the window; a cluster of cluster_min or more is a candidate. */
export function observerCandidates(rows: readonly ObserverRow[]): Candidate[] {
  const groups = new Map<string, ObserverRow[]>();
  for (const r of rows) {
    if (!SAFE_NAME.test(r.worker) || !SAFE_NAME.test(r.metric)) continue;
    const k = `${r.worker}\u0000${r.metric}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: Candidate[] = [];
  for (const g of groups.values()) {
    if (g.length < PROPOSAL_LIMITS.cluster_min) continue;
    const sorted = [...g].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const { worker, metric } = sorted[0];
    out.push({
      proposed_by: "agent:platform-api", trigger_kind: "finding",
      topic: `Repeated Observer warnings: ${metric} on ${worker}`.slice(0, 200),
      question: `The Observer keeps flagging ${metric} on ${worker} against its 7-day baseline. What causes it, and should anything change?`,
      refs: sorted.slice(0, 5).map((r) => `ev:platform/observer_finding/${r.finding_id}`),
      detail: `${g.length} warnings of ${metric} on ${worker} in 24 h; newest value ${fmt(sorted[0].value)}, baseline ${fmt(sorted[0].baseline_7d)}, z ${fmt(sorted[0].z)}.`,
    });
  }
  return out;
}

export interface SnapshotRow { report_id: string; created_at: string; body_json: string }
interface OrganMetric { metric: string; value: number | null; baseline_7d: number | null; z: number | null; status: string | null }
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Only the named numbers of a trading_organ_health.v1 body (as syscall.ts presentOrganHealth reads them): no text, no price. */
function organMetrics(bodyJson: string): OrganMetric[] {
  let body: any = {};
  try { body = JSON.parse(bodyJson); } catch { body = {}; }
  return (Array.isArray(body?.metrics) ? body.metrics : []).slice(0, 32)
    .filter((m: any) => m && typeof m.metric === "string" && /^[a-z0-9_]{1,40}$/.test(m.metric))
    .map((m: any) => ({ metric: m.metric, value: num(m.value), baseline_7d: num(m.baseline_7d), z: num(m.z), status: typeof m.status === "string" && /^[a-z_]{1,40}$/.test(m.status) ? m.status : null }));
}
/** KPI regressions in the newest trading_organ_health.v1 snapshot: |z| >= 3, or a hit rate's status changed. */
export function kpiCandidates(latest: SnapshotRow | null, previous: SnapshotRow | null): Candidate[] {
  if (!latest) return [];
  const now = { metrics: organMetrics(latest.body_json) };
  const before = previous ? { metrics: organMetrics(previous.body_json) } : null;
  const ref = `ev:platform/report/${latest.report_id}#metrics`;
  const out: Candidate[] = [];
  for (const m of now.metrics) {
    const prior = before?.metrics.find((x) => x.metric === m.metric);
    const zHit = typeof m.z === "number" && Math.abs(m.z) >= PROPOSAL_LIMITS.z_threshold;
    const statusChange = /^hit_rate_/.test(m.metric) && typeof m.status === "string" && typeof prior?.status === "string" && prior.status !== m.status;
    if (!zHit && !statusChange) continue;
    out.push({
      proposed_by: "agent:signal-analyst", trigger_kind: "kpi_regression",
      topic: `Trading organ KPI regression: ${m.metric}`,
      question: `The trading organ's ${m.metric} moved away from its usual range. What explains it, and should anything change? (Measured outcomes only: no price, no order.)`,
      refs: [ref],
      detail: zHit
        ? `${m.metric} is ${fmt(m.value)} against a 7-day baseline of ${fmt(m.baseline_7d)} (z ${fmt(m.z)}).`
        : `${m.metric}'s status changed from ${prior!.status} to ${m.status}.`,
    });
  }
  return out;
}

export interface CensusRow { main_sha: string; status: string; findings: string; taken_at: string }
/** Census findings present in the newest census and in every census before it for at least census_persist_ms. */
export function censusCandidates(rows: readonly CensusRow[], now: number): Candidate[] {
  const sorted = [...rows].sort((a, b) => (a.taken_at < b.taken_at ? 1 : -1));
  const parse = (r: CensusRow) => { try { const f = JSON.parse(r.findings); return Array.isArray(f) ? f : []; } catch { return []; } };
  const keyOf = (f: any) => (typeof f?.kind === "string" && typeof f?.subject === "string" ? `${f.kind} ${f.subject}` : null);
  if (!sorted.length) return [];
  const out: Candidate[] = [];
  for (const f of parse(sorted[0])) {
    const k = keyOf(f);
    if (!k || !/^[a-z_]{1,40} [A-Za-z0-9_.:-]{1,120}$/.test(k)) continue;
    let earliest = sorted[0];
    for (const r of sorted.slice(1)) { if (parse(r).some((x) => keyOf(x) === k)) earliest = r; else break; }
    if (now - Date.parse(earliest.taken_at) < PROPOSAL_LIMITS.census_persist_ms) continue;
    out.push({
      proposed_by: "agent:auditor", trigger_kind: "finding",
      topic: `Persistent census finding: ${k}`.slice(0, 200),
      question: `The organism census has reported "${k}" for more than a day. Should the DNA or the registry change, and who should do it?`,
      refs: [`ev:platform/census/${sorted[0].main_sha.slice(0, 12)}#findings`],
      detail: `Reported in every census since ${earliest.taken_at} (main ${earliest.main_sha.slice(0, 12)} to ${sorted[0].main_sha.slice(0, 12)}).`,
    });
  }
  return out;
}

export interface ProposalEnv { DB: D1Database; COUNCIL?: { idFromName(name: string): unknown; get(id: unknown): CouncilStub } }
export interface ProposalPass { proposed: string[]; skipped: { topic: string; reason: string }[]; reason?: string }

async function rows<T>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T[]> {
  try { return ((await db.prepare(sql).bind(...binds).all<T>()).results ?? []) as T[]; } catch (err) {
    if (/no such table|no such column/i.test(String((err as Error)?.message ?? err))) return [];
    throw err;
  }
}

/** The hourly pass: read the three sources, dedup, cap, and propose through each council's Durable Object. */
export async function proposeCouncils(env: ProposalEnv, now = Date.now()): Promise<ProposalPass> {
  const db = env.DB;
  if (!env.COUNCIL) return { proposed: [], skipped: [], reason: "no_council_binding" };
  if (!(await agentsEnabled(db))) return { proposed: [], skipped: [], reason: "agents_disabled" };
  const observer = await rows<ObserverRow>(db,
    `SELECT finding_id, worker, metric, kind, value, baseline_7d, z, created_at FROM observer_findings
     WHERE kind IN ('anomaly', 'early_warning') AND severity = 'warning' AND report_only = 0 AND created_at >= ? ORDER BY created_at DESC LIMIT 200`,
    iso(now - PROPOSAL_LIMITS.cluster_window_ms));
  const snaps = await rows<SnapshotRow>(db,
    "SELECT report_id, created_at, body_json FROM agent_reports WHERE agent_id = 'signal-analyst' AND kind = 'xauusd_digest' AND json_extract(body_json, '$.schema') = 'trading_organ_health.v1' ORDER BY created_at DESC, rowid DESC LIMIT 2");
  const census = await rows<CensusRow>(db, "SELECT main_sha, status, findings, taken_at FROM forge_organism_census ORDER BY taken_at DESC LIMIT 30");
  const candidates = [...kpiCandidates(snaps[0] ?? null, snaps[1] ?? null), ...observerCandidates(observer), ...censusCandidates(census, now)];
  if (!candidates.length) return { proposed: [], skipped: [] };

  const recent = (await rows<{ topic_key: string; evidence_refs_json: string | null; created_at: string; state: string; trigger_kind: string }>(db,
    "SELECT topic_key, evidence_refs_json, created_at, state, trigger_kind FROM councils WHERE topic_key IS NOT NULL AND created_at >= ? ORDER BY created_at DESC LIMIT 200",
    iso(now - 7 * 24 * HOUR))).map((r) => ({ key: r.topic_key, refs: (() => { try { const a = JSON.parse(r.evidence_refs_json ?? "[]"); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } })(), created_at: r.created_at, state: r.state, trigger_kind: r.trigger_kind }));
  let pending = (await rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM councils WHERE state = 'proposed'"))[0]?.n ?? 0;
  let today = (await rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM councils WHERE trigger_kind != 'owner' AND substr(created_at, 1, 10) = ?", iso(now).slice(0, 10)))[0]?.n ?? 0;

  const out: ProposalPass = { proposed: [], skipped: [] };
  for (const c of candidates) {
    const key = topicKey(c.topic, c.question);
    const same = recent.filter((r) => r.key === key);
    const skip = (reason: string) => out.skipped.push({ topic: c.topic, reason });
    if (same.some((r) => r.state === "proposed")) { skip("already_proposed"); continue; }
    if (same.some((r) => now - Date.parse(r.created_at) < PROPOSAL_LIMITS.min_repropose_ms)) { skip("proposed_within_24h"); continue; }
    if (isDuplicateProposal(key, c.refs, same, now)) { skip("no_new_evidence"); continue; }
    if (pending >= PROPOSAL_LIMITS.max_pending) { skip("pending_limit"); continue; }
    if (today >= PROPOSAL_LIMITS.max_new_per_utc_day) { skip("daily_limit"); continue; }
    const id = `cs_${crypto.randomUUID()}`;
    const r = await env.COUNCIL.get(env.COUNCIL.idFromName(id)).propose({ ...c, session_id: id }) as { ok: boolean; code?: string };
    if (!r?.ok) { skip(r?.code ?? "refused"); continue; }
    out.proposed.push(id);
    pending += 1; today += 1;
    recent.push({ key, refs: c.refs, created_at: iso(now), state: "proposed", trigger_kind: c.trigger_kind });
  }
  return out;
}
