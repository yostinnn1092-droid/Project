"""
ICT (Inner Circle Trader) concepts, made mechanical and testable.

ICT is one of the most popular retail methodologies in forex, and unusually
for retail material its core ideas have *precise* definitions — a Fair Value
Gap either exists on three candles or it does not. That makes it testable in
a way that "trade with the trend" is not.

THE CONCEPTS IMPLEMENTED
------------------------
**Liquidity sweep (stop hunt).** Price pushes through a prior swing low,
triggering resting stop-loss orders, then closes back above it. The claim is
that this is engineered: large participants source liquidity where retail
stops sit, then move the other way.

**Market Structure Shift (MSS).** After the sweep, price closes beyond the
most recent opposing swing point — read as a change in intent.

**Fair Value Gap (FVG).** A three-candle imbalance where candle 1's high and
candle 3's low do not overlap, leaving a price range that traded through in
one direction only. The claim is that price returns to "rebalance" it.

**Killzones.** ICT holds that setups are only valid in specific sessions —
London and New York opens — rather than at any hour.

The canonical long setup chains them: sweep a low → MSS upward → enter on the
retracement into the FVG → stop under the sweep → target a fixed R multiple.

WHAT THIS TEST CAN AND CANNOT SETTLE
------------------------------------
It tests ONE mechanical reading of ICT. Practitioners will reasonably object
that real ICT includes higher-timeframe bias, judgement about *which*
liquidity pool matters, and discretion about setup quality — none of which is
here.

That objection is fair, and it cuts both ways. A method that cannot be
specified precisely enough to test also cannot be verified, only believed,
and its failures can always be attributed to the practitioner rather than the
method. What follows is a falsifiable version. If it works, that is evidence
for the mechanical core; if it fails, the discretionary layer is doing the
work and has not been demonstrated.

THE CONTROL — the part that actually matters
--------------------------------------------
ICT imposes a stop and a fixed reward:risk on every trade. That structure
*alone* produces characteristic win rates and equity curves regardless of
whether entries carry information: a 2R target with a tight stop will lose
often and win big, and can look profitable in a trending sample by accident.

So `RandomEntry` runs identical risk management — same stop distance, same R
multiple, same hold limit, same trade frequency, same killzone filter — with
entries chosen at random. Comparing the two isolates the only question worth
asking: **does the ICT setup identify anything, or is it the money management
doing all the work?**
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .strategy import Strategy


@dataclass
class ICTConfig:
    swing_n: int = 2             # bars each side needed to confirm a swing
    sweep_lookback: int = 24     # how far back to look for liquidity
    mss_window: int = 12         # bars after a sweep in which MSS must occur
    require_fvg: bool = True     # enter only on retrace into the FVG
    fvg_window: int = 12         # bars an FVG stays valid
    risk_reward: float = 2.0     # target as a multiple of risk
    stop_buffer_bps: float = 2.0  # extra room beyond the sweep extreme
    max_hold: int = 24           # bars before abandoning a trade
    killzone_only: bool = True
    # UTC hours. London open ~07-10, New York open ~12-15 (EDT).
    killzone_hours: tuple = (7, 8, 9, 12, 13, 14)
    allow_short: bool = True


class _SetupEngine:
    """Shared bookkeeping: swings, sweeps, structure, FVGs, trade management.

    Deliberately separate from the entry decision so `ICTStrategy` and
    `RandomEntry` share *identical* mechanics and differ only in what
    triggers an entry.
    """

    def __init__(self, cfg: ICTConfig):
        self.cfg = cfg
        self.warmup = cfg.sweep_lookback + cfg.swing_n + 5
        self._pos = 0.0
        self._entry: float | None = None
        self._stop: float | None = None
        self._target: float | None = None
        self._held = 0
        self.trades: list[dict] = []
        self._pending_reason = ""

    # -- structure -----------------------------------------------------
    def _swings(self, h: np.ndarray, l: np.ndarray) -> tuple[list[int], list[int]]:
        """Confirmed swing indices. A swing at i needs `swing_n` bars on BOTH
        sides, so it is only knowable `swing_n` bars later — the loop stops
        short accordingly rather than peeking at the future."""
        n = self.cfg.swing_n
        highs, lows = [], []
        for i in range(n, len(h) - n):
            if h[i] == max(h[i - n : i + n + 1]):
                highs.append(i)
            if l[i] == min(l[i - n : i + n + 1]):
                lows.append(i)
        return highs, lows

    def detect(self, hist: pd.DataFrame) -> dict:
        """Return the current setup state from data up to and including now.

        Only the recent tail is scanned. Every lookback in the config is
        bounded (sweep_lookback, mss_window, fvg_window), so bars older than
        their sum cannot change the answer — and rescanning the full history
        on every bar makes the backtest O(n^2), which on 12,000 bars x 10
        pairs takes longer than the research it is meant to serve.
        """
        cfg = self.cfg
        need = (cfg.sweep_lookback + cfg.mss_window + cfg.fvg_window
                + 4 * cfg.swing_n + 10)
        if len(hist) > need:
            hist = hist.iloc[-need:]
        h = hist["high"].to_numpy(dtype=float)
        l = hist["low"].to_numpy(dtype=float)
        c = hist["close"].to_numpy(dtype=float)
        i = len(hist) - 1

        sh, sl = self._swings(h, l)
        # Only swings confirmed strictly before now are usable.
        sh = [j for j in sh if j <= i - cfg.swing_n]
        sl = [j for j in sl if j <= i - cfg.swing_n]
        if not sh or not sl:
            return {}

        lo_win = max(0, i - cfg.sweep_lookback)
        recent_lows = [j for j in sl if j >= lo_win]
        recent_highs = [j for j in sh if j >= lo_win]

        state: dict = {}

        # --- liquidity sweeps in the last mss_window bars ---
        for k in range(max(lo_win, i - cfg.mss_window), i + 1):
            for j in recent_lows:
                if j < k and l[k] < l[j] and c[k] > l[j]:
                    state.setdefault("bull_sweep", {"bar": k, "low": l[k]})
            for j in recent_highs:
                if j < k and h[k] > h[j] and c[k] < h[j]:
                    state.setdefault("bear_sweep", {"bar": k, "high": h[k]})

        # --- market structure shift AFTER the sweep ---
        if "bull_sweep" in state:
            k = state["bull_sweep"]["bar"]
            prior = [j for j in sh if j < i and j >= k - cfg.mss_window]
            if prior and c[i] > h[max(prior)]:
                state["bull_mss"] = True
        if "bear_sweep" in state:
            k = state["bear_sweep"]["bar"]
            prior = [j for j in sl if j < i and j >= k - cfg.mss_window]
            if prior and c[i] < l[min(prior)]:
                state["bear_mss"] = True

        # --- fair value gaps in the recent window ---
        # Bullish FVG at bar m: low[m] > high[m-2] — a gap left unfilled.
        for m in range(max(2, i - cfg.fvg_window), i + 1):
            if l[m] > h[m - 2]:
                state["bull_fvg"] = (h[m - 2], l[m])
            if h[m] < l[m - 2]:
                state["bear_fvg"] = (h[m], l[m - 2])

        state["price"] = c[i]
        state["in_killzone"] = (
            not cfg.killzone_only
            or pd.Timestamp(hist["timestamp"].iloc[-1]).hour in cfg.killzone_hours
        )
        return state

    # -- trade management ----------------------------------------------
    def manage(self, hist: pd.DataFrame) -> float | None:
        """If in a trade, check stop/target/timeout. Returns new weight or None.

        Stops and targets are detected using the bar's high/low but EXITED at
        the next bar's open (the engine fills there). That is deliberately
        pessimistic — a real stop would usually fill closer to its level —
        and it understates performance rather than flattering it.
        """
        if self._pos == 0.0:
            return None
        self._held += 1
        hi = float(hist["high"].iloc[-1])
        lo = float(hist["low"].iloc[-1])

        if self._pos > 0:
            if lo <= self._stop:
                return self._close("stop", hist)
            if hi >= self._target:
                return self._close("target", hist)
        else:
            if hi >= self._stop:
                return self._close("stop", hist)
            if lo <= self._target:
                return self._close("target", hist)

        if self._held >= self.cfg.max_hold:
            return self._close("timeout", hist)
        return self._pos

    def _open(self, side: float, price: float, stop: float, reason: str) -> float:
        risk = abs(price - stop)
        if risk <= 0:
            return 0.0
        self._pos = side
        self._entry = price
        self._stop = stop
        self._target = price + side * risk * self.cfg.risk_reward
        self._held = 0
        self._pending_reason = reason
        return side

    def _close(self, why: str, hist: pd.DataFrame) -> float:
        px = float(hist["close"].iloc[-1])
        self.trades.append({
            "timestamp": hist["timestamp"].iloc[-1],
            "side": "long" if self._pos > 0 else "short",
            "entry": self._entry,
            "exit": px,
            "gross_return": (px / self._entry - 1) * self._pos,
            "bars_held": self._held,
            "exit_reason": why,
            "setup": self._pending_reason,
        })
        self._pos = 0.0
        self._entry = self._stop = self._target = None
        self._held = 0
        return 0.0

    def sync(self, actual: float) -> None:
        if actual == 0.0 and self._pos != 0.0:
            self._pos = 0.0
            self._entry = self._stop = self._target = None
            self._held = 0

    def report(self) -> dict:
        if not self.trades:
            return {"n_trades": 0}
        df = pd.DataFrame(self.trades)
        g = df["gross_return"]
        wins = g[g > 0]
        return {
            "n_trades": len(df),
            "win_rate": float((g > 0).mean()),
            "avg_win_bps": float(wins.mean() * 1e4) if len(wins) else 0.0,
            "avg_loss_bps": float(g[g <= 0].mean() * 1e4) if (g <= 0).any() else 0.0,
            "expectancy_bps": float(g.mean() * 1e4),
            "avg_bars_held": float(df["bars_held"].mean()),
            "exits": df["exit_reason"].value_counts().to_dict(),
        }


class ICTStrategy(Strategy):
    """Liquidity sweep -> market structure shift -> FVG entry, with a fixed R target."""

    def __init__(self, config: ICTConfig | None = None, **kw):
        self.cfg = config or ICTConfig(**kw)
        self.eng = _SetupEngine(self.cfg)
        self.warmup = self.eng.warmup

    def sync_position(self, actual_weight: float) -> None:
        self.eng.sync(actual_weight)

    def on_bar(self, hist: pd.DataFrame) -> float:
        managed = self.eng.manage(hist)
        if managed is not None:
            return managed

        st = self.eng.detect(hist)
        if not st or not st.get("in_killzone"):
            return 0.0

        px = st["price"]
        buf = self.cfg.stop_buffer_bps / 1e4

        if st.get("bull_mss"):
            if self.cfg.require_fvg:
                fvg = st.get("bull_fvg")
                # Enter only if price has retraced back into the imbalance.
                if not fvg or not (fvg[0] <= px <= fvg[1]):
                    return 0.0
            stop = st["bull_sweep"]["low"] * (1 - buf)
            return self.eng._open(1.0, px, stop, "bull_sweep+mss")

        if st.get("bear_mss") and self.cfg.allow_short:
            if self.cfg.require_fvg:
                fvg = st.get("bear_fvg")
                if not fvg or not (fvg[0] <= px <= fvg[1]):
                    return 0.0
            stop = st["bear_sweep"]["high"] * (1 + buf)
            return self.eng._open(-1.0, px, stop, "bear_sweep+mss")

        return 0.0

    def report(self) -> dict:
        return self.eng.report()


class RandomEntry(Strategy):
    """The control: identical risk management, entries chosen at random.

    Same stop distance, same R multiple, same hold cap, same killzone filter.
    The ONLY difference is that entries carry no information. If ICT cannot
    beat this, its edge is the money management, not the setup.
    """

    def __init__(self, config: ICTConfig | None = None, entry_prob: float = 0.02,
                 stop_atr_mult: float = 1.0, seed: int = 0, **kw):
        self.cfg = config or ICTConfig(**kw)
        self.eng = _SetupEngine(self.cfg)
        self.warmup = self.eng.warmup
        self.entry_prob = entry_prob
        self.stop_atr_mult = stop_atr_mult
        self.rng = np.random.default_rng(seed)

    def sync_position(self, actual_weight: float) -> None:
        self.eng.sync(actual_weight)

    def on_bar(self, hist: pd.DataFrame) -> float:
        managed = self.eng.manage(hist)
        if managed is not None:
            return managed

        if self.cfg.killzone_only:
            if pd.Timestamp(hist["timestamp"].iloc[-1]).hour not in self.cfg.killzone_hours:
                return 0.0
        if self.rng.random() > self.entry_prob:
            return 0.0

        # Stop sized from recent range, so risk per trade is comparable to
        # ICT's sweep-based stop rather than arbitrarily tighter or wider.
        w = hist.iloc[-14:]
        rng_ = float((w["high"] - w["low"]).mean())
        px = float(hist["close"].iloc[-1])
        if rng_ <= 0:
            return 0.0
        side = 1.0 if self.rng.random() < 0.5 else -1.0
        if side < 0 and not self.cfg.allow_short:
            return 0.0
        stop = px - side * rng_ * self.stop_atr_mult
        return self.eng._open(side, px, stop, "random")

    def report(self) -> dict:
        return self.eng.report()
