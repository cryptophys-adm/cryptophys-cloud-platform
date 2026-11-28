// Issue #327 C2 (owner 2026-11-28: "Ya Kerjakan", on "jadikan autonomous hasil council dikirim ke cerebrum untuk ditindak
// lanjut, call for council, owner hanya approved atau reject topic dan harus selalu segar ada umur kadaluarsa dan ada arsip
// beserta statusnya"); ADR-0014 §11 and the ADR-0018 X1 amendment 2026-11-28: a council task for xauusd is queued_external
// for xauusd-worker, moves forward with POST /v1/evolution/intents/{id}/progress (the owner, or a listed service identity
// on an assigned intent), expires after 7 days without progress, and every step reaches the council once through
// council.decisions.read. Nothing executes: no evolutions_v2 row and no Forge change request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, CI_JWT, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, migratedDb, req, signAccessJwt } from "./harness.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { FRESH_MS, intakeCouncil, triageCouncilTask } from "../../ai-kernel/src/evolution-intake.ts";
import {
  EXPIRED_REASON, EXPIRE_EVENT, PROGRESS_EVENT, checkTransition, expireExternalIntents, nextActor, progressExternalIntent, progressNote, progressRef,
} from "../../ai-kernel/src/evolution-progress.ts";
import { readCouncilDecisions } from "../../ai-kernel/src/council-decisions.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { destructiveMigration } from "../src/migration-rules.ts";

type Db = ReturnType<typeof migratedDb>;
const NOW = Date.parse("2026-11-28T10:07:00.000Z");
const DAY = 86_400_000;
const XAU = "cryptophys-adm/xauusd-ai-trading-assistant";
const MOD = "xauusd-moderator";
const WORKER_TOKEN = "cryptophys-agent-xauusd-worker.access";
const WORKER_JWT = await signAccessJwt({ common_name: WORKER_TOKEN });
const OTHER_TOKEN_JWT = await signAccessJwt({ common_name: "cryptophys-agent-other.access" });
const PR = `https://github.com/${XAU}/pull/661`;
const read = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");
const rows = (db: Db, sql: string, ...args: unknown[]) => (db.raw.prepare(sql).all(...(args as never[])) as any[]).map((r) => ({ ...r }));

const TASK = {
  schema: "typed_proposal.v1", proposal_id: "cp_mx01aa_c2test", kind: "repository_task", state: "handed_off", executor: "cryptophys",
  origin: { council: "cfc_mx01aa_sess01", option_id: "atr_filter", side: "nexus", repo: XAU, topic: "free:evaluasi-strategy", question: "Evaluasi Strategy" },
  chosen_by: "council", topic_approved_by: "owner:owner@example.com", session_id: "cfc_mx01aa_sess01", chosen_at: "2026-11-28T09:00:00.000Z",
  title: "Add a 15-minute ATR volatility filter", spec: "Before a zone_pullback entry is sent, compute the 15-minute ATR; above a share of the range, keep WAIT.",
  evidence_refs: [], source: "xauusd-ai-trading-assistant",
};

function withModerator(db: Db): Db {
  db.raw.prepare(`INSERT OR IGNORE INTO agents (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at, voter)
    VALUES (?, 'Council moderator', 'xauusd-ai-trading-assistant', 'test', 1, '["reports.publish"]', 'enabled', NULL, 'consensus:test', ?, ?, 0)`)
    .run(MOD, "2026-11-17T00:00:00.000Z", "2026-11-17T00:00:00.000Z");
  return db;
}
function report(db: Db, body: Record<string, unknown>, at = NOW - 60_000): void {
  db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at) VALUES (?, ?, 'xauusd_digest', 'info', 'Council task', ?, 'deterministic', NULL, ?)")
    .run(`rpt_${crypto.randomUUID()}`, MOD, JSON.stringify(body), new Date(at).toISOString());
}
/** A council task for xauusd recorded by the intake: queued_external for xauusd-worker. */
async function queued(body: Record<string, unknown> = TASK, at = NOW): Promise<{ db: Db; id: string }> {
  const db = withModerator(migratedDb());
  report(db, body, at - 60_000);
  const [r] = await intakeCouncil(db, at);
  assert.ok(r, "recorded");
  return { db, id: r.intent_id };
}
const intent = (db: Db, id: string) => rows(db, "SELECT * FROM evolution_intents_v2 WHERE intent_id = ?", id)[0];
const ups = (db: Db) => rows(db, "SELECT * FROM evolution_updates_v2 ORDER BY created_at, rowid");
const events = (db: Db, type = PROGRESS_EVENT) => rows(db, "SELECT * FROM audit_events WHERE event_type = ? ORDER BY rowid", type).map((e) => ({ ...e, payload: JSON.parse(e.payload_json) }));
const env = (db: Db, extra: Record<string, unknown> = {}) => baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL, ...extra });
const progress = (db: Db, id: string, body: unknown, jwt: string | null = APPROVER_JWT, extra: Record<string, unknown> = {}) =>
  call(kernel, env(db, extra), req("POST", `/v1/evolution/intents/${id}/progress`, body, jwt));
const counts = (db: Db) => ({
  evolutions: rows(db, "SELECT COUNT(*) AS n FROM evolutions_v2")[0].n,
  consensus: rows(db, "SELECT COUNT(*) AS n FROM consensus_proposals")[0].n,
});

test("EP1. intake: a council-chosen task (topic approved by the owner, a session id) for xauusd is queued_external for xauusd-worker, fresh for 7 days", async () => {
  const { db, id } = await queued();
  const i = intent(db, id);
  assert.deepEqual([i.state, i.state_reason, i.assignee, i.expires_at], ["waiting_external", "queued_external", "xauusd-worker", new Date(NOW + FRESH_MS).toISOString()]);
  const origin = JSON.parse(i.origin_json);
  assert.deepEqual([origin.chosen_by, origin.topic_approved_by, origin.session_id], ["council", "owner:owner@example.com", TASK.session_id]);
  assert.deepEqual(ups(db).map((u) => [u.state, u.reason, JSON.parse(u.refs_json)]), [["queued_external", "assigned to xauusd-worker", { intent_id: id, assignee: "xauusd-worker" }]]);
  // The owner approves or rejects the topic only; without the topic's approval or the session, the task is rejected.
  for (const [body, reason] of [
    [{ ...TASK, topic_approved_by: undefined }, "topic_not_owner_approved"],
    [{ ...TASK, topic_approved_by: "agent:moderator" }, "topic_not_owner_approved"],
    [{ ...TASK, session_id: undefined }, "topic_not_owner_approved"],
    [{ ...TASK, session_id: "cfc other" }, "topic_not_owner_approved"],
    [{ ...TASK, session_id: "cfc_another_session" }, "topic_not_owner_approved"],
    [{ ...TASK, chosen_by: "moderator" }, "not_chosen_by_owner"],
  ] as const) assert.deepEqual([triageCouncilTask(body as never)!.state, triageCouncilTask(body as never)!.reason], ["rejected", reason], JSON.stringify(body));
  // An owner-chosen task is queued_external too.
  assert.deepEqual([triageCouncilTask({ ...TASK, chosen_by: "owner:owner@example.com" })!.assignee, triageCouncilTask({ ...TASK, chosen_by: "owner:owner@example.com" })!.reason], ["xauusd-worker", "queued_external"]);
});

test("EP2. the owner walks the forward path; each step writes exactly one update row and one audit event; the council reads each once, in order", async () => {
  const { db, id } = await queued();
  const before = await readCouncilDecisions({ DB: db }, MOD, {});
  const steps: Array<[string, Record<string, unknown>, string | null]> = [
    ["in_progress", { note: "picked up by the worker" }, new Date(NOW + 1000 + FRESH_MS).toISOString()],
    ["proposed", { ref: PR }, null], // proposed waits on review or the owner's merge: it never expires
    ["merged", { ref: "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567" }, null],
    ["deployed", { ref: "0a1b2c3" }, null],
    ["closed", { note: "measured: fewer large losses over the window" }, null],
  ];
  let t = NOW;
  for (const [state, extra, expires] of steps) {
    t += 1000;
    const nUps = ups(db).length;
    const nEv = events(db).length;
    const out = await progressExternalIntent(db, { actor: APPROVER_EMAIL, owner: true }, id, { state, ...extra }, t);
    assert.deepEqual([out.state, out.changed, out.expires_at], [state, true, expires], state);
    assert.equal(ups(db).length, nUps + 1, `${state}: one update row`);
    assert.equal(events(db).length, nEv + 1, `${state}: one audit event`);
    const i = intent(db, id);
    assert.deepEqual([i.state, i.expires_at], [state, expires]);
  }
  assert.deepEqual(events(db).map((e) => [e.payload.from, e.payload.to, e.actor, e.subject]), [
    ["waiting_external", "in_progress", APPROVER_EMAIL, `intent:${id}`], ["in_progress", "proposed", APPROVER_EMAIL, `intent:${id}`],
    ["proposed", "merged", APPROVER_EMAIL, `intent:${id}`], ["merged", "deployed", APPROVER_EMAIL, `intent:${id}`], ["deployed", "closed", APPROVER_EMAIL, `intent:${id}`],
  ]);
  const out = await readCouncilDecisions({ DB: db }, MOD, { cursor: before.next_cursor });
  const u = out.updates as any[];
  assert.deepEqual(u.map((x) => [x.proposal_id, x.state, x.reason]), [
    [TASK.proposal_id, "in_progress", "picked up by the worker"], [TASK.proposal_id, "proposed", "proposed"], [TASK.proposal_id, "merged", "merged"],
    [TASK.proposal_id, "deployed", "deployed"], [TASK.proposal_id, "closed", "measured: fewer large losses over the window"],
  ]);
  assert.deepEqual(u[1].refs, { intent_id: id, pr_url: PR, assignee: "xauusd-worker" });
  assert.deepEqual(u[4].refs, { intent_id: id, assignee: "xauusd-worker", close_code: "completed" });
  assert.equal(intent(db, id).close_code, "completed");
  assert.deepEqual(u[2].refs, { intent_id: id, sha: "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567", assignee: "xauusd-worker" });
  // Read again after the last cursor: nothing is delivered twice.
  assert.deepEqual((await readCouncilDecisions({ DB: db }, MOD, { cursor: out.next_cursor })).updates, []);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("EP3. forward one step only: skips, backward moves, moves after closed or refused and non-progress states are 409; nothing is written", async () => {
  for (const [from, to, code] of [
    ["waiting_external", "proposed", "invalid_transition"], ["waiting_external", "closed", "invalid_transition"], ["in_progress", "merged", "invalid_transition"],
    ["merged", "in_progress", "invalid_transition"], ["deployed", "proposed", "invalid_transition"], ["closed", "refused", "intent_terminal"],
    ["refused", "in_progress", "intent_terminal"], ["queued", "in_progress", "not_external_progress"], ["rejected", "in_progress", "not_external_progress"],
    ["deployed_unmeasured", "closed", "not_external_progress"],
  ] as const) assert.throws(() => checkTransition(from, to), (e: any) => e.status === 409 && e.code === code, `${from} → ${to}`);
  for (const from of ["waiting_external", "in_progress", "proposed", "merged", "deployed"]) assert.equal(checkTransition(from, "refused"), "move", from);

  const { db, id } = await queued();
  const n = { ups: ups(db).length, ev: events(db).length };
  const skip = await progress(db, id, { state: "merged" });
  assert.deepEqual([skip.status, skip.body.error], [409, "invalid_transition"]);
  // The platform's own intents (the evolver's) never move here.
  db.raw.prepare("UPDATE evolution_intents_v2 SET target_repo = 'platform', state = 'in_progress' WHERE intent_id = ?").run(id);
  const own = await progress(db, id, { state: "proposed" });
  assert.deepEqual([own.status, own.body.error], [409, "not_external"]);
  assert.deepEqual({ ups: ups(db).length, ev: events(db).length }, n);
});

test("EP4. a non-owner is 403: an operator, the CI token, an unlisted service token; a listed service token moves an assigned intent only", async () => {
  const { db, id } = await queued();
  for (const jwt of [OPERATOR_JWT, CI_JWT, OTHER_TOKEN_JWT, WORKER_JWT]) {
    const res = await progress(db, id, { state: "in_progress" }, jwt);
    assert.deepEqual([res.status, res.body.error], [403, "owner_required"], "EVOLUTION_PROGRESS_IDENTITIES is empty by default");
  }
  assert.equal((await progress(db, id, { state: "in_progress" }, null)).status, 403);
  // Listing the CI token's name does not make a person or another token able: the exact service common name only.
  const listed = { EVOLUTION_PROGRESS_IDENTITIES: WORKER_TOKEN };
  assert.deepEqual([(await progress(db, id, { state: "in_progress" }, OTHER_TOKEN_JWT, listed)).status], [403]);
  assert.deepEqual([(await progress(db, id, { state: "in_progress" }, await signAccessJwt({ email: WORKER_TOKEN }), listed)).status], [403], "a person named like the token is not the token");
  assert.equal(intent(db, id).state, "waiting_external");
  assert.equal(events(db).length, 0);
  const ok = await progress(db, id, { state: "in_progress", note: "started" }, WORKER_JWT, listed);
  assert.deepEqual([ok.status, ok.body.state, ok.body.changed], [200, "in_progress", true], JSON.stringify(ok.body));
  assert.equal(events(db)[0].actor, WORKER_TOKEN);
  // An external intent nobody was assigned (another repository) is the owner's: the service is 403 not_assigned.
  const { db: db2, id: id2 } = await queued({ ...TASK, proposal_id: "cp_other_repo", origin: { ...TASK.origin, repo: "cryptophys-adm/cryptophys-aether" } });
  assert.equal(intent(db2, id2).assignee, null);
  const na = await progress(db2, id2, { state: "in_progress" }, WORKER_JWT, listed);
  assert.deepEqual([na.status, na.body.error], [403, "not_assigned"]);
  assert.equal((await progress(db2, id2, { state: "in_progress" })).status, 200, "the owner may");
});

test("EP5. a replay of the current state is changed: false and writes nothing; a race writes one step", async () => {
  const { db, id } = await queued();
  assert.equal((await progress(db, id, { state: "in_progress" })).body.changed, true);
  const n = { ups: ups(db).length, ev: events(db).length, at: intent(db, id).updated_at };
  const again = await progress(db, id, { state: "in_progress", note: "again" });
  assert.equal(again.status, 200);
  assert.deepEqual([again.body.changed, again.body.update_id, again.body.state], [false, null, "in_progress"]);
  assert.deepEqual({ ups: ups(db).length, ev: events(db).length, at: intent(db, id).updated_at }, n);
  const both = await Promise.all([
    progressExternalIntent(db, { actor: "a@x", owner: true }, id, { state: "proposed" }, NOW + 5000),
    progressExternalIntent(db, { actor: "b@x", owner: true }, id, { state: "proposed" }, NOW + 5000),
  ]);
  assert.deepEqual(both.map((r) => r.changed).sort(), [false, true]);
  assert.equal(ups(db).filter((u) => u.state === "proposed").length, 1);
  assert.equal(events(db).filter((e) => e.outcome === "proposed").length, 1);
});

test("EP6. the body: a price or a secret in the note, a bad ref, refused without a note, a bad state, unknown keys are 400; nothing is written", async () => {
  const { db, id } = await queued();
  const cases: Array<[unknown, string]> = [
    [{ state: "in_progress", note: "entry near 4095" }, "note_carries_price"],
    [{ state: "in_progress", note: "near ４０９５" }, "note_carries_price"],
    [{ state: "in_progress", note: "token sk-abcdefghijklmnopqrstuvwxyzABCD" }, "note_carries_secret"],
    [{ state: "in_progress", note: "a".repeat(301) }, "note_too_long"],
    [{ state: "in_progress", note: 5 }, "invalid_note"],
    [{ state: "in_progress", ref: "https://github.com/someone/else/pull/3" }, "ref_repo_not_allowed"],
    [{ state: "in_progress", ref: `https://github.com/${XAU}/pull/0` }, "invalid_ref"],
    [{ state: "in_progress", ref: `http://github.com/${XAU}/pull/3` }, "invalid_ref"],
    [{ state: "in_progress", ref: "0A1B2C3" }, "invalid_ref"],
    [{ state: "in_progress", ref: "abc12" }, "invalid_ref"],
    [{ state: "in_progress", ref: 7 }, "invalid_ref"],
    [{ state: "refused" }, "note_required"],
    [{ state: "refused", note: "   " }, "note_required"],
    [{ state: "waiting_external" }, "invalid_state"],
    [{ state: "expired" }, "invalid_state"],
    [{}, "invalid_state"],
    [{ state: "in_progress", reason: "x" }, "unknown_field"],
    [{ state: "in_progress", assignee: "me" }, "unknown_field"],
  ];
  for (const [body, code] of cases) {
    const res = await progress(db, id, body);
    assert.deepEqual([res.status, res.body.error], [400, code], JSON.stringify(body));
  }
  assert.equal(progressNote("  fewer  large losses "), "fewer large losses");
  assert.deepEqual(progressRef(` ${PR} `, "xauusd-worker"), { pr_url: PR });
  assert.throws(() => progressRef("0a1b2c3", null), (e: any) => e.code === "ref_repo_not_allowed", "no ref on an unassigned intent");
  assert.equal(intent(db, id).state, "waiting_external");
  assert.equal(events(db).length, 0);
  assert.equal(ups(db).length, 1, "only the intake's update");
  const r = await progress(db, id, { state: "refused", note: "the worker cannot build it without a feed change" });
  assert.deepEqual([r.status, r.body.state], [200, "refused"]);
  assert.equal(intent(db, id).state_reason, "the worker cannot build it without a feed change");
  // Unknown intent and malformed paths; GET is 405.
  assert.deepEqual([(await progress(db, "int_ffffffffffff", { state: "in_progress" })).body.error], ["intent_not_found"]);
  assert.equal((await call(kernel, env(db), req("GET", `/v1/evolution/intents/${id}/progress`, undefined, APPROVER_JWT))).status, 405);
  assert.equal((await call(kernel, env(db), req("POST", `/v1/evolution/intents/INT_0/progress`, { state: "in_progress" }, OPERATOR_JWT))).status, 404, "not the progress route: the operator API answers not_found");
});

test("EP7. nothing executes: no evolutions_v2 row, no consensus proposal, no Forge change request (ADR-0018 X2 stays held)", async () => {
  const { db, id } = await queued();
  const before = counts(db);
  for (const state of ["in_progress", "proposed", "merged", "deployed", "closed"]) assert.equal((await progress(db, id, { state, ref: state === "proposed" ? PR : undefined })).status, 200, state);
  assert.deepEqual(counts(db), before);
  assert.equal(intent(db, id).evolution_id, null);
  const src = read("workers/ai-kernel/src/evolution-progress.ts");
  for (const s of ["evolutions_v2 (", "consensus_proposals", "FORGE", "env.EVOLVER", "fetch("]) assert.ok(!src.includes(s), s);
});

test("EP8. freshness: no progress for 7 days returns the task to the council once (closed, expired); merged and deployed never expire", async () => {
  const { db, id } = await queued();
  assert.deepEqual(await expireExternalIntents(db, NOW + FRESH_MS - 1), [], "not before 7 days");
  const n = ups(db).length;
  const out = await expireExternalIntents(db, NOW + FRESH_MS);
  assert.deepEqual(out.map((x) => [x.intent_id, x.from]), [[id, "waiting_external"]]);
  const i = intent(db, id);
  assert.deepEqual([i.state, i.state_reason, i.close_code, i.expires_at], ["closed", EXPIRED_REASON, "expired", null]);
  assert.equal(ups(db).length, n + 1);
  assert.deepEqual([ups(db).at(-1).state, ups(db).at(-1).reason], ["expired", EXPIRED_REASON]);
  assert.deepEqual(events(db, EXPIRE_EVENT).map((e) => [e.actor, e.outcome, e.payload.from]), [["agent:supervisor", "expired", "waiting_external"]]);
  assert.deepEqual(await expireExternalIntents(db, NOW + 30 * DAY), [], "once");
  assert.equal(ups(db).length, n + 1);

  // Progress keeps it fresh: in_progress at day 6 moves its expiry to day 13.
  const { db: db2, id: id2 } = await queued();
  await progressExternalIntent(db2, { actor: APPROVER_EMAIL, owner: true }, id2, { state: "in_progress" }, NOW + 6 * DAY);
  assert.deepEqual(await expireExternalIntents(db2, NOW + 8 * DAY), []);
  assert.equal((await expireExternalIntents(db2, NOW + 13 * DAY)).length, 1);
  // proposed waits on review or the owner's merge, merged on a deploy: neither expires (proposed shows as stale).
  const { db: db3, id: id3 } = await queued();
  for (const state of ["in_progress", "proposed"]) await progressExternalIntent(db3, { actor: APPROVER_EMAIL, owner: true }, id3, { state }, NOW + DAY);
  assert.equal(intent(db3, id3).expires_at, null);
  assert.deepEqual(await expireExternalIntents(db3, NOW + 365 * DAY), []);
  assert.equal(intent(db3, id3).state, "proposed");
  await progressExternalIntent(db3, { actor: APPROVER_EMAIL, owner: true }, id3, { state: "merged" }, NOW + 2 * DAY);
  assert.deepEqual(await expireExternalIntents(db3, NOW + 365 * DAY), []);
  assert.equal(intent(db3, id3).state, "merged");
  // An unassigned waiting_external intent (nobody owes a step but the owner) never expires either.
  const { db: db5, id: id5 } = await queued({ ...TASK, proposal_id: "cp_unassigned", origin: { ...TASK.origin, repo: "cryptophys-adm/cryptophys-aether" } });
  db5.raw.prepare("UPDATE evolution_intents_v2 SET expires_at = ? WHERE intent_id = ?").run(new Date(NOW).toISOString(), id5);
  assert.deepEqual(await expireExternalIntents(db5, NOW + 365 * DAY), []);
  // An intent recorded before 0092 (expires_at NULL) never expires.
  const { db: db4, id: id4 } = await queued();
  db4.raw.prepare("UPDATE evolution_intents_v2 SET expires_at = NULL WHERE intent_id = ?").run(id4);
  assert.deepEqual(await expireExternalIntents(db4, NOW + 365 * DAY), []);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("EP9. an external repository without a worker still waits unassigned (adr_0018_x1_x2), with no expiry", async () => {
  const { db, id } = await queued({ ...TASK, proposal_id: "cp_aether_task", origin: { ...TASK.origin, repo: "cryptophys-adm/cryptophys-aether" } });
  const i = intent(db, id);
  assert.deepEqual([i.state, i.state_reason, i.assignee, i.expires_at], ["waiting_external", "adr_0018_x1_x2", null, null]);
  assert.deepEqual(ups(db).map((u) => [u.state, u.reason]), [["waiting_external", "adr_0018_x1_x2"]]);
  assert.deepEqual(await expireExternalIntents(db, NOW + 365 * DAY), []);
});

test("EP10. migration 0092 is additive (three nullable columns and an index), the next number; the kernel lists the route", async () => {
  const dir = new URL("../../control-plane-migrations/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  assert.equal(files.at(-1), "0092_evolution_external_progress.sql");
  const sql = readFileSync(new URL("0092_evolution_external_progress.sql", dir), "utf8");
  assert.equal(destructiveMigration(sql), false);
  const code = sql.split("\n").map((l) => l.split("--")[0]).join("\n");
  assert.deepEqual(code.match(/^(ALTER TABLE|CREATE INDEX)[^\n]*/gm)?.map((l) => l.split(" ").slice(0, 6).join(" ")), [
    "ALTER TABLE evolution_intents_v2 ADD COLUMN assignee", "ALTER TABLE evolution_intents_v2 ADD COLUMN expires_at", "ALTER TABLE evolution_intents_v2 ADD COLUMN close_code", "CREATE INDEX IF NOT EXISTS idx_evolution_intents_v2_expiry",
  ]);
  const db = migratedDb();
  assert.throws(() => db.raw.prepare(`INSERT INTO evolution_intents_v2 (intent_id, source, source_ref, target_repo, title, state, created_at, updated_at, assignee)
    VALUES ('int_000000000001', 'owner', 'x', 'r', 't', 'waiting_external', 'a', 'a', '')`).run(), /CHECK/);
  const meta = await call(kernel, env(db), req("GET", "/", undefined, OPERATOR_JWT));
  assert.ok(JSON.stringify(meta.body).includes("POST /v1/evolution/intents/{id}/progress"));
  assert.match(read("workers/ai-kernel/src/index.ts"), /expireExternalIntents\(env\.DB, event\.scheduledTime\)/);
});

test("EP11. the record: ADR-0014 §12 cites the owner, the 0014 manifest lists C3, the SSOT documents the route and its newest line-5 entry", () => {
  const adr = read("architecture/adr/0014-evolution-loop.md");
  const sec = adr.slice(adr.indexOf("### 12. Amendment 2026-11-28"), adr.indexOf("## Consequences"));
  for (const s of ['"Ya Kerjakan"', "owner hanya approved atau reject topic", "`topic_approved_by", "queued_external", "POST /v1/evolution/intents/{id}/progress", "7 days", "no `evolutions_v2` row and no Forge change request", "ADR-0018 X1/X2"]) assert.ok(sec.includes(s), s);
  const manifest = JSON.parse(read("architecture/adr/progress/0014.json"));
  const c3 = manifest.phases.find((p: any) => p.id === "C3");
  assert.deepEqual([c3.evidence.kind, c3.evidence.event_type], ["audit_event", PROGRESS_EVENT]);
  assert.ok(c3.built.includes("workers/ai-kernel/src/evolution-progress.ts"));
  const ssot = read("docs/SSOT.md");
  assert.match(ssot.split("\n")[4], /^Last reviewed: 2026-11-16 \((?:[^\n]*; )?external intent progress, 2026-11-28 \(owner: "Ya Kerjakan"/);
  assert.ok(ssot.includes("- **External intent progress** (owner, 2026-11-28") && ssot.includes("`EVOLUTION_PROGRESS_IDENTITIES`"));
});

test("EP12. a service identity sets in_progress, proposed, merged and refused only; deployed and closed are 403; refs only in the assignee's repository", async () => {
  const listed = { EVOLUTION_PROGRESS_IDENTITIES: WORKER_TOKEN };
  const { db, id } = await queued();
  const svc = (body: unknown) => progress(db, id, body, WORKER_JWT, listed);
  assert.equal((await svc({ state: "in_progress" })).status, 200);
  const otherRepo = await svc({ state: "proposed", ref: "https://github.com/cryptophys-adm/cryptophys-aether/pull/4" });
  assert.deepEqual([otherRepo.status, otherRepo.body.error], [400, "ref_repo_not_allowed"]);
  assert.equal((await svc({ state: "proposed", ref: PR })).status, 200);
  assert.equal((await svc({ state: "merged", ref: "0a1b2c3d" })).status, 200);
  const n = events(db).length;
  for (const state of ["deployed", "closed"]) {
    const res = await svc({ state });
    assert.deepEqual([res.status, res.body.error], [403, "state_not_for_service"], state);
  }
  assert.equal(events(db).length, n);
  assert.equal(intent(db, id).state, "merged");
  // The owner records deployed and closed.
  assert.equal((await progress(db, id, { state: "deployed" })).status, 200);
  // A service may still refuse, with a note.
  const { db: db2, id: id2 } = await queued();
  const r = await progress(db2, id2, { state: "refused", note: "out of scope for the worker" }, WORKER_JWT, listed);
  assert.deepEqual([r.status, r.body.close_code, r.body.next_actor], [200, "refused", "none"]);
});

test("EP13. a replay does not extend the freshness: only a real change resets expires_at", async () => {
  const { db, id } = await queued();
  await progressExternalIntent(db, { actor: APPROVER_EMAIL, owner: true }, id, { state: "in_progress" }, NOW + DAY);
  const first = intent(db, id).expires_at;
  assert.equal(first, new Date(NOW + DAY + FRESH_MS).toISOString());
  const again = await progressExternalIntent(db, { actor: APPROVER_EMAIL, owner: true }, id, { state: "in_progress", note: "still on it" }, NOW + 6 * DAY);
  assert.deepEqual([again.changed, again.expires_at], [false, first]);
  assert.equal(intent(db, id).expires_at, first);
  assert.equal((await expireExternalIntents(db, NOW + 8 * DAY)).length, 1, "the replay at day 6 kept nothing alive");
});

test("EP14. next_actor in one pure function, exposed by GET /v1/evolution with assignee, expires_at, close_code and stale", async () => {
  const at = new Date(NOW).toISOString();
  const old = new Date(NOW - FRESH_MS).toISOString();
  const table: Array<[Record<string, unknown>, string, boolean]> = [
    [{ state: "waiting_external", assignee: "xauusd-worker", updated_at: at }, "xauusd-worker", false],
    [{ state: "waiting_external", assignee: null, updated_at: at }, "owner", false],
    [{ state: "in_progress", assignee: "xauusd-worker", updated_at: old }, "xauusd-worker", false],
    [{ state: "proposed", assignee: "xauusd-worker", updated_at: at }, "owner/orchestrator", false],
    [{ state: "proposed", assignee: "xauusd-worker", updated_at: old }, "owner/orchestrator", true],
    [{ state: "merged", updated_at: old }, "deploy", false],
    [{ state: "deployed", updated_at: old }, "measurement", false],
    // An external intent: only the owner records deployed and closed there (the coordinator's review, 2026-11-28).
    [{ state: "merged", target_repo: XAU, updated_at: old }, "owner", false],
    [{ state: "deployed", target_repo: XAU, updated_at: old }, "owner", false],
    [{ state: "merged", target_repo: "platform", updated_at: old }, "deploy", false],
    [{ state: "closed" }, "none", false],
    [{ state: "refused" }, "none", false],
  ];
  for (const [i, actor, stale] of table) assert.deepEqual(nextActor(i as never, NOW), { next_actor: actor, stale }, JSON.stringify(i));
  const { db, id } = await queued();
  const view = await call(kernel, env(db), req("GET", "/v1/evolution", undefined, OPERATOR_JWT));
  assert.equal(view.status, 200);
  const it = (view.body.intents as any[]).find((x) => x.intent_id === id);
  assert.deepEqual([it.state, it.assignee, it.expires_at, it.close_code, it.next_actor, it.stale], ["waiting_external", "xauusd-worker", new Date(NOW + FRESH_MS).toISOString(), null, "xauusd-worker", false]);
  const src = read("workers/ai-kernel/src/evolution-view.ts");
  assert.ok(src.includes("nextActor(") && !/next_actor:\s*"/.test(src), "the view uses nextActor and derives nothing itself");
});

test("EP15. the return path carries queued_external, every progress state, refused and expired with close_code, each once", async () => {
  const { db, id } = await queued();
  let t = NOW;
  for (const state of ["in_progress", "proposed", "merged", "deployed", "closed"]) await progressExternalIntent(db, { actor: APPROVER_EMAIL, owner: true }, id, { state, ...(state === "proposed" ? { ref: PR } : {}) }, t += 1000);
  const a = (await readCouncilDecisions({ DB: db }, MOD, {})).updates as any[];
  assert.deepEqual(a.map((u) => [u.state, u.refs.close_code ?? null]), [
    ["queued_external", null], ["in_progress", null], ["proposed", null], ["merged", null], ["deployed", null], ["closed", "completed"],
  ]);
  const { db: db2 } = await queued({ ...TASK, proposal_id: "cp_will_expire" });
  await expireExternalIntents(db2, NOW + FRESH_MS);
  const b = (await readCouncilDecisions({ DB: db2 }, MOD, {})).updates as any[];
  assert.deepEqual(b.map((u) => [u.proposal_id, u.state, u.reason, u.refs.close_code ?? null]), [
    ["cp_will_expire", "queued_external", "assigned to xauusd-worker", null], ["cp_will_expire", "expired", EXPIRED_REASON, "expired"],
  ]);
  const { db: db3, id: id3 } = await queued({ ...TASK, proposal_id: "cp_refused" });
  await progressExternalIntent(db3, { actor: APPROVER_EMAIL, owner: true }, id3, { state: "refused", note: "superseded by another council task" }, NOW + 1000);
  const c = (await readCouncilDecisions({ DB: db3 }, MOD, {})).updates as any[];
  assert.deepEqual(c.at(-1).state, "refused");
  assert.deepEqual([c.at(-1).reason, c.at(-1).refs.close_code], ["superseded by another council task", "refused"]);
  assert.equal(c.length, 2, "each transition once");
});
