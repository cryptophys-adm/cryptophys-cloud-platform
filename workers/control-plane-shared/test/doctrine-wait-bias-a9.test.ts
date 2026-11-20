// ADR-0020 Amendment 9 (owner 2026-11-20, "1.b"): WAIT-with-bias entries past the quorum share only, with a learned
// counter-bias multiplier per strategy agent and mode; and ADR-0021 (owner 2026-11-20, "3. All protocols live"): the
// Self-Improvement Protocol's validator gates, whose floors are the owner's starting values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOCTRINE_BOUNDS, boundProblem, doctrineActionFor } from "../src/doctrine.ts";

const MODES = ["scalp", "intraday", "swing", "range"] as const;
// xauusd's STRATEGY_AGENTS ids (src/strategy-agents.mjs), as relayed 2026-11-20 09:09.
const AGENTS = ["zone_pullback", "sweep_reversal", "breakout_retest", "range_fade", "pattern_peaks", "pattern_lines", "pattern_curve",
  "pattern_bars", "pattern_pole", "pattern_gaps", "pattern_legs", "pattern_event", "pattern_inside"] as const;
const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

test("WB1. omega.wait_bias_min_score_<mode>: 0.20-0.60 for every mode, start 0.30 inside", () => {
  for (const mode of MODES) {
    const f = `omega.wait_bias_min_score_${mode}`;
    assert.deepEqual(DOCTRINE_BOUNDS[f], { kind: "number", min: 0.2, max: 0.6 }, mode);
    assert.equal(boundProblem(f, 0.3), null, `${f}: the start value`);
    assert.match(boundProblem(f, 0.1)!, /outside 0.2-0.6/);
  }
  assert.match(boundProblem("omega.wait_bias_min_score", 0.3)!, /not a council-amendable fact/, "only per-mode facts are bounded");
});

test("WB2. omega.wait_bias_counter_<agent>_<mode>: 0-0.5 for intraday, swing and range, 0-0 for scalp; 0 is the start and means never", () => {
  const counter = Object.keys(DOCTRINE_BOUNDS).filter((f) => f.startsWith("omega.wait_bias_counter_"));
  assert.equal(counter.length, AGENTS.length * MODES.length, "13 agents x 4 modes");
  assert.equal(Object.keys(DOCTRINE_BOUNDS).filter((f) => f.startsWith("omega.wait_bias_")).length, 56);
  for (const agent of AGENTS) for (const mode of MODES) {
    const f = `omega.wait_bias_counter_${agent}_${mode}`;
    assert.deepEqual(DOCTRINE_BOUNDS[f], { kind: "number", min: 0, max: mode === "scalp" ? 0 : 0.5 }, f);
    assert.equal(boundProblem(f, 0), null, `${f}: the start value`);
    if (mode === "scalp") assert.match(boundProblem(f, 0.1)!, /outside 0-0/, "scalp never opens a counter-bias plan");
    else {
      assert.equal(boundProblem(f, 0.5), null);
      assert.match(boundProblem(f, 0.6)!, /outside 0-0.5/, "a counter-bias plan needs at least twice the score");
    }
  }
  assert.equal(doctrineActionFor(["omega.wait_bias_counter_range_fade_range", "omega.wait_bias_min_score_range"], false), "amend_doctrine");
});

test("WB3. the names carry no word the Policy Engine prohibits, and Amendment 9 keeps the veto and every guardrail but the quorum share", () => {
  for (const f of Object.keys(DOCTRINE_BOUNDS).filter((x) => x.startsWith("omega.wait_bias_") || x.startsWith("validator."))) {
    assert.doesNotMatch(f, /trad(e|ing)\b|order|wallet|withdraw|transfer|swap/, f);
  }
  const adr = read("architecture/adr/0020-standing-trading-authorization.md");
  assert.match(adr, /## Amendment 9 \(owner, 2026-11-20\): WAIT-with-bias entries, past the quorum share only/);
  assert.match(adr, /Every guardrail of that side except the quorum share\. A Decision Engine veto still blocks it\./);
  assert.match(adr, /choosing both the bias-side entry and the learned counter-bias multipliers \("1\.b"\)/);
  for (const agent of AGENTS) assert.ok(adr.includes(agent), `the ADR names ${agent}`);
  assert.ok(adr.indexOf("## Amendment 9") < adr.indexOf("## Guards"), "before the Guards");
});

test("SI1. ADR-0021's validator gates: the floor of each bound is the owner's starting value, so a tuning can only be stricter", () => {
  const FLOORS: Record<string, [number, number, "integer" | "number"]> = {
    "validator.min_sim_samples": [100, 1000, "integer"], "validator.min_sim_samples_per_mode": [50, 500, "integer"],
    "validator.min_oos_pf": [1.2, 3, "number"], "validator.min_wf_windows_positive": [3, 4, "integer"], "validator.sensitivity_pct": [20, 50, "integer"],
  };
  assert.deepEqual(Object.keys(DOCTRINE_BOUNDS).filter((f) => f.startsWith("validator.")).sort(), Object.keys(FLOORS).sort());
  for (const [f, [min, max, kind]] of Object.entries(FLOORS)) {
    assert.deepEqual(DOCTRINE_BOUNDS[f], { kind, min, max }, f);
    assert.equal(boundProblem(f, min), null, `${f}: the owner's starting value`);
    assert.match(boundProblem(f, kind === "integer" ? min - 1 : min - 0.1)!, /outside/, `${f}: never looser than the owner's start`);
  }
  const adr = read("architecture/adr/0021-self-improvement-protocol.md");
  assert.match(adr, /^- \*\*Status:\*\* Accepted \(owner, 2026-11-20: "3\. All protocols live"/m);
  assert.match(adr, /No AI approves a strategy or rule it proposed\. Every candidate passes an independent, deterministic validator, and no model call takes part in the verdict\./);
  assert.match(adr, /"Sekarang breakglass urgent jadi langsung live"/);
});
