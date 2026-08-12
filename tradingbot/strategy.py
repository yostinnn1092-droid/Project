"""
Strategy layer.

A strategy answers exactly one question, once per closed bar:

    "Given everything I know up to and including now, what fraction of my
     equity do I want to be holding?"

It returns a *target weight* in [-1, 1]:

     1.0  = fully long
     0.0  = flat
    -1.0  = fully short
     0.5  = half of equity long

Target weights rather than buy/sell orders is a deliberate choice. The
strategy stays a pure function of history and never has to track how much
it already owns, so it cannot desynchronise from the real position. The
backtester and the live broker both just close the gap between current and
target — which means the exact same strategy object drives both.

THE ONE RULE: `on_bar` receives `history`, whose LAST ROW IS THE CURRENT
BAR. You may use every row including the last. You may not use anything
after it, because in live trading it does not exist yet. Every lookahead
bug is a violation of this line.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

import pandas as pd


class Strategy(ABC):
    """Base class. Subclass and implement `on_bar`."""

    #: Bars required before `on_bar` produces meaningful output. The
    #: backtester skips this many bars so indicators are warmed up.
    warmup: int = 0

    @abstractmethod
    def on_bar(self, history: pd.DataFrame) -> float:
        """Return target weight in [-1, 1]. `history` ends at the current bar."""

    def sync_position(self, actual_weight: float) -> None:
        """Tell the strategy what it ACTUALLY holds, before `on_bar`.

        Market orders always fill, so a strategy can assume it got what it
        asked for. Limit orders often do not fill, and a stateful strategy
        that assumes otherwise will manage a position it does not own —
        tracking stops on a phantom entry, refusing to re-enter because it
        thinks it is already in.

        Default is a no-op, which is correct for stateless strategies.
        Any strategy holding its own position state must override this.
        """
        return None

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        params = ", ".join(
            f"{k}={v}" for k, v in vars(self).items() if not k.startswith("_")
        )
        return f"{type(self).__name__}({params})"


class BuyAndHold(Strategy):
    """The benchmark you must beat. If you don't, you have built an
    expensive way to underperform doing nothing."""

    def on_bar(self, history: pd.DataFrame) -> float:
        return 1.0


class SmaCrossover(Strategy):
    """Classic trend following: long when fast SMA is above slow SMA.

    Included because it is the canonical teaching example, not because it
    is good. On liquid markets this is thoroughly arbitraged; expect it to
    lose to buy-and-hold after costs. That is the point — it shows you what
    an honest backtest of a mediocre idea looks like.
    """

    def __init__(self, fast: int = 20, slow: int = 60, allow_short: bool = False):
        if fast >= slow:
            raise ValueError("fast window must be shorter than slow window")
        self.fast = fast
        self.slow = slow
        self.allow_short = allow_short
        self.warmup = slow + 1

    def on_bar(self, history: pd.DataFrame) -> float:
        close = history["close"]
        fast = close.iloc[-self.fast :].mean()
        slow = close.iloc[-self.slow :].mean()
        if fast > slow:
            return 1.0
        return -1.0 if self.allow_short else 0.0


class Breakout(Strategy):
    """Donchian channel: go long on a new N-bar high, short on a new N-bar low.

    A third family, structurally different from both an SMA crossover (which
    reacts to an average) and a z-score fade (which reacts to a deviation).
    Breakouts react to an *extreme*, which is the classic trend-following
    entry and the basis of the original Turtle system.

    Included so the strategy search spans genuinely different ideas rather
    than three re-parameterisations of the same one — a search over near-
    identical strategies mostly measures noise.
    """

    def __init__(self, entry: int = 20, exit: int = 10, allow_short: bool = True):
        self.entry = entry
        self.exit = exit
        self.allow_short = allow_short
        self.warmup = max(entry, exit) + 1
        self._pos = 0.0

    def sync_position(self, actual_weight: float) -> None:
        self._pos = 0.0 if actual_weight == 0 else (1.0 if actual_weight > 0 else -1.0)

    def on_bar(self, history: pd.DataFrame) -> float:
        h = history["high"]
        l = history["low"]
        c = float(history["close"].iloc[-1])

        # Channels exclude the current bar: comparing today's high against a
        # window that contains today's high guarantees a breakout every bar.
        hi = float(h.iloc[-self.entry - 1 : -1].max())
        lo = float(l.iloc[-self.entry - 1 : -1].min())
        x_hi = float(h.iloc[-self.exit - 1 : -1].max())
        x_lo = float(l.iloc[-self.exit - 1 : -1].min())

        if self._pos == 0.0:
            if c > hi:
                self._pos = 1.0
            elif c < lo and self.allow_short:
                self._pos = -1.0
        elif self._pos > 0 and c < x_lo:
            self._pos = 0.0
        elif self._pos < 0 and c > x_hi:
            self._pos = 0.0
        return self._pos


class MeanReversion(Strategy):
    """Fade stretched moves: short when price is far above its mean, long
    when far below, measured in standard deviations (a z-score).

    Mean reversion tends to work on ranging instruments and get destroyed
    by sustained trends — the mirror image of SmaCrossover. Comparing the
    two on the same data teaches more than either alone.
    """

    def __init__(self, lookback: int = 50, entry_z: float = 1.5, exit_z: float = 0.3):
        self.lookback = lookback
        self.entry_z = entry_z
        self.exit_z = exit_z
        self.warmup = lookback + 1
        self._position = 0.0

    def on_bar(self, history: pd.DataFrame) -> float:
        window = history["close"].iloc[-self.lookback :]
        mu = window.mean()
        sd = window.std()
        if sd == 0 or pd.isna(sd):
            return self._position

        z = (history["close"].iloc[-1] - mu) / sd

        # Hysteresis: enter at entry_z, exit only once back inside exit_z.
        # Without the gap, price hovering at the threshold churns in and out
        # and the commissions eat you alive.
        if self._position == 0.0:
            if z > self.entry_z:
                self._position = -1.0
            elif z < -self.entry_z:
                self._position = 1.0
        elif abs(z) < self.exit_z:
            self._position = 0.0

        return self._position
