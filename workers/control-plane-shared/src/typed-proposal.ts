// HAIC H2 (ADR-0017 H2; docs/design/HAIC-H0-H1.md §4.4 and §5; owner answers of 2026-11-18): typed_proposal.v1, a
// directive turned into a typed, governed change. The owner always confirms first; then it goes its kind's way:
//   - policy_parameter: a consensus proposal set_policy_parameter (routine, inside the parameter's hard bounds), made
//     by the Supervisor (owner: "Konsensus rutin": the owner's confirmation is the click);
//   - repository_task: an evolution intent for the evolver (ADR-0014), which writes an ordinary change request (checks,
//     consensus, the owner's click on a guard path) (owner: "Evolver");
//   - vision_kpi: a change of organism/vision.json, a guard path the evolver refuses by design, so the orchestrator
//     writes it and its merge needs the owner's click (owner: "KPI lewat repo");
//   - shadow_arm: handed to xauusd through the existing pull path (council.decisions.read); xauusd runs the shadow arm
//     itself, and going live is the owner's click in xauusd (owner: "shadow ke xauusd").
// Pure validation here; ai-kernel/src/proposals.ts stores and hands off. A typed proposal never widens autonomy, never
// carries a price, and never acts before the owner's confirmation.
import { parseRef, refCarriesPrice, widensAutonomy } from "./council.ts";
import { POLICY_PARAMETERS, isPolicyParameter, validPolicyValue } from "./policy-params.ts";

export const TP_SCHEMA = "typed_proposal.v1";
export const TP_KINDS = ["policy_parameter", "repository_task", "vision_kpi", "shadow_arm"] as const;
export type TpKind = (typeof TP_KINDS)[number];
export const TP_STATES = ["draft", "confirmed", "rejected", "handoff_pending", "handed_off", "failed", "expired"] as const;
export type TpState = (typeof TP_STATES)[number];
export const TP_SOURCES = ["council", "chat"] as const;
/** Where a confirmed proposal goes, by kind. */
export const HANDOFF_PATH: Readonly<Record<TpKind, "consensus" | "evolver" | "orchestrator" | "xauusd">> = {
  policy_parameter: "consensus", repository_task: "evolver", vision_kpi: "orchestrator", shadow_arm: "xauusd",
};
/** A draft not confirmed in 7 days expires; nothing happens. */
export const DRAFT_WINDOW_MS = 7 * 24 * 3_600_000;
export const TP_LIMITS = { title: 200, rationale: 1_200, spec: 8_192, refs: 12, params_json: 2_000 } as const;

export interface TypedProposal {
  schema: typeof TP_SCHEMA;
  proposal_id: string;
  kind: TpKind;
  title: string;
  rationale: string;
  target: string | null;
  params: Record<string, unknown>;
  measurement: { metric: string | null; baseline: number | null; window: string | null; success_threshold: number | null } | null;
  origin: { source: (typeof TP_SOURCES)[number]; ref: string };
  evidence_refs: string[];
  requires: string[];
}

const PROPOSAL_ID = /^tp_[0-9a-f]{16}$/;
export const isProposalId = (s: unknown): s is string => typeof s === "string" && PROPOSAL_ID.test(s);
export const newProposalId = () => `tp_${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
const PRICE_KEY = /^(price|prices|entry|entry_price|sl|tp\d?|stop|stop_loss|take_profit|bid|ask|level|levels|lot|lots|volume)$/i;
const text = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

/** Every key of an object, at any depth (for the price check). */
function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); }
  return out;
}

/** The errors of a typed proposal (empty when valid). Checked when a draft is made and again when it is confirmed. */
export function validateTypedProposal(p: any): string[] {
  const e: string[] = [];
  if (p?.schema !== TP_SCHEMA) e.push("schema");
  if (!isProposalId(p?.proposal_id)) e.push("proposal_id");
  if (!(TP_KINDS as readonly string[]).includes(p?.kind)) { e.push("kind"); return e; }
  if (!text(p?.title, TP_LIMITS.title)) e.push("title");
  if (!text(p?.rationale, TP_LIMITS.rationale)) e.push("rationale");
  if (!p?.origin || !(TP_SOURCES as readonly string[]).includes(p.origin.source) || !text(p.origin.ref, 200)) e.push("origin");
  if (!p?.params || typeof p.params !== "object" || Array.isArray(p.params)) { e.push("params"); return e; }
  if (JSON.stringify(p.params).length > TP_LIMITS.params_json) e.push("params_too_large");
  if (keysOf(p.params).some((k) => PRICE_KEY.test(k))) e.push("params_carry_a_price");
  const refs = Array.isArray(p?.evidence_refs) ? p.evidence_refs : null;
  if (!refs || refs.length > TP_LIMITS.refs || refs.some((r: unknown) => { const x = parseRef(r); return !x || refCarriesPrice(x); })) e.push("evidence_refs");
  if (!Array.isArray(p?.requires) || !p.requires.includes("owner_confirm")) e.push("requires.owner_confirm");
  if (widensAutonomy({ change: { type: p.kind, target: p.target ?? null, params: p.params } })) e.push("widens_autonomy");
  switch (p.kind as TpKind) {
    case "policy_parameter":
      if (!isPolicyParameter(String(p.target))) e.push("target: not a council-adjustable policy parameter");
      else if (!validPolicyValue(p.target, p.params.value)) {
        const b = POLICY_PARAMETERS[p.target as keyof typeof POLICY_PARAMETERS];
        e.push(`params.value: an integer from ${b.min} to ${b.max}`);
      }
      break;
    case "repository_task":
      if (p.target !== "platform") e.push("target: the platform repository (other repositories wait for ADR-0018)");
      if (!text(p.params.spec, TP_LIMITS.spec)) e.push("params.spec");
      break;
    case "vision_kpi":
      if (typeof p.target !== "string" || !/^[a-z][a-z0-9_.-]{1,63}$/.test(p.target)) e.push("target: a KPI id");
      if (!(typeof p.params.to === "number" || text(p.params.to, 120))) e.push("params.to");
      break;
    case "shadow_arm":
      if (typeof p.target !== "string" || !/^[a-z][a-z0-9_-]{1,63}$/.test(p.target)) e.push("target: a strategy id");
      if (!p.requires.includes("shadow_window")) e.push("requires.shadow_window");
      if (Object.values(p.params).some((v) => v !== null && typeof v === "object")) e.push("params: flat values only");
      break;
  }
  return e;
}

/** The draft a council's pick makes (ai-kernel/src/council.ts pickOption's proposal_draft and the chosen option). */
export function draftFromCouncil(proposalId: string, sessionId: string, option: { option_id: string; title: string; hypothesis: string; evidence_refs: string[] },
  draft: { kind: string; target: string | null; params: Record<string, unknown>; measurement: TypedProposal["measurement"]; requires: string[] }): TypedProposal {
  const params = { ...draft.params };
  if (draft.kind === "repository_task" && typeof params.spec !== "string") params.spec = option.hypothesis;
  return {
    schema: TP_SCHEMA, proposal_id: proposalId, kind: draft.kind as TpKind, title: option.title.slice(0, TP_LIMITS.title), rationale: option.hypothesis.slice(0, TP_LIMITS.rationale),
    target: draft.kind === "repository_task" ? (draft.target === "platform" || draft.target === null ? "platform" : draft.target) : draft.target,
    params, measurement: draft.measurement, origin: { source: "council", ref: `${sessionId}#${option.option_id}` },
    evidence_refs: option.evidence_refs.slice(0, TP_LIMITS.refs), requires: draft.requires,
  };
}

/** What the owner sees before confirming: what happens next, in words. */
export function whatHappens(kind: TpKind): string {
  return {
    policy_parameter: "The Supervisor proposes set_policy_parameter to the council; the agents vote; inside its hard bounds it executes as a routine action.",
    repository_task: "It becomes an evolution intent; the evolver writes a change request, which is checked, put to consensus, and needs your click on a guard path.",
    vision_kpi: "It becomes a task for the orchestrator to change organism/vision.json (a guard path): its merge needs your click.",
    shadow_arm: "It is handed to xauusd through the council return path; xauusd runs it as a shadow arm, and going live is your click there.",
  }[kind];
}
