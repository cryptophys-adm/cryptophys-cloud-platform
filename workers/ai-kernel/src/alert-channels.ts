// Owner 2026-11-13: "buatkan panel alert di menu cerebrum user. Panel ini untuk mengaktifkan/nonaktifkan atau
// menambah/hapus telegram alert. Contoh saya mau memisahkan alert khusus cerebrum ke bot yang berbeda, jadi next
// tidak perlu deploy terus menerus cukup input chat id atau token id telegram".
//
// The owner's Telegram alert channels (migration 0056), managed from the Console's Alerts page:
//   - a channel is a chat that receives the owner notices of the topics it lists, when enabled;
//   - `alc_default` is the existing bot (the xauusd AI Worker's OwnerNotifier, Service Binding OWNER_TELEGRAM); it can
//     be disabled, never deleted;
//   - any other channel is a Telegram bot token plus a chat id. The token is write-only: it is kept in the kernel's own
//     Durable Object (AlertVault), never in D1 (shared by every platform Worker), never returned, logged or audited;
//     the row keeps its last four characters;
//   - only an approver changes channels; every change is audited (without the token).
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";

export const DEFAULT_CHANNEL_ID = "alc_default";
export const MAX_CHANNELS = 10;
const TELEGRAM_API = "https://api.telegram.org";
/** A BotFather token: `<bot id>:<secret>`. */
export const BOT_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
/** A numeric chat id (a user, group or channel; groups are negative) or a public @channel name. */
export const CHAT_ID = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
const CHANNEL_ID = /^alc_[0-9a-f-]{36}$|^alc_default$/;

/** The kernel's vault of bot tokens (the AlertVault Durable Object's RPC methods). */
export interface AlertVault {
  put(channelId: string, token: string): Promise<void>;
  get(channelId: string): Promise<string | null>;
  delete(channelId: string): Promise<void>;
}
export interface OwnerTelegramBinding {
  notify(input: { change: string; title: string; lines: string[]; link: string }): Promise<{ sent?: boolean; reason?: string }>;
}
export interface AlertEnv { DB: D1Database; ALERT_VAULT?: AlertVault; OWNER_TELEGRAM?: OwnerTelegramBinding }

export interface AlertChannel {
  channel_id: string;
  name: string;
  kind: "telegram" | "telegram_default";
  chat_id: string | null;
  topics: string[];
  enabled: boolean;
  token_hint: string | null;
  updated_by: string;
  updated_at: string;
}

export class AlertChannelError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(`${code}: ${message}`); this.status = status; this.code = code; }
}

const parseTopics = (raw: unknown): string[] => {
  try { const a = JSON.parse(String(raw ?? "[]")); return Array.isArray(a) ? a.filter((t): t is string => typeof t === "string") : []; } catch { return []; }
};
function rowToChannel(r: Record<string, unknown>): AlertChannel {
  return {
    channel_id: String(r.channel_id), name: String(r.name), kind: r.kind === "telegram_default" ? "telegram_default" : "telegram",
    chat_id: typeof r.chat_id === "string" ? r.chat_id : null, topics: parseTopics(r.topics_json), enabled: r.enabled === 1,
    token_hint: typeof r.token_hint === "string" ? r.token_hint : null, updated_by: String(r.updated_by ?? ""), updated_at: String(r.updated_at ?? ""),
  };
}

/** Every channel, the default first. Null when the table does not exist yet (before migration 0056). */
export async function listChannels(db: D1Database): Promise<AlertChannel[] | null> {
  try {
    const rows = await db.prepare("SELECT channel_id, name, kind, chat_id, topics_json, enabled, token_hint, updated_by, updated_at FROM alert_channels ORDER BY channel_id = 'alc_default' DESC, created_at")
      .all<Record<string, unknown>>();
    return rows.results.map(rowToChannel);
  } catch {
    return null;
  }
}

function validName(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s.length > 60 || /[\u0000-\u001f]/.test(s)) throw new AlertChannelError(400, "invalid_name", "a name of 1 to 60 characters");
  return s;
}
function validTopics(v: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(v) || !v.length || v.length > allowed.length) throw new AlertChannelError(400, "invalid_topics", `choose one or more of: ${allowed.join(", ")}`);
  const out = [...new Set(v.map(String))];
  for (const t of out) if (!allowed.includes(t)) throw new AlertChannelError(400, "invalid_topics", `unknown topic ${t.slice(0, 40)}`);
  return allowed.filter((t) => out.includes(t));
}
function validChat(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!CHAT_ID.test(s)) throw new AlertChannelError(400, "invalid_chat_id", "a numeric chat id (groups are negative) or @channelname");
  return s;
}
function validToken(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!BOT_TOKEN.test(s)) throw new AlertChannelError(400, "invalid_bot_token", "a bot token from @BotFather (digits, a colon, then the secret)");
  return s;
}
const nowIso = () => new Date().toISOString();
const audit = (db: D1Database, actor: string, event: string, channelId: string, payload: Record<string, unknown>) =>
  appendAuditEvent(db, { event_type: event, actor, subject: `alert_channel:${channelId}`, outcome: "succeeded", payload });

async function getChannel(db: D1Database, id: string): Promise<AlertChannel> {
  if (!CHANNEL_ID.test(id)) throw new AlertChannelError(404, "not_found", "unknown alert channel");
  const r = await db.prepare("SELECT channel_id, name, kind, chat_id, topics_json, enabled, token_hint, updated_by, updated_at FROM alert_channels WHERE channel_id = ?").bind(id).first<Record<string, unknown>>();
  if (!r) throw new AlertChannelError(404, "not_found", "unknown alert channel");
  return rowToChannel(r);
}

/** Add a Telegram channel: a bot token and a chat id. The token goes to the vault before the row is written. */
export async function createChannel(env: AlertEnv, actor: string, body: Record<string, unknown>, allowedTopics: readonly string[]): Promise<AlertChannel> {
  if (!env.ALERT_VAULT) throw new AlertChannelError(503, "vault_unavailable", "the alert vault is not bound");
  const name = validName(body.name);
  const chat = validChat(body.chat_id);
  const token = validToken(body.bot_token);
  const topics = validTopics(body.topics, allowedTopics);
  const enabled = body.enabled !== false;
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM alert_channels").first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_CHANNELS) throw new AlertChannelError(409, "too_many_channels", `at most ${MAX_CHANNELS} channels`);
  const id = `alc_${crypto.randomUUID()}`;
  await env.ALERT_VAULT.put(id, token);
  const at = nowIso();
  await env.DB.prepare(`INSERT INTO alert_channels (channel_id, name, kind, chat_id, topics_json, enabled, token_hint, created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, 'telegram', ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, name, chat, JSON.stringify(topics), enabled ? 1 : 0, token.slice(-4), actor, at, actor, at).run();
  await audit(env.DB, actor, "alerts.channel_created", id, { name, chat_id: chat, topics, enabled, token_hint: token.slice(-4) });
  return getChannel(env.DB, id);
}

/** Change a channel: enabled, topics, name, chat id or (write-only) the bot token. The default keeps its bot. */
export async function updateChannel(env: AlertEnv, actor: string, id: string, body: Record<string, unknown>, allowedTopics: readonly string[]): Promise<AlertChannel> {
  const c = await getChannel(env.DB, id);
  const next = { name: c.name, chat: c.chat_id, topics: c.topics, enabled: c.enabled, hint: c.token_hint };
  const changed: string[] = [];
  if (body.name !== undefined) { next.name = validName(body.name); changed.push("name"); }
  if (body.topics !== undefined) { next.topics = validTopics(body.topics, allowedTopics); changed.push("topics"); }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw new AlertChannelError(400, "invalid_enabled", "true or false");
    next.enabled = body.enabled; changed.push("enabled");
  }
  if (body.chat_id !== undefined || body.bot_token !== undefined) {
    if (c.kind === "telegram_default") throw new AlertChannelError(409, "default_channel_fixed", "the default channel uses the xauusd bot; add a channel for another bot");
    if (body.chat_id !== undefined) { next.chat = validChat(body.chat_id); changed.push("chat_id"); }
    if (body.bot_token !== undefined) {
      const token = validToken(body.bot_token);
      if (!env.ALERT_VAULT) throw new AlertChannelError(503, "vault_unavailable", "the alert vault is not bound");
      await env.ALERT_VAULT.put(id, token);
      next.hint = token.slice(-4); changed.push("bot_token");
    }
  }
  if (!changed.length) throw new AlertChannelError(400, "nothing_to_change", "send enabled, topics, name, chat_id or bot_token");
  await env.DB.prepare("UPDATE alert_channels SET name = ?, chat_id = ?, topics_json = ?, enabled = ?, token_hint = ?, updated_by = ?, updated_at = ? WHERE channel_id = ?")
    .bind(next.name, next.chat, JSON.stringify(next.topics), next.enabled ? 1 : 0, next.hint, actor, nowIso(), id).run();
  await audit(env.DB, actor, "alerts.channel_updated", id, { changed, name: next.name, chat_id: next.chat, topics: next.topics, enabled: next.enabled, token_hint: next.hint });
  return getChannel(env.DB, id);
}

/** Remove a channel and its token. The default channel can only be disabled. */
export async function deleteChannel(env: AlertEnv, actor: string, id: string): Promise<{ deleted: true; channel_id: string }> {
  const c = await getChannel(env.DB, id);
  if (c.kind === "telegram_default") throw new AlertChannelError(409, "default_channel_fixed", "the default channel can be disabled, not deleted");
  await env.DB.prepare("DELETE FROM alert_channels WHERE channel_id = ?").bind(id).run();
  if (env.ALERT_VAULT) await env.ALERT_VAULT.delete(id);
  await audit(env.DB, actor, "alerts.channel_deleted", id, { name: c.name, chat_id: c.chat_id });
  return { deleted: true, channel_id: id };
}

export interface AlertMessage { change: string; title: string; lines: string[]; link: string }

/** The message text sent through a channel's own bot (plain text; no markup to escape). */
export function messageText(m: AlertMessage): string {
  const head = m.change === "closed" ? `Resolved: ${m.title}` : m.change === "test" ? m.title : `${m.title}.`;
  return [head, ...m.lines.slice(0, 20).map((l) => `- ${l}`), "", `Console: ${m.link}`].join("\n").slice(0, 3900);
}

/** Send one message through one channel. Never throws; the result is "sent" or "failed: <reason>" (no token in it). */
export async function sendToChannel(env: AlertEnv, c: AlertChannel, m: AlertMessage, fetcher: typeof fetch = fetch): Promise<string> {
  try {
    if (c.kind === "telegram_default") {
      if (typeof env.OWNER_TELEGRAM?.notify !== "function") return "failed: owner_telegram_not_bound";
      const r = await env.OWNER_TELEGRAM.notify({ change: m.change, title: m.title, lines: m.lines.slice(0, 20), link: m.link });
      return r?.sent === true ? "sent" : `failed: ${String(r?.reason ?? "not sent").slice(0, 120)}`;
    }
    const token = await env.ALERT_VAULT?.get(c.channel_id);
    if (!token || !BOT_TOKEN.test(token)) return "failed: bot_token_missing";
    const res = await fetcher(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: c.chat_id, text: messageText(m), disable_web_page_preview: true }),
    });
    const body = await res.json().catch(() => null) as { ok?: boolean; description?: unknown } | null;
    if (res.ok && body?.ok === true) return "sent";
    // Telegram's own description (e.g. "Bad Request: chat not found"); it never contains the token.
    return `failed: telegram_${res.status}${typeof body?.description === "string" ? ` ${body.description.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot***").slice(0, 100)}` : ""}`;
  } catch (err) {
    return `failed: ${String((err as Error)?.message ?? err).replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot***").slice(0, 120)}`;
  }
}

/** Approver: send a test message through one channel, and record the outcome (never the token). */
export async function testChannel(env: AlertEnv, actor: string, id: string, link: string, fetcher: typeof fetch = fetch): Promise<{ channel_id: string; delivery: string }> {
  const c = await getChannel(env.DB, id);
  const delivery = await sendToChannel(env, c, { change: "test", title: `Cryptophys test alert for "${c.name}"`, lines: ["This channel receives: " + (c.topics.join(", ") || "nothing"), c.enabled ? "It is enabled." : "It is disabled: real alerts are not sent to it."], link }, fetcher);
  await appendAuditEvent(env.DB, { event_type: "alerts.channel_tested", actor, subject: `alert_channel:${id}`, outcome: delivery === "sent" ? "succeeded" : "failed", payload: { delivery } });
  return { channel_id: id, delivery };
}

/** The AlertVault Durable Object's logic over its storage (kept out of the class for tests). */
export function vaultOn(storage: { get<T>(k: string): Promise<T | undefined>; put<T>(k: string, v: T): Promise<void>; delete(k: string): Promise<boolean | void> }): AlertVault {
  return {
    async put(id, token) {
      if (!CHANNEL_ID.test(id) || id === DEFAULT_CHANNEL_ID) throw new Error("invalid_channel_id");
      if (!BOT_TOKEN.test(token)) throw new Error("invalid_bot_token");
      await storage.put(`token:${id}`, token);
    },
    async get(id) { return CHANNEL_ID.test(id) ? (await storage.get<string>(`token:${id}`)) ?? null : null; },
    async delete(id) { if (CHANNEL_ID.test(id)) await storage.delete(`token:${id}`); },
  };
}
