// HAIC H3b (docs/design/HAIC-H3.md §4–§5, §11 step 2; owner 2026-11-19, every recommended default accepted): the
// corrections ledger. Migration 0084 is additive; a record is never refused for its content; dedup returns the same row
// for the same content (whitespace, key order) and writes nothing; up, down, up is three rows and the newest counts; the
// routes are the owner's; the audit chain never holds the text; 100 records in an hour in survival are all written; a
// chat rating is also a correction, and a failure there never fails the rating; the Q8 backfill is idempotent.
// One migratedDb() per test at most.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, migratedDb, req, signAccessJwt } from "./harness.ts";
import kernel from "../../ai-kernel/src/index.ts";
import {
  BACKFILL_DONE_EVENT, CorrectionError, backfillChatRatings, backfillChatRatingsOnce, listCorrections, modelSubject, newCorrectionId, recordCorrection, turnRef,
} from "../../ai-kernel/src/corrections.ts";
import { ConversationError, rateTurn, readConversation, runTurn, type ConversationStore } from "../../ai-kernel/src/conversation.ts";
import { appendAuditEvent } from "../src/audit.ts";
import { CHAT_MODEL } from "../src/conversation.ts";
import { validateCorrection } from "../src/correction.ts";
import { destructiveMigration, splitSqlStatements } from "../src/migration-rules.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const MIGRATION = "0084_corrections.sql";
const OWNER = APPROVER_EMAIL;
const ACTOR = `owner:${OWNER}`;
const CTX = { actor: ACTOR, owner: true, attested_by: "cerebrum_access" as const };
const CNV = "cnv_0123456789abcdef";
const TARGET = { ref: turnRef(CNV, 1), subject: "model:test-model", as_of: null };

function setup() {
  const db = migratedDb();
  const env: any = baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL });
  const rows = () => db.raw.prepare("SELECT correction_id, label, rating, category, target_ref, subject, actor, weight, supersedes, body_json, created_at FROM corrections ORDER BY rowid").all() as any[];
  const events = (like = "correction.%") => (db.raw.prepare("SELECT event_type, actor, subject, outcome, payload_json FROM audit_events WHERE event_type LIKE ? ORDER BY rowid").all(like) as any[])
    .map((e) => ({ ...JSON.parse(e.payload_json), type: e.event_type as string, actor: e.actor as string, audit_subject: e.subject as string, outcome: e.outcome as string, raw: e.payload_json as string }));
  return { db, env, rows, events };
}
function memStore(): ConversationStore {
  const map = new Map<string, unknown>();
  return { get: async <T>(k: string) => structuredClone(map.get(k)) as T | undefined, put: async (k: string, v: unknown) => { map.set(k, structuredClone(v)); } };
}
/** A conversation whose first turn was answered, with a model that plans no tool and answers "Hello." */
async function answeredTurn(env: any, store: ConversationStore) {
  env.AI = { run: async (_m: string, input: any) => ({ response: String(input.messages?.[0]?.content ?? "").startsWith("You plan") ? { tools: [] } : { answer: "Hello.", citations: [] }, usage: { prompt_tokens: 10, completion_tokens: 2 } }) };
  const t = await runTurn(env, store, { actor: OWNER, conversation_id: CNV, question: "Hello" });
  assert.equal(t.status, "answered");
  return t;
}

test("H3b-1. migration 0084 is the next free number, additive (one table, four non-unique indexes) and routine; it applies twice", () => {
  const files = readdirSync(new URL("workers/control-plane-migrations/", ROOT)).filter((f) => f.endsWith(".sql")).sort();
  const at = files.indexOf(MIGRATION);
  assert.ok(at > 0, "the migration exists");
  assert.equal(files[at - 1], "0083_autonomy_dial.sql", "it follows the autonomy dial (the latest at H3b)");
  assert.ok(files.slice(at + 1).every((f) => Number(f.slice(0, 4)) > 84), "only later migrations follow it");
  const sql = read(`workers/control-plane-migrations/${MIGRATION}`);
  const statements = splitSqlStatements(sql).map((s) => s.replace(/^(\s*--[^\n]*\n)+/, "").trim());
  assert.deepEqual(statements.map((s) => /^CREATE (TABLE|INDEX) IF NOT EXISTS (\w+)/.exec(s)?.[2] ?? s.slice(0, 40)),
    ["corrections", "idx_corrections_subject", "idx_corrections_target", "idx_corrections_dedup", "idx_corrections_side"]);
  assert.equal(destructiveMigration(sql), false, "the native deploy applies it as routine (no owner click)");
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /\b(UNIQUE|UPDATE|DELETE|DROP|ALTER|INSERT)\b/i);
  const db = migratedDb();
  db.raw.exec(sql);
  const idx = db.raw.prepare("SELECT name, \"unique\" AS u FROM pragma_index_list('corrections') WHERE name LIKE 'idx_%' ORDER BY name").all() as any[];
  assert.deepEqual(idx.map((r) => [r.name, r.u]), [["idx_corrections_dedup", 0], ["idx_corrections_side", 0], ["idx_corrections_subject", 0], ["idx_corrections_target", 0]]);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM corrections").get() as any).n, 0, "no row is seeded");
  // The migration tests in Python cover the CHECKs; here the plan of the newest-per-target read uses an index.
  const plan = (db.raw.prepare("EXPLAIN QUERY PLAN SELECT correction_id FROM corrections WHERE target_ref = ? AND actor = ? AND created_at <= ? ORDER BY created_at DESC LIMIT 1").all("x", "y", "z") as any[]).map((r) => r.detail).join(" ");
  assert.match(plan, /USING INDEX idx_corrections_(target|dedup)/);
  assert.match(read("workers/control-plane-migrations/test_migrations.py"), /PASS: 0084 corrections/);
});

test("H3b-2. dedup: whitespace and key order give the same row and write nothing; different content writes; never refused for content", async () => {
  const s = setup();
  const a = await recordCorrection(s.db, { side: "cerebrum", source: "chat_rating", category: "evidence_wrong", text: "  the   deploy count\nis stale ", evidence_refs: ["ev:platform/reports@x", "ev:platform/agents@y"], target: TARGET }, CTX);
  assert.equal(a.deduplicated, false);
  assert.match(a.correction.correction_id, /^cor_[0-9a-f]{16}$/);
  assert.deepEqual(validateCorrection(a.correction), []);
  // The same content: other whitespace, other key order, the refs in another order.
  const b = await recordCorrection(s.db, { evidence_refs: ["ev:platform/agents@y", "ev:platform/reports@x"], target: { as_of: null, subject: TARGET.subject, ref: TARGET.ref }, text: "the deploy count is stale", category: "evidence_wrong", source: "chat_rating", side: "cerebrum" }, CTX);
  assert.deepEqual([b.deduplicated, b.correction.correction_id], [true, a.correction.correction_id]);
  assert.equal(s.rows().length, 1, "a duplicate writes nothing");
  assert.deepEqual(s.events().map((e) => e.type), ["correction.recorded", "correction.deduplicated"]);
  // Different content writes, and names the row it supersedes.
  const c = await recordCorrection(s.db, { side: "cerebrum", source: "chat_rating", category: "evidence_missing", target: TARGET }, CTX);
  assert.equal(c.deduplicated, false);
  assert.equal(c.correction.supersedes, a.correction.correction_id);
  // Another actor with the same content is its own row.
  const d = await recordCorrection(s.db, { side: "cerebrum", source: "chat_rating", category: "evidence_missing", target: TARGET }, { ...CTX, actor: "owner:other@example.com" });
  assert.deepEqual([d.deduplicated, d.correction.supersedes], [false, null]);
  assert.equal(s.rows().length, 3);
  // Never refused for its content: a secret is redacted (and audited), a price masked, a long text truncated, an unknown category kept.
  const e = await recordCorrection(s.db, { side: "cerebrum", source: "chat_rating", category: "made_up", text: `use ghp_${"a".repeat(36)} at 2,345.6 ${"z".repeat(600)}`, target: TARGET }, CTX);
  assert.deepEqual([e.deduplicated, e.correction.redactions, e.correction.category, e.correction.category_raw], [false, ["secret", "price", "truncated"], "other", "made_up"]);
  assert.ok(!JSON.stringify(s.rows()).includes(`ghp_${"a".repeat(36)}`) && !JSON.stringify(s.rows()).includes("2,345.6"), "the stored copy holds neither the secret nor the price");
  assert.deepEqual(s.events("correction.secret_redacted").map((x) => x.correction_id), [e.correction.correction_id]);
  // Only a structural error is refused, as 400, and writes nothing.
  for (const [input, error] of [
    [{ side: "cerebrum", source: "chat_rating", target: TARGET }, "empty"],
    [{ side: "cerebrum", source: "chat_rating", rating: "up", target: { ref: "not a ref", subject: TARGET.subject } }, "invalid_target"],
    [{ side: "cerebrum", source: "chat_rating", rating: "up", target: { ref: TARGET.ref, subject: "@cf/x/y" } }, "invalid_subject"],
    [{ side: "cerebrum", source: "chat_rating", rating: "up", target: TARGET, params: { risk: 2 } }, "forbidden_key: input.params"],
  ] as const) {
    await assert.rejects(recordCorrection(s.db, input as never, CTX), (err: any) => err instanceof CorrectionError && err.status === 400 && err.message === error, error);
  }
  assert.equal(s.rows().length, 4);
  assert.match(newCorrectionId(), /^cor_[0-9a-f]{16}$/);
  assert.notEqual(newCorrectionId(), newCorrectionId());
});

test("H3b-3. up, down, up on one target is three rows, each superseding the one before; the newest counts; nothing is updated", async () => {
  const s = setup();
  const t0 = Date.parse("2026-11-19T10:00:00.000Z");
  const ids: string[] = [];
  for (const [i, rating] of (["up", "down", "up"] as const).entries()) {
    const r = await recordCorrection(s.db, { side: "cerebrum", source: "chat_rating", rating, target: TARGET }, { ...CTX, now: new Date(t0 + i * 60_000).toISOString() });
    assert.equal(r.deduplicated, false, `${i}: ${rating}`);
    ids.push(r.correction.correction_id);
  }
  const rows = s.rows();
  assert.deepEqual(rows.map((r) => [r.rating, r.label, r.weight, r.supersedes]), [["up", "owner_rating", 3, null], ["down", "owner_rating", 3, ids[0]], ["up", "owner_rating", 3, ids[1]]]);
  // A repeat of the newest (the same click again) is deduplicated against it.
  const again = await recordCorrection(s.db, { side: "cerebrum", source: "chat_rating", rating: "up", target: TARGET }, { ...CTX, now: new Date(t0 + 3 * 60_000).toISOString() });
  assert.deepEqual([again.deduplicated, again.correction.correction_id], [true, ids[2]]);
  // The newest row per actor and target is the one that counts (the teaching record's read, §6.1).
  const newest = await listCorrections(s.db, { target: TARGET.ref, limit: 1 });
  assert.deepEqual(newest.corrections.map((c) => [c.correction_id, c.rating]), [[ids[2], "up"]]);
  const list = await listCorrections(s.db, { target: TARGET.ref });
  assert.deepEqual(list.corrections.map((c) => c.correction_id), [...ids].reverse(), "newest first");
  for (const c of list.corrections) assert.deepEqual(validateCorrection(c), [], c.correction_id);
  // Append-only: the module never updates or deletes a corrections row.
  const code = read("workers/ai-kernel/src/corrections.ts").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /\bUPDATE\s+corrections\b|\bDELETE\s+FROM\b|\bREPLACE\s+INTO\b|ON CONFLICT/i);
  assert.equal((code.match(/INSERT INTO corrections/g) ?? []).length, 1, "one INSERT, nothing else writes the table");
});

test("H3b-4. listCorrections filters by subject, target and side, newest first, at most 200; a bad side or time is a 400", async () => {
  const s = setup();
  const t0 = Date.parse("2026-11-19T00:00:00.000Z");
  for (let i = 0; i < 205; i++) {
    await recordCorrection(s.db, { side: "cerebrum", source: "council", category: "reading_wrong", target: { ref: `ev:platform/council/cs_${i}#seq_1`, subject: i % 2 ? "agent:a" : "agent:b", as_of: null } }, { ...CTX, now: new Date(t0 + i * 1_000).toISOString() });
  }
  assert.equal((await listCorrections(s.db, {})).corrections.length, 50, "50 by default");
  const all = await listCorrections(s.db, { limit: 500 });
  assert.equal(all.corrections.length, 200, "at most 200");
  assert.equal(all.corrections[0].target.ref, "ev:platform/council/cs_204#seq_1", "newest first");
  const a = await listCorrections(s.db, { subject: "agent:a", limit: 200 });
  assert.ok(a.corrections.length === 102 && a.corrections.every((c) => c.target.subject === "agent:a"));
  assert.deepEqual((await listCorrections(s.db, { target: "ev:platform/council/cs_7#seq_1" })).corrections.map((c) => c.target.subject), ["agent:a"]);
  assert.equal((await listCorrections(s.db, { side: "nexus" })).corrections.length, 0);
  assert.equal((await listCorrections(s.db, { since: new Date(t0 + 200_000).toISOString() })).corrections.length, 5);
  await assert.rejects(listCorrections(s.db, { side: "mars" }), (e: any) => e instanceof CorrectionError && e.status === 400);
  await assert.rejects(listCorrections(s.db, { since: "yesterday" }), (e: any) => e instanceof CorrectionError && e.status === 400);
});

test("H3b-5. the routes are the owner's: POST records (201, then 200 deduplicated), GET lists; operators, viewers and CI are 403", async () => {
  const s = setup();
  const body = { source: "chat_rating", target_ref: TARGET.ref, subject: TARGET.subject, rating: "down", text: "the count is from yesterday" };
  const made = await call(kernel, s.env, req("POST", "/v1/corrections", body, APPROVER_JWT));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.match(made.body.correction_id, /^cor_[0-9a-f]{16}$/);
  assert.deepEqual([made.body.deduplicated, made.body.redactions, made.body.correction.side, made.body.correction.label, made.body.correction.actor, made.body.correction.attested_by, made.body.correction.weight],
    [false, [], "cerebrum", "owner_correction", ACTOR, "cerebrum_access", 3]);
  // The actor, the attestation and the weight come from the authentication, never from the body.
  const forged = await call(kernel, s.env, req("POST", "/v1/corrections", { ...body, rating: "up", actor: "owner:someone@else", attested_by: "xauusd_nexus_access", weight: 1 }, APPROVER_JWT));
  assert.equal(forged.status, 201);
  assert.deepEqual([forged.body.correction.actor, forged.body.correction.attested_by, forged.body.correction.weight], [ACTOR, "cerebrum_access", 3]);
  const nested = await call(kernel, s.env, req("POST", "/v1/corrections", { source: "chat_rating", target: { ref: TARGET.ref, subject: TARGET.subject }, rating: "up" }, APPROVER_JWT));
  assert.equal(nested.status, 201);
  const dup = await call(kernel, s.env, req("POST", "/v1/corrections", { source: "chat_rating", target: { subject: TARGET.subject, ref: TARGET.ref }, rating: "up" }, APPROVER_JWT));
  assert.deepEqual([dup.status, dup.body.deduplicated, dup.body.correction_id], [200, true, nested.body.correction_id]);
  const empty = await call(kernel, s.env, req("POST", "/v1/corrections", { source: "chat_rating", target_ref: TARGET.ref, subject: TARGET.subject }, APPROVER_JWT));
  assert.deepEqual([empty.status, empty.body.error], [400, "invalid_request"]);
  const list = await call(kernel, s.env, req("GET", `/v1/corrections?target=${encodeURIComponent(TARGET.ref)}&limit=2`, undefined, APPROVER_JWT));
  assert.equal(list.status, 200);
  assert.deepEqual([list.body.schema, list.body.corrections.map((c: any) => c.correction_id)], ["corrections.v1", [nested.body.correction_id, forged.body.correction_id]]);
  assert.equal((await call(kernel, s.env, req("DELETE", "/v1/corrections", undefined, APPROVER_JWT))).status, 405);
  assert.equal((await call(kernel, s.env, req("GET", "/v1/corrections?side=mars", undefined, APPROVER_JWT))).status, 400);
  // Not the owner: an operator, a viewer account and a service token are refused, for reading and for writing.
  const VIEWER = "viewer-h3b@cryptophys.work";
  s.db.raw.prepare("INSERT INTO platform_accounts (email, kind, privilege, status, created_by, created_at, updated_by, updated_at) VALUES (?, 'admin', 'viewer', 'active', 'o', 't', 'o', 't')").run(VIEWER);
  const viewerJwt = await signAccessJwt({ email: VIEWER });
  for (const jwt of [OPERATOR_JWT, viewerJwt, undefined]) {
    const get = await call(kernel, s.env, req("GET", "/v1/corrections", undefined, jwt));
    const post = await call(kernel, s.env, req("POST", "/v1/corrections", body, jwt));
    assert.equal(get.status, 403, JSON.stringify(get.body));
    assert.equal(post.status, 403, JSON.stringify(post.body));
  }
  assert.equal((await call(kernel, s.env, req("GET", "/v1/corrections", undefined, OPERATOR_JWT))).body.error, "owner_required");
  assert.equal(s.rows().length, 3, "nothing was written by the refused calls");
});

test("H3b-6. the audit chain never holds the text: recorded, deduplicated and secret_redacted carry ids, labels, hashes and flags only", async () => {
  const s = setup();
  const text = "Unmistakable owner wording 42 about the stale count";
  const secret = `token ghp_${"b".repeat(36)}`;
  const r = await recordCorrection(s.db, { side: "cerebrum", source: "chat_rating", category: "evidence_wrong", text, target: TARGET }, CTX);
  await recordCorrection(s.db, { side: "cerebrum", source: "chat_rating", category: "evidence_wrong", text, target: TARGET }, CTX);
  await recordCorrection(s.db, { side: "cerebrum", source: "chat_rating", category: "rule_broken", text: secret, target: TARGET }, CTX);
  const events = s.events();
  assert.deepEqual(events.map((e) => e.type), ["correction.recorded", "correction.deduplicated", "correction.recorded", "correction.secret_redacted"]);
  for (const e of events) {
    assert.ok(!e.raw.includes("Unmistakable") && !e.raw.includes("stale count") && !e.raw.includes("ghp_"), `${e.type} holds no text`);
    assert.equal(e.actor, ACTOR);
    assert.match(e.audit_subject, /^correction:cor_[0-9a-f]{16}$/);
  }
  const rec = events[0];
  assert.deepEqual(Object.keys(rec).filter((k) => !["type", "actor", "audit_subject", "outcome", "raw"].includes(k)).sort(),
    ["category", "content_sha256", "correction_id", "label", "rating", "redactions", "subject", "target_ref", "weight"].sort());
  assert.deepEqual([rec.correction_id, rec.outcome, rec.target_ref, rec.subject, rec.weight, rec.content_sha256], [r.correction.correction_id, "owner_correction", TARGET.ref, TARGET.subject, 3, r.correction.content_sha256]);
  // The text is kept in D1 body_json only.
  assert.equal(JSON.parse(s.rows()[0].body_json).text, text);
});

test("H3b-7. the learning mandate: 100 corrections in one hour, in survival and with the agents' kill switch pulled, are all written and audited", async () => {
  const s = setup();
  s.db.raw.prepare("UPDATE metabolism_controls SET value = 'survival' WHERE control = 'power_mode'").run();
  s.db.raw.prepare("UPDATE kernel_controls SET value = '0' WHERE control = 'agents_enabled'").run();
  const t0 = Date.parse("2026-11-19T11:00:00.000Z");
  for (let i = 0; i < 100; i++) {
    const r = await recordCorrection(s.db, { side: "cerebrum", source: "chat_rating", rating: i % 2 ? "up" : "down", target: { ref: turnRef(CNV, i + 1), subject: "model:test-model", as_of: null } }, { ...CTX, now: new Date(t0 + i * 30_000).toISOString() });
    assert.equal(r.deduplicated, false, `record ${i}`);
  }
  assert.equal(s.rows().length, 100, "all 100 written: no cap, rate limit or power mode applies");
  assert.equal(s.events("correction.recorded").length, 100, "each one audited");
  const code = read("workers/ai-kernel/src/corrections.ts").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /power_mode|max_per_hour|rate_limit|kill|agents_enabled|reserveTurn|budget/i, "nothing in the ledger limits learning");
  // §1 non-goals: no corrections path writes a parameter, a weight, a proposal or a gate.
  assert.doesNotMatch(code, /consensusPropose|insertDraft|policy_parameters|autonomy|typed_proposals|consensus_proposals|knowledge_proposals|agent_memories/);
});

test("H3b-8. a chat rating is also a correction (with the note as its text); a failure there never fails the rating", async () => {
  const s = setup();
  const store = memStore();
  const t = await answeredTurn(s.env, store);
  assert.deepEqual(await rateTurn(s.env, store, OWNER, CNV, 1, "up"), { turn: 1, rating: "up" });
  const [first] = s.rows();
  assert.deepEqual([first.label, first.rating, first.category, first.target_ref, first.subject, first.actor, first.weight],
    ["owner_rating", "up", null, turnRef(CNV, 1), modelSubject(CHAT_MODEL), ACTOR, 3]);
  assert.equal(modelSubject(CHAT_MODEL), "model:deepseek-v4.1-flash-1017");
  const c1 = JSON.parse(first.body_json);
  assert.deepEqual([c1.source, c1.side, c1.attested_by, c1.target.as_of, c1.text], ["chat_rating", "cerebrum", "cerebrum_access", t.created_at, null]);
  assert.deepEqual(validateCorrection(c1), []);
  // The same thumbs again: deduplicated, nothing written. Then down with a note: an owner_correction with the note as text.
  await rateTurn(s.env, store, OWNER, CNV, 1, "up");
  assert.equal(s.rows().length, 1);
  await rateTurn(s.env, store, OWNER, CNV, 1, "down", `  wrong: the deploy count was yesterday's ${"x".repeat(600)} `);
  const second = s.rows()[1];
  const c2 = JSON.parse(second.body_json);
  assert.deepEqual([second.label, second.rating, second.category, second.supersedes, c2.text.length, c2.redactions], ["owner_correction", "down", null, first.correction_id, 500, ["truncated"]]);
  assert.ok(c2.text.startsWith("wrong: the deploy count was yesterday's"));
  // conversation.rated names the correction; its payload holds no note.
  const rated = s.events("conversation.rated");
  assert.deepEqual(rated.map((e) => [e.outcome, e.turn, e.correction_id]), [["up", 1, first.correction_id], ["up", 1, first.correction_id], ["down", 1, second.correction_id]]);
  assert.ok(rated.every((e) => !e.raw.includes("yesterday")));
  assert.equal((await readConversation(store, OWNER, CNV)).turns[0].rating, "down", "the thumbs show the newest rating");
  // A note that is not text is a 400; a note never makes a refused turn rateable.
  await assert.rejects(rateTurn(s.env, store, OWNER, CNV, 1, "up", { text: "x" }), (e: any) => e instanceof ConversationError && e.status === 400);
  // The ledger fails (its table is gone): the rating still stands and is audited, with no correction id.
  s.db.raw.exec("ALTER TABLE corrections RENAME TO corrections_away");
  const errors: string[] = [];
  const original = console.error;
  console.error = (m: unknown) => { errors.push(String(m)); };
  try {
    assert.deepEqual(await rateTurn(s.env, store, OWNER, CNV, 1, "up", "fine after all"), { turn: 1, rating: "up" });
  } finally { console.error = original; }
  assert.equal((await readConversation(store, OWNER, CNV)).turns[0].rating, "up");
  assert.deepEqual(s.events("conversation.rated").map((e) => e.correction_id).at(-1), null);
  assert.ok(errors.some((m) => m.includes("chat_rating_correction_failed")));
  s.db.raw.exec("ALTER TABLE corrections_away RENAME TO corrections");
  // The route passes the note through, and the Ask page sends it.
  const objects = new Map<string, ConversationStore>([[`${OWNER}:${CNV}`, store]]);
  s.env.CONVERSATION = {
    idFromName: (name: string) => name,
    get: (name: string) => {
      const st = objects.get(name) ?? memStore();
      const settle = async (op: () => Promise<unknown>) => { try { return { ok: true, value: await op() }; } catch (e: any) { if (e instanceof ConversationError) return { ok: false, status: e.status, code: e.code, message: e.message }; throw e; } };
      return { rate: (a: string, id: string, n: unknown, r: unknown, note?: unknown) => settle(() => rateTurn(s.env, st, a, id, n, r, note)) };
    },
  };
  const routed = await call(kernel, s.env, req("POST", `/v1/conversations/${CNV}/turns/1/rating`, { rating: "down", note: "route note" }, APPROVER_JWT));
  assert.deepEqual([routed.status, routed.body], [200, { turn: 1, rating: "down" }]);
  assert.equal(JSON.parse(s.rows().at(-1).body_json).text, "route note");
  assert.match(read("workers/console/ui/src/pages/Ask.tsx"), /call\("kernel\.conversation_rate", \[id, String\(t\.n\)\], text \? \{ rating, note: text \} : \{ rating \}\)/);
  assert.match(read("workers/console/ui/src/pages/Ask.tsx"), /maxLength=\{500\}[^\n]*aria-label="Rating note"/);
});

test("H3b-9. the Q8 backfill: earlier conversation.rated events become owner_rating corrections once, idempotently; live ratings are not read again", async () => {
  const s = setup();
  const audit = (type: string, outcome: string, payload: Record<string, unknown>, cnv = CNV) =>
    appendAuditEvent(s.db, { event_type: `conversation.${type}`, actor: OWNER, subject: `conversation:${cnv}`, outcome, payload: { conversation_id: cnv, ...payload } });
  // Before H3b: a turn (its model), then up, up again, down, up on turn 1; down on turn 2 of another conversation.
  await audit("turn", "answered", { turn: 1, model: CHAT_MODEL });
  for (const r of ["up", "up", "down", "up"]) await audit("rated", r, { turn: 1 });
  const OTHER = "cnv_fedcba9876543210";
  await audit("rated", "down", { turn: 2 }, OTHER);
  await audit("rated", "meh", { turn: 3 });
  // Since H3b a live rating names its correction: never read again (here a correction id the ledger does not hold).
  await audit("rated", "down", { turn: 4, correction_id: "cor_00000000000000ff" });
  const first = await backfillChatRatings(s.db);
  assert.deepEqual(first, { read: 7, recorded: 4, deduplicated: 1, skipped: 2, complete: true });
  const rows = s.rows();
  assert.deepEqual(rows.map((r) => [r.target_ref, r.rating, r.label, r.weight, r.actor]), [
    [turnRef(CNV, 1), "up", "owner_rating", 3, ACTOR], [turnRef(CNV, 1), "down", "owner_rating", 3, ACTOR],
    [turnRef(CNV, 1), "up", "owner_rating", 3, ACTOR], [turnRef(OTHER, 2), "down", "owner_rating", 3, ACTOR],
  ]);
  assert.deepEqual(rows.map((r) => r.supersedes), [null, rows[0].correction_id, rows[1].correction_id, null]);
  const body = JSON.parse(rows[0].body_json);
  assert.deepEqual([body.backfilled, typeof body.backfill_event, body.source, body.target.subject], [true, "string", "chat_rating", modelSubject(CHAT_MODEL)]);
  assert.equal(JSON.parse(rows[3].body_json).target.as_of, null, "no turn event for that turn: as_of unknown");
  const listed = (await listCorrections(s.db, { target: turnRef(CNV, 1) })).corrections;
  assert.ok(listed.every((c) => c.backfilled === true && !("backfill_event" in c)));
  const ratedTimes = (s.db.raw.prepare("SELECT created_at FROM audit_events WHERE event_type = 'conversation.rated' ORDER BY rowid").all() as any[]).map((r) => r.created_at);
  assert.deepEqual(rows.slice(0, 3).map((r) => r.created_at), [ratedTimes[0], ratedTimes[2], ratedTimes[3]], "each keeps its original time");
  assert.ok(s.events("correction.recorded").every((e) => e.backfilled === true));
  // Again: nothing written, nothing audited.
  const before = s.events().length;
  assert.deepEqual(await backfillChatRatings(s.db), { read: 7, recorded: 0, deduplicated: 1, skipped: 6, complete: true });
  assert.equal(s.rows().length, 4);
  assert.equal(s.events().length, before, "a second run writes no audit event");
  // The scheduled hook runs it until one complete run, then only reads the done event.
  const once = await backfillChatRatingsOnce(s.db);
  assert.equal(once?.recorded, 0);
  assert.deepEqual(s.events(BACKFILL_DONE_EVENT).map((e) => [e.actor, e.outcome, e.read]), [["system:corrections-backfill", "done", 7]]);
  await audit("rated", "down", { turn: 9 });
  assert.equal(await backfillChatRatingsOnce(s.db), null, "after the done event it never runs again");
  assert.equal(s.rows().length, 4);
  // Wired into the kernel's scheduled handler at :07.
  const index = read("workers/ai-kernel/src/index.ts");
  assert.match(index, /if \(minute === 7\) \{\n\s*ctx\.waitUntil\(backfillChatRatingsOnce\(env\.DB\)/);
});

test("H3b-10. wiring: the kernel's route index, the Console's allow-list and UI routes, and the SSOT", async () => {
  const index = read("workers/ai-kernel/src/index.ts");
  assert.match(index, /"GET \/v1\/corrections\?[^"]*\(the owner\)", "POST \/v1\/corrections \(the owner\)"/);
  const { CONSOLE_ALLOW_LIST } = await import("../../console/src/index.ts");
  const { UI_ROUTES } = await import("../../console/src/ui/routes.ts");
  for (const method of ["GET", "POST"]) assert.ok(CONSOLE_ALLOW_LIST.some((a) => a.service === "kernel" && a.method === method && a.path === "/v1/corrections"), method);
  assert.deepEqual(UI_ROUTES.filter((r) => r.path === "/v1/corrections").map((r) => ({ ...r })), [
    { id: "kernel.corrections", service: "kernel", method: "GET", path: "/v1/corrections", approverOnly: true, confirm: null },
    { id: "kernel.correction_create", service: "kernel", method: "POST", path: "/v1/corrections", approverOnly: true, confirm: null },
  ]);
  const ssot = read("docs/SSOT.md");
  assert.match(ssot.split("\n").find((l) => l.startsWith("Last reviewed: "))!, /^Last reviewed: 2026-11-16 \(HAIC H3b, 2026-11-19 [^\n]*migration 0084[^\n]*`GET` and `POST \/v1\/corrections`[^\n]*; HAIC H3a, 2026-11-19 /);
  assert.doesNotMatch(ssot, /\*\*Not built yet\.\*\* H0 and H1 start only after/, "the §2.6 drift is fixed");
  assert.match(ssot, /\*\*Built on the platform:\*\* H0 [^\n]*the corrections ledger \(H3b: migration 0084/);
});
