"""
Open Range Breakout (ORB).

The strategy sold in most "forex robot" marketing, and — unusually for that
genre — a completely precise one:

  1. At the session open, mark the high and low of the first N bars.
     That is the "opening range".
  2. If price closes above the range high, go long. Below the low, go short.
  3. Stop at the opposite side of the range.
  4. Target a fixed multiple of the range width.
  5. Flatten at the end of the session; do not hold overnight.

The premise is that the opening range represents overnight indecision, and a
break from it signals which way the session has resolved. It is a real idea
with a real rationale — which is exactly why it deserves a real test rather
than an argument about the marketing around it.

WHAT MAKES OR BREAKS AN ORB TEST
--------------------------------
**Session definition.** Forex has no opening bell. ORB in FX means a
*session* open — London (~07:00 UTC) or New York (~12:00 UTC). Choosing the
session is a free parameter, and testing several then reporting the best is
the data-snooping trap. Both are reported here, side by side.

**The stop is the range.** Position size is therefore set by range width, so
a wide opening range means a wide stop. This is stop-based sizing done right,
and it is the part of ORB that is genuinely sound regardless of whether the
entry works.

**Bar granularity.** ORB is usually run on 5- or 15-minute bars. On hourly
bars a "2-bar opening range" is two hours, which is coarse. That makes this
an approximation of the marketed system, and the direction of the error is
unknown — coarser bars mean fewer, larger breakouts.

**The honest comparison** is not "did it make money" but "did it beat random
entries carrying the same stop and target". Any fixed-R system produces a
characteristic win/loss shape on its own.
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from .ict import _SetupEngine, ICTConfig
from .strategy import Strategy


@dataclass
class ORBConfig:
    session_hour: int = 7        # UTC session open (7 = London, 12 = New York)
    range_bars: int = 2          # bars forming the opening range
    trade_bars: int = 8          # bars after the range in which entries are allowed
    risk_reward: float = 2.0
    allow_short: bool = True
    one_trade_per_session: bool = True
    max_hold: int = 12


class ORBStrategy(Strategy):
    """Open Range Breakout with range-width stops and a fixed R target."""

    def __init__(self, config: ORBConfig | None = None, **kw):
        self.cfg = config or ORBConfig(**kw)
        # Reuse ICT's trade manager so ORB and ICT are measured by identical
        # stop/target/timeout machinery — otherwise a difference in results
        # could just be a difference in exit handling.
        self.eng = _SetupEngine(ICTConfig(
            risk_reward=self.cfg.risk_reward,
            max_hold=self.cfg.max_hold,
            allow_short=self.cfg.allow_short,
            killzone_only=False,
        ))
        self.warmup = 30
        self._session_date = None
        self._range_hi: float | None = None
        self._range_lo: float | None = None
        self._bars_since_open = -1
        self._traded_this_session = False

    def sync_position(self, actual_weight: float) -> None:
        self.eng.sync(actual_weight)

    def on_bar(self, hist: pd.DataFrame) -> float:
        managed = self.eng.manage(hist)
        if managed is not None:
            return managed

        ts = pd.Timestamp(hist["timestamp"].iloc[-1])
        cfg = self.cfg

        # --- session bookkeeping ---
        if ts.hour == cfg.session_hour and self._session_date != ts.date():
            self._session_date = ts.date()
            self._bars_since_open = 0
            self._range_hi = float(hist["high"].iloc[-1])
            self._range_lo = float(hist["low"].iloc[-1])
            self._traded_this_session = False
            return 0.0

        if self._bars_since_open < 0:
            return 0.0
        self._bars_since_open += 1

        # --- still forming the opening range ---
        if self._bars_since_open < cfg.range_bars:
            self._range_hi = max(self._range_hi, float(hist["high"].iloc[-1]))
            self._range_lo = min(self._range_lo, float(hist["low"].iloc[-1]))
            return 0.0

        # --- outside the trading window, or already traded ---
        if self._bars_since_open > cfg.range_bars + cfg.trade_bars:
            return 0.0
        if cfg.one_trade_per_session and self._traded_this_session:
            return 0.0
        if self._range_hi is None or self._range_hi <= self._range_lo:
            return 0.0

        c = float(hist["close"].iloc[-1])

        if c > self._range_hi:
            self._traded_this_session = True
            return self.eng._open(1.0, c, self._range_lo, "orb_long")
        if c < self._range_lo and cfg.allow_short:
            self._traded_this_session = True
            return self.eng._open(-1.0, c, self._range_hi, "orb_short")
        return 0.0

    def report(self) -> dict:
        return self.eng.report()
