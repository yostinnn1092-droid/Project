#!/usr/bin/env python
"""
Paper-trading loop — step 2 of the progression, and the one people skip.

    python live_paper.py

This replays the sample CSV bar by bar as if it were arriving live, through
the SAME `Strategy` and `RiskManager` objects the backtester uses, but with
orders going to a `PaperBroker`. Replacing the feed with a real websocket
and the broker with a real exchange is then a small, contained change.

Why this stage exists at all: a backtest hands you a clean dataframe and
cannot fail to receive it. Live, the failures are different in kind —

  * the feed stalls and you are trading on a stale price
  * a bar arrives twice, or out of order, or never
  * the process restarts and forgets it holds a position
  * the API returns 429, or 500, or times out after the order landed
  * your clock drifts and you act on a bar that has not closed

None of those are strategy bugs, so no amount of backtesting finds them.
The loop below sketches where each one gets handled.
"""

from __future__ import annotations

import time
from pathlib import Path

from tradingbot import (
    MeanReversion,
    PaperBroker,
    RiskLimits,
    RiskManager,
    load_csv,
)

SYMBOL = "SAMPLE"
DATA = Path(__file__).parent / "data" / "sample_5min.csv"
SPEED = 0.0  # seconds to sleep per bar; set >0 to watch it tick


def main() -> None:
    bars = load_csv(DATA).tail(3_000).reset_index(drop=True)

    strategy = MeanReversion(lookback=50, entry_z=1.5, exit_z=0.3)
    risk = RiskManager(RiskLimits(max_position=1.0, max_drawdown=0.15,
                                  daily_loss_limit=0.05))
    broker = PaperBroker(cash=10_000.0, commission=0.0004, slippage=0.0002)

    start_equity = broker.cash
    print(f"Paper trading {SYMBOL} over {len(bars):,} replayed bars")
    print(f"  strategy: {strategy}")
    print(f"  start:    {start_equity:,.2f}\n")

    # ---- RECONCILE ON START ----------------------------------------
    # Live, this is where you ask the exchange what you actually hold and
    # overwrite local state with the answer. Never assume a restart
    # resumed with the position you last remembered.
    position = broker.get_position(SYMBOL)
    if position:
        print(f"  recovered existing position: {position}")

    last_ts = None

    for i in range(strategy.warmup, len(bars)):
        bar = bars.iloc[i]

        # ---- FEED HYGIENE ------------------------------------------
        # Duplicate or out-of-order bars are normal on real feeds. Acting
        # on one twice double-sizes the position.
        if last_ts is not None and bar["timestamp"] <= last_ts:
            continue
        last_ts = bar["timestamp"]

        broker.set_price(SYMBOL, float(bar["close"]))

        equity = broker.get_equity()
        risk.update(equity, bar["timestamp"])

        # The strategy sees only closed bars up to now — identical to the
        # backtest, which is the entire point of this exercise.
        target = strategy.on_bar(bars.iloc[: i + 1])
        target = risk.adjust(float(target))

        try:
            fill = broker.rebalance_to_weight(SYMBOL, target)
        except Exception as exc:  # live: catch API errors, back off, retry
            print(f"  [{bar['timestamp']}] order failed: {exc}")
            continue

        if fill:
            print(
                f"  [{fill.timestamp:%H:%M:%S}] {fill.side:<4} "
                f"{fill.units:>10.4f} @ {fill.price:>8.3f}  "
                f"target={target:+.2f}  equity={equity:,.2f}"
            )

        if risk.halted:
            print(f"\n  RISK HALT: {risk.halt_reason}")
            broker.rebalance_to_weight(SYMBOL, 0.0)
            break

        if SPEED:
            time.sleep(SPEED)

    final = broker.get_equity()
    fees = sum(f.fee for f in broker.fills)
    print(f"\n  fills:  {len(broker.fills)}")
    print(f"  fees:   {fees:,.2f}")
    print(f"  equity: {start_equity:,.2f} -> {final:,.2f} "
          f"({final / start_equity - 1:+.2%})")


if __name__ == "__main__":
    main()
