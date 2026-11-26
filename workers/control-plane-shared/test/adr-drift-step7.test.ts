// The ADR Steward, step 7 (docs/design/ADR-STEWARD.md §4.8, §11 row 7; owner 2026-11-16, "ya semua, sesuai
// rekomendasimu", Q12): the drift reports. A drift episode, a phase whose manifest doc_claim disagrees with its computed
// state as the Steward stored it, is published once through the policy-gated reports.publish syscall as a
// platform_digest WARNING (body.schema adr_drift.v1, alert_key adr_drift:<adr>:<phase>), and closed by a "Resolved:"
// info report with the same alert_key, which the kernel's reports overview reads as resolved (syscall.ts
// resolvedLaterSql). Under reports.publish's 4 calls an hour the new episodes are batched into one report. Never
// critical (the consensus brake), never sent to Telegram (owner notices, the report relay). Plain fs reads relative to
// the repository root, so the Forge runner can bundle it; no AI is called (the harness's fake AI only). One
// migratedDb() per test at most (sql.js under the Forge).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CI_CLIENT_ID, APPROVER_EMAIL, OPERATOR_EMAIL, baseEnv, fakeAi, migratedDb, registeredDb, lastReviewedRecord } from "./harness.ts";
import { appendAuditEvent, sha256Hex } from "../src/audit.ts";
import { CAPABILITIES } from "../src/capabilities.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { observe } from "../../ai-kernel/src/syscall.ts";
import { openCriticalReports } from "../../ai-kernel/src/consensus.ts";
import { collectNotices, reconcileNotices, OWNER_CHANNEL_TOPICS } from "../../ai-kernel/src/owner-notices.ts";
import { CHANNEL_TOPICS, RELAY_HOSTS, RELAY_KINDS, relayReports } from "../../ai-kernel/src/report-relay.ts";
import { ADR_STEWARD_ID, runAdrStewardCycle, stewardState } from "../../ai-kernel/src/adr-steward.ts";
import {
  ADR_DRIFT_AGENT, ADR_DRIFT_MAX_EPISODES, ADR_DRIFT_PUBLISH_PER_HOUR, ADR_DRIFT_SCHEMA, ADR_DRIFT_SEVERITY, openDriftAlerts, reconcileDriftReports,
  type DriftReportState,
} from "../../ai-kernel/src/adr-drift.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const NOW = Date.UTC(2026, 10, 17, 12, 7, 0);
const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();

function memory() {
  const m = new Map<string, unknown>();
  return { m, async get<T>(k: string) { return m.get(k) as T | undefined; }, async put(k: string, v: unknown) { m.set(k, structuredClone(v)); } };
}
/** The kernel's env over a database, with the real Policy Engine deciding the syscalls. */
function kernelEnv(db: Db) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  return {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async () => ({ plan: {} }) },
  } as any;
}
const rows = (db: Db, sql: string, ...args: unknown[]) => db.raw.prepare(sql).all(...(args as never[])) as any[];
const set = (db: Db, sql: string, ...args: unknown[]) => db.raw.prepare(sql).run(...(args as never[]));
/** The Steward's reports, oldest first, with their bodies parsed. */
const reports = (db: Db) => rows(db, "SELECT report_id, kind, severity, subject, ai_status, body_json, created_at FROM agent_reports WHERE agent_id = ? ORDER BY created_at, rowid", ADR_STEWARD_ID)
  .map((r) => ({ ...r, body: JSON.parse(r.body_json) }));
const findingOf = (r: { findings: Record<string, unknown>[] }) => r.findings.filter((f) => f.kind === "adr_drift").at(-1) as Record<string, any> | undefined;
const g4bDeploy = (db: Db) => set(db, `INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
  VALUES ('dep_g4b', 'cryptophys-ai-kernel', ?, 'test', 'succeeded', NULL, 'idem_g4b', ?, ?, ?)`, "f".repeat(40),
  JSON.stringify({ executor: "native:deploy", outcome: { steps: ["migration:0075_adr_progress.sql:applied", "cryptophys-ai-kernel:topology_planned", "cryptophys-ai-kernel:do_migration_deployed", "unit:smoke_passed"] } }), iso(NOW), iso(NOW));

/** One stored document whose drift is `drift` (the shape the Steward stores, adr.progress-doc.v1). */
function storeDoc(db: Db, adr: string, drift: Array<{ phase: string; kind: "doc_behind" | "doc_ahead" }>, revision = 1) {
  const body = {
    schema: "adr.progress-doc.v1", adr,
    phases: drift.map((d) => ({ id: d.phase, title: `Phase ${d.phase}`, state: d.kind === "doc_behind" ? "proven" : "open", reason: d.kind === "doc_behind" ? null : "no evidence yet", doc_claim: d.kind === "doc_behind" ? "built" : "done", refs: [] })),
    drift: drift.map((d) => ({ phase: d.phase, kind: d.kind, doc_ref: "docs/GITHUB-CUTOVER.md", doc_state: d.kind === "doc_behind" ? "built" : "done", computed_state: d.kind === "doc_behind" ? "proven" : "open", refs: d.kind === "doc_behind" ? [`ev:platform/audit/evt_${adr}_${d.phase}@2026-11-17T12:00:00.000Z`] : [] })),
  };
  set(db, `INSERT INTO adr_progress (adr_id, revision, lifecycle, status, phases_total, phases_proven, phases_asserted, percent, percent_proven, manifest_sha256, body_sha256, body_json, explanation_json, changed_at)
    VALUES (?, ?, 'accepted', 'in_progress', ?, 0, 0, 0, 0, 'm', ?, ?, NULL, ?)
    ON CONFLICT (adr_id) DO UPDATE SET revision = excluded.revision, body_sha256 = excluded.body_sha256, body_json = excluded.body_json`,
  adr, revision, drift.length, `h${revision}`, JSON.stringify(body), iso(NOW));
}

// ================================================================ the episode, end to end on the real manifests

test("AD1. a drift episode is one platform_digest warning (adr_drift.v1) with its alert_key; it closes with a Resolved: report the overview reads as resolved", async () => {
  const db = registeredDb();
  const env = kernelEnv(db);
  const mem = memory();
  const cycle = (t: "scheduled" | "operator", at: number) => runAdrStewardCycle(env, mem, t, at);

  // The first pass: G4B's document says part B ran live (doc_claim done), an empty platform has no such deploy.
  const r1 = await cycle("scheduled", NOW);
  const f1 = findingOf(r1)!;
  assert.deepEqual([f1.outcome, f1.opened, f1.resolved, f1.batched], ["published", ["adr_drift:0012:G4B"], [], false]);
  let all = reports(db);
  assert.equal(all.length, 1);
  const open = all[0];
  assert.deepEqual([open.kind, open.severity, open.ai_status], ["platform_digest", "warning", "not_used"]);
  assert.equal(open.subject, "ADR-0012 G4B: the document claims more than the evidence (docs/GITHUB-CUTOVER.md says done, evidence open)");
  assert.deepEqual([open.body.schema, open.body.source, open.body.alert_key, open.body.state, open.body.metric, open.body.value], [ADR_DRIFT_SCHEMA, "adr_steward", "adr_drift:0012:G4B", "open", "adr_drift_episodes", 1]);
  const ep = open.body.episodes[0];
  const quote = JSON.parse(read("architecture/adr/progress/0012.json")).phases.find((p: any) => p.id === "G4B").doc_claim.quote;
  assert.deepEqual([ep.key, ep.adr, ep.phase, ep.kind, ep.doc_ref, ep.doc_state, ep.doc_quote, ep.computed_state, ep.manifest, ep.link],
    ["adr_drift:0012:G4B", "0012", "G4B", "doc_ahead", "docs/GITHUB-CUTOVER.md", "done", quote, "open", "architecture/adr/progress/0012.json", "#/vision/adr/0012"]);
  assert.equal(ep.title, "Gate 4 part B: routes, DO migrations, Workflows natively");
  assert.match(ep.suggestion, /docs\/GITHUB-CUTOVER\.md says "built, first live run 2026-11-17[^"]*" \(doc_claim done\), but the evidence is open\./);
  assert.match(ep.suggestion, /architecture\/adr\/progress\/0012\.json in one change request/);
  // Through the agent syscall path: a Policy Engine allow, consumed, recorded in agent_actions.
  assert.equal(rows(db, "SELECT COUNT(*) AS n FROM agent_actions WHERE agent_id = ? AND capability = 'reports.publish' AND outcome = 'succeeded'", ADR_STEWARD_ID)[0].n, 1);
  assert.equal(r1.actions.filter((a: any) => a.capability === "reports.publish" && a.outcome === "succeeded").length, 1);

  // Once per episode: the next pass, and a tick with nothing due, publish nothing.
  assert.equal(findingOf(await cycle("operator", NOW + MIN))!.outcome, "unchanged");
  const quiet = await cycle("scheduled", NOW + 15 * MIN);
  assert.equal(quiet.findings[0].why, "nothing due");
  assert.equal(findingOf(quiet), undefined, "nothing is pending, so a quiet tick reads nothing");
  assert.equal(reports(db).length, 1);
  // Open: the kernel's reports overview lists it, as a warning; nothing critical, so the consensus brake stays off.
  let ov = (await observe(env)) as any;
  assert.ok(ov.agent_reports_24h.latest_attention.some((r: any) => r.agent_id === ADR_STEWARD_ID && r.severity === "warning"));
  assert.deepEqual([ov.agent_reports_24h.counts.critical, openCriticalReports(ov.agent_reports_24h)], [0, 0]);

  // The evidence moves: a native deploy proves G4B (the document now agrees), and a binding repair proves GB, whose
  // document still says built (doc_behind). One Resolved: report and one new warning, each on its own key.
  g4bDeploy(db);
  await appendAuditEvent(db, { event_type: "deployment.binding_drift_repaired", actor: "service:cryptophys-deployment-orchestrator", subject: "cryptophys-ai-kernel", outcome: "repaired", payload: { request_id: "dep_x" } });
  const f2 = findingOf(await cycle("operator", NOW + 20 * MIN))!;
  assert.deepEqual([f2.outcome, f2.opened, f2.resolved], ["published", ["adr_drift:0012:GB"], ["adr_drift:0012:G4B"]]);
  all = reports(db);
  assert.equal(all.length, 3);
  const resolved = all.find((r) => r.severity === "info")!;
  assert.match(resolved.subject, /^Resolved: ADR drift 0012 G4B: /);
  assert.deepEqual([resolved.kind, resolved.body.schema, resolved.body.alert_key, resolved.body.state, resolved.body.opened_report_id], ["platform_digest", ADR_DRIFT_SCHEMA, "adr_drift:0012:G4B", "resolved", open.report_id]);
  assert.deepEqual(resolved.body.episodes, [{ key: "adr_drift:0012:G4B", kind: "doc_ahead", adr: "0012", phase: "G4B", doc_state: "done", computed_state: "proven" }]);
  const gb = all.find((r) => r.body.alert_key === "adr_drift:0012:GB")!;
  assert.deepEqual([gb.severity, gb.body.episodes[0].kind, gb.body.episodes[0].doc_state, gb.body.episodes[0].computed_state], ["warning", "doc_behind", "built", "proven"]);
  assert.match(gb.body.episodes[0].doc_quote, /^\*\*Status: built, not yet run live\*\*/);
  assert.match(gb.body.episodes[0].suggestion, /^The evidence proves GB, but docs\/GITHUB-CUTOVER\.md still says /);
  assert.ok(gb.body.episodes[0].refs.length >= 1);
  // Resolved alerts are hidden as the others are: G4B is no longer listed, and counts as resolved.
  ov = (await observe(env)) as any;
  const listed = ov.agent_reports_24h.latest_attention.filter((r: any) => r.agent_id === ADR_STEWARD_ID).map((r: any) => r.report_id);
  assert.deepEqual(listed, [gb.report_id]);
  assert.equal(ov.agent_reports_24h.warnings_resolved_24h, 1);
  assert.equal(ov.agent_reports_24h.counts.warning, 1);
  assert.deepEqual((await openDriftAlerts(db)).map((a) => a.alert_key), ["adr_drift:0012:GB"]);

  // A new episode under a closed key is a new warning: the deploy row is gone, G4B's document is ahead again.
  set(db, "DELETE FROM deployment_requests WHERE request_id = 'dep_g4b'");
  assert.deepEqual(findingOf(await cycle("operator", NOW + 25 * MIN))!.opened, ["adr_drift:0012:G4B"]);
  assert.deepEqual((await openDriftAlerts(db)).map((a) => a.alert_key).sort(), ["adr_drift:0012:G4B", "adr_drift:0012:GB"]);
  assert.equal((await stewardState(mem)).drift_reports!.calls.length, 4, "four reports.publish calls this hour");

  // A pending publish (here forced) is tried on the next tick even when no pass is due.
  const st = await stewardState(mem);
  st.drift_reports = { calls: [], pending: true };
  await mem.put("state", st);
  const pendingTick = await cycle("scheduled", NOW + 26 * MIN);
  assert.equal(pendingTick.findings[0].why, "nothing due");
  assert.equal(findingOf(pendingTick)!.outcome, "unchanged");
  assert.equal((await stewardState(mem)).drift_reports!.pending, false);
  // Never critical.
  assert.ok(reports(db).every((r) => r.severity === "warning" || r.severity === "info"));
});

// ================================================================ batching under reports.publish's limit

test("AD2. within 4 calls an hour: one report per episode when they fit, else one batch; a batch closes when all its episodes have; the policy's limit is the backstop", async () => {
  const db = registeredDb();
  const env = kernelEnv(db);
  assert.equal(ADR_DRIFT_PUBLISH_PER_HOUR, CAPABILITIES["reports.publish"].max_per_hour);
  assert.equal(ADR_DRIFT_PUBLISH_PER_HOUR, 4);
  assert.equal(ADR_DRIFT_AGENT, ADR_STEWARD_ID);
  let state: DriftReportState | null = null;
  const run = async (at: number) => { const r = await reconcileDriftReports(env, state, at); state = r.state; return r.finding as Record<string, any>; };

  // Two episodes, four calls left: one report each.
  storeDoc(db, "0012", [{ phase: "G10", kind: "doc_behind" }, { phase: "GB", kind: "doc_behind" }]);
  let f = await run(NOW);
  assert.deepEqual([f.outcome, f.opened, f.batched, f.calls_this_hour], ["published", ["adr_drift:0012:G10", "adr_drift:0012:GB"], false, 2]);
  assert.equal(reports(db)[0].body.episodes[0].doc_quote, "**built, live, not yet run**", "the quote the manifest anchors");

  // Five more, two calls left: they go into ONE report, keyed by its episodes.
  storeDoc(db, "0016", ["X1", "X2", "X3", "X4", "X5"].map((phase) => ({ phase, kind: "doc_ahead" as const })));
  f = await run(NOW + 5 * MIN);
  assert.equal(f.batched, true);
  assert.equal(f.deferred, 0);
  const batch = reports(db).at(-1)!;
  const ids = ["X1", "X2", "X3", "X4", "X5"].map((p) => `adr_drift:0016:${p}|doc_ahead`);
  assert.equal(batch.body.alert_key, `adr_drift:batch:${(await sha256Hex(ids.join("\n"))).slice(0, 12)}`);
  assert.deepEqual([batch.severity, batch.body.value, batch.body.episodes.length], ["warning", 5, 5]);
  assert.equal(batch.subject, "ADR drift: 5 document claims disagree with the evidence (0016 X1, 0016 X2, 0016 X3, 0016 X4 and 1 more)");
  assert.ok(new TextEncoder().encode(batch.body_json).byteLength < 16 * 1024);
  assert.equal(ADR_DRIFT_MAX_EPISODES, 12);

  // G10 closes, and two of the batch's five: G10's alert is resolved, the batch stays open for its other three.
  storeDoc(db, "0012", [{ phase: "GB", kind: "doc_behind" }], 2);
  storeDoc(db, "0016", ["X3", "X4", "X5"].map((phase) => ({ phase, kind: "doc_ahead" as const })), 2);
  f = await run(NOW + 10 * MIN);
  assert.deepEqual([f.outcome, f.resolved, f.opened, f.calls_this_hour], ["published", ["adr_drift:0012:G10"], [], 4]);
  assert.deepEqual((await openDriftAlerts(db)).map((a) => a.alert_key).sort(), [batch.body.alert_key, "adr_drift:0012:GB"].sort());

  // Everything closes with no call left this hour: nothing is sent, the work waits.
  storeDoc(db, "0012", [], 3);
  storeDoc(db, "0016", [], 3);
  const before = reports(db).length;
  f = await run(NOW + 15 * MIN);
  assert.deepEqual([f.outcome, f.deferred, f.stopped, state!.pending], ["deferred", 2, "hourly_limit", true]);
  assert.equal(reports(db).length, before);

  // The hour has passed for the Steward's own count, but not for the Policy Engine's (its clock is the wall clock): the
  // policy refuses, nothing is counted or lost, and the work stays pending.
  f = await run(NOW + 71 * MIN);
  assert.equal(f.outcome, "deferred");
  assert.match(String(f.stopped), /^denied: .*rate_limit/);
  assert.equal(state!.pending, true);
  assert.equal(reports(db).length, before);
  // Once the policy's hour has passed too, both alerts close, and nothing is left.
  set(db, "UPDATE agent_syscall_consumptions SET consumed_at = ? WHERE agent_id = ?", "2000-01-01T00:00:00.000Z", ADR_STEWARD_ID);
  f = await run(NOW + 72 * MIN);
  assert.deepEqual([f.outcome, f.deferred, state!.pending], ["published", 0, false]);
  assert.deepEqual(f.resolved.sort(), [batch.body.alert_key, "adr_drift:0012:GB"].sort());
  assert.deepEqual(await openDriftAlerts(db), []);
  const closing = reports(db).find((r) => r.body.alert_key === batch.body.alert_key && r.body.state === "resolved")!;
  assert.deepEqual(closing.body.episodes.map((e: any) => e.key), ["X1", "X2", "X3", "X4", "X5"].map((p) => `adr_drift:0016:${p}`));
  assert.ok(reports(db).every((r) => r.severity === ADR_DRIFT_SEVERITY.open || r.severity === ADR_DRIFT_SEVERITY.resolved));
  assert.deepEqual(ADR_DRIFT_SEVERITY, { open: "warning", resolved: "info" });
});

// ================================================================ never critical, never Telegram

test("AD3. drift reports change no owner notice, are not relayed, and leave the consensus brake off", async () => {
  const db = registeredDb();
  const env = kernelEnv(db);
  // Every alert channel topic on the default channel, the owner's Telegram bot recording every message.
  set(db, "UPDATE alert_channels SET topics_json = ?, enabled = 1 WHERE channel_id = 'alc_default'", JSON.stringify(CHANNEL_TOPICS));
  const sent: Array<{ title: string; lines: string[] }> = [];
  const noticeEnv = { DB: db, OWNER_NOTICE_CHANNELS: "telegram", OWNER_TELEGRAM: { notify: async (m: { title: string; lines: string[] }) => { sent.push(m); return { sent: true }; } } } as any;
  const before = await collectNotices(db, Date.now());

  storeDoc(db, "0012", [{ phase: "G10", kind: "doc_behind" }, { phase: "GB", kind: "doc_behind" }]);
  storeDoc(db, "0016", ["X1", "X2", "X3"].map((phase) => ({ phase, kind: "doc_ahead" as const })));
  const r = await reconcileDriftReports(env, null, NOW);
  assert.equal((r.finding as any).batched, true);
  const mine = reports(db);
  assert.equal(mine.length, 1);
  assert.ok(mine.every((x) => x.severity === "warning" && x.kind === "platform_digest" && !("telegram_topic" in x.body)));

  // The owner notices (email and Telegram) compute exactly what they computed before the reports.
  assert.deepEqual(await collectNotices(db, Date.now()), before);
  const critical = (await collectNotices(db, Date.now(), ["critical_reports"]))[0];
  assert.equal(critical.active, false);
  assert.deepEqual([...OWNER_CHANNEL_TOPICS], ["owner_attention", "critical_reports", "production_unhandled"]);
  await reconcileNotices(noticeEnv, Date.now());
  assert.ok(sent.every((m) => !/adr_drift|ADR-\d{4}|ADR drift/.test([m.title, ...m.lines].join("\n"))), JSON.stringify(sent));
  // The report relay forwards only an xauusd-hosted agent's xauusd_digest that names a telegram_topic: none of these.
  assert.ok(!(RELAY_KINDS as readonly string[]).includes("platform_digest"));
  assert.ok(!RELAY_HOSTS.includes("cryptophys-ai-kernel"));
  assert.deepEqual(await relayReports(noticeEnv, Date.now()), []);
  assert.equal(rows(db, "SELECT COUNT(*) AS n FROM audit_events WHERE event_type LIKE 'owner.relay_%'")[0].n, 0);
  // The consensus brake counts open critical reports only.
  const ov = (await observe(env)) as any;
  assert.deepEqual([ov.agent_reports_24h.counts.critical, openCriticalReports(ov.agent_reports_24h)], [0, 0]);
  // The source publishes no other severity, and names no Telegram topic.
  const src = read("workers/ai-kernel/src/adr-drift.ts");
  assert.doesNotMatch(src, /severity:\s*"critical"|"critical"/);
  assert.doesNotMatch(src, /telegram_topic:|OWNER_TELEGRAM|sendToChannel/);
});

// ================================================================ the documents

test("AD4. gate 4 part B's first live run is recorded, gate 4 is not marked met, G4B's doc_claim follows it; SSOT and the design record step 7", () => {
  const cutover = read("docs/GITHUB-CUTOVER.md");
  const row4 = cutover.split("\n").find((l) => l.startsWith("| 4 | "))!;
  assert.match(row4, /\*\*partly built:\*\*/, "gate 4 stays partly built: its other open items remain");
  assert.match(row4, /`dep_3b2b298a-8d3d-40e7-8317-f1ba610bde17` at 07:07 UTC, executor `native:deploy`, commit f32a445/);
  assert.match(row4, /`migration:0075_adr_progress\.sql:applied`, then on `cryptophys-ai-kernel` `planned`, `topology_planned`, `do_migration_deployed` \(wrangler migration v5, the new SQLite class `AdrStewardAgent`\), `bindings_match`, `settings_match`, `verified` and `smoke_passed`, then the unit's `unit:smoke_passed`/);
  assert.match(row4, /the destructive path, which has not run live either/);
  assert.doesNotMatch(row4, /topology\.ts`, built, not yet run live\):\*\*/);
  const g4b = JSON.parse(read("architecture/adr/progress/0012.json")).phases.find((p: any) => p.id === "G4B");
  assert.equal(g4b.doc_claim.state, "done");
  assert.ok(cutover.includes(g4b.doc_claim.quote) && g4b.doc_claim.quote.includes("first live run 2026-11-17 07:07 UTC"));
  const g4d = JSON.parse(read("architecture/adr/progress/0012.json")).phases.find((p: any) => p.id === "G4D");
  assert.equal(g4d.doc_claim, undefined, "the destructive path claims nothing");
  // The guard paths: 0012.json is the only one this step touches.
  assert.equal(criticalPathReason("architecture/adr/progress/0012.json"), "adr_0009_0012");
  for (const p of ["workers/ai-kernel/src/adr-drift.ts", "workers/ai-kernel/src/adr-steward.ts", "workers/control-plane-shared/test/adr-drift-step7.test.ts",
    "workers/control-plane-shared/test/adr-steward-step3.test.ts", "workers/control-plane-shared/test/adr-evidence.test.ts", "docs/GITHUB-CUTOVER.md", "docs/SSOT.md", "docs/design/ADR-STEWARD.md"]) {
    assert.equal(criticalPathReason(p), null, p);
  }
  const ssot = read("docs/SSOT.md");
  assert.match(lastReviewedRecord(), /(?:^Last reviewed: |\); )2026-11-16 \([^\n]*ADR Steward step 7, the drift reports: [^()]*`adr_drift\.v1`[^()]*`adr_drift:<adr>:<phase>`[^()]*; ADR Steward step 6, the AI explanation: /);
  assert.match(ssot, /drift episode[^\n]*`platform_digest` warning[^\n]*never critical[^\n]*never sent to Telegram/);
  assert.match(read("docs/design/ADR-STEWARD.md"), /\| 7 \| Drift: [^\n]*\*\*Built 2026-11-17\*\*/);
});
