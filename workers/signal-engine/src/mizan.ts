/**
 * Mizan engines and signal-edge confluence, ported from apps-gitops (ADR-0005):
 *  - mizan-kww-engine (Rust lib.rs): KWW memory kernel and weighted average/momentum
 *  - mizan-dimension-router (Rust main.rs): dimension scores
 *  - mizan-regime (Python hurst.py): Hurst R/S, entropy, regime score/zone, cycle phase
 *  - mizan-confluence (Rust lib.rs/main.rs): phi, tier, rank, size, SL/TP multipliers
 *  - signal-edge tf_aggregator + decision_engine (Python): multi-timeframe confluence and bias
 *
 * Parity: tools/parity/mizan-fixtures (compiled recovered Rust) and tools/parity/legacy_fixtures.py
 * (recovered Python). Advisory only: risk levels are suggestions; nothing places orders.
 */
import { pairwiseSum, round, type Indicators } from "./indicators.ts";

// mizan-kww-engine lib.rs constants (compile-time; the KWW_* deployment env vars were unused).
export const K = {
  BETA: 0.577_350_269,
  TAU: 14.0,
  BASE: 19,
  PHI: 1.618_033_989,
  H_QURAN: 0.845_299,
  ATR_MULT: 3.050_8,
  MAX_ALLOC: 0.051_80,
  CONFIDENCE: 0.60,
} as const;

// mizan-regime settings from apps-gitops mizan__deployments.yaml.
export const REGIME = { H_QURAN: 0.8453, SIGMA: 0.15, ENTROPY_MAX: 0.92, WINDOW: 100, TAU: 14 } as const;

export const kwwMemory = (t: number): number => Math.exp(-Math.pow(t / K.TAU, K.BETA));

/** KWW-weighted average; index 0 (the oldest close) carries weight 1, as in the source. */
export function kwwMa(series: number[]): number {
  if (!series.length) return 0;
  let ws = 0;
  let s = 0;
  series.forEach((p, i) => { const w = kwwMemory(i); ws += p * w; s += w; });
  return s === 0 ? 0 : ws / s;
}

export const kwwMomentum = (series: number[]): number => (series.length < 2 ? 0 : kwwMa(series) - kwwMa(series.slice(0, -1)));

export function timeframeWeight(tf: string): number {
  return ({ "5m": 0.4018, "15m": 0.3313, "1h": 0.2001, "4h": 0.0652, "1d": 0.0016 } as Record<string, number>)[tf] ?? 0.05;
}

const bounded = (v: number) => Math.min(Math.max(v, 0), 1);

export interface Dimension { dim_score: number; trend_direction: number; momentum_score: number; trend_strength: number; cycle_score: number; volume_score: number }

/** mizan-dimension-router: scores from one KWW payload. */
export function dimension(kwwClose: number, kwwVolume: number, kwwMom: number, candlesSinceSignal: number, window: number[]): Dimension {
  const trend_direction = kwwMom >= 0 ? 1 : 0;
  const momentum_score = bounded(Math.min(Math.abs(kwwMom) / Math.max(Math.abs(kwwClose), 1), 1));
  const trend_strength = window.length >= 2
    ? bounded(Math.min(Math.abs(window[window.length - 1] - window[0]) / Math.max(Math.abs(window[0]), 1), 1))
    : momentum_score;
  const cycle_score = 1 - Math.abs((candlesSinceSignal % K.BASE) / K.BASE - 0.5) * 2;
  const volume_score = bounded(Math.abs(kwwVolume / (kwwVolume + Math.abs(kwwClose) + 1)));
  const dim_score = bounded(trend_direction * 0.20 + momentum_score * 0.20 + trend_strength * 0.1667 + cycle_score * 0.0667 + volume_score * 0.0333);
  return { dim_score, trend_direction, momentum_score, trend_strength, cycle_score, volume_score };
}

// ---------------------------------------------------------------- regime (numpy semantics)

const mean = (x: number[]) => pairwiseSum(x) / x.length;

/** hurst_rs: rescaled-range exponent of log returns over dyadic windows, clipped to [0, 1]. */
export function hurstRs(input: number[]): number {
  const series = input.filter(Number.isFinite);
  if (series.length < 20 || series.some((v) => v <= 0)) return 0.5;
  const logs = series.map(Math.log);
  const returns = logs.slice(1).map((v, i) => v - logs[i]);
  if (returns.length < 16) return 0.5;
  const maxPower = Math.floor(Math.log2(returns.length));
  const points: [number, number][] = [];
  for (let power = 3; power <= maxPower; power++) {
    const window = 2 ** power;
    const chunks = Math.floor(returns.length / window);
    if (chunks < 2) continue;
    const rs: number[] = [];
    for (let c = 0; c < chunks; c++) {
      const seg = returns.slice(c * window, (c + 1) * window);
      const m = mean(seg);
      let cum = 0;
      let hi = -Infinity;
      let lo = Infinity;
      for (const v of seg) { cum += v - m; hi = Math.max(hi, cum); lo = Math.min(lo, cum); }
      const sd = Math.sqrt(pairwiseSum(seg.map((v) => (v - m) ** 2)) / (seg.length - 1));
      const r = hi - lo;
      if (sd > 0 && r > 0) rs.push(r / sd);
    }
    if (rs.length) points.push([window, mean(rs)]);
  }
  if (points.length < 2) return 0.5;
  const xs = points.map((p) => Math.log(p[0]));
  const ys = points.map((p) => Math.log(p[1]));
  const mx = mean(xs);
  const my = mean(ys);
  const slope = pairwiseSum(xs.map((x, i) => (x - mx) * (ys[i] - my))) / pairwiseSum(xs.map((x) => (x - mx) ** 2));
  return Math.min(Math.max(slope, 0), 1);
}

/** np.histogram(series, bins) counts, including numpy's edge handling. */
function histogram(x: number[], bins: number): number[] {
  let lo = Math.min(...x);
  let hi = Math.max(...x);
  if (lo === hi) { lo -= 0.5; hi += 0.5; }
  const step = (hi - lo) / bins;
  const edges = Array.from({ length: bins + 1 }, (_, i) => (i === bins ? hi : i * step + lo));
  const norm = bins / (hi - lo);
  const counts = new Array<number>(bins).fill(0);
  for (const v of x) {
    let idx = Math.floor((v - lo) * norm);
    if (idx === bins) idx -= 1;
    if (v < edges[idx]) idx -= 1;
    else if (v >= edges[idx + 1] && idx !== bins - 1) idx += 1;
    counts[idx] += 1;
  }
  return counts;
}

export function shannonEntropy(series: number[], bins = 10): number {
  const counts = histogram(series, bins);
  const total = counts.reduce((a, b) => a + b, 0);
  const p = counts.map((c) => c / total).filter((v) => v > 0);
  return -pairwiseSum(p.map((v) => v * Math.log2(v))) / Math.log2(bins);
}

export const regimeScore = (h: number): number => Math.exp(-((h - REGIME.H_QURAN) ** 2) / (2 * REGIME.SIGMA ** 2));

export function classifyRegime(h: number): string {
  if (h < 0.35) return "chaotic";
  if (h < 0.50) return "mean-reverting";
  if (h < 0.65) return "random-walk";
  if (h < 0.80) return "trending";
  if (h < 0.89) return "quran-alignment";
  return "hyper-trending";
}

export const cyclePhase = (closes: number[], period: number): number => (closes.length >= period ? (closes.length % period) / period : 0);

export interface Regime { hurst: number; entropy: number; regime_score: number; regime_zone: string; cycle_phase_19: number; cycle_phase_14: number }

/** handle_kww in hurst.py: null below 20 closes (the source publishes nothing). */
export function regime(closesIn: number[]): Regime | null {
  const closes = closesIn.slice(-REGIME.WINDOW);
  if (closes.length < 20) return null;
  const h = hurstRs(closes);
  const e = shannonEntropy(closes);
  return {
    hurst: round(h, 6)!,
    entropy: round(e, 6)!,
    regime_score: round(e <= REGIME.ENTROPY_MAX ? regimeScore(h) : 0, 6)!,
    regime_zone: e > REGIME.ENTROPY_MAX ? "chaotic" : classifyRegime(h),
    cycle_phase_19: cyclePhase(closes, 19),
    cycle_phase_14: cyclePhase(closes, REGIME.TAU),
  };
}

// ---------------------------------------------------------------- mizan confluence

export function signalTier(phi: number): string {
  return phi >= 0.90 ? "extreme" : phi >= 0.75 ? "strong" : phi >= 0.60 ? "standard" : phi >= 0.45 ? "weak" : "neutral";
}
export function signalRank(phi: number): number {
  return phi >= 0.90 ? 1 : phi >= 0.80 ? 2 : phi >= 0.75 ? 3 : phi >= 0.70 ? 5 : phi >= 0.65 ? 7 : 10;
}
export const positionSizePct = (rank: number): number => K.MAX_ALLOC * Math.exp(-Math.pow(rank / K.TAU, K.BETA)) * 100;
export const SL_ATR = K.ATR_MULT;
export const TP_ATR = K.ATR_MULT * K.PHI;

/**
 * Full Mizan chain for one closed candle. Advisory risk levels replace mizan-executor (owner
 * decision 2026-11-04): they are produced only where the source would have emitted a
 * mizan.signal (phi >= CONFIDENCE), and they are suggestions, never orders.
 */
export function mizan(closes: number[], volume: number, timeframe: string, regime1h: Regime | null, close: number, atr14: number | null): Indicators {
  const window = closes.slice(-REGIME.WINDOW);
  const kwwClose = kwwMa(window);
  const kwwMom = kwwMomentum(window);
  const since = Math.max(window.length - 1, 0);
  const d = dimension(kwwClose, volume, kwwMom, since, window);
  const tfScore = timeframeWeight(timeframe);
  const regimeValue = regime1h?.regime_score ?? 1.0; // mizan-confluence default when no regime was seen
  const phi = Math.min(Math.max(d.dim_score * tfScore * regimeValue, 0), 1);
  const rank = signalRank(phi);
  const signal = phi >= K.CONFIDENCE;
  const direction = d.trend_direction === 1 ? "long" : "short";
  const slDistance = atr14 === null ? null : atr14 * SL_ATR;
  return {
    kww_close: round(kwwClose, 6),
    kww_momentum: round(kwwMom, 8),
    memory_weight: round(kwwMemory(since), 8),
    candles_since_signal: since,
    ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, round(v, 8)])),
    tf_score: tfScore,
    regime: regime1h,
    phi: round(phi, 8),
    signal_tier: signalTier(phi),
    signal_rank: rank,
    position_size_pct: round(positionSizePct(rank), 6),
    sl_atr: SL_ATR,
    tp_atr: round(TP_ATR, 10),
    signal,
    advisory_risk_levels: signal && slDistance !== null ? {
      direction,
      stop_loss: round(direction === "long" ? close - slDistance : close + slDistance, 6),
      take_profit: round(direction === "long" ? close + slDistance * K.PHI : close - slDistance * K.PHI, 6),
      suggested_size_pct: round(positionSizePct(rank), 6),
      note: "advisory only; not an order",
    } : null,
  };
}

// ---------------------------------------------------------------- signal-edge tf_aggregator + decision

const TF_WEIGHTS: Record<string, number> = { "1w": 0.30, "1d": 0.25, "4h": 0.20, "1h": 0.15, "15m": 0.06, "5m": 0.03, "1m": 0.01 };
const TF_MAX_AGE_S: Record<string, number> = { "1m": 90, "5m": 360, "15m": 1000, "1h": 4000, "4h": 16000, "1d": 90000, "1w": 700000 };
const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"];
export const CATEGORIES = ["trend", "momentum", "volatility", "volume", "structure"] as const;
type Ind = Record<string, any>;
const truthy = (v: unknown) => v !== null && v !== undefined && v !== 0 && v !== false && v !== "";

export const SCORERS: Record<(typeof CATEGORIES)[number], (ind: Ind) => number | null> = {
  trend(ind) {
    let score = 0;
    let hits = 0;
    const close = ind.close;
    for (const k of ["ema_9", "ema_21", "ema_50", "ema_200"]) {
      const v = ind[k];
      if (truthy(v) && truthy(close)) { score += close > v ? 1 : -1; hits++; }
    }
    if (truthy(ind.adx) && ind.adx > 25) {
      if (ind.supertrend_direction === 1) { score += 1; hits++; } else if (ind.supertrend_direction === -1) { score -= 1; hits++; }
    }
    return hits ? score / hits : null;
  },
  momentum(ind) {
    let score = 0;
    let hits = 0;
    if (ind.rsi_14 != null) { score += ind.rsi_14 > 60 ? 1 : ind.rsi_14 < 40 ? -1 : 0; hits++; }
    if (ind.macd_histogram != null) { score += ind.macd_histogram > 0 ? 1 : -1; hits++; }
    if (ind.cci_20 != null) { score += ind.cci_20 > 100 ? 1 : ind.cci_20 < -100 ? -1 : 0; hits++; }
    return hits ? score / hits : null;
  },
  volatility(ind) {
    const p = ind.bb_percent;
    if (p == null) return null;
    return p > 0.8 ? 1 : p < 0.2 ? -1 : 0;
  },
  volume(ind) {
    let score = 0;
    let hits = 0;
    if (ind.mfi_14 != null) { score += ind.mfi_14 > 60 ? 1 : ind.mfi_14 < 40 ? -1 : 0; hits++; }
    if (ind.cmf_20 != null) { score += ind.cmf_20 > 0.1 ? 1 : ind.cmf_20 < -0.1 ? -1 : 0; hits++; }
    return hits ? score / hits : null;
  },
  structure(ind) {
    let score = 0;
    let hits = 0;
    if (truthy(ind.bos)) { score += ind.bos.direction === "bullish" ? 1 : -1; hits++; }
    if (truthy(ind.choch)) { score += ind.choch.direction === "bullish" ? 0.5 : -0.5; hits++; }
    return hits ? score / hits : null;
  },
};

/** Python round(x, n) with ties to even, for the 2/4-decimal scores the aggregator publishes. */
function pyRound(x: number, digits: number): number {
  const f = 10 ** digits;
  const y = x * f;
  const r = Math.round(y);
  return (Math.abs(y % 1) === 0.5 ? (r % 2 === 0 ? r : r - 1) : r) / f;
}

/** state[category][timeframe] = { ts (ms, candle close), indicators }. */
export function tfConfluence(state: Record<string, Record<string, { ts: number; indicators: Ind }>>, nowMs: number) {
  const tfScores: Record<string, number> = {};
  for (const tf of TIMEFRAMES) {
    const maxAge = (TF_MAX_AGE_S[tf] ?? 3600) * 1000;
    const cat: number[] = [];
    for (const c of CATEGORIES) {
      const entry = state[c]?.[tf];
      if (!entry || nowMs - (entry.ts ?? 0) > maxAge) continue;
      const s = SCORERS[c](entry.indicators ?? {});
      if (s !== null) cat.push(s);
    }
    if (cat.length) tfScores[tf] = cat.reduce((a, b) => a + b, 0) / cat.length;
  }
  const tfs = Object.keys(tfScores);
  if (!tfs.length) return null;
  const weighted = tfs.reduce((a, tf) => a + (TF_WEIGHTS[tf] ?? 0.01) * tfScores[tf], 0);
  const total = tfs.reduce((a, tf) => a + (TF_WEIGHTS[tf] ?? 0.01), 0);
  const normalised = total ? weighted / total : 0;
  return {
    ts: nowMs,
    confluence_score: pyRound(((normalised + 1) / 2) * 100, 2),
    tf_scores: Object.fromEntries(tfs.map((tf) => [tf, pyRound(tfScores[tf], 4)])),
  };
}

/**
 * decision_engine._generate_signal with the intended base rate (the source's keyword mismatch
 * raised TypeError, so it never published). The action is reported as an advisory bias.
 */
export function decision(confluenceScore: number) {
  const baseRate = 65 / (65 + 35);
  const adj = confluenceScore * baseRate;
  let action = adj >= 62.0 ? "BUY" : adj <= 38.0 ? "SELL" : "NEUTRAL";
  const winProb = action === "BUY" ? 0.65 : action === "SELL" ? 0.62 : 0;
  const ev = winProb * 2.0 + (1 - winProb) * -1.0;
  if (action !== "NEUTRAL" && ev <= 0) action = "NEUTRAL";
  const kelly = action !== "NEUTRAL" ? Math.max(0, ((winProb * 2.0 - (1 - winProb)) / 2.0) * 0.25) : 0;
  return {
    action,
    bias: action === "BUY" ? "bullish" : action === "SELL" ? "bearish" : "neutral",
    confidence: pyRound(Math.abs(adj - 50) / 50, 4),
    confluence_score: pyRound(adj, 2),
    expected_value: pyRound(ev, 4),
    kelly_sizing: pyRound(kelly, 4),
    weights: { trend: 0.3, momentum: 0.25, volatility: 0.2, volume: 0.15, structure: 0.1 },
    advisory_only: true,
  };
}
