# Mizan Revised/2 (`mizan-revised/2`, ADR-0005 Decision 11) — Behavioral Review

**Last Reviewed:** 2026-11-05  
**Implementation:** [`workers/signal-engine/src/revised.ts`](../workers/signal-engine/src/revised.ts)  
**Test Suite:** [`workers/control-plane-shared/test/revised.test.ts`](../workers/control-plane-shared/test/revised.test.ts)  
**Comparison Tool:** [`tools/parity/compare_revised.ts`](../tools/parity/compare_revised.ts)

---

## 1. Implemented formulas (verified against source)

The revised router is dimensionless and symmetric in the tested rising/falling cases. The exact implementation is:

**Known neutral-direction edge case:** `dimensionScaled` currently maps `kwwMom === 0` to `trend_direction = 1`, and `mizanSymbol` treats a weighted direction of exactly `0.5` as `long`. The signal threshold still gates whether a signal is emitted, but the direction label itself is not neutral at exact zero momentum. The current tests cover positive/negative drift symmetry, not this zero-momentum label. This is a separate Mizan behavior fix and is not changed by TP-011.

- **Dimension weights** (`DIM_WEIGHTS`): direction `0.30`, momentum `0.30`, strength `0.25`, cycle `0.10`, volume `0.05`. They sum to `1.00`.
- **Direction component:** `1.0` when KWW momentum and log-return drift have the same sign, `0.5` when either is zero, and `0.0` when their signs disagree.
- **Momentum component:** `clamp01(abs(kwwMom) / (stdev(kwwMomentumHistory) * FULL_SCORE_Z))`. The history is the sequence of prefix KWW-momentum values inside the current window; `FULL_SCORE_Z = 2`. When that standard deviation is zero, a non-zero current momentum scores `1`, otherwise `0`.
- **Trend-strength component:** `clamp01(abs(log(lastClose / firstClose)) / (stdev(logReturns) * sqrt(n - 1) * FULL_SCORE_Z))`, with the zero-volatility fallback implemented in `dimensionScaled`.
- **Cycle component:** `1 - abs(((candlesSinceSignal % K.BASE) / K.BASE) - 0.5) * 2`; `K.BASE` is the source constant, not a per-symbol fitted value.
- **Volume component:** `clamp01(lastVolume / median(alignedVolumeWindow) / FULL_SCORE_Z)`. The last `n` samples must be aligned, finite and non-negative; an invalid or short window, or a zero median, scores `0`. No older-volume fallback is used.

The symbol-level `phi` is the timeframe-weighted mean of `dim_score`, multiplied by the revised regime score. `signalTier` labels are `neutral`, `weak`, `standard`, `strong`, and `extreme`; these are Mizan signal labels, **not** ADR-0007 agent autonomy tiers. The `decisionRevised` function independently applies raw-confluence thresholds BUY `>= 62` and SELL `<= 38`.

Entropy is the normalized 10-bin Shannon entropy of log returns. The 1h threshold is the 95th percentile of rolling `REGIME.WINDOW` entropies when at least 30 windows exist; otherwise the implementation falls back to the source threshold `0.92` (`calibrated = false`).

---

## 2. Test evidence (synthetic inputs, not production parity)

The current unit tests use deterministic synthetic series. They establish the following and no more:

| Scenario | Test evidence | What is not established |
|---|---|---|
| Rising and falling drift (`+0.4%` / `-0.4%` per candle) | Trend-strength difference is below `0.15`; dimension-score difference is below `0.20`; direction flags are opposite. | Exact equality or TradingView parity. |
| Strong synthetic uptrend (`+1%` log drift per candle) with a 2x latest-volume sample | With an injected `regime_score = 0.8`, the test asserts `dim_score > 0.75`, `phi >= 0.60`, and `signal = true`. | Hurst/entropy behavior for that same series; the test injects the regime score rather than deriving it from a production history. |
| Flat volume | `volume_score = 0.50` when the latest sample equals the median. | A fixed `phi` range; none is asserted. |
| Missing, short, negative or non-finite volume sample | The volume component fails closed to `0`; no older sample is substituted. | Any claim that the entire signal is neutral solely because volume is invalid. |
| Short entropy-calibration history | A 60-close series has fewer than 30 rolling windows, so calibration is false and the fallback threshold is `0.92`; fewer than 20 closes returns no regime. | A committed `walk_140` chaotic fixture. No such fixture is asserted by the current revised test suite. |

Risk levels and `suggested_size_pct` are advisory outputs only. They are not orders, broker instructions, or execution authorization. No trading or fund-moving capability is introduced.

---

## 3. Production validation and parity boundary

The unit tests above are synthetic regression tests. They do **not** establish historical parity with TradingView or prove that production distributions match the legacy router.

The comparison tool [`compare_revised.ts`](../tools/parity/compare_revised.ts) requires exported 1h/4h closes and aligned per-candle volume arrays for BTCUSDT, ETHUSDT and SOLUSDT. It deliberately rejects scalar-volume fallbacks. A production parity claim requires:
1. a dated D1 export with source and candle-close provenance;
2. aligned 1h/4h volume arrays;
3. captured legacy and revised outputs for the same windows; and
4. a reviewed comparison of dimensions, regime, `phi`, tier, direction and decision.

Until that evidence is attached and reviewed, describe `mizan-revised/2` as the owner-authorized deterministic revision with synthetic regression coverage, **not as TradingView parity**.

---

## 4. Multi-day production monitoring checklist

As closed 1h and 4h candles accumulate in D1 (`market_candles` and `signal_confluence`):

1. Verify `implementation = 'mizan-revised/2'` on new rows and confirm every stored `dim_score` is in `[0, 1]`.
2. Monitor `agent_reports` only after the relevant caller binding is deployed and the agent is actually able to publish; a registered/enabled D1 row alone does not prove invocation.
3. Export 100-candle 1h/4h windows with aligned `vols1h` and `vols4h_desc`, then run:

   ```bash
   node --experimental-strip-types tools/parity/compare_revised.ts prod.json
   ```

4. Record the export provenance, exact commit, candle-close times, output hashes and any distribution differences in a reviewed artifact.
