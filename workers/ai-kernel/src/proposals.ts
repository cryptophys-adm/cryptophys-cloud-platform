// HAIC H2 (ADR-0017 H2; owner answers of 2026-11-18): typed proposals, stored and handed off. A draft comes from a
// council's pick (council.ts) or, with H2b, from an owner's chat directive. Only the owner confirms or rejects it
// (Cerebrum only). A confirmed proposal goes its kind's way (control-plane-shared/src/typed-proposal.ts HANDOFF_PATH):
//   - policy_parameter -> handoff_pending; the Supervisor proposes set_policy_parameter to consensus at its next cycle
//     (supervisor.ts), and the proposal records the consensus proposal id;
//   - repository_task -> an evolution intent (evolution_intents_v2, source owner, queued) for the evolver;
//   - vision_kpi -> handed to the orchestrator (organism/vision.json is a guard path the evolver refuses by design);
//   - shadow_arm -> an evolution intent waiting on xauusd and one return-path update (evolution_updates_v2, origin
//     xauusd) that council.decisions.read serves with the draft, so xauusd pulls it and runs the shadow arm itself.
// This module never proposes to consensus, never executes, and writes only its own table and those hand-off rows.
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { DRAFT_WINDOW_MS, HANDOFF_PATH, TP_SCHEMA, isProposalId, validateTypedProposal, whatHappens, type TpKind, type TypedProposal } from "../../control-plane-shared/src/typed-proposal.ts";

export class ProposalError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const iso = (ms: number) => new Date(ms).toISOString();
const hex12 = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
const audit = (db: D1Database, type: string, actor: string, id: string, outcome: string, payload: Record<string, unknown>) =>
  appendAuditEvent(db, { event_type: `proposal.${type}`, actor, subject: `proposal:${id}`, outcome, payload: { proposal_id: id, ...payload } as never });

export interface ProposalRow {
  proposal_id: string; kind: TpKind; state: string; title: string; origin_source: string; origin_ref: string; body_json: string; created_by: string;
  created_at: string; updated_at: string; expires_at: string; decided_by: string | null; decided_at: string | null; handoff_path: string | null; handoff_ref: string | null; reason: string | null;
}
const present = (r: ProposalRow) => {
  let body: TypedProposal | null = null;
  try { body = JSON.parse(r.body_json); } catch { body = null; }
  const { body_json: _omit, ...rest } = r;
  return { ...rest, body, what_happens: whatHappens(r.kind) };
};

/** Store a validated draft. Returns the validation errors instead when it is not a valid typed_proposal.v1. */
export async function insertDraft(db: D1Database, tp: TypedProposal, createdBy: string, now = Date.now()): Promise<{ ok: true; proposal_id: string } | { ok: false; errors: string[] }> {
  const errors = validateTypedProposal(tp);
  if (errors.length) {
    await audit(db, "draft_invalid", createdBy, tp.proposal_id ?? "unknown", "invalid", { kind: tp.kind ?? null, origin: tp.origin ?? null, errors: errors.slice(0, 10) });
    return { ok: false, errors };
  }
  await db.prepare(`INSERT INTO typed_proposals (proposal_id, kind, state, title, origin_source, origin_ref, body_json, created_by, created_at, updated_at, expires_at)
    VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`).bind(tp.proposal_id, tp.kind, tp.title, tp.origin.source, tp.origin.ref, JSON.stringify(tp), createdBy, iso(now), iso(now), iso(now + DRAFT_WINDOW_MS)).run();
  await audit(db, "drafted", createdBy, tp.proposal_id, "draft", { kind: tp.kind, origin: tp.origin, evidence_refs: tp.evidence_refs.length });
  return { ok: true, proposal_id: tp.proposal_id };
}

/** GET /v1/proposals: the newest 50, with what each kind does once confirmed. */
export async function listTypedProposals(db: D1Database) {
  try {
    const rows = (await db.prepare("SELECT * FROM typed_proposals ORDER BY created_at DESC LIMIT 50").all<ProposalRow>()).results ?? [];
    return { schema: "typed_proposals.v1", available: true, proposals: rows.map(present) };
  } catch (err) {
    if (/no such table/i.test(String((err as Error)?.message ?? err))) return { schema: "typed_proposals.v1", available: false, proposals: [] };
    throw err;
  }
}

export async function readTypedProposal(db: D1Database, id: string) {
  if (!isProposalId(id)) throw new ProposalError(400, "invalid_request", "a proposal id is tp_ and 16 hex digits");
  const row = await db.prepare("SELECT * FROM typed_proposals WHERE proposal_id = ?").bind(id).first<ProposalRow>();
  if (!row) throw new ProposalError(404, "not_found", "no such proposal");
  return present(row);
}

/** The drafts that wait for the owner, soonest expiry first (owner inbox, H2). Before migration 0082 there are none. */
export async function draftsAwaitingOwner(db: D1Database, now = Date.now()): Promise<{ proposal_id: string; kind: string; title: string; since: string; deadline: string; origin_source: string }[]> {
  try {
    return ((await db.prepare("SELECT proposal_id, kind, title, created_at, expires_at, origin_source FROM typed_proposals WHERE state = 'draft' AND expires_at > ? ORDER BY expires_at LIMIT 50")
      .bind(iso(now)).all<{ proposal_id: string; kind: string; title: string; created_at: string; expires_at: string; origin_source: string }>()).results ?? [])
      .map((r) => ({ proposal_id: r.proposal_id, kind: r.kind, title: r.title, since: r.created_at, deadline: r.expires_at, origin_source: r.origin_source }));
  } catch (err) {
    if (/no such table/i.test(String((err as Error)?.message ?? err))) return [];
    throw err;
  }
}

async function setState(db: D1Database, id: string, state: string, fields: { decided_by?: string; handoff_path?: string | null; handoff_ref?: string | null; reason?: string | null }, now: number) {
  await db.prepare(`UPDATE typed_proposals SET state = ?, updated_at = ?, decided_by = COALESCE(?, decided_by), decided_at = CASE WHEN ? IS NULL THEN decided_at ELSE ? END,
    handoff_path = COALESCE(?, handoff_path), handoff_ref = COALESCE(?, handoff_ref), reason = COALESCE(?, reason) WHERE proposal_id = ?`)
    .bind(state, iso(now), fields.decided_by ?? null, fields.decided_by ?? null, iso(now), fields.handoff_path ?? null, fields.handoff_ref ?? null, fields.reason ?? null, id).run();
}

/** The hand-off of a confirmed proposal, by kind. Returns the new state. */
async function handOff(db: D1Database, tp: TypedProposal, actor: string, now: number): Promise<{ state: string; ref: string | null; reason: string }> {
  if (tp.kind === "policy_parameter") {
    return { state: "handoff_pending", ref: null, reason: "the Supervisor proposes set_policy_parameter at its next cycle" };
  }
  if (tp.kind === "vision_kpi") {
    return { state: "handed_off", ref: null, reason: "the orchestrator changes organism/vision.json (a guard path); the merge needs the owner's click" };
  }
  const intent = `int_${hex12()}`;
  const origin = JSON.stringify({ typed_proposal: tp.proposal_id, origin: tp.origin, kind: tp.kind, confirmed_by: actor });
  if (tp.kind === "repository_task") {
    await db.prepare(`INSERT INTO evolution_intents_v2 (intent_id, source, source_ref, origin_json, target_repo, title, spec, evidence_refs_json, state, state_reason, created_at, updated_at)
      VALUES (?, 'owner', ?, ?, 'platform', ?, ?, ?, 'queued', 'confirmed by the owner (typed proposal)', ?, ?)`)
      .bind(intent, tp.proposal_id, origin, tp.title.slice(0, 300), String(tp.params.spec).slice(0, 8192), JSON.stringify(tp.evidence_refs), iso(now), iso(now)).run();
    return { state: "handed_off", ref: intent, reason: `evolution intent ${intent}, queued for the evolver` };
  }
  // shadow_arm: xauusd pulls it through council.decisions.read; the draft travels in the update's refs (flat, no price).
  await db.prepare(`INSERT INTO evolution_intents_v2 (intent_id, source, source_ref, origin_json, target_repo, title, spec, evidence_refs_json, state, state_reason, created_at, updated_at)
    VALUES (?, 'owner', ?, ?, 'xauusd', ?, ?, ?, 'waiting_external', 'a shadow arm that xauusd runs', ?, ?)`)
    .bind(intent, tp.proposal_id, origin, tp.title.slice(0, 300), tp.rationale.slice(0, 8192), JSON.stringify(tp.evidence_refs), iso(now), iso(now)).run();
  const draft = { kind: tp.kind, target: tp.target, params: tp.params, measurement: tp.measurement, requires: tp.requires };
  await db.prepare("INSERT INTO evolution_updates_v2 (update_id, intent_id, origin, proposal_id, state, reason, refs_json, created_at) VALUES (?, ?, 'xauusd', ?, 'handed_off', ?, ?, ?)")
    .bind(`evu_${crypto.randomUUID()}`, intent, tp.proposal_id, "a shadow arm confirmed by the owner in Cerebrum", JSON.stringify({ intent_id: intent, draft }), iso(now)).run();
  return { state: "handed_off", ref: intent, reason: `handed to xauusd (intent ${intent}); xauusd pulls it through council.decisions.read` };
}

/** The owner confirms (then it is handed off) or rejects a draft. Owner only: the route checks; confirmed here again by state. */
export async function decideProposal(db: D1Database, actor: string, id: string, decision: "confirm" | "reject", reasonRaw: unknown, now = Date.now()) {
  if (!isProposalId(id)) throw new ProposalError(400, "invalid_request", "a proposal id is tp_ and 16 hex digits");
  const row = await db.prepare("SELECT * FROM typed_proposals WHERE proposal_id = ?").bind(id).first<ProposalRow>();
  if (!row) throw new ProposalError(404, "not_found", "no such proposal");
  if (row.state !== "draft") throw new ProposalError(409, "not_a_draft", `the proposal is ${row.state}`);
  if (Date.parse(row.expires_at) <= now) throw new ProposalError(409, "expired", "the draft's 7-day window has passed");
  const reason = typeof reasonRaw === "string" && reasonRaw.trim() ? reasonRaw.trim().slice(0, 500) : null;
  if (decision === "reject") {
    await setState(db, id, "rejected", { decided_by: actor, reason }, now);
    await audit(db, "rejected", actor, id, "rejected", { kind: row.kind, reason });
    return readTypedProposal(db, id);
  }
  let tp: TypedProposal;
  try { tp = JSON.parse(row.body_json); } catch { throw new ProposalError(500, "corrupt", "the stored proposal does not parse"); }
  const errors = validateTypedProposal(tp);
  if (errors.length || tp.schema !== TP_SCHEMA) throw new ProposalError(422, "invalid_proposal", errors.join(", "));
  await setState(db, id, "confirmed", { decided_by: actor, reason }, now);
  await audit(db, "confirmed", actor, id, "confirmed", { kind: tp.kind, path: HANDOFF_PATH[tp.kind], reason });
  const h = await handOff(db, tp, actor, now);
  await setState(db, id, h.state, { handoff_path: HANDOFF_PATH[tp.kind], handoff_ref: h.ref, reason: h.reason }, now);
  await audit(db, h.state === "handed_off" ? "handed_off" : "handoff_pending", actor, id, h.state, { kind: tp.kind, path: HANDOFF_PATH[tp.kind], ref: h.ref });
  return readTypedProposal(db, id);
}

/** Drafts past their window expire (the kernel's :07 pass); nothing else changes. */
export async function expireDrafts(db: D1Database, now = Date.now()): Promise<string[]> {
  let ids: string[] = [];
  try {
    ids = ((await db.prepare("SELECT proposal_id FROM typed_proposals WHERE state = 'draft' AND expires_at <= ? LIMIT 50").bind(iso(now)).all<{ proposal_id: string }>()).results ?? []).map((r) => r.proposal_id);
  } catch (err) {
    if (/no such table/i.test(String((err as Error)?.message ?? err))) return [];
    throw err;
  }
  for (const id of ids) {
    await setState(db, id, "expired", { reason: "not confirmed in 7 days" }, now);
    await audit(db, "expired", "system:proposals", id, "expired", {});
  }
  return ids;
}

/** The Supervisor's side (supervisor.ts): the oldest confirmed policy_parameter waiting for its consensus proposal. */
export async function nextPolicyHandoff(db: D1Database): Promise<{ proposal_id: string; target: string; value: number } | null> {
  try {
    const row = await db.prepare("SELECT proposal_id, body_json FROM typed_proposals WHERE state = 'handoff_pending' AND kind = 'policy_parameter' ORDER BY updated_at LIMIT 1")
      .first<{ proposal_id: string; body_json: string }>();
    if (!row) return null;
    const tp = JSON.parse(row.body_json) as TypedProposal;
    return { proposal_id: row.proposal_id, target: String(tp.target), value: Number(tp.params.value) };
  } catch { return null; }
}
/** Record what consensus did with a policy_parameter hand-off: the proposal id, or why it failed. */
export async function recordPolicyHandoff(db: D1Database, id: string, outcome: { ok: true; consensus_id: string } | { ok: false; reason: string }, now = Date.now()) {
  if (outcome.ok) {
    await setState(db, id, "handed_off", { handoff_ref: outcome.consensus_id, reason: `consensus proposal ${outcome.consensus_id}` }, now);
    await audit(db, "handed_off", "agent:supervisor", id, "handed_off", { path: "consensus", ref: outcome.consensus_id });
  } else {
    await setState(db, id, "failed", { reason: outcome.reason.slice(0, 300) }, now);
    await audit(db, "handoff_failed", "agent:supervisor", id, "failed", { path: "consensus", reason: outcome.reason.slice(0, 300) });
  }
}
