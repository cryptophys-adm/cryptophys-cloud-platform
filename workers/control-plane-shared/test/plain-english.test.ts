// Owner 2026-11-07: operators were confused by machine-like agent output. Reports are in English:
// codes become sentences, and the AI model is Gemma 4 within the free Workers AI allocation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describeAction, describeResource, explainCode, explainReason, serviceName, REASON_TEXT } from "../src/plain.ts";
import { ALLOWED_TEXT_MODELS, DEFAULT_MODEL, PLAIN_ENGLISH_STYLE, AiEngine } from "../src/ai-engine.ts";
import { driftSubject } from "../../drift-detector/src/index.ts";
import { templateAuditDigest } from "../../ai-kernel/src/auditor.ts";
import { fakeAi, migratedDb } from "./harness.ts";

const ROOT = new URL("../../../", import.meta.url);

test("P1. codes become sentences; unknown codes are still readable", () => {
  assert.equal(explainReason("failed: target_rate_limit"), "Blocked: This service was already changed in the last hour; it will be retried after that.");
  assert.equal(explainReason("all policy checks passed"), "All safety checks passed.");
  assert.match(explainReason("failed: platform_daily_limit, ci_green"), /^Blocked: The daily limit of 6 deploys.*; the commit's automated checks/);
  assert.equal(explainCode("brand_new_code"), "brand new code");
  assert.equal(explainReason("A sentence already."), "A sentence already.");
  assert.equal(serviceName("cryptophys-policy-engine"), "Policy Engine");
  assert.equal(serviceName("xauusd-risk-manager"), "XAUUSD Risk Manager");
  assert.equal(describeAction("deploy_commit", "cryptophys-console"), "deploy the latest code to Cerebrum Console");
  assert.equal(describeResource("rollback_worker_version:cryptophys-platform-api"), "roll back Platform API");
  for (const code of ["target_rate_limit", "platform_daily_limit", "ci_green", "version_mismatch", "observed_version_unavailable", "commit_not_current_main"]) {
    assert.ok(REASON_TEXT[code] && !/_/.test(REASON_TEXT[code]), code);
  }
});

test("P2. report titles are plain English: drift, audit digest", () => {
  assert.equal(driftSubject([{ service_id: "cryptophys-platform-registry" }]), "Platform Registry is not running the expected version");
  assert.equal(driftSubject([{ service_id: "cryptophys-console" }, { service_id: "cryptophys-home" }]), "Cerebrum Console, Home (retired) are not running the expected version");
  const obs = {
    observed_at: "2026-11-07T08:37:00.000Z", since: "2026-11-06T08:37:00.000Z",
    chain: { valid: true, events_checked: 1610, head_hash: "abc1234567890", first_invalid_event_id: null, reason: null },
    valid: true, events_checked: 1610,
    counts_24h: { agent_actions_by_agent: [], denied_agent_syscalls: 4, failed_agent_syscalls: 3, policy_denies_by_action: [{ action: "consensus.execute", count: 12 }],
      governance_audit_events: { "agent.suspended": 0, "agent.resumed": 0, "kernel.agents_enabled": 0 }, agent_recovery_plans: 0 },
  };
  const d = templateAuditDigest(obs as never, "warning", ["denied_agent_syscalls:4"]);
  assert.equal(d.headline, "Needs a look: 4 agent request(s) were refused by policy in the last 24 hours");
  assert.doesNotMatch([d.headline, d.summary, ...d.items].join(" "), /syscall|_/);
});

test("P3. AI: Gemma 4 by default, thinking off, the plain-English style in every prompt, OpenAI-style answers read", async () => {
  assert.equal(DEFAULT_MODEL, "@cf/google/gemma-4-26b-a4b-it");
  assert.ok(ALLOWED_TEXT_MODELS.includes("@cf/meta/llama-3.1-8b-instruct-fast"), "the previous model stays allowed for a rollback");
  for (const dir of readdirSync(new URL("workers/", ROOT))) {
    let toml = "";
    try { toml = readFileSync(new URL(`workers/${dir}/wrangler.toml`, ROOT), "utf8"); } catch { continue; }
    if (!/^AI_MODEL/m.test(toml)) continue;
    assert.match(toml, /^AI_MODEL = "@cf\/google\/gemma-4-26b-a4b-it"$/m, dir);
    assert.match(toml, /^AI_ACCOUNT_DAILY_REQUEST_LIMIT = "250"$/m, `${dir}: the account cap keeps the worst case inside the free 10k neurons`);
  }
  const ai = fakeAi({ choices: [{ message: { content: '{"text":"The Policy Engine refused it."}' } }] } as never);
  const e = new AiEngine({ service: "cryptophys-policy-engine", ai, db: migratedDb() as never, allowedModels: ALLOWED_TEXT_MODELS, allowedTasks: ["t"] });
  const r: any = await e.run({ name: "t", instructions: "x", maxInputChars: 1000, maxOutputTokens: 100, validate: (o: any) => (typeof o?.text === "string" ? o : null) }, { a: 1 }, "c");
  assert.equal(r.status, "ok");
  assert.equal(r.data.text, "The Policy Engine refused it.");
  const sent = ai.calls[0].input as any;
  assert.deepEqual(sent.chat_template_kwargs, { enable_thinking: false });
  assert.ok(String(sent.messages[0].content).includes(PLAIN_ENGLISH_STYLE));
  assert.match(PLAIN_ENGLISH_STYLE, /plain English/);
});
