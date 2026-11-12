// Owner 2026-11-12: "larangan trading harus dicabut karena kita sudah masuk fase production" → "Trading boleh,
// dana tidak". ADR-0009 amendment: fund movement stays prohibited at every tier, whatever a vote or a click
// says; trading is allowed, but a trading consensus action is always critical (the owner's click) and a trading
// capability must be tier 2 or above. A target that merely contains the word (xauusd-ai-trading-assistant) is
// no trading action.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, migratedDb } from "./harness.ts";
import { PROHIBITED_CAPABILITY, TRADING_CAPABILITY } from "../src/capabilities.ts";
import { CONSENSUS_ACTIONS, classify, forbiddenCapabilities, privilegedCapabilities } from "../src/consensus-rules.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";

async function veto(resource: string, cls: string) {
  const db = migratedDb();
  const env = baseEnv("cryptophys-policy-engine", db);
  const req = parsePolicyRequest({ subject: "agent:supervisor", action: "consensus.execute", resource, context: { class: cls, passed: true } });
  if (req instanceof Error) throw req;
  const d = await decide(env as never, req) as unknown as { decision: string; reason: string };
  const row = db.raw.prepare("SELECT evidence_json FROM policy_decisions ORDER BY rowid DESC LIMIT 1").get() as { evidence_json: string };
  const failed = (JSON.parse(row.evidence_json).checks as Array<{ id: string; passed: boolean }>).filter((c) => !c.passed).map((c) => c.id);
  return { decision: d.decision, failed };
}

test("F1. fund movement is prohibited at every tier; trading words are not", () => {
  for (const c of ["wallet.withdraw", "funds.transfer", "chain.sign_tx", "dex.swap", "exchange.deposit", "treasury.payout"]) assert.ok(PROHIBITED_CAPABILITY.test(c), c);
  for (const c of ["trade.execute_order", "broker.place_order", "exchange_account.read"]) {
    assert.ok(!PROHIBITED_CAPABILITY.test(c), c);
    assert.ok(TRADING_CAPABILITY.test(c), c);
  }
  assert.deepEqual(forbiddenCapabilities(["wallet.withdraw", "signals.observe"]), ["wallet.withdraw"]);
  assert.ok(privilegedCapabilities(["trade.execute_order"]).includes("trade.execute_order"), "a trading capability always needs the owner's click to register");
});

test("F2. a trading consensus action is always critical; a fund action is prohibited; nothing new is executable without reviewed code", () => {
  assert.equal(classify("withdraw_funds"), "prohibited");
  assert.equal(classify("place_order"), null, "unknown: refused until an action is added by reviewed code");
  CONSENSUS_ACTIONS.place_order = { class: "routine", target: "service", description: "test only" };
  try {
    assert.equal(classify("place_order"), "critical", "even declared routine, a trading action is critical");
  } finally {
    delete CONSENSUS_ACTIONS.place_order;
  }
  for (const [name, def] of Object.entries(CONSENSUS_ACTIONS)) assert.ok(!TRADING_CAPABILITY.test(name) || classify(name) === "critical", name);
});

test("F3. the Policy Engine: a target naming trading passes; a routine trading action is vetoed; fund movement is always vetoed", async () => {
  const engine = await veto("register_engine:xauusd-ai-trading-assistant", "routine");
  assert.ok(!engine.failed.includes("not_prohibited") && !engine.failed.includes("trading_is_critical"), JSON.stringify(engine));
  const routineTrade = await veto("place_order:xauusd-ai-trading-assistant", "routine");
  assert.equal(routineTrade.decision, "deny");
  assert.ok(routineTrade.failed.includes("trading_is_critical"));
  const criticalTrade = await veto("place_order:xauusd-ai-trading-assistant", "critical");
  assert.ok(!criticalTrade.failed.includes("trading_is_critical") && !criticalTrade.failed.includes("not_prohibited"), JSON.stringify(criticalTrade));
  for (const r of ["withdraw_funds:cryptophys-platform-api", "transfer_funds:xauusd-omega", "swap_tokens:x"]) {
    const funds = await veto(r, "critical");
    assert.equal(funds.decision, "deny", r);
    assert.ok(funds.failed.includes("not_prohibited"), r);
  }
});
