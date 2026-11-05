import { test } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, fakeAi, migratedDb } from "./harness.ts";
import { engineFor, AiEngine, type AiTask, extractJsonObject } from "../src/ai-engine.ts";
import { REQUIRED_MIGRATION, schemaReady } from "../src/readiness.ts";

function makeEngine(db: any, ai: any, tasks: readonly string[], timeoutMs = 8000) {
  const env: any = baseEnv("cryptophys-policy-engine", db, { AI: ai });
  return engineFor(env, "cryptophys-policy-engine", tasks, ["@cf/meta/llama-3.1-8b-instruct-fast"]);
  // override timeout via constructor not exposed; use default 8000
}

test("TP-016 migration", async () => {
  const db = migratedDb();
  assert.equal(REQUIRED_MIGRATION, "0019_ai_failures.sql");
  assert.equal(await schemaReady({ DB: db } as never), true);
  const row = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_failures'").get();
  assert.ok(row);
});

test("TP-016 object response", async () => {
  const db = migratedDb();
  const ai = fakeAi({ response: { ok: true } });
  const task: AiTask<any> = { name: "simple", instructions: "x", maxInputChars: 1000, maxOutputTokens: 100, validate: (o) => o };
  const engine = engineFor(baseEnv("cryptophys-policy-engine", db, { AI: ai }) as any, "cryptophys-policy-engine", [task.name]);
  const res = await engine.run(task, { a: 1 }, "c1");
  assert.equal(res.status, "ok");
  const rows = db.raw.prepare("SELECT COUNT(*) AS n FROM ai_failures").get() as any;
  assert.equal(rows.n, 0);
});

test("TP-016 truncated", async () => {
  const db = migratedDb();
  const ai = fakeAi({ response: '{"headline": "x", "summary": "abc' });
  const task: AiTask<any> = { name: "simple", instructions: "x", maxInputChars: 1000, maxOutputTokens: 100, validate: () => null };
  const engine = engineFor(baseEnv("cryptophys-policy-engine", db, { AI: ai }) as any, "cryptophys-policy-engine", [task.name]);
  const res: any = await engine.run(task, { a: 1 }, "c2");
  assert.equal(res.status, "invalid_output");
  assert.equal(res.reason, "truncated");
  const row = db.raw.prepare("SELECT category, count FROM ai_failures").get() as any;
  assert.equal(row.category, "truncated");
  assert.equal(row.count, 1);
});

test("TP-016 other text categories", async () => {
  // empty
  const db1 = migratedDb();
  const ai1 = fakeAi({ response: "" });
  const task: AiTask<any> = { name: "simple", instructions: "x", maxInputChars: 1000, maxOutputTokens: 100, validate: () => null };
  const e1 = engineFor(baseEnv("cryptophys-policy-engine", db1, { AI: ai1 }) as any, "cryptophys-policy-engine", [task.name]);
  const r1: any = await e1.run(task, { a: 1 }, "c");
  assert.equal(r1.reason, "empty_response");

  // no json
  const db2 = migratedDb();
  const ai2 = fakeAi({ response: "no json here" });
  const e2 = engineFor(baseEnv("cryptophys-policy-engine", db2, { AI: ai2 }) as any, "cryptophys-policy-engine", [task.name]);
  const r2: any = await e2.run(task, { a: 1 }, "c");
  assert.equal(r2.reason, "no_json_object");

  // json parse error
  const db3 = migratedDb();
  const ai3 = fakeAi({ response: "{bad json}" });
  const e3 = engineFor(baseEnv("cryptophys-policy-engine", db3, { AI: ai3 }) as any, "cryptophys-policy-engine", [task.name]);
  const r3: any = await e3.run(task, { a: 1 }, "c");
  assert.equal(r3.reason, "json_parse_error");
});

test("TP-016 schema with diagnose", async () => {
  const db = migratedDb();
  const task: AiTask<any> = {
    name: "simple", instructions: "x", maxInputChars: 1000, maxOutputTokens: 100,
    validate: (o: any) => (o && o.ok === true ? o : null),
    diagnose: (o: any) => (o && o.ok === true ? "unknown" : "headline_invalid"),
  };
  const ai1 = fakeAi({ response: { ok: false } });
  const e1 = engineFor(baseEnv("cryptophys-policy-engine", db, { AI: ai1 }) as any, "cryptophys-policy-engine", [task.name]);
  const r1: any = await e1.run(task, {}, "c");
  assert.equal(r1.status, "invalid_output");
  assert.equal(r1.reason, "schema:headline_invalid");
});

test("TP-016 schema without diagnose", async () => {
  const db = migratedDb();
  const ai = fakeAi({ response: { foo: "bar" } });
  const task: AiTask<any> = { name: "simple", instructions: "x", maxInputChars: 1000, maxOutputTokens: 100, validate: () => null };
  const e = engineFor(baseEnv("cryptophys-policy-engine", db, { AI: ai }) as any, "cryptophys-policy-engine", [task.name]);
  const r: any = await e.run(task, { a: 1 }, "c");
  assert.equal(r.reason, "schema_rejected");
});

test("TP-016 timeout and throw", async () => {
  // timeout
  const db1 = migratedDb();
  const ai1 = fakeAi({ response: "{}" });
  ai1.delayMs = 100;
  const task: AiTask<any> = { name: "simple", instructions: "x", maxInputChars: 1000, maxOutputTokens: 100, validate: () => null };
  const e1 = new AiEngine({ service: "cryptophys-policy-engine", ai: ai1, db: db1, allowedModels: ["@cf/meta/llama-3.1-8b-instruct-fast"], allowedTasks: [task.name], timeoutMs: 10 });
  const r1: any = await e1.run(task, { a: 1 }, "c");
  assert.equal(r1.status, "unavailable");
  assert.equal(r1.reason, "timeout");
  const cat1 = db1.raw.prepare("SELECT category FROM ai_failures").get() as any;
  assert.equal(cat1.category, "timeout");

  // throw
  const db2 = migratedDb();
  const ai2 = fakeAi({ response: "{}" });
  ai2.fail = new Error("boom");
  const e2 = engineFor(baseEnv("cryptophys-policy-engine", db2, { AI: ai2 }) as any, "cryptophys-policy-engine", [task.name]);
  const r2: any = await e2.run(task, { a: 1 }, "c");
  assert.equal(r2.status, "unavailable");
  assert.equal(r2.reason, "inference_failed");
  const cat2 = db2.raw.prepare("SELECT category FROM ai_failures").get() as any;
  assert.equal(cat2.category, "inference_failed");
});

test("TP-016 count aggregates", async () => {
  const db = migratedDb();
  const ai = fakeAi({ response: '{"headline": "x", "summary": "abc' });
  const task: AiTask<any> = { name: "simple", instructions: "x", maxInputChars: 1000, maxOutputTokens: 100, validate: () => null };
  const e = engineFor(baseEnv("cryptophys-policy-engine", db, { AI: ai }) as any, "cryptophys-policy-engine", [task.name]);
  await e.run(task, { a: 1 }, "c1");
  await e.run(task, { a: 1 }, "c2");
  const row = db.raw.prepare("SELECT count FROM ai_failures").get() as any;
  assert.equal(row.count, 2);
  const usage = db.raw.prepare("SELECT failures FROM ai_usage").get() as any;
  assert.equal(usage.failures, 2);
});

test("TP-016 no content stored", async () => {
  const db = migratedDb();
  const ai = fakeAi({ response: '{"x":"SECRET_MARKER"}' });
  const task: AiTask<any> = { name: "simple", instructions: "x", maxInputChars: 1000, maxOutputTokens: 100, validate: () => null };
  const e = engineFor(baseEnv("cryptophys-policy-engine", db, { AI: ai }) as any, "cryptophys-policy-engine", [task.name]);
  await e.run(task, { a: 1 }, "c");
  const rows = db.raw.prepare("SELECT * FROM ai_failures").all() as any[];
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      assert.equal(String(r[k]).includes("SECRET_MARKER"), false);
    }
  }
  // diagnose slug no symbol name
  const db2 = migratedDb();
  const ai2 = fakeAi({ response: { ok: false } });
  const task2: AiTask<any> = { name: "simple", instructions: "x", maxInputChars: 1000, maxOutputTokens: 100, validate: () => null, diagnose: () => "headline_invalid" };
  const e2 = engineFor(baseEnv("cryptophys-policy-engine", db2, { AI: ai2 }) as any, "cryptophys-policy-engine", [task2.name]);
  await e2.run(task2, {}, "c");
  const row = db2.raw.prepare("SELECT category FROM ai_failures").get() as any;
  assert.equal(row.category.includes("BTCUSDT"), false);
});

test("TP-016 telemetry never breaks caller", async () => {
  const db = migratedDb();
  const wrapped: any = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (sql.includes("ai_failures")) throw new Error("boom");
          return target.prepare(sql);
        };
      }
      return (target as any)[prop];
    },
  });
  const ai = fakeAi({ response: '{"headline": "x", "summary": "abc' });
  const task: AiTask<any> = { name: "simple", instructions: "x", maxInputChars: 1000, maxOutputTokens: 100, validate: () => null };
  const e = engineFor(baseEnv("cryptophys-policy-engine", wrapped, { AI: ai }) as any, "cryptophys-policy-engine", [task.name]);
  const r: any = await e.run(task, { a: 1 }, "c");
  assert.equal(r.status, "invalid_output");
  assert.equal(r.reason, "truncated");
});

test("TP-016 extractJsonObject keeps behaviour", async () => {
  assert.deepEqual(extractJsonObject('prefix {"a":1} suffix'), { a: 1 });
  assert.equal(extractJsonObject("no json"), null);
});
