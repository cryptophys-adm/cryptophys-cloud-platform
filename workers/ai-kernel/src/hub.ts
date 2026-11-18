// HAIC push hub (docs/design/HAIC-H0-H1.md §4.5; ADR-0015 phase 1 "push hub DO, WebSocket Hibernation", its minimal
// slice): one ConsoleHub Durable Object in the AI Kernel. The Console forwards one upgrade path, GET /v1/hub, after its
// Access gate and an Origin check; the kernel admits operators. The pure rules are here; worker.ts holds the glue.
//
//   - Server -> client only: {channel, seq, at, kind, data}. The client sends only {op: "subscribe"|"unsubscribe", channel}.
//   - Channels: "inbox" (the owner's inbox changed), "councils" (a council's index row changed) and "council:<session id>"
//     (that council's state or messages changed). Every operator may subscribe to them, as every operator may read them.
//   - An event says only that something changed (a state, a message count): never text, never a price. The page reloads
//     what it shows through its ordinary GET route, so who may read what stays decided in one place.
//   - Deviation from §4.5, smaller: no "conversation:<id>" channel; the chat's POST already returns the answer.
//   - Every owner message stays a POST (CSRF). When the hub is down the pages poll every 5 minutes (ADR-0015 §3).

export const HUB_LIMITS = { max_sockets: 100, max_channels_per_socket: 10, max_client_message_bytes: 512, max_event_bytes: 2_048 } as const;
const COUNCIL_CHANNEL = /^council:cs_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isChannel = (c: unknown): c is string => typeof c === "string" && (c === "inbox" || c === "councils" || COUNCIL_CHANNEL.test(c));

/** What a socket carries across hibernation: who opened it and what it listens to. */
export interface HubAttachment { actor: string; channels: string[] }
export interface HubEvent { channel: string; seq: number; at: string; kind: string; data: Record<string, string | number | boolean | null> }

/**
 * One message from a client. Returns the new attachment and the reply frame (a JSON string), or a reply that closes
 * nothing: a bad message is answered with an error frame, never acted on.
 */
export function handleClientMessage(att: HubAttachment, raw: unknown): { attachment: HubAttachment; reply: string } {
  const err = (code: string) => ({ attachment: att, reply: JSON.stringify({ kind: "error", code }) });
  if (typeof raw !== "string" || raw.length > HUB_LIMITS.max_client_message_bytes) return err("invalid_message");
  let msg: any;
  try { msg = JSON.parse(raw); } catch { return err("invalid_message"); }
  if (!msg || (msg.op !== "subscribe" && msg.op !== "unsubscribe") || !isChannel(msg.channel)) return err("invalid_message");
  const has = att.channels.includes(msg.channel);
  if (msg.op === "subscribe") {
    if (!has && att.channels.length >= HUB_LIMITS.max_channels_per_socket) return err("channel_limit");
    const channels = has ? att.channels : [...att.channels, msg.channel];
    return { attachment: { ...att, channels }, reply: JSON.stringify({ kind: "subscribed", channel: msg.channel }) };
  }
  return { attachment: { ...att, channels: att.channels.filter((c) => c !== msg.channel) }, reply: JSON.stringify({ kind: "unsubscribed", channel: msg.channel }) };
}

/** A server event frame: only a channel, a kind and flat scalar data (no nested text), capped in size. */
export function eventFrame(channel: string, seq: number, kind: string, data: Record<string, unknown>, now = Date.now()): string | null {
  if (!isChannel(channel) || !/^[a-z_]{1,32}$/.test(kind)) return null;
  const flat: HubEvent["data"] = {};
  for (const [k, v] of Object.entries(data)) {
    if (!/^[a-z_]{1,32}$/.test(k)) continue;
    if (typeof v === "number" || typeof v === "boolean" || v === null) flat[k] = v;
    else if (typeof v === "string" && /^[A-Za-z0-9_:.-]{0,64}$/.test(v)) flat[k] = v;
  }
  const frame = JSON.stringify({ channel, seq, at: new Date(now).toISOString(), kind, data: flat } satisfies HubEvent);
  return frame.length <= HUB_LIMITS.max_event_bytes ? frame : null;
}

/** Whether a new socket is admitted: an actor is required, and the hub holds at most max_sockets. */
export const admit = (actor: string | null, open: number): { ok: true } | { ok: false; status: number; code: string } =>
  !actor ? { ok: false, status: 403, code: "forbidden" } : open >= HUB_LIMITS.max_sockets ? { ok: false, status: 503, code: "hub_full" } : { ok: true };

/** What a council's change publishes: its own channel, the councils list, and the inbox when it starts or stops waiting on the owner. */
export function councilEvents(before: { state: string; messages: number } | null, after: { session_id: string; state: string; messages: number }): { channel: string; kind: string; data: Record<string, unknown> }[] {
  if (before && before.state === after.state && before.messages === after.messages) return [];
  const data = { session_id: after.session_id, state: after.state, messages: after.messages };
  const out: { channel: string; kind: string; data: Record<string, unknown> }[] = [{ channel: `council:${after.session_id}`, kind: "council_changed", data }];
  if (!before || before.state !== after.state) out.push({ channel: "councils", kind: "council_changed", data });
  const waits = (s: string | undefined) => s === "awaiting_owner" || s === "proposed";
  if (!before || before.state !== after.state) if (waits(before?.state) || waits(after.state)) out.push({ channel: "inbox", kind: "inbox_changed", data: { source: "council" } });
  return out;
}

/** Publish change signals to the push hub; the hub being down never fails the caller (the pages poll every 5 minutes). */
export async function publishHub(env: { HUB?: { idFromName(name: string): unknown; get(id: unknown): { publish(events: { channel: string; kind: string; data: Record<string, unknown> }[]): Promise<unknown> } } }, events: { channel: string; kind: string; data: Record<string, unknown> }[]): Promise<void> {
  if (!events.length || !env.HUB) return;
  try { await env.HUB.get(env.HUB.idFromName("console")).publish(events); } catch (err) {
    console.error(JSON.stringify({ service: "cryptophys-ai-kernel", event: "hub_publish_failed", message: String((err as Error)?.message ?? err) }));
  }
}

