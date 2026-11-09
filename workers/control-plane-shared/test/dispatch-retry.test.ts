// 2026-11-09 10:38 UTC: GitHub answered a consensus deploy dispatch with HTTP 500, and the dispatch
// lock for that commit stayed claimed, so no later proposal could deploy it. A 5xx/429 dispatch is
// now retried once (unless a run appeared meanwhile), and a failed dispatch releases its lock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DeploymentLock, dispatchWorkflow } from "../../deployment-orchestrator/src/index.ts";

const realFetch = globalThis.fetch;
function fakeGithub(statuses: number[], runs: Array<{ created_at: string }> = []) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/dispatches") && init?.method === "POST") { calls.push("dispatch"); return new Response(null, { status: statuses.shift() ?? 204 }); }
    if (url.includes("/runs?event=workflow_dispatch")) { calls.push("runs"); return Response.json({ workflow_runs: runs }); }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return calls;
}
const noSleep = async () => {};

test("DR1. a 5xx or 429 is retried once; a run that appeared meanwhile counts as dispatched; 4xx is not retried", async () => {
  try {
    let calls = fakeGithub([500, 204]);
    assert.deepEqual(await dispatchWorkflow("t", "deploy-forge.yml", { a: "b" }, noSleep), { status: 204, attempts: 2 });
    assert.deepEqual(calls, ["dispatch", "runs", "dispatch"]);
    calls = fakeGithub([502], [{ created_at: new Date().toISOString() }]);
    assert.deepEqual(await dispatchWorkflow("t", "deploy-forge.yml", {}, noSleep), { status: 204, attempts: 1 }, "the 502 did start a run: no second dispatch");
    assert.deepEqual(calls, ["dispatch", "runs"]);
    calls = fakeGithub([500, 503]);
    assert.deepEqual(await dispatchWorkflow("t", "deploy-forge.yml", {}, noSleep), { status: 503, attempts: 2 });
    calls = fakeGithub([429, 204], [{ created_at: "2026-01-01T00:00:00Z" }]);
    assert.deepEqual(await dispatchWorkflow("t", "deploy-forge.yml", {}, noSleep), { status: 204, attempts: 2 }, "an old run does not count");
    calls = fakeGithub([422]);
    assert.deepEqual(await dispatchWorkflow("t", "deploy-forge.yml", {}, noSleep), { status: 422, attempts: 1 });
    assert.deepEqual(calls, ["dispatch"]);
  } finally { globalThis.fetch = realFetch; }
});

test("DR2. the dispatch lock can be released, so a commit whose dispatch failed can be dispatched again", async () => {
  const data = new Map<string, unknown>();
  const lock = new DeploymentLock({ storage: { get: async (k: string) => data.get(k) as never, put: async (k: string, v: unknown) => { data.set(k, v); }, delete: async (k: string) => data.delete(k) }, blockConcurrencyWhile: (cb) => cb() });
  const post = async (path: string) => (await lock.fetch(new Request("https://lock.internal" + path, { method: "POST", body: JSON.stringify({ sha: "a".repeat(40) }) }))).json() as Promise<any>;
  assert.equal((await post("/claim")).claimed, true);
  assert.equal((await post("/claim")).claimed, false, "claimed once");
  assert.deepEqual(await post("/release"), { released: true });
  assert.equal((await post("/claim")).claimed, true, "claimable again after a failed dispatch released it");
  assert.deepEqual(await post("/release"), { released: true });
  assert.deepEqual(await post("/release"), { released: false });
});

test("DR3. wiring: every autonomous dispatch (consensus deploy, recovery deploy, rollback, retire) retries and releases its lock on failure", () => {
  const src = readFileSync(new URL("../../deployment-orchestrator/src/index.ts", import.meta.url), "utf8");
  assert.equal((src.match(/await dispatchWorkflow\(env\.GH_ACTIONS_TOKEN/g) ?? []).length, 4);
  assert.equal((src.match(/if \(dispatch\.status !== 204\) \{ await releaseLock\(env, /g) ?? []).length, 4);
});
