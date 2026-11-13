// ADR-0012 phase 2: owner notifications without GitHub. These replace the scheduled
// owner-attention.yml and drift-alert.yml workflows, which kept GitHub issues open and closed.
//
// Seven topics are computed from D1:
//   owner_attention  - recovery plans in draft, critical proposals in pending_owner and pending knowledge
//                      proposals (a click is needed);
//   critical_reports - an open (not acknowledged) critical agent report of the last 24 hours;
//   drift            - a service drifted, unhealthy, never observed, or not observed for 45 minutes;
//   build_minutes    - the month's measured Workers Builds minutes, or their projection, reach 80% of the
//                      free-tier budget (owner 2026-11-12; control-plane-shared/src/build-usage.ts);
//   organism         - the Forge's census (ADR-0013) found the DNA and the live registries apart:
//                      a declared Worker or agent not registered, an agent no longer declared, a change;
//   dependencies     - the Forge's npm dependency audit (ADR-0012 G5) found a high or critical advisory in a
//                      Worker's or the Console UI's lockfile, or has not succeeded for 72 hours;
//   production_unhandled - a production problem no agent is handling (owner-inbox.ts unhandledProblems: the kernel
//                      or the Drift Detector itself unhealthy, stale observations, a persistent drift with no plan or
//                      deploy under way or with agents off, a failed or expired recovery, a critical runtime advisory,
//                      the Workers Builds budget used up).
// Every scheduled run (:22 and :52) compares each topic with its last notice event in the audit
// chain. It records owner.notice_opened, owner.notice_changed or owner.notice_closed, so the state
// needs no table of its own. The Console shows the live notices at GET /v1/notices.
//
// The owner channel (owner 2026-11-13: "Batasi User/Owner hanya untuk critical dan permintaan approval only"):
// only OWNER_CHANNEL_TOPICS, the approvals (owner_attention), the open critical reports (critical_reports) and the
// production problems no agent is handling (production_unhandled), reach the owner. They are emailed to the people in APPROVER_IDENTITIES when the send_email binding OWNER_EMAIL
// and the var NOTIFY_FROM are configured, and sent to the owner's Telegram through the Service Binding
// OWNER_TELEGRAM (the xauusd AI Worker's OwnerNotifier, which holds the bot; the platform holds no Telegram
// credential; owner 2026-11-11). Both link to the Console's Owner page (#/owner), which lists exactly the same
// items (owner-inbox.ts). Every other topic, and any topic added later, is console-only: computed, audited with
// the same owner.notice_* events and shown at GET /v1/notices with channel "console", but never emailed or sent
// to Telegram. ADR-0009 amendment 2026-11-13 (owner channel) records why that is safe.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent, sha256Hex } from "../../control-plane-shared/src/audit.ts";
import { describeAction, explainReason, serviceName } from "../../control-plane-shared/src/plain.ts";
import { buildUsage } from "../../control-plane-shared/src/build-usage.ts";
import { dependencyAudit, NOTICE_SEVERITIES } from "../../control-plane-shared/src/dependency-audit.ts";
import { STALE_MS, openCriticalReportRows, pendingApprovals, unhandledProblems } from "./owner-inbox.ts";

export const CONSOLE_URL = "https://nexus.cryptophys.work/console/";
/** The one Console page every owner email and Telegram message links to (owner 2026-11-13). */
export const OWNER_PANEL_URL = `${CONSOLE_URL}#/owner`;
export const TOPICS = ["owner_attention", "drift", "critical_reports", "organism", "build_minutes", "dependencies", "production_unhandled"] as const;
export type Topic = (typeof TOPICS)[number];
/**
 * The only topics that contact the owner, by email and by Telegram: approval requests and critical items, i.e. the
 * open critical reports and the production problems no agent is handling (owner 2026-11-13). Every other topic stays
 * in the Console.
 */
export const OWNER_CHANNEL_TOPICS = ["owner_attention", "critical_reports", "production_unhandled"] as const satisfies readonly Topic[];
export type Channel = "owner" | "console";
export const channelOf = (topic: Topic): Channel => (OWNER_CHANNEL_TOPICS as readonly Topic[]).includes(topic) ? "owner" : "console";
/** Observations older than this (45 min, three missed Drift Detector runs) count as stale (owner-inbox.ts). */
export { STALE_MS };

export interface Notice {
  topic: Topic;
  /** "owner": emailed and sent to Telegram; "console": shown in the Console only. */
  channel: Channel;
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

const fp = async (parts: string[]) => (parts.length ? (await sha256Hex([...parts].sort().join("\n"))).slice(0, 32) : "");

async function ownerAttention(db: D1Database): Promise<Notice> {
  const { recovery_plans: plans, consensus: critical, knowledge } = await pendingApprovals(db);
  const lines = [
    ...plans.map((p) => `Recovery plan for ${serviceName(p.service_id)} (by ${p.created_by})`),
    ...critical.map((c) => `Critical action: ${describeAction(c.action, c.target)} (proposed by ${c.proposer_agent_id})`),
    ...knowledge.map((k) => `Knowledge proposal ${k.item_id}@${k.item_version} (${String(k.kind).replace(/_/g, " ")}, by ${k.proposer_agent_id})`),
  ];
  const n = lines.length;
  return {
    topic: "owner_attention", channel: channelOf("owner_attention"), active: n > 0,
    fingerprint: await fp([...plans.map((p) => p.plan_id), ...critical.map((c) => c.proposal_id), ...knowledge.map((k) => k.proposal_id)]),
    title: n ? `${n} item(s) wait for your approval` : "Nothing waits for your approval",
    // Every item is decided on the Owner page (owner 2026-11-13), whatever its kind.
    lines, link: OWNER_PANEL_URL,
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
    topic: "drift", channel: channelOf("drift"), active: problems.length > 0,
    fingerprint: await fp(problems.map((p) => `${p.service}:${p.code}:${p.line}`)),
    title: problems.length ? `Drift in production: ${problems.length} service(s)` : "All services are healthy and at their expected versions",
    lines: problems.map((p) => p.line), link: `${CONSOLE_URL}#/infrastructure`,
  };
}

/**
 * Open critical reports of the last 24 hours. A report an approver acknowledged (ADR-0009 amendment 2026-11-13,
 * migration 0053) is not open, as for the consensus baseline; before the table exists every one is open.
 */
async function criticalReports(db: D1Database, now: number): Promise<Notice> {
  const rows = await openCriticalReportRows(db, now);
  const n = rows.length;
  return {
    topic: "critical_reports", channel: channelOf("critical_reports"), active: n > 0,
    fingerprint: await fp(rows.map((r) => r.report_id)),
    title: n ? `${n} open critical agent report(s) in the last 24 hours` : "No open critical agent report in the last 24 hours",
    lines: rows.slice(0, 5).map((r) => `${r.created_at} ${r.agent_id}: ${r.subject.slice(0, 160)}`),
    link: OWNER_PANEL_URL,
  };
}

/**
 * Findings the Supervisor turns into routine registrations by itself, one an hour per Worker (ADR-0013 phase 3).
 * They stay in the notice's lines, but not in its fingerprint: the owner gets one email when they appear and one
 * when they are all registered, not one per registration (owner 2026-11-12, 23 XAUUSD engines). A finding that
 * needs the owner (a seat, a privileged agent, a refused external organ, a changed host) still changes it.
 */
export const SELF_REGISTERING_FINDINGS: ReadonlySet<string> = new Set(["unregistered_engine", "unregistered_agent"]);

async function organism(db: D1Database): Promise<Notice> {
  let row: { main_sha: string; status: string; findings: string } | null = null;
  try { row = await db.prepare("SELECT main_sha, status, findings FROM forge_organism_census ORDER BY taken_at DESC LIMIT 1").first<{ main_sha: string; status: string; findings: string }>(); } catch { row = null; }
  let findings: Array<{ kind: string; subject: string; detail: string }> = [];
  try { const f = JSON.parse(row?.findings ?? "[]"); if (Array.isArray(f)) findings = f; } catch { findings = []; }
  return {
    topic: "organism", channel: channelOf("organism"), active: findings.length > 0,
    fingerprint: await fp([
      ...findings.filter((f) => !SELF_REGISTERING_FINDINGS.has(f.kind)).map((f) => `${f.kind}:${f.subject}`),
      ...(findings.some((f) => SELF_REGISTERING_FINDINGS.has(f.kind)) ? ["self-registering"] : []),
    ]),
    title: findings.length
      ? `The platform's DNA and its registries differ: ${findings.length} item(s)${findings.every((f) => SELF_REGISTERING_FINDINGS.has(f.kind)) ? ", all being registered automatically" : ""}`
      : "Every organ and agent in the DNA is registered",
    lines: findings.slice(0, 10).map((f) => f.detail), link: `${CONSOLE_URL}#/agents`,
  };
}

async function buildMinutes(db: D1Database, now: number): Promise<Notice> {
  const u = await buildUsage(db, now);
  const active = u !== null && (u.status === "warning" || u.status === "over");
  // The fingerprint changes once per 10% step, so the owner hears of a rising month without one email per build.
  const step = u ? Math.floor(Math.max(u.minutes, u.projected_minutes ?? 0) / (u.budget_minutes / 10)) : 0;
  const lines = u && active ? [
    `${u.month}: ${u.minutes} of ${u.budget_minutes} build minutes measured (${u.builds} builds${u.unmeasured_builds ? `, ${u.unmeasured_builds} without a measured duration` : ""})`,
    ...(u.projected_minutes !== null ? [`At this month's pace: about ${u.projected_minutes} minutes by the end of the month`] : []),
    ...u.by_worker.slice(0, 3).map((w) => `${w.worker}: ${w.minutes} min, ${w.builds} builds`),
    `Budget: the Workers Builds free tier (${u.included_minutes.free} min/month); the account's Workers Paid plan includes ${u.included_minutes.paid}`,
  ] : [];
  return {
    topic: "build_minutes", channel: channelOf("build_minutes"), active,
    fingerprint: active && u ? await fp([u.month, u.status, String(step)]) : "",
    title: !u || u.status === "no_data" ? "Workers Builds minutes are not measured yet"
      : u.status === "stale" ? `Workers Builds minutes: last measured at ${u.last_collection?.collected_at ?? "unknown"} (${u.minutes}/${u.budget_minutes} this month)`
      : active
      ? `Workers Builds minutes: ${u.status === "over" ? "over" : "near"} the free-tier budget (${u.minutes}/${u.budget_minutes} this month)`
      : `Workers Builds minutes within the free-tier budget (${u.minutes}/${u.budget_minutes} this month)`,
    lines, link: `${CONSOLE_URL}#/code`,
  };
}

/**
 * ADR-0012 G5: vulnerable npm dependencies, from the Forge's daily audit (Dependabot's alerts, off GitHub). Open
 * when the last successful audit found a high or critical advisory in a Worker's or the Console UI's lockfile, or
 * when no audit has succeeded for 72 hours. The fingerprint is the sorted advisory ids, so the owner gets one email
 * per new set of advisories, not one per run.
 */
async function dependencies(db: D1Database, now: number): Promise<Notice> {
  const a = await dependencyAudit(db, now);
  const ids = a?.runtime_high_ids ?? [];
  const active = a !== null && (a.stale || ids.length > 0);
  const serious = (a?.findings ?? []).filter((f) => f.runtime && NOTICE_SEVERITIES.has(f.severity));
  const lines = active && a ? [
    ...(a.stale ? [a.last_ok_run ? `The last successful dependency audit ran at ${a.last_ok_run.ran_at} (main ${a.last_ok_run.main_sha.slice(0, 12)})` : "No dependency audit has succeeded yet"] : []),
    ...(a.stale && a.latest_run?.status === "failed" && a.latest_run.error ? [`Latest audit failed: ${a.latest_run.error}`] : []),
    ...serious.slice(0, 10).map((f) => `${f.package}@${f.version}: ${f.severity}, ${f.title ?? f.advisory_id}${f.url ? ` (${f.url})` : ""} in ${f.lockfiles.join(", ")}`),
    ...(serious.length > 10 ? [`and ${serious.length - 10} more`] : []),
  ] : [];
  const n = ids.length;
  return {
    topic: "dependencies", channel: channelOf("dependencies"), active,
    fingerprint: active ? await fp([...ids, ...(a?.stale ? ["stale"] : [])]) : "",
    title: !a || a.status === "no_data" ? "npm dependencies are not audited yet"
      : n ? `Vulnerable npm dependencies: ${n} high or critical advisor${n === 1 ? "y" : "ies"} in Worker or Console builds${a.stale ? "; the audit is also stale" : ""}`
      : a.stale ? "The npm dependency audit has not succeeded for 72 hours"
      : `No high or critical advisory in Worker or Console builds (${a.findings.length} finding(s) in total)`,
    lines, link: `${CONSOLE_URL}#/code`,
  };
}

/** Production problems no agent is handling; one line per problem, fingerprinted by what and where, not when. */
async function productionUnhandled(db: D1Database, now: number): Promise<Notice> {
  const problems = await unhandledProblems(db, now);
  const n = problems.length;
  return {
    topic: "production_unhandled", channel: channelOf("production_unhandled"), active: n > 0,
    fingerprint: await fp(problems.map((p) => `${p.code}:${p.subject}`)),
    title: n ? `A production problem no agent is handling: ${n} item(s)` : "Every production problem is handled by an agent or waits for your approval",
    lines: problems.slice(0, 20).map((p) => p.detail), link: OWNER_PANEL_URL,
  };
}

/** The live notices, for the Console and for reconcileNotices. Read-only. */
export async function collectNotices(db: D1Database, now = Date.now()): Promise<Notice[]> {
  return [await ownerAttention(db), await drift(db, now), await criticalReports(db, now), await organism(db), await buildMinutes(db, now), await dependencies(db, now), await productionUnhandled(db, now)];
}

const owners = (env: NoticeEnv) => (env.APPROVER_IDENTITIES ?? "").split(",").map((v) => v.trim().toLowerCase()).filter((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v));

/** Whether email is set up at all (GET /v1/notices reports it); only owner-channel topics are ever emailed. */
export function emailConfigured(env: NoticeEnv): boolean {
  return Boolean(env.OWNER_EMAIL && env.NOTIFY_FROM && owners(env).length);
}

/** Whether this topic goes to the owner's Telegram: an owner-channel topic and a configured binding. */
export function telegramConfigured(env: NoticeEnv, topic: Topic): boolean {
  return typeof env.OWNER_TELEGRAM?.notify === "function" && channelOf(topic) === "owner";
}
const emailFor = (env: NoticeEnv, topic: Topic) => channelOf(topic) === "owner" && emailConfigured(env);
const anyChannel = (env: NoticeEnv, topic: Topic) => emailFor(env, topic) || telegramConfigured(env, topic);

async function deliverTelegram(env: NoticeEnv, change: "opened" | "changed" | "closed", n: Notice): Promise<string> {
  try {
    const r = await env.OWNER_TELEGRAM!.notify({ change, title: n.title, lines: n.lines.slice(0, 20), link: n.link });
    return r?.sent === true ? "sent" : `failed: ${String(r?.reason ?? "not sent").slice(0, 120)}`;
  } catch (err) {
    return `failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`;
  }
}

/**
 * Every configured channel of an owner-channel topic; "sent" only when each one sent. A console-only topic is never
 * delivered: its delivery is recorded as "console_only", and it is never retried.
 */
async function deliver(env: NoticeEnv, change: "opened" | "changed" | "closed", n: Notice): Promise<string> {
  if (channelOf(n.topic) !== "owner") return "console_only";
  const results: string[] = [];
  if (emailFor(env, n.topic)) results.push(await deliverEmail(env, change, n));
  if (telegramConfigured(env, n.topic)) results.push(await deliverTelegram(env, change, n));
  if (!results.length) return "not_configured";
  if (results.length === 1 || results.every((r) => r === "sent")) return results.length === 1 ? results[0] : "sent";
  const names = [emailFor(env, n.topic) ? "email" : null, telegramConfigured(env, n.topic) ? "telegram" : null].filter(Boolean);
  return names.map((c, i) => `${c}: ${results[i]}`).join("; ").slice(0, 300);
}

async function deliverEmail(env: NoticeEnv, change: "opened" | "changed" | "closed", n: Notice): Promise<string> {
  const subject = `[Cryptophys] ${change === "closed" ? "Resolved: " : ""}${n.title}`;
  const text = [
    change === "closed" ? "This is resolved; nothing more is needed." : n.title + ".",
    "",
    ...n.lines.map((l) => `- ${l}`),
    "",
    `Open the Owner page of the Cerebrum Console: ${n.link}`,
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
