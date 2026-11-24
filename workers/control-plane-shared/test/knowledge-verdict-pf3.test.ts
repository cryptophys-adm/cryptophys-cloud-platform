// PF3 (owner 2026-11-24, "harus dibuat jalurnya untuk feedback loop"): the knowledge.verdict write-back. xauusd's
// shadow-knowledge arm reports its verdict on an autonomous knowledge item (caution, role_reminder) to the platform; the
// proposer (Aether's curator or calibrator) reads it back with knowledge.status, and the Console shows it.
// - knowledge.verdict is tier 1, reversible and learning (no rate limit, no power-mode denial, never refused for its
//   reason: secrets redacted, prices masked). Only XAUUSD_CEILING grants it, to SHADOW_KNOWLEDGE_AGENT, and nothing else
//   to that agent; EXTERNAL_CEILING is not widened. No migration seeds the agent: the census registers it.
// - Migration 0088 adds knowledge_verdicts (additive); knowledge_proposals is not altered and its status never changes.
// The learning-mandate side (100 calls an hour in survival, the kill switch) is LM11 in learning-mandate-2026-11-14.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, call, migratedDb, req } from "./harness.ts";
import { CAPABILITIES, hourlyLimit } from "../src/capabilities.ts";
import { isLearningCapability, survivalDenies } from "../src/power-mode.ts";
import {
  AETHER_CEILING, EXTERNAL_CEILING, EXTERNAL_ORIGINS, SHADOW_KNOWLEDGE_AGENT, XAUUSD_CEILING, externalCeilingFor, externalCeilingViolations, externalOrgans,
  type Genome,
} from "../src/organism.ts";
import { castVote, privilegedCapabilities, type Evidence, type Proposal } from "../src/consensus-rules.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import { destructiveMigration } from "../src/migration-rules.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { rpcSyscall } from "../../ai-kernel/src/agent-rpc.ts";
import { compare } from "../../forge/src/census.ts";
import { proposalFor, type CensusRow } from "../../ai-kernel/src/organism.ts";
import {
  KNOWLEDGE_ITEM_VERSION, KNOWLEDGE_VERDICTS, TERMINAL_VERDICTS, VERDICT_EVIDENCE_KEYS, getKnowledge, knowledgeStatus, listKnowledge, validateVerdictInput,
} from "../../ai-kernel/src/knowledge.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const AI = "xauusd-ai-trading-assistant";
const XAU = { host_worker: AI };
const AETHER = { host_worker: "cryptophys-aether" };
const SHADOW = SHADOW_KNOWLEDGE_AGENT;
const CAP = "knowledge.verdict";
const XAUUSD = EXTERNAL_ORIGINS.find((o) => o.origin === "xauusd")!;
const AETHER_ORIGIN = EXTERNAL_ORIGINS.find((o) => o.origin === "aether")!;
const CANON = "1347833f2e6dd1a47f078181215180e387cc94d30d5ba1c9858718bb3a66eb80";
const cards = () => Array.from({ length: 12 }, (_, i) => `d:60:${1793000000000 + i * 3_600_000}:0`);

const caution = (itemId: string) => ({
  schema: KNOWLEDGE_ITEM_VERSION, item_id: itemId, version: 1, kind: "caution", claim_type: "measured_outcome", label: "learned",
  audience: { agents: ["prophet", "moderator"], charts: ["60"] },
  situation: { chart: "60", session: "london" },
  text: "On the hourly chart in the London session, the prophet agent was wrong in 79% of its decisive calls over 30 days, against 48% in its other situations.",
  evidence: { agent: "prophet", chart: "60", session: "london", window_days: 30, decisive: 14, wrong: 11, wrong_pct: 79, baseline_wrong_pct: 48, baseline_decisive: 20, p_value: 0.03 },
  provenance: { card_ids: cards(), canon_sha: CANON, canon_version: "aether.canon.v1", source: "aether" },
});

/** The census's routine register_agent, once xauusd's DNA declares the agent (no migration seeds it). */
function registerShadow(db: Db, host = AI) {
  const at = new Date().toISOString();
  db.raw.prepare(`INSERT INTO agents (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at)
    VALUES (?, 'Shadow Knowledge', ?, 'test', 1, '["knowledge.verdict"]', 'enabled', NULL, 'consensus:test', ?, ?)`).run(SHADOW, host, at, at);
}

function setup() {
  const db = migratedDb();
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async () => { throw new Error("unused"); } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
  };
  const verdicts = () => db.raw.prepare("SELECT * FROM knowledge_verdicts ORDER BY rowid").all() as any[];
  const events = (type: string) => db.raw.prepare("SELECT event_type, actor, subject, outcome, payload_json FROM audit_events WHERE event_type = ? ORDER BY rowid").all(type) as any[];
  const propose = async (itemId: string, agent = "aether-curator") => {
    const r = await rpcSyscall(env as never, AETHER, agent, "knowledge.propose", { item: caution(itemId) }) as any;
    assert.equal(r.outcome, "succeeded", JSON.stringify(r));
    return r.result.proposal.proposal_id as string;
  };
  const verdict = (over: Record<string, unknown> = {}) => rpcSyscall(env as never, XAU, SHADOW, CAP, {
    item_id: "k-prophet-trap", item_version: 1, verdict: "not_better",
    reason: "The treated arm did not beat the control arm over the window.",
    evidence: { arm: "treat", window_start: "2026-11-10T00:00:00Z", window_end: "2026-11-23T00:00:00Z", rows: 140, scored: 35, treat_hits: 9, control_hits: 26, aa_changed: 0, aa_total: 20, p_value: 0.41237, p_holm: 0.82, charts: ["60", "240"], rule: "holm_0.05+aa" },
    ...over,
  }) as Promise<any>;
  return { db, env, verdicts, events, propose, verdict };
}

// ------------------------------------------------------------------------------------------- 1. the catalog and the ceiling

test("PF3-1. knowledge.verdict is tier 1, reversible, learning; only XAUUSD_CEILING grants it, to shadow-knowledge alone, holding nothing else", () => {
  assert.equal(SHADOW, "shadow-knowledge");
  assert.deepEqual([CAPABILITIES[CAP].tier, CAPABILITIES[CAP].reversible, CAPABILITIES[CAP].max_per_hour], [1, true, undefined]);
  assert.equal(isLearningCapability(CAP), true);
  assert.equal(hourlyLimit(CAP), null, "no rate limit");
  assert.equal(survivalDenies(CAP, [CAP]), false, "never denied by a power mode, even if listed");
  assert.deepEqual(privilegedCapabilities([CAP]), [], "a routine registration, no owner click for the agent");
  // XAUUSD_CEILING: shadow-knowledge holds knowledge.verdict and nothing else, not even EXTERNAL_CEILING.
  assert.deepEqual([...XAUUSD_CEILING.agents[SHADOW]], [CAP]);
  assert.deepEqual(externalCeilingFor(XAUUSD, SHADOW), { tier_max: 1, capabilities: [CAP], proposals: [] });
  assert.deepEqual(Object.entries(XAUUSD_CEILING.agents).filter(([, caps]) => caps.includes(CAP)).map(([id]) => id), [SHADOW]);
  assert.ok(!XAUUSD_CEILING.capabilities.includes(CAP));
  assert.deepEqual([...EXTERNAL_CEILING.capabilities], ["signals.observe", "reports.publish", "memory.recall", "memory.remember"], "EXTERNAL_CEILING is not widened");
  assert.ok(!Object.values(AETHER_CEILING.agents).some((caps) => caps.includes(CAP)) && !AETHER_CEILING.capabilities.includes(CAP), "no Aether agent reports verdicts");
  for (const o of EXTERNAL_ORIGINS) for (const id of [undefined, "hud-prophet", "xauusd-moderator", "nexus-teacher", "aether-curator", "cta-editor"]) {
    assert.ok(!externalCeilingFor(o, id).capabilities.includes(CAP), `${o.origin}/${id}`);
  }
  // A census gene that puts it on another agent, or anything else on shadow-knowledge, is refused.
  const xau = (id: string, capabilities: string[]) => externalCeilingViolations({ id, tier_max: 1, voter: false, capabilities }, XAUUSD);
  assert.deepEqual(xau(SHADOW, [CAP]), []);
  assert.deepEqual(xau(SHADOW, [CAP, "reports.publish"]), ["capability reports.publish"]);
  assert.deepEqual(xau(SHADOW, [CAP, "knowledge.status"]), ["capability knowledge.status"]);
  assert.deepEqual(externalCeilingViolations({ id: SHADOW, tier_max: 2, voter: true, capabilities: [CAP] }, XAUUSD), ["tier_max 2", "council seat"]);
  assert.deepEqual(xau("nexus-teacher", ["corrections.record", CAP]), [`capability ${CAP}`]);
  assert.deepEqual(xau("hud-prophet", [...EXTERNAL_CEILING.capabilities, CAP]), [`capability ${CAP}`]);
  assert.deepEqual(externalCeilingViolations({ id: "aether-curator", tier_max: 1, capabilities: [...AETHER_CEILING.agents["aether-curator"], CAP] }, AETHER_ORIGIN), [`capability ${CAP}`]);
  // The one constant names the agent: organism.ts uses it, not a second literal.
  const src = read("workers/control-plane-shared/src/organism.ts");
  assert.equal(src.match(/"shadow-knowledge"/g)?.length, 1, "the id is written once");
  assert.match(src, /\[SHADOW_KNOWLEDGE_AGENT\]: Object\.freeze\(\["knowledge\.verdict"\]\)/);
  // The guard paths PF3 touches: one owner change.
  assert.equal(criticalPathReason("workers/control-plane-shared/src/capabilities.ts"), "evolution_guard");
  assert.equal(criticalPathReason("workers/control-plane-shared/src/power-mode.ts"), "learning_mandate");
  assert.equal(criticalPathReason("workers/control-plane-shared/src/organism.ts"), "capability_ceiling");
  assert.equal(criticalPathReason("workers/control-plane-shared/test/learning-mandate-2026-11-14.test.ts"), "learning_mandate");
  assert.equal(criticalPathReason("workers/ai-kernel/src/knowledge.ts"), null);
});

test("PF3-2. no migration seeds shadow-knowledge; a ceiling entry for an agent that does not exist breaks nothing; the census registers it as routine", async () => {
  for (const f of ["0086_nexus_teacher.sql", "0087_hud_mizan_oracle.sql", "0088_knowledge_verdicts.sql"]) assert.doesNotMatch(read(`workers/control-plane-migrations/${f}`), /'shadow-knowledge'/, f);
  const db = migratedDb();
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM agents WHERE agent_id = ?").get(SHADOW)!.n, 0, "not registered by any migration");
  const live = (db.raw.prepare("SELECT agent_id, capabilities_json FROM agents WHERE host_worker = ? ORDER BY agent_id").all(AI) as Array<{ agent_id: string; capabilities_json: string }>)
    .map((r) => ({ id: r.agent_id, display_name: r.agent_id, capabilities: JSON.parse(r.capabilities_json), tier_max: 1, voter: false }));
  const organ = (agents: unknown[]) => ({ $schema_version: 1, service: AI, display_name: AI, kind: "service", deploy_unit: null, access: false, rollback: false, drift: { via: "rpc", binding: "EXT_XAUUSD_AI" }, agents, engines: [] });
  const genomeOf = (agents: unknown[]) => {
    const { organs, refused } = externalOrgans(XAUUSD, { schema: XAUUSD.schema, organs: [organ(agents)] });
    const g: Genome = new Map(organs.map((o) => [o.service, o]));
    return { g, refused };
  };
  // Before xauusd's DNA declares it: the ceiling entry alone makes no finding and refuses nothing.
  const before = genomeOf(live);
  assert.deepEqual(before.refused, []);
  const quiet = await compare(db as never, before.g);
  assert.ok(!quiet.some((f) => f.subject === SHADOW), JSON.stringify(quiet));
  assert.ok(!quiet.some((f) => f.kind === "agent_capabilities_changed" || f.kind === "undeclared_agent"), JSON.stringify(quiet));
  // Once it declares it with exactly its ceiling: unregistered_agent, then the routine register_agent the voters approve.
  const declared = genomeOf([...live, { id: SHADOW, display_name: "Shadow Knowledge", capabilities: [CAP], tier_max: 1, voter: false }]);
  assert.deepEqual(declared.refused, []);
  const findings = await compare(db as never, declared.g);
  assert.deepEqual(findings.filter((f) => f.subject === SHADOW).map((f) => f.kind), ["unregistered_agent"]);
  const census: CensusRow = { main_sha: "a".repeat(40), status: "changes", findings, genome: [...declared.g.values()].map((d) => ({ service: d.service, kind: d.kind, agents: d.agents, engines: [], origin: "xauusd" })) };
  const p = proposalFor(census, { kind: "unregistered_agent", subject: SHADOW })!;
  assert.deepEqual([p.action, p.target, p.params.capabilities, p.params.tier_max, p.params.service], ["register_agent", SHADOW, [CAP], 1, AI]);
  const e = {
    agents_enabled: true, audit_valid: true, critical_reports_24h: 0, services: [], recovery_plans: [], deploys: [], proposals_last_hour: 0,
    agents: {}, registry: { [AI]: { status: "healthy" } },
  } as unknown as Evidence;
  const proposal = (caps: string[], action = "register_agent") => ({ proposal_id: "cns_t", action, target: SHADOW, class: "routine", params: { service: AI, capabilities: caps, tier_max: 1, main_sha: "a".repeat(40) } }) as unknown as Proposal;
  assert.equal(castVote("platform-api", proposal([CAP]), e).vote, "approve");
  assert.match(castVote("platform-api", proposal([CAP, "reports.publish"]), e).reason, /above the external-organ ceiling: capability reports\.publish/);
  // A DNA that declares more is refused by the ceiling, left out of the genome (a finding, never a proposal).
  const over = genomeOf([...live, { id: SHADOW, display_name: "Shadow Knowledge", capabilities: [CAP, "memory.remember"], tier_max: 1, voter: false }]);
  assert.deepEqual(over.refused.map((r) => [r.kind, r.subject]), [["external_agent_refused", SHADOW]]);
});

// ------------------------------------------------------------------------------------------- 2. the migration

test("PF3-3. migration 0088 applies on node:sqlite: knowledge_verdicts with its CHECKs, the unique dedup index; additive, applies twice", () => {
  const sql = read("workers/control-plane-migrations/0088_knowledge_verdicts.sql");
  assert.equal(destructiveMigration(sql), false, "routine under migration-rules.ts");
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /ALTER\s+TABLE|INSERT|UPDATE|DELETE|DROP/i, "no change to knowledge_proposals or any row");
  assert.match(read("workers/control-plane-migrations/test_migrations.py"), /PASS: 0088 knowledge_verdicts/);
  const db = migratedDb();
  const cols = (db.raw.prepare("PRAGMA table_info(knowledge_verdicts)").all() as Array<{ name: string; notnull: number }>).map((c) => `${c.name}${c.notnull ? "" : "?"}`);
  assert.deepEqual(cols, ["verdict_id", "proposal_id", "item_id", "item_version", "verdict", "terminal", "reason", "evidence_json", "reporter_agent_id", "window_end?", "created_at"]);
  const idx = db.raw.prepare("SELECT name, \"unique\" AS u FROM pragma_index_list('knowledge_verdicts') ORDER BY name").all() as Array<{ name: string; u: number }>;
  assert.deepEqual(idx.filter((i) => !i.name.startsWith("sqlite_autoindex")).map((i) => [i.name, i.u]), [["idx_knowledge_verdicts_dedup", 1], ["idx_knowledge_verdicts_proposal", 0]]);
  const fks = (db.raw.prepare("PRAGMA foreign_key_list(knowledge_verdicts)").all() as Array<{ table: string; from: string }>).map((f) => `${f.from}->${f.table}`).sort();
  assert.deepEqual(fks, ["proposal_id->knowledge_proposals", "reporter_agent_id->agents"]);
  // The CHECKs, on a proposal and an agent that exist.
  db.raw.prepare(`INSERT INTO knowledge_proposals (proposal_id, proposer_agent_id, item_id, item_version, kind, item_json, content_sha256, status, decision_id, created_at)
    VALUES ('knw_00000000-0000-4000-8000-000000000000', 'aether-curator', 'k-x', 1, 'caution', '{}', ?, 'pending', 'dec_x', '2026-11-24T00:00:00.000Z')`).run("0".repeat(64));
  const ins = db.raw.prepare(`INSERT INTO knowledge_verdicts (verdict_id, proposal_id, item_id, item_version, verdict, terminal, reason, evidence_json, reporter_agent_id, window_end, created_at)
    VALUES (?, 'knw_00000000-0000-4000-8000-000000000000', 'k-x', 1, ?, ?, ?, ?, 'aether-curator', ?, '2026-11-24T00:00:00.000Z')`);
  const ok = ["kvd_1", "not_better", 1, "A reason that is long enough.", "{}", null] as const;
  ins.run(...ok);
  const bad: Array<[number, unknown]> = [[0, "xyz_2"], [0, null], [1, "great"], [2, 0], [2, 2], [3, "short"], [3, "r".repeat(301)], [4, "not json"], [4, "[1]"]];
  for (const [i, v] of bad) {
    const row: unknown[] = [...ok]; row[0] = `kvd_bad_${i}_${String(v).length}`; row[i] = v;
    assert.throws(() => ins.run(...(row as never[])), /constraint/i, `column ${i} ${String(v).slice(0, 12)}`);
  }
  ins.run("kvd_2", "collecting", 0, "Still collecting rows here.", "{}", null);
  assert.throws(() => ins.run("kvd_3", "not_better", 1, "The same verdict again, no window.", "{}", null), /UNIQUE/i, "one row per (proposal, verdict, window_end or '')");
  ins.run("kvd_4", "not_better", 1, "The same verdict, another window.", "{}", "2026-11-23T00:00:00.000Z");
  assert.throws(() => ins.run("kvd_5", "not_better", 1, "The same verdict, the same window.", "{}", "2026-11-23T00:00:00.000Z"), /UNIQUE/i);
  assert.throws(() => db.raw.prepare(`INSERT INTO knowledge_verdicts (verdict_id, proposal_id, item_id, item_version, verdict, terminal, reason, evidence_json, reporter_agent_id, created_at)
    VALUES ('kvd_6', 'knw_missing', 'k-x', 1, 'live', 1, 'A reason that is long enough.', '{}', 'aether-curator', 't')`).run(), /FOREIGN KEY/i);
  // Applied again (IF NOT EXISTS): nothing changes, every row kept.
  const schema = () => db.raw.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
  const s0 = schema();
  db.raw.exec(sql);
  assert.deepEqual(schema(), s0);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM knowledge_verdicts").get()!.n, 3);
  // On the schema before it, it adds exactly the table and its indexes.
  const raw = new DatabaseSync(":memory:");
  const names = () => new Set((raw.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map((r) => r.name));
  const dir = new URL("workers/control-plane-migrations/", ROOT);
  for (const f of (db.raw.prepare("SELECT name FROM d1_migrations ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name).filter((n) => n < "0088_")) raw.exec(readFileSync(new URL(f, dir), "utf8"));
  const pre = names();
  raw.exec(sql);
  assert.deepEqual([...names()].filter((n) => !pre.has(n)).sort(), ["idx_knowledge_verdicts_dedup", "idx_knowledge_verdicts_proposal", "knowledge_verdicts", "sqlite_autoindex_knowledge_verdicts_1"]);
  raw.close();
});

// ------------------------------------------------------------------------------------------- 3. validation

test("PF3-4. validation: the verdict list, the reason's length, the closed evidence list; prices masked and secrets redacted, never refused for them", () => {
  assert.deepEqual([...KNOWLEDGE_VERDICTS], ["live", "retired", "not_better", "worse", "holdout_failed", "collecting", "inconclusive", "not_tested"]);
  assert.deepEqual([...TERMINAL_VERDICTS], ["live", "retired", "not_better", "worse", "holdout_failed"]);
  assert.deepEqual([...VERDICT_EVIDENCE_KEYS], ["arm", "window_start", "window_end", "rows", "scored", "treat_hits", "control_hits", "aa_changed", "aa_total", "p_value", "p_holm", "charts", "rule"]);
  const base = { item_id: "k-prophet-trap", item_version: 1, verdict: "worse", reason: "The treated arm lost against the control arm." };
  const errs = (over: Record<string, unknown>) => { const r = validateVerdictInput({ ...base, ...over }); return r.ok ? [] : r.errors; };
  assert.deepEqual(errs({}), [], "evidence is optional");
  for (const v of KNOWLEDGE_VERDICTS) assert.deepEqual(errs({ verdict: v }), [], v);
  for (const v of ["great", "LIVE", "", null, 1, "promoted"]) assert.deepEqual(errs({ verdict: v }), ["verdict_invalid"], String(v));
  assert.deepEqual(errs({ item_id: "prophet-trap" }), ["item_id_invalid"]);
  assert.deepEqual(errs({ item_version: 0 }), ["item_version_invalid"]);
  assert.deepEqual(errs({ item_version: "1" }), ["item_version_invalid"]);
  assert.deepEqual(errs({ reason: "too short" }), ["reason_length"]);
  assert.deepEqual(errs({ reason: "x".repeat(301) }), ["reason_length"]);
  assert.deepEqual(errs({ reason: `  ${"y".repeat(10)}​  ` }), [], "normalized before it is measured");
  assert.deepEqual(errs({ reason: undefined }), ["reason_length"]);
  // Forbidden keys (self-model.ts) at the top and in the evidence; any other key is refused too.
  assert.deepEqual(errs({ price: 4095 }), ["forbidden_key:price"]);
  assert.deepEqual(errs({ evidence: { entry_price: 4095 } }), ["evidence_forbidden_key:entry_price"]);
  assert.deepEqual(errs({ evidence: { tp1: 1 } }), ["evidence_forbidden_key:tp1"]);
  assert.deepEqual(errs({ evidence: { stopLoss: 1 } }), ["evidence_forbidden_key:stopLoss"]);
  assert.deepEqual(errs({ evidence: { supportLevel: "x" } }), ["evidence_forbidden_key:supportLevel"]);
  assert.deepEqual(errs({ evidence: { note: "fine" } }), ["evidence_unknown_key:note"]);
  assert.deepEqual(errs({ evidence: { rows: 3, extra: { price: 1 } } }), ["evidence_unknown_key:extra"]);
  assert.deepEqual(errs({ schema: "x" }), ["unknown_key:schema"]);
  assert.deepEqual(errs({ evidence: [1] }), ["evidence_not_object"]);
  assert.deepEqual(errs({ evidence: "rows=3" }), ["evidence_not_object"]);
  // Each evidence key's shape.
  for (const k of ["rows", "scored", "treat_hits", "control_hits", "aa_changed", "aa_total"]) {
    assert.deepEqual(errs({ evidence: { [k]: 0 } }), [], k);
    for (const v of [-1, 1.5, "3", Number.NaN, 2 ** 60]) assert.deepEqual(errs({ evidence: { [k]: v } }), [`evidence_${k}_invalid`], `${k} ${v}`);
  }
  for (const k of ["p_value", "p_holm"]) for (const v of [-0.01, 1.01, "0.5", Number.POSITIVE_INFINITY]) assert.deepEqual(errs({ evidence: { [k]: v } }), [`evidence_${k}_invalid`], `${k} ${v}`);
  for (const v of ["2026-11-24", "2026-11-24T00:00:00+07:00", "yesterday", 1, "2026-13-40T00:00:00Z"]) assert.deepEqual(errs({ evidence: { window_end: v } }), ["evidence_window_end_invalid"], String(v));
  assert.deepEqual(errs({ evidence: { window_start: "2026-11-24T00:00:00Z", window_end: "2026-11-23T00:00:00Z" } }), ["evidence_window_order"]);
  assert.deepEqual(errs({ evidence: { charts: ["15", "60", "240", "1440", "d1", "m15_london"] } }), []);
  // The agreed token rule, verbatim: 1-4 digits or a short lower-case token (so "1D" is sent as "1d").
  assert.deepEqual(errs({ evidence: { charts: ["1d", "12345"] } }), []);
  for (const v of [["60m!"], ["1D"], ["a".repeat(17)], [""], Array.from({ length: 9 }, (_, i) => String(i)), "60", [60]]) assert.deepEqual(errs({ evidence: { charts: v } }), ["evidence_charts_invalid"], JSON.stringify(v));
  assert.deepEqual(errs({ evidence: { rule: "holm_0.05+aa", arm: "treat" } }), []);
  for (const v of ["Holm", "x".repeat(41), "a b", "min_rows_120", "4095"]) assert.deepEqual(errs({ evidence: { rule: v } }), ["evidence_rule_invalid"], v);
  for (const v of ["Treat", "a".repeat(33), "arm_4095", "a+b"]) assert.deepEqual(errs({ evidence: { arm: v } }), ["evidence_arm_invalid"], v);
  // Normalized: p rounded to 4 decimals, times as ISO UTC with milliseconds; a price in the reason masked, a secret redacted.
  const r = validateVerdictInput({ ...base, reason: `Lost twice near 4,095.50 and 4100; token sk-${"a".repeat(24)} was in the log.`, evidence: { p_value: 0.123456, p_holm: 1, window_end: "2026-11-23T00:00Z", window_start: "2026-11-10T00:00:00.5Z" } });
  assert.ok(r.ok);
  assert.equal(r.value.reason, "Lost twice near [level] and [level]; token [redacted] was in the log.");
  assert.deepEqual(r.value.evidence, { p_value: 0.1235, p_holm: 1, window_end: "2026-11-23T00:00:00.000Z", window_start: "2026-11-10T00:00:00.500Z" });
  const long = validateVerdictInput({ ...base, reason: `${"z".repeat(290)} 4095 4095` });
  assert.ok(long.ok && long.value.reason.length === 300, "masking that lengthens the text is cut at 300");
});

// ------------------------------------------------------------------------------------------- 4. the call

test("PF3-5. shadow-knowledge records a verdict on a caution; the proposal is untouched; the reason stays out of agent_actions and the chain", async () => {
  const s = setup();
  const pid = await s.propose("k-prophet-trap");
  registerShadow(s.db);
  const r = await s.verdict({ reason: "Treat 9 hits against control 26 near 4,095.5, so it is not better." });
  assert.equal(r.outcome, "succeeded", JSON.stringify(r));
  assert.equal(r.tier, 1);
  assert.match(r.result.verdict_id, /^kvd_[0-9a-f-]{36}$/);
  assert.deepEqual({ ...r.result, verdict_id: "kvd", created_at: "t" }, {
    verdict_id: "kvd", proposal_id: pid, item_id: "k-prophet-trap", item_version: 1, verdict: "not_better", terminal: true,
    reason: "Treat 9 hits against control 26 near [level], so it is not better.",
    evidence: { arm: "treat", window_start: "2026-11-10T00:00:00.000Z", window_end: "2026-11-23T00:00:00.000Z", rows: 140, scored: 35, treat_hits: 9, control_hits: 26, aa_changed: 0, aa_total: 20, p_value: 0.4124, p_holm: 0.82, charts: ["60", "240"], rule: "holm_0.05+aa" },
    window_end: "2026-11-23T00:00:00.000Z", created_at: "t", deduplicated: false,
  });
  const [row] = s.verdicts();
  assert.deepEqual([row.reporter_agent_id, row.terminal, row.window_end, row.reason.includes("4,095")], [SHADOW, 1, "2026-11-23T00:00:00.000Z", false]);
  assert.equal((s.db.raw.prepare("SELECT status FROM knowledge_proposals WHERE proposal_id = ?").get(pid) as any).status, "pending", "a verdict is no review");
  // Metered (a tier 1 decision, consumed), audited without the reason.
  assert.equal(s.db.raw.prepare("SELECT COUNT(*) AS n FROM agent_syscall_consumptions WHERE agent_id = ? AND capability = ?").get(SHADOW, CAP)!.n, 1);
  const [ev] = s.events("knowledge.verdict");
  assert.deepEqual([ev.actor, ev.subject, ev.outcome], [`agent:${SHADOW}`, "k-prophet-trap@1", "not_better"]);
  assert.deepEqual(JSON.parse(ev.payload_json), { verdict_id: r.result.verdict_id, proposal_id: pid, proposer: "agent:aether-curator", terminal: true, window_end: "2026-11-23T00:00:00.000Z" });
  const action = s.db.raw.prepare("SELECT input_json FROM agent_actions WHERE agent_id = ? AND capability = ?").get(SHADOW, CAP) as any;
  assert.doesNotMatch(action.input_json, /4,095|Treat 9 hits/, "the raw reason never reaches agent_actions");
  assert.deepEqual(JSON.parse(action.input_json), { item_id: "k-prophet-trap", item_version: 1, verdict: "not_better", reason_chars: 66, evidence_keys: 13, omitted: "the reason is kept in knowledge_verdicts only, masked" });
  // A refused call keeps no raw value either.
  const refused = await s.verdict({ item_id: "item 4095", verdict: "price 4095", reason: "Secret sk-" + "c".repeat(30) + " was here." });
  assert.equal(refused.outcome, "failed");
  const fail = (s.db.raw.prepare("SELECT input_json FROM agent_actions WHERE agent_id = ? AND outcome = 'failed'").get(SHADOW) as any).input_json;
  assert.doesNotMatch(fail, /4095|sk-c/);
  assert.equal((await verifyAuditChain(s.db as never)).valid, true);
});

test("PF3-6. an unknown proposal is a 404-style error; a param_candidate is refused; a bad input writes nothing", async () => {
  const s = setup();
  await s.propose("k-prophet-trap");
  registerShadow(s.db);
  const unknown = await s.verdict({ item_id: "k-never-proposed" });
  assert.deepEqual([unknown.outcome, unknown.reason], ["failed", "knowledge_proposal_not_found: k-never-proposed@1"]);
  assert.deepEqual([(await s.verdict({ item_version: 2 })).reason], ["knowledge_proposal_not_found: k-prophet-trap@2"]);
  s.db.raw.prepare(`INSERT INTO knowledge_proposals (proposal_id, proposer_agent_id, item_id, item_version, kind, item_json, content_sha256, status, decision_id, created_at)
    VALUES ('knw_00000000-0000-4000-8000-0000000000aa', 'aether-calibrator', 'k-param-prophet-r37-statemaxage-16', 1, 'param_candidate', '{}', ?, 'approved', 'dec_x', ?)`).run("1".repeat(64), new Date().toISOString());
  const param = await s.verdict({ item_id: "k-param-prophet-r37-statemaxage-16", verdict: "live" });
  assert.equal(param.outcome, "failed");
  assert.match(param.reason, /^knowledge_verdict_kind_refused: param_candidate/);
  const bad = await s.verdict({ verdict: "great", evidence: { entry_price: 4095, rows: -1 } });
  assert.equal(bad.outcome, "failed");
  assert.match(bad.reason, /^invalid_knowledge_verdict: verdict_invalid; evidence_forbidden_key:entry_price; evidence_rows_invalid$/);
  assert.equal(s.verdicts().length, 0);
  assert.equal(s.events("knowledge.verdict").length, 0);
});

test("PF3-7. only shadow-knowledge, hosted where its DNA put it, may call it; nexus-teacher, the moderator, Aether and kernel agents are denied", async () => {
  const s = setup();
  await s.propose("k-prophet-trap");
  // Before the census registers it: refused as unregistered.
  const early = await s.verdict();
  assert.equal(early.outcome, "denied");
  registerShadow(s.db);
  assert.equal((await rpcSyscall(s.env as never, AETHER, SHADOW, CAP, {}) as any).reason, "agent_not_hosted_by_caller");
  for (const [props, id] of [[XAU, "nexus-teacher"], [XAU, "xauusd-moderator"], [XAU, "hud-prophet"], [AETHER, "aether-curator"], [AETHER, "knowledge-council"]] as const) {
    const r = await rpcSyscall(s.env as never, props, id, CAP, { item_id: "k-prophet-trap", item_version: 1, verdict: "live", reason: "It went live for the hourly chart." }) as any;
    assert.equal(r.outcome, "denied", `${id}: ${JSON.stringify(r)}`);
    assert.match(r.reason, /capability_granted/);
  }
  assert.equal((await syscall(s.env as never, "supervisor", CAP, {})).outcome, "denied");
  // shadow-knowledge holds nothing else.
  for (const cap of ["knowledge.status", "knowledge.propose", "reports.publish", "memory.remember", "corrections.record"]) {
    const r = await rpcSyscall(s.env as never, XAU, SHADOW, cap, {}) as any;
    assert.equal(r.outcome, "denied", cap);
  }
  assert.equal(s.verdicts().length, 0);
});

test("PF3-8. idempotent on (proposal, verdict, window_end): a repeat returns the stored row with deduplicated: true", async () => {
  const s = setup();
  await s.propose("k-prophet-trap");
  registerShadow(s.db);
  const first = await s.verdict();
  const again = await s.verdict({ reason: "Another wording of the same verdict, same window." , evidence: { window_end: "2026-11-23T00:00:00.000Z", rows: 999 } });
  assert.equal(again.outcome, "succeeded");
  assert.deepEqual({ ...again.result, deduplicated: false }, first.result, "the stored row, unchanged");
  assert.equal(again.result.deduplicated, true);
  const nextWindow = await s.verdict({ evidence: { window_end: "2026-11-24T00:00:00Z" } });
  assert.equal(nextWindow.result.deduplicated, false);
  const otherVerdict = await s.verdict({ verdict: "worse" });
  assert.equal(otherVerdict.result.deduplicated, false);
  const noWindow1 = await s.verdict({ verdict: "not_tested", reason: "The arm never ran on this chart.", evidence: {} });
  const noWindow2 = await s.verdict({ verdict: "not_tested", reason: "The arm never ran on this chart.", evidence: undefined });
  assert.deepEqual([noWindow1.result.deduplicated, noWindow2.result.deduplicated, noWindow2.result.verdict_id], [false, true, noWindow1.result.verdict_id]);
  assert.equal(s.verdicts().length, 4);
  assert.equal(s.events("knowledge.verdict").length, 4, "a repeat writes no audit event of its own");
});

test("PF3-9. the proposal is found in any status, from any proposer; the newest when several match", async () => {
  const s = setup();
  const insert = (id: string, agent: string, status: string, at: string) => s.db.raw.prepare(`INSERT INTO knowledge_proposals (proposal_id, proposer_agent_id, item_id, item_version, kind, item_json, content_sha256, status, decision_id, created_at, decided_at)
    VALUES (?, ?, 'k-shared', 3, 'role_reminder', '{}', ?, ?, 'dec_x', ?, ?)`).run(id, agent, "2".repeat(64), status, at, status === "pending" ? null : at);
  insert("knw_00000000-0000-4000-8000-0000000000c1", "aether-curator", "expired", "2026-11-01T00:00:00.000Z");
  insert("knw_00000000-0000-4000-8000-0000000000c2", "aether-calibrator", "rejected", "2026-11-05T00:00:00.000Z");
  registerShadow(s.db);
  const r = await s.verdict({ item_id: "k-shared", item_version: 3, verdict: "retired" });
  assert.equal(r.outcome, "succeeded", JSON.stringify(r));
  assert.equal(r.result.proposal_id, "knw_00000000-0000-4000-8000-0000000000c2", "the newest, a rejected one of another proposer");
  assert.deepEqual(s.db.raw.prepare("SELECT status FROM knowledge_proposals WHERE item_id = 'k-shared' ORDER BY proposal_id").all().map((x: any) => x.status), ["expired", "rejected"], "no status changed");
});

// ------------------------------------------------------------------------------------------- 5. back to Aether and the Console

test("PF3-10. knowledge.status gives the curator each own proposal's item_version and latest verdict (null when none); the Console list and detail too", async () => {
  const s = setup();
  const tested = await s.propose("k-prophet-trap");
  const quiet = await s.propose("k-quiet-trap");
  const other = await s.propose("k-calibrator-trap", "aether-calibrator");
  registerShadow(s.db);
  assert.equal((await s.verdict({ verdict: "collecting", reason: "Collecting shadow rows for the arm.", evidence: { rows: 120, window_end: "2026-11-20T00:00:00Z" } })).outcome, "succeeded");
  // The newest verdict wins, whatever its kind.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await s.verdict()).outcome, "succeeded");
  assert.equal((await s.verdict({ item_id: "k-calibrator-trap", verdict: "live", reason: "It went live for the hourly chart.", evidence: { treat_hits: 30, control_hits: 12 } })).outcome, "succeeded");
  const st = await rpcSyscall(s.env as never, AETHER, "aether-curator", "knowledge.status", {}) as any;
  assert.equal(st.outcome, "succeeded", JSON.stringify(st));
  const byId = new Map(st.result.proposals.map((p: any) => [p.proposal_id, p]));
  assert.deepEqual([...byId.keys()].sort(), [tested, quiet].sort(), "its own proposals only");
  const t: any = byId.get(tested);
  assert.equal(t.item_version, 1);
  assert.equal(t.status, "pending");
  assert.deepEqual(Object.keys(t.latest_verdict).sort(), ["created_at", "evidence", "reason", "terminal", "verdict"]);
  assert.deepEqual([t.latest_verdict.verdict, t.latest_verdict.terminal, t.latest_verdict.evidence.treat_hits, t.latest_verdict.evidence.control_hits], ["not_better", true, 9, 26]);
  assert.equal((byId.get(quiet) as any).latest_verdict, null);
  assert.equal("item" in t, false, "no item bodies, as before");
  // The kernel's Console list: latest_verdict on every row; a pending one with a terminal verdict is counted apart.
  const list = await listKnowledge(s.db as never, { limit: 50 }) as any;
  const rows = new Map(list.proposals.map((p: any) => [p.proposal_id, p]));
  assert.equal((rows.get(tested) as any).latest_verdict.verdict, "not_better");
  assert.equal((rows.get(other) as any).latest_verdict.verdict, "live");
  assert.equal((rows.get(quiet) as any).latest_verdict, null);
  assert.deepEqual(list.counts, { pending: 3 });
  assert.deepEqual(list.verdicts, { pending_tested: 2 }, "not_better and live are terminal; the quiet one is plain pending");
  const one = await getKnowledge(s.db as never, tested) as any;
  assert.equal(one.latest_verdict.verdict, "not_better");
  // Over HTTP, as the Console reads it.
  const res = await call(kernel as never, s.env, req("GET", "/v1/knowledge", undefined, APPROVER_JWT));
  assert.equal(res.status, 200);
  const body = res.body as any;
  assert.equal(body.proposals.find((p: any) => p.proposal_id === tested).latest_verdict.verdict, "not_better");
  assert.equal(body.verdicts.pending_tested, 2);
  // A proposal created and expired outside the 30-day window still comes back while a verdict on it is recent.
  s.db.raw.prepare("UPDATE knowledge_proposals SET created_at = '2026-01-01T00:00:00.000Z', status = 'expired', decided_at = '2026-01-15T00:00:00.000Z' WHERE proposal_id = ?").run(tested);
  const old = await knowledgeStatus(s.db as never, "aether-curator", {}, Date.now()) as any;
  assert.ok(old.proposals.some((p: any) => p.proposal_id === tested && p.latest_verdict?.verdict === "not_better"));
  // ... and a pending one with a terminal verdict that expired is no longer counted as pending_tested.
  assert.deepEqual(((await listKnowledge(s.db as never)) as any).verdicts, { pending_tested: 1 });
});

test("PF3-11. before migration 0088 the reads answer as before, with latest_verdict null", async () => {
  const s = setup();
  const pid = await s.propose("k-prophet-trap");
  s.db.raw.exec("DROP TABLE knowledge_verdicts");
  const st = await knowledgeStatus(s.db as never, "aether-curator", {}) as any;
  assert.deepEqual(st.proposals.map((p: any) => [p.proposal_id, p.latest_verdict]), [[pid, null]]);
  const list = await listKnowledge(s.db as never) as any;
  assert.deepEqual([list.proposals[0].latest_verdict, list.verdicts.pending_tested], [null, null]);
});

// ------------------------------------------------------------------------------------------- 6. the docs

test("PF3-12. the SSOT carries PF3's entry on line 5, and the xauusd agent lists name shadow-knowledge", () => {
  const ssot = read("docs/SSOT.md");
  const line = ssot.split("\n").find((l) => l.startsWith("Last reviewed: "))!;
  assert.match(line, /^Last reviewed: 2026-11-16 \((?:[^\n]*; )?Knowledge verdict write-back \(PF3\)/);
  assert.ok(line.includes(`Knowledge verdict write-back (PF3), 2026-11-24 (owner: "harus dibuat jalurnya untuk feedback loop"): `));
  for (const want of ["`knowledge.verdict`", "`shadow-knowledge`", "Migration 0088", "`knowledge.status`", "LM11", "`merge_owner_change`"]) assert.ok(line.includes(want), want);
  assert.match(ssot, /\*\*External origins[^\n]*`shadow-knowledge` with `knowledge\.verdict` only/);
  assert.match(read("docs/XAUUSD-INTEGRATION.md"), /`shadow-knowledge`[^\n]*`knowledge\.verdict`/);
});
