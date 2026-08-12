"""
Break-of-Structure + Fibonacci "gold zone" scalping (1-minute).

Rules as specified:

  1. Read the micro-trend on 1-minute bars: higher highs/lows = up,
     lower highs/lows = down.
  2. Wait for a BREAK OF STRUCTURE — price closes beyond the previous
     swing point.
  3. Draw a Fibonacci retracement from the START of that swing to the
     break point.
  4. ENTER when price retraces into the 0.5-0.618 "gold zone".
  5. Target the previous swing high/low, typically within 7-15 minutes.
  6. Risk:reward 1:1.5.

WHY THIS ONE IS WORTH TESTING PROPERLY
--------------------------------------
It is a pullback-continuation setup with an unusually well-defined entry: a
structural trigger (the BOS) plus a specific price band (the retracement),
so there is no discretion about where to buy. The 1.5R target is explicit,
and the stop follows naturally from the swing origin.

THE ARITHMETIC THAT DECIDES IT
------------------------------
On 1-minute bars the swing being measured is small, so `stop_distance` is
small, so the round-trip cost is LARGE relative to the trade. A 1.5R target
needs a 40% win rate to break even before costs. Every basis point of
spread raises that requirement, and on a 1-minute swing the spread can be a
material fraction of the whole move. `report()` therefore returns the
average risk distance in basis points, which is the number that determines
whether any of this is viable on a given venue.

ONE CLAIM IS NOT IMPLEMENTED, DELIBERATELY
------------------------------------------
"A stop-loss hit is a signal to look for a reversal rather than a failure."
That is available as `flip_after_stop`, off by default. Treating a loss as
evidence for the opposite trade is a rationalisation unless it is tested —
so it is tested, as an option, rather than assumed either way.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .strategy import Strategy


@dataclass
class FibBosConfig:
    #: Bars each side needed to confirm a swing pivot. A swing is knowable
    #: only `swing_n` bars after it forms; the detector respects that.
    swing_n: int = 2
    #: Fibonacci entry band.
    fib_low: float = 0.5
    fib_high: float = 0.618
    #: Bars after the BOS in which the retracement must arrive. The video
    #: says "wait for the next break of structure" if momentum stalls.
    entry_window: int = 20
    risk_reward: float = 1.5
    #: Extra room beyond the swing origin for the stop, as a fraction of the
    #: swing height. 0 places the stop exactly at the origin.
    stop_buffer_frac: float = 0.05
    #: "7-15 minutes" — abandon the trade after this many bars.
    max_hold_bars: int = 30
    #: Treat a stop-out as a signal to take the opposite trade.
    flip_after_stop: bool = False
    allow_long: bool = True
    allow_short: bool = True


@dataclass
class FibTrade:
    direction: int
    entry_time: pd.Timestamp
    entry: float
    stop: float
    target: float
    swing_low: float
    swing_high: float
    risk_bps: float
    exit_time: pd.Timestamp | None = None
    exit: float | None = None
    r_multiple: float = 0.0
    reason: str = ""
    bars_held: int = 0
    was_flip: bool = False


class FibBosScalper(Strategy):
    """BOS -> Fibonacci gold-zone entry -> 1.5R target."""

    def __init__(self, config: FibBosConfig | None = None, **kw):
        self.cfg = config or FibBosConfig(**kw)
        self.warmup = 60
        self._pos = 0.0
        self._t: FibTrade | None = None
        self.trades: list[FibTrade] = []
        #: pending setup: (direction, swing_low, swing_high, bars_waited)
        self._setup: tuple[int, float, float, int] | None = None
        self._pending_flip: int = 0
        self._last_risk: float = 0.0
        self.bos_count = 0
        self.setups_expired = 0

    def sync_position(self, actual_weight: float) -> None:
        if actual_weight == 0.0 and self._pos != 0.0:
            self._pos = 0.0
            self._t = None

    # ------------------------------------------------------------------
    def _swings(self, h: np.ndarray, l: np.ndarray, upto: int):
        """Confirmed pivots only — a swing at i needs swing_n bars to its
        right, so it is invisible until bar i + swing_n."""
        n = self.cfg.swing_n
        highs, lows = [], []
        for i in range(n, upto - n + 1):
            if h[i] == h[i - n:i + n + 1].max():
                highs.append((i, h[i]))
            if l[i] == l[i - n:i + n + 1].min():
                lows.append((i, l[i]))
        return highs, lows

    def on_bar(self, hist: pd.DataFrame) -> float:
        if len(hist) < self.warmup:
            return 0.0
        ts = pd.Timestamp(hist["timestamp"].iloc[-1])

        if self._pos != 0.0:
            return self._manage(hist, ts)

        # "A stop-loss hit is a signal to look for the reversal." Taken
        # literally: immediately take the opposite side, same risk distance.
        # The video does not specify a stop for the flip, so the symmetric
        # reading is used — anything else would be inventing a rule.
        if self._pending_flip:
            d = self._pending_flip
            self._pending_flip = 0
            px = float(hist["close"].iloc[-1])
            risk = self._last_risk
            if risk > 0:
                return self._open(d, px, px - d * risk, px - d * risk, px, ts,
                                  flip=True)

        # Bounded window: every lookback here is finite.
        w = hist.iloc[-120:]
        h = w["high"].to_numpy(dtype=float)
        l = w["low"].to_numpy(dtype=float)
        c = w["close"].to_numpy(dtype=float)
        i = len(w) - 1

        highs, lows = self._swings(h, l, i)
        if len(highs) < 2 or len(lows) < 2:
            return 0.0

        last_high_i, last_high = highs[-1]
        last_low_i, last_low = lows[-1]

        # ---- 1 & 2: break of structure ----
        if self._setup is None:
            # Bullish BOS: close above the most recent confirmed swing high,
            # with a swing low behind it to anchor the retracement.
            if self.cfg.allow_long and c[i] > last_high and last_low_i < last_high_i:
                self._setup = (1, last_low, c[i], 0)
                self.bos_count += 1
            elif self.cfg.allow_short and c[i] < last_low and last_high_i < last_low_i:
                self._setup = (-1, c[i], last_high, 0)
                self.bos_count += 1
            return 0.0

        # ---- 3 & 4: wait for the retracement into the gold zone ----
        direction, lo, hi, waited = self._setup
        waited += 1
        if waited > self.cfg.entry_window:
            self._setup = None
            self.setups_expired += 1
            return 0.0
        self._setup = (direction, lo, hi, waited)

        height = hi - lo
        if height <= 0:
            self._setup = None
            return 0.0

        if direction > 0:
            zone_hi = hi - self.cfg.fib_low * height       # 0.5 retrace
            zone_lo = hi - self.cfg.fib_high * height      # 0.618 retrace
            entered = float(w["low"].iloc[-1]) <= zone_hi
            if entered:
                price = min(float(w["close"].iloc[-1]), zone_hi)
                stop = lo - height * self.cfg.stop_buffer_frac
                return self._open(1, price, stop, lo, hi, ts)
        else:
            zone_lo = lo + self.cfg.fib_low * height
            zone_hi = lo + self.cfg.fib_high * height
            entered = float(w["high"].iloc[-1]) >= zone_lo
            if entered:
                price = max(float(w["close"].iloc[-1]), zone_lo)
                stop = hi + height * self.cfg.stop_buffer_frac
                return self._open(-1, price, stop, lo, hi, ts)

        return 0.0

    # ------------------------------------------------------------------
    def _open(self, direction, price, stop, lo, hi, ts, flip=False) -> float:
        risk = abs(price - stop)
        if risk <= 0 or price <= 0:
            self._setup = None
            return 0.0
        self._t = FibTrade(
            direction=direction, entry_time=ts, entry=price, stop=stop,
            target=price + direction * risk * self.cfg.risk_reward,
            swing_low=lo, swing_high=hi,
            risk_bps=1e4 * risk / price, was_flip=flip,
        )
        self._pos = float(direction)
        self._setup = None
        return self._pos

    def _manage(self, hist: pd.DataFrame, ts) -> float:
        t = self._t
        assert t is not None
        t.bars_held += 1
        hi = float(hist["high"].iloc[-1])
        lo = float(hist["low"].iloc[-1])

        # Stop before target on an ambiguous bar — the pessimistic reading.
        if (t.direction > 0 and lo <= t.stop) or (t.direction < 0 and hi >= t.stop):
            return self._close(t.stop, "stop", ts)
        if (t.direction > 0 and hi >= t.target) or (t.direction < 0 and lo <= t.target):
            return self._close(t.target, "target", ts)
        if t.bars_held >= self.cfg.max_hold_bars:
            return self._close(float(hist["close"].iloc[-1]), "timeout", ts)
        return self._pos

    def _close(self, price, reason, ts) -> float:
        t = self._t
        assert t is not None
        risk = abs(t.entry - t.stop)
        t.exit_time, t.exit, t.reason = ts, price, reason
        t.r_multiple = ((price - t.entry) * t.direction) / risk if risk else 0.0
        self.trades.append(t)
        # "A stop is a signal to look for the reversal" — only if enabled.
        if reason == "stop" and self.cfg.flip_after_stop:
            self._pending_flip = -t.direction
            self._last_risk = risk
        self._t = None
        self._pos = 0.0
        return 0.0

    # ------------------------------------------------------------------
    def report(self) -> dict:
        if not self.trades:
            return {"n_trades": 0, "bos_detected": self.bos_count}
        df = pd.DataFrame([vars(t) for t in self.trades])
        r = df["r_multiple"]
        wins, losses = r[r > 0], r[r <= 0]
        gw = float(wins.sum()) if len(wins) else 0.0
        gl = float(-losses.sum()) if len(losses) else 0.0
        return {
            "n_trades": len(df),
            "bos_detected": self.bos_count,
            "setups_expired": self.setups_expired,
            "fill_rate": len(df) / max(self.bos_count, 1),
            "win_rate": float((r > 0).mean()),
            "expectancy_r": float(r.mean()),
            "total_r": float(r.sum()),
            "profit_factor": (gw / gl) if gl > 0 else float("inf"),
            # The number that decides viability: how big is 1R in basis
            # points? If it approaches the round-trip cost, the payoff
            # structure is irrelevant.
            "avg_risk_bps": float(df["risk_bps"].mean()),
            "median_risk_bps": float(df["risk_bps"].median()),
            "avg_bars_held": float(df["bars_held"].mean()),
            "exits": df["reason"].value_counts().to_dict(),
        }
