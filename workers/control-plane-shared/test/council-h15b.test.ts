// HAIC H1.5b (docs/design/HAIC-H0-H1.md §4): a Cerebrum council end to end with a fake model: convene, five positions,
// rebuttals, the synthesis (autonomy guard, "no change", confidence capped by verified evidence), the owner's pick into a
// typed_proposal.v1 draft, the limits, the kill switch, expiry, and the routes. One migratedDb() per test at most.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { CouncilError, PERSONAS, dismissCouncil, ownerMessage, pickOption, readCouncil, startCouncil, stepCouncil, type CouncilStore } from "../../ai-kernel/src/council.ts";
import { validateDecision, validateMessage, validateSession } from "../src/council.ts";
import { CHAT_MODEL } from "../src/conversation.ts";

const OWNER = APPROVER_EMAIL;
const ID = "cs_8f14e45f-ceea-467a-9575-5b8a3c1f0a01";
const NOW = Date.parse("2026-11-18T10:00:00.000Z");
function memStore(): CouncilStore { const m = new Map<string, unknown>(); return { get: async <T>(k: string) => structuredClone(m.get(k)) as T | undefined, put: async (k: string, v: unknown) => { m.set(k, structuredClone(v)); } }; }

/** A model that posts positions citing the owner inbox's approval count (one right, one wrong), rebuts the first other position, and synthesises. */
function councilAi(o: { failPositions?: boolean; options?: unknown[] } = {}) {
  const calls: { task: string; input: any; params: any }[] = [];
  return {
    calls,
    async run(_model: string, params: any) {
      const sys = String(params.messages[0].content);
      const input = JSON.parse(params.messages[1].content);
      const task = sys.startsWith("You moderate") ? "synthesis" : sys.includes("Answer at most two") ? "rebuttal" : "position";
      calls.push({ task, input, params });
      const usage = { prompt_tokens: 3000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 2000 } };
      const inbox = input.evidence_pack?.find((e: any) => e.tool === "owner_inbox")?.refs?.[0];
      if (task === "position") {
        if (o.failPositions) throw new Error("model down");
        const agent = input.role_card.agent;
        return { usage, response: { stance: agent === "auditor" ? "oppose" : "support", text: `${agent}: 0 approvals wait; the inbox is clear.`,
          claims: [{ metric: "approvals_waiting", value: 0, refs: [`${inbox}#counts.approvals`] }, { metric: "critical_reports", value: 9, refs: [`${inbox}#counts.critical_reports`] }] } };
      }
      if (task === "rebuttal") return { usage, response: { reply_to: [input.positions[0].seq], stance: "amend", text: "The sample is small.", claims: [] } };
      return { usage, response: { text: "Two options; the owner's constraint is kept.", options: o.options ?? [
        { title: "Shadow a stricter entry", hypothesis: "Fewer stop hits.", change: { type: "shadow_arm", target: "key_level", params: { confirmation: "close" } },
          expected_effect: { metric: "sl_share_30d", from: 0.41, to: 0.3, window: "30d" }, risk: { level: "low", reversible: true }, confidence: 0.9, evidence_refs: [`${inbox}#counts.approvals`], dissent: ["agent:auditor"] },
        { title: "Let the council arm strategies live", hypothesis: "More trades.", change: { type: "policy_parameter", target: "strategy", params: { live_armed: true } },
          expected_effect: { metric: "trades", from: 1, to: 2, window: "7d" }, risk: { level: "high", reversible: true }, confidence: 0.8, evidence_refs: [], dissent: [] },
      ] } };
    },
  };
}
function setup(o: Parameters<typeof councilAi>[0] = {}) {
  const db = migratedDb();
  const ai = councilAi(o);
  const env: any = { ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }), AI: ai };
  const events = (type?: string) => (db.raw.prepare(`SELECT event_type, outcome, payload_json FROM audit_events WHERE event_type LIKE 'council.%' ${type ? "AND event_type = ?" : ""} ORDER BY rowid`).all(...(type ? [type] : [])) as any[])
    .map((e) => ({ type: e.event_type, outcome: e.outcome, ...JSON.parse(e.payload_json) }));
  return { db, env, ai, store: memStore(), events };
}
const run = async (s: ReturnType<typeof setup>, now = NOW) => { for (let i = 0; i < 6; i++) await stepCouncil(s.env, s.store, now); return readCouncil(s.store); };

test("CO1. a council end to end: convene, 5 positions, rebuttals, a synthesis with the autonomy guard and \"no change\", the owner's pick into a draft", async () => {
  const s = setup();
  const started = await startCouncil(s.env, s.store, { actor: OWNER, session_id: ID, topic: "Key Level entries hit SL", question: "Why, and what should run in shadow?" }, NOW);
  assert.deepEqual([started.state, started.convened.length], ["convening", 5]);
  const { session, messages } = await run(s);
  assert.equal(session.state, "awaiting_owner");
  assert.deepEqual(messages.map((m) => m.phase), ["system", ...PERSONAS.map(() => "position"), ...PERSONAS.map(() => "rebuttal"), "synthesis"]);
  for (const m of messages) assert.deepEqual(validateMessage(m), [], `seq ${m.seq}: council.v1`);
  assert.deepEqual(validateSession({ ...session, decision: null }), [], "the session follows council.v1");
  const pos = messages[1];
  assert.deepEqual(pos.claims.map((c) => [c.metric, c.verified]), [["approvals_waiting", true], ["critical_reports", false]], "the right claim verifies, the wrong value does not");
  assert.equal(s.events("council.claim_unverified").length, 5);
  const synth = messages.at(-1)!;
  assert.deepEqual(synth.options!.map((o) => [o.option_id, o.change.type, o.confidence]), [["opt-1", "shadow_arm", 0.9], ["opt-2", "no_change", 0]], "the live-arming option is refused; no change is added");
  const published = s.events("council.synthesis_published")[0];
  assert.deepEqual(published.refused.map((r: any) => r.reason), ["autonomy_or_capability"]);
  assert.equal(session.spent.calls, 11, "5 positions, 5 rebuttals, 1 synthesis");
  assert.ok(session.spent.usd_est > 0 && session.spent.usd_est <= 0.10);
  for (const c of s.ai.calls) assert.equal(c.params.reasoning_effort, "low");
  assert.deepEqual(s.ai.calls[0].input.role_card, { agent: "auditor", role: PERSONAS[0].role, label: "persona of auditor" });
  assert.equal(typeof s.ai.calls[0].input.evidence_pack[0].data_json, "string", "evidence reaches the model as quoted JSON text");
  await assert.rejects(pickOption(s.env, s.store, OWNER, "opt-9", null, NOW), (e: any) => e.status === 400);
  const decided = await pickOption(s.env, s.store, OWNER, "opt-1", "Shadow first.", NOW + 1000);
  assert.equal(decided.state, "decided");
  assert.deepEqual(validateDecision(decided.decision), []);
  assert.deepEqual((decided.decision as any).proposal_draft.requires, ["owner_confirm", "shadow_window", "owner_click_to_promote"]);
  assert.match(decided.transcript_sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual({ ...(s.db.raw.prepare("SELECT state, spent_calls, transcript_sha256 IS NOT NULL AS t FROM councils WHERE session_id = ?").get(ID) as object) }, { state: "decided", spent_calls: 11, t: 1 });
  assert.deepEqual(s.events().map((e) => e.type).filter((t) => !/claim_unverified|position_posted|rebuttal_posted/.test(t)),
    ["council.started", "council.convened", "council.synthesis_published", "council.option_chosen", "council.proposal_drafted"]);
  await assert.rejects(pickOption(s.env, s.store, OWNER, "opt-1", null, NOW + 2000), (e: any) => e.status === 409, "a decided council is not picked again");
});

test("CO2. the owner joins, dismisses, chooses no change; the kill switch aborts; too few positions abort; the owner window expires", async () => {
  const s = setup();
  await startCouncil(s.env, s.store, { actor: OWNER, session_id: ID, topic: "t topic", question: "a question" }, NOW);
  const m = await ownerMessage(s.env, s.store, OWNER, "Keep it shadow only.", NOW);
  assert.deepEqual([m.phase, m.role, m.author], ["owner", "owner", `owner:${OWNER}`]);
  await assert.rejects(ownerMessage(s.env, s.store, OWNER, "token Bearer abcdefghijklmnopqrstu", NOW), (e: any) => e.code === "secret_refused");
  const { session, messages } = await run(s);
  assert.equal(session.state, "awaiting_owner");
  assert.ok(s.ai.calls.at(-1)!.input.owner_messages.some((x: any) => x.text === "Keep it shadow only."), "the moderator sees the owner's message");
  await assert.rejects(ownerMessage(s.env, s.store, OWNER, "late", NOW), (e: any) => e.code === "not_running");
  const noChange = messages.at(-1)!.options!.find((o) => o.change.type === "no_change")!;
  const closed = await pickOption(s.env, s.store, OWNER, noChange.option_id, null, NOW);
  assert.deepEqual([closed.state, closed.reason], ["dismissed", "owner_chose_no_change"]);

  const k = setup();
  await startCouncil(k.env, k.store, { actor: OWNER, session_id: ID, topic: "t topic", question: "q" }, NOW);
  k.db.raw.prepare("UPDATE kernel_controls SET value = '0' WHERE control = 'agents_enabled'").run();
  assert.deepEqual([(await stepCouncil(k.env, k.store, NOW))!.state, (await readCouncil(k.store)).session.reason], ["aborted", "kill_switch"]);
  await assert.rejects(startCouncil(k.env, memStore(), { actor: OWNER, session_id: ID.replace("a01", "a02"), topic: "t", question: "q" }, NOW), (e: any) => e.code === "agents_disabled");

  const f = setup({ failPositions: true });
  await startCouncil(f.env, f.store, { actor: OWNER, session_id: ID, topic: "t topic", question: "q" }, NOW);
  const failed = await run(f);
  assert.deepEqual([failed.session.state, failed.session.reason], ["aborted", "too_few_positions"]);
  assert.ok(failed.messages.filter((x) => x.phase === "position").every((x) => x.stance === "abstain"));

  const e = setup();
  await startCouncil(e.env, e.store, { actor: OWNER, session_id: ID, topic: "t topic", question: "q" }, NOW);
  const waiting = await run(e);
  await stepCouncil(e.env, e.store, Date.parse(waiting.session.deadline) + 1);
  assert.equal((await readCouncil(e.store)).session.state, "expired", "no default option");
  const d = setup();
  await startCouncil(d.env, d.store, { actor: OWNER, session_id: ID, topic: "t topic", question: "q" }, NOW);
  assert.equal((await dismissCouncil(d.env, d.store, OWNER, NOW)).state, "aborted", "a deliberating council the owner stops is aborted");
});

test("CO3. limits: at most 2 open and 4 a UTC day; a topic carrying a secret is refused", async () => {
  const s = setup();
  const ids = [1, 2, 3, 4, 5].map((i) => `cs_8f14e45f-ceea-467a-9575-5b8a3c1f0a0${i}`);
  await startCouncil(s.env, memStore(), { actor: OWNER, session_id: ids[0], topic: "a topic", question: "q" }, NOW);
  await startCouncil(s.env, memStore(), { actor: OWNER, session_id: ids[1], topic: "b topic", question: "q" }, NOW);
  await assert.rejects(startCouncil(s.env, memStore(), { actor: OWNER, session_id: ids[2], topic: "c", question: "q" }, NOW), (e: any) => e.code === "too_many_open");
  s.db.raw.prepare("UPDATE councils SET state = 'expired'").run();
  await startCouncil(s.env, memStore(), { actor: OWNER, session_id: ids[2], topic: "c topic", question: "q" }, NOW);
  s.db.raw.prepare("UPDATE councils SET state = 'expired'").run();
  await startCouncil(s.env, memStore(), { actor: OWNER, session_id: ids[3], topic: "d topic", question: "q" }, NOW);
  s.db.raw.prepare("UPDATE councils SET state = 'expired'").run();
  await assert.rejects(startCouncil(s.env, memStore(), { actor: OWNER, session_id: ids[4], topic: "e", question: "q" }, NOW), (e: any) => e.code === "daily_limit");
  await assert.rejects(startCouncil(s.env, memStore(), { actor: OWNER, session_id: ids[4], topic: "Bearer abcdefghijklmnopqrstu", question: "q" }, NOW + 86_400_000), (e: any) => e instanceof CouncilError && e.code === "secret_refused");
});

test("CO4. the routes: operators read; only the owner opens, joins, picks or dismisses; one object per session", async () => {
  const s = setup();
  const objects = new Map<string, CouncilStore>();
  const settle = async (op: () => Promise<unknown>) => { try { return { ok: true, value: await op() }; } catch (e: any) { if (e instanceof CouncilError) return { ok: false, status: e.status, code: e.code, message: e.message }; throw e; } };
  s.env.COUNCIL = { idFromName: (n: string) => n, get: (n: string) => {
    const st = objects.get(n) ?? memStore(); objects.set(n, st);
    return { start: (a: string, id: string, t: unknown, q: unknown) => settle(() => startCouncil(s.env, st, { actor: a, session_id: id, topic: t, question: q })),
      read: () => settle(() => readCouncil(st)), message: (a: string, t: unknown) => settle(() => ownerMessage(s.env, st, a, t)),
      pick: (a: string, o: unknown, n2: unknown) => settle(() => pickOption(s.env, st, a, o, n2)), dismiss: (a: string) => settle(() => dismissCouncil(s.env, st, a)) };
  } };
  assert.equal((await call(kernel, s.env, req("POST", "/v1/councils", { topic: "t", question: "q" }, OPERATOR_JWT))).status, 403, "operators do not open councils");
  const open = await call(kernel, s.env, req("POST", "/v1/councils", { topic: "Key Level entries", question: "Why so many stops?" }, APPROVER_JWT));
  assert.equal(open.status, 201, JSON.stringify(open.body));
  const id = open.body.session_id;
  assert.match(id, /^cs_[0-9a-f-]{36}$/);
  assert.deepEqual([...objects.keys()], [id]);
  const list = await call(kernel, s.env, req("GET", "/v1/councils", undefined, OPERATOR_JWT));
  assert.deepEqual([list.status, list.body.councils.map((c: any) => [c.session_id, c.state])], [200, [[id, "convening"]]]);
  const one = await call(kernel, s.env, req("GET", `/v1/councils/${id}`, undefined, OPERATOR_JWT));
  assert.deepEqual([one.status, one.body.session.topic], [200, "Key Level entries"]);
  assert.equal((await call(kernel, s.env, req("POST", `/v1/councils/${id}/messages`, { text: "x" }, OPERATOR_JWT))).status, 403);
  assert.equal((await call(kernel, s.env, req("POST", `/v1/councils/${id}/messages`, { text: "Shadow only." }, APPROVER_JWT))).status, 200);
  assert.equal((await call(kernel, s.env, req("POST", `/v1/councils/${id}/dismiss`, {}, APPROVER_JWT))).body.state, "aborted");
  assert.equal((await call(kernel, s.env, req("GET", "/v1/councils/cs_00000000-0000-0000-0000-000000000000", undefined, OPERATOR_JWT))).status, 404);
  assert.equal((await call(kernel, s.env, req("DELETE", `/v1/councils/${id}`, undefined, APPROVER_JWT))).status, 405);
});

test("CO5. wiring and the static guard: the DO and migration v8, the DNA's three tasks, and no council module that writes or executes", () => {
  const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
  const toml = read("workers/ai-kernel/wrangler.toml");
  assert.match(toml, /\[\[durable_objects\.bindings\]\]\nname = "COUNCIL"\nclass_name = "CouncilAgent"/);
  assert.match(toml, /\[\[migrations\]\]\ntag = "v8"\nnew_sqlite_classes = \["CouncilAgent"\]/);
  assert.match(read("workers/ai-kernel/src/worker.ts"), /export class CouncilAgent extends DurableObject<Env>/);
  const dna = JSON.parse(read("workers/ai-kernel/organism.json"));
  for (const t of ["council_position", "council_rebuttal", "council_synthesis"]) assert.ok(dna.engines.some((e: any) => e.task === t), t);
  for (const f of ["workers/ai-kernel/src/council.ts", "workers/control-plane-shared/src/council.ts"]) {
    const src = read(f);
    for (const imp of src.matchAll(/^import [\s\S]*? from "([^"]+)";/gm)) assert.doesNotMatch(imp[1], /consensus|syscall|executor|recovery|deploy|merge|git-write|evolution|forge|knowledge/, `${f} imports ${imp[1]}`);
    assert.doesNotMatch(src, /consensus\.propose|\.syscall\(|\.dispatch\(|POLICY\.evaluate|FORGE_EVOLUTION|DEPLOY\./, `${f}: no executor or proposal path`);
  }
  assert.equal(CHAT_MODEL, "@cf/deepseek-ai/deepseek-v4.1-flash-1017");
});
