import { test } from "node:test";
import assert from "node:assert/strict";
import { decision, kwwMa, kwwMemory } from "../../signal-engine/src/mizan.ts";
import {
  calibrateEntropyMax, decisionRevised, kwwMaRecent, kwwMomentumRecent, mizanSymbol, mizanTimeframe, dimensionScaled, DIM_WEIGHTS, percentile, regimeRevised, returnEntropy,
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
  const vols = up.map(() => 5e6);
  const perTf = { "1h": mizanTimeframe(up, vols, "1h"), "4h": mizanTimeframe(up, vols, "4h") };
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

test("5. decision 11: dimensions are dimensionless, symmetric and can reach the signal threshold", () => {
  assert.ok(Math.abs(Object.values(DIM_WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-12, "weights sum to 1");
  // Deterministic pseudo-random walk (LCG) with an optional drift per candle.
  const walk = (drift: number, seed = 7) => {
    let x = seed; const out = [100];
    for (let i = 1; i < 100; i++) { x = (x * 1103515245 + 12345) % 2147483648; out.push(out[i - 1] * Math.exp(drift + ((x / 2147483648) - 0.5) * 0.02)); }
    return out;
  };
  const flatVol = Array(100).fill(10);
  const noise = dimensionScaled(walk(0), flatVol, 99);
  const up = dimensionScaled(walk(0.004), flatVol, 99);
  const down = dimensionScaled(walk(-0.004), flatVol, 99);
  assert.ok(up.trend_strength > noise.trend_strength, "a drifting series scores a stronger trend than noise");
  assert.ok(Math.abs(up.trend_strength - down.trend_strength) < 0.15, "rising and falling trends of equal size score alike");
  assert.ok(Math.abs(up.dim_score - down.dim_score) < 0.2, "the score no longer favours rising markets only");
  assert.equal(up.trend_direction, 1);
  assert.equal(down.trend_direction, 0);
  // Price level does not matter: the same shape at 1/1000 of the price scores the same.
  const scaled = dimensionScaled(walk(0.004).map((c) => c / 1000), flatVol, 99);
  assert.ok(Math.abs(scaled.dim_score - up.dim_score) < 1e-9, "dimensionless: independent of the price level");
  // Volume relative to its own median: 2x the median earns the full volume score.
  const spike = [...Array(99).fill(10), 20];
  assert.equal(dimensionScaled(walk(0.004), spike, 99).volume_score, 1);
  assert.equal(dimensionScaled(walk(0.004), flatVol, 99).volume_score, 0.5);
  // A strong, consistent trend can now reach the 0.60 signal threshold with a good regime.
  const strong = walk(0.01);
  const per = { "1h": mizanTimeframe(strong, spike, "1h") };
  const m = mizanSymbol(per, { regime_score: 0.8 } as never, strong.at(-1)!, 1)!;
  assert.ok((per["1h"].dim_score) <= 1 && per["1h"].dim_score > 0.75, `dim ${per["1h"].dim_score}`);
  assert.ok((m.phi as number) >= 0.6 && m.signal === true, `phi ${m.phi}`);
  assert.equal(m.max_dim_score, 1);
});
