"""
Adaptive regime switching — "letting the bot learn".

The timeframe study produced a genuinely useful observation: trend following
and mean reversion are mirror images. Trend won at H1 (+23.87%) and died at
5min (-3.72%); mean reversion did the exact opposite (+14.98% at 5min,
-25.49% at 1D). They are not competing answers, they are answers to different
market conditions.

So rather than pick one, measure which condition you are in and switch.

WHAT "LEARNING" MEANS HERE
--------------------------
Two different mechanisms, and it is worth keeping them apart:

1. **Online regime detection** (this module). Every bar, the strategy
   measures how trending the market currently is and picks its behaviour
   accordingly. No training, no fitted weights — it adapts continuously and
   cannot overfit, because there is nothing stored to overfit with.

2. **Periodic re-tuning** (`walkforward.py`). Parameters are re-fitted on
   recent history each window, then traded blind. That is the closest thing
   here to conventional machine learning, and it carries the matching risk:
   if the tuner is fitting noise, "learning" makes it worse, not better.
   Parameter instability across windows is how you detect that.

Both are honest forms of learning. Neither is a reason to trust a result —
an adaptive strategy that loses is still a losing strategy, and adaptivity
adds parameters, which makes overfitting *easier*, not harder.

THE REGIME MEASURE
------------------
Kaufman's Efficiency Ratio over N bars:

    ER = |P_t - P_(t-N)|  /  sum(|P_i - P_(i-1)|)

Net distance travelled divided by total distance travelled. A straight line
gives ER = 1 (perfectly trending). Violent chop that ends where it started
gives ER near 0. It is parameter-light, has no lookahead, and needs no
fitting — properties worth more than sophistication.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .strategy import Strategy


def efficiency_ratio(prices: pd.Series, window: int) -> float:
    """Kaufman's Efficiency Ratio in [0, 1]. 1 = clean trend, 0 = pure chop."""
    if len(prices) < window + 1:
        return 0.0
    seg = prices.iloc[-(window + 1) :]
    net = abs(float(seg.iloc[-1]) - float(seg.iloc[0]))
    path = float(seg.diff().abs().sum())
    if path == 0:
        return 0.0
    return net / path


class AdaptiveRegime(Strategy):
    """Trend-follow when the market trends, fade it when it chops.

    Parameters
    ----------
    er_window     : bars used to measure the efficiency ratio
    er_threshold  : above this, treat the market as trending
    fast, slow    : moving averages for the trend leg
    mr_lookback   : window for the mean-reversion z-score
    mr_entry_z    : z-score needed to fade a move
    allow_short   : if False, negative signals become flat

    The `neutral_band` exists to stop the strategy thrashing between modes
    when ER sits exactly on the threshold. Without it, a market hovering at
    the boundary flips behaviour every bar and pays costs for the privilege.
    """

    def __init__(
        self,
        er_window: int = 20,
        er_threshold: float = 0.35,
        neutral_band: float = 0.05,
        fast: int = 20,
        slow: int = 50,
        mr_lookback: int = 20,
        mr_entry_z: float = 1.5,
        allow_short: bool = True,
    ):
        self.er_window = er_window
        self.er_threshold = er_threshold
        self.neutral_band = neutral_band
        self.fast = fast
        self.slow = slow
        self.mr_lookback = mr_lookback
        self.mr_entry_z = mr_entry_z
        self.allow_short = allow_short
        self.warmup = max(slow, mr_lookback, er_window) + 1
        self._mode = "trend"
        #: per-bar record of which regime was detected — inspect this to check
        #: the switch is doing something rather than sitting in one mode
        self.regime_log: list[dict] = []

    def on_bar(self, history: pd.DataFrame) -> float:
        close = history["close"]
        er = efficiency_ratio(close, self.er_window)

        # Hysteresis: only flip mode once ER clears the band, not at the line.
        if er > self.er_threshold + self.neutral_band:
            self._mode = "trend"
        elif er < self.er_threshold - self.neutral_band:
            self._mode = "revert"

        if self._mode == "trend":
            w = self._trend(close)
        else:
            w = self._revert(close)

        if not self.allow_short and w < 0:
            w = 0.0

        self.regime_log.append(
            {
                "timestamp": history["timestamp"].iloc[-1],
                "er": er,
                "mode": self._mode,
                "weight": w,
            }
        )
        return w

    # ------------------------------------------------------------------
    def _trend(self, close: pd.Series) -> float:
        f = close.iloc[-self.fast :].mean()
        s = close.iloc[-self.slow :].mean()
        return 1.0 if f > s else -1.0

    def _revert(self, close: pd.Series) -> float:
        w = close.iloc[-self.mr_lookback :]
        mu, sd = w.mean(), w.std()
        if sd == 0 or pd.isna(sd):
            return 0.0
        z = (float(close.iloc[-1]) - mu) / sd
        if z > self.mr_entry_z:
            return -1.0
        if z < -self.mr_entry_z:
            return 1.0
        return 0.0

    # ------------------------------------------------------------------
    def regime_report(self) -> dict:
        """Did the switch actually switch? A strategy stuck in one mode is
        not adaptive, it is the underlying strategy wearing a costume."""
        if not self.regime_log:
            return {"bars": 0}
        df = pd.DataFrame(self.regime_log)
        modes = df["mode"].value_counts(normalize=True).to_dict()
        flips = int((df["mode"] != df["mode"].shift()).sum() - 1)
        return {
            "bars": len(df),
            "pct_trend_mode": modes.get("trend", 0.0),
            "pct_revert_mode": modes.get("revert", 0.0),
            "mode_switches": flips,
            "mean_er": float(df["er"].mean()),
            "pct_bars_in_position": float((df["weight"] != 0).mean()),
        }
