// Wave C: supervisor proposes suspending a repeatedly failing agent; D1 backup and UI render
// smoke wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, fakeAi, fakeWorkflow, migratedDb } from "./harness.ts";
import { verifySyscallDecision } from "../src/capabilities.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { proposeFromAgent } from "../../recovery-manager/src/index.ts";
import { SUSPEND_AFTER_FAILURES_PER_HOUR, runCycle } from "../../ai-kernel/src/supervisor.ts";

const ROOT = new URL("../../../", import.meta.url);

function kernelEnv(db = migratedDb()) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const recoveryEnv = { ...baseEnv("cryptophys-recovery-manager", db), RECOVERY_LIFECYCLE: fakeWorkflow().binding };
  const mem = new Map<string, unknown>();
  const env = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async (a: string, d: string, i: Record<string, unknown>) => { await verifySyscallDecision(db, d, a, "recovery.propose"); return proposeFromAgent(recoveryEnv as never, a, i); } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
  };
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, structuredClone(v)); } };
  return { env, db, memory };
}

function failures(db: ReturnType<typeof migratedDb>, agent: string, n: number) {
  for (let i = 0; i < n; i++) {
    db.raw.prepare(`INSERT INTO agent_actions (action_id, agent_id, capability, tier, decision_id, outcome, input_json, result_json, created_at) VALUES (?, ?, 'reports.publish', 1, NULL, 'denied', '{}', '{}', ?)`)
      .run(`act_${agent}_${i}`, agent, new Date(Date.now() - i * 60_000).toISOString());
  }
}
const suspendProposals = (db: ReturnType<typeof migratedDb>) => db.raw.prepare("SELECT target, status FROM consensus_proposals WHERE action = 'suspend_agent'").all() as any[];

test("C2. a repeatedly failing agent is proposed for suspension once; kernel agents and quiet agents are not", async () => {
  const { env, db, memory } = kernelEnv();
  failures(db, "platform-api", SUSPEND_AFTER_FAILURES_PER_HOUR);
  failures(db, "auditor", 20);
  failures(db, "policy-engine", SUSPEND_AFTER_FAILURES_PER_HOUR - 1);
  await runCycle(env as never, memory, "scheduled");
  let ps = suspendProposals(db);
  assert.deepEqual(ps.map((p) => p.target), ["platform-api"]);
  assert.equal(ps[0].status, "shadow_passed", "shadow mode only records it");
  assert.equal((db.raw.prepare("SELECT status FROM agents WHERE agent_id = 'platform-api'").get() as any).status, "enabled");
  await runCycle(env as never, memory, "scheduled");
  ps = suspendProposals(db);
  assert.equal(ps.length, 1, "not proposed again within 6 h");
  await runCycle(env as never, memory, "operator");
  assert.equal(suspendProposals(db).length, 1, "operator wakes never propose");
});

test("C3/C4. wiring: nightly D1 backup to a private R2 bucket, UI render smoke in CI", () => {
  const backup = readFileSync(new URL(".github/workflows/d1-backup.yml", ROOT), "utf8");
  assert.match(backup, /wrangler d1 export "\$D1_DATABASE_NAME" --remote/);
  assert.match(backup, /r2 object put "\$\{BUCKET\}\/control-plane\/\$\{stamp\}\.sql\.gz"/);
  assert.match(backup, /R2 is not enabled on the Cloudflare account/);
  assert.doesNotMatch(backup, /upload-artifact/, "backups never become public artifacts");
  assert.match(backup, /jq -c '\[\.errors\[\]\? \| \{code, message\}\]'/, "a refused token logs Cloudflare's error codes, never the token");
  assert.match(readFileSync(new URL(".github/workflows/ops-dispatch.yml", ROOT), "utf8"), /d1-backup\.yml\) ref=main ;;/, "the operator can run a backup on demand");
  const validate = readFileSync(new URL(".github/workflows/validate-control-plane.yml", ROOT), "utf8");
  assert.match(validate, /npx playwright install --with-deps chromium\n\s+npm run render-smoke/);
  const pullRequestTrigger = validate.match(/\n  pull_request:\n([\s\S]*?)\n  push:/)?.[1] ?? "";
  const pushTrigger = validate.match(/\n  push:\n([\s\S]*?)\n  workflow_dispatch:/)?.[1] ?? "";
  assert.match(pullRequestTrigger, /paths:/, "PR validation keeps its scoped path filter");
  assert.match(pushTrigger, /branches:\s*\[main\]/, "main push validation is enabled");
  assert.doesNotMatch(pushTrigger, /paths:/, "every main SHA must receive the Control Plane validation required by ciGreen");
  const smoke = readFileSync(new URL("workers/console/ui/scripts/render-smoke.mjs", ROOT), "utf8");
  assert.match(smoke, /horizontal scroll/);
  assert.match(smoke, /pageerror/);
});
