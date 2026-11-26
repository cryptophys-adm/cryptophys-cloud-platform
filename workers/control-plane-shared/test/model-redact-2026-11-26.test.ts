// Review 2026-11-26 (chat flex, item c): Beam is an outside provider, so no person's email may leave the platform in a
// model's input. redactForModel (model-redact.ts) runs in the AI engine over every task's input, after redact() and
// before any model call, Beam and Workers AI alike: an owner's email becomes "the owner", any other "an operator".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, migratedDb } from "./harness.ts";
import { runTool } from "../../ai-kernel/src/conversation-tools.ts";
import { runTurn, type ConversationStore } from "../../ai-kernel/src/conversation.ts";
import { AiEngine, ALLOWED_TEXT_MODELS, engineFor, type AiTask } from "../src/ai-engine.ts";
import { CHAT_TOOLS, toolText } from "../src/conversation.ts";
import { EMAIL_PATTERN, OPERATOR_WORD, OWNER_WORD, ownersOf, redactEmails, redactForModel } from "../src/model-redact.ts";
import { criticalPathReason } from "../src/guard-paths.ts";

const NOW = Date.parse("2026-11-26T11:00:00.000Z");
const OWNER = APPROVER_EMAIL;
const OTHER = "someone.else+ops@example.co.uk";
const hasEmail = (s: string) => new RegExp(EMAIL_PATTERN.source).test(s);
const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

test("MR-1. emails become role words; refs, Client IDs and every other value stay as they are", () => {
  const owners = ownersOf(` ${OWNER.toUpperCase()} , not-an-email, ${CI_CLIENT_ID}`);
  assert.deepEqual([...owners], [OWNER.toLowerCase()], "only emails count as owners");
  assert.equal(redactEmails(`approved by ${OWNER} and ${OTHER}.`, owners), `approved by ${OWNER_WORD} and ${OPERATOR_WORD}.`);
  assert.equal(redactEmails(`${OWNER.toUpperCase()}`, owners), OWNER_WORD, "case does not matter");
  assert.equal(redactEmails(OWNER), OPERATOR_WORD, "without the owner list every email is an operator");
  for (const keep of ["ev:platform/owner_inbox@2026-11-26T11:00:00.000Z", "ev:platform/consensus/cns_1@2026-11-26T10:00:00Z", CI_CLIENT_ID, "@cf/google/gemma-4-26b-a4b-it", "user@localhost", "a@b"]) {
    assert.equal(redactEmails(keep, owners), keep, keep);
  }
  const v = { actor: OWNER, updated_by: OTHER, requested_by: OPERATOR_EMAIL, approved_by: OWNER, n: 3, ok: true, none: null,
    nested: [{ votes: [{ voter: OTHER, note: `ask ${OWNER}` }] }], [OTHER]: "a key", client: CI_CLIENT_ID };
  const out = redactForModel(v, owners) as Record<string, any>;
  assert.deepEqual(out, { actor: OWNER_WORD, updated_by: OPERATOR_WORD, requested_by: OPERATOR_WORD, approved_by: OWNER_WORD, n: 3, ok: true, none: null,
    nested: [{ votes: [{ voter: OPERATOR_WORD, note: `ask ${OWNER_WORD}` }] }], [OPERATOR_WORD]: "a key", client: CI_CLIENT_ID });
  assert.equal(v.actor, OWNER, "the input is not changed");
});

test("MR-2. every chat tool's result, with its actor fields, reaches the model without an email (Workers AI and Beam alike)", async () => {
  const db = migratedDb();
  const env: any = { ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${OWNER}`, APPROVER_IDENTITIES: OWNER }) };
  try { db.raw.prepare("UPDATE model_router_state SET updated_by = ?").run(OWNER); } catch { /* no router table on this base */ }
  const fixtures: Record<string, unknown> = {};
  for (const t of CHAT_TOOLS) {
    const args = t.name === "policy_dry_run" ? { action: "deploy", resource: "cryptophys-console", subject: OWNER } : {};
    const r = await runTool(env, { name: t.name, args }, NOW);
    // The tool's own result plus the actor fields a real row carries, so every tool is checked with emails in it.
    fixtures[t.name] = { data_json: toolText(r.data), refs: r.refs, actor: OWNER, updated_by: OTHER, requested_by: OPERATOR_EMAIL, approved_by: OWNER, note: `ask ${OTHER}` };
  }
  const input = { question: `What did ${OWNER} approve?`, history: [{ question: `Ping ${OTHER}`, answer: `${OWNER} approved it.` }], tool_results: fixtures };
  assert.ok(hasEmail(JSON.stringify(input)), "the fixture carries emails");
  const sent: string[] = [];
  const ai = { async run(_m: string, i: any) { sent.push(String(i.messages[1].content)); return { response: { x: "y" } }; } };
  const beamSent: string[] = [];
  const router = {
    routes: () => true,
    attempt: async (_t: string, messages: { content: string }[]) => { beamSent.push(messages[1].content); return { kind: "skip", reason: "off" }; },
    meter: async () => {},
  };
  const task: AiTask<unknown> = { name: "chat_answer", instructions: "Answer.", maxInputChars: 2_000_000, maxOutputTokens: 50, validate: (o) => o };
  const e = new AiEngine({ service: "cryptophys-ai-kernel", ai: ai as never, db: db as never, allowedModels: ALLOWED_TEXT_MODELS, allowedTasks: ["chat_answer"],
    ownBudget: async () => true, router: router as never, ownerIdentities: OWNER });
  const r = await e.run(task, input, "mr-2");
  assert.equal(r.status, "ok");
  assert.equal(beamSent.length, 1, "Beam was asked first");
  assert.equal(sent.length, 1, "then Workers AI");
  for (const s of [...beamSent, ...sent]) {
    assert.equal(hasEmail(s), false, "no email reaches a model");
    assert.ok(s.includes(OWNER_WORD) && s.includes(OPERATOR_WORD));
    assert.ok(s.includes("ev:platform/"), "the refs are kept");
  }
  assert.equal(beamSent[0], sent[0], "both providers get the same input");
});

test("MR-3. a chat turn: an email in the question and in an earlier turn never reaches the model; the stored turn is unchanged", async () => {
  const db = migratedDb();
  const sent: string[] = [];
  const ai = { async run(_m: string, i: any) { sent.push(String(i.messages[1].content)); const sys = String(i.messages[0].content); return { response: sys.startsWith("You plan") ? { tools: [{ name: "consensus" }] } : { answer: "Done.", citations: [] } }; } };
  const env: any = { ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${OWNER}`, APPROVER_IDENTITIES: OWNER }), AI: ai };
  const map = new Map<string, unknown>();
  const store: ConversationStore = { get: async <T>(k: string) => structuredClone(map.get(k)) as T | undefined, put: async (k: string, v: unknown) => { map.set(k, structuredClone(v)); } };
  const first = await runTurn(env, store, { actor: OWNER, conversation_id: "cnv_0123456789abcdef", question: `Did ${OTHER} vote?` }, NOW);
  assert.equal(first.question, `Did ${OTHER} vote?`, "the owner's own record keeps what they wrote");
  await runTurn(env, store, { actor: OWNER, conversation_id: "cnv_0123456789abcdef", question: `And ${OWNER}?` }, NOW + 1_000);
  assert.equal(sent.length, 4);
  for (const s of sent) assert.equal(hasEmail(s), false, s.slice(0, 200));
  assert.ok(sent[3].includes(`And ${OWNER_WORD}?`) && sent[3].includes(`Did ${OPERATOR_WORD} vote?`));
});

test("MR-4. every engine gets the owners: the chat, directives and councils pass APPROVER_IDENTITIES, engineFor reads it; no guard path", async () => {
  for (const f of ["workers/ai-kernel/src/conversation.ts", "workers/ai-kernel/src/directives.ts", "workers/ai-kernel/src/council.ts"]) {
    assert.match(read(f), /ownerIdentities: \(env as \{ APPROVER_IDENTITIES\?: string \}\)\.APPROVER_IDENTITIES/, f);
  }
  assert.match(read("workers/control-plane-shared/src/ai-engine.ts"), /const serialized = JSON\.stringify\(redactForModel\(redact\(input\), this\.owners\)\);/);
  const sent: string[] = [];
  const db = migratedDb();
  const e = engineFor({ AI: { async run(_m: string, i: any) { sent.push(String(i.messages[1].content)); return { response: { x: "y" } }; } } as never, DB: db as never, APPROVER_IDENTITIES: OWNER }, "cryptophys-ai-kernel", ["t"]);
  await e.run({ name: "t", instructions: "T.", maxInputChars: 10_000, maxOutputTokens: 10, validate: (o) => o }, { who: OWNER }, "mr-4");
  assert.equal(sent[0], JSON.stringify({ who: OWNER_WORD }));
  for (const p of ["workers/control-plane-shared/src/model-redact.ts", "workers/control-plane-shared/src/ai-engine.ts", "workers/ai-kernel/src/conversation.ts",
    "workers/ai-kernel/src/directives.ts", "workers/ai-kernel/src/council.ts", "docs/SSOT.md"]) assert.equal(criticalPathReason(p), null, p);
  assert.match(read("docs/SSOT.md"), /  - No person's email reaches a model \(review 2026-11-26\): `redactForModel`/);
});
