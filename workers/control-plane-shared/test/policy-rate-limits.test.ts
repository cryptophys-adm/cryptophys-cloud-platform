// Owner fix 2026-11-07: the Policy Engine's deploy rate limits count actions that really ran
// (executing/executed). The first real deploy in mode deploy was denied by platform_daily_limit
// because yesterday's six shadow_passed records, which never deployed anything, were counted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, migratedDb } from "./harness.ts";
import { decide } from "../../policy-engine/src/index.ts";

type Db = ReturnType<typeof migratedDb>;
const H = 3_600_000;

let seq = 0;
function record(db: Db, n: number, status: string, target: (i: number) => string, hoursAgo = 2) {
  for (let i = 0; i < n; i++) {
    const at = new Date(Date.now() - hoursAgo * H - i * 1000).toISOString();
    db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
      VALUES (?, 'supervisor', 'deploy_commit', ?, 'routine', '{}', '{}', 'deploy', 8, 8, 0, 1, NULL, 'allow', ?, NULL, ?, ?)`)
      .run(`cns_${String(++seq).padStart(36, "0")}`, target(i), status, at, at);
  }
}

const ask = (db: Db, target = "cryptophys-policy-engine") => decide(baseEnv("cryptophys-policy-engine", db) as never, {
  subject: "agent:supervisor", action: "consensus.execute", resource: `deploy_commit:${target}`, context: { class: "routine", passed: true },
});
const check = (d: any, name: string) => d.checks.find((c: any) => c.id === name)?.passed;

const setMode = (db: Db, mode: string) => db.raw.prepare("UPDATE consensus_controls SET value = ? WHERE control = 'mode'").run(mode);

test("R1. once the mode executes, shadow records never count against the deploy limits", async () => {
  const db = migratedDb();
  setMode(db, "deploy");
  record(db, 10, "shadow_passed", (i) => `svc-${i}`);
  record(db, 1, "shadow_passed", () => "cryptophys-policy-engine", 0.2);
  const d = await ask(db);
  assert.equal(check(d, "platform_daily_limit"), true, "ten shadow_passed records are not ten deploys");
  assert.equal(check(d, "target_rate_limit"), true, "a shadow record in the last hour is not an executed action");
});

test("R2. real executions still count: the tenth executed deploy closes the day (owner 2026-11-10), one per target per hour", async () => {
  const db = migratedDb();
  setMode(db, "deploy");
  record(db, 9, "executed", (i) => `svc-${i}`);
  assert.equal(check(await ask(db), "platform_daily_limit"), true, "nine executed deploys leave room for one more");
  record(db, 1, "executing", () => "svc-x", 3);
  const full = await ask(db);
  assert.equal(check(full, "platform_daily_limit"), false);
  assert.equal(full.decision, "deny");
  const db2 = migratedDb();
  setMode(db2, "deploy");
  record(db2, 1, "executed", () => "cryptophys-policy-engine", 0.5);
  assert.equal(check(await ask(db2), "target_rate_limit"), false);
});

test("R3. in shadow mode the shadow records still simulate the limits faithfully", async () => {
  const db = migratedDb();
  setMode(db, "shadow");
  record(db, 10, "shadow_passed", (i) => `svc-${i}`);
  const d = await ask(db);
  assert.equal(check(d, "platform_daily_limit"), false);
  assert.equal(d.decision, "deny");
});

// Owner 2026-11-10: the council may change Policy Engine parameters by consensus alone, inside hard bounds in code.
test("R4. the council changes a policy parameter by consensus; values outside the hard bounds are refused and clamped", async () => {
  const { POLICY_PARAMETERS, readPolicyParameter } = await import("../src/policy-params.ts");
  const { castVote } = await import("../src/consensus-rules.ts");
  const db = migratedDb();
  assert.equal(await readPolicyParameter(db as never, "daily-deploy-limit"), 10, "migration 0044 seeds 10");
  assert.equal(await readPolicyParameter(db as never, "target-actions-per-hour"), 1);
  const ev: any = { agents_enabled: true, audit_valid: true, services: {}, registry: {}, agents: {}, critical_reports_24h: 0, executing_plan_targets: [], recent_same: 0 };
  const vote = (target: string, value: unknown) => castVote("policy-engine", { action: "set_policy_parameter", target, params: { value }, class: "routine" } as any, ev);
  assert.equal(vote("daily-deploy-limit", 12).vote, "approve");
  assert.equal(vote("daily-deploy-limit", POLICY_PARAMETERS["daily-deploy-limit"].max + 1).vote, "reject");
  assert.equal(vote("daily-deploy-limit", 2.5).vote, "reject");
  assert.equal(vote("kill-switch", 0).vote, "reject", "only listed parameters are adjustable");
  // A value that bypassed consensus outside the bounds is clamped, never trusted.
  db.raw.prepare("UPDATE policy_parameters SET value = 20 WHERE name = 'target-actions-per-hour'").run();
  assert.equal(await readPolicyParameter(db as never, "target-actions-per-hour"), POLICY_PARAMETERS["target-actions-per-hour"].max);
  db.raw.prepare("UPDATE policy_parameters SET value = 12 WHERE name = 'daily-deploy-limit'").run();
  setMode(db, "deploy");
  record(db, 11, "executed", (i) => `svc-${i}`);
  assert.equal(check(await ask(db), "platform_daily_limit"), true, "the Policy Engine reads the parameter");
});
