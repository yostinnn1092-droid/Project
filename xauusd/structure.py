"""
Market structure: swing points, support/resistance zones, headroom checks.

Structure answers three questions the indicators cannot:

  * where does a stop belong, so that being wrong is *structurally* wrong
    rather than merely unlucky?
  * is there a wall of resistance directly above this long?
  * is the reward available before that wall worth the risk being taken?

No fixed price levels appear anywhere. Everything is derived from the bars.

THE CONFIRMATION LAG, WHICH MATTERS MORE THAN IT LOOKS
------------------------------------------------------
A swing high at bar i needs `lookback` bars on BOTH sides to be a swing. It
is therefore not knowable until bar i + lookback. Detectors that scan the
whole series and return every fractal are reading the future for the last
`lookback` bars of every window — a lookahead bug that shows up as uncannily
well-placed stops.

`find_swings` refuses to report a swing before it is confirmed.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class SwingPoint:
    index: int
    timestamp: pd.Timestamp
    price: float
    kind: str  # "high" | "low"


@dataclass(frozen=True)
class Zone:
    """A merged support/resistance band."""

    low: float
    high: float
    touches: int
    kind: str  # "resistance" | "support"

    @property
    def mid(self) -> float:
        return (self.low + self.high) / 2.0

    def contains(self, price: float) -> bool:
        return self.low <= price <= self.high


def find_swings(df: pd.DataFrame, lookback: int = 3,
                as_of: int | None = None) -> list[SwingPoint]:
    """Confirmed swing highs and lows in `df`, up to bar `as_of`.

    A swing at i is reported only if i + lookback <= as_of, i.e. only once
    enough bars have printed to the RIGHT of it to confirm it. Bars nearer
    the present than that are deliberately invisible.
    """
    n = len(df)
    if as_of is None:
        as_of = n - 1
    h = df["high"].to_numpy(dtype=float)
    l = df["low"].to_numpy(dtype=float)
    ts = df["timestamp"].to_numpy()

    out: list[SwingPoint] = []
    last_confirmable = as_of - lookback
    for i in range(lookback, last_confirmable + 1):
        w_hi = h[i - lookback: i + lookback + 1]
        w_lo = l[i - lookback: i + lookback + 1]
        if h[i] == w_hi.max() and (w_hi.argmax() == lookback):
            out.append(SwingPoint(i, pd.Timestamp(ts[i]), float(h[i]), "high"))
        if l[i] == w_lo.min() and (w_lo.argmin() == lookback):
            out.append(SwingPoint(i, pd.Timestamp(ts[i]), float(l[i]), "low"))
    return out


def build_zones(swings: list[SwingPoint], kind: str, atr_value: float,
                merge_atr: float = 0.5) -> list[Zone]:
    """Cluster nearby swing levels into zones.

    Two swing highs a few cents apart are one level that price respected
    twice, not two levels. Merging them means `touches` counts genuine
    retests, which is what makes a zone worth avoiding.
    """
    pts = sorted([s.price for s in swings if s.kind == ("high" if kind == "resistance" else "low")])
    if not pts:
        return []

    tol = max(atr_value * merge_atr, 1e-9)
    zones: list[Zone] = []
    cur = [pts[0]]
    for p in pts[1:]:
        if p - cur[-1] <= tol:
            cur.append(p)
        else:
            zones.append(Zone(min(cur), max(cur), len(cur), kind))
            cur = [p]
    zones.append(Zone(min(cur), max(cur), len(cur), kind))
    return zones


def nearest_zone_above(zones: list[Zone], price: float) -> Zone | None:
    cands = [z for z in zones if z.low > price]
    return min(cands, key=lambda z: z.low) if cands else None


def nearest_zone_below(zones: list[Zone], price: float) -> Zone | None:
    cands = [z for z in zones if z.high < price]
    return max(cands, key=lambda z: z.high) if cands else None


def recent_swing_low(swings: list[SwingPoint], before_index: int,
                     within: int = 40) -> float | None:
    c = [s for s in swings
         if s.kind == "low" and before_index - within <= s.index <= before_index]
    return min(s.price for s in c) if c else None


def recent_swing_high(swings: list[SwingPoint], before_index: int,
                      within: int = 40) -> float | None:
    c = [s for s in swings
         if s.kind == "high" and before_index - within <= s.index <= before_index]
    return max(s.price for s in c) if c else None


def headroom_ok(price: float, stop: float, direction: int,
                zones: list[Zone], min_headroom_r: float) -> tuple[bool, str]:
    """Is there room to the next barrier worth the risk being taken?

    Buying with a wall of resistance 0.3R above is a poor trade even when the
    signal is valid: the reward is capped below the risk before the trade
    starts. Returns (ok, human-readable reason) so the journal can record
    WHY a setup was rejected, not merely that it was.
    """
    risk = abs(price - stop)
    if risk <= 0:
        return False, "non-positive risk distance"

    barrier = (nearest_zone_above(zones, price) if direction > 0
               else nearest_zone_below(zones, price))
    if barrier is None:
        return True, "no opposing structure within lookback"

    room = (barrier.low - price) if direction > 0 else (price - barrier.high)
    room_r = room / risk
    if room_r < min_headroom_r:
        return False, (f"only {room_r:.2f}R to {barrier.kind} "
                       f"{barrier.low:.2f}-{barrier.high:.2f} "
                       f"(need {min_headroom_r:.2f}R)")
    return True, f"{room_r:.2f}R of headroom to next {barrier.kind}"
