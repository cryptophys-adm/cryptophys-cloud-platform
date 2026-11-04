import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  K, SL_ATR, TP_ATR, decision, dimension, kwwMa, kwwMemory, kwwMomentum, mizan, positionSizePct, regime,
  signalRank, signalTier, tfConfluence, timeframeWeight, SCORERS, CATEGORIES,
} from "../../signal-engine/src/mizan.ts";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const rust = load("mizan-parity.json"); // compiled from the recovered Rust (tools/parity/mizan-fixtures)
const py = load("legacy-parity.json"); // recovered Python (tools/parity/legacy_fixtures.py)
const close = (a: number, b: number, tol = 1e-12) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test("KWW constants and kernel match the compiled Rust", () => {
  for (const [k, v] of Object.entries(rust.constants)) {
    if (k === "sl_atr") close(SL_ATR, v as number);
    else if (k === "tp_atr") close(TP_ATR, v as number);
    else close((K as Record<string, number>)[k], v as number, 0);
  }
  for (const c of rust.kww) {
    close(kwwMa(c.window), c.kww_close);
    close(kwwMomentum(c.window), c.kww_momentum, 1e-9);
    close(kwwMemory(c.candles_since_signal), c.memory_weight);
    for (const [tf, want] of Object.entries(c.tf) as [string, { tf_score: number; dim: number[] }][]) {
      close(timeframeWeight(tf), want.tf_score, 0);
      const d = dimension(c.kww_close, c.volume, c.kww_momentum, c.candles_since_signal, c.window);
      [d.dim_score, d.trend_direction, d.momentum_score, d.trend_strength, d.cycle_score, d.volume_score].forEach((v, i) => close(v, want.dim[i]));
    }
  }
});

test("tier, rank and Bismillah sizing match the compiled Rust at every threshold", () => {
  for (const p of rust.phi) {
    assert.equal(signalTier(p.phi), p.tier, `tier ${p.phi}`);
    assert.equal(signalRank(p.phi), p.rank, `rank ${p.phi}`);
    close(positionSizePct(p.rank), p.size_pct);
  }
});

test("regime (Hurst R/S, histogram entropy, zone, cycle phase) matches the recovered Python", () => {
  for (const c of py.regime) {
    const r = regime(c.closes);
    if (c.closes.length < 20) { assert.equal(r, null); continue; }
    assert.ok(r, c.name);
    for (const k of ["hurst", "entropy", "regime_score"] as const) close(r![k], c[k], 1e-6);
    assert.equal(r!.regime_zone, c.regime_zone, c.name);
    close(r!.cycle_phase_19, c.cycle_phase_19, 0);
    close(r!.cycle_phase_14, c.cycle_phase_14, 0);
  }
});

test("multi-timeframe confluence and decision bias match the recovered Python", () => {
  const signal = load("signal-parity.json");
  const cases = Object.fromEntries(signal.cases.map((c: any) => [c.name, c]));
  for (const c of py.confluence) {
    const state: Record<string, Record<string, { ts: number; indicators: any }>> = {};
    for (const [tf, [name, ageS]] of Object.entries(c.layout) as [string, [string, number]][]) {
      const s = cases[name];
      const ind = { trend: { ...s.trend, close: s.candles.at(-1).c }, momentum: s.momentum, volatility: s.volatility, volume: s.volume, structure: s.structure };
      for (const cat of CATEGORIES) {
        (state[cat] ??= {})[tf] = { ts: py.now - ageS * 1000, indicators: ind[cat] };
        assert.equal(SCORERS[cat](ind[cat]), c.scores[tf][cat], `${c.name}.${tf}.${cat}`);
      }
    }
    const conf = tfConfluence(state, py.now);
    if (!c.confluence) { assert.equal(conf, null, c.name); continue; }
    assert.deepEqual([conf!.confluence_score, conf!.tf_scores], [c.confluence.confluence_score, c.confluence.tf_scores], c.name);
    const d = decision(conf!.confluence_score);
    for (const k of ["action", "confidence", "confluence_score", "expected_value", "kelly_sizing", "weights"]) {
      assert.deepEqual((d as any)[k], c.decision[k], `${c.name}.${k}`);
    }
  }
});

test("advisory risk levels exist only where the source would emit a signal (phi >= 0.60)", () => {
  const closes = Array.from({ length: 120 }, (_, i) => 2000 + i);
  const r = regime(closes);
  const out = mizan(closes, 1000, "1h", r, 2119, 12);
  assert.ok((out.phi as number) <= timeframeWeight("1h"), "phi cannot exceed the timeframe weight (ADR-0005 finding)");
  assert.deepEqual([out.signal, out.advisory_risk_levels], [false, null]);
  const forced = mizan(closes, 1000, "5m", { ...r!, regime_score: 1 }, 2119, 12);
  assert.equal(forced.signal, false, "even with a perfect regime the 5m weight (0.40) keeps phi below 0.60");
});
