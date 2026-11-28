// ADR-0014 §11 (owner via the coordinator, 2026-11-25: "CT1 closed not supported"): the owner closes an evolution intent
// that waits for another repository (state waiting_external) with a reason, and the reason reaches the council that handed
// the task off through the return path council.decisions.read (xauusd-moderator reads it).
//  - POST /v1/evolution/intents/{int_<12 hex>}/close {reason}: the owner only (index.ts checks it).
//  - The reason is words only: 1..300 characters after normalizeText, never a price-like number (the shared PRICE rule of
//    correction.ts) and never a secret; it is stored normalised.
//  - One batch: the intent's state (only from waiting_external), for a council intent with a proposal id one
//    evolution_updates_v2 row, and the audit event evolution.intent_closed. A close that lost a race writes nothing.
//  - An intent already closed answers changed: false and writes nothing; any other state is 409 not_waiting_external.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { AuditMutationConflictError, appendAuditEventWithMutation } from "../../control-plane-shared/src/audit.ts";
import { normalizeText, textCarriesPrice } from "../../control-plane-shared/src/correction.ts";
import { secretInText } from "../../control-plane-shared/src/conversation.ts";

export const INTENT_ID = /^int_[0-9a-f]{12}$/;
export const CLOSE_REASON_MAX = 300;
export const CLOSE_EVENT = "evolution.intent_closed";

export class EvolutionCloseError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export interface CloseResult { intent_id: string; state: "closed"; changed: boolean; update_id: string | null }

const missingTable = (err: unknown) => /no such table/i.test(String((err as Error)?.message ?? err));
const parse = (s: unknown): Record<string, unknown> => {
  try { const v = typeof s === "string" ? JSON.parse(s) : null; return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
};

/** The close reason, normalised, or the refusal. */
export function closeReason(raw: unknown): string {
  if (typeof raw !== "string") throw new EvolutionCloseError(400, "invalid_reason", "reason is a text of 1 to 300 characters");
  const reason = normalizeText(raw);
  if (!reason) throw new EvolutionCloseError(400, "invalid_reason", "reason is a text of 1 to 300 characters");
  if (reason.length > CLOSE_REASON_MAX) throw new EvolutionCloseError(400, "reason_too_long", `reason is at most ${CLOSE_REASON_MAX} characters`);
  // A secret first: a token usually carries digit runs too, and "carries a price" would misname it.
  if (secretInText(reason)) throw new EvolutionCloseError(400, "reason_carries_secret", "the reason carries a secret; never paste a token or a password");
  if (textCarriesPrice(reason)) throw new EvolutionCloseError(400, "reason_carries_price", "the reason carries a price-like number (3 digits or more); words only");
  return reason;
}

interface IntentRow { intent_id: string; source: string; source_ref: string; origin_json: string; state: string }

export async function closeExternalIntent(db: D1Database, actor: string, intentId: string, reasonRaw: unknown, now = Date.now()): Promise<CloseResult> {
  if (!INTENT_ID.test(intentId)) throw new EvolutionCloseError(404, "intent_not_found", "no such evolution intent");
  const reason = closeReason(reasonRaw);
  const read = async (): Promise<IntentRow | null> => {
    try {
      return await db.prepare("SELECT intent_id, source, source_ref, origin_json, state FROM evolution_intents_v2 WHERE intent_id = ?").bind(intentId).first<IntentRow>();
    } catch (err) {
      if (missingTable(err)) throw new EvolutionCloseError(503, "not_available", "the evolution tables do not exist yet (migration 0077)");
      throw err;
    }
  };
  const row = await read();
  if (!row) throw new EvolutionCloseError(404, "intent_not_found", "no such evolution intent");
  const unchanged: CloseResult = { intent_id: intentId, state: "closed", changed: false, update_id: null };
  if (row.state === "closed") return unchanged;
  if (row.state !== "waiting_external") throw new EvolutionCloseError(409, "not_waiting_external", `the intent is ${row.state}; only a waiting_external intent is closed here`);

  const origin = parse(row.origin_json);
  // A council intent recorded under its proposal id reaches the council's origin (council.decisions.read); one recorded
  // under its report (no proposal id) has nothing the council could match, as at intake.
  const proposal_id = row.source === "council" && !row.source_ref.startsWith("report:") ? row.source_ref : null;
  const originName = typeof origin.origin === "string" && origin.origin ? origin.origin : null;
  const update_id = proposal_id && originName ? `evu_${crypto.randomUUID()}` : null;
  const at = new Date(now).toISOString();
  try {
    await appendAuditEventWithMutation(
      db,
      { event_type: CLOSE_EVENT, actor, subject: `intent:${intentId}`, outcome: "closed", payload: { intent_id: intentId, proposal_id, reason } },
      () => {
        // Issue #327: close_code owner_closed (migration 0092); expires_at cleared, a closed intent never expires.
        const close = db.prepare("UPDATE evolution_intents_v2 SET state = 'closed', state_reason = ?, close_code = 'owner_closed', expires_at = NULL, updated_at = ? WHERE intent_id = ? AND state = 'waiting_external'")
          .bind(reason, at, intentId);
        if (!update_id) return close;
        // Only when the close above changed the intent: a lost race inserts no update, and the audit row then fails too.
        return [close, db.prepare(
          `INSERT INTO evolution_updates_v2 (update_id, intent_id, origin, proposal_id, state, reason, refs_json, created_at)
           SELECT ?, ?, ?, ?, 'closed', ?, ?, ? WHERE changes() = 1`,
        ).bind(update_id, intentId, originName, proposal_id, reason, JSON.stringify({ intent_id: intentId, close_code: "owner_closed" }), at)];
      },
    );
  } catch (err) {
    if (!(err instanceof AuditMutationConflictError)) throw err;
    // Another close (or the intent's own move) won: nothing of this request was written.
    const now2 = await read();
    if (now2?.state === "closed") return unchanged;
    throw new EvolutionCloseError(409, "not_waiting_external", `the intent is ${now2?.state ?? "gone"}; only a waiting_external intent is closed here`);
  }
  return { intent_id: intentId, state: "closed", changed: true, update_id };
}
