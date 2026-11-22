// Frontend mockup 2026-11-22 (owner approved in the frontend session: "lanjutkan semua dan tetap berkoordinasi dengan
// orkestrator"): the Organism page's Telemetry tab on GET /v1/telemetry (ADR-0015 decision 6, phase 3, step 4). It reads
// only kernel.telemetry, twice (the syscalls by agent or capability, and the cron jobs), each with its own error box and
// Retry; a null is "—" or a gap, never 0; the hours before the first point are hatched as no data; the tail is folded
// into Other (top 3 agents, top 2 capabilities); "not configured" is shown as such. Measured data only (AGENTS.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FOLD_TOP, MISSING, OTHER, TONE_COLOR, cells, count, cronCell, deployMarks, foldSeries, ms, noDataBuckets, rate, shareTone, sumOrNull, topKeys, totalsOf, seriesOf,
} from "../../console/ui/src/lib/telemetry.ts";
import { UI_ROUTES } from "../../console/src/ui/routes.ts";
import { criticalPathReason } from "../src/guard-paths.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const UI = "workers/console/ui/src/";
const HOUR = 3_600_000;
const buckets = (n: number, end = Date.parse("2026-11-22T04:00:00.000Z")) => Array.from({ length: n }, (_, i) => new Date(end - (n - 1 - i) * HOUR).toISOString());

test("TT1. a null is \"—\" or a gap, never 0; sums over nothing stay null; tones are cyan / amber / red / grey, never green", () => {
  assert.deepEqual([count(null), rate(null), ms(null), count(undefined), rate("0.1"), ms(Number.NaN)], [MISSING, MISSING, MISSING, MISSING, MISSING, MISSING]);
  assert.deepEqual([count(0), rate(0), ms(0)], ["0", "0.0 %", "0 ms"], "0 is a value, never a default");
  assert.equal(rate(0.0039), "0.39 %");
  assert.deepEqual(cells([1, null, "2", undefined], 5), [1, null, null, null, null], "anything but a number is no point");
  assert.equal(sumOrNull([null, null]), null);
  assert.equal(sumOrNull([null, 0, 2]), 2);
  assert.deepEqual([shareTone(null, "denied"), shareTone(0, "denied"), shareTone(0.01, "denied"), shareTone(0.01, "failed")], ["off", "ok", "late", "fault"]);
  assert.deepEqual([cronCell(null, null, false), cronCell(4, 0, false), cronCell(4, 1, false), cronCell(4, 1, true)], ["none", "ok", "fault", "nodata"]);
  assert.deepEqual(TONE_COLOR, { ok: "#22d3ee", late: "#fbbf24", fault: "#ef4444", off: "#94a3b8" }, "the header status port's palette");
});

test("TT2. hours before first_point_at are hatched; with no first point every hour is", () => {
  const b = buckets(24);
  // The first point at 02:52 of the 7th hour: the six whole hours before it are no data; its own hour has data.
  const first = new Date(Date.parse(b[6]) + 52 * 60_000 + 13_000).toISOString();
  assert.equal(noDataBuckets(b, first, HOUR), 6);
  assert.equal(noDataBuckets(b, b[0], HOUR), 0);
  assert.equal(noDataBuckets(b, null, HOUR), 24);
  assert.equal(noDataBuckets(b, "not a date", HOUR), 24);
  const marks = deployMarks({ deploys: [{ at: b[12], deploy_version: "785b0e235bac", previous: null }, { at: "2026-10-01T00:00:00.000Z", deploy_version: "old", previous: null }] }, b, HOUR);
  assert.deepEqual(marks.map((m) => [m.version, m.x]), [["785b0e235bac", 0.5]], "a deploy outside the window draws no marker");
});

test("TT3. the tail folds into Other: top 3 agents, top 2 capabilities, in the API's order of totals", () => {
  assert.deepEqual(FOLD_TOP, { agent: 3, capability: 2 });
  const keys = ["a", "b", "c", "d", "e"];
  const body = {
    totals: keys.map((key, i) => ({ key, syscalls: 50 - i * 10, denied: 0, failed: 0, deny_rate: 0, fail_rate: 0, latency_ms: { p50: null, p95: null } })),
    series: keys.map((key, i) => ({ key, syscalls: [i, null, i === 4 ? 7 : null], denied: [0, null, null], failed: [0, null, null] })),
  };
  const totals = totalsOf(body), series = seriesOf(body, 3);
  assert.deepEqual(topKeys(totals, "agent"), ["a", "b", "c"]);
  assert.deepEqual(topKeys(totals, "capability"), ["a", "b"]);
  const agent = foldSeries(series, totals, "agent", 3);
  assert.deepEqual(agent.map((f) => f.label), ["a", "b", "c", `${OTHER} (2)`]);
  assert.deepEqual(agent[3].syscalls, [3 + 4, null, 7], "Other is the folded keys' sum per hour, null where none had a point");
  assert.equal(agent[3].total, 20 + 10);
  assert.deepEqual(foldSeries(series, totals, "capability", 3).map((f) => f.label), ["a", "b", `${OTHER} (3)`]);
  assert.deepEqual(foldSeries(series.slice(0, 2), totals.slice(0, 2), "agent", 3).map((f) => f.label), ["a", "b"], "no Other without a tail");
  assert.equal(totalsOf({ totals: [{ key: "x", latency_ms: {} }] })[0].latency_ms.p50, null, "a missing quantile stays null");
});

test("TT4. the tab reads only kernel.telemetry, twice, each with its own error box and Retry; no green, no tokens or neurons", () => {
  const route = UI_ROUTES.find((r) => r.id === "kernel.telemetry");
  assert.deepEqual(route && [route.service, route.method, route.path, route.confirm], ["kernel", "GET", "/v1/telemetry", null]);
  const tab = read(`${UI}components/MetabolismPanels.tsx`);
  const calls = [...tab.matchAll(/call\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(calls, ["kernel.telemetry", "kernel.telemetry"]);
  assert.match(tab, /usePoll\(\(\) => call\("kernel\.telemetry", undefined, undefined, \{ window: win, group \}\), 60_000, \[win, group\]\)/);
  assert.match(tab, /usePoll\(\(\) => call\("kernel\.telemetry", undefined, undefined, \{ window: win, group: "job" \}\), 60_000, \[win\]\)/);
  assert.match(tab, /<ErrorBox error=\{sys\.error\} onRetry=\{\(\) => void sys\.refresh\(\)\}/);
  assert.match(tab, /<ErrorBox error=\{job\.error\} onRetry=\{\(\) => void job\.refresh\(\)\}/);
  // Only the answer for the selected window and group is drawn.
  assert.match(tab, /sys\.data\.window === win && sys\.data\.group === group \? sys\.data : null/);
  // Not configured is its own state; the hatch follows first_point_at; the fold follows FOLD_TOP.
  assert.match(tab, /s\?\.configured === false && <NotConfigured what="syscalls" \/>/);
  assert.match(tab, /j\?\.configured === false && <NotConfigured what="cron runs" \/>/);
  assert.match(tab, /noDataBuckets\(sb\.buckets, s\.first_point_at, sb\.bucketMs\)/);
  assert.match(tab, /noDataBuckets\(jb\.buckets, j\.first_point_at, jb\.bucketMs\)/);
  assert.match(tab, /foldSeries\(seriesOf\(s, n\), totals, group, n\)/);
  for (const f of [tab, read(`${UI}lib/telemetry.ts`)]) {
    assert.doesNotMatch(f, /emerald|green-|STATUS\.good|#0ca30c|#199e70|#008300/, "green stays for bullish only");
    assert.doesNotMatch(f, /\.(tokens|neurons)\b|neurons?_|tokens?_(in|out)/, "tokens and neurons are not shown");
  }
  const viz = read(`${UI}components/viz.tsx`);
  assert.match(viz, /export function Sparkline\(/);
  assert.match(viz, /<pattern id=\{id\} patternUnits="userSpaceOnUse"/, "the no-data hatch");
});

test("TT5. routing: #/organism/telemetry opens the tab, #/metabolism still lands on Organism; the owner's undecided texts are unchanged", () => {
  const app = read(`${UI}App.tsx`);
  assert.match(app, /case "organism": page = <Organism section=\{id\} \/>; break;/);
  assert.match(app, /case "metabolism": page = <Organism \/>; current = "organism"; break;/);
  const org = read(`${UI}pages/Organism.tsx`);
  assert.match(org, /export default function Organism\(\{ section \}: \{ section\?: string \}\)/);
  assert.match(org, /\{ id: "telemetry", label: "Telemetry", href: "#\/organism\/telemetry" \}/);
  assert.match(org, /\{tab === "telemetry" \? <TelemetryPanels \/> : <Metabolism \/>\}/);
  assert.match(org, /The platform never moves funds or places orders\./);
  assert.match(read(`${UI}pages/Markets.tsx`), /advisory relay · not an order/);
});

test("TT6. the render smoke draws the tab: fixtures per window and group, configured false, a failed read with Retry", () => {
  const smoke = read("workers/console/ui/scripts/render-smoke.mjs");
  assert.match(smoke, /"organism", "organism\/telemetry",/);
  assert.match(smoke, /for \(const w of \["24h", "7d"\]\) for \(const g of \["agent", "capability", "job"\]\) MOCK\[tq\(w, g\)\] = telemetryFixture\(w, g\);/);
  assert.match(smoke, /configured: false/);
  for (const name of ["agent 24h", "capability", "7d", "not configured", "job read fails"]) assert.match(smoke, new RegExp(`\\{ name: "${name}", override: `), name);
  for (const s of ["the tail folded into Other", "hours before the first point hatched", "a null value is not shown as \"—\"", "Retry did not read", "deploy markers, expected"]) assert.ok(smoke.includes(s), s);
});

test("TT7. no guard path is touched; docs/SSOT.md records the tab", () => {
  for (const p of [`${UI}components/MetabolismPanels.tsx`, `${UI}components/viz.tsx`, `${UI}lib/telemetry.ts`, `${UI}pages/Organism.tsx`, `${UI}App.tsx`,
    "workers/console/ui/scripts/render-smoke.mjs", "workers/control-plane-shared/test/console-telemetry-tab-2026-11-22.test.ts", "docs/SSOT.md"]) assert.equal(criticalPathReason(p), null, p);
  const ssot = read("docs/SSOT.md");
  assert.match(ssot.split("\n").find((l) => l.startsWith("Last reviewed: "))!, /^Last reviewed: 2026-11-16 \((?:[^\n]*; )?Console Telemetry tab, 2026-11-22 \(the frontend mockup the owner approved, "lanjutkan semua dan tetap berkoordinasi dengan orkestrator"\): [^\n]*`#\/organism\/telemetry`/);
  assert.match(ssot, /\n  - The Console's Organism page has a Telemetry tab \(`#\/organism\/telemetry`, [^\n]*hours before `first_point_at` are hatched as no data/);
});
