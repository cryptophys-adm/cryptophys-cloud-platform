// HAIC H1b "Ask the organism" (ADR-0017 H1, docs/design/HAIC-H0-H1.md §3; owner answers 2026-11-16 Q1–Q4): one owner's
// conversation with the organism. A turn: the question (refused if it carries a secret), the daily turn budget, a plan
// (which read-only tools), the tools, an answer from their results only, the citation post-check, the audit. The chat
// never acts: no tool writes, and the kernel's write tools are not offered.
//
// Deviations from the design, each smaller than what it replaces: a plain SQLite-backed Durable Object as the kernel's
// other agents are (the Workers here bundle no npm dependency, so no Agents SDK); the switch is its own table
// conversation_controls (kernel_controls only admits agents_enabled, and widening its CHECK is a destructive migration);
// answers in English (owner 2026-11-17, "all in english please"); the reply is JSON, streamed later with the Console page.
import { AiEngine, type AiTask, type AiUsage } from "../../control-plane-shared/src/ai-engine.ts";
import { appendAuditEvent, sha256Hex } from "../../control-plane-shared/src/audit.ts";
import type { AiBinding, D1Database } from "../../control-plane-shared/src/types.ts";
import {
  ANSWER_INSTRUCTIONS, CHAT_DAILY_TURN_LIMIT, CHAT_MODEL, CHAT_MODELS, CHAT_SERVICE, CHAT_TASKS, CHAT_TOOLS, CONVERSATION_ID, HISTORY_TURNS,
  MAX_CALLS_PER_TURN, MAX_QUESTION_CHARS, PLAN_INSTRUCTIONS, checkCitations, injectionFlags, redactText, secretInText, toolText, validateAnswer, validatePlan,
  type ChatAnswer, type ChatPlan,
} from "../../control-plane-shared/src/conversation.ts";
import { runTool, type ToolEnv, type ToolResult } from "./conversation-tools.ts";
import { modelSubject, recordCorrection, turnRef } from "./corrections.ts";

export interface ConversationEnv extends ToolEnv { AI?: AiBinding; CHAT_DAILY_TURN_LIMIT?: string }
/** The Durable Object's storage, as much of it as a conversation uses. */
export interface ConversationStore { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> }

export interface TurnRecord {
  n: number;
  status: "answered" | "refused" | "failed";
  reason?: string;
  question: string;
  answer: string;
  tools: { name: string; args: Record<string, unknown>; ok: boolean; error?: string }[];
  refs: string[];
  model: string | null;
  usage: AiUsage;
  citations: { kept: number; stripped: number };
  injection: string[];
  latency_ms: number;
  created_at: string;
  rating?: "up" | "down";
}
interface Meta { conversation_id: string; actor: string; created_at: string; turns: number }
export class ConversationError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

const AI_TIMEOUT_MS = 30_000;
const TURN_KEY = (n: number) => `turn:${String(n).padStart(6, "0")}`;
const day = (now: number) => new Date(now).toISOString().slice(0, 10);

/** The chat's switch (owner Q3: its own, not the agents' kill switch). No table or no row reads as off. */
export async function conversationEnabled(db: D1Database): Promise<boolean> {
  try { return (await db.prepare("SELECT value FROM conversation_controls WHERE control = 'enabled'").first<{ value: string }>())?.value === "1"; } catch { return false; }
}
export const turnLimit = (env: { CHAT_DAILY_TURN_LIMIT?: string }) => { const n = Number(env.CHAT_DAILY_TURN_LIMIT); return Number.isInteger(n) && n > 0 && n <= 500 ? n : CHAT_DAILY_TURN_LIMIT; };

/** One turn from today's budget, atomically; false when it is used up. */
export async function reserveTurn(db: D1Database, today: string, limit: number): Promise<boolean> {
  const r = await db.prepare(
    `INSERT INTO conversation_budget (day, turns) SELECT ?, 1 WHERE ? > 0
     ON CONFLICT(day) DO UPDATE SET turns = turns + 1 WHERE turns < ?`,
  ).bind(today, limit, limit).run();
  return (r.meta.changes ?? 0) > 0;
}
export async function budgetToday(db: D1Database, env: { CHAT_DAILY_TURN_LIMIT?: string }, now = Date.now()) {
  let used = 0;
  try { used = (await db.prepare("SELECT turns FROM conversation_budget WHERE day = ?").bind(day(now)).first<{ turns: number }>())?.turns ?? 0; } catch { used = 0; }
  return { day: day(now), used, limit: turnLimit(env) };
}

const audit = (db: D1Database, type: string, actor: string, id: string, outcome: string, payload: Record<string, unknown>) =>
  appendAuditEvent(db, { event_type: `conversation.${type}`, actor, subject: `conversation:${id}`, outcome, payload: { conversation_id: id, ...payload } as never });

const planTask: AiTask<ChatPlan> = { name: "chat_plan", instructions: PLAN_INSTRUCTIONS, maxInputChars: 24_000, maxOutputTokens: 600, validate: validatePlan };
const answerTask: AiTask<ChatAnswer> = { name: "chat_answer", instructions: ANSWER_INSTRUCTIONS, maxInputChars: 64_000, maxOutputTokens: 2_000, validate: validateAnswer };

async function metaOf(store: ConversationStore, actor: string, id: string): Promise<Meta | null> {
  const meta = await store.get<Meta>("meta");
  if (meta && (meta.actor !== actor || meta.conversation_id !== id)) throw new ConversationError(403, "not_your_conversation", "this conversation belongs to another identity");
  return meta ?? null;
}

/** One question, answered from read-only tools and audited. The caller is the owner; the DO serializes turns. */
export async function runTurn(env: ConversationEnv, store: ConversationStore, input: { actor: string; conversation_id: string; question: unknown }, now = Date.now()): Promise<TurnRecord> {
  const { actor, conversation_id: id } = input;
  if (!CONVERSATION_ID.test(id)) throw new ConversationError(400, "invalid_request", "a conversation id is cnv_ and 16 hex characters");
  if (typeof input.question !== "string" || !input.question.trim() || input.question.length > MAX_QUESTION_CHARS) {
    throw new ConversationError(400, "invalid_request", `a question is 1–${MAX_QUESTION_CHARS} characters`);
  }
  const started = Date.now();
  const db = env.DB;
  let meta = await metaOf(store, actor, id);
  if (!(await conversationEnabled(db))) throw new ConversationError(503, "conversation_disabled", "the chat is switched off (conversation_controls)");
  const n = (meta?.turns ?? 0) + 1;
  const at = new Date(now).toISOString();
  const empty: AiUsage = { input: 0, cached: 0, output: 0 };
  if (!meta) {
    meta = { conversation_id: id, actor, created_at: at, turns: 0 };
    await audit(db, "started", actor, id, "started", {});
    await db.prepare("INSERT OR IGNORE INTO conversations (conversation_id, actor, turns, stripped, last_status, created_at, updated_at) VALUES (?, ?, 0, 0, NULL, ?, ?)").bind(id, actor, at, at).run();
  }
  const m: Meta = meta;
  const record = async (t: TurnRecord): Promise<TurnRecord> => {
    m.turns = n;
    await store.put(TURN_KEY(n), t);
    await store.put("meta", m);
    await db.prepare("UPDATE conversations SET turns = ?, stripped = stripped + ?, last_status = ?, updated_at = ? WHERE conversation_id = ?")
      .bind(n, t.citations.stripped, t.status, at, id).run();
    await audit(db, "turn", actor, id, t.status, {
      turn: n, question_sha256: await sha256Hex(t.question), answer_sha256: await sha256Hex(t.answer), reason: t.reason ?? null,
      tools: t.tools, refs: t.refs.slice(0, 40), model: t.model, tokens: t.usage, latency_ms: t.latency_ms, citations: t.citations,
    });
    return t;
  };
  const refused = (reason: string, answer: string, question = input.question as string): Promise<TurnRecord> => record({
    n, status: "refused", reason, question, answer, tools: [], refs: [], model: null, usage: empty, citations: { kept: 0, stripped: 0 }, injection: [],
    latency_ms: Date.now() - started, created_at: at,
  });

  // §3.3: a secret never reaches the model; only its redacted form is kept.
  if (secretInText(input.question)) {
    await audit(db, "secret_refused", actor, id, "refused", { turn: n });
    return refused("secret_in_question", "That message looks like it contains a secret (a token, a key or a password). It was not sent to the model, and only its redacted form is kept. Never paste secrets here.", redactText(input.question));
  }
  const limit = turnLimit(env);
  if (!(await reserveTurn(db, day(now), limit))) {
    await audit(db, "budget_refused", actor, id, "refused", { turn: n, limit });
    return refused("daily_budget_used", `The chat's daily budget is used up (${limit} turns a day). It starts again at 00:00 UTC.`);
  }

  const history: { question: string; answer: string }[] = [];
  for (let k = Math.max(1, n - HISTORY_TURNS); k < n; k++) {
    const t = await store.get<TurnRecord>(TURN_KEY(k));
    if (t) history.push({ question: t.question.slice(0, 1_000), answer: t.answer.slice(0, 1_500) });
  }
  // The turn was reserved above; its model calls are bounded per turn, not counted in ai_usage (the platform's caps).
  let calls = 0;
  const engine = new AiEngine({
    service: CHAT_SERVICE, ai: env.AI, db, allowedModels: CHAT_MODELS, allowedTasks: CHAT_TASKS, model: CHAT_MODEL, timeoutMs: AI_TIMEOUT_MS,
    ownBudget: async () => ++calls <= MAX_CALLS_PER_TURN,
  });
  const usage: AiUsage = { input: 0, cached: 0, output: 0 };
  const add = (u?: AiUsage) => { if (u) { usage.input += u.input; usage.cached += u.cached; usage.output += u.output; } };
  const question = input.question.trim();
  const catalog = CHAT_TOOLS.map((t) => ({ name: t.name, description: t.description, args: t.args, required: t.required ?? [] }));

  const plan = await engine.run(planTask, { question, history, tools: catalog }, `chat:${id}:${n}:plan`);
  if (plan.status === "ok") add(plan.usage);
  const planned = plan.status === "ok" ? plan.data.tools : [];
  const results: ToolResult[] = [];
  const injection = new Set<string>();
  for (const call of planned) {
    const r = await runTool(env, call, now);
    results.push(r);
    await audit(db, r.ok ? "tool_called" : "tool_refused", actor, id, r.ok ? "ok" : "refused", { turn: n, tool: r.name, args: call.args, refs: r.refs.length, error: r.error ?? null });
    const flags = r.ok ? injectionFlags(r.data) : [];
    if (flags.length) { for (const f of flags) injection.add(f); await audit(db, "injection_flagged", actor, id, "flagged", { turn: n, tool: r.name, flags }); }
  }
  const outputs = new Map<string, string>();
  const quoted = results.map((r) => {
    const text = r.ok ? toolText(r.data) : "null";
    for (const ref of r.refs) outputs.set(ref, text);
    return { tool: r.name, ok: r.ok, error: r.error ?? null, refs: r.refs, data_json: text };
  });
  const refs = [...new Set(results.flatMap((r) => r.refs))];
  const tools = results.map((r, i) => ({ name: r.name, args: planned[i].args, ok: r.ok, ...(r.error ? { error: r.error } : {}) }));

  const ans = await engine.run(answerTask, { question, history, tool_results: quoted, plan_status: plan.status === "ok" ? "ok" : plan.reason }, `chat:${id}:${n}:answer`);
  if (ans.status !== "ok") {
    const advisory = ans.reason === "schema:advisory_language";
    return record({
      n, status: "failed", reason: ans.reason, question, tools, refs, model: CHAT_MODEL, usage, citations: { kept: 0, stripped: 0 }, injection: [...injection].sort(),
      answer: advisory ? "The answer was withheld: it contained trading language (a price level or an instruction to trade), which the platform never gives."
        : `No answer this time: the model was not available (${ans.reason}). Nothing was changed.`,
      latency_ms: Date.now() - started, created_at: at,
    });
  }
  add(ans.usage);
  const checked = checkCitations(ans.data.answer, ans.data.citations, outputs);
  if (checked.stripped) await audit(db, "citation_stripped", actor, id, "stripped", { turn: n, stripped: checked.stripped, kept: checked.kept });
  return record({
    n, status: "answered", question, answer: redactText(checked.answer), tools, refs, model: CHAT_MODEL, usage,
    citations: { kept: checked.kept, stripped: checked.stripped }, injection: [...injection].sort(), latency_ms: Date.now() - started, created_at: at,
  });
}

/** The conversation's turns, for its owner only. */
export async function readConversation(store: ConversationStore, actor: string, id: string): Promise<{ conversation_id: string; created_at: string | null; turns: TurnRecord[] }> {
  if (!CONVERSATION_ID.test(id)) throw new ConversationError(400, "invalid_request", "a conversation id is cnv_ and 16 hex characters");
  const meta = await metaOf(store, actor, id);
  if (!meta) throw new ConversationError(404, "not_found", "no such conversation");
  const turns: TurnRecord[] = [];
  for (let k = 1; k <= meta.turns; k++) { const t = await store.get<TurnRecord>(TURN_KEY(k)); if (t) turns.push(t); }
  return { conversation_id: id, created_at: meta.created_at, turns };
}

/**
 * A thumbs up or down on one answered turn (§3.1); audited as conversation.rated. HAIC H3b: it is also recorded as a
 * correction (source chat_rating; with the owner's optional note, an owner_correction whose text is the note), whose id
 * the rated event names. The rating stands whatever happens to that record: a failure there is logged, never thrown.
 */
export async function rateTurn(env: { DB: D1Database }, store: ConversationStore, actor: string, id: string, n: unknown, rating: unknown, note?: unknown): Promise<{ turn: number; rating: "up" | "down" }> {
  const meta = await metaOf(store, actor, id);
  if (!meta) throw new ConversationError(404, "not_found", "no such conversation");
  if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > meta.turns) throw new ConversationError(400, "invalid_request", "no such turn");
  if (rating !== "up" && rating !== "down") throw new ConversationError(400, "invalid_request", "rating is up or down");
  if (note !== undefined && note !== null && typeof note !== "string") throw new ConversationError(400, "invalid_request", "note is text");
  const t = await store.get<TurnRecord>(TURN_KEY(n as number));
  if (!t || t.status !== "answered") throw new ConversationError(409, "not_rateable", "only an answered turn is rated");
  t.rating = rating;
  await store.put(TURN_KEY(n as number), t);
  let correctionId: string | null = null;
  try {
    // The note is never refused for its content: the contract redacts a secret, masks a price and truncates at 500.
    const r = await recordCorrection(env.DB, {
      side: "cerebrum", source: "chat_rating", rating, text: note ?? null,
      target: { ref: turnRef(id, n as number), subject: modelSubject(t.model), as_of: t.created_at },
    }, { actor: `owner:${actor}`, owner: true, attested_by: "cerebrum_access" });
    correctionId = r.correction.correction_id;
  } catch (err) {
    console.error(JSON.stringify({ service: CHAT_SERVICE, event: "chat_rating_correction_failed", conversation_id: id, turn: n, message: String((err as Error)?.message ?? err).slice(0, 200) }));
  }
  await audit(env.DB, "rated", actor, id, rating, { turn: n, correction_id: correctionId });
  return { turn: n as number, rating };
}

/** GET /v1/conversations: the owner's own conversations (ids and counts only), the switch and today's budget. */
export async function listConversations(env: { DB: D1Database; CHAT_DAILY_TURN_LIMIT?: string }, actor: string, now = Date.now()) {
  let rows: unknown[] = [];
  try {
    rows = (await env.DB.prepare("SELECT conversation_id, turns, stripped, last_status, created_at, updated_at FROM conversations WHERE actor = ? ORDER BY updated_at DESC LIMIT 50")
      .bind(actor).all()).results ?? [];
  } catch { rows = []; }
  return { schema: "conversations.v1", enabled: await conversationEnabled(env.DB), model: CHAT_MODEL, budget: await budgetToday(env.DB, env, now), conversations: rows };
}
