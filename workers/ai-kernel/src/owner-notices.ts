// ADR-0012 phase 2: owner notifications without GitHub. These replace the scheduled
// owner-attention.yml and drift-alert.yml workflows, which kept GitHub issues open and closed.
//
// Three topics are computed from D1:
//   owner_attention  - recovery plans in draft and critical proposals in pending_owner (a click is needed);
//   drift            - a service drifted, unhealthy, never observed, or not observed for 45 minutes;
//   critical_reports - an agent published a critical report in the last 24 hours.
// Every scheduled run (:22 and :52) compares each topic with its last notice event in the audit
// chain. It records owner.notice_opened, owner.notice_changed or owner.notice_closed, so the state
// needs no table of its own. When the send_email binding OWNER_EMAIL and the var NOTIFY_FROM are
// configured, it also emails the owners (the people in APPROVER_IDENTITIES). The Console shows
// the live notices at GET /v1/notices.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent, sha256Hex } from "../../control-plane-shared/src/audit.ts";
import { describeAction, explainReason, serviceName } from "../../control-plane-shared/src/plain.ts";

export const CONSOLE_URL = "https://nexus.cryptophys.work/console/";
export const TOPICS = ["owner_attention", "drift", "critical_reports"] as const;
export type Topic = (typeof TOPICS)[number];
/** Observations older than this (45 min, three missed Drift Detector runs) count as stale. */
export const STALE_MS = 45 * 60_000;

export interface Notice {
  topic: Topic;
  active: boolean;
  fingerprint: string;
  title: string;
  lines: string[];
  link: string;
}

export interface SendEmailBinding {
  send(message: { to: string | string[]; from: string; subject: string; text: string }): Promise<unknown>;
}
export interface NoticeEnv {
  DB: D1Database;
  APPROVER_IDENTITIES?: string;
  OWNER_EMAIL?: SendEmailBinding;
  NOTIFY_FROM?: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const fp = async (parts: string[]) => (parts.length ? (await sha256Hex([...parts].sort().join("\n"))).slice(0, 32) : "");

async function ownerAttention(db: D1Database): Promise<Notice> {
  const plans = await db.prepare("SELECT plan_id, service_id, created_by FROM recovery_plans WHERE status = 'draft' ORDER BY created_at LIMIT 50")
    .all<{ plan_id: string; service_id: string; created_by: string }>();
  const critical = await db.prepare("SELECT proposal_id, action, target, proposer_agent_id FROM consensus_proposals WHERE status = 'pending_owner' ORDER BY created_at LIMIT 50")
    .all<{ proposal_id: string; action: string; target: string; proposer_agent_id: string }>();
  const lines = [
    ...plans.results.map((p) => `Recovery plan for ${serviceName(p.service_id)} (by ${p.created_by}): review at ${CONSOLE_URL}#/recovery/${p.plan_id}`),
    ...critical.results.map((c) => `Critical action: ${describeAction(c.action, c.target)} (proposed by ${c.proposer_agent_id}): decide at ${CONSOLE_URL}#/consensus`),
  ];
  const n = lines.length;
  return {
    topic: "owner_attention", active: n > 0,
    fingerprint: await fp([...plans.results.map((p) => p.plan_id), ...critical.results.map((c) => c.proposal_id)]),
    title: n ? `${n} item(s) wait for your approval` : "Nothing waits for your approval",
    lines, link: `${CONSOLE_URL}#/`,
  };
}

async function drift(db: D1Database, now: number): Promise<Notice> {
  const services = await db.prepare("SELECT service_id, desired_version FROM service_registry WHERE status != 'disabled' ORDER BY service_id")
    .all<{ service_id: string; desired_version: string | null }>();
  const latest = await db.prepare(
    `SELECT d.service_id, d.drifted, d.evidence_json, d.observed_at FROM drift_observations d
     JOIN (SELECT service_id, MAX(observed_at) AS m FROM drift_observations GROUP BY service_id) x
       ON x.service_id = d.service_id AND x.m = d.observed_at`,
  ).all<{ service_id: string; drifted: number; evidence_json: string; observed_at: string }>();
  const byService = new Map(latest.results.map((r) => [r.service_id, r]));
  const problems: { service: string; code: string; line: string }[] = [];
  for (const s of services.results) {
    const o = byService.get(s.service_id);
    if (!o) { problems.push({ service: s.service_id, code: "no_observation", line: `${serviceName(s.service_id)}: never observed by the Drift Detector` }); continue; }
    let ev: { reasons?: unknown; desired_version?: unknown; probe?: { version_tag?: unknown } } = {};
    try { ev = JSON.parse(o.evidence_json || "{}"); } catch { ev = {}; }
    const reasons = Array.isArray(ev.reasons) ? ev.reasons.filter((r): r is string => typeof r === "string") : [];
    if (reasons.includes("disabled")) continue;
    const observedAt = Date.parse(o.observed_at);
    if (!Number.isFinite(observedAt) || observedAt > now) {
      problems.push({ service: s.service_id, code: "invalid_observation_time", line: `${serviceName(s.service_id)}: invalid observation timestamp ${o.observed_at}` });
    } else if (now - observedAt > STALE_MS) {
      problems.push({ service: s.service_id, code: "stale_observation", line: `${serviceName(s.service_id)}: not observed since ${o.observed_at} (check the Drift Detector cron)` });
    } else if (o.drifted) {
      const running = typeof ev.probe?.version_tag === "string" ? ev.probe.version_tag : "unknown";
      problems.push({ service: s.service_id, code: reasons.join(",") || "drifted",
        line: `${serviceName(s.service_id)}: ${explainReason(reasons.join(", ")) || "drifted"} (expected ${s.desired_version ?? "unset"}, running ${running})` });
    }
  }
  return {
    topic: "drift", active: problems.length > 0,
    fingerprint: await fp(problems.map((p) => `${p.service}:${p.code}:${p.line}`)),
    title: problems.length ? `Drift in production: ${problems.length} service(s)` : "All services are healthy and at their expected versions",
    lines: problems.map((p) => p.line), link: `${CONSOLE_URL}#/infrastructure`,
  };
}

async function criticalReports(db: D1Database, now: number): Promise<Notice> {
  const since = iso(now - 24 * 3_600_000);
  const rows = await db.prepare("SELECT report_id, agent_id, kind, subject, created_at FROM agent_reports WHERE severity = 'critical' AND created_at >= ? AND created_at <= ? ORDER BY created_at DESC LIMIT 200")
    .bind(since, iso(now)).all<{ report_id: string; agent_id: string; kind: string; subject: string; created_at: string }>();
  const n = rows.results.length;
  return {
    topic: "critical_reports", active: n > 0,
    fingerprint: await fp(rows.results.map((r) => r.report_id)),
    title: n ? `${n} critical agent report(s) in the last 24 hours` : "No critical agent report in the last 24 hours",
    lines: rows.results.slice(0, 5).map((r) => `${r.created_at} ${r.agent_id}: ${r.subject.slice(0, 160)}`),
    link: `${CONSOLE_URL}#/agents`,
  };
}

/** The live notices, for the Console and for reconcileNotices. Read-only. */
export async function collectNotices(db: D1Database, now = Date.now()): Promise<Notice[]> {
  return [await ownerAttention(db), await drift(db, now), await criticalReports(db, now)];
}

const owners = (env: NoticeEnv) => (env.APPROVER_IDENTITIES ?? "").split(",").map((v) => v.trim().toLowerCase()).filter((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v));

export function emailConfigured(env: NoticeEnv): boolean {
  return Boolean(env.OWNER_EMAIL && env.NOTIFY_FROM && owners(env).length);
}

async function deliver(env: NoticeEnv, change: "opened" | "changed" | "closed", n: Notice): Promise<string> {
  if (!emailConfigured(env)) return "not_configured";
  const subject = `[Cryptophys] ${change === "closed" ? "Resolved: " : ""}${n.title}`;
  const text = [
    change === "closed" ? "This is resolved; nothing more is needed." : n.title + ".",
    "",
    ...n.lines.map((l) => `- ${l}`),
    "",
    `Open the Cerebrum Console: ${n.link}`,
    "",
    "Sent by the Cryptophys AI Kernel (ADR-0012). Advisory only; no trading.",
  ].join("\n");
  try {
    await env.OWNER_EMAIL!.send({ to: owners(env), from: env.NOTIFY_FROM!, subject: subject.slice(0, 200), text: text.slice(0, 8000) });
    return "sent";
  } catch (err) {
    return `failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`;
  }
}

/** The last notice event per topic: open with its fingerprint, or closed. */
async function lastState(db: D1Database, topic: Topic): Promise<{ open: boolean; fingerprint: string; delivery: string; eventType: string }> {
  const row = await db.prepare("SELECT event_type, payload_json FROM audit_events WHERE event_type IN ('owner.notice_opened','owner.notice_changed','owner.notice_closed','owner.notice_delivery_retry') AND subject = ? ORDER BY rowid DESC LIMIT 1")
    .bind(topic).first<{ event_type: string; payload_json: string }>();
  if (!row) return { open: false, fingerprint: "", delivery: "unknown", eventType: "" };
  let p: { fingerprint?: unknown; delivery?: unknown; state?: unknown } = {};
  try { p = JSON.parse(row.payload_json); } catch { p = {}; }
  const open = row.event_type === "owner.notice_closed" ? false : row.event_type === "owner.notice_delivery_retry" ? p.state !== "closed" : true;
  return {
    open,
    fingerprint: typeof p.fingerprint === "string" ? p.fingerprint : "",
    delivery: typeof p.delivery === "string" ? p.delivery : "unknown",
    eventType: row.event_type,
  };
}

/** Open, update or close each topic's notice (idempotent; at most one event per topic per run). */
export async function reconcileNotices(env: NoticeEnv, now = Date.now()): Promise<{ topic: Topic; change: string; delivery?: string }[]> {
  const out: { topic: Topic; change: string; delivery?: string }[] = [];
  for (const n of await collectNotices(env.DB, now)) {
    const last = await lastState(env.DB, n.topic);
    const change = n.active && !last.open ? "opened" : n.active && last.fingerprint !== n.fingerprint ? "changed" : !n.active && last.open ? "closed" : null;
    if (!change) {
      const retryChange = emailConfigured(env) && last.delivery !== "sent"
        && ((n.active && last.open && last.fingerprint === n.fingerprint) || (!n.active && !last.open && last.eventType === "owner.notice_closed"))
        ? (n.active ? "opened" : "closed") : null;
      if (!retryChange) { out.push({ topic: n.topic, change: "unchanged" }); continue; }
      const delivery = await deliver(env, retryChange, n);
      await appendAuditEvent(env.DB, {
        event_type: "owner.notice_delivery_retry", actor: "agent:supervisor", subject: n.topic, outcome: "delivery_retry",
        payload: { fingerprint: n.active ? n.fingerprint : "", state: n.active ? "open" : "closed", count: n.lines.length, title: n.title, delivery },
      });
      out.push({ topic: n.topic, change: "delivery_retry", delivery });
      continue;
    }
    const delivery = await deliver(env, change, n);
    await appendAuditEvent(env.DB, {
      event_type: `owner.notice_${change}`, actor: "agent:supervisor", subject: n.topic, outcome: change,
      payload: { fingerprint: n.active ? n.fingerprint : "", count: n.lines.length, title: n.title, delivery },
    });
    out.push({ topic: n.topic, change, delivery });
  }
  return out;
}
