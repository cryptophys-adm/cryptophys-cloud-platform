// AIR1, the model router (ADR-0007 amendment 2026-11-25; owner: "Approve, but Cerebrum only"; earlier: "tetap siapkan
// callback jika beam tidak bisa dijangkau atau menjadi berbayar atau lebih dari batasan"). Beam answers Cerebrum's chat,
// directive drafts and councils first, free_only; every other case returns the Workers AI answer with its reason metered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, fakeAi, migratedDb, req, lastReviewedRecord } from "./harness.ts";
import { AiEngine, BEAM_MODEL_ID, type AiTask } from "../src/ai-engine.ts";
import { CHAT_MODEL, CHAT_MODELS, CHAT_SERVICE } from "../src/conversation.ts";
import {
  BEAM_MAX_OUTPUT_TOKENS, BEAM_MODEL, BREAKER_OPEN_MS, beamOutputTokens, DEFAULT_LIMITS, DEFAULT_MODEL_BASE_URL, FALLBACK_REASONS, ModelRouter, ModelRouterError, NEVER_ROUTED_TASKS, ROUTER_TASKS, forgetRouterState,
  modelRouterStatus, rateBackoffMs, readRouterState, reportPaid, setRouterState, type ModelRouterEnv,
} from "../src/model-router.ts";
import { CAPABILITIES, hourlyLimit } from "../src/capabilities.ts";
import {
  AETHER_CEILING, CTA_CEILING, CTA_MODEL_ROUTER_AGENT, EXTERNAL_CEILING, EXTERNAL_ORIGINS, XAUUSD_CEILING, XAUUSD_MODEL_ROUTER_AGENT, externalCeilingFor, externalCeilingViolations, externalOrgans, type Genome,
} from "../src/organism.ts";
import { castVote, privilegedCapabilities, type Evidence, type Proposal } from "../src/consensus-rules.ts";
import { rpcSyscall } from "../../ai-kernel/src/agent-rpc.ts";
import { compare } from "../../forge/src/census.ts";
import { proposalFor, type CensusRow } from "../../ai-kernel/src/organism.ts";
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
  // Beam's output margin (coordinator review): twice the task's 600, as Beam's reasoning counts as output.
  assert.deepEqual([f.body.model, f.body.max_completion_tokens, f.body.reasoning_effort, f.body.messages.map((m: any) => m.role)], [BEAM_MODEL, 1200, "low", ["system", "user"]]);
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
    ["schema mismatch", ok('{"wrong":1}')], ["not JSON", new Response("<html>bad gateway</html>", { status: 200 })],
  ];
  // An answer cut at its output limit is output_budget, not unreachable, and does not count for the breaker (AIR1-20).
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

test("AIR1-14. capabilities: model_router.status (tier 0) and model_router.report_paid (tier 1, rate limited); a granted agent reads and reports, an ungranted one is denied; only the router clients' ceiling entries (xauusd's, and CTA's since 2026-11-27) and no migration grant them", async () => {
  assert.deepEqual([CAPABILITIES["model_router.status"].tier, CAPABILITIES["model_router.report_paid"].tier, hourlyLimit("model_router.report_paid"), hourlyLimit("model_router.status")], [0, 1, 4, null]);
  // Since 2026-11-25 (owner: "news_compare saja") one ceiling entry held them: xauusd's router client (AIR1-16). Since
  // 2026-11-27 (owner: "Ya, buat draft-nya") CTA's router client is the second and last (cta-model-router-2026-11-27).
  const holders: string[] = [];
  for (const o of EXTERNAL_ORIGINS) for (const id of new Set(["x", "cta-model-router", ...Object.keys(o.ceiling?.agents ?? {})])) {
    const c = externalCeilingFor(o, id).capabilities;
    if (c.includes("model_router.status") || c.includes("model_router.report_paid")) holders.push(`${o.origin}:${id}`);
  }
  assert.deepEqual(holders, [`xauusd:${XAUUSD_MODEL_ROUTER_AGENT}`, `cta:${CTA_MODEL_ROUTER_AGENT}`]);
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

test("AIR1-15. configuration and records: MODEL_ROUTER on in wrangler (owner, 2026-11-26), no required secret, D1 seeds off; the migration; the ADR amendment, the requirement's exception and the SSOT", () => {
  const toml = read("workers/ai-kernel/wrangler.toml");
  // Owner 2026-11-26 ("pandu aktifkan beam", "buatkan togglenya di cerebrum > command"): the var is on, so the owner's
  // switch on Command is the toggle; Beam stays off until the owner sets the key (no required secret, below) and turns the
  // D1 state on (migration 0090 seeds it off, below).
  assert.match(toml, /\nMODEL_ROUTER = "on"\n/);
  assert.doesNotMatch(toml, /\nMODEL_ROUTER = "off"\n/);
  assert.match(toml, /\nMODEL_BASE_URL = "https:\/\/api\.reflection\.ai\/openai\/v1"\n/);
  assert.match(toml, /\nMODEL_ROUTER_RPM = "10"\nMODEL_ROUTER_REQUESTS_DAY = "500"\nMODEL_ROUTER_INPUT_TOKENS_DAY = "1000000"\nMODEL_ROUTER_OUTPUT_TOKENS_DAY = "150000"\n/);
  assert.doesNotMatch(toml, /\[secrets\]|^REFLECTION_API_KEY\s*=/m, "the key is never in the config and is not a required secret");
  assert.deepEqual(FALLBACK_REASONS, ["unreachable", "rate", "budget", "paid", "retention", "breaker", "off", "disabled", "output_budget"]);
  const sql = read("workers/control-plane-migrations/0090_model_router.sql");
  assert.match(sql, /PRIMARY KEY \(day, system, purpose, provider, model\)/);
  assert.match(sql, /INSERT OR IGNORE INTO model_router_state [^;]*VALUES \('global', 'off', 'free_only'/, "D1 seeds the owner's switch off");
  // The owner's Beam toggle on Cerebrum → Command: the same panel as Organism → Telemetry, compact; the switch is the owner's.
  const cmd = read("workers/console/ui/src/pages/Command.tsx"), panel = read("workers/console/ui/src/components/ModelRouterPanel.tsx");
  assert.match(cmd, /<ModelRouterPanel compact \/>/);
  assert.match(read("workers/console/ui/src/pages/Organism.tsx"), /tab === "telemetry" && <ModelRouterPanel \/>/);
  assert.match(panel, /const controls = who\.owner \? \(/);
  assert.doesNotMatch(panel, /REFLECTION_API_KEY/, "the Console never names or shows the key");
  assert.match(read("workers/control-plane-migrations/test_migrations.py"), /PASS: 0090 model_router/);
  const adr = read("architecture/adr/0007-ai-worker-os.md");
  assert.match(adr, /## Amendment 2026-11-25: Beam for Cerebrum \(the model router, AIR1\)/);
  assert.ok(adr.includes('"Approve, but Cerebrum only"'));
  assert.ok(adr.includes("tetap siapkan callback jika beam tidak bisa dijangkau atau menjadi berbayar atau lebih dari batasan"));
  assert.match(adr, /model_router\.status[^\n]*AgentRpc/);
  const req = read("architecture/AI-ENGINE-REQUIREMENT.md");
  assert.match(req, /No automatic paid upgrade, paid model fallback, or external AI provider fallback is permitted, with one scoped exception/);
  const ssot = read("docs/SSOT.md");
  assert.match(lastReviewedRecord(), /^Last reviewed: 2026-11-16 \((?:[^\n]*; )?model router, 2026-11-25 \(owner: "Approve, but Cerebrum only"; Beam free_only for Cerebrum chat, directives and councils, Workers AI always the fallback; off by default\); /);
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

// ------------------------------------------------------- xauusd's news_compare (owner: "semua shadow pakai beam", then "news_compare saja")

const XAU_AI = "xauusd-ai-trading-assistant";
const XAU_ORIGIN = EXTERNAL_ORIGINS.find((o) => o.origin === "xauusd")!;
const ROUTER_CAPS = ["model_router.status", "model_router.report_paid"];

test("AIR1-16. the xauusd router grant: XAUUSD_CEILING names xauusd-model-router with exactly the two model router capabilities; no other xauusd or Aether agent holds them; CTA's other agents keep the general ceiling", () => {
  assert.equal(XAUUSD_MODEL_ROUTER_AGENT, "xauusd-model-router");
  assert.deepEqual([...XAUUSD_CEILING.agents[XAUUSD_MODEL_ROUTER_AGENT]], ROUTER_CAPS);
  assert.deepEqual(externalCeilingFor(XAU_ORIGIN, XAUUSD_MODEL_ROUTER_AGENT), { tier_max: 1, capabilities: ROUTER_CAPS, proposals: [] });
  assert.deepEqual(privilegedCapabilities(ROUTER_CAPS), [], "a routine registration, no owner click for the agent");
  // Nobody else: no other xauusd agent, no xauusd default, no Aether agent, no CTA agent but CTA's router client
  // (2026-11-27, cta-model-router-2026-11-27), not EXTERNAL_CEILING.
  for (const cap of ROUTER_CAPS) {
    assert.deepEqual(Object.entries(XAUUSD_CEILING.agents).filter(([, caps]) => caps.includes(cap)).map(([id]) => id), [XAUUSD_MODEL_ROUTER_AGENT], cap);
    assert.ok(!XAUUSD_CEILING.capabilities.includes(cap), cap);
    assert.ok(!AETHER_CEILING.capabilities.includes(cap) && !Object.values(AETHER_CEILING.agents).some((caps) => caps.includes(cap)), cap);
    assert.ok(!EXTERNAL_CEILING.capabilities.includes(cap), cap);
  }
  for (const o of EXTERNAL_ORIGINS) for (const id of [undefined, "x", "hud-prophet", "xauusd-moderator", "nexus-teacher", "shadow-knowledge", "xauusd-reasoner", "aether-curator", "knowledge-council", "cta-editor", "cta-model-router", ...Object.keys(o.ceiling?.agents ?? {})]) {
    if (o.origin === "xauusd" && id === XAUUSD_MODEL_ROUTER_AGENT) continue;
    if (o.origin === "cta" && id === CTA_MODEL_ROUTER_AGENT) continue;
    const c = externalCeilingFor(o, id).capabilities;
    assert.ok(!ROUTER_CAPS.some((cap) => c.includes(cap)), `${o.origin}/${id}`);
  }
  // AC-CTA holds for every cta agent but its router client: they have the general ceiling. Until 2026-11-27 CTA had no
  // ceiling of its own and cta-model-router had the general ceiling too; the owner's "Ya, buat draft-nya" gave it the two.
  const CTA = EXTERNAL_ORIGINS.find((o) => o.origin === "cta")!;
  assert.equal(CTA.ceiling, CTA_CEILING);
  for (const id of ["cta-editor", "cta-reviewer", "x"]) {
    assert.deepEqual(externalCeilingFor(CTA, id), { tier_max: EXTERNAL_CEILING.tier_max, capabilities: EXTERNAL_CEILING.capabilities, proposals: [] }, id);
  }
  assert.deepEqual(externalCeilingViolations({ id: "cta-editor", tier_max: 1, capabilities: ["model_router.status"] }, CTA), ["capability model_router.status"]);
  assert.deepEqual(externalCeilingViolations({ id: CTA_MODEL_ROUTER_AGENT, tier_max: 1, capabilities: ["model_router.status"] }, CTA), []);
  // A census gene that puts them on another agent, or anything else on the router client, is refused.
  const xau = (id: string, capabilities: string[]) => externalCeilingViolations({ id, tier_max: 1, voter: false, capabilities }, XAU_ORIGIN);
  assert.deepEqual(xau(XAUUSD_MODEL_ROUTER_AGENT, ROUTER_CAPS), []);
  assert.deepEqual(xau(XAUUSD_MODEL_ROUTER_AGENT, ["model_router.status"]), []);
  assert.deepEqual(xau(XAUUSD_MODEL_ROUTER_AGENT, [...ROUTER_CAPS, "reports.publish"]), ["capability reports.publish"]);
  assert.deepEqual(xau(XAUUSD_MODEL_ROUTER_AGENT, [...ROUTER_CAPS, "knowledge.verdict"]), ["capability knowledge.verdict"]);
  assert.deepEqual(externalCeilingViolations({ id: XAUUSD_MODEL_ROUTER_AGENT, tier_max: 2, voter: true, capabilities: ROUTER_CAPS }, XAU_ORIGIN), ["tier_max 2", "council seat"]);
  for (const id of ["shadow-knowledge", "hud-prophet", "xauusd-moderator"]) assert.deepEqual(xau(id, ["model_router.report_paid"]), ["capability model_router.report_paid"], id);
  // The earlier grants are unchanged (PF3, H3e, the return path).
  assert.deepEqual([...XAUUSD_CEILING.agents["shadow-knowledge"]], ["knowledge.verdict"]);
  assert.deepEqual([...XAUUSD_CEILING.agents["nexus-teacher"]], ["corrections.record"]);
  assert.deepEqual([...XAUUSD_CEILING.agents["xauusd-moderator"]], [...EXTERNAL_CEILING.capabilities, "council.decisions.read"]);
  assert.deepEqual([...XAUUSD_CEILING.capabilities], [...EXTERNAL_CEILING.capabilities]);
  // One constant names the agent, as PF3's.
  const src = read("workers/control-plane-shared/src/organism.ts");
  assert.equal(src.match(/"xauusd-model-router"/g)?.length, 1, "the id is written once");
  assert.match(src, /\[XAUUSD_MODEL_ROUTER_AGENT\]: Object\.freeze\(\["model_router\.status", "model_router\.report_paid"\]\)/);
  assert.equal(criticalPathReason("workers/control-plane-shared/src/organism.ts"), "capability_ceiling");
});

test("AIR1-17. no migration seeds xauusd-model-router; the ceiling entry alone breaks nothing; once xauusd's DNA declares it the census proposes the routine register_agent", async () => {
  for (const f of readdirSync(new URL("workers/control-plane-migrations/", ROOT)).filter((n) => n.endsWith(".sql"))) {
    assert.doesNotMatch(read(`workers/control-plane-migrations/${f}`), /xauusd-model-router|model_router\.(status|report_paid)/, f);
  }
  const db = migratedDb();
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agents WHERE agent_id = ?").get(XAUUSD_MODEL_ROUTER_AGENT) as any).n, 0);
  const live = (db.raw.prepare("SELECT agent_id, capabilities_json FROM agents WHERE host_worker = ? ORDER BY agent_id").all(XAU_AI) as Array<{ agent_id: string; capabilities_json: string }>)
    .map((r) => ({ id: r.agent_id, display_name: r.agent_id, capabilities: JSON.parse(r.capabilities_json), tier_max: 1, voter: false }));
  const organ = (agents: unknown[]) => ({ $schema_version: 1, service: XAU_AI, display_name: XAU_AI, kind: "service", deploy_unit: null, access: false, rollback: false, drift: { via: "rpc", binding: "EXT_XAUUSD_AI" }, agents, engines: [] });
  const genomeOf = (agents: unknown[]) => {
    const { organs, refused } = externalOrgans(XAU_ORIGIN, { schema: XAU_ORIGIN.schema, organs: [organ(agents)] });
    return { g: new Map(organs.map((o) => [o.service, o])) as Genome, refused };
  };
  const before = genomeOf(live);
  assert.deepEqual(before.refused, []);
  const quiet = await compare(db as never, before.g);
  assert.ok(!quiet.some((f) => f.subject === XAUUSD_MODEL_ROUTER_AGENT), JSON.stringify(quiet));
  const declared = genomeOf([...live, { id: XAUUSD_MODEL_ROUTER_AGENT, display_name: "Model router client", capabilities: ROUTER_CAPS, tier_max: 1, voter: false }]);
  assert.deepEqual(declared.refused, []);
  const findings = await compare(db as never, declared.g);
  assert.deepEqual(findings.filter((f) => f.subject === XAUUSD_MODEL_ROUTER_AGENT).map((f) => f.kind), ["unregistered_agent"]);
  const census: CensusRow = { main_sha: "a".repeat(40), status: "changes", findings, genome: [...declared.g.values()].map((d) => ({ service: d.service, kind: d.kind, agents: d.agents, engines: [], origin: "xauusd" })) };
  const p = proposalFor(census, { kind: "unregistered_agent", subject: XAUUSD_MODEL_ROUTER_AGENT })!;
  assert.deepEqual([p.action, p.target, p.params.capabilities, p.params.tier_max, p.params.service], ["register_agent", XAUUSD_MODEL_ROUTER_AGENT, ROUTER_CAPS, 1, XAU_AI]);
  const e = { agents_enabled: true, audit_valid: true, critical_reports_24h: 0, services: [], recovery_plans: [], deploys: [], proposals_last_hour: 0, agents: {}, registry: { [XAU_AI]: { status: "healthy" } } } as unknown as Evidence;
  const proposal = (caps: string[]) => ({ proposal_id: "cns_t", action: "register_agent", target: XAUUSD_MODEL_ROUTER_AGENT, class: "routine", params: { service: XAU_AI, capabilities: caps, tier_max: 1, main_sha: "a".repeat(40) } }) as unknown as Proposal;
  assert.equal(castVote("platform-api", proposal(ROUTER_CAPS), e).vote, "approve");
  assert.match(castVote("platform-api", proposal([...ROUTER_CAPS, "memory.remember"]), e).reason, /above the external-organ ceiling: capability memory\.remember/);
  const over = genomeOf([...live, { id: XAUUSD_MODEL_ROUTER_AGENT, display_name: "Model router client", capabilities: [...ROUTER_CAPS, "signals.observe"], tier_max: 1, voter: false }]);
  assert.deepEqual(over.refused.map((r) => [r.kind, r.subject]), [["external_agent_refused", XAUUSD_MODEL_ROUTER_AGENT]]);
});

test("AIR1-18. over AgentRpc, xauusd-model-router (hosted by xauusd-ai-trading-assistant) reads the state and reports a paid sign; hosted elsewhere or another agent is denied; it holds nothing else", async () => {
  const db = migratedDb();
  forgetRouterState(db);
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const env = { ...baseEnv("cryptophys-ai-kernel", db, { ...ON }), POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async () => { throw new Error("unused"); } } };
  const XAU = { host_worker: XAU_AI };
  assert.equal((await rpcSyscall(env as never, XAU, XAUUSD_MODEL_ROUTER_AGENT, "model_router.status", {}) as any).outcome, "denied", "unregistered");
  const at = new Date().toISOString();
  db.raw.prepare(`INSERT INTO agents (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at)
    VALUES (?, 'Model router client', ?, 'test', 1, ?, 'enabled', NULL, 'consensus:test', ?, ?)`).run(XAUUSD_MODEL_ROUTER_AGENT, XAU_AI, JSON.stringify(ROUTER_CAPS), at, at);
  // Since 2026-11-26 (owner: per-system Beam switches, migration 0091) xauusd reads its own switch, not Cerebrum's.
  await setRouterState(db, APPROVER_EMAIL, { system: "xauusd", state: "on" });
  const st = await rpcSyscall(env as never, XAU, XAUUSD_MODEL_ROUTER_AGENT, "model_router.status", {}) as any;
  assert.equal(st.outcome, "succeeded", JSON.stringify(st));
  assert.deepEqual([st.result.schema, st.result.state.state, st.result.state.mode], ["model_router.status.v1", "on", "free_only"]);
  assert.ok(!JSON.stringify(st).includes(KEY));
  assert.equal((await rpcSyscall(env as never, { host_worker: "cryptophys-aether" }, XAUUSD_MODEL_ROUTER_AGENT, "model_router.status", {}) as any).reason, "agent_not_hosted_by_caller");
  for (const id of ["shadow-knowledge", "nexus-teacher", "xauusd-moderator", "hud-prophet"]) {
    const r = await rpcSyscall(env as never, XAU, id, "model_router.report_paid", { signal: "http_402" }) as any;
    assert.equal(r.outcome, "denied", id);
  }
  for (const cap of ["reports.publish", "memory.remember", "knowledge.verdict", "signals.observe"]) {
    assert.equal((await rpcSyscall(env as never, XAU, XAUUSD_MODEL_ROUTER_AGENT, cap, {}) as any).outcome, "denied", cap);
  }
  const rep = await rpcSyscall(env as never, XAU, XAUUSD_MODEL_ROUTER_AGENT, "model_router.report_paid", { signal: "http_402" }) as any;
  assert.equal(rep.outcome, "succeeded", JSON.stringify(rep));
  assert.deepEqual(rep.result, { state: "off_paid", changed: true });
  const ev = db.raw.prepare("SELECT actor, payload_json FROM audit_events WHERE event_type = 'model_router.paid_detected'").all() as any[];
  assert.deepEqual(ev.map((x) => [x.actor, JSON.parse(x.payload_json).signal]), [[`agent:${XAUUSD_MODEL_ROUTER_AGENT}`, "http_402"]]);
  // The org-wide state: Cerebrum's own router is off_paid too, and the owner hears of it once.
  assert.deepEqual((await unhandledProblems(db as never)).filter((p) => p.code === "model_router_stopped").map((p) => p.subject), ["model_router:off_paid"]);
});

test("AIR1-19. a 429 is always a rate answer, whatever its text: a free daily quota that says 'upgrade your plan', 'credits' or 'subscription' backs off, stays on and opens no owner notice; billing text counts only on another 4xx", async () => {
  const bodies = [
    { error: { code: "rate_limit_exceeded", message: "Daily limit exceeded for the free tier; upgrade your plan for higher limits" } },
    { error: { message: "You have used today's free credits; the daily limit resets at 00:00 UTC" } },
    { error: { type: "requests", message: "Too many requests today on your subscription" } },
  ];
  for (const body of bodies) {
    const w = world();
    await on(w.db);
    w.script.push(status(429, body));
    const r = await w.run();
    assert.deepEqual(r.status === "ok" && r.provider, "workers_ai", body.error.message);
    const s = (await readRouterState(w.db))!;
    assert.deepEqual([s.state, s.mode], ["on", "free_only"], body.error.message);
    assert.deepEqual(wai(w)!.fallbacks, { rate: 1 }, body.error.message);
    assert.equal(w.events("model_router.paid_detected").length, 0, body.error.message);
    assert.deepEqual((await unhandledProblems(w.db as never)).filter((p) => p.code === "model_router_stopped"), [], body.error.message);
    assert.equal(w.health().consecutive_failures, 0);
  }
  // The daily one backs off until 00:00 UTC; a Retry-After wins.
  const d = world();
  await on(d.db);
  d.script.push(status(429, bodies[0]));
  await d.run();
  assert.equal(d.health().rate_limited_until, "2026-11-26T00:00:00.000Z");
  d.clock.now = Date.parse("2026-11-25T23:59:00.000Z");
  await d.run();
  assert.equal(d.fetches.length, 1, "Workers AI until 00:00 UTC");
  d.clock.now = Date.parse("2026-11-26T00:00:01.000Z");
  const next = await d.run();
  assert.deepEqual(next.status === "ok" && next.provider, "reflection");
  const ra = world();
  await on(ra.db);
  ra.script.push(status(429, bodies[0], { "retry-after": "30" }));
  await ra.run();
  assert.equal(Date.parse(ra.health().rate_limited_until), T0 + 30_000);
  // A 5xx with billing words is unreachable, not paid; a 403 billing error is still a paid sign.
  const u = world();
  await on(u.db);
  u.script.push(status(503, { error: { message: "billing service unavailable" } }));
  await u.run();
  assert.deepEqual([(await readRouterState(u.db))!.state, wai(u)!.fallbacks], ["on", { unreachable: 1 }]);
  const b = world();
  await on(b.db);
  b.script.push(status(403, { error: { message: "Your credits are exhausted; add a payment method" } }));
  await b.run();
  assert.equal((await readRouterState(b.db))!.state, "off_paid");
  assert.equal(JSON.parse(b.events("model_router.paid_detected")[0].payload_json).signal, "billing_error");
});

test("AIR1-20. Beam's output margin: max_completion_tokens is twice the task's (at most 8,000, never below the task's); an answer cut at its limit falls back as output_budget, never counts for the breaker and frees a half-open probe", async () => {
  assert.equal(BEAM_MAX_OUTPUT_TOKENS, 8_000);
  assert.deepEqual([beamOutputTokens(600), beamOutputTokens(1), beamOutputTokens(4_000), beamOutputTokens(5_000), beamOutputTokens(9_000), beamOutputTokens(0)], [1_200, 2, 8_000, 8_000, 9_000, 2]);
  const w = world();
  await on(w.db);
  const cut = () => new Response(beamBody('{"answer":"cut', { prompt_tokens: 100, completion_tokens: 1200 }, "length"), { status: 200, headers: { "reflection-data-retention": "none" } });
  for (let i = 0; i < 5; i++) {
    w.script.push(cut);
    const r = await w.run();
    assert.deepEqual(r.status === "ok" && [r.provider, r.data.answer], ["workers_ai", "from workers ai"], `cut ${i}`);
  }
  assert.equal(w.fetches.length, 5, "the breaker never opened");
  assert.ok(w.fetches.every((f) => f.body.max_completion_tokens === 1200));
  assert.ok(w.ai.calls.every((c: any) => c.input.max_tokens === 600), "the Workers AI path keeps the task's own limit");
  assert.deepEqual([w.health().consecutive_failures, w.health().breaker_open_until], [0, null]);
  assert.deepEqual(wai(w)!.fallbacks, { output_budget: 5 });
  // A half-open probe cut at its limit: the breaker stays as it was, the lease is freed, the next call probes again.
  for (let i = 0; i < 3; i++) { w.script.push(status(502)); await w.run(); }
  w.clock.now = T0 + BREAKER_OPEN_MS + 1_000;
  w.script.push(cut);
  await w.run();
  assert.deepEqual([w.health().consecutive_failures, w.health().probe_until], [3, null]);
  w.script.push(ok());
  const probe = await w.run();
  assert.deepEqual(probe.status === "ok" && probe.provider, "reflection");
  assert.deepEqual([w.health().consecutive_failures, w.health().breaker_open_until], [0, null]);
  assert.deepEqual(wai(w)!.fallbacks, { output_budget: 6, unreachable: 3 });
});

test("AIR1-21. paid_capped: the spend is added and compared in one statement (UPDATE ... RETURNING), so concurrent calls cannot overshoot the cap", async () => {
  const w = world();
  await setRouterState(w.db, APPROVER_EMAIL, { state: "on", mode: "paid_capped", paid_cap_usd: 0.01 });
  forgetRouterState(w.db);
  for (let i = 0; i < 5; i++) w.script.push(ok('{"answer":"paid beam"}', {}, { prompt_tokens: 10, completion_tokens: 5, cost: 0.004 }));
  const out = await Promise.all(Array.from({ length: 5 }, () => w.run()));
  assert.equal(w.fetches.length, 5);
  assert.equal(out.filter((r) => r.status === "ok" && r.provider === "reflection").length, 2, "0.004 + 0.004 < 0.01; the third reaches the cap");
  assert.equal(out.filter((r) => r.status === "ok" && r.provider === "workers_ai").length, 3);
  const s = (await readRouterState(w.db))!;
  assert.deepEqual([s.state, s.reason], ["off_paid", "paid sign: paid_cap_reached"]);
  assert.equal(w.events("model_router.paid_detected").length, 1, "the cap is reported once");
  assert.match(read("workers/control-plane-shared/src/model-router.ts"), /UPDATE model_router_state SET spent_usd = spent_usd \+ \? WHERE system = 'cerebrum' RETURNING spent_usd, paid_cap_usd/);
});

test("AIR1-22. after a paid sign the owner may turn free_only back on only with confirm_free: true (audited from off_paid); the next paid sign turns it off again", async () => {
  const w = world();
  await on(w.db);
  w.script.push(status(402));
  await w.run();
  assert.equal((await readRouterState(w.db))!.state, "off_paid");
  await assert.rejects(setRouterState(w.db, APPROVER_EMAIL, { state: "on" }), (e: unknown) => e instanceof ModelRouterError && e.status === 409 && e.code === "paid_sign_recorded");
  await assert.rejects(setRouterState(w.db, APPROVER_EMAIL, { state: "on", mode: "free_only", confirm_free: false }), (e: unknown) => e instanceof ModelRouterError && e.status === 400 && e.code === "invalid_confirm_free");
  await assert.rejects(setRouterState(w.db, APPROVER_EMAIL, { state: "on", confirm_free: "yes" }), (e: unknown) => e instanceof ModelRouterError && e.code === "invalid_confirm_free");
  await assert.rejects(setRouterState(w.db, APPROVER_EMAIL, { state: "off", confirm_free: true }), (e: unknown) => e instanceof ModelRouterError && e.status === 400);
  await assert.rejects(setRouterState(w.db, APPROVER_EMAIL, { state: "on", mode: "paid_capped", paid_cap_usd: 5, confirm_free: true }), (e: unknown) => e instanceof ModelRouterError && e.status === 400);
  assert.equal((await readRouterState(w.db))!.state, "off_paid", "nothing changed");
  const r = await on(w.db, { state: "on", mode: "free_only", confirm_free: true, reason: "the 402 was a provider outage, not a charge" });
  assert.deepEqual([r.changed, r.state!.state, r.state!.mode, r.state!.paid_cap_usd], [true, "on", "free_only", null]);
  const ch = w.events("model_router.state_changed").map((e) => JSON.parse(e.payload_json));
  assert.deepEqual(ch.at(-1), { system: "cerebrum", from: "off_paid", to: "on", mode: "free_only", paid_cap_usd: null, reason: "the 402 was a provider outage, not a charge", confirm_free: true });
  assert.deepEqual((await unhandledProblems(w.db as never)).filter((p) => p.code === "model_router_stopped"), [], "the owner item closes");
  const back = await w.run();
  assert.deepEqual(back.status === "ok" && back.provider, "reflection");
  // free_only still goes off at the next paid sign.
  w.script.push(ok('{"answer":"from beam"}', {}, { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 }));
  await w.run();
  assert.equal((await readRouterState(w.db))!.state, "off_paid");
  assert.equal(w.events("model_router.paid_detected").length, 2);
  // Over the kernel route: the owner's POST with confirm_free.
  const env = baseEnv("cryptophys-ai-kernel", w.db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL, ...ON });
  const post = (body: unknown, jwt = APPROVER_JWT) => call(kernel, env, req("POST", "/v1/model-router/state", body, jwt));
  assert.deepEqual([(await post({ state: "on" })).status, (await post({ state: "on", confirm_free: true }, OPERATOR_JWT)).status], [409, 403]);
  const ok2 = await post({ state: "on", mode: "free_only", confirm_free: true });
  assert.deepEqual([ok2.status, ok2.body.changed, ok2.body.status.state.state, ok2.body.status.state.mode], [200, true, "on", "free_only"]);
});

test("AIR1-23. the records: the amendment quotes the owner's three answers in order and limits xauusd to shadow:news_compare, with the share table and the org-wide guard; the requirement's exception, the SSOT and the K3 note say so", () => {
  const adr = read("architecture/adr/0007-ai-worker-os.md");
  const section = adr.slice(adr.indexOf("### xauusd's news_compare on Beam (owner 2026-11-25)"));
  assert.ok(section.length > 100, "the section exists");
  const order = ['"Approve, but Cerebrum only"', '"semua shadow pakai beam"', '"news_compare saja"'].map((q) => section.indexOf(q));
  assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], `the owner's answers in order: ${order}`);
  for (const want of [
    "2026-11-25", "`shadow:news_compare`", "FS1", "ai_usage_daily", "`xauusd-model-router`", "`XAUUSD_MODEL_ROUTER_AGENT`", "every other `shadow:*` source included",
  ]) assert.ok(section.includes(want), want);
  for (const want of [
    "| Cerebrum | 1M | 150k | 10 | 500 |", "| xauusd news_compare | 100k | 20k | 2 | 20 |", "| CTA | 1M | 200k | 20 | — |", "| Total | about 2.1M | about 370k | 32 | |",
    "`confirm_free`", "`output_budget`", "UPDATE ... RETURNING",
  ]) assert.ok(adr.includes(want), want);
  assert.doesNotMatch(adr, /xauusd shadow \| 3M/, "the earlier all-shadow share is gone");
  assert.match(adr, /9M input[^\n]*900k output[^\n]*50 requests a minute/);
  assert.match(adr, /Platform shadow callers: none/);
  const reqDoc = read("architecture/AI-ENGINE-REQUIREMENT.md");
  assert.match(reqDoc, /"news_compare saja"[^\n]*`shadow:news_compare` only/);
  const ssot = read("docs/SSOT.md");
  assert.match(ssot, /\*\*Model router \(AIR1[^\n]*"news_compare saja"[^\n]*`shadow:news_compare` only[^\n]*`xauusd-model-router`/);
  const k3 = JSON.parse(read("architecture/adr/progress/0007.json")).phases.find((p: any) => p.id === "K3");
  assert.ok(k3 && JSON.stringify(k3).includes("shadow:news_compare"), "the K3 note names xauusd's news_compare");
});
