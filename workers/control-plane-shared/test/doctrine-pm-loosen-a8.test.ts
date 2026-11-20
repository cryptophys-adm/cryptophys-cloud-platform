// ADR-0020 Amendment 8 (owner 2026-11-20): the Position Manager council may loosen an open position's stop once, never
// beyond the original entry stop. Its two knobs are tuned per trading mode inside these bounds, as xauusd proposed
// them (#504, relay 2026-11-20 09:05): the ATR expansion a loosening needs, and how far back toward the original stop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOCTRINE_BOUNDS, boundProblem, doctrineActionFor } from "../src/doctrine.ts";

const MODES = ["scalp", "intraday", "swing", "range"] as const;
// xauusd's start values: each must sit inside its bound.
const START = { atr: { scalp: 1.6, intraday: 1.5, swing: 1.5, range: 1.8 }, back: { scalp: 0.4, intraday: 0.5, swing: 0.6, range: 0.4 } };

test("PL1. omega.pm_loosen_*_<mode>: ATR expansion 1.2-2.5, back share 0.25-1 (1 = the original entry stop, never past it), for each mode", () => {
  for (const mode of MODES) {
    const atr = `omega.pm_loosen_atr_expand_${mode}`;
    const back = `omega.pm_loosen_back_share_${mode}`;
    assert.deepEqual(DOCTRINE_BOUNDS[atr], { kind: "number", min: 1.2, max: 2.5 }, mode);
    assert.deepEqual(DOCTRINE_BOUNDS[back], { kind: "number", min: 0.25, max: 1 }, mode);
    assert.equal(boundProblem(atr, START.atr[mode]), null, `${atr} start value`);
    assert.equal(boundProblem(back, START.back[mode]), null, `${back} start value`);
    assert.match(boundProblem(atr, 1)!, /outside 1.2-2.5/, "no loosening without a real ATR expansion");
    assert.equal(boundProblem(back, 1), null, "back to the original entry stop is allowed");
    assert.match(boundProblem(back, 1.01)!, /outside 0.25-1/, "never past the original entry stop");
    assert.equal(doctrineActionFor([atr, back], false), "amend_doctrine");
  }
  for (const single of ["omega.pm_loosen_atr_expand", "omega.pm_loosen_back_share"]) {
    assert.match(boundProblem(single, 1.5)!, /not a council-amendable fact/, `${single}: only per-mode facts are bounded`);
  }
});

test("PL2. the names carry no word the Policy Engine prohibits, and the ADR's Amendment 8 names the knobs", () => {
  for (const fact of Object.keys(DOCTRINE_BOUNDS).filter((f) => f.startsWith("omega.pm_loosen_"))) {
    assert.doesNotMatch(fact, /trad(e|ing)\b|order|wallet|withdraw|transfer|swap/, fact);
  }
  const adr = readFileSync(new URL("../../../architecture/adr/0020-standing-trading-authorization.md", import.meta.url), "utf8");
  assert.match(adr, /The knobs \(the ATR-expansion threshold, how far back toward the original stop\) become doctrine facts per trading mode/);
});
