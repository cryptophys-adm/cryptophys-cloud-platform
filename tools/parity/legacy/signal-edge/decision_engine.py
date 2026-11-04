"""signal-decision-engine — weighted scoring → BUY/SELL/NEUTRAL signal."""
import asyncio
import json
import logging
import os
import time

from .common import NATSClient, run_service

SERVICE = "signal-decision-engine"
PORT = int(os.environ.get("SERVICE_PORT", 4009))

# Weights per analytics category (must sum to 1.0)
WEIGHTS = {
    "trend": 0.30,
    "momentum": 0.25,
    "volatility": 0.20,
    "volume": 0.15,
    "structure": 0.10,
}

BUY_THRESHOLD = 62.0
SELL_THRESHOLD = 38.0

log = logging.getLogger(SERVICE)
client = NATSClient(SERVICE)


from .quant_formulas import QuantReflector


def _generate_signal(confluence: dict) -> dict:
    score = confluence.get("confluence_score", 50.0)
    symbol = confluence.get("symbol", "UNKNOWN")

    # ── Step 1: Base Rate Adjustment (Hedge Fund Formula #4) ──
    # Simulated true/false positives from historical ledger
    base_rate = QuantReflector.base_rate_adjustment(
        tp=65, fp=35
    )  # 65% base success for this pattern
    adj_score = score * base_rate

    # ── Step 2: Probabilistic Decision ──
    if adj_score >= BUY_THRESHOLD:
        action = "BUY"
        win_prob = 0.65
    elif adj_score <= SELL_THRESHOLD:
        action = "SELL"
        win_prob = 0.62
    else:
        action = "NEUTRAL"
        win_prob = 0.0

    # ── Step 3: Expected Value (EV) Check (Hedge Fund Formula #1) ──
    # Payoff: 2.0 (Target), Penalty: -1.0 (Stoploss)
    ev = QuantReflector.calculate_ev(win_prob, 2.0, (1 - win_prob), -1.0)

    if action != "NEUTRAL" and ev <= 0:
        log.warning(f"📉 Negative EV ({ev:.2f}) for {symbol}. Killing signal.")
        action = "NEUTRAL"

    # ── Step 4: Kelly Sizing (Hedge Fund Formula #3) ──
    sizing = 0.0
    if action != "NEUTRAL":
        sizing = QuantReflector.kelly_fraction(win_prob, 2.0)  # 1/4 Kelly

    confidence = abs(adj_score - 50.0) / 50.0

    return {
        "symbol": symbol,
        "ts": confluence.get("ts", int(time.time() * 1000)),
        "action": action,
        "confidence": round(confidence, 4),
        "confluence_score": round(adj_score, 2),
        "expected_value": round(ev, 4),
        "kelly_sizing": round(sizing, 4),
        "weights": WEIGHTS,
    }


async def _on_confluence(msg) -> None:
    try:
        payload = json.loads(msg.data.decode())
        signal = _generate_signal(payload)
        sym = signal["symbol"]
        await client.publish(f"signal.decision.{sym}", signal)
        log.info(
            json.dumps(
                {
                    "event": "signal_generated",
                    "symbol": sym,
                    "action": signal["action"],
                    "confidence": signal["confidence"],
                    "score": signal["confluence_score"],
                }
            )
        )
        await msg.ack()
    except Exception as exc:
        log.error("Decision engine error: %s", exc)


async def main() -> None:
    await client.connect()
    await client.subscribe("confluence.>", "decision-engine", _on_confluence)
    log.info("Decision engine subscribed to confluence.>")
    while True:
        await asyncio.sleep(1)


if __name__ == "__main__":
    run_service(PORT, SERVICE, main())
