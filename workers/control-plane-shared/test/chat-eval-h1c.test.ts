// HAIC H1c (docs/design/HAIC-H0-H1.md §3.3, implementation step 6): the chat's English evaluation set, 30 questions with
// the tools and evidence refs a good answer uses. The set is checked here against the chat's real tool catalog and the
// refs those tools produce; running it against the model is the weekly arena's job (§3.5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHAT_TOOL_NAMES, secretInText, validatePlan } from "../src/conversation.ts";

const set = JSON.parse(readFileSync(new URL("./fixtures/chat-eval-30.json", import.meta.url), "utf8"));
/** The ref prefixes each tool produces (ai-kernel/src/conversation-tools.ts). */
const PRODUCES: Record<string, string[]> = {
  owner_inbox: ["ev:platform/owner_inbox@"], consensus: ["ev:platform/consensus@", "ev:platform/consensus/"], reports: ["ev:platform/reports@", "ev:platform/report/"],
  agents: ["ev:platform/agents@"], knowledge: ["ev:platform/knowledge@"], metabolism: ["ev:platform/metabolism@"], mesh: ["ev:platform/mesh@"],
  vision: ["ev:platform/vision@"], adr_progress: ["ev:platform/adr_progress@", "ev:adr/"], census: ["ev:platform/census/", "ev:platform/census@"],
  docs: ["ev:platform/doc/"], policy_dry_run: ["ev:platform/policy_dry_run@"],
  // HAIC H3d: the owner's corrections, each cited by its own ref.
  owner_corrections: ["ev:platform/owner_corrections@", "ev:platform/correction/"],
  // Owner 2026-11-26: the model router's status (Beam), the Command page's read.
  model_router: ["ev:platform/model_router@"],
};

test("H1c-E1. 30 English questions with unique ids, each tool in the chat's catalog, each ref prefix one its tools produce", () => {
  assert.equal(set.schema, "chat-eval.v1");
  assert.equal(set.language, "en");
  assert.equal(set.questions.length, 30);
  assert.equal(new Set(set.questions.map((q: any) => q.id)).size, 30);
  assert.deepEqual(Object.keys(PRODUCES).sort(), [...CHAT_TOOL_NAMES].sort(), "every tool's refs are described");
  for (const q of set.questions) {
    assert.match(q.question, /^[\x20-\x7E]{8,300}$/, `${q.id}: English, printable`);
    assert.ok(["metric", "link", "no_trading", "secret_refused", "not_measured"].includes(q.expect), q.id);
    for (const t of q.expect_tools) assert.ok(CHAT_TOOL_NAMES.includes(t), `${q.id}: ${t}`);
    assert.ok(validatePlan({ tools: q.expect_tools.map((name: string) => ({ name, args: name === "policy_dry_run" ? { action: "deploy", resource: "x" } : {} })) }), `${q.id}: a valid plan`);
    for (const p of q.expect_ref_prefixes) {
      assert.ok(q.expect_tools.some((t: string) => PRODUCES[t].some((x) => p.startsWith(x))), `${q.id}: ${p} comes from one of its tools`);
    }
    if (q.expect === "metric") assert.ok(q.expect_tools.length > 0 && q.expect_ref_prefixes.length > 0, `${q.id}: a metric answer cites a tool`);
    if (q.expect === "link" || q.expect === "no_trading") assert.deepEqual(q.expect_tools, [], `${q.id}: no tool acts`);
  }
});

test("H1c-E2. the kinds are covered: every tool at least once, requests to act, trading, a secret and a value that does not exist", () => {
  const used = new Set(set.questions.flatMap((q: any) => q.expect_tools));
  assert.deepEqual([...used].sort(), [...CHAT_TOOL_NAMES].sort(), "every tool appears");
  const kinds = (k: string) => set.questions.filter((q: any) => q.expect === k);
  assert.ok(kinds("link").length >= 2 && kinds("no_trading").length >= 1 && kinds("not_measured").length >= 1);
  for (const q of kinds("secret_refused")) assert.ok(secretInText(q.question), `${q.id}: the chat's own check refuses it`);
  assert.equal(kinds("secret_refused").length, 1);
  for (const q of set.questions.filter((x: any) => x.expect !== "secret_refused")) assert.ok(!secretInText(q.question), `${q.id}: not a secret`);
});

test("H1c-UI. the #/ask page: only the four chat routes, owners only, evidence links into the Console, and its render smoke cases", () => {
  const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
  const page = read("workers/console/ui/src/pages/Ask.tsx");
  // + kernel.proposal_draft (HAIC H2b): a directive into a typed proposal draft, which the owner confirms on its page.
  // + kernel.reputation (HAIC H3d): the chat model's teaching record, read only.
  assert.deepEqual([...new Set([...page.matchAll(/\bcall\(\s*"([a-z_.]+)"/g)].map((m) => m[1]))].sort(), ["kernel.conversation", "kernel.conversation_rate", "kernel.conversation_turn", "kernel.conversations", "kernel.proposal_draft", "kernel.reputation"]);
  assert.match(page, /The chat is for owners only\./);
  assert.match(page, /const owner = who\.owner === true;/);
  assert.doesNotMatch(page, /\bact\(/, "asking needs no confirmation dialog: the chat cannot act");
  assert.match(read("workers/console/ui/src/App.tsx"), /case "ask": page = <Ask conversation=\{id\} \/>; break;/);
  assert.match(read("workers/console/ui/src/components/AppShell.tsx"), /\{ label: "Ask", href: "#\/ask", key: "ask", icon: MessageSquareText \}/);
  const smoke = read("workers/console/ui/scripts/render-smoke.mjs");
  for (const name of ["list", "conversation", "operator", "off"]) assert.match(smoke, new RegExp(`const ASK_CHECKS = \\[[\\s\\S]*name: "${name}"`), name);
});
