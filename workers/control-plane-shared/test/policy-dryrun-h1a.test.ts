// HAIC H1a (ADR-0017 H1, docs/design/HAIC-H0-H1.md §3.2 `policy_dry_run`): PolicyRpc.dryRun() answers "would X be
// allowed?" with exactly evaluate()'s decision, reason and checks, and records nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { baseEnv, call, migratedDb, req, CI_JWT } from "./harness.ts";
import policy, { decide, dryRun, parsePolicyRequest } from "../../policy-engine/src/index.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const CTX = { commit_sha: SHA, confirm_production: "DEPLOY", ci_green: true };
const CASES: Record<string, unknown>[] = [
  { subject: "github-actions", action: "deploy", resource: "cryptophys-platform-api", context: CTX },
  { subject: "op", action: "deploy", resource: "cryptophys-platform-api", context: { ...CTX, ci_green: false } },
  { subject: "op", action: "deploy", resource: "ghost", context: CTX },
  { subject: "op", action: "delete_everything", resource: "x" },
  { subject: "agent:supervisor", action: "agent.syscall", resource: "reports.publish" },
  { subject: "agent:nobody", action: "agent.syscall", resource: "consensus.propose" },
];

test("H1a-P1. dryRun gives evaluate()'s decision, reason and checks for allows and denies, and writes no decision, audit event or report", async () => {
  const db = migratedDb();
  const reports: unknown[] = [];
  const env = { ...baseEnv("cryptophys-policy-engine", db), AGENTS: { syscall: async (...a: unknown[]) => { reports.push(a); return { ok: true }; } } } as never;
  const count = (table: string) => (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const decisions: string[] = [];
  for (const input of CASES) {
    const parsed = parsePolicyRequest(input as never);
    assert.ok(!(parsed instanceof Error), JSON.stringify(input));
    const before = [count("policy_decisions"), count("audit_events"), reports.length];
    const dry = await dryRun(env, parsed as never);
    assert.deepEqual([count("policy_decisions"), count("audit_events"), reports.length], before, `${input.action} ${input.resource}: a dry run records nothing`);
    assert.equal(dry.dry_run, true);
    assert.ok(!("decision_id" in dry), "no decision id: nothing was recorded");
    const real = await decide(env, parsed as never);
    assert.deepEqual({ decision: dry.decision, reason: dry.reason, checks: dry.checks, action: dry.action, resource: dry.resource },
      { decision: real.decision, reason: real.reason, checks: real.checks, action: real.action, resource: real.resource }, `${input.action} ${input.resource}: the same answer as evaluate()`);
    assert.equal(dry.subject, (parsed as { subject: string }).subject);
    decisions.push(dry.decision);
  }
  assert.ok(decisions.includes("allow") && decisions.includes("deny"), "both outcomes covered");
});

test("H1a-P2. only the RPC entrypoint offers the dry run: no HTTP route, and the RPC validates its input like evaluate()", async () => {
  const db = migratedDb();
  const env = baseEnv("cryptophys-policy-engine", db);
  for (const path of ["/v1/dry-run", "/v1/dryrun", "/v1/evaluate/dry-run"]) {
    const r = await call(policy, env, req("POST", path, CASES[0], CI_JWT));
    assert.equal(r.status, 404, path);
  }
  const worker = readFileSync(new URL("../../policy-engine/src/worker.ts", import.meta.url), "utf8");
  assert.match(worker, /export class PolicyRpc extends WorkerEntrypoint<Env> \{[\s\S]*?async dryRun\(input: Record<string, unknown>\): Promise<PolicyDryRun> \{\n\s+const parsed = parsePolicyRequest\(input \?\? \{\}\);\n\s+if \(parsed instanceof Error\) throw new Error\(`invalid_request: \$\{parsed\.message\}`\);\n\s+return dryRun\(this\.env, parsed\);/);
  const index = readFileSync(new URL("../../policy-engine/src/index.ts", import.meta.url), "utf8");
  const body = index.slice(index.indexOf("export async function dryRun("), index.indexOf("/** Evaluate, persist the decision"));
  assert.doesNotMatch(body, /INSERT|appendAuditEvent|publishAgentReport|\.run\(\)/, "the dry run's body writes nothing");
  assert.ok(parsePolicyRequest({ subject: "op", action: "", resource: "x" } as never) instanceof Error);
});
