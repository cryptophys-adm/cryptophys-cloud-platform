"""
mizan-regime — Hurst + entropy regime detector
Contract: ssot-core/contracts/mizan/mizan-regime-contract.yaml
H_quran = 2 - 2/sqrt(3) = 0.8453
"""
import asyncio
import json
import os
from collections import defaultdict, deque
from math import exp, sqrt

import nats
import numpy as np

BETA = 1 / sqrt(3)
TAU = 14
H_QURAN = float(os.environ.get("H_QURAN", 2 - 2 / sqrt(3)))
SIGMA = float(os.environ.get("HURST_SIGMA", 0.15))
ENTROPY_MAX = float(os.environ.get("ENTROPY_MAX", 0.92))
HURST_WINDOW = max(int(os.environ.get("HURST_WINDOW", 100)), 20)


def hurst_rs(series: np.ndarray) -> float:
    series = np.asarray(series, dtype=float)
    series = series[np.isfinite(series)]
    if len(series) < 20 or np.any(series <= 0):
        return 0.5
    returns = np.diff(np.log(series))
    if len(returns) < 16:
        return 0.5

    max_power = int(np.floor(np.log2(len(returns))))
    window_sizes = [2**power for power in range(3, max_power + 1)]
    rs_points = []
    for window in window_sizes:
        chunks = len(returns) // window
        if chunks < 2:
            continue
        rs_values = []
        for idx in range(chunks):
            segment = returns[idx * window : (idx + 1) * window]
            centered = segment - np.mean(segment)
            cumulative = np.cumsum(centered)
            r_value = cumulative.max() - cumulative.min()
            s_value = np.std(segment, ddof=1)
            if s_value > 0 and r_value > 0:
                rs_values.append(r_value / s_value)
        if rs_values:
            rs_points.append((window, np.mean(rs_values)))

    if len(rs_points) < 2:
        return 0.5

    log_windows = np.log([point[0] for point in rs_points])
    log_rs = np.log([point[1] for point in rs_points])
    slope, _ = np.polyfit(log_windows, log_rs, 1)
    return float(np.clip(slope, 0.0, 1.0))


def shannon_entropy(series: np.ndarray, bins: int = 10) -> float:
    counts, _ = np.histogram(series, bins=bins)
    p = counts / counts.sum()
    p = p[p > 0]
    return float(-np.sum(p * np.log2(p)) / np.log2(bins))


def regime_score(h: float) -> float:
    return exp(-((h - H_QURAN) ** 2) / (2 * SIGMA**2))


def classify_regime(h: float) -> str:
    if h < 0.35:
        return "chaotic"
    if h < 0.50:
        return "mean-reverting"
    if h < 0.65:
        return "random-walk"
    if h < 0.80:
        return "trending"
    if h < 0.89:
        return "quran-alignment"
    return "hyper-trending"


def cycle_phase(closes: np.ndarray, period: int) -> float:
    return float((len(closes) % period) / period) if len(closes) >= period else 0.0


async def run():
    nats_url = os.environ.get(
        "NATS_URL", "nats://mesh-broker-client.nervous-system.svc.cluster.local:4222"
    )
    nc = await nats.connect(servers=[nats_url])
    js = nc.jetstream()
    close_windows: dict[tuple[str, str], deque[float]] = defaultdict(
        lambda: deque(maxlen=HURST_WINDOW)
    )

    async def handle_kww(msg):
        data = json.loads(msg.data)
        symbol = data.get("symbol", "")
        tf = data.get("tf", "")
        raw_window = data.get("kww_close_window") or []
        if raw_window:
            closes = np.array(raw_window[-HURST_WINDOW:], dtype=float)
        else:
            key = (symbol, tf)
            if "kww_close" in data:
                close_windows[key].append(float(data["kww_close"]))
            closes = np.array(close_windows[key], dtype=float)
        if len(closes) < 20:
            await msg.ack()
            return
        h = hurst_rs(closes)
        entropy = shannon_entropy(closes)
        r = regime_score(h) if entropy <= ENTROPY_MAX else 0.0
        zone = "chaotic" if entropy > ENTROPY_MAX else classify_regime(h)
        await js.publish(
            f"mizan.regime.{symbol}",
            json.dumps(
                {
                    "symbol": symbol,
                    "hurst": round(h, 6),
                    "entropy": round(entropy, 6),
                    "regime_score": round(r, 6),
                    "regime_zone": zone,
                    "cycle_phase_19": cycle_phase(closes, 19),
                    "cycle_phase_14": cycle_phase(closes, TAU),
                    "timestamp": data.get("timestamp", 0),
                }
            ).encode(),
        )
        await msg.ack()

    await js.subscribe("mizan.kww.*.1h", cb=handle_kww, stream="MIZAN_SIGNALS")
    print(
        f"mizan-regime | H_quran={H_QURAN:.6f} | entropy_max={ENTROPY_MAX} | window={HURST_WINDOW}"
    )
    while True:
        await asyncio.sleep(1)


if __name__ == "__main__":
    asyncio.run(run())
