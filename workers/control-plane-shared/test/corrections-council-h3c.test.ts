// HAIC H3c (docs/design/HAIC-H3.md §3, §11 step 3; owner 2026-11-19, "Setuju semua rekomendasi"): council and proposal
// corrections. The owner corrects a council's message, claim or option (POST /v1/councils/{id}/corrections) or a typed
// proposal (POST /v1/proposals/{id}/corrections); a target that does not exist is a 400, an expired or closed council is
// corrected all the same. An owner's reject reason on a typed proposal or a knowledge review is recorded as an
// owner_decision (Q6, weight 1), and a failure there never fails the reject. Owners only; the audit chain holds no text.
// One migratedDb() per test at most.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, CI_JWT, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, migratedDb, req, signAccessJwt, lastReviewedRecord } from "./harness.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { COUNCIL_MODERATOR_SUBJECT, councilRef, knowledgeRef, modelSubject, proposalRef } from "../../ai-kernel/src/corrections.ts";
import { CouncilError, MODERATOR, proposeCouncil, readCouncil, type CouncilStore } from "../../ai-kernel/src/council.ts";
import { decideProposal, insertDraft } from "../../ai-kernel/src/proposals.ts";
import { decideKnowledge } from "../../ai-kernel/src/knowledge.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { CHAT_MODEL } from "../src/conversation.ts";
import { CORRECTION_CATEGORIES, LABEL_WEIGHT, validateCorrection } from "../src/correction.ts";
import { newProposalId, type TypedProposal } from "../src/typed-proposal.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const OWNER = APPROVER_EMAIL;
const ACTOR = `owner:${OWNER}`;
const CS = "cs_8f14e45f-ceea-467a-9575-5b8a3c1f0c01";
const NOW = Date.parse("2026-11-19T10:00:00.000Z");
/** Typed proposals are made now: the routes decide them by the real clock, within their 7-day window. */
const T = Date.now();
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const KNW = "knw_00000000-0000-4000-8000-0000000000c3";

function memStore(): CouncilStore { const m = new Map<string, unknown>(); return { get: async <T>(k: string) => structuredClone(m.get(k)) as T | undefined, put: async (k: string, v: unknown) => { m.set(k, structuredClone(v)); } }; }
const message = (seq: number, phase: string, role: string, author: string, extra: Record<string, unknown> = {}) => ({
  schema: "council.message.v1", session_id: CS, seq, at: at(seq), phase, role, author, reply_to: [], stance: role === "participant" ? "support" : null, claims: [],
  text: `${phase} ${seq}`, options: null, model: null, tokens: { in: 0, cached: 0, out: 0 }, content_sha256: "0".repeat(64), ...extra,
});
/** A council as its object stores it: the convener's note, two positions (the first with two claims), the owner's message and a synthesis. */
async function council(store: CouncilStore, state: string) {
  const msgs = [
    message(1, "system", "system", "system:convener"),
    message(2, "position", "participant", "agent:supervisor", { claims: [{ metric: "approvals_waiting", value: 0, refs: ["ev:platform/owner_inbox@x#counts.approvals"], verified: true }, { metric: "critical_reports", value: 9, refs: ["ev:platform/owner_inbox@x#counts.critical_reports"], verified: false }] }),
    message(3, "position", "participant", "agent:signal-analyst"),
    message(4, "owner", "owner", ACTOR),
    message(5, "synthesis", "moderator", `agent:${MODERATOR}`, { options: [{ option_id: "opt-1", rank: 1 }, { option_id: "opt-2", rank: 2 }] }),
  ];
  for (const m of msgs) await store.put(`msg:${String(m.seq).padStart(4, "0")}`, m);
  await store.put("session", { schema: "council.session.v1", session_id: CS, side: "cerebrum", topic: "t", question: "q", trigger: { kind: "owner", ref: null }, convened: [], state,
    owner_present: true, created_at: at(0), deadline: at(-1), phase_deadline: null, budget: { max_calls: 16, max_usd: 0.1 }, spent: { calls: 11, tokens_in: 0, tokens_cached: 0, tokens_out: 0, usd_est: 0.02 },
    decision: null, transcript_sha256: null, created_by: OWNER, reason: null, messages: msgs.length });
}
function setup() {
  const db = migratedDb();
  const env: any = baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL });
  const stores = new Map<string, CouncilStore>();
  const storeOf = (id: string) => { if (!stores.has(id)) stores.set(id, memStore()); return stores.get(id)!; };
  const settle = async (op: () => Promise<unknown>) => { try { return { ok: true, value: await op() }; } catch (e) { if (e instanceof CouncilError) return { ok: false, status: e.status, code: e.code, message: e.message }; throw e; } };
  env.COUNCIL = { idFromName: (n: string) => n, get: (n: string) => ({ read: () => settle(() => readCouncil(storeOf(n))) }) };
  const rows = () => db.raw.prepare("SELECT correction_id, source, label, rating, category, target_ref, subject, actor, weight, body_json FROM corrections ORDER BY rowid").all() as any[];
  const events = (like = "correction.%") => (db.raw.prepare("SELECT event_type, outcome, payload_json FROM audit_events WHERE event_type LIKE ? ORDER BY rowid").all(like) as any[])
    .map((e) => ({ type: e.event_type as string, outcome: e.outcome as string, raw: e.payload_json as string, ...JSON.parse(e.payload_json) }));
  return { db, env, storeOf, rows, events };
}
const post = (s: ReturnType<typeof setup>, path: string, body: unknown, jwt: string = APPROVER_JWT) => call(kernel, s.env, req("POST", path, body, jwt));
function draft(origin: TypedProposal["origin"]): TypedProposal {
  return { schema: "typed_proposal.v1", proposal_id: newProposalId(), kind: "policy_parameter", title: "Lower the deploy limit", rationale: "Fewer stalls.", target: "daily-deploy-limit", params: { value: 12 },
    measurement: { metric: "m", baseline: 0.1, window: "14d", success_threshold: 0.05 }, origin, evidence_refs: ["ev:platform/consensus/cns_00000005-0000-4000-8000-000000000000"],
    requires: ["owner_confirm", "owner_click_to_promote"] } as TypedProposal;
}
const knowledgeRow = (db: any, id: string, proposer = "aether-curator") => db.raw.prepare(`INSERT INTO knowledge_proposals (proposal_id, proposer_agent_id, item_id, item_version, kind, item_json, content_sha256, status, decision_id, created_at)
  VALUES (?, ?, ?, 1, 'caution', '{}', ?, 'pending', 'dec', ?)`).run(id, proposer, `k-${id.slice(-4)}`, "c".repeat(64), new Date(Date.now() - 3_600_000).toISOString());

test("H3c-1. the owner corrects a council's message, a claim and an option: council source, the agent's subject, the message's time", async () => {
  const s = setup();
  await council(s.storeOf(CS), "awaiting_owner");
  const path = `/v1/councils/${CS}/corrections`;
  const msg = await post(s, path, { seq: 2, category: "evidence_wrong", text: "the inbox count is from yesterday" });
  assert.equal(msg.status, 201, JSON.stringify(msg.body));
  assert.match(msg.body.correction_id, /^cor_[0-9a-f]{16}$/);
  assert.deepEqual([msg.body.deduplicated, msg.body.redactions], [false, []]);
  const c = msg.body.correction;
  assert.deepEqual([c.side, c.source, c.label, c.category, c.target, c.actor, c.attested_by, c.weight],
    ["cerebrum", "council", "owner_correction", "evidence_wrong", { ref: `ev:platform/council/${CS}#seq_2`, subject: "agent:supervisor", as_of: at(2) }, ACTOR, "cerebrum_access", 3]);
  assert.deepEqual(validateCorrection(c), []);
  const claim = await post(s, path, { seq: 2, claim: 1, rating: "down", category: "overconfident" });
  assert.equal(claim.status, 201, JSON.stringify(claim.body));
  assert.deepEqual(claim.body.correction.target, { ref: `ev:platform/council/${CS}#seq_2.claim_1`, subject: "agent:supervisor", as_of: at(2) });
  const opt = await post(s, path, { option_id: "opt-2", rating: "up" });
  assert.equal(opt.status, 201, JSON.stringify(opt.body));
  assert.deepEqual([opt.body.correction.label, opt.body.correction.weight, opt.body.correction.target],
    ["owner_rating", 3, { ref: `ev:platform/council/${CS}#option_opt_2`, subject: COUNCIL_MODERATOR_SUBJECT, as_of: at(5) }]);
  const synth = await post(s, path, { seq: 5, category: "evidence_missing" });
  assert.deepEqual([synth.status, synth.body.correction.target.subject], [201, `agent:${MODERATOR}`], "the moderator's synthesis is its own output");
  // The same correction again is the same row (200); the body cannot name the target, the subject, the actor or the weight.
  const again = await post(s, path, { seq: 2, text: "the inbox  count is from yesterday ", category: "evidence_wrong", subject: "agent:someone", target_ref: "ev:platform/x/y", actor: "owner:x@y", weight: 1 });
  assert.deepEqual([again.status, again.body.deduplicated, again.body.correction_id], [200, true, msg.body.correction_id]);
  assert.deepEqual(councilRef(CS, "seq_2"), `ev:platform/council/${CS}#seq_2`);
  assert.deepEqual(s.rows().map((r) => [r.source, r.target_ref.split("#")[1], r.subject, r.weight]),
    [["council", "seq_2", "agent:supervisor", 3], ["council", "seq_2.claim_1", "agent:supervisor", 3], ["council", "option_opt_2", "agent:auditor", 3], ["council", "seq_5", "agent:auditor", 3]]);
});

test("H3c-2. a target that does not exist is a 400 and writes nothing; an unknown council is a 404; an empty correction is a 400", async () => {
  const s = setup();
  await council(s.storeOf(CS), "awaiting_owner");
  const path = `/v1/councils/${CS}/corrections`;
  for (const [body, message] of [
    [{ text: "no target" }, /names a message \(seq\)/],
    [{ seq: 9, text: "x" }, /no such message/],
    [{ seq: 0, text: "x" }, /seq is a message's number/],
    [{ seq: "2", text: "x" }, /seq is a message's number/],
    [{ seq: 2, claim: 2, text: "x" }, /no such claim/],
    [{ seq: 3, claim: 0, text: "x" }, /no such claim/],
    [{ seq: 2, claim: -1, text: "x" }, /no such claim/],
    [{ option_id: "opt-9", text: "x" }, /no such option/],
    [{ option_id: "opt-1", seq: 5, text: "x" }, /not both/],
    [{ seq: 4, text: "my own message" }, /only an agent's message/],
    [{ seq: 1, text: "the convener" }, /only an agent's message/],
    [{ seq: 2 }, /empty/],
    [{ seq: 2, text: "x", params: { risk: 2 } }, /forbidden_key/],
  ] as const) {
    const r = await post(s, path, body);
    assert.deepEqual([r.status, r.body.error], [400, "invalid_request"], JSON.stringify(body));
    assert.match(r.body.detail, message, JSON.stringify(body));
  }
  const unknown = await post(s, "/v1/councils/cs_00000000-0000-0000-0000-000000000000/corrections", { seq: 1, text: "x" });
  assert.equal(unknown.status, 404);
  assert.equal((await call(kernel, s.env, req("GET", path, undefined, APPROVER_JWT))).status, 405);
  assert.equal(s.rows().length, 0, "nothing was written");
});

test("H3c-3. an expired, dismissed, aborted or decided council is corrected all the same; so is an agent's proposal before it is begun", async () => {
  const s = setup();
  for (const [i, state] of ["expired", "dismissed", "aborted", "decided"].entries()) {
    const id = CS.replace(/c01$/, `c1${i}`);
    const store = s.storeOf(id);
    await council(store, state);
    // The stored messages name the default council; point them at this one.
    const sess = await store.get<any>("session");
    await store.put("session", { ...sess, session_id: id });
    const r = await post(s, `/v1/councils/${id}/corrections`, { seq: 3, rating: "down", text: `wrong while ${state}` });
    assert.equal(r.status, 201, `${state}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.correction.target.ref, `ev:platform/council/${id}#seq_3`);
  }
  // A council an agent proposed (H1.5d) waits in "proposed"; its proposal message is the proposing agent's output.
  const id = CS.replace(/c01$/, "c20");
  const store = s.storeOf(id);
  await proposeCouncil(s.env, store, { session_id: id, proposed_by: "agent:platform-api", trigger_kind: "finding", topic: "CPU spikes", question: "Why?", refs: ["ev:platform/reports@x"], detail: "Three findings in a day." }, NOW);
  const r = await post(s, `/v1/councils/${id}/corrections`, { seq: 1, category: "evidence_missing" });
  assert.deepEqual([r.status, r.body.correction.target.subject], [201, "agent:platform-api"], JSON.stringify(r.body));
  assert.equal((await readCouncil(store)).session.state, "proposed", "a correction changes nothing in the council");
  assert.equal(s.rows().length, 5);
});

test("H3c-4. the routes are the owner's: an operator, a viewer account and a service token are refused (403) and nothing is written", async () => {
  const s = setup();
  await council(s.storeOf(CS), "awaiting_owner");
  const p = draft({ source: "council", ref: `${CS}#opt-1` });
  await insertDraft(s.db as never, p, ACTOR, T);
  const VIEWER = "viewer-h3c@cryptophys.work";
  s.db.raw.prepare("INSERT INTO platform_accounts (email, kind, privilege, status, created_by, created_at, updated_by, updated_at) VALUES (?, 'admin', 'viewer', 'active', 'o', 't', 'o', 't')").run(VIEWER);
  const viewerJwt = await signAccessJwt({ email: VIEWER });
  for (const jwt of [OPERATOR_JWT, viewerJwt, CI_JWT]) {
    const a = await post(s, `/v1/councils/${CS}/corrections`, { seq: 2, text: "x" }, jwt);
    const b = await post(s, `/v1/proposals/${p.proposal_id}/corrections`, { text: "x" }, jwt);
    assert.equal(a.status, 403, JSON.stringify(a.body));
    assert.equal(b.status, 403, JSON.stringify(b.body));
  }
  assert.equal((await post(s, `/v1/councils/${CS}/corrections`, { seq: 2, text: "x" }, OPERATOR_JWT)).body.error, "owner_required");
  assert.equal(s.rows().length, 0);
});

test("H3c-5. a typed proposal's reject reason is an owner_decision correction of its origin (weight 1); no reason, a confirm or a pick is none", async () => {
  const s = setup();
  const fromCouncil = draft({ source: "council", ref: `${CS}#opt-1` });
  const fromChat = draft({ source: "chat", ref: "cnv_0123456789abcdef#directive:0123456789ab" });
  const silent = draft({ source: "council", ref: `${CS}#opt-2` });
  const confirmed = draft({ source: "council", ref: `${CS}#opt-3` });
  for (const p of [fromCouncil, fromChat, silent, confirmed]) assert.equal((await insertDraft(s.db as never, p, ACTOR, T)).ok, true);
  const rej = await call(kernel, s.env, req("POST", `/v1/proposals/${fromCouncil.proposal_id}/reject`, { reason: "  the limit is not the cause " }, APPROVER_JWT));
  assert.deepEqual([rej.status, rej.body.state, rej.body.reason], [200, "rejected", "the limit is not the cause"]);
  await decideProposal(s.db as never, OWNER, fromChat.proposal_id, "reject", "I asked for accuracy, not speed", T + 1_000);
  await decideProposal(s.db as never, OWNER, silent.proposal_id, "reject", "   ", T + 2_000);
  await decideProposal(s.db as never, OWNER, confirmed.proposal_id, "confirm", "good", T + 3_000);
  const rows = s.rows();
  assert.deepEqual(rows.map((r) => [r.source, r.label, r.target_ref, r.subject, r.actor, r.weight]), [
    ["typed_proposal", "owner_decision", proposalRef(fromCouncil.proposal_id), COUNCIL_MODERATOR_SUBJECT, ACTOR, LABEL_WEIGHT.owner_decision],
    ["typed_proposal", "owner_decision", proposalRef(fromChat.proposal_id), modelSubject(CHAT_MODEL), ACTOR, LABEL_WEIGHT.owner_decision],
  ], "a reject without a reason and a confirmation record nothing (Q6)");
  assert.equal(LABEL_WEIGHT.owner_decision, 1);
  const body = JSON.parse(rows[0].body_json);
  assert.deepEqual([body.text, body.rating, body.category, body.target.as_of], ["the limit is not the cause", null, null, new Date(T).toISOString()]);
  assert.deepEqual(validateCorrection(body), []);
});

test("H3c-6. an owner's knowledge-review reject reason is an owner_decision correction of the proposer; an approval or an approver account's reason is none", async () => {
  const s = setup();
  const ids = [1, 2, 3, 4].map((i) => KNW.replace(/c3$/, `c${i}`));
  knowledgeRow(s.db, ids[0]);
  knowledgeRow(s.db, ids[1], "aether-calibrator");
  knowledgeRow(s.db, ids[2]);
  knowledgeRow(s.db, ids[3]);
  const rej = await call(kernel, s.env, req("POST", `/v1/knowledge/${ids[0]}/reject`, { reason: "too few sessions for a caution" }, APPROVER_JWT));
  assert.deepEqual([rej.status, rej.body.status], [200, "rejected"], JSON.stringify(rej.body));
  assert.equal((await call(kernel, s.env, req("POST", `/v1/knowledge/${ids[1]}/approve`, { reason: "approved for shadow testing" }, APPROVER_JWT))).status, 200);
  // Q9: an approver account that is not an owner reviews, but corrects nothing in H3.
  const APPROVER_ACCOUNT = "approver-h3c@cryptophys.work";
  s.db.raw.prepare("INSERT INTO platform_accounts (email, kind, privilege, status, created_by, created_at, updated_by, updated_at) VALUES (?, 'admin', 'approver', 'active', 'o', 't', 'o', 't')").run(APPROVER_ACCOUNT);
  const byAccount = await call(kernel, s.env, req("POST", `/v1/knowledge/${ids[2]}/reject`, { reason: "not convincing" }, await signAccessJwt({ email: APPROVER_ACCOUNT })));
  assert.deepEqual([byAccount.status, byAccount.body.status], [200, "rejected"], JSON.stringify(byAccount.body));
  // Without the caller's owner flag the domain function records nothing either (the default).
  await decideKnowledge(s.db as never, ids[3], "reject", OWNER, "no flag");
  assert.deepEqual(s.rows().map((r) => [r.source, r.label, r.target_ref, r.subject, r.actor, r.weight]),
    [["knowledge_review", "owner_decision", knowledgeRef(ids[0]), "agent:aether-curator", ACTOR, LABEL_WEIGHT.owner_decision]]);
  const body = JSON.parse(s.rows()[0].body_json);
  assert.equal(body.text, "too few sessions for a caution");
  assert.deepEqual(validateCorrection(body), []);
});

test("H3c-7. a failure to record never fails the reject: the reject stands and the failure is logged without the reason", async () => {
  const s = setup();
  const p = draft({ source: "council", ref: `${CS}#opt-1` });
  await insertDraft(s.db as never, p, ACTOR, T);
  knowledgeRow(s.db, KNW);
  s.db.raw.exec("DROP TABLE corrections");
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  try {
    const rej = await call(kernel, s.env, req("POST", `/v1/proposals/${p.proposal_id}/reject`, { reason: "Unmistakable reject wording 7" }, APPROVER_JWT));
    assert.deepEqual([rej.status, rej.body.state], [200, "rejected"], JSON.stringify(rej.body));
    const kr = await call(kernel, s.env, req("POST", `/v1/knowledge/${KNW}/reject`, { reason: "Unmistakable review wording 8" }, APPROVER_JWT));
    assert.deepEqual([kr.status, kr.body.status], [200, "rejected"], JSON.stringify(kr.body));
  } finally { console.error = realError; }
  const failures = logged.filter((l) => l.includes("reject_reason_correction_failed"));
  assert.equal(failures.length, 2, logged.join("\n"));
  assert.deepEqual(failures.map((l) => JSON.parse(l).source), ["typed_proposal", "knowledge_review"]);
  assert.ok(!logged.join("\n").includes("Unmistakable"), "the log never holds the reason");
  assert.equal((s.db.raw.prepare("SELECT state FROM typed_proposals WHERE proposal_id = ?").get(p.proposal_id) as any).state, "rejected");
  assert.equal((await verifyAuditChain(s.db as never)).valid, true);
});

test("H3c-8. the audit chain never holds the text of a council correction, a proposal correction or a reject reason", async () => {
  const s = setup();
  await council(s.storeOf(CS), "expired");
  const p = draft({ source: "chat", ref: "cnv_0123456789abcdef#directive:0123456789ab" });
  await insertDraft(s.db as never, p, ACTOR, T);
  knowledgeRow(s.db, KNW);
  const words = ["Distinct council wording 41", "Distinct proposal wording 42", "Distinct reject wording 43", "Distinct review wording 44"];
  const secret = `ghp_${"d".repeat(36)}`;
  assert.equal((await post(s, `/v1/councils/${CS}/corrections`, { seq: 2, claim: 0, text: `${words[0]} ${secret}` })).status, 201);
  assert.equal((await post(s, `/v1/proposals/${p.proposal_id}/corrections`, { category: "rule_broken", text: words[1] })).status, 201);
  assert.equal((await call(kernel, s.env, req("POST", `/v1/proposals/${p.proposal_id}/reject`, { reason: words[2] }, APPROVER_JWT))).status, 200);
  assert.equal((await call(kernel, s.env, req("POST", `/v1/knowledge/${KNW}/reject`, { reason: words[3] }, APPROVER_JWT))).status, 200);
  const events = s.events();
  assert.deepEqual(events.map((e) => e.type), ["correction.recorded", "correction.secret_redacted", "correction.recorded", "correction.recorded", "correction.recorded"]);
  for (const e of events) {
    for (const w of [...words, secret, "wording"]) assert.ok(!e.raw.includes(w), `${e.type} holds "${w}"`);
    assert.ok(!("text" in e), e.type);
  }
  assert.deepEqual(events.filter((e) => e.type === "correction.recorded").map((e) => [e.label, e.weight]), [["owner_correction", 3], ["owner_correction", 3], ["owner_decision", 1], ["owner_decision", 1]]);
  // The stored copy is redacted; the text stays in body_json only.
  assert.ok(!JSON.stringify(s.rows()).includes(secret));
  assert.equal((await verifyAuditChain(s.db as never)).valid, true);
});

test("H3c-9. the owner corrects a typed proposal in any state: its origin is the subject, a missing proposal is a 404", async () => {
  const s = setup();
  const p = draft({ source: "council", ref: `${CS}#opt-1` });
  await insertDraft(s.db as never, p, ACTOR, T);
  await decideProposal(s.db as never, OWNER, p.proposal_id, "reject", null, T + 1_000);
  const r = await post(s, `/v1/proposals/${p.proposal_id}/corrections`, { category: "evidence_missing", text: "the evidence is one report" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.correction.source, r.body.correction.label, r.body.correction.weight, r.body.correction.target],
    ["typed_proposal", "owner_correction", 3, { ref: proposalRef(p.proposal_id), subject: COUNCIL_MODERATOR_SUBJECT, as_of: new Date(T).toISOString() }]);
  assert.equal((await post(s, `/v1/proposals/${p.proposal_id}/corrections`, {})).status, 400, "an empty correction");
  assert.equal((await post(s, "/v1/proposals/tp_00000000000000ff/corrections", { text: "x" })).status, 404);
  assert.equal((await call(kernel, s.env, req("GET", `/v1/proposals/${p.proposal_id}`, undefined, APPROVER_JWT))).body.state, "rejected", "the proposal is unchanged");
  // The moderator's subject is the council's MODERATOR (not imported by the corrections module, which must not reach council.ts).
  assert.equal(COUNCIL_MODERATOR_SUBJECT, `agent:${MODERATOR}`);
});

test("H3c-10. wiring: the kernel's route index, the Console's allow-list and UI routes, the pages' correction controls, and the SSOT", async () => {
  const index = read("workers/ai-kernel/src/index.ts");
  assert.match(index, /"POST \/v1\/proposals\/\{id\}\/confirm \| reject \| corrections \(the owner\)"/);
  assert.match(index, /"POST \/v1\/councils\/\{id\}\/messages \| pick \| dismiss \| start \| corrections"/);
  const { CONSOLE_ALLOW_LIST } = await import("../../console/src/index.ts");
  const { UI_ROUTES } = await import("../../console/src/ui/routes.ts");
  for (const path of ["/v1/councils/{id}/corrections", "/v1/proposals/{id}/corrections"]) {
    assert.ok(CONSOLE_ALLOW_LIST.some((a) => a.service === "kernel" && a.method === "POST" && a.path === path), path);
  }
  assert.deepEqual(UI_ROUTES.filter((r) => /\/corrections$/.test(r.path) && r.path !== "/v1/corrections").map((r) => ({ ...r })), [
    { id: "kernel.council_correct", service: "kernel", method: "POST", path: "/v1/councils/{id}/corrections", approverOnly: true, confirm: null },
    { id: "kernel.proposal_correct", service: "kernel", method: "POST", path: "/v1/proposals/{id}/corrections", approverOnly: true, confirm: null },
  ]);
  const councils = read("workers/console/ui/src/pages/Councils.tsx");
  assert.match(councils, /const correct: Correct = owner \? \(target, what\) => <CorrectionBox [^\n]*call\("kernel\.council_correct", s\.session_id, \{ \.\.\.target, \.\.\.body \}\)/);
  assert.match(councils, /correct\(\{ seq: m\.seq \}, /);
  assert.match(councils, /correct\?\.\(\{ seq: m\.seq, claim: i \}, /);
  assert.match(councils, /correct\(\{ option_id: o\.option_id \}, /);
  const proposals = read("workers/console/ui/src/pages/Proposals.tsx");
  assert.match(proposals, /\{owner && \([\s\S]*?<CorrectionBox what="this proposal" submit=\{\(body\) => call\("kernel\.proposal_correct", p\.proposal_id, body\)\} \/>/);
  const box = read("workers/console/ui/src/components/CorrectionBox.tsx");
  const cats = /export const CORRECTION_CATEGORIES = \[([\s\S]*?)\] as const;/.exec(box)![1].match(/"([a-z_]+)"/g)!.map((x) => x.slice(1, -1));
  assert.deepEqual(cats, [...CORRECTION_CATEGORIES], "the page offers the contract's categories");
  assert.match(box, /maxLength=\{500\}/);
  const ssot = read("docs/SSOT.md");
  assert.match(lastReviewedRecord(), /^Last reviewed: 2026-11-16 \((?:[^\n]*; )?HAIC H3c, 2026-11-19 [^\n]*`POST \/v1\/councils\/\{id\}\/corrections`[^\n]*owner_decision[^\n]*corrections-boundary-h3[^\n]*; HAIC H3b, 2026-11-19 /);
  assert.match(ssot, /\*\*Built on the platform:\*\* H0 [^\n]*council and proposal corrections \(H3c/);
  assert.ok(ssot.includes(`a ${CONSOLE_ALLOW_LIST.length}-row allow-list`));
});
