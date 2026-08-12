"""
Opening-Range Failed-Breakout Fade ("first 4H candle" scalping strategy).

Rules as specified:

  1. On a 4-hour chart in NEW YORK time, take the FIRST 4H candle of the day.
     Mark its high and its low.
  2. Drop to 5-minute bars. Wait for a candle to trade OUTSIDE that range and
     CLOSE back INSIDE it.
  3. Break the LOW and close back in  -> go LONG.
     Break the HIGH and close back in -> go SHORT.
  4. Stop at the breakout extreme (the wick that poked out).
  5. Target 2R.

WHAT THIS ACTUALLY IS
---------------------
A failed-breakout fade, i.e. a liquidity-sweep trade. The hypothesis is that
stops rest just outside the opening range, price reaches for them, and once
that liquidity is taken it reverses. Same family as the ICT sweep already in
this repo — this version just uses a fixed, mechanical definition of where
the liquidity sits.

That is a genuine, testable market hypothesis rather than an indicator
mashup, and it has one attractive structural property: **the stop is
naturally tight** (the breakout wick), so 2R targets are close by. Whether
that survives costs is exactly what the arithmetic in `scalping.py` decides.

TIMEZONE IS LOAD-BEARING
------------------------
"First 4H candle of the day, New York time" is not the same bar as "first 4H
candle UTC", and New York observes daylight saving while UTC does not. Get
this wrong and you mark a different range for half the year — the strategy
would look broken for reasons that have nothing to do with the strategy.
Timestamps are therefore converted to America/New_York and bucketed there.

NO LOOKAHEAD
------------
The range is fixed once the opening window CLOSES, and no trade is taken
before that. Entries use only the currently-closed 5-minute bar; the engine
fills at the next bar's open.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from .strategy import Strategy

NY = ZoneInfo("America/New_York")


@dataclass
class ORFadeConfig:
    #: Hour (New York time) at which the trading day's first 4H candle opens.
    #: 0 matches a TradingView 4H chart set to New York time.
    session_start_hour: int = 0
    range_hours: int = 4
    risk_reward: float = 2.0
    #: Trades allowed per day. The rules imply the first clean signal; more
    #: than one is a re-entry policy the video does not specify.
    max_trades_per_day: int = 1
    #: Abandon a position after this many 5-minute bars (24h = 288).
    max_hold_bars: int = 288
    #: Require the breakout wick to exceed the range by at least this
    #: fraction of the range height, so a one-tick graze is not a "sweep".
    min_breakout_frac: float = 0.0
    allow_long: bool = True
    allow_short: bool = True

    # ---- optional enhancements (all OFF by default) ------------------
    #: Only fade in the direction of the longer-term trend: longs require
    #: close above the EMA, shorts below. 0 disables.
    trend_ema: int = 0
    #: Skip days whose opening range is outside this band, measured as a
    #: multiple of the trailing range average. A range far wider than normal
    #: means the "sweep" is just noise; far narrower means the level is not
    #: meaningful. 0 disables either bound.
    min_range_ratio: float = 0.0
    max_range_ratio: float = 0.0
    #: Restrict ENTRIES to these New York hours. Empty tuple disables.
    entry_hours: tuple = ()


@dataclass
class ORTrade:
    day: str
    direction: int
    entry_time: pd.Timestamp
    entry: float
    stop: float
    target: float
    exit_time: pd.Timestamp | None = None
    exit: float | None = None
    r_multiple: float = 0.0
    reason: str = ""
    bars_held: int = 0


class OpeningRangeFade(Strategy):
    """Fade failed breakouts of the day's first 4H range."""

    def __init__(self, config: ORFadeConfig | None = None, **kw):
        self.cfg = config or ORFadeConfig(**kw)
        self.warmup = 2
        self._day: str | None = None
        self._hi: float | None = None
        self._lo: float | None = None
        self._range_done = False
        self._trades_today = 0
        self._pos = 0.0
        self._t: ORTrade | None = None
        self.trades: list[ORTrade] = []
        self._days_seen = 0
        self._days_with_signal = 0
        self._signalled_today = False
        self._ny_hour = 0

    def sync_position(self, actual_weight: float) -> None:
        if actual_weight == 0.0 and self._pos != 0.0:
            self._pos = 0.0
            self._t = None

    # ------------------------------------------------------------------
    def on_bar(self, hist: pd.DataFrame) -> float:
        ts = pd.Timestamp(hist["timestamp"].iloc[-1])
        ny = ts.tz_localize("UTC").tz_convert(NY) if ts.tzinfo is None else ts.tz_convert(NY)

        # Day boundary is the session start hour in NY, not midnight UTC.
        day_key = (ny - pd.Timedelta(hours=self.cfg.session_start_hour)).strftime("%Y-%m-%d")
        if day_key != self._day:
            self._day = day_key
            self._hi = self._lo = None
            self._range_done = False
            self._trades_today = 0
            self._signalled_today = False
            self._days_seen += 1

        hour_into_day = (ny.hour - self.cfg.session_start_hour) % 24
        in_range_window = hour_into_day < self.cfg.range_hours

        hi = float(hist["high"].iloc[-1])
        lo = float(hist["low"].iloc[-1])
        close = float(hist["close"].iloc[-1])
        self._ny_hour = ny.hour

        # ---- build the opening range ----
        if in_range_window:
            self._hi = hi if self._hi is None else max(self._hi, hi)
            self._lo = lo if self._lo is None else min(self._lo, lo)
            return self._manage(hist, ts)  # a prior trade may still be open
        if not self._range_done:
            self._range_done = True  # window has closed; range is now fixed

        managed = self._manage(hist, ts)
        if self._pos != 0.0:
            return managed

        if self._hi is None or self._lo is None or self._hi <= self._lo:
            return 0.0
        if self._trades_today >= self.cfg.max_trades_per_day:
            return 0.0

        height = self._hi - self._lo
        buf = height * self.cfg.min_breakout_frac

        # ---- optional filters ----
        if self.cfg.entry_hours and self._ny_hour not in self.cfg.entry_hours:
            return 0.0

        if self.cfg.min_range_ratio > 0 or self.cfg.max_range_ratio > 0:
            # Compare today's opening range to recent typical bar range, so
            # "unusually wide" is measured against the instrument's own
            # volatility rather than an absolute price figure.
            recent = hist.iloc[-288:]
            typical = float((recent["high"] - recent["low"]).mean())
            if typical > 0:
                ratio = height / (typical * 48)  # 48 five-min bars per 4H
                if self.cfg.min_range_ratio > 0 and ratio < self.cfg.min_range_ratio:
                    return 0.0
                if self.cfg.max_range_ratio > 0 and ratio > self.cfg.max_range_ratio:
                    return 0.0

        trend_ok_long = trend_ok_short = True
        if self.cfg.trend_ema > 0:
            e = hist["close"].ewm(span=self.cfg.trend_ema, adjust=False,
                                  min_periods=self.cfg.trend_ema).mean()
            ev = e.iloc[-1]
            if pd.isna(ev):
                return 0.0
            trend_ok_long = close > float(ev)
            trend_ok_short = close < float(ev)

        # ---- failed breakout DOWN -> long ----
        if (self.cfg.allow_long and trend_ok_long
                and lo < self._lo - buf and close > self._lo):
            return self._open(1, close, lo, ts, day_key)

        # ---- failed breakout UP -> short ----
        if (self.cfg.allow_short and trend_ok_short
                and hi > self._hi + buf and close < self._hi):
            return self._open(-1, close, hi, ts, day_key)

        return 0.0

    # ------------------------------------------------------------------
    def _open(self, direction: int, price: float, extreme: float,
              ts: pd.Timestamp, day: str) -> float:
        risk = abs(price - extreme)
        if risk <= 0:
            return 0.0
        target = price + direction * risk * self.cfg.risk_reward
        self._t = ORTrade(day=day, direction=direction, entry_time=ts,
                          entry=price, stop=extreme, target=target)
        self._pos = float(direction)
        self._trades_today += 1
        if not self._signalled_today:
            self._signalled_today = True
            self._days_with_signal += 1
        return self._pos

    def _manage(self, hist: pd.DataFrame, ts: pd.Timestamp) -> float:
        if self._pos == 0.0 or self._t is None:
            return 0.0
        t = self._t
        t.bars_held += 1
        hi = float(hist["high"].iloc[-1])
        lo = float(hist["low"].iloc[-1])

        # Stop checked before target: a bar spanning both is counted as a
        # loss. Assuming the good fill is how bar backtests invent profit.
        if (t.direction > 0 and lo <= t.stop) or (t.direction < 0 and hi >= t.stop):
            return self._close(t.stop, "stop", ts)
        if (t.direction > 0 and hi >= t.target) or (t.direction < 0 and lo <= t.target):
            return self._close(t.target, "target", ts)
        if t.bars_held >= self.cfg.max_hold_bars:
            return self._close(float(hist["close"].iloc[-1]), "timeout", ts)
        return self._pos

    def _close(self, price: float, reason: str, ts: pd.Timestamp) -> float:
        t = self._t
        assert t is not None
        risk = abs(t.entry - t.stop)
        t.exit_time, t.exit, t.reason = ts, price, reason
        t.r_multiple = ((price - t.entry) * t.direction) / risk if risk else 0.0
        self.trades.append(t)
        self._t = None
        self._pos = 0.0
        return 0.0

    # ------------------------------------------------------------------
    def report(self) -> dict:
        if not self.trades:
            return {"n_trades": 0, "days_seen": self._days_seen}
        df = pd.DataFrame([vars(t) for t in self.trades])
        r = df["r_multiple"]
        wins = r[r > 0]
        losses = r[r <= 0]
        gw = float(wins.sum()) if len(wins) else 0.0
        gl = float(-losses.sum()) if len(losses) else 0.0
        return {
            "n_trades": len(df),
            "days_seen": self._days_seen,
            "days_with_signal": self._days_with_signal,
            "signal_rate": self._days_with_signal / max(self._days_seen, 1),
            "win_rate": float((r > 0).mean()),
            "expectancy_r": float(r.mean()),
            "total_r": float(r.sum()),
            "profit_factor": (gw / gl) if gl > 0 else float("inf"),
            "avg_bars_held": float(df["bars_held"].mean()),
            "exits": df["reason"].value_counts().to_dict(),
            "long_share": float((df["direction"] > 0).mean()),
        }
