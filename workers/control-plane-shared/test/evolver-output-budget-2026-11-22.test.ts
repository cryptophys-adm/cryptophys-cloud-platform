// 2026-11-22: both evolutions so far (18 and 20 Nov) were refused at the plan step (no_json_object, json_parse_error).
// EVOLVER_MODEL reasons before it answers and the reasoning is billed out of max_tokens: a 31 000-character plan input
// at 1500 tokens stopped at the limit with no content; at 6000 it answered in 897. This test holds the budgets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EVOLVER_OUTPUT_TOKENS, planTask, writeTask } from "../../ai-kernel/src/evolver.ts";

const ROOT = new URL("../../../", import.meta.url);

test("EB1. the evolver's plan and write leave room to think, and the timeout fits the write", () => {
  assert.ok(EVOLVER_OUTPUT_TOKENS.plan >= 6_000 && EVOLVER_OUTPUT_TOKENS.write >= 16_000);
  assert.equal(planTask(new Set()).maxOutputTokens, EVOLVER_OUTPUT_TOKENS.plan);
  assert.equal(writeTask().maxOutputTokens, EVOLVER_OUTPUT_TOKENS.write);
  const src = readFileSync(new URL("workers/ai-kernel/src/evolver.ts", ROOT), "utf8");
  assert.match(src, /^const AI_TIMEOUT_MS = 180_000;$/m);
});
