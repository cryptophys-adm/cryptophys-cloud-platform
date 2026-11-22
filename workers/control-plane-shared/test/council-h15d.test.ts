// HAIC H1.5d (docs/design/HAIC-H0-H1.md §4.1; owner answer Q9): agents propose councils from evidence (an Observer
// cluster, a KPI regression, a persistent census finding), deduplicated and capped; a proposal is an owner inbox item that
// only the owner begins; unbegun, it is dismissed as expired after 7 days. Deterministic, never a price, never acts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { CouncilError, beginCouncil, dismissCouncil, proposeCouncil, readCouncil, startCouncil, stepCouncil, type CouncilStore } from "../../ai-kernel/src/council.ts";
import { PROPOSAL_LIMITS, censusCandidates, kpiCandidates, observerCandidates, proposeCouncils } from "../../ai-kernel/src/council-proposals.ts";
import { councilProposals, ownerInbox } from "../../ai-kernel/src/owner-inbox.ts";
import { collectNotices } from "../../ai-kernel/src/owner-notices.ts";
import { COUNCIL_PROPOSAL_KIND, rankInbox } from "../src/owner-inbox-rank.ts";
import { COUNCIL_LIMITS, parseRef, refCarriesPrice, validateSession } from "../src/council.ts";
import { UI_ROUTES } from "../../console/src/ui/routes.ts";

const NOW = Date.parse("2026-11-18T10:07:00.000Z");
const H = 3_600_000;
const at = (h: number) => new Date(NOW + h * H).toISOString();
const ID = (n: number) => `cs_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function memStore(): CouncilStore { const m = new Map<string, unknown>(); return { get: async <T>(k: string) => structuredClone(m.get(k)) as T | undefined, put: async (k: string, v: unknown) => { m.set(k, structuredClone(v)); } }; }

function setup() {
  const db = migratedDb();
  const env: any = baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL });
  const stores = new Map<string, CouncilStore>();
  const storeOf = (id: string) => { if (!stores.has(id)) stores.set(id, memStore()); return stores.get(id)!; };
  const settle = async (op: () => Promise<unknown>) => { try { return { ok: true, value: await op() }; } catch (e) { if (e instanceof CouncilError) return { ok: false, status: e.status, code: e.code, message: e.message }; throw e; } };
  let clock = NOW;
  env.COUNCIL = { idFromName: (n: string) => n, get: (n: string) => ({
    propose: (input: any) => settle(() => proposeCouncil(env, storeOf(n), input, clock)),
    begin: (actor: string) => settle(() => beginCouncil(env, storeOf(n), actor, clock)),
    dismiss: (actor: string) => settle(() => dismissCouncil(env, storeOf(n), actor, clock)),
    read: () => settle(() => readCouncil(storeOf(n))),
  }) };
  const events = (type: string) => (db.raw.prepare("SELECT actor, outcome, payload_json FROM audit_events WHERE event_type = ? ORDER BY rowid").all(type) as any[])
    .map((e) => ({ actor: e.actor, outcome: e.outcome, ...JSON.parse(e.payload_json) }));
  return { db, env, storeOf, events, setClock: (t: number) => { clock = t; } };
}
const finding = (db: any, n: number, worker: string, metric: string, hoursAgo: number, z = 4.2) => db.raw.prepare(`INSERT INTO observer_findings
  (finding_id, worker, metric, kind, severity, bucket, value, baseline_7d, z, since_deploy_json, sample_json, detail, report_only, created_at)
  VALUES (?, ?, ?, 'anomaly', 'warning', ?, 120, 40, ?, NULL, '{}', 'cpu above baseline', 0, ?)`).run(`obf_${n}`, worker, metric, `b${n}`, z, at(-hoursAgo));
const snapshot = (db: any, id: string, hoursAgo: number, metrics: unknown[]) => db.raw.prepare(`INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at)
  VALUES (?, 'signal-analyst', 'xauusd_digest', 'info', 'snapshot', ?, 'deterministic', NULL, ?)`).run(id, JSON.stringify({ schema: "trading_organ_health.v1", metrics }), at(-hoursAgo));

test("D1. the detectors: an Observer cluster of 3, a KPI |z| >= 3 or a hit-rate status change, a census finding persisting 24 h", () => {
  const obs = (n: number, metric: string, h: number) => ({ finding_id: `obf_${n}`, worker: "cryptophys-forge", metric, kind: "anomaly", value: 120, baseline_7d: 40, z: 4.2, created_at: at(-h) });
  const o = observerCandidates([obs(1, "cpu_ms_p99", 1), obs(2, "cpu_ms_p99", 3), obs(3, "cpu_ms_p99", 9), obs(4, "errors", 2), obs(5, "errors", 4)]);
  assert.equal(o.length, 1, "two warnings of errors are not a cluster");
  assert.deepEqual([o[0].proposed_by, o[0].trigger_kind, o[0].topic], ["agent:platform-api", "finding", "Repeated Observer warnings: cpu_ms_p99 on cryptophys-forge"]);
  assert.deepEqual(o[0].refs, ["ev:platform/observer_finding/obf_1", "ev:platform/observer_finding/obf_2", "ev:platform/observer_finding/obf_3"], "newest first");
  assert.match(o[0].detail, /^3 warnings of cpu_ms_p99 on cryptophys-forge in 24 h; newest value 120, baseline 40, z 4.2\.$/);
  assert.deepEqual(observerCandidates([obs(1, "a b", 1), obs(2, "a b", 2), obs(3, "a b", 3)]), [], "an unsafe name is never put in a topic");

  const body = (metrics: unknown[]) => ({ report_id: "rpt_s2", created_at: at(-1), body_json: JSON.stringify({ schema: "trading_organ_health.v1", metrics }) });
  const k = kpiCandidates(body([{ metric: "decisions_24h", value: 2, baseline_7d: 40, z: -3.4 }, { metric: "flip_rate_24h", value: 0.1, baseline_7d: 0.09, z: 0.4 },
    { metric: "hit_rate_7d", value: null, status: "no_scored_data" }]), { ...body([{ metric: "hit_rate_7d", value: 0.55, status: "ok" }]), report_id: "rpt_s1" });
  assert.deepEqual(k.map((c) => [c.proposed_by, c.trigger_kind, c.topic, c.refs]), [
    ["agent:signal-analyst", "kpi_regression", "Trading organ KPI regression: decisions_24h", ["ev:platform/report/rpt_s2#metrics"]],
    ["agent:signal-analyst", "kpi_regression", "Trading organ KPI regression: hit_rate_7d", ["ev:platform/report/rpt_s2#metrics"]],
  ]);
  assert.match(k[0].detail, /z -3\.4/);
  assert.equal(k[1].detail, "hit_rate_7d's status changed from ok to no_scored_data.");
  assert.deepEqual(kpiCandidates(null, null), []);

  const census = (sha: string, h: number, findings: unknown[]) => ({ main_sha: sha.padEnd(40, "0"), status: findings.length ? "findings" : "consistent", findings: JSON.stringify(findings), taken_at: at(-h) });
  const f1 = { kind: "unregistered_engine", subject: "cryptophys-ai-kernel:council_position", detail: "x" };
  const f2 = { kind: "undeclared_agent", subject: "ghost", detail: "y" };
  const c = censusCandidates([census("c3", 1, [f1, f2]), census("c2", 20, [f1, f2]), census("c1", 30, [f1]), census("c0", 40, [])], NOW);
  assert.deepEqual(c.map((x) => [x.proposed_by, x.topic, x.refs]), [["agent:auditor", "Persistent census finding: unregistered_engine cryptophys-ai-kernel:council_position", ["ev:platform/census/c30000000000#findings"]]],
    "f2 is only 20 h old");
  for (const cand of [...o, ...k, ...c]) for (const r of cand.refs) { const p = parseRef(r); assert.ok(p && !refCarriesPrice(p), r); }
});

test("D2. the hourly pass proposes through the council's object, audits council.proposed, and deduplicates", async () => {
  const s = setup();
  for (let i = 1; i <= 3; i++) finding(s.db, i, "cryptophys-forge", "cpu_ms_p99", i);
  snapshot(s.db, "rpt_s1", 7, [{ metric: "decisions_24h", value: 2, baseline_7d: 40, z: -3.4 }]);
  const pass = await proposeCouncils(s.env, NOW);
  assert.equal(pass.proposed.length, 2, JSON.stringify(pass));
  const rows = s.db.raw.prepare("SELECT session_id, state, trigger_kind, created_by, topic, owner_present, started_at, evidence_refs_json FROM councils ORDER BY created_by").all() as any[];
  assert.deepEqual(rows.map((r) => [r.state, r.trigger_kind, r.created_by, r.owner_present, r.started_at]), [
    ["proposed", "finding", "agent:platform-api", 0, null], ["proposed", "kpi_regression", "agent:signal-analyst", 0, null]]);
  const { session, messages } = await readCouncil(s.storeOf(rows[0].session_id));
  assert.deepEqual(validateSession(session), []);
  assert.deepEqual([session.state, session.trigger.kind, session.trigger.ref, session.proposal?.proposed_by], ["proposed", "finding", "ev:platform/observer_finding/obf_1", "agent:platform-api"]);
  assert.equal(Date.parse(session.deadline) - NOW, COUNCIL_LIMITS.proposal_cooldown_ms, "7 days to begin it");
  assert.deepEqual([messages.length, messages[0].role, messages[0].phase], [1, "system", "system"]);
  assert.match(messages[0].text, /^Proposed by platform-api: 3 warnings of cpu_ms_p99/);
  assert.deepEqual(s.events("council.proposed").map((e) => [e.actor, e.trigger]), [["agent:signal-analyst", "kpi_regression"], ["agent:platform-api", "finding"]]);

  // An hour later the same evidence, and one new finding: nothing is proposed again while one waits.
  finding(s.db, 4, "cryptophys-forge", "cpu_ms_p99", 0);
  const again = await proposeCouncils(s.env, NOW + H);
  assert.deepEqual([again.proposed, again.skipped.map((x) => x.reason).sort()], [[], ["already_proposed", "already_proposed"]]);

  // Dismissed by the owner: the same topic waits 24 h, then only new evidence brings it back.
  for (const r of rows) await dismissCouncil(s.env, s.storeOf(r.session_id), APPROVER_EMAIL, NOW + 2 * H);
  assert.deepEqual((await proposeCouncils(s.env, NOW + 3 * H)).skipped.map((x) => x.reason).sort(), ["proposed_within_24h", "proposed_within_24h"]);
  const later = await proposeCouncils(s.env, NOW + 26 * H);
  assert.deepEqual(later.skipped.map((x) => [x.topic, x.reason]), [["Trading organ KPI regression: decisions_24h", "no_new_evidence"]],
    "the same snapshot brings nothing new; the Observer cluster has gone (older than 24 h)");
});

test("D3. caps and the kill switch: at most 2 proposals a UTC day and 3 waiting; nothing with the agents off", async () => {
  const s = setup();
  for (const [w, m] of [["cryptophys-forge", "cpu"], ["cryptophys-console", "errors"], ["cryptophys-home", "latency"]]) for (let i = 1; i <= 3; i++) finding(s.db, `${w}${m}${i}` as never, w, m, i);
  const pass = await proposeCouncils(s.env, NOW);
  assert.deepEqual([pass.proposed.length, pass.skipped.map((x) => x.reason)], [PROPOSAL_LIMITS.max_new_per_utc_day, ["daily_limit"]]);
  s.db.raw.prepare("UPDATE kernel_controls SET value = '0' WHERE control = 'agents_enabled'").run();
  assert.deepEqual(await proposeCouncils(s.env, NOW + 24 * H), { proposed: [], skipped: [], reason: "agents_disabled" });
  assert.equal(PROPOSAL_LIMITS.max_pending, 3);
});

test("D4. only the owner begins a proposal; it then deliberates under the usual limits, and proposals never count against them", async () => {
  const s = setup();
  const input = (n: number) => ({ session_id: ID(n), proposed_by: "agent:auditor", trigger_kind: "finding" as const, topic: `Persistent census finding ${n}`,
    question: "Should the DNA change?", refs: [`ev:platform/census/abcdefabcdef#findings`], detail: "Reported for 2 days." });
  for (const n of [1, 2, 3]) await proposeCouncil(s.env, s.storeOf(ID(n)), input(n), NOW);
  // Three proposals wait; the owner can still open a council of their own (proposals are not "open").
  const own = await startCouncil(s.env, s.storeOf(ID(9)), { actor: APPROVER_EMAIL, session_id: ID(9), topic: "Owner topic", question: "Why?" }, NOW);
  assert.equal(own.state, "convening");
  const begun = await beginCouncil(s.env, s.storeOf(ID(1)), APPROVER_EMAIL, NOW + H);
  assert.deepEqual([begun.state, begun.owner_present, begun.trigger.kind], ["convening", true, "finding"]);
  assert.equal(Date.parse(begun.deadline) - (NOW + H), COUNCIL_LIMITS.positions_ms + COUNCIL_LIMITS.rebuttals_ms + COUNCIL_LIMITS.synthesis_ms + COUNCIL_LIMITS.owner_window_ms);
  assert.equal((s.db.raw.prepare("SELECT started_at FROM councils WHERE session_id = ?").get(ID(1)) as any).started_at, at(1));
  const started = s.events("council.started");
  assert.deepEqual(started.map((e) => e.actor), [APPROVER_EMAIL, APPROVER_EMAIL]);
  assert.deepEqual([started[1].trigger, started[1].proposed_by], ["finding", "agent:auditor"]);
  // Two councils now deliberate: a third begin is refused by the open limit, as a third owner's council would be.
  await assert.rejects(beginCouncil(s.env, s.storeOf(ID(2)), APPROVER_EMAIL, NOW + H), (e: any) => e.code === "too_many_open");
  await assert.rejects(beginCouncil(s.env, s.storeOf(ID(1)), APPROVER_EMAIL, NOW + H), (e: any) => e.code === "not_proposed");
  // A proposal past its window cannot be begun, and its alarm dismisses it as expired, even with the agents off.
  s.db.raw.prepare("UPDATE kernel_controls SET value = '0' WHERE control = 'agents_enabled'").run();
  const late = NOW + COUNCIL_LIMITS.proposal_cooldown_ms + H;
  await assert.rejects(beginCouncil(s.env, s.storeOf(ID(3)), APPROVER_EMAIL, late), (e: any) => e.code === "proposal_expired");
  assert.equal((await stepCouncil(s.env, s.storeOf(ID(2)), NOW + 2 * H))?.state, "proposed", "inside its window a proposal just waits");
  const expired = await stepCouncil(s.env, s.storeOf(ID(3)), late);
  assert.deepEqual([expired?.state, expired?.reason], ["dismissed", "proposal_expired"]);
  assert.ok(s.events("council.dismissed").some((e) => e.reason === "proposal_expired"));
  // Bad proposals are refused: no ref, a price ref, a secret, a non-agent proposer.
  for (const [bad, code] of [[{ refs: [] }, "invalid_request"], [{ refs: ["ev:xauusd/signal/abc#entry_price"] }, "invalid_request"],
    [{ detail: "token Bearer abcdefghijklmnopqrstuvwxyz0123456789" }, "secret_refused"], [{ proposed_by: "owner@example.com" }, "invalid_request"]] as const) {
    await assert.rejects(proposeCouncil({ ...s.env }, memStore(), { ...input(7), session_id: ID(7), ...bad } as never, NOW), (e: any) => e.code === code, JSON.stringify(bad));
  }
});

test("D5. a proposal is a low owner inbox item and part of owner_attention; the owner begins it over the route, an operator cannot", async () => {
  const s = setup();
  await proposeCouncil(s.env, s.storeOf(ID(5)), { session_id: ID(5), proposed_by: "agent:signal-analyst", trigger_kind: "kpi_regression", topic: "Trading organ KPI regression: decisions_24h",
    question: "What explains it?", refs: ["ev:platform/report/rpt_s1#metrics"], detail: "decisions_24h is 2 against 40 (z -3.4)." }, NOW);
  const props = await councilProposals(s.db, NOW + H);
  assert.deepEqual(props.map((p) => [p.session_id, p.proposed_by, p.trigger_kind, p.refs]), [[ID(5), "agent:signal-analyst", "kpi_regression", ["ev:platform/report/rpt_s1#metrics"]]]);
  const [item] = rankInbox({ approvals: { recovery_plans: [], consensus: [], knowledge: [] }, critical_reports: [], production_problems: [], council_proposals: props }, NOW + H);
  assert.deepEqual(COUNCIL_PROPOSAL_KIND, { urgency: "low", blocks: [] });
  assert.deepEqual([item.item_id, item.kind, item.urgency, item.action, item.page, item.evidence_refs], [`council:${ID(5)}`, "council_proposed", "low",
    { kind: "start", route: "kernel.council_begin", approver_only: true }, `#/councils/${ID(5)}`, [`ev:platform/council/${ID(5)}`, "ev:platform/report/rpt_s1#metrics"]]);
  assert.equal(item.what, "Council proposed by signal-analyst: Trading organ KPI regression: decisions_24h");
  const inbox = await ownerInbox(s.db, NOW + H) as any;
  assert.deepEqual([inbox.counts.council_proposals, inbox.council_proposals.length, inbox.counts.councils], [1, 1, 0]);
  const notice = (await collectNotices(s.db as never, NOW + H, ["owner_attention"]))[0];
  assert.deepEqual([notice.active, notice.count], [true, 1]);
  assert.match(notice.lines[0], /^#1 Council proposed by signal-analyst: .+#\/owner\/council:/);

  const begin = UI_ROUTES.find((r) => r.id === "kernel.council_begin")!;
  assert.deepEqual([begin.method, begin.path, begin.approverOnly, begin.confirm], ["POST", "/v1/councils/{id}/start", true, "CONVENE {id13}"]);
  const path = `/v1/councils/${ID(5)}/start`;
  const denied = await call(kernel, s.env, req("POST", path, {}, OPERATOR_JWT));
  assert.equal(denied.status, 403);
  const ok = await call(kernel, s.env, req("POST", path, {}, APPROVER_JWT));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.state, "convening");
  assert.equal((await councilProposals(s.db, NOW + H)).length, 0, "begun, it is no longer a proposal");
});

test("D6. the static guard: the proposal module reads and proposes only; the kernel runs it once an hour", () => {
  const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
  const src = read("workers/ai-kernel/src/council-proposals.ts");
  for (const imp of src.matchAll(/^import [\s\S]*? from "([^"]+)";/gm)) assert.doesNotMatch(imp[1], /consensus|syscall|executor|recovery|deploy|merge|git-write|evolution|forge|knowledge|ai-engine/, imp[1]);
  assert.doesNotMatch(src, /consensus\.propose|\.syscall\(|\.dispatch\(|POLICY\.evaluate|DEPLOY\.|\bAI\b\.run|INSERT INTO|UPDATE |DELETE /, "no write but through the council's object, no model call");
  const idx = read("workers/ai-kernel/src/index.ts");
  assert.match(idx, /if \(minute === 7 && env\.COUNCIL\) \{\n\s+ctx\.waitUntil\(proposals = trackJob\(env, "council_proposals", proposeCouncils\(/); // timed since 2026-11-22
  assert.match(idx, /Promise\.all\(\[cycle, fullPass, proposals\]\)\.then\(\(\) => reconcileOwnerAttentionNow\(/);
  const mig = read("workers/control-plane-migrations/0080_council_proposals.sql");
  const code = mig.split("\n").map((l) => l.split("--")[0]).join("\n").toUpperCase();
  assert.ok(!/\b(DROP|DELETE|UPDATE|INSERT|RENAME)\b/.test(code) && (code.match(/ALTER TABLE COUNCILS ADD COLUMN/g) ?? []).length === 4, "0080 only adds four columns and an index");
});
