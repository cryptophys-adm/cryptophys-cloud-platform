// Owner 2026-11-19 (xauusd #482, cryptophys-aether #35): the Decision Engine's room guardrail is tuned per trading mode
// by the learning protocol inside 0.5 to 1.5 times the 1H average range; the value in force is the doctrine fact
// decision.room_min_atr, and Cerebrum bounds an amendment of it exactly as Aether does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCTRINE_BOUNDS, boundProblem } from "../src/doctrine.ts";

test("DR1. decision.room_min_atr is a number from 0.5 to 1.5, the same bound as Aether's", () => {
  assert.deepEqual(DOCTRINE_BOUNDS["decision.room_min_atr"], { kind: "number", min: 0.5, max: 1.5 });
  for (const v of [0.5, 0.75, 1, 1.5]) assert.equal(boundProblem("decision.room_min_atr", v), null, String(v));
  assert.match(boundProblem("decision.room_min_atr", 0.25)!, /outside 0.5-1.5/, "the floor keeps the guard on");
  assert.match(boundProblem("decision.room_min_atr", 1.75)!, /outside 0.5-1.5/);
  assert.match(boundProblem("decision.room_min_atr", "1")!, /must be a number/);
});
