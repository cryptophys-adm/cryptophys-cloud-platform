// ADR-0012 phase 2: owner notices without GitHub (replaces owner-attention.yml and drift-alert.yml).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migratedDb } from "./harness.ts";
import { collectNotices, emailConfigured, reconcileNotices, STALE_MS } from "../../ai-kernel/src/owner-notices.ts";

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
  assert.deepEqual(n.map((x) => [x.topic, x.active]), [["owner_attention", false], ["drift", false], ["critical_reports", false]]);
  assert.deepEqual((await reconcileNotices({ DB: db } as never, NOW)).map((r) => r.change), ["unchanged", "unchanged", "unchanged"]);
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
  assert.match(mail.sent[0].text, /Recovery plan for Cerebrum Console .*#\/recovery\/plan_1/);
  r = await reconcileNotices(env as never, NOW);
  assert.equal(r[0].change, "unchanged", "same items, no second email");
  assert.equal(mail.sent.length, 1);
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES ('cns_1', 'supervisor', 'retire_worker', 'cryptophys-home', 'critical', '{}', '{}', 'deploy', 9, 6, 0, 1, NULL, NULL, 'pending_owner', NULL, ?, ?)`).run(now, now);
  r = await reconcileNotices(env as never, NOW);
  assert.equal(r[0].change, "changed");
  assert.match(mail.sent[1].text, /Critical action: retire Home \(retired\)/);
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
});

test("O5. wiring: kernel schedule, kernel route, Console route and panel", () => {
  const idx = readFileSync(new URL("workers/ai-kernel/src/index.ts", ROOT), "utf8");
  assert.match(idx, /if \(minute === 22 \|\| minute === 52\) \{\n\s+ctx\.waitUntil\(reconcileNotices\(env, event\.scheduledTime\)/);
  assert.match(idx, /path === "\/v1\/notices" && request\.method === "GET"/);
  assert.match(readFileSync(new URL("workers/console/src/ui/routes.ts", ROOT), "utf8"), /r\("kernel\.notices", "kernel", "GET", "\/v1\/notices", false, null\)/);
  assert.match(readFileSync(new URL("workers/console/ui/src/pages/Command.tsx", ROOT), "utf8"), /call\("kernel\.notices"\)/);
  assert.doesNotMatch(readFileSync(new URL("workers/ai-kernel/wrangler.toml", ROOT), "utf8"), /send_email/, "the email binding is added only after the owner onboards the sending domain");
});
