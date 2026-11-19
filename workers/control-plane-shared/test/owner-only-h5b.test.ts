// HAIC H5b (owner 2026-11-19: "Perbaiki sekarang"; ADR-0017 §6, only the owner approves critical actions). The critical
// decisions move from approver accounts (Users page privilege "approver") to the owner, the people in
// APPROVER_IDENTITIES: a critical consensus decision, raising the consensus mode, turning agents back on, agent
// principals, the owner's alert channels and the Forge one-time actions. Approver accounts keep recovery plans,
// knowledge reviews, critical-report acknowledgements and resuming one agent (requireApprover is unchanged, U4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, call, migratedDb, signAccessJwt } from "./harness.ts";
import kernel from "../../ai-kernel/src/index.ts";

const ACCOUNT = "delegate@example.com";

function kernelWithApproverAccount() {
  const db = migratedDb();
  db.raw.prepare(`INSERT INTO platform_accounts (email, kind, privilege, status, created_by, created_at, updated_by, updated_at)
    VALUES (?, 'admin', 'approver', 'active', 'o', 't', 'o', 't')`).run(ACCOUNT);
  const env = baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL });
  return { db, env };
}
const send = (method: string, path: string, jwt: string, body?: unknown) =>
  new Request(`https://x${path}`, { method, headers: { "cf-access-jwt-assertion": jwt, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

test("H5b-1. an approver account gets owner_required on each critical route; the owner passes the same gate", async () => {
  const { env } = kernelWithApproverAccount();
  const account = await signAccessJwt({ email: ACCOUNT });
  const critical: [string, string, unknown][] = [
    ["POST", "/v1/consensus/cns_00000000-0000-4000-8000-000000000001/approve", { reason: "looks fine" }],
    ["POST", "/v1/consensus/cns_00000000-0000-4000-8000-000000000001/reject", { reason: "no" }],
    ["POST", "/v1/consensus/mode", { mode: "deploy", confirm: "RAISE MODE" }],
    ["POST", "/v1/kernel/agents-enabled", { enabled: true }],
    ["POST", "/v1/agents/supervisor/principals", { access_identity: "x.access" }],
    ["DELETE", "/v1/agents/supervisor/principals/x.access", undefined],
    ["POST", "/v1/alerts", { label: "x" }],
  ];
  for (const [method, path, body] of critical) {
    const r = await call(kernel, env as never, send(method, path, account, body));
    assert.deepEqual([r.status, r.body.error], [403, "owner_required"], `${method} ${path}`);
  }
  // The owner passes the gate (what follows is the route's own answer, never owner_required).
  for (const [method, path, body] of critical) {
    const r = await call(kernel, env as never, send(method, path, APPROVER_JWT, body));
    assert.notEqual(r.body?.error, "owner_required", `${method} ${path} for the owner`);
  }
  const on = await call(kernel, env as never, send("POST", "/v1/kernel/agents-enabled", APPROVER_JWT, { enabled: true }));
  assert.equal(on.status, 200);
});

test("H5b-2. approver accounts keep their non-critical approvals: resuming one agent, acknowledging a report, knowledge reviews", async () => {
  const { env } = kernelWithApproverAccount();
  const account = await signAccessJwt({ email: ACCOUNT });
  for (const [method, path, body] of [
    ["POST", "/v1/agents/supervisor/resume", {}],
    ["POST", "/v1/reports/rpt_none/acknowledge", { reason: "handled and checked" }],
    ["POST", "/v1/knowledge/kp_none/approve", { reason: "fine" }],
  ] as const) {
    const r = await call(kernel, env as never, send(method, path, account, body));
    assert.ok(!["owner_required", "approver_required"].includes(r.body?.error), `${method} ${path}: ${JSON.stringify(r.body)}`);
  }
  // Turning agents off stays with any operator.
  assert.equal((await call(kernel, env as never, send("POST", "/v1/kernel/agents-enabled", account, { enabled: false }))).status, 200);
});

test("H5b-3. MCP and the Forge: set_agents_enabled true and the Forge one-time actions need the owner", () => {
  const root = new URL("../../../", import.meta.url);
  const mcp = readFileSync(new URL("workers/ai-kernel/src/mcp.ts", root), "utf8");
  assert.match(mcp, /args\.enabled === true && !isOwner\) return text\(\{ error: "owner_required" \}/);
  const forge = readFileSync(new URL("workers/forge/src/index.ts", root), "utf8");
  assert.equal((forge.match(/if \(!isOwner\(approver\.identity, env as never\)\) return errorResponse\(403, "owner_required"/g) ?? []).length, 2, "merge-spike and work-repo");
});
