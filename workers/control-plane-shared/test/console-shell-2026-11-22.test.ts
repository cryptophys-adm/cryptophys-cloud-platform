// Frontend mockup 2026-11-22 (owner approved in the frontend session: "lanjutkan semua dan tetap berkoordinasi dengan
// orkestrator"): the Console shell. A grouped side nav, a header strip of status cells and a UTC + local clock, an error box
// with Retry on the pages that never showed a failed load, and the Markets colours. Measured data only (AGENTS.md):
// a header cell the API did not report reads "—" in grey, never a default.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { attentionCell, clockParts, driftCell, meshCell, observedCell, OBSERVED_FAULT_MS, OBSERVED_LATE_MS } from "../../console/ui/src/lib/headerStatus.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const NOW = Date.parse("2026-11-22T04:00:00.000Z");

test("CS1. header cells: measured values only; a missing value is grey '—'; tones cyan / amber / red, never green", () => {
  for (const cell of [meshCell(null), attentionCell(null), driftCell(null), observedCell(null, NOW), attentionCell({ open_agent_plans: [] } as never)]) {
    assert.deepEqual([cell.code, cell.tone], ["—", "off"], cell.label);
  }
  assert.deepEqual([meshCell({ agents_enabled: true }).code, meshCell({ agents_enabled: true }).tone], ["LIVE", "ok"]);
  assert.deepEqual([meshCell({ agents_enabled: false }).code, meshCell({ agents_enabled: false }).tone], ["HALTED", "fault"]);
  const ov = (critical: number, plans: number) => ({ agent_reports_24h: { latest_critical: Array.from({ length: critical }, (_, i) => ({ report_id: `r${i}`, agent_id: "a", kind: "k", created_at: "" })) }, open_agent_plans: Array.from({ length: plans }, (_, i) => ({ plan_id: `p${i}` })) });
  assert.deepEqual(["CLEAR", "ok"], [attentionCell(ov(0, 0) as never).code, attentionCell(ov(0, 0) as never).tone]);
  assert.deepEqual(["2", "late"], [attentionCell(ov(0, 2) as never).code, attentionCell(ov(0, 2) as never).tone]);
  assert.deepEqual(["1", "fault"], [attentionCell(ov(1, 2) as never).code, attentionCell(ov(1, 2) as never).tone], "a critical report outranks waiting plans");
  const svc = (drifted: boolean, persistent = false) => ({ service_id: "s", drifted, persistent });
  assert.equal(driftCell({ services: [svc(false)] }).tone, "ok");
  assert.equal(driftCell({ services: [svc(true)] }).tone, "late");
  assert.equal(driftCell({ services: [svc(true, true), svc(false)] }).tone, "fault");
  const at = (msAgo: number) => ({ observed_at: new Date(NOW - msAgo).toISOString() });
  assert.deepEqual([observedCell(at(5 * 60_000), NOW).code, observedCell(at(5 * 60_000), NOW).tone], ["5m", "ok"]);
  assert.equal(observedCell(at(OBSERVED_LATE_MS + 60_000), NOW).tone, "late");
  assert.equal(observedCell(at(OBSERVED_FAULT_MS + 60_000), NOW).tone, "fault");
  const c = clockParts(new Date(NOW));
  assert.equal(c.utc, "04:00:00");
  assert.equal(c.utcShort, "04:00");
  const status = read("workers/console/ui/src/components/HeaderStatus.tsx");
  assert.doesNotMatch(status, /emerald|green-/, "green stays for bullish only");
});

test("CS2. the shell: grouped nav with every page once (Owner first), Alerts in the nav, no doctrine panel, slogan or identity strip", () => {
  const shell = read("workers/console/ui/src/components/AppShell.tsx");
  const keys = [...shell.matchAll(/\{ label: "[^"]+", href: "#\/[^"]*", key: "([^"]*)", icon: \w+ \}/g)].map((m) => m[1]);
  const groups = [...shell.matchAll(/\{ title: "[^"]+", keys: \[([^\]]*)\] \}/g)].flatMap((m) => [...m[1].matchAll(/"([^"]*)"/g)].map((k) => k[1]));
  assert.deepEqual([...groups].sort(), [...keys].sort(), "every nav entry is in exactly one group");
  assert.equal(new Set(groups).size, groups.length);
  assert.deepEqual(keys.slice(0, 2), ["owner", ""], "Owner first, then Command (owner 2026-11-13)");
  assert.ok(keys.includes("alerts"));
  assert.doesNotMatch(shell, /Cockpit Doctrine|Observe → reason → act → attest|>identity</);
  assert.doesNotMatch(shell, /role="menuitem" href="#\/alerts"/, "Alerts left the account menu");
  assert.match(shell, /<StatusStrip \/>/);
  assert.match(shell, /<StatusRow \/>/);
  assert.match(shell, /min-h-\[44px\]/, "phone drawer rows are 44 px");
  // Every page App.tsx routes to has a nav entry or is a detail view of one.
  const app = read("workers/console/ui/src/App.tsx");
  for (const k of [...app.matchAll(/case "([a-z]+)":/g)].map((m) => m[1]).filter((k) => k !== "metabolism")) assert.ok(keys.includes(k), `nav has ${k}`);
});

test("CS3. a failed load shows an error box with Retry on the seven pages that never showed one; Markets colours carry glyphs", () => {
  const ui = read("workers/console/ui/src/components/ui.tsx");
  assert.match(ui, /export function ErrorBox\(\{ error, onRetry, stale = false \}/);
  assert.match(ui, /if \(!error\) return null;/);
  for (const page of ["Infrastructure", "Organism", "Policy", "Recovery", "RecoveryDetail", "Ledger", "AgentDetail"]) {
    assert.match(read(`workers/console/ui/src/pages/${page}.tsx`), /<ErrorBox error=\{[^}]+\} onRetry=\{/, page);
  }
  const markets = read("workers/console/ui/src/pages/Markets.tsx");
  assert.match(markets, /\{ key: "BUY", label: "▲ BUY \(advisory\)", color: "#1a9c50" \}/);
  assert.match(markets, /\{ key: "HOLD", label: "■ HOLD \/ other", color: "#d9a21b" \}/);
  assert.match(markets, /\{ key: "SELL", label: "▼ SELL \(advisory\)", color: "#c23a3a" \}/);
  // Unchanged until the owner decides (flagged by the frontend session).
  assert.match(markets, /advisory relay · not an order/);
});
