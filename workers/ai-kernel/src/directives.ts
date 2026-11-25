// HAIC H2b (ADR-0017 H2: "the chat turns 'fokus ke akurasi minggu ini' into a typed_proposal.v1"; owner answer of
// 2026-11-18: council and chat drafts): an owner's directive, written in the chat, becomes a typed_proposal.v1 DRAFT.
// One model call (task directive_draft, CHAT_MODEL) turns the text into a candidate; the candidate is validated as any
// draft (typed-proposal.ts: each kind's rules, never a price, never wider autonomy) and a vision_kpi must name a KPI of
// the growth layer. It is only a draft: nothing happens until the owner confirms it on its page (proposals.ts).
// Owners only, from the chat's own switch and daily budget (one directive is one turn); the text is audited by hash.
import { AiEngine, type AiTask } from "../../control-plane-shared/src/ai-engine.ts";
import { appendAuditEvent, sha256Hex } from "../../control-plane-shared/src/audit.ts";
import { CHAT_MODEL, CHAT_MODELS, CHAT_SERVICE, secretInText } from "../../control-plane-shared/src/conversation.ts";
import { modelRouterFor, type ModelRouterEnv } from "../../control-plane-shared/src/model-router.ts";
import { POLICY_PARAMETERS } from "../../control-plane-shared/src/policy-params.ts";
import { TP_KINDS, TP_LIMITS, TP_SCHEMA, newProposalId, type TpKind, type TypedProposal } from "../../control-plane-shared/src/typed-proposal.ts";
import type { AiBinding, D1Database } from "../../control-plane-shared/src/types.ts";
import visionFile from "../../../organism/vision.json" with { type: "json" };
import { conversationEnabled, reserveTurn, turnLimit } from "./conversation.ts";
import { insertDraft } from "./proposals.ts";

export const DIRECTIVE_TASKS = ["directive_draft"] as const;
export const MAX_DIRECTIVE_CHARS = 1_200;
/** The growth layer's KPI ids (organism/vision.json of this deploy): the only targets a vision_kpi draft may name. */
export const KPI_IDS: readonly string[] = ((visionFile as any)?.growth?.goals ?? []).flatMap((g: any) => (Array.isArray(g?.kpis) ? g.kpis.map((k: any) => String(k?.id ?? "")) : [])).filter(Boolean);

export class DirectiveError extends Error {
  readonly status: number;
  readonly code: string;
  readonly errors: string[];
  constructor(status: number, code: string, message: string, errors: string[] = []) { super(message); this.status = status; this.code = code; this.errors = errors; }
}

interface Candidate { kind: TpKind | null; title: string; rationale: string; target: string | null; params: Record<string, unknown>; measurement: TypedProposal["measurement"]; reason: string | null }

const INSTRUCTIONS = [
  "You turn the owner's directive into ONE typed proposal for the Cerebrum platform, or say that it is none. You never act.",
  'Answer JSON only: {"kind":"policy_parameter|repository_task|vision_kpi|shadow_arm"|null,"title":"...","rationale":"...","target":"..."|null,"params":{},"measurement":{"metric","baseline","window","success_threshold"}|null,"reason":"..."|null}.',
  "policy_parameter: target is one of the parameters given, params {\"value\": an integer inside its bounds}.",
  "repository_task: target \"platform\", params {\"spec\": what to change and why, at most 2000 characters}.",
  "vision_kpi: target is one of the KPI ids given, params {\"to\": the new target value}.",
  "shadow_arm: target is an xauusd strategy id (lowercase, underscores), params are flat settings; never a price, a lot, a stop or a take profit.",
  "Never propose anything that arms trading, raises autonomy, adds a capability or touches funds: answer kind null with the reason.",
  "If the directive is a question, unclear, or none of these, answer kind null with a short reason. Write in English.",
].join(" ");

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const task: AiTask<Candidate> = {
  name: "directive_draft", instructions: INSTRUCTIONS, maxInputChars: 8_000, maxOutputTokens: 3_000, // thinking included (CHAT_MODEL reasons; council fix 2026-11-22)
  validate(o: unknown): Candidate | null {
    if (!isObj(o)) return null;
    const kind = o.kind === null ? null : (TP_KINDS as readonly string[]).includes(String(o.kind)) ? (o.kind as TpKind) : undefined;
    if (kind === undefined) return null;
    const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const m = isObj(o.measurement) ? o.measurement : null;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      kind, title: str(o.title, TP_LIMITS.title), rationale: str(o.rationale, TP_LIMITS.rationale), target: typeof o.target === "string" ? o.target.trim().slice(0, 64) : null,
      params: isObj(o.params) ? o.params : {}, reason: typeof o.reason === "string" ? o.reason.slice(0, 300) : null,
      measurement: m ? { metric: typeof m.metric === "string" ? m.metric.slice(0, 64) : null, baseline: num(m.baseline), window: typeof m.window === "string" ? m.window.slice(0, 16) : null, success_threshold: num(m.success_threshold) } : null,
    };
  },
};

export interface DirectiveEnv extends ModelRouterEnv { DB: D1Database; AI?: AiBinding; CHAT_DAILY_TURN_LIMIT?: string }

/** POST /v1/proposals: the owner's directive into a draft. Returns the stored draft's id, or throws why not. */
export async function draftFromDirective(env: DirectiveEnv, actor: string, directiveRaw: unknown, conversationId: unknown, now = Date.now()): Promise<{ proposal_id: string; kind: TpKind }> {
  if (typeof directiveRaw !== "string" || !directiveRaw.trim() || directiveRaw.length > MAX_DIRECTIVE_CHARS) throw new DirectiveError(400, "invalid_request", `a directive is 1–${MAX_DIRECTIVE_CHARS} characters`);
  const directive = directiveRaw.trim();
  if (secretInText(directive)) throw new DirectiveError(400, "secret_refused", "the directive looks like it carries a secret; it was not sent to the model");
  const conv = typeof conversationId === "string" && /^cnv_[0-9a-f]{16}$/.test(conversationId) ? conversationId : null;
  const db = env.DB;
  if (!(await conversationEnabled(db))) throw new DirectiveError(503, "conversation_disabled", "the chat is switched off (conversation_controls)");
  if (!(await reserveTurn(db, new Date(now).toISOString().slice(0, 10), turnLimit(env)))) throw new DirectiveError(429, "daily_budget_used", "the chat's daily budget is used up; it starts again at 00:00 UTC");
  const textHash = await sha256Hex(directive);
  let calls = 0;
  const engine = new AiEngine({ service: CHAT_SERVICE, ai: env.AI, db, allowedModels: CHAT_MODELS, allowedTasks: DIRECTIVE_TASKS, model: CHAT_MODEL, timeoutMs: 30_000, ownBudget: async () => ++calls <= 1,
    // AIR1 (ADR-0007 amendment 2026-11-25): Beam first for directive_draft, Workers AI always the fallback.
    router: modelRouterFor(env, db) });
  const parameters = Object.entries(POLICY_PARAMETERS).map(([name, p]) => ({ name, min: p.min, max: p.max, description: p.description }));
  const r = await engine.run(task, { directive, policy_parameters: parameters, kpi_ids: KPI_IDS }, `directive:${textHash.slice(0, 12)}`);
  if (r.status !== "ok") {
    await appendAuditEvent(db, { event_type: "proposal.directive_failed", actor, subject: `directive:${textHash.slice(0, 16)}`, outcome: "model_unavailable", payload: { text_sha256: textHash, status: r.status } as never });
    throw new DirectiveError(503, "model_unavailable", "the model could not turn the directive into a proposal; try again later");
  }
  const c = r.data;
  if (!c.kind) {
    await appendAuditEvent(db, { event_type: "proposal.directive_refused", actor, subject: `directive:${textHash.slice(0, 16)}`, outcome: "not_a_proposal", payload: { text_sha256: textHash, reason: c.reason } as never });
    throw new DirectiveError(422, "not_a_proposal", c.reason ?? "the directive is not one of the proposal kinds");
  }
  const params = { ...c.params };
  const tp: TypedProposal = {
    schema: TP_SCHEMA, proposal_id: newProposalId(), kind: c.kind, title: c.title || directive.slice(0, TP_LIMITS.title), rationale: c.rationale || directive.slice(0, TP_LIMITS.rationale),
    target: c.kind === "repository_task" ? "platform" : c.target, params, measurement: c.measurement,
    origin: { source: "chat", ref: conv ? `${conv}#directive:${textHash.slice(0, 12)}` : `directive:${textHash.slice(0, 12)}` },
    evidence_refs: [], requires: ["owner_confirm", ...(c.kind === "shadow_arm" ? ["shadow_window"] : []), "owner_click_to_promote"],
  };
  if (tp.kind === "vision_kpi" && !KPI_IDS.includes(String(tp.target))) throw new DirectiveError(422, "invalid_proposal", "the model named no KPI of the growth layer", ["target: not a KPI id"]);
  const made = await insertDraft(db, tp, `owner:${actor}`, now);
  if (!made.ok) throw new DirectiveError(422, "invalid_proposal", "the model's proposal did not pass the typed proposal rules", made.errors);
  await appendAuditEvent(db, { event_type: "proposal.directive_drafted", actor, subject: `proposal:${tp.proposal_id}`, outcome: tp.kind, payload: { proposal_id: tp.proposal_id, text_sha256: textHash, conversation_id: conv } as never });
  return { proposal_id: tp.proposal_id, kind: tp.kind };
}
