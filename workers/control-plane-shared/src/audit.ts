import type { D1Database, D1PreparedStatement } from "./types.ts";
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

type AuditMutation = (event: AuditEvent) => D1PreparedStatement;

async function appendAuditEventInternal(db: D1Database, input: AuditInput, mutation?: AuditMutation): Promise<AuditEvent> {
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
      const insert = db.prepare(
        `INSERT INTO audit_events (event_id, event_type, actor, subject, outcome, payload_json, previous_hash, event_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(event.event_id, event.event_type, event.actor, event.subject, event.outcome, event.payload_json,
        event.previous_hash, event.event_hash, event.created_at);
      // D1 batch is transactional: a companion state mutation and its audit event either both commit or neither does.
      await db.batch(mutation ? [mutation(event), insert] : [insert]);
      return event;
    } catch (err) {
      if (!isUniqueViolation(err) || attempt === MAX_APPEND_ATTEMPTS) throw err;
      // Another writer extended the head first; the batch rolls back and we retry against the new head.
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5 * attempt)));
    }
  }
  throw new Error("audit append failed");
}

export async function appendAuditEvent(db: D1Database, input: AuditInput): Promise<AuditEvent> {
  return appendAuditEventInternal(db, input);
}

/** Atomically commit a state mutation with its corresponding hash-chained audit event. */
export async function appendAuditEventWithMutation(
  db: D1Database,
  input: AuditInput,
  mutation: AuditMutation,
): Promise<AuditEvent> {
  return appendAuditEventInternal(db, input, mutation);
}

export interface ChainVerification {
  valid: boolean;
  events_checked: number;
  head_hash: string;
  first_invalid_event_id: string | null;
  reason: string | null;
}

interface ChainStart { rowid: number; hash: string; checked: number }
interface Checkpoint { last_rowid: number; event_id: string; event_hash: string; events_checked: number }

/** Re-computes every hash in insertion order and checks each link to its predecessor. */
export async function verifyAuditChain(db: D1Database, pageSize = 500, start?: ChainStart): Promise<ChainVerification & { last_rowid?: number; last_event_id?: string | null }> {
  let expectedPrevious = start?.hash ?? GENESIS_HASH;
  let checked = start?.checked ?? 0;
  let lastRowId = start?.rowid ?? 0;
  let lastEventId: string | null = null;
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
      lastEventId = row.event_id;
      checked++;
    }
    if (page.results.length < pageSize) break;
  }
  const result = { valid: true, events_checked: checked, head_hash: expectedPrevious, first_invalid_event_id: null, reason: null, last_rowid: lastRowId, last_event_id: lastEventId };
  // A full pass that succeeded re-anchors the checkpoint (best effort: the table exists from 0025).
  if (!start && lastEventId) await saveCheckpoint(db, { last_rowid: lastRowId, event_id: lastEventId, event_hash: expectedPrevious, events_checked: checked }, "full");
  return result;
}

async function saveCheckpoint(db: D1Database, c: Checkpoint, mode: "full" | "incremental"): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO audit_checkpoints (id, last_rowid, event_id, event_hash, events_checked, verified_at, mode) VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_rowid = excluded.last_rowid, event_id = excluded.event_id, event_hash = excluded.event_hash,
         events_checked = excluded.events_checked, verified_at = excluded.verified_at, mode = excluded.mode
       WHERE excluded.last_rowid >= audit_checkpoints.last_rowid`,
    ).bind(c.last_rowid, c.event_id, c.event_hash, c.events_checked, new Date().toISOString(), mode).run();
  } catch {
    // Before migration 0025 the table does not exist; verification results are unaffected.
  }
}

/**
 * Fast chain check for hot paths (consensus evidence). Starts from the last verified
 * checkpoint, confirms that checkpointed event is still byte-identical (its stored hash and
 * its recomputed hash), then verifies only newer events and advances the checkpoint. Falls
 * back to a full verification when there is no checkpoint. Full verifications still run in
 * the Audit Ledger, the auditor agent and every deploy verification.
 */
export async function verifyAuditChainIncremental(db: D1Database): Promise<ChainVerification> {
  let cp: Checkpoint | null = null;
  try {
    cp = await db.prepare("SELECT last_rowid, event_id, event_hash, events_checked FROM audit_checkpoints WHERE id = 1").first<Checkpoint>();
  } catch {
    cp = null;
  }
  if (!cp) return verifyAuditChain(db);
  const anchor = await db.prepare(
    `SELECT event_id, event_type, actor, subject, outcome, payload_json, previous_hash, event_hash, created_at FROM audit_events WHERE rowid = ?`,
  ).bind(cp.last_rowid).first<AuditEvent>();
  if (!anchor || anchor.event_id !== cp.event_id || anchor.event_hash !== cp.event_hash || (await computeEventHash(anchor)) !== cp.event_hash) {
    return { valid: false, events_checked: 0, head_hash: cp.event_hash, first_invalid_event_id: cp.event_id, reason: "checkpointed event changed since it was verified" };
  }
  const result = await verifyAuditChain(db, 500, { rowid: cp.last_rowid, hash: cp.event_hash, checked: cp.events_checked });
  if (result.valid && result.last_event_id) {
    await saveCheckpoint(db, { last_rowid: result.last_rowid!, event_id: result.last_event_id, event_hash: result.head_hash, events_checked: result.events_checked }, "incremental");
  }
  return { valid: result.valid, events_checked: result.events_checked, head_hash: result.head_hash, first_invalid_event_id: result.first_invalid_event_id, reason: result.reason };
}
