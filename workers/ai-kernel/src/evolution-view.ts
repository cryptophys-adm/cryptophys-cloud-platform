// ADR-0014 §11, docs/design/EVOLVER.md §3, §7 and step V2: the evolution intake's read view and the evolver's kill switch.
//  - GET /v1/evolution: the switch, the intents (newest first), the attempts and the counts by state. Read-only.
//  - POST /v1/evolution/mode {mode, confirm, reason}: "off" is a brake any operator may pull (like suspending an agent or
//    the shadow brake); "on" needs the owner, a person in APPROVER_IDENTITIES, with the confirmation "EVOLVER ON".
//    Every change is audited as evolution.mode_changed in the same statement as the update.
// Before migration 0076 the view answers available: false and the switch reads "off".
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { AuditMutationConflictError, appendAuditEventWithMutation } from "../../control-plane-shared/src/audit.ts";
import { nextActor } from "./evolution-progress.ts";

export const EVOLVER_MODES = ["on", "off"] as const;
export type EvolverMode = (typeof EVOLVER_MODES)[number];
export const EVOLVER_ON_CONFIRMATION = "EVOLVER ON";
const LIST_LIMIT = 50;
/** Issue #327 C3: the audit events that make an intent's history (the archive), oldest first. */
export const HISTORY_EVENTS = Object.freeze(["evolution.intent_recorded", "evolution.intent_progress", "evolution.intent_expired", "evolution.intent_closed"] as const);
const HISTORY_LIMIT = 100;
const LAST_LIMIT = 400;

export class EvolverModeError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

const missingTable = (err: unknown) => /no such table/i.test(String((err as Error)?.message ?? err));
const parse = (s: unknown, fallback: unknown) => { try { return typeof s === "string" ? JSON.parse(s) : fallback; } catch { return fallback; } };

export interface EvolverControl { mode: EvolverMode; updated_by: string | null; updated_at: string | null }

/** The evolver's switch. "off" when the table or its row is missing: a missing switch never runs the evolver. */
export async function evolverMode(db: D1Database): Promise<EvolverControl> {
  try {
    const row = await db.prepare("SELECT value, updated_by, updated_at FROM evolver_controls WHERE control = 'mode'").first<{ value: string; updated_by: string; updated_at: string }>();
    if (row && (EVOLVER_MODES as readonly string[]).includes(row.value)) return { mode: row.value as EvolverMode, updated_by: row.updated_by, updated_at: row.updated_at };
  } catch (err) {
    if (!missingTable(err)) throw err;
  }
  return { mode: "off", updated_by: null, updated_at: null };
}

// Issue #327 C2: each intent also carries assignee, expires_at and close_code (migration 0092), and next_actor and stale
// from nextActor (evolution-progress.ts), so the Console renders them and never derives them itself.
export async function evolutionView(db: D1Database, now = Date.now()): Promise<Record<string, unknown>> {
  try {
    const intents = await db.prepare(
      `SELECT intent_id, source, source_ref, origin_json, target_repo, title, spec, evidence_refs_json, state, state_reason, evolution_id, created_at, updated_at,
         assignee, expires_at, close_code
       FROM evolution_intents_v2 ORDER BY created_at DESC, rowid DESC LIMIT ${LIST_LIMIT}`,
    ).all<Record<string, unknown>>();
    const evolutions = await db.prepare(
      `SELECT evolution_id, intent_id, state, branch, base_sha, head_sha, cr_id, merge_sha, deploy_ref, model, ai_calls, changed_lines, files_json, refusals_json, started_at, ended_at
       FROM evolutions_v2 ORDER BY started_at DESC, rowid DESC LIMIT ${LIST_LIMIT}`,
    ).all<Record<string, unknown>>();
    const counts = await db.prepare("SELECT state, count(*) AS n FROM evolution_intents_v2 GROUP BY state").all<{ state: string; n: number }>();
    // Issue #327 C3: each listed intent's last step (time, actor, ref, note) from its audit history, one indexed query.
    const subjects = intents.results.map((r) => `intent:${String(r.intent_id)}`);
    const last = new Map<string, HistoryStep>();
    if (subjects.length) {
      const ev = await db.prepare(
        `SELECT subject, event_type, actor, outcome, payload_json, created_at FROM audit_events
         WHERE subject IN (${subjects.map(() => "?").join(", ")}) AND event_type IN (${HISTORY_EVENTS.map(() => "?").join(", ")})
         ORDER BY created_at DESC LIMIT ${LAST_LIMIT}`,
      ).bind(...subjects, ...HISTORY_EVENTS).all<AuditRow>();
      for (const e of ev.results) if (!last.has(e.subject)) last.set(e.subject, step(e));
    }
    return {
      available: true,
      control: await evolverMode(db),
      counts: Object.fromEntries(counts.results.map((c) => [c.state, Number(c.n)])),
      intents: intents.results.map(({ origin_json, evidence_refs_json, ...r }) => ({
        ...r, origin: parse(origin_json, {}), evidence_refs: parse(evidence_refs_json, []),
        ...nextActor(r as { state: string; assignee: string | null; updated_at: string; target_repo: string }, now),
        last_update: last.get(`intent:${String(r.intent_id)}`) ?? null,
      })),
      evolutions: evolutions.results.map(({ files_json, refusals_json, ...r }) => ({ ...r, files: parse(files_json, []), refusals: parse(refusals_json, []) })),
    };
  } catch (err) {
    if (missingTable(err)) return { available: false, control: { mode: "off", updated_by: null, updated_at: null }, counts: {}, intents: [], evolutions: [] };
    throw err;
  }
}

/** Set the evolver's switch. `owner` is whether the caller is the owner (a person in APPROVER_IDENTITIES). */
export async function setEvolverMode(db: D1Database, modeRaw: unknown, actor: string, owner: boolean, confirmRaw: unknown, reasonRaw: unknown): Promise<EvolverControl & { changed: boolean }> {
  const mode = String(modeRaw ?? "") as EvolverMode;
  if (!(EVOLVER_MODES as readonly string[]).includes(mode)) throw new EvolverModeError(400, "invalid_mode", "mode must be on or off");
  const reason = typeof reasonRaw === "string" && reasonRaw.trim() ? reasonRaw.trim().slice(0, 300) : null;
  let current: EvolverControl;
  try {
    const row = await db.prepare("SELECT value FROM evolver_controls WHERE control = 'mode'").first<{ value: string }>();
    if (!row) throw new EvolverModeError(503, "not_available", "the evolver switch does not exist yet (migration 0076)");
    current = await evolverMode(db);
  } catch (err) {
    if (missingTable(err)) throw new EvolverModeError(503, "not_available", "the evolver switch does not exist yet (migration 0076)");
    throw err;
  }
  if (mode === current.mode) return { ...current, changed: false };
  if (mode === "on") {
    if (!owner) throw new EvolverModeError(403, "owner_required", "turning the evolver on needs the owner");
    if (confirmRaw !== EVOLVER_ON_CONFIRMATION) throw new EvolverModeError(400, "confirmation_required", `turning the evolver on requires the exact confirmation ${EVOLVER_ON_CONFIRMATION}`);
  }
  try {
    const event = await appendAuditEventWithMutation(
      db,
      { event_type: "evolution.mode_changed", actor, subject: "evolver", outcome: mode, payload: { previous: current.mode, mode, reason } },
      (e) => db.prepare("UPDATE evolver_controls SET value = ?, updated_by = ?, updated_at = ? WHERE control = 'mode' AND value = ?").bind(mode, actor, e.created_at, current.mode),
    );
    return { mode, updated_by: actor, updated_at: event.created_at, changed: true };
  } catch (err) {
    if (err instanceof AuditMutationConflictError) throw new EvolverModeError(409, "mode_changed_concurrently", "the evolver switch changed while this request was in progress; reload and retry");
    throw err;
  }
}

interface AuditRow { subject: string; event_type: string; actor: string; outcome: string; payload_json: string; created_at: string }
/** One step of an intent's history: what happened, who, and its ref and words (validated when written; never a price). */
export interface HistoryStep { at: string; event: string; actor: string; state: string; from: string | null; ref: Record<string, string> | null; note: string | null }

function step(e: AuditRow): HistoryStep {
  const p = parse(e.payload_json, {}) as Record<string, unknown>;
  const ref = p.ref && typeof p.ref === "object" && !Array.isArray(p.ref)
    ? Object.fromEntries(Object.entries(p.ref as Record<string, unknown>).filter(([k, v]) => (k === "pr_url" || k === "sha") && typeof v === "string")) as Record<string, string>
    : null;
  // The words: a progress note, or the owner's close reason (the intake's reason is a code, not words).
  const words = typeof p.note === "string" ? p.note : e.event_type === "evolution.intent_closed" && typeof p.reason === "string" ? p.reason : null;
  const state = e.event_type === "evolution.intent_expired" ? "expired" : e.event_type === "evolution.intent_closed" ? "closed" : e.outcome;
  return { at: e.created_at, event: e.event_type.replace("evolution.intent_", ""), actor: e.actor, state, from: typeof p.from === "string" ? p.from : null, ref: ref && Object.keys(ref).length ? ref : null, note: words };
}

/**
 * Issue #327 C3, GET /v1/evolution/intents/{id} (operators read): one intent with its next actor and its full history,
 * oldest first, from the audit trail on intent:<id> (recorded, progress, expired, closed). Read only.
 */
export async function intentDetail(db: D1Database, intentId: string, now = Date.now()): Promise<Record<string, unknown> | null> {
  try {
    const r = await db.prepare(
      `SELECT intent_id, source, source_ref, origin_json, target_repo, title, spec, evidence_refs_json, state, state_reason, evolution_id, created_at, updated_at,
         assignee, expires_at, close_code FROM evolution_intents_v2 WHERE intent_id = ?`,
    ).bind(intentId).first<Record<string, unknown>>();
    if (!r) return null;
    const ev = await db.prepare(
      `SELECT subject, event_type, actor, outcome, payload_json, created_at FROM audit_events
       WHERE subject = ? AND event_type IN (${HISTORY_EVENTS.map(() => "?").join(", ")}) ORDER BY created_at, rowid LIMIT ${HISTORY_LIMIT}`,
    ).bind(`intent:${intentId}`, ...HISTORY_EVENTS).all<AuditRow>();
    const { origin_json, evidence_refs_json, ...rest } = r;
    return {
      available: true,
      intent: { ...rest, origin: parse(origin_json, {}), evidence_refs: parse(evidence_refs_json, []), ...nextActor(r as { state: string; assignee: string | null; updated_at: string; target_repo: string }, now) },
      history: ev.results.map(step),
    };
  } catch (err) {
    if (missingTable(err)) return { available: false, intent: null, history: [] };
    throw err;
  }
}
