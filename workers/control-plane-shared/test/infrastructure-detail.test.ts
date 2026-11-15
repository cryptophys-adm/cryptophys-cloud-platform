// Owner 2026-11-15 ("tombol Edit tidak berfungsi"): the Console's Services & Drift page is read only. The Edit form
// is gone, a click on a service opens a read-only detail panel, the age of the last probe is the Drift Detector's
// heartbeat (not the last observation, written only on change since 0061), and an untagged version is labelled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NOT_MEASURED, UNTAGGED_LABEL, UNTAGGED_REASON, driftReasons, driftState, lastProbeAt, minutesSince, onlyUntagged, probeAges,
} from "../src/service-detail.ts";
import { onlyUntaggedVersion } from "../../ai-kernel/src/supervisor.ts";
import { UI_ROUTES } from "../../console/src/ui/routes.ts";
import { CONSOLE_ALLOW_LIST } from "../../console/src/index.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const NOW = Date.parse("2026-11-15T10:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

test("I1. the last probe is last_seen_at (service_registry.updated_at), never the last recorded observation", () => {
  // In sync for 80 minutes: the row was recorded 80 minutes ago, the heartbeat 4 minutes ago.
  const row = { service_id: "cryptophys-forge", drifted: false, observed_at: minutesAgo(80), last_seen_at: minutesAgo(4), evidence: { reasons: [] } };
  assert.equal(lastProbeAt(row), minutesAgo(4));
  assert.equal(minutesSince(lastProbeAt(row), NOW), 4);
  // No heartbeat: not measured, and observed_at is not used in its place.
  assert.equal(lastProbeAt({ ...row, last_seen_at: null }), null);
  assert.equal(lastProbeAt({ ...row, last_seen_at: "not a time" }), null);
  assert.equal(lastProbeAt(undefined), null);
  assert.equal(minutesSince(null, NOW), null);
  assert.equal(minutesSince("garbage", NOW), null);
  assert.equal(minutesSince(new Date(NOW + 120_000).toISOString(), NOW), 0, "a clock skew into the future reads 0, not a negative age");
  assert.equal(minutesSince(minutesAgo(7.4), NOW), 7);
});

test("I2. probe ages: oldest first, gaps listed as not measured, and nothing summed or defaulted to 0", () => {
  const byId = new Map([
    ["a", { last_seen_at: minutesAgo(3) }],
    ["b", { last_seen_at: minutesAgo(14) }],
    ["c", { last_seen_at: null, observed_at: minutesAgo(80) }],
    ["e", { last_seen_at: minutesAgo(14) }],
  ]);
  const ages = probeAges(["a", "b", "c", "d", "e"], byId, NOW);
  assert.deepEqual(ages.measured.map((x) => [x.service_id, x.minutes]), [["b", 14], ["e", 14], ["a", 3]]);
  assert.deepEqual(ages.unmeasured, ["c", "d"], "no heartbeat and no row are not measured");
  assert.ok(ages.measured.every((x) => x.minutes > 0), "no invented zero");
  assert.equal(probeAges([], byId, NOW).measured.length, 0);
  // The page folds the services beyond the first six by their maximum age, never by a sum (the old "other (12): 80 min").
  const viz = read("workers/console/ui/src/components/viz.tsx");
  assert.match(viz, /fold === "max"\s*\?\s*\{ label: `\$\{rest\.length\} more · up to`, value: Math\.max\(\.\.\.rest\.map\(\(i\) => i\.value\)\) \}/);
  const inf = read("workers/console/ui/src/pages/Infrastructure.tsx");
  assert.match(inf, /<BarList max=\{6\} rest="max" unit=" min"/);
  assert.match(inf, /Minutes since last probe · Drift Detector heartbeat/);
  assert.match(inf, /Not measured \(never probed\)/);
  assert.doesNotMatch(inf, /\?\? 0 \}\)\)/, "a missing age is not drawn as 0");
});

test("I3. drift label: an untagged version (dashboard change) is not a plain 'drifted'", () => {
  const untagged = { drifted: true, evidence: { reasons: [UNTAGGED_REASON] } };
  assert.deepEqual(driftState(untagged), { kind: "untagged", label: "untagged version (dashboard change)", tone: "amber" });
  assert.equal(UNTAGGED_LABEL, "untagged version (dashboard change)");
  assert.deepEqual(driftState({ drifted: true, evidence: { reasons: ["health_check_failed", UNTAGGED_REASON] } }).kind, "drifted", "unhealthy as well: drifted");
  assert.deepEqual(driftState({ drifted: true, evidence: { reasons: ["version_mismatch"] } }), { kind: "drifted", label: "drifted", tone: "red" });
  assert.deepEqual(driftState({ drifted: false, evidence: { reasons: [] } }), { kind: "in_sync", label: "in sync", tone: "green" });
  assert.deepEqual(driftState(undefined), { kind: "not_observed", label: "not observed", tone: "slate" });
  assert.equal(driftState(untagged, "disabled").kind, "disabled", "the registry's disabled status wins");
  assert.deepEqual(driftReasons({ evidence: { reasons: ["a", 3, "b"] } }), ["a", "b"]);
  assert.deepEqual(driftReasons({ evidence: null }), []);
  // The same rule as the Supervisor's (not a recovery case), so the page and the agents never disagree.
  for (const reasons of [[UNTAGGED_REASON], ["version_mismatch"], ["health_check_failed", UNTAGGED_REASON], []]) {
    assert.equal(onlyUntagged(reasons), onlyUntaggedVersion({ reasons }), JSON.stringify(reasons));
  }
  const inf = read("workers/console/ui/src/pages/Infrastructure.tsx");
  assert.match(inf, /label: "untagged version", value: count\("untagged"\)/);
  assert.match(inf, /driftState\(byId\.get\(s\.service_id\), s\.status\)/);
});

test("I4. the page is read only: no Edit, no registry write, Observe now kept, and a row opens the detail panel", () => {
  const inf = read("workers/console/ui/src/pages/Infrastructure.tsx");
  assert.doesNotMatch(inf, /Editor|Pencil|>Edit<|registry\.upsert|registry\.desired_version|Update service|Set desired version/);
  assert.match(inf, /route: "drift\.observe"/);
  assert.match(inf, /onRowClick=\{\(s\) => setOpen\(s\.service_id\)\}/);
  assert.match(inf, /aria-label=\{`Details of \$\{s\.service_id\}`\}/);
  assert.match(inf, /<ServiceDetail service=\{selected\} drift=\{byId\.get\(selected\.service_id\)\} onClose=\{close\} \/>/);
  for (const id of ["registry.upsert", "registry.desired_version"]) assert.equal(UI_ROUTES.find((r) => r.id === id), undefined, `${id} is gone`);
  assert.equal(CONSOLE_ALLOW_LIST.filter((a) => a.service === "registry" && a.method === "PUT").length, 0);
  const drift = UI_ROUTES.find((r) => r.id === "drift.service");
  assert.deepEqual(drift, { id: "drift.service", service: "drift", method: "GET", path: "/v1/drift/{id}", approverOnly: false, confirm: null });
  assert.ok(CONSOLE_ALLOW_LIST.some((a) => a.service === "drift" && a.method === "GET" && a.path === "/v1/drift/{id}"), "already allow-listed");
});

test("I5. the detail panel reads only GET routes and says 'not measured' for a gap, never a default number", () => {
  const d = read("workers/console/ui/src/components/ServiceDetail.tsx");
  const routes = [...d.matchAll(/call\("([a-z_.]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(routes, ["drift.service", "forge.census", "orchestrator.deployments", "platform.observer"]);
  for (const id of routes) assert.equal(UI_ROUTES.find((r) => r.id === id)?.method, "GET", id);
  assert.doesNotMatch(d, /\bact\(|useSession/, "no action from the panel");
  assert.equal(NOT_MEASURED, "not measured");
  assert.match(d, /\{value \?\? <Unmeasured \/>\}/);
  assert.match(d, /D1 is not attributed to a Worker/, "no per-Worker D1 figure is invented");
  assert.match(d, /`account-wide \$\{est\.value\} · estimated`/, "the account estimate is labelled");
  assert.doesNotMatch(d, /\?\? 0\b|\|\| 0\b/, "no missing value becomes 0");
  // The bottom sheet on a phone, the side panel on a desktop; Escape closes.
  assert.match(d, /absolute inset-x-0 bottom-0/);
  assert.match(d, /lg:inset-y-0 lg:left-auto lg:right-0/);
  assert.match(d, /e\.key === "Escape"/);
  // The render smoke opens it at both widths, measured and not measured.
  const smoke = read("workers/console/ui/scripts/render-smoke.mjs");
  assert.match(smoke, /const DETAIL_CHECKS = \[/);
  assert.match(smoke, /name: "not measured"/);
  assert.match(smoke, /not a bottom sheet/);
  assert.match(smoke, /not a side panel/);
});

test("I6. SSOT: a dashboard secret or variable change reads as observed_version_unavailable until the next deploy", () => {
  const ssot = read("docs/SSOT.md");
  assert.match(ssot, /dashboard secret or variable change creates an untagged Worker version/);
  assert.match(ssot, /observed_version_unavailable/);
  assert.match(ssot, /a 66-route allow-list/);
});
