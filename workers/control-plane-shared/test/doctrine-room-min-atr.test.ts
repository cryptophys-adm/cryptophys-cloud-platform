// Owner 2026-11-19 (xauusd #482, cryptophys-aether #35 at c2abe6b): the Decision Engine's room guardrail is tuned per
// trading mode by the learning protocol inside 0.5 to 1.5 times the 1H average range. Each mode's value is its own
// doctrine fact (one anchor per mode, so a mode switch moves no anchor), and Cerebrum bounds an amendment of each exactly
// as Aether does. The single decision.room_min_atr (the value in force) is information only and has no bound here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCTRINE_BOUNDS, boundProblem } from "../src/doctrine.ts";

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
