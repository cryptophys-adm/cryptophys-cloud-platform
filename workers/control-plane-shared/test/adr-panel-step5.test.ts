// The ADR Steward, step 5 (docs/design/ADR-STEWARD.md §6, §11 row 5; owner 2026-11-16, "ya semua, sesuai
// rekomendasimu"): the Vision page's ADR panel. Its wording is §6.3's, word for word; it reads GET /v1/adr every five
// minutes while the tab is visible and an open row's GET /v1/adr/{id}; #/vision/adr scrolls to it and
// #/vision/adr/<id> opens that row; and it shows only what the API served (AGENTS.md, console-truthfulness.test.ts):
// "—" for a missing value, no bar without phases, no green mark for a status not proven. The render smoke test
// (console/ui/scripts/render-smoke.mjs) renders it filled, opened, empty, unavailable, unregistered and suspended.
// Plain fs reads relative to the repository root, so the Forge runner can bundle it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { criticalPathReason } from "../src/guard-paths.ts";
import { OWNER_ACTION_HREFS } from "../src/adr-progress.ts";
import { UI_ROUTES } from "../../console/src/ui/routes.ts";
import {
  ADR_PANEL_TITLE, ADR_POLL_MS, ADR_VIEW_SCHEMA as UI_VIEW_SCHEMA, DRIFT_LABEL, MISSING, OUTSIDE_PLATFORM, OWNER_LINK, OWNER_WAITING, STEWARD_LABEL,
  evidenceLink, explanationSource, isDeferred, lastChange, openAdrId, outsideMain, ownerLink, phaseLabel, phaseMark, progressSegments, shown,
  staleLabel, statusLabel, statusTone, stewardLabel, stewardTone, utcMinute,
} from "../../console/ui/src/lib/adr.ts";
import { ADR_VIEW_SCHEMA, type StewardStatus } from "../../ai-kernel/src/adr-view.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const design = () => read("docs/design/ADR-STEWARD.md");
/** §6.3's table, key -> label, with the backticks of the key and the label removed. */
function labels(): Map<string, string> {
  const d = design();
  const section = d.slice(d.indexOf("### 6.3 Labels (Indonesian)"), d.indexOf("### 6.4 Sketch"));
  const out = new Map<string, string>();
  for (const m of section.matchAll(/^\| ([^|\n]+?) \| ([^|\n]+?) \|$/gm)) if (m[1] !== "Key" && !/^-+$/.test(m[1])) out.set(m[1].replace(/`/g, ""), m[2]);
  return out;
}
const ENTRY_0012 = { adr: "0012", status: "in_progress", lifecycle: "accepted", deferred: false, phases_total: 26, phases_proven: 12, phases_asserted: 6, percent: 69, percent_proven: 46, revision: 14, changed_at: "2026-11-17T21:56:00.000Z" };

test("AV1. the panel's wording is §6.3's: the owner's title, the statuses, the phases, the owner actions, drift, stale and the explanation source", () => {
  const l = labels();
  assert.equal(ADR_PANEL_TITLE, "ADR — Architecture Decision Records (Catatan Keputusan Arsitektur)", "the owner's exact title");
  assert.equal(l.get("Panel title"), ADR_PANEL_TITLE);
  assert.match(design(), /\*\*Panel title \(owner\):\*\* "ADR — Architecture Decision Records \(Catatan Keputusan Arsitektur\)"/);
  assert.equal(statusLabel({ status: "not_started" }), l.get("Status not_started"));
  assert.equal(l.get("Status in_progress"), "berjalan (X dari Y fase)");
  assert.equal(statusLabel(ENTRY_0012), "berjalan (18 dari 26 fase)", "X counts the complete phases, proven and asserted, as the sketch does");
  assert.equal(statusLabel({ status: "done" }), l.get("Status done"));
  assert.equal(l.get("Status superseded"), "digantikan oleh ADR-NNNN");
  assert.equal(statusLabel({ status: "superseded", superseded_by: "0021" }), "digantikan oleh ADR-0021");
  assert.equal(statusLabel({ status: "held" }), l.get("Status held"));
  assert.equal(statusLabel({ status: "planned" }), l.get("Status planned"));
  assert.equal(statusLabel({ status: "held", phases_total: 5, phases_proven: 0, phases_asserted: 1 }), "ditahan (1 dari 5 fase)", "as the sketch's 0018 row");
  assert.equal(l.get("Badge deferred"), "ditunda");
  assert.match(read("workers/console/ui/src/components/AdrPanel.tsx"), /\{isDeferred\(e\) && <Badge tone="amber">ditunda<\/Badge>\}/);
  assert.equal(phaseLabel("proven"), l.get("Phase proven"));
  assert.equal(l.get("Phase asserted"), `dinyatakan dokumen (eksternal: "dinyatakan sumber luar")`);
  assert.equal(phaseLabel("doc_asserted"), "dinyatakan dokumen");
  assert.equal(phaseLabel("external_asserted"), "dinyatakan sumber luar");
  assert.equal(phaseLabel("open"), l.get("Phase open"));
  assert.equal(l.get("Stale"), "data lama: <source> tidak terbaca");
  assert.equal(staleLabel(["outcome_scores"]), "data lama: outcome_scores tidak terbaca");
  assert.equal(DRIFT_LABEL, l.get("Drift"));
  assert.equal(l.get("Explanation source"), `dijelaskan AI · teks otomatis`);
  assert.deepEqual([explanationSource({ source: "ai" }), explanationSource({ source: "template" })], ["dijelaskan AI", "teks otomatis"]);
  assert.equal(MISSING, l.get("Missing value"));
  const owner = l.get("Owner action")!;
  for (const w of [OWNER_WAITING, OWNER_LINK["#/owner"], OWNER_LINK["#/consensus"], OUTSIDE_PLATFORM]) assert.ok(owner.includes(w), w);
  assert.deepEqual(Object.keys(OWNER_LINK).sort(), [...OWNER_ACTION_HREFS].sort(), "a link for every href a manifest may name, and no other");
  const right = l.get("Right of title")!.replace(" <time>", "");
  assert.equal(right, "baca-saja · dihitung dari bukti, bukan tebakan AI · diperbarui");
  const panel = read("workers/console/ui/src/components/AdrPanel.tsx");
  assert.ok(panel.includes(`<span>${right} {utcMinute(steward?.last_pass_at)}</span>`), "right of the title, with the last pass's time");
  // Every column of §6.3 after Status is a label on the row or its open detail (Kemajuan is the bar).
  for (const col of l.get("Columns")!.split(" · ").slice(1)) assert.ok(panel.includes(col === "Kemajuan" ? "% terbukti" : col), col);
});

test("AV2. truthfulness: a missing value is \"—\", a bar only with phases and both percentages, green only for proven, the Steward's four states as served", () => {
  assert.deepEqual([shown(null), shown(undefined), shown(""), shown(0), shown("x")], [MISSING, MISSING, MISSING, "0", "x"], "0 is a value, never a default");
  assert.equal(statusLabel({}), MISSING, "no default status");
  assert.equal(statusLabel({ status: "something_new" }), "something_new", "an unknown status is shown as served");
  assert.equal(statusLabel({ status: "in_progress" }), "berjalan", "no count without the counts");
  assert.equal(statusLabel({ status: "superseded" }), "digantikan", "no ADR number without superseded_by");
  // Proven solid, asserted hatched, both from the response.
  assert.deepEqual(progressSegments(ENTRY_0012), { proven: 46, asserted: 23, percent: 69 });
  assert.equal(progressSegments({ status: "planned", phases_total: 0, percent: 0, percent_proven: 0 }), null, "a planned ADR without phases has no bar");
  assert.equal(progressSegments({ ...ENTRY_0012, percent: null }), null);
  assert.equal(progressSegments({ ...ENTRY_0012, percent_proven: undefined }), null);
  assert.equal(progressSegments({ ...ENTRY_0012, phases_total: null }), null);
  assert.deepEqual(progressSegments({ phases_total: 2, percent: 50, percent_proven: 50 }), { proven: 50, asserted: 0, percent: 50 });
  // Green only for an ADR done by evidence; held and planned are drawn apart.
  assert.equal(statusTone({ status: "done", percent_proven: 100 }), "green");
  assert.notEqual(statusTone({ status: "done", percent_proven: 60 }), "green", "done by document is not shown as proven");
  for (const s of ["not_started", "in_progress", "held", "planned", "superseded", undefined]) assert.notEqual(statusTone({ status: s, percent_proven: 100 }), "green", String(s));
  assert.deepEqual([outsideMain({ status: "held" }), outsideMain({ status: "planned" }), outsideMain({ status: "in_progress", lifecycle: "accepted" })], [true, true, false]);
  assert.deepEqual([isDeferred({ deferred: true }), isDeferred({ deferred: null }), isDeferred({ lifecycle: "deferred" })], [true, false, false], "the badge only when the document says so");
  assert.deepEqual([phaseMark("proven"), phaseMark("doc_asserted"), phaseMark("external_asserted"), phaseMark("open"), phaseMark("not_measurable_yet"), phaseMark("unknown"), phaseMark(undefined)],
    ["proven", "asserted", "asserted", "open", "open", "open", "open"], "nothing unproven is marked proven");
  // The Steward's states (adr-view.ts StewardStatus), each in words; only enabled is green.
  const states: StewardStatus[] = ["enabled", "suspended", "agents_disabled", "not_registered"];
  assert.deepEqual(Object.keys(STEWARD_LABEL).sort(), [...states].sort());
  assert.deepEqual(states.map(stewardLabel), ["aktif", "ditangguhkan", "dimatikan (kill switch agen)", "belum terdaftar"]);
  assert.deepEqual(states.map(stewardTone), ["green", "red", "red", "amber"]);
  assert.equal(stewardLabel(undefined), MISSING);
  assert.equal(UI_VIEW_SCHEMA, ADR_VIEW_SCHEMA, "the panel recognizes exactly the kernel's view");
  assert.deepEqual([utcMinute("2026-11-17T22:37:12.000Z"), utcMinute(null), utcMinute("not a time")], ["2026-11-17 22:37 UTC", MISSING, MISSING]);
  assert.deepEqual([lastChange(ENTRY_0012), lastChange({})], ["rev 14 · 2026-11-17 21:56 UTC", `${MISSING} · ${MISSING}`]);
  assert.equal(explanationSource(null), MISSING);
  // Only the platform's own pages are linked; anything else in a document is shown, never followed.
  assert.deepEqual(ownerLink({ href: "#/owner" }), { href: "#/owner", label: "Buka halaman Owner" });
  for (const href of ["javascript:alert(1)", "https://example.com", "#/ledger", null]) assert.equal(ownerLink({ href }), null, String(href));
  assert.deepEqual(evidenceLink("ev:platform/consensus/cns_1"), { text: "ev:consensus/cns_1", href: "#/consensus" });
  assert.equal(evidenceLink("ev:platform/audit/evt_1@2026-11-17#x")?.href, "#/ledger");
  assert.equal(evidenceLink("ev:platform/forge.change/fg-x")?.href, "#/code");
  assert.equal(evidenceLink("ev:platform/observer.vitals/x")?.href, "#/organism");
  assert.equal(evidenceLink("ev:platform/doc/docs-SSOT.md")?.href, null);
  assert.deepEqual(evidenceLink("javascript:alert(1)"), { text: "javascript:alert(1)", href: null });
  // #/vision/adr/<id>: four digits only.
  assert.deepEqual([openAdrId("adr", "0012"), openAdrId("adr", "12"), openAdrId("adr", undefined), openAdrId("goals", "0012"), openAdrId("adr", "0012x")], ["0012", null, null, null, null]);
});

test("AV3. the panel reads kernel.adr every five minutes while visible and an open row's kernel.adr_one, writes nothing and invents no number", () => {
  const panel = read("workers/console/ui/src/components/AdrPanel.tsx");
  const lib = read("workers/console/ui/src/lib/adr.ts");
  assert.deepEqual([...panel.matchAll(/\b(?:call|act)\(\s*(?:\{\s*route:\s*)?"([a-z_.]+)"/g)].map((m) => m[1]), ["kernel.adr_one", "kernel.adr"], "two reads, no action");
  assert.doesNotMatch(panel, /route:\s*"/, "no write route");
  for (const id of ["kernel.adr", "kernel.adr_one"]) {
    const r = UI_ROUTES.find((x) => x.id === id)!;
    assert.deepEqual([r.method, r.approverOnly, r.confirm], ["GET", false, null], id);
  }
  // §6.5: the slow poll, at the ADR-0015 §3 floor; usePoll skips a hidden tab.
  assert.equal(ADR_POLL_MS, 300_000);
  assert.match(design(), /`usePoll\(\(\) => call\("kernel\.adr"\), 300_000\)`/);
  assert.match(panel, /usePoll\(\(\) => call\("kernel\.adr"\), ADR_POLL_MS\)/);
  assert.match(read("workers/console/ui/src/lib/usePoll.ts"), /if \(document\.visibilityState === "visible"\) void refresh\(\);/);
  // The open row's document is read when it opens and again only when the list shows a new revision.
  assert.match(panel, /usePoll\(\(\) => call\("kernel\.adr_one", id\), 0, \[id, rev\]\)/);
  // Honest states (§4.9): no table yet, no pass yet, the Steward not running, an unknown response.
  assert.match(panel, /data\.available === false\) body = <Empty>Steward belum berjalan: data ADR belum tersedia/);
  assert.match(panel, /adrs\.length === 0\) body = <Empty>Belum ada pass Steward/);
  assert.match(panel, /known && status !== "enabled" &&/);
  assert.match(panel, /!known\) body = <Empty>Respons GET \/v1\/adr tidak dikenali/);
  // No default number, no hardcoded percentage, no default status.
  for (const [name, s] of [["AdrPanel.tsx", panel], ["adr.ts", lib]] as const) {
    assert.doesNotMatch(s, /\?\? 0\b|\|\| 0\b|\?\? 100\b/, `${name}: no default number`);
    assert.doesNotMatch(s, /["'`]\d+ ?%/, `${name}: no percentage written into the UI`);
    assert.doesNotMatch(s, /\?\? "(done|in_progress|enabled|selesai|aktif)"/, `${name}: no default status`);
  }
  // The bar: proven solid, asserted hatched (index.css .adr-hatch).
  assert.match(panel, /data-adr-seg="proven"[^>]*bg-emerald-400/);
  assert.match(panel, /data-adr-seg="asserted" className="adr-hatch/);
  assert.match(read("workers/console/ui/src/index.css"), /\.adr-hatch \{ background-image: repeating-linear-gradient\(/);
});

test("AV4. routing: #/vision/adr scrolls to the panel and #/vision/adr/<id> opens that row; the panel renders without a vision; the render smoke covers every state", () => {
  const app = read("workers/console/ui/src/App.tsx");
  assert.match(app, /const sub = id && parts\[2\] && SAFE\.test\(parts\[2\]\) \? parts\[2\] : undefined;/);
  assert.match(app, /case "vision": page = <Vision section=\{id\} item=\{sub\} \/>; break;/);
  const vision = read("workers/console/ui/src/pages/Vision.tsx");
  assert.match(vision, /export default function Vision\(\{ section, item \}: \{ section\?: string; item\?: string \}\)/);
  // Below Goals and KPIs, outside the `v &&` block (§6.2: it does not depend on the vision).
  assert.match(vision, /<\/Panel>\n {6}<\/>\)\}\n(?: {6}\{\/\*[^\n]*\*\/\}\n)? {6}<AdrPanel focus=\{section === "adr"\} openId=\{openAdrId\(section, item\)\} \/>\n {4}<\/div>/);
  const panel = read("workers/console/ui/src/components/AdrPanel.tsx");
  assert.match(panel, /<a href=\{open \? "#\/vision\/adr" : `#\/vision\/adr\/\$\{id\}`\}/, "a row opens and closes through the hash");
  assert.match(panel, /\(row \?\? ref\.current\)\?\.scrollIntoView\(\{ block: "start" \}\)/);
  const smoke = read("workers/console/ui/scripts/render-smoke.mjs");
  assert.match(smoke, /MOCK\["\/api\/kernel\/v1\/adr"\] = \{ schema: "adr\.progress-view\.v1", available: true/);
  assert.match(smoke, /MOCK\["\/api\/kernel\/v1\/adr\/0012"\]/);
  for (const name of ["filled", "open row", "no pass yet", "unavailable", "not registered", "suspended", "no vision"]) assert.match(smoke, new RegExp(`\\{ name: "${name}", hash: "vision`), name);
  assert.match(smoke, /hash: "vision\/adr\/0012", override: \{\}, open: "0012"/);
  assert.match(smoke, /const ADR_PANEL_TITLE = "ADR — Architecture Decision Records \(Catatan Keputusan Arsitektur\)";/);
  assert.match(smoke, /a number without a document/, "an empty or unavailable list shows no number");
  assert.match(smoke, /repeating-linear-gradient/, "the asserted share is checked as hatched");
  assert.match(smoke, /the held and planned rows are not drawn apart/);
  assert.match(smoke, /the planned ADR shows a number/);
  assert.match(smoke, /did not scroll to the panel/);
});

test("AV5. no guard path is touched; docs/SSOT.md records step 5 and the panel on the Vision page; the design marks step 5 built", () => {
  for (const p of ["workers/console/ui/src/components/AdrPanel.tsx", "workers/console/ui/src/lib/adr.ts", "workers/console/ui/src/pages/Vision.tsx", "workers/console/ui/src/App.tsx",
    "workers/console/ui/src/index.css", "workers/console/ui/scripts/render-smoke.mjs", "workers/ai-kernel/src/adr-view.ts", "workers/control-plane-shared/test/adr-panel-step5.test.ts",
    "workers/control-plane-shared/test/adr-api-step4.test.ts", "workers/control-plane-shared/test/vision-telos-0016.test.ts", "docs/SSOT.md", "docs/design/ADR-STEWARD.md"]) assert.equal(criticalPathReason(p), null, p);
  const ssot = read("docs/SSOT.md");
  assert.match(ssot.split("\n").find((l) => l.startsWith("Last reviewed: "))!, /(?:^Last reviewed: |\); )2026-11-16 \([^\n]*ADR Steward step 5, the Vision page's ADR panel: [^()]*`#\/vision\/adr\/<id>`[^()]*; ADR Steward step 4, the read-only API: /);
  assert.match(ssot, /The Console's Vision page \(`#\/vision`\) shows it\.[^\n]*\n  - [^\n]*ADR — Architecture Decision Records \(Catatan Keputusan Arsitektur\)/);
  assert.doesNotMatch(ssot, /the Vision page's ADR panel is not built yet/);
  assert.match(design(), /\| 5 \| The Vision panel: [^\n]*\*\*Built 2026-11-17\*\*/);
});
