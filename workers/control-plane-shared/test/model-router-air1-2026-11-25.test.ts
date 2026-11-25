// AIR1, the model router (ADR-0007 amendment 2026-11-25; owner: "Approve, but Cerebrum only"; earlier: "tetap siapkan
// callback jika beam tidak bisa dijangkau atau menjadi berbayar atau lebih dari batasan"). Beam answers Cerebrum's chat,
// directive drafts and councils first, free_only; every other case returns the Workers AI answer with its reason metered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, fakeAi, migratedDb, req } from "./harness.ts";
import { AiEngine, BEAM_MODEL_ID, type AiTask } from "../src/ai-engine.ts";
import { CHAT_MODEL, CHAT_MODELS, CHAT_SERVICE } from "../src/conversation.ts";
import {
  BEAM_MODEL, BREAKER_OPEN_MS, DEFAULT_LIMITS, DEFAULT_MODEL_BASE_URL, FALLBACK_REASONS, ModelRouter, ModelRouterError, NEVER_ROUTED_TASKS, ROUTER_TASKS, forgetRouterState,
  modelRouterStatus, rateBackoffMs, readRouterState, reportPaid, setRouterState, type ModelRouterEnv,
} from "../src/model-router.ts";
import { CAPABILITIES, hourlyLimit } from "../src/capabilities.ts";
import { EXTERNAL_CEILING, EXTERNAL_ORIGINS, externalCeilingFor } from "../src/organism.ts";
import { PROBLEM_KINDS } from "../src/owner-inbox-rank.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { unhandledProblems } from "../../ai-kernel/src/owner-inbox.ts";
import { reconcileNotices } from "../../ai-kernel/src/owner-notices.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const KEY = "rk-test-KEY-0123456789-never-stored";
const PROMPT = "PROMPT-MARKER-the owner asks about the deploy stall";
const T0 = Date.parse("2026-11-25T10:00:30.000Z");
const ON: ModelRouterEnv = { MODEL_ROUTER: "on", REFLECTION_API_KEY: KEY };

interface Answer { answer: string }
const task = (name: string): AiTask<Answer> => ({
  name, instructions: "Answer the question.", maxInputChars: 20_000, maxOutputTokens: 600,
  validate: (o) => (o && typeof (o as Answer).answer === "string" && (o as Answer).answer.length > 0 ? { answer: (o as Answer).answer } : null),
});
const WAI = '{"answer":"from workers ai"}';
const beamBody = (content: unknown, usage: Record<string, unknown> = { prompt_tokens: 120, completion_tokens: 30 }, finish = "stop") =>
  JSON.stringify({ id: "x", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }], usage });
const ok = (content: unknown = '{"answer":"from beam"}', headers: Record<string, string> = {}, usage?: Record<string, unknown>) =>
  new Response(beamBody(content, usage), { status: 200, headers: { "content-type": "application/json", "reflection-data-retention": "none", ...headers } });
const status = (code: number, body: unknown = { error: { message: "server error" } }, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json", ...headers } });

type Reply = Response | (() => Response | Promise<Response>) | Error;
/** A world: one migrated database, a Workers AI fake, a scripted Beam, a clock. */
function world(o: { env?: ModelRouterEnv; on?: boolean; timeoutMs?: number } = {}) {
  const db = migratedDb();
  forgetRouterState(db);
  const ai = fakeAi({ response: WAI });
  const clock = { now: T0 };
  const fetches: { url: string; init: RequestInit; body: any }[] = [];
  const script: Reply[] = [];
  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    fetches.push({ url, init, body: JSON.parse(String(init.body)) });
    const next = script.length ? script.shift()! : ok();
    if (next instanceof Error) throw next;
    return typeof next === "function" ? await next() : next;
  };
  const env = o.env ?? ON;
  const router = new ModelRouter({ db, env, fetch: fetcher, now: () => clock.now, timeoutMs: o.timeoutMs });
  const engine = new AiEngine({ service: CHAT_SERVICE, ai, db, allowedModels: CHAT_MODELS, model: CHAT_MODEL, ownBudget: async () => true, router,
    allowedTasks: [...ROUTER_TASKS, "evolve_plan", "evolve_write", "draft_recovery_proposal", "embed"] });
  const run = (name = "chat_answer", question = PROMPT) => engine.run(task(name), { question }, "c1");
  const ledger = () => (db.raw.prepare("SELECT * FROM model_calls_daily ORDER BY purpose, provider").all() as any[]).map((r) => ({ ...r, fallbacks: JSON.parse(r.fallbacks_json) }));
  const health = () => ({ ...(db.raw.prepare("SELECT * FROM model_router_health WHERE id = 'beam'").get() as any) });
  const events = (type: string) => db.raw.prepare("SELECT * FROM audit_events WHERE event_type = ? ORDER BY rowid").all(type) as any[];
  const resetHealth = () => db.raw.prepare("UPDATE model_router_health SET consecutive_failures = 0, breaker_open_until = NULL, probe_until = NULL, rate_limited_until = NULL").run();
  return { db, ai, clock, fetches, script, router, engine, run, ledger, health, events, resetHealth, env };
}
async function on(db: Db, body: Record<string, unknown> = { state: "on" }) {
  const r = await setRouterState(db, APPROVER_EMAIL, body);
  forgetRouterState(db);
  return r;
}
const wai = (w: ReturnType<typeof world>, purpose = "chat_answer") => w.ledger().find((r) => r.purpose === purpose && r.provider === "workers_ai");
const beam = (w: ReturnType<typeof world>, purpose = "chat_answer") => w.ledger().find((r) => r.purpose === purpose && r.provider === "reflection");

test("AIR1-1. on and free: Beam answers an allow-listed task with the CTA contract; Workers AI is not called; the call is metered", async () => {
  const w = world();
  await on(w.db);
  const r = await w.run();
  assert.equal(r.status, "ok");
  assert.deepEqual(r.status === "ok" && [r.data.answer, r.model, r.provider, r.usage?.input, r.usage?.output], ["from beam", BEAM_MODEL, "reflection", 120, 30]);
  assert.equal(w.ai.calls.length, 0);
  assert.equal(w.fetches.length, 1);
  const f = w.fetches[0];
  assert.equal(f.url, `${DEFAULT_MODEL_BASE_URL}/chat/completions`);
  assert.equal(f.init.method, "POST");
  assert.equal((f.init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
  assert.deepEqual(Object.keys(f.body).sort(), ["max_completion_tokens", "messages", "model", "reasoning_effort"]);
  assert.deepEqual([f.body.model, f.body.max_completion_tokens, f.body.reasoning_effort, f.body.messages.map((m: any) => m.role)], [BEAM_MODEL, 600, "low", ["system", "user"]]);
  assert.equal(BEAM_MODEL_ID, BEAM_MODEL, "ai-engine.ts and model-router.ts name the same model");
  assert.equal(DEFAULT_MODEL_BASE_URL, "https://api.reflection.ai/openai/v1");
  const row = beam(w)!;
  assert.deepEqual([row.system, row.model, row.calls, row.in_tokens, row.out_tokens, row.fallbacks], ["cerebrum", BEAM_MODEL, 1, 120, 30, {}]);
  assert.equal(wai(w), undefined);
  assert.equal(w.health().consecutive_failures, 0);
});

test("AIR1-2. unreachable: a timeout, a network error, a 5xx, an empty answer, invalid JSON, a schema mismatch and a non-JSON body each return the Workers AI answer, metered unreachable", async () => {
  const w = world({ timeoutMs: 40 });
  await on(w.db);
  const hang = () => new Promise<Response>((_, reject) => {
    const signal = w.fetches[w.fetches.length - 1].init.signal!;
    signal.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })));
  });
  const cases: [string, Reply][] = [
    ["timeout", hang], ["network error", new TypeError("fetch failed")], ["503", status(503)], ["empty", ok("")], ["invalid JSON", ok("no json here")],
    ["schema mismatch", ok('{"wrong":1}')], ["not JSON", new Response("<html>bad gateway</html>", { status: 200 })], ["cut off at the limit", () => new Response(beamBody('{"answer":"cut', undefined, "length"), { status: 200 })],
  ];
  for (const [name, reply] of cases) {
    w.resetHealth();
    w.script.push(reply);
    const before = w.ai.calls.length;
    const r = await w.run();
    assert.equal(r.status, "ok", name);
    assert.deepEqual(r.status === "ok" && [r.data.answer, r.model, r.provider], ["from workers ai", CHAT_MODEL, "workers_ai"], name);
    assert.equal(w.ai.calls.length, before + 1, name);
    assert.equal(w.health().consecutive_failures, 1, `${name} counts for the breaker`);
  }
  assert.deepEqual(wai(w)!.fallbacks, { unreachable: cases.length });
  assert.equal(wai(w)!.calls, cases.length);
  assert.equal(beam(w), undefined, "no Beam answer was used");
});

test("AIR1-3. over limits: a 429 or a quota error falls back at once and backs off until the reset (Retry-After, rate-limit headers, a daily quota to 00:00 UTC)", async () => {
  const w = world();
  await on(w.db);
  w.script.push(status(429, { error: { message: "Too Many Requests" } }, { "retry-after": "120" }));
  let r = await w.run();
  assert.deepEqual(r.status === "ok" && r.provider, "workers_ai");
  assert.equal(Date.parse(w.health().rate_limited_until), T0 + 120_000);
  assert.equal(w.health().consecutive_failures, 0, "a rate limit is not a breaker failure");
  w.clock.now = T0 + 60_000;
  r = await w.run();
  assert.equal(w.fetches.length, 1, "backing off: no request to Beam");
  w.clock.now = T0 + 121_000;
  r = await w.run();
  assert.deepEqual(r.status === "ok" && r.provider, "reflection");
  // A quota error that is not a 429, for the day: back off until 00:00 UTC.
  w.script.push(status(403, { error: { code: "quota_exceeded", message: "Requests per day quota exceeded" } }));
  await w.run();
  assert.equal(w.health().rate_limited_until, "2026-11-26T00:00:00.000Z");
  assert.deepEqual(wai(w)!.fallbacks, { rate: 3 });
  const h = (o: Record<string, string>) => new Headers(o);
  assert.equal(rateBackoffMs(h({ "x-ratelimit-reset-requests": "6m0s" }), T0), 360_000);
  assert.equal(rateBackoffMs(h({ "x-ratelimit-reset": "1.5s" }), T0), 1_500);
  assert.equal(rateBackoffMs(h({ "retry-after": new Date(T0 + 30_000).toUTCString() }), T0), 30_000);
  assert.equal(rateBackoffMs(h({}), T0), 60_000);
});

test("AIR1-4. Cerebrum's share: 15 calls in one minute send exactly 10 to Beam, never more; the daily request and token counters stop Beam before the limit until 00:00 UTC", async () => {
  const w = world();
  await on(w.db);
  const out = await Promise.all(Array.from({ length: 15 }, () => w.run()));
  assert.equal(w.fetches.length, DEFAULT_LIMITS.rpm);
  assert.equal(out.filter((r) => r.status === "ok" && r.provider === "reflection").length, 10);
  assert.equal(out.filter((r) => r.status === "ok" && r.provider === "workers_ai").length, 5);
  assert.deepEqual(wai(w)!.fallbacks, { budget: 5 });
  assert.equal((w.db.raw.prepare("SELECT requests FROM model_router_counters WHERE bucket = 'min:2026-11-25T10:00'").get() as any).requests, 10);
  const day = w.db.raw.prepare("SELECT * FROM model_router_counters WHERE bucket = 'day:2026-11-25'").get() as any;
  assert.deepEqual([day.requests, day.in_tokens, day.out_tokens], [10, 1200, 300], "the reserved bounds are replaced by the reported tokens");

  // The daily request share: 3 a day, then Workers AI until 00:00 UTC.
  const d = world({ env: { ...ON, MODEL_ROUTER_REQUESTS_DAY: "3" } });
  await on(d.db);
  for (let i = 0; i < 5; i++) { d.clock.now = T0 + i * 61_000; await d.run(); }
  assert.equal(d.fetches.length, 3);
  assert.deepEqual(wai(d)!.fallbacks, { budget: 2 });
  d.clock.now = Date.parse("2026-11-25T23:59:59.000Z");
  await d.run();
  assert.equal(d.fetches.length, 3, "still the same UTC day");
  d.clock.now = Date.parse("2026-11-26T00:00:01.000Z");
  const next = await d.run();
  assert.deepEqual([d.fetches.length, next.status === "ok" && next.provider], [4, "reflection"], "a new UTC day");

  // Tokens: a call whose output bound would pass the day's output share never reaches Beam; neither does a too-long input.
  const t = world({ env: { ...ON, MODEL_ROUTER_OUTPUT_TOKENS_DAY: "500", MODEL_ROUTER_INPUT_TOKENS_DAY: "100000" } });
  await on(t.db);
  await t.run();
  assert.equal(t.fetches.length, 0, "600 output tokens would pass a 500 share");
  const u = world({ env: { ...ON, MODEL_ROUTER_INPUT_TOKENS_DAY: "200" } });
  await on(u.db);
  await u.run("chat_answer", "x".repeat(400));
  assert.equal(u.fetches.length, 0);
  assert.deepEqual(wai(u)!.fallbacks, { budget: 1 });
  assert.deepEqual((u.db.raw.prepare("SELECT COUNT(*) AS n FROM model_router_counters WHERE bucket GLOB 'min:*' AND requests > 0").get() as any).n, 0, "a refused day reservation gives the minute back");
});

test("AIR1-5. the breaker: 3 consecutive failures skip Beam for 15 minutes, then one half-open probe; a good probe closes it, a bad one reopens it", async () => {
  const w = world();
  await on(w.db);
  for (let i = 0; i < 3; i++) { w.script.push(status(502)); await w.run(); }
  assert.equal(Date.parse(w.health().breaker_open_until), T0 + BREAKER_OPEN_MS);
  await w.run();
  assert.equal(w.fetches.length, 3, "open: Beam is skipped");
  w.clock.now = T0 + BREAKER_OPEN_MS + 1_000;
  let release!: () => void;
  w.script.push(() => new Promise<Response>((r) => { release = () => r(ok()); }));
  const probe = w.run();
  await new Promise((r) => setTimeout(r, 20));
  const other = await w.run();
  assert.deepEqual(other.status === "ok" && other.provider, "workers_ai", "only one probe at a time");
  assert.equal(w.fetches.length, 4);
  release();
  const p = await probe;
  assert.deepEqual(p.status === "ok" && p.provider, "reflection");
  assert.deepEqual([w.health().consecutive_failures, w.health().breaker_open_until], [0, null], "closed");
  const after = await w.run();
  assert.deepEqual(after.status === "ok" && after.provider, "reflection");
  assert.deepEqual(wai(w)!.fallbacks, { unreachable: 3, breaker: 2 });
  // A failed probe reopens it for another 15 minutes.
  for (let i = 0; i < 3; i++) { w.script.push(status(500)); await w.run(); }
  w.clock.now += BREAKER_OPEN_MS + 1;
  w.script.push(status(500));
  await w.run();
  assert.equal(Date.parse(w.health().breaker_open_until), w.clock.now + BREAKER_OPEN_MS);
});

test("AIR1-6. off: the default state, the owner's off, MODEL_ROUTER off, no key or a bad base URL never reach Beam; the Workers AI call is metered off or disabled", async () => {
  const w = world();
  assert.equal((await readRouterState(w.db))!.state, "off", "migration 0090 seeds off");
  await w.run();
  await on(w.db);
  await setRouterState(w.db, APPROVER_EMAIL, { state: "off" });
  forgetRouterState(w.db);
  await w.run();
  assert.equal(w.fetches.length, 0);
  assert.deepEqual(wai(w)!.fallbacks, { off: 2 });
  for (const env of [{ ...ON, MODEL_ROUTER: "off" }, { MODEL_ROUTER: "on" }, { ...ON, REFLECTION_API_KEY: "  " }, { ...ON, MODEL_BASE_URL: "http://api.reflection.ai/openai/v1" }, {}]) {
    const d = world({ env });
    await on(d.db);
    const r = await d.run();
    assert.deepEqual([r.status === "ok" && r.provider, d.fetches.length, wai(d)!.fallbacks], ["workers_ai", 0, { disabled: 1 }], JSON.stringify(env).replace(KEY, "KEY"));
  }
});

test("AIR1-7. only the allow-list: another task is neither routed nor metered; the evolver and embeddings are never routed", async () => {
  const w = world();
  await on(w.db);
  assert.deepEqual([...ROUTER_TASKS], ["chat_plan", "chat_answer", "directive_draft", "council_position", "council_rebuttal", "council_synthesis"]);
  assert.deepEqual([...NEVER_ROUTED_TASKS], ["evolve_plan", "evolve_write", "embed"]);
  for (const name of ["draft_recovery_proposal", "evolve_plan", "evolve_write"]) {
    const r = await w.run(name);
    assert.deepEqual(r.status === "ok" && [r.provider, r.model], [undefined, CHAT_MODEL], name);
    assert.equal(w.router.routes(name), false, name);
  }
  await w.engine.embed("a memory");
  assert.equal(w.fetches.length, 0);
  assert.deepEqual(w.ledger(), [], "nothing metered for a task outside the allow-list");
  // The evolver's engine has no router at all, and the guard paths of the evolution loop and the learning mandate are untouched.
  const evolver = read("workers/ai-kernel/src/evolver.ts");
  assert.doesNotMatch(evolver, /model-router|router:/);
  for (const p of ["workers/ai-kernel/src/evolver.ts", "workers/control-plane-shared/src/evolution-limits.ts", "workers/control-plane-shared/src/power-mode.ts"]) assert.ok(criticalPathReason(p), p);
  for (const p of ["workers/ai-kernel/src/conversation.ts", "workers/ai-kernel/src/council.ts", "workers/ai-kernel/src/directives.ts"]) assert.match(read(p), /router: modelRouterFor\(env, db\)/, p);
});

test("AIR1-8. Beam answers go through the same checks: advisory language is refused as from Workers AI, with no retry", async () => {
  const w = world();
  await on(w.db);
  w.script.push(ok('{"answer":"You should buy now before the breakout."}'));
  const r = await w.run();
  assert.deepEqual([r.status, r.status === "invalid_output" && r.reason], ["invalid_output", "schema:advisory_language"]);
  assert.equal(w.ai.calls.length, 0);
  assert.deepEqual([beam(w)!.calls, wai(w)], [1, undefined]);
  const f = w.db.raw.prepare("SELECT category, count FROM ai_failures WHERE task = 'chat_answer'").all() as any[];
  assert.deepEqual(f.map((x) => ({ ...x })), [{ category: "schema:advisory_language", count: 1 }]);
});

test("AIR1-9. free_only: a 402, a billing error, a non-zero cost or a plan change turns Beam off_paid globally with one audit event; later calls skip Beam", async () => {
  const signals: [string, Reply, string][] = [
    ["402", status(402, { error: { message: "Payment Required" } }), "http_402"],
    ["billing", status(400, { error: { code: "insufficient_quota", message: "You exceeded your current quota, please check your plan and billing details" } }), "billing_error"],
    ["cost", ok('{"answer":"from beam"}', {}, { prompt_tokens: 10, completion_tokens: 5, cost: 0.0021 }), "cost_field"],
    ["plan", ok('{"answer":"from beam"}', { "reflection-plan": "pro" }), "plan_change"],
  ];
  for (const [name, reply, signal] of signals) {
    const w = world();
    await on(w.db);
    w.script.push(reply);
    const r = await w.run();
    assert.deepEqual(r.status === "ok" && [r.provider, r.data.answer], ["workers_ai", "from workers ai"], `${name}: the paid answer is not used`);
    assert.equal((await readRouterState(w.db))!.state, "off_paid", name);
    await w.run();
    await w.run();
    assert.equal(w.fetches.length, 1, `${name}: later calls skip Beam`);
    assert.deepEqual(wai(w)!.fallbacks, { paid: 3 }, name);
    assert.equal(w.events("model_router.paid_detected").length, 1, name);
    assert.equal(JSON.parse(w.events("model_router.paid_detected")[0].payload_json).signal, signal, name);
    assert.deepEqual(await reportPaid(w.db, "agent:x", "reported"), { state: "off_paid", changed: false }, `${name}: idempotent`);
    assert.equal(w.events("model_router.paid_detected").length, 1, name);
  }
});

test("AIR1-10. a paid sign reaches the owner once, through the owner channel (production_unhandled), and only the owner's capped turn-on ends it", async () => {
  const w = world();
  await on(w.db);
  const sent: { title: string; change: string }[] = [];
  const env = { DB: w.db, APPROVER_IDENTITIES: APPROVER_EMAIL, OWNER_NOTICE_CHANNELS: "telegram", OWNER_TELEGRAM: { notify: async (m: { title: string; change: string }) => { sent.push(m); return { sent: true }; } } };
  await reconcileNotices(env as never);
  const before = sent.filter((m) => /production problem/i.test(m.title)).length;
  assert.equal((await unhandledProblems(w.db as never)).filter((p) => p.code === "model_router_stopped").length, 0);
  w.script.push(status(402));
  await w.run();
  const problems = (await unhandledProblems(w.db as never)).filter((p) => p.code === "model_router_stopped");
  assert.deepEqual(problems.map((p) => [p.subject, p.link]), [["model_router:off_paid", "#/organism/telemetry"]]);
  assert.match(problems[0].detail, /paid sign \(paid sign: http_402\)[^]*Workers AI/);
  await reconcileNotices(env as never);
  await reconcileNotices(env as never);
  const after = sent.filter((m) => /production problem/i.test(m.title)).length;
  assert.equal(after - before, 1, "exactly one owner notice for the paid sign");
  const notices = w.db.raw.prepare("SELECT payload_json FROM audit_events WHERE event_type IN ('owner.notice_opened','owner.notice_changed') AND subject = 'production_unhandled' ORDER BY rowid DESC LIMIT 1").get() as any;
  assert.ok(JSON.parse(notices.payload_json).items.some((i: any) => i.code === "model_router_stopped"));
  assert.equal(PROBLEM_KINDS.model_router_stopped.urgency, "high");
  // free_only is refused after a paid sign; paid_capped needs an explicit cap.
  await assert.rejects(setRouterState(w.db, APPROVER_EMAIL, { state: "on" }), (e: unknown) => e instanceof ModelRouterError && e.status === 409 && e.code === "paid_sign_recorded");
  await assert.rejects(setRouterState(w.db, APPROVER_EMAIL, { state: "on", mode: "paid_capped" }), (e: unknown) => e instanceof ModelRouterError && e.code === "invalid_paid_cap");
  await assert.rejects(setRouterState(w.db, APPROVER_EMAIL, { state: "on", mode: "paid_capped", paid_cap_usd: 0 }), (e: unknown) => e instanceof ModelRouterError && e.code === "invalid_paid_cap");
  await on(w.db, { state: "on", mode: "paid_capped", paid_cap_usd: 0.01 });
  assert.deepEqual(await unhandledProblems(w.db as never).then((ps) => ps.filter((p) => p.code === "model_router_stopped")), [], "the item closes with the state");
  // paid_capped: a cost is spent against the cap; at the cap Beam is off_paid again.
  w.script.push(ok('{"answer":"paid beam"}', {}, { prompt_tokens: 10, completion_tokens: 5, cost: 0.004 }));
  const paid = await w.run();
  assert.deepEqual(paid.status === "ok" && [paid.provider, paid.data.answer], ["reflection", "paid beam"]);
  assert.equal((await readRouterState(w.db))!.spent_usd, 0.004);
  w.script.push(ok('{"answer":"paid beam"}', {}, { prompt_tokens: 10, completion_tokens: 5, cost: 0.007 }));
  const capped = await w.run();
  assert.deepEqual(capped.status === "ok" && capped.provider, "workers_ai");
  const s = (await readRouterState(w.db))!;
  assert.deepEqual([s.state, s.reason], ["off_paid", "paid sign: paid_cap_reached"]);
});

test("AIR1-11. retention: a contributor header turns Beam off_retention, the answer is not used, later calls skip Beam", async () => {
  const w = world();
  await on(w.db);
  w.script.push(ok('{"answer":"from beam"}', { "reflection-data-retention": "contributor" }));
  const r = await w.run();
  assert.deepEqual(r.status === "ok" && r.provider, "workers_ai");
  await w.run();
  assert.equal(w.fetches.length, 1);
  assert.deepEqual([(await readRouterState(w.db))!.state, wai(w)!.fallbacks, w.events("model_router.retention_detected").length], ["off_retention", { retention: 2 }, 1]);
  assert.deepEqual((await unhandledProblems(w.db as never)).filter((p) => p.code === "model_router_stopped").map((p) => p.subject), ["model_router:off_retention"]);
});

test("AIR1-12. no prompt and no key in any stored row or audit event; the status read carries no key", async () => {
  const w = world();
  await on(w.db);
  w.script.push(ok(), status(503), status(429, {}, { "retry-after": "1" }));
  for (let i = 0; i < 3; i++) await w.run();
  w.clock.now += 5_000;
  w.script.push(status(402));
  await w.run();
  const tables = (w.db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[]).map((t) => t.name);
  for (const t of tables) {
    const dump = JSON.stringify(w.db.raw.prepare(`SELECT * FROM "${t}"`).all());
    assert.ok(!dump.includes(KEY), `${t} holds the key`);
    assert.ok(!dump.includes("PROMPT-MARKER"), `${t} holds the prompt`);
    assert.ok(!dump.includes("from beam"), `${t} holds an answer`);
  }
  const s = JSON.stringify(await modelRouterStatus(w.db, ON, w.clock.now));
  assert.ok(!s.includes(KEY));
  assert.match(s, /"key_present":true/);
});

test("AIR1-13. the kernel: operators read GET /v1/model-router; only the owner turns it on or off (403 for anyone else); the body is checked", async () => {
  const db = migratedDb();
  const env = baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL, ...ON });
  const get = await call(kernel, env, req("GET", "/v1/model-router", undefined, OPERATOR_JWT));
  assert.equal(get.status, 200);
  assert.deepEqual([get.body.schema, get.body.state.state, get.body.effective, get.body.model], ["model_router.status.v1", "off", "off", BEAM_MODEL]);
  assert.ok(!JSON.stringify(get.body).includes(KEY));
  const post = (body: unknown, jwt = APPROVER_JWT) => call(kernel, env, req("POST", "/v1/model-router/state", body, jwt));
  const denied = await post({ state: "on" }, OPERATOR_JWT);
  assert.deepEqual([denied.status, denied.body.error], [403, "owner_required"]);
  assert.equal((await post({ state: "off" }, OPERATOR_JWT)).status, 403);
  assert.equal((await post({ state: "on", key: "x" })).status, 400);
  assert.equal((await post({ state: "maybe" })).status, 400);
  assert.equal((await post({ state: "on", mode: "free_only", paid_cap_usd: 5 })).status, 400);
  const onRes = await post({ state: "on" });
  assert.deepEqual([onRes.status, onRes.body.changed, onRes.body.status.state.state, onRes.body.status.state.mode], [200, true, "on", "free_only"]);
  const offRes = await post({ state: "off", reason: "pause" });
  assert.deepEqual([offRes.status, offRes.body.status.state.state], [200, "off_owner"]);
  const changes = db.raw.prepare("SELECT actor, payload_json FROM audit_events WHERE event_type = 'model_router.state_changed' ORDER BY rowid").all() as any[];
  assert.deepEqual(changes.map((c) => [c.actor, JSON.parse(c.payload_json).to]), [[APPROVER_EMAIL, "on"], [APPROVER_EMAIL, "off_owner"]]);
  assert.equal((await call(kernel, env, req("GET", "/v1/model-router/state", undefined, APPROVER_JWT))).status, 405);
});

test("AIR1-14. capabilities: model_router.status (tier 0) and model_router.report_paid (tier 1, rate limited); a granted agent reads and reports, an ungranted one is denied; no ceiling or migration grants them yet", async () => {
  assert.deepEqual([CAPABILITIES["model_router.status"].tier, CAPABILITIES["model_router.report_paid"].tier, hourlyLimit("model_router.report_paid"), hourlyLimit("model_router.status")], [0, 1, 4, null]);
  for (const o of EXTERNAL_ORIGINS) for (const id of ["x", ...Object.keys(o.ceiling?.agents ?? {})]) {
    const c = externalCeilingFor(o, id).capabilities;
    assert.ok(!c.includes("model_router.status") && !c.includes("model_router.report_paid"), `${o.origin}:${id}`);
  }
  assert.ok(!EXTERNAL_CEILING.capabilities.some((c) => c.startsWith("model_router.")));
  for (const f of ["0001_initial.sql", "0090_model_router.sql"]) assert.doesNotMatch(read(`workers/control-plane-migrations/${f}`), /model_router\.(status|report_paid)/);
  const db = migratedDb();
  const at = new Date().toISOString();
  db.raw.prepare(`INSERT INTO agents (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at)
    VALUES ('router-probe', 'Router probe', 'cryptophys-ai-kernel', 'test', 1, '["model_router.status","model_router.report_paid"]', 'enabled', NULL, 'test', ?, ?)`).run(at, at);
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const env = { ...baseEnv("cryptophys-ai-kernel", db, { ...ON }), POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async () => { throw new Error("unused"); } } };
  const st = await syscall(env as never, "router-probe", "model_router.status", {});
  assert.equal(st.outcome, "succeeded", JSON.stringify(st));
  assert.equal((st.result as any).state.state, "off");
  assert.ok(!JSON.stringify(st).includes(KEY));
  assert.equal((await syscall(env as never, "supervisor", "model_router.status", {})).outcome, "denied", "not granted");
  assert.equal((await syscall(env as never, "router-probe", "model_router.report_paid", { signal: "nope" })).outcome, "failed");
  const rep = await syscall(env as never, "router-probe", "model_router.report_paid", { signal: "http_402" });
  assert.equal(rep.outcome, "succeeded", JSON.stringify(rep));
  assert.deepEqual((rep as { result?: unknown }).result, { state: "off_paid", changed: true });
  const again = await syscall(env as never, "router-probe", "model_router.report_paid", { signal: "http_402" });
  assert.deepEqual((again as { result?: unknown }).result, { state: "off_paid", changed: false });
  const ev = db.raw.prepare("SELECT actor FROM audit_events WHERE event_type = 'model_router.paid_detected'").all() as any[];
  assert.deepEqual(ev.map((e) => e.actor), ["agent:router-probe"]);
});

test("AIR1-15. configuration and records: off by default in wrangler, no required secret; the migration; the ADR amendment, the requirement's exception and the SSOT", () => {
  const toml = read("workers/ai-kernel/wrangler.toml");
  assert.match(toml, /\nMODEL_ROUTER = "off"\n/);
  assert.match(toml, /\nMODEL_BASE_URL = "https:\/\/api\.reflection\.ai\/openai\/v1"\n/);
  assert.match(toml, /\nMODEL_ROUTER_RPM = "10"\nMODEL_ROUTER_REQUESTS_DAY = "500"\nMODEL_ROUTER_INPUT_TOKENS_DAY = "1000000"\nMODEL_ROUTER_OUTPUT_TOKENS_DAY = "150000"\n/);
  assert.doesNotMatch(toml, /\[secrets\]|^REFLECTION_API_KEY\s*=/m, "the key is never in the config and is not a required secret");
  assert.deepEqual(FALLBACK_REASONS, ["unreachable", "rate", "budget", "paid", "retention", "breaker", "off", "disabled"]);
  const sql = read("workers/control-plane-migrations/0090_model_router.sql");
  assert.match(sql, /PRIMARY KEY \(day, system, purpose, provider, model\)/);
  assert.match(read("workers/control-plane-migrations/test_migrations.py"), /PASS: 0090 model_router/);
  const adr = read("architecture/adr/0007-ai-worker-os.md");
  assert.match(adr, /## Amendment 2026-11-25: Beam for Cerebrum \(the model router, AIR1\)/);
  assert.ok(adr.includes('"Approve, but Cerebrum only"'));
  assert.ok(adr.includes("tetap siapkan callback jika beam tidak bisa dijangkau atau menjadi berbayar atau lebih dari batasan"));
  assert.match(adr, /model_router\.status[^\n]*AgentRpc/);
  const req = read("architecture/AI-ENGINE-REQUIREMENT.md");
  assert.match(req, /No automatic paid upgrade, paid model fallback, or external AI provider fallback is permitted, with one scoped exception/);
  const ssot = read("docs/SSOT.md");
  assert.match(ssot.split("\n")[4], /^Last reviewed: 2026-11-16 \((?:[^\n]*; )?model router, 2026-11-25 \(owner: "Approve, but Cerebrum only"; Beam free_only for Cerebrum chat, directives and councils, Workers AI always the fallback; off by default\); /);
  assert.match(ssot, /\*\*Model router \(AIR1/);
  const manifest = JSON.parse(read("architecture/adr/progress/0007.json"));
  assert.ok(manifest.phases.some((p: any) => p.id === "K3" && JSON.stringify(p.evidence).includes("0090_model_router.sql")));
  // Coordinator review of 4ffe685: the router holds the free_only safeguard, so it is a guard path (AIR1-G).
  assert.equal(criticalPathReason("workers/control-plane-shared/src/model-router.ts"), "paid_model_guard");
});

test("AIR1-G: the model router is a guard path (its free_only safeguard is the owner's)", () => {
  assert.equal(criticalPathReason("workers/control-plane-shared/src/model-router.ts"), "paid_model_guard");
  assert.equal(criticalPathReason("workers/control-plane-shared/src/ai-engine.ts"), null);
});
