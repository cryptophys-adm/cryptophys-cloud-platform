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
    if (url.includes("/billable-usage")) {
      const handler = handlers["billableUsage"];
      if (handler) {
        const out = handler({});
        if (out instanceof Error) return new Response(JSON.stringify({ result: null, errors: [{ message: out.message }] }), { status: 400 });
        return new Response(JSON.stringify({ result: out, success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: [], success: true }), { status: 200 });
    }
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
      { sum: { requests: 1200, errors: 3 }, dimensions: { datetime: "2026-11-10T12:00:00Z", scriptName: "cryptophys-ai-kernel" } },
      { sum: { requests: 300, errors: 0 }, dimensions: { datetime: "2026-11-10T14:00:00Z", scriptName: "cryptophys-console" } },
      { sum: { requests: 9000, errors: 1 }, dimensions: { datetime: "2026-11-09T08:00:00Z", scriptName: "cryptophys-ai-kernel" } },
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
  assert.ok(calls.every((c) => c.auth === "Bearer tok" && c.vars.a === ACCOUNT));
  const workersCall = calls.find((c) => c.query.includes("workersInvocationsAdaptive"))!;
  assert.equal(workersCall.vars.s, "2026-11-04T00:00:00Z");
  assert.equal(workersCall.vars.e, "2026-11-10T23:59:59Z");
  const d1Call = calls.find((c) => c.query.includes("d1AnalyticsAdaptiveGroups"))!;
  assert.equal(d1Call.vars.s, "2026-11-04");
  assert.equal(d1Call.vars.e, "2026-11-10");
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

test("U4. with the token, billable usage is fetched and parsed into Spend Summary and Product Breakdown", async () => {
  resetUsageCache();
  const db = migratedDb();
  const sampleBillableRows = [
    {
      BillingCurrency: "USD",
      BillingPeriodStart: "2026-10-17T00:00:00Z",
      ChargePeriodStart: "2026-10-17T00:00:00Z",
      ChargePeriodEnd: "2026-11-16T23:59:59Z",
      ServiceName: "Regular Twitch Neurons",
      ServiceFamilyName: "Workers AI",
      ConsumedQuantity: 1410000,
      ConsumedUnit: "Neurons",
      PricingQuantity: 1410000,
      ContractedCost: 1.41,
    },
    {
      BillingCurrency: "USD",
      BillingPeriodStart: "2026-10-17T00:00:00Z",
      ChargePeriodStart: "2026-10-17T00:00:00Z",
      ChargePeriodEnd: "2026-11-16T23:59:59Z",
      ServiceName: "Container Memory, per GiB-hr",
      ServiceFamilyName: "Compute",
      ConsumedQuantity: 117,
      ConsumedUnit: "GiB-hr",
      PricingQuantity: 117,
      ContractedCost: 1.17,
    },
    {
      BillingCurrency: "USD",
      BillingPeriodStart: "2026-10-17T00:00:00Z",
      ChargePeriodStart: "2026-10-17T00:00:00Z",
      ChargePeriodEnd: "2026-11-16T23:59:59Z",
      ServiceName: "Container Disk, per GB-hr",
      ServiceFamilyName: "Compute",
      ConsumedQuantity: 30,
      ConsumedUnit: "GB-hr",
      PricingQuantity: 30,
      ContractedCost: 0.03,
    },
  ];

  const { fetcher } = fakeGraphql({
    workersInvocationsAdaptive: () => [],
    d1AnalyticsAdaptiveGroups: () => [],
    aiInferenceAdaptiveGroups: () => [],
    kvOperationsAdaptiveGroups: () => [],
    billableUsage: () => sampleBillableRows,
  });

  const r: any = await cloudflareUsage({ CF_ANALYTICS_TOKEN: "tok", CF_ACCOUNT_ID: ACCOUNT, DB: db as never }, NOW, fetcher);
  assert.equal(r.configured, true);
  assert.ok(r.spend_summary);
  assert.equal(r.spend_summary.total_cost, 2.61);
  assert.equal(r.spend_summary.projected_cost, 3.24);
  assert.equal(r.spend_summary.average_daily_cost, 0.10);
  assert.equal(r.spend_summary.days_observed, 25);
  assert.equal(r.spend_summary.total_days, 31);
  assert.equal(r.spend_summary.billing_period, "Oct 2026");

  assert.equal(r.billable_products.length, 3);
  const rtn = r.billable_products.find((p: any) => p.product === "Regular Twitch Neurons");
  assert.ok(rtn);
  assert.equal(rtn.usage_cost, 1.41);
  assert.equal(rtn.total_usage, "1,410,000 Neurons");

  const cm = r.billable_products.find((p: any) => p.product === "Container Memory, per GiB-hr");
  assert.ok(cm);
  assert.equal(cm.usage_cost, 1.17);

  const cd = r.billable_products.find((p: any) => p.product === "Container Disk, per GB-hr");
  assert.ok(cd);
  assert.equal(cd.usage_cost, 0.03);

  // The cycle-to-date cost (25 days observed) is stored as a daily burn, never as one day's cost.
  const burnRows = db.raw.prepare("SELECT service_id, ai_neurons, estimated_cost_usd FROM infra_burn_metrics WHERE period_day = '2026-11-10' ORDER BY service_id").all() as any[];
  assert.equal(burnRows.length, 2);
  const kernelBurn = burnRows.find((b: any) => b.service_id === "cryptophys-ai-kernel");
  assert.equal(kernelBurn.estimated_cost_usd, 0.06); // 1.41 / 25
  assert.equal(kernelBurn.ai_neurons, 56400); // 1,410,000 / 25
  assert.equal(burnRows.find((b: any) => b.service_id === "cryptophys-platform-api").estimated_cost_usd, 0.05); // 1.20 / 25
});

test("U5. when billable costs exceed Free Tier, supervisor/orchestrator throttling intents are generated", async () => {
  resetUsageCache();
  const sampleBillableRows = [
    {
      ServiceName: "Regular Twitch Neurons",
      ServiceFamilyName: "Workers AI",
      ConsumedQuantity: 1410000,
      ConsumedUnit: "Neurons",
      ContractedCost: 1.41,
    },
    {
      ServiceName: "Container Memory, per GiB-hr",
      ServiceFamilyName: "Compute",
      ConsumedQuantity: 117,
      ConsumedUnit: "GiB-hr",
      ContractedCost: 1.17,
    },
  ];

  const { fetcher } = fakeGraphql({
    workersInvocationsAdaptive: () => [],
    d1AnalyticsAdaptiveGroups: () => [],
    aiInferenceAdaptiveGroups: () => [],
    kvOperationsAdaptiveGroups: () => [],
    billableUsage: () => sampleBillableRows,
  });

  const r: any = await cloudflareUsage({ CF_ANALYTICS_TOKEN: "tok", CF_ACCOUNT_ID: ACCOUNT }, NOW, fetcher);
  assert.equal(r.free_tier_status, "overage_detected");
  assert.equal(r.orchestrator_cost_intents.length, 2);

  const aiIntent = r.orchestrator_cost_intents.find((i: any) => i.action === "throttle_ai_neurons");
  assert.ok(aiIntent);
  assert.equal(aiIntent.target_service, "cryptophys-ai-kernel");
  assert.match(aiIntent.directive, /FREE_TIER_RESTRICTION/);

  const containerIntent = r.orchestrator_cost_intents.find((i: any) => i.action === "reduce_container_runtime");
  assert.ok(containerIntent);
  assert.equal(containerIntent.target_service, "compute-containers");
});

test("U6. billable usage API error reports an error cleanly without breaking GraphQL metrics", async () => {
  resetUsageCache();
  const { fetcher } = fakeGraphql({
    workersInvocationsAdaptive: () => [{ sum: { requests: 50, errors: 0 }, dimensions: { date: "2026-11-10", scriptName: "test" } }],
    d1AnalyticsAdaptiveGroups: () => [],
    aiInferenceAdaptiveGroups: () => [],
    kvOperationsAdaptiveGroups: () => [],
    billableUsage: () => new Error("billable_forbidden_403"),
  });

  const r: any = await cloudflareUsage({ CF_ANALYTICS_TOKEN: "tok", CF_ACCOUNT_ID: ACCOUNT }, NOW, fetcher);
  assert.equal(r.configured, true);
  assert.match(r.billable_error, /billable_forbidden_403/);
  assert.equal(r.spend_summary, null);
  assert.equal(r.billable_products.length, 0);
  assert.equal(r.metrics.find((m: any) => m.key === "workers_requests").today, 50);
});

test("U7. when the billable API returns nothing, no product, cost or intent is rebuilt from stored rows", async () => {
  resetUsageCache();
  const db = migratedDb();
  db.raw.prepare(
    "INSERT INTO infra_burn_metrics (metric_id, period_day, service_id, ai_neurons, estimated_cost_usd, calculated_at) VALUES ('brn_ai_kernel_20261110', '2026-11-10', 'cryptophys-ai-kernel', 10000, 1.41, '2026-11-10T12:00:00Z')"
  ).run();

  const { fetcher } = fakeGraphql({
    workersInvocationsAdaptive: () => [],
    d1AnalyticsAdaptiveGroups: () => [],
    aiInferenceAdaptiveGroups: () => [],
    kvOperationsAdaptiveGroups: () => [],
    billableUsage: () => [],
  });

  const r: any = await cloudflareUsage({ CF_ANALYTICS_TOKEN: "tok", CF_ACCOUNT_ID: ACCOUNT, DB: db as never }, NOW, fetcher);
  assert.equal(r.configured, true);
  assert.equal(r.spend_summary, null);
  assert.equal(r.billable_products.length, 0);
  assert.equal(r.orchestrator_cost_intents.length, 0);
  assert.equal(r.free_tier_status, "unknown");
});
