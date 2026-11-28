// ADR-0014 §12 (Issue #327 C2; owner 2026-11-28: "Ya Kerjakan", on "jadikan autonomous hasil council dikirim ke cerebrum
// untuk ditindak lanjut ... harus selalu segar ada umur kadaluarsa dan ada arsip beserta statusnya"): the progress of an
// evolution intent that another repository builds. The coordinator's review of the design (2026-11-28) is folded in.
//  - POST /v1/evolution/intents/{int_<12 hex>}/progress {state, ref?, note?}: the owner, or a service identity listed in
//    EVOLUTION_PROGRESS_IDENTITIES (empty by default) on an intent assigned to a worker (index.ts checks who).
//  - Only an external intent (target_repo not the platform) in a progress state moves here; the evolver's own intents
//    never do. Forward one step at a time: waiting_external → in_progress → proposed → merged → deployed → closed;
//    refused from any state before closed. The same state again answers changed: false and writes nothing (it does not
//    extend the freshness either); anything else is 409.
//  - A service identity sets in_progress, proposed, merged and refused only. deployed comes from deploy evidence and
//    closed from the owner (or a measurement): 403 for a service.
//  - ref: only on an assigned intent, and only in the assignee's repository: a pull request
//    (https://github.com/<owner>/<name>/pull/<n>) there, or a commit of 7 to 40 hex. note: words only under CT1's rules
//    (≤300 characters, no price, no secret). refused needs a note: the council reads why.
//  - close_code (migration 0092) says why an intent ended, machine-readable: refused, completed (closed after deployed),
//    owner_closed (CT1), expired. state_reason stays the human text.
//  - One batch: the intent's state, state_reason, close_code and expires_at, for a council intent with a proposal id one
//    evolution_updates_v2 row (the return path, council.decisions.read), and the audit event evolution.intent_progress.
//    A lost race writes nothing.
//  - Nothing is executed: no evolutions_v2 row and no Forge change request (ADR-0018 X2 stays held).
//
// Freshness (expireExternalIntents, the kernel's :07 pass): only while the worker is the next actor (queued_external,
// i.e. waiting_external with an assignee, and in_progress). 7 days after the last real change the intent closes with
// close_code expired and the return path says expired, so the council gets the task back. proposed waits on review or
// the owner's merge and never expires; past 7 days it shows as stale (display only). merged and deployed never expire.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { AuditMutationConflictError, appendAuditEventWithMutation } from "../../control-plane-shared/src/audit.ts";
import { normalizeText, textCarriesPrice } from "../../control-plane-shared/src/correction.ts";
import { secretInText } from "../../control-plane-shared/src/conversation.ts";
import { FRESH_MS, PLATFORM_REPO, repoOfAssignee } from "./evolution-intake.ts";
import { INTENT_ID } from "./evolution-close.ts";

export const PROGRESS_EVENT = "evolution.intent_progress";
export const EXPIRE_EVENT = "evolution.intent_expired";
export const PROGRESS_ACTOR_EXPIRY = "agent:supervisor";
export const NOTE_MAX = 300;
/** The forward order of an external intent. */
export const PROGRESS_ORDER = Object.freeze(["waiting_external", "in_progress", "proposed", "merged", "deployed", "closed"] as const);
export type ProgressState = (typeof PROGRESS_ORDER)[number] | "refused";
export const PROGRESS_TARGETS: readonly string[] = Object.freeze([...PROGRESS_ORDER.slice(1), "refused"]);
/** What a service identity may set; deployed and closed are not the worker's to claim. */
export const SERVICE_TARGETS: readonly string[] = Object.freeze(["in_progress", "proposed", "merged", "refused"]);
export const CLOSE_CODES = Object.freeze(["owner_closed", "expired", "refused", "completed"] as const);
export type CloseCode = (typeof CLOSE_CODES)[number];
export const EXPIRED_REASON = "expired: no progress in 7 days; returned to the council";
const SHA = /^[0-9a-f]{7,40}$/;
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,6})$/;
const EXPIRE_LIMIT = 50;

export class EvolutionProgressError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export type NextActor = string;
export interface ProgressResult { intent_id: string; state: string; changed: boolean; update_id: string | null; expires_at: string | null; close_code: string | null; next_actor: NextActor }
export interface ProgressActor { actor: string; owner: boolean }

/** Whether the worker is the next actor, so the intent expires when nothing moves: queued_external and in_progress. */
export const freshnessApplies = (state: string, assignee: string | null): boolean =>
  state === "in_progress" || (state === "waiting_external" && Boolean(assignee));

/**
 * Who acts next on an intent, in one place (the API exposes it; the Console only renders it):
 * queued_external and in_progress → the assignee (an unassigned waiting_external → the owner, to assign or close);
 * proposed → owner/orchestrator (review and merge); merged → deploy; deployed → measurement; closed, refused → none.
 * For an external intent (target_repo not the platform) merged and deployed → owner: nothing but the owner records
 * deployed or closed for another repository today (the coordinator's review, 2026-11-28).
 * `stale` marks a proposed intent unchanged for 7 days (display only: proposed never expires).
 */
export function nextActor(i: { state: string; assignee?: string | null; updated_at?: string | null; target_repo?: string | null }, now = Date.now()): { next_actor: NextActor; stale: boolean } {
  const external = typeof i.target_repo === "string" && i.target_repo !== PLATFORM_REPO;
  const stale = i.state === "proposed" && typeof i.updated_at === "string" && Date.parse(i.updated_at) + FRESH_MS <= now;
  switch (i.state) {
    case "waiting_external": return { next_actor: i.assignee ? i.assignee : "owner", stale: false };
    case "in_progress": return { next_actor: i.assignee ? i.assignee : "owner", stale: false };
    case "proposed": return { next_actor: "owner/orchestrator", stale };
    case "merged": return { next_actor: external ? "owner" : "deploy", stale: false };
    case "deployed": return { next_actor: external ? "owner" : "measurement", stale: false };
    case "closed": case "refused": case "rejected": return { next_actor: "none", stale: false };
    default: return { next_actor: "evolver", stale: false }; // the platform's own intents
  }
}

const missingTable = (err: unknown) => /no such table|no such column/i.test(String((err as Error)?.message ?? err));
const parse = (s: unknown): Record<string, unknown> => {
  try { const v = typeof s === "string" ? JSON.parse(s) : null; return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
};

/** The note, normalised, or the refusal (CT1's rules: words only, ≤300 characters, no price, no secret). */
export function progressNote(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new EvolutionProgressError(400, "invalid_note", "note is a text of at most 300 characters");
  const note = normalizeText(raw);
  if (!note) return null;
  if (note.length > NOTE_MAX) throw new EvolutionProgressError(400, "note_too_long", `note is at most ${NOTE_MAX} characters`);
  if (secretInText(note)) throw new EvolutionProgressError(400, "note_carries_secret", "the note carries a secret; never paste a token or a password");
  if (textCarriesPrice(note)) throw new EvolutionProgressError(400, "note_carries_price", "the note carries a price-like number (3 digits or more); words only");
  return note;
}

/** The reference, only in the assignee's repository: a pull request there, or a commit of 7 to 40 hex. */
export function progressRef(raw: unknown, assignee: string | null): { pr_url: string } | { sha: string } | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new EvolutionProgressError(400, "invalid_ref", "ref is a pull request URL or a commit SHA");
  const repo = assignee ? repoOfAssignee(assignee) : null;
  if (!repo) throw new EvolutionProgressError(400, "ref_repo_not_allowed", "a ref is accepted only on an intent assigned to a worker, in that worker's repository");
  const ref = raw.trim();
  if (SHA.test(ref)) return { sha: ref };
  const m = PR_URL.exec(ref);
  if (!m) throw new EvolutionProgressError(400, "invalid_ref", "ref is https://github.com/<owner>/<repo>/pull/<n> or a commit of 7 to 40 lowercase hex");
  if (m[1].toLowerCase() !== repo.toLowerCase()) throw new EvolutionProgressError(400, "ref_repo_not_allowed", `the pull request must be in ${repo}, the assignee's repository`);
  return { pr_url: ref };
}

/** The next step check: the same state is a replay, one step forward or refused is a move, anything else 409. */
export function checkTransition(from: string, to: string): "replay" | "move" {
  if (from === to) return "replay";
  if (from === "closed" || from === "refused") throw new EvolutionProgressError(409, "intent_terminal", `the intent is ${from}; it does not move again`);
  const i = PROGRESS_ORDER.indexOf(from as never);
  if (i < 0) throw new EvolutionProgressError(409, "not_external_progress", `the intent is ${from}; only an external intent in progress moves here`);
  if (to === "refused" || PROGRESS_ORDER[i + 1] === to) return "move";
  throw new EvolutionProgressError(409, "invalid_transition", `${from} moves to ${PROGRESS_ORDER[i + 1]} or refused, not ${to}`);
}

interface IntentRow { intent_id: string; source: string; source_ref: string; origin_json: string; target_repo: string; state: string; state_reason: string | null; assignee: string | null; expires_at: string | null; close_code: string | null; updated_at: string }
const COLUMNS = "intent_id, source, source_ref, origin_json, target_repo, state, state_reason, assignee, expires_at, close_code, updated_at";

/** The return-path target of a council intent recorded under its proposal id (as CT1 close and the intake). */
function returnPath(row: Pick<IntentRow, "source" | "source_ref" | "origin_json">): { proposal_id: string; origin: string } | null {
  const proposal_id = row.source === "council" && !row.source_ref.startsWith("report:") ? row.source_ref : null;
  const o = parse(row.origin_json).origin;
  return proposal_id && typeof o === "string" && o ? { proposal_id, origin: o } : null;
}

export async function progressExternalIntent(db: D1Database, who: ProgressActor, intentId: string, input: { state?: unknown; ref?: unknown; note?: unknown }, now = Date.now()): Promise<ProgressResult> {
  if (!INTENT_ID.test(intentId)) throw new EvolutionProgressError(404, "intent_not_found", "no such evolution intent");
  if (typeof input.state !== "string" || !PROGRESS_TARGETS.includes(input.state)) {
    throw new EvolutionProgressError(400, "invalid_state", `state is one of ${PROGRESS_TARGETS.join(", ")}`);
  }
  const to = input.state as ProgressState;
  if (!who.owner && !SERVICE_TARGETS.includes(to)) {
    throw new EvolutionProgressError(403, "state_not_for_service", `a service identity sets ${SERVICE_TARGETS.join(", ")}; ${to} is the owner's or the deploy's`);
  }
  const note = progressNote(input.note);
  const read = async (): Promise<IntentRow | null> => {
    try {
      return await db.prepare(`SELECT ${COLUMNS} FROM evolution_intents_v2 WHERE intent_id = ?`).bind(intentId).first<IntentRow>();
    } catch (err) {
      if (missingTable(err)) throw new EvolutionProgressError(503, "not_available", "the evolution tables are not migrated yet (migrations 0077 and 0092)");
      throw err;
    }
  };
  const row = await read();
  if (!row) throw new EvolutionProgressError(404, "intent_not_found", "no such evolution intent");
  if (row.target_repo === PLATFORM_REPO) throw new EvolutionProgressError(409, "not_external", "the platform's own intents move with the evolver, not here");
  // A service identity works only what was assigned to a worker; the owner may move any external intent.
  if (!who.owner && !row.assignee) throw new EvolutionProgressError(403, "not_assigned", "a service identity moves only an intent assigned to a worker");
  const ref = progressRef(input.ref, row.assignee);
  const result = (r: IntentRow, changed: boolean, update_id: string | null): ProgressResult =>
    ({ intent_id: intentId, state: r.state, changed, update_id, expires_at: r.expires_at, close_code: r.close_code, next_actor: nextActor(r, now).next_actor });
  // A replay writes nothing and does not extend the freshness.
  if (checkTransition(row.state, to) === "replay") return result(row, false, null);
  if (to === "refused" && !note) throw new EvolutionProgressError(400, "note_required", "refused carries a note in words: the council reads why");

  const rp = returnPath(row);
  const update_id = rp ? `evu_${crypto.randomUUID()}` : null;
  const at = new Date(now).toISOString();
  const expires_at = freshnessApplies(to, row.assignee) ? new Date(now + FRESH_MS).toISOString() : null;
  const close_code: CloseCode | null = to === "refused" ? "refused" : to === "closed" ? "completed" : null;
  const reason = note ?? to;
  const refs = { intent_id: intentId, ...(ref ?? {}), ...(row.assignee ? { assignee: row.assignee } : {}), ...(close_code ? { close_code } : {}) };
  try {
    await appendAuditEventWithMutation(
      db,
      { event_type: PROGRESS_EVENT, actor: who.actor, subject: `intent:${intentId}`, outcome: to, payload: { intent_id: intentId, proposal_id: rp?.proposal_id ?? null, from: row.state, to, ref: ref ?? null, note, assignee: row.assignee, close_code } },
      () => {
        const move = db.prepare("UPDATE evolution_intents_v2 SET state = ?, state_reason = ?, close_code = ?, expires_at = ?, updated_at = ? WHERE intent_id = ? AND state = ?")
          .bind(to, reason, close_code, expires_at, at, intentId, row.state);
        if (!update_id || !rp) return move;
        return [move, db.prepare(
          `INSERT INTO evolution_updates_v2 (update_id, intent_id, origin, proposal_id, state, reason, refs_json, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
        ).bind(update_id, intentId, rp.origin, rp.proposal_id, to, reason, JSON.stringify(refs), at)];
      },
    );
  } catch (err) {
    if (!(err instanceof AuditMutationConflictError)) throw err;
    const now2 = await read();
    if (now2?.state === to) return result(now2, false, null);
    throw new EvolutionProgressError(409, "invalid_transition", `the intent moved to ${now2?.state ?? "gone"} meanwhile`);
  }
  return result({ ...row, state: to, expires_at, close_code, updated_at: at }, true, update_id);
}

export interface ExpiredIntent { intent_id: string; from: string; update_id: string | null }

/** The freshness pass: every external intent past its expires_at whose worker is still the next actor returns to the council. */
export async function expireExternalIntents(db: D1Database, now = Date.now()): Promise<ExpiredIntent[]> {
  const at = new Date(now).toISOString();
  let rows: IntentRow[];
  try {
    rows = (await db.prepare(
      `SELECT ${COLUMNS} FROM evolution_intents_v2
       WHERE expires_at IS NOT NULL AND expires_at <= ? AND target_repo != ?
         AND (state = 'in_progress' OR (state = 'waiting_external' AND assignee IS NOT NULL))
       ORDER BY expires_at, intent_id LIMIT ${EXPIRE_LIMIT}`,
    ).bind(at, PLATFORM_REPO).all<IntentRow>()).results;
  } catch (err) {
    if (missingTable(err)) return [];
    throw err;
  }
  const out: ExpiredIntent[] = [];
  for (const row of rows) {
    const rp = returnPath(row);
    const update_id = rp ? `evu_${crypto.randomUUID()}` : null;
    try {
      await appendAuditEventWithMutation(
        db,
        { event_type: EXPIRE_EVENT, actor: PROGRESS_ACTOR_EXPIRY, subject: `intent:${row.intent_id}`, outcome: "expired", payload: { intent_id: row.intent_id, proposal_id: rp?.proposal_id ?? null, from: row.state, expires_at: row.expires_at, assignee: row.assignee, close_code: "expired" } },
        () => {
          const close = db.prepare("UPDATE evolution_intents_v2 SET state = 'closed', state_reason = ?, close_code = 'expired', expires_at = NULL, updated_at = ? WHERE intent_id = ? AND state = ? AND expires_at = ?")
            .bind(EXPIRED_REASON, at, row.intent_id, row.state, row.expires_at);
          if (!update_id || !rp) return close;
          return [close, db.prepare(
            `INSERT INTO evolution_updates_v2 (update_id, intent_id, origin, proposal_id, state, reason, refs_json, created_at)
             SELECT ?, ?, ?, ?, 'expired', ?, ?, ? WHERE changes() = 1`,
          ).bind(update_id, row.intent_id, rp.origin, rp.proposal_id, EXPIRED_REASON, JSON.stringify({ intent_id: row.intent_id, ...(row.assignee ? { assignee: row.assignee } : {}), close_code: "expired" }), at)];
        },
      );
    } catch (err) {
      if (err instanceof AuditMutationConflictError) continue; // a progress won the race: the intent is fresh again
      throw err;
    }
    out.push({ intent_id: row.intent_id, from: row.state, update_id });
  }
  return out;
}
