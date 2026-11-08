// Retrospective 2026-11-08 (docs/RETROSPECTIVE-2026-11-08.md §6.6): agents repeated the same warning.
// The auditor re-published one burst of denied syscalls every hour for a day (24-hour rolling counts),
// and the Policy Engine reported every retry of the same vetoed deploy. Both now report what is new.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, migratedDb } from "./harness.ts";
import { AUDIT_WARNING_REPEAT_MS, warningCounts, warningIsNew } from "../../ai-kernel/src/auditor.ts";
import { DENY_REPORT_WINDOW_MS, decide } from "../../policy-engine/src/index.ts";

test("RD1. an auditor warning is republished only when a reason is new or has grown, or after six hours", () => {
  const t0 = Date.parse("2026-11-06T10:37:00Z");
  assert.equal(warningIsNew(["denied_agent_syscalls:5"], undefined, t0), true, "nothing published yet");
  const last = { counts: warningCounts(["denied_agent_syscalls:5", "kernel_agents_enabled_changed:1"]), at: t0 };
  assert.deepEqual(last.counts, { denied_agent_syscalls: 5, kernel_agents_enabled_changed: 1 });
  const hour = 60 * 60_000;
  assert.equal(warningIsNew(["denied_agent_syscalls:5", "kernel_agents_enabled_changed:1"], last, t0 + hour), false, "the same counts an hour later");
  assert.equal(warningIsNew(["denied_agent_syscalls:4"], last, t0 + 2 * hour), false, "the rolling window shrinks: nothing new");
  assert.equal(warningIsNew(["denied_agent_syscalls:7"], last, t0 + hour), true, "more denials than last published");
  assert.equal(warningIsNew(["denied_agent_syscalls:5", "audit_chain_invalid"], last, t0 + hour), true, "a new reason");
  assert.equal(warningIsNew(["denied_agent_syscalls:5"], last, t0 + AUDIT_WARNING_REPEAT_MS), true, "still there after six hours");
});

test("RD2. an identical policy denial is decided and audited every time but reported once per hour", async () => {
  const db = migratedDb();
  const reports: string[] = [];
  const env: any = {
    ...baseEnv("cryptophys-policy-engine", db),
    AGENTS: {
      whoami: async () => ({}), observe: async () => ({}),
      syscall: async (_a: string, capability: string, input: any) => { if (capability === "reports.publish") reports.push(input.subject); return { outcome: "succeeded" }; },
    },
  };
  const req = { subject: "agent:supervisor", action: "deploy", resource: "cryptophys-unknown", context: {} };
  for (let i = 0; i < 4; i++) assert.equal((await decide(env, req)).decision, "deny");
  assert.equal(reports.length, 1, "four identical retries: one report");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM policy_decisions WHERE decision = 'deny'").get() as any).n, 4, "every decision is still recorded");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'policy.decision'").get() as any).n, 4, "and audited");
  await decide(env, { ...req, resource: "cryptophys-other" });
  assert.equal(reports.length, 2, "another resource is a new denial");
  db.raw.prepare("UPDATE policy_decisions SET created_at = ?").run(new Date(Date.now() - DENY_REPORT_WINDOW_MS - 60_000).toISOString());
  await decide(env, req);
  assert.equal(reports.length, 3, "the same denial an hour later is reported again");
});
