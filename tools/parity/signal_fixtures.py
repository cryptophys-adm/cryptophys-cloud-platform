#!/usr/bin/env python3
"""Generate parity fixtures for workers/signal-engine/src/indicators.ts.

Runs the `_compute` logic of apps-gitops signal-edge trend_engine.py / volume_engine.py with
the library they import (pandas_ta_classic), on deterministic synthetic candles.

Deviations from the Python source, both deliberate:
- `forecast_next_5` is omitted: its module (forecasting.py) is not in apps-gitops.
- Ichimoku is read by column name. The source indexes `ich[0]` and reads columns by position,
  which raises on pandas_ta_classic 0.9.0 (it returns one DataFrame) and would mislabel
  span A/B as tenkan/kijun on the old tuple API.

Usage: python3 signal_fixtures.py > workers/control-plane-shared/test/fixtures/signal-parity.json
Requires: pandas, pandas_ta_classic==0.9.0
"""
import json
import math

import numpy as np
import pandas as pd
import pandas_ta_classic as ta


def r(x, d):
    return None if x is None or (isinstance(x, float) and math.isnan(x)) else round(float(x), d)


def trend(df):
    close, high, low = df["c"], df["h"], df["l"]
    out = {}
    for p in [9, 21, 50, 200]:
        val = ta.ema(close, length=p)
        out[f"ema_{p}"] = r(val.iloc[-1], 6) if val is not None and not val.empty else None
    for p in [20, 50, 200]:
        val = ta.sma(close, length=p)
        out[f"sma_{p}"] = r(val.iloc[-1], 6) if val is not None and not val.empty else None
    a = ta.adx(high, low, close, length=14)
    out["adx"], out["adx_plus_di"], out["adx_minus_di"] = (
        (r(a.iloc[-1, 0], 4), r(a.iloc[-1, 1], 4), r(a.iloc[-1, 2], 4)) if a is not None and not a.empty else (None, None, None))
    st = ta.supertrend(high, low, close, length=10, multiplier=3)
    if st is not None and not st.empty:
        out["supertrend"] = r(st.iloc[-1, 0], 6)
        d = st.iloc[-1, 1]
        out["supertrend_direction"] = None if pd.isna(d) else int(d)
    else:
        out["supertrend"], out["supertrend_direction"] = None, None
    ich = ta.ichimoku(high, low, close)
    if ich is not None and not ich.empty:
        row = ich.iloc[-1]
        out["ichimoku_tenkan"] = r(row["ITS_9"], 6)
        out["ichimoku_kijun"] = r(row["IKS_26"], 6)
        out["ichimoku_span_a"] = r(row["ISA_9"], 6)
        out["ichimoku_span_b"] = r(row["ISB_26"], 6)
    return out


def volume(df):
    close, high, low, vol = df["c"], df["h"], df["l"], df["v"]
    typical = (high + low + close) / 3
    vwap = (typical * vol).cumsum() / vol.cumsum()
    obv, mfi, cmf = ta.obv(close, vol), ta.mfi(high, low, close, vol, length=14), ta.cmf(high, low, close, vol, length=20)
    return {
        "vwap": r(vwap.iloc[-1], 6),
        "obv": r(obv.iloc[-1], 2) if obv is not None and not obv.empty else None,
        "mfi_14": r(mfi.iloc[-1], 4) if mfi is not None and not mfi.empty else None,
        "cmf_20": r(cmf.iloc[-1], 6) if cmf is not None and not cmf.empty else None,
    }


def series(seed, n, flat_from=None):
    rng = np.random.default_rng(seed)
    c = 2000 + np.cumsum(rng.normal(0, 4, n))
    o = c + rng.normal(0, 1, n)
    h = np.maximum(o, c) + rng.random(n) * 3
    l = np.minimum(o, c) - rng.random(n) * 3
    v = np.round(rng.random(n) * 5000, 3)
    if flat_from is not None:  # zero-range, zero-volume tail exercises the 0/0 masks
        c[flat_from:] = o[flat_from:] = h[flat_from:] = l[flat_from:] = c[flat_from]
        v[flat_from:] = 0
    return [{"open_time": 1_700_000_000_000 + i * 3_600_000, "o": float(o[i]), "h": float(h[i]), "l": float(l[i]), "c": float(c[i]), "v": float(v[i])} for i in range(n)]


cases = []
for name, candles in [
    ("random_210", series(1, 210)), ("random_60", series(2, 60)), ("random_30", series(3, 30)),
    ("random_21", series(4, 21)), ("random_20", series(5, 20)), ("random_500_window", series(6, 500)[-210:]),
    ("flat_tail", series(7, 120, flat_from=95)),
]:
    df = pd.DataFrame(candles)
    cases.append({"name": name, "candles": candles, "trend": trend(df), "volume": volume(df)})

json.dump({"generator": "tools/parity/signal_fixtures.py", "pandas_ta_classic": ta.version, "pandas": pd.__version__, "cases": cases}, __import__("sys").stdout, separators=(",", ":"))
