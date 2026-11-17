// ADR-0014 §11 (owner 2026-11-17: "aktifkan evolver sekarang termasuk jalur balik"), docs/design/EVOLVER.md step V2:
// migration 0076 (evolution_intents, evolutions, evolution_updates, evolver_controls), the intake of council tasks and of
// the platform's own inventory findings (ai-kernel/src/evolution-intake.ts), GET /v1/evolution and the evolver's kill
// switch POST /v1/evolution/mode (ai-kernel/src/evolution-view.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { destructiveMigration, splitSqlStatements, unsupportedStatement } from "../src/migration-rules.ts";
import {
  COUNCIL_HOSTS, PLATFORM_REPO, SPEC_MAX, intakeCouncil, intakeEvolutionIntents, intakeInventory, triageCouncilTask, withoutPrices,
} from "../../ai-kernel/src/evolution-intake.ts";
import { EVOLVER_ON_CONFIRMATION, evolverMode } from "../../ai-kernel/src/evolution-view.ts";

type Db = ReturnType<typeof migratedDb>;
const NOW = Date.parse("2026-11-17T17:07:00.000Z");
const MIGRATION = "0076_evolution.sql";
const MIGRATIONS = new URL("../../control-plane-migrations/", import.meta.url);
const read = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");
const rows = (db: Db, sql: string, ...args: unknown[]) => (db.raw.prepare(sql).all(...(args as never[])) as any[]).map((r) => ({ ...r }));

function withModerator(db: Db, host = "xauusd-ai-trading-assistant", id = "xauusd-moderator"): Db {
  db.raw.prepare(`INSERT OR IGNORE INTO agents (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at, voter)
    VALUES (?, 'Council moderator', ?, 'test', 1, '["reports.publish"]', 'enabled', NULL, 'consensus:test', ?, ?, 0)`)
    .run(id, host, "2026-11-17T00:00:00.000Z", "2026-11-17T00:00:00.000Z");
  return db;
}

const TASK = {
  schema: "typed_proposal.v1", proposal_id: "cp_mwkvn9ec_1en88v", kind: "repository_task", state: "handoff_pending", executor: "cryptophys",
  origin: { council: "cfc_mwktu8ac_v3czfd", option_id: "vol_filter", side: "nexus", repo: "cryptophys-adm/xauusd-ai-trading-assistant", topic: "free:evaluasi-strategy", question: "Evaluasi Strategy" },
  chosen_by: "owner:owner@example.com", chosen_at: "2026-11-17T15:58:41.748Z",
  title: "Add a 15-minute ATR volatility filter for zone_pullback entries",
  hypothesis: "Blocking pull-back trades when short-term volatility spikes cuts large losses.",
  change: "Before a zone_pullback entry is sent, compute the 15-minute ATR.", risk: "Fewer trades.", dissent: "m15",
  spec: "Before a zone_pullback entry is sent, compute the 15-minute ATR; above X % of the range, keep WAIT.",
  evidence_refs: ["ev:xauusd/outcome_summary/engine:15/30d@2026-11-17#hit_rate"], source: "xauusd-ai-trading-assistant",
};

function report(db: Db, body: Record<string, unknown>, o: { agent?: string; kind?: string; at?: number } = {}): string {
  const id = `rpt_${crypto.randomUUID()}`;
  db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at) VALUES (?, ?, ?, 'info', 'Council task', ?, 'deterministic', NULL, ?)")
    .run(id, o.agent ?? "xauusd-moderator", o.kind ?? "xauusd_digest", JSON.stringify(body), new Date(o.at ?? NOW - 60_000).toISOString());
  return id;
}
function finding(db: Db, worker: string, metric: string, at = NOW - 600_000): string {
  const id = `obf_${crypto.randomUUID()}`;
  db.raw.prepare("INSERT INTO observer_findings (finding_id, worker, metric, kind, severity, bucket, detail, report_only, created_at) VALUES (?, ?, ?, 'inventory', 'warning', ?, ?, 1, ?)")
    .run(id, worker, metric, new Date(at).toISOString() + id, `${worker}: ${metric}`, new Date(at).toISOString());
  return id;
}
const intents = (db: Db) => rows(db, "SELECT * FROM evolution_intents ORDER BY created_at, rowid");
const updates = (db: Db) => rows(db, "SELECT * FROM evolution_updates ORDER BY created_at, rowid");
const intentEvents = (db: Db) => rows(db, "SELECT outcome, subject, payload_json FROM audit_events WHERE event_type = 'evolution.intent_recorded' ORDER BY rowid").map((e) => ({ ...e, payload: JSON.parse(e.payload_json) }));

test("EV1. migration 0076 is additive: the next number, four new tables, never destructive, applies twice; the switch starts on", () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const at = files.indexOf(MIGRATION);
  assert.ok(at > 0);
  assert.equal(Number(MIGRATION.slice(0, 4)), Number(files[at - 1].slice(0, 4)) + 1, "the next free number");
  const sql = readFileSync(new URL(MIGRATION, MIGRATIONS), "utf8");
  const statements = splitSqlStatements(sql);
  assert.deepEqual(statements.map((s) => /CREATE TABLE IF NOT EXISTS (\w+)/.exec(s)?.[1]).filter(Boolean), ["evolution_intents", "evolutions", "evolution_updates", "evolver_controls"]);
  assert.equal(destructiveMigration(sql), false, "the native deploy applies it as routine");
  assert.equal(unsupportedStatement(statements), null);
  const db = migratedDb();
  const schema = () => rows(db, "SELECT name, sql FROM sqlite_master ORDER BY name");
  const before = schema();
  db.raw.exec(sql);
  assert.deepEqual(schema(), before, "applied again, nothing changes");
  assert.deepEqual(rows(db, "SELECT control, value FROM evolver_controls"), [{ control: "mode", value: "on" }], "on by the owner's decision of 2026-11-17");
  const ins = (id: string, state: string) => () => db.raw.prepare("INSERT INTO evolution_intents (intent_id, source, source_ref, target_repo, title, state, created_at, updated_at) VALUES (?, 'owner', ?, 'platform', 't', ?, 'a', 'a')").run(id, id, state);
  assert.throws(ins("int_bad", "queued"), /CHECK/, "a malformed id is refused");
  assert.throws(ins("int_0123456789ab", "done"), /CHECK/, "an unknown state is refused");
  ins("int_0123456789ab", "queued")();
  assert.throws(() => db.raw.prepare("INSERT INTO evolution_intents (intent_id, source, source_ref, target_repo, title, state, created_at, updated_at) VALUES ('int_0123456789ac', 'owner', 'int_0123456789ab', 'platform', 't', 'queued', 'a', 'a')").run(), /UNIQUE/, "one intent per (source, source_ref)");
  assert.throws(() => db.raw.prepare("UPDATE evolver_controls SET value = 'maybe'").run(), /CHECK/);
});

test("EV2. an owner-accepted council task for the xauusd repository waits for ADR-0018 X1/X2, recorded once, with its return-path update and audit", async () => {
  const db = withModerator(migratedDb());
  const rid = report(db, TASK);
  const r1 = await intakeEvolutionIntents(db, NOW);
  assert.deepEqual(r1.map((r) => [r.source, r.source_ref, r.state, r.reason, r.outcome]), [["council", TASK.proposal_id, "waiting_external", "adr_0018_x1_x2", "recorded"]]);
  const [i] = intents(db);
  assert.match(i.intent_id, /^int_[0-9a-f]{12}$/);
  assert.deepEqual([i.source, i.target_repo, i.title, i.state, i.state_reason, i.evolution_id], ["council", TASK.origin.repo, TASK.title, "waiting_external", "adr_0018_x1_x2", null]);
  assert.equal(i.spec, TASK.spec);
  const origin = JSON.parse(i.origin_json);
  assert.deepEqual([origin.origin, origin.report_id, origin.agent_id, origin.council, origin.option_id, origin.side, origin.chosen_by], ["xauusd", rid, "xauusd-moderator", TASK.origin.council, "vol_filter", "nexus", TASK.chosen_by]);
  assert.deepEqual(JSON.parse(i.evidence_refs_json), TASK.evidence_refs);
  assert.deepEqual(updates(db).map((u) => [u.intent_id, u.origin, u.proposal_id, u.state, u.reason]), [[i.intent_id, "xauusd", TASK.proposal_id, "waiting_external", "adr_0018_x1_x2"]]);
  assert.deepEqual(intentEvents(db).map((e) => [e.subject, e.outcome, e.payload.source, e.payload.report_id]), [[`intent:${i.intent_id}`, "waiting_external", "council", rid]]);
  // Every later tick, and the same proposal sent again (xauusd retries a failed send hourly): never a second intent.
  report(db, TASK, { at: NOW - 30_000 });
  for (let k = 1; k <= 3; k++) assert.deepEqual(await intakeEvolutionIntents(db, NOW + k * 900_000), []);
  assert.equal(intents(db).length, 1);
  assert.equal(updates(db).length, 1);
  assert.equal(intentEvents(db).length, 1);
});

test("EV3. a council task for the platform repository is queued; price fields never reach D1", async () => {
  const db = withModerator(migratedDb());
  report(db, { ...TASK, proposal_id: "cp_platform_1", origin: { ...TASK.origin, repo: "cryptophys-adm/cryptophys-cloud-platform", price: 2650.5, levels: [2640, 2660] }, entry_price: 2651 });
  const [r] = await intakeCouncil(db, NOW);
  assert.deepEqual([r.state, r.reason], ["queued", null]);
  const [i] = intents(db);
  assert.equal(i.target_repo, PLATFORM_REPO);
  const stored = JSON.stringify(rows(db, "SELECT * FROM evolution_intents")) + JSON.stringify(rows(db, "SELECT payload_json FROM audit_events"));
  assert.ok(!/2650|2651|2640|2660/.test(stored), "no price is stored");
  assert.deepEqual(withoutPrices({ a: 1, price: 2, nested: [{ sl: 3, tp: 4, keep: 5 }] }), { a: 1, nested: [{ keep: 5 }] });
  assert.equal(triageCouncilTask({ ...TASK, origin: { ...TASK.origin, repo: "cryptophys/platform" } })!.target_repo, PLATFORM_REPO);
});

test("EV4. the deterministic triage: invalid tasks are rejected with their reason; other kinds, later states and other hosts are no intent", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ...TASK, proposal_id: "cp_a", executor: "xauusd" }, "executor_not_cryptophys"],
    [{ ...TASK, proposal_id: "cp_b", origin: { ...TASK.origin, side: "cerebrum" } }, "not_from_nexus"],
    [{ ...TASK, proposal_id: "cp_c", chosen_by: "agent:xauusd-moderator" }, "not_chosen_by_owner"],
    [{ ...TASK, proposal_id: "cp_d", spec: "x".repeat(SPEC_MAX + 1) }, "invalid_spec"],
    [{ ...TASK, proposal_id: "cp_e", spec: "" }, "invalid_spec"],
    [{ ...TASK, proposal_id: "cp_f", title: "" }, "invalid_spec"],
    [{ ...TASK, proposal_id: "cp_g", origin: { ...TASK.origin, repo: "" } }, "no_repository"],
    [{ ...TASK, proposal_id: "not a valid id!" }, "invalid_proposal_id"],
  ];
  for (const [body, reason] of cases) assert.deepEqual([triageCouncilTask(body)!.state, triageCouncilTask(body)!.reason], ["rejected", reason], reason);
  assert.equal(triageCouncilTask({ ...TASK, kind: "policy_parameter", knob: "decision.min_confidence", value: 0.45 }), null, "a knob change is xauusd's own");
  assert.equal(triageCouncilTask({ ...TASK, state: "live" }), null, "a later state update is not a new intent");
  assert.equal(triageCouncilTask({ ...TASK, schema: "council_decision.v1" }), null);

  const db = withModerator(withModerator(migratedDb()), "cryptophys-aether", "aether-scribe");
  for (const [body] of cases) report(db, body);
  report(db, { ...TASK, proposal_id: "cp_knob", kind: "policy_parameter" });
  report(db, { ...TASK, proposal_id: "cp_aether" }, { agent: "aether-scribe" });
  report(db, { ...TASK, proposal_id: "cp_kind" }, { kind: "platform_digest" });
  report(db, { ...TASK, proposal_id: "cp_old" }, { at: NOW - 8 * 86_400_000 });
  const r = await intakeCouncil(db, NOW);
  assert.deepEqual(r.map((x) => x.reason).sort(), cases.map(([, reason]) => reason).sort(), "each invalid task recorded once, rejected, with its reason");
  assert.ok(r.every((x) => x.state === "rejected"));
  assert.equal(intents(db).find((i) => i.source_ref.startsWith("report:"))?.state_reason, "invalid_proposal_id", "no valid proposal_id: keyed by its report");
  assert.ok(!intents(db).some((i) => ["cp_knob", "cp_aether", "cp_kind", "cp_old"].includes(i.source_ref)), "a knob, another origin's agent, another report kind, a report older than 7 days");
  assert.deepEqual(await intakeCouncil(db, NOW + 900_000), [], "a rejected task is not evaluated again");
  assert.deepEqual(COUNCIL_HOSTS.includes("xauusd-ai-trading-assistant"), true);
});

test("EV5. the platform's own inventory findings become one intent per subject; external organs' are skipped; a recurrence adds evidence", async () => {
  const db = migratedDb();
  const f1 = finding(db, "cryptophys-mystery", "undeclared_worker");
  finding(db, "xauusd-ai-preview-43727660332", "undeclared_worker");
  finding(db, "d1:aether-knowledge", "undeclared_resource");
  finding(db, "kv:xauusd-signal-cache", "undeclared_resource");
  finding(db, "cryptophys-old", "deleted_worker");
  const r1 = await intakeInventory(db, NOW);
  assert.deepEqual(r1.map((r) => [r.source, r.source_ref, r.state, r.outcome]), [["inventory", "undeclared_worker:cryptophys-mystery", "queued", "recorded"]]);
  const [i] = intents(db);
  assert.deepEqual([i.target_repo, i.state, JSON.parse(i.evidence_refs_json)], [PLATFORM_REPO, "queued", [`ev:platform/observer.finding/${f1}`]]);
  assert.equal(updates(db).length, 0, "the return path carries council intents only");
  assert.deepEqual(await intakeInventory(db, NOW + 900_000), [], "the same finding: nothing new");
  const f2 = finding(db, "cryptophys-mystery", "undeclared_worker", NOW + 1_200_000);
  const r2 = await intakeInventory(db, NOW + 1_800_000);
  assert.deepEqual(r2.map((r) => [r.intent_id, r.outcome]), [[i.intent_id, "evidence_added"]]);
  assert.equal(intents(db).length, 1);
  assert.deepEqual(JSON.parse(intents(db)[0].evidence_refs_json), [`ev:platform/observer.finding/${f1}`, `ev:platform/observer.finding/${f2}`]);
});

test("EV6. before migration 0076 the intake does nothing and the switch reads off", async () => {
  const db = migratedDb();
  for (const t of ["evolution_updates", "evolutions", "evolution_intents", "evolver_controls"]) db.raw.exec(`DROP TABLE ${t}`);
  withModerator(db);
  report(db, TASK);
  assert.deepEqual(await intakeEvolutionIntents(db, NOW), []);
  assert.deepEqual(await evolverMode(db), { mode: "off", updated_by: null, updated_at: null }, "a missing switch never runs the evolver");
});

test("EV7. GET /v1/evolution and the kill switch: off is a brake any operator pulls; on needs the owner and the confirmation", async () => {
  const db = withModerator(migratedDb());
  report(db, TASK);
  await intakeEvolutionIntents(db, NOW);
  const env = baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL });
  const view = await call(kernel, env, req("GET", "/v1/evolution", undefined, OPERATOR_JWT));
  assert.equal(view.status, 200);
  assert.deepEqual([view.body.available, view.body.control.mode, view.body.counts], [true, "on", { waiting_external: 1 }]);
  assert.deepEqual([view.body.intents[0].source, view.body.intents[0].origin.option_id, view.body.intents[0].evidence_refs, view.body.evolutions], ["council", "vol_filter", TASK.evidence_refs, []]);
  assert.equal((await call(kernel, env, req("GET", "/v1/evolution", undefined, null))).status, 403, "behind Access");

  const mode = (body: unknown, jwt: string) => call(kernel, env, req("POST", "/v1/evolution/mode", body, jwt));
  assert.deepEqual([(await mode({ mode: "sideways" }, OPERATOR_JWT)).status], [400]);
  const off = await mode({ mode: "off", reason: "brake test" }, OPERATOR_JWT);
  assert.deepEqual([off.status, off.body.mode, off.body.changed, off.body.updated_by], [200, "off", true, OPERATOR_EMAIL]);
  assert.deepEqual([(await mode({ mode: "off" }, OPERATOR_JWT)).body.changed], [false], "already off: nothing changes");
  const denied = await mode({ mode: "on", confirm: EVOLVER_ON_CONFIRMATION }, OPERATOR_JWT);
  assert.deepEqual([denied.status, denied.body.error], [403, "owner_required"]);
  const unconfirmed = await mode({ mode: "on" }, APPROVER_JWT);
  assert.deepEqual([unconfirmed.status, unconfirmed.body.error], [400, "confirmation_required"]);
  const on = await mode({ mode: "on", confirm: EVOLVER_ON_CONFIRMATION, reason: "owner" }, APPROVER_JWT);
  assert.deepEqual([on.status, on.body.mode, on.body.updated_by], [200, "on", APPROVER_EMAIL]);
  const ev = rows(db, "SELECT actor, outcome, payload_json FROM audit_events WHERE event_type = 'evolution.mode_changed' ORDER BY rowid").map((e) => [e.actor, e.outcome, JSON.parse(e.payload_json).previous]);
  assert.deepEqual(ev, [[OPERATOR_EMAIL, "off", "on"], [APPROVER_EMAIL, "on", "off"]]);
  assert.equal((await call(kernel, env, req("GET", "/v1/evolution/mode", undefined, OPERATOR_JWT))).status, 405);
});

test("EV8. wired into the kernel's cron tick, never acting: the intake writes intents, updates and audit only", () => {
  const index = read("workers/ai-kernel/src/index.ts");
  const scheduled = index.slice(index.indexOf("async scheduled("));
  assert.match(scheduled, /intakeEvolutionIntents\(env\.DB, event\.scheduledTime\)/);
  const intake = read("workers/ai-kernel/src/evolution-intake.ts");
  const written = [...intake.matchAll(/(?:INSERT(?: OR IGNORE)? INTO|UPDATE) (\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(written)].sort(), ["evolution_intents", "evolution_updates"]);
  assert.ok(!/syscall|consensus\.propose|FORGE|fetch\(/.test(intake), "no syscall, no proposal, no Forge call, no network");
  assert.match(read("docs/SSOT.md"), /0076/);
});
