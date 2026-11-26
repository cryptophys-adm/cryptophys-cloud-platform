// Review 2026-11-26 (after the 14:10 UTC chat turn: Beam fell back after 14 s, then Workers AI timed out at 30 s): for
// chat_answer only, when Beam was called in this run and failed (unreachable, or cut at its output budget), the Workers AI
// fallback gets the tool results trimmed to FALLBACK_TOOL_RESULTS_CHARS, whole results in the plan's order. The first
// attempt's input is unchanged, a skipped Beam (off, rate, breaker…) changes nothing, and the answer is never partial.
import { test } from "node:test";
import assert from "node:assert/strict";
import { migratedDb } from "./harness.ts";
import { AiEngine, ALLOWED_TEXT_MODELS, type AiTask } from "../src/ai-engine.ts";
import { ANSWER_INSTRUCTIONS, FALLBACK_TOOL_RESULTS_CHARS, trimToolResults, validateAnswer, type ChatAnswer } from "../src/conversation.ts";

const result = (tool: string, kb: number) => ({ tool, ok: true, error: null, refs: [`ev:platform/${tool}@2026-11-26T14:10:18.812Z`], data_json: JSON.stringify({ x: "y".repeat(kb * 1000) }) });
const INPUT = { question: "What is the state?", history: [], context: { today_utc: "2026-11-26" }, tool_results: [result("owner_inbox", 9), result("agents", 9), result("metabolism", 9), result("mesh", 9)], plan_status: "ok" };

test("FT-1. trimToolResults keeps whole results in order within the budget; the rest stay listed with their refs, without data", () => {
  assert.equal(FALLBACK_TOOL_RESULTS_CHARS, 24_000);
  const t = trimToolResults(INPUT) as Omit<typeof INPUT, "tool_results"> & { tool_results: any[] };
  assert.deepEqual(t.tool_results.map((r) => [r.tool, r.data_json === null ? "omitted" : "kept"]), [["owner_inbox", "kept"], ["agents", "kept"], ["metabolism", "omitted"], ["mesh", "omitted"]]);
  assert.ok(JSON.stringify(t.tool_results.filter((r) => r.data_json !== null)).length <= FALLBACK_TOOL_RESULTS_CHARS);
  for (const r of t.tool_results.slice(2)) { assert.equal(r.omitted, "budget"); assert.deepEqual(r.refs, [`ev:platform/${r.tool}@2026-11-26T14:10:18.812Z`]); }
  assert.deepEqual({ ...t, tool_results: null }, { ...INPUT, tool_results: null }, "everything else is unchanged");
  assert.equal(INPUT.tool_results[2].data_json.length > 0, true, "the input itself is not changed");
  const small = { ...INPUT, tool_results: [result("a", 1), result("b", 1)] };
  assert.deepEqual(trimToolResults(small), small, "results that fit are all kept");
  assert.equal(trimToolResults(null), null);
  assert.match(ANSWER_INSTRUCTIONS, /A tool result marked omitted was not given to you this time: say it was not read; never guess what it holds\./);
});

function engineWith(beam: () => unknown) {
  const db = migratedDb();
  const beamInputs: string[] = [], waiInputs: string[] = [];
  const router = { routes: () => true, attempt: async (_t: string, m: { content: string }[]) => { beamInputs.push(m[1].content); return beam(); }, meter: async () => {} };
  const ai = { async run(_m: string, i: any) { waiInputs.push(String(i.messages[1].content)); return { response: { answer: "Owner inbox and agents were read; metabolism and mesh were not read this time.", citations: [] } }; } };
  const e = new AiEngine({ service: "cryptophys-ai-kernel", ai: ai as never, db: db as never, allowedModels: ALLOWED_TEXT_MODELS, allowedTasks: ["chat_answer"], ownBudget: async () => true, router: router as never });
  return { e, beamInputs, waiInputs };
}
const TASK: AiTask<ChatAnswer> = { name: "chat_answer", instructions: "Answer.", maxInputChars: 96_000, maxOutputTokens: 100, validate: validateAnswer, fallbackInput: trimToolResults };
const answer = (content: string, finish = "stop") => ({ kind: "answer", completion: { choices: [{ message: { content }, finish_reason: finish }] }, latency_ms: 1000, settle: async () => {} });
const full = JSON.stringify(INPUT);

test("FT-2. Beam answers: its input is the whole input and Workers AI is not called", async () => {
  const x = engineWith(() => answer(JSON.stringify({ answer: "All four were read.", citations: [] })));
  const r = await x.e.run(TASK, INPUT, "ft-2");
  assert.equal(r.status, "ok");
  assert.equal(r.status === "ok" && r.provider, "reflection");
  assert.deepEqual(x.beamInputs, [full], "the first attempt's input is unchanged");
  assert.deepEqual(x.waiInputs, []);
});

test("FT-3. Beam fails (a refused answer, or cut at its budget): the fallback gets the trimmed input and answers whole", async () => {
  for (const beam of [() => answer(JSON.stringify({ answer: "x".repeat(5000), citations: [] })), () => answer("{\"answer\": \"cut", "length")]) {
    const x = engineWith(beam);
    const r = await x.e.run(TASK, INPUT, "ft-3");
    assert.equal(r.status, "ok");
    assert.equal(r.status === "ok" && r.provider, "workers_ai");
    assert.deepEqual(x.beamInputs, [full]);
    assert.equal(x.waiInputs.length, 1);
    assert.equal(x.waiInputs[0], JSON.stringify(trimToolResults(INPUT)));
    assert.ok(x.waiInputs[0].length < full.length - 15_000, `fallback input ${x.waiInputs[0].length} vs ${full.length}`);
    assert.equal(r.status === "ok" && r.data.answer, "Owner inbox and agents were read; metabolism and mesh were not read this time.");
  }
});

test("FT-4. Beam skipped (off, rate, breaker, disabled…) or a task without fallbackInput: Workers AI gets the whole input", async () => {
  for (const reason of ["off", "rate", "breaker", "disabled", "budget"]) {
    const x = engineWith(() => ({ kind: "skip", reason }));
    await x.e.run(TASK, INPUT, `ft-4-${reason}`);
    assert.deepEqual(x.waiInputs, [full], reason);
  }
  const x = engineWith(() => answer("not json"));
  const { fallbackInput: _f, ...plain } = TASK;
  await x.e.run(plain as AiTask<ChatAnswer>, INPUT, "ft-4-plain");
  assert.deepEqual(x.waiInputs, [full], "only a task that asks for it is trimmed");
});
