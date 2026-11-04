"""signal-structure-engine — Order Blocks, FVG, Swing H/L, BOS, ChoCH."""
import asyncio
import json
import logging
import os
from collections import defaultdict, deque

import pandas as pd

from .common import NATSClient, run_service

SERVICE = "signal-structure-engine"
PORT = int(os.environ.get("SERVICE_PORT", 4007))
WINDOW = 210
SWING_LOOKBACK = 5

log = logging.getLogger(SERVICE)
client = NATSClient(SERVICE)

_history: dict[tuple, deque] = defaultdict(lambda: deque(maxlen=WINDOW))


def _swing_highs_lows(high: pd.Series, low: pd.Series, n: int = SWING_LOOKBACK):
    """Return boolean series for swing highs and lows."""
    sh = high == high.rolling(2 * n + 1, center=True).max()
    sl = low == low.rolling(2 * n + 1, center=True).min()
    return sh, sl


def _detect_fvg(high: pd.Series, low: pd.Series, close: pd.Series) -> list[dict]:
    """Detect Fair Value Gaps (3-candle pattern)."""
    fvgs = []
    for i in range(2, len(close)):
        # Bullish FVG: low[i] > high[i-2]
        if low.iloc[i] > high.iloc[i - 2]:
            fvgs.append(
                {
                    "type": "bullish",
                    "top": float(low.iloc[i]),
                    "bottom": float(high.iloc[i - 2]),
                    "idx": i,
                }
            )
        # Bearish FVG: high[i] < low[i-2]
        elif high.iloc[i] < low.iloc[i - 2]:
            fvgs.append(
                {
                    "type": "bearish",
                    "top": float(low.iloc[i - 2]),
                    "bottom": float(high.iloc[i]),
                    "idx": i,
                }
            )
    return fvgs[-3:] if fvgs else []


def _detect_order_blocks(
    high: pd.Series, low: pd.Series, close: pd.Series
) -> list[dict]:
    """Detect last bullish/bearish order blocks."""
    obs = []
    for i in range(3, len(close) - 1):
        # Bullish OB: bearish candle before strong bullish move
        if close.iloc[i] < close.iloc[i - 1] and close.iloc[i + 1] > high.iloc[i - 1]:
            obs.append(
                {
                    "type": "bullish",
                    "top": float(high.iloc[i]),
                    "bottom": float(low.iloc[i]),
                    "idx": i,
                }
            )
        # Bearish OB: bullish candle before strong bearish move
        elif close.iloc[i] > close.iloc[i - 1] and close.iloc[i + 1] < low.iloc[i - 1]:
            obs.append(
                {
                    "type": "bearish",
                    "top": float(high.iloc[i]),
                    "bottom": float(low.iloc[i]),
                    "idx": i,
                }
            )
    return obs[-3:] if obs else []


def _detect_bos_choch(high: pd.Series, low: pd.Series, close: pd.Series):
    """Detect BOS and ChoCH using swing structure."""
    sh, sl = _swing_highs_lows(high, low)
    swing_highs = high[sh].dropna()
    swing_lows = low[sl].dropna()

    bos = None
    choch = None

    if len(swing_highs) >= 2:
        last_sh = swing_highs.iloc[-1]
        prev_sh = swing_highs.iloc[-2]
        if last_sh > prev_sh and float(close.iloc[-1]) > last_sh:
            bos = {"direction": "bullish", "level": round(float(last_sh), 6)}
        elif last_sh < prev_sh and float(close.iloc[-1]) < last_sh:
            choch = {"direction": "bearish", "level": round(float(last_sh), 6)}

    if len(swing_lows) >= 2:
        last_sl = swing_lows.iloc[-1]
        prev_sl = swing_lows.iloc[-2]
        if last_sl < prev_sl and float(close.iloc[-1]) < last_sl:
            bos = {"direction": "bearish", "level": round(float(last_sl), 6)}
        elif last_sl > prev_sl and float(close.iloc[-1]) > last_sl:
            choch = {"direction": "bullish", "level": round(float(last_sl), 6)}

    return bos, choch


def _compute(candles: list[dict]) -> dict:
    df = pd.DataFrame(candles)
    close = df["c"].astype(float).reset_index(drop=True)
    high = df["h"].astype(float).reset_index(drop=True)
    low = df["l"].astype(float).reset_index(drop=True)

    result: dict = {}

    try:
        sh, sl = _swing_highs_lows(high, low)
        result["last_swing_high"] = (
            round(float(high[sh].iloc[-1]), 6) if sh.any() else None
        )
        result["last_swing_low"] = (
            round(float(low[sl].iloc[-1]), 6) if sl.any() else None
        )
    except Exception:
        pass

    try:
        result["fvg"] = _detect_fvg(high, low, close)
    except Exception:
        result["fvg"] = []

    try:
        result["order_blocks"] = _detect_order_blocks(high, low, close)
    except Exception:
        result["order_blocks"] = []

    try:
        bos, choch = _detect_bos_choch(high, low, close)
        result["bos"] = bos
        result["choch"] = choch
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
        if len(hist) < 15:
            await msg.ack()
            return
        indicators = _compute(hist)
        payload = {
            "symbol": sym,
            "tf": tf,
            "ts": candle.get("ts"),
            "indicators": indicators,
        }
        await client.publish(f"analytics.structure.{sym}.{tf}", payload)
        log.info(json.dumps({"event": "structure_computed", "symbol": sym, "tf": tf}))
        await msg.ack()
    except Exception as exc:
        log.error("Structure engine error: %s", exc)


async def main() -> None:
    await client.connect()
    await client.subscribe("market.candle.>", "structure-engine", _on_candle)
    log.info("Structure engine subscribed")
    while True:
        await asyncio.sleep(1)


if __name__ == "__main__":
    run_service(PORT, SERVICE, main())
