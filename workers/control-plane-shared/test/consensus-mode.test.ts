// Owner decision 2026-11-06: a person sets the consensus mode. Raising needs an approver who is
// a person; lowering toward shadow is a brake any operator may pull; every change is audited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, CI_JWT, OPERATOR_EMAIL, baseEnv, call, migratedDb } from "./harness.ts";
import { verifyAuditChain } from "../src/audit.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { setConsensusMode } from "../../ai-kernel/src/consensus.ts";

const env = (db = migratedDb()) => ({ db, env: baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }) });
const mode = (db: ReturnType<typeof migratedDb>) => (db.raw.prepare("SELECT value FROM consensus_controls WHERE control = 'mode'").get() as any).value;
const post = (jwt: string, body: unknown) => new Request("https://x/v1/consensus/mode", { method: "POST", headers: { "cf-access-jwt-assertion": jwt, "content-type": "application/json" }, body: JSON.stringify(body) });

test("raising the mode needs an approver who is a person; the CI token cannot", async () => {
  const { db, env: e } = env();
  const ci = await call(kernel, e, post(CI_JWT, { mode: "deploy" }));
  assert.deepEqual([ci.status, ci.body.error], [403, "approver_required"]);
  assert.equal(mode(db), "shadow");
  await assert.rejects(setConsensusMode(e as never, "deploy", "ci-client.access", true, null), /person_required/);
  const ok = await call(kernel, e, post(APPROVER_JWT, { mode: "deploy", reason: "owner override of the 7-day shadow window" }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.previous, ok.body.mode, ok.body.changed], ["shadow", "deploy", true]);
  assert.equal(mode(db), "deploy");
  const ev = db.raw.prepare("SELECT actor, outcome, payload_json FROM audit_events WHERE event_type = 'consensus.mode_changed'").get() as any;
  assert.equal(ev.actor, APPROVER_EMAIL);
  assert.equal(ev.outcome, "deploy");
  assert.match(ev.payload_json, /7-day/);
  assert.equal((await verifyAuditChain(db as never)).valid, true);
});

test("any operator can brake back to shadow; invalid modes are refused; no-op changes are not audited", async () => {
  const { db, env: e } = env();
  await setConsensusMode(e as never, "deploy", APPROVER_EMAIL, true, null);
  const brake = await call(kernel, e, post(CI_JWT, { mode: "shadow" }));
  assert.equal(brake.status, 200);
  assert.equal(mode(db), "shadow");
  assert.equal((await call(kernel, e, post(APPROVER_JWT, { mode: "autonomous" }))).status, 400);
  const same = await setConsensusMode(e as never, "shadow", APPROVER_EMAIL, true, null);
  assert.equal(same.changed, false);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'consensus.mode_changed'").get() as any).n, 2);
});

test("deploy verification accepts any known mode but fails on a stuck execution", () => {
  const wf = readFileSync(new URL("../../../.github/workflows/deploy-control-plane.yml", import.meta.url), "utf8");
  assert.match(wf, /\(\.mode \| IN\("shadow", "routine", "deploy", "critical"\)\)/);
  assert.match(wf, /select\(\.status == "executing" and \.decided_at < \$cutoff\)/);
});
