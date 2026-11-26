// Review 2026-11-26: two chat fallbacks in 90 minutes, a chat_answer (14:10 UTC) and a chat_plan (15:38 UTC), both
// "unreachable" after 14–15 s. A refused Beam answer records beam:schema:<slug> since a00b2a7; diagnosePlan gives
// chat_plan the same, so a refused plan is told apart from a transport failure (no beam:schema row).
import { test } from "node:test";
import assert from "node:assert/strict";
import { migratedDb } from "./harness.ts";
import { AiEngine, ALLOWED_TEXT_MODELS, type AiTask } from "../src/ai-engine.ts";
import { diagnosePlan, validatePlan, type ChatPlan } from "../src/conversation.ts";

test("DP-1. every way validatePlan refuses a plan has its slug; a valid plan is not diagnosed as missing", () => {
  const cases: Array<[unknown, string]> = [
    [{}, "plan_missing"], [{ tools: "x" }, "plan_missing"],
    [{ tools: [{ name: "agents" }, { name: "mesh" }, { name: "vision" }, { name: "census" }, { name: "metabolism" }] }, "too_many_calls"],
    [{ tools: [{ name: "wake_agent" }] }, "unknown_tool"],
    [{ tools: [{ name: "reports", args: [1] }] }, "bad_args"],
    [{ tools: [{ name: "reports", args: { system: "x" } }] }, "unknown_argument"],
    [{ tools: [{ name: "reports", args: { limit: 99 } }] }, "bad_argument"],
    [{ tools: [{ name: "reports", args: { agent_id: 7 } }] }, "bad_argument"],
    [{ tools: [{ name: "policy_dry_run", args: { action: "deploy" } }] }, "missing_required"],
  ];
  for (const [plan, slug] of cases) {
    assert.equal(validatePlan(plan), null, JSON.stringify(plan));
    assert.equal(diagnosePlan(plan), slug, JSON.stringify(plan));
  }
  assert.ok(validatePlan({ tools: [{ name: "reports", args: { limit: 5, severity: "warning" } }] }));
});

test("DP-2. a Beam plan the validator refuses falls back to Workers AI and records beam:schema:<slug>", async () => {
  const db = migratedDb();
  const router = {
    routes: () => true,
    attempt: async () => ({ kind: "answer", completion: { choices: [{ message: { content: JSON.stringify({ tools: [{ name: "agents" }, { name: "mesh" }, { name: "vision" }, { name: "census" }, { name: "metabolism" }] }) } }] }, latency_ms: 14_000, settle: async () => {} }),
    meter: async () => {},
  };
  const ai = { async run() { return { response: { tools: [{ name: "agents" }] } }; } };
  const task: AiTask<ChatPlan> = { name: "chat_plan", instructions: "You plan.", maxInputChars: 24_000, maxOutputTokens: 600, validate: validatePlan, diagnose: diagnosePlan };
  const e = new AiEngine({ service: "cryptophys-ai-kernel", ai: ai as never, db: db as never, allowedModels: ALLOWED_TEXT_MODELS, allowedTasks: ["chat_plan"], ownBudget: async () => true, router: router as never });
  const r = await e.run(task, { q: 1 }, "dp-2");
  assert.equal(r.status === "ok" && r.provider, "workers_ai");
  assert.deepEqual(db.raw.prepare("SELECT task, category, count FROM ai_failures").all().map((x: any) => ({ ...x })), [{ task: "chat_plan", category: "beam:schema:too_many_calls", count: 1 }]);
});
