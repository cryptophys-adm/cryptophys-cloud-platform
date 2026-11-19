// HAIC H1.5 "Call for Councils" (ADR-0017, docs/design/HAIC-H0-H1.md §4; design approved 2026-11-16, Q6 picks in Cerebrum
// only, Q8 shadow window 14 days and 30 directional outcomes, Q9 agent-raised councils are inbox items the owner starts):
// the shared contract council.v1, pure. Both sides implement it: Cerebrum here, Nexus in the xauusd repository, which
// checks its own output against the JSON fixtures in docs/contracts/council-v1/. A council deliberates and ranks options;
// it never acts, never widens trading autonomy, and ends at most in a proposal draft the owner confirms.
import { TRADING_CAPABILITY } from "./capabilities.ts";

export const COUNCIL_SCHEMAS = {
  session: "council.session.v1", message: "council.message.v1", decision: "council.decision.v1", draft: "typed_proposal.v1",
} as const;

// ---------------------------------------------------------------- lifecycle (§4.6)

export const COUNCIL_STATES = [
  "proposed", "convening", "positions", "rebuttals", "synthesis", "awaiting_owner", "decided", "handed_off", "dismissed", "aborted", "expired",
] as const;
export type CouncilState = (typeof COUNCIL_STATES)[number];
export const TERMINAL_STATES: readonly CouncilState[] = ["handed_off", "dismissed", "aborted", "expired"];
const FLOW: Readonly<Record<CouncilState, readonly CouncilState[]>> = {
  proposed: ["convening", "dismissed"],
  convening: ["positions"],
  positions: ["rebuttals", "synthesis"], // synthesis early: over budget, or nothing to rebut
  rebuttals: ["synthesis"],
  synthesis: ["awaiting_owner"],
  awaiting_owner: ["decided", "dismissed", "expired"],
  decided: ["handed_off"],
  handed_off: [], dismissed: [], aborted: [], expired: [],
};
/** Every running state may abort (an error, the kill switch, the budget, the other side unreachable). */
const ABORTABLE: readonly CouncilState[] = ["convening", "positions", "rebuttals", "synthesis"];
export function canTransition(from: CouncilState, to: CouncilState): boolean {
  return FLOW[from]?.includes(to) || (to === "aborted" && ABORTABLE.includes(from));
}

// ---------------------------------------------------------------- limits (§4.6, Cerebrum; Nexus sets its own, no higher)

export const COUNCIL_LIMITS = {
  max_open_sessions: 2,
  max_started_per_utc_day: 4,
  max_model_calls: 16,
  max_messages: 60,
  max_owner_messages: 20,
  max_message_chars: 1_200,
  max_usd: 0.10,
  min_positions: 3,
  max_rebuttal_targets: 2,
  positions_ms: 10 * 60_000,
  rebuttals_ms: 10 * 60_000,
  synthesis_ms: 5 * 60_000,
  owner_window_ms: 72 * 3_600_000,
  handoff_ack_ms: 24 * 3_600_000,
  proposal_cooldown_ms: 7 * 24 * 3_600_000,
} as const;
/** Q8: a strategy change runs first in shadow for at least this long and this many directional outcomes, whichever is later. */
export const SHADOW_MINIMUM = { days: 14, directional_outcomes: 30 } as const;

// ---------------------------------------------------------------- evidence refs (§4.6)

export const REF_SIDES = ["platform", "xauusd", "aether", "adr", "ssot"] as const;
export interface EvidenceRef { side: (typeof REF_SIDES)[number]; source: string; id: string; as_of: string | null; field: string | null }
const REF = /^ev:(platform|xauusd|aether|adr|ssot)\/(?:([a-z][a-z0-9_.-]{0,63})\/)?([^@#\s]{1,200})(?:@([^#\s]{1,40}))?(?:#([A-Za-z0-9_.]{1,80}))?$/;
/**
 * Fields that would carry a price level: a ref never does (the xauusd resolver drops them, as signals.observe does). A
 * field names a price when its last part is a price word: entry_price, sl, tp2, level, close. sl_share or hit_rate is a
 * measure of outcomes, not a price.
 */
const PRICE_WORDS = /^(price|entry|stoploss|stop|takeprofit|sl|tp\d?|level|bid|ask|open|high|low|close|mid)$/i;
export function parseRef(ref: unknown): EvidenceRef | null {
  if (typeof ref !== "string") return null;
  const m = REF.exec(ref);
  if (!m) return null;
  const [, side, source, id, asOf, field] = m;
  // ev:adr/0017#phases and ev:ssot/<section> name no source: the side is the source.
  return { side: side as EvidenceRef["side"], source: source ?? side, id, as_of: asOf ?? null, field: field ?? null };
}
export const refCarriesPrice = (ref: EvidenceRef) => ref.field !== null && PRICE_WORDS.test(ref.field.split(/[._]/).pop() ?? "");

// ---------------------------------------------------------------- claims and their deterministic check (§4.3 step 5)

export interface Claim { metric: string; value: number | string; unit?: string; window?: string; n?: number; refs: string[]; verified?: boolean }
export type Resolver = (ref: string) => { value: unknown; as_of: string | null } | null;
const same = (a: unknown, b: unknown) => {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (typeof a === "number" && typeof b === "string" && b.trim() !== "" && Number.isFinite(Number(b))) return same(a, Number(b));
  if (typeof b === "number" && typeof a === "string") return same(b, a);
  return a === b;
};
/**
 * A claim is verified when every ref parses, carries no price, resolves, and at least one resolves to the claimed value.
 * Anything else is verified: false (council.claim_unverified); it then adds no confidence to an option.
 */
export function verifyClaim(claim: Claim, resolve: Resolver): boolean {
  if (!Array.isArray(claim.refs) || claim.refs.length === 0) return false;
  let match = false;
  for (const r of claim.refs) {
    const ref = parseRef(r);
    if (!ref || refCarriesPrice(ref)) return false;
    const got = resolve(r);
    if (!got) return false;
    if (same(claim.value, got.value)) match = true;
  }
  return match;
}

// ---------------------------------------------------------------- options and the autonomy guard (§4.4)

export const CHANGE_TYPES = ["shadow_arm", "policy_parameter", "vision_kpi", "repository_task", "no_change"] as const;
export interface CouncilOption {
  option_id: string; rank: number; title: string; hypothesis: string;
  change: { type: (typeof CHANGE_TYPES)[number]; target: string | null; params: Record<string, unknown> };
  expected_effect: { metric: string; from: number | null; to: number | null; window: string } | null;
  risk: { level: "low" | "medium" | "high"; reversible: boolean; notes?: string };
  confidence: number; evidence_refs: string[]; dissent: string[];
}
// Letter boundaries, not \b: in snake_case ("grant_capability", "tier_max") the underscore is a word character.
const AUTONOMY = /(?<![a-z])(autonomy|auto[_-]?arm|tier[_-]?max|capabilit(?:y|ies)|privileged?|live[_-]?armed|ceiling|kill[_-]?switch|agents[_-]?enabled)(?![a-z])/i;
/**
 * A council never widens trading autonomy: an option whose change touches a trading capability, raises an autonomy level
 * or adds a capability is refused before ranking. (A shadow arm of a strategy is not trading: it measures, it never orders.)
 */
export function widensAutonomy(option: Pick<CouncilOption, "change">): string | null {
  const text = JSON.stringify({ target: option.change.target, params: option.change.params });
  if (option.change.type !== "shadow_arm" && TRADING_CAPABILITY.test(text)) return "trading_capability";
  if (AUTONOMY.test(text)) return "autonomy_or_capability";
  return null;
}
/** An option's confidence is capped at the share of its evidence refs whose claims verified; "no change" is exempt. */
export function capConfidence(option: CouncilOption, verifiedRefs: ReadonlySet<string>): number {
  if (option.change.type === "no_change") return option.confidence;
  const refs = option.evidence_refs;
  const share = refs.length ? refs.filter((r) => verifiedRefs.has(r)).length / refs.length : 0;
  return Math.min(option.confidence, Math.round(share * 1000) / 1000);
}

// ---------------------------------------------------------------- validators (both sides check the fixtures with these)

type Errors = string[];
const isText = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const isIso = (v: unknown) => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,3})?)?Z$/.test(v);
const SESSION_ID = /^cs_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT = /^agent:[a-z0-9][a-z0-9-]{1,62}$/;

export function validateSession(s: any): Errors {
  const e: Errors = [];
  if (s?.schema !== COUNCIL_SCHEMAS.session) e.push("schema");
  if (!SESSION_ID.test(String(s?.session_id))) e.push("session_id");
  if (!["cerebrum", "nexus"].includes(s?.side)) e.push("side");
  if (!isText(s?.topic, 200)) e.push("topic");
  if (!isText(s?.question, 1_000)) e.push("question");
  if (!["owner", "finding", "kpi_regression", "agent", "strategist"].includes(s?.trigger?.kind)) e.push("trigger.kind");
  if (s?.trigger?.ref !== null && s?.trigger?.ref !== undefined && !parseRef(s.trigger.ref)) e.push("trigger.ref");
  if (!Array.isArray(s?.convened) || !s.convened.every((a: unknown) => AGENT.test(String(a)))) e.push("convened");
  if (!(COUNCIL_STATES as readonly string[]).includes(s?.state)) e.push("state");
  if (typeof s?.owner_present !== "boolean") e.push("owner_present");
  if (!isIso(s?.created_at) || !isIso(s?.deadline)) e.push("times");
  const b = s?.budget;
  if (!b || !(Number.isInteger(b.max_calls) && b.max_calls >= 1 && b.max_calls <= COUNCIL_LIMITS.max_model_calls)) e.push("budget.max_calls");
  if (!b || !(typeof b.max_usd === "number" && b.max_usd > 0 && b.max_usd <= COUNCIL_LIMITS.max_usd)) e.push("budget.max_usd");
  if (s?.decision !== null && s?.decision !== undefined && validateDecision(s.decision).length) e.push("decision");
  return e;
}

export function validateMessage(m: any): Errors {
  const e: Errors = [];
  if (m?.schema !== COUNCIL_SCHEMAS.message) e.push("schema");
  if (!SESSION_ID.test(String(m?.session_id))) e.push("session_id");
  if (!(Number.isInteger(m?.seq) && m.seq >= 1 && m.seq <= COUNCIL_LIMITS.max_messages)) e.push("seq");
  if (!isIso(m?.at)) e.push("at");
  if (!["position", "rebuttal", "owner", "synthesis", "system"].includes(m?.phase)) e.push("phase");
  if (!["participant", "moderator", "owner", "system"].includes(m?.role)) e.push("role");
  if (typeof m?.text !== "string" || m.text.length > COUNCIL_LIMITS.max_message_chars) e.push("text");
  if (m?.stance !== null && !["support", "oppose", "amend", "abstain"].includes(m?.stance)) e.push("stance");
  if (!Array.isArray(m?.reply_to) || m.reply_to.length > COUNCIL_LIMITS.max_rebuttal_targets || !m.reply_to.every((n: unknown) => Number.isInteger(n) && (n as number) < m.seq)) e.push("reply_to");
  if (m?.phase === "rebuttal" && (!Array.isArray(m.reply_to) || m.reply_to.length === 0)) e.push("rebuttal_names_no_position");
  if (!Array.isArray(m?.claims)) e.push("claims");
  else for (const c of m.claims) {
    if (!isText(c?.metric, 80) || !(typeof c.value === "number" || typeof c.value === "string")) { e.push("claim.metric"); break; }
    if (!Array.isArray(c.refs) || c.refs.length === 0) { e.push("claim.refs"); break; }
    const refs = c.refs.map(parseRef);
    if (refs.some((r: EvidenceRef | null) => !r)) { e.push("claim.ref_format"); break; }
    if (refs.some((r: EvidenceRef) => refCarriesPrice(r))) { e.push("claim.ref_price"); break; }
  }
  if (m?.phase === "synthesis") {
    if (m.role !== "moderator") e.push("synthesis_role");
    const opts = m.options;
    if (!Array.isArray(opts) || opts.length === 0) e.push("options");
    else {
      for (const o of opts) for (const x of validateOption(o)) e.push(`option.${x}`);
      const ranks = opts.map((o: any) => o?.rank).sort((a: number, b: number) => a - b);
      if (!ranks.every((r: number, i: number) => r === i + 1)) e.push("option.ranks");
      if (!opts.some((o: any) => o?.change?.type === "no_change")) e.push("option.no_change_missing");
    }
  } else if (m?.options !== null && m?.options !== undefined) e.push("options_outside_synthesis");
  return [...new Set(e)];
}

export function validateOption(o: any): Errors {
  const e: Errors = [];
  if (!/^opt-\d{1,2}$/.test(String(o?.option_id))) e.push("option_id");
  if (!(Number.isInteger(o?.rank) && o.rank >= 1)) e.push("rank");
  if (!isText(o?.title, 120) || !isText(o?.hypothesis, 600)) e.push("text");
  if (!(CHANGE_TYPES as readonly string[]).includes(o?.change?.type)) e.push("change.type");
  if (o?.change && (typeof o.change.params !== "object" || o.change.params === null || Array.isArray(o.change.params))) e.push("change.params");
  if (o?.change && !e.includes("change.type") && widensAutonomy(o)) e.push(`widens_autonomy:${widensAutonomy(o)}`);
  if (!["low", "medium", "high"].includes(o?.risk?.level) || typeof o?.risk?.reversible !== "boolean") e.push("risk");
  if (!(typeof o?.confidence === "number" && o.confidence >= 0 && o.confidence <= 1)) e.push("confidence");
  if (!Array.isArray(o?.evidence_refs) || !o.evidence_refs.every((r: unknown) => parseRef(r))) e.push("evidence_refs");
  if (!Array.isArray(o?.dissent) || !o.dissent.every((a: unknown) => AGENT.test(String(a)))) e.push("dissent");
  if (o?.change?.type !== "no_change" && (o?.expected_effect === null || !isText(o?.expected_effect?.metric, 80))) e.push("expected_effect");
  return e;
}

export function validateDecision(d: any): Errors {
  const e: Errors = [];
  if (d?.schema !== COUNCIL_SCHEMAS.decision) e.push("schema");
  if (!SESSION_ID.test(String(d?.session_id))) e.push("session_id");
  if (!/^opt-\d{1,2}$/.test(String(d?.option_id))) e.push("option_id");
  if (!/^owner:\S+$/.test(String(d?.chosen_by))) e.push("chosen_by");
  if (!isIso(d?.chosen_at)) e.push("chosen_at");
  const p = d?.proposal_draft;
  if (p?.schema !== COUNCIL_SCHEMAS.draft) e.push("draft.schema");
  if (!["shadow_arm", "policy_parameter", "vision_kpi", "repository_task"].includes(p?.kind)) e.push("draft.kind");
  if (p?.origin?.council !== d?.session_id || p?.origin?.option !== d?.option_id) e.push("draft.origin");
  const req = Array.isArray(p?.requires) ? p.requires : [];
  if (!req.includes("owner_confirm") || !req.includes("owner_click_to_promote")) e.push("draft.requires");
  if (p?.kind === "shadow_arm" && !req.includes("shadow_window")) e.push("draft.shadow_window");
  if (p && widensAutonomy({ change: { type: p.kind, target: p.target ?? null, params: p.params ?? {} } })) e.push("draft.widens_autonomy");
  return e;
}

/** Proposals of the same topic are deduplicated for 7 days, unless they bring evidence refs the last one did not have. */
export function topicKey(topic: string, question: string): string {
  return `${topic} ${question}`.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w.length > 2).sort().join(" ").slice(0, 300);
}
export function isDuplicateProposal(key: string, refs: readonly string[], recent: readonly { key: string; refs: readonly string[]; created_at: string }[], now: number): boolean {
  return recent.some((r) => r.key === key && now - Date.parse(r.created_at) < COUNCIL_LIMITS.proposal_cooldown_ms && refs.every((x) => r.refs.includes(x)));
}
