// 2026-11-26, 14:10 UTC: an owner's chat turn with four tool results failed. Beam's chat_answer was refused by the
// validator about 14 s in (it fell back as "unreachable", with no reason recorded), then Workers AI timed out at 30 s.
// Since "Format jawaban bebas" a why or how answer is a few paragraphs, while the answer cap stayed 2,400 characters and
// the instructions never said so. Now the cap is 4,000, the instructions state a limit under it, the validator says why it
// refused (diagnoseAnswer), and a refused Beam answer records its category (beam:<category>) in ai_failures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { migratedDb } from "./harness.ts";
import { AiEngine, ALLOWED_TEXT_MODELS, type AiTask } from "../src/ai-engine.ts";
import { ANSWER_INSTRUCTIONS, MAX_ANSWER_CHARS, diagnoseAnswer, validateAnswer, type ChatAnswer } from "../src/conversation.ts";

test("CL-1. the cap is 4,000 characters, the instructions ask for less, and a refusal says why", () => {
  assert.equal(MAX_ANSWER_CHARS, 4_000);
  assert.match(ANSWER_INSTRUCTIONS, /Keep every answer under 3500 characters\./);
  const ok = "word ".repeat(700).trim();
  assert.ok(validateAnswer({ answer: ok, citations: [] }), "3,499 characters pass");
  assert.equal(validateAnswer({ answer: "x".repeat(MAX_ANSWER_CHARS + 1), citations: [] }), null);
  assert.equal(diagnoseAnswer({ answer: "x".repeat(MAX_ANSWER_CHARS + 1), citations: [] }), "answer_too_long");
  assert.equal(diagnoseAnswer({ answer: " ", citations: [] }), "answer_missing");
  assert.equal(diagnoseAnswer({ answer: "ok", citations: "x" }), "citations_not_a_list");
  assert.equal(diagnoseAnswer({ answer: "ok", citations: Array(61).fill({ ref: "r", value: "1" }) }), "too_many_citations");
  assert.equal(diagnoseAnswer({ answer: "ok", citations: [{ ref: 1, value: "1" }] }), "citation_invalid");
});

test("CL-2. a Beam answer the validator refuses falls back to Workers AI and records beam:<category> in ai_failures", async () => {
  const db = migratedDb();
  const long = JSON.stringify({ answer: "x".repeat(MAX_ANSWER_CHARS + 10), citations: [] });
  const settled: unknown[] = [];
  const router = {
    routes: () => true,
    attempt: async () => ({ kind: "answer", completion: { choices: [{ message: { content: long } }] }, latency_ms: 14_000, settle: async (u: unknown) => { settled.push(u); } }),
    meter: async () => {},
  };
  const ai = { async run() { return { response: { answer: "A short answer.", citations: [] } }; } };
  const task: AiTask<ChatAnswer> = { name: "chat_answer", instructions: "Answer.", maxInputChars: 10_000, maxOutputTokens: 100, validate: validateAnswer, diagnose: diagnoseAnswer };
  const e = new AiEngine({ service: "cryptophys-ai-kernel", ai: ai as never, db: db as never, allowedModels: ALLOWED_TEXT_MODELS, allowedTasks: ["chat_answer"], ownBudget: async () => true, router: router as never });
  const r = await e.run(task, { q: 1 }, "cl-2");
  assert.equal(r.status, "ok");
  assert.equal(r.status === "ok" && r.provider, "workers_ai");
  assert.deepEqual(settled, [false], "a refused answer counts as a Beam failure for the breaker");
  const rows = db.raw.prepare("SELECT task, category, count FROM ai_failures ORDER BY category").all().map((x: any) => ({ ...x }));
  assert.deepEqual(rows, [{ task: "chat_answer", category: "beam:schema:answer_too_long", count: 1 }]);
});
