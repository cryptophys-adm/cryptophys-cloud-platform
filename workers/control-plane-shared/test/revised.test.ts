import { test } from "node:test";
import assert from "node:assert/strict";
import { decision, kwwMa, kwwMemory } from "../../signal-engine/src/mizan.ts";
import {
  calibrateEntropyMax, decisionRevised, kwwMaRecent, kwwMomentumRecent, mizanSymbol, mizanTimeframe, percentile, regimeRevised, returnEntropy,
} from "../../signal-engine/src/revised.ts";

test("1. KWW weights decay from the newest close (the source weighted the oldest highest)", () => {
  const rising = Array.from({ length: 50 }, (_, i) => 100 + i);
  assert.ok(kwwMaRecent(rising) > kwwMa(rising), "recent closes now dominate");
  const s = [10, 20, 30];
  const w = [kwwMemory(2), kwwMemory(1), kwwMemory(0)];
  assert.ok(Math.abs(kwwMaRecent(s) - (10 * w[0] + 20 * w[1] + 30 * w[2]) / (w[0] + w[1] + w[2])) < 1e-12);
  assert.ok(kwwMomentumRecent(rising) > 0 && kwwMomentumRecent([...rising].reverse()) < 0, "momentum sign follows the recent move");
  assert.equal(kwwMaRecent([]), 0);
});

test("2. regime entropy is measured on log returns and gated at a calibrated 95th percentile", () => {
  assert.equal(returnEntropy([1, 2]), null);
  assert.equal(returnEntropy([1, 0, 2]), null);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([0, 10], 0.95), 9.5);
  // Price levels of a steady trend look maximally "spread"; their returns do not.
  let p = 100;
  const trend = Array.from({ length: 400 }, (_, i) => (p *= 1 + 0.002 + 0.0004 * Math.sin(i)));
  const cal = calibrateEntropyMax(trend);
  assert.equal(cal.calibrated, true);
  assert.equal(cal.windows, 301);
  const r = regimeRevised(trend)!;
  assert.equal(r.entropy_basis, "log_returns");
  assert.ok(r.entropy! <= r.entropy_max || r.regime_zone === "chaotic");
  const short = regimeRevised(trend.slice(0, 60))!;
  assert.deepEqual([short.entropy_calibrated, short.entropy_max], [false, 0.92], "too little history keeps the source threshold");
  assert.equal(regimeRevised(trend.slice(0, 19)), null);
});

test("3. phi mixes timeframes by weight, so it is no longer capped by the timeframe weight", () => {
  const up = Array.from({ length: 100 }, (_, i) => 100 * Math.exp(i * 0.01));
  const perTf = { "1h": mizanTimeframe(up, 5e6, "1h"), "4h": mizanTimeframe(up, 5e6, "4h") };
  const regime = { regime_score: 1 } as never;
  const m = mizanSymbol(perTf, regime, 270, 2)!;
  const expected = (0.2001 * perTf["1h"].dim_score + 0.0652 * perTf["4h"].dim_score) / (0.2001 + 0.0652);
  assert.ok(Math.abs((m.phi as number) - expected) < 1e-8);
  assert.ok((m.phi as number) > 0.40, "the source capped phi at the timeframe weight (<= 0.40)");
  assert.equal(m.direction_bias, "long");
  if (m.signal) {
    const lv = m.advisory_risk_levels!;
    assert.ok(lv.stop_loss! < 270 && lv.take_profit! > 270);
    assert.equal(lv.note, "advisory only; not an order");
  }
  assert.equal(mizanSymbol(perTf, null, 270, 2)!.phi, 0, "no regime means no signal (the source assumed 1.0)");
  assert.equal(mizanSymbol({}, regime, 270, 2), null);
});

test("4. the decision is symmetric on the raw score (the source scaled by 0.65 first)", () => {
  assert.equal(decisionRevised(62).action, "BUY");
  assert.equal(decisionRevised(38).action, "SELL");
  assert.equal(decisionRevised(50).action, "NEUTRAL");
  assert.equal(decision(58).action, "SELL", "source: a mildly bullish 58 became SELL (58 * 0.65 = 37.7)");
  assert.equal(decision(80).action, "NEUTRAL", "source: a clearly bullish 80 was NEUTRAL");
  assert.equal(decisionRevised(80).bias, "bullish");
  assert.deepEqual([decisionRevised(80).expected_value, decisionRevised(80).kelly_sizing], [0.95, 0.1188]);
  assert.equal(decisionRevised(20).confidence, 0.6);
});
