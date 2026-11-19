// Owner 2026-11-14, after the learning mandate ("learning tidak boleh dibatasi siapa pun, itu adalah mandat
// tertinggi"): (1) exact-duplicate dedup, not a cap: an identical memory or knowledge proposal returns the existing
// row's id and writes nothing, and different content is always written; (2) observe, don't block: learning volume and
// learning AI use are visible (GET /v1/metabolism, the Organism page), and a spike or a repeated subject is an
// Observer finding in metric form for the owner and the Supervisor. Nothing is throttled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, migratedDb } from "./harness.ts";
import { DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, utcDay } from "../src/ai-engine.ts";
import { readFindings } from "../src/observer.ts";
import { LEARNING_BASELINE_FLOOR, LEARNING_SPIKE_RATIO, lastCompleteHourMs, learningFindings, learningHour } from "../src/learning-watch.ts";
import { decide, evaluatePolicy, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { rpcSyscall } from "../../ai-kernel/src/agent-rpc.ts";
import { KNOWLEDGE_ITEM_VERSION } from "../../ai-kernel/src/knowledge.ts";
import { knowledgeDedupHash, memoryDedupHash, normalizeText } from "../../ai-kernel/src/learning-dedup.ts";
import { evaluateMetabolismState } from "../../ai-kernel/src/supervisor.ts";
import { metabolismView } from "../../ai-kernel/src/metabolism-view.ts";
import { observerCycle } from "../../ai-kernel/src/observer-watch.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const n = (db: Db, sql: string, ...args: unknown[]) => (db.raw.prepare(sql).get(...(args as never[])) as { n: number }).n;

function kernelEnv(db: Db = migratedDb()) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const embeds: string[] = [];
  const vectors: string[] = [];
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: { async run(model: string, input: any) { if (model === DEFAULT_EMBEDDING_MODEL) { embeds.push(String(input?.text?.[0])); return { data: [Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.5)] }; } return { response: "{}" }; } },
    MEMORY: { upsert: async (b: { id: string }[]) => { vectors.push(...b.map((v) => v.id)); return {}; }, query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async () => { throw new Error("unused"); } },
  };
  return { env, db, embeds, vectors };
}

const CANON = "1347833f2e6dd1a47f078181215180e387cc94d30d5ba1c9858718bb3a66eb80";
const item = (over: Record<string, unknown> = {}) => ({
  schema: KNOWLEDGE_ITEM_VERSION, item_id: "k-dedup", version: 1, kind: "caution", claim_type: "measured_outcome", label: "learned",
  audience: { agents: ["prophet", "moderator"], charts: ["60"] },
  situation: { chart: "60", session: "london" },
  text: "On the hourly chart in the London session, the prophet agent was wrong in 79% of its decisive calls over 30 days, against 48% in its other situations.",
  evidence: { agent: "prophet", chart: "60", session: "london", window_days: 30, decisive: 14, wrong: 11, wrong_pct: 79, baseline_wrong_pct: 48, baseline_decisive: 20, p_value: 0.03 },
  provenance: { card_ids: Array.from({ length: 12 }, (_, i) => `d:60:${1793000000000 + i * 3_600_000}:0`), canon_sha: CANON, canon_version: "aether.canon.v1", source: "aether" },
  ...over,
});
const AETHER = { host_worker: "cryptophys-aether" };

// ---------------------------------------------------------------- 1. dedup, not a cap

test("LO1. memory.remember: an exact duplicate (up to whitespace) returns the existing id and writes no second row, vector or embedding; different content is written", async () => {
  const { env, db, embeds, vectors } = kernelEnv();
  const first = await syscall(env as never, "auditor", "memory.remember", { kind: "audit_digest", text: "Audit chain verified across 42 events.", source_ref: "rpt_1" });
  assert.equal(first.outcome, "succeeded", JSON.stringify(first));
  const id = (first as any).result.memory.memory_id;
  assert.equal((first as any).result.memory.deduplicated, false);
  const again = await syscall(env as never, "auditor", "memory.remember", { kind: " audit_digest ", text: "  Audit chain   verified\nacross 42 events.  ", source_ref: "rpt_2" });
  assert.equal(again.outcome, "succeeded", "a duplicate is never refused");
  assert.deepEqual([(again as any).result.memory.memory_id, (again as any).result.memory.deduplicated], [id, true]);
  assert.equal(n(db, "SELECT COUNT(*) AS n FROM agent_memories"), 1, "no second row");
  assert.deepEqual([vectors.length, embeds.length], [1, 1], "no second vector and no second embedding");
  // Different content is always written: other text, other case, other kind, another agent.
  for (const [agent, kind, text] of [["auditor", "audit_digest", "Audit chain verified across 43 events."], ["auditor", "audit_digest", "audit chain verified across 42 events."],
    ["auditor", "audit_warning", "Audit chain verified across 42 events."], ["supervisor", "audit_digest", "Audit chain verified across 42 events."]]) {
    const r = await syscall(env as never, agent, "memory.remember", { kind, text });
    assert.equal(r.outcome, "succeeded", JSON.stringify(r));
    assert.equal((r as any).result.memory.deduplicated, false, `${agent} ${kind} ${text}`);
  }
  assert.equal(n(db, "SELECT COUNT(*) AS n FROM agent_memories"), 5);
  assert.equal(n(db, "SELECT COUNT(*) AS n FROM agent_memories WHERE dedup_sha256 IS NULL"), 0, "every new row carries its hash");
  // The normalization is exactly: trim, collapse whitespace; case kept; source_ref not hashed.
  assert.equal(normalizeText("  a \t b\n\nc "), "a b c");
  assert.equal(await memoryDedupHash("auditor", "k", "A  b"), await memoryDedupHash("auditor", " k ", " A b "));
  assert.notEqual(await memoryDedupHash("auditor", "k", "A b"), await memoryDedupHash("auditor", "k", "a b"));
  assert.equal(n(db, "SELECT COUNT(*) AS n FROM policy_decisions WHERE decision = 'deny'"), 0, "nothing refused");
});

test("LO2. knowledge.propose: the same claim (whitespace, key order or a new version) returns the existing proposal; different content and an expired claim are written", async () => {
  const { env, db } = kernelEnv();
  const first = await rpcSyscall(env as never, AETHER, "aether-curator", "knowledge.propose", { item: item() });
  assert.equal(first.outcome, "succeeded", JSON.stringify(first));
  const id = (first as any).result.proposal.proposal_id;
  const reordered = Object.fromEntries(Object.entries(item({ version: 2, text: ` ${item().text.replace(/ /g, "  ")} ` })).reverse());
  const same = await rpcSyscall(env as never, AETHER, "aether-curator", "knowledge.propose", { item: reordered });
  assert.equal(same.outcome, "succeeded", JSON.stringify(same));
  assert.deepEqual([(same as any).result.proposal.proposal_id, (same as any).result.proposal.deduplicated, (same as any).result.proposal.status], [id, true, "pending"]);
  assert.equal(n(db, "SELECT COUNT(*) AS n FROM knowledge_proposals"), 1, "no second row");
  assert.equal(await knowledgeDedupHash("aether-curator", item()), await knowledgeDedupHash("aether-curator", item({ version: 7 })));
  // Different content is a new proposal.
  const other = await rpcSyscall(env as never, AETHER, "aether-curator", "knowledge.propose", { item: item({ item_id: "k-dedup-other" }) });
  assert.deepEqual([other.outcome, (other as any).result.proposal.deduplicated], ["succeeded", false]);
  // Once expired unreviewed, the same claim may be proposed again (by design), and is written.
  db.raw.prepare("UPDATE knowledge_proposals SET status = 'expired' WHERE proposal_id = ?").run(id);
  const again = await rpcSyscall(env as never, AETHER, "aether-curator", "knowledge.propose", { item: item({ version: 3 }) });
  assert.deepEqual([again.outcome, (again as any).result.proposal.deduplicated], ["succeeded", false]);
  // A row from before migration 0070 (no hash): its exact resubmission returns it instead of an error.
  db.raw.prepare("UPDATE knowledge_proposals SET dedup_sha256 = NULL").run();
  const legacy = await rpcSyscall(env as never, AETHER, "aether-curator", "knowledge.propose", { item: item({ item_id: "k-dedup-other" }) });
  assert.deepEqual([legacy.outcome, (legacy as any).result.proposal.proposal_id], ["succeeded", (other as any).result.proposal.proposal_id]);
  assert.equal(n(db, "SELECT COUNT(*) AS n FROM knowledge_proposals"), 3);
  assert.equal(n(db, "SELECT COUNT(*) AS n FROM policy_decisions WHERE decision = 'deny'"), 0, "nothing refused");
});

// ---------------------------------------------------------------- 2. observe, don't block

function learningAction(db: Db, agentId: string, capability: string, at: number, result: Record<string, unknown> = {}, input: Record<string, unknown> = {}) {
  db.raw.prepare("INSERT INTO agent_actions (action_id, agent_id, capability, tier, decision_id, outcome, input_json, result_json, created_at) VALUES (?, ?, ?, 1, NULL, 'succeeded', ?, ?, ?)")
    .run(`act_${crypto.randomUUID()}`, agentId, capability, JSON.stringify(input), JSON.stringify(result), new Date(at).toISOString());
}

test("LO3. a learning spike (>= 10x the 7-day hourly baseline) and a repeated subject are Observer findings in metric form; nothing is denied, and the Supervisor reads them", async () => {
  const db = migratedDb();
  const now = Date.parse("2026-11-14T11:27:00.000Z");
  const hour = lastCompleteHourMs(now);
  // auditor: a baseline of 1 an hour (168 in the 7 days before), then 12 in the hour: 12 >= 10 x 1 -> spike.
  for (let i = 0; i < 168; i++) learningAction(db, "auditor", "memory.remember", hour - (i + 1) * 3_600_000 + 60_000, { memory: { memory_id: `mem_b${i}` } });
  for (let i = 0; i < 12; i++) learningAction(db, "auditor", "memory.remember", hour + i * 60_000, { memory: { memory_id: `mem_h${i}` } });
  // supervisor: a baseline of 2 an hour and 15 in the hour: below 10x -> no spike.
  for (let i = 0; i < 336; i++) learningAction(db, "supervisor", "memory.remember", hour - Math.floor(i / 2 + 1) * 3_600_000 + 60_000, { memory: { memory_id: `mem_s${i}` } });
  for (let i = 0; i < 15; i++) learningAction(db, "supervisor", "memory.remember", hour + i * 60_000, { memory: { memory_id: `mem_sh${i}` } });
  // aether-curator: the same item proposed 3 times in the hour -> a repeat.
  for (let i = 0; i < 3; i++) learningAction(db, "aether-curator", "knowledge.propose", hour + i * 60_000, { proposal: { proposal_id: "knw_x" } }, { item: { item_id: "k-same" } });
  const h = await learningHour(db as never, hour);
  const auditor = h.by_agent.find((a) => a.agent_id === "auditor")!;
  assert.deepEqual([auditor.count, auditor.baseline_hourly], [12, 1]);
  const findings = learningFindings(h);
  assert.deepEqual(findings.map((f) => `${f.worker}:${f.metric}:${f.value}`).sort(), ["agent:aether-curator:learning_repeat:3", "agent:auditor:learning_volume:12"]);
  const spike = findings.find((f) => f.metric === "learning_volume")!;
  assert.deepEqual([spike.kind, spike.severity, spike.report_only, spike.baseline_7d, spike.z], ["anomaly", "info", true, 1, null], "metric form, never a rollback");
  assert.equal((spike.sample as any).ratio_to_baseline, 12);
  assert.equal(LEARNING_SPIKE_RATIO * LEARNING_BASELINE_FLOOR, 10, "a quiet agent needs at least 10 calls in an hour");

  // In the Observer's run (no analytics token needed): stored once, published to the owner as an advisory.
  const { runObserver } = await import("../../platform-api/src/index.ts");
  const published: any[] = [];
  const apiEnv: any = { ...baseEnv("cryptophys-platform-api", db), PLATFORM_NAME: "cryptophys-cloud-platform", PLATFORM_ENVIRONMENT: "production", DB: db,
    AGENTS: { syscall: async (agent: string, cap: string, input: any) => { published.push({ agent, cap, input }); return { outcome: "succeeded" }; } } };
  const r = await runObserver(apiEnv, now, async () => new Response("{}", { status: 500 }));
  assert.deepEqual(r.learning, { outcome: "recorded", findings: 2 });
  assert.equal(published.length, 1);
  assert.deepEqual(published[0].input.body.findings.map((f: any) => f.metric).sort(), ["learning_repeat", "learning_volume"]);
  assert.equal(published[0].input.severity, "warning");
  const again = await runObserver(apiEnv, now, async () => new Response("{}", { status: 500 }));
  assert.deepEqual(again.learning, { outcome: "recorded", findings: 0 }, "one finding per agent, metric and hour");
  const stored = await readFindings(db as never, new Date(now - 86_400_000).toISOString(), "metric LIKE 'learning_%'");
  assert.equal(stored.length, 2);
  // The Supervisor reads them as advisory cycle findings and proposes nothing.
  const mem = new Map<string, unknown>();
  const memory: any = { get: async (k: string) => mem.get(k), put: async (k: string, v: unknown) => { mem.set(k, v); } };
  const report: any = { agent_id: "supervisor", trigger: "scheduled", cycle_at: new Date(now).toISOString(), findings: [], actions: [] };
  await observerCycle({ ...baseEnv("cryptophys-ai-kernel", db) } as never, memory, report, "scheduled", async () => { throw new Error("no proposal for a learning finding"); }, now);
  assert.deepEqual(report.findings.filter((f: any) => String(f.metric).startsWith("learning_")).map((f: any) => [f.service_id, f.metric, f.advisory]).sort(),
    [["agent:aether-curator", "learning_repeat", true], ["agent:auditor", "learning_volume", true]]);
  // No denial: the spiking agent's next learning call is allowed.
  const next = await evaluatePolicy(db as never, "agent.syscall", "memory.remember", { __subject: "agent:auditor" });
  assert.equal(next.decision, "allow", next.reason);
  assert.equal(n(db, "SELECT COUNT(*) AS n FROM policy_decisions WHERE decision = 'deny'"), 0);
});

test("LO4. learning is allowed in survival with the projected month over the budget; its AI calls are counted as learning and shown, cost not measured", async () => {
  const { env, db } = kernelEnv();
  // Tuesday 2026-11-10 14:00 UTC, market open: $1.50/day x 30 days = $45 > the $30 budget -> survival.
  const TUESDAY = Date.UTC(2026, 10, 10, 14, 0, 0);
  db.raw.prepare("INSERT INTO infra_burn_metrics (metric_id, period_day, service_id, estimated_cost_usd, calculated_at) VALUES ('brn_over', '2026-11-10', 'cryptophys-platform-api', 1.5, '2026-11-10T12:00:00.000Z')").run();
  const state: any = await evaluateMetabolismState(env as never, TUESDAY);
  assert.equal(state.power_mode, "survival", JSON.stringify(state));
  for (let i = 0; i < 3; i++) {
    const r = await syscall(env as never, "auditor", "memory.remember", { kind: "audit_digest", text: `Over-budget note ${i}` });
    assert.equal(r.outcome, "succeeded", JSON.stringify(r));
  }
  const k = await rpcSyscall(env as never, AETHER, "aether-curator", "knowledge.propose", { item: item({ item_id: "k-over-budget" }) });
  assert.equal(k.outcome, "succeeded", JSON.stringify(k));
  const usage = db.raw.prepare("SELECT requests, learning_requests FROM ai_usage WHERE service_id = 'cryptophys-ai-kernel' AND day = ?").get(utcDay()) as any;
  assert.deepEqual([usage.requests, usage.learning_requests], [3, 3], "metered, and counted as learning");
  const view: any = await metabolismView(env as never, Date.now());
  assert.equal(view.learning.ai_requests_today, 3);
  assert.equal(view.learning.ai_requests_today_all, 3);
  assert.equal(view.learning.cost_usd_month, null, "never estimated");
  assert.equal(view.learning.budget_usd_month, 30);
  assert.deepEqual(view.learning.last_hour.map((r: any) => `${r.agent_id}:${r.capability}:${r.count}`).sort(), ["aether-curator:knowledge.propose:1", "auditor:memory.remember:3"]);
  assert.equal(n(db, "SELECT COUNT(*) AS n FROM policy_decisions WHERE decision = 'deny'"), 0);
  // The Organism page shows the learning lines from GET /v1/metabolism and "not measured" otherwise.
  const org = read("workers/console/ui/src/pages/Organism.tsx");
  assert.match(org, /data\?\.learning \?\? \{\}/);
  assert.match(org, /learningCalls === null \? "not measured"/);
  assert.match(org, /typeof lrn\.ai_requests_today === "number" \?/);
  assert.match(org, /typeof lrn\.cost_usd_month === "number" \?/);
  assert.match(read("workers/console/ui/scripts/render-smoke.mjs"), /not measured \(budget \$30\/month\)/);
  // The migration is additive and its indexes are lookups, not unique.
  const sql = read("workers/control-plane-migrations/0070_learning_dedup_observe.sql").replace(/--[^\n]*/g, "");
  assert.doesNotMatch(sql, /\bUNIQUE\b|\bDELETE\b|\bDROP\b/i);
});
