// Wave A reliability: incremental audit-chain verification, the deployment ledger reconciler,
// and the wiring of the cron-window guard and Access API retries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { baseEnv, migratedDb } from "./harness.ts";
import { appendAuditEvent, verifyAuditChain, verifyAuditChainIncremental } from "../src/audit.ts";
import { REQUIRED_MIGRATION } from "../src/readiness.ts";
import { reconcileDeployments } from "../../deployment-orchestrator/src/index.ts";

type Db = ReturnType<typeof migratedDb>;
const realFetch = globalThis.fetch;
const ROOT = new URL("../../../", import.meta.url);

async function fill(db: Db, n: number, from = 0) {
  for (let i = from; i < from + n; i++) await appendAuditEvent(db as never, { event_type: "test.event", actor: "t", subject: `s${i}`, outcome: "ok", payload: { i } });
}

/** Counts audit_events rows read, by wrapping the fake D1. */
function counting(db: Db) {
  let rows = 0;
  const wrapped = new Proxy(db, {
    get(target, prop) {
      if (prop !== "prepare") return Reflect.get(target, prop);
      return (sql: string) => {
        const stmt = (target as any).prepare(sql);
        if (!/FROM audit_events/.test(sql)) return stmt;
        const wrap = (s: any): any => ({
          bind: (...a: unknown[]) => wrap(s.bind(...a)),
          all: async () => { const r = await s.all(); rows += r.results.length; return r; },
          first: async () => { const r = await s.first(); if (r) rows += 1; return r; },
          run: () => s.run(),
        });
        return wrap(stmt);
      };
    },
  });
  return { db: wrapped, rows: () => rows, reset: () => { rows = 0; } };
}

test("A1. migration 0025 is required; a full verification anchors the checkpoint", async () => {
  assert.equal(REQUIRED_MIGRATION, "0029_knowledge_proposals.sql");
  const db = migratedDb();
  await fill(db, 30);
  const full = await verifyAuditChain(db as never);
  assert.equal(full.valid, true);
  const cp = db.raw.prepare("SELECT events_checked, mode, event_hash FROM audit_checkpoints WHERE id = 1").get() as any;
  assert.deepEqual([cp.events_checked, cp.mode, cp.event_hash], [30, "full", full.head_hash]);
});

test("A1. incremental verification reads only new events and advances the checkpoint", async () => {
  const db = migratedDb();
  await fill(db, 200);
  await verifyAuditChain(db as never);
  await fill(db, 5, 200);
  const c = counting(db);
  const inc = await verifyAuditChainIncremental(c.db as never);
  assert.equal(inc.valid, true);
  assert.equal(inc.events_checked, 205);
  assert.ok(c.rows() <= 7, `read ${c.rows()} rows, expected the anchor plus 5 new events`);
  const full = await verifyAuditChain(db as never);
  assert.equal(inc.head_hash, full.head_hash);
  assert.equal((db.raw.prepare("SELECT events_checked FROM audit_checkpoints").get() as any).events_checked, 205);
});

const untrigger = (db: Db) => db.raw.exec("DROP TRIGGER IF EXISTS audit_events_no_update; DROP TRIGGER IF EXISTS audit_events_no_delete;");

test("A1. tampering is still detected: the checkpointed event, and any newer event", async () => {
  const db = migratedDb();
  await fill(db, 20);
  await verifyAuditChain(db as never);
  const cp = db.raw.prepare("SELECT last_rowid FROM audit_checkpoints").get() as any;
  untrigger(db); // simulate tampering below the database's append-only guard
  db.raw.prepare("UPDATE audit_events SET payload_json = '{\"i\":999}' WHERE rowid = ?").run(cp.last_rowid);
  const a = await verifyAuditChainIncremental(db as never);
  assert.equal(a.valid, false);
  assert.match(String(a.reason), /checkpointed event changed/);

  const db2 = migratedDb();
  await fill(db2, 10);
  await verifyAuditChain(db2 as never);
  await fill(db2, 3, 10);
  untrigger(db2);
  db2.raw.prepare("UPDATE audit_events SET outcome = 'forged' WHERE rowid = (SELECT MAX(rowid) FROM audit_events)").run();
  const b = await verifyAuditChainIncremental(db2 as never);
  assert.equal(b.valid, false);
  // A failed check never moves the checkpoint forward.
  assert.equal((db2.raw.prepare("SELECT events_checked FROM audit_checkpoints").get() as any).events_checked, 10);
});

test("A1. without a checkpoint the incremental check falls back to a full pass; consensus uses the fast path", async () => {
  const db = migratedDb();
  await fill(db, 4);
  const r = await verifyAuditChainIncremental(db as never);
  assert.deepEqual([r.valid, r.events_checked], [true, 4]);
  assert.match(readFileSync(new URL("workers/ai-kernel/src/consensus.ts", ROOT), "utf8"), /verifyAuditChainIncremental\(env\.DB\)/);
});

test("A4. the orchestrator reconciles the deployment ledger from GitHub runs, and fails stale requests", async () => {
  const db = migratedDb();
  const sha = "a".repeat(40);
  const ins = (id: string, workflow: string, created: string, version = sha) => db.raw.prepare(
    `INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
     VALUES (?, 'cryptophys-console', ?, 'consensus:x', 'running', NULL, ?, ?, ?, ?)`).run(id, version, `k-${id}`, JSON.stringify({ workflow }), created, created);
  const old = new Date(Date.now() - 4 * 3_600_000).toISOString();
  const recent = new Date(Date.now() - 10 * 60_000).toISOString();
  ins("dep_ok", "deploy-console.yml", recent);
  ins("dep_bad", "deploy-home.yml", recent);
  ins("dep_stale", "deploy-platform-api.yml", old);
  ins("dep_wait", "deploy-control-plane.yml", recent);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const m = /\/actions\/workflows\/([a-z-]+\.yml)\/runs/.exec(url);
    const runs: Record<string, unknown[]> = {
      "deploy-console.yml": [{ id: 1, head_sha: sha, status: "completed", conclusion: "success", html_url: "u1", created_at: recent }],
      "deploy-home.yml": [{ id: 2, head_sha: sha, status: "completed", conclusion: "failure", html_url: "u2", created_at: recent }],
      "deploy-platform-api.yml": [],
      "deploy-control-plane.yml": [{ id: 4, head_sha: sha, status: "in_progress", conclusion: null, html_url: "u4", created_at: recent }],
    };
    return Response.json({ workflow_runs: m ? runs[m[1]] ?? [] : [] });
  }) as typeof fetch;
  try {
    const out = await reconcileDeployments(baseEnv("cryptophys-deployment-orchestrator", db, { GH_ACTIONS_TOKEN: "t" }) as never);
    assert.deepEqual(out, { checked: 4, closed: 3 });
    const st = Object.fromEntries((db.raw.prepare("SELECT request_id, status FROM deployment_requests").all() as any[]).map((r) => [r.request_id, r.status]));
    assert.deepEqual(st, { dep_ok: "succeeded", dep_bad: "failed", dep_stale: "failed", dep_wait: "running" });
    assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'deployment.reconciled'").get() as any).n, 3);
  } finally { globalThis.fetch = realFetch; }
});

test("A2/A3. Access API calls retry transient errors; every deploy waits for a cron-free window before deploying", () => {
  for (const f of ["resolve-access.sh", "find-service-token.sh"]) {
    assert.match(readFileSync(new URL(`.github/scripts/${f}`, ROOT), "utf8"), /--retry 5 --retry-delay 10/, f);
  }
  for (const wf of ["deploy-control-plane.yml", "deploy-console.yml", "deploy-home.yml", "deploy-platform-api.yml", "deploy-deployment-orchestrator.yml"]) {
    const s = readFileSync(new URL(`.github/workflows/${wf}`, ROOT), "utf8");
    const wait = s.indexOf("wait-cron-window.sh");
    assert.ok(wait > 0 && wait < s.indexOf("npx wrangler deploy"), `${wf}: the cron guard runs before the deploy`);
  }
  // ADR-0012 phase 2: the Orchestrator cron fires at every SAFE minute (native rollbacks); the
  // ledger reconcile still runs twice an hour, at :10 and :40 (asserted in native-rollback-0012).
  assert.match(readFileSync(new URL("workers/deployment-orchestrator/wrangler.toml", ROOT), "utf8"), /crons = \["2,10,17,25,32,40,47,55 \* \* \* \*"\]/);
});
