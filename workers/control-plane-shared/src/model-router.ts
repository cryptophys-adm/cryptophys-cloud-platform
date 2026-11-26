// AIR1, the model router (ADR-0007 amendment 2026-11-25; owner: "Approve, but Cerebrum only"). Beam, Reflection's
// OpenAI-compatible model, may answer Cerebrum's own AI tasks (the chat, directive drafts and councils) before Workers AI,
// free_only; Workers AI is always the fallback ("tetap siapkan callback jika beam tidak bisa dijangkau atau menjadi
// berbayar atau lebih dari batasan"). The contract is CTA's router's (cryptophys-cta src/agent/router.mjs).
//
// Pure TypeScript with no npm dependency and only light imports (types, audit, http): every Forge test bundle copies its
// imports. AiEngine.run (ai-engine.ts) calls attempt() for an allow-listed task and runs today's Workers AI path whenever
// it answers "skip" or its answer is unusable, so call sites do not change. Every case returns the Workers AI answer.
//
// What the router never does: send or store the key anywhere but the Authorization header of its own request, log or
// store a prompt or an answer, route the evolver (evolve_plan, evolve_write; ADR-0014 Q2: gpt-oss on Workers AI only),
// an embedding or an advisory or agent draft, or run for xauusd or Aether (they do not use this engine's router).
//
// Owner 2026-11-26 ("tambahkan untuk semua beam toggle dari cta dan juga xauusd di command"; migration 0091): the owner's
// switch is per system (cerebrum, cta, xauusd) in model_router_state; this router reads Cerebrum's row only. A paid sign
// from any system sets the one global stop (model_router_global) and turns every switch that is on to off, so Beam is off
// for every system; the owner's clearing turns on only the system clicked. CTA's and xauusd's own router copies read their own row through model_router.status (modelRouterStatusFor).
import type { D1Database } from "./types.ts";
import { appendAuditEvent } from "./audit.ts";

export const BEAM_MODEL = "Beam-1.0-501B-A23B";
export const BEAM_PROVIDER = "reflection";
export const WORKERS_AI_PROVIDER = "workers_ai";
export const DEFAULT_MODEL_BASE_URL = "https://api.reflection.ai/openai/v1";
/** The response header that says how Reflection retains the request; "contributor" turns the router off (as CTA does). */
export const RETENTION_HEADER = "reflection-data-retention";
/** The system whose router is this file's (owner: "Approve, but Cerebrum only"): the kernel's chat, directives and councils. */
export const ROUTER_SYSTEM = "cerebrum";
/**
 * Owner 2026-11-26 ("tambahkan untuk semua beam toggle dari cta dan juga xauusd di command"; migration 0091): one Beam
 * switch per system in D1 model_router_state. CTA and xauusd (its shadow:news_compare) run their own router copies and read
 * their own row through model_router.status; a paid sign from any system stops all of them (model_router_global).
 */
export const ROUTER_SYSTEMS = ["cerebrum", "cta", "xauusd"] as const;
export type RouterSystem = (typeof ROUTER_SYSTEMS)[number];
export const isRouterSystem = (v: unknown): v is RouterSystem => typeof v === "string" && (ROUTER_SYSTEMS as readonly string[]).includes(v);
/**
 * The one map from a calling agent to its router system, by the external origin of the Worker that hosts it: a platform
 * agent (no external origin) is Cerebrum's, an agent hosted by xauusd's services (xauusd-model-router) is xauusd's, one
 * hosted by cryptophys-cta (a future cta-model-router) is CTA's. Aether, or any other origin, has none (null): it never
 * reads or reports for another system's switch.
 */
export function routerSystemOfOrigin(origin: string | null | undefined): RouterSystem | null {
  if (origin === null || origin === undefined || origin === "") return "cerebrum";
  return origin === "xauusd" ? "xauusd" : origin === "cta" ? "cta" : null;
}

/** R1: the only tasks Beam may answer: the chat, directive drafts and the councils' seats and synthesis. */
export const ROUTER_TASKS = ["chat_plan", "chat_answer", "directive_draft", "council_position", "council_rebuttal", "council_synthesis"] as const;
/** Never routed, whatever a list says: the evolver (ADR-0014 Q2) and embeddings. Defence in depth for ROUTER_TASKS. */
export const NEVER_ROUTED_TASKS = ["evolve_plan", "evolve_write", "embed"] as const;

export const ROUTER_STATES = ["on", "off", "off_paid", "off_owner", "off_retention"] as const;
export type RouterState = (typeof ROUTER_STATES)[number];
export const ROUTER_MODES = ["free_only", "paid_capped"] as const;
export type RouterMode = (typeof ROUTER_MODES)[number];
/**
 * Why Beam did not answer a call that Workers AI then answered. output_budget (coordinator review, 2026-11-25): Beam stopped
 * at its output limit (finish_reason "length") before a usable answer; it is not a failure of Beam and does not count
 * toward the breaker.
 */
export const FALLBACK_REASONS = ["unreachable", "rate", "budget", "paid", "retention", "breaker", "off", "disabled", "output_budget"] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];
export const PAID_SIGNALS = ["http_402", "billing_error", "cost_field", "plan_change", "paid_cap_reached", "reported"] as const;
export type PaidSignal = (typeof PAID_SIGNALS)[number];

/** Hard limits of one call and of the breaker (the task's own spec, not configuration). */
export const BEAM_TIMEOUT_MS = 25_000;
export const BREAKER_FAILURES = 3;
export const BREAKER_OPEN_MS = 15 * 60_000;
/** A half-open probe that never settles frees its lease after this long. */
export const PROBE_LEASE_MS = 60_000;
/** The back-off after a 429 or quota error that names no reset time. */
export const DEFAULT_RATE_BACKOFF_MS = 60_000;
export const MAX_RATE_BACKOFF_MS = 24 * 3_600_000;
/** The router reads the global state at most once a minute (and before its first Beam call). */
export const STATE_CACHE_MS = 60_000;
/** The owner's paid cap, when the owner turns Beam on as paid_capped, in USD: (0, 100]. */
export const MAX_PAID_CAP_USD = 100;
/**
 * Beam's output margin (coordinator review, 2026-11-25): Beam's reasoning counts as output, so a Beam call may use up to
 * twice the task's maxOutputTokens, at most BEAM_MAX_OUTPUT_TOKENS, never less than the task's own. Beam calls only; the
 * Workers AI path keeps the task's maxOutputTokens.
 */
export const BEAM_MAX_OUTPUT_TOKENS = 8_000;
export const beamOutputTokens = (maxTokens: number): number => {
  const base = Math.max(1, Math.floor(Number.isFinite(maxTokens) ? maxTokens : 1));
  return Math.max(base, Math.min(base * 2, BEAM_MAX_OUTPUT_TOKENS));
};

/** Cerebrum's share of Beam, stopped before the limits (configurable vars). */
export const DEFAULT_LIMITS = Object.freeze({ rpm: 10, requests_day: 500, input_tokens_day: 1_000_000, output_tokens_day: 150_000 });
export type RouterLimits = { rpm: number; requests_day: number; input_tokens_day: number; output_tokens_day: number };

/** The vars and the one secret the router reads (ai-kernel wrangler.toml). REFLECTION_API_KEY absent: the router is off. */
export interface ModelRouterEnv {
  MODEL_ROUTER?: string;
  MODEL_BASE_URL?: string;
  REFLECTION_API_KEY?: string;
  MODEL_ROUTER_RPM?: string;
  MODEL_ROUTER_REQUESTS_DAY?: string;
  MODEL_ROUTER_INPUT_TOKENS_DAY?: string;
  MODEL_ROUTER_OUTPUT_TOKENS_DAY?: string;
}

export interface ChatMessage { role: "system" | "user"; content: string }
/** One call's meter: what answered, its tokens and latency, and why Beam did not answer (null when it did). */
export interface RouteMeter { provider: typeof BEAM_PROVIDER | typeof WORKERS_AI_PROVIDER; model: string; in_tokens: number; out_tokens: number; latency_ms: number; fallback: FallbackReason | null }
/** Beam's answer, for AiEngine to interpret; settle(true) when it was usable, settle(false) when it was not. */
/** settle("output_budget"): the answer stopped at its output limit; the call falls back, the breaker neither counts it nor stays half-open for it. */
export interface BeamAnswer { kind: "answer"; completion: unknown; latency_ms: number; settle(usable: boolean | "output_budget"): Promise<void> }
export type BeamAttempt = BeamAnswer | { kind: "skip"; reason: FallbackReason };

/**
 * A system's state as its router must obey it: state is the effective one (off_paid while the global paid stop is set,
 * with that stop's updated_by, updated_at and reason; else the system's own switch). switch is the system's own switch
 * underneath (never off_paid), last_status_read_at when its router agent last read model_router.status.
 */
export interface RouterStateRow {
  state: RouterState; mode: RouterMode; paid_cap_usd: number | null; spent_usd: number; updated_by: string; updated_at: string; reason: string | null;
  system: RouterSystem; switch: Exclude<RouterState, "off_paid">; last_status_read_at: string | null;
  /** The first paid sign turned this switch from on to off; it stays off until the owner turns it on (coordinator review). */
  stopped_by_paid: boolean;
}
/** The global paid stop (model_router_global, migration 0091). */
export interface RouterGlobalRow { paid_off: boolean; updated_by: string; updated_at: string; reason: string | null }

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
const iso = (ms: number) => new Date(ms).toISOString();
const dayOf = (ms: number) => iso(ms).slice(0, 10);
const minuteOf = (ms: number) => iso(ms).slice(0, 16);
const nextUtcMidnight = (ms: number) => Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate() + 1);
const intVar = (v: string | undefined, d: number, max: number) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= max ? n : d; };

export function routerLimits(env: ModelRouterEnv): RouterLimits {
  return {
    rpm: intVar(env.MODEL_ROUTER_RPM, DEFAULT_LIMITS.rpm, 1_000),
    requests_day: intVar(env.MODEL_ROUTER_REQUESTS_DAY, DEFAULT_LIMITS.requests_day, 100_000),
    input_tokens_day: intVar(env.MODEL_ROUTER_INPUT_TOKENS_DAY, DEFAULT_LIMITS.input_tokens_day, 100_000_000),
    output_tokens_day: intVar(env.MODEL_ROUTER_OUTPUT_TOKENS_DAY, DEFAULT_LIMITS.output_tokens_day, 100_000_000),
  };
}

/** The base URL, only https and without credentials, query or fragment; null otherwise (the router is then disabled). */
export function routerBaseUrl(env: ModelRouterEnv): string | null {
  const raw = (env.MODEL_BASE_URL ?? "").trim() || DEFAULT_MODEL_BASE_URL;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null;
    return u.toString().replace(/\/+$/, "");
  } catch { return null; }
}

export const routerVarOn = (env: ModelRouterEnv) => (env.MODEL_ROUTER ?? "off").trim().toLowerCase() === "on";
export const routerKeyPresent = (env: ModelRouterEnv) => typeof env.REFLECTION_API_KEY === "string" && env.REFLECTION_API_KEY.trim().length > 0;
export const isRoutedTask = (task: string) => (ROUTER_TASKS as readonly string[]).includes(task) && !(NEVER_ROUTED_TASKS as readonly string[]).includes(task);

/** The fallback reason of a global state that is not on. */
export function stateReason(state: RouterState): FallbackReason | null {
  return state === "on" ? null : state === "off_paid" ? "paid" : state === "off_retention" ? "retention" : "off";
}

// ---------------------------------------------------------------- response classification (pure)

const BILLING = /\b(billing|payment|pay(?:ing)? as you go|credit(?:s)?|insufficient[_ ]?(?:funds|balance|credits?)|paid[_ ]plan|upgrade[_ ](?:your[_ ])?plan|subscription|charge[sd]?|invoice)\b/i;
const RATE = /\b(rate[_ ]?limit(?:ed)?|too many requests|quota|throttl\w*|limit[_ ]exceeded|requests? per (?:minute|day|hour)|tokens? per (?:minute|day))\b/i;
const COST_KEYS = ["cost", "cost_usd", "total_cost", "total_cost_usd", "price", "price_usd", "billed", "billed_usd", "charge", "charge_usd", "amount_usd"] as const;
const PLAN_HEADERS = ["reflection-plan", "x-reflection-plan", "x-plan", "x-billing-plan"] as const;

/** The error text of a provider answer (code, type and message), lower case and bounded. Read, never stored. */
export function errorText(body: unknown): string {
  const b = body as { error?: unknown; code?: unknown; type?: unknown; message?: unknown; detail?: unknown } | null;
  const e = (b && typeof b.error === "object" && b.error !== null ? b.error : b) as Record<string, unknown> | null;
  const parts = [e?.code, e?.type, e?.message, typeof b?.error === "string" ? b.error : null, b?.detail].filter((v) => typeof v === "string") as string[];
  return parts.join(" ").slice(0, 600).toLowerCase();
}

/** A non-zero cost in the usage or the top level of an answer, in USD (the first numeric cost field found), else 0. */
export function costOf(body: unknown): number {
  const pick = (o: unknown): number => {
    if (!o || typeof o !== "object") return 0;
    for (const k of COST_KEYS) {
      const v = (o as Record<string, unknown>)[k];
      const n = typeof v === "number" ? v : typeof v === "string" && /^\s*[0-9]+(\.[0-9]+)?\s*$/.test(v) ? Number(v) : Number.NaN;
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  };
  const b = body as { usage?: unknown } | null;
  return pick(b?.usage) || pick(b);
}

/** A plan header that does not say free, when the provider exposes one. */
export function planChanged(headers: Headers): boolean {
  for (const h of PLAN_HEADERS) {
    const v = headers.get(h);
    if (v !== null && v.trim() !== "" && !/\bfree\b/i.test(v)) return true;
  }
  return false;
}

/** How long to back off after a rate or quota answer: Retry-After (seconds or a date), a rate-limit reset header, a daily quota (to 00:00 UTC), else the default. */
export function rateBackoffMs(headers: Headers, now: number, text = ""): number {
  const clamp = (ms: number) => Math.min(MAX_RATE_BACKOFF_MS, Math.max(1_000, Math.ceil(ms)));
  const ra = headers.get("retry-after");
  if (ra !== null) {
    const s = Number(ra.trim());
    if (Number.isFinite(s) && s >= 0) return clamp(s * 1000);
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return clamp(at - now);
  }
  for (const h of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens", "x-ratelimit-reset", "ratelimit-reset"]) {
    const v = headers.get(h)?.trim();
    if (!v) continue;
    // "6m0s", "1.5s", "20ms" (OpenAI style), seconds, or an epoch time in seconds.
    const dur = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/.exec(v);
    if (dur && dur[0] !== "") return clamp(((Number(dur[1] ?? 0) * 60 + Number(dur[2] ?? 0)) * 60 + Number(dur[3] ?? 0)) * 1000 + Number(dur[4] ?? 0));
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return clamp(n > 1e9 ? n * 1000 - now : n * 1000);
  }
  if (/\b(day|daily)\b/.test(text)) return clamp(nextUtcMidnight(now) - now);
  return DEFAULT_RATE_BACKOFF_MS;
}

/** The UTF-8 byte length: an upper bound on the tokens of a text for a byte-level tokenizer. */
const bytesOf = (s: string) => new TextEncoder().encode(s).byteLength;
const tokenBound = (messages: readonly ChatMessage[]) => messages.reduce((n, m) => n + bytesOf(m.content) + 16, 16);

// ---------------------------------------------------------------- per-system state (D1 model_router_state, model_router_global)

const stateCache = new WeakMap<D1Database, { at: number; row: RouterStateRow | null }>();
/** For tests and for the owner's route in this isolate: forget the cached state of this database. */
export function forgetRouterState(db: D1Database): void { stateCache.delete(db); }

const SWITCH_STATES = ROUTER_STATES.filter((s) => s !== "off_paid");

/** The global paid stop, or null when it cannot be read (migration 0091 not applied): every reader then fails closed. */
export async function readRouterGlobal(db: D1Database): Promise<RouterGlobalRow | null> {
  try {
    const g = await db.prepare("SELECT paid_off, updated_by, updated_at, reason FROM model_router_global WHERE id = 'global'")
      .first<{ paid_off: number; updated_by: string; updated_at: string; reason: string | null }>();
    if (!g || (g.paid_off !== 0 && g.paid_off !== 1)) return null;
    return { paid_off: g.paid_off === 1, updated_by: g.updated_by, updated_at: g.updated_at, reason: g.reason ?? null };
  } catch { return null; }
}

/**
 * One system's state (Cerebrum's by default, the kernel's router's): its own row and the global paid stop, read in one
 * statement. null (Beam off) when either is missing or malformed.
 */
export async function readRouterState(db: D1Database, system: RouterSystem = ROUTER_SYSTEM): Promise<RouterStateRow | null> {
  try {
    const r = await db.prepare(
      `SELECT s.state, s.mode, s.paid_cap_usd, s.spent_usd, s.updated_by, s.updated_at, s.reason, s.last_status_read_at, s.stopped_by_paid,
              g.paid_off AS g_paid_off, g.updated_by AS g_updated_by, g.updated_at AS g_updated_at, g.reason AS g_reason
         FROM model_router_state s LEFT JOIN model_router_global g ON g.id = 'global' WHERE s.system = ?`,
    ).bind(system).first<{ state: string; mode: string; paid_cap_usd: number | null; spent_usd: number; updated_by: string; updated_at: string; reason: string | null;
      last_status_read_at: string | null; stopped_by_paid: number; g_paid_off: number | null; g_updated_by: string | null; g_updated_at: string | null; g_reason: string | null }>();
    if (!r || !(SWITCH_STATES as readonly string[]).includes(r.state) || !(ROUTER_MODES as readonly string[]).includes(r.mode)) return null;
    if (r.g_paid_off !== 0 && r.g_paid_off !== 1) return null;
    const paid = r.g_paid_off === 1;
    return {
      state: paid ? "off_paid" : (r.state as RouterState), mode: r.mode as RouterMode,
      paid_cap_usd: typeof r.paid_cap_usd === "number" ? r.paid_cap_usd : null, spent_usd: Number(r.spent_usd) || 0,
      updated_by: paid ? String(r.g_updated_by) : r.updated_by, updated_at: paid ? String(r.g_updated_at) : r.updated_at, reason: paid ? r.g_reason ?? null : r.reason,
      system, switch: r.state as Exclude<RouterState, "off_paid">, last_status_read_at: r.last_status_read_at ?? null, stopped_by_paid: r.stopped_by_paid === 1,
    };
  } catch { return null; }
}

async function cachedState(db: D1Database, now: number): Promise<RouterStateRow | null> {
  const hit = stateCache.get(db);
  if (hit && now - hit.at < STATE_CACHE_MS && now >= hit.at) return hit.row;
  const row = await readRouterState(db, ROUTER_SYSTEM);
  stateCache.set(db, { at: now, row });
  return row;
}

/** A system's router agent read model_router.status: recorded at most once a minute; best effort, never throws. */
export async function recordStatusRead(db: D1Database, system: RouterSystem, now = Date.now()): Promise<void> {
  try {
    await db.prepare("UPDATE model_router_state SET last_status_read_at = ? WHERE system = ? AND (last_status_read_at IS NULL OR last_status_read_at < ?)")
      .bind(iso(now), system, iso(now - 60_000)).run();
  } catch { /* telemetry */ }
}

/**
 * A paid sign (free_only), or a reached paid cap, from any system (the kernel's router, or model_router.report_paid from
 * a system's router agent): Beam is off for every system, at once, until the owner clears it. The first sign, in one batch,
 * turns every switch that is on to off (stopped_by_paid, reason "paid sign: <signal>", by the reporter) and sets the
 * global stop, both only while the stop is not yet set; so clearing it later (one system turned on as paid_capped, or as
 * free_only with confirm_free) turns on only the system the owner clicked (coordinator review of 284b275). Idempotent: a
 * later sign while the stop is set writes nothing. One audit event lists the systems it turned off, and the owner hears
 * of it once through the owner channel (owner-inbox.ts production problem model_router_stopped, owner-notices.ts).
 */
export async function reportPaid(db: D1Database, by: string, signal: PaidSignal, now = Date.now(), system: RouterSystem = ROUTER_SYSTEM): Promise<{ state: RouterState; changed: boolean }> {
  const before = await readRouterState(db, system);
  const actor = by.slice(0, 120), t = iso(now), reason = `paid sign: ${signal}`;
  const [, stop] = await db.batch([
    db.prepare(
      `UPDATE model_router_state SET state = 'off', stopped_by_paid = 1, updated_by = ?, updated_at = ?, reason = ?
        WHERE state = 'on' AND EXISTS (SELECT 1 FROM model_router_global WHERE id = 'global' AND paid_off = 0)`,
    ).bind(actor, t, reason),
    db.prepare("UPDATE model_router_global SET paid_off = 1, updated_by = ?, updated_at = ?, reason = ? WHERE id = 'global' AND paid_off = 0").bind(actor, t, reason),
  ]);
  const changed = (stop?.meta.changes ?? 0) > 0;
  forgetRouterState(db);
  if (changed) {
    let turnedOff: string[] = [];
    try {
      turnedOff = ((await db.prepare("SELECT system FROM model_router_state WHERE stopped_by_paid = 1 AND updated_by = ? AND updated_at = ? AND reason = ? ORDER BY system")
        .bind(actor, t, reason).all<{ system: string }>()).results ?? []).map((r) => r.system);
    } catch { turnedOff = []; }
    await appendAuditEvent(db, { event_type: "model_router.paid_detected", actor, subject: "model_router", outcome: "off_paid",
      payload: { from: before?.state ?? null, to: "off_paid", signal, mode: before?.mode ?? null, model: BEAM_MODEL, provider: BEAM_PROVIDER, system, scope: "all_systems", turned_off: turnedOff } });
  }
  return { state: "off_paid", changed };
}

/** The contributor retention header: this system off until the owner turns it on again. Idempotent like reportPaid. */
export async function reportRetention(db: D1Database, by: string, now = Date.now(), system: RouterSystem = ROUTER_SYSTEM): Promise<{ changed: boolean }> {
  const before = await readRouterState(db, system);
  const r = await db.prepare(
    "UPDATE model_router_state SET state = 'off_retention', updated_by = ?, updated_at = ?, reason = ? WHERE system = ? AND state = 'on'",
  ).bind(by.slice(0, 120), iso(now), "retention header: contributor", system).run();
  const changed = (r.meta.changes ?? 0) > 0;
  forgetRouterState(db);
  if (changed) {
    await appendAuditEvent(db, { event_type: "model_router.retention_detected", actor: by.slice(0, 120), subject: "model_router", outcome: "off_retention",
      payload: { from: before?.state ?? null, to: "off_retention", header: RETENTION_HEADER, value: "contributor", model: BEAM_MODEL, provider: BEAM_PROVIDER, system } });
  }
  return { changed };
}

export class ModelRouterError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

/**
 * The owner's switch of one system (POST /v1/model-router/state; the kernel checks the owner). Body: {system?, state: "on"
 * | "off", mode?, paid_cap_usd?, confirm_free?, reason?}; system is "cerebrum" (the default, as before migration 0091),
 * "cta" or "xauusd". "on" needs free_only, or paid_capped with an explicit cap in (0, MAX_PAID_CAP_USD]. After a paid sign
 * (the global stop, every system off_paid), free_only needs the owner's explicit confirm_free: true (coordinator review,
 * 2026-11-25: the owner may judge the sign was not a charge); free_only then still goes off again at the next paid sign.
 * Turning any system on after a paid sign (paid_capped, or free_only with confirm_free) clears the stop for every system
 * (owner 2026-11-26) and turns on only that system: the first paid sign turned every switch that was on to off, so each
 * other system stays off until the owner turns it on (coordinator review). Turning a system off never clears it. Each
 * change is audited (model_router.state_changed, with its system and from state; model_router.paid_cleared when the stop
 * is cleared); turning Cerebrum on closes its router's breaker; turning a system on starts its paid spend from 0.
 */
export async function setRouterState(db: D1Database, actor: string, body: Record<string, unknown>, now = Date.now()): Promise<{ changed: boolean; state: RouterStateRow | null }> {
  const extra = Object.keys(body).filter((k) => !["system", "state", "mode", "paid_cap_usd", "confirm_free", "reason"].includes(k));
  if (extra.length) throw new ModelRouterError(400, "unknown_field", `the body carries only system, state, mode, paid_cap_usd, confirm_free and reason, not ${extra.slice(0, 3).join(", ")}`);
  if (body.system !== undefined && !isRouterSystem(body.system)) throw new ModelRouterError(400, "invalid_system", `system is ${ROUTER_SYSTEMS.join(", ")} (default cerebrum)`);
  const system: RouterSystem = body.system === undefined ? ROUTER_SYSTEM : (body.system as RouterSystem);
  if (body.confirm_free !== undefined && body.confirm_free !== true) throw new ModelRouterError(400, "invalid_confirm_free", "confirm_free is true or absent");
  const confirmFree = body.confirm_free === true;
  if (body.state !== "on" && body.state !== "off") throw new ModelRouterError(400, "invalid_state", "state is on or off");
  const reason = body.reason === undefined || body.reason === null ? null : typeof body.reason === "string" && body.reason.trim().length <= 300 ? body.reason.trim() || null : undefined;
  if (reason === undefined) throw new ModelRouterError(400, "invalid_reason", "the reason is text of at most 300 characters");
  if (reason !== null && /[A-Za-z0-9_-]{32,}|sk-[A-Za-z0-9]/.test(reason)) throw new ModelRouterError(400, "secret_in_reason", "the reason looks like it carries a key; never paste a key here");
  const before = await readRouterState(db, system);
  if (!before) throw new ModelRouterError(503, "model_router_unavailable", "migrations 0090 and 0091 are not applied");
  const paid = before.state === "off_paid";
  let next: { state: Exclude<RouterState, "off_paid">; mode: RouterMode; cap: number | null };
  if (body.state === "off") {
    if (body.mode !== undefined || body.paid_cap_usd !== undefined || confirmFree) throw new ModelRouterError(400, "invalid_request", "turning Beam off takes no mode, cap or confirm_free");
    next = { state: "off_owner", mode: before.mode, cap: before.paid_cap_usd };
  } else {
    const mode = body.mode === undefined ? "free_only" : body.mode;
    if (mode !== "free_only" && mode !== "paid_capped") throw new ModelRouterError(400, "invalid_mode", "mode is free_only or paid_capped");
    if (mode === "free_only") {
      if (body.paid_cap_usd !== undefined) throw new ModelRouterError(400, "invalid_request", "a paid cap goes only with mode paid_capped");
      if (paid && !confirmFree) throw new ModelRouterError(409, "paid_sign_recorded", "Beam showed a paid sign; turn it on as free_only only with confirm_free: true, or as paid_capped with an explicit cap, or leave it off");
      next = { state: "on", mode, cap: null };
    } else {
      const cap = body.paid_cap_usd;
      if (confirmFree) throw new ModelRouterError(400, "invalid_request", "confirm_free goes only with mode free_only");
      if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0 || cap > MAX_PAID_CAP_USD) throw new ModelRouterError(400, "invalid_paid_cap", `paid_capped needs paid_cap_usd, a number above 0 and at most ${MAX_PAID_CAP_USD}`);
      next = { state: "on", mode, cap: Math.round(cap * 100) / 100 };
    }
  }
  const clearsPaid = paid && next.state === "on";
  const same = before.switch === next.state && before.mode === next.mode && before.paid_cap_usd === next.cap;
  if (same && !clearsPaid) return { changed: false, state: before };
  const t = iso(now);
  const writes = [
    db.prepare(
      `UPDATE model_router_state SET state = ?, mode = ?, paid_cap_usd = ?, spent_usd = CASE WHEN ? = 'on' THEN 0 ELSE spent_usd END, stopped_by_paid = 0, updated_by = ?, updated_at = ?, reason = ? WHERE system = ?`,
    ).bind(next.state, next.mode, next.cap, next.state, actor.slice(0, 120), t, reason ?? (next.state === "on" ? `turned on (${next.mode})` : "turned off by the owner"), system),
  ];
  if (clearsPaid) {
    writes.push(db.prepare("UPDATE model_router_global SET paid_off = 0, updated_by = ?, updated_at = ?, reason = ? WHERE id = 'global' AND paid_off = 1")
      .bind(actor.slice(0, 120), t, `cleared by the owner (${next.mode === "paid_capped" ? "paid_capped" : "confirm_free"}, ${system})`));
  }
  if (next.state === "on" && system === ROUTER_SYSTEM) {
    writes.push(db.prepare("UPDATE model_router_health SET consecutive_failures = 0, breaker_open_until = NULL, probe_until = NULL, updated_at = ? WHERE id = 'beam'").bind(t));
  }
  await db.batch(writes);
  forgetRouterState(db);
  await appendAuditEvent(db, { event_type: "model_router.state_changed", actor, subject: "model_router", outcome: next.state,
    payload: { system, from: before.state, to: next.state, mode: next.mode, paid_cap_usd: next.cap, reason, ...(confirmFree && paid ? { confirm_free: true } : {}) } });
  if (clearsPaid) {
    await appendAuditEvent(db, { event_type: "model_router.paid_cleared", actor, subject: "model_router", outcome: "cleared",
      payload: { via_system: system, mode: next.mode, scope: "all_systems", ...(confirmFree ? { confirm_free: true } : { paid_cap_usd: next.cap }) } });
  }
  return { changed: true, state: await readRouterState(db, system) };
}

// ---------------------------------------------------------------- the router

export interface ModelRouterOptions {
  db: D1Database;
  env: ModelRouterEnv;
  fetch?: Fetch;
  now?: () => number;
  /** Tests only: a shorter timeout than BEAM_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Who writes a paid or retention switch: the router acts as the kernel. */
  actor?: string;
}

interface HealthRow { consecutive_failures: number; breaker_open_until: string | null; probe_until: string | null; rate_limited_until: string | null }
const at = (v: string | null | undefined) => { const t = Date.parse(String(v ?? "")); return Number.isFinite(t) ? t : null; };

let lastPrune = 0;

export class ModelRouter {
  private readonly db: D1Database;
  private readonly env: ModelRouterEnv;
  private readonly fetchImpl: Fetch;
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  private readonly actor: string;

  constructor(o: ModelRouterOptions) {
    this.db = o.db;
    this.env = o.env;
    this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
    this.clock = o.now ?? Date.now;
    this.timeoutMs = o.timeoutMs && o.timeoutMs > 0 ? Math.min(o.timeoutMs, BEAM_TIMEOUT_MS) : BEAM_TIMEOUT_MS;
    this.actor = o.actor ?? "system:model-router";
  }

  /** Whether this task is Beam's at all (R1). A task that is not is neither routed nor metered by the router. */
  routes(task: string): boolean { return isRoutedTask(task); }

  /** Why Beam is not configured on this deploy, or null: the var MODEL_ROUTER, the secret, the base URL. */
  private disabled(): boolean { return !routerVarOn(this.env) || !routerKeyPresent(this.env) || routerBaseUrl(this.env) === null; }

  private async health(): Promise<HealthRow | null> {
    try { return await this.db.prepare("SELECT consecutive_failures, breaker_open_until, probe_until, rate_limited_until FROM model_router_health WHERE id = 'beam'").first<HealthRow>(); } catch { return null; }
  }

  /** Reserve one request and the call's token bound in the minute and day counters; false when a limit would be passed. */
  private async reserve(now: number, inBound: number, outBound: number): Promise<boolean> {
    const l = routerLimits(this.env);
    const minute = `min:${minuteOf(now)}`, day = `day:${dayOf(now)}`, t = iso(now);
    const m = await this.db.prepare(
      `INSERT INTO model_router_counters (bucket, requests, in_tokens, out_tokens, updated_at) SELECT ?, 1, 0, 0, ? WHERE 1 <= ?
       ON CONFLICT(bucket) DO UPDATE SET requests = requests + 1, updated_at = excluded.updated_at WHERE requests < ?`,
    ).bind(minute, t, l.rpm, l.rpm).run();
    if ((m.meta.changes ?? 0) === 0) return false;
    const d = await this.db.prepare(
      `INSERT INTO model_router_counters (bucket, requests, in_tokens, out_tokens, updated_at) SELECT ?, 1, ?, ?, ? WHERE 1 <= ? AND ? <= ? AND ? <= ?
       ON CONFLICT(bucket) DO UPDATE SET requests = requests + 1, in_tokens = in_tokens + excluded.in_tokens, out_tokens = out_tokens + excluded.out_tokens, updated_at = excluded.updated_at
       WHERE requests < ? AND in_tokens + excluded.in_tokens <= ? AND out_tokens + excluded.out_tokens <= ?`,
    ).bind(day, inBound, outBound, t, l.requests_day, inBound, l.input_tokens_day, outBound, l.output_tokens_day, l.requests_day, l.input_tokens_day, l.output_tokens_day).run();
    if ((d.meta.changes ?? 0) === 0) {
      await this.db.prepare("UPDATE model_router_counters SET requests = MAX(0, requests - 1) WHERE bucket = ?").bind(minute).run();
      return false;
    }
    if (now - lastPrune > 600_000 || now < lastPrune) {
      lastPrune = now;
      try { await this.db.prepare("DELETE FROM model_router_counters WHERE bucket GLOB 'min:*' AND bucket < ?").bind(`min:${minuteOf(now - 3_600_000)}`).run(); } catch { /* telemetry */ }
    }
    return true;
  }

  /** Give back a reservation that was never sent (the half-open probe was taken by another call). */
  private async release(now: number, inBound: number, outBound: number): Promise<void> {
    try {
      await this.db.batch([
        this.db.prepare("UPDATE model_router_counters SET requests = MAX(0, requests - 1) WHERE bucket = ?").bind(`min:${minuteOf(now)}`),
        this.db.prepare("UPDATE model_router_counters SET requests = MAX(0, requests - 1), in_tokens = MAX(0, in_tokens - ?), out_tokens = MAX(0, out_tokens - ?) WHERE bucket = ?")
          .bind(inBound, outBound, `day:${dayOf(now)}`),
      ]);
    } catch { /* telemetry */ }
  }

  /** Replace the reserved token bound with what the provider reported (or keep the bound when it reported nothing). */
  private async settleTokens(now: number, inBound: number, outBound: number, used: { input: number; output: number } | null, refund: boolean): Promise<void> {
    if (!used && !refund) return;
    const inUsed = used ? used.input : 0, outUsed = used ? used.output : 0;
    try {
      await this.db.prepare("UPDATE model_router_counters SET in_tokens = MAX(0, in_tokens - ? + ?), out_tokens = MAX(0, out_tokens - ? + ?) WHERE bucket = ?")
        .bind(inBound, inUsed, outBound, outUsed, `day:${dayOf(now)}`).run();
    } catch { /* telemetry */ }
  }

  private async failure(now: number): Promise<void> {
    try {
      await this.db.prepare(
        `UPDATE model_router_health SET consecutive_failures = consecutive_failures + 1,
           breaker_open_until = CASE WHEN consecutive_failures + 1 >= ? OR breaker_open_until IS NOT NULL THEN ? ELSE breaker_open_until END,
           probe_until = NULL, updated_at = ? WHERE id = 'beam'`,
      ).bind(BREAKER_FAILURES, iso(now + BREAKER_OPEN_MS), iso(now)).run();
    } catch { /* the breaker is best effort; the call already falls back */ }
  }

  private async success(now: number): Promise<void> {
    try {
      await this.db.prepare("UPDATE model_router_health SET consecutive_failures = 0, breaker_open_until = NULL, probe_until = NULL, updated_at = ? WHERE id = 'beam' AND (consecutive_failures != 0 OR breaker_open_until IS NOT NULL OR probe_until IS NOT NULL)")
        .bind(iso(now)).run();
    } catch { /* best effort */ }
  }

  /** An answer cut at its output limit: neither a failure nor a success; a half-open probe's lease is freed for the next call. */
  private async releaseProbe(now: number): Promise<void> {
    try {
      await this.db.prepare("UPDATE model_router_health SET probe_until = NULL, updated_at = ? WHERE id = 'beam' AND probe_until IS NOT NULL").bind(iso(now)).run();
    } catch { /* best effort */ }
  }

  private async rateLimited(now: number, ms: number): Promise<void> {
    try {
      await this.db.prepare("UPDATE model_router_health SET rate_limited_until = ?, probe_until = NULL, updated_at = ? WHERE id = 'beam'").bind(iso(now + ms), iso(now)).run();
    } catch { /* best effort */ }
  }

  /**
   * Add a cost to the paid spend and compare the stored total (UPDATE ... RETURNING, one statement) with the cap, so calls
   * that run at once cannot overshoot it on a stale cached total (coordinator review, 2026-11-25). The cap is read in the
   * same statement. Fails closed.
   */
  private async addSpend(now: number, usd: number): Promise<"ok" | "cap"> {
    try {
      const row = await this.db.prepare("UPDATE model_router_state SET spent_usd = spent_usd + ? WHERE system = 'cerebrum' RETURNING spent_usd, paid_cap_usd")
        .bind(usd).first<{ spent_usd: number; paid_cap_usd: number | null }>();
      forgetRouterState(this.db);
      if (!row) return "cap";
      const spent = Number(row.spent_usd), cap = typeof row.paid_cap_usd === "number" ? row.paid_cap_usd : null;
      if (!Number.isFinite(spent) || cap === null || spent >= cap) { await reportPaid(this.db, this.actor, "paid_cap_reached", now); return "cap"; }
    } catch { /* fail closed below */ return "cap"; }
    return "ok";
  }

  /**
   * One Beam attempt for an allow-listed task: "skip" with the reason when Beam must not or cannot answer, else Beam's
   * completion for AiEngine to validate exactly as a Workers AI one. Never throws.
   */
  async attempt(task: string, messages: readonly ChatMessage[], maxTokens: number): Promise<BeamAttempt> {
    try {
      return await this.attemptOnce(task, messages, maxTokens);
    } catch {
      return { kind: "skip", reason: "unreachable" };
    }
  }

  private async attemptOnce(task: string, messages: readonly ChatMessage[], maxTokens: number): Promise<BeamAttempt> {
    if (!this.routes(task)) return { kind: "skip", reason: "disabled" };
    if (this.disabled()) return { kind: "skip", reason: "disabled" };
    const now = this.clock();
    const state = await cachedState(this.db, now);
    if (!state) return { kind: "skip", reason: "off" };
    const off = stateReason(state.state);
    if (off) return { kind: "skip", reason: off };
    const h = await this.health();
    if (!h) return { kind: "skip", reason: "off" };
    const rateUntil = at(h.rate_limited_until);
    if (rateUntil !== null && rateUntil > now) return { kind: "skip", reason: "rate" };
    const openUntil = at(h.breaker_open_until);
    if (openUntil !== null && openUntil > now) return { kind: "skip", reason: "breaker" };
    const probeHeld = at(h.probe_until);
    if (openUntil !== null && probeHeld !== null && probeHeld > now) return { kind: "skip", reason: "breaker" };

    // Beam's output margin: its reasoning counts as output (beamOutputTokens; the Workers AI path keeps maxTokens).
    const inBound = tokenBound(messages), outBound = beamOutputTokens(maxTokens);
    if (!(await this.reserve(now, inBound, outBound))) return { kind: "skip", reason: "budget" };
    if (openUntil !== null) {
      // Half-open: exactly one probe may run; another call meanwhile stays on Workers AI.
      const lease = await this.db.prepare(
        "UPDATE model_router_health SET probe_until = ?, updated_at = ? WHERE id = 'beam' AND breaker_open_until IS NOT NULL AND breaker_open_until <= ? AND (probe_until IS NULL OR probe_until <= ?)",
      ).bind(iso(now + PROBE_LEASE_MS), iso(now), iso(now), iso(now)).run();
      if ((lease.meta.changes ?? 0) === 0) { await this.release(now, inBound, outBound); return { kind: "skip", reason: "breaker" }; }
    }

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${routerBaseUrl(this.env)}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${String(this.env.REFLECTION_API_KEY).trim()}` },
        body: JSON.stringify({ model: BEAM_MODEL, messages, max_completion_tokens: outBound, reasoning_effort: "low" }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      // A timeout may have reached the provider: its token bound stays reserved. A network error is refunded.
      const timedOut = controller.signal.aborted || /abort|timeout/i.test(String((err as Error)?.name ?? "") + String((err as Error)?.message ?? ""));
      await this.settleTokens(now, inBound, outBound, null, !timedOut);
      await this.failure(now);
      return { kind: "skip", reason: "unreachable" };
    }
    let body: unknown = null;
    let raw = "";
    try {
      raw = await res.text();
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    } finally {
      clearTimeout(timer);
    }
    const latency = Date.now() - started;
    const usage = usageCounts(body);
    await this.settleTokens(now, inBound, outBound, usage, !usage && !res.ok);

    // Retention first: a contributor answer is not used, and Beam stays off until the owner turns it on again.
    if (/\bcontributor\b/i.test(res.headers.get(RETENTION_HEADER) ?? "")) {
      await reportRetention(this.db, this.actor, now);
      return { kind: "skip", reason: "retention" };
    }
    const text = res.ok ? "" : errorText(body ?? raw.slice(0, 600));
    // HTTP 429 is always a rate or quota answer, whatever its text says (coordinator review, 2026-11-25: a free daily quota
    // says "daily limit exceeded ... upgrade your plan for higher limits", which is not a charge). It backs off until the
    // reset (Retry-After, a rate-limit header, a daily quota to 00:00 UTC) and never turns Beam off.
    if (res.status === 429) {
      await this.rateLimited(now, rateBackoffMs(res.headers, now, text));
      return { kind: "skip", reason: "rate" };
    }
    // A paid sign: HTTP 402, a billing, credit or payment error on another 4xx, a plan that is not free, or a non-zero cost.
    const signal: PaidSignal | null = res.status === 402 ? "http_402"
      : res.status >= 400 && res.status < 500 && BILLING.test(text) ? "billing_error"
      : planChanged(res.headers) ? "plan_change"
      : res.ok && costOf(body) > 0 ? "cost_field" : null;
    if (signal) {
      // paid_capped (the owner's explicit cap): a cost is spent against the cap, a plan header is expected; a 402 or a
      // billing error still means Beam cannot be paid, so it is off. free_only: every paid sign turns Beam off.
      if (state.mode === "paid_capped" && signal === "cost_field") {
        if ((await this.addSpend(now, costOf(body))) === "cap") return { kind: "skip", reason: "paid" };
      } else if (!(state.mode === "paid_capped" && signal === "plan_change")) {
        await reportPaid(this.db, this.actor, signal, now);
        return { kind: "skip", reason: "paid" };
      }
    }
    if (!res.ok && res.status < 500 && RATE.test(text)) {
      await this.rateLimited(now, rateBackoffMs(res.headers, now, text));
      return { kind: "skip", reason: "rate" };
    }
    if (!res.ok || body === null || typeof body !== "object") {
      await this.failure(now);
      return { kind: "skip", reason: "unreachable" };
    }
    return {
      kind: "answer", completion: body, latency_ms: latency,
      settle: async (usable: boolean | "output_budget") => {
        if (usable === "output_budget") await this.releaseProbe(this.clock());
        else if (usable) await this.success(this.clock());
        else await this.failure(this.clock());
      },
    };
  }

  /** One row of the daily ledger (model_calls_daily). Never a prompt, an answer or a key; never throws. */
  async meter(task: string, m: RouteMeter): Promise<void> {
    if (!this.routes(task)) return;
    const reason = m.fallback && (FALLBACK_REASONS as readonly string[]).includes(m.fallback) ? m.fallback : null;
    try {
      await this.db.prepare(
        `INSERT INTO model_calls_daily (day, system, purpose, provider, model, calls, in_tokens, out_tokens, latency_ms, fallbacks_json)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, CASE WHEN ? IS NULL THEN '{}' ELSE json_object(?, 1) END)
         ON CONFLICT(day, system, purpose, provider, model) DO UPDATE SET calls = calls + 1, in_tokens = in_tokens + excluded.in_tokens,
           out_tokens = out_tokens + excluded.out_tokens, latency_ms = latency_ms + excluded.latency_ms,
           fallbacks_json = CASE WHEN ? IS NULL THEN fallbacks_json ELSE json_set(fallbacks_json, '$.' || ?, COALESCE(json_extract(fallbacks_json, '$.' || ?), 0) + 1) END`,
      ).bind(dayOf(this.clock()), ROUTER_SYSTEM, task, m.provider, m.model.slice(0, 100), Math.max(0, Math.round(m.in_tokens)), Math.max(0, Math.round(m.out_tokens)),
        Math.max(0, Math.round(m.latency_ms)), reason, reason, reason, reason, reason).run();
    } catch { /* telemetry never breaks the caller */ }
  }
}

/** The reported token counts of an OpenAI-style answer, or null. */
function usageCounts(body: unknown): { input: number; output: number } | null {
  const u = (body as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u || typeof u !== "object") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  const input = n(u.prompt_tokens ?? u.input_tokens), output = n(u.completion_tokens ?? u.output_tokens);
  return input || output ? { input, output } : null;
}

/** The router of a Worker's env (the kernel's: ai-kernel wrangler.toml vars and the secret REFLECTION_API_KEY). */
export function modelRouterFor(env: ModelRouterEnv, db: D1Database, options: Omit<ModelRouterOptions, "db" | "env"> = {}): ModelRouter {
  return new ModelRouter({ db, env, ...options });
}

// ---------------------------------------------------------------- the status read (GET /v1/model-router, model_router.status)

const stateView = (r: RouterStateRow) => ({ state: r.state, mode: r.mode, paid_cap_usd: r.paid_cap_usd, spent_usd: r.spent_usd, updated_by: r.updated_by, updated_at: r.updated_at, reason: r.reason, switch: r.switch, stopped_by_paid: r.stopped_by_paid });
const globalView = (g: RouterGlobalRow | null) => (g ? { paid_off: g.paid_off, updated_by: g.updated_by, updated_at: g.updated_at, reason: g.reason } : null);
const kernelDisabled = (env: ModelRouterEnv) => !routerVarOn(env) || !routerKeyPresent(env) || routerBaseUrl(env) === null;
/** A system's effective state: off without a row; Cerebrum's is "disabled" while the kernel's deploy cannot call Beam. */
const effectiveOf = (system: RouterSystem, r: RouterStateRow | null, env: ModelRouterEnv): string => !r ? "off" : system === ROUTER_SYSTEM && kernelDisabled(env) ? "disabled" : r.state;

/**
 * The status read. GET /v1/model-router (operators; the Console): Cerebrum's view as before (state, effective, health,
 * limits, today, ledger, fallbacks), the global paid stop (global), and every system's row (systems: state, effective,
 * last_status_read_at). The schema string and the existing fields never change.
 */
export async function modelRouterStatus(db: D1Database, env: ModelRouterEnv, now = Date.now()): Promise<Record<string, unknown>> {
  const out = await statusOf(db, env, ROUTER_SYSTEM, now);
  const systems = [];
  for (const system of ROUTER_SYSTEMS) {
    const r = await readRouterState(db, system);
    systems.push({ system, available: r !== null, state: r ? stateView(r) : null, effective: effectiveOf(system, r, env), last_status_read_at: r?.last_status_read_at ?? null });
  }
  return { ...out, systems };
}

/**
 * model_router.status (tier 0) for the calling agent's system (routerSystemOfOrigin): the same schema and fields, with
 * system, state and effective that system's own (state.state the effective state: off_paid while the global stop is set).
 * Cerebrum's own ledger, counters and limits go only to Cerebrum (another system reads tasks [], limits null, today null,
 * ledger [] and fallbacks {}); the breaker (the provider's health as the kernel's router sees it) and the global stop go
 * to every caller. Never another system's row. Records the read (last_status_read_at, at most once a minute).
 */
export async function modelRouterStatusFor(db: D1Database, env: ModelRouterEnv, system: RouterSystem, now = Date.now()): Promise<Record<string, unknown>> {
  await recordStatusRead(db, system, now);
  return await statusOf(db, env, system, now);
}

async function statusOf(db: D1Database, env: ModelRouterEnv, system: RouterSystem, now: number): Promise<Record<string, unknown>> {
  const state = await readRouterState(db, system);
  const global = await readRouterGlobal(db);
  const own = system === ROUTER_SYSTEM;
  let health: HealthRow | null = null;
  try { health = await db.prepare("SELECT consecutive_failures, breaker_open_until, probe_until, rate_limited_until FROM model_router_health WHERE id = 'beam'").first<HealthRow>(); } catch { health = null; }
  const day = dayOf(now);
  let counters: { bucket: string; requests: number; in_tokens: number; out_tokens: number }[] = [];
  let ledger: Record<string, unknown>[] = [];
  if (own) {
    try {
      counters = (await db.prepare("SELECT bucket, requests, in_tokens, out_tokens FROM model_router_counters WHERE bucket IN (?, ?)").bind(`day:${day}`, `min:${minuteOf(now)}`)
        .all<{ bucket: string; requests: number; in_tokens: number; out_tokens: number }>()).results ?? [];
      ledger = ((await db.prepare("SELECT purpose, provider, model, calls, in_tokens, out_tokens, latency_ms, fallbacks_json FROM model_calls_daily WHERE day = ? AND system = ? ORDER BY purpose, provider, model")
        .bind(day, ROUTER_SYSTEM).all<Record<string, unknown>>()).results ?? []).map((r) => {
        let fallbacks: Record<string, number> = {};
        try { const f = JSON.parse(String(r.fallbacks_json ?? "{}")); if (f && typeof f === "object" && !Array.isArray(f)) fallbacks = f; } catch { fallbacks = {}; }
        return { purpose: r.purpose, provider: r.provider, model: r.model, calls: r.calls, in_tokens: r.in_tokens, out_tokens: r.out_tokens, latency_ms: r.latency_ms, fallbacks };
      });
    } catch { counters = []; ledger = []; }
  }
  const dayRow = counters.find((c) => c.bucket.startsWith("day:")) ?? null;
  const minRow = counters.find((c) => c.bucket.startsWith("min:")) ?? null;
  const openUntil = at(health?.breaker_open_until), rateUntil = at(health?.rate_limited_until);
  const breaker = !health ? null : openUntil === null ? "closed" : openUntil > now ? "open" : "half_open";
  const fallbacks: Record<string, number> = {};
  for (const r of ledger) for (const [k, v] of Object.entries(r.fallbacks as Record<string, number>)) if (typeof v === "number") fallbacks[k] = (fallbacks[k] ?? 0) + v;
  return {
    schema: "model_router.status.v1",
    available: state !== null,
    system,
    provider: BEAM_PROVIDER,
    model: BEAM_MODEL,
    tasks: own ? [...ROUTER_TASKS] : [],
    configured: { var_on: routerVarOn(env), key_present: routerKeyPresent(env), base_url_valid: routerBaseUrl(env) !== null },
    state: state ? stateView(state) : null,
    effective: effectiveOf(system, state, env),
    health: health ? { breaker, consecutive_failures: health.consecutive_failures, breaker_open_until: health.breaker_open_until, rate_limited_until: rateUntil !== null && rateUntil > now ? health.rate_limited_until : null } : null,
    limits: own ? routerLimits(env) : null,
    today: own ? { day, requests: dayRow?.requests ?? 0, in_tokens: dayRow?.in_tokens ?? 0, out_tokens: dayRow?.out_tokens ?? 0, this_minute: minRow?.requests ?? 0 } : null,
    ledger,
    fallbacks,
    global: globalView(global),
    last_status_read_at: state?.last_status_read_at ?? null,
    generated_at: iso(now),
  };
}
