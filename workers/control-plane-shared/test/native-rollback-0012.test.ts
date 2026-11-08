// ADR-0012 phase 2 (owner, 2026-11-08: "kita harus sepenuhnya lepas dari Github"): the
// Orchestrator rolls a Worker back through the Workers Deployments API. GitHub is not involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { baseEnv, migratedDb } from "./harness.ts";
import { appendAuditEvent } from "../src/audit.ts";
import worker, { DeploymentLock, NATIVE_ROLLBACK_EXECUTION_LEASE_MS, rollbackForRecovery, runNativeRollbacks } from "../../deployment-orchestrator/src/index.ts";
import { CloudflareWorkers, executeRollback, nativeRollbackConfigured, SAFE_MINUTES } from "../../deployment-orchestrator/src/native-rollback.ts";
import { recordRollback } from "../../platform-registry/src/index.ts";
import { probeService } from "../../drift-detector/src/index.ts";

const ROOT = new URL("../../../", import.meta.url);
const ACCOUNT = "a".repeat(32);
const SVC = "cryptophys-console";
const V_NOW = "11111111-1111-4111-8111-111111111111";
const V_OLD = "22222222-2222-4222-8222-222222222222";
const PLAN = "plan_11111111-1111-1111-1111-111111111111";
const DEC = "dec_22222222-2222-2222-2222-222222222222";
const nextSafeMinute = (after: number): number => {
  const first = Math.ceil(after / 60_000) * 60_000;
  for (let i = 0; i < 60; i++) {
    const candidate = first + i * 60_000;
    if (SAFE_MINUTES.includes(new Date(candidate).getUTCMinutes())) return candidate;
  }
  throw new Error("no safe minute found");
};
const SAFE_AT = Date.parse("2026-11-08T03:10:00Z");

function lockNs() {
  const stores = new Map<string, Map<string, unknown>>();
  return { idFromName: (n: string) => n, get: (id: unknown) => {
    const key = String(id); if (!stores.has(key)) stores.set(key, new Map()); const data = stores.get(key)!;
    const lock = new DeploymentLock({ storage: { get: async (k: string) => data.get(k) as never, put: async (k: string, v: unknown) => { data.set(k, v); } }, blockConcurrencyWhile: (cb) => cb() });
    return { fetch: (i: RequestInfo | URL, init?: RequestInit) => lock.fetch(new Request(i, init)) };
  } };
}

async function setup() {
  const db = migratedDb();
  let prev: string | null = null;
  for (const v of ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]) {
    await appendAuditEvent(db as never, { event_type: "registry.desired_version_set", actor: "ci.access", subject: SVC, outcome: "success", payload: { previous: prev, desired_version: v } });
    prev = v;
  }
  db.raw.prepare("UPDATE service_registry SET desired_version = 'bbbbbbbbbbbb' WHERE service_id = ?").run(SVC);
  const now = new Date().toISOString();
  db.raw.prepare(`INSERT INTO recovery_plans (plan_id, service_id, plan_version, status, steps_json, approved_by, last_execution_json, created_by, created_at, updated_at)
    VALUES (?, ?, 'bbbbbbbbbbbb', 'executing', '{}', 'owner@example.com', ?, 'agent:supervisor', ?, ?)`).run(PLAN, SVC, JSON.stringify({ policy_decision_id: DEC }), now, now);
  db.raw.prepare(`INSERT INTO policy_decisions (decision_id, subject, action, resource, decision, reason, evidence_json, created_at) VALUES (?, 'ai:recovery-manager', 'recovery.execute', ?, 'allow', 'ok', '{}', ?)`).run(DEC, PLAN, now);
  return db;
}

/** A fake Cloudflare Workers API: one script, the active deployment, versions, and POSTed deployments. */
function fakeCloudflare(opts: { tagged?: boolean; failDeploy?: boolean } = {}) {
  let active = [{ version_id: V_NOW, percentage: 100 }];
  const posted: any[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    assert.ok(url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${SVC}/`), url);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer deploy-token");
    if (url.endsWith("/deployments") && (init?.method ?? "GET") === "GET") {
      return Response.json({ success: true, result: { deployments: [{ created_on: "2026-11-08T00:00:00Z", versions: active }] } });
    }
    if (url.endsWith("/deployments") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      if (opts.failDeploy && posted.length === 1) return Response.json({ success: false, errors: [{ code: 10021 }] }, { status: 400 });
      active = body.versions;
      return Response.json({ success: true, result: { id: "dep" } });
    }
    if (url.includes("/versions?")) {
      return Response.json({ success: true, result: { items: [
        { id: V_NOW, annotations: { "workers/tag": "bbbbbbbbbbbb" }, metadata: { created_on: "2026-11-07T00:00:00Z" } },
        ...(opts.tagged === false ? [] : [{ id: V_OLD, annotations: { "workers/tag": "aaaaaaaaaaaa" }, metadata: { created_on: "2026-11-06T00:00:00Z" } }]),
      ] } });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { fetcher, posted, active: () => active };
}

function nativeEnv(db: any, drift: (id: string) => Promise<any>) {
  return baseEnv("cryptophys-deployment-orchestrator", db, {
    GH_ACTIONS_TOKEN: "", DEPLOYMENT_LOCK: lockNs(), CF_DEPLOY_TOKEN: "deploy-token", CF_ACCOUNT_ID: ACCOUNT,
    DRIFT: { probeService: drift },
    REGISTRY: { recordRollback: (id: string) => recordRollback({ DB: db } as never, id) },
  });
}

test("N1. with the deploy credentials, a rollback is queued for the Orchestrator itself; GitHub is never called; a replay is a no-op", async () => {
  const db = await setup();
  const real = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL) => { throw new Error(`GitHub must not be called: ${String(i)}`); }) as typeof fetch;
  try {
    const env = nativeEnv(db, async () => ({ healthy: true, version_tag: "aaaaaaaaaaaa" }));
    assert.equal(nativeRollbackConfigured(env as never), true);
    const r = await rollbackForRecovery(env as never, PLAN, DEC, SVC);
    assert.equal(r.dispatched, true);
    assert.equal(r.executor, "native:rollback");
    assert.equal((await rollbackForRecovery(env as never, PLAN, DEC, SVC)).dispatched, false, "the idempotency lock holds");
    const rows = db.raw.prepare("SELECT status, requested_version, details_json FROM deployment_requests").all() as any[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "approved");
    assert.equal(rows[0].requested_version, "aaaaaaaaaaaa");
    assert.equal(JSON.parse(rows[0].details_json).plan_id, PLAN);
    assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'deployment.rollback_queued'").get() as any).n, 1);
  } finally { globalThis.fetch = real; }
});

test("N2. the executor deploys the tagged version at 100%, verifies it live, records it as desired; only at a SAFE minute", async () => {
  const db = await setup();
  const probes: string[] = [];
  const env = nativeEnv(db, async (id) => { probes.push(id); return { reachable: true, healthy: true, version_tag: probes.length >= 2 ? "aaaaaaaaaaaa" : "bbbbbbbbbbbb", error: null }; });
  await rollbackForRecovery(env as never, PLAN, DEC, SVC);
  const cf = fakeCloudflare();
  assert.deepEqual(await runNativeRollbacks(env as never, Date.parse("2026-11-08T03:07:00Z"), cf.fetcher, { delayMs: 0 }), { executed: 0, succeeded: 0 }, ":07 is a kernel cron minute");
  assert.equal(cf.posted.length, 0);
  assert.deepEqual(await runNativeRollbacks(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 1 });
  assert.deepEqual(cf.posted.map((p) => p.versions), [[{ version_id: V_OLD, percentage: 100 }]]);
  assert.equal(cf.posted[0].strategy, "percentage");
  assert.deepEqual(probes, [SVC, SVC], "verification waits until the old tag is live");
  const row = db.raw.prepare("SELECT status, details_json FROM deployment_requests").get() as any;
  assert.equal(row.status, "succeeded");
  assert.deepEqual(JSON.parse(row.details_json).outcome.steps, ["captured", "deployed", "verified", "desired_recorded"]);
  assert.equal((db.raw.prepare("SELECT desired_version FROM service_registry WHERE service_id = ?").get(SVC) as any).desired_version, "aaaaaaaaaaaa");
  const set = db.raw.prepare("SELECT actor, payload_json FROM audit_events WHERE event_type = 'registry.desired_version_set' ORDER BY rowid DESC LIMIT 1").get() as any;
  assert.match(set.actor, /^rollback:dep_/);
  assert.deepEqual(JSON.parse(set.payload_json), { previous: "bbbbbbbbbbbb", desired_version: "aaaaaaaaaaaa" });
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'deployment.rollback_succeeded'").get() as any).n, 1);
  assert.deepEqual(await runNativeRollbacks(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 0, succeeded: 0 }, "a finished request is not run again");
});

test("N3. if the version never reports live, the captured deployment is restored and the request fails", async () => {
  const db = await setup();
  const env = nativeEnv(db, async () => ({ reachable: true, healthy: true, version_tag: "bbbbbbbbbbbb", error: null }));
  await rollbackForRecovery(env as never, PLAN, DEC, SVC);
  const cf = fakeCloudflare();
  assert.deepEqual(await runNativeRollbacks(env as never, nextSafeMinute(Date.now() + 1_000), cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 0 });
  assert.deepEqual(cf.posted.map((p) => p.versions[0].version_id), [V_OLD, V_NOW], "deployed, then restored");
  assert.deepEqual(cf.active(), [{ version_id: V_NOW, percentage: 100 }]);
  const row = db.raw.prepare("SELECT status, details_json FROM deployment_requests").get() as any;
  assert.equal(row.status, "failed");
  const outcome = JSON.parse(row.details_json).outcome;
  assert.equal(outcome.reason, "not_live_at_tag");
  assert.equal(outcome.restored, true);
  assert.equal((db.raw.prepare("SELECT desired_version FROM service_registry WHERE service_id = ?").get(SVC) as any).desired_version, "bbbbbbbbbbbb", "desired version untouched");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'deployment.rollback_failed'").get() as any).n, 1);
});

test("N4. a missing tagged version or a refused deploy fails without changing production", async () => {
  const drift = { probeService: async () => ({ reachable: true, healthy: true, version_tag: "aaaaaaaaaaaa", error: null }) };
  const registry = { recordRollback: async () => { throw new Error("must not record"); } };
  const missing = fakeCloudflare({ tagged: false });
  const r1 = await executeRollback(new CloudflareWorkers("deploy-token", ACCOUNT, missing.fetcher), { DRIFT: drift, REGISTRY: registry } as never, "dep_x", SVC, "aaaaaaaaaaaa", { delayMs: 0 });
  assert.deepEqual([r1.ok, r1.reason, missing.posted.length], [false, "no_version_with_tag", 0]);
  const refused = fakeCloudflare({ failDeploy: true });
  const r2 = await executeRollback(new CloudflareWorkers("deploy-token", ACCOUNT, refused.fetcher), { DRIFT: drift, REGISTRY: registry } as never, "dep_y", SVC, "aaaaaaaaaaaa", { delayMs: 0 });
  assert.equal(r2.ok, false);
  assert.match(String(r2.reason), /^cloudflare_api_400_10021$/);
  assert.deepEqual(refused.active(), [{ version_id: V_NOW, percentage: 100 }], "production unchanged");
});

test("N5. without the deploy credentials the GitHub workflow stays the path; queued native requests go stale after 3 hours", async () => {
  const db = await setup();
  const env = baseEnv("cryptophys-deployment-orchestrator", db, { GH_ACTIONS_TOKEN: "t", DEPLOYMENT_LOCK: lockNs() });
  assert.equal(nativeRollbackConfigured(env as never), false);
  assert.equal(nativeRollbackConfigured({ CF_DEPLOY_TOKEN: "t", CF_ACCOUNT_ID: "not-an-id", DRIFT: {}, REGISTRY: {} } as never), false);
  const old = new Date(SAFE_AT - 4 * 3_600_000).toISOString();
  db.raw.prepare(`INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
    VALUES ('dep_stale', ?, 'aaaaaaaaaaaa', 'x', 'approved', NULL, 'k', ?, ?, ?)`).run(SVC, JSON.stringify({ executor: "native:rollback" }), old, old);
  assert.deepEqual(await runNativeRollbacks(env as never, SAFE_AT), { executed: 0, succeeded: 0 });
  assert.equal((db.raw.prepare("SELECT status FROM deployment_requests WHERE request_id = 'dep_stale'").get() as any).status, "failed");
});

test("N9. a queued rollback expires after three hours even when credentials are configured", async () => {
  const db = await setup();
  const env = nativeEnv(db, async () => ({ reachable: true, healthy: true, version_tag: "aaaaaaaaaaaa", error: null }));
  await rollbackForRecovery(env as never, PLAN, DEC, SVC);
  const cf = fakeCloudflare();
  const expiredAt = nextSafeMinute(Date.now() + 4 * 3_600_000);
  assert.deepEqual(await runNativeRollbacks(env as never, expiredAt, cf.fetcher, { delayMs: 0 }), { executed: 0, succeeded: 0 });
  assert.equal(cf.posted.length, 0, "an expired request never reaches the Workers Deployments API");
  const row = db.raw.prepare("SELECT status, details_json FROM deployment_requests").get() as any;
  assert.equal(row.status, "failed");
  assert.equal(JSON.parse(row.details_json).outcome.reason, "stale: native rollback request expired");
});

test("N10. the executor refuses a forged non-platform target before calling Cloudflare", async () => {
  const db = await setup();
  const env = nativeEnv(db, async () => ({ reachable: true, healthy: true, version_tag: "aaaaaaaaaaaa", error: null }));
  await rollbackForRecovery(env as never, PLAN, DEC, SVC);
  db.raw.prepare("UPDATE deployment_requests SET service_id = 'xauusd-ai-trading-assistant'").run();
  const cf = fakeCloudflare();
  const at = nextSafeMinute(Date.now() + 1_000);
  assert.deepEqual(await runNativeRollbacks(env as never, at, cf.fetcher, { delayMs: 0 }), { executed: 0, succeeded: 0 });
  assert.equal(cf.posted.length, 0);
  const row = db.raw.prepare("SELECT status, details_json FROM deployment_requests").get() as any;
  assert.equal(row.status, "failed");
  assert.equal(JSON.parse(row.details_json).outcome.reason, "invalid_native_rollback_request");
});

test("N11. a D1-tampered rollback row fails its Orchestrator-only signature", async () => {
  const db = await setup();
  const env = nativeEnv(db, async () => ({ reachable: true, healthy: true, version_tag: "aaaaaaaaaaaa", error: null }));
  await rollbackForRecovery(env as never, PLAN, DEC, SVC);
  const row = db.raw.prepare("SELECT request_id, details_json FROM deployment_requests").get() as any;
  const details = JSON.parse(row.details_json);
  details.signature = "0".repeat(64);
  db.raw.prepare("UPDATE deployment_requests SET details_json = ? WHERE request_id = ?").run(JSON.stringify(details), row.request_id);
  const cf = fakeCloudflare();
  const at = nextSafeMinute(Date.now() + 1_000);
  assert.deepEqual(await runNativeRollbacks(env as never, at, cf.fetcher, { delayMs: 0 }), { executed: 0, succeeded: 0 });
  assert.equal(cf.posted.length, 0);
  const updated = db.raw.prepare("SELECT status, details_json FROM deployment_requests").get() as any;
  assert.equal(updated.status, "failed");
  assert.equal(JSON.parse(updated.details_json).outcome.reason, "invalid_native_rollback_signature");
});
test("N12. restoring a completed signed D1 row to approved cannot replay its rollback", async () => {
  const db = await setup();
  const env = nativeEnv(db, async () => ({ reachable: true, healthy: true, version_tag: "aaaaaaaaaaaa", error: null }));
  await rollbackForRecovery(env as never, PLAN, DEC, SVC);
  const original = db.raw.prepare("SELECT request_id, details_json FROM deployment_requests").get() as any;
  const cf = fakeCloudflare();
  const firstAt = nextSafeMinute(Date.now() + 1_000);
  assert.deepEqual(await runNativeRollbacks(env as never, firstAt, cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 1 });
  assert.equal(cf.posted.length, 1);

  // Simulate a different D1-bound Worker restoring the exact old signed payload and queue state.
  db.raw.prepare("UPDATE deployment_requests SET status = 'approved', details_json = ?, updated_at = ? WHERE request_id = ?")
    .run(original.details_json, new Date(firstAt + 1_000).toISOString(), original.request_id);
  const secondAt = nextSafeMinute(firstAt + 60_000);
  assert.deepEqual(await runNativeRollbacks(env as never, secondAt, cf.fetcher, { delayMs: 0 }), { executed: 0, succeeded: 0 });
  assert.equal(cf.posted.length, 1, "the request-scoped Durable Object claim prevents a second Workers Deployments API call");
});

test("N13. a D1 transition failure does not consume the one-time claim; the next pass safely retries", async () => {
  const db = await setup();
  let failTransition = true;
  const wrappedDb = new Proxy(db as any, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (sql.startsWith("UPDATE deployment_requests SET status = 'running'")) {
          return {
            bind: (...values: unknown[]) => {
              const bound = statement.bind(...values);
              return {
                run: async () => {
                  if (failTransition) {
                    failTransition = false;
                    throw new Error("injected_d1_transition_failure");
                  }
                  return bound.run();
                },
              };
            },
          };
        }
        return statement;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const env = nativeEnv(wrappedDb, async () => ({ reachable: true, healthy: true, version_tag: "aaaaaaaaaaaa", error: null }));
  await rollbackForRecovery(env as never, PLAN, DEC, SVC);
  const cf = fakeCloudflare();
  const firstAt = nextSafeMinute(Date.now() + 1_000);
  await assert.rejects(runNativeRollbacks(env as never, firstAt, cf.fetcher, { delayMs: 0 }), /injected_d1_transition_failure/);
  assert.equal(cf.posted.length, 0);
  assert.equal((db.raw.prepare("SELECT status FROM deployment_requests").get() as any).status, "approved");

  const retryAt = nextSafeMinute(firstAt + 60_000);
  assert.deepEqual(await runNativeRollbacks(env as never, retryAt, cf.fetcher, { delayMs: 0 }), { executed: 1, succeeded: 1 });
  assert.equal(cf.posted.length, 1, "the failed D1 transition left the DO execution claim available for the retry");
});

test("N14. a one-time claim abandoned before deployment is terminally audited after its lease", async () => {
  const db = await setup();
  const env = nativeEnv(db, async () => ({ reachable: true, healthy: true, version_tag: "aaaaaaaaaaaa", error: null }));
  await rollbackForRecovery(env as never, PLAN, DEC, SVC);
  const row = db.raw.prepare("SELECT request_id, idempotency_key FROM deployment_requests").get() as any;
  const claimedAt = Date.now();
  db.raw.prepare("UPDATE deployment_requests SET status = 'running', updated_at = ? WHERE request_id = ?")
    .run(new Date(claimedAt).toISOString(), row.request_id);

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("cryptophys.native-rollback.execution.v1|" + row.request_id),
  );
  const sha = Array.from(new Uint8Array(digest).slice(0, 20), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const deploymentLock = (env as any).DEPLOYMENT_LOCK;
  const lock = deploymentLock.get(deploymentLock.idFromName(row.idempotency_key));
  const claimResponse = await lock.fetch("https://lock.internal/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sha }),
  });
  assert.equal(claimResponse.status, 201);

  const expiredAt = nextSafeMinute(claimedAt + NATIVE_ROLLBACK_EXECUTION_LEASE_MS + 60_000);
  const cf = fakeCloudflare();
  assert.deepEqual(await runNativeRollbacks(env as never, expiredAt, cf.fetcher, { delayMs: 0 }), { executed: 0, succeeded: 0 });
  assert.equal(cf.posted.length, 0, "an abandoned claim is never replayed");
  const updated = db.raw.prepare("SELECT status, details_json FROM deployment_requests").get() as any;
  assert.equal(updated.status, "failed");
  assert.equal(JSON.parse(updated.details_json).outcome.reason, "native_rollback_execution_claim_expired");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'deployment.rollback_failed'").get() as any).n, 1);
});

test("N6. the Registry records a rollback version only for a running native rollback request of the last hour", async () => {
  const db = migratedDb();
  const insert = (id: string, status: string, details: object, created = new Date().toISOString()) => db.raw.prepare(
    `INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
     VALUES (?, ?, 'aaaaaaaaaaaa', 'x', ?, NULL, ?, ?, ?, ?)`).run(id, SVC, status, id, JSON.stringify(details), created, created);
  const id = (n: number) => `dep_${String(n).repeat(8)}-1111-4111-8111-111111111111`;
  insert(id(1), "running", { workflow: "rollback-worker.yml" });
  insert(id(2), "approved", { executor: "native:rollback" });
  insert(id(3), "running", { executor: "native:rollback" }, new Date(Date.now() - 2 * 3_600_000).toISOString());
  insert(id(4), "running", { executor: "native:rollback" });
  await assert.rejects(recordRollback({ DB: db } as never, "dep_bad"), /invalid_request_id/);
  await assert.rejects(recordRollback({ DB: db } as never, id(9)), /rollback_request_not_found/);
  await assert.rejects(recordRollback({ DB: db } as never, id(1)), /not_a_native_rollback/);
  await assert.rejects(recordRollback({ DB: db } as never, id(2)), /rollback_not_running/);
  await assert.rejects(recordRollback({ DB: db } as never, id(3)), /rollback_request_expired/);
  assert.deepEqual(await recordRollback({ DB: db } as never, id(4)), { desired_version: "aaaaaaaaaaaa" });
});

test("N7. the Drift Detector probe is read-only and limited to platform Workers", async () => {
  const env: any = { SVC_CONSOLE: { health: async () => ({ status: "ok", version: { tag: "aaaaaaaaaaaa" } }) } };
  assert.deepEqual(await probeService(env, SVC), { reachable: true, healthy: true, version_tag: "aaaaaaaaaaaa", error: null });
  await assert.rejects(probeService(env, "xauusd-ai-trading-assistant"), /unknown_service/);
});

test("N8. wiring: cron minutes inside SAFE, ledger reconcile at :10/:40 only, bindings, account id, RPC entrypoints", async () => {
  const safe = /SAFE=" ([0-9 ]+) "/.exec(readFileSync(new URL(".github/scripts/wait-cron-window.sh", ROOT), "utf8"))![1].split(" ").map(Number);
  assert.ok(SAFE_MINUTES.every((m) => safe.includes(m)), "every executor minute is a SAFE deploy minute");
  const toml = readFileSync(new URL("workers/deployment-orchestrator/wrangler.toml", ROOT), "utf8");
  assert.match(toml, new RegExp(`crons = \\["${SAFE_MINUTES.join(",")} \\* \\* \\* \\*"\\]`));
  assert.match(toml, /binding = "DRIFT"\nservice = "cryptophys-drift-detector"\nentrypoint = "DriftRpc"/);
  assert.match(toml, /binding = "REGISTRY"\nservice = "cryptophys-platform-registry"\nentrypoint = "RegistryRpc"/);
  assert.doesNotMatch(toml, /CF_DEPLOY_TOKEN\s*=/, "the deploy token is a Worker secret set by the owner, never config");
  assert.match(readFileSync(new URL(".github/workflows/deploy-deployment-orchestrator.yml", ROOT), "utf8"), /--var "CF_ACCOUNT_ID:\$\{CLOUDFLARE_ACCOUNT_ID\}"/);
  assert.match(readFileSync(new URL("workers/drift-detector/src/worker.ts", ROOT), "utf8"), /async probeService\(serviceId: string\)/);
  assert.match(readFileSync(new URL("workers/platform-registry/src/worker.ts", ROOT), "utf8"), /async recordRollback\(requestId: string\)/);
  const reconciled: number[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async () => { reconciled.push(1); return Response.json({ workflow_runs: [] }); }) as typeof fetch;
  try {
    const db = migratedDb();
    const t = new Date(SAFE_AT).toISOString();
    db.raw.prepare(`INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
      VALUES ('dep_gh', ?, 'aaaaaaaaaaaa', 'x', 'running', NULL, 'k', ?, '2026-11-08T00:00:00Z', ?)`).run(SVC, JSON.stringify({ workflow: "rollback-worker.yml" }), t);
    const env = baseEnv("cryptophys-deployment-orchestrator", db, { GH_ACTIONS_TOKEN: "t" });
    for (const [minute, expect] of [[17, 0], [40, 1]] as const) {
      const before = reconciled.length;
      const waits: Promise<unknown>[] = [];
      await worker.scheduled({ cron: "", scheduledTime: Date.parse(`2026-11-08T03:${minute}:00Z`) }, env as never, { waitUntil: (p) => { waits.push(p); } });
      await Promise.all(waits);
      assert.equal(reconciled.length - before, expect, `reconcile at :${minute}`);
    }
  } finally { globalThis.fetch = real; }
});
