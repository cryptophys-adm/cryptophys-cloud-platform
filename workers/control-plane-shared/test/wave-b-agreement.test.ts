// Wave B: the shadow agreement report (evidence for promoting the consensus mode) and the owner
// attention workflow wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { migratedDb } from "./harness.ts";
import { appendAuditEvent } from "../src/audit.ts";
import { agreementReport } from "../../ai-kernel/src/consensus.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const H = 3_600_000;
const SHA = "abcdef1234567890abcdef1234567890abcdef12";

function proposal(db: Db, id: string, action: string, target: string, status: string, passed: boolean, hoursAgo: number, params: Record<string, unknown> = {}) {
  const at = new Date(Date.now() - hoursAgo * H).toISOString();
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES (?, 'supervisor', ?, ?, 'routine', ?, '{}', 'shadow', 8, ?, 0, ?, NULL, ?, ?, NULL, ?, ?)`)
    .run(`cns_${id.padEnd(36, "0")}`, action, target, JSON.stringify(params), passed ? 8 : 2, passed ? 1 : 0, passed ? "allow" : "deny", status, at, at);
  return at;
}

function observe(db: Db, svc: string, drifted: boolean, hoursAgo: number) {
  db.raw.prepare(`INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at) VALUES (?, ?, 'd', 'o', ?, '{}', ?)`)
    .run(`obs_${Math.random().toString(16).slice(2)}`, svc, drifted ? 1 : 0, new Date(Date.now() - hoursAgo * H).toISOString());
}

test("B3. agreement: deploy proposals are scored against what the registry recorded within 24 h", async () => {
  const db = migratedDb();
  proposal(db, "a1", "deploy_commit", "cryptophys-console", "shadow_passed", true, 30, { commit_sha: SHA });
  proposal(db, "a2", "deploy_commit", "cryptophys-home", "shadow_passed", true, 30, { commit_sha: SHA });
  proposal(db, "a3", "deploy_commit", "cryptophys-platform-api", "shadow_blocked", false, 30, { commit_sha: SHA });
  proposal(db, "a4", "deploy_commit", "cryptophys-console", "shadow_passed", true, 2, { commit_sha: SHA });
  // People deployed the console (agree) and the platform API (the refused one: false negative); not home.
  for (const svc of ["cryptophys-console", "cryptophys-platform-api"]) {
    await appendAuditEvent(db as never, { event_type: "registry.desired_version_set", actor: "ci.access", subject: svc, outcome: "success", payload: { desired_version: SHA.slice(0, 12) } });
  }
  // Backdate those audit rows into the scoring window (the hash chain is not checked here).
  db.raw.exec("DROP TRIGGER IF EXISTS audit_events_no_update");
  db.raw.prepare("UPDATE audit_events SET created_at = ?").run(new Date(Date.now() - 20 * H).toISOString());
  const r = await agreementReport({ DB: db } as never, 7);
  assert.equal(r.total, 4);
  assert.deepEqual([r.agree, r.false_positive, r.false_negative, r.pending], [1, 1, 1, 1]);
  assert.equal(r.agreement_rate, 0.333);
  const v = Object.fromEntries((r.items as any[]).map((i) => [i.proposal_id.slice(4, 6), i.verdict]));
  assert.deepEqual(v, { a1: "agree", a2: "false_positive", a3: "false_negative", a4: "pending" });
});

test("B3. agreement: redeploy proposals agree when the service is back in sync within 2 h", async () => {
  const db = migratedDb();
  proposal(db, "b1", "redeploy_desired_version", "cryptophys-policy-engine", "shadow_passed", true, 5);
  observe(db, "cryptophys-policy-engine", false, 4);
  proposal(db, "b2", "redeploy_desired_version", "cryptophys-audit-ledger", "shadow_passed", true, 5);
  observe(db, "cryptophys-audit-ledger", true, 4);
  const r = await agreementReport({ DB: db } as never, 7);
  assert.deepEqual([r.agree, r.false_positive], [1, 1]);
  assert.equal((r.by_action as any).redeploy_desired_version.agree, 1);
});

test("B3. agreement: an empty window reports no rate; the window is bounded", async () => {
  const r = await agreementReport({ DB: migratedDb() } as never, 999);
  assert.equal(r.window_days, 30);
  assert.equal(r.agreement_rate, null);
});

test("B2/B3. wiring: kernel route, Console panel and route; owner notices come from the AI Kernel (ADR-0012)", () => {
  assert.match(readFileSync(new URL("workers/ai-kernel/src/index.ts", ROOT), "utf8"), /path === "\/v1\/consensus\/report"/);
  assert.match(readFileSync(new URL("workers/console/ui/src/pages/Consensus.tsx", ROOT), "utf8"), /call\("kernel\.consensus_report"/);
  // ADR-0012 phase 2: the GitHub issue workflows are retired; the kernel's owner notices replace them.
  for (const f of [".github/workflows/owner-attention.yml", ".github/workflows/drift-alert.yml"]) {
    assert.equal(existsSync(new URL(f, ROOT)), false, `${f} is retired`);
  }
  assert.match(readFileSync(new URL("workers/ai-kernel/src/index.ts", ROOT), "utf8"), /reconcileNotices\(\{ \.\.\.env, ALERT_VAULT: alertVaultOf\(env\) \}, event\.scheduledTime\)/);
  assert.doesNotMatch(readFileSync(new URL(".github/workflows/validate-control-plane.yml", ROOT), "utf8"), /owner-attention\.test\.sh|drift-summary\.test\.sh|report-summary\.test\.sh/);
});

// ---------------------------------------------------------------- B1: rollback to the previous recorded version
import { baseEnv as _baseEnv } from "./harness.ts";
import { DeploymentLock, previousVersion, rollbackForConsensus, rollbackForRecovery } from "../../deployment-orchestrator/src/index.ts";

function lockNs() {
  const stores = new Map<string, Map<string, unknown>>();
  return { idFromName: (n: string) => n, get: (id: unknown) => {
    const key = String(id); if (!stores.has(key)) stores.set(key, new Map()); const data = stores.get(key)!;
    const lock = new DeploymentLock({ storage: { get: async (k: string) => data.get(k) as never, put: async (k: string, v: unknown) => { data.set(k, v); } }, blockConcurrencyWhile: (cb) => cb() });
    return { fetch: (i: RequestInfo | URL, init?: RequestInit) => lock.fetch(new Request(i, init)) };
  } };
}

async function history(db: Db, svc: string, versions: string[]) {
  let prev: string | null = null;
  for (const v of versions) {
    await appendAuditEvent(db as never, { event_type: "registry.desired_version_set", actor: "ci.access", subject: svc, outcome: "success", payload: { previous: prev, desired_version: v } });
    prev = v;
  }
  db.raw.prepare("UPDATE service_registry SET desired_version = ? WHERE service_id = ?").run(versions[versions.length - 1], svc);
}

test("B1. the rollback target is the version recorded before the current one", async () => {
  const db = migratedDb();
  await history(db, "cryptophys-console", ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]);
  assert.equal(await previousVersion({ DB: db } as never, "cryptophys-console"), "bbbbbbbbbbbb");
  assert.equal(await previousVersion({ DB: db } as never, "cryptophys-home"), null, "no history, no rollback");
});

test("B1. rollbackForRecovery dispatches the Rollback Worker workflow for an executing plan, once", async () => {
  const db = migratedDb();
  await history(db, "cryptophys-console", ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
  const planId = "plan_11111111-1111-1111-1111-111111111111";
  const decId = "dec_22222222-2222-2222-2222-222222222222";
  db.raw.prepare(`INSERT INTO recovery_plans (plan_id, service_id, plan_version, status, steps_json, approved_by, last_execution_json, created_by, created_at, updated_at)
    VALUES (?, 'cryptophys-console', 'bbbbbbbbbbbb', 'executing', '{}', 'owner@example.com', ?, 'agent:supervisor', ?, ?)`).run(planId, JSON.stringify({ policy_decision_id: decId }), new Date().toISOString(), new Date().toISOString());
  db.raw.prepare(`INSERT INTO policy_decisions (decision_id, subject, action, resource, decision, reason, evidence_json, created_at) VALUES (?, 'ai:recovery-manager', 'recovery.execute', ?, 'allow', 'ok', '{}', ?)`).run(decId, planId, new Date().toISOString());
  const dispatched: any[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "f".repeat(40) } });
    if (/rollback-worker\.yml\/dispatches$/.test(url)) { dispatched.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  try {
    const env = _baseEnv("cryptophys-deployment-orchestrator", db, { GH_ACTIONS_TOKEN: "t", DEPLOYMENT_LOCK: lockNs() });
    const r = await rollbackForRecovery(env as never, planId, decId, "cryptophys-console");
    assert.equal(r.dispatched, true);
    assert.deepEqual(dispatched, [{ ref: "main", inputs: { worker: "cryptophys-console", version_tag: "aaaaaaaaaaaa", confirm_production: "ROLLBACK" } }]);
    assert.equal((await rollbackForRecovery(env as never, planId, decId, "cryptophys-console")).dispatched, false, "a replay is not dispatched twice");
    await assert.rejects(rollbackForRecovery(env as never, planId, "dec_33333333-3333-3333-3333-333333333333", "cryptophys-console"), /plan_not_executing/);
    await assert.rejects(rollbackForConsensus(env as never, "cns_00000000-0000-0000-0000-000000000000", decId, "cryptophys-console", { version: "aaaaaaaaaaaa" }), /consensus_/);
  } finally { globalThis.fetch = real; }
});

test("B1. wiring: Rollback Worker workflow gates, ops-dispatch allow-list, tag accepted by record-desired-version", () => {
  const wf = readFileSync(new URL(".github/workflows/rollback-worker.yml", ROOT), "utf8");
  assert.match(wf, /\[\[ "\$CONFIRM" == "ROLLBACK" \]\]/);
  assert.match(wf, /\[\[ "\$GITHUB_REF" == "refs\/heads\/main" \]\]/);
  const order = ["wait-cron-window.sh", "worker-rollback.sh\" capture", "/deployments\"", "record-desired-version.sh", "worker-rollback.sh\" restore"].map((k) => wf.indexOf(k));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), `step order ${order}`);
  const ops = readFileSync(new URL(".github/workflows/ops-dispatch.yml", ROOT), "utf8");
  assert.match(ops, /rollback-worker\.yml\) ref=main ;;/);
  assert.match(ops, /\(DEPLOY\|PROVISION\|DELETE\|ROLLBACK\)/);
  assert.match(readFileSync(new URL(".github/scripts/record-desired-version.sh", ROOT), "utf8"), /\^\[0-9a-f\]\{12\}\$/);
});
