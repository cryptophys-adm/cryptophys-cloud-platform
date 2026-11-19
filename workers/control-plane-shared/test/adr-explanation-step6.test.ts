// The ADR Steward, step 6 (docs/design/ADR-STEWARD.md §4.4 step 7, §4.5, §7, §11 row 6; owner 2026-11-16, "ya semua,
// sesuai rekomendasimu", Q5 and Q6): the AI explanation. The draft_adr_explanation task runs only when an ADR's stored
// status changes, through the kernel's AI engine (the model allow-list, the kernel's daily limit and
// AI_ACCOUNT_DAILY_REQUEST_LIMIT), within the Durable Object's caps: 6 a UTC day, 1 per ADR a day, 2 a cycle, none in
// survival mode. Its deterministic validator keeps only a draft that cites the stored document's evidence; otherwise
// the template sentence stays and adr.explanation_skipped says why. Every task, this one included, is plain English
// (owner 2026-11-17, "all in english please", which removed the per-task Indonesian style of step 6). GET /v1/adr's
// steward.ai_today counts it. A fake AI only (harness
// fakeAi), never a model. Plain fs reads relative to the repository root, so the Forge runner can bundle it. One
// migratedDb() per test at most (sql.js under the Forge).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fakeAi, migratedDb, registeredDb } from "./harness.ts";
import * as aiEngine from "../src/ai-engine.ts";
import { AiEngine, ALLOWED_TEXT_MODELS, DEFAULT_MODEL, PLAIN_ENGLISH_STYLE, utcDay, type AiTask } from "../src/ai-engine.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import { isComplete, type AdrEvaluation, type AdrEvidenceState } from "../src/adr-evidence.ts";
import { draftAuditDigestTask } from "../../ai-kernel/src/auditor.ts";
import { draftTask as supervisorDraftTask } from "../../ai-kernel/src/supervisor.ts";
import { riskTask } from "../../deployment-orchestrator/src/index.ts";
import { overviewTask } from "../../platform-api/src/index.ts";
import { tagTask } from "../../platform-registry/src/index.ts";
import { adrListView } from "../../ai-kernel/src/adr-view.ts";
import {
  ADR_AI_DAILY_CAP, ADR_AI_PER_ADR_DAILY, ADR_AI_PER_CYCLE, ADR_DEFERRED_WORD, ADR_STATUS_WORDS, ADR_STEWARD_ID, applyObservation, buildAdrDoc, checkAdrExplanation,
  draftAdrExplanationTask, explanationInput, runAdrStewardCycle, stewardState, templateSentence, type AdrObservation, type AdrProgressDoc, type StewardState,
} from "../../ai-kernel/src/adr-steward.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const NOW = Date.UTC(2026, 10, 17, 12, 7, 0);
const MIN = 60_000;
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
const GEMMA = "@cf/google/gemma-4-26b-a4b-it";

// ================================================================ synthetic evaluations (the evaluator is step 2's)

type PhaseSpec = { id: string; state: AdrEvidenceState; refs?: string[]; reason?: string | null };
function evaluation(adr: string, phases: PhaseSpec[], o: Partial<AdrEvaluation> = {}): AdrEvaluation {
  return {
    schema: "adr.evaluation.v1", adr, valid: true, title: `ADR ${adr} test title`, lifecycle: "accepted", deferred: false, superseded_by: null, scope: "platform",
    status: "in_progress", phases_total: phases.length, phases_complete: 0, phases_proven: 0, phases_asserted: 0, phases_doc_asserted: 0, phases_external_asserted: 0,
    percent: 0, percent_proven: 0,
    phases: phases.map((p) => ({
      id: p.id, group: null, title: `Phase ${p.id}`, weight: 1, state: p.state, reason: p.reason !== undefined ? p.reason : isComplete(p.state) ? null : `${p.id} has no evidence yet`,
      refs: p.refs ?? [], at: null, live: false, earliest: null, depends_on: [], blockers: isComplete(p.state) ? [] : [`${p.id}: no evidence yet`], built: false,
      doc_claim: null, drift: null, next: null, note: null, pending_owner: [],
    })),
    open: [], blockers: [], next_step: null, owner_actions: [], drift: [], stale: false, stale_sources: [], evaluated_at: iso(NOW), ...o,
  } as AdrEvaluation;
}
const observation = (evals: AdrEvaluation[]): AdrObservation =>
  ({ schema: "adr.observe.v1", evaluated_at: iso(NOW), manifests: evals.map((e) => ({ adr: e.adr, file: `${e.adr}.json`, sha256: `m${e.adr}` })), evaluations: evals });
/** One phase, open (not started) or proven with one ref: a status change each time it flips. */
const single = (adr: string, proven: boolean) => evaluation(adr, [{ id: "P1", state: proven ? "proven" : "open", refs: proven ? [`ev:platform/audit/evt_${adr}@2026-11-17T12:00:00.000Z`] : [] }]);
/** Two phases, one always proven: in progress or done, with evidence to cite either way. */
const pair = (adr: string, proven: boolean) => evaluation(adr, [
  { id: "K", state: "proven", refs: [`ev:platform/d1_migrations/k_${adr}.sql`] },
  { id: "P2", state: proven ? "proven" : "open", refs: proven ? [`ev:platform/audit/evt_${adr}@2026-11-17T12:00:00.000Z`] : [] },
]);

/** The harness's fakeAi, answering each call from its input: by default a valid draft citing the input's first ref. */
type Input = { adr: string; counts: Record<string, number>; changed: { refs: string[] }[]; evidence: { ref: string }[]; from: string; to: string };
const firstRef = (i: Input) => [...i.changed.flatMap((c) => c.refs), ...i.evidence.map((e) => e.ref)][0];
function answeringAi(make: (i: Input) => unknown = (i) => ({ teks: `${i.counts.phases_complete} of ${i.counts.phases_total} phases complete.`, rujukan: [firstRef(i)] })) {
  const ai = fakeAi();
  const run = ai.run.bind(ai);
  ai.run = async (model: string, input: any) => {
    ai.reply = { response: JSON.stringify(make(JSON.parse(input.messages[1].content) as Input)) };
    return run(model, input);
  };
  return ai;
}

function memory() {
  const m = new Map<string, unknown>();
  return { m, async get<T>(k: string) { return m.get(k) as T | undefined; }, async put(k: string, v: unknown) { m.set(k, structuredClone(v)); } };
}
const rows = (db: Db, sql: string, ...args: unknown[]) => db.raw.prepare(sql).all(...(args as never[])) as any[];
const skipped = (db: Db) => rows(db, "SELECT subject, outcome, payload_json FROM audit_events WHERE event_type = 'adr.explanation_skipped' ORDER BY rowid")
  .map((e) => ({ adr: e.subject.slice(4), ...JSON.parse(e.payload_json) }));
const explanationOfRow = (db: Db, adr: string) => JSON.parse(rows(db, "SELECT explanation_json FROM adr_progress WHERE adr_id = ?", adr)[0].explanation_json);
const bodyOf = (db: Db, adr: string) => JSON.parse(rows(db, "SELECT body_json FROM adr_progress WHERE adr_id = ?", adr)[0].body_json) as AdrProgressDoc;

/** A Steward over a migrated database: the kernel's AI settings, a fake AI, and applyObservation as one pass. */
function steward(ai: unknown = answeringAi(), extra: Record<string, unknown> = {}) {
  const db = migratedDb();
  const env: Record<string, unknown> = { DB: db, AI: ai, AI_MODEL: GEMMA, AI_DAILY_REQUEST_LIMIT: "80", AI_ACCOUNT_DAILY_REQUEST_LIMIT: "75", CF_VERSION_METADATA: { id: "ver-self", tag: "abc1234def56" }, ...extra };
  const state: StewardState = { cursor: null, cursor_ids: [], last_pass_at: null, version_id: null, wake_at: null, daily_day: null, retry_at: null, invalid: {}, last_pass: null, ai: null };
  const pass = (evals: AdrEvaluation[], at = NOW, e: unknown = env) => applyObservation(e as never, state, observation(evals), iso(at));
  return { db, env, state, pass };
}

// ================================================================ every task is plain English (ai-engine.ts)

test("AE1. every task is plain English: the ADR explanation too (owner 2026-11-17, \"all in english please\"); no per-task style is left", async () => {
  // The Indonesian exception is gone with its mechanism: no per-task style, no opt-in list, no Indonesian style line.
  for (const name of ["INDONESIAN_STYLE_TASKS", "PLAIN_INDONESIAN_STYLE", "taskStyle"]) assert.equal(name in aiEngine, false, `ai-engine.ts no longer exports ${name}`);
  const adrTask = draftAdrExplanationTask({ status: "in_progress", refs: ["ev:platform/audit/evt_1"], text: "{}" });
  assert.equal("style" in adrTask, false, "the ADR explanation asks for no style of its own");
  assert.match(adrTask.instructions, /^Write a short explanation of one ADR's status change/);
  assert.match(adrTask.instructions, /ADR numbers and phase ids stay as they are/, "identifiers and numbers stay as they are");
  // Every task the platform runs, the ADR explanation included, gets PLAIN_ENGLISH_STYLE in the system message.
  const tasks: AiTask<unknown>[] = [adrTask, draftAuditDigestTask({ denials: undefined } as never), supervisorDraftTask, riskTask, overviewTask, tagTask] as AiTask<unknown>[];
  for (const t of tasks) assert.equal("style" in t, false, t.name);
  const ai = fakeAi({ response: '{"teks":"x","rujukan":[]}' });
  const e = new AiEngine({ service: "cryptophys-ai-kernel", ai, db: migratedDb() as never, allowedModels: ALLOWED_TEXT_MODELS, allowedTasks: tasks.map((t) => t.name) });
  for (const [i, t] of tasks.entries()) await e.run({ ...t, maxInputChars: 100_000 }, { a: 1 }, `c${i}`);
  const system = ai.calls.map((c) => String((c.input as any).messages[0].content));
  assert.equal(system.length, tasks.length);
  for (const [i, s] of system.entries()) {
    assert.ok(s.startsWith(`${tasks[i].instructions}\n${PLAIN_ENGLISH_STYLE}\n`), `${tasks[i].name}: the plain-English style follows the instructions`);
    assert.doesNotMatch(s, /bahasa Indonesia|Indonesian/i, tasks[i].name);
  }
  // Even a task that asks for a style gets plain English: the engine reads no style field.
  await e.run({ ...tasks[1], style: "plain_indonesian" } as AiTask<unknown>, { a: 1 }, "c-style");
  assert.ok(String((ai.calls.at(-1)!.input as any).messages[0].content).includes(PLAIN_ENGLISH_STYLE));
  assert.equal(DEFAULT_MODEL, GEMMA, "no new model");
  // No source asks for an Indonesian style any more.
  const workers = new URL("workers/", ROOT);
  const walk = (rel: string): string[] => (readdirSync(new URL(rel, workers)) as string[]).flatMap((n) => {
    if (n === "node_modules" || n === "dist") return [];
    const f = `${rel}${n}`;
    return statSync(new URL(f, workers)).isDirectory() ? walk(`${f}/`) : [f];
  });
  const users = walk("").filter((f) => /\/src\/.*\.tsx?$/.test(`/${f}`)).filter((f) => /plain_indonesian|PLAIN_INDONESIAN_STYLE|INDONESIAN_STYLE_TASKS|taskStyle/.test(readFileSync(new URL(f, workers), "utf8")));
  assert.deepEqual(users, []);
});

// ================================================================ the validator and the input (§4.5)

test("AE2. the validator: refs only from the stored document (at least one), numbers only from the input, no contradicting status word, bounds", () => {
  const refs = ["ev:platform/audit/evt_a@2026-11-17T12:00:00.000Z", "ev:platform/consensus/cns_b@2026-11-17T11:00:00.000Z"];
  const text = JSON.stringify({ adr: "0012", from: "in_progress", to: "in_progress", counts: { phases_complete: 18, phases_total: 26, percent: 69 } });
  const check = (teks: unknown, rujukan: unknown = [refs[0]], o: { status?: any; deferred?: boolean } = {}) =>
    checkAdrExplanation({ status: o.status ?? "in_progress", deferred: o.deferred, refs, text }, { teks, rujukan });
  const fail = (r: ReturnType<typeof check>) => ("fail" in r ? r.fail : "ok");
  assert.deepEqual(check("0012: 18 of 26 phases complete, 69%. Still in progress."), { ok: { teks: "0012: 18 of 26 phases complete, 69%. Still in progress.", rujukan: [refs[0]] } });
  assert.equal(fail(check("18 of 26 phases complete.", refs)), "ok", "up to six refs, each from the input");
  // Refs.
  assert.equal(fail(check("18 of 26.", [])), "rujukan_missing", "it must cite evidence");
  assert.equal(fail(check("18 of 26.", "ev:x")), "rujukan_missing");
  assert.equal(fail(check("18 of 26.", ["ev:platform/audit/evt_zzz"])), "ref_not_in_input");
  assert.equal(fail(check("18 of 26.", [refs[0], refs[0]])), "rujukan_bounds", "no ref twice");
  assert.equal(fail(check("18 of 26.", Array(7).fill(refs[0]))), "rujukan_bounds");
  // Numbers: every one occurs in the input as a number, not as a digit inside one.
  assert.equal(fail(check("19 of 26 phases complete.")), "number_not_in_input");
  assert.equal(fail(check("8 phases are still open.")), "number_not_in_input", "no arithmetic the input does not state");
  assert.equal(fail(check("1 phase changed.")), "number_not_in_input", "1 is in 18, but not a number of the input");
  // Status words (§6.3, English): only the computed status's, never negated.
  assert.deepEqual({ ...ADR_STATUS_WORDS }, { not_started: "not started", in_progress: "in progress", done: "done", superseded: "superseded", held: "held", planned: "planned" });
  assert.equal(ADR_DEFERRED_WORD, "deferred");
  assert.equal(fail(check("This ADR is done.")), "status_contradiction");
  assert.equal(fail(check("This ADR is held.")), "status_contradiction");
  assert.equal(fail(check("This ADR is planned.")), "status_contradiction");
  assert.equal(fail(check("This ADR is superseded.")), "status_contradiction");
  assert.equal(fail(check("This ADR is not started.")), "status_contradiction");
  assert.equal(fail(check("This ADR is deferred.")), "status_contradiction", "deferred only for a deferred ADR");
  assert.equal(fail(check("This ADR is deferred and in progress.", [refs[0]], { deferred: true })), "ok");
  assert.equal(fail(check("This ADR is not done.")), "ok", "a negated other status is not a claim");
  assert.equal(fail(check("This ADR is not yet done.")), "ok");
  assert.equal(fail(check("This ADR isn't done.")), "ok");
  assert.equal(fail(check("This ADR is not deferred.")), "ok", "a negated deferred badge is not a claim");
  assert.equal(fail(check("This ADR is not in progress.")), "status_contradiction", "the computed status negated");
  assert.equal(fail(check("This ADR is no longer in progress.")), "status_contradiction");
  assert.equal(fail(check("This ADR isn't in  progress.")), "status_contradiction", "whitespace inside the words does not hide them");
  assert.equal(fail(check("This ADR is done.", [refs[0]], { status: "done" })), "ok");
  assert.equal(fail(check("This ADR is not done.", [refs[0]], { status: "done" })), "status_contradiction");
  assert.equal(fail(check("This ADR has not been done.", [refs[0]], { status: "done" })), "status_contradiction");
  assert.equal(fail(check("This ADR is never done.", [refs[0]], { status: "done" })), "status_contradiction");
  assert.equal(fail(check("In progress.", [refs[0]], { status: "done" })), "status_contradiction");
  assert.equal(fail(check("This ADR is not started.", [refs[0]], { status: "not_started" })), "ok", "not started is the computed status's own word");
  assert.deepEqual(Object.keys(ADR_STATUS_WORDS).sort(), ["done", "held", "in_progress", "not_started", "planned", "superseded"]);
  // Bounds, sentences, advisory language, shape.
  assert.equal(fail(check("x".repeat(401))), "teks_bounds");
  assert.equal(fail(check("   ")), "teks_bounds");
  assert.equal(fail(check("One. Two. Three. Four.")), "too_many_sentences");
  assert.equal(fail(check("You should buy now at 26.")), "advisory_language");
  assert.equal(fail(checkAdrExplanation({ status: "done", refs, text }, ["x"])), "not_object");
  // The task wraps it, and names the failed rule for ai_failures (never output content).
  const task = draftAdrExplanationTask({ status: "in_progress", refs, text });
  assert.equal(task.validate({ teks: "19 of 26.", rujukan: [refs[0]] }), null);
  assert.equal(task.diagnose!({ teks: "19 of 26.", rujukan: [refs[0]] }), "number_not_in_input");
  assert.equal(task.maxInputChars, 4_000);
  assert.equal(task.maxOutputTokens, 300);
});

test("AE3. the input: at most 4,000 characters, no ADR prose, the changed phases with their refs, every ref from the document", () => {
  const many = evaluation("0012", Array.from({ length: 40 }, (_, i) => ({
    id: `G${i}`, state: (i % 2 ? "proven" : "open") as AdrEvidenceState, refs: i % 2 ? [`ev:platform/audit/evt_${"x".repeat(60)}${i}@2026-11-17T12:00:00.000Z`, `ev:platform/consensus/cns_${i}`] : [], reason: "r".repeat(400),
  })), { title: "T".repeat(300), owner_actions: [{ phase: "G0", text: "o".repeat(500), href: "#/owner", outside_platform: false, proposal_id: null }] });
  const doc = buildAdrDoc(many, null, { manifest_sha256: "m", deployed_commit: null });
  const { input, refs, text } = explanationInput("in_progress", doc, doc.phases.map((p) => p.id));
  assert.ok(text.length <= 4_000, `${text.length} characters`);
  assert.equal(text, JSON.stringify(input));
  assert.deepEqual(Object.keys(input), ["adr", "title", "from", "to", "deferred", "counts", "changed", "evidence", "next_step", "owner_actions"]);
  assert.ok(String(input.title).length <= 120);
  const all = new Set(doc.phases.flatMap((p) => p.refs));
  assert.ok(refs.length > 0 && refs.every((r) => all.has(r)), "every ref comes from the stored document");
  assert.ok(refs.every((r) => text.includes(JSON.stringify(r))), "and is in the input the model reads");
  assert.equal((input.counts as any).phases_open, doc.phases_total - doc.phases_complete);
  // Changed phases first; the other complete phases' evidence fills in when they did not change.
  const small = buildAdrDoc(evaluation("0003", [{ id: "M1", state: "proven", refs: ["ev:platform/d1_migrations/0003.sql"] }, { id: "M2", state: "open" }]), null, { manifest_sha256: "m", deployed_commit: null });
  const x = explanationInput("not_started", small, ["M2"]);
  assert.deepEqual([(x.input.changed as any[]).map((c) => c.id), (x.input.evidence as any[]).map((e) => e.id), x.refs], [["M2"], ["M1"], ["ev:platform/d1_migrations/0003.sql"]]);
});

// ================================================================ the trigger: a status change only

test("AE4. the AI explains a status change only, cites the stored document, keeps the sentence, and is counted for GET /v1/adr", async () => {
  const ai = answeringAi();
  const { db, env, state, pass } = steward(ai);
  // A first document is not a status change: the sentence, no AI call, no skip.
  const first = await pass([single("0901", false), evaluation("0902", [{ id: "A", state: "open" }, { id: "B", state: "open" }])]);
  assert.deepEqual([first.pass.written, first.pass.explained, first.pass.explanation_skipped, ai.calls.length], [["0901", "0902"], [], [], 0]);
  assert.equal(explanationOfRow(db, "0901").source, "template");
  // A change under the same status (a reason moved) is written, but not explained, and is not a skip.
  const same = await pass([single("0901", false), evaluation("0902", [{ id: "A", state: "open", reason: "another reason" }, { id: "B", state: "open" }])], NOW + MIN);
  assert.deepEqual([same.pass.written, same.pass.explained, ai.calls.length], [["0902"], [], 0]);
  // 0901 not_started -> done: one call, the model of the allow-list, the plain-English style, the bounded input.
  const r = await pass([single("0901", true), evaluation("0902", [{ id: "A", state: "open", reason: "another reason" }, { id: "B", state: "open" }])], NOW + 2 * MIN);
  assert.deepEqual([r.pass.written, r.pass.explained, r.pass.explanation_skipped], [["0901"], ["0901"], []]);
  assert.equal(ai.calls.length, 1);
  const call = ai.calls[0] as { model: string; input: any };
  assert.equal(call.model, GEMMA);
  assert.ok(ALLOWED_TEXT_MODELS.includes(call.model));
  assert.equal(call.input.max_tokens, 300);
  assert.ok(String(call.input.messages[0].content).includes(PLAIN_ENGLISH_STYLE));
  const sent = JSON.parse(call.input.messages[1].content);
  assert.ok(call.input.messages[1].content.length <= 4_000);
  assert.deepEqual([sent.adr, sent.from, sent.to, sent.changed.map((c: any) => c.id)], ["0901", "not_started", "done", ["P1"]]);
  const doc = bodyOf(db, "0901");
  const expl = explanationOfRow(db, "0901");
  assert.deepEqual(expl, { schema: "adr.explanation.v1", source: "ai", teks: "1 of 1 phases complete.", rujukan: [doc.phases[0].refs[0]], template: templateSentence(doc) });
  assert.ok(expl.rujukan.every((x: string) => doc.phases.some((p) => p.refs.includes(x))), "every cited ref is in the stored document");
  const hist = rows(db, "SELECT explanation_json FROM adr_progress_history WHERE adr_id = '0901' ORDER BY revision DESC LIMIT 1")[0];
  assert.deepEqual(JSON.parse(hist.explanation_json), expl, "the history row holds the same explanation");
  assert.deepEqual(skipped(db), []);
  // The counter lives in the Durable Object's state, never in D1 beyond the engine's own ai_usage meter.
  assert.deepEqual(state.ai, { day: "2026-11-17", used: 1, adrs: ["0901"] });
  assert.equal(rows(db, "SELECT SUM(requests) AS n FROM ai_usage WHERE service_id = 'cryptophys-ai-kernel' AND day = ?", utcDay())[0].n, 1);
  // GET /v1/adr: steward.ai_today from that counter; a day it has not counted is 0; an unreadable state is null.
  const mem = memory();
  await mem.put("state", state);
  const ns = (get: () => Promise<StewardState>) => ({ idFromName: (n: string) => n, get: () => ({ state: get }) });
  const view = (t: number, n: unknown) => adrListView({ ...(env as any), ADR_STEWARD: n }, t);
  assert.deepEqual((await view(NOW + 3 * MIN, ns(() => stewardState(mem)))).steward.ai_today, { used: 1, cap: ADR_AI_DAILY_CAP });
  assert.deepEqual((await view(NOW + DAY, ns(() => stewardState(mem)))).steward.ai_today, { used: 0, cap: 6 });
  assert.deepEqual((await view(NOW, ns(async () => { throw new Error("DO down"); }))).steward.ai_today, { used: null, cap: null });
  assert.deepEqual((await view(NOW, undefined)).steward.ai_today, { used: null, cap: null });
  // The body hash leaves the explanation out: the same evidence again rewrites nothing and calls nothing.
  const again = await pass([single("0901", true), evaluation("0902", [{ id: "A", state: "open", reason: "another reason" }, { id: "B", state: "open" }])], NOW + 4 * MIN);
  assert.deepEqual([again.pass.written, ai.calls.length], [[], 1]);
});

// ================================================================ the caps (§7, owner Q6)

test("AE5. the caps: 2 a cycle, 1 per ADR a day, 6 a UTC day, then the next day; each skip is audited with its reason", async () => {
  assert.deepEqual([ADR_AI_DAILY_CAP, ADR_AI_PER_ADR_DAILY, ADR_AI_PER_CYCLE], [6, 1, 2]);
  const ai = answeringAi();
  const { db, state, pass } = steward(ai);
  const ids = ["0911", "0912", "0913", "0914", "0915", "0916", "0917", "0918", "0919"];
  let proven = false;
  const flip = () => { proven = !proven; return ids.map((a) => pair(a, proven)); };
  await pass(ids.map((a) => pair(a, false)));
  const cycles: NonNullable<StewardState["last_pass"]>[] = [];
  for (let i = 1; i <= 4; i++) cycles.push((await pass(flip(), NOW + i * 15 * MIN)).pass);
  // Two a cycle, never the same ADR twice a day, six in all.
  assert.deepEqual(cycles.map((c) => c.explained), [["0911", "0912"], ["0913", "0914"], ["0915", "0916"], []]);
  assert.equal(ai.calls.length, 6);
  assert.deepEqual(state.ai, { day: "2026-11-17", used: 6, adrs: ids.slice(0, 6) });
  const reasons = (c: (typeof cycles)[number]) => c.explanation_skipped!.map((s) => s.reason);
  assert.deepEqual(reasons(cycles[0]), Array(7).fill("daily_cap"));
  const events = skipped(db);
  const capOf = (cycle: number, adr: string) => events.filter((e) => e.adr === adr)[cycle - 1]?.cap;
  assert.equal(capOf(1, "0913"), "cycle");
  assert.equal(capOf(1, "0911"), "adr", "0911 was explained in cycle 1, so cycle 2 skips it per ADR");
  assert.equal(events.filter((e) => e.adr === "0917").at(-1).cap, "day", "the seventh is over the day's cap");
  for (const e of events) {
    assert.deepEqual(Object.keys(e).sort(), ["adr", "cap", "detail", "from", "reason", "revision", "to"]);
    assert.equal(e.reason, "daily_cap");
    assert.ok(e.from !== e.to);
  }
  // The sentence stays for every skipped change.
  for (const id of ["0917", "0918", "0919"]) assert.equal(explanationOfRow(db, id).source, "template", id);
  // The next UTC day starts a new count.
  const next = (await pass(flip(), NOW + DAY)).pass;
  assert.deepEqual(next.explained, ["0911", "0912"]);
  assert.deepEqual(state.ai, { day: "2026-11-18", used: 2, adrs: ["0911", "0912"] });
});

test("AE6. survival mode: no AI call, the sentence, adr.explanation_skipped survival; read as the AI engine reads the mode", async () => {
  const ai = answeringAi();
  const { db, state, pass } = steward(ai);
  const set = (control: string, value: string) => db.raw.prepare("UPDATE metabolism_controls SET value = ? WHERE control = ?").run(value, control);
  await pass([pair("0921", false)]);
  set("power_mode", "survival");
  const r = await pass([pair("0921", true)], NOW + MIN);
  assert.deepEqual([r.pass.written, r.pass.explained, r.pass.explanation_skipped, ai.calls.length], [["0921"], [], [{ adr: "0921", reason: "survival" }], 0]);
  assert.equal(explanationOfRow(db, "0921").source, "template");
  assert.deepEqual(skipped(db).map((e) => [e.adr, e.reason, e.from, e.to]), [["0921", "survival", "in_progress", "done"]]);
  assert.equal(state.ai?.used, 0, "no request spent");
  // The owner's override wins, as in AiEngine.reserve: homeostasis over an automatic survival allows the call ...
  set("power_mode_override", "homeostasis");
  assert.deepEqual((await pass([pair("0921", false)], NOW + 2 * MIN)).pass.explained, ["0921"]);
  // ... and an override to survival stops it.
  set("power_mode", "homeostasis"); set("power_mode_override", "survival");
  assert.deepEqual((await pass([pair("0921", true)], NOW + DAY)).pass.explanation_skipped, [{ adr: "0921", reason: "survival" }]);
  assert.equal(ai.calls.length, 1);
  // The learning mandate is untouched: never a learning call, and power-mode.ts is only read.
  const src = read("workers/ai-kernel/src/adr-steward.ts");
  assert.doesNotMatch(src, /purpose:/);
  assert.match(src, /import \{ isPowerMode \} from "\.\.\/\.\.\/control-plane-shared\/src\/power-mode\.ts";/);
});

test("AE7. the engine's budgets and allow-list: the account cap (budget), a model outside ALLOWED_TEXT_MODELS or no binding (unavailable), no call", async () => {
  const ai = answeringAi();
  const { db, env, state, pass } = steward(ai);
  await pass([single("0931", false), single("0932", false), single("0933", false)]);
  // AI_ACCOUNT_DAILY_REQUEST_LIMIT = 75: the other services used it all today.
  db.raw.prepare("INSERT INTO ai_usage (service_id, day, requests, failures) VALUES ('cryptophys-platform-api', ?, 75, 0)").run(utcDay());
  const full = await pass([single("0931", true), single("0932", false), single("0933", false)], NOW + MIN);
  assert.deepEqual([full.pass.explanation_skipped, ai.calls.length, state.ai?.used], [[{ adr: "0931", reason: "budget" }], 0, 0]);
  assert.equal(skipped(db)[0].detail, "daily_budget_exhausted");
  db.raw.prepare("DELETE FROM ai_usage").run();
  // A model outside the allow-list, or no AI binding: unavailable, nothing reserved.
  const other = await pass([single("0931", true), single("0932", true), single("0933", false)], NOW + 2 * MIN, { ...env, AI_MODEL: "@cf/some/other-model" });
  assert.deepEqual(other.pass.explanation_skipped, [{ adr: "0932", reason: "unavailable" }]);
  const none = await pass([single("0931", true), single("0932", true), single("0933", true)], NOW + 3 * MIN, { ...env, AI: undefined });
  assert.deepEqual(none.pass.explanation_skipped, [{ adr: "0933", reason: "unavailable" }]);
  assert.deepEqual(skipped(db).slice(1).map((e) => e.detail), ["model_not_allowed", "ai_binding_missing"]);
  assert.deepEqual([ai.calls.length, state.ai?.used], [0, 0]);
  assert.equal(rows(db, "SELECT COUNT(*) AS n FROM ai_usage")[0].n, 0, "no request reserved");
});

test("AE8. an invalid draft or an AI error keeps the sentence (invalid_output, unavailable) and counts the request; nothing to cite, no call", async () => {
  let mode: "invented" | "foreign_ref" | "throw" = "invented" as "invented" | "foreign_ref" | "throw";
  const ai = answeringAi((i) => (mode === "invented" ? { teks: "7 of 9 phases complete.", rujukan: [firstRef(i)] } : { teks: "1 of 1 phases complete.", rujukan: ["ev:platform/audit/evt_not_in_the_document"] }));
  const { db, state, pass } = steward(ai);
  await pass([single("0941", false), single("0942", false), single("0943", false), single("0944", true)]);
  const a = await pass([single("0941", true), single("0942", false), single("0943", false), single("0944", true)], NOW + MIN);
  mode = "foreign_ref";
  const b = await pass([single("0941", true), single("0942", true), single("0943", false), single("0944", true)], NOW + 2 * MIN);
  mode = "throw";
  ai.fail = new Error("Workers AI 500");
  const c = await pass([single("0941", true), single("0942", true), single("0943", true), single("0944", true)], NOW + 3 * MIN);
  ai.fail = undefined;
  assert.deepEqual([a, b, c].map((x) => x.pass.explanation_skipped), [[{ adr: "0941", reason: "invalid_output" }], [{ adr: "0942", reason: "invalid_output" }], [{ adr: "0943", reason: "unavailable" }]]);
  assert.deepEqual(skipped(db).map((e) => e.detail), ["schema:number_not_in_input", "schema:ref_not_in_input", "inference_failed"]);
  for (const id of ["0941", "0942", "0943"]) {
    const expl = explanationOfRow(db, id);
    assert.deepEqual([expl.source, expl.teks, expl.rujukan], ["template", templateSentence(bodyOf(db, id)), []], id);
  }
  assert.deepEqual([ai.calls.length, state.ai?.used], [3, 3], "each reached the model, so each counts against the caps");
  assert.deepEqual(rows(db, "SELECT task, category, count FROM ai_failures ORDER BY category").map((r) => `${r.task}:${r.category}:${r.count}`),
    ["draft_adr_explanation:inference_failed:1", "draft_adr_explanation:schema:number_not_in_input:1", "draft_adr_explanation:schema:ref_not_in_input:1"]);
  // A status change with no evidence ref in the document (back to not started): no draft could cite, so no call.
  const back = await pass([single("0941", true), single("0942", true), single("0943", true), single("0944", false)], NOW + 4 * MIN);
  assert.deepEqual([back.pass.explanation_skipped, ai.calls.length], [[{ adr: "0944", reason: "unavailable" }], 3]);
  assert.equal(skipped(db).at(-1).detail, "no_evidence_refs");
});

// ================================================================ the cycle, end to end

test("AE9. one Steward cycle: an executed merge_change moves ADR-0014 from not started; the AI explains it once; the counter is in the Durable Object", async () => {
  const db = registeredDb();
  // Before the evolver is registered (E2 would be proven by its registration alone).
  db.raw.prepare("DELETE FROM agents WHERE agent_id = 'evolver'").run();
  const ai = answeringAi();
  const mem = memory();
  const env: Record<string, unknown> = {
    SERVICE_NAME: "cryptophys-ai-kernel", SERVICE_ENVIRONMENT: "production", API_CONTRACT_VERSION: "v1", DB: db, AI: ai, AI_MODEL: GEMMA,
    AI_DAILY_REQUEST_LIMIT: "80", AI_ACCOUNT_DAILY_REQUEST_LIMIT: "75", CF_VERSION_METADATA: { id: "ver-self", tag: "abc1234def56" },
  };
  const first = await runAdrStewardCycle(env as never, mem, "scheduled", NOW);
  const firstPass = first.findings.filter((f) => f.kind === "adr").at(-1) as any;
  assert.ok(firstPass.written.length > 10, JSON.stringify(first.findings).slice(0, 300));
  assert.deepEqual([firstPass.explained, ai.calls.length], [[], 0], "the first documents are not status changes");
  const before = rows(db, "SELECT adr_id, status FROM adr_progress ORDER BY adr_id");
  assert.equal(before.find((r) => r.adr_id === "0014").status, "not_started");
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, status, created_at, decided_at)
    VALUES ('cns_step6merge', 'supervisor', 'merge_change', 'fg-step6', 'routine', '{}', '{}', 'routine', 7, 7, 0, 1, 'executed', ?, ?)`).run(iso(NOW + MIN), iso(NOW + MIN));
  const second = await runAdrStewardCycle(env as never, mem, "operator", NOW + 2 * MIN);
  const p = second.findings.filter((f) => f.kind === "adr").at(-1) as any;
  const after = rows(db, "SELECT adr_id, status FROM adr_progress ORDER BY adr_id");
  const moved = after.filter((r) => before.find((b) => b.adr_id === r.adr_id).status !== r.status).map((r) => r.adr_id);
  assert.ok(moved.includes("0014"), moved.join(", "));
  assert.deepEqual(p.explained, moved.slice(0, ADR_AI_PER_CYCLE));
  assert.equal(ai.calls.length, Math.min(moved.length, ADR_AI_PER_CYCLE));
  const expl = explanationOfRow(db, "0014");
  assert.equal(expl.source, "ai");
  const doc = bodyOf(db, "0014");
  assert.ok(expl.rujukan.length > 0 && expl.rujukan.every((x: string) => doc.phases.some((ph) => ph.refs.includes(x))), JSON.stringify(expl));
  const sent = ai.calls.map((c) => JSON.parse((c.input as any).messages[1].content)).find((i) => i.adr === "0014");
  const e1 = sent.changed.find((c: any) => c.id === "E1");
  assert.deepEqual([sent.from, sent.to, e1.state, e1.refs], ["not_started", "in_progress", "proven", [`ev:platform/consensus/cns_step6merge@${iso(NOW + MIN)}`]]);
  const st = await stewardState(mem);
  assert.deepEqual([st.ai?.day, st.ai?.used, st.last_pass?.explained], ["2026-11-17", ai.calls.length, p.explained]);
  // A Steward made only adr.* audit events.
  const kinds = rows(db, "SELECT DISTINCT event_type FROM audit_events WHERE actor = ?", `agent:${ADR_STEWARD_ID}`).map((e) => e.event_type);
  assert.ok(kinds.every((k) => k.startsWith("adr.")), kinds.join(", "));
});

// ================================================================ guard paths and the record

test("AE10. no guard path is touched; docs/SSOT.md records step 6 and that every AI text is plain English; the design marks step 6 built and the reversal", () => {
  for (const p of [
    "workers/control-plane-shared/src/ai-engine.ts", "workers/ai-kernel/src/adr-steward.ts", "workers/ai-kernel/src/adr-view.ts",
    "workers/console/ui/src/lib/adr.ts", "workers/console/ui/src/components/AdrPanel.tsx", "workers/console/ui/scripts/render-smoke.mjs",
    "workers/control-plane-shared/test/adr-explanation-step6.test.ts", "workers/control-plane-shared/test/adr-steward-step3.test.ts",
    "workers/control-plane-shared/test/adr-api-step4.test.ts", "workers/control-plane-shared/test/adr-panel-step5.test.ts",
    "docs/SSOT.md", "docs/design/ADR-STEWARD.md",
  ]) assert.equal(criticalPathReason(p), null, p);
  assert.equal(criticalPathReason("workers/control-plane-shared/src/power-mode.ts"), "learning_mandate", "power-mode.ts is a guard path, and step 6 only reads it");
  const ssot = read("docs/SSOT.md");
  assert.match(ssot.split("\n").find((l) => l.startsWith("Last reviewed: "))!, /(?:^Last reviewed: |\); )2026-11-16 \([^\n]*ADR Steward step 6, the AI explanation: [^()]*`draft_adr_explanation`[^()]*`adr\.explanation_skipped`[^()]*; ADR Steward step 5, the Vision page's ADR panel: /);
  assert.match(ssot, /\*\*Workers AI\.\*\*[^\n]*\n(?:  - [^\n]*\n)*  - Every AI text is plain English for operators[^\n]*without exception[^\n]*all in english please/);
  assert.doesNotMatch(ssot, /explanation[^\n]*\bin Indonesian\b|Indonesian exception/, "the SSOT no longer says the explanation is Indonesian");
  assert.match(ssot.split("\n").find((l) => l.startsWith("Last reviewed: "))!, /(?:^Last reviewed: |\); )2026-11-16 \([^\n]*all in english please[^()]*INDONESIAN_STYLE_TASKS[^()]*; /);
  const design = read("docs/design/ADR-STEWARD.md");
  assert.match(design, /\| 6 \| The explanation: [^\n]*\*\*Built 2026-11-17\*\*/);
  assert.match(design, /\*\*Q5\. [^\n]*\*\*Superseded 2026-11-17\*\* by the owner's "all in english please"/);
  assert.match(design, /\*\*Reversal \(2026-11-17, "all in english please"\)\.\*\*/);
});
