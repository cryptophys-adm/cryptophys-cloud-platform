// Ledger anchors outside D1 (owner 2026-11-20, "4a semuanya"; ADR-0021 "Tamper evidence"). Once per UTC day this
// Worker writes the head of each hash-chained ledger to the R2 bucket cryptophys-ledger-anchors, whose bucket lock
// keeps every object for 3 years: nobody can delete or overwrite it during that time, the owner included. Each
// anchor is also submitted to OpenTimestamps (Bitcoin-anchored, free), and the calendars' pending proofs are stored
// next to it as .ots files that `ots upgrade` / `ots verify` read.
//
// Two sources:
//  - the platform's own audit_events chain: its head after an incremental verification (audit.ts);
//  - xauusd's signal ledger: the head xauusd publishes as a ledger_anchor.v1 report (reports.publish, kind
//    xauusd_digest). xauusd holds no binding to the bucket, so it can neither read nor delete an anchor: it can
//    only publish a head, which this module writes once per day and ledger.
// Never throws; a failure is audited as ledger.anchor_failed. An anchor already written for the day is never
// rewritten (the lock would refuse it anyway).
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent, verifyAuditChainIncremental } from "../../control-plane-shared/src/audit.ts";

export interface AnchorBucket {
  head(key: string): Promise<unknown | null>;
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
}
export interface AnchorEnv { DB: D1Database; ANCHORS?: AnchorBucket }
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export const ANCHOR_SCHEMA = "ledger_anchor.v1";
export const ANCHOR_BUCKET = "cryptophys-ledger-anchors";
/** The bucket lock's retention (set on the bucket, not here): 3 years. */
export const ANCHOR_RETENTION_DAYS = 1095;
/** OpenTimestamps public calendars; each answers a digest with a pending timestamp (ots/calendar.py). */
export const OTS_CALENDARS: ReadonlyArray<readonly [string, string]> = [["a", "https://a.pool.opentimestamps.org"], ["b", "https://b.pool.opentimestamps.org"]];
/** The detached timestamp file's magic (opentimestamps DetachedTimestampFile.HEADER_MAGIC). */
export const OTS_MAGIC = Uint8Array.from([0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94]);
const OTS_VERSION = 0x01;
const OTS_SHA256 = 0x08;
/** A published xauusd head is anchored when it is at most this old. */
const XAUUSD_WINDOW_MS = 26 * 3_600_000;
const ACTOR = "cryptophys-recovery-manager";
const HEX64 = /^[0-9a-f]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LEDGER = /^[a-z][a-z0-9_]{2,39}$/;

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const cat = (...parts: Uint8Array[]) => { const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let a = 0; for (const p of parts) { o.set(p, a); a += p.length; } return o; };

/** A detached .ots file for a SHA-256 digest and a calendar's answer (the serialized timestamp of that digest). */
export function otsFile(digest: Uint8Array, calendarAnswer: Uint8Array): Uint8Array {
  if (digest.length !== 32) throw new Error("digest_must_be_32_bytes");
  return cat(OTS_MAGIC, Uint8Array.of(OTS_VERSION, OTS_SHA256), digest, calendarAnswer);
}

interface Anchor { key: string; source: string; body: Record<string, unknown> }

/** The platform audit chain's anchor for the day, after an incremental verification of the chain. */
async function platformAnchor(db: D1Database, day: string, at: string): Promise<Anchor> {
  const v = await verifyAuditChainIncremental(db);
  const head = await db.prepare("SELECT event_id, event_hash, created_at FROM audit_events ORDER BY rowid DESC LIMIT 1")
    .first<{ event_id: string; event_hash: string; created_at: string }>();
  const count = await db.prepare("SELECT count(*) AS n FROM audit_events").first<{ n: number }>();
  return {
    key: `platform/audit_events/${day}.json`, source: "platform.audit_events",
    body: {
      schema: ANCHOR_SCHEMA, source: "platform.audit_events", day, anchored_at: at,
      head_event_id: head?.event_id ?? null, head_hash: head?.event_hash ?? null, head_created_at: head?.created_at ?? null,
      events: count?.n ?? 0, chain_valid: v.valid, chain_reason: v.reason, first_invalid_event_id: v.first_invalid_event_id,
    },
  };
}

/** xauusd's newest published heads (one per ledger and day), from ledger_anchor.v1 reports of the last 26 hours. */
async function xauusdAnchors(db: D1Database, nowMs: number, at: string): Promise<Anchor[]> {
  const since = new Date(nowMs - XAUUSD_WINDOW_MS).toISOString();
  const rows = (await db.prepare(
    `SELECT report_id, agent_id, body_json, created_at FROM agent_reports WHERE kind = 'xauusd_digest' AND created_at > ? ORDER BY created_at DESC LIMIT 50`,
  ).bind(since).all<{ report_id: string; agent_id: string; body_json: string; created_at: string }>()).results ?? [];
  const out = new Map<string, Anchor>();
  for (const r of rows) {
    let b: Record<string, unknown>;
    try { b = JSON.parse(r.body_json); } catch { continue; }
    if (!b || typeof b !== "object" || b.schema !== ANCHOR_SCHEMA) continue;
    const { ledger, day, head_hash, events } = b as { ledger?: unknown; day?: unknown; head_hash?: unknown; events?: unknown };
    if (typeof ledger !== "string" || !LEDGER.test(ledger) || typeof day !== "string" || !DAY.test(day) || typeof head_hash !== "string" || !HEX64.test(head_hash)
      || typeof events !== "number" || !Number.isInteger(events) || events < 0) continue;
    if (!r.agent_id.startsWith("xauusd-")) continue;
    const key = `xauusd/${ledger}/${day}.json`;
    if (out.has(key)) continue; // newest first: the newest report for a ledger and day wins
    out.set(key, { key, source: `xauusd.${ledger}`, body: { schema: ANCHOR_SCHEMA, source: `xauusd.${ledger}`, day, anchored_at: at, head_hash, events, report_id: r.report_id, agent_id: r.agent_id, reported_at: r.created_at } });
  }
  return [...out.values()];
}

/** Submits a digest to each OpenTimestamps calendar; returns the calendars that answered and their .ots files. */
async function timestamp(digest: Uint8Array, fetchFn: Fetch): Promise<{ ok: Array<[string, Uint8Array]>; failed: string[] }> {
  const ok: Array<[string, Uint8Array]> = [];
  const failed: string[] = [];
  for (const [label, base] of OTS_CALENDARS) {
    try {
      const res = await fetchFn(`${base}/digest`, {
        method: "POST", body: digest, signal: AbortSignal.timeout(10_000),
        headers: { Accept: "application/vnd.opentimestamps.v1", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "cryptophys-ledger-anchor" },
      });
      if (!res.ok) { failed.push(`${label}:${res.status}`); continue; }
      const answer = new Uint8Array(await res.arrayBuffer());
      if (answer.length < 2 || answer.length > 10_000) { failed.push(`${label}:bad_answer`); continue; }
      ok.push([label, otsFile(digest, answer)]);
    } catch {
      failed.push(`${label}:unreachable`);
    }
  }
  return { ok, failed };
}

/**
 * Hourly from the scheduled handler: writes each source's anchor for the UTC day once, with its OpenTimestamps
 * proofs, and audits it (ledger.anchor_written). Returns what it did; never throws.
 */
export async function anchorTick(env: AnchorEnv, nowMs = Date.now(), fetchFn: Fetch = fetch as unknown as Fetch): Promise<Record<string, unknown>> {
  const bucket = env.ANCHORS;
  if (!bucket || typeof bucket.put !== "function") return { outcome: "not_configured" };
  const at = new Date(nowMs).toISOString();
  const day = at.slice(0, 10);
  const written: string[] = [];
  const skipped: string[] = [];
  try {
    const candidates: Anchor[] = [];
    if (!(await bucket.head(`platform/audit_events/${day}.json`))) candidates.push(await platformAnchor(env.DB, day, at));
    else skipped.push(`platform/audit_events/${day}.json`);
    for (const a of await xauusdAnchors(env.DB, nowMs, at)) {
      if (await bucket.head(a.key)) skipped.push(a.key); else candidates.push(a);
    }
    for (const a of candidates) {
      const bytes = enc.encode(JSON.stringify(a.body));
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      await bucket.put(a.key, bytes, { httpMetadata: { contentType: "application/json" }, customMetadata: { sha256: hex(digest), schema: ANCHOR_SCHEMA } });
      const ots = await timestamp(digest, fetchFn);
      for (const [label, file] of ots.ok) await bucket.put(`${a.key}.${label}.ots`, file, { httpMetadata: { contentType: "application/octet-stream" } });
      await appendAuditEvent(env.DB, {
        event_type: "ledger.anchor_written", actor: ACTOR, subject: a.key, outcome: a.body.chain_valid === false ? "chain_invalid" : "written",
        payload: { key: a.key, source: a.source, sha256: hex(digest), head_hash: a.body.head_hash ?? null, events: a.body.events ?? null, ots: ots.ok.map(([l]) => l), ots_failed: ots.failed },
      }).catch(() => undefined);
      written.push(a.key);
    }
    return { outcome: written.length ? "written" : "not_due", written, skipped };
  } catch (e) {
    const message = String((e as Error)?.message ?? e).replace(/[^\x20-\x7e]/g, "?").slice(0, 300);
    await appendAuditEvent(env.DB, { event_type: "ledger.anchor_failed", actor: ACTOR, subject: ANCHOR_BUCKET, outcome: "failed", payload: { message, written } }).catch(() => undefined);
    return { outcome: "failed", message, written };
  }
}
