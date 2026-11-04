/**
 * Deterministic indicator kernels ported from apps-gitops signal-edge (ADR-0005):
 * trend, volume, momentum, volatility and structure engines.
 *
 * Each kernel reproduces pandas_ta_classic 0.4.47, the version pinned in the engines'
 * requirements.txt, including its numerical details (SMA-seeded Wilder/EMA averages, the
 * epsilon added to zero ranges, pandas' exact rolling mean over identical values, numpy's
 * pairwise summation in variance/MAD). Fixtures generated from the recovered Python by
 * tools/parity/signal_fixtures.py prove parity. Series use NaN for "no value"; outputs
 * report null. Deliberate deviations from the Python sources are listed in ADR-0005.
 */

export interface Candle { open_time: number; o: number; h: number; l: number; c: number; v: number }

export const IMPLEMENTATION = "signal-engine/3 (pandas_ta_classic 0.4.47 parity; revised Mizan/decision, ADR-0005 decision 10)";

type Series = number[];
const nan = (n: number): Series => new Array<number>(n).fill(NaN);
const finite = Number.isFinite;
const EPSILON = 2.220446049250313e-16;

// ---------------------------------------------------------------- numeric primitives

/** numpy's pairwise summation (PW_BLOCKSIZE 128, 8-way unrolled), bit-for-bit. */
export function pairwiseSum(a: Series, start = 0, n = a.length - start): number {
  if (n < 8) {
    let res = 0;
    for (let i = 0; i < n; i++) res += a[start + i];
    return res;
  }
  if (n <= 128) {
    const r = [0, 1, 2, 3, 4, 5, 6, 7].map((j) => a[start + j]);
    let i = 8;
    for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] += a[start + i + j];
    let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for (; i < n; i++) res += a[start + i];
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return pairwiseSum(a, start, n2) + pairwiseSum(a, start + n2, n - n2);
}

/** pandas Series.mean() of a slice: NaN skipped, NaN when nothing is left. */
function meanSkipNa(x: Series, from: number, to: number): number {
  const vals = x.slice(from, to).filter(finite);
  return vals.length ? pairwiseSum(vals) / vals.length : NaN;
}

/** pandas rolling(n).sum(): NaN unless the window holds n values. */
function rollingSum(x: Series, n: number): Series {
  const out = nan(x.length);
  for (let i = n - 1; i < x.length; i++) {
    let s = 0;
    let ok = true;
    for (let j = i - n + 1; j <= i; j++) {
      if (!finite(x[j])) { ok = false; break; }
      s += x[j];
    }
    if (ok) out[i] = s;
  }
  return out;
}

/** pandas rolling(n).mean(): a window of identical values returns that value exactly. */
function rollingMean(x: Series, n: number): Series {
  return rollingSum(x, n).map((s, i) => {
    if (!finite(s)) return NaN;
    const v = x[i];
    for (let j = i - n + 1; j < i; j++) if (x[j] !== v) return s / n;
    return v;
  });
}

function rollingExtreme(x: Series, n: number, pick: (a: number, b: number) => number): Series {
  const out = nan(x.length);
  for (let i = n - 1; i < x.length; i++) {
    let m = x[i - n + 1];
    for (let j = i - n + 2; j <= i; j++) m = pick(m, x[j]);
    out[i] = m;
  }
  return out;
}
const rollingMin = (x: Series, n: number) => rollingExtreme(x, n, Math.min);
const rollingMax = (x: Series, n: number) => rollingExtreme(x, n, Math.max);

/** pandas_ta non_zero_range: a - b, with epsilon added everywhere if any difference is 0. */
function nonZeroRange(a: Series, b: Series): Series {
  const d = a.map((v, i) => v - b[i]);
  return d.some((v) => v === 0) ? d.map((v) => v + EPSILON) : d;
}

/** SMA-seeded exponential average (pandas_ta 0.4.47 rma/ema): seed = mean of the first n values. */
function seededEwm(x: Series, n: number, alpha: number): Series {
  const out = nan(x.length);
  if (x.length < n) return out;
  let prev = meanSkipNa(x, 0, n);
  out[n - 1] = prev;
  for (let i = n; i < x.length; i++) {
    if (!finite(prev)) { prev = x[i]; out[i] = prev; continue; } // ewm starts at the first value
    prev = alpha * x[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

export const sma = (x: Series, n: number): Series => (x.length < n ? nan(x.length) : rollingMean(x, n));
export const ema = (x: Series, n: number): Series => seededEwm(x, n, 2 / (n + 1));
export const rma = (x: Series, n: number): Series => seededEwm(x, n, 1 / n);

export function trueRange(h: Series, l: Series, c: Series): Series {
  const hl = nonZeroRange(h, l);
  return h.map((hi, i) => (i === 0 ? NaN : Math.max(Math.abs(hl[i]), Math.abs(hi - c[i - 1]), Math.abs(c[i - 1] - l[i]))));
}

export function atr(h: Series, l: Series, c: Series, n: number): Series {
  return c.length < n ? nan(c.length) : rma(trueRange(h, l, c), n);
}

const hlc3 = (h: Series, l: Series, c: Series): Series => c.map((ci, i) => (h[i] + l[i] + ci) / 3);

/** numpy sliding-window variance (ddof) or mean absolute deviation, via pairwise sums. */
function windowStat(x: Series, n: number, stat: "var" | "mad", ddof = 0): Series {
  const out = nan(x.length);
  for (let i = n - 1; i < x.length; i++) {
    const w = x.slice(i - n + 1, i + 1);
    const mean = pairwiseSum(w) / n;
    const dev = w.map((v) => (stat === "var" ? (v - mean) * (v - mean) : Math.abs(v - mean)));
    out[i] = pairwiseSum(dev) / (stat === "var" ? n - ddof : n);
  }
  return out;
}

// ---------------------------------------------------------------- trend

export function adx(h: Series, l: Series, c: Series, n: number): { adx: Series; dmp: Series; dmn: Series } {
  const len = c.length;
  if (len < n) return { adx: nan(len), dmp: nan(len), dmn: nan(len) };
  const a = atr(h, l, c, n);
  const pos = nan(len);
  const neg = nan(len);
  for (let i = 1; i < len; i++) {
    const up = h[i] - h[i - 1];
    const dn = l[i - 1] - l[i];
    const p = up > dn && up > 0 ? up : 0;
    const q = dn > up && dn > 0 ? dn : 0;
    pos[i] = Math.abs(p) < EPSILON ? 0 : p;
    neg[i] = Math.abs(q) < EPSILON ? 0 : q;
  }
  const pm = rma(pos, n);
  const nm = rma(neg, n);
  const dmp = pm.map((v, i) => (100 / a[i]) * v);
  const dmn = nm.map((v, i) => (100 / a[i]) * v);
  const dx = dmp.map((p, i) => (100 * Math.abs(p - dmn[i])) / (p + dmn[i]));
  return { adx: rma(dx, n), dmp, dmn };
}

export function supertrend(h: Series, l: Series, c: Series, n: number, mult: number): { trend: Series; direction: Series } {
  const len = c.length;
  if (len < n) return { trend: nan(len), direction: nan(len) };
  const a = atr(h, l, c, n);
  const ub = h.map((hi, i) => (hi + l[i]) / 2 + mult * a[i]);
  const lb = h.map((hi, i) => (hi + l[i]) / 2 - mult * a[i]);
  const dir = new Array<number>(len).fill(1);
  const trend = new Array<number>(len).fill(0);
  for (let i = 1; i < len; i++) {
    if (c[i] > ub[i - 1]) dir[i] = 1;
    else if (c[i] < lb[i - 1]) dir[i] = -1;
    else {
      dir[i] = dir[i - 1];
      if (dir[i] > 0 && lb[i] < lb[i - 1]) lb[i] = lb[i - 1];
      if (dir[i] < 0 && ub[i] > ub[i - 1]) ub[i] = ub[i - 1];
    }
    trend[i] = dir[i] > 0 ? lb[i] : ub[i];
  }
  return { trend, direction: dir };
}

function midprice(h: Series, l: Series, n: number): Series {
  const lo = rollingMin(l, n);
  const hi = rollingMax(h, n);
  return lo.map((v, i) => 0.5 * (v + hi[i]));
}

/** Last-row Ichimoku as pandas_ta reports it (spans shifted forward by kijun). */
export function ichimokuLast(h: Series, l: Series, tenkan = 9, kijun = 26, senkou = 52) {
  const len = h.length;
  if (len < Math.max(tenkan, kijun, senkou)) return null;
  const t = midprice(h, l, tenkan);
  const k = midprice(h, l, kijun);
  const b = midprice(h, l, senkou);
  const at = len - 1 - kijun;
  return { tenkan: t[len - 1], kijun: k[len - 1], span_a: at >= 0 ? 0.5 * (t[at] + k[at]) : NaN, span_b: at >= 0 ? b[at] : NaN };
}

// ---------------------------------------------------------------- volume

export function obv(c: Series, v: Series): Series {
  let total = 0;
  return c.map((ci, i) => {
    const sign = i === 0 ? 1 : ci > c[i - 1] ? 1 : ci < c[i - 1] ? -1 : 0;
    total += sign * v[i];
    return total;
  });
}

export function mfi(h: Series, l: Series, c: Series, v: Series, n: number): Series {
  const len = c.length;
  if (len < n) return nan(len);
  const tp = hlc3(h, l, c);
  const pos = new Array<number>(len).fill(0);
  const neg = new Array<number>(len).fill(0);
  for (let i = 1; i < len; i++) {
    const change = tp[i] - tp[i - 1];
    if (change > 0) pos[i] = tp[i] * v[i];
    else if (change < 0) neg[i] = tp[i] * v[i];
  }
  const ps = rollingSum(pos, n);
  const ns = rollingSum(neg, n);
  return ps.map((p, i) => (100 * p) / (p + ns[i]));
}

export function cmf(h: Series, l: Series, c: Series, v: Series, n: number): Series {
  if (c.length < n) return nan(c.length);
  const range = nonZeroRange(h, l);
  const ad = c.map((ci, i) => (2 * ci - (h[i] + l[i])) * (v[i] / range[i]));
  const adSum = rollingSum(ad, n);
  const vSum = rollingSum(v, n);
  return adSum.map((s, i) => s / vSum[i]);
}

// ---------------------------------------------------------------- momentum

export function rsi(c: Series, n: number): Series {
  if (c.length < n) return nan(c.length);
  const diff = c.map((v, i) => (i === 0 ? NaN : v - c[i - 1]));
  const pos = rma(diff.map((d) => (d < 0 ? 0 : d)), n);
  const neg = rma(diff.map((d) => (d > 0 ? 0 : d)), n);
  return pos.map((p, i) => (100 * p) / (p + Math.abs(neg[i])));
}

export function macd(c: Series, fast = 12, slow = 26, signal = 9): { macd: Series; histogram: Series; signal: Series } | null {
  const m = c.length;
  if (m < Math.max(fast, slow, signal)) return null;
  const aligned = (arr: Series, period: number, seedEnd: number): Series => {
    const out = nan(m);
    const start = seedEnd - period + 1;
    if (start < 0 || seedEnd >= m) return out;
    let s = 0;
    const w = arr.slice(start, seedEnd + 1);
    s = pairwiseSum(w) / period;
    out[seedEnd] = s;
    const k = 2 / (period + 1);
    for (let i = seedEnd + 1; i < m; i++) out[i] = k * arr[i] + (1 - k) * out[i - 1];
    return out;
  };
  const f = aligned(c, fast, fast - 1);
  const s = aligned(c, slow, slow - 1);
  const line = f.map((v, i) => v - s[i]);
  const sig = aligned(line, signal, slow - 1 + signal - 1);
  return { macd: line, signal: sig, histogram: line.map((v, i) => v - sig[i]) };
}

export function stoch(h: Series, l: Series, c: Series, k = 14, d = 3, smoothK = 3): { k: Series; d: Series } | null {
  if (c.length < Math.max(k, d, smoothK)) return null;
  const ll = rollingMin(l, k);
  const hh = rollingMax(h, k);
  const range = nonZeroRange(hh, ll);
  const raw = c.map((ci, i) => (100 * (ci - ll[i])) / range[i]);
  const smoothFrom = (x: Series, n: number): Series => {
    const first = x.findIndex(finite);
    const out = nan(x.length);
    if (first < 0 || x.length - first < n) return out;
    const tail = rollingMean(x.slice(first), n);
    tail.forEach((v, i) => { out[first + i] = v; });
    return out;
  };
  const sk = smoothFrom(raw, smoothK);
  return { k: sk, d: smoothFrom(sk, d) };
}

export function cci(h: Series, l: Series, c: Series, n: number): Series {
  if (c.length < n) return nan(c.length);
  const tp = hlc3(h, l, c);
  const mean = sma(tp, n);
  const mad = windowStat(tp, n, "mad");
  return tp.map((v, i) => (v - mean[i]) / (0.015 * mad[i]));
}

export function willr(h: Series, l: Series, c: Series, n: number): Series {
  if (c.length < n) return nan(c.length);
  const ll = rollingMin(l, n);
  const hh = rollingMax(h, n);
  return c.map((v, i) => 100 * ((v - ll[i]) / (hh[i] - ll[i]) - 1));
}

// ---------------------------------------------------------------- volatility

export function bbands(c: Series, n: number, k: number) {
  if (c.length < n) return null;
  const sd = windowStat(c, n, "var", 0).map(Math.sqrt);
  const mid = sma(c, n);
  const lower = mid.map((m, i) => m - k * sd[i]);
  const upper = mid.map((m, i) => m + k * sd[i]);
  const ulr = nonZeroRange(upper, lower);
  const cl = nonZeroRange(c, lower);
  return { lower, mid, upper, bandwidth: ulr.map((r, i) => (100 * r) / mid[i]), percent: cl.map((r, i) => r / ulr[i]) };
}

export function keltner(h: Series, l: Series, c: Series, n: number, scalar: number) {
  if (c.length < n) return null;
  const basis = ema(c, n);
  const band = ema(trueRange(h, l, c), n);
  return { lower: basis.map((b, i) => b - scalar * band[i]), basis, upper: basis.map((b, i) => b + scalar * band[i]) };
}

// ---------------------------------------------------------------- structure (pure Python logic)

const SWING_LOOKBACK = 5;

/** high == rolling(2n+1, center=True).max(): NaN windows at both ends never match. */
function swings(h: Series, l: Series, n = SWING_LOOKBACK): { sh: boolean[]; sl: boolean[] } {
  const w = 2 * n + 1;
  const sh = h.map(() => false);
  const sl = h.map(() => false);
  for (let i = n; i < h.length - n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - n; j <= i + n; j++) { hi = Math.max(hi, h[j]); lo = Math.min(lo, l[j]); }
    sh[i] = h[i] === hi;
    sl[i] = l[i] === lo;
    void w;
  }
  return { sh, sl };
}

interface Zone { type: "bullish" | "bearish"; top: number; bottom: number; idx: number }

function fvg(h: Series, l: Series, c: Series): Zone[] {
  const out: Zone[] = [];
  for (let i = 2; i < c.length; i++) {
    if (l[i] > h[i - 2]) out.push({ type: "bullish", top: l[i], bottom: h[i - 2], idx: i });
    else if (h[i] < l[i - 2]) out.push({ type: "bearish", top: l[i - 2], bottom: h[i], idx: i });
  }
  return out.slice(-3);
}

function orderBlocks(h: Series, l: Series, c: Series): Zone[] {
  const out: Zone[] = [];
  for (let i = 3; i < c.length - 1; i++) {
    if (c[i] < c[i - 1] && c[i + 1] > h[i - 1]) out.push({ type: "bullish", top: h[i], bottom: l[i], idx: i });
    else if (c[i] > c[i - 1] && c[i + 1] < l[i - 1]) out.push({ type: "bearish", top: h[i], bottom: l[i], idx: i });
  }
  return out.slice(-3);
}

function bosChoch(h: Series, l: Series, c: Series) {
  const { sh, sl } = swings(h, l);
  const highs = h.filter((_, i) => sh[i]);
  const lows = l.filter((_, i) => sl[i]);
  const close = c[c.length - 1];
  let bos: { direction: string; level: number | null } | null = null;
  let choch: { direction: string; level: number | null } | null = null;
  if (highs.length >= 2) {
    const [prev, lastH] = highs.slice(-2);
    if (lastH > prev && close > lastH) bos = { direction: "bullish", level: round(lastH, 6) };
    else if (lastH < prev && close < lastH) choch = { direction: "bearish", level: round(lastH, 6) };
  }
  if (lows.length >= 2) {
    const [prev, lastL] = lows.slice(-2);
    if (lastL < prev && close < lastL) bos = { direction: "bearish", level: round(lastL, 6) };
    else if (lastL > prev && close > lastL) choch = { direction: "bullish", level: round(lastL, 6) };
  }
  return { bos, choch };
}

// ---------------------------------------------------------------- engine outputs

/** Python's round(x, digits) for finite values; null for NaN/undefined. */
export function round(x: number | undefined, digits: number): number | null {
  if (x === undefined || !finite(x)) return null;
  return Number(x.toFixed(digits));
}

const last = (x: Series) => x[x.length - 1];
const cols = (candles: Candle[]) => ({
  c: candles.map((k) => k.c), h: candles.map((k) => k.h), l: candles.map((k) => k.l), v: candles.map((k) => k.v),
});

export type Indicators = Record<string, unknown>;

/** trend_engine._compute: EMA 9/21/50/200, SMA 20/50/200, ADX(14), Supertrend(10, 3), Ichimoku. */
export function trendIndicators(candles: Candle[]): Indicators {
  const { c, h, l } = cols(candles);
  const out: Indicators = {};
  for (const p of [9, 21, 50, 200]) out[`ema_${p}`] = round(last(ema(c, p)), 6);
  for (const p of [20, 50, 200]) out[`sma_${p}`] = round(last(sma(c, p)), 6);
  const a = adx(h, l, c, 14);
  out.adx = round(last(a.adx), 4);
  out.adx_plus_di = round(last(a.dmp), 4);
  out.adx_minus_di = round(last(a.dmn), 4);
  const st = supertrend(h, l, c, 10, 3);
  out.supertrend = round(last(st.trend), 6);
  out.supertrend_direction = finite(last(st.direction)) ? last(st.direction) : null;
  const ich = ichimokuLast(h, l);
  if (ich) { // pandas_ta 0.4.47 returns None below 52 candles, so the keys are absent
    out.ichimoku_tenkan = round(ich.tenkan, 6);
    out.ichimoku_kijun = round(ich.kijun, 6);
    out.ichimoku_span_a = round(ich.span_a, 6);
    out.ichimoku_span_b = round(ich.span_b, 6);
  }
  return out;
}

/** volume_engine._compute: VWAP over the window, OBV, MFI(14), CMF(20). */
export function volumeIndicators(candles: Candle[]): Indicators {
  const { c, h, l, v } = cols(candles);
  let pv = 0;
  let vol = 0;
  candles.forEach((k) => { pv += ((k.h + k.l + k.c) / 3) * k.v; vol += k.v; });
  return {
    vwap: round(pv / vol, 6),
    obv: round(last(obv(c, v)), 2),
    mfi_14: round(last(mfi(h, l, c, v, 14)), 4),
    cmf_20: round(last(cmf(h, l, c, v, 20)), 6),
  };
}

/** momentum_engine._compute: RSI(14), MACD(12,26,9), Stochastic(14,3), CCI(20), Williams %R(14). */
export function momentumIndicators(candles: Candle[]): Indicators {
  const { c, h, l } = cols(candles);
  const out: Indicators = { rsi_14: round(last(rsi(c, 14)), 4) };
  const m = macd(c);
  if (m) {
    out.macd = round(last(m.macd), 6);
    out.macd_histogram = round(last(m.histogram), 6);
    out.macd_signal = round(last(m.signal), 6);
  }
  const s = stoch(h, l, c);
  if (s) {
    out.stoch_k = round(last(s.k), 4);
    out.stoch_d = round(last(s.d), 4);
  }
  out.cci_20 = round(last(cci(h, l, c, 20)), 4);
  out.willr_14 = round(last(willr(h, l, c, 14)), 4);
  return out;
}

/** volatility_engine._compute with correct band labels (the source reads lower bands as upper). */
export function volatilityIndicators(candles: Candle[]): Indicators {
  const { c, h, l } = cols(candles);
  const out: Indicators = {};
  const bb = bbands(c, 20, 2);
  if (bb) {
    out.bb_upper = round(last(bb.upper), 6);
    out.bb_mid = round(last(bb.mid), 6);
    out.bb_lower = round(last(bb.lower), 6);
    out.bb_bandwidth = round(last(bb.bandwidth), 6);
    out.bb_percent = round(last(bb.percent), 6);
  }
  out.atr_14 = round(last(atr(h, l, c, 14)), 6);
  const kc = keltner(h, l, c, 20, 2);
  if (kc) {
    out.kc_upper = round(last(kc.upper), 6);
    out.kc_basis = round(last(kc.basis), 6);
    out.kc_lower = round(last(kc.lower), 6);
  }
  const [bu, bl, ku, kl] = [out.bb_upper, out.bb_lower, out.kc_upper, out.kc_lower] as (number | null | undefined)[];
  if ([bu, bl, ku, kl].every((x) => x !== null && x !== undefined)) out.squeeze = bu! <= ku! && bl! >= kl!;
  return out;
}

/** structure_engine._compute: swing high/low, FVG, order blocks, BOS/CHoCH (window indices). */
export function structureIndicators(candles: Candle[]): Indicators {
  const { c, h, l } = cols(candles);
  const { sh, sl } = swings(h, l);
  const lastIdx = (flags: boolean[]) => flags.lastIndexOf(true);
  const ih = lastIdx(sh);
  const il = lastIdx(sl);
  const { bos, choch } = bosChoch(h, l, c);
  return {
    last_swing_high: ih >= 0 ? round(h[ih], 6) : null,
    last_swing_low: il >= 0 ? round(l[il], 6) : null,
    fvg: fvg(h, l, c),
    order_blocks: orderBlocks(h, l, c),
    bos,
    choch,
  };
}

/** Minimum history before an engine publishes, as in the Python services. */
export const MIN_HISTORY = { trend: 20, volume: 21, momentum: 27, volatility: 21, structure: 15 } as const;
export const WINDOW = 210;
