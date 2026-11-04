"""signal-volatility-engine — Bollinger Bands, ATR, Keltner Channel, Squeeze."""
import asyncio
import json
import logging
import os
from collections import defaultdict, deque

import pandas as pd
import pandas_ta_classic as ta

from .common import NATSClient, run_service

SERVICE = "signal-volatility-engine"
PORT = int(os.environ.get("SERVICE_PORT", 4005))
WINDOW = 210

log = logging.getLogger(SERVICE)
client = NATSClient(SERVICE)

_history: dict[tuple, deque] = defaultdict(lambda: deque(maxlen=WINDOW))


def _compute(candles: list[dict]) -> dict:
    df = pd.DataFrame(candles)
    close = df["c"].astype(float)
    high = df["h"].astype(float)
    low = df["l"].astype(float)

    result: dict = {}

    # Bollinger Bands(20, 2)
    try:
        bbands = ta.bbands(close, length=20, std=2)
        if bbands is not None and not bbands.empty:
            result["bb_upper"] = round(float(bbands.iloc[-1, 0]), 6)
            result["bb_mid"] = round(float(bbands.iloc[-1, 1]), 6)
            result["bb_lower"] = round(float(bbands.iloc[-1, 2]), 6)
            result["bb_bandwidth"] = round(float(bbands.iloc[-1, 3]), 6)
            result["bb_percent"] = round(float(bbands.iloc[-1, 4]), 6)
    except Exception:
        pass

    # ATR(14)
    try:
        atr = ta.atr(high, low, close, length=14)
        result["atr_14"] = (
            round(float(atr.iloc[-1]), 6) if atr is not None and not atr.empty else None
        )
    except Exception:
        pass

    # Keltner Channel
    try:
        kc = ta.kc(high, low, close, length=20, scalar=2)
        if kc is not None and not kc.empty:
            result["kc_upper"] = round(float(kc.iloc[-1, 0]), 6)
            result["kc_basis"] = round(float(kc.iloc[-1, 1]), 6)
            result["kc_lower"] = round(float(kc.iloc[-1, 2]), 6)
    except Exception:
        pass

    # Squeeze: BB inside KC
    try:
        bb_upper = result.get("bb_upper")
        bb_lower = result.get("bb_lower")
        kc_upper = result.get("kc_upper")
        kc_lower = result.get("kc_lower")
        if all(v is not None for v in [bb_upper, bb_lower, kc_upper, kc_lower]):
            result["squeeze"] = bb_upper <= kc_upper and bb_lower >= kc_lower
    except Exception:
        pass

    return result


async def _on_candle(msg) -> None:
    try:
        candle = json.loads(msg.data.decode())
        sym = candle.get("symbol", "")
        tf = candle.get("tf", "")
        key = (sym, tf)
        _history[key].append(candle)
        hist = list(_history[key])
        if len(hist) < 21:
            await msg.ack()
            return
        indicators = _compute(hist)
        payload = {
            "symbol": sym,
            "tf": tf,
            "ts": candle.get("ts"),
            "indicators": indicators,
        }
        await client.publish(f"analytics.volatility.{sym}.{tf}", payload)
        log.info(json.dumps({"event": "volatility_computed", "symbol": sym, "tf": tf}))
        await msg.ack()
    except Exception as exc:
        log.error("Volatility engine error: %s", exc)


async def main() -> None:
    await client.connect()
    await client.subscribe("market.candle.>", "volatility-engine", _on_candle)
    log.info("Volatility engine subscribed")
    while True:
        await asyncio.sleep(1)


if __name__ == "__main__":
    run_service(PORT, SERVICE, main())
