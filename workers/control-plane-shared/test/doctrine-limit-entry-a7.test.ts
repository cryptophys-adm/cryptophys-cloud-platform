// ADR-0020 Amendment 7 (owner 2026-11-20; xauusd RFC_OMEGA_LIMIT_ENTRY, #496/#497): Omega's resting limit entries are
// tuned per trading mode inside these bounds, as the RFC's final values (orchestrator relay 2026-11-20 01:40).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCTRINE_BOUNDS, boundProblem, doctrineActionFor } from "../src/doctrine.ts";

const MODES = ["scalp", "intraday", "swing", "range"] as const;
const LIFE: Record<(typeof MODES)[number], [number, number]> = { scalp: [15, 60], intraday: [30, 240], swing: [60, 720], range: [30, 240] };

test("LA1. omega.limit_*_<mode>: life in integer minutes, move up to 0.5 ATR, cancel drop 0.03-0.10, band 0.1-0.6, for each mode", () => {
  for (const mode of MODES) {
    const [lo, hi] = LIFE[mode];
    assert.deepEqual(DOCTRINE_BOUNDS[`omega.limit_life_min_${mode}`], { kind: "integer", min: lo, max: hi }, mode);
    assert.equal(boundProblem(`omega.limit_life_min_${mode}`, lo), null);
    assert.equal(boundProblem(`omega.limit_life_min_${mode}`, hi), null);
    assert.match(boundProblem(`omega.limit_life_min_${mode}`, hi + 1)!, /outside/);
    assert.match(boundProblem(`omega.limit_life_min_${mode}`, lo + 0.5)!, /must be an integer/);
    assert.deepEqual(DOCTRINE_BOUNDS[`omega.limit_move_max_atr_${mode}`], { kind: "number", min: 0, max: 0.5 }, mode);
    assert.match(boundProblem(`omega.limit_move_max_atr_${mode}`, 0.6)!, /outside 0-0.5/, "no chasing by more than half an ATR");
    assert.deepEqual(DOCTRINE_BOUNDS[`omega.limit_cancel_share_drop_${mode}`], { kind: "number", min: 0.03, max: 0.1 }, mode);
    assert.deepEqual(DOCTRINE_BOUNDS[`omega.limit_band_${mode}`], { kind: "number", min: 0.1, max: 0.6 }, mode);
    assert.match(boundProblem(`omega.limit_band_${mode}`, 1)!, /outside 0.1-0.6/, "a limit on the stop would leave no risk distance");
    assert.equal(doctrineActionFor([`omega.limit_band_${mode}`, `omega.limit_life_min_${mode}`], false), "amend_doctrine");
  }
  for (const single of ["omega.limit_life_min", "omega.limit_move_max_atr", "omega.limit_cancel_share_drop", "omega.limit_band"]) {
    assert.match(boundProblem(single, 1)!, /not a council-amendable fact/, `${single}: only per-mode facts are bounded`);
  }
});

test("LA2. no limit-entry fact name carries a word the Policy Engine prohibits", () => {
  for (const fact of Object.keys(DOCTRINE_BOUNDS).filter((f) => f.startsWith("omega.limit_"))) {
    assert.doesNotMatch(fact, /trad(e|ing)\b|order|wallet|withdraw|transfer|swap/, fact);
  }
});
