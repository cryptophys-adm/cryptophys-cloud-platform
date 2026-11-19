// DR2: owner 2026-11-19 (xauusd #485): decision.quorum_min, lean and min_rrr split per mode the same way.
// Owner 2026-11-19 (xauusd #482, cryptophys-aether #35 at c2abe6b): the Decision Engine's room guardrail is tuned per
// trading mode by the learning protocol inside 0.5 to 1.5 times the 1H average range. Each mode's value is its own
// doctrine fact (one anchor per mode, so a mode switch moves no anchor), and Cerebrum bounds an amendment of each exactly
// as Aether does. The single decision.room_min_atr (the value in force) is information only and has no bound here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCTRINE_BOUNDS, boundProblem, doctrineActionFor } from "../src/doctrine.ts";

const MODES = ["scalp", "intraday", "swing", "range"];

test("DR1. decision.room_min_atr_<mode> is a number from 0.5 to 1.5 for each trading mode, the same bound as Aether's", () => {
  for (const mode of MODES) {
    const fact = `decision.room_min_atr_${mode}`;
    assert.deepEqual(DOCTRINE_BOUNDS[fact], { kind: "number", min: 0.5, max: 1.5 }, fact);
    for (const v of [0.5, 0.75, 1, 1.5]) assert.equal(boundProblem(fact, v), null, `${fact} ${v}`);
    assert.match(boundProblem(fact, 0.25)!, /outside 0.5-1.5/, `${fact}: the floor keeps the guard on`);
    assert.match(boundProblem(fact, 1.75)!, /outside 0.5-1.5/, fact);
    assert.match(boundProblem(fact, "1")!, /must be a number/, fact);
  }
  assert.match(boundProblem("decision.room_min_atr", 1)!, /not a council-amendable fact/, "the value in force is information only");
});

test("DR2. decision.quorum_min, lean and min_rrr are bounded per trading mode with the single fact's bound; the single facts and min_rrr_scalp are information only", () => {
  const bounds: Record<string, [number, number]> = { quorum_min: [0.45, 0.7], lean: [0.05, 0.3], min_rrr: [1, 3] };
  for (const [name, [min, max]] of Object.entries(bounds)) {
    for (const mode of MODES) {
      const fact = `decision.${name}_${mode}`;
      if (name === "min_rrr" && mode === "scalp") continue;
      assert.deepEqual(DOCTRINE_BOUNDS[fact], { kind: "number", min, max }, fact);
      assert.equal(boundProblem(fact, min), null, fact);
      assert.equal(boundProblem(fact, max), null, fact);
      assert.match(boundProblem(fact, max + 0.01)!, new RegExp(`outside ${min}-${max}`), fact);
      assert.match(boundProblem(fact, min - 0.01)!, new RegExp(`outside ${min}-${max}`), fact);
    }
    assert.match(boundProblem(`decision.${name}`, min)!, /not a council-amendable fact/, `decision.${name} is information only`);
  }
  assert.equal(DOCTRINE_BOUNDS["decision.min_rrr_scalp"], undefined, "scalp has no reward minimum (owner 2026-11-12)");
  assert.match(boundProblem("decision.min_rrr_scalp", 0)!, /not a council-amendable fact/);
});

test("DR3. decision.trading_mode is not bounded, as Aether #36: amending the mode in force is amend_constitution", () => {
  assert.equal(DOCTRINE_BOUNDS["decision.trading_mode"], undefined);
  for (const mode of ["scalp", "intraday", "swing", "range"]) assert.match(boundProblem("decision.trading_mode", mode)!, /not a council-amendable fact/, mode);
  assert.equal(doctrineActionFor(["decision.trading_mode"], false), "amend_constitution");
  assert.equal(doctrineActionFor(["decision.quorum_min_range", "decision.lean_range"], false), "amend_doctrine");
});
