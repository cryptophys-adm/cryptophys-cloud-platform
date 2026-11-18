import { useEffect, useRef, useState } from "react";
import { MOUNT, ROUTES } from "./api";

/**
 * HAIC push hub (docs/design/HAIC-H0-H1.md §4.5): one WebSocket per page to the kernel's ConsoleHub, through the
 * Console's same-origin upgrade path (route kernel.hub). The server sends change signals only ({channel, seq, at, kind,
 * data}); a page reloads what it shows through its ordinary GET routes. The client sends only subscribe and
 * unsubscribe. When the socket is down it reconnects with a growing delay (2 s to 60 s), and the pages keep their slow
 * poll (ADR-0015 §3), so nothing depends on the hub being up.
 */
export type HubStatus = "live" | "connecting" | "offline";
export interface HubEvent { channel: string; seq: number; at: string; kind: string; data: Record<string, unknown> }
type Listener = (e: HubEvent) => void;

const listeners = new Map<string, Set<Listener>>();
const statusSubs = new Set<(s: HubStatus) => void>();
let ws: WebSocket | null = null;
let status: HubStatus = "offline";
let retry = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const DELAYS_S = [2, 5, 15, 30, 60];

function hubUrl(): string {
  const r = ROUTES["kernel.hub"];
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${MOUNT}/api/${r.service}${r.path}`;
}
function setStatus(s: HubStatus) { status = s; for (const f of statusSubs) f(s); }
function send(o: unknown) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function schedule() {
  if (!listeners.size) return;
  clearTimeout(timer);
  timer = setTimeout(connect, DELAYS_S[Math.min(retry++, DELAYS_S.length - 1)] * 1000);
}
function connect() {
  if (ws || typeof WebSocket === "undefined" || !listeners.size) return;
  setStatus("connecting");
  let sock: WebSocket;
  try { sock = new WebSocket(hubUrl()); } catch { setStatus("offline"); schedule(); return; }
  ws = sock;
  sock.onopen = () => { retry = 0; setStatus("live"); for (const ch of listeners.keys()) send({ op: "subscribe", channel: ch }); };
  sock.onmessage = (m) => {
    let e: any;
    try { e = JSON.parse(String(m.data)); } catch { return; }
    if (e && typeof e.channel === "string" && typeof e.seq === "number") listeners.get(e.channel)?.forEach((l) => l(e as HubEvent));
  };
  sock.onclose = () => { if (ws === sock) ws = null; setStatus("offline"); schedule(); };
  sock.onerror = () => { try { sock.close(); } catch { /* closing */ } };
}

/** Listen to hub channels; `onEvent` runs on every change signal of them. Returns the socket's status for the page. */
export function useHub(channels: string[], onEvent: (e: HubEvent) => void): HubStatus {
  const [s, setS] = useState<HubStatus>(status);
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const key = channels.join(" ");
  useEffect(() => {
    statusSubs.add(setS);
    const l: Listener = (e) => cb.current(e);
    for (const ch of channels) {
      if (!listeners.has(ch)) { listeners.set(ch, new Set()); send({ op: "subscribe", channel: ch }); }
      listeners.get(ch)!.add(l);
    }
    connect();
    return () => {
      statusSubs.delete(setS);
      for (const ch of channels) {
        const set = listeners.get(ch);
        set?.delete(l);
        if (set && !set.size) { listeners.delete(ch); send({ op: "unsubscribe", channel: ch }); }
      }
      if (!listeners.size) { clearTimeout(timer); const sock = ws; ws = null; try { sock?.close(1000, "no listeners"); } catch { /* closed */ } setStatus("offline"); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return s;
}

/** A refresh that runs at most once per `ms` for a burst of signals. */
export function useDebounced(fn: () => void, ms = 700): () => void {
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const f = useRef(fn);
  f.current = fn;
  useEffect(() => () => clearTimeout(t.current), []);
  return () => { clearTimeout(t.current); t.current = setTimeout(() => f.current(), ms); };
}

export const hubLabel = (s: HubStatus) => (s === "live" ? "live" : "reloads every 5 min");
