# Mizan Revised/2 (`mizan-revised/2`, ADR-0005 Decision 11) — Behavioral Review

**Last Reviewed:** 2026-11-05  
**Implementation:** [`workers/signal-engine/src/revised.ts`](../workers/signal-engine/src/revised.ts)  
**Test Suite:** [`workers/control-plane-shared/test/revised.test.ts`](../workers/control-plane-shared/test/revised.test.ts)  
**Comparison Tool:** [`tools/parity/compare_revised.ts`](../tools/parity/compare_revised.ts)

---

## 1. Summary of Changes in `mizan-revised/2` (Decision 11)

The legacy router (`mizan.ts`) suffered from two structural saturation issues on real multi-timeframe OHLCV series:
1. **Dimension Saturation & Asymmetry:** Raw price-denominated drift/momentum and unnormalized latest-candle volume prevented `dim_score` from reaching the `0.60` `phi` threshold reliably across assets with different nominal prices (`BTCUSDT` vs `ETHUSDT` vs `SOLUSDT`), while biasing `direction` toward long-only trends.
2. **Latest-Volume Fallback Masking:** When a candle window lacked aligned per-candle volume history or contained an invalid latest sample (`NaN`/missing), re-using an older candle's scalar volume hid data degradation.

`mizan-revised/2` (`revised.ts`) resolves both issues deterministically:
- **Dimensionless, Symmetric 5-Component Router (`DIM_WEIGHTS`):**
  - `direction` (`0.25`): `1.0` whenever KWW stretched-exponential momentum (`kwwMom`) and log-return drift agree in sign (symmetric for both **long** and **short** trends), `0.5` when neutral, `0.0` when diverging.
  - `momentum` (`0.25`): `clamp01(|kwwMom| / (volatility * FULL_SCORE_Z))` (`FULL_SCORE_Z = 2`).
  - `strength` (`0.20`): `clamp01(|drift| / volatility * sqrt(n) / FULL_SCORE_Z)` (t-statistic scaled).
  - `cycle` (`0.15`): `1 - |((candlesSinceSignal % 19) / 19 - 0.5) * 2|`.
  - `volume` (`0.15`): `clamp01((lastVol / median(volumeWindow)) / FULL_SCORE_Z)`.
- **Fail-Closed Volume Window Alignment:**
  - `dimensionScaled` requires `volumeWindow.length === n` where every sample is finite and `>= 0`.
  - If the window is shorter than `n` or the latest sample is `NaN`/negative, `volume_score` fails closed to `0` (never substituting an older candle's volume).

---

## 2. Quantitative Behavior Across Regimes

| Regime / Scenario | Hurst (`H`) | Entropy (`S`) | Volume Profile | `volume_score` | Composite `phi` | Tier / Action Behavior |
|---|---|---|---|---|---|---|
| **Strong Consistent Uptrend (`+1%/bar` + 2x Volume Spike)** | `> 0.65` (Persistent) | Low (`< 0.65`) | `lastVol = 2.0 * median` | `1.00` | `>= 0.60` | Reaches `tier >= 2` (`LONG` advisory bias, Bismillah sizing active) |
| **Strong Consistent Downtrend (`-1%/bar` + 2x Volume Spike)** | `> 0.65` (Persistent) | Low (`< 0.65`) | `lastVol = 2.0 * median` | `1.00` | `>= 0.60` | Symmetric `dim_score` with uptrend; emits `SHORT` advisory bias when `confluence < 50` |
| **Trending Price with Flat Volume (`lastVol == median`)** | `> 0.60` | Moderate | Constant volume | `0.50` | Moderate (`0.55–0.68`) | Requires stronger trend/regime alignment to cross `phi >= 0.60` |
| **Missing / Misaligned / `NaN` Latest Volume** | Any | Any | `length != n` or `NaN` | **`0.00` (Fail-Closed)** | Reduced by `0.15 * weight` | Fails closed on volume component; prevents false breakout confirmation |
| **High-Entropy Chaotic Walk (`walk_140` fixture)** | `~0.456` | `~0.943` | Normal | `<= 0.50` | `< 0.60` | `regime_zone = chaotic`, `tier = 0` (`WAIT` / no advisory risk levels) |

---

## 3. Ongoing Multi-Day Production Monitoring Checklist

As live `1h` and `4h` closed candles accumulate in D1 (`market_candles` and `signal_confluence`):
1. **Verify `implementation = 'mizan-revised/2'` in D1:** Confirm new rows in `signal_confluence` record `mizan_json` with dimensionless `dim_score` in `[0, 1]`.
2. **Check Signal Analyst Hourly Digest (`agent_reports` where `kind = 'signal_digest'`):** Monitor how often `BTCUSDT`, `ETHUSDT`, and `SOLUSDT` cross `phi >= 0.60` (expected only during genuine persistent regime + volume expansion, not in choppy/chaotic windows).
3. **Run Parity Comparison (`tools/parity/compare_revised.ts`):** Export 100-candle `1h` and `4h` windows with aligned `vols1h` and `vols4h_desc` arrays from D1 and execute:
   ```bash
   node --experimental-strip-types tools/parity/compare_revised.ts prod.json
   ```
   to compare legacy vs. `mizan-revised/2` tier distributions over the multi-day sample.
