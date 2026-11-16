// Owner 2026-11-16 ("pakai cara 2 lewat kernel"): the xauusd EA's heartbeat and terminal-health messages go to the
// Cerebrum chat, not to the xauusd Worker's own TELEGRAM_CHAT_ID (Cryptophys-Nexus). The xauusd Worker publishes each
// message as an agent report (reports.publish over its AgentRpc binding, host_worker pinned in the binding props);
// on every kernel cron tick (:07, :22, :37, :52) this relay forwards each qualifying report once, as one Telegram
// message, to every enabled alert channel (migration 0056, Console → Alerts) whose topics include the relay topic.
//
// Relay topics are event-style, unlike the notice topics of owner-notices.ts (state-style: opened, changed, closed).
// A qualifying report (the contract, docs/XAUUSD-INTEGRATION.md "Relay to the Cerebrum chat"):
//   - its agent is registered with host_worker = a service of the xauusd origin (EXTERNAL_ORIGINS, organism.ts);
//   - kind xauusd_digest; severity info or warning (critical is never forwarded: a heartbeat never holds the brake);
//   - body.telegram_topic is a relay topic ("ea_heartbeat") and body.text is a non-empty string; the text is sent as
//     plain text after sanitizeRelayText (HTML tags and control characters removed, at most RELAY_TEXT_MAX characters);
//   - it is at most RELAY_MAX_AGE_MS old when the relay first sees it (older: dropped as stale, never sent).
// Anything else is ignored. The state needs no table: each report's relay state is its last owner.relay_* audit event
// (subject relay:<report_id>), so a report is never forwarded twice, a restart loses nothing, and a failed channel is
// retried, on that channel only, at most MAX_DELIVERY_RETRIES times. At most RELAY_MAX_PER_HOUR messages per topic are
// sent an hour; the excess is dropped (audited) and folded into one summary line on the next forwarded message. The
// audit records report and channel ids and delivery outcomes, never the message text.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { EXTERNAL_ORIGINS } from "../../control-plane-shared/src/organism.ts";
import { listChannels, sendToChannel, type AlertChannel, type AlertEnv } from "./alert-channels.ts";
import { MAX_DELIVERY_RETRIES, TOPICS } from "./owner-notices.ts";

export const RELAY_TOPICS = ["ea_heartbeat"] as const;
export type RelayTopic = (typeof RELAY_TOPICS)[number];
/** Every topic an alert channel may list: the notice topics, then the relay topics. */
export const CHANNEL_TOPICS: readonly string[] = Object.freeze([...TOPICS, ...RELAY_TOPICS]);
export const RELAY_ORIGIN = "xauusd";
/** The Workers whose agents may publish relayed reports: the xauusd origin's services. */
export const RELAY_HOSTS: readonly string[] = EXTERNAL_ORIGINS.find((o) => o.origin === RELAY_ORIGIN)?.services ?? [];
export const RELAY_KINDS = ["xauusd_digest"] as const;
export const RELAY_SEVERITIES = ["info", "warning"] as const;
/** The longest text sent, in characters (a batch of several alerts fits; Telegram's own limit is 4096). */
export const RELAY_TEXT_MAX = 2000;
/** Messages sent per topic per hour, at most (xauusd 2026-11-16: up to about 20 terminal-health alerts an hour). */
export const RELAY_MAX_PER_HOUR = 20;
/** A report older than this when the relay first sees it is not sent (a stale heartbeat says nothing). */
export const RELAY_MAX_AGE_MS = 2 * 3_600_000;
const HOUR_MS = 3_600_000;
/** Reports scanned: the age limit plus the rate-limit hour, so every forward of the last hour is in view. */
const SCAN_MS = RELAY_MAX_AGE_MS + HOUR_MS;
const SCAN_LIMIT = 200;
const RELAY_EVENTS = ["owner.relay_forwarded", "owner.relay_delivery_retry", "owner.relay_dropped"] as const;

/**
 * The text of a relayed report as sent: plain text, HTML tags and control characters (except new lines) removed,
 * anything shaped like a bot token redacted, at most RELAY_TEXT_MAX characters. Null when nothing is left.
 */
export function sanitizeRelayText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.replace(/\r\n?/g, "\n").replace(/\t/g, " ");
  s = s.replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, "");
  s = s.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, "");
  s = s.replace(/\b\d{5,15}:[A-Za-z0-9_-]{30,60}\b/g, "[redacted]");
  s = s.split("\n").map((l) => l.replace(/ {2,}/g, " ").trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!s) return null;
  const chars = Array.from(s);
  return chars.length > RELAY_TEXT_MAX ? chars.slice(0, RELAY_TEXT_MAX - 1).join("") + "…" : s;
}

interface ReportRow { report_id: string; agent_id: string; kind: string; severity: string; body_json: string; created_at: string }
interface RelayState { event: string; payload: Record<string, unknown>; forwardedAt: number | null; counted: boolean }
export interface RelayResult { report_id: string; topic: string; outcome: "forwarded" | "retried" | "dropped"; delivery: string }

const parse = (s: string): Record<string, unknown> => { try { const v = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const isRelayTopic = (t: unknown): t is RelayTopic => typeof t === "string" && (RELAY_TOPICS as readonly string[]).includes(t);
/** The channels that receive a relay topic: enabled, with their own bot (never the xauusd bot it came from), subscribed. */
const targetsOf = (channels: AlertChannel[], topic: string) => channels.filter((c) => c.enabled && c.kind === "telegram" && c.topics.includes(topic));
const summarize = (channels: Record<string, string>): string => {
  const r = Object.entries(channels);
  if (!r.length) return "no_channel";
  if (r.every(([, v]) => v === "sent")) return "sent";
  return r.length === 1 ? r[0][1] : r.map(([k, v]) => `${k}: ${v}`).join("; ").slice(0, 300);
};

/** The qualifying reports of the scan window, oldest first (the newest SCAN_LIMIT when there are more). */
async function qualifyingReports(db: D1Database, now: number): Promise<ReportRow[]> {
  if (!RELAY_HOSTS.length) return [];
  const q = (xs: readonly string[]) => xs.map(() => "?").join(", ");
  const rows = await db.prepare(
    `SELECT r.report_id, r.agent_id, r.kind, r.severity, r.body_json, r.created_at FROM agent_reports r
     JOIN agents a ON a.agent_id = r.agent_id
     WHERE r.created_at >= ? AND a.host_worker IN (${q(RELAY_HOSTS)}) AND r.kind IN (${q(RELAY_KINDS)}) AND r.severity IN (${q(RELAY_SEVERITIES)})
       AND json_extract(r.body_json, '$.telegram_topic') IN (${q(RELAY_TOPICS)})
     ORDER BY r.created_at DESC, r.rowid DESC LIMIT ${SCAN_LIMIT}`,
  ).bind(new Date(now - SCAN_MS).toISOString(), ...RELAY_HOSTS, ...RELAY_KINDS, ...RELAY_SEVERITIES, ...RELAY_TOPICS).all<ReportRow>();
  return rows.results.filter((r) => (RELAY_SEVERITIES as readonly string[]).includes(r.severity) && (RELAY_KINDS as readonly string[]).includes(r.kind)).reverse();
}

/** Each report's last relay event, and the time of its first forward (from the audit chain). */
async function relayStates(db: D1Database, ids: string[]): Promise<Map<string, RelayState>> {
  const out = new Map<string, RelayState>();
  for (let i = 0; i < ids.length; i += 50) {
    const subjects = ids.slice(i, i + 50).map((id) => `relay:${id}`);
    const rows = await db.prepare(
      `SELECT subject, event_type, payload_json FROM audit_events WHERE subject IN (${subjects.map(() => "?").join(", ")})
       AND event_type IN (${RELAY_EVENTS.map(() => "?").join(", ")}) ORDER BY rowid`,
    ).bind(...subjects, ...RELAY_EVENTS).all<{ subject: string; event_type: string; payload_json: string }>();
    for (const r of rows.results) {
      const id = r.subject.slice("relay:".length);
      const payload = parse(r.payload_json);
      const prev = out.get(id);
      const first = r.event_type === "owner.relay_forwarded";
      out.set(id, {
        event: r.event_type, payload,
        forwardedAt: first ? Date.parse(String(payload.forwarded_at ?? "")) : prev?.forwardedAt ?? null,
        counted: first ? payload.counted === true : prev?.counted ?? false,
      });
    }
  }
  return out;
}

/**
 * Forward the new qualifying reports, retry failed channels, drop the stale and the excess. Idempotent: run it as
 * often as the cron fires. Before migration 0056 (no alert_channels table) it does nothing.
 */
export async function relayReports(env: AlertEnv, now = Date.now()): Promise<RelayResult[]> {
  const channels = await listChannels(env.DB);
  if (channels === null) return [];
  const reports = await qualifyingReports(env.DB, now);
  if (!reports.length) return [];
  const states = await relayStates(env.DB, reports.map((r) => r.report_id));
  const nowIso = new Date(now).toISOString();
  const out: RelayResult[] = [];
  const audit = (event: (typeof RELAY_EVENTS)[number], r: ReportRow, outcome: string, payload: Record<string, unknown>) =>
    appendAuditEvent(env.DB, { event_type: event, actor: "agent:supervisor", subject: `relay:${r.report_id}`, outcome, payload: { report_id: r.report_id, agent_id: r.agent_id, report_created_at: r.created_at, ...payload } });

  // Per topic: messages sent in the last hour, the last forward, and the drops since then.
  const sentLastHour = new Map<string, number>();
  const lastForward = new Map<string, number>();
  const foldedSince = new Map<string, number>();
  for (const s of states.values()) {
    const topic = String(s.payload.topic ?? "");
    if (s.forwardedAt !== null && Number.isFinite(s.forwardedAt) && s.counted) {
      if (s.forwardedAt > now - HOUR_MS) sentLastHour.set(topic, (sentLastHour.get(topic) ?? 0) + 1);
      lastForward.set(topic, Math.max(lastForward.get(topic) ?? 0, s.forwardedAt));
    }
  }
  for (const s of states.values()) {
    const topic = String(s.payload.topic ?? "");
    const droppedAt = Date.parse(String(s.payload.dropped_at ?? ""));
    if (s.event === "owner.relay_dropped" && s.payload.reason === "rate_limited" && droppedAt > (lastForward.get(topic) ?? 0)) foldedSince.set(topic, (foldedSince.get(topic) ?? 0) + 1);
  }

  const pending = new Map<RelayTopic, Array<{ r: ReportRow; text: string }>>();
  for (const r of reports) {
    const body = parse(r.body_json);
    const topic = body.telegram_topic;
    if (!isRelayTopic(topic)) continue;
    const state = states.get(r.report_id);
    if (state) {
      // A retry: only the channels whose send failed, while they still exist, are enabled and list the topic.
      if (state.event === "owner.relay_dropped") continue;
      const retries = typeof state.payload.retries === "number" ? state.payload.retries : 0;
      const prior = state.payload.channels && typeof state.payload.channels === "object" ? state.payload.channels as Record<string, string> : {};
      const failed = Object.entries(prior).filter(([, v]) => v.startsWith("failed")).map(([k]) => k);
      if (!failed.length || retries >= MAX_DELIVERY_RETRIES) continue;
      const text = sanitizeRelayText(body.text);
      const targets = targetsOf(channels, topic);
      const results: Record<string, string> = {};
      for (const id of failed) {
        const c = targets.find((t) => t.channel_id === id);
        results[id] = c && text ? await sendToChannel(env, c, { change: "relay", title: text, lines: [], link: "" }) : "dropped: channel_unavailable";
      }
      const merged = { ...prior, ...results };
      const delivery = summarize(merged);
      await audit("owner.relay_delivery_retry", r, delivery === "sent" ? "forwarded" : "delivery_retry", { topic, forwarded_at: state.payload.forwarded_at, delivery, channels: merged, retries: retries + 1, counted: state.counted });
      out.push({ report_id: r.report_id, topic, outcome: "retried", delivery });
      continue;
    }
    const text = sanitizeRelayText(body.text);
    const created = Date.parse(r.created_at);
    const reason = !text ? "invalid_text" : !Number.isFinite(created) || created < now - RELAY_MAX_AGE_MS ? "stale" : null;
    if (reason) {
      await audit("owner.relay_dropped", r, "dropped", { topic, reason, dropped_at: nowIso });
      out.push({ report_id: r.report_id, topic, outcome: "dropped", delivery: reason });
      continue;
    }
    const list = pending.get(topic) ?? [];
    list.push({ r, text: text! });
    pending.set(topic, list);
  }

  for (const [topic, list] of pending) {
    const targets = targetsOf(channels, topic);
    if (!targets.length) {
      // No channel lists the topic: recorded once, never sent later (a subscription does not replay old messages).
      for (const { r } of list) {
        await audit("owner.relay_forwarded", r, "no_channel", { topic, forwarded_at: nowIso, delivery: "no_channel", channels: {}, counted: false, retries: 0 });
        out.push({ report_id: r.report_id, topic, outcome: "forwarded", delivery: "no_channel" });
      }
      continue;
    }
    const budget = Math.max(0, RELAY_MAX_PER_HOUR - (sentLastHour.get(topic) ?? 0));
    // Over the hour's budget: the oldest are dropped, the newest are sent.
    const excess = list.slice(0, Math.max(0, list.length - budget));
    for (const { r } of excess) {
      await audit("owner.relay_dropped", r, "dropped", { topic, reason: "rate_limited", dropped_at: nowIso });
      out.push({ report_id: r.report_id, topic, outcome: "dropped", delivery: "rate_limited" });
    }
    let folded = (foldedSince.get(topic) ?? 0) + excess.length;
    for (const { r, text } of list.slice(excess.length)) {
      const lines = folded > 0 ? [`(${folded} more ${topic} message${folded === 1 ? "" : "s"} not forwarded: at most ${RELAY_MAX_PER_HOUR} an hour)`] : [];
      const channelsOut: Record<string, string> = {};
      for (const c of targets) channelsOut[c.channel_id] = await sendToChannel(env, c, { change: "relay", title: text, lines, link: "" });
      const delivery = summarize(channelsOut);
      await audit("owner.relay_forwarded", r, delivery === "sent" ? "forwarded" : "failed", { topic, forwarded_at: nowIso, delivery, channels: channelsOut, counted: true, retries: 0, folded });
      out.push({ report_id: r.report_id, topic, outcome: "forwarded", delivery });
      folded = 0;
    }
  }
  return out;
}
