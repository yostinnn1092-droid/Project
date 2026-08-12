"""
Martingale — why "72 days of profit" proves almost nothing.

Martingale doubles position size after every loss, so a single win recovers
the whole losing run plus one unit of profit. Grid, averaging-down, and
"zone recovery" systems are variants of the same arithmetic.

WHY IT LOOKS SO GOOD
--------------------
The win rate is enormous. Because a losing sequence only ends when it wins,
almost every *sequence* closes green. The equity curve is smooth, upward,
and boring — exactly what a convincing track record looks like.

WHY IT IS NOT
-------------
The doubling that produces the smooth curve also means a run of n losses
requires 2^n - 1 units of capital to survive. Six consecutive losses needs
63 units; ten needs 1,023. Since the position is doubling, the loss when the
run finally exceeds your capital is not a normal bad day — it is the entire
account. The curve does not degrade, it terminates.

So martingale converts a large number of small wins into one catastrophic
loss, and the *ordering* is what fools people: the small wins come first,
for months, and the catastrophe arrives once.

THE TESTABLE CLAIM
------------------
"I ran this bot for 72 days and it made money" is not evidence a martingale
works. It is the expected observation *whether or not it works*, because 72
days is usually shorter than the interval between blow-ups.

`run_martingale.py` measures exactly that: the fraction of 72-day windows
that show a profit, against what the same system does over the full period.
If most short windows look good while the full run is destroyed, then a
72-day live test cannot distinguish a sound system from a doomed one — and
neither can any number of testimonials of the same length.

NOTE ON LEVERAGE. Doubling from a 5% base reaches 160% of equity by the
sixth step, so martingale *requires* leverage to run at all. That is not an
incidental detail: it is why the failure is total rather than partial.
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from .strategy import Strategy


@dataclass
class MartingaleConfig:
    base_size: float = 0.05      # first position, as a fraction of equity
    multiplier: float = 2.0      # size multiplier after each loss
    max_steps: int = 6           # doublings before the account is gone
    take_profit: float = 0.002   # 20bp
    stop_loss: float = 0.002     # 20bp — symmetric, so entries are coin flips
    max_hold: int = 24
    allow_short: bool = True


class Martingale(Strategy):
    """Doubles down after losses. Included as a cautionary demonstration.

    Entries are deliberately near-random (a trivial momentum tilt). That is
    the point: martingale's equity curve comes from the SIZING, not from the
    signal, so a coin-flip entry reproduces the seductive curve exactly.
    """

    def __init__(self, config: MartingaleConfig | None = None, **kw):
        self.cfg = config or MartingaleConfig(**kw)
        self.warmup = 5
        self._pos = 0.0
        self._size = self.cfg.base_size
        self._entry: float | None = None
        self._held = 0
        self._losses = 0
        self.blown_up = False
        self.max_step_reached = 0
        self.sequences: list[dict] = []

    def sync_position(self, actual_weight: float) -> None:
        if actual_weight == 0.0 and self._pos != 0.0:
            self._pos = 0.0
            self._entry = None
            self._held = 0

    def on_bar(self, hist: pd.DataFrame) -> float:
        if self.blown_up:
            return 0.0

        cfg = self.cfg
        c = float(hist["close"].iloc[-1])

        # --- manage an open trade ---
        if self._pos != 0.0 and self._entry is not None:
            self._held += 1
            move = (c / self._entry - 1.0) * self._pos

            if move >= cfg.take_profit:
                self._settle(True, hist)
                return 0.0
            if move <= -cfg.stop_loss or self._held >= cfg.max_hold:
                self._settle(False, hist)
                return 0.0
            return self._pos * self._size

        # --- open the next trade in the sequence ---
        prev = float(hist["close"].iloc[-2])
        side = 1.0 if c >= prev else -1.0
        if side < 0 and not cfg.allow_short:
            side = 1.0

        self._size = cfg.base_size * (cfg.multiplier ** self._losses)
        self._pos = side
        self._entry = c
        self._held = 0
        return side * self._size

    def _settle(self, won: bool, hist: pd.DataFrame) -> None:
        self.sequences.append({
            "timestamp": hist["timestamp"].iloc[-1],
            "won": won,
            "step": self._losses,
            "size": self._size,
        })
        if won:
            self._losses = 0
        else:
            self._losses += 1
            self.max_step_reached = max(self.max_step_reached, self._losses)
            if self._losses >= self.cfg.max_steps:
                # The run exceeded the capital available to double again.
                self.blown_up = True
        self._pos = 0.0
        self._entry = None
        self._held = 0

    def report(self) -> dict:
        if not self.sequences:
            return {"n_trades": 0, "blown_up": self.blown_up}
        df = pd.DataFrame(self.sequences)
        return {
            "n_trades": len(df),
            "win_rate": float(df["won"].mean()),
            "max_step_reached": self.max_step_reached,
            "blown_up": self.blown_up,
            "largest_position": float(df["size"].max()),
        }
