// ADR-0020 Amendment 10 (owner 2026-11-21, "tabel disetujui"): Omega's risk bounds follow the account profile. Before
// it one static range each (risk 0.1-2, daily loss 1-5, positions 1-3) predated the profiles, and the owner's live
// Conservative daily loss of 6% was outside it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOCTRINE_BOUNDS, boundProblem, doctrineActionFor } from "../src/doctrine.ts";

// xauusd src/account-spec.mjs PROFILES (relay 2026-11-21 14:55): [hard cap per trade %, daily loss %, max positions].
// Custom has no limit of its own in xauusd; the owner bounded it as Aggressive ("2a").
const PROFILES: Record<string, [number, number, number]> = { safe: [2, 3, 1], conservative: [5, 6, 2], aggressive: [10, 10, 3], custom: [10, 10, 3] };
// The risk-per-trade targets of the same table: each sits inside its profile's bound.
const TARGET: Record<string, number> = { safe: 1, conservative: 2, aggressive: 5, custom: 5 };

test("PA1. each profile's ceiling is its hard limit: risk per trade, daily loss and positions", () => {
  for (const [p, [cap, daily, positions]] of Object.entries(PROFILES)) {
    assert.deepEqual(DOCTRINE_BOUNDS[`omega.risk_pct_${p}`], { kind: "number", min: 0.1, max: cap }, p);
    assert.deepEqual(DOCTRINE_BOUNDS[`omega.max_daily_loss_pct_${p}`], { kind: "number", min: 0.1, max: daily }, p);
    assert.deepEqual(DOCTRINE_BOUNDS[`omega.max_positions_${p}`], { kind: "integer", min: 1, max: positions }, p);
    assert.equal(boundProblem(`omega.risk_pct_${p}`, TARGET[p]), null, `${p}: the target`);
    assert.equal(boundProblem(`omega.risk_pct_${p}`, cap), null);
    assert.match(boundProblem(`omega.risk_pct_${p}`, cap + 0.1)!, /outside/, `${p}: never above the hard cap`);
    assert.equal(boundProblem(`omega.max_daily_loss_pct_${p}`, daily), null);
    assert.match(boundProblem(`omega.max_daily_loss_pct_${p}`, daily + 0.5)!, /outside/);
    assert.match(boundProblem(`omega.max_positions_${p}`, positions + 1)!, /outside/);
    assert.equal(doctrineActionFor([`omega.risk_pct_${p}`, `omega.max_daily_loss_pct_${p}`], false), "amend_doctrine");
  }
  // The owner's live setting: Conservative, 6% a day. Refused under the old single bound (1-5), allowed under its profile.
  assert.equal(boundProblem("omega.max_daily_loss_pct_conservative", 6), null);
  assert.match(boundProblem("omega.max_daily_loss_pct_safe", 6)!, /outside 0.1-3/, "the same value is refused for Safe");
});

test("PA2. the single facts are information, Custom is bounded as Aggressive, and no name carries a prohibited word", () => {
  for (const f of ["omega.risk_pct", "omega.max_daily_loss_pct", "omega.max_positions"]) {
    assert.equal(Object.hasOwn(DOCTRINE_BOUNDS, f), false, f);
    assert.match(boundProblem(f, 1)!, /not a council-amendable fact/);
    assert.equal(doctrineActionFor([f], false), "amend_constitution", `${f}: a change is the owner's`);
  }
  for (const k of ["risk_pct", "max_daily_loss_pct", "max_positions"]) assert.deepEqual(DOCTRINE_BOUNDS[`omega.${k}_custom`], DOCTRINE_BOUNDS[`omega.${k}_aggressive`], k);
  assert.match(boundProblem("omega.max_daily_loss_pct_custom", 20)!, /outside 0.1-10/, "the engine's input range (up to 20) is not the bound");
  assert.match(boundProblem("omega.max_positions_custom", 5)!, /outside 1-3/);
  assert.equal(Object.hasOwn(DOCTRINE_BOUNDS, "omega.profile"), false, "the profile itself is not the council's (Amendment 3)");
  const mine = Object.keys(DOCTRINE_BOUNDS).filter((f) => /^omega\.(risk_pct|max_daily_loss_pct|max_positions)_/.test(f));
  assert.equal(mine.length, 12);
  for (const f of mine) assert.doesNotMatch(f, /trad(e|ing)\b|order|wallet|withdraw|transfer|swap/, f);
  const adr = readFileSync(new URL("../../../architecture/adr/0020-standing-trading-authorization.md", import.meta.url), "utf8");
  assert.match(adr, /## Amendment 10 \(owner, 2026-11-21\): risk bounds follow the account profile/);
  assert.match(adr, /confirmed it directly to the platform session on 2026-11-21 \("tabel disetujui"; for the Custom profile, "2a": bounded as Aggressive\)/);
  assert.match(adr, /\| Conservative \| 2% \| 5% \| 5% \| 6% \| 2 \| intraday, swing, range \|/);
  assert.ok(adr.indexOf("## Amendment 10") < adr.indexOf("## Guards"));
});
