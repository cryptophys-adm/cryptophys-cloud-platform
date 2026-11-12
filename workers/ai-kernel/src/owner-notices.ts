// ADR-0012 phase 2: owner notifications without GitHub. These replace the scheduled
// owner-attention.yml and drift-alert.yml workflows, which kept GitHub issues open and closed.
//
// Four topics are computed from D1:
//   owner_attention  - recovery plans in draft, critical proposals in pending_owner and pending knowledge
//                      proposals (a click is needed);
//   drift            - a service drifted, unhealthy, never observed, or not observed for 45 minutes;
//   critical_reports - an agent published a critical report in the last 24 hours;
//   organism         - the Forge's census (ADR-0013) found the DNA and the live registries apart:
//                      a declared Worker or agent not registered, an agent no longer declared, a change.
// Every scheduled run (:22 and :52) compares each topic with its last notice event in the audit
// chain. It records owner.notice_opened, owner.notice_changed or owner.notice_closed, so the state
// needs no table of its own. When the send_email binding OWNER_EMAIL and the var NOTIFY_FROM are
// configured, it also emails the owners (the people in APPROVER_IDENTITIES). The Console shows
// the live notices at GET /v1/notices.
// Telegram (owner 2026-11-11: "buat notif telegram jika ada yang perlu approve owner di semua
// cerebrum"): owner_attention also goes to the owner's Telegram through the Service Binding
// OWNER_TELEGRAM (the xauusd AI Worker's OwnerNotifier, which holds the bot; the platform holds no
// Telegram credential). The other topics stay in the Console and the email.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent, sha256Hex } from "../../control-plane-shared/src/audit.ts";
import { describeAction, explainReason, serviceName } from "../../control-plane-shared/src/plain.ts";

export const CONSOLE_URL = "https://nexus.cryptophys.work/console/";
export const TOPICS = ["owner_attention", "drift", "critical_reports", "organism"] as const;
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
export interface OwnerTelegramBinding {
  notify(input: { change: string; title: string; lines: string[]; link: string }): Promise<{ sent?: boolean; reason?: string }>;
}
export interface NoticeEnv {
  DB: D1Database;
  APPROVER_IDENTITIES?: string;
  OWNER_EMAIL?: SendEmailBinding;
  NOTIFY_FROM?: string;
  OWNER_TELEGRAM?: OwnerTelegramBinding;
}
/** The topics that reach the owner's Telegram: only what waits for the owner's click. */
export const TELEGRAM_TOPICS: readonly Topic[] = ["owner_attention"];

const iso = (ms: number) => new Date(ms).toISOString();
const fp = async (parts: string[]) => (parts.length ? (await sha256Hex([...parts].sort().join("\n"))).slice(0, 32) : "");

async function ownerAttention(db: D1Database): Promise<Notice> {
  const plans = await db.prepare("SELECT plan_id, service_id, created_by FROM recovery_plans WHERE status = 'draft' ORDER BY created_at LIMIT 50")
    .all<{ plan_id: string; service_id: string; created_by: string }>();
  const critical = await db.prepare("SELECT proposal_id, action, target, proposer_agent_id FROM consensus_proposals WHERE status = 'pending_owner' ORDER BY created_at LIMIT 50")
    .all<{ proposal_id: string; action: string; target: string; proposer_agent_id: string }>();
  // Learned-knowledge proposals wait for an approver too (TP-028); before migration 0029 there are none.
  let knowledge: { proposal_id: string; item_id: string; item_version: number; kind: string; proposer_agent_id: string }[] = [];
  try {
    knowledge = (await db.prepare("SELECT proposal_id, item_id, item_version, kind, proposer_agent_id FROM knowledge_proposals WHERE status = 'pending' ORDER BY created_at LIMIT 50")
      .all<{ proposal_id: string; item_id: string; item_version: number; kind: string; proposer_agent_id: string }>()).results;
  } catch { knowledge = []; }
  const lines = [
    ...plans.results.map((p) => `Recovery plan for ${serviceName(p.service_id)} (by ${p.created_by}): review at ${CONSOLE_URL}#/recovery/${p.plan_id}`),
    ...critical.results.map((c) => `Critical action: ${describeAction(c.action, c.target)} (proposed by ${c.proposer_agent_id}): decide at ${CONSOLE_URL}#/consensus`),
    ...knowledge.map((k) => `Knowledge proposal ${k.item_id}@${k.item_version} (${String(k.kind).replace(/_/g, " ")}, by ${k.proposer_agent_id}): review at ${CONSOLE_URL}#/knowledge`),
  ];
  const n = lines.length;
  // The link goes to the one page that holds every item when it is a single kind.
  const kinds = [plans.results.length > 0, critical.results.length > 0, knowledge.length > 0].filter(Boolean).length;
  const link = kinds !== 1 ? `${CONSOLE_URL}#/` : plans.results.length ? `${CONSOLE_URL}#/recovery` : critical.results.length ? `${CONSOLE_URL}#/consensus` : `${CONSOLE_URL}#/knowledge`;
  return {
    topic: "owner_attention", active: n > 0,
    fingerprint: await fp([...plans.results.map((p) => p.plan_id), ...critical.results.map((c) => c.proposal_id), ...knowledge.map((k) => k.proposal_id)]),
    title: n ? `${n} item(s) wait for your approval` : "Nothing waits for your approval",
    lines, link,
  };
}

async function drift(db: D1Database, now: number): Promise<Notice> {
  const services = await db.prepare("SELECT service_id, desired_version FROM service_registry WHERE status != 'disabled' ORDER BY service_id")
    .all<{ service_id: string; desired_version: string | null }>();
  // Latest observation per registered service through the (service_id, observed_at) index: about 3 rows read per service instead of the whole table (2026-11-11: 24,480 rows per call at 12,240 observations).
  const latest = await db.prepare(
    `SELECT d.service_id, d.drifted, d.evidence_json, d.observed_at FROM service_registry r
     JOIN drift_observations d ON d.observation_id = (
       SELECT i.observation_id FROM drift_observations i WHERE i.service_id = r.service_id ORDER BY i.observed_at DESC, i.rowid DESC LIMIT 1)`,
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

async function organism(db: D1Database): Promise<Notice> {
  let row: { main_sha: string; status: string; findings: string } | null = null;
  try { row = await db.prepare("SELECT main_sha, status, findings FROM forge_organism_census ORDER BY taken_at DESC LIMIT 1").first<{ main_sha: string; status: string; findings: string }>(); } catch { row = null; }
  let findings: Array<{ kind: string; subject: string; detail: string }> = [];
  try { const f = JSON.parse(row?.findings ?? "[]"); if (Array.isArray(f)) findings = f; } catch { findings = []; }
  return {
    topic: "organism", active: findings.length > 0,
    fingerprint: await fp(findings.map((f) => `${f.kind}:${f.subject}`)),
    title: findings.length ? `The platform's DNA and its registries differ: ${findings.length} item(s)` : "Every organ and agent in the DNA is registered",
    lines: findings.slice(0, 10).map((f) => f.detail), link: `${CONSOLE_URL}#/agents`,
  };
}

/** The live notices, for the Console and for reconcileNotices. Read-only. */
export async function collectNotices(db: D1Database, now = Date.now()): Promise<Notice[]> {
  return [await ownerAttention(db), await drift(db, now), await criticalReports(db, now), await organism(db)];
}

const owners = (env: NoticeEnv) => (env.APPROVER_IDENTITIES ?? "").split(",").map((v) => v.trim().toLowerCase()).filter((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v));

export function emailConfigured(env: NoticeEnv): boolean {
  return Boolean(env.OWNER_EMAIL && env.NOTIFY_FROM && owners(env).length);
}

export function telegramConfigured(env: NoticeEnv, topic: Topic): boolean {
  return typeof env.OWNER_TELEGRAM?.notify === "function" && TELEGRAM_TOPICS.includes(topic);
}
const anyChannel = (env: NoticeEnv, topic: Topic) => emailConfigured(env) || telegramConfigured(env, topic);

async function deliverTelegram(env: NoticeEnv, change: "opened" | "changed" | "closed", n: Notice): Promise<string> {
  try {
    const r = await env.OWNER_TELEGRAM!.notify({ change, title: n.title, lines: n.lines.slice(0, 20), link: n.link });
    return r?.sent === true ? "sent" : `failed: ${String(r?.reason ?? "not sent").slice(0, 120)}`;
  } catch (err) {
    return `failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`;
  }
}

/** Every configured channel; "sent" only when each one sent. */
async function deliver(env: NoticeEnv, change: "opened" | "changed" | "closed", n: Notice): Promise<string> {
  const results: string[] = [];
  if (emailConfigured(env)) results.push(await deliverEmail(env, change, n));
  if (telegramConfigured(env, n.topic)) results.push(await deliverTelegram(env, change, n));
  if (!results.length) return "not_configured";
  if (results.length === 1 || results.every((r) => r === "sent")) return results.length === 1 ? results[0] : "sent";
  const names = [emailConfigured(env) ? "email" : null, telegramConfigured(env, n.topic) ? "telegram" : null].filter(Boolean);
  return names.map((c, i) => `${c}: ${results[i]}`).join("; ").slice(0, 300);
}

async function deliverEmail(env: NoticeEnv, change: "opened" | "changed" | "closed", n: Notice): Promise<string> {
  const subject = `[Cryptophys] ${change === "closed" ? "Resolved: " : ""}${n.title}`;
  const text = [
    change === "closed" ? "This is resolved; nothing more is needed." : n.title + ".",
    "",
    ...n.lines.map((l) => `- ${l}`),
    "",
    `Open the Cerebrum Console: ${n.link}`,
    "",
    "Sent by the Cryptophys AI Kernel (ADR-0012). It moves no funds; a trading action needs your click.",
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
      const retryChange = anyChannel(env, n.topic) && last.delivery !== "sent"
        && ((n.active && last.open && last.fingerprint === n.fingerprint) || (!n.active && !last.open && last.eventType !== ""))
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
