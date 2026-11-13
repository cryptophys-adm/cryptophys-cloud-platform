// ADR-0009 amendment 2026-11-13 (owner: "Tambah tombol 'acknowledge'"): an approver, a person, acknowledges a
// critical agent report as handled; it then no longer counts as open for the consensus baseline. Unacknowledged
// critical reports keep blocking; warnings and info cannot be acknowledged. One migratedDb() per test at most
// (the Forge runs these under sql.js, whose wasm heap never shrinks).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, CI_JWT, OPERATOR_EMAIL, OPERATOR_JWT, OUTSIDER_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { baseline, castVote, classify, type Proposal } from "../src/consensus-rules.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { observe } from "../../ai-kernel/src/syscall.ts";
import { gatherEvidence } from "../../ai-kernel/src/consensus.ts";
import { collectNotices } from "../../ai-kernel/src/owner-notices.ts";
import { acknowledgePhrase } from "../../ai-kernel/src/reports.ts";
import { UI_ROUTES } from "../../console/src/ui/routes.ts";
import { CONSOLE_ALLOW_LIST } from "../../console/src/index.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const BLOCK = "a critical report is open in the last 24 h";
const REASON = "Cause fixed and live; production unchanged by the failed deploy.";

function kernelEnv(db: Db) {
  return baseEnv("cryptophys-ai-kernel", db, {
    OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`,
    APPROVER_IDENTITIES: APPROVER_EMAIL,
  });
}

function insertReport(db: Db, severity: "critical" | "warning" | "info", subject: string, minutesAgo = 5): string {
  const id = `rpt_${crypto.randomUUID()}`;
  db.raw.prepare(`INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at)
    VALUES (?, 'supervisor', 'platform_digest', ?, ?, '{}', 'deterministic', NULL, ?)`).run(id, severity, subject, new Date(Date.now() - minutesAgo * 60_000).toISOString());
  return id;
}

const ack = (env: unknown, id: string, body: unknown, jwt: string = APPROVER_JWT) =>
  call(kernel, env, req("POST", `/v1/reports/${id}/acknowledge`, body, jwt));
const ackEvents = (db: Db, id: string) => db.raw.prepare("SELECT * FROM audit_events WHERE event_type = 'report.acknowledged' AND subject = ?").all(`report:${id}`) as any[];
const proposal: Proposal = { action: "registry_enable_service", target: "cryptophys-policy-engine", params: {}, class: classify("registry_enable_service")! };

test("A1. an unacknowledged critical report blocks; the approver's acknowledgement is audited, drops the count and lifts that brake; a second critical report still blocks", async () => {
  const db = migratedDb();
  const env = kernelEnv(db);
  const first = insertReport(db, "critical", "Deploy of control-plane at 8cc865b9d77b failed");

  // Today's behaviour: the open critical report makes every voter reject.
  let e = await gatherEvidence({ DB: db } as never, proposal.action, proposal.target);
  assert.equal(e.critical_reports_24h, 1);
  assert.equal(baseline(e), BLOCK);
  assert.deepEqual([castVote("platform-registry", proposal, e).vote, castVote("platform-registry", proposal, e).reason], ["reject", BLOCK]);

  const r = await ack(env, first, { confirm: acknowledgePhrase(first), reason: `  ${REASON}  ` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.already_acknowledged, false);
  assert.equal(r.body.acknowledgement.acknowledged_by, APPROVER_EMAIL);
  assert.equal(r.body.acknowledgement.reason, REASON, "the reason is stored trimmed");

  // The audit event is in the chain, by the approver, with the report's identity and the reason.
  const events = ackEvents(db, first);
  assert.equal(events.length, 1);
  assert.equal(events[0].actor, APPROVER_EMAIL);
  assert.equal(events[0].outcome, "acknowledged");
  assert.deepEqual(JSON.parse(events[0].payload_json), { report_id: first, agent_id: "supervisor", kind: "platform_digest", subject: "Deploy of control-plane at 8cc865b9d77b failed", reason: REASON });
  assert.equal(events[0].created_at, r.body.acknowledgement.acknowledged_at, "row and event are written together");
  assert.equal((await verifyAuditChain(db)).valid, true);

  // The count drops, the overview says how many were acknowledged, and the brake no longer fires for it.
  const ov: any = await observe(env as never);
  assert.deepEqual(ov.agent_reports_24h.counts, { critical: 0, warning: 0, info: 0, critical_acknowledged: 1 });
  assert.deepEqual(ov.agent_reports_24h.latest_critical, []);
  assert.deepEqual(ov.agent_reports_24h.latest_attention, []);
  e = await gatherEvidence({ DB: db } as never, proposal.action, proposal.target);
  assert.equal(e.critical_reports_24h, 0);
  assert.equal(baseline(e), null);
  assert.notEqual(castVote("platform-registry", proposal, e).reason, BLOCK);

  // A second, unacknowledged critical report blocks exactly as before.
  const second = insertReport(db, "critical", "Rollback of Cerebrum Console failed", 1);
  e = await gatherEvidence({ DB: db } as never, proposal.action, proposal.target);
  assert.equal(e.critical_reports_24h, 1);
  assert.deepEqual([castVote("platform-registry", proposal, e).vote, castVote("platform-registry", proposal, e).reason], ["reject", BLOCK]);
  const ov2: any = await observe(env as never);
  assert.deepEqual(ov2.agent_reports_24h.latest_critical.map((c: any) => c.report_id), [second]);
  assert.deepEqual(ov2.agent_reports_24h.counts, { critical: 1, warning: 0, info: 0, critical_acknowledged: 1 });

  // The owner notice counts the open one only.
  const notice = (await collectNotices(db as never)).find((n) => n.topic === "critical_reports")!;
  assert.equal(notice.active, true);
  assert.equal(notice.lines.length, 1);
  assert.match(notice.lines[0], /Rollback of Cerebrum Console failed/);
});

test("A2. idempotent: a repeat returns the existing acknowledgement and writes no second audit event; GET /v1/reports shows it", async () => {
  const db = migratedDb();
  const env = kernelEnv(db);
  const id = insertReport(db, "critical", "Deploy failed");
  const other = insertReport(db, "critical", "Another critical report", 2);
  const warn = insertReport(db, "warning", "Console drifts", 3);
  const first = await ack(env, id, { confirm: acknowledgePhrase(id), reason: REASON });
  assert.equal(first.status, 200);
  const again = await ack(env, id, { confirm: acknowledgePhrase(id), reason: "A different reason the second time." });
  assert.equal(again.status, 200);
  assert.equal(again.body.already_acknowledged, true);
  assert.deepEqual(again.body.acknowledgement, first.body.acknowledgement, "the first acknowledgement stands");
  assert.equal(ackEvents(db, id).length, 1, "no second audit event");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_report_acknowledgements").get() as any).n, 1);

  const list = await call(kernel, env, req("GET", "/v1/reports?limit=10", undefined, OPERATOR_JWT));
  assert.equal(list.status, 200);
  const byId = Object.fromEntries(list.body.reports.map((r: any) => [r.report_id, r]));
  assert.deepEqual(byId[id].acknowledgement, { acknowledged_by: APPROVER_EMAIL, reason: REASON, acknowledged_at: first.body.acknowledgement.acknowledged_at });
  assert.equal(byId[other].acknowledgement, null);
  assert.equal(byId[warn].acknowledgement, null);
  // Filters still apply with the acknowledgement join.
  const filtered = await call(kernel, env, req("GET", "/v1/reports?agent_id=supervisor&kind=platform_digest&limit=1", undefined, OPERATOR_JWT));
  assert.equal(filtered.body.reports.length, 1);
  assert.equal(filtered.body.reports[0].report_id, other, "newest first");
});

test("A3. only an approver who is a person: operators, the service token and outsiders get 403 and nothing is written", async () => {
  const db = migratedDb();
  const env = kernelEnv(db);
  const id = insertReport(db, "critical", "Deploy failed");
  const body = { confirm: acknowledgePhrase(id), reason: REASON };
  for (const [who, jwt] of [["operator", OPERATOR_JWT], ["service token", CI_JWT], ["outsider", OUTSIDER_JWT]] as const) {
    const r = await ack(env, id, body, jwt);
    assert.equal(r.status, 403, `${who}: ${JSON.stringify(r.body)}`);
  }
  assert.equal(ackEvents(db, id).length, 0);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_report_acknowledgements").get() as any).n, 0);
  assert.equal((await gatherEvidence({ DB: db } as never, proposal.action, proposal.target)).critical_reports_24h, 1);
  // GET is not an acknowledgement.
  assert.equal((await call(kernel, env, req("GET", `/v1/reports/${id}/acknowledge`, undefined, APPROVER_JWT))).status, 405);
});

test("A4. refusals: wrong phrase and a short or long reason 400, a warning 409 not_critical, an unknown or malformed id 404", async () => {
  const db = migratedDb();
  const env = kernelEnv(db);
  const id = insertReport(db, "critical", "Deploy failed");
  const warn = insertReport(db, "warning", "Console drifts");
  const info = insertReport(db, "info", "All nominal");
  const phrase = acknowledgePhrase(id);
  assert.equal(phrase, `ACKNOWLEDGE ${id.slice(0, 12)}`, "rpt_ plus 8 hex: the Console's {id13} without the trailing hyphen");

  for (const confirm of [undefined, "", "ACKNOWLEDGE", `APPROVE ${id.slice(0, 12)}`, `ACKNOWLEDGE ${acknowledgePhrase(warn).slice(12)}`, phrase.toLowerCase()]) {
    const r = await ack(env, id, { confirm, reason: REASON });
    assert.deepEqual([r.status, r.body.error], [400, "confirmation_required"], String(confirm));
  }
  for (const reason of [undefined, "", "too short", "         x         ", "x".repeat(501), 42]) {
    const r = await ack(env, id, { confirm: phrase, reason });
    assert.deepEqual([r.status, r.body.error], [400, "invalid_reason"], String(reason));
  }
  assert.equal((await ack(env, id, { confirm: phrase, reason: "x".repeat(500) })).status, 200, "500 characters is the bound");

  for (const r of [warn, info]) {
    const res = await ack(env, r, { confirm: acknowledgePhrase(r), reason: REASON });
    assert.deepEqual([res.status, res.body.error], [409, "not_critical"]);
  }
  const unknown = `rpt_${crypto.randomUUID()}`;
  assert.deepEqual([(await ack(env, unknown, { confirm: acknowledgePhrase(unknown), reason: REASON })).status], [404]);
  assert.equal((await ack(env, "rpt_not-a-uuid", { confirm: "ACKNOWLEDGE rpt_not-a-uu", reason: REASON })).status, 404);
  assert.equal((await ack(env, `cns_${crypto.randomUUID()}`, { confirm: "x", reason: REASON })).status, 404);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'report.acknowledged'").get()!.n, 1);
});

test("A5. fail closed: without migration 0053's table every critical report stays open, GET /v1/reports still answers", async () => {
  const db = migratedDb();
  const env = kernelEnv(db);
  const id = insertReport(db, "critical", "Deploy failed");
  db.raw.exec("DROP TABLE agent_report_acknowledgements");
  const ov: any = await observe(env as never);
  assert.equal(ov.agent_reports_24h.error, undefined);
  assert.deepEqual(ov.agent_reports_24h.counts, { critical: 1, warning: 0, info: 0, critical_acknowledged: 0 });
  assert.deepEqual(ov.agent_reports_24h.latest_critical.map((c: any) => c.report_id), [id]);
  assert.equal(baseline(await gatherEvidence({ DB: db } as never, proposal.action, proposal.target)), BLOCK);
  assert.equal((await collectNotices(db as never)).find((n) => n.topic === "critical_reports")!.active, true);
  const list = await call(kernel, env, req("GET", "/v1/reports", undefined, OPERATOR_JWT));
  assert.equal(list.status, 200);
  assert.equal(list.body.reports[0].acknowledgement, null);
  // The acknowledgement itself cannot be written without its table, so nothing changes.
  const r = await ack(env, id, { confirm: acknowledgePhrase(id), reason: REASON });
  assert.equal(r.status, 500);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'report.acknowledged'").get()!.n, 0);
});

test("A6. Console and docs: one approver-only route with the ACKNOWLEDGE {id13} phrase, allow-listed; migration 0053 is additive", () => {
  const route = UI_ROUTES.find((r) => r.id === "kernel.report_acknowledge");
  assert.deepEqual(route, { id: "kernel.report_acknowledge", service: "kernel", method: "POST", path: "/v1/reports/{id}/acknowledge", approverOnly: true, confirm: "ACKNOWLEDGE {id13}" });
  assert.ok(CONSOLE_ALLOW_LIST.some((a) => a.service === "kernel" && a.method === "POST" && a.path === "/v1/reports/{id}/acknowledge"));
  // The Console builds {id13} as the first 13 characters without a trailing separator; the kernel expects the same.
  const id = "rpt_4c0738b9-0000-4000-8000-000000000000";
  assert.equal(acknowledgePhrase(id), `ACKNOWLEDGE ${id.slice(0, 13).replace(/[-_.:]+$/, "")}`);
  const ui = readFileSync(new URL("workers/console/ui/src/components/CriticalReports.tsx", ROOT), "utf8");
  assert.match(ui, /who\.approver \?/, "the action is shown to approvers only");
  assert.match(ui, /maxLength=\{REASON_MAX\}/);
  assert.match(ui, /r\.acknowledgement\.acknowledged_by/, "who acknowledged comes from the API");
  const sql = readFileSync(new URL("workers/control-plane-migrations/0053_agent_report_acknowledgements.sql", ROOT), "utf8");
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /\b(DROP|DELETE|UPDATE|ALTER)\b/i);
  const index = readFileSync(new URL("workers/ai-kernel/src/index.ts", ROOT), "utf8");
  assert.match(index, /"POST \/v1\/reports\/\{id\}\/acknowledge \(APPROVER_IDENTITIES person; critical reports only\)"/);
});
