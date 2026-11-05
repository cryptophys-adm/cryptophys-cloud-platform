/**
 * Revised Mizan and decision formulas (owner decision 2026-11-04, ADR-0005 decision 10).
 *
 * The faithful ports in mizan.ts stay unchanged and parity-tested; they document what the
 * original code did. Production uses these revisions:
 *  1. KWW memory weights decay with lag from the NEWEST candle (the source gave the oldest
 *     candle weight 1).
 *  2. Regime entropy is measured on log returns, not price levels, and its gate threshold is
 *     calibrated per symbol as the 95th percentile of rolling-window entropies of the stored
 *     1h history (the source used a fixed 0.92 against price-level entropy).
 *  3. Mizan phi is computed once per symbol across timeframes:
 *     phi = (sum w_tf * dim_tf / sum w_tf) * regime_score, using the source's timeframe weights
 *     as mixing weights (the source multiplied each timeframe's dim by its weight, capping phi
 *     at 0.40).
 *  4. The decision applies BUY >= 62 / SELL <= 38 to the raw confluence score; the 0.65 base
 *     rate is the BUY win probability in EV/Kelly, as the source's own per-action win
 *     probabilities already were (the source also scaled the score by 0.65, biasing it bearish).
 *  5. (decision 11, owner 2026-11-05: "skala ulang mizan") The router's dimensions are rescaled
 *     to be dimensionless and comparable across assets: momentum and trend strength are z-scores
 *     against the series' own volatility, volume is relative to its median, direction scores
 *     agreement between momentum and trend (symmetric for long and short), and the source
 *     weights are normalised to sum to 1. The source divided by the raw price, so momentum and
 *     volume sat near 1e-4, dim_score could not exceed 0.667, and only rising markets scored.
 */
import { pairwiseSum, round } from "./indicators.ts";
import {
  K, REGIME, SL_ATR, TP_ATR, classifyRegime, cyclePhase, hurstRs, kwwMemory, positionSizePct, regimeScore,
  shannonEntropy, signalRank, signalTier, timeframeWeight, type Dimension,
} from "./mizan.ts";

export const FORMULAS = "mizan-revised/2 (ADR-0005 decisions 10 and 11)";
export const ENTROPY_PERCENTILE = 0.95;
const MIN_CALIBRATION_WINDOWS = 30;

/** 1. KWW-weighted average with lag measured from the newest value. */
export function kwwMaRecent(series: number[]): number {
  if (!series.length) return 0;
  const n = series.length;
  let ws = 0;
  let s = 0;
  series.forEach((p, i) => { const w = kwwMemory(n - 1 - i); ws += p * w; s += w; });
  return s === 0 ? 0 : ws / s;
}
export const kwwMomentumRecent = (series: number[]): number => (series.length < 2 ? 0 : kwwMaRecent(series) - kwwMaRecent(series.slice(0, -1)));

/** 2. Shannon entropy (10 bins, normalised to [0, 1]) of log returns. */
export function returnEntropy(closes: number[]): number | null {
  if (closes.length < 3 || closes.some((c) => !(c > 0))) return null;
  const r = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  return shannonEntropy(r);
}

/** numpy.percentile with linear interpolation. */
export function percentile(values: number[], q: number): number {
  const v = [...values].sort((a, b) => a - b);
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

/** Per-symbol entropy gate: 95th percentile of rolling REGIME.WINDOW entropies over the 1h history. */
export function calibrateEntropyMax(closes1h: number[]): { entropy_max: number; windows: number; calibrated: boolean } {
  const ents: number[] = [];
  for (let end = REGIME.WINDOW; end <= closes1h.length; end++) {
    const e = returnEntropy(closes1h.slice(end - REGIME.WINDOW, end));
    if (e !== null) ents.push(e);
  }
  if (ents.length < MIN_CALIBRATION_WINDOWS) return { entropy_max: REGIME.ENTROPY_MAX, windows: ents.length, calibrated: false };
  return { entropy_max: percentile(ents, ENTROPY_PERCENTILE), windows: ents.length, calibrated: true };
}

export interface RegimeRevised {
  hurst: number; entropy: number | null; entropy_basis: "log_returns"; entropy_max: number; entropy_calibrated: boolean;
  calibration_windows: number; regime_score: number; regime_zone: string; cycle_phase_19: number; cycle_phase_14: number;
}

export function regimeRevised(closes1hAll: number[]): RegimeRevised | null {
  const closes = closes1hAll.slice(-REGIME.WINDOW);
  if (closes.length < 20) return null;
  const h = hurstRs(closes);
  const e = returnEntropy(closes);
  const cal = calibrateEntropyMax(closes1hAll);
  const chaotic = e === null || e > cal.entropy_max;
  return {
    hurst: round(h, 6)!,
    entropy: e === null ? null : round(e, 6),
    entropy_basis: "log_returns",
    entropy_max: round(cal.entropy_max, 6)!,
    entropy_calibrated: cal.calibrated,
    calibration_windows: cal.windows,
    regime_score: round(chaotic ? 0 : regimeScore(h), 6)!,
    regime_zone: chaotic ? "chaotic" : classifyRegime(h),
    cycle_phase_19: cyclePhase(closes, 19),
    cycle_phase_14: cyclePhase(closes, REGIME.TAU),
  };
}

/** 5. Source weights (0.20, 0.20, 0.1667, 0.0667, 0.0333) normalised to sum to 1. */
export const DIM_WEIGHTS = { direction: 0.30, momentum: 0.30, strength: 0.25, cycle: 0.10, volume: 0.05 } as const;
/** A z-score of this size (or a 2x median volume) earns the full dimension score. */
export const FULL_SCORE_Z = 2;

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(Math.max(x, 0), 1) : 0);
function stdev(x: number[]): number {
  if (x.length < 2) return 0;
  const m = pairwiseSum(x) / x.length;
  return Math.sqrt(pairwiseSum(x.map((v) => (v - m) ** 2)) / (x.length - 1));
}
function median(x: number[]): number {
  const v = [...x].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** 5. Dimensionless Mizan dimensions for one timeframe window (closes and volumes ascending). */
export function dimensionScaled(window: number[], volumes: number[], candlesSinceSignal: number): Dimension & { kww_close: number; kww_momentum: number } {
  const kwwClose = kwwMaRecent(window);
  const kwwMom = kwwMomentumRecent(window);
  const n = window.length;
  const valid = n >= 3 && window.every((c) => c > 0);
  const returns = valid ? window.slice(1).map((c, i) => Math.log(c / window[i])) : [];
  const sigma = stdev(returns);
  // Momentum: today's KWW momentum against the spread of its own history over the window.
  const history: number[] = [];
  for (let end = 3; end <= n; end++) history.push(kwwMomentumRecent(window.slice(0, end)));
  const momSigma = stdev(history);
  const momentum_score = momSigma > 0 ? clamp01(Math.abs(kwwMom) / momSigma / FULL_SCORE_Z) : (kwwMom !== 0 ? 1 : 0);
  // Trend strength: the window's log return against a random walk's sigma * sqrt(n - 1).
  const drift = valid ? Math.log(window[n - 1] / window[0]) : 0;
  const trend_strength = sigma > 0 ? clamp01(Math.abs(drift) / (sigma * Math.sqrt(n - 1)) / FULL_SCORE_Z) : (drift !== 0 ? 1 : 0);
  // Direction: momentum agreeing with the trend scores in either direction (long or short).
  const agreement = kwwMom === 0 || drift === 0 ? 0.5 : Math.sign(kwwMom) === Math.sign(drift) ? 1 : 0;
  const cycle_score = 1 - Math.abs((candlesSinceSignal % K.BASE) / K.BASE - 0.5) * 2;
  const vols = volumes.slice(-n).filter((v) => Number.isFinite(v) && v >= 0);
  const med = vols.length ? median(vols) : 0;
  const lastVol = vols.at(-1) ?? 0;
  const volume_score = med > 0 ? clamp01(lastVol / med / FULL_SCORE_Z) : 0;
  const dim_score = clamp01(
    agreement * DIM_WEIGHTS.direction + momentum_score * DIM_WEIGHTS.momentum + trend_strength * DIM_WEIGHTS.strength
    + cycle_score * DIM_WEIGHTS.cycle + volume_score * DIM_WEIGHTS.volume,
  );
  return {
    dim_score, trend_direction: kwwMom >= 0 ? 1 : 0, momentum_score, trend_strength, cycle_score, volume_score,
    kww_close: kwwClose, kww_momentum: kwwMom,
  };
}

/** Per-timeframe Mizan dimensions with the revised KWW and the rescaled router (decision 11). */
export function mizanTimeframe(closes: number[], volumes: number[], timeframe: string): Dimension & { kww_close: number; kww_momentum: number; tf_weight: number } {
  const window = closes.slice(-REGIME.WINDOW);
  const d = dimensionScaled(window, volumes.slice(-REGIME.WINDOW), Math.max(window.length - 1, 0));
  return { ...d, tf_weight: timeframeWeight(timeframe) };
}

/** 3. Symbol-level phi across timeframes, tier/rank/size and advisory risk levels (never orders). */
export function mizanSymbol(perTf: Record<string, Dimension & { tf_weight: number }>, regime: RegimeRevised | null, close: number | null, atr14: number | null) {
  const tfs = Object.keys(perTf);
  if (!tfs.length) return null;
  const wsum = pairwiseSum(tfs.map((tf) => perTf[tf].tf_weight));
  const dim = pairwiseSum(tfs.map((tf) => perTf[tf].tf_weight * perTf[tf].dim_score)) / wsum;
  const dir = pairwiseSum(tfs.map((tf) => perTf[tf].tf_weight * perTf[tf].trend_direction)) / wsum;
  const regimeValue = regime?.regime_score ?? 0; // revised: no regime means no signal, not a free 1.0
  const phi = Math.min(Math.max(dim * regimeValue, 0), 1);
  const rank = signalRank(phi);
  const signal = phi >= K.CONFIDENCE;
  const direction = dir >= 0.5 ? "long" : "short";
  const sl = atr14 === null || close === null ? null : atr14 * SL_ATR;
  return {
    formulas: FORMULAS,
    timeframes: Object.fromEntries(tfs.map((tf) => [tf, { tf_weight: perTf[tf].tf_weight, dim_score: round(perTf[tf].dim_score, 8) }])),
    dim_score: round(dim, 8),
    max_dim_score: 1, // decision 11: the weights are normalised to sum to 1
    regime,
    phi: round(phi, 8),
    signal_tier: signalTier(phi),
    signal_rank: rank,
    signal,
    direction_bias: direction,
    position_size_pct: round(positionSizePct(rank), 6),
    advisory_risk_levels: signal && sl !== null && close !== null ? {
      direction,
      reference_close: close,
      stop_loss: round(direction === "long" ? close - sl : close + sl, 6),
      take_profit: round(direction === "long" ? close + sl * K.PHI : close - sl * K.PHI, 6),
      sl_atr: SL_ATR,
      tp_atr: round(TP_ATR, 10),
      suggested_size_pct: round(positionSizePct(rank), 6),
      note: "advisory only; not an order",
    } : null,
  };
}

/** 4. Symmetric decision on the raw confluence score. */
export function decisionRevised(score: number) {
  let action = score >= 62.0 ? "BUY" : score <= 38.0 ? "SELL" : "NEUTRAL";
  const winProb = action === "BUY" ? 0.65 : action === "SELL" ? 0.62 : 0;
  const ev = winProb * 2.0 + (1 - winProb) * -1.0;
  if (action !== "NEUTRAL" && ev <= 0) action = "NEUTRAL";
  const kelly = action !== "NEUTRAL" ? Math.max(0, ((winProb * 2.0 - (1 - winProb)) / 2.0) * 0.25) : 0;
  return {
    formulas: FORMULAS,
    action,
    bias: action === "BUY" ? "bullish" : action === "SELL" ? "bearish" : "neutral",
    confidence: round(Math.abs(score - 50) / 50, 4),
    confluence_score: score,
    expected_value: round(ev, 4),
    kelly_sizing: round(kelly, 4),
    thresholds: { buy: 62, sell: 38 },
    advisory_only: true,
  };
}
