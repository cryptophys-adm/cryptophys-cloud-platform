// ADR-0015 decision 6, phase 3, step 2 (owner 2026-11-22: "Pindahkan folder analytic engine ke platform"). The owner's
// VPS analytics library (6bb8306) is ported into the AI Kernel: a positional schema registry, one writer and a soft
// budget. It writes two kinds of points: one per agent syscall (cryptophys_agent_runtime) and one per cron job of the
// kernel's tick (cryptophys_control_plane). Telemetry only: no decision, proposal, vote, trade or identity in a point,
// nothing reads it back, and a failing write never changes what the caller does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AGENT_RUNTIME, ALL_DATASETS, CONTROL_PLANE, budgetSnapshot, recordCronJob, recordSyscall, startInvocation,
  trackJob, tryConsumePoint, truncateUtf8, writePoint, type AnalyticsEngineBinding,
} from "../../ai-kernel/src/analytics/index.ts";
import { INVOCATION_WINDOW_MS as INVOCATION_WINDOW_MS_FOR_TEST } from "../../ai-kernel/src/analytics/budget.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");

type Point = { blobs?: (string | ArrayBuffer)[] | null; doubles?: number[] | null; indexes?: string[] | null };
const sink = () => { const points: Point[] = []; const binding: AnalyticsEngineBinding = { writeDataPoint: (p) => { points.push(p); } }; return { points, binding }; };

test("AW1. only the platform's two datasets, bound as the kernel declares them, with no field for decisions, votes, trades or identities", () => {
  assert.deepEqual(ALL_DATASETS.map((d) => d.dataset).sort(), ["cryptophys_agent_runtime", "cryptophys_control_plane"]);
  const toml = read("workers/ai-kernel/wrangler.toml");
  assert.match(toml, /binding = "ANALYTICS_CONTROL_PLANE"\ndataset = "cryptophys_control_plane"/);
  assert.match(toml, /binding = "ANALYTICS_AGENT_RUNTIME"\ndataset = "cryptophys_agent_runtime"/);
  const forbidden = /^(?:.*_)?(email|identity|secret|password|token_value|price|entry|stop_loss|take_profit|lot|decision|vote|votes_for|votes_against|proposal|policy_id|amount|balance|symbol)$/;
  for (const d of ALL_DATASETS) {
    for (const name of [d.index.name, ...d.blobs, ...d.doubles]) assert.doesNotMatch(name, forbidden, `${d.dataset}.${name}`);
    assert.equal(d.blobs[0], "schema", `${d.dataset}: blob1 is the schema version`);
  }
  // The VPS copy's xauusd datasets did not come along.
  for (const f of ["datasets.ts", "index.ts", "telemetry.ts"]) assert.doesNotMatch(read(`workers/ai-kernel/src/analytics/${f}`), /xauusd_|stop_loss|SIGNAL_EVENTS/);
});

test("AW2. names become positions, long values are cut on a code point, and a throwing binding never throws to the caller", () => {
  startInvocation();
  const s = sink();
  assert.equal(writePoint(s.binding, AGENT_RUNTIME, { agent_id: "supervisor", schema: "ar.v2", event: "syscall", capability: "consensus.propose", outcome: "succeeded", deploy_version: "abc", tier: 1, latency_ms: 12, tokens: 0 }), true);
  assert.deepEqual(s.points[0], { blobs: ["ar.v2", "syscall", "consensus.propose", "succeeded", "abc"], doubles: [1, 12, 0, 1], indexes: ["supervisor"] });
  assert.equal(truncateUtf8("é".repeat(10), 5), "éé", "two bytes each: never half a character");
  const boom: AnalyticsEngineBinding = { writeDataPoint: () => { throw new Error("quota"); } };
  const drops: string[] = [];
  assert.equal(writePoint(boom, CONTROL_PLANE, { service: "k" }, { onDrop: (_d, why) => drops.push(why) }), false);
  assert.deepEqual(drops, ["error:quota"]);
  assert.equal(writePoint(undefined, CONTROL_PLANE, { service: "k" }), false, "no binding: nothing, no error");
});

test("AW3. the budget resets per invocation, and by itself after a minute in a long-lived Durable Object isolate", () => {
  const t0 = 1_000_000_000_000;
  startInvocation(t0);
  for (let i = 0; i < 3; i++) assert.equal(tryConsumePoint(3, t0 + i), true);
  assert.equal(tryConsumePoint(3, t0 + 10), false, "the 4th point of the invocation is dropped");
  assert.equal(tryConsumePoint(3, t0 + INVOCATION_WINDOW_MS_FOR_TEST + 11), true, "a minute later it counts as a new invocation");
  assert.ok(budgetSnapshot().dropped >= 1);
});

test("AW4. a syscall's point: agent, capability, tier, outcome and latency only; the cron job's point: job, outcome and duration", async () => {
  startInvocation();
  const runtime = sink();
  const control = sink();
  const env = { ANALYTICS_AGENT_RUNTIME: runtime.binding, ANALYTICS_CONTROL_PLANE: control.binding, ANALYTICS_SAMPLE_RATE: "1", CF_VERSION_METADATA: { tag: "8337fa0dbb50" } };
  recordSyscall(env, "auditor", "reports.publish", 1, "denied", 7);
  assert.deepEqual(runtime.points[0].blobs, ["ar.v2", "syscall", "reports.publish", "denied", "8337fa0dbb50"]);
  assert.deepEqual(runtime.points[0].indexes, ["auditor"]);
  let clock = 100;
  const value = await trackJob(env, "supervisor_cycle", Promise.resolve(42), () => (clock += 250));
  assert.equal(value, 42, "the job's own value comes back");
  await assert.rejects(trackJob(env, "auditor_cycle", Promise.reject(new Error("d1 busy")), () => (clock += 10)), /d1 busy/, "and its own rejection");
  assert.deepEqual(control.points.map((p) => [p.indexes?.[0], ...(p.blobs ?? []).slice(1, 4), p.doubles?.[0]]), [
    ["cryptophys-ai-kernel", "cron_job", "supervisor_cycle", "ok", 250],
    ["cryptophys-ai-kernel", "cron_job", "auditor_cycle", "failed", 10],
  ]);
  // No binding (a test env, or a Worker that does not bind the datasets): silently nothing.
  recordCronJob({}, "x", "ok", 1);
  recordSyscall({}, "a", "b", 0, "succeeded", 1);
});

test("AW5. wired: every syscall goes through the timed wrapper, and the kernel's tick times its jobs without changing them", () => {
  const sys = read("workers/ai-kernel/src/syscall.ts");
  assert.match(sys, /export async function syscall\([^)]*\): Promise<SyscallResult> \{\n  const started = Date\.now\(\);\n  const result = await syscallOnce\(env, agentId, capability, input\);\n  recordSyscall\(env, agentId, capability, result\.tier, result\.outcome as SyscallOutcome, Date\.now\(\) - started\);\n  return result;\n\}/);
  assert.doesNotMatch(sys, /recordSyscall\([^)]*\b(input|result\.result|reason)\b/, "the point never carries the input, the result or a reason");
  const idx = read("workers/ai-kernel/src/index.ts");
  const jobs = [...idx.matchAll(/trackJob\(env, "([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(jobs, ["supervisor_cycle", "signal_analyst_cycle", "auditor_cycle", "adr_steward_cycle", "evolution_intake", "evolver_cycle", "autonomy_downgrade", "council_proposals", "owner_notices", "report_relay"]);
  assert.match(idx, /async scheduled\([^)]*\): Promise<void> \{\n(?:    \/\/[^\n]*\n)*    startInvocation\(event\.scheduledTime\);/);
});
