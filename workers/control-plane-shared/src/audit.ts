import type { D1Database } from "./types.ts";
import { newId, nowIso, redact } from "./http.ts";

/**
 * Append-only, hash-chained audit log stored in `audit_events`.
 *
 * Each event commits to the previous event's hash. Migration 0003 adds a UNIQUE
 * index on `previous_hash`, so two concurrent writers cannot both extend the same
 * head: the loser gets a constraint error and retries against the new head. The
 * chain therefore stays linear without a separate lock.
 */

export const GENESIS_HASH = "GENESIS";
const MAX_PAYLOAD_CHARS = 16 * 1024;
const MAX_APPEND_ATTEMPTS = 25;

export interface AuditInput {
  event_type: string;
  actor: string;
  subject: string;
  outcome: string;
  payload?: unknown;
}

export interface AuditEvent {
  event_id: string;
  event_type: string;
  actor: string;
  subject: string;
  outcome: string;
  payload_json: string;
  previous_hash: string;
  event_hash: string;
  created_at: string;
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function computeEventHash(e: Omit<AuditEvent, "event_hash">): Promise<string> {
  return sha256Hex(canonicalJson({
    event_id: e.event_id,
    event_type: e.event_type,
    actor: e.actor,
    subject: e.subject,
    outcome: e.outcome,
    payload_json: e.payload_json,
    previous_hash: e.previous_hash,
    created_at: e.created_at,
  }));
}

function isUniqueViolation(err: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String((err as Error)?.message ?? err));
}

export async function chainHead(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT event_hash FROM audit_events ORDER BY rowid DESC LIMIT 1").first<{ event_hash: string }>();
  return row?.event_hash ?? GENESIS_HASH;
}

export async function appendAuditEvent(db: D1Database, input: AuditInput): Promise<AuditEvent> {
  let payload = canonicalJson(redact(input.payload ?? {}));
  if (payload.length > MAX_PAYLOAD_CHARS) payload = canonicalJson({ truncated: true, original_chars: payload.length });
  for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt++) {
    const base = {
      event_id: newId("evt"),
      event_type: input.event_type,
      actor: input.actor,
      subject: input.subject,
      outcome: input.outcome,
      payload_json: payload,
      previous_hash: await chainHead(db),
      created_at: nowIso(),
    };
    const event: AuditEvent = { ...base, event_hash: await computeEventHash(base) };
    try {
      await db.prepare(
        `INSERT INTO audit_events (event_id, event_type, actor, subject, outcome, payload_json, previous_hash, event_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(event.event_id, event.event_type, event.actor, event.subject, event.outcome, event.payload_json,
        event.previous_hash, event.event_hash, event.created_at).run();
      return event;
    } catch (err) {
      if (!isUniqueViolation(err) || attempt === MAX_APPEND_ATTEMPTS) throw err;
      // Another writer extended the head first; back off with jitter and re-read it.
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5 * attempt)));
    }
  }
  throw new Error("audit append failed");
}

export interface ChainVerification {
  valid: boolean;
  events_checked: number;
  head_hash: string;
  first_invalid_event_id: string | null;
  reason: string | null;
}

/** Re-computes every hash in insertion order and checks each link to its predecessor. */
export async function verifyAuditChain(db: D1Database, pageSize = 500): Promise<ChainVerification> {
  let expectedPrevious = GENESIS_HASH;
  let checked = 0;
  let lastRowId = 0;
  for (;;) {
    const page = await db.prepare(
      `SELECT rowid AS rid, event_id, event_type, actor, subject, outcome, payload_json, previous_hash, event_hash, created_at
       FROM audit_events WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`,
    ).bind(lastRowId, pageSize).all<AuditEvent & { rid: number }>();
    for (const row of page.results) {
      const fail = (reason: string): ChainVerification =>
        ({ valid: false, events_checked: checked, head_hash: expectedPrevious, first_invalid_event_id: row.event_id, reason });
      if (row.previous_hash !== expectedPrevious) return fail("previous_hash does not link to the preceding event");
      const recomputed = await computeEventHash(row);
      if (recomputed !== row.event_hash) return fail("event_hash does not match event contents");
      expectedPrevious = row.event_hash;
      lastRowId = row.rid;
      checked++;
    }
    if (page.results.length < pageSize) break;
  }
  return { valid: true, events_checked: checked, head_hash: expectedPrevious, first_invalid_event_id: null, reason: null };
}
