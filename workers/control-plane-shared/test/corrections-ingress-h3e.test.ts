// HAIC H3e (docs/design/HAIC-H3.md §7.1–§7.3, §8 and §11 step 5; the owner's answers of 2026-11-19, "Setuju semua
// rekomendasi"): the Nexus ingress and the Aether pull of the corrections ledger.
// - corrections.record (tier 1, learning): only nexus-teacher (migration 0086, XAUUSD_CEILING) holds it, and holds
//   nothing else. Weight 3 only for an attested actor who is an owner of the platform, else weight 1, never refused.
//   Secrets redacted, prices masked, deduplicated, audited; the text never reaches agent_actions or the audit chain.
// - corrections.read (tier 0): only aether-curator (AETHER_CEILING) holds it; the nexus corrections, oldest first, by a
//   cursor of created_at and correction_id, at most 50 a call (the council.decisions.read pattern).
// The learning-mandate side (100 calls an hour in survival, no max_per_hour, the kill switch) is LM10 in
// learning-mandate-2026-11-14.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, migratedDb, lastReviewedRecord } from "./harness.ts";
import { CAPABILITIES, hourlyLimit } from "../src/capabilities.ts";
import { isLearningCapability } from "../src/power-mode.ts";
import { AETHER_CEILING, EXTERNAL_CEILING, EXTERNAL_ORIGINS, XAUUSD_CEILING, externalCeilingFor, externalCeilingViolations } from "../src/organism.ts";
import { privilegedCapabilities } from "../src/consensus-rules.ts";
import { validateCorrection } from "../src/correction.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import { destructiveMigration } from "../src/migration-rules.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { rpcSyscall } from "../../ai-kernel/src/agent-rpc.ts";
import { NEXUS_READ_MAX, recordCorrection } from "../../ai-kernel/src/corrections.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const AI = "xauusd-ai-trading-assistant";
const NEXUS = { host_worker: AI };
const AETHER = { host_worker: "cryptophys-aether" };
const TEACHER = "nexus-teacher";
const CURATOR = "aether-curator";
const XAUUSD = EXTERNAL_ORIGINS.find((o) => o.origin === "xauusd")!;
const AETHER_ORIGIN = EXTERNAL_ORIGINS.find((o) => o.origin === "aether")!;

function setup() {
  const db = migratedDb();
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async () => { throw new Error("unused"); } },
  };
  const rows = () => db.raw.prepare("SELECT correction_id, side, source, label, actor, attested_by, weight, body_json, created_at FROM corrections ORDER BY rowid").all() as any[];
  const events = (type: string) => db.raw.prepare("SELECT event_type, actor, subject, outcome, payload_json FROM audit_events WHERE event_type = ? ORDER BY rowid").all(type) as any[];
  return { db, env, rows, events };
}
/** Aether's DNA declares the curator's corrections.read and the census's routine update_agent_capabilities applies it. */
function grantCuratorRead(db: Db) {
  db.raw.prepare("UPDATE agents SET capabilities_json = ? WHERE agent_id = ?").run(JSON.stringify([...AETHER_CEILING.agents[CURATOR]]), CURATOR);
}
const nexusCorrection = (over: Record<string, unknown> = {}) => ({
  side: "nexus", source: "nexus_card", label: "owner_correction", rating: "down", category: "reading_wrong",
  target: { ref: "ev:xauusd/card/d_20261122_0900", subject: "seat:prophet", as_of: "2026-11-22T09:00:00Z" },
  text: "The card read a breakout the session did not confirm.", evidence_refs: ["ev:xauusd/room_run/r_20261122_0900#step_3"],
  actor: `owner:${APPROVER_EMAIL}`, ...over,
});

// ------------------------------------------------------------------------------------------- 1. the catalog and the ceilings

test("H3e-1. corrections.record is tier 1 learning, corrections.read tier 0 read only; only nexus-teacher and aether-curator may hold them", () => {
  assert.deepEqual([CAPABILITIES["corrections.record"].tier, CAPABILITIES["corrections.record"].reversible, CAPABILITIES["corrections.record"].max_per_hour], [1, true, undefined]);
  assert.deepEqual([CAPABILITIES["corrections.read"].tier, CAPABILITIES["corrections.read"].reversible, CAPABILITIES["corrections.read"].max_per_hour], [0, true, undefined]);
  assert.equal(isLearningCapability("corrections.record"), true);
  assert.equal(isLearningCapability("corrections.read"), false, "a read is not learning");
  assert.deepEqual([hourlyLimit("corrections.record"), hourlyLimit("corrections.read")], [null, null]);
  assert.deepEqual(privilegedCapabilities(["corrections.record", "corrections.read"]), [], "neither needs a privileged registration");
  // XAUUSD_CEILING: nexus-teacher holds corrections.record and nothing else; EXTERNAL_CEILING is not widened.
  assert.deepEqual([...XAUUSD_CEILING.agents[TEACHER]], ["corrections.record"]);
  assert.deepEqual(externalCeilingFor(XAUUSD, TEACHER), { tier_max: 1, capabilities: ["corrections.record"], proposals: [] });
  assert.deepEqual([...EXTERNAL_CEILING.capabilities], ["signals.observe", "reports.publish", "memory.recall", "memory.remember"]);
  assert.deepEqual([...XAUUSD_CEILING.capabilities], [...EXTERNAL_CEILING.capabilities]);
  assert.deepEqual(Object.entries(XAUUSD_CEILING.agents).filter(([, caps]) => caps.includes("corrections.record")).map(([id]) => id), [TEACHER]);
  // AETHER_CEILING: the curator reads, nobody else does; no Aether agent records.
  assert.ok(AETHER_CEILING.agents[CURATOR].includes("corrections.read"));
  assert.deepEqual(Object.entries(AETHER_CEILING.agents).filter(([, caps]) => caps.includes("corrections.read")).map(([id]) => id), [CURATOR]);
  assert.ok(!Object.values(AETHER_CEILING.agents).some((caps) => caps.includes("corrections.record")));
  // A census gene that puts either on another agent is refused (a finding, never a proposal).
  const xau = (id: string, capabilities: string[]) => externalCeilingViolations({ id, tier_max: 1, voter: false, capabilities }, XAUUSD);
  assert.deepEqual(xau("hud-prophet", [...EXTERNAL_CEILING.capabilities, "corrections.record"]), ["capability corrections.record"]);
  assert.deepEqual(xau("xauusd-moderator", [...EXTERNAL_CEILING.capabilities, "council.decisions.read", "corrections.record"]), ["capability corrections.record"]);
  assert.deepEqual(xau("xauusd-new", ["corrections.record"]), ["capability corrections.record"]);
  assert.deepEqual(xau(TEACHER, ["corrections.record", "reports.publish"]), ["capability reports.publish"], "nexus-teacher holds corrections.record only");
  assert.deepEqual(xau(TEACHER, ["corrections.record", "corrections.read"]), ["capability corrections.read"]);
  assert.deepEqual(xau(TEACHER, ["corrections.record"]), []);
  const aeth = (id: string, capabilities: string[]) => externalCeilingViolations({ id, tier_max: 1, voter: false, capabilities }, AETHER_ORIGIN);
  assert.deepEqual(aeth("aether-calibrator", ["reports.publish", "knowledge.propose", "knowledge.status", "corrections.read"]), ["capability corrections.read"]);
  assert.deepEqual(aeth(CURATOR, [...AETHER_CEILING.agents[CURATOR], "corrections.record"]), ["capability corrections.record"]);
  assert.deepEqual(aeth(CURATOR, [...AETHER_CEILING.agents[CURATOR]]), []);
  // The guard paths H3e touches (§8): one owner change.
  assert.equal(criticalPathReason("workers/control-plane-shared/src/capabilities.ts"), "evolution_guard");
  assert.equal(criticalPathReason("workers/control-plane-shared/src/power-mode.ts"), "learning_mandate");
  assert.equal(criticalPathReason("workers/control-plane-shared/src/organism.ts"), "capability_ceiling");
  assert.equal(criticalPathReason("workers/control-plane-shared/test/learning-mandate-2026-11-14.test.ts"), "learning_mandate");
});

test("H3e-2. migration 0086 registers nexus-teacher additively: the xauusd AI Worker, tier 1, corrections.record only, no seat", () => {
  const sql = read("workers/control-plane-migrations/0086_nexus_teacher.sql");
  assert.equal(destructiveMigration(sql), false, "routine under migration-rules.ts");
  assert.match(sql, /INSERT OR IGNORE INTO agents/);
  assert.match(read("workers/control-plane-migrations/test_migrations.py"), /PASS: 0086 nexus-teacher/);
  const { db } = setup();
  const r = db.raw.prepare("SELECT host_worker, tier_max, capabilities_json, status, voter FROM agents WHERE agent_id = ?").get(TEACHER) as any;
  assert.deepEqual([r.host_worker, r.tier_max, JSON.parse(r.capabilities_json), r.status, r.voter], [AI, 1, ["corrections.record"], "enabled", 0]);
  assert.equal(externalCeilingViolations({ id: TEACHER, tier_max: r.tier_max, voter: false, capabilities: JSON.parse(r.capabilities_json) }, XAUUSD).length, 0, "within its ceiling");
});

// ------------------------------------------------------------------------------------------- 2. the Nexus ingress

test("H3e-3. nexus-teacher can call corrections.record, and only that", async () => {
  const s = setup();
  const ok = await rpcSyscall(s.env as never, NEXUS, TEACHER, "corrections.record", nexusCorrection()) as any;
  assert.equal(ok.outcome, "succeeded", JSON.stringify(ok));
  assert.deepEqual(Object.keys(ok.result).sort(), ["correction_id", "deduplicated", "redactions"], "the POST's answer: id, deduplicated, redactions");
  assert.match(ok.result.correction_id, /^cor_[0-9a-f]{16}$/);
  assert.equal(ok.result.deduplicated, false);
  for (const cap of ["corrections.read", "reports.publish", "memory.remember", "memory.recall", "signals.observe", "council.decisions.read", "knowledge.propose"]) {
    const r = await rpcSyscall(s.env as never, NEXUS, TEACHER, cap, { kind: "info", text: "x", cursor: null }) as any;
    assert.equal(r.outcome, "denied", `${cap}: ${JSON.stringify(r)}`);
    assert.match(r.reason, /capability_granted/, cap);
  }
  // Only the xauusd AI Worker acts as nexus-teacher (the binding's pinned host).
  assert.equal((await rpcSyscall(s.env as never, AETHER, TEACHER, "corrections.record", nexusCorrection()) as any).reason, "agent_not_hosted_by_caller");
  assert.equal(s.rows().length, 1);
});

test("H3e-4. weight 3 only for an attested owner; any other actor is recorded at weight 1, never refused; side nexus, attested by Nexus", async () => {
  const s = setup();
  const rec = async (over: Record<string, unknown>) => {
    const r = await rpcSyscall(s.env as never, NEXUS, TEACHER, "corrections.record", nexusCorrection(over)) as any;
    assert.equal(r.outcome, "succeeded", JSON.stringify(r));
    return s.rows().find((x) => x.correction_id === r.result.correction_id);
  };
  // The owner, as owner:<email> or the bare email, in any case.
  const owner = await rec({ actor: `owner:${APPROVER_EMAIL.toUpperCase()}`, target: { ref: "ev:xauusd/card/d_w1", subject: "seat:prophet", as_of: null } });
  assert.deepEqual([owner.actor, owner.weight, owner.side, owner.attested_by], [`owner:${APPROVER_EMAIL}`, 3, "nexus", "xauusd_nexus_access"]);
  assert.equal((await rec({ actor: APPROVER_EMAIL, target: { ref: "ev:xauusd/card/d_w2", subject: "seat:prophet", as_of: null } })).weight, 3);
  // An operator is not an owner (Q9); nor is anyone Nexus attests who is not in the owner list.
  const operator = await rec({ actor: `owner:${OPERATOR_EMAIL}`, target: { ref: "ev:xauusd/card/d_w3", subject: "seat:prophet", as_of: null } });
  assert.deepEqual([operator.actor, operator.weight], [`nexus:${OPERATOR_EMAIL}`, 1]);
  const outsider = await rec({ actor: "owner:someone@example.com", target: { ref: "ev:xauusd/card/d_w4", subject: "seat:prophet", as_of: null } });
  assert.deepEqual([outsider.actor, outsider.weight], ["nexus:someone@example.com", 1]);
  // No attested actor at all: still recorded, as the sender, weight 1.
  const none = await rec({ actor: undefined, target: { ref: "ev:xauusd/card/d_w5", subject: "seat:prophet", as_of: null } });
  assert.deepEqual([none.actor, none.weight], [`agent:${TEACHER}`, 1]);
  const junk = await rec({ actor: "not an email", target: { ref: "ev:xauusd/card/d_w6", subject: "seat:prophet", as_of: null } });
  assert.deepEqual([junk.actor, junk.weight], [`agent:${TEACHER}`, 1]);
  // What the platform decides is never taken from the input: weight, attestation, side.
  const claimed = await rec({ actor: "owner:someone@example.com", weight: 3, attested_by: "cerebrum_access", target: { ref: "ev:xauusd/card/d_w7", subject: "seat:prophet", as_of: null } });
  assert.deepEqual([claimed.weight, claimed.attested_by, claimed.side], [1, "xauusd_nexus_access", "nexus"]);
  const noSide = await rec({ side: undefined, label: undefined, category: undefined, text: undefined, rating: "up", target: { ref: "ev:xauusd/engine_decision/b_1", subject: "seat:decision_council", as_of: null } });
  assert.deepEqual([noSide.side, noSide.label, noSide.weight], ["nexus", "owner_rating", 3]);
  // Every stored record is a valid correction.v1.
  for (const r of s.rows()) assert.deepEqual(validateCorrection(JSON.parse(r.body_json)), [], r.correction_id);
});

test("H3e-5. never refused for its content: a secret is redacted, a price masked, a long text truncated; the text stays out of agent_actions and the audit chain", async () => {
  const s = setup();
  const secret = `ghp_${"b".repeat(36)}`;
  const r = await rpcSyscall(s.env as never, NEXUS, TEACHER, "corrections.record", nexusCorrection({
    text: `Token ${secret} leaked; the stop at 2,345.6 was too tight. ${"z".repeat(600)}`, category: "invalidation_too_tight",
    evidence_refs: ["ev:xauusd/card/d_20261122_0900#entry_price", "not a ref"],
  })) as any;
  assert.equal(r.outcome, "succeeded", JSON.stringify(r));
  assert.deepEqual(r.result.redactions, ["secret", "price", "truncated"]);
  const row = s.rows()[0];
  const body = JSON.parse(row.body_json);
  assert.ok(!row.body_json.includes(secret) && !row.body_json.includes("2,345.6"), "the ledger holds neither the secret nor the price");
  assert.match(body.text, /\[level\]/);
  assert.ok(body.text.length <= 500);
  assert.deepEqual(body.evidence_refs, ["ev:xauusd/card/d_20261122_0900"], "a priced ref loses its field; an unparsed one is dropped");
  assert.equal(body.invalid_refs, 1);
  assert.deepEqual(validateCorrection(body), []);
  assert.equal(s.events("correction.secret_redacted").length, 1);
  // The action row and every audit event carry no text: the raw input never leaves the call.
  const actions = s.db.raw.prepare("SELECT input_json, result_json FROM agent_actions WHERE agent_id = ? AND capability = 'corrections.record'").all(TEACHER) as any[];
  assert.equal(actions.length, 1);
  const audit = JSON.stringify(s.db.raw.prepare("SELECT payload_json FROM audit_events").all());
  for (const text of [actions[0].input_json, actions[0].result_json, audit]) {
    assert.ok(!text.includes(secret), "no secret");
    assert.ok(!text.includes("2,345.6") && !text.includes("leaked") && !text.includes("[level]"), "no text at all");
  }
  assert.deepEqual(JSON.parse(actions[0].input_json).text_chars > 500, true, "only the text's length is kept");
  // An unknown category is kept as other, never refused.
  const odd = await rpcSyscall(s.env as never, NEXUS, TEACHER, "corrections.record", nexusCorrection({ category: "vibes_off", target: { ref: "ev:xauusd/card/d_odd", subject: "seat:prophet", as_of: null } })) as any;
  assert.equal(odd.outcome, "succeeded");
  assert.deepEqual([JSON.parse(s.rows()[1].body_json).category, JSON.parse(s.rows()[1].body_json).category_raw], ["other", "vibes_off"]);
});

test("H3e-6. dedup: the same correction twice returns the same id and writes nothing; a changed one is a new row superseding it", async () => {
  const s = setup();
  const first = await rpcSyscall(s.env as never, NEXUS, TEACHER, "corrections.record", nexusCorrection()) as any;
  const again = await rpcSyscall(s.env as never, NEXUS, TEACHER, "corrections.record", nexusCorrection({ text: "  The card read a breakout   the session did not confirm. " })) as any;
  assert.deepEqual([again.outcome, again.result.correction_id, again.result.deduplicated], ["succeeded", first.result.correction_id, true]);
  assert.equal(s.rows().length, 1, "nothing written");
  assert.deepEqual(s.events("correction.deduplicated").map((e) => JSON.parse(e.payload_json).correction_id), [first.result.correction_id]);
  const changed = await rpcSyscall(s.env as never, NEXUS, TEACHER, "corrections.record", nexusCorrection({ rating: "up", category: "good_call", text: null })) as any;
  assert.equal(changed.result.deduplicated, false);
  assert.equal(JSON.parse(s.rows()[1].body_json).supersedes, first.result.correction_id);
  // Another actor's identical correction is its own row.
  const other = await rpcSyscall(s.env as never, NEXUS, TEACHER, "corrections.record", nexusCorrection({ actor: "owner:someone@example.com" })) as any;
  assert.equal(other.result.deduplicated, false);
  assert.equal(s.rows().length, 3);
});

test("H3e-7. only structural errors fail, and write nothing: another side, a Cerebrum source, a label Nexus does not send, a parameter key, no target", async () => {
  const s = setup();
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ side: "cerebrum" }, /invalid_side/],
    [{ source: "chat_rating" }, /invalid_source/],
    [{ source: undefined }, /invalid_source/],
    [{ label: "owner_decision" }, /invalid_label/],
    [{ label: "reviewer_correction" }, /invalid_label/],
    [{ params: { stop: 1 } }, /forbidden_key/],
    [{ target: { ref: "ev:xauusd/card/d_1", subject: "seat:prophet", as_of: null, entry_price: 1 } }, /forbidden_key/],
    [{ target: null }, /invalid_target/],
    [{ rating: null, category: null, text: null }, /empty/],
  ];
  for (const [over, reason] of cases) {
    const r = await rpcSyscall(s.env as never, NEXUS, TEACHER, "corrections.record", nexusCorrection(over)) as any;
    assert.equal(r.outcome, "failed", JSON.stringify(over));
    assert.match(r.reason, reason, JSON.stringify(over));
  }
  assert.equal(s.rows().length, 0);
  // Each failed call is still recorded as an agent action.
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE agent_id = ? AND outcome = 'failed'").get(TEACHER) as any).n, cases.length);
});

test("H3e-8. every record is audited: correction.recorded with the row, agent.action for the call; the chain verifies", async () => {
  const s = setup();
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await rpcSyscall(s.env as never, NEXUS, TEACHER, "corrections.record", nexusCorrection({ target: { ref: `ev:xauusd/council/cs_${i}#seq_${i + 1}`, subject: "seat:moderator", as_of: null }, source: "nexus_council" })) as any;
    assert.equal(r.outcome, "succeeded", JSON.stringify(r));
    ids.push(r.result.correction_id);
  }
  const recorded = s.events("correction.recorded");
  assert.deepEqual(recorded.map((e) => JSON.parse(e.payload_json).correction_id), ids);
  for (const e of recorded) {
    const p = JSON.parse(e.payload_json);
    assert.deepEqual([e.actor, p.weight, p.label], [`owner:${APPROVER_EMAIL}`, 3, "owner_correction"]);
    assert.equal("text" in p, false, "no text in the chain");
  }
  const actions = s.events("agent.action").filter((e) => e.actor === `agent:${TEACHER}` && e.subject === "corrections.record");
  assert.equal(actions.length, 5);
  assert.ok(actions.every((e) => e.outcome === "succeeded"));
  assert.equal((await verifyAuditChain(s.db as never)).valid, true);
});

// ------------------------------------------------------------------------------------------- 3. the Aether pull

test("H3e-9. aether-curator reads the nexus corrections by cursor, oldest first, at most 50 a call; never a Cerebrum one", async () => {
  const s = setup();
  grantCuratorRead(s.db);
  const ctx = { actor: `owner:${APPROVER_EMAIL}`, owner: true, attested_by: "xauusd_nexus_access" as const };
  const at = (i: number) => new Date(Date.parse("2026-11-22T00:00:00.000Z") + i * 60_000).toISOString();
  // Written newest first, so oldest-first is the read's order, not the insert's.
  for (let i = 119; i >= 0; i--) {
    await recordCorrection(s.db as never, { side: "nexus", source: "nexus_room", rating: "down", category: "evidence_wrong", target: { ref: `ev:xauusd/room_run/r_${i}#step_1`, subject: "seat:prophet", as_of: null } }, { ...ctx, now: at(i) });
  }
  // Two with the same time: the correction id breaks the tie, and the cursor still steps over both.
  await recordCorrection(s.db as never, { side: "nexus", source: "nexus_card", rating: "up", target: { ref: "ev:xauusd/card/d_tie_a", subject: "seat:prophet", as_of: null } }, { ...ctx, now: at(200) });
  await recordCorrection(s.db as never, { side: "nexus", source: "nexus_card", rating: "up", target: { ref: "ev:xauusd/card/d_tie_b", subject: "seat:prophet", as_of: null } }, { ...ctx, now: at(200) });
  // Cerebrum's own corrections are never served to Aether.
  for (let i = 0; i < 3; i++) {
    await recordCorrection(s.db as never, { side: "cerebrum", source: "chat_rating", rating: "up", target: { ref: `ev:platform/conversation/cnv_0123456789abcdef#turn_${i + 1}`, subject: "model:m", as_of: null } }, { actor: `owner:${APPROVER_EMAIL}`, owner: true, attested_by: "cerebrum_access", now: at(i) });
  }
  assert.equal(NEXUS_READ_MAX, 50);
  const seen: any[] = [];
  const pages: number[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < 6; n++) {
    const r = await rpcSyscall(s.env as never, AETHER, CURATOR, "corrections.read", { cursor }) as any;
    assert.equal(r.outcome, "succeeded", JSON.stringify(r));
    assert.equal(r.tier, 0);
    assert.equal(r.result.available, true);
    pages.push(r.result.corrections.length);
    seen.push(...r.result.corrections);
    if (!r.result.corrections.length) { assert.equal(r.result.next_cursor, cursor, "an empty page keeps the cursor"); break; }
    const last = r.result.corrections.at(-1);
    assert.equal(r.result.next_cursor, `${last.created_at}|${last.correction_id}`);
    cursor = r.result.next_cursor;
  }
  assert.deepEqual(pages, [50, 50, 22, 0]);
  assert.equal(seen.length, 122);
  assert.equal(new Set(seen.map((c) => c.correction_id)).size, 122, "no record twice");
  assert.ok(seen.every((c) => c.side === "nexus"), "never a Cerebrum correction");
  const order = seen.map((c) => `${c.created_at}|${c.correction_id}`);
  assert.deepEqual(order, [...order].sort(), "oldest first, by created_at then correction_id");
  assert.equal(seen[0].created_at, at(0));
  for (const c of seen) assert.deepEqual(validateCorrection(c), [], c.correction_id);
  // side may be named and must be nexus; a bad cursor is an error, not an empty page.
  assert.equal((await rpcSyscall(s.env as never, AETHER, CURATOR, "corrections.read", { cursor: null, side: "nexus" }) as any).result.corrections.length, 50);
  const cerebrum = await rpcSyscall(s.env as never, AETHER, CURATOR, "corrections.read", { side: "cerebrum" }) as any;
  assert.deepEqual([cerebrum.outcome, cerebrum.reason], ["failed", "invalid_side"]);
  const bad = await rpcSyscall(s.env as never, AETHER, CURATOR, "corrections.read", { cursor: "yesterday" }) as any;
  assert.deepEqual([bad.outcome, bad.reason], ["failed", "invalid_cursor"]);
  // Each read that returned records is audited as correction.delivered, with ids only.
  const delivered = s.events("correction.delivered");
  assert.equal(delivered.length, 4, "three pages, and the side: nexus read");
  assert.deepEqual(delivered.map((e) => JSON.parse(e.payload_json).count), [50, 50, 22, 50]);
  assert.ok(delivered.every((e) => e.actor === `agent:${CURATOR}`));
  assert.equal(s.db.raw.prepare("SELECT COUNT(*) AS n FROM corrections").get()!.n, 125, "a read writes no correction");
});

test("H3e-10. an agent not granted is denied both: corrections.record and corrections.read", async () => {
  const s = setup();
  grantCuratorRead(s.db);
  for (const [props, id] of [[NEXUS, "xauusd-moderator"], [NEXUS, "hud-prophet"], [AETHER, CURATOR], [AETHER, "aether-calibrator"], [AETHER, "knowledge-council"]] as const) {
    const r = await rpcSyscall(s.env as never, props, id, "corrections.record", nexusCorrection()) as any;
    assert.equal(r.outcome, "denied", `${id}: ${JSON.stringify(r)}`);
    assert.match(r.reason, /capability_granted/);
  }
  for (const [props, id] of [[NEXUS, TEACHER], [NEXUS, "xauusd-moderator"], [AETHER, "aether-calibrator"], [AETHER, "aether-guardian"]] as const) {
    const r = await rpcSyscall(s.env as never, props, id, "corrections.read", { cursor: null }) as any;
    assert.equal(r.outcome, "denied", `${id}: ${JSON.stringify(r)}`);
    assert.match(r.reason, /capability_granted/);
  }
  // Kernel agents hold neither.
  assert.equal((await syscall(s.env as never, "supervisor", "corrections.record", nexusCorrection())).outcome, "denied");
  assert.equal((await syscall(s.env as never, "auditor", "corrections.read", {})).outcome, "denied");
  assert.equal(s.rows().length, 0);
  assert.equal(s.events("correction.delivered").length, 0);
  // Before Aether's DNA declares it, the curator itself is not granted either.
  const s2 = setup();
  assert.match((await rpcSyscall(s2.env as never, AETHER, CURATOR, "corrections.read", {}) as any).reason, /capability_granted/);
});

test("H3e-11. the SSOT: line 5 carries H3e's entry, the collaboration section lists H3e as built, and the ceilings name the two agents", () => {
  const ssot = read("docs/SSOT.md");
  const line = lastReviewedRecord();
  // Later changes put their own entries first on line 5 (2026-11-22: "begins with" failed every branch after H3e).
  assert.ok(line.startsWith("Last reviewed: 2026-11-16 ("));
  assert.ok(line.includes(`(HAIC H3e, 2026-11-22 (owner: "ya kerjakan nomor 1 dan semuanya"; the H3 answers of 2026-11-19, "Setuju semua rekomendasi"): `) || line.includes(`; HAIC H3e, 2026-11-22 (owner: "ya kerjakan nomor 1 dan semuanya"; the H3 answers of 2026-11-19, "Setuju semua rekomendasi"): `), "H3e's entry");
  for (const want of ["`corrections.record`", "`corrections.read`", "`nexus-teacher`", "`aether-curator`", "Migration 0086", "LM10", "`merge_owner_change`"]) assert.ok(line.includes(want), want);
  assert.ok(line.indexOf("HAIC H3e, 2026-11-22") < line.indexOf("HAIC H3d, 2026-11-19"), "H3e before H3d");
  assert.match(ssot, /\*\*Built on the platform:\*\* H0 [^\n]*the Nexus ingress and the Aether pull \(H3e/);
  assert.match(ssot, /\*\*Not built yet:\*\* H3f–H3h /);
  assert.match(ssot, /\*\*External origins[^\n]*`nexus-teacher` with `corrections\.record` only[^\n]*`aether-curator` may also hold the read-only `corrections\.read`/);
  assert.match(read("docs/design/HAIC-H3.md"), /^Status: accepted by the owner on 2026-11-19; H3a–H3d built; H3e built on 2026-11-22/m);
});

test("H3e-12. the syscall gate reaches the ledger only through the H3e entry points; the ledger's imports are unchanged", () => {
  const uses = [...read("workers/ai-kernel/src/syscall.ts").matchAll(/^import \{([^}]+)\} from "\.\/corrections\.ts";/gm)].flatMap((m) => m[1].split(",").map((x) => x.trim()).filter(Boolean)).sort();
  assert.deepEqual(uses, ["nexusActorEmail", "readNexusCorrections", "recordNexusCorrection"]);
  // The decision is verified and consumed before the record (metered, as every tier 1 target), then the owner is resolved.
  const sys = read("workers/ai-kernel/src/syscall.ts");
  const fn = sys.slice(sys.indexOf("async function recordCorrectionSyscall"), sys.indexOf("async function doctrineStatus"));
  assert.ok(fn.indexOf("verifySyscallDecision(env.DB, decisionId, agentId, \"corrections.record\")") >= 0 && fn.indexOf("verifySyscallDecision") < fn.indexOf("recordNexusCorrection("));
  assert.match(fn, /isOwner\(\{ type: "user", subject: email \}, env\)/);
  // corrections.ts still imports only the contract, the audit chain, the chat constants and the D1 types (corrections-boundary-h3).
  const ledger = [...read("workers/ai-kernel/src/corrections.ts").matchAll(/^\s*import\b[^;]*?\bfrom\s+"([^"]+)"/gm)].map((m) => m[1]).sort();
  assert.deepEqual(ledger, ["../../control-plane-shared/src/audit.ts", "../../control-plane-shared/src/conversation.ts", "../../control-plane-shared/src/correction.ts", "../../control-plane-shared/src/types.ts"]);
});
