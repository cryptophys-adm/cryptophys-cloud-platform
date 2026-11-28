// Issue #327 C3 (owner 2026-11-28: "Ya Kerjakan", "... ada arsip beserta statusnya"): the Console's External intents
// panel and the Archive. GET /v1/evolution gives each intent its last update; GET /v1/evolution/intents/{id} gives one
// intent with its full history from the audit trail (ai-kernel/src/evolution-view.ts). Read only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { intakeCouncil } from "../../ai-kernel/src/evolution-intake.ts";
import { expireExternalIntents, progressExternalIntent } from "../../ai-kernel/src/evolution-progress.ts";
import { closeExternalIntent } from "../../ai-kernel/src/evolution-close.ts";
import { intentDetail } from "../../ai-kernel/src/evolution-view.ts";

type Db = ReturnType<typeof migratedDb>;
const NOW = Date.parse("2026-11-28T12:07:00.000Z");
const XAU = "cryptophys-adm/xauusd-ai-trading-assistant";
const PR = `https://github.com/${XAU}/pull/661`;
const read = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");
const TASK = {
  schema: "typed_proposal.v1", kind: "repository_task", state: "handed_off", executor: "cryptophys",
  origin: { council: "cfc_mx01aa_sess01", option_id: "atr", side: "nexus", repo: XAU },
  chosen_by: "council", topic_approved_by: "owner:owner@example.com", session_id: "cfc_mx01aa_sess01",
  title: "Add a volatility filter", spec: "Keep WAIT when short-term volatility spikes.", evidence_refs: [],
};

async function seeded(proposals: string[]): Promise<{ db: Db; ids: string[] }> {
  const db = migratedDb();
  db.raw.prepare(`INSERT OR IGNORE INTO agents (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at, voter)
    VALUES ('xauusd-moderator', 'Council moderator', 'xauusd-ai-trading-assistant', 'test', 1, '["reports.publish"]', 'enabled', NULL, 'consensus:test', ?, ?, 0)`)
    .run("2026-11-17T00:00:00.000Z", "2026-11-17T00:00:00.000Z");
  for (const p of proposals) {
    db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at) VALUES (?, 'xauusd-moderator', 'xauusd_digest', 'info', 'Council task', ?, 'deterministic', NULL, ?)")
      .run(`rpt_${crypto.randomUUID()}`, JSON.stringify({ ...TASK, proposal_id: p }), new Date(NOW - 60_000).toISOString());
  }
  const out = await intakeCouncil(db, NOW);
  return { db, ids: proposals.map((p) => out.find((r) => r.source_ref === p)!.intent_id) };
}
const env = (db: Db) => baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL });
const owner = { actor: APPROVER_EMAIL, owner: true };

test("EA1. GET /v1/evolution/intents/{id}: the intent with its next actor and its full history, oldest first (recorded, progress, closed)", async () => {
  const { db, ids: [id] } = await seeded(["cp_ea1"]);
  await progressExternalIntent(db, owner, id, { state: "in_progress", note: "picked up" }, NOW + 1000);
  await progressExternalIntent(db, owner, id, { state: "proposed", ref: PR }, NOW + 2000);
  await progressExternalIntent(db, owner, id, { state: "refused", note: "superseded" }, NOW + 3000);
  const res = await call(kernel, env(db), req("GET", `/v1/evolution/intents/${id}`, undefined, OPERATOR_JWT));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual([res.body.intent.intent_id, res.body.intent.state, res.body.intent.close_code, res.body.intent.next_actor, res.body.intent.assignee], [id, "refused", "refused", "none", "xauusd-worker"]);
  assert.deepEqual(res.body.history.map((h: any) => [h.event, h.state, h.from, h.ref, h.note]), [
    ["recorded", "queued_external", null, null, null],
    ["progress", "in_progress", "waiting_external", null, "picked up"],
    ["progress", "proposed", "in_progress", { pr_url: PR }, null],
    ["progress", "refused", "proposed", null, "superseded"],
  ]);
  assert.equal(res.body.history[1].actor, APPROVER_EMAIL);
  // Unknown and malformed ids; any other method on the detail path is not a route.
  assert.deepEqual([(await call(kernel, env(db), req("GET", "/v1/evolution/intents/int_ffffffffffff", undefined, OPERATOR_JWT))).body.error], ["intent_not_found"]);
  assert.equal((await call(kernel, env(db), req("GET", "/v1/evolution/intents/int_FF", undefined, OPERATOR_JWT))).status, 404);
  assert.equal((await call(kernel, env(db), req("POST", `/v1/evolution/intents/${id}`, {}, OPERATOR_JWT))).status, 404);
  assert.equal((await call(kernel, env(db), req("GET", `/v1/evolution/intents/${id}`, undefined, null))).status, 403);
});

test("EA2. GET /v1/evolution: each intent's last update (time, actor, ref, note), expired and owner-closed included; next_actor and close_code", async () => {
  const { db, ids: [a, b, c] } = await seeded(["cp_ea2a", "cp_ea2b", "cp_ea2c"]);
  await progressExternalIntent(db, owner, a, { state: "in_progress" }, NOW + 1000);
  await progressExternalIntent(db, owner, a, { state: "proposed", ref: PR, note: "PR opened" }, NOW + 2000);
  await closeExternalIntent(db, APPROVER_EMAIL, b, "not supported by the replay", NOW + 3000);
  await expireExternalIntents(db, NOW + 8 * 86_400_000);
  const res = await call(kernel, env(db), req("GET", "/v1/evolution", undefined, OPERATOR_JWT));
  assert.equal(res.status, 200);
  const by = (id: string) => (res.body.intents as any[]).find((i) => i.intent_id === id);
  assert.deepEqual([by(a).state, by(a).next_actor, by(a).last_update.state, by(a).last_update.ref, by(a).last_update.note], ["proposed", "owner/orchestrator", "proposed", { pr_url: PR }, "PR opened"]);
  assert.deepEqual([by(b).state, by(b).close_code, by(b).last_update.event, by(b).last_update.note], ["closed", "owner_closed", "closed", "not supported by the replay"]);
  assert.deepEqual([by(c).state, by(c).close_code, by(c).last_update.event, by(c).last_update.state, by(c).next_actor], ["closed", "expired", "expired", "expired", "none"]);
  const d = await intentDetail(db, c, NOW);
  assert.deepEqual((d!.history as any[]).map((h) => h.state), ["queued_external", "expired"]);
});

test("EA3. wiring: the kernel lists the route; the Console forwards it and the progress POST; UI routes; the page and the SSOT", async () => {
  const { CONSOLE_ALLOW_LIST } = await import("../../console/src/index.ts");
  const { UI_ROUTES } = await import("../../console/src/ui/routes.ts");
  assert.ok(CONSOLE_ALLOW_LIST.some((x) => x.service === "kernel" && x.method === "GET" && x.path === "/v1/evolution/intents/{id}"));
  assert.ok(CONSOLE_ALLOW_LIST.some((x) => x.service === "kernel" && x.method === "POST" && x.path === "/v1/evolution/intents/{id}/progress"));
  assert.deepEqual(UI_ROUTES.filter((r) => r.id === "kernel.intent" || r.id === "kernel.intent_progress").map((r) => ({ ...r })), [
    { id: "kernel.intent", service: "kernel", method: "GET", path: "/v1/evolution/intents/{id}", approverOnly: false, confirm: null },
    { id: "kernel.intent_progress", service: "kernel", method: "POST", path: "/v1/evolution/intents/{id}/progress", approverOnly: true, confirm: null },
  ]);
  const meta = await call(kernel, env(migratedDb()), req("GET", "/", undefined, OPERATOR_JWT));
  assert.ok(JSON.stringify(meta.body).includes("GET /v1/evolution/intents/{id}"));
  const page = read("workers/console/ui/src/pages/Proposals.tsx");
  for (const s of ['aria-label="External intents"', 'aria-label="Archive"', "kernel.intent_progress", "kernel.intent\"", "i.next_actor", "last_update", "Start", "Merged", "Deployed", "Refuse", "noteRequired: true", "queued_external"]) assert.ok(page.includes(s), s);
  assert.ok(!/next_actor\s*[:=]\s*["']/.test(page), "the Console renders next_actor; it never derives it");
  const ssot = read("docs/SSOT.md");
  assert.match(ssot.split("\n")[4], /^Last reviewed: 2026-11-16 \((?:[^\n]*; )?external intents console, 2026-11-28 \(owner: "Ya Kerjakan"/);
  assert.ok(ssot.includes("- **External intents and the Archive** (owner, 2026-11-28") && ssot.includes("GET /v1/evolution/intents/{id}"));
});
