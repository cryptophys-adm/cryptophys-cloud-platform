// HAIC H0d (docs/design/HAIC-H0-H1.md §2.5): the owner notices list their top 5 items by the inbox's score, each with a
// deep link to the item on the Owner page, and no notice carries a URL or a button that performs an action.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { migratedDb } from "./harness.ts";
import { CONSOLE_URL, OWNER_CHANNEL_TOPICS, OWNER_PANEL_URL, TOP_LINES, collectNotices, rankedLines, reconcileNotices } from "../../ai-kernel/src/owner-notices.ts";
import { rankInbox } from "../src/owner-inbox-rank.ts";

const NOW = Date.parse("2026-11-18T06:00:00Z");
const at = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

test("H0d-1. rankedLines: the top 5 by score as `#<rank> <what> · blocks <…> · <due> · <deep link>`, then one line for the rest", () => {
  const reports = Array.from({ length: 7 }, (_, i) => ({ report_id: `rpt_${i}`, agent_id: "observer", subject: `finding ${i}`, created_at: at(-i) }));
  const items = rankInbox({ approvals: { recovery_plans: [], consensus: [], knowledge: [] }, critical_reports: reports, production_problems: [] }, NOW);
  const lines = rankedLines(items, NOW);
  assert.equal(TOP_LINES, 5);
  assert.equal(lines.length, 6);
  assert.equal(lines[5], "and 2 more on the Owner page");
  assert.equal(lines[0], `#1 observer: finding 6 · blocks deploys, merges · no deadline · ${CONSOLE_URL}#/owner/critical_report:rpt_6`, "the oldest open report ranks first (age)");
  lines.slice(0, 5).forEach((l, i) => assert.ok(l.startsWith(`#${i + 1} `), l));
  assert.deepEqual(rankedLines(items.slice(0, 2), NOW).length, 2, "no rest line when everything fits");
  assert.deepEqual(rankedLines([], NOW), []);
});

test("H0d-2. every owner notice ranks its items, counts all of them, and no notice carries a URL that acts; the Telegram payload has no buttons", async () => {
  const db = migratedDb();
  for (const s of db.raw.prepare("SELECT service_id FROM service_registry WHERE status != 'disabled'").all() as { service_id: string }[]) {
    db.raw.prepare(`INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at) VALUES (?, ?, 'h', 'h', 0, '{"reasons":[]}', ?)`).run(`obs_${s.service_id}`, s.service_id, at(-0.05));
    db.raw.prepare("UPDATE service_registry SET updated_at = ? WHERE service_id = ?").run(at(-0.05), s.service_id);
  }
  const proposal = (id: string, action: string, target: string, hoursAgo: number) => db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES (?, 'supervisor', ?, ?, 'critical', '{}', '{}', 'deploy', 8, 8, 0, 1, NULL, NULL, 'pending_owner', NULL, ?, ?)`).run(id, action, target, at(-hoursAgo), at(-hoursAgo));
  proposal("cns_admit", "admit_voter", "forge-steward", 1);
  proposal("cns_merge", "merge_owner_change", "fg-claude-guarded", 21);
  proposal("cns_retire", "retire_worker", "cryptophys-home", 2);
  for (let i = 0; i < 4; i++) proposal(`cns_voter_${i}`, "admit_voter", `agent-${i}`, 0.5);
  for (const [id, h] of [["rpt_a", 3], ["rpt_b", 1]] as const) db.raw.prepare(`INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at)
    VALUES (?, 'deployment-orchestrator', 'platform_digest', 'critical', ?, '{}', 'deterministic', NULL, ?)`).run(id, `deploy failed ${id}`, at(-h));

  const notices = await collectNotices(db as never, NOW);
  const attention = notices.find((n) => n.topic === "owner_attention")!;
  assert.equal(attention.count, 7, "the notice is about all seven");
  assert.equal(attention.title, "7 item(s) wait for your approval");
  assert.equal(attention.lines.length, 6);
  assert.match(attention.lines[0], /^#1 Critical action: .*fg-claude-guarded.* · blocks merges, deploys · due in 3 h · https:\/\/nexus\.cryptophys\.work\/console\/#\/owner\/consensus:cns_merge$/, "the merge with 3 h left ranks first");
  assert.match(attention.lines[1], /^#2 Critical action: .* · blocks cutover_gate, deploys · due in 22 h · .*#\/owner\/consensus:cns_retire$/);
  assert.equal(attention.lines[5], "and 2 more on the Owner page");
  const critical = notices.find((n) => n.topic === "critical_reports")!;
  assert.deepEqual([critical.count, critical.lines.map((l) => l.replace(/ · .*$/, ""))], [2, ["#1 deployment-orchestrator: deploy failed rpt_a", "#2 deployment-orchestrator: deploy failed rpt_b"]]);

  const urls: string[] = [];
  for (const n of notices) {
    for (const text of [n.link, n.title, ...n.lines]) {
      assert.doesNotMatch(text, /\/(approve|reject|acknowledge|disable|execute)\b/i, `${n.topic}: no notice text names an action route`);
      for (const u of text.match(/https?:\/\/\S+/g) ?? []) urls.push(u);
    }
  }
  for (const n of notices.filter((x) => (OWNER_CHANNEL_TOPICS as readonly string[]).includes(x.topic))) {
    assert.equal(n.link, OWNER_PANEL_URL);
    for (const l of n.lines) for (const u of l.match(/https?:\/\/\S+/g) ?? []) assert.ok(u.startsWith(`${OWNER_PANEL_URL}/`), `${n.topic}: ${u} is a deep link into the Owner page`);
  }
  assert.ok(urls.length >= 7);
  assert.ok(urls.every((u) => u.startsWith(CONSOLE_URL) && !u.includes("?")), "every link opens the Console only; none carries a query");

  const sent: any[] = [];
  await reconcileNotices({ DB: db, OWNER_TELEGRAM: { notify: async (m: any) => { sent.push(m); return { sent: true }; } } } as never, NOW);
  assert.ok(sent.length >= 2);
  for (const m of sent) {
    assert.deepEqual(Object.keys(m).sort(), ["change", "lines", "link", "title"], "no inline keyboard, callback or reply markup");
    assert.ok(m.lines.length <= TOP_LINES + 1);
  }
  const ev = db.raw.prepare("SELECT json_extract(payload_json, '$.count') AS n FROM audit_events WHERE event_type = 'owner.notice_opened' AND subject = 'owner_attention'").get() as { n: number };
  assert.equal(ev.n, 7, "the audit records how many items, not how many lines");
});

test("H0c. the Owner page ranks from the inbox's items[] and opens one by its deep link, with no new read or action route", () => {
  const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
  const page = read("workers/console/ui/src/pages/Owner.tsx");
  assert.match(page, /const items = arr\(data\?\.items\)/, "the ranked list is the kernel's, not recomputed in the browser");
  assert.match(page, /<RankedList items=\{items\} \/>/);
  assert.match(page, /<ItemDetail id=\{item\}/);
  assert.deepEqual([...page.matchAll(/\bcall\(\s*"([a-z_.]+)"/g)].map((m) => m[1]), ["kernel.owner_inbox"], "still one read");
  assert.match(page, /This item no longer waits for you/);
  assert.doesNotMatch(page, /deep_link[^\n]*(approve|reject|acknowledge)/, "a deep link only navigates");
  const smoke = read("workers/console/ui/scripts/render-smoke.mjs");
  for (const name of ["ranked", "item", "item-gone", "item-gone-empty"]) assert.match(smoke, new RegExp(`name: "${name}"`), `render smoke checks ${name}`);
});
