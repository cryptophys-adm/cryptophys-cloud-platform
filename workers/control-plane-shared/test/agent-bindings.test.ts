// TP-011 part 2: platform Workers call their own agents through the AI Kernel's AgentRpc
// (ADR-0007 §1.1). Agent calls are advisory and must never fail the Worker's own work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { baseEnv, migratedDb } from "./harness.ts";
import { publishAgentReport, type AgentRpcBinding } from "../src/agents.ts";

function recorder(outcome: Record<string, unknown> | Error = { outcome: "succeeded" }) {
  const calls: { agentId: string; capability: string; input: any }[] = [];
  const binding: AgentRpcBinding = {
    whoami: async () => ({}),
    observe: async () => ({}),
    syscall: async (agentId, capability, input) => {
      calls.push({ agentId, capability, input });
      if (outcome instanceof Error) throw outcome;
      return outcome as never;
    },
  };
  return { calls, binding };
}

test("publishAgentReport adds the advisory disclaimer, reports denials as data and never throws", async () => {
  const ok = recorder();
  const r = await publishAgentReport(ok.binding, "signal-engine", { kind: "platform_digest", severity: "warning", subject: "s", body: { a: 1 } });
  assert.equal(r.ok, true);
  assert.deepEqual([ok.calls[0].capability, ok.calls[0].input.body.disclaimer], ["reports.publish", "advisory only; not an order"]);
  assert.deepEqual(await publishAgentReport(undefined, "x", { kind: "platform_digest", severity: "info", subject: "s", body: {} }), { ok: false, reason: "agents_binding_missing" });
  const denied = recorder({ outcome: "denied", reason: "rate_limit" });
  assert.deepEqual(await publishAgentReport(denied.binding, "x", { kind: "platform_digest", severity: "info", subject: "s", body: {} }), { ok: false, reason: "rate_limit" });
  const down = recorder(new Error("kernel unavailable"));
  assert.equal((await publishAgentReport(down.binding, "x", { kind: "platform_digest", severity: "info", subject: "s", body: {} })).ok, false);
});


test("every platform Worker binds AgentRpc pinned to its own Worker name", () => {
  const workers = ["platform-api", "deployment-orchestrator", "platform-registry", "policy-engine", "drift-detector", "audit-ledger", "recovery-manager"];
  for (const w of workers) {
    const toml = readFileSync(new URL(`../../${w}/wrangler.toml`, import.meta.url), "utf8");
    const block = toml.slice(toml.indexOf('binding = "AGENTS"'));
    assert.ok(block.startsWith('binding = "AGENTS"'), `${w} has an AGENTS binding`);
    assert.match(block, /service = "cryptophys-ai-kernel"\nentrypoint = "AgentRpc"\nprops = \{ host_worker = "([a-z-]+)" \}/, w);
    assert.equal(/host_worker = "([a-z-]+)"/.exec(block)![1], `cryptophys-${w}`, `${w} is pinned to itself`);
  }
});
