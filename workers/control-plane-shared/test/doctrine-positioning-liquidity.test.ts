// xauusd's Positioning & Liquidity analyst (#505), live on merge as a breakglass under ADR-0021 (owner, in the xauusd
// session: "Sekarang breakglass urgent jadi langsung live"): Aether moves its knobs inside these hard bounds. The table is
// xauusd's (relay 2026-11-20 10:13): fact -> [kind, min, max, start]; every start sits inside its bound.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCTRINE_BOUNDS, boundProblem, doctrineActionFor } from "../src/doctrine.ts";

const TABLE: Record<string, ["number" | "integer", number, number, number]> = {
  "positioning.de_weight_scalp": ["number", 0.02, 0.04, 0.02],
  "positioning.de_weight_intraday": ["number", 0.02, 0.06, 0.03],
  "positioning.de_weight_swing": ["number", 0.02, 0.1, 0.05],
  "positioning.de_weight_range": ["number", 0.02, 0.05, 0.03],
  "positioning.crowd_pctl_scalp": ["number", 0.8, 0.95, 0.9],
  "positioning.crowd_pctl_intraday": ["number", 0.8, 0.95, 0.9],
  "positioning.crowd_pctl_swing": ["number", 0.8, 0.95, 0.9],
  "positioning.crowd_pctl_range": ["number", 0.8, 0.95, 0.9],
  "positioning.flow_z_scalp": ["number", 0.5, 2.0, 1.0],
  "positioning.flow_z_intraday": ["number", 0.5, 2.0, 1.0],
  "positioning.flow_z_swing": ["number", 0.5, 2.0, 1.0],
  "positioning.flow_z_range": ["number", 0.5, 2.0, 1.0],
  "liquidity.council_weight_scalp": ["number", 0, 0.8, 0.4],
  "liquidity.council_weight_intraday": ["number", 0, 0.6, 0.3],
  "liquidity.council_weight_swing": ["number", 0, 0.4, 0.2],
  "liquidity.council_weight_range": ["number", 0, 0.6, 0.3],
  "liquidity.spike_pctl_scalp": ["number", 0.9, 0.99, 0.95],
  "liquidity.spike_pctl_intraday": ["number", 0.9, 0.99, 0.95],
  "liquidity.spike_pctl_swing": ["number", 0.9, 0.99, 0.97],
  "liquidity.spike_pctl_range": ["number", 0.9, 0.99, 0.95],
  "liquidity.thin_pctl_scalp": ["number", 0.05, 0.3, 0.2],
  "liquidity.thin_pctl_intraday": ["number", 0.05, 0.3, 0.2],
  "liquidity.thin_pctl_swing": ["number", 0.05, 0.3, 0.2],
  "liquidity.thin_pctl_range": ["number", 0.05, 0.3, 0.2],
  "liquidity.spread_widen_scalp": ["number", 1.5, 4.0, 1.8],
  "liquidity.spread_widen_intraday": ["number", 1.5, 4.0, 2.0],
  "liquidity.spread_widen_swing": ["number", 1.5, 4.0, 2.5],
  "liquidity.spread_widen_range": ["number", 1.5, 4.0, 2.0],
  "liquidity.sweep_lookback_min_scalp": ["integer", 30, 120, 60],
  "liquidity.sweep_lookback_min_intraday": ["integer", 60, 360, 180],
  "liquidity.sweep_lookback_min_swing": ["integer", 240, 1440, 720],
  "liquidity.sweep_lookback_min_range": ["integer", 60, 360, 180],
  "liquidity.pool_tol_atr_scalp": ["number", 0.02, 0.15, 0.05],
  "liquidity.pool_tol_atr_intraday": ["number", 0.02, 0.15, 0.05],
  "liquidity.pool_tol_atr_swing": ["number", 0.02, 0.15, 0.08],
  "liquidity.pool_tol_atr_range": ["number", 0.02, 0.15, 0.05],
  "liquidity.hvn_pctl_scalp": ["number", 0.8, 0.95, 0.85],
  "liquidity.hvn_pctl_intraday": ["number", 0.8, 0.95, 0.85],
  "liquidity.hvn_pctl_swing": ["number", 0.8, 0.95, 0.85],
  "liquidity.hvn_pctl_range": ["number", 0.8, 0.95, 0.85],
  "liquidity.profile_window_min_scalp": ["integer", 120, 480, 240],
  "liquidity.profile_window_min_intraday": ["integer", 480, 2880, 1440],
  "liquidity.profile_window_min_swing": ["integer", 2880, 14400, 7200],
  "liquidity.profile_window_min_range": ["integer", 480, 2880, 1440],
  "positioning.score_floor": ["number", 0.4, 0.5, 0.45],
  "liquidity.score_floor": ["number", 0.4, 0.5, 0.45],
  "positioning.score_window": ["integer", 40, 200, 60],
  "liquidity.score_window": ["integer", 50, 300, 100],
};

test("PQ1. the 48 positioning.* and liquidity.* facts hold xauusd's bounds, and every start value is inside its bound", () => {
  const ours = Object.keys(DOCTRINE_BOUNDS).filter((f) => f.startsWith("positioning.") || f.startsWith("liquidity."));
  assert.deepEqual(ours.sort(), Object.keys(TABLE).sort());
  assert.equal(ours.length, 48, "11 per-mode facts x 4 modes, and 4 per lens");
  for (const [f, [kind, min, max, start]] of Object.entries(TABLE)) {
    assert.deepEqual(DOCTRINE_BOUNDS[f], { kind, min, max }, f);
    assert.equal(boundProblem(f, start), null, `${f}: the start value`);
    assert.match(boundProblem(f, max + 1)!, /outside/, `${f}: above its bound`);
    if (kind === "integer") assert.match(boundProblem(f, start + 0.5)!, /must be an integer/, f);
  }
  // A muted council weight is allowed; the Decision Engine share never drops to 0 nor passes its mode's cap.
  assert.equal(boundProblem("liquidity.council_weight_swing", 0), null);
  assert.match(boundProblem("positioning.de_weight_swing", 0)!, /outside 0.02-0.1/);
  assert.match(boundProblem("positioning.de_weight_scalp", 0.05)!, /outside 0.02-0.04/);
  assert.equal(doctrineActionFor(["positioning.flow_z_range", "liquidity.score_window"], false), "amend_doctrine");
});

test("PQ2. no positioning or liquidity fact name carries a word the Policy Engine prohibits", () => {
  for (const f of Object.keys(TABLE)) assert.doesNotMatch(f, /trad(e|ing)\b|order|wallet|withdraw|transfer|swap/, f);
});
