// Owner decision 2026-11-13 ("Pastikan semua loop ini apakah juga perlu Human Ai Interaction Panel? Batasi User/Owner
// hanya untuk critical dan permintaan approval only"): one Console panel (#/owner) lists everything that needs a
// person, from GET /v1/owner/inbox on the AI Kernel: the approvals (draft recovery plans, critical proposals in
// pending_owner, pending knowledge proposals) and the open critical reports. The owner notices read the same items.
// One migratedDb() per test at most (the Forge runs these under sql.js, whose wasm heap never shrinks).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, OUTSIDER_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { OWNER_CHANNEL_TOPICS, OWNER_PANEL_URL, collectNotices } from "../../ai-kernel/src/owner-notices.ts";
import { acknowledgePhrase } from "../../ai-kernel/src/reports.ts";
import { UI_ROUTES } from "../../console/src/ui/routes.ts";
import { CONSOLE_ALLOW_LIST } from "../../console/src/index.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

test("I1. GET /v1/owner/inbox: operators read the approvals and the open critical reports, the same items the owner notices send; read-only", async () => {
  const db = migratedDb();
  const env = baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL });
  const plan = (id: string, status: string, minutes: number) => db.raw.prepare(`INSERT INTO recovery_plans (plan_id, service_id, plan_version, status, steps_json, approved_by, last_execution_json, created_by, created_at, updated_at, approve_by)
    VALUES (?, 'cryptophys-console', 'aaaaaaaaaaaa', ?, ?, NULL, NULL, 'agent:supervisor', ?, ?, ?)`)
    .run(id, status, JSON.stringify({ title: `Drift on cryptophys-console (${id})`, rationale: "two drifted observations", steps: [{ action: "redeploy_commit", description: "Redeploy the desired version." }] }), ago(minutes), ago(minutes), ago(-60 * 70));
  plan("plan_00000000-0000-4000-8000-000000000001", "draft", 30);
  plan("plan_00000000-0000-4000-8000-000000000002", "approved", 20);
  const proposal = (id: string, action: string, status: string) => db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES (?, 'supervisor', ?, 'forge-steward', 'critical', '{}', '{}', 'critical', 8, 7, 1, 1, NULL, NULL, ?, NULL, ?, ?)`).run(id, action, status, ago(60), ago(59));
  proposal("cns_00000000-0000-4000-8000-000000000001", "admit_voter", "pending_owner");
  proposal("cns_00000000-0000-4000-8000-000000000002", "rotate_secret", "pending_owner");
  proposal("cns_00000000-0000-4000-8000-000000000003", "admit_voter", "executed");
  db.raw.prepare(`INSERT INTO knowledge_proposals (proposal_id, proposer_agent_id, item_id, item_version, kind, item_json, content_sha256, status, decided_by, reason, decision_id, created_at, decided_at)
    VALUES ('knw_00000000-0000-4000-8000-000000000001', 'aether-curator', 'k-prophet-trap', 1, 'caution', '{"text":"Prophet is often wrong in London"}', ?, 'pending', NULL, NULL, 'dec_x', ?, NULL)`).run("a".repeat(64), ago(90));
  const report = (id: string, severity: string, minutes: number) => db.raw.prepare(`INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at)
    VALUES (?, 'deployment-orchestrator', 'platform_digest', ?, ?, '{}', 'deterministic', NULL, ?)`).run(id, severity, `${severity} ${id}`, ago(minutes));
  const open = "rpt_00000000-0000-4000-8000-000000000001", handled = "rpt_00000000-0000-4000-8000-000000000002";
  report(open, "critical", 10);
  report(handled, "critical", 20);
  report("rpt_00000000-0000-4000-8000-000000000003", "warning", 5);
  report("rpt_00000000-0000-4000-8000-000000000004", "critical", 25 * 60);
  const ack = await call(kernel, env, req("POST", `/v1/reports/${handled}/acknowledge`, { confirm: acknowledgePhrase(handled), reason: "Rolled back by hand; production is healthy." }, APPROVER_JWT));
  assert.equal(ack.status, 200, JSON.stringify(ack.body));

  const events = () => (db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n;
  const before = events();
  const r = await call(kernel, env, req("GET", "/v1/owner/inbox", undefined, OPERATOR_JWT));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body;
  assert.equal(b.schema, "owner-inbox.v1");
  assert.equal(b.consensus_mode, (db.raw.prepare("SELECT value FROM consensus_controls WHERE control = 'mode'").get() as { value: string }).value, "the mode comes from D1, never a default");
  assert.deepEqual(b.approvals.recovery_plans.map((p: any) => [p.plan_id, p.title, p.steps.length, p.synthetic]),
    [["plan_00000000-0000-4000-8000-000000000001", "Drift on cryptophys-console (plan_00000000-0000-4000-8000-000000000001)", 1, false]], "draft plans only");
  assert.deepEqual(b.approvals.consensus.map((p: any) => [p.proposal_id, p.action, p.executable, p.approvals, p.eligible]),
    [["cns_00000000-0000-4000-8000-000000000001", "admit_voter", true, 7, 8], ["cns_00000000-0000-4000-8000-000000000002", "rotate_secret", false, 7, 8]], "pending_owner only; rotate_secret has no platform executor");
  assert.equal(Date.parse(b.approvals.consensus[0].expires_at) - Date.parse(b.approvals.consensus[0].created_at), 24 * 3_600_000, "the 24 h owner window");
  assert.deepEqual(b.approvals.knowledge.map((k: any) => [k.proposal_id, k.item.text]), [["knw_00000000-0000-4000-8000-000000000001", "Prophet is often wrong in London"]]);
  assert.deepEqual(b.critical_reports.map((x: any) => x.report_id), [open], "acknowledged, older than 24 h and warning reports are not open critical reports");
  // This database has no drift observation at all, so every registered service reads as not observed (condition 2 of
  // production_unhandled); the conditions themselves are tested one by one in production-unhandled.test.ts.
  assert.ok(b.production_problems.length > 0 && b.production_problems.every((p: any) => p.code === "observations_stale"));
  assert.deepEqual(b.counts, { approvals: 4, critical_reports: 1, production_problems: b.production_problems.length });
  assert.equal(events(), before, "reading the inbox writes nothing");
  assert.equal((db.raw.prepare("SELECT status FROM knowledge_proposals").get() as { status: string }).status, "pending");

  // The notices list the same items, and both owner-channel notices link to the Owner page.
  const notices = await collectNotices(db as never);
  const attention = notices.find((n) => n.topic === "owner_attention")!;
  assert.deepEqual([attention.active, attention.lines.length, attention.channel, attention.link], [true, b.counts.approvals, "owner", OWNER_PANEL_URL]);
  const critical = notices.find((n) => n.topic === "critical_reports")!;
  assert.deepEqual([critical.active, critical.lines.length, critical.channel, critical.link], [true, b.counts.critical_reports, "owner", OWNER_PANEL_URL]);

  // GET /v1/notices names each notice's channel.
  const n = await call(kernel, env, req("GET", "/v1/notices", undefined, OPERATOR_JWT));
  assert.equal(n.status, 200);
  assert.deepEqual(n.body.owner_channel_topics, ["owner_attention", "critical_reports", "production_unhandled"]);
  assert.deepEqual(n.body.notices.map((x: any) => [x.topic, x.channel]), [["owner_attention", "owner"], ["drift", "console"], ["critical_reports", "owner"], ["organism", "console"], ["build_minutes", "console"], ["dependencies", "console"], ["production_unhandled", "owner"]]);
  const problems = notices.find((x) => x.topic === "production_unhandled")!;
  assert.deepEqual([problems.active, problems.lines.length, problems.link], [true, Math.min(20, b.counts.production_problems), OWNER_PANEL_URL], "the notice lists the inbox's problems");

  // Access still decides who reads it.
  assert.equal((await call(kernel, env, req("GET", "/v1/owner/inbox", undefined, OUTSIDER_JWT))).status, 403);
  assert.equal((await call(kernel, env, req("GET", "/v1/owner/inbox", undefined, null))).status, 403, "no Access JWT");
  assert.equal((await call(kernel, env, req("POST", "/v1/owner/inbox", {}, APPROVER_JWT))).status, 404, "nothing is written through the inbox");
});

test("I2. the Console: #/owner is the first nav item, reads only the inbox, reuses the approver-only routes and the critical-report list; the allow-list adds one read-only row", () => {
  assert.deepEqual([...OWNER_CHANNEL_TOPICS], ["owner_attention", "critical_reports", "production_unhandled"]);
  assert.deepEqual(UI_ROUTES.find((r) => r.id === "kernel.owner_inbox"), { id: "kernel.owner_inbox", service: "kernel", method: "GET", path: "/v1/owner/inbox", approverOnly: false, confirm: null });
  assert.deepEqual(CONSOLE_ALLOW_LIST.filter((a) => a.path.startsWith("/v1/owner")), [{ service: "kernel", method: "GET", path: "/v1/owner/inbox" }]);
  const app = read("workers/console/ui/src/App.tsx");
  assert.match(app, /case "owner": page = <Owner \/>; break;/);
  const shell = read("workers/console/ui/src/components/AppShell.tsx");
  assert.match(shell, /export const NAV = \[\n(?:\s*\/\/[^\n]*\n)*\s*\{ label: "Owner", href: "#\/owner", key: "owner", icon: Inbox \},\n\s*\{ label: "Command"/, "Owner is the first nav item");
  const page = read("workers/console/ui/src/pages/Owner.tsx");
  assert.deepEqual([...page.matchAll(/\bcall\(\s*"([a-z_.]+)"/g)].map((m) => m[1]), ["kernel.owner_inbox"], "one read, no other counts or alerts");
  for (const route of ["recovery.approve", "recovery.disable", "kernel.consensus_approve", "kernel.consensus_reject", "kernel.knowledge_approve", "kernel.knowledge_reject"]) {
    assert.match(page, new RegExp(`route: "${route.replace(".", "\\.")}"`), `${route} is reused`);
  }
  assert.equal((page.match(/who\.approver \?/g) ?? []).length, 3, "every action group is shown to approvers only");
  assert.match(page, /Only an approver can decide\./);
  assert.match(page, /<CriticalReportList rows=\{reports\}/, "the open critical reports reuse CriticalReports.tsx (acknowledge for approvers)");
  for (const text of ["Waiting for your approval", "Open critical reports", "Production problems no agent is handling", "Nothing needs you"]) assert.ok(page.includes(text), text);
  assert.match(page, /const problems = arr\(data\?\.production_problems\)/, "the third section reads the same inbox");
  assert.match(page, /p\.executable === true && mode === "critical"/, "approve follows the kernel's executor list and mode");
  const reports = read("workers/console/ui/src/components/CriticalReports.tsx");
  assert.match(reports, /export function CriticalReportList/);
  const smoke = read("workers/console/ui/scripts/render-smoke.mjs");
  assert.match(smoke, /const ROUTES = \["owner", /);
  assert.match(smoke, /"\/api\/kernel\/v1\/owner\/inbox"/);
  for (const check of ["approver", "operator", "empty"]) assert.match(smoke, new RegExp(`name: "${check}"`), `render smoke checks the Owner page as ${check}`);
  assert.match(smoke, /want: \["Nothing needs you"\]/);
});
