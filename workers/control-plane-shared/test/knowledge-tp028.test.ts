// TP-028: learned-knowledge proposals (RFC_AETHER_KNOWLEDGE_GUARDIAN phase A6). Aether's curator and
// calibrator draft items with knowledge.propose (tier 1) and read their own review status with
// knowledge.status (tier 0); a person who is an approver approves for shadow testing or rejects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import { CAPABILITIES } from "../src/capabilities.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { rpcSyscall } from "../../ai-kernel/src/agent-rpc.ts";
import { decideKnowledge, KNOWLEDGE_ITEM_VERSION, KNOWLEDGE_MAX_PER_DAY, validateKnowledgeItem } from "../../ai-kernel/src/knowledge.ts";

const AETHER = { host_worker: "cryptophys-aether" };
const XAU = { host_worker: "xauusd-ai-trading-assistant" };
const CANON = "1347833f2e6dd1a47f078181215180e387cc94d30d5ba1c9858718bb3a66eb80";
const cards = (n = 12) => Array.from({ length: n }, (_, i) => `d:60:${1793000000000 + i * 3_600_000}:0`);

function item(over: Record<string, unknown> = {}) {
  return {
    schema: KNOWLEDGE_ITEM_VERSION, item_id: "k-prophet-trap", version: 1, kind: "caution", claim_type: "measured_outcome",
    audience: { agents: ["prophet", "moderator"], charts: ["60"] },
    situation: { stuck: "structure", session: "london" },
    text: "When the Prophet structure stayed a bull trap for 8 or more hourly candles, its bearish lean was wrong in 11 of 14 such bars.",
    evidence: { candles: 8, bars: 14, wrong: 11, baseline_wrong_rate: 0.48, p_value: 0.03, window: ["2026-10-08", "2026-11-07"] },
    provenance: { card_ids: cards(), canon_sha: CANON, scoring_version: "v3" },
    ...over,
  };
}

function env(db = migratedDb()) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const e: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async () => { throw new Error("unused"); } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
  };
  return { env: e, db };
}

test("0029 grants knowledge.propose and knowledge.status to the Aether curator and calibrator only", () => {
  const { db } = env();
  assert.equal(CAPABILITIES["knowledge.propose"]!.tier, 1);
  assert.equal(CAPABILITIES["knowledge.propose"]!.max_per_hour, 6);
  assert.equal(CAPABILITIES["knowledge.status"]!.tier, 0);
  const rows = db.raw.prepare("SELECT agent_id, capabilities_json FROM agents").all() as Array<{ agent_id: string; capabilities_json: string }>;
  const holders = (cap: string) => rows.filter((r) => (JSON.parse(r.capabilities_json) as string[]).includes(cap)).map((r) => r.agent_id).sort();
  assert.deepEqual(holders("knowledge.propose"), ["aether-calibrator", "aether-curator"]);
  assert.deepEqual(holders("knowledge.status"), ["aether-calibrator", "aether-curator"]);
  const curator = JSON.parse((rows.find((r) => r.agent_id === "aether-curator"))!.capabilities_json) as string[];
  assert.deepEqual(curator, ["reports.publish", "knowledge.propose", "knowledge.status"], "appended once, in order");
});

test("validator: measured or role claims in plain words, numbers from the evidence, 10+ cited cards, no level, size or order", () => {
  assert.deepEqual(validateKnowledgeItem(item()), []);
  const errs = (over: Record<string, unknown>) => validateKnowledgeItem(item(over));
  assert.ok(errs({ text: "Price rejected 4051 twice, so the lean was wrong in 11 of 14 bars." }).includes("text_price_like_number"));
  assert.ok(errs({ text: "Place a buy limit when the lean was wrong in 11 of 14 bars." }).includes("text_order_wording"));
  assert.ok(errs({ text: "The gmi_dir field was wrong in 11 of 14 bars." }).includes("text_not_natural_language"));
  assert.ok(errs({ text: "Code 3 means a trap; it was wrong in 11 of 14 bars." }).includes("text_not_natural_language"));
  assert.ok(errs({ text: "Its bearish lean was wrong in 12 of 14 such bars." }).some((e) => e.startsWith("text_number_not_in_evidence")), "every number must be measured");
  assert.ok(errs({ provenance: { card_ids: cards(9), canon_sha: CANON } }).includes("provenance_cards"));
  assert.ok(errs({ kind: "role_reminder" }).includes("claim_type_mismatch"));
  assert.ok(errs({ evidence: { bars: 14, wrong: 11, candles: 8, entry: 1 } }).some((e) => e.startsWith("forbidden_key:")));
  assert.ok(errs({ kind: "param_candidate" }).includes("params_invalid"));
  assert.deepEqual(errs({ kind: "param_candidate", params: { family: "gmi_v12_70", grid: "TUNING_GRID.gmi_v12_70.stateMaxAge", values: { stateMaxAge: 16 }, hypothesis: "fewer holds in trends", metric: "paired sign test" } }), []);
});

test("Aether's curator proposes through AgentRpc; xauusd and the other Aether agents cannot; denials are final", async () => {
  const { env: e, db } = env();
  const ok = await rpcSyscall(e as never, AETHER, "aether-curator", "knowledge.propose", { item: item() });
  assert.equal(ok.outcome, "succeeded", JSON.stringify(ok));
  const proposal = (ok as { result: { proposal: Record<string, unknown> } }).result.proposal;
  assert.match(String(proposal.proposal_id), /^knw_[0-9a-f-]{36}$/);
  assert.equal(proposal.status, "pending");
  assert.match(String(proposal.content_sha256), /^[0-9a-f]{64}$/);

  assert.equal((await rpcSyscall(e as never, AETHER, "aether-auditor", "knowledge.propose", { item: item({ item_id: "k-other" }) })).outcome, "denied", "not granted");
  const cross = await rpcSyscall(e as never, XAU, "aether-curator", "knowledge.propose", { item: item() }) as { outcome: string; reason: string };
  assert.deepEqual([cross.outcome, cross.reason], ["denied", "agent_not_hosted_by_caller"], "xauusd cannot act as an Aether agent");
  const dup = await rpcSyscall(e as never, AETHER, "aether-curator", "knowledge.propose", { item: item() });
  assert.equal(dup.outcome, "failed");
  assert.match((dup as { reason: string }).reason, /knowledge_item_version_exists/);
  const bad = await rpcSyscall(e as never, AETHER, "aether-calibrator", "knowledge.propose", { item: item({ item_id: "k-bad", text: "Held 4051 in 11 of 14 bars." }) });
  assert.equal(bad.outcome, "failed");
  assert.match((bad as { reason: string }).reason, /text_price_like_number/);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM knowledge_proposals").get() as { n: number }).n, 1);

  const status = await rpcSyscall(e as never, AETHER, "aether-curator", "knowledge.status", {});
  assert.equal(status.outcome, "succeeded");
  const mine = (status as { result: { proposals: Array<Record<string, unknown>> } }).result.proposals;
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.status, "pending");
  assert.equal("item" in mine[0]!, false, "status carries no item body");
  const other = await rpcSyscall(e as never, AETHER, "aether-calibrator", "knowledge.status", {});
  assert.equal((other as { result: { proposals: unknown[] } }).result.proposals.length, 0, "an agent sees only its own proposals");
});

test("a person approves or rejects once, through the kernel API; operators and tokens cannot; the audit chain holds", async () => {
  const { env: e, db } = env();
  const a = await rpcSyscall(e as never, AETHER, "aether-curator", "knowledge.propose", { item: item() });
  const b = await rpcSyscall(e as never, AETHER, "aether-calibrator", "knowledge.propose", { item: item({ item_id: "k-second" }) });
  const idA = String((a as any).result.proposal.proposal_id);
  const idB = String((b as any).result.proposal.proposal_id);

  const list = await call(kernel as never, e, req("GET", "/v1/knowledge", undefined, OPERATOR_JWT));
  assert.equal(list.status, 200);
  assert.equal(list.body.proposals.length, 2);
  assert.equal(list.body.counts.pending, 2);
  const one = await call(kernel as never, e, req("GET", `/v1/knowledge/${idA}`, undefined, OPERATOR_JWT));
  assert.equal(one.body.item.item_id, "k-prophet-trap");

  assert.equal((await call(kernel as never, e, req("POST", `/v1/knowledge/${idA}/approve`, {}, OPERATOR_JWT))).status, 403, "an operator is not an approver");
  assert.equal((await call(kernel as never, e, req("POST", `/v1/knowledge/${idA}/approve`, {}))).status, 403, "a service token never approves");
  const approved = await call(kernel as never, e, req("POST", `/v1/knowledge/${idA}/approve`, { reason: "approved for shadow testing" }, APPROVER_JWT));
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.status, "approved");
  assert.equal((await call(kernel as never, e, req("POST", `/v1/knowledge/${idA}/reject`, {}, APPROVER_JWT))).status, 409, "decided once");
  const rejected = await call(kernel as never, e, req("POST", `/v1/knowledge/${idB}/reject`, { reason: "too few sessions" }, APPROVER_JWT));
  assert.equal(rejected.body.status, "rejected");

  const status = await rpcSyscall(e as never, AETHER, "aether-curator", "knowledge.status", {});
  const row = (status as any).result.proposals[0];
  assert.deepEqual([row.status, row.decided_by], ["approved", APPROVER_EMAIL]);
  const events = db.raw.prepare("SELECT event_type FROM audit_events WHERE event_type LIKE 'knowledge.%' ORDER BY event_type").all() as Array<{ event_type: string }>;
  assert.deepEqual(events.map((x) => x.event_type), ["knowledge.approved", "knowledge.proposed", "knowledge.proposed", "knowledge.rejected"]);
  assert.equal((await verifyAuditChain(db as never)).valid, true);

  await assert.rejects(decideKnowledge(db as never, idA, "approve", "agent:aether-curator", null), (err: { code?: string }) => err.code === "person_required", "an agent never reviews");
});

test("pending proposals expire after 14 days, and each agent proposes at most 20 a day", async () => {
  const { env: e, db } = env();
  const a = await rpcSyscall(e as never, AETHER, "aether-curator", "knowledge.propose", { item: item() });
  const id = String((a as any).result.proposal.proposal_id);
  db.raw.prepare("UPDATE knowledge_proposals SET created_at = ? WHERE proposal_id = ?").run(new Date(Date.now() - 15 * 86_400_000).toISOString(), id);
  const late = await call(kernel as never, e, req("POST", `/v1/knowledge/${id}/approve`, {}, APPROVER_JWT));
  assert.equal(late.status, 409);
  assert.equal(late.body.error ?? late.body.code, "not_pending");

  assert.equal(KNOWLEDGE_MAX_PER_DAY, 20);
  const today = new Date().toISOString();
  const insert = db.raw.prepare("INSERT INTO knowledge_proposals (proposal_id, proposer_agent_id, item_id, item_version, kind, item_json, content_sha256, status, decision_id, created_at) VALUES (?, 'aether-calibrator', ?, 1, 'caution', '{}', 'x', 'rejected', 'dec', ?)");
  for (let i = 0; i < 20; i++) insert.run(`knw_00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`, `k-fill-${i}`, today);
  const over = await rpcSyscall(e as never, AETHER, "aether-calibrator", "knowledge.propose", { item: item({ item_id: "k-over" }) });
  assert.equal(over.outcome, "failed");
  assert.match((over as { reason: string }).reason, /knowledge_daily_limit/);
});
