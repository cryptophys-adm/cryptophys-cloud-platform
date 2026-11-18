// HAIC H2b (ADR-0017 H2; owner answer of 2026-11-18): the owner's chat directive becomes a typed_proposal.v1 DRAFT
// through one model call on the chat's budget; the draft passes the same rules as any (typed-proposal.ts) and is
// confirmed on its page. Not a proposal, a secret, the chat off or its budget used: nothing is drafted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { DIRECTIVE_TASKS, KPI_IDS, draftFromDirective } from "../../ai-kernel/src/directives.ts";
import { readTypedProposal } from "../../ai-kernel/src/proposals.ts";
import { CHAT_MODEL } from "../src/conversation.ts";

const NOW = Date.parse("2026-11-18T12:40:00.000Z");
function setup(response: unknown, o: { enabled?: string; limit?: string } = {}) {
  const db = migratedDb();
  if (o.enabled) db.raw.prepare("UPDATE conversation_controls SET value = ? WHERE control = 'enabled'").run(o.enabled);
  const calls: any[] = [];
  const ai = { async run(model: string, params: any) { calls.push({ model, params }); return { response, usage: { prompt_tokens: 900, completion_tokens: 120 } }; } };
  const env: any = { ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }), AI: ai, CHAT_DAILY_TURN_LIMIT: o.limit };
  const events = (type: string) => (db.raw.prepare("SELECT outcome, payload_json FROM audit_events WHERE event_type = ? ORDER BY rowid").all(type) as any[]).map((e) => ({ outcome: e.outcome, ...JSON.parse(e.payload_json) }));
  return { db, env, calls, events };
}

test("D1. a directive becomes a draft: one model call on the chat's model with the parameters and the KPI ids, validated, audited by hash", async () => {
  const s = setup({ kind: "policy_parameter", title: "Raise the daily deploy limit to 12", rationale: "Deploys stall at the limit on busy days.", target: "daily-deploy-limit", params: { value: 12 }, measurement: null, reason: null });
  const made = await draftFromDirective(s.env, APPROVER_EMAIL, "naikkan batas deploy harian ke 12", "cnv_0123456789abcdef", NOW);
  assert.equal(made.kind, "policy_parameter");
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].model, CHAT_MODEL);
  const input = JSON.parse(s.calls[0].params.messages[1].content);
  assert.deepEqual(input.kpi_ids, KPI_IDS);
  assert.ok(KPI_IDS.includes("decision_hit_rate_15m"));
  assert.deepEqual(input.policy_parameters.map((p: any) => p.name), ["daily-deploy-limit", "target-actions-per-hour", "infra-budget-usd-month"]);
  const p = await readTypedProposal(s.db as never, made.proposal_id) as any;
  assert.deepEqual([p.state, p.origin_source, p.body.origin.ref.startsWith("cnv_0123456789abcdef#directive:"), p.body.params, p.body.requires], ["draft", "chat", true, { value: 12 }, ["owner_confirm", "owner_click_to_promote"]]);
  const drafted = s.events("proposal.directive_drafted");
  assert.equal(drafted.length, 1);
  assert.match(drafted[0].text_sha256, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(drafted).includes("naikkan"), "the directive's text is audited by hash only");
  assert.deepEqual(DIRECTIVE_TASKS, ["directive_draft"]);
});

test("D2. nothing is drafted for a non-proposal, an out-of-bounds value, an unknown KPI, a secret, the chat off or its budget used", async () => {
  const none = setup({ kind: null, title: "", rationale: "", target: null, params: {}, measurement: null, reason: "a question, not a directive" });
  await assert.rejects(draftFromDirective(none.env, APPROVER_EMAIL, "what needs me?", null, NOW), (e: any) => e.code === "not_a_proposal" && /a question/.test(e.message));
  const out = setup({ kind: "policy_parameter", title: "t", rationale: "r", target: "daily-deploy-limit", params: { value: 400 }, measurement: null, reason: null });
  await assert.rejects(draftFromDirective(out.env, APPROVER_EMAIL, "limit 400", null, NOW), (e: any) => e.code === "invalid_proposal" && e.errors.some((x: string) => x.startsWith("params.value")));
  const kpi = setup({ kind: "vision_kpi", title: "t", rationale: "r", target: "made_up_kpi", params: { to: 1 }, measurement: null, reason: null });
  await assert.rejects(draftFromDirective(kpi.env, APPROVER_EMAIL, "KPI", null, NOW), (e: any) => e.code === "invalid_proposal");
  const arm = setup({ kind: "repository_task", title: "Arm trading", rationale: "r", target: "platform", params: { spec: "give the evolver the trading capability tier_max 3" }, measurement: null, reason: null });
  await assert.rejects(draftFromDirective(arm.env, APPROVER_EMAIL, "arm", null, NOW), (e: any) => e.code === "invalid_proposal" && e.errors.includes("widens_autonomy"));
  const secret = setup({ kind: null });
  await assert.rejects(draftFromDirective(secret.env, APPROVER_EMAIL, "use token Bearer abcdefghijklmnopqrstuvwxyz0123456789", null, NOW), (e: any) => e.code === "secret_refused");
  assert.equal(secret.calls.length, 0, "a secret is never sent to the model");
  const off = setup({ kind: null }, { enabled: "0" });
  await assert.rejects(draftFromDirective(off.env, APPROVER_EMAIL, "x", null, NOW), (e: any) => e.code === "conversation_disabled");
  const budget = setup({ kind: "policy_parameter", title: "t", rationale: "r", target: "daily-deploy-limit", params: { value: 12 }, measurement: null, reason: null }, { limit: "1" });
  await draftFromDirective(budget.env, APPROVER_EMAIL, "limit 12", null, NOW);
  await assert.rejects(draftFromDirective(budget.env, APPROVER_EMAIL, "limit 13", null, NOW), (e: any) => e.code === "daily_budget_used", "one directive is one chat turn");
});

test("D3. the route: only the owner drafts; the draft is 201 and waits for CONFIRM; the DNA declares the task", async () => {
  const s = setup({ kind: "repository_task", title: "Retry deploys after a migration lock", rationale: "Deploys collide with the lock.", target: "platform", params: { spec: "Retry a native deploy once after a migration lock." }, measurement: null, reason: null });
  assert.equal((await call(kernel, s.env, req("POST", "/v1/proposals", { directive: "retry deploys" }, OPERATOR_JWT))).status, 403);
  const r = await call(kernel, s.env, req("POST", "/v1/proposals", { directive: "retry deploys after a migration lock" }, APPROVER_JWT));
  assert.deepEqual([r.status, r.body.state, r.body.kind, r.body.body.target], [201, "draft", "repository_task", "platform"]);
  const dna = JSON.parse(readFileSync(new URL("../../ai-kernel/organism.json", import.meta.url), "utf8"));
  assert.ok(dna.engines.some((e: any) => e.task === "directive_draft"));
  const src = readFileSync(new URL("../../ai-kernel/src/directives.ts", import.meta.url), "utf8");
  for (const imp of src.matchAll(/^import [\s\S]*? from "([^"]+)";/gm)) assert.doesNotMatch(imp[1], /consensus|syscall|executor|recovery|deploy|merge|forge|evolution/, imp[1]);
  assert.doesNotMatch(src, /consensus\.propose|\.syscall\(|\.dispatch\(|decideProposal/, "a directive only drafts; the owner confirms");
});
