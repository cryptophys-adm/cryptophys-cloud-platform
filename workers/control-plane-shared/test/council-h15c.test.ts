// HAIC H1.5c (docs/design/HAIC-H0-H1.md §2.2, §4.4, §4.6): a council that waits for the owner's pick is an owner inbox
// item and part of the owner_attention notice (the single source of council notices); the Console forwards the council
// routes, with typed phrases on convene, pick and dismiss; the Councils page calls only the council routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migratedDb } from "./harness.ts";
import { councilsAwaitingOwner, ownerInbox } from "../../ai-kernel/src/owner-inbox.ts";
import { OWNER_PANEL_URL, collectNotices } from "../../ai-kernel/src/owner-notices.ts";
import { COUNCIL_KIND, rankInbox } from "../src/owner-inbox-rank.ts";
import { UI_ROUTES } from "../../console/src/ui/routes.ts";
import { CONSOLE_ALLOW_LIST } from "../../console/src/index.ts";

const NOW = Date.parse("2026-11-18T10:00:00Z");
const at = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
const CS = (n: number) => `cs_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const EMPTY = { approvals: { recovery_plans: [], consensus: [], knowledge: [] }, critical_reports: [], production_problems: [] };

function council(db: ReturnType<typeof migratedDb>, n: number, state: string, waitingSinceH: number, deadlineH: number, topic = `Topic ${n}`) {
  db.raw.prepare(`INSERT INTO councils (session_id, side, topic, state, owner_present, created_by, spent_calls, spent_usd, reason, transcript_sha256, created_at, updated_at, deadline)
    VALUES (?, 'cerebrum', ?, ?, 0, 'owner@example.com', 11, 0.024, NULL, NULL, ?, ?, ?)`).run(CS(n), topic, state, at(waitingSinceH - 1), at(waitingSinceH), at(deadlineH));
}
const auditCount = (db: ReturnType<typeof migratedDb>) => (db.raw.prepare("SELECT count(*) AS n FROM audit_events").get() as { n: number }).n;

test("CC1. rankInbox: a council waiting for the pick is a normal item that blocks nothing, links to its page, and is picked there", () => {
  const items = rankInbox({ ...EMPTY, councils: [{ session_id: CS(1), topic: "Native deploys fail after migrations", since: at(-12), deadline: at(60) }] }, NOW);
  assert.equal(items.length, 1);
  const i = items[0];
  assert.deepEqual(COUNCIL_KIND, { urgency: "normal", blocks: [] });
  assert.equal(i.item_id, `council:${CS(1)}`);
  assert.equal(i.source, "council");
  assert.equal(i.kind, "council_awaiting_pick");
  assert.equal(i.what, "Council waits for your pick: Native deploys fail after migrations");
  assert.deepEqual(i.evidence_refs, [`ev:platform/council/${CS(1)}`]);
  assert.deepEqual([i.urgency, i.blocks, i.deadline, i.created_at, i.metric, i.risk], ["normal", [], at(60), at(-12), null, null]);
  // 100 × U 0.4 × B 1 × A 1.5 (12 h) × D 1 (60 h left) = 60.
  assert.deepEqual([i.score, i.score_parts], [60, { U: 0.4, B: 1, A: 1.5, D: 1 }]);
  assert.deepEqual(i.action, { kind: "pick", route: "kernel.council_pick", approver_only: true });
  assert.equal(i.page, `#/councils/${CS(1)}`);
  assert.equal(i.deep_link, `#/owner/council:${CS(1)}`);
  assert.ok(UI_ROUTES.some((r) => r.id === i.action.route), "the action names an existing Console route");
  // Within an hour of expiry the deadline factor triples it; a critical report still outranks it.
  const late = rankInbox({ ...EMPTY, councils: [{ session_id: CS(2), topic: "t", since: at(-71.5), deadline: at(0.5) }],
    critical_reports: [{ report_id: "rpt_1", agent_id: "observer", subject: "s", created_at: at(-1) }] }, NOW);
  assert.deepEqual(late.map((x) => [x.item_id, x.score]), [["critical_report:rpt_1", 469], [`council:${CS(2)}`, 240]]);
});

test("CC2. GET /v1/owner/inbox lists only councils in awaiting_owner whose window is open, soonest deadline first; reading writes nothing", async () => {
  const db = migratedDb();
  council(db, 1, "awaiting_owner", -10, 62, "Later deadline");
  council(db, 2, "awaiting_owner", -60, 12, "Sooner deadline");
  council(db, 3, "awaiting_owner", -80, -8, "Window passed, not yet expired by its alarm");
  council(db, 4, "positions", -1, 71);
  council(db, 5, "decided", -20, 52);
  council(db, 6, "dismissed", -20, 52);
  const before = auditCount(db);
  const waiting = await councilsAwaitingOwner(db as never, NOW);
  assert.deepEqual(waiting, [
    { session_id: CS(2), topic: "Sooner deadline", since: at(-60), deadline: at(12) },
    { session_id: CS(1), topic: "Later deadline", since: at(-10), deadline: at(62) },
  ]);
  const inbox = await ownerInbox(db as never, NOW) as any;
  assert.deepEqual(inbox.councils, waiting);
  assert.equal(inbox.counts.councils, 2);
  assert.deepEqual(inbox.items.filter((i: any) => i.source === "council").map((i: any) => i.item_id), [`council:${CS(2)}`, `council:${CS(1)}`]);
  assert.equal(inbox.schema, "owner-inbox.v1", "additive: the schema and the three sections are unchanged");
  assert.equal(auditCount(db), before, "reading the inbox writes nothing");
});

test("CC3. the owner_attention notice is the single source of council notices: it counts the waiting council and deep-links it", async () => {
  const db = migratedDb();
  const quiet = (await collectNotices(db as never, NOW, ["owner_attention"]))[0];
  assert.equal(quiet.active, false);
  council(db, 7, "awaiting_owner", -2, 70, "Knowledge proposals expire unreviewed");
  const n = (await collectNotices(db as never, NOW, ["owner_attention"]))[0];
  assert.equal(n.active, true);
  assert.equal(n.count, 1);
  assert.equal(n.link, OWNER_PANEL_URL);
  assert.ok(n.fingerprint && n.fingerprint !== quiet.fingerprint);
  assert.equal(n.lines.length, 1);
  assert.match(n.lines[0], /^#1 Council waits for your pick: Knowledge proposals expire unreviewed · blocks nothing · .+#\/owner\/council:cs_00000000-0000-4000-8000-000000000007$/);
  assert.ok(!/\/(approve|reject|pick|dismiss)\b/.test(JSON.stringify(n)), "no notice URL performs an action");
});

test("CC4. before migration 0079 there is no council to list", async () => {
  const db = migratedDb();
  db.raw.exec("DROP TABLE councils");
  assert.deepEqual(await councilsAwaitingOwner(db as never, NOW), []);
  const inbox = await ownerInbox(db as never, NOW) as any;
  assert.deepEqual([inbox.councils, inbox.counts.councils], [[], 0]);
});

test("CC5. the Console forwards the six council routes; convene, pick and dismiss need a typed phrase, a message does not", () => {
  const byId = Object.fromEntries(UI_ROUTES.map((r) => [r.id, r]));
  assert.deepEqual(["kernel.councils", "kernel.council", "kernel.council_start", "kernel.council_message", "kernel.council_pick", "kernel.council_dismiss"].map((id) => {
    const r = byId[id];
    return [id, r.method, r.path, r.approverOnly, r.confirm];
  }), [
    ["kernel.councils", "GET", "/v1/councils", false, null],
    ["kernel.council", "GET", "/v1/councils/{id}", false, null],
    ["kernel.council_start", "POST", "/v1/councils", true, "CONVENE COUNCIL"],
    ["kernel.council_message", "POST", "/v1/councils/{id}/messages", true, null],
    ["kernel.council_pick", "POST", "/v1/councils/{id}/pick", true, "PICK {id13}"],
    ["kernel.council_dismiss", "POST", "/v1/councils/{id}/dismiss", true, "DISMISS {id13}"],
  ]);
  for (const r of UI_ROUTES.filter((x) => x.id.startsWith("kernel.council"))) {
    assert.ok(CONSOLE_ALLOW_LIST.some((a) => a.service === "kernel" && a.method === r.method && a.path === r.path), `${r.id} is an allow-list row`);
  }
});

test("CC6. the Councils page calls only the council routes: a council never acts", () => {
  const src = readFileSync(new URL("../../console/ui/src/pages/Councils.tsx", import.meta.url), "utf8");
  const routes = [...src.matchAll(/(?:call\(|route: )"([a-z_.]+)"/g)].map((m) => m[1]);
  assert.ok(routes.length >= 6, routes.join(", "));
  // HAIC H3c: and the owner's correction of a message, claim or option (it decides nothing).
  assert.deepEqual([...new Set(routes)].sort(), ["kernel.council", "kernel.council_begin", "kernel.council_correct", "kernel.council_dismiss", "kernel.council_message", "kernel.council_pick", "kernel.council_start", "kernel.councils"]);
  assert.ok(!/consensus|policy\.|recovery\.|registry\.|orchestrator\./.test(routes.join(" ")));
});
