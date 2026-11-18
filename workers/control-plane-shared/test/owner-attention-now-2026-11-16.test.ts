// Owner 2026-11-16 (approved directly): a consensus proposal entering pending_owner sends the owner's notice in the
// same cron tick, not up to 30 minutes later. Before, the owner_attention notice was reconciled only at :22 and :52,
// concurrently with the Supervisor cycle, so a proposal the cycle created (cns_dea7a710, 7 s after the 10:52:46 pass)
// waited for the next pass and was approved before any notice opened. Now the kernel's scheduled handler reconciles
// owner_attention alone after the cycle and that tick's :22/:52 pass have settled, when an item newer than the last
// notice event waits; the same reconcile (fingerprint dedup, retries, channels, closing) as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migratedDb } from "./harness.ts";
import kernel from "../../ai-kernel/src/index.ts";
import {
  MAX_DELIVERY_RETRIES, OWNER_PANEL_URL, TOPICS, collectNotices, ownerAttentionHasNewItems, reconcileNotices, reconcileOwnerAttentionNow,
} from "../../ai-kernel/src/owner-notices.ts";

const ROOT = new URL("../../../", import.meta.url);
const CRON = "7,22,37,52 * * * *";
const tick = (minute: number) => Date.parse(`2026-11-16T10:${String(minute).padStart(2, "0")}:00Z`);
const OWNER_TITLE = /^(\d+ item\(s\) wait for your approval|Nothing waits for your approval)$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Db = ReturnType<typeof migratedDb>;
let seq = 0;

/** A critical proposal as consensus.ts propose() records it in mode deploy (status pending_owner). */
function pendingOwner(db: Db, action = "merge_owner_change", target = "fg-owner-attention-now") {
  const id = `cns_t${++seq}`;
  const at = new Date().toISOString();
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES (?, 'supervisor', ?, ?, 'critical', '{}', '{}', 'deploy', 9, 6, 0, 1, NULL, 'allow', 'pending_owner', '{"executed":false}', ?, ?)`).run(id, action, target, at, at);
  return id;
}

/**
 * The kernel env with a Supervisor whose cycle, like the real one, proposes after the tick started (here 15 ms in, after
 * the :22/:52 pass has read the inbox), and the owner's Telegram (the xauusd OwnerNotifier) as a spy.
 */
function setup(opts: { telegram?: (n: any) => { sent: boolean; reason?: string } } = {}) {
  const db = migratedDb();
  const tg: any[] = [];
  let propose: (() => void) | null = null;
  const cycles: string[] = [];
  const env: Record<string, unknown> = {
    DB: db,
    OWNER_NOTICE_CHANNELS: "telegram",
    OWNER_TELEGRAM: { notify: async (n: any) => { tg.push(n); return opts.telegram ? opts.telegram(n) : { sent: true }; } },
    SUPERVISOR: {
      idFromName: (n: string) => n,
      get: () => ({
        cycle: async (t: string) => { cycles.push(t); await sleep(15); propose?.(); propose = null; return { agent_id: "supervisor", trigger: t, findings: [], actions: [] }; },
        status: async () => null,
      }),
    },
  };
  const run = async (minute: number, during?: () => void) => {
    propose = during ?? null;
    const waited: Promise<unknown>[] = [];
    await kernel.scheduled({ scheduledTime: tick(minute), cron: CRON }, env as never, { waitUntil: (p) => { waited.push(p); } });
    await Promise.all(waited);
  };
  const owner = () => tg.filter((n) => OWNER_TITLE.test(n.title));
  const events = (topic = "owner_attention") => (db.raw.prepare("SELECT event_type, payload_json FROM audit_events WHERE subject = ? AND event_type LIKE 'owner.notice_%' ORDER BY rowid").all(topic) as any[])
    .map((e) => ({ type: e.event_type as string, ...JSON.parse(e.payload_json) }));
  return { db, env, tg, owner, events, run, cycles };
}

for (const minute of [7, 37, 52]) {
  test(`N1.${minute}. a proposal the cycle puts in pending_owner at :${String(minute).padStart(2, "0")} is sent to the owner once, in that tick`, async () => {
    const s = setup();
    let id = "";
    await s.run(minute, () => { id = pendingOwner(s.db); });
    assert.deepEqual(s.cycles, ["scheduled"]);
    assert.equal(s.owner().length, 1, "exactly one owner_attention delivery in the tick");
    const [n] = s.owner();
    assert.equal(n.change, "opened");
    assert.equal(n.title, "1 item(s) wait for your approval");
    assert.equal(n.lines.length, 1);
    assert.match(n.lines[0], /^#1 Critical action: .*fg-owner-attention-now.* \(proposed by supervisor\) · blocks merges, deploys · due in 24 h · https:\/\/nexus\.cryptophys\.work\/console\/#\/owner\/consensus:cns_t\d+$/);
    assert.equal(n.link, OWNER_PANEL_URL, "every item is decided on the Owner page (owner 2026-11-13)");
    const ev = s.events();
    assert.deepEqual(ev.map((e) => [e.type, e.delivery, e.count]), [["owner.notice_opened", "sent", 1]]);
    assert.ok(id.startsWith("cns_t"));
  });
}

test("N2. a second cycle with the same pending set sends nothing and records nothing", async () => {
  const s = setup();
  await s.run(52, () => pendingOwner(s.db));
  assert.equal(s.owner().length, 1);
  await s.run(7);
  await s.run(22);
  await s.run(37);
  await s.run(52);
  assert.equal(s.owner().length, 1, "never more than once per fingerprint");
  assert.deepEqual(s.events().map((e) => e.type), ["owner.notice_opened"]);
});

test("N3. a cycle that creates no pending_owner proposal adds no notice traffic", async () => {
  const s = setup();
  await s.run(7);
  await s.run(37);
  assert.equal(s.tg.length, 0, "no Telegram message at all at :07/:37");
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type LIKE 'owner.notice_%'").get() as any).n, 0, "and no notice event");
  assert.equal(await ownerAttentionHasNewItems(s.db as never), false);
  assert.equal(await reconcileOwnerAttentionNow(s.env as never), null);
});

test("N4. a second proposal in a later cycle changes the notice once; both proposals are listed", async () => {
  const s = setup();
  await s.run(7, () => pendingOwner(s.db, "merge_owner_change", "fg-first"));
  await s.run(37, () => pendingOwner(s.db, "merge_owner_change", "fg-second"));
  assert.deepEqual(s.owner().map((n) => [n.change, n.title]), [["opened", "1 item(s) wait for your approval"], ["changed", "2 item(s) wait for your approval"]]);
  assert.equal(s.owner()[1].lines.length, 2);
  assert.ok(s.owner()[1].lines.some((l: string) => l.includes("fg-first")) && s.owner()[1].lines.some((l: string) => l.includes("fg-second")));
});

test("N5. the :22/:52 pass still works: it opens what waited before the tick and keeps the other topics on its cadence", async () => {
  const s = setup();
  // Created between ticks (e.g. the Knowledge Council's amend_constitution over AgentRpc): caught by the next tick.
  pendingOwner(s.db, "amend_constitution", "platform");
  s.db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, created_at) VALUES ('rpt_c', 'supervisor', 'platform_digest', 'critical', 'Rollback failed', '{}', 'deterministic', ?)")
    .run(new Date(tick(0)).toISOString());
  await s.run(22);
  assert.equal(s.owner().length, 1, "the full pass opened owner_attention; the pass after the cycle found nothing newer");
  assert.equal(s.events().length, 1);
  assert.deepEqual(s.events("critical_reports").map((e) => e.type), ["owner.notice_opened"], "the full pass reconciled every topic");

  const t = setup();
  t.db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, created_at) VALUES ('rpt_c', 'supervisor', 'platform_digest', 'critical', 'Rollback failed', '{}', 'deterministic', ?)")
    .run(new Date(tick(0)).toISOString());
  await t.run(7, () => pendingOwner(t.db));
  assert.equal(t.owner().length, 1);
  assert.deepEqual(t.events("critical_reports"), [], "at :07 only owner_attention is reconciled");
  await t.run(22);
  assert.deepEqual(t.events("critical_reports").map((e) => e.type), ["owner.notice_opened"]);
  assert.equal(t.owner().length, 1, "and the :22 pass does not repeat the owner_attention notice");

  // An item created between ticks after the last notice is caught right after the next cycle, even at :07.
  const u = setup();
  pendingOwner(u.db);
  await u.run(7);
  assert.deepEqual(u.owner().map((n) => n.change), ["opened"]);
});

test("N6. deciding the proposal closes the notice at the next :22/:52 pass, once", async () => {
  const s = setup();
  let id = "";
  await s.run(52, () => { id = pendingOwner(s.db); });
  assert.equal(s.owner().length, 1);
  s.db.raw.prepare("UPDATE consensus_proposals SET status = 'executed', decided_at = ? WHERE proposal_id = ?").run(new Date().toISOString(), id);
  await s.run(7);
  assert.equal(s.owner().length, 1, "a decision alone adds nothing at :07 (closing keeps the :22/:52 cadence)");
  await s.run(22);
  assert.deepEqual(s.owner().map((n) => [n.change, n.title]), [["opened", "1 item(s) wait for your approval"], ["closed", "Nothing waits for your approval"]]);
  await s.run(37);
  await s.run(52);
  assert.equal(s.owner().length, 2);
  assert.deepEqual(s.events().map((e) => e.type), ["owner.notice_opened", "owner.notice_closed"]);
});

test("N7. a failed delivery after the cycle is retried on the :22/:52 cadence, at most MAX_DELIVERY_RETRIES times", async () => {
  const s = setup({ telegram: () => ({ sent: false, reason: "telegram down" }) });
  await s.run(7, () => pendingOwner(s.db));
  assert.equal(s.owner().length, 1);
  assert.match(s.events()[0].delivery, /^failed: telegram down$/);
  await s.run(37);
  assert.equal(s.owner().length, 1, "the pass after the cycle does not retry");
  for (let i = 0; i < MAX_DELIVERY_RETRIES + 2; i++) await s.run(i % 2 ? 52 : 22);
  assert.equal(s.owner().length, 1 + MAX_DELIVERY_RETRIES);
  assert.deepEqual(s.events().map((e) => e.type), ["owner.notice_opened", ...Array(MAX_DELIVERY_RETRIES).fill("owner.notice_delivery_retry")]);
});

test("N8. a failing cycle still runs the pass afterwards; the pass after the cycle is never concurrent with the :52 pass", async () => {
  const s = setup();
  (s.env.SUPERVISOR as any).get = () => ({ cycle: async () => { await sleep(5); pendingOwner(s.db); throw new Error("cycle failed"); }, status: async () => null });
  const errors: string[] = [];
  const orig = console.error;
  console.error = (m: string) => { errors.push(String(m)); };
  try { await s.run(52); } finally { console.error = orig; }
  assert.ok(errors.some((e) => e.includes("supervisor_cycle_failed")));
  assert.equal(s.owner().length, 1, "the proposal recorded before the failure is still notified");

  const idx = readFileSync(new URL("workers/ai-kernel/src/index.ts", ROOT), "utf8");
  assert.match(idx, /const cycle = env\.SUPERVISOR\.get\(env\.SUPERVISOR\.idFromName\(AGENT_ID\)\)\.cycle\("scheduled"\)/);
  assert.match(idx, /ctx\.waitUntil\(Promise\.all\(\[cycle, fullPass\]\)\.then\(\(\) => reconcileOwnerAttentionNow\(\{ \.\.\.env, ALERT_VAULT: alertVaultOf\(env\) \}\)\)/);
});

test("N9. topics: collectNotices and reconcileNotices limited to owner_attention touch nothing else", async () => {
  const db = migratedDb();
  assert.deepEqual((await collectNotices(db as never, tick(7), ["owner_attention"])).map((n) => n.topic), ["owner_attention"]);
  assert.deepEqual((await collectNotices(db as never, tick(7))).map((n) => n.topic), [...TOPICS], "without topics: every topic, in order");
  pendingOwner(db);
  const tg: any[] = [];
  const env = { DB: db, OWNER_TELEGRAM: { notify: async (n: any) => { tg.push(n); return { sent: true }; } } };
  assert.deepEqual(await reconcileNotices(env as never, tick(7), { topics: ["owner_attention"] }), [{ topic: "owner_attention", change: "opened", delivery: "sent" }]);
  assert.equal(await ownerAttentionHasNewItems(db as never), false, "the item is in the notice the owner received");
  assert.equal(await reconcileOwnerAttentionNow(env as never), null);
  assert.equal(tg.length, 1);
});
