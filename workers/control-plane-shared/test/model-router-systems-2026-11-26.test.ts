// Owner 2026-11-26 ("tambahkan untuk semua beam toggle dari cta dan juga xauusd di command"): one Beam switch per system
// (Cerebrum, CTA, xauusd's news_compare) on Cerebrum → Command, migration 0091. A paid sign from any system stops all of
// them (model_router_global) until the owner clears it; each system's router reads only its own switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, FakeD1, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, fakeAi, migratedDb, req } from "./harness.ts";
import { AiEngine, type AiTask } from "../src/ai-engine.ts";
import { CHAT_MODEL, CHAT_MODELS, CHAT_SERVICE } from "../src/conversation.ts";
import {
  ModelRouter, ModelRouterError, ROUTER_SYSTEMS, ROUTER_TASKS, forgetRouterState, modelRouterStatus, modelRouterStatusFor, readRouterGlobal, readRouterState,
  reportPaid, routerSystemOfOrigin, setRouterState, type ModelRouterEnv,
} from "../src/model-router.ts";
import { XAUUSD_MODEL_ROUTER_AGENT } from "../src/organism.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { rpcSyscall } from "../../ai-kernel/src/agent-rpc.ts";
import { unhandledProblems } from "../../ai-kernel/src/owner-inbox.ts";
import { reconcileNotices } from "../../ai-kernel/src/owner-notices.ts";

const ROOT = new URL("../../../", import.meta.url);
const MIGRATIONS = new URL("workers/control-plane-migrations/", ROOT);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const KEY = "rk-test-KEY-0123456789-never-stored";
const ON: ModelRouterEnv = { MODEL_ROUTER: "on", REFLECTION_API_KEY: KEY };
const XAU_AI = "xauusd-ai-trading-assistant";
const CTA_AGENT = "cta-model-router";
const CAPS = JSON.stringify(["model_router.status", "model_router.report_paid"]);

/** The database as it stood before migration 0091 (every migration before it, as wrangler applied them). */
function dbBefore0091(): FakeD1 {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    if (f >= "0091") break;
    raw.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  }
  return new FakeD1(raw);
}
const apply0091 = (db: FakeD1) => db.raw.exec(read("workers/control-plane-migrations/0091_model_router_systems.sql"));
/** The 0090 reader (readRouterState and the status's state block as they were before 0091), over the old table. */
const oldRead = (db: FakeD1) => ({ ...(db.raw.prepare("SELECT state, mode, paid_cap_usd, spent_usd, updated_by, updated_at, reason FROM model_router_state WHERE id = 'global'").get() as Record<string, unknown>) });
const pick = (s: Record<string, unknown> | null) => s && { state: s.state, mode: s.mode, paid_cap_usd: s.paid_cap_usd, spent_usd: s.spent_usd, updated_by: s.updated_by, updated_at: s.updated_at, reason: s.reason };

function agent(db: FakeD1, id: string, host: string) {
  const at = new Date().toISOString();
  db.raw.prepare(`INSERT INTO agents (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, 'test', 1, ?, 'enabled', NULL, 'consensus:test', ?, ?)`).run(id, id, host, CAPS, at, at);
}
function kernelEnv(db: FakeD1) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  return { ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL, ...ON }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async () => { throw new Error("unused"); } } };
}
const set = async (db: FakeD1, body: Record<string, unknown>) => { const r = await setRouterState(db, APPROVER_EMAIL, body); forgetRouterState(db); return r; };

interface Answer { answer: string }
const task: AiTask<Answer> = { name: "chat_answer", instructions: "Answer.", maxInputChars: 20_000, maxOutputTokens: 600,
  validate: (o) => (o && typeof (o as Answer).answer === "string" ? { answer: (o as Answer).answer } : null) };
function cerebrum(db: FakeD1) {
  const fetches: string[] = [];
  const reply = () => new Response(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: '{"answer":"from beam"}' }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    { status: 200, headers: { "content-type": "application/json", "reflection-data-retention": "none" } });
  const router = new ModelRouter({ db, env: ON, fetch: async (url) => { fetches.push(url); return reply(); } });
  const engine = new AiEngine({ service: CHAT_SERVICE, ai: fakeAi({ response: '{"answer":"from workers ai"}' }), db, allowedModels: CHAT_MODELS, model: CHAT_MODEL, ownBudget: async () => true, router, allowedTasks: [...ROUTER_TASKS] });
  return { fetches, run: () => engine.run(task, { question: "q" }, "c1") };
}

test("BEAM-1. migration 0091: the 0090 row becomes Cerebrum's with every value kept; a pre-0091 and a post-0091 read give the same Cerebrum state; CTA and xauusd are seeded off; the audit trail is untouched", async () => {
  const cases: [string, string | null][] = [
    ["default off", null],
    ["owner on", "UPDATE model_router_state SET state = 'on', updated_by = 'approver@cryptophys.work', updated_at = '2026-11-25T12:00:00.000Z', reason = 'turned on (free_only)'"],
    ["owner off", "UPDATE model_router_state SET state = 'off_owner', updated_by = 'approver@cryptophys.work', updated_at = '2026-11-25T13:00:00.000Z', reason = 'pause'"],
    ["paid capped with spend", "UPDATE model_router_state SET state = 'on', mode = 'paid_capped', paid_cap_usd = 5, spent_usd = 0.25, updated_by = 'approver@cryptophys.work', updated_at = '2026-11-25T14:00:00.000Z', reason = 'capped'"],
    ["off_paid", "UPDATE model_router_state SET state = 'off_paid', updated_by = 'agent:xauusd-model-router', updated_at = '2026-11-25T15:00:00.000Z', reason = 'paid sign: http_402'"],
    ["off_retention", "UPDATE model_router_state SET state = 'off_retention', updated_by = 'system:model-router', updated_at = '2026-11-25T16:00:00.000Z', reason = 'retention header: contributor'"],
  ];
  for (const [name, sql] of cases) {
    const db = dbBefore0091();
    if (sql) db.raw.exec(sql);
    db.raw.exec("INSERT INTO audit_events (event_id, event_type, actor, subject, outcome, payload_json, previous_hash, event_hash, created_at) VALUES ('ev-mr', 'model_router.state_changed', 'x', 'model_router', 'on', '{}', NULL, 'h', 't0')");
    const before = oldRead(db);
    const audits = JSON.stringify(db.raw.prepare("SELECT * FROM audit_events ORDER BY rowid").all());
    apply0091(db);
    forgetRouterState(db);
    const after = await readRouterState(db);
    assert.deepEqual(pick(after as never), before, `${name}: the same Cerebrum state through readRouterState`);
    const st = await modelRouterStatus(db, ON) as any;
    assert.deepEqual([st.schema, st.system, pick(st.state)], ["model_router.status.v1", "cerebrum", before], `${name}: the same state block in the status read`);
    assert.equal(JSON.stringify(db.raw.prepare("SELECT * FROM audit_events ORDER BY rowid").all()), audits, `${name}: audit_events untouched`);
    const rows = db.raw.prepare("SELECT system, state, mode, paid_cap_usd, spent_usd, last_status_read_at FROM model_router_state ORDER BY system").all().map((r) => ({ ...r }));
    const cer = before.state === "off_paid" ? "off" : before.state;
    assert.deepEqual(rows, [
      { system: "cerebrum", state: cer, mode: before.mode, paid_cap_usd: before.paid_cap_usd, spent_usd: before.spent_usd, last_status_read_at: null },
      { system: "cta", state: "off", mode: "free_only", paid_cap_usd: null, spent_usd: 0, last_status_read_at: null },
      { system: "xauusd", state: "off", mode: "free_only", paid_cap_usd: null, spent_usd: 0, last_status_read_at: null },
    ], name);
    const g = await readRouterGlobal(db);
    assert.equal(g!.paid_off, before.state === "off_paid", `${name}: the paid sign moves to the global stop`);
    if (before.state === "off_paid") {
      assert.deepEqual([g!.updated_by, g!.updated_at, g!.reason], [before.updated_by, before.updated_at, before.reason]);
      for (const s of ["cta", "xauusd"] as const) assert.equal((await readRouterState(db, s))!.state, "off_paid", `${s} is stopped with it`);
    }
  }
  // The rebuilt table's CHECKs: three systems, no off_paid row state, a cap for paid_capped.
  const db = migratedDb();
  assert.throws(() => db.raw.exec("INSERT INTO model_router_state (system, state, mode, updated_by, updated_at) VALUES ('aether', 'off', 'free_only', 'x', 't0')"));
  assert.throws(() => db.raw.exec("UPDATE model_router_state SET state = 'off_paid' WHERE system = 'cta'"));
  assert.throws(() => db.raw.exec("UPDATE model_router_state SET mode = 'paid_capped' WHERE system = 'cta'"));
  assert.throws(() => db.raw.exec("INSERT INTO model_router_global (id, paid_off, updated_by, updated_at) VALUES ('other', 0, 'x', 't0')"));
  assert.throws(() => db.raw.exec("UPDATE model_router_global SET paid_off = 2"));
  assert.deepEqual([...ROUTER_SYSTEMS], ["cerebrum", "cta", "xauusd"]);
});

test("BEAM-2. model_router.status answers for the caller's system: xauusd-model-router reads xauusd's switch (the same schema and state fields SB1 reads), never Cerebrum's or CTA's; a cta agent reads CTA's; Aether has none", async () => {
  const db = migratedDb();
  forgetRouterState(db);
  const env = kernelEnv(db);
  agent(db, XAUUSD_MODEL_ROUTER_AGENT, XAU_AI);
  agent(db, CTA_AGENT, "cryptophys-cta");
  agent(db, "aether-router-probe", "cryptophys-aether");
  agent(db, "platform-router-probe", "cryptophys-ai-kernel");
  await set(db, { state: "on" });
  await set(db, { system: "cta", state: "on", mode: "paid_capped", paid_cap_usd: 3 });
  const xau = await rpcSyscall(env as never, { host_worker: XAU_AI }, XAUUSD_MODEL_ROUTER_AGENT, "model_router.status", {}) as any;
  assert.equal(xau.outcome, "succeeded", JSON.stringify(xau));
  // SB1 (#599) reads { schema: "model_router.status.v1", state: { state, mode } } and routes only on on + free_only.
  assert.deepEqual([xau.result.schema, xau.result.system, xau.result.state.state, xau.result.state.mode, xau.result.effective], ["model_router.status.v1", "xauusd", "off", "free_only", "off"]);
  assert.deepEqual([xau.result.ledger, xau.result.fallbacks, xau.result.tasks, xau.result.today, xau.result.limits, xau.result.systems], [[], {}, [], null, null, undefined], "none of Cerebrum's own use, no other system's row");
  assert.equal(xau.result.global.paid_off, false);
  assert.ok(!JSON.stringify(xau).includes("paid_capped") && !JSON.stringify(xau).includes(KEY), "nothing of CTA's switch, never the key");
  const asks = await rpcSyscall(env as never, { host_worker: XAU_AI }, XAUUSD_MODEL_ROUTER_AGENT, "model_router.status", { system: "cerebrum" }) as any;
  assert.deepEqual([asks.outcome, /own system/.test(asks.reason)], ["failed", true], "an agent cannot read another system's row");
  assert.equal((await rpcSyscall(env as never, { host_worker: XAU_AI }, XAUUSD_MODEL_ROUTER_AGENT, "model_router.status", { system: "xauusd" }) as any).outcome, "succeeded");
  // The owner turns xauusd on: xauusd's router may call Beam (on, free_only); Cerebrum's and CTA's switches are untouched.
  await set(db, { system: "xauusd", state: "on" });
  const on = await rpcSyscall(env as never, { host_worker: XAU_AI }, XAUUSD_MODEL_ROUTER_AGENT, "model_router.status", {}) as any;
  assert.deepEqual([on.result.state.state, on.result.state.mode], ["on", "free_only"]);
  const cta = await syscall(env as never, CTA_AGENT, "model_router.status", {}) as any;
  assert.deepEqual([cta.outcome, cta.result.system, cta.result.state.state, cta.result.state.mode, cta.result.state.paid_cap_usd], ["succeeded", "cta", "on", "paid_capped", 3]);
  const platform = await syscall(env as never, "platform-router-probe", "model_router.status", {}) as any;
  assert.deepEqual([platform.result.system, platform.result.state.state, platform.result.tasks.length], ["cerebrum", "on", ROUTER_TASKS.length]);
  const aether = await syscall(env as never, "aether-router-probe", "model_router.status", {}) as any;
  assert.deepEqual([aether.outcome, /model_router_no_system/.test(aether.reason)], ["failed", true]);
  assert.equal((await syscall(env as never, "aether-router-probe", "model_router.report_paid", { signal: "http_402" }) as any).outcome, "failed");
  assert.equal((await readRouterGlobal(db))!.paid_off, false, "Aether's report changes nothing");
  // The one map.
  assert.deepEqual([routerSystemOfOrigin(null), routerSystemOfOrigin(undefined), routerSystemOfOrigin("xauusd"), routerSystemOfOrigin("cta"), routerSystemOfOrigin("aether"), routerSystemOfOrigin("other")],
    ["cerebrum", "cerebrum", "xauusd", "cta", null, null]);
});

test("BEAM-3. a paid sign from xauusd stops every system (one global stop, one audit event, one owner notice); turning a system off does not clear it; the owner's confirmed free turn-on of any system clears it for all", async () => {
  const db = migratedDb();
  forgetRouterState(db);
  const env = kernelEnv(db);
  agent(db, XAUUSD_MODEL_ROUTER_AGENT, XAU_AI);
  for (const system of ROUTER_SYSTEMS) await set(db, { system, state: "on" });
  const c = cerebrum(db);
  const first = await c.run();
  assert.deepEqual(first.status === "ok" && first.provider, "reflection");
  const sent: { title: string }[] = [];
  const notify = { DB: db, APPROVER_IDENTITIES: APPROVER_EMAIL, OWNER_NOTICE_CHANNELS: "telegram", OWNER_TELEGRAM: { notify: async (m: { title: string }) => { sent.push(m); return { sent: true }; } } };
  await reconcileNotices(notify as never);
  const before = sent.filter((m) => /production problem/i.test(m.title)).length;
  const rep = await rpcSyscall(env as never, { host_worker: XAU_AI }, XAUUSD_MODEL_ROUTER_AGENT, "model_router.report_paid", { signal: "http_402" }) as any;
  assert.deepEqual([rep.outcome, rep.result], ["succeeded", { state: "off_paid", changed: true }]);
  const again = await rpcSyscall(env as never, { host_worker: XAU_AI }, XAUUSD_MODEL_ROUTER_AGENT, "model_router.report_paid", { signal: "billing_error" }) as any;
  assert.deepEqual(again.result, { state: "off_paid", changed: false }, "idempotent");
  forgetRouterState(db);
  const get = await call(kernel, env, req("GET", "/v1/model-router", undefined, OPERATOR_JWT));
  assert.deepEqual(get.body.systems.map((s: any) => [s.system, s.state.state, s.state.switch, s.effective]), [["cerebrum", "off_paid", "on", "off_paid"], ["cta", "off_paid", "on", "off_paid"], ["xauusd", "off_paid", "on", "off_paid"]]);
  assert.deepEqual([get.body.global.paid_off, get.body.global.reason, get.body.global.updated_by], [true, "paid sign: http_402", `agent:${XAUUSD_MODEL_ROUTER_AGENT}`]);
  const skipped = await c.run();
  assert.deepEqual([skipped.status === "ok" && skipped.provider, c.fetches.length], ["workers_ai", 1], "Cerebrum's router skips Beam");
  const ev = db.raw.prepare("SELECT actor, payload_json FROM audit_events WHERE event_type = 'model_router.paid_detected'").all() as any[];
  assert.deepEqual(ev.map((e) => [e.actor, JSON.parse(e.payload_json).signal, JSON.parse(e.payload_json).system, JSON.parse(e.payload_json).scope]), [[`agent:${XAUUSD_MODEL_ROUTER_AGENT}`, "http_402", "xauusd", "all_systems"]]);
  const problems = (await unhandledProblems(db as never)).filter((p) => p.code === "model_router_stopped");
  assert.deepEqual(problems.map((p) => p.subject), ["model_router:off_paid"]);
  assert.match(problems[0].detail, /every system \(Cerebrum, CTA and xauusd's news_compare\)[^]*paid sign \(paid sign: http_402\)/);
  await reconcileNotices(notify as never);
  await reconcileNotices(notify as never);
  assert.equal(sent.filter((m) => /production problem/i.test(m.title)).length - before, 1, "one owner notice");
  // The paid rules stay: free_only without confirm_free is refused for every system; turning one off does not clear it.
  for (const system of ROUTER_SYSTEMS) {
    await assert.rejects(set(db, { system, state: "on" }), (e: unknown) => e instanceof ModelRouterError && e.status === 409 && e.code === "paid_sign_recorded", system);
  }
  await set(db, { system: "cta", state: "off" });
  assert.deepEqual([(await readRouterGlobal(db))!.paid_off, (await readRouterState(db, "cta"))!.switch, (await readRouterState(db, "cta"))!.state], [true, "off_owner", "off_paid"]);
  // The owner's confirmed free turn-on of xauusd clears the stop for all: Cerebrum follows its own switch (on) again, CTA stays off (its switch).
  const cleared = await set(db, { system: "xauusd", state: "on", confirm_free: true });
  assert.deepEqual([cleared.changed, cleared.state!.state], [true, "on"], "the row was already on: clearing the stop is still a change");
  assert.deepEqual(await Promise.all(ROUTER_SYSTEMS.map(async (s) => (await readRouterState(db, s))!.state)), ["on", "off_owner", "on"]);
  const pc = db.raw.prepare("SELECT actor, payload_json FROM audit_events WHERE event_type = 'model_router.paid_cleared'").all() as any[];
  assert.deepEqual(pc.map((e) => [e.actor, JSON.parse(e.payload_json)]), [[APPROVER_EMAIL, { via_system: "xauusd", mode: "free_only", scope: "all_systems", confirm_free: true }]]);
  const sc = db.raw.prepare("SELECT payload_json FROM audit_events WHERE event_type = 'model_router.state_changed' ORDER BY rowid DESC LIMIT 1").get() as any;
  assert.deepEqual(JSON.parse(sc.payload_json), { system: "xauusd", from: "off_paid", to: "on", mode: "free_only", paid_cap_usd: null, reason: null, confirm_free: true });
  assert.deepEqual((await unhandledProblems(db as never)).filter((p) => p.code === "model_router_stopped"), [], "the owner item closes");
  const back = await c.run();
  assert.deepEqual(back.status === "ok" && back.provider, "reflection");
  // A paid_capped turn-on clears it too; the kernel's own paid sign (cost on free_only) stops everyone again.
  await reportPaid(db, "system:model-router", "cost_field");
  await set(db, { system: "cta", state: "on", mode: "paid_capped", paid_cap_usd: 2 });
  assert.equal((await readRouterGlobal(db))!.paid_off, false);
  assert.deepEqual(await Promise.all(ROUTER_SYSTEMS.map(async (s) => (await readRouterState(db, s))!.state)), ["on", "on", "on"]);
});

test("BEAM-4. the owner's route per system: POST /v1/model-router/state with system (cerebrum by default); 403 for anyone else; an unknown system is refused; GET returns every system's row and the global stop", async () => {
  const db = migratedDb();
  const env = kernelEnv(db);
  const post = (body: unknown, jwt = APPROVER_JWT) => call(kernel, env, req("POST", "/v1/model-router/state", body, jwt));
  for (const system of ROUTER_SYSTEMS) {
    const denied = await post({ system, state: "on" }, OPERATOR_JWT);
    assert.deepEqual([denied.status, denied.body.error], [403, "owner_required"], system);
    assert.equal((await post({ system, state: "off" }, OPERATOR_JWT)).status, 403, system);
  }
  for (const bad of ["aether", "CTA", "", 1, null]) assert.deepEqual([(await post({ system: bad, state: "on" })).status, (await post({ system: bad, state: "on" })).body.error], [400, "invalid_system"], String(bad));
  const cta = await post({ system: "cta", state: "on" });
  assert.equal(cta.status, 200);
  assert.deepEqual(cta.body.status.systems.map((s: any) => [s.system, s.state.state]), [["cerebrum", "off"], ["cta", "on"], ["xauusd", "off"]], "only CTA's switch moved");
  assert.deepEqual([cta.body.status.system, cta.body.status.state.state], ["cerebrum", "off"], "the top-level view is still Cerebrum's");
  const xau = await post({ system: "xauusd", state: "on", mode: "paid_capped", paid_cap_usd: 1.5 });
  const xs = xau.body.status.systems.find((s: any) => s.system === "xauusd").state;
  assert.deepEqual([xs.state, xs.mode, xs.paid_cap_usd, xs.switch, xs.updated_by], ["on", "paid_capped", 1.5, "on", APPROVER_EMAIL]);
  assert.equal((await post({ system: "xauusd", state: "off" })).body.status.systems.find((s: any) => s.system === "xauusd").state.state, "off_owner");
  const legacy = await post({ state: "on" });
  assert.deepEqual([legacy.status, legacy.body.status.state.state, legacy.body.status.systems[0].state.state], [200, "on", "on"], "no system: Cerebrum, as before 0091");
  const changes = db.raw.prepare("SELECT actor, payload_json FROM audit_events WHERE event_type = 'model_router.state_changed' ORDER BY rowid").all() as any[];
  assert.deepEqual(changes.map((c) => [c.actor, JSON.parse(c.payload_json).system, JSON.parse(c.payload_json).to]), [[APPROVER_EMAIL, "cta", "on"], [APPROVER_EMAIL, "xauusd", "on"], [APPROVER_EMAIL, "xauusd", "off_owner"], [APPROVER_EMAIL, "cerebrum", "on"]]);
  const get = await call(kernel, env, req("GET", "/v1/model-router", undefined, OPERATOR_JWT));
  assert.equal(get.status, 200);
  assert.deepEqual(Object.keys(get.body.systems[0]).sort(), ["available", "effective", "last_status_read_at", "state", "system"]);
  assert.deepEqual(get.body.global && Object.keys(get.body.global).sort(), ["paid_off", "reason", "updated_at", "updated_by"]);
  assert.ok(!JSON.stringify(get.body).includes(KEY));
  // The Console's allow-list keeps one route and three phrases; the body names the system.
  const routes = read("workers/console/src/ui/routes.ts");
  for (const [id, phrase] of [["kernel.model_router_on", "BEAM ON"], ["kernel.model_router_off", "BEAM OFF"], ["kernel.model_router_on_free", "BEAM ON FREE"]]) {
    assert.match(routes, new RegExp(`r\\("${id.replace(".", "\\.")}", "kernel", "POST", "/v1/model-router/state", true, "${phrase}"\\)`));
  }
});

test("BEAM-5. Cerebrum's routing is unchanged: its own switch alone decides; CTA's or xauusd's on never turns Cerebrum's router on", async () => {
  const db = migratedDb();
  forgetRouterState(db);
  const c = cerebrum(db);
  await set(db, { system: "xauusd", state: "on" });
  await set(db, { system: "cta", state: "on" });
  const off = await c.run();
  assert.deepEqual([off.status === "ok" && off.provider, c.fetches.length], ["workers_ai", 0]);
  await set(db, { state: "on" });
  const on = await c.run();
  assert.deepEqual([on.status === "ok" && on.provider, c.fetches.length], ["reflection", 1]);
  await set(db, { system: "xauusd", state: "off" });
  assert.deepEqual((await c.run()).status === "ok" && c.fetches.length, 2, "xauusd's off leaves Cerebrum on");
  const ledger = db.raw.prepare("SELECT system, provider, fallbacks_json FROM model_calls_daily ORDER BY provider").all().map((r) => ({ ...r }));
  assert.deepEqual(ledger, [{ system: "cerebrum", provider: "reflection", fallbacks_json: "{}" }, { system: "cerebrum", provider: "workers_ai", fallbacks_json: '{"off":1}' }]);
});

test("BEAM-6. last_status_read_at: null until a system's agent reads model_router.status, then the read's time (at most one write a minute); it never moves the switch's updated_by or updated_at", async () => {
  const db = migratedDb();
  forgetRouterState(db);
  const T = Date.parse("2026-11-26T09:00:00.000Z");
  await set(db, { system: "xauusd", state: "on" });
  const sw = db.raw.prepare("SELECT updated_by, updated_at FROM model_router_state WHERE system = 'xauusd'").get();
  let get = await modelRouterStatus(db, ON, T) as any;
  assert.deepEqual(get.systems.map((s: any) => s.last_status_read_at), [null, null, null]);
  const r1 = await modelRouterStatusFor(db, ON, "xauusd", T) as any;
  assert.equal(r1.last_status_read_at, "2026-11-26T09:00:00.000Z");
  await modelRouterStatusFor(db, ON, "xauusd", T + 30_000);
  get = await modelRouterStatus(db, ON, T + 30_000) as any;
  assert.deepEqual(get.systems.map((s: any) => [s.system, s.last_status_read_at]), [["cerebrum", null], ["cta", null], ["xauusd", "2026-11-26T09:00:00.000Z"]], "within a minute: one write");
  await modelRouterStatusFor(db, ON, "xauusd", T + 61_000);
  assert.equal((await readRouterState(db, "xauusd"))!.last_status_read_at, "2026-11-26T09:01:01.000Z");
  assert.deepEqual({ ...db.raw.prepare("SELECT updated_by, updated_at FROM model_router_state WHERE system = 'xauusd'").get() }, { ...sw });
  // Over the syscall path, the agent's read records its own system only.
  const env = kernelEnv(db);
  agent(db, XAUUSD_MODEL_ROUTER_AGENT, XAU_AI);
  agent(db, CTA_AGENT, "cryptophys-cta");
  await syscall(env as never, CTA_AGENT, "model_router.status", {});
  const rows = db.raw.prepare("SELECT system, last_status_read_at FROM model_router_state ORDER BY system").all() as any[];
  assert.deepEqual([rows[0].last_status_read_at, typeof rows[1].last_status_read_at, rows[2].last_status_read_at], [null, "string", "2026-11-26T09:01:01.000Z"]);
  // The kernel's GET (an operator reading) records nothing.
  await call(kernel, env, req("GET", "/v1/model-router", undefined, OPERATOR_JWT));
  assert.equal((db.raw.prepare("SELECT last_status_read_at FROM model_router_state WHERE system = 'cerebrum'").get() as any).last_status_read_at, null);
});

test("BEAM-7. the guard reasons are unchanged, and the records: SSOT line 5 and its model router bullet, the ADR-0007 amendment, the Console's Command card for three systems", () => {
  assert.equal(criticalPathReason("workers/control-plane-shared/src/model-router.ts"), "paid_model_guard");
  assert.equal(criticalPathReason("workers/control-plane-shared/src/organism.ts"), "capability_ceiling");
  assert.equal(criticalPathReason("workers/control-plane-shared/src/ai-engine.ts"), null);
  const ssot = read("docs/SSOT.md");
  assert.ok(ssot.split("\n")[4].startsWith('Last reviewed: 2026-11-16 (beam toggles, 2026-11-26 (owner: "tambahkan untuk semua beam toggle dari cta dan juga xauusd di command"; per-system Beam switches for Cerebrum, CTA and xauusd on Command, a paid sign stops all); '));
  assert.match(ssot, /\*\*Model router \(AIR1[^\n]*"tambahkan untuk semua beam toggle dari cta dan juga xauusd di command"[^\n]*`model_router_global`/);
  const adr = read("architecture/adr/0007-ai-worker-os.md");
  const section = adr.slice(adr.indexOf("### Per-system Beam switches (owner 2026-11-26)"));
  assert.ok(section.length > 100, "the section exists");
  for (const want of ['"tambahkan untuk semua beam toggle dari cta dan juga xauusd di command"', "`model_router_global`", "`model_router.status`", "0091", "`confirm_free`", "`last_status_read_at`"]) assert.ok(section.includes(want), want);
  const panel = read("workers/console/ui/src/components/ModelRouterPanel.tsx");
  for (const want of ['"cerebrum"', '"cta"', '"xauusd"', "not connected yet", "data-beam-system"]) assert.ok(panel.includes(want), want);
  assert.doesNotMatch(panel, /REFLECTION_API_KEY/);
  assert.match(read("workers/control-plane-migrations/test_migrations.py"), /PASS: 0091 model_router_systems/);
});
