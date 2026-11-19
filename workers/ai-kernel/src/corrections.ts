// HAIC H3b (docs/design/HAIC-H3.md §4–§5; owner 2026-11-19, every recommended default accepted): the corrections ledger.
// An owner's rating or correction of one agent output, built by the correction.v1 contract (control-plane-shared/src/
// correction.ts) and stored in D1 `corrections` (migration 0084).
//
// - Never refused for its content: buildCorrection redacts, masks and truncates; only its structural errors (no target,
//   no subject, nothing to learn, a parameter key) are refused, as 400. No cap, rate limit or power mode applies to
//   recording one (the learning mandate, control-plane-shared/src/power-mode.ts).
// - Dedup (§4.3): when the actor's newest earlier row on the same target has the same dedup_sha256, that row is returned
//   with deduplicated: true and nothing is written. Up, down, up is three rows; the newest counts.
// - Append-only: this module never updates or deletes a row. A changed judgement is a new row whose supersedes names the
//   actor's previous row on that target.
// - Audited (§4.5): correction.recorded (atomically with the row), correction.deduplicated, correction.secret_redacted.
//   The payload never holds the text, which stays in body_json.
// - It changes no parameter, weight, proposal or gate: it writes the corrections table and the audit chain only.
import { appendAuditEvent, appendAuditEventWithMutation } from "../../control-plane-shared/src/audit.ts";
import { CHAT_MODEL, CHAT_SERVICE } from "../../control-plane-shared/src/conversation.ts";
import {
  CORRECTION_SIDES, buildCorrection, forbiddenCorrectionKeys, type Correction, type CorrectionContext, type CorrectionInput,
} from "../../control-plane-shared/src/correction.ts";
import type { D1Database } from "../../control-plane-shared/src/types.ts";

export class CorrectionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

/** Who records: decided by the caller's authentication, never by the input. */
export interface RecordContext {
  actor: string;
  owner: boolean;
  attested_by: CorrectionContext["attested_by"];
  /** The record's time; now by default. The Q8 backfill passes the original rating's time. */
  now?: string;
  /** Q8 backfill: the conversation.rated audit event this row was read from (body_json.backfilled, .backfill_event). */
  backfill_event?: string;
}
export interface Recorded { correction: Correction; deduplicated: boolean }
/** A ledger row as the API returns it: the correction.v1 record, plus `backfilled: true` on a Q8 backfill row. */
export type LedgerCorrection = Correction & { backfilled?: true };

const LIST_MAX = 200;
const LIST_DEFAULT = 50;

/** cor_ and 16 hex characters from the platform's random source. */
export function newCorrectionId(): string {
  return `cor_${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
/** A model id as a correction subject: its last path segment (the contract's subject has no "/" or "@"). */
export function modelSubject(model: string | null | undefined): string {
  const last = (model || CHAT_MODEL).split("/").pop() ?? "";
  return `model:${last.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 100) || "unknown"}`;
}
/** The ev: ref of one chat turn (§3, the sources table). */
export const turnRef = (conversationId: string, n: number) => `ev:platform/conversation/${conversationId}#turn_${n}`;

const ledgerBody = (bodyJson: string): LedgerCorrection => {
  const { backfilled, backfill_event: _e, ...c } = JSON.parse(bodyJson) as Correction & { backfilled?: boolean; backfill_event?: string };
  return (backfilled ? { ...c, backfilled: true } : c) as LedgerCorrection;
};
/** §4.5: what the audit chain holds of a correction. Never its text. */
const auditPayload = (c: Correction) => ({
  correction_id: c.correction_id, label: c.label, rating: c.rating, category: c.category, target_ref: c.target.ref,
  subject: c.target.subject, weight: c.weight, content_sha256: c.content_sha256, redactions: c.redactions,
});

/** Record one correction (§4.4): built by the contract, deduplicated, appended and audited. Throws CorrectionError(400) for a structural error only. */
export async function recordCorrection(db: D1Database, input: CorrectionInput, ctx: RecordContext): Promise<Recorded> {
  const now = ctx.now ?? new Date().toISOString();
  const base = { actor: ctx.actor, owner: ctx.owner, attested_by: ctx.attested_by, now, correction_id: newCorrectionId() };
  let built = await buildCorrection(input, base);
  if (!built.ok) throw new CorrectionError(400, "invalid_request", built.error);
  // The actor's newest row on this target at or before this record's time (the dedup index's actor, the target index).
  const prev = await db.prepare(
    "SELECT correction_id, dedup_sha256, body_json FROM corrections WHERE target_ref = ? AND actor = ? AND created_at <= ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).bind(built.correction.target.ref, ctx.actor, now).first<{ correction_id: string; dedup_sha256: string; body_json: string }>();
  if (prev && prev.dedup_sha256 === built.correction.dedup_sha256) {
    const existing = ledgerBody(prev.body_json);
    // A backfill re-read of a repeated rating writes nothing, not even a dedup event (the backfill's own summary counts it).
    if (!ctx.backfill_event) {
      await appendAuditEvent(db, { event_type: "correction.deduplicated", actor: ctx.actor, subject: `correction:${existing.correction_id}`, outcome: "deduplicated", payload: auditPayload(existing) });
    }
    return { correction: existing, deduplicated: true };
  }
  if (prev && (input.supersedes === undefined || input.supersedes === null)) {
    built = await buildCorrection({ ...input, supersedes: prev.correction_id }, base);
    if (!built.ok) throw new CorrectionError(400, "invalid_request", built.error);
  }
  const c = built.correction;
  const body = JSON.stringify(ctx.backfill_event ? { ...c, backfilled: true, backfill_event: ctx.backfill_event } : c);
  await appendAuditEventWithMutation(db, { event_type: "correction.recorded", actor: ctx.actor, subject: `correction:${c.correction_id}`, outcome: c.label, payload: { ...auditPayload(c), ...(ctx.backfill_event ? { backfilled: true } : {}) } },
    () => db.prepare(
      `INSERT INTO corrections (correction_id, side, source, label, rating, category, target_ref, subject, body_json, actor, attested_by, weight, supersedes, content_sha256, dedup_sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(c.correction_id, c.side, c.source, c.label, c.rating, c.category, c.target.ref, c.target.subject, body, c.actor, c.attested_by, c.weight, c.supersedes, c.content_sha256, c.dedup_sha256, c.created_at));
  if (c.redactions.includes("secret")) {
    await appendAuditEvent(db, { event_type: "correction.secret_redacted", actor: ctx.actor, subject: `correction:${c.correction_id}`, outcome: "redacted", payload: { correction_id: c.correction_id, target_ref: c.target.ref } });
  }
  return { correction: ctx.backfill_event ? { ...c, backfilled: true } as LedgerCorrection : c, deduplicated: false };
}

export interface CorrectionFilters { subject?: string | null; target?: string | null; side?: string | null; since?: string | null; limit?: number | null }

/** GET /v1/corrections: the ledger, newest first, at most 200, filtered by subject, target ref, side and time. */
export async function listCorrections(db: D1Database, f: CorrectionFilters = {}): Promise<{ schema: "corrections.v1"; corrections: LedgerCorrection[] }> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.subject) { where.push("subject = ?"); args.push(f.subject); }
  if (f.target) { where.push("target_ref = ?"); args.push(f.target); }
  if (f.side) {
    if (!CORRECTION_SIDES.includes(f.side as never)) throw new CorrectionError(400, "invalid_request", "side is cerebrum or nexus");
    where.push("side = ?"); args.push(f.side);
  }
  if (f.since) {
    if (Number.isNaN(Date.parse(f.since))) throw new CorrectionError(400, "invalid_request", "since is an ISO time");
    where.push("created_at >= ?"); args.push(new Date(f.since).toISOString());
  }
  const limit = Number.isInteger(f.limit) && (f.limit as number) > 0 ? Math.min(f.limit as number, LIST_MAX) : LIST_DEFAULT;
  const rows = (await db.prepare(
    `SELECT body_json FROM corrections ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).bind(...args, limit).all<{ body_json: string }>()).results ?? [];
  return { schema: "corrections.v1", corrections: rows.map((r) => ledgerBody(r.body_json)) };
}

/** POST /v1/corrections: the owner's body into a contract input. `target` or the flat target_ref, subject, as_of (§7.1). */
export function correctionInputFromBody(body: Record<string, unknown>): CorrectionInput {
  const t = body.target && typeof body.target === "object" && !Array.isArray(body.target) ? body.target as Record<string, unknown> : null;
  return {
    side: body.side ?? "cerebrum", source: body.source, label: body.label, rating: body.rating, category: body.category, text: body.text,
    evidence_refs: body.evidence_refs, supersedes: body.supersedes,
    target: t ? { ref: t.ref, subject: t.subject, as_of: t.as_of } : { ref: body.target_ref, subject: body.subject, as_of: body.as_of },
  };
}

// ---------------------------------------------------------------- H3c: council and proposal corrections, reject reasons
//
// HAIC H3c (docs/design/HAIC-H3.md §3, §11 step 3; owner 2026-11-19, "Setuju semua rekomendasi"). The owner corrects a
// council's message, claim or option, or a typed proposal; an owner's free-text reject reason on a typed proposal or a
// knowledge review is recorded as an owner_decision (Q6, weight 1). This module reads what it corrects as plain values
// handed in by the caller: it never imports the council, typed-proposal, knowledge, consensus, policy-parameter,
// autonomy-dial or executor modules (test corrections-boundary-h3), and it writes only the corrections table and the
// audit chain, through recordCorrection.

/**
 * The council's moderator, whose synthesis holds the options (§3: subject agent:<moderator>). ai-kernel/src/council.ts
 * names it MODERATOR; it is not imported from there (that module writes drafts), and test H3c-9 keeps the two equal.
 */
export const COUNCIL_MODERATOR_SUBJECT = "agent:auditor";
/** The ev: ref of a council message, claim or option (§3). The ref grammar allows no "-" in a field: opt-2 is option_opt_2. */
export const councilRef = (sessionId: string, field: string) => `ev:platform/council/${sessionId}#${field}`;
export const proposalRef = (proposalId: string) => `ev:platform/typed_proposal/${proposalId}`;
export const knowledgeRef = (proposalId: string) => `ev:platform/knowledge/${proposalId}`;

/** What a council correction reads of a council (GET /v1/councils/{id}): its id and its messages. */
export interface CouncilView {
  session: { session_id: string };
  messages: { seq: number; at: string; author: string; phase: string; claims?: unknown[] | null; options?: { option_id: string }[] | null }[];
}
/** What a proposal correction reads of a typed proposal (GET /v1/proposals/{id}): its id, its time and its origin. */
export interface ProposalView { proposal_id: string; created_at: string; body: { origin?: { source?: unknown } | null } | null }

const bad = (message: string) => new CorrectionError(400, "invalid_request", message);
/**
 * The judgement in a correction body: what the owner says, never where it points (that comes from the record itself). A
 * parameter or price key anywhere in the body is refused, as the contract refuses it in a record (§4.1).
 */
function judgement(body: Record<string, unknown>) {
  const forbidden = forbiddenCorrectionKeys(body, "body");
  if (forbidden.length) throw bad(`forbidden_key: ${forbidden[0]}`);
  return { rating: body.rating, category: body.category, text: body.text, evidence_refs: body.evidence_refs };
}

/**
 * POST /v1/councils/{id}/corrections: the owner corrects one message ({seq}), one of its claims ({seq, claim}, the
 * claim's 0-based index) or one option of the newest synthesis ({option_id}). A target that does not exist is a 400; a
 * council in any state, expired or closed included, is corrected all the same (a correction is never refused for it).
 * Only an agent's output is corrected: an owner's or a system message has no agent subject.
 */
export async function recordCouncilCorrection(db: D1Database, council: CouncilView, body: Record<string, unknown>, ctx: RecordContext): Promise<Recorded> {
  const id = council.session.session_id;
  const msgs = Array.isArray(council.messages) ? council.messages : [];
  let target: { ref: string; subject: string; as_of: string | null };
  if (body.option_id !== undefined) {
    if (body.seq !== undefined || body.claim !== undefined) throw bad("name a message (seq, and claim for one of its claims) or an option (option_id), not both");
    const optionId = body.option_id;
    if (typeof optionId !== "string" || !/^[a-z0-9-]{1,40}$/.test(optionId)) throw bad("option_id is an option's id");
    // The newest synthesis is the one whose options the owner picks from (as pickOption reads it).
    const synth = [...msgs].reverse().find((m) => m.phase === "synthesis");
    if (!synth || !Array.isArray(synth.options) || !synth.options.some((o) => o?.option_id === optionId)) throw bad("no such option");
    target = { ref: councilRef(id, `option_${optionId.replace(/-/g, "_")}`), subject: synth.author, as_of: synth.at };
  } else {
    if (body.seq === undefined) throw bad("a council correction names a message (seq), a claim (seq and claim) or an option (option_id)");
    if (!Number.isInteger(body.seq) || (body.seq as number) < 1) throw bad("seq is a message's number");
    const m = msgs.find((x) => x.seq === body.seq);
    if (!m) throw bad("no such message");
    if (!/^agent:[A-Za-z0-9_.:-]{1,100}$/.test(m.author)) throw bad("only an agent's message is corrected");
    let field = `seq_${m.seq}`;
    if (body.claim !== undefined) {
      const claims = Array.isArray(m.claims) ? m.claims : [];
      if (!Number.isInteger(body.claim) || (body.claim as number) < 0 || (body.claim as number) >= claims.length) throw bad("no such claim");
      field += `.claim_${body.claim}`;
    }
    target = { ref: councilRef(id, field), subject: m.author, as_of: m.at };
  }
  return recordCorrection(db, { side: "cerebrum", source: "council", ...judgement(body), target }, ctx);
}

/** A typed proposal's subject (§3): the council's moderator for a council's pick, the chat model for a chat directive. */
export const proposalSubject = (p: ProposalView): string => (p.body?.origin?.source === "chat" ? modelSubject(CHAT_MODEL) : COUNCIL_MODERATOR_SUBJECT);

/** POST /v1/proposals/{id}/corrections: the owner corrects a typed proposal, in any state (the route reads it, 404 when missing). */
export function recordProposalCorrection(db: D1Database, p: ProposalView, body: Record<string, unknown>, ctx: RecordContext): Promise<Recorded> {
  return recordCorrection(db, { side: "cerebrum", source: "typed_proposal", ...judgement(body), target: { ref: proposalRef(p.proposal_id), subject: proposalSubject(p), as_of: p.created_at } }, ctx);
}

/**
 * Q6: an owner's free-text reject reason is recorded as an owner_decision (weight 1, LABEL_WEIGHT). No reason, no
 * record. The reject stands whatever happens here: a failure is logged without the text, never thrown (as rateTurn).
 */
export async function recordRejectReason(db: D1Database, r: { source: "typed_proposal" | "knowledge_review"; ref: string; subject: string; as_of: string | null; reason: string | null }, ctx: RecordContext): Promise<string | null> {
  if (!r.reason) return null;
  try {
    const out = await recordCorrection(db, { side: "cerebrum", source: r.source, label: "owner_decision", text: r.reason, target: { ref: r.ref, subject: r.subject, as_of: r.as_of } }, ctx);
    return out.correction.correction_id;
  } catch (err) {
    console.error(JSON.stringify({ service: CHAT_SERVICE, event: "reject_reason_correction_failed", source: r.source, ref: r.ref, message: String((err as Error)?.message ?? err).slice(0, 200) }));
    return null;
  }
}

// ---------------------------------------------------------------- Q8: the one-off backfill of existing chat ratings

export const BACKFILL_DONE_EVENT = "correction.backfill_done";
export const BACKFILL_ACTOR = "system:corrections-backfill";
const BACKFILL_PAGE = 200;
const BACKFILL_MAX = 1_000;
export interface BackfillReport { read: number; recorded: number; deduplicated: number; skipped: number; complete: boolean }

/**
 * Q8 ("yes, once"): every conversation.rated audit event written before H3b (its payload has no correction_id) becomes
 * an owner_rating correction with source chat_rating, its original time and body_json.backfilled: true. Idempotent: an
 * event already backfilled (body_json.backfill_event) is skipped, a repeat of the same rating is deduplicated, and a
 * rating recorded live since H3b (correction_id in its payload) is never read again. At most 1,000 events a run.
 * A repeat is found in audit order (the previous rating of the same actor on the same turn in this run, backfilled
 * or not), never by time alone: ratings written in the same millisecond would otherwise compare with a later row.
 */
export async function backfillChatRatings(db: D1Database): Promise<BackfillReport> {
  const report: BackfillReport = { read: 0, recorded: 0, deduplicated: 0, skipped: 0, complete: true };
  let after = 0;
  // The last rating read in this run per actor and turn, in audit order.
  const last = new Map<string, string>();
  for (;;) {
    const page = (await db.prepare(
      "SELECT rowid AS rid, event_id, actor, subject, outcome, payload_json, created_at FROM audit_events WHERE event_type = 'conversation.rated' AND rowid > ? ORDER BY rowid LIMIT ?",
    ).bind(after, BACKFILL_PAGE).all<{ rid: number; event_id: string; actor: string; subject: string; outcome: string; payload_json: string; created_at: string }>()).results ?? [];
    for (const ev of page) {
      after = ev.rid;
      if (report.read >= BACKFILL_MAX) { report.complete = false; return report; }
      report.read += 1;
      let p: { conversation_id?: unknown; turn?: unknown; correction_id?: unknown };
      try { p = JSON.parse(ev.payload_json); } catch { report.skipped += 1; continue; }
      const id = typeof p.conversation_id === "string" ? p.conversation_id : "";
      const n = p.turn;
      if (typeof p.correction_id === "string" || !/^cnv_[0-9a-f]{16}$/.test(id) || !Number.isInteger(n) || (ev.outcome !== "up" && ev.outcome !== "down")) { report.skipped += 1; continue; }
      const ref = turnRef(id, n as number);
      const key = `${ev.actor}\n${ref}`;
      const done = await db.prepare("SELECT 1 AS x FROM corrections WHERE target_ref = ? AND json_extract(body_json, '$.backfill_event') = ? LIMIT 1").bind(ref, ev.event_id).first();
      if (done) { last.set(key, ev.outcome); report.skipped += 1; continue; }
      if (last.get(key) === ev.outcome) { report.deduplicated += 1; continue; }
      // The rated turn's own audit event names its model and the time of the answer (the turn record lives in its DO).
      const turn = await db.prepare(
        "SELECT payload_json, created_at FROM audit_events WHERE subject = ? AND event_type = 'conversation.turn' AND json_extract(payload_json, '$.turn') = ? ORDER BY rowid LIMIT 1",
      ).bind(ev.subject, n).first<{ payload_json: string; created_at: string }>();
      let model: string | null = null;
      try { const tp = turn ? JSON.parse(turn.payload_json) : null; model = typeof tp?.model === "string" ? tp.model : null; } catch { model = null; }
      try {
        const r = await recordCorrection(db, {
          side: "cerebrum", source: "chat_rating", label: "owner_rating", rating: ev.outcome,
          target: { ref, subject: modelSubject(model), as_of: turn?.created_at ?? null },
        }, { actor: `owner:${ev.actor}`, owner: true, attested_by: "cerebrum_access", now: ev.created_at, backfill_event: ev.event_id });
        if (r.deduplicated) report.deduplicated += 1; else report.recorded += 1;
        last.set(key, ev.outcome);
      } catch (err) {
        if (!(err instanceof CorrectionError)) throw err;
        report.skipped += 1;
      }
    }
    if (page.length < BACKFILL_PAGE) return report;
  }
}

/** The scheduled hook: runs the backfill until one complete run, then never again (the correction.backfill_done audit event). */
export async function backfillChatRatingsOnce(db: D1Database): Promise<BackfillReport | null> {
  const done = await db.prepare("SELECT 1 AS x FROM audit_events WHERE event_type = ? LIMIT 1").bind(BACKFILL_DONE_EVENT).first();
  if (done) return null;
  const report = await backfillChatRatings(db);
  if (report.complete) await appendAuditEvent(db, { event_type: BACKFILL_DONE_EVENT, actor: BACKFILL_ACTOR, subject: "corrections:backfill", outcome: "done", payload: report });
  return report;
}
