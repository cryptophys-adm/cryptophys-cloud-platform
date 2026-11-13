// ADR-0012 phase 2: owner notices without GitHub (replaces owner-attention.yml and drift-alert.yml).
// Owner 2026-11-13 ("Batasi User/Owner hanya untuk critical dan permintaan approval only"): only owner_attention and
// critical_reports are emailed and sent to Telegram, both linking to the Owner page; every other topic is console-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migratedDb } from "./harness.ts";
import { OWNER_CHANNEL_TOPICS, TOPICS, channelOf, collectNotices, emailConfigured, reconcileNotices, STALE_MS, telegramConfigured } from "../../ai-kernel/src/owner-notices.ts";

const ROOT = new URL("../../../", import.meta.url);
const NOW = Date.parse("2026-11-08T03:22:00Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

/** Every non-disabled registered service observed in sync 5 minutes ago. */
function healthy(db: any) {
  const services = db.raw.prepare("SELECT service_id FROM service_registry WHERE status != 'disabled'").all() as { service_id: string }[];
  let i = 0;
  for (const s of services) {
    db.raw.prepare(`INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at) VALUES (?, ?, 'h', 'h', 0, '{"reasons":[]}', ?)`)
      .run(`obs_${i++}`, s.service_id, at(5 * 60_000));
  }
  return services.map((s) => s.service_id);
}

function emailSpy() {
  const sent: any[] = [];
  return { sent, binding: { send: async (m: any) => { sent.push(m); return { messageId: "m" }; } } };
}

test("O1. nothing open when everything is healthy and nothing waits", async () => {
  const db = migratedDb();
  healthy(db);
  const n = await collectNotices(db as never, NOW);
  assert.deepEqual(n.map((x) => [x.topic, x.active]), [["owner_attention", false], ["drift", false], ["critical_reports", false], ["organism", false], ["build_minutes", false], ["dependencies", false], ["production_unhandled", false]]);
  assert.deepEqual((await reconcileNotices({ DB: db } as never, NOW)).map((r) => r.change), ["unchanged", "unchanged", "unchanged", "unchanged", "unchanged", "unchanged", "unchanged"]);
});

test("O2. a draft plan and a pending_owner proposal open owner_attention once; a change updates it; resolution closes it, with emails to the owners", async () => {
  const db = migratedDb();
  healthy(db);
  const now = at(0);
  db.raw.prepare(`INSERT INTO recovery_plans (plan_id, service_id, plan_version, status, steps_json, approved_by, last_execution_json, created_by, created_at, updated_at)
    VALUES ('plan_1', 'cryptophys-console', 'aaaaaaaaaaaa', 'draft', '{}', NULL, NULL, 'agent:supervisor', ?, ?)`).run(now, now);
  const mail = emailSpy();
  const env = { DB: db, APPROVER_IDENTITIES: "Owner@Example.com,cf-client-id.access", OWNER_EMAIL: mail.binding, NOTIFY_FROM: "alerts@notify.example.com" };
  assert.equal(emailConfigured(env as never), true);
  let r = await reconcileNotices(env as never, NOW);
  assert.deepEqual(r[0], { topic: "owner_attention", change: "opened", delivery: "sent" });
  assert.equal(mail.sent.length, 1);
  assert.deepEqual(mail.sent[0].to, ["owner@example.com"], "only owner emails, never service tokens");
  assert.equal(mail.sent[0].from, "alerts@notify.example.com");
  assert.match(mail.sent[0].subject, /^\[Cryptophys\] 1 item\(s\) wait for your approval$/);
  assert.match(mail.sent[0].text, /^- Recovery plan for Cerebrum Console \(by agent:supervisor\)$/m);
  assert.match(mail.sent[0].text, /^Open the Owner page of the Cerebrum Console: https:\/\/nexus\.cryptophys\.work\/console\/#\/owner$/m, "every owner email links to the Owner page");
  assert.doesNotMatch(mail.sent[0].text, /#\/recovery/, "no per-kind link: the item is decided on the Owner page");
  r = await reconcileNotices(env as never, NOW);
  assert.equal(r[0].change, "unchanged", "same items, no second email");
  assert.equal(mail.sent.length, 1);
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES ('cns_1', 'supervisor', 'retire_worker', 'cryptophys-home', 'critical', '{}', '{}', 'deploy', 9, 6, 0, 1, NULL, NULL, 'pending_owner', NULL, ?, ?)`).run(now, now);
  r = await reconcileNotices(env as never, NOW);
  assert.equal(r[0].change, "changed");
  assert.match(mail.sent[1].text, /^- Critical action: retire Home \(proposed by supervisor\)$/m);
  db.raw.prepare("UPDATE recovery_plans SET status = 'approved'").run();
  db.raw.prepare("UPDATE consensus_proposals SET status = 'executed'").run();
  r = await reconcileNotices(env as never, NOW);
  assert.equal(r[0].change, "closed");
  assert.match(mail.sent[2].subject, /^\[Cryptophys\] Resolved: /);
  const events = (db.raw.prepare("SELECT event_type, actor, subject FROM audit_events WHERE event_type LIKE 'owner.notice_%' ORDER BY rowid").all() as any[]);
  assert.deepEqual(events.map((e) => e.event_type), ["owner.notice_opened", "owner.notice_changed", "owner.notice_closed"]);
  assert.ok(events.every((e) => e.subject === "owner_attention" && e.actor === "agent:supervisor"));
});

test("O3. drift: drifted, never observed and stale services; disabled services are ignored", async () => {
  const db = migratedDb();
  const services = healthy(db);
  const [a, b] = services;
  db.raw.prepare(`INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at) VALUES ('obs_d', ?, 'h', 'x', 1, ?, ?)`)
    .run(a, JSON.stringify({ reasons: ["version_mismatch"], probe: { version_tag: "bbbbbbbbbbbb" } }), at(60_000));
  db.raw.prepare("UPDATE drift_observations SET observed_at = ? WHERE service_id = ?").run(at(STALE_MS + 60_000), b);
  db.raw.prepare("INSERT INTO service_registry (service_id, display_name, environment, status, desired_version, metadata_json, created_at, updated_at) VALUES ('cryptophys-new', 'New', 'production', 'registered', NULL, '{}', ?, ?)").run(at(0), at(0));
  db.raw.prepare("INSERT INTO service_registry (service_id, display_name, environment, status, desired_version, metadata_json, created_at, updated_at) VALUES ('cryptophys-gone', 'Gone', 'production', 'disabled', NULL, '{}', ?, ?)").run(at(0), at(0));
  const d = (await collectNotices(db as never, NOW))[1];
  assert.equal(d.active, true);
  assert.equal(d.lines.length, 3);
  assert.ok(d.lines.some((l) => /running bbbbbbbbbbbb/.test(l) && /differs from the expected version/i.test(l)));
  assert.ok(d.lines.some((l) => /not observed since/.test(l)));
  assert.ok(d.lines.some((l) => /New: never observed/.test(l)));
  assert.ok(!d.lines.some((l) => /Gone/.test(l)));
});

test("O4. critical reports of the last 24 hours open critical_reports; older ones do not", async () => {
  const db = migratedDb();
  healthy(db);
  const ins = db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, created_at) VALUES (?, 'supervisor', 'platform_digest', ?, ?, '{}', 'deterministic', ?)");
  ins.run("rpt_old", "critical", "old", at(25 * 3_600_000));
  ins.run("rpt_warn", "warning", "warn", at(60_000));
  let c = (await collectNotices(db as never, NOW))[2];
  assert.equal(c.active, false);
  ins.run("rpt_new", "critical", "Rollback of Cerebrum Console failed", at(60_000));
  c = (await collectNotices(db as never, NOW))[2];
  assert.equal(c.active, true);
  assert.match(c.lines[0], /supervisor: Rollback of Cerebrum Console failed/);
  const r = await reconcileNotices({ DB: db } as never, NOW);
  assert.deepEqual(r[2], { topic: "critical_reports", change: "opened", delivery: "not_configured" }, "without email the notice is still recorded for the Console");
  assert.equal(c.channel, "owner");
  assert.equal(c.link, "https://nexus.cryptophys.work/console/#/owner");
});

test("O6. a failed email delivery is retried until it succeeds, then stops", async () => {
  const db = migratedDb();
  healthy(db);
  const now = at(0);
  db.raw.prepare(`INSERT INTO recovery_plans (plan_id, service_id, plan_version, status, steps_json, approved_by, last_execution_json, created_by, created_at, updated_at)
    VALUES ('plan_retry', 'cryptophys-console', 'aaaaaaaaaaaa', 'draft', '{}', NULL, NULL, 'agent:supervisor', ?, ?)`).run(now, now);
  let attempts = 0;
  const env = { DB: db, APPROVER_IDENTITIES: "owner@example.com", NOTIFY_FROM: "alerts@notify.example.com", OWNER_EMAIL: { send: async () => { attempts++; if (attempts === 1) throw new Error("temporary provider failure"); return { messageId: "m" }; } } };
  const first = await reconcileNotices(env as never, NOW);
  assert.equal(first[0].delivery, "failed: temporary provider failure");
  const second = await reconcileNotices(env as never, NOW);
  assert.deepEqual(second[0], { topic: "owner_attention", change: "delivery_retry", delivery: "sent" });
  assert.equal(attempts, 2);
  const third = await reconcileNotices(env as never, NOW);
  assert.equal(third[0].change, "unchanged");
  assert.equal(attempts, 2, "a successful retry is not sent again");
});

test("O7. invalid or future observation timestamps fail closed as drift notices", async () => {
  const db = migratedDb();
  const services = healthy(db);
  const [invalid, future] = services;
  db.raw.prepare('UPDATE drift_observations SET observed_at = ? WHERE service_id = ?').run('not-a-date', invalid);
  db.raw.prepare('UPDATE drift_observations SET observed_at = ? WHERE service_id = ?').run('2099-01-01T00:00:00.000Z', future);
  const d = (await collectNotices(db as never, NOW))[1];
  assert.equal(d.active, true);
  assert.equal(d.lines.filter((line) => /invalid observation timestamp/.test(line)).length, 2);
});

test("O8. critical reports with future timestamps are not treated as current", async () => {
  const db = migratedDb();
  healthy(db);
  db.raw.prepare(`INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, created_at) VALUES ('rpt_future', 'supervisor', 'platform_digest', 'critical', 'future', '{}', 'deterministic', ?)`).run(new Date(NOW + 60 * 60_000).toISOString());
  const c = (await collectNotices(db as never, NOW))[2];
  assert.equal(c.active, false);
});
test("O9. repeated closure email failures keep retrying until delivered", async () => {
  const db = migratedDb();
  healthy(db);
  const now = at(0);
  db.raw.prepare(`INSERT INTO recovery_plans (plan_id, service_id, plan_version, status, steps_json, approved_by, last_execution_json, created_by, created_at, updated_at)
    VALUES ('plan_close_retry', 'cryptophys-console', 'aaaaaaaaaaaa', 'draft', '{}', NULL, NULL, 'agent:supervisor', ?, ?)`).run(now, now);
  let attempts = 0;
  const env = { DB: db, APPROVER_IDENTITIES: "owner@example.com", NOTIFY_FROM: "alerts@notify.example.com", OWNER_EMAIL: { send: async () => { attempts++; if (attempts === 2 || attempts === 3) throw new Error("temporary provider failure"); return { messageId: "m" + attempts }; } } };
  assert.equal((await reconcileNotices(env as never, NOW))[0].delivery, "sent");
  db.raw.prepare("UPDATE recovery_plans SET status = 'approved' WHERE plan_id = 'plan_close_retry'").run();
  assert.equal((await reconcileNotices(env as never, NOW))[0].delivery, "failed: temporary provider failure");
  assert.equal((await reconcileNotices(env as never, NOW))[0].change, "delivery_retry");
  assert.equal((await reconcileNotices(env as never, NOW))[0].delivery, "sent");
  assert.equal((await reconcileNotices(env as never, NOW))[0].change, "unchanged");
  assert.equal(attempts, 4);
});

test("O5. wiring: kernel schedule, kernel route, Console route and panel", () => {
  const idx = readFileSync(new URL("workers/ai-kernel/src/index.ts", ROOT), "utf8");
  assert.match(idx, /if \(minute === 22 \|\| minute === 52\) \{\n\s+ctx\.waitUntil\(reconcileNotices\(env, event\.scheduledTime\)/);
  assert.match(idx, /path === "\/v1\/notices" && request\.method === "GET"/);
  assert.match(readFileSync(new URL("workers/console/src/ui/routes.ts", ROOT), "utf8"), /r\("kernel\.notices", "kernel", "GET", "\/v1\/notices", false, null\)/);
  const command = readFileSync(new URL("workers/console/ui/src/pages/Command.tsx", ROOT), "utf8");
  assert.match(command, /call\("kernel\.notices"\)/);
  assert.match(command, /Email enabled/);
  assert.doesNotMatch(command, /emailed to the owner/, "configuration is not proof of delivery");
  const toml = readFileSync(new URL("workers/ai-kernel/wrangler.toml", ROOT), "utf8");
  assert.match(toml, /\[\[send_email\]\]\nname = "OWNER_EMAIL"\n/, "owner notices are emailed through the send_email binding");
  assert.match(toml, /^NOTIFY_FROM = "alerts@notify\.cryptophys\.work"$/m, "the sender is on the onboarded subdomain");
  assert.ok(toml.includes('allowed_destination_addresses = ["owner-notify-placeholder@example.invalid"]'), "source config fails closed; deploy rendering injects protected approver identities");
  assert.ok(toml.includes('allowed_sender_addresses = ["alerts@notify.cryptophys.work"]'), "binding restricts the sender as well as recipients");
});

test("O10. owner 2026-11-11: pending knowledge proposals wait for the owner too, and owner_attention reaches the owner's Telegram (an owner-channel topic)", async () => {
  const db = migratedDb();
  healthy(db);
  const now = at(0);
  const tg: any[] = [];
  let fail = true;
  const env = { DB: db, OWNER_TELEGRAM: { notify: async (n: any) => { tg.push(n); if (fail) { fail = false; return { sent: false, reason: "rate_limited" }; } return { sent: true }; } } };
  assert.equal(telegramConfigured(env as never, "owner_attention"), true);
  assert.equal(telegramConfigured(env as never, "critical_reports"), true, "owner 2026-11-13: critical reports reach Telegram too");
  for (const topic of ["drift", "organism", "build_minutes", "dependencies"] as const) assert.equal(telegramConfigured(env as never, topic), false, `${topic} stays in the Console`);
  db.raw.prepare(`INSERT INTO knowledge_proposals (proposal_id, proposer_agent_id, item_id, item_version, kind, item_json, content_sha256, status, decided_by, reason, decision_id, created_at, decided_at)
    VALUES ('knw_00000000-0000-4000-8000-000000000001', 'aether-calibrator', 'k-param-prophet-r37-statemaxage-16', 1, 'param_candidate', '{}', ?, 'pending', NULL, NULL, 'dec_x', ?, NULL)`).run("a".repeat(64), now);
  // #310: a text proposal runs by itself (optional veto), so it never waits for the owner.
  db.raw.prepare(`INSERT INTO knowledge_proposals (proposal_id, proposer_agent_id, item_id, item_version, kind, item_json, content_sha256, status, decided_by, reason, decision_id, created_at, decided_at)
    VALUES ('knw_00000000-0000-4000-8000-000000000002', 'aether-curator', 'k-role-risk-calibration-talk', 1, 'role_reminder', '{}', ?, 'pending', NULL, NULL, 'dec_y', ?, NULL)`).run("b".repeat(64), now);
  let r = await reconcileNotices(env as never, NOW);
  assert.deepEqual([r[0].topic, r[0].change, r[0].delivery], ["owner_attention", "opened", "failed: rate_limited"]);
  assert.equal(tg[0].change, "opened");
  assert.equal(tg[0].title, "1 item(s) wait for your approval");
  assert.deepEqual(tg[0].lines, ["Knowledge proposal k-param-prophet-r37-statemaxage-16@1 (param candidate, by aether-calibrator)"], "only the parameter proposal needs the owner");
  assert.equal(tg[0].link, "https://nexus.cryptophys.work/console/#/owner", "every kind is decided on the Owner page");
  r = await reconcileNotices(env as never, NOW);
  assert.deepEqual([r[0].change, r[0].delivery], ["delivery_retry", "sent"], "a failed Telegram send is retried");
  r = await reconcileNotices(env as never, NOW);
  assert.equal(r[0].change, "unchanged");
  assert.equal(tg.length, 2);
  db.raw.prepare("UPDATE knowledge_proposals SET status = 'approved' WHERE kind = 'param_candidate'").run();
  r = await reconcileNotices(env as never, NOW);
  assert.deepEqual([r[0].change, r[0].delivery], ["closed", "sent"]);
  assert.equal(tg.at(-1).change, "closed");
  // With email too, the delivery is "sent" only when both sent.
  const mail: any[] = [];
  const both = { ...env, APPROVER_IDENTITIES: "owner@example.com", NOTIFY_FROM: "alerts@notify.example.com", OWNER_EMAIL: { send: async (m: any) => { mail.push(m); return {}; } }, OWNER_TELEGRAM: { notify: async () => ({ sent: false, reason: "telegram_not_configured" }) } };
  db.raw.prepare("UPDATE knowledge_proposals SET status = 'pending' WHERE kind = 'param_candidate'").run();
  r = await reconcileNotices(both as never, NOW);
  assert.equal(r[0].delivery, "email: sent; telegram: failed: telegram_not_configured");
  assert.equal(mail.length, 1);
});


test("O9. the organism notice changes once while the Supervisor registers engines one by one, and again when something needs the owner; it is console-only (owner 2026-11-13)", async () => {
  const db = migratedDb();
  healthy(db);
  const census = (findings: Array<{ kind: string; subject: string; detail: string }>, sha: string) =>
    db.raw.prepare("INSERT INTO forge_organism_census (main_sha, status, organs, agents, engines, voters, findings, genome, taken_at) VALUES (?, 'changes', 18, 23, 34, 9, ?, '[]', ?)")
      .run(sha, JSON.stringify(findings), new Date(NOW + Number.parseInt(sha[0], 16) * 60_000).toISOString());
  const engine = (t: string) => ({ kind: "unregistered_engine", subject: `xauusd-ai-trading-assistant:${t}`, detail: `AI engine ${t} on xauusd-ai-trading-assistant is in the DNA but not registered` });
  const mail = emailSpy();
  const tg: any[] = [];
  const env = { DB: db, APPROVER_IDENTITIES: "owner@example.com", OWNER_EMAIL: mail.binding, NOTIFY_FROM: "alerts@notify.example.com", OWNER_TELEGRAM: { notify: async (n: any) => { tg.push(n); return { sent: true }; } } };
  const organism = async () => (await reconcileNotices(env as never, NOW)).find((r) => r.topic === "organism")!;
  census([engine("a"), engine("b"), engine("c")], "1".repeat(40));
  assert.deepEqual(await organism(), { topic: "organism", change: "opened", delivery: "console_only" });
  assert.match((await collectNotices(db as never, NOW)).find((n) => n.topic === "organism")!.title, /3 item\(s\), all being registered automatically/);
  census([engine("b"), engine("c")], "2".repeat(40));
  assert.equal((await organism()).change, "unchanged", "one engine registered: no new notice event");
  census([engine("c"), { kind: "agent_host_changed", subject: "x", detail: "agent x moved" }], "3".repeat(40));
  assert.equal((await organism()).change, "changed", "a finding the Supervisor does not settle by itself changes the notice");
  census([], "4".repeat(40));
  assert.equal((await organism()).change, "closed");
  assert.equal(mail.sent.length, 0, "the organism topic is never emailed");
  assert.equal(tg.length, 0, "nor sent to Telegram");
  const events = db.raw.prepare("SELECT event_type, payload_json FROM audit_events WHERE subject = 'organism' AND event_type LIKE 'owner.notice_%' ORDER BY rowid").all() as any[];
  assert.deepEqual(events.map((e) => [e.event_type, JSON.parse(e.payload_json).delivery]),
    [["owner.notice_opened", "console_only"], ["owner.notice_changed", "console_only"], ["owner.notice_closed", "console_only"]], "the audit events are unchanged; the delivery says console only");
});

test("O11. owner 2026-11-13: drift, organism, build minutes and dependencies are computed, audited and shown with channel console, but never emailed, sent to Telegram or retried", async () => {
  const db = migratedDb();
  healthy(db);
  // drift: a registered service the Drift Detector never observed.
  db.raw.prepare("INSERT INTO service_registry (service_id, display_name, environment, status, desired_version, metadata_json, created_at, updated_at) VALUES ('cryptophys-new', 'New', 'production', 'registered', NULL, '{}', ?, ?)").run(at(0), at(0));
  // organism: a census finding.
  db.raw.prepare("INSERT INTO forge_organism_census (main_sha, status, organs, agents, engines, voters, findings, genome, taken_at) VALUES (?, 'changes', 18, 23, 34, 9, ?, '[]', ?)")
    .run("a".repeat(40), JSON.stringify([{ kind: "agent_host_changed", subject: "x", detail: "agent x moved" }]), at(60_000));
  // build_minutes: 1000 measured minutes by 8 November project past 80% of the 3000-minute budget.
  db.raw.prepare("INSERT INTO forge_build_collections (collected_at, outcome, workers, builds_seen, builds_new) VALUES (?, 'collected', 1, 1, 1)").run(at(600_000));
  db.raw.prepare("INSERT INTO forge_builds (build_uuid, worker, created_on, stopped_on, duration_s, billed_minutes, seen_at) VALUES ('b1', 'cryptophys-forge-typecheck', ?, ?, 60000, 1000, ?)").run(at(86_400_000), at(86_000_000), at(0));
  // dependencies: no audit has succeeded for 72 hours.
  db.raw.prepare("INSERT INTO forge_dependency_audits (run_id, main_sha, ran_at, status) VALUES ('dep_1', ?, ?, 'ok')").run("b".repeat(40), at(80 * 3_600_000));
  const consoleTopics = TOPICS.filter((t) => !(OWNER_CHANNEL_TOPICS as readonly string[]).includes(t));
  assert.deepEqual(consoleTopics, ["drift", "organism", "build_minutes", "dependencies"]);
  const notices = await collectNotices(db as never, NOW);
  for (const t of consoleTopics) {
    const n = notices.find((x) => x.topic === t)!;
    assert.deepEqual([t, n.active, n.channel, channelOf(t)], [t, true, "console", "console"], `${t} is open and console-only`);
  }
  assert.deepEqual(notices.filter((n) => n.channel === "owner").map((n) => n.topic), ["owner_attention", "critical_reports", "production_unhandled"]);
  assert.equal(notices.find((n) => n.topic === "production_unhandled")!.active, false, "an 80% build month, a stale audit without a critical advisory and a census finding are not production problems");
  const mail = emailSpy();
  const tg: any[] = [];
  const env = { DB: db, APPROVER_IDENTITIES: "owner@example.com", OWNER_EMAIL: mail.binding, NOTIFY_FROM: "alerts@notify.example.com", OWNER_TELEGRAM: { notify: async (n: any) => { tg.push(n); return { sent: true }; } } };
  const first = await reconcileNotices(env as never, NOW);
  for (const t of consoleTopics) assert.deepEqual(first.find((r) => r.topic === t), { topic: t, change: "opened", delivery: "console_only" });
  const second = await reconcileNotices(env as never, NOW);
  for (const t of consoleTopics) assert.equal(second.find((r) => r.topic === t)!.change, "unchanged", `${t}: a console-only delivery is never retried`);
  assert.equal(mail.sent.length, 0);
  assert.equal(tg.length, 0);
  const events = db.raw.prepare("SELECT event_type, subject, actor FROM audit_events WHERE event_type LIKE 'owner.notice_%' ORDER BY rowid").all() as any[];
  assert.deepEqual(events.map((e) => [e.event_type, e.subject]), consoleTopics.map((t) => ["owner.notice_opened", t]), "each one is still audited, once");
  assert.ok(events.every((e) => e.actor === "agent:supervisor"));
});

test("O12. owner 2026-11-13: an open critical report is emailed and sent to Telegram with the Owner page link, and its resolution sends one Resolved message", async () => {
  const db = migratedDb();
  healthy(db);
  db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, created_at) VALUES ('rpt_c1', 'deployment-orchestrator', 'platform_digest', 'critical', 'Rollback of Cerebrum Console failed', '{}', 'deterministic', ?)").run(at(60_000));
  const mail = emailSpy();
  const tg: any[] = [];
  const env = { DB: db, APPROVER_IDENTITIES: "owner@example.com", OWNER_EMAIL: mail.binding, NOTIFY_FROM: "alerts@notify.example.com", OWNER_TELEGRAM: { notify: async (n: any) => { tg.push(n); return { sent: true }; } } };
  const critical = async () => (await reconcileNotices(env as never, NOW)).find((r) => r.topic === "critical_reports")!;
  assert.deepEqual(await critical(), { topic: "critical_reports", change: "opened", delivery: "sent" }, "email and Telegram both sent");
  assert.equal(mail.sent.length, 1);
  assert.match(mail.sent[0].subject, /^\[Cryptophys\] 1 open critical agent report\(s\) in the last 24 hours$/);
  assert.match(mail.sent[0].text, /deployment-orchestrator: Rollback of Cerebrum Console failed/);
  assert.match(mail.sent[0].text, /: https:\/\/nexus\.cryptophys\.work\/console\/#\/owner$/m);
  assert.deepEqual([tg.length, tg[0].change, tg[0].link], [1, "opened", "https://nexus.cryptophys.work/console/#/owner"]);
  assert.equal((await critical()).change, "unchanged");
  db.raw.prepare("DELETE FROM agent_reports WHERE report_id = 'rpt_c1'").run();
  assert.deepEqual(await critical(), { topic: "critical_reports", change: "closed", delivery: "sent" });
  assert.match(mail.sent[1].subject, /^\[Cryptophys\] Resolved: /);
  assert.equal(tg.at(-1).change, "closed");
  assert.equal(mail.sent.length, 2);
});
