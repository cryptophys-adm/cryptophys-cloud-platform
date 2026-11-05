import { test } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, migratedDb } from "./harness.ts";
import { ADVISORY_LANGUAGE, violatesAdvisoryLanguage } from "../src/ai-engine.ts";
import { observe } from "../../ai-kernel/src/syscall.ts";
import { overviewTask } from "../../platform-api/src/index.ts";

test("TP-019 blocks recommendations", async () => {
  assert.equal(violatesAdvisoryLanguage("SOLUSDT is recommended for a buy"), true);
  assert.equal(violatesAdvisoryLanguage("Buy now"), true);
  assert.equal(violatesAdvisoryLanguage("you should consider entering a long"), true);
  assert.equal(violatesAdvisoryLanguage("set a stop-loss at 2300"), true);
  assert.equal(violatesAdvisoryLanguage("use 10x leverage"), true);
  assert.equal(violatesAdvisoryLanguage({ notes: ["fine", "position size 2%"] }), true);
});

test("TP-019 allows descriptions", async () => {
  assert.equal(violatesAdvisoryLanguage("XAUUSD decision is WAIT with confidence 0.3"), false);
  assert.equal(violatesAdvisoryLanguage("The audit chain is valid across 569 events"), false);
  assert.equal(violatesAdvisoryLanguage("Redeploy the Platform API to the desired version"), false);
  assert.equal(violatesAdvisoryLanguage("BTCUSDT momentum is neutral"), false);
  assert.equal(violatesAdvisoryLanguage("No action was taken"), false);
});

test("TP-019 engine rejects advisory language", async () => {
  const db = migratedDb();
  const ai = { run: async () => ({ response: { summary: "recommended for a buy" } }) };
  const env: any = baseEnv("cryptophys-policy-engine", db, { AI: ai });
  const { engineFor } = await import("../src/ai-engine.ts");
  const task: any = { name: "t", instructions: "x", maxInputChars: 1000, maxOutputTokens: 100, validate: (o: any) => o };
  const engine = engineFor(env, "cryptophys-policy-engine", [task.name]);
  const res: any = await engine.run(task, {}, "c");
  assert.equal(res.status, "invalid_output");
  assert.equal(res.reason, "schema:advisory_language");
  const row = db.raw.prepare("SELECT category, count FROM ai_failures").get() as any;
  assert.equal(row.category, "schema:advisory_language");
  assert.equal(row.count, 1);
  const usage = db.raw.prepare("SELECT failures FROM ai_usage").get() as any;
  assert.equal(usage.failures, 1);
});

test("TP-019 engine passes clean drafts", async () => {
  const db = migratedDb();
  const ai = { run: async () => ({ response: { summary: "all good" } }) };
  const env: any = baseEnv("cryptophys-policy-engine", db, { AI: ai });
  const { engineFor } = await import("../src/ai-engine.ts");
  const task: any = { name: "t", instructions: "x", maxInputChars: 1000, maxOutputTokens: 100, validate: (o: any) => o };
  const engine = engineFor(env, "cryptophys-policy-engine", [task.name]);
  const res: any = await engine.run(task, {}, "c");
  assert.equal(res.status, "ok");
});

test("TP-019 bounded walk fails closed when the scan is incomplete", async () => {
  const deep: any = {};
  let cur = deep;
  for (let i = 0; i < 7; i++) { cur.n = {}; cur = cur.n; }
  cur.s = "neutral description";
  assert.equal(violatesAdvisoryLanguage(deep), true);

  const arr = Array.from({ length: 201 }, () => "neutral description");
  assert.equal(violatesAdvisoryLanguage(arr), true);

  const uninspectable = new Proxy({}, {
    ownKeys() { throw new Error("uninspectable model output"); },
  });
  assert.equal(violatesAdvisoryLanguage(uninspectable), true);
});

test("TP-019 overview latest decision", async () => {
  const db = migratedDb();
  const b1 = { report_id: "r1", agent_id: "signal-analyst", kind: "xauusd_digest", severity: "info", subject: "s", body_json: JSON.stringify({ decision: "WAIT", confidence: 0.3, candle_key: "k1", decided_at: "d1" }), ai_status: "deterministic", created_at: "2026-11-05T10:00:00.000Z" };
  const b2 = { report_id: "r2", agent_id: "signal-analyst", kind: "xauusd_digest", severity: "info", subject: "s", body_json: JSON.stringify({ decision: "BUY", confidence: 0.5, candle_key: "k2", decided_at: "d2" }), ai_status: "deterministic", created_at: "2026-11-05T11:00:00.000Z" };
  const b3 = { report_id: "r3", agent_id: "signal-analyst", kind: "xauusd_digest", severity: "warning", subject: "s", body_json: JSON.stringify({}), ai_status: "deterministic", created_at: "2026-11-05T12:00:00.000Z" };
  for (const b of [b1, b2, b3]) {
    db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(b.report_id, b.agent_id, b.kind, b.severity, b.subject, b.body_json, b.ai_status, b.created_at);
  }
  const env: any = baseEnv("cryptophys-ai-kernel", db);
  const r: any = await observe(env, Date.now());
  assert.deepEqual(Object.keys(r.xauusd_latest).sort(), ["candle_key", "confidence", "decided_at", "decision", "report_id", "reported_at"]);
  assert.equal(r.xauusd_latest.decision, "BUY");
  assert.equal(JSON.stringify(r.xauusd_latest).includes("reasoning"), false);
});

test("TP-019 overview none and fail-safe", async () => {
  const db = migratedDb();
  const env: any = baseEnv("cryptophys-ai-kernel", db);
  const r: any = await observe(env, Date.now());
  assert.equal(r.xauusd_latest, null);

  const wrapped: any = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (sql.includes("xauusd_digest")) throw new Error("boom");
          return target.prepare(sql);
        };
      }
      return (target as any)[prop];
    },
  });
  const env2: any = baseEnv("cryptophys-ai-kernel", wrapped);
  const r2: any = await observe(env2, Date.now());
  assert.deepEqual(r2.xauusd_latest, { error: "xauusd_latest_unavailable" });
  assert.ok(Array.isArray(r2.services));
  assert.ok(r2.agent_reports_24h);
});

test("TP-019 prompt", async () => {
  assert.match(overviewTask.instructions, /latest XAUUSD advisory decision/);
  assert.equal(overviewTask.instructions.includes("signal ingestion"), false);
});

test("TP-019 regex exact", async () => {
  assert.equal(ADVISORY_LANGUAGE.length, 3);
});
