// Incidents on the Owner page (owner 2026-11-19, "kita perlu incident report di halaman owner" / "ya, buatkan setelah tiga
// perbaikan masuk"). Read only: every incident and its timeline are derived from records that already exist; nothing
// here writes D1, and nothing is typed by a person except the post-incident summary (incident-summaries.ts, a merge).
//
// An incident opens on
//   - a critical agent report (incident inc_<report_id>; a deploy report carries its request_id), or
//   - a native deploy that failed without restoring every Worker (deployment_requests status failed, outcome restored
//     false) that no critical report names (incident inc_<request_id>).
// Its timeline joins, in time order: the deploy request and its outcome (reason, D1 migrations applied, Workers not
// restored, Durable Object migrations), the report, its acknowledgement, every deploy of the unit refused on every path
// (audit deployment.no_path), recovery plans for the unit's Workers and how they ended, the first later deploy of the
// unit that succeeded, and the drift of the unit's Workers since.
//   - a production problem no agent is handling (owner 2026-11-19, "Incidents dari masalah produksi"): each item of the
//     production_unhandled notice events (owner-notices.ts keeps `items` in their payload) is an episode from the event
//     that first lists it to the event that no longer does. An episode about a Worker of an open (or not yet resolved)
//     deploy incident joins that incident's timeline; any other one is its own incident (inc_p:<code>:<subject>@<opened>),
//     open while listed, resolved once a later notice event no longer lists it. break_glass_deployed is a notice, not an
//     incident: it only joins a deploy incident's timeline.
// Status is derived, never typed:
//   resolved   a later deploy of the unit succeeded and the latest drift observation of each Worker of the unit, taken
//              after it, is clean (a report without a deploy: a later "Resolved: <subject>" report);
//   mitigated  not resolved, and the report was acknowledged (a request without a report: never; it stays open);
//   open       otherwise.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { unitForService } from "../../control-plane-shared/src/deploy-units.ts";
import { serviceName } from "../../control-plane-shared/src/plain.ts";
import { INCIDENT_SUMMARIES, type IncidentSummary } from "./incident-summaries.ts";

export const INCIDENT_WINDOW_MS = 30 * 86_400_000;
export const INCIDENT_LIMIT = 20;
const TIMELINE_LIMIT = 40;

export type IncidentStatus = "open" | "mitigated" | "resolved";
export interface IncidentEvent { at: string; kind: string; text: string; ref?: string }
export interface Incident {
  incident_id: string;
  title: string;
  status: IncidentStatus;
  status_reason: string;
  opened_at: string;
  mitigated_at: string | null;
  resolved_at: string | null;
  unit: string | null;
  services: string[];
  commit: string | null;
  report_id: string | null;
  request_id: string | null;
  timeline: IncidentEvent[];
  summary: IncidentSummary | null;
}
export interface IncidentsView { schema: "incidents.v1"; observed_at: string; window_days: number; incidents: Incident[] }

const iso = (ms: number) => new Date(ms).toISOString();
const short = (sha: string | null | undefined) => (typeof sha === "string" ? sha.slice(0, 12) : "unknown");
const clip = (v: unknown, n = 160) => (typeof v === "string" ? v.slice(0, n) : "");
const parse = (v: string | null | undefined): Record<string, any> => { try { const o = JSON.parse(v ?? "{}"); return o && typeof o === "object" ? o : {}; } catch { return {}; } };
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 80)) : []);

interface ReportRow { report_id: string; agent_id: string; subject: string; body_json: string | null; created_at: string }
interface RequestRow { request_id: string; service_id: string; requested_version: string; status: string; details_json: string | null; created_at: string; updated_at: string | null }

async function rows<T>(db: D1Database, sql: string, ...bind: unknown[]): Promise<T[]> {
  try { return ((await db.prepare(sql).bind(...bind).all<T>()).results ?? []) as T[]; } catch { return []; }
}

function requestEvents(r: RequestRow): IncidentEvent[] {
  const d = parse(r.details_json);
  const o = d.outcome && typeof d.outcome === "object" ? d.outcome : {};
  const how = typeof d.executor === "string" ? d.executor : typeof d.workflow === "string" ? d.workflow : "deploy";
  const unit = unitForService(r.service_id)?.unit ?? serviceName(r.service_id);
  const out: IncidentEvent[] = [{ at: r.created_at, kind: "deploy_requested", text: `Deploy of ${unit} at ${short(r.requested_version)} requested (${clip(how, 40)})`, ref: r.request_id }];
  if (r.status === "failed" || r.status === "succeeded") {
    const parts: string[] = [];
    if (r.status === "failed") parts.push(`failed: ${clip(o.reason, 120) || "reason not recorded"}`);
    else parts.push("succeeded");
    const applied = list(o.migrations_applied);
    if (applied.length) parts.push(`D1 migrations applied: ${applied.join(", ")}`);
    const dom = list(o.do_migrations);
    if (dom.length) parts.push(`Durable Object migrations: ${dom.join(", ")}`);
    const nr = list(o.not_restored);
    if (nr.length) parts.push(`not restored: ${nr.map(serviceName).join(", ")}`);
    else if (r.status === "failed" && o.restored === true) parts.push("every changed Worker restored");
    out.push({ at: r.updated_at ?? r.created_at, kind: r.status === "failed" ? "deploy_failed" : "deploy_succeeded", text: `Deploy of ${unit} at ${short(r.requested_version)} ${parts.join("; ")}`.slice(0, 600), ref: r.request_id });
  }
  return out;
}

async function deployIncident(db: D1Database, id: string, req: RequestRow, report: ReportRow | null, now: number): Promise<Incident> {
  const unit = unitForService(req.service_id);
  const services = unit ? [...unit.services] as string[] : [req.service_id];
  const marks = services.map(() => "?").join(", ");
  const opened = report && report.created_at < req.created_at ? report.created_at : req.created_at;
  const timeline: IncidentEvent[] = [...requestEvents(req)];
  let ack: { acknowledged_by: string; reason: string; acknowledged_at: string } | null = null;
  if (report) {
    timeline.push({ at: report.created_at, kind: "report", text: `Critical report: ${clip(report.subject, 200)}`, ref: report.report_id });
    ack = (await rows<{ acknowledged_by: string; reason: string; acknowledged_at: string }>(db,
      "SELECT acknowledged_by, reason, acknowledged_at FROM agent_report_acknowledgements WHERE report_id = ?", report.report_id))[0] ?? null;
    if (ack) timeline.push({ at: ack.acknowledged_at, kind: "acknowledged", text: `Acknowledged by an approver: ${clip(ack.reason, 200)}`, ref: report.report_id });
  }
  // Every deploy of the unit refused on every path since (deploy_no_path).
  for (const e of await rows<{ subject: string; created_at: string; payload_json: string | null }>(db,
    `SELECT subject, created_at, payload_json FROM audit_events WHERE event_type = 'deployment.no_path' AND created_at > ? AND subject IN (${marks}) ORDER BY created_at LIMIT 12`, opened, ...services)) {
    const p = parse(e.payload_json);
    timeline.push({ at: e.created_at, kind: "no_path", text: `Deploy of ${short(p.commit_sha)} refused on every path: native ${clip(p.native_deploy?.reason, 60) || "not recorded"}, GitHub ${clip(p.github_gate, 60) || "not recorded"}` });
  }
  // Recovery plans for the unit's Workers since, with how they ended.
  for (const p of await rows<{ plan_id: string; service_id: string; status: string; created_at: string; updated_at: string | null; last_execution_json: string | null }>(db,
    `SELECT plan_id, service_id, status, created_at, updated_at, last_execution_json FROM recovery_plans WHERE created_at > ? AND service_id IN (${marks}) ORDER BY created_at LIMIT 8`, opened, ...services)) {
    const ex = parse(p.last_execution_json);
    const detail = clip(ex.failed_stage?.detail, 160);
    timeline.push({ at: p.created_at, kind: "recovery_plan", text: `Recovery plan for ${serviceName(p.service_id)}: ${p.status}${detail ? ` (${detail})` : ""}`, ref: p.plan_id });
  }
  // Later deploys of the unit: refusals are above; the first success heals it.
  const later = await rows<RequestRow>(db,
    `SELECT request_id, service_id, requested_version, status, details_json, created_at, updated_at FROM deployment_requests
      WHERE created_at > ? AND service_id IN (${marks}) AND status IN ('succeeded', 'failed') ORDER BY created_at LIMIT 10`, req.created_at, ...services);
  const healing = later.find((r) => r.status === "succeeded") ?? null;
  for (const r of later) {
    if (healing && r.created_at > healing.created_at) break;
    timeline.push(...requestEvents(r).filter((e) => e.kind !== "deploy_requested"));
  }
  // Drift of the unit's Workers: the latest observation of each.
  let clean = Boolean(healing);
  let cleanSince = "";
  for (const s of services) {
    const last = (await rows<{ drifted: number; observed_at: string }>(db, "SELECT drifted, observed_at FROM drift_observations WHERE service_id = ? ORDER BY observed_at DESC LIMIT 1", s))[0];
    const healedAt = healing ? (healing.updated_at ?? healing.created_at) : "";
    if (!last || last.drifted || (healing && last.observed_at < healedAt)) clean = false;
    else if (last.observed_at > cleanSince) cleanSince = last.observed_at;
  }
  const resolved = clean && healing ? (cleanSince > (healing.updated_at ?? healing.created_at) ? cleanSince : healing.updated_at ?? healing.created_at) : null;
  if (resolved) timeline.push({ at: resolved, kind: "drift_clear", text: `No drift on the ${services.length} Worker(s) of ${unit?.unit ?? serviceName(req.service_id)}` });
  const status: IncidentStatus = resolved ? "resolved" : ack ? "mitigated" : "open";
  const reason = resolved ? `a later deploy of the unit succeeded (${short(healing!.requested_version)}) and its Workers show no drift`
    : ack ? (healing ? "acknowledged; a later deploy succeeded, but a Worker of the unit still shows drift" : "acknowledged; no later deploy of the unit has succeeded yet")
    : "not acknowledged";
  timeline.sort((a, b) => a.at.localeCompare(b.at));
  return {
    incident_id: id, title: report ? clip(report.subject, 200) : `Deploy of ${unit?.unit ?? serviceName(req.service_id)} at ${short(req.requested_version)} failed without a full restore`,
    status, status_reason: reason, opened_at: opened, mitigated_at: ack?.acknowledged_at ?? null, resolved_at: resolved,
    unit: unit?.unit ?? null, services, commit: req.requested_version, report_id: report?.report_id ?? null, request_id: req.request_id,
    timeline: timeline.slice(0, TIMELINE_LIMIT), summary: INCIDENT_SUMMARIES[id] ?? null,
  };
}

async function reportIncident(db: D1Database, id: string, report: ReportRow): Promise<Incident> {
  const timeline: IncidentEvent[] = [{ at: report.created_at, kind: "report", text: `Critical report: ${clip(report.subject, 200)}`, ref: report.report_id }];
  const ack = (await rows<{ reason: string; acknowledged_at: string }>(db, "SELECT reason, acknowledged_at FROM agent_report_acknowledgements WHERE report_id = ?", report.report_id))[0] ?? null;
  if (ack) timeline.push({ at: ack.acknowledged_at, kind: "acknowledged", text: `Acknowledged by an approver: ${clip(ack.reason, 200)}`, ref: report.report_id });
  const done = (await rows<{ report_id: string; created_at: string }>(db,
    "SELECT report_id, created_at FROM agent_reports WHERE subject = ? AND created_at > ? ORDER BY created_at LIMIT 1", `Resolved: ${report.subject}`.slice(0, 300), report.created_at))[0] ?? null;
  if (done) timeline.push({ at: done.created_at, kind: "resolved_report", text: `Resolved report: ${clip(report.subject, 180)}`, ref: done.report_id });
  // An out-of-band report (deployment-orchestrator, body.out_of_band, alert_key out_of_band:<worker>:<version>) is resolved
  // when the Orchestrator later records that the same Worker no longer runs that version (deployment.out_of_band_cleared,
  // payload.was_version_id): nobody writes a "Resolved:" report for it (2026-11-22: the kernel's upload of 21 Nov was
  // restored at 22:40 that day and still showed as mitigated).
  const body = parse(report.body_json);
  const oob = body.out_of_band === true && typeof body.alert_key === "string" ? /^out_of_band:([a-z0-9-]+):([0-9a-f-]{8,})$/.exec(body.alert_key) : null;
  const cleared = !done && oob ? (await rows<{ created_at: string; payload_json: string | null }>(db,
    "SELECT created_at, payload_json FROM audit_events WHERE event_type = 'deployment.out_of_band_cleared' AND subject = ? AND created_at > ? ORDER BY created_at LIMIT 20", oob[1], report.created_at))
    .find((e) => String(parse(e.payload_json).was_version_id ?? "").startsWith(oob[2])) ?? null : null;
  if (cleared) {
    const p = parse(cleared.payload_json);
    timeline.push({ at: cleared.created_at, kind: "out_of_band_cleared", text: `${serviceName(oob![1])} runs a platform version again${p.tag ? ` (${clip(p.tag, 40)})` : ""}` });
  }
  const resolvedAt = done?.created_at ?? cleared?.created_at ?? null;
  return {
    incident_id: id, title: clip(report.subject, 200), status: resolvedAt ? "resolved" : ack ? "mitigated" : "open",
    status_reason: done ? "the reporting agent reported it resolved" : cleared ? "the Worker runs a platform version again (out-of-band cleared)" : ack ? "acknowledged; not reported resolved yet" : "not acknowledged",
    opened_at: report.created_at, mitigated_at: ack?.acknowledged_at ?? null, resolved_at: resolvedAt,
    unit: null, services: [], commit: null, report_id: report.report_id, request_id: null, timeline, summary: INCIDENT_SUMMARIES[id] ?? null,
  };
}

interface ProblemEpisode { key: string; code: string; subject: string; detail: string; opened_at: string; resolved_at: string | null }
const NOTICE_EVENTS = "('owner.notice_opened', 'owner.notice_changed', 'owner.notice_closed')";
/** Not incidents of their own: notices that only say something happened (a break-glass deploy succeeded). */
const NOT_AN_INCIDENT: ReadonlySet<string> = new Set(["break_glass_deployed"]);

/** Episodes of each production problem, from the production_unhandled notice events that carry `items`. */
async function problemEpisodes(db: D1Database, since: string, now: number): Promise<ProblemEpisode[]> {
  const events = await rows<{ created_at: string; payload_json: string | null }>(db,
    `SELECT created_at, payload_json FROM audit_events WHERE event_type IN ${NOTICE_EVENTS} AND subject = 'production_unhandled' AND created_at >= ? AND created_at <= ?
      ORDER BY created_at, rowid LIMIT 500`, since, iso(now));
  const open = new Map<string, ProblemEpisode>();
  const done: ProblemEpisode[] = [];
  for (const e of events) {
    const items = parse(e.payload_json).items;
    if (!Array.isArray(items)) continue; // an event written before items were kept says nothing per problem
    const present = new Set<string>();
    for (const it of items) {
      if (!it || typeof it.key !== "string" || typeof it.code !== "string") continue;
      present.add(it.key);
      const cur = open.get(it.key);
      if (cur) { cur.detail = clip(it.detail, 300) || cur.detail; continue; }
      const sinceAt = typeof it.since === "string" && it.since <= e.created_at && it.since >= since ? it.since : e.created_at;
      open.set(it.key, { key: it.key, code: it.code.slice(0, 60), subject: clip(it.subject, 160), detail: clip(it.detail, 300), opened_at: sinceAt, resolved_at: null });
    }
    for (const [k, ep] of open) if (!present.has(k)) { ep.resolved_at = e.created_at; done.push(ep); open.delete(k); }
  }
  return [...done, ...open.values()];
}

function problemIncident(ep: ProblemEpisode): Incident {
  const unit = ep.subject.startsWith("cryptophys-") ? unitForService(ep.subject) : null;
  const timeline: IncidentEvent[] = [{ at: ep.opened_at, kind: "problem", text: `Production problem (${ep.code}): ${ep.detail}`.slice(0, 600) }];
  if (ep.resolved_at) timeline.push({ at: ep.resolved_at, kind: "problem_cleared", text: `No longer listed as a production problem (${ep.code})` });
  return {
    incident_id: `inc_p:${ep.key}@${ep.opened_at}`.slice(0, 260), title: ep.detail || `${ep.code}: ${ep.subject}`,
    status: ep.resolved_at ? "resolved" : "open",
    status_reason: ep.resolved_at ? "no longer listed as a production problem" : "listed as a production problem no agent is handling",
    opened_at: ep.opened_at, mitigated_at: null, resolved_at: ep.resolved_at, unit: unit?.unit ?? null,
    services: unit ? [ep.subject] : [], commit: null, report_id: null, request_id: null, timeline, summary: null,
  };
}

/** The incidents of the last INCIDENT_WINDOW_MS, newest first. */
export async function listIncidents(db: D1Database, now = Date.now()): Promise<IncidentsView> {
  const since = iso(now - INCIDENT_WINDOW_MS);
  const reports = await rows<ReportRow>(db,
    "SELECT report_id, agent_id, subject, body_json, created_at FROM agent_reports WHERE severity = 'critical' AND created_at >= ? AND created_at <= ? ORDER BY created_at DESC LIMIT ?",
    since, iso(now), INCIDENT_LIMIT);
  const failed = await rows<RequestRow>(db,
    `SELECT request_id, service_id, requested_version, status, details_json, created_at, updated_at FROM deployment_requests
      WHERE status = 'failed' AND created_at >= ? AND json_extract(details_json, '$.outcome.restored') = 0 ORDER BY created_at DESC LIMIT ?`, since, INCIDENT_LIMIT);
  const incidents: Incident[] = [];
  const covered = new Set<string>();
  for (const r of reports) {
    const body = parse(r.body_json);
    const rid = typeof body.request_id === "string" && /^dep_[0-9a-f-]{36}$/.test(body.request_id) ? body.request_id : null;
    const req = rid ? (await rows<RequestRow>(db, "SELECT request_id, service_id, requested_version, status, details_json, created_at, updated_at FROM deployment_requests WHERE request_id = ?", rid))[0] : undefined;
    if (req) {
      covered.add(req.request_id);
      incidents.push(await deployIncident(db, `inc_${r.report_id}`, req, r, now));
    } else {
      incidents.push(await reportIncident(db, `inc_${r.report_id}`, r));
    }
  }
  for (const f of failed) if (!covered.has(f.request_id)) incidents.push(await deployIncident(db, `inc_${f.request_id}`, f, null, now));
  // Production problems: joined to the deploy incident of their Worker while it is unresolved, else their own incident.
  for (const ep of await problemEpisodes(db, since, now)) {
    const host = incidents.find((i) => i.request_id && i.services.includes(ep.subject) && ep.opened_at >= i.opened_at && (!i.resolved_at || ep.opened_at <= i.resolved_at));
    if (host) {
      host.timeline.push(...problemIncident(ep).timeline);
      host.timeline.sort((a, b) => a.at.localeCompare(b.at));
      host.timeline = host.timeline.slice(0, TIMELINE_LIMIT);
    } else if (!NOT_AN_INCIDENT.has(ep.code)) {
      incidents.push(problemIncident(ep));
    }
  }
  incidents.sort((a, b) => b.opened_at.localeCompare(a.opened_at));
  return { schema: "incidents.v1", observed_at: iso(now), window_days: INCIDENT_WINDOW_MS / 86_400_000, incidents: incidents.slice(0, INCIDENT_LIMIT) };
}
