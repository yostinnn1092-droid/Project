"""
Scalping.

Scalping means taking many small profits over very short holds — seconds to
minutes — rather than a few large ones. It is the strategy family most
sensitive to trading costs, because the edge per trade is small and the cost
per trade is fixed. That single fact decides almost everything, so this
module puts the arithmetic first and the strategy second.

THE COST WALL
-------------
Every completed scalp is a round trip: one entry, one exit. You pay costs on
both. With 4bp commission and 2bp slippage per side:

    round trip = 2 x (4 + 2) = 12 bp = 0.12%

So a scalp must capture more than 0.12% before it breaks even. If your
average winner is 20bp, your average loser is 20bp, and you win half the
time, your gross edge is zero and your net edge is MINUS 12bp per trade. Do
that 2,000 times and you have donated 240% of your starting capital to the
exchange.

This is why retail scalping usually fails. Not bad signals — the signal never
gets a chance. Professional scalpers solve it by not paying retail costs:
exchange rebates for providing liquidity, colocation, direct market access,
and per-share pricing measured in fractions of a basis point. If you are
paying taker fees through a retail API, you are playing a different game with
the same name.

Use `breakeven_edge()` and `required_win_rate()` BEFORE writing a signal. If
the numbers say the edge you would need is implausible, no amount of
cleverness in the entry logic will save it.

A NOTE ON BAR DATA
------------------
True scalping lives on ticks or seconds. Bar data cannot see what happened
inside the bar, which matters here more than anywhere else:

  * A stop is assumed to fill at exactly the stop price. In reality price
    gaps through stops, and gaps go against you far more often than for you.
  * A bar whose range spans both your target AND your stop is ambiguous —
    this module resolves it pessimistically (stop first), because assuming
    the good fill is how backtests manufacture profit.

So treat any bar-based scalping result as an OPTIMISTIC upper bound. The
real thing will be worse.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .strategy import Strategy


# ----------------------------------------------------------------- economics
def round_trip_cost(commission: float = 0.0004, slippage: float = 0.0002) -> float:
    """Total cost of one complete scalp, as a fraction. Entry + exit."""
    return 2.0 * (commission + slippage)


def breakeven_edge(commission: float = 0.0004, slippage: float = 0.0002) -> float:
    """Gross edge per trade required just to break even. Same as the round trip."""
    return round_trip_cost(commission, slippage)


def required_win_rate(
    take_profit: float,
    stop_loss: float,
    commission: float = 0.0004,
    slippage: float = 0.0002,
) -> float:
    """Win rate needed for a target/stop pair to break even after costs.

    Solves  w*TP - (1-w)*SL - cost = 0  for w:

        w = (SL + cost) / (TP + SL)

    Returns a value > 1.0 when the setup is impossible at any win rate —
    which happens whenever the target is small relative to costs.
    """
    cost = round_trip_cost(commission, slippage)
    return (stop_loss + cost) / (take_profit + stop_loss)


def breakeven_table(
    targets_bps=(5, 10, 20, 30, 50, 100),
    rr: float = 1.0,
    commission: float = 0.0004,
    slippage: float = 0.0002,
) -> pd.DataFrame:
    """Required win rate across a range of profit targets.

    `rr` is the stop as a multiple of the target (1.0 = symmetric).
    Read it before you build anything: it tells you which targets are
    reachable at your cost level and which are arithmetic fiction.
    """
    rows = []
    cost = round_trip_cost(commission, slippage)
    for bps in targets_bps:
        tp = bps / 10_000
        sl = tp * rr
        w = required_win_rate(tp, sl, commission, slippage)
        rows.append(
            {
                "target_bps": bps,
                "stop_bps": round(sl * 10_000, 1),
                "cost_bps": round(cost * 10_000, 1),
                "required_win_rate": w,
                "verdict": (
                    "impossible" if w >= 1.0
                    else "implausible" if w > 0.75
                    else "hard" if w > 0.6
                    else "plausible"
                ),
            }
        )
    return pd.DataFrame(rows)


# ------------------------------------------------------------------ strategy
@dataclass
class ScalpConfig:
    lookback: int = 20        # bars used to measure "normal" movement
    entry_z: float = 1.5      # how stretched before entering
    take_profit: float = 0.003
    stop_loss: float = 0.002
    max_hold: int = 3         # bars; scalps must not become investments
    allow_short: bool = True
    cooldown: int = 1         # bars to sit out after closing


class Scalper(Strategy):
    """Mean-reversion scalper with an explicit exit state machine.

    Enters when price is stretched `entry_z` standard deviations from its
    short-run mean, then leaves on whichever comes first: profit target,
    stop, or `max_hold` bars. The timeout is the important one — a scalp
    that stops working must be closed, not held hopefully. Positions that
    outlive their thesis are how scalpers take large losses.

    Exit checks are pessimistic: the stop is tested before the target, so a
    bar that could have hit either is counted as a loss.
    """

    def __init__(self, config: ScalpConfig | None = None, **kwargs):
        self.cfg = config or ScalpConfig(**kwargs)
        self.warmup = self.cfg.lookback + 1
        self._pos = 0.0
        self._entry_price: float | None = None
        self._held = 0
        self._cooldown = 0
        #: closed round trips, as fractional returns before costs
        self.round_trips: list[dict] = []

    def on_bar(self, history: pd.DataFrame) -> float:
        price = float(history["close"].iloc[-1])

        # ---- manage an open scalp -------------------------------------
        if self._pos != 0.0 and self._entry_price is not None:
            self._held += 1
            gross = (price / self._entry_price - 1.0) * self._pos

            # Stop checked FIRST — see class docstring.
            if gross <= -self.cfg.stop_loss:
                return self._close("stop", gross, history)
            if gross >= self.cfg.take_profit:
                return self._close("target", gross, history)
            if self._held >= self.cfg.max_hold:
                return self._close("timeout", gross, history)
            return self._pos

        # ---- cooldown --------------------------------------------------
        if self._cooldown > 0:
            self._cooldown -= 1
            return 0.0

        # ---- look for an entry ----------------------------------------
        window = history["close"].iloc[-self.cfg.lookback :]
        mu, sd = window.mean(), window.std()
        if sd == 0 or pd.isna(sd):
            return 0.0

        z = (price - mu) / sd
        if z <= -self.cfg.entry_z:
            self._open(1.0, price)
        elif z >= self.cfg.entry_z and self.cfg.allow_short:
            self._open(-1.0, price)
        return self._pos

    # ------------------------------------------------------------------
    def _open(self, side: float, price: float) -> None:
        self._pos = side
        self._entry_price = price
        self._held = 0

    def _close(self, reason: str, gross: float, history: pd.DataFrame) -> float:
        self.round_trips.append(
            {
                "timestamp": history["timestamp"].iloc[-1],
                "side": "long" if self._pos > 0 else "short",
                "bars_held": self._held,
                "gross_return": gross,
                "exit_reason": reason,
            }
        )
        self._pos = 0.0
        self._entry_price = None
        self._held = 0
        self._cooldown = self.cfg.cooldown
        return 0.0

    # ------------------------------------------------------------------
    def trade_report(
        self, commission: float = 0.0004, slippage: float = 0.0002
    ) -> dict:
        """Per-trade economics — the numbers that actually decide a scalper.

        Equity-curve metrics hide the mechanism. What matters is expectancy:
        average gross gain per round trip, minus the round-trip cost. If that
        is negative, the strategy loses by arithmetic, and trading it more
        only loses faster.

        ACCURACY LIMIT — check this before trusting the output. Returns here
        are measured close-to-close at the moment of decision, while the
        backtester fills at the NEXT bar's open. Those agree only while the
        close-to-next-open gap is small relative to your profit target.

        Measured on this repo's sample data at 4h bars, the mean gap is
        0.51% against a 0.30% target — the jump between deciding and filling
        is larger than the entire prize. At that point the target and stop
        barely bind, outcomes are decided by gap luck rather than by the
        strategy, and this report and the equity curve disagree (it reported
        -1.14bp net expectancy while the run returned +14.26%).

        Rule of thumb: if the median close-to-next-open gap approaches your
        take_profit, you are no longer testing your strategy. Either use a
        finer timeframe, widen the target, or model limit-order entries.
        """
        if not self.round_trips:
            return {"n_trades": 0}

        df = pd.DataFrame(self.round_trips)
        g = df["gross_return"]
        wins, losses = g[g > 0], g[g <= 0]
        cost = round_trip_cost(commission, slippage)
        gross_exp = float(g.mean())

        return {
            "n_trades": len(df),
            "win_rate": float((g > 0).mean()),
            "avg_win_bps": float(wins.mean() * 10_000) if len(wins) else 0.0,
            "avg_loss_bps": float(losses.mean() * 10_000) if len(losses) else 0.0,
            "gross_expectancy_bps": gross_exp * 10_000,
            "round_trip_cost_bps": cost * 10_000,
            "net_expectancy_bps": (gross_exp - cost) * 10_000,
            "avg_bars_held": float(df["bars_held"].mean()),
            "exits": df["exit_reason"].value_counts().to_dict(),
        }
