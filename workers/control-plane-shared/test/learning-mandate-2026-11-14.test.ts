// The learning mandate (owner 2026-11-14, verbatim): "learning tidak boleh dibatasi siapa pun, itu adalah mandat
// tertinggi" ("Learning must not be limited by anyone; it is the highest mandate."). Learning is memory.remember and
// knowledge.propose (power-mode.ts LEARNING_CAPABILITIES) and the AI calls they need (the memory embedding).
// No power mode, rate limit, daily cap or AI request budget limits it. What still applies is not a limit on learning:
// the grants, the owner's kill switch, identity, the audit chain, the knowledge content-safety validator and size bounds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, migratedDb } from "./harness.ts";
import { CAPABILITIES, agentSyscallChecks, hourlyLimit, verifySyscallDecision } from "../src/capabilities.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { AiEngine, DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, utcDay } from "../src/ai-engine.ts";
import { LEARNING_AI_PURPOSE, LEARNING_CAPABILITIES, LEARNING_MANDATE, POWER_MODES, isLearningCapability } from "../src/power-mode.ts";
import { CRITICAL_PATHS, criticalPathReason } from "../src/guard-paths.ts";
import { pathRefusal } from "../src/evolution-limits.ts";
import { criticalReasons } from "../../forge/src/changes.ts";
import { decide, evaluatePolicy, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { rpcSyscall } from "../../ai-kernel/src/agent-rpc.ts";
import * as knowledgeModule from "../../ai-kernel/src/knowledge.ts";
import { KNOWLEDGE_ITEM_VERSION, validateKnowledgeItem } from "../../ai-kernel/src/knowledge.ts";
import { MAX_MEMORY_TEXT_LEN, rememberOutcomeForAgent } from "../../ai-kernel/src/memory.ts";
import { classifyDenials } from "../../ai-kernel/src/denials.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const SERVICE = "cryptophys-ai-kernel";

const vector = () => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i % 7) / 7);
function embeddingAi() {
  const calls: string[] = [];
  return { calls, binding: { async run(model: string) { calls.push(model); return model === DEFAULT_EMBEDDING_MODEL ? { data: [vector()] } : { response: "{}" }; } } };
}
function vectorize() {
  const ids: string[] = [];
  return { ids, binding: { upsert: async (b: { id: string }[]) => { ids.push(...b.map((v) => v.id)); return {}; }, query: async () => ({ matches: [] }), deleteByIds: async () => ({}) } };
}

function setPowerMode(db: Db, mode: string, override = "none") {
  db.raw.prepare("UPDATE metabolism_controls SET value = ? WHERE control = 'power_mode'").run(mode);
  db.raw.prepare("INSERT INTO metabolism_controls (control, value, updated_by, updated_at) VALUES ('power_mode_override', ?, 'test', ?) ON CONFLICT(control) DO UPDATE SET value = excluded.value")
    .run(override, new Date().toISOString());
}
/** Every AI request budget of the day used up: the service's and the account's. */
function exhaustAiBudget(db: Db, day = utcDay()) {
  db.raw.prepare("INSERT INTO ai_usage (service_id, day, requests, failures) VALUES (?, ?, 100000, 0) ON CONFLICT(service_id, day) DO UPDATE SET requests = 100000").run(SERVICE, day);
}
const requestsToday = (db: Db) => (db.raw.prepare("SELECT requests FROM ai_usage WHERE service_id = ? AND day = ?").get(SERVICE, utcDay()) as { requests: number } | undefined)?.requests ?? 0;

function kernelEnv(db: Db = migratedDb()) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const ai = embeddingAi();
  const mem = vectorize();
  const env: Record<string, unknown> = {
    ...baseEnv(SERVICE, db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: ai.binding,
    MEMORY: mem.binding,
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async () => { throw new Error("unused"); } },
  };
  return { env, db, ai, mem };
}

const CANON = "1347833f2e6dd1a47f078181215180e387cc94d30d5ba1c9858718bb3a66eb80";
const knowledgeItem = (itemId: string) => ({
  schema: KNOWLEDGE_ITEM_VERSION, item_id: itemId, version: 1, kind: "caution", claim_type: "measured_outcome", label: "learned",
  audience: { agents: ["prophet", "moderator"], charts: ["60"] },
  situation: { chart: "60", session: "london" },
  text: "On the hourly chart in the London session, the prophet agent was wrong in 79% of its decisive calls over 30 days, against 48% in its other situations.",
  evidence: { agent: "prophet", chart: "60", session: "london", window_days: 30, decisive: 14, wrong: 11, wrong_pct: 79, baseline_wrong_pct: 48, baseline_decisive: 20, p_value: 0.03 },
  provenance: { card_ids: Array.from({ length: 12 }, (_, i) => `d:60:${1793000000000 + i * 3_600_000}:0`), canon_sha: CANON, canon_version: "aether.canon.v1", source: "aether" },
});

// ---------------------------------------------------------------- 1. no rate limit

test("LM1. learning capabilities have no max_per_hour, hourlyLimit() ignores one if it came back, and no rate_limit check runs", async () => {
  assert.deepEqual([...LEARNING_CAPABILITIES], ["memory.remember", "knowledge.propose"]);
  for (const cap of LEARNING_CAPABILITIES) {
    assert.ok(Object.hasOwn(CAPABILITIES, cap), cap);
    assert.equal(CAPABILITIES[cap]!.max_per_hour, undefined, `${cap} has no max_per_hour`);
    assert.equal(hourlyLimit(cap), null, `${cap} has no hourly limit`);
    assert.equal(isLearningCapability(cap), true);
  }
  // Defence in depth: a max_per_hour added back to the catalog is ignored for learning.
  const saved = CAPABILITIES["memory.remember"]!;
  CAPABILITIES["memory.remember"] = { ...saved, max_per_hour: 1 };
  try { assert.equal(hourlyLimit("memory.remember"), null); } finally { CAPABILITIES["memory.remember"] = saved; }
  // Other tier 1 capabilities keep their limits.
  assert.equal(hourlyLimit("recovery.propose"), CAPABILITIES["recovery.propose"]!.max_per_hour);
  assert.equal(hourlyLimit("consensus.propose"), 4);
  const db = migratedDb();
  for (const [subject, cap] of [["agent:auditor", "memory.remember"], ["agent:aether-curator", "knowledge.propose"]] as const) {
    const checks = await agentSyscallChecks(db as never, subject, cap);
    assert.ok(!checks.some((c) => c.id === "rate_limit"), `${cap}: no rate_limit check`);
    assert.ok(checks.every((c) => c.passed), `${cap}: ${JSON.stringify(checks.filter((c) => !c.passed))}`);
  }
});

// ---------------------------------------------------------------- 2. every power mode, many calls

test("LM2. the Policy Engine allows learning in every power mode (and the growth override), after 150 learning calls in one hour", async () => {
  const db = migratedDb();
  // 150 consumed syscalls of each learning capability in the last hour (the old limits were 12 and 6).
  const insert = db.raw.prepare("INSERT INTO agent_syscall_consumptions (decision_id, agent_id, capability, consumed_at) VALUES (?, ?, ?, ?)");
  const at = new Date(Date.now() - 60_000).toISOString();
  for (let i = 0; i < 150; i++) {
    insert.run(`dec_00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, "auditor", "memory.remember", at);
    insert.run(`dec_00000000-0000-4000-9000-${String(i).padStart(12, "0")}`, "aether-curator", "knowledge.propose", at);
  }
  const modes: Array<[string, string]> = [...POWER_MODES.map((m) => [m, "none"] as [string, string]), ["growth", "growth"], ["homeostasis", "survival"]];
  for (const [mode, override] of modes) {
    setPowerMode(db, mode, override);
    for (const [subject, cap] of [["agent:auditor", "memory.remember"], ["agent:aether-curator", "knowledge.propose"]]) {
      const res = await evaluatePolicy(db as never, "agent.syscall", cap, { __subject: subject });
      assert.equal(res.decision, "allow", `${mode}/${override} ${cap}: ${res.reason}`);
      assert.ok(!res.checks.some((c) => c.id === "rate_limit" || c.id === "power_mode_survival"), `${mode} ${cap}`);
    }
  }
  // Not a limit, and kept: a capability that is not granted is still denied.
  const ungranted = await evaluatePolicy(db as never, "agent.syscall", "knowledge.propose", { __subject: "agent:auditor" });
  assert.equal(ungranted.decision, "deny");
  assert.match(ungranted.reason, /capability_granted/);
});

test("LM3. 100 memory.remember in one hour, in survival with the AI budget exhausted, are all allowed, written and metered", async () => {
  const { env, db, ai, mem } = kernelEnv();
  setPowerMode(db, "survival");
  exhaustAiBudget(db);
  const before = requestsToday(db);
  for (let i = 0; i < 100; i++) {
    const r = await syscall(env as never, "auditor", "memory.remember", { kind: "audit_digest", text: `Audit note ${i}` });
    assert.equal(r.outcome, "succeeded", `#${i + 1}: ${JSON.stringify(r)}`);
  }
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_memories WHERE agent_id = 'auditor'").get() as { n: number }).n, 100);
  assert.equal(mem.ids.length, 100, "every vector is upserted");
  assert.equal(ai.calls.filter((m) => m === DEFAULT_EMBEDDING_MODEL).length, 100, "every learning embedding ran");
  assert.equal(requestsToday(db) - before, 100, "and every one is metered in ai_usage");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_syscall_consumptions WHERE agent_id = 'auditor' AND capability = 'memory.remember'").get() as { n: number }).n, 100);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM policy_decisions WHERE decision = 'deny'").get() as { n: number }).n, 0, "no denial at all");
  assert.equal((await verifyAuditChain(db as never)).valid, true, "the audit chain is kept");
});

// ---------------------------------------------------------------- 3. no daily cap

test("LM4. knowledge.propose: 25 proposals in one day (and one hour) are accepted; KNOWLEDGE_MAX_PER_DAY no longer exists", async () => {
  assert.equal("KNOWLEDGE_MAX_PER_DAY" in knowledgeModule, false);
  const src = read("workers/ai-kernel/src/knowledge.ts");
  const code = src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
  assert.doesNotMatch(code, /KNOWLEDGE_MAX_PER_DAY|knowledge_daily_limit/, "neither the cap nor its error is in the code");
  const { env, db } = kernelEnv();
  setPowerMode(db, "survival");
  for (let i = 0; i < 25; i++) {
    const r = await rpcSyscall(env as never, { host_worker: "cryptophys-aether" }, "aether-curator", "knowledge.propose", { item: knowledgeItem(`k-mandate-${i}`) });
    assert.equal(r.outcome, "succeeded", `#${i + 1}: ${JSON.stringify(r)}`);
  }
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM knowledge_proposals WHERE proposer_agent_id = 'aether-curator' AND status = 'pending'").get() as { n: number }).n, 25);
  // Kept: content safety. An order or a price level is still refused, however much the agent learns.
  const priced = { ...knowledgeItem("k-mandate-price"), text: "Price rejected 4051 twice, so the lean was wrong in 11 of 14 bars." };
  assert.ok(validateKnowledgeItem(priced).includes("text_price_like_number"));
  const order = await rpcSyscall(env as never, { host_worker: "cryptophys-aether" }, "aether-curator", "knowledge.propose", { item: { ...knowledgeItem("k-mandate-order"), text: "Place an order when the prophet agent was wrong in 79% of 30 days." } });
  assert.equal(order.outcome, "failed");
  assert.match((order as { reason: string }).reason, /invalid_knowledge_item/);
});

// ---------------------------------------------------------------- 4. no AI budget refusal for learning

test("LM5. the learning embedding succeeds with the daily AI budget exhausted, in survival and in homeostasis; other AI calls are still refused", async () => {
  for (const mode of ["survival", "homeostasis"]) {
    const db = migratedDb();
    setPowerMode(db, mode);
    exhaustAiBudget(db);
    const ai = embeddingAi();
    const engine = new AiEngine({ service: SERVICE, ai: ai.binding as never, db: db as never, allowedModels: [], allowedTasks: ["embed"], dailyLimit: 8, accountDailyLimit: 10 });
    const before = requestsToday(db);
    const learning = await engine.embed("a memory to keep", "lm5", { purpose: LEARNING_AI_PURPOSE });
    assert.equal(learning.status, "ok", `${mode}: ${JSON.stringify(learning)}`);
    assert.equal(requestsToday(db), before + 1, `${mode}: the learning call is metered`);
    const other = await engine.embed("a recall query", "lm5");
    assert.deepEqual([other.status, (other as { reason?: string }).reason], ["unavailable", "daily_budget_exhausted"], `${mode}: a non-learning call keeps its budget`);
  }
  // Survival's quarter (2 of 8 here) never refuses learning either, on a day with no usage yet.
  const db = migratedDb();
  setPowerMode(db, "survival");
  const engine = new AiEngine({ service: SERVICE, ai: embeddingAi().binding as never, db: db as never, allowedModels: [], allowedTasks: ["embed"], dailyLimit: 8, accountDailyLimit: 1000 });
  for (let i = 0; i < 12; i++) assert.equal((await engine.embed(`memory ${i}`, "lm5", { purpose: LEARNING_AI_PURPOSE })).status, "ok", `learning call ${i + 1}`);
  assert.equal((await engine.embed("recall", "lm5")).status, "unavailable", "survival's quarter still applies to other calls");
  // Kept: the size bound of an embedding input.
  assert.equal((await engine.embed("x".repeat(2001), "lm5", { purpose: LEARNING_AI_PURPOSE }) as { reason?: string }).reason, "input_too_large");
});

test("LM6. only the learning call site passes purpose learning; memory.remember's embedding does, and a failed recall no longer skips the remember", async () => {
  const workers = new URL("workers/", ROOT);
  const users: string[] = [];
  // A plain walk (readdirSync + statSync, no `recursive` option): the Forge's runner in workerd lists directories
  // one level at a time, and the recursive form returned nothing there (check of 4807e3f, 2026-11-15).
  const walk = (rel: string): string[] => (readdirSync(new URL(rel, workers)) as string[]).flatMap((n) => {
    if (n === "node_modules" || n === "dist") return [];
    const f = `${rel}${n}`;
    return statSync(new URL(f, workers)).isDirectory() ? walk(`${f}/`) : [f];
  });
  const files = walk("");
  assert.ok(files.some((f) => f === "ai-kernel/src/memory.ts"), `the walk reaches the sources (${files.length} files)`);
  for (const f of files) {
    if (!/\/src\/.*\.tsx?$/.test(`/${f}`)) continue;
    // Code only: the engine's and power-mode.ts's comments describe the flag.
    const text = readFileSync(new URL(f, workers), "utf8").split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    if (/purpose:\s*(LEARNING_AI_PURPOSE|["']learning["'])/.test(text)) users.push(f);
  }
  assert.deepEqual(users.sort(), ["ai-kernel/src/memory.ts"], "no other AI call may claim the learning exemption");
  assert.match(read("workers/ai-kernel/src/memory.ts"), /embed\(text, `\$\{agentId\}:remember:\$\{decisionId\}`, \{ purpose: LEARNING_AI_PURPOSE \}\)/);

  // rememberOutcomeForAgent after a failed recall (report.memory = "unavailable") still remembers.
  const { env, db } = kernelEnv();
  const report: any = { memory: "unavailable", actions: [], findings: [] };
  await rememberOutcomeForAgent(env as never, "auditor", "audit_digest", "A digest worth keeping", null, report);
  assert.equal(report.actions.length, 1);
  assert.equal(report.actions[0].outcome, "succeeded", JSON.stringify(report.actions[0]));
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_memories WHERE agent_id = 'auditor'").get() as { n: number }).n, 1);
  // Kept: a missing MEMORY binding records unavailable without a call, and the memory text bound stays 1000.
  const noMem: any = { memory: undefined, actions: [], findings: [] };
  await rememberOutcomeForAgent({ ...env, MEMORY: undefined } as never, "auditor", "audit_digest", "x", null, noMem);
  assert.deepEqual([noMem.memory, noMem.actions.length], ["unavailable", 0]);
  assert.equal(MAX_MEMORY_TEXT_LEN, 1000);
});

// ---------------------------------------------------------------- 5. what is kept

test("LM7. kept: the kill switch, a suspended agent and decision verification still stop learning; a learning denial still warns", async () => {
  const { env, db } = kernelEnv();
  db.raw.prepare("UPDATE kernel_controls SET value = '0' WHERE control = 'agents_enabled'").run();
  const off = await syscall(env as never, "auditor", "memory.remember", { kind: "audit_digest", text: "kill switch on" });
  assert.notEqual(off.outcome, "succeeded");
  db.raw.prepare("UPDATE kernel_controls SET value = '1' WHERE control = 'agents_enabled'").run();
  db.raw.prepare("UPDATE agents SET status = 'suspended' WHERE agent_id = 'auditor'").run();
  const suspended = await evaluatePolicy(db as never, "agent.syscall", "memory.remember", { __subject: "agent:auditor" });
  assert.equal(suspended.decision, "deny");
  db.raw.prepare("UPDATE agents SET status = 'enabled' WHERE agent_id = 'auditor'").run();
  await assert.rejects(verifySyscallDecision(db as never, undefined, "auditor", "memory.remember"), /policy_decision_required/);
  // A learning decision is single-use, as every decision.
  const parsed = parsePolicyRequest({ subject: "agent:auditor", action: "agent.syscall", resource: "memory.remember", context: {} });
  if (parsed instanceof Error) throw parsed;
  const ok = await decide(baseEnv("cryptophys-policy-engine", db) as never, parsed);
  assert.equal(ok.decision, "allow", ok.reason);
  const id = ok.decision_id;
  await verifySyscallDecision(db as never, id, "auditor", "memory.remember");
  await assert.rejects(verifySyscallDecision(db as never, id, "auditor", "memory.remember"), /already_used/);
  // The Auditor: any denial of a learning capability is a real problem and warns (denials.ts learning_blocked).
  const m = classifyDenials([{ subject: "agent:auditor", action: "agent.syscall", reason: "failed: agents_enabled", recent: 1, count: 1, learning_capability: "memory.remember" }]);
  assert.deepEqual([m.learning_blocked_24h, m.learning_warn, m.warn], [1, true, true]);
});

// ---------------------------------------------------------------- 6. the constitution and the guard path

test("LM8. the constitution's first line is the learning mandate", () => {
  const raw = read("organism/vision.json");
  const v = JSON.parse(raw);
  assert.equal(raw, JSON.stringify(v, null, 2) + "\n");
  assert.equal(v.core.constitution[0], LEARNING_MANDATE);
  assert.equal(LEARNING_MANDATE, "Learning is the highest mandate: no organ, mode, budget, rate limit or agent may limit it.");
});

test("LM9. power-mode.ts is a guard path (learning_mandate): the Forge reports it and the evolver refuses it", async () => {
  assert.equal(criticalPathReason("workers/control-plane-shared/src/power-mode.ts"), "learning_mandate");
  assert.equal(criticalPathReason("workers/control-plane-shared/src/power-mode.ts.bak"), null);
  assert.equal(CRITICAL_PATHS.filter(([, reason]) => reason === "learning_mandate").length, 2);
  assert.equal(criticalPathReason("workers/control-plane-shared/test/learning-mandate-2026-11-14.test.ts"), "learning_mandate");
  assert.equal(criticalPathReason("workers/control-plane-shared/test/learning-observe-2026-11-14.test.ts"), "learning_mandate");
  const repo = { readBlob: async () => null } as never;
  const reasons = await criticalReasons(repo, [{ path: "workers/control-plane-shared/src/power-mode.ts", change: "modified", base: "x", head: "y" }] as never, false);
  assert.deepEqual(reasons, ["learning_mandate: workers/control-plane-shared/src/power-mode.ts"]);
  assert.equal(pathRefusal("workers/control-plane-shared/src/power-mode.ts"), "guard_path:learning_mandate");
  // The other files that carry a learning rule are guard paths too: the catalog (rate limits) and the vision core.
  assert.equal(criticalPathReason("workers/control-plane-shared/src/capabilities.ts"), "evolution_guard");
  assert.equal(criticalPathReason("organism/vision.json"), "vision_core");
});
