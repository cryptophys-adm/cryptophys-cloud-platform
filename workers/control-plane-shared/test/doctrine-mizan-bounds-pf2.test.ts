// xauusd's Mizan Oracle as a Decision Engine witness (platform task PF2; owner 2026-11-22/23: "langsung promote saja",
// "Council naik, auto mati"): Aether moves its knobs inside these hard bounds, which mirror Aether's DOCTRINE_BOUNDS.
// fact -> [kind, min, max, start]; every start sits inside its bound.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOCTRINE_BOUNDS, boundProblem, doctrineActionFor } from "../src/doctrine.ts";

const TABLE: Record<string, ["number" | "integer", number, number, number]> = {
  "mizan.de_weight_scalp": ["number", 0, 0.04, 0.02],
  "mizan.de_weight_intraday": ["number", 0, 0.04, 0.02],
  "mizan.de_weight_swing": ["number", 0, 0.04, 0.02],
  "mizan.de_weight_range": ["number", 0, 0.04, 0.02],
  "mizan.score_floor": ["number", 0.4, 0.6, 0.45],
  "mizan.score_window": ["integer", 50, 200, 100],
  "mizan.min_readings": ["integer", 20, 100, 40],
};

test("MZ-PF2-1. the seven mizan.* facts hold their bounds, and every start value is inside its bound", () => {
  const ours = Object.keys(DOCTRINE_BOUNDS).filter((f) => f.startsWith("mizan."));
  assert.deepEqual(ours.sort(), Object.keys(TABLE).sort());
  assert.equal(ours.length, 7, "4 per-mode weights and 3 per lens");
  for (const [f, [kind, min, max, start]] of Object.entries(TABLE)) {
    assert.deepEqual(DOCTRINE_BOUNDS[f], { kind, min, max }, f);
    assert.equal(boundProblem(f, start), null, `${f}: the start value`);
    assert.equal(boundProblem(f, min), null, `${f}: its minimum`);
    assert.equal(boundProblem(f, max), null, `${f}: its maximum`);
    assert.match(boundProblem(f, max + 1)!, /outside/, `${f}: above its bound`);
    assert.match(boundProblem(f, min - 1)!, /outside/, `${f}: below its bound`);
    if (kind === "integer") assert.match(boundProblem(f, start + 0.5)!, /must be an integer/, f);
  }
});

test("MZ-PF2-2. the witness may drop to 0 but never pass 0.04 in any mode", () => {
  for (const mode of ["scalp", "intraday", "swing", "range"]) {
    assert.equal(boundProblem(`mizan.de_weight_${mode}`, 0), null, `${mode}: auto off`);
    assert.match(boundProblem(`mizan.de_weight_${mode}`, 0.041)!, /outside 0-0.04/, mode);
    assert.match(boundProblem(`mizan.de_weight_${mode}`, -0.01)!, /outside 0-0.04/, mode);
  }
  assert.match(boundProblem("mizan.score_floor", 0.39)!, /outside 0.4-0.6/);
  assert.match(boundProblem("mizan.score_floor", 0.61)!, /outside 0.4-0.6/);
});

test("MZ-PF2-3. inside its bounds a mizan amendment is routine; a constitutional rule beside it is not", () => {
  assert.equal(doctrineActionFor(["mizan.de_weight_swing", "mizan.score_floor"], false), "amend_doctrine");
  assert.equal(doctrineActionFor(["mizan.de_weight_swing"], true), "amend_constitution");
  assert.equal(doctrineActionFor(["mizan.de_weight_swing", "mizan.action_label"], false), "amend_constitution");
});

test("MZ-PF2-4. no mizan fact name carries a word the Policy Engine prohibits or a decision word", () => {
  for (const f of Object.keys(TABLE)) {
    assert.doesNotMatch(f, /trad(e|ing)\b|order|wallet|withdraw|transfer|swap/, f);
    assert.doesNotMatch(f, /sniper|override|veto|safe_mode|action/, f);
  }
});

test("MZ-PF2-5. SSOT line 5 carries the PF2 entry", () => {
  const line5 = readFileSync(new URL("../../../docs/SSOT.md", import.meta.url), "utf8").split("\n")[4];
  assert.match(line5, /^Last reviewed: 2026-11-16 \((?:[^\n]*; )?Mizan doctrine bounds \(PF2\), 2026-11-23/);
});
