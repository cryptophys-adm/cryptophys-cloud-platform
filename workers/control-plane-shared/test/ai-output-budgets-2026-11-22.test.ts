// 2026-11-22: every council of 19 and 21 Nov aborted as too_few_positions. Each persona's position call on
// CHAT_MODEL (a reasoning model, whose thinking is billed out of max_tokens) came back empty or cut off
// (ai_failures: 12 empty_response, 2 truncated, 1 json_parse_error), so every persona abstained. These tests hold
// the output budgets of the CHAT_MODEL tasks and the engine's output_budget_exhausted category.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { baseEnv, fakeAi, migratedDb } from "./harness.ts";
import { engineFor, finishReasonOf, type AiTask } from "../src/ai-engine.ts";
import { COUNCIL_AI_TIMEOUT_MS, COUNCIL_OUTPUT_TOKENS } from "../../ai-kernel/src/council.ts";
import { COUNCIL_LIMITS } from "../src/council.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const task: AiTask<any> = { name: "simple", instructions: "x", maxInputChars: 1000, maxOutputTokens: 100, validate: (o) => o };
const run = async (reply: unknown) => {
  const db = migratedDb();
  const engine = engineFor(baseEnv("cryptophys-policy-engine", db, { AI: fakeAi(reply) }) as any, "cryptophys-policy-engine", [task.name]);
  const r: any = await engine.run(task, { a: 1 }, "c");
  const row = db.raw.prepare("SELECT category, count FROM ai_failures").get() as any;
  return { r, row };
};

test("AB1. a reply cut at the token limit is output_budget_exhausted, not a bad answer", async () => {
  const empty = await run({ choices: [{ message: { content: null, reasoning_content: "thinking..." }, finish_reason: "length" }] });
  assert.deepEqual([empty.r.status, empty.r.reason, empty.row.category], ["invalid_output", "output_budget_exhausted", "output_budget_exhausted"]);
  const cut = await run({ choices: [{ message: { content: '{"stance":"support","text":"ab' }, finish_reason: "length" }] });
  assert.equal(cut.r.reason, "output_budget_exhausted");
  // The model stopped on its own: the categories of TP-016 are unchanged.
  assert.equal((await run({ choices: [{ message: { content: "" }, finish_reason: "stop" }] })).r.reason, "empty_response");
  assert.equal((await run({ response: '{"a": "x' })).r.reason, "truncated");
  // A complete answer at the limit is still an answer.
  assert.equal((await run({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "length" }] })).r.status, "ok");
});

test("AB2. finishReasonOf reads the OpenAI-style and the top-level field, else null", () => {
  assert.equal(finishReasonOf({ choices: [{ finish_reason: "length" }] }), "length");
  assert.equal(finishReasonOf({ finish_reason: "stop" }), "stop");
  assert.equal(finishReasonOf({ response: "x" }), null);
  assert.equal(finishReasonOf(null), null);
});

test("AB3. the CHAT_MODEL tasks leave room to think; the council's own budget still bounds the spend", () => {
  assert.ok(COUNCIL_OUTPUT_TOKENS.position >= 3_000 && COUNCIL_OUTPUT_TOKENS.rebuttal >= 3_000 && COUNCIL_OUTPUT_TOKENS.synthesis >= 5_000);
  assert.ok(COUNCIL_AI_TIMEOUT_MS >= 90_000);
  const council = read("workers/ai-kernel/src/council.ts");
  for (const t of ["position", "rebuttal", "synthesis"]) assert.match(council, new RegExp(`maxOutputTokens: COUNCIL_OUTPUT_TOKENS\\.${t},`), t);
  assert.match(council, /timeoutMs: COUNCIL_AI_TIMEOUT_MS,/);
  assert.doesNotMatch(council, /maxOutputTokens: (900|700|2_000),/, "no task is back on the old budgets");
  assert.match(read("workers/ai-kernel/src/directives.ts"), /name: "directive_draft",[^\n]*maxOutputTokens: 3_000,/);
  // The spend: the session's budget is checked before every call, so one call is the most it can overshoot, and one
  // call at the largest input and output (CHAT_MODEL prices, ~4 characters per token) is a small part of max_usd.
  assert.match(council, /ownBudget: async \(\) => s\.spent\.calls < s\.budget\.max_calls && s\.spent\.usd_est < s\.budget\.max_usd/);
  const oneCall = (90_000 / 4) * (0.30 / 1e6) + COUNCIL_OUTPUT_TOKENS.synthesis * (1.20 / 1e6);
  assert.ok(oneCall <= COUNCIL_LIMITS.max_usd / 5, `${oneCall} <= ${COUNCIL_LIMITS.max_usd / 5}`);
});
