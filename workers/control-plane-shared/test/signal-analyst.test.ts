import { test } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, migratedDb, req, call } from "./harness.ts";
import { parsePolicyRequest, decide } from "../../policy-engine/src/index.ts";
function kernelEnv(db: any, extra: any = {}) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const env: any = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: "ci-client.access,ops@cryptophys.work,approver@cryptophys.work", APPROVER_IDENTITIES: "approver@cryptophys.work" }),
    POLICY: { evaluate: async (input: any) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as any, p); } },
    RECOVERY: { propose: async () => ({}) },
    SIGNALS: { reingest: async () => ({ run_id: "x", series: 1, failed: 0 }) },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    ...extra,
  };
  const memStore = new Map();
  const mem = { get: async (k: string) => memStore.get(k), put: async (k: string, v: any) => { memStore.set(k, v); }, delete: async (k: string) => { memStore.delete(k); } };
  return { env, db, mem };
}
import { observeSignals, withoutLevels } from "../../ai-kernel/src/syscall.ts";
import { runSignalCycle } from "../../ai-kernel/src/signal-analyst.ts";
import { SignalAnalystCycleQueue } from "../../ai-kernel/src/signal-analyst.ts";

function fakeXauusd(items: any[], status = 200) {
  return {
    fetch: async () => new Response(JSON.stringify({ status: "ok", count: items.length, items }), { status, headers: { "content-type": "application/json" } }),
  };
}
function emptyXauusd() {
  return { fetch: async () => new Response(JSON.stringify({ status: "ok", count: 0, items: [] }), { status: 200, headers: { "content-type": "application/json" } }) };
}
function badFetchXauusd(err: Error) {
  return { fetch: async () => { throw err; } };
}
function neverXauusd() {
  return { fetch: async (_u: any, init: any) => new Promise((_res, rej) => { if (init?.signal) init.signal.addEventListener("abort", () => rej(new Error("AbortError"))); }) };
}
function httpXauusd(status: number) {
  return { fetch: async () => new Response("err", { status }) };
}
function nonJsonXauusd() {
  return { fetch: async () => new Response("not json", { status: 200 }) };
}

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const item = (overrides: any = {}) => ({
  candle_key: `OANDA:XAUUSD:60:${NOW - 10 * 60_000}`,
  timestamp: "2026-11-05 11:05:16",
  decision: "WAIT",
  confidence: 0.3,
  entry_price: null,
  stop_loss: null,
  take_profit: null,
  risk_reward: null,
  position_size_pct: 0.5,
  reasoning: "r",
  ...overrides,
});

test("TP-017 normalize", async () => {
  const binding = fakeXauusd([
    item({ position_size_pct: 0.5, reasoning: "x".repeat(350), confidence: 2, entry_price: 0, decision: "NOPE", candle_key: "bad" }),
    item({ candle_key: "OANDA:XAUUSD:60:1793876400000", decision: "BUY", confidence: 0.5, entry_price: 100, stop_loss: 99, take_profit: 101, risk_reward: 2, reasoning: "x".repeat(350) }),
  ]);
  const db = migratedDb();
  const { env } = kernelEnv(db, { XAUUSD_AI: binding });
  const r: any = await observeSignals(env as any, NOW);
  assert.equal(r.available, true);
  assert.equal(r.recent.length, 1);
  const n = r.recent[0];
  assert.equal(n.candle_key, "OANDA:XAUUSD:60:1793876400000");
  assert.equal(n.decision, "BUY");
  assert.equal(n.confidence, 0.5);
  for (const k of ["entry_price", "stop_loss", "take_profit", "position_size_pct"]) assert.equal(k in n, false, `${k} never enters the kernel`);
  assert.equal(n.risk_reward, 2, "the ratio is not a level and is kept");
  assert.equal(n.reasoning.length, 300);
});

test("no price level reaches a kernel report, the cycle memory or the observation (owner rule, 2026-11-07)", async () => {
  const levels = { decision: "SELL", confidence: 0.6, entry_price: 4051.2, stop_loss: 4060, take_profit: 4030, risk_reward: 2.4,
    reasoning: "Rejected 4,078.50 twice; the prior level was 123456; sell below 4051 with the stop above $4060 and the target near 4030." };
  const { env, db, mem } = kernelEnv(migratedDb(), { XAUUSD_AI: fakeXauusd([item(levels)]) });
  const obs: any = await observeSignals(env as any, NOW);
  assert.equal(obs.latest.reasoning, "Rejected [level] twice; the prior level was [level]; sell below [level] with the stop above [level] and the target near [level].");
  const cycle = await runSignalCycle(env as any, mem, "operator", NOW);
  const body = JSON.parse(((db as any).raw.prepare("SELECT body_json FROM agent_reports WHERE agent_id='signal-analyst'").get() as any).body_json);
  assert.deepEqual([body.decision, body.confidence, body.risk_reward], ["SELL", 0.6, 2.4]);
  const PRICE = /\b(?:\d{3,}(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?)\b/;
  for (const [what, value] of [["report body", body], ["cycle report", cycle], ["observation", obs]] as const) {
    const text = JSON.stringify(value);
    for (const k of ["entry_price", "stop_loss", "take_profit"]) assert.equal(text.includes(k), false, `${what} carries ${k}`);
    // Ids, keys and timestamps hold digit runs that are not prices.
    const cleaned = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|OANDA:XAUUSD:60:\d+|"candle_open_ms":\d+|\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, "");
    assert.equal(PRICE.test(cleaned), false, `${what} carries a price-like number`);
  }
});

test("TP-017 errors", async () => {
  const db = migratedDb();
  // missing
  const { env: e0 } = kernelEnv(db);
  const r0: any = await observeSignals(e0 as any, NOW);
  assert.equal(r0.error, "xauusd_binding_missing");

  // http 500
  const { env: e1 } = kernelEnv(migratedDb(), { XAUUSD_AI: httpXauusd(500) });
  const r1: any = await observeSignals(e1 as any, NOW);
  assert.equal(r1.error, "xauusd_http_500");

  // throw
  const { env: e2 } = kernelEnv(migratedDb(), { XAUUSD_AI: badFetchXauusd(new Error("boom")) });
  const r2: any = await observeSignals(e2 as any, NOW);
  assert.equal(r2.error, "xauusd_unreachable");

  // timeout
  const { env: e3 } = kernelEnv(migratedDb(), { XAUUSD_AI: neverXauusd() });
  const r3: any = await observeSignals(e3 as any, NOW, 10);
  assert.equal(r3.error, "xauusd_timeout");

  // non-json
  const { env: e4 } = kernelEnv(migratedDb(), { XAUUSD_AI: nonJsonXauusd() });
  const r4: any = await observeSignals(e4 as any, NOW);
  assert.equal(r4.error, "xauusd_invalid_body");

  // never throws
  const { env: e5 } = kernelEnv(migratedDb(), { XAUUSD_AI: { fetch: async () => { throw new Error("x"); } } });
  assert.doesNotThrow(() => observeSignals(e5 as any, NOW));
});

test("TP-017 stale rule", async () => {
  // 89 minutes ago close -> not stale
  const open89 = NOW - 89 * 60_000 - 3_600_000; // close 89 min ago? close = open+1h; now-close=89min => open = now - 89min - 1h
  // simpler: latest candle open such that close is 89 min ago
  const openMs89 = NOW - 89 * 60_000 - 60 * 60_000;
  const key89 = `OANDA:XAUUSD:60:${openMs89}`;
  const { env: e1 } = kernelEnv(migratedDb(), { XAUUSD_AI: fakeXauusd([item({ candle_key: key89 })]) });
  const r1: any = await observeSignals(e1 as any, NOW);
  assert.equal(r1.stale, false);

  const openMs91 = NOW - 91 * 60_000 - 60 * 60_000;
  const key91 = `OANDA:XAUUSD:60:${openMs91}`;
  const { env: e2 } = kernelEnv(migratedDb(), { XAUUSD_AI: fakeXauusd([item({ candle_key: key91 })]) });
  const r2: any = await observeSignals(e2 as any, NOW);
  assert.equal(r2.stale, true);

  const { env: e3 } = kernelEnv(migratedDb(), { XAUUSD_AI: emptyXauusd() });
  const r3: any = await observeSignals(e3 as any, NOW);
  assert.equal(r3.stale, true);
});

test("TP-017 first digest", async () => {
  const { env, db, mem } = kernelEnv(migratedDb(), { XAUUSD_AI: fakeXauusd([item()]) });
  const cycle = await runSignalCycle(env as any, mem, "operator", NOW);
  const reports = (db as any).raw.prepare("SELECT * FROM agent_reports WHERE agent_id='signal-analyst'").all();
  assert.equal(reports.length, 1);
  const r = reports[0];
  assert.equal(r.kind, "xauusd_digest");
  assert.equal(r.severity, "info");
  assert.equal(r.ai_status, "deterministic");
  assert.ok(JSON.parse(r.body_json).disclaimer);
});

test("TP-017 no repeat", async () => {
  const binding = fakeXauusd([item()]);
  const { env, db, mem } = kernelEnv(migratedDb(), { XAUUSD_AI: binding });
  await runSignalCycle(env as any, mem, "operator", NOW);
  // same candle again within 6h
  const cycle2 = await runSignalCycle(env as any, mem, "operator", NOW + 1000);
  const reports = (db as any).raw.prepare("SELECT COUNT(*) AS n FROM agent_reports WHERE agent_id='signal-analyst'").get().n;
  assert.equal(reports, 1);
  // new candle same decision within 6h
  const binding2 = fakeXauusd([item({ candle_key: `OANDA:XAUUSD:60:${NOW - 3_600_000}`, decision: "WAIT" })]);
  (env as any).XAUUSD_AI = binding2;
  await runSignalCycle(env as any, mem, "operator", NOW + 2000);
  const reports2 = (db as any).raw.prepare("SELECT COUNT(*) AS n FROM agent_reports WHERE agent_id='signal-analyst'").get().n;
  assert.equal(reports2, 1);
});

test("TP-017 change and flip", async () => {
  const { env, db, mem } = kernelEnv(migratedDb(), { XAUUSD_AI: fakeXauusd([item({ decision: "WAIT" })]) });
  await runSignalCycle(env as any, mem, "operator", NOW);
  // new candle WAIT->BUY info
  (env as any).XAUUSD_AI = fakeXauusd([item({ candle_key: "OANDA:XAUUSD:60:1793876400000", decision: "BUY" })]);
  await runSignalCycle(env as any, mem, "operator", NOW + 3600_000);
  // new candle BUY->SELL warning
  (env as any).XAUUSD_AI = fakeXauusd([item({ candle_key: "OANDA:XAUUSD:60:1793880000000", decision: "SELL" })]);
  await runSignalCycle(env as any, mem, "operator", NOW + 7200_000);
  const rows = (db as any).raw.prepare("SELECT severity FROM agent_reports WHERE agent_id='signal-analyst' ORDER BY rowid").all();
  assert.equal(rows[rows.length - 1].severity, "warning");
});

test("TP-017 six-hour heartbeat", async () => {
  const { env, db, mem } = kernelEnv(migratedDb(), { XAUUSD_AI: fakeXauusd([item()]) });
  await runSignalCycle(env as any, mem, "operator", NOW);
  // Same decision six hours later, on a candle that is fresh at that time (not stale).
  const later = NOW + 6 * 3600_000 + 1000;
  (env as any).XAUUSD_AI = fakeXauusd([item({ candle_key: `OANDA:XAUUSD:60:${later - 10 * 60_000}` })]);
  await runSignalCycle(env as any, mem, "operator", later);
  const n = (db as any).raw.prepare("SELECT COUNT(*) AS n FROM agent_reports WHERE agent_id='signal-analyst'").get().n;
  assert.equal(n, 2);
});

test("TP-017 stale report", async () => {
  const openMs = NOW - 91 * 60_000 - 60 * 60_000;
  const key = `OANDA:XAUUSD:60:${openMs}`;
  const binding = fakeXauusd([item({ candle_key: key })]);
  const { env, db, mem } = kernelEnv(migratedDb(), { XAUUSD_AI: binding });
  await runSignalCycle(env as any, mem, "operator", NOW);
  const n1 = (db as any).raw.prepare("SELECT COUNT(*) AS n FROM agent_reports WHERE agent_id='signal-analyst' AND severity='warning'").get().n;
  assert.equal(n1, 1);
  // second cycle same stale key no new stale report
  (env as any).XAUUSD_AI = fakeXauusd([item({ candle_key: key })]);
  await runSignalCycle(env as any, mem, "operator", NOW + 1000);
  const n2 = (db as any).raw.prepare("SELECT COUNT(*) AS n FROM agent_reports WHERE agent_id='signal-analyst' AND severity='warning'").get().n;
  assert.equal(n2, 1);
});

test("TP-017 unavailable", async () => {
  const binding = badFetchXauusd(new Error("boom"));
  const { env, db, mem } = kernelEnv(migratedDb(), { XAUUSD_AI: binding });
  await runSignalCycle(env as any, mem, "operator", NOW);
  const n1 = (db as any).raw.prepare("SELECT COUNT(*) AS n FROM agent_reports WHERE agent_id='signal-analyst'").get().n;
  assert.equal(n1, 1);
  // repeated within 6h no further
  (env as any).XAUUSD_AI = badFetchXauusd(new Error("boom"));
  await runSignalCycle(env as any, mem, "operator", NOW + 1000);
  const n2 = (db as any).raw.prepare("SELECT COUNT(*) AS n FROM agent_reports WHERE agent_id='signal-analyst'").get().n;
  assert.equal(n2, 1);
});

test("TP-017 no AI", async () => {
  const aiCalls: any[] = [];
  const ai = { run: async (m: any, i: any) => { aiCalls.push(1); return { response: "{}" }; } };
  const { env, mem } = kernelEnv(migratedDb(), { XAUUSD_AI: fakeXauusd([item()]), AI: ai, MEMORY: undefined });
  await runSignalCycle(env as any, mem, "operator", NOW);
  assert.equal(aiCalls.length, 0);
});

test("TP-017 schedule", async () => {
  // just check index.ts minute 22
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../../ai-kernel/src/index.ts", import.meta.url), "utf8");
  assert.match(src, /minute === 22/);
  assert.match(src, /if \(minute === 22 && env\.SIGNAL_ANALYST\)/);
});


test("withoutLevels redacts common thousands and decimal separators", () => {
  for (const value of ["4,078.50", "4 078.50", "4_078.50", "4'078.50", "4.078,50", "4\u202F078,50", "$4,078.50"]) {
    assert.equal(withoutLevels(value), "[level]", value);
  }
  assert.equal(withoutLevels("XAUUSD_4078"), "XAUUSD_[level]", "numeric levels embedded in symbol-like text are redacted");
  assert.equal(withoutLevels("XAUUSD4078"), "XAUUSD[level]", "numeric levels adjacent to letters are redacted");
});
