// ADR-0015 decision 6, phase 3, step 4 (owner 2026-11-22: "sesuai rekomendasimu", a read-only Account Analytics token):
// GET /v1/telemetry, the Console's Telemetry tab, in the shape the frontend session specified. These tests run against a
// fake SQL API; the first real read is checked on the account once the owner has set the kernel's two secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clearTelemetryCache, hourBuckets, JOB_ORDER, telemetryView } from "../../ai-kernel/src/telemetry-view.ts";
import { CONSOLE_ALLOW_LIST } from "../../console/src/index.ts";
import { UI_ROUTES } from "../../console/src/ui/routes.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const NOW = Date.parse("2026-11-22T04:30:00.000Z");
const ACCOUNT = "c".repeat(32);
const TOKEN = "analytics-read-token-TESTONLY";
const env = { CF_ANALYTICS_TOKEN: TOKEN, CF_ANALYTICS_ACCOUNT_ID: ACCOUNT };
const q = (s: string) => new URLSearchParams(s);

/** A fake Analytics Engine SQL API: answers by the shape of the query, records every call. */
function sqlApi(answer: (sql: string) => unknown[] | Response) {
  const calls: Array<{ url: string; auth: string; body: string }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    calls.push({ url, auth: (init?.headers as Record<string, string>).authorization, body });
    const a = answer(body);
    return a instanceof Response ? a : new Response(JSON.stringify({ meta: [], data: a, rows: a.length }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl: fetchImpl as never };
}

test("TV1. without the kernel's two secrets: configured false, the buckets, and no request at all", async () => {
  clearTelemetryCache();
  const api = sqlApi(() => []);
  const r = await telemetryView({}, q("window=24h&group=agent"), NOW, api.fetchImpl);
  assert.equal(r.configured, false);
  assert.equal((r.buckets as string[]).length, 24);
  assert.equal(api.calls.length, 0);
  assert.equal((await telemetryView({ CF_ANALYTICS_TOKEN: TOKEN, CF_ANALYTICS_ACCOUNT_ID: "not-an-account" }, q(""), NOW, api.fetchImpl)).configured, false);
  await assert.rejects(telemetryView(env, q("window=30d"), NOW, api.fetchImpl), /invalid_window/);
  await assert.rejects(telemetryView(env, q("group=trades"), NOW, api.fetchImpl), /invalid_group/);
  assert.deepEqual(hourBuckets(NOW, 3), ["2026-11-22T02:00:00.000Z", "2026-11-22T03:00:00.000Z", "2026-11-22T04:00:00.000Z"]);
});

test("TV2. by agent: counts weighted by the sample interval, null where no point, rates null over nothing, deploy markers", async () => {
  clearTelemetryCache();
  const api = sqlApi((sql) => {
    if (sql.includes("GROUP BY h, k")) return [
      { h: "2026-11-22 03:00:00", k: "supervisor", n: "10", d: "2", f: "0" },
      { h: "2026-11-22 04:00:00", k: "supervisor", n: "4", d: "0", f: "1" },
      { h: "2026-11-22 04:00:00", k: "auditor", n: "3", d: "0", f: "0" },
    ];
    if (sql.includes("GROUP BY k")) return [
      { k: "auditor", n: "3", d: "0", f: "0", p50: 5, p95: 9 },
      { k: "supervisor", n: "14", d: "2", f: "1", p50: 12, p95: 40 },
    ];
    if (sql.includes("GROUP BY h")) return [{ h: "2026-11-22 03:00:00", p95: 30 }, { h: "2026-11-22 04:00:00", p95: 45 }];
    if (sql.includes("GROUP BY v")) return [{ v: "785b0e235bac", at: "2026-11-22 02:42:10" }, { v: "unknown", at: "2026-11-22 02:40:00" }];
    if (sql.includes("INTERVAL '90' DAY")) return [{ at: "2026-11-22 02:42:10" }];
    return [{ n: "17", d: "2", f: "1", p50: 11, p95: 38 }];
  });
  const r = await telemetryView(env, q("window=24h&group=agent"), NOW, api.fetchImpl) as any;
  assert.equal(r.configured, true);
  assert.equal(r.first_point_at, "2026-11-22T02:42:10.000Z");
  assert.deepEqual(r.deploys, [{ at: "2026-11-22T02:42:10.000Z", deploy_version: "785b0e235bac", previous: null }], "unknown versions are not markers");
  assert.deepEqual(r.summary, { syscalls: 17, denied: 2, failed: 1, deny_rate: 2 / 17, fail_rate: 1 / 17, latency_ms: { p50: 11, p95: 38 } });
  const last3 = (a: unknown[]) => a.slice(-3);
  assert.deepEqual(last3(r.summary_by_bucket.syscalls), [null, 10, 7], "02:00 has no point: null, not 0");
  assert.deepEqual(last3(r.summary_by_bucket.latency_p95_ms), [null, 30, 45]);
  assert.deepEqual(r.totals.map((t: any) => [t.key, t.syscalls, t.deny_rate]), [["supervisor", 14, 2 / 14], ["auditor", 3, 0]], "sorted by syscalls");
  assert.deepEqual(last3(r.series.find((s: any) => s.key === "auditor").syscalls), [null, null, 3]);
  // Fixed queries on the v2 layout only, the token only to the SQL API of the account, as a bearer token.
  for (const c of api.calls) {
    assert.equal(c.url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`);
    assert.equal(c.auth, `Bearer ${TOKEN}`);
    assert.match(c.body, /^SELECT .* FROM cryptophys_agent_runtime WHERE blob1 = 'ar\.v2' AND timestamp > NOW\(\) - INTERVAL '(24|90)' (HOUR|DAY).* FORMAT JSON$/s);
  }
  assert.ok(!JSON.stringify(r).includes(TOKEN), "the token is never returned");
  // By capability: blob3 instead of index1.
  clearTelemetryCache();
  await telemetryView(env, q("window=7d&group=capability"), NOW, api.fetchImpl);
  assert.ok(api.calls.slice(-6).every((c) => !/index1 AS k/.test(c.body)) && api.calls.slice(-6).some((c) => /blob3 AS k/.test(c.body)));
});

test("TV3. by job: the ten jobs in the kernel's order, runs and failures per bucket, duration quantiles", async () => {
  clearTelemetryCache();
  const api = sqlApi((sql) => {
    if (sql.includes("GROUP BY h, k")) return [{ h: "2026-11-22 04:00:00", k: "auditor_cycle", n: "1", f: "1" }, { h: "2026-11-22 04:00:00", k: "supervisor_cycle", n: "2", f: "0" }];
    if (sql.includes("GROUP BY k, service")) return [
      { k: "auditor_cycle", service: "cryptophys-ai-kernel", n: "1", f: "1", p50: 800, p95: 800 },
      { k: "supervisor_cycle", service: "cryptophys-ai-kernel", n: "2", f: "0", p50: 3000, p95: 4100 },
    ];
    if (sql.includes("GROUP BY v")) return [];
    return [{ at: null }];
  });
  const r = await telemetryView(env, q("window=24h&group=job"), NOW, api.fetchImpl) as any;
  assert.deepEqual(r.jobs.map((j: any) => j.subject), ["supervisor_cycle", "auditor_cycle"], "the kernel's job order");
  assert.deepEqual(r.summary, { runs: 3, failed: 1 });
  assert.deepEqual(r.jobs[1].failed_by_bucket.slice(-1), [1]);
  assert.deepEqual(r.jobs[0].duration_ms, { p50: 3000, p95: 4100 });
  assert.equal(r.first_point_at, null);
  assert.equal(JOB_ORDER.length, 10);
  for (const c of api.calls) assert.match(c.body, /FROM cryptophys_control_plane WHERE blob1 = 'cp\.v2'/);
});

test("TV4. cached for 60 s per window and group; an SQL API failure is an error, never empty data", async () => {
  clearTelemetryCache();
  const api = sqlApi(() => []);
  await telemetryView(env, q("group=job"), NOW, api.fetchImpl);
  const n = api.calls.length;
  await telemetryView(env, q("group=job"), NOW + 30_000, api.fetchImpl);
  assert.equal(api.calls.length, n, "served from the cache");
  await telemetryView(env, q("group=job"), NOW + 61_000, api.fetchImpl);
  assert.ok(api.calls.length > n, "read again after 60 s");
  clearTelemetryCache();
  const down = sqlApi(() => new Response("forbidden", { status: 403 }));
  await assert.rejects(telemetryView(env, q("group=agent"), NOW, down.fetchImpl), /telemetry_http_403/);
});

test("TV5. wired: kernel route, one read-only allow-list row, the Console route", () => {
  const idx = read("workers/ai-kernel/src/index.ts");
  assert.match(idx, /if \(path === "\/v1\/telemetry" && request\.method === "GET"\) \{/);
  assert.match(idx, /TelemetryRequestError\) return errorResponse\(400, err\.message\)/);
  assert.match(idx, /TelemetryReadError\) return errorResponse\(502, err\.message\)/);
  assert.deepEqual(CONSOLE_ALLOW_LIST.filter((a) => a.path === "/v1/telemetry"), [{ service: "kernel", method: "GET", path: "/v1/telemetry" }]);
  assert.deepEqual(UI_ROUTES.find((r) => r.id === "kernel.telemetry"), { id: "kernel.telemetry", service: "kernel", method: "GET", path: "/v1/telemetry", approverOnly: false, confirm: null });
});
