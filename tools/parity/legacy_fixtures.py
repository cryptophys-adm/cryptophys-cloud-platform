#!/usr/bin/env python3
"""Parity fixtures for mizan-regime (hurst.py), signal-edge tf_aggregator and decision_engine.

Loads the recovered functions from ./legacy without their NATS runtimes and runs them on
deterministic inputs. Deployment settings come from apps-gitops mizan__deployments.yaml:
H_QURAN=0.8453, HURST_SIGMA=0.15, ENTROPY_MAX=0.92, HURST_WINDOW=100.

Deviation (documented in ADR-0005): decision_engine calls
QuantReflector.base_rate_adjustment(tp=65, fp=35), but the function's parameters are
true_positives/false_positives, so the original raised TypeError on every message and never
published. The fixture supplies the intended keywords; everything else is the original code.

Usage: python3 legacy_fixtures.py > workers/control-plane-shared/test/fixtures/legacy-parity.json
Requires: numpy
"""
import ast
import json
import os
import pathlib
import sys

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent / "legacy"
os.environ.update(H_QURAN="0.8453", HURST_SIGMA="0.15", ENTROPY_MAX="0.92", HURST_WINDOW="100")


def load(path, names, ns):
    tree = ast.parse((HERE / path).read_text())
    keep = [n for n in tree.body if (isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in names)
            or (isinstance(n, ast.Assign) and any(getattr(t, "id", "") in names for t in n.targets))
            or isinstance(n, ast.ImportFrom) and n.module == "math"]
    exec(compile(ast.Module(body=keep, type_ignores=[]), path, "exec"), ns)
    return ns


regime = load("mizan/regime_hurst.py", {"BETA", "TAU", "H_QURAN", "SIGMA", "ENTROPY_MAX", "HURST_WINDOW", "hurst_rs",
                                        "shannon_entropy", "regime_score", "classify_regime", "cycle_phase"}, {"np": np, "os": os})
quant = load("signal-edge/quant_formulas.py", {"QuantReflector"}, {"np": np, "log": None})
QR = quant["QuantReflector"]


class IntendedQuantReflector(QR):
    @staticmethod
    def base_rate_adjustment(tp=None, fp=None, true_positives=None, false_positives=None):
        return QR.base_rate_adjustment(tp if tp is not None else true_positives, fp if fp is not None else false_positives)


agg = load("signal-edge/tf_aggregator.py", {"TIMEFRAMES", "TF_WEIGHTS", "TF_MAX_AGE", "CATEGORIES", "_score_trend", "_score_momentum",
                                            "_score_volatility", "_score_volume", "_score_structure", "SCORERS", "_compute_confluence"},
           {"time": None, "_state": None})
dec = load("signal-edge/decision_engine.py", {"WEIGHTS", "BUY_THRESHOLD", "SELL_THRESHOLD", "_generate_signal"},
           {"QuantReflector": IntendedQuantReflector, "time": None})


def regime_case(name, closes):
    closes = np.array(closes[-int(os.environ["HURST_WINDOW"]):], dtype=float)
    h = regime["hurst_rs"](closes)
    e = regime["shannon_entropy"](closes)
    r = regime["regime_score"](h) if e <= regime["ENTROPY_MAX"] else 0.0
    zone = "chaotic" if e > regime["ENTROPY_MAX"] else regime["classify_regime"](h)
    return {"name": name, "closes": closes.tolist(), "hurst": round(h, 6), "entropy": round(e, 6), "regime_score": round(r, 6),
            "regime_zone": zone, "cycle_phase_19": regime["cycle_phase"](closes, 19), "cycle_phase_14": regime["cycle_phase"](closes, 14)}


rng = np.random.default_rng(11)
walk = (2000 * np.exp(np.cumsum(rng.normal(0, 0.004, 140)))).tolist()
trend = (2000 * np.exp(np.cumsum(rng.normal(0.003, 0.002, 100)))).tolist()
revert = (2000 + 15 * np.sin(np.arange(64) / 2.0) + rng.normal(0, 1, 64)).tolist()
regimes = [regime_case("walk_140", walk), regime_case("trend_100", trend), regime_case("revert_64", revert),
           regime_case("short_19", walk[:19]), regime_case("with_zero", [0.0] + walk[:40])]


class Clock:
    def __init__(self, ms): self.ms = ms
    def time(self): return self.ms / 1000


NOW = 1_793_800_000_000
inputs = json.loads((pathlib.Path(__file__).resolve().parents[2] / "workers/control-plane-shared/test/fixtures/signal-parity.json").read_text())
cases = {c["name"]: c for c in inputs["cases"]}
confluences = []
for name, layout in [
    ("1h_4h_fresh", {"1h": ("random_210", 600), "4h": ("random_60", 3600)}),
    ("4h_stale_1h_fresh", {"1h": ("random_500_window", 100), "4h": ("random_30", 20000)}),
    ("only_1h", {"1h": ("flat_tail", 10)}),
    ("all_stale", {"1h": ("random_210", 9000)}),
]:
    state = {"SYM": {cat: {} for cat in agg["CATEGORIES"]}}
    for tf, (case, age_s) in layout.items():
        c = cases[case]
        trend_ind = dict(c["trend"], close=c["candles"][-1]["c"])  # the published trend payload lacked close (ADR-0005)
        for cat, ind in (("trend", trend_ind), ("momentum", c["momentum"]), ("volatility", c["volatility"]),
                         ("volume", c["volume"]), ("structure", c["structure"])):
            state["SYM"][cat][tf] = {"ts": NOW - age_s * 1000, "indicators": ind}
    agg["_state"] = state
    agg["time"] = Clock(NOW)
    conf = agg["_compute_confluence"]("SYM")
    dec["time"] = Clock(NOW)
    signal = dec["_generate_signal"](conf) if conf else None
    scores = {tf: {cat: agg["SCORERS"][cat](state["SYM"][cat][tf]["indicators"]) for cat in agg["CATEGORIES"]} for tf in layout}
    confluences.append({"name": name, "layout": {tf: [c, a] for tf, (c, a) in layout.items()}, "scores": scores,
                        "confluence": conf, "decision": signal})

json.dump({"generator": "tools/parity/legacy_fixtures.py", "now": NOW, "regime": regimes, "confluence": confluences},
          sys.stdout, separators=(",", ":"))
