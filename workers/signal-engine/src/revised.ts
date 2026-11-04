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
 */
import { pairwiseSum, round } from "./indicators.ts";
import {
  K, REGIME, SL_ATR, TP_ATR, classifyRegime, cyclePhase, dimension, hurstRs, kwwMemory, positionSizePct, regimeScore,
  shannonEntropy, signalRank, signalTier, timeframeWeight, type Dimension,
} from "./mizan.ts";

export const FORMULAS = "mizan-revised/1 (ADR-0005 decision 10)";
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

/** Per-timeframe Mizan dimensions with the revised KWW. */
export function mizanTimeframe(closes: number[], volume: number, timeframe: string): Dimension & { kww_close: number; kww_momentum: number; tf_weight: number } {
  const window = closes.slice(-REGIME.WINDOW);
  const kwwClose = kwwMaRecent(window);
  const kwwMom = kwwMomentumRecent(window);
  const d = dimension(kwwClose, volume, kwwMom, Math.max(window.length - 1, 0), window);
  return { ...d, kww_close: kwwClose, kww_momentum: kwwMom, tf_weight: timeframeWeight(timeframe) };
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
    max_dim_score: 0.6667, // the router's dimension weights sum to 0.6667
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
