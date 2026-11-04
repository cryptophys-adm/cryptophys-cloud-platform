"""signal-tf-aggregator — aggregate analytics across timeframes, emit confluence score."""
import asyncio
import json
import logging
import os
import time
from collections import defaultdict

from .common import NATSClient, run_service

SERVICE = "signal-tf-aggregator"
PORT = int(os.environ.get("SERVICE_PORT", 4008))

TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"]
TF_WEIGHTS = {
    "1w": 0.30,
    "1d": 0.25,
    "4h": 0.20,
    "1h": 0.15,
    "15m": 0.06,
    "5m": 0.03,
    "1m": 0.01,
}

# Max age seconds for a TF bucket to still be considered valid
TF_MAX_AGE = {
    "1m": 90,
    "5m": 360,
    "15m": 1000,
    "1h": 4000,
    "4h": 16000,
    "1d": 90000,
    "1w": 700000,
}

log = logging.getLogger(SERVICE)
client = NATSClient(SERVICE)

# {symbol: {category: {tf: {ts, indicators}}}}
_state: dict[str, dict[str, dict]] = defaultdict(lambda: defaultdict(dict))

CATEGORIES = ["trend", "momentum", "volatility", "volume", "structure"]


def _score_trend(ind: dict) -> float | None:
    score = 0.0
    hits = 0
    close = ind.get("close")
    for k in ["ema_9", "ema_21", "ema_50", "ema_200"]:
        v = ind.get(k)
        if v and close:
            score += 1.0 if close > v else -1.0
            hits += 1
    adx = ind.get("adx")
    if adx and adx > 25:
        st_dir = ind.get("supertrend_direction")
        if st_dir == 1:
            score += 1.0
            hits += 1
        elif st_dir == -1:
            score -= 1.0
            hits += 1
    return score / hits if hits else None


def _score_momentum(ind: dict) -> float | None:
    score = 0.0
    hits = 0
    rsi = ind.get("rsi_14")
    if rsi is not None:
        if rsi > 60:
            score += 1.0
        elif rsi < 40:
            score -= 1.0
        hits += 1
    macd_h = ind.get("macd_histogram")
    if macd_h is not None:
        score += 1.0 if macd_h > 0 else -1.0
        hits += 1
    cci = ind.get("cci_20")
    if cci is not None:
        if cci > 100:
            score += 1.0
        elif cci < -100:
            score -= 1.0
        hits += 1
    return score / hits if hits else None


def _score_volatility(ind: dict) -> float | None:
    bb_pct = ind.get("bb_percent")
    if bb_pct is None:
        return None
    if bb_pct > 0.8:
        return 1.0
    if bb_pct < 0.2:
        return -1.0
    return 0.0


def _score_volume(ind: dict) -> float | None:
    score = 0.0
    hits = 0
    mfi = ind.get("mfi_14")
    if mfi is not None:
        score += 1.0 if mfi > 60 else (-1.0 if mfi < 40 else 0.0)
        hits += 1
    cmf = ind.get("cmf_20")
    if cmf is not None:
        score += 1.0 if cmf > 0.1 else (-1.0 if cmf < -0.1 else 0.0)
        hits += 1
    return score / hits if hits else None


def _score_structure(ind: dict) -> float | None:
    score = 0.0
    hits = 0
    bos = ind.get("bos")
    if bos:
        score += 1.0 if bos.get("direction") == "bullish" else -1.0
        hits += 1
    choch = ind.get("choch")
    if choch:
        score += 0.5 if choch.get("direction") == "bullish" else -0.5
        hits += 1
    return score / hits if hits else None


SCORERS = {
    "trend": _score_trend,
    "momentum": _score_momentum,
    "volatility": _score_volatility,
    "volume": _score_volume,
    "structure": _score_structure,
}


def _compute_confluence(symbol: str) -> dict | None:
    now_ms = int(time.time() * 1000)
    tf_scores: dict[str, float] = {}

    for tf in TIMEFRAMES:
        max_age_ms = TF_MAX_AGE.get(tf, 3600) * 1000
        cat_scores = []
        for cat in CATEGORIES:
            entry = _state[symbol][cat].get(tf)
            if not entry:
                continue
            age = now_ms - entry.get("ts", 0)
            if age > max_age_ms:
                continue
            s = SCORERS[cat](entry.get("indicators", {}))
            if s is not None:
                cat_scores.append(s)
        if cat_scores:
            tf_scores[tf] = sum(cat_scores) / len(cat_scores)

    if not tf_scores:
        return None

    weighted = sum(TF_WEIGHTS.get(tf, 0.01) * s for tf, s in tf_scores.items())
    total_w = sum(TF_WEIGHTS.get(tf, 0.01) for tf in tf_scores)
    normalised = weighted / total_w if total_w else 0.0
    confluence = round((normalised + 1) / 2 * 100, 2)  # map [-1,1] → [0,100]

    return {
        "symbol": symbol,
        "ts": now_ms,
        "confluence_score": confluence,
        "tf_scores": {tf: round(s, 4) for tf, s in tf_scores.items()},
    }


async def _on_analytics(msg) -> None:
    try:
        payload = json.loads(msg.data.decode())
        sym = payload.get("symbol", "")
        tf = payload.get("tf", "")
        # Determine category from subject
        subj = msg.subject  # e.g. analytics.trend.BTCUSDT.1h
        parts = subj.split(".")
        cat = parts[1] if len(parts) >= 2 else "unknown"
        if cat in CATEGORIES:
            _state[sym][cat][tf] = {
                "ts": payload.get("ts", 0),
                "indicators": payload.get("indicators", {}),
            }

        confluence = _compute_confluence(sym)
        if confluence:
            await client.publish(f"confluence.{sym}", confluence)
            log.info(
                json.dumps(
                    {
                        "event": "confluence",
                        "symbol": sym,
                        "score": confluence["confluence_score"],
                    }
                )
            )
        await msg.ack()
    except Exception as exc:
        log.error("TF aggregator error: %s", exc)


async def main() -> None:
    await client.connect()
    await client.subscribe("analytics.>", "tf-aggregator", _on_analytics)
    log.info("TF aggregator subscribed to analytics.>")
    while True:
        await asyncio.sleep(1)


if __name__ == "__main__":
    run_service(PORT, SERVICE, main())
