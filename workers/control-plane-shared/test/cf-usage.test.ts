// Owner 2026-11-10: a real Cloudflare usage panel. Values come only from the GraphQL Analytics API
// (read-only token) or from the platform's own counters; nothing is estimated or simulated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { migratedDb } from "./harness.ts";
import { FREE_LIMITS, cloudflareUsage, resetUsageCache } from "../src/cf-usage.ts";

const NOW = Date.UTC(2026, 10, 10, 15, 0, 0);
const ACCOUNT = "a".repeat(32);

function fakeGraphql(handlers: Record<string, (vars: any) => unknown>) {
  const calls: Array<{ auth: string | null; query: string; vars: any }> = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    assert.equal(url, "https://api.cloudflare.com/client/v4/graphql");
    const body = JSON.parse(String(init?.body));
    calls.push({ auth: new Headers(init?.headers).get("authorization"), query: body.query, vars: body.variables });
    const name = Object.keys(handlers).find((k) => body.query.includes(k))!;
    const out = handlers[name](body.variables);
    if (out instanceof Error) return new Response(JSON.stringify({ data: null, errors: [{ message: out.message }] }), { status: 200 });
    return new Response(JSON.stringify({ data: { viewer: { accounts: [{ g: out }] } } }), { status: 200 });
  };
  return { fetcher, calls };
}

test("U1. without the owner's token nothing is invented: only the platform's own counters and setup steps", async () => {
  resetUsageCache();
  const db = migratedDb();
  db.raw.prepare("INSERT INTO ai_usage (service_id, day, requests) VALUES ('cryptophys-platform-api', '2026-11-10', 7)").run();
  let fetched = false;
  const r: any = await cloudflareUsage({ DB: db as never }, NOW, async () => { fetched = true; return new Response("{}"); });
  assert.equal(r.configured, false);
  assert.equal(fetched, false, "no call without a token");
  assert.equal(r.metrics, undefined, "no metric numbers without Cloudflare data");
  assert.equal(r.platform.ai_requests_today, 7);
  assert.match(r.setup, /Account Analytics > Read/);
  const bad: any = await cloudflareUsage({ CF_ANALYTICS_TOKEN: "t", CF_ACCOUNT_ID: "not-an-account" }, NOW);
  assert.equal(bad.configured, false);
});

test("U2. with the token, every metric is read from GraphQL for today (UTC) against the free limits, with 7-day history", async () => {
  resetUsageCache();
  const { fetcher, calls } = fakeGraphql({
    workersInvocationsAdaptive: () => [
      { sum: { requests: 1200, errors: 3 }, dimensions: { date: "2026-11-10", scriptName: "cryptophys-ai-kernel" } },
      { sum: { requests: 300, errors: 0 }, dimensions: { date: "2026-11-10", scriptName: "cryptophys-console" } },
      { sum: { requests: 9000, errors: 1 }, dimensions: { date: "2026-11-09", scriptName: "cryptophys-ai-kernel" } },
    ],
    d1AnalyticsAdaptiveGroups: () => [{ sum: { rowsRead: 250_000, rowsWritten: 5_000 }, dimensions: { date: "2026-11-10" } }],
    aiInferenceAdaptiveGroups: () => [{ sum: { totalNeurons: 2500 }, dimensions: { date: "2026-11-10" } }],
    kvOperationsAdaptiveGroups: () => [
      { sum: { requests: 40 }, dimensions: { date: "2026-11-10", actionType: "read" } },
      { sum: { requests: 5 }, dimensions: { date: "2026-11-10", actionType: "write" } },
    ],
  });
  const r: any = await cloudflareUsage({ CF_ANALYTICS_TOKEN: "tok", CF_ACCOUNT_ID: ACCOUNT }, NOW, fetcher);
  assert.equal(r.configured, true);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.auth === "Bearer tok" && c.vars.a === ACCOUNT && c.vars.e === "2026-11-10" && c.vars.s === "2026-11-04"));
  const m = Object.fromEntries(r.metrics.map((x: any) => [x.key, x]));
  assert.deepEqual([m.workers_requests.today, m.workers_requests.limit, m.workers_requests.pct], [1500, FREE_LIMITS.workers_requests.limit, 1.5]);
  assert.equal(m.workers_requests.history.find((h: any) => h.date === "2026-11-09").value, 9000);
  assert.deepEqual([m.d1_rows_read.today, m.d1_rows_written.today], [250_000, 5_000]);
  assert.deepEqual([m.ai_neurons.today, m.ai_neurons.pct], [2500, 25]);
  assert.deepEqual([m.kv_reads.today, m.kv_writes.today], [40, 5]);
  assert.deepEqual(r.workers_today.map((s: any) => [s.script, s.requests]), [["cryptophys-ai-kernel", 1200], ["cryptophys-console", 300]]);
  assert.equal(r.workers_errors_today, 3);
});

test("U3. a dataset that fails shows its error, never a number; the others still read; results are cached 5 min", async () => {
  resetUsageCache();
  const { fetcher, calls } = fakeGraphql({
    workersInvocationsAdaptive: () => [{ sum: { requests: 10, errors: 0 }, dimensions: { date: "2026-11-10", scriptName: "x" } }],
    d1AnalyticsAdaptiveGroups: () => [],
    aiInferenceAdaptiveGroups: () => new Error("unknown field totalNeurons"),
    kvOperationsAdaptiveGroups: () => [],
  });
  const env = { CF_ANALYTICS_TOKEN: "tok", CF_ACCOUNT_ID: ACCOUNT };
  const r: any = await cloudflareUsage(env, NOW, fetcher);
  const ai = r.metrics.find((x: any) => x.key === "ai_neurons");
  assert.deepEqual([ai.today, ai.pct], [null, null]);
  assert.match(ai.error, /totalNeurons/);
  assert.equal(r.metrics.find((x: any) => x.key === "workers_requests").today, 10);
  const again: any = await cloudflareUsage(env, NOW + 60_000, fetcher);
  assert.equal(again.cached, true);
  assert.equal(calls.length, 4, "served from cache");
});
