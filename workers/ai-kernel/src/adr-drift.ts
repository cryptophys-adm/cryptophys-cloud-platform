/**
 * The ADR Steward's drift reports (docs/design/ADR-STEWARD.md §4.8, §11 row 7; owner 2026-11-16, Q12: drift findings are
 * `platform_digest` warnings, never critical, and not sent to Telegram; a documentation lag must never raise the
 * consensus brake).
 *
 * A drift is a phase whose manifest `doc_claim.state` disagrees with its computed state (doc_behind, doc_ahead), as the
 * Steward stored it in `adr_progress` (step 3; the same drift the panel shows, step 5). An EPISODE is one (ADR, phase,
 * kind) drift from the pass that opens it to the pass that closes it; step 3 audits both ends as `adr.drift_detected`
 * and `adr.drift_resolved`. This file publishes the episodes as reports, through the agent syscall path
 * (`reports.publish`, tier 1, policy-gated), as the Auditor and the Signal Analyst publish theirs:
 *  - an episode is reported once: a `platform_digest` WARNING with `body.schema = "adr_drift.v1"`, `body.state "open"`
 *    and `body.alert_key = adr_drift:<adr>:<phase>`, listing the phase, the file, the quote the manifest anchors and
 *    what the evidence shows, with the suggested fix (a change request that edits the document and the manifest's
 *    doc_claim together, §4.8.3);
 *  - when every episode a report listed has closed, a `Resolved:` INFO report with the same alert_key and
 *    `state "resolved"` closes it: the kernel's reports overview then counts it as resolved and stops listing it
 *    (syscall.ts resolvedLaterSql), as the deploy stall alarm and the break-glass notices are closed;
 *  - `reports.publish` allows 4 consumed calls an hour per agent (capabilities.ts). The Steward keeps the times of its
 *    own calls in its Durable Object, and when the episodes to open and the alerts to close need more calls than are
 *    left this hour, the new episodes go into ONE report (up to ADR_DRIFT_MAX_EPISODES), whose alert_key is
 *    adr_drift:batch:<12 hex of the sha256 of its episode keys>; it closes when all of them have. What is left waits
 *    for the next tick (`pending`), never for a new event;
 *  - the open alerts are read back from agent_reports (the Steward's own reports, newest first): the newest report of an
 *    alert_key decides whether it is open, so a restart or a lost Durable Object state reports nothing twice. An
 *    episode that closes and opens again while an alert still lists it (a batch whose other episodes are open) stays
 *    with that alert; once the alert is resolved, a new episode under the same key is a new warning.
 *
 * Never critical: an open critical report is the consensus brake (consensus.ts openCriticalReports). Never Telegram:
 * the owner notices read critical reports and named production problems only (owner-notices.ts OWNER_CHANNEL_TOPICS,
 * owner-inbox.ts), and the report relay forwards only an xauusd-hosted agent's `xauusd_digest` with a
 * `body.telegram_topic` (report-relay.ts); these reports are none of those. test/adr-drift-step7.test.ts proves both.
 */
import type { JsonObject } from "../../control-plane-shared/src/http.ts";
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { sha256Hex } from "../../control-plane-shared/src/audit.ts";
import { CAPABILITIES } from "../../control-plane-shared/src/capabilities.ts";
import { ADR_MANIFESTS, type BundledManifest } from "./adr-observe.ts";
import { syscall, type SyscallEnv, type SyscallResult } from "./syscall.ts";

/** The publishing agent: the ADR Steward (adr-steward.ts ADR_STEWARD_ID; not imported, which would be circular). */
export const ADR_DRIFT_AGENT = "adr-steward";
export const ADR_DRIFT_SCHEMA = "adr_drift.v1";
export const ADR_DRIFT_KIND = "platform_digest";
export const ADR_DRIFT_SOURCE = "adr_steward";
export const ADR_DRIFT_PREFIX = "adr_drift:";
export const ADR_DRIFT_BATCH_PREFIX = `${ADR_DRIFT_PREFIX}batch:`;
/** The two severities this file ever publishes: an episode opens as a warning, and closes as info. Never critical. */
export const ADR_DRIFT_SEVERITY = Object.freeze({ open: "warning", resolved: "info" } as const);
/** reports.publish's hourly limit per agent, as the Policy Engine applies it. */
export const ADR_DRIFT_PUBLISH_PER_HOUR: number = CAPABILITIES["reports.publish"].max_per_hour ?? 4;
/** Episodes in one report at most, so a body stays well under MAX_REPORT_BODY_BYTES (16 KiB). */
export const ADR_DRIFT_MAX_EPISODES = 12;
/** A body above this many bytes drops its last episodes into the next report. */
const BODY_BUDGET_BYTES = 14_000;
/** The Steward's own reports read back to find its open alerts, newest first. */
const READ_LIMIT = 200;
const HOUR_MS = 3_600_000;

export type DriftKind = "doc_behind" | "doc_ahead";

/** One open drift as stored, with what a fix needs (§4.8.3: the phase, the file, the quote and what the evidence shows). */
export interface DriftEpisode {
  /** adr_drift:<adr>:<phase> */
  key: string;
  adr: string;
  phase: string;
  title: string | null;
  kind: DriftKind;
  doc_ref: string;
  doc_state: string;
  doc_quote: string | null;
  computed_state: string;
  reason: string | null;
  refs: string[];
  manifest: string;
  suggestion: string;
}

/** An adr_drift alert whose newest report is an open warning. */
export interface OpenDriftAlert {
  report_id: string;
  alert_key: string;
  created_at: string;
  subject: string;
  episodes: { key: string; kind: string }[];
}

/** What the Durable Object keeps for the reports: the times of this agent's reports.publish calls, and work left over. */
export interface DriftReportState { calls: string[]; pending: boolean }
export const EMPTY_DRIFT_STATE: DriftReportState = Object.freeze({ calls: [], pending: false }) as DriftReportState;

export const episodeKey = (adr: string, phase: string) => `${ADR_DRIFT_PREFIX}${adr}:${phase}`;
const identity = (key: string, kind: string) => `${key}|${kind}`;
const clip = (s: unknown, n: number): string | null => (typeof s === "string" && s ? s.slice(0, n) : null);

/** The quote a manifest anchors for a phase's doc_claim, from the manifests of this deploy. */
function quoteOf(manifests: readonly BundledManifest[], adr: string, phase: string): string | null {
  const m = manifests.find((x) => x.adr === adr)?.manifest as { phases?: Array<{ id?: unknown; doc_claim?: { quote?: unknown } }> } | undefined;
  const ph = Array.isArray(m?.phases) ? m!.phases.find((p) => p?.id === phase) : undefined;
  return clip(ph?.doc_claim?.quote, 200);
}

/** The suggested fix, in plain English (the report is for operators, like every report but the panel's explanation). */
export function driftSuggestion(e: Pick<DriftEpisode, "adr" | "phase" | "kind" | "doc_ref" | "doc_state" | "doc_quote" | "computed_state" | "manifest">): string {
  const quoted = e.doc_quote ? `"${e.doc_quote}"` : `"${e.doc_state}"`;
  const what = e.kind === "doc_behind"
    ? `The evidence proves ${e.phase}, but ${e.doc_ref} still says ${quoted} (doc_claim ${e.doc_state}). Update the text to say what ran, and when.`
    : `${e.doc_ref} says ${quoted} (doc_claim done), but the evidence is ${e.computed_state}. Correct the text, or record the evidence.`;
  return `${what} Change the document and the doc_claim in ${e.manifest} in one change request (the CI quote check requires both).`.slice(0, 400);
}

interface StoredDoc { adr: string; phases: Array<{ id: string; title?: string; state?: string; reason?: string | null; doc_claim?: string | null; refs?: string[] }>; drift: Array<{ phase: string; kind: string; doc_ref: string; doc_state: string; computed_state: string; refs?: string[] }> }

/** The stored documents (adr_progress, the panel's source), by ADR id. */
async function storedDocs(db: D1Database): Promise<Map<string, StoredDoc>> {
  const rows = (await db.prepare("SELECT adr_id, body_json FROM adr_progress ORDER BY adr_id LIMIT 200").bind().all<{ adr_id: string; body_json: string }>()).results ?? [];
  const out = new Map<string, StoredDoc>();
  for (const r of rows) {
    try {
      const b = JSON.parse(r.body_json) as Partial<StoredDoc>;
      out.set(r.adr_id, { adr: r.adr_id, phases: Array.isArray(b.phases) ? b.phases : [], drift: Array.isArray(b.drift) ? b.drift : [] });
    } catch { /* an unreadable body has no drift to report */ }
  }
  return out;
}

/** Every drift episode the stored documents hold now, in ADR and phase order. */
export function episodesOf(docs: Map<string, StoredDoc>, manifests: readonly BundledManifest[] = ADR_MANIFESTS): DriftEpisode[] {
  const out: DriftEpisode[] = [];
  for (const doc of docs.values()) {
    for (const d of doc.drift) {
      if (!d || typeof d.phase !== "string" || (d.kind !== "doc_behind" && d.kind !== "doc_ahead")) continue;
      const ph = doc.phases.find((p) => p.id === d.phase);
      const base = {
        key: episodeKey(doc.adr, d.phase), adr: doc.adr, phase: d.phase, title: clip(ph?.title, 120), kind: d.kind as DriftKind,
        doc_ref: String(d.doc_ref ?? "").slice(0, 200), doc_state: String(d.doc_state ?? "").slice(0, 20), doc_quote: quoteOf(manifests, doc.adr, d.phase),
        computed_state: String(d.computed_state ?? "").slice(0, 30), reason: clip(ph?.reason, 200),
        refs: (Array.isArray(d.refs) ? d.refs : []).filter((r): r is string => typeof r === "string").slice(0, 3),
        manifest: manifests.find((m) => m.adr === doc.adr)?.file ?? `architecture/adr/progress/${doc.adr}.json`,
      };
      out.push({ ...base, suggestion: driftSuggestion(base) });
    }
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.kind < b.kind ? -1 : 1));
}

/**
 * The Steward's open drift alerts: of its own reports with an adr_drift: alert_key (newest first, by the
 * agent_reports_agent_created index), the newest report of each key decides; an open warning keeps it open, a
 * resolved report closes it (the convention of syscall.ts resolvedLaterSql).
 */
export async function openDriftAlerts(db: D1Database): Promise<OpenDriftAlert[]> {
  const rows = (await db.prepare(
    `SELECT report_id, severity, subject, created_at, body_json FROM agent_reports
     WHERE agent_id = ? AND substr(COALESCE(json_extract(body_json, '$.alert_key'), ''), 1, ?) = ?
     ORDER BY created_at DESC, rowid DESC LIMIT ${READ_LIMIT}`,
  ).bind(ADR_DRIFT_AGENT, ADR_DRIFT_PREFIX.length, ADR_DRIFT_PREFIX).all<{ report_id: string; severity: string; subject: string; created_at: string; body_json: string }>()).results ?? [];
  const seen = new Set<string>();
  const out: OpenDriftAlert[] = [];
  for (const r of rows) {
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(r.body_json); } catch { continue; }
    const key = String(body.alert_key ?? "");
    if (seen.has(key)) continue;
    seen.add(key);
    const resolved = body.state === "resolved" || String(r.subject).startsWith("Resolved:");
    if (resolved || r.severity !== ADR_DRIFT_SEVERITY.open) continue;
    const episodes = (Array.isArray(body.episodes) ? body.episodes : [])
      .filter((e): e is { key: string; kind: string } => !!e && typeof (e as { key?: unknown }).key === "string" && typeof (e as { kind?: unknown }).kind === "string")
      .map((e) => ({ key: e.key, kind: e.kind }));
    out.push({ report_id: r.report_id, alert_key: key, created_at: r.created_at, subject: r.subject, episodes });
  }
  return out.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

const KIND_WORDS: Record<DriftKind, string> = { doc_behind: "the document lags the evidence", doc_ahead: "the document claims more than the evidence" };

/** The report that opens one episode, or a batch of them (reports.publish input). A warning, never critical. */
export async function driftOpenReport(episodes: readonly DriftEpisode[], at: string): Promise<Record<string, unknown>> {
  const list = [...episodes];
  const alertKey = list.length === 1 ? list[0].key : `${ADR_DRIFT_BATCH_PREFIX}${(await sha256Hex(list.map((e) => identity(e.key, e.kind)).join("\n"))).slice(0, 12)}`;
  const e0 = list[0];
  const names = list.slice(0, 4).map((e) => `${e.adr} ${e.phase}`).join(", ") + (list.length > 4 ? ` and ${list.length - 4} more` : "");
  const subject = list.length === 1
    ? `ADR-${e0.adr} ${e0.phase}: ${KIND_WORDS[e0.kind]} (${e0.doc_ref} says ${e0.doc_state}, evidence ${e0.computed_state})`
    : `ADR drift: ${list.length} document claims disagree with the evidence (${names})`;
  return {
    kind: ADR_DRIFT_KIND, severity: ADR_DRIFT_SEVERITY.open, ai_status: "not_used", subject: subject.slice(0, 200),
    body: {
      schema: ADR_DRIFT_SCHEMA, source: ADR_DRIFT_SOURCE, alert_key: alertKey, state: "open",
      metric: "adr_drift_episodes", value: list.length, opened_at: at,
      episodes: list.map((e) => ({ ...e, link: `#/vision/adr/${e.adr}` })),
    },
  };
}

/** The report that closes an alert: info, "Resolved:", the same alert_key and state "resolved", with each episode now. */
export function driftResolvedReport(alert: OpenDriftAlert, docs: Map<string, StoredDoc>): Record<string, unknown> {
  const now = alert.episodes.map((e) => {
    const [, adr, phase] = e.key.slice(ADR_DRIFT_PREFIX.length).match(/^(\d{4}):(.+)$/) ?? [];
    const p = adr ? docs.get(adr)?.phases.find((x) => x.id === phase) : undefined;
    return { key: e.key, kind: e.kind, adr: adr ?? null, phase: phase ?? null, doc_state: p?.doc_claim ?? null, computed_state: p?.state ?? null };
  });
  const names = now.slice(0, 4).map((e) => (e.adr ? `${e.adr} ${e.phase}` : e.key)).join(", ") + (now.length > 4 ? ` and ${now.length - 4} more` : "");
  return {
    kind: ADR_DRIFT_KIND, severity: ADR_DRIFT_SEVERITY.resolved, ai_status: "not_used",
    subject: `Resolved: ADR drift ${names}: the document no longer disagrees with the evidence`.slice(0, 200),
    body: {
      schema: ADR_DRIFT_SCHEMA, source: ADR_DRIFT_SOURCE, alert_key: alert.alert_key, state: "resolved", resolution: "no_drift",
      opened_report_id: alert.report_id, opened_at: alert.created_at, episodes: now,
    },
  };
}

/** Split episodes into report-sized groups (at most ADR_DRIFT_MAX_EPISODES each, and under the body budget). */
async function chunk(episodes: readonly DriftEpisode[], at: string): Promise<DriftEpisode[][]> {
  const out: DriftEpisode[][] = [];
  let rest = [...episodes];
  while (rest.length) {
    let group = rest.slice(0, ADR_DRIFT_MAX_EPISODES);
    while (group.length > 1 && new TextEncoder().encode(JSON.stringify((await driftOpenReport(group, at)).body)).byteLength > BODY_BUDGET_BYTES) group = group.slice(0, -1);
    out.push(group);
    rest = rest.slice(group.length);
  }
  return out;
}

export interface DriftReconcile {
  /** The finding for the cycle report. */
  finding: JsonObject;
  /** Every reports.publish syscall made, as the cycle report records actions. */
  actions: SyscallResult[];
  state: DriftReportState;
}

/**
 * Publish what the stored drift calls for: a report for each episode no open alert lists, and a `Resolved:` report for
 * each open alert none of whose episodes is open any more. Within this hour's calls (`state.calls`, ADR_DRIFT_PUBLISH_PER_HOUR):
 * one report per episode when they all fit, otherwise the new episodes in one batch first and the closings with what
 * is left. Anything not published leaves `pending` set, and the Steward tries again on its next tick.
 */
export async function reconcileDriftReports(env: SyscallEnv, prior: DriftReportState | null | undefined, now: number): Promise<DriftReconcile> {
  const at = new Date(now).toISOString();
  const state: DriftReportState = { calls: (prior?.calls ?? []).filter((t) => Date.parse(t) > now - HOUR_MS), pending: false };
  const actions: SyscallResult[] = [];
  let docs: Map<string, StoredDoc>;
  let open: OpenDriftAlert[];
  try {
    docs = await storedDocs(env.DB);
    open = await openDriftAlerts(env.DB);
  } catch (err) {
    state.pending = true;
    return { finding: { kind: "adr_drift", outcome: "store_unavailable", why: String((err as Error)?.message ?? err).slice(0, 200) }, actions, state };
  }
  const episodes = episodesOf(docs);
  const current = new Set(episodes.map((e) => identity(e.key, e.kind)));
  const covered = new Set(open.flatMap((a) => a.episodes.map((e) => identity(e.key, e.kind))));
  const toOpen = episodes.filter((e) => !covered.has(identity(e.key, e.kind)));
  const toClose = open.filter((a) => !a.episodes.some((e) => current.has(identity(e.key, e.kind))));

  const budget = Math.max(0, ADR_DRIFT_PUBLISH_PER_HOUR - state.calls.length);
  const fits = toOpen.length + toClose.length <= budget;
  const opened: string[] = [];
  const resolved: string[] = [];
  let stopped: string | null = null;
  const publish = async (input: Record<string, unknown>): Promise<boolean> => {
    if (stopped) return false;
    if (state.calls.length >= ADR_DRIFT_PUBLISH_PER_HOUR) { stopped = "hourly_limit"; return false; }
    if (input.severity !== ADR_DRIFT_SEVERITY.open && input.severity !== ADR_DRIFT_SEVERITY.resolved) throw new Error("adr_drift_severity_not_allowed");
    const r = await syscall(env, ADR_DRIFT_AGENT, "reports.publish", input as JsonObject);
    actions.push(r);
    // A denial consumed nothing; a failure after the Policy Engine's allow may have consumed the decision.
    if (r.outcome !== "denied") state.calls.push(at);
    if (r.outcome === "succeeded") return true;
    stopped = `${r.outcome}: ${r.reason}`.slice(0, 200);
    return false;
  };
  const closeAll = async () => {
    for (const a of toClose) {
      if (opened.includes(a.alert_key)) continue; // reopened under the same key in this cycle: the newer report stands
      if (await publish(driftResolvedReport(a, docs))) resolved.push(a.alert_key);
    }
  };
  const groups = fits ? toOpen.map((e) => [e]) : await chunk(toOpen, at);
  if (fits) await closeAll();
  for (const g of groups) {
    const input = await driftOpenReport(g, at);
    if (await publish(input)) opened.push(String((input.body as JsonObject).alert_key));
  }
  if (!fits) await closeAll();

  const deferred = toOpen.length - groups.slice(0, opened.length).reduce((n, g) => n + g.length, 0) + (toClose.length - resolved.length - toClose.filter((a) => opened.includes(a.alert_key)).length);
  state.pending = deferred > 0;
  const outcome = !toOpen.length && !toClose.length ? "unchanged" : deferred > 0 ? (opened.length || resolved.length ? "partly_published" : "deferred") : "published";
  return {
    finding: {
      kind: "adr_drift", outcome, episodes: episodes.length, open_alerts: open.length, opened, resolved, deferred,
      batched: !fits && toOpen.length > 1, calls_this_hour: state.calls.length, ...(stopped ? { stopped } : {}),
    },
    actions, state,
  };
}
