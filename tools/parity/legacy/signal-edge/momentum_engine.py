"""signal-momentum-engine — RSI, MACD, Stochastic, CCI, Williams%R."""
import asyncio
import json
import logging
import os
from collections import defaultdict, deque

import pandas as pd
import pandas_ta_classic as ta

from .common import NATSClient, run_service

SERVICE = "signal-momentum-engine"
PORT = int(os.environ.get("SERVICE_PORT", 4004))
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

    # RSI(14)
    try:
        rsi = ta.rsi(close, length=14)
        result["rsi_14"] = (
            round(float(rsi.iloc[-1]), 4) if rsi is not None and not rsi.empty else None
        )
    except Exception:
        pass

    # MACD(12,26,9)
    try:
        macd = ta.macd(close, fast=12, slow=26, signal=9)
        if macd is not None and not macd.empty:
            result["macd"] = round(float(macd.iloc[-1, 0]), 6)
            result["macd_histogram"] = round(float(macd.iloc[-1, 1]), 6)
            result["macd_signal"] = round(float(macd.iloc[-1, 2]), 6)
    except Exception:
        pass

    # Stochastic(14,3)
    try:
        stoch = ta.stoch(high, low, close, k=14, d=3)
        if stoch is not None and not stoch.empty:
            result["stoch_k"] = round(float(stoch.iloc[-1, 0]), 4)
            result["stoch_d"] = round(float(stoch.iloc[-1, 1]), 4)
    except Exception:
        pass

    # CCI(20)
    try:
        cci = ta.cci(high, low, close, length=20)
        result["cci_20"] = (
            round(float(cci.iloc[-1]), 4) if cci is not None and not cci.empty else None
        )
    except Exception:
        pass

    # Williams%R(14)
    try:
        wr = ta.willr(high, low, close, length=14)
        result["willr_14"] = (
            round(float(wr.iloc[-1]), 4) if wr is not None and not wr.empty else None
        )
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
        if len(hist) < 27:
            await msg.ack()
            return
        indicators = _compute(hist)
        payload = {
            "symbol": sym,
            "tf": tf,
            "ts": candle.get("ts"),
            "indicators": indicators,
        }
        await client.publish(f"analytics.momentum.{sym}.{tf}", payload)
        log.info(json.dumps({"event": "momentum_computed", "symbol": sym, "tf": tf}))
        await msg.ack()
    except Exception as exc:
        log.error("Momentum engine error: %s", exc)


async def main() -> None:
    await client.connect()
    await client.subscribe("market.candle.>", "momentum-engine", _on_candle)
    log.info("Momentum engine subscribed")
    while True:
        await asyncio.sleep(1)


if __name__ == "__main__":
    run_service(PORT, SERVICE, main())
