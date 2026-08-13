"""
Markov regime-switching — the "hedge fund transition matrix" strategy.

The method, which is genuinely standard quant practice rather than an
indicator mashup:

  1. Label every bar with a STATE: bull, bear or sideways.
  2. Count what historically followed each state, giving a TRANSITION MATRIX:

                    -> bull   -> bear   -> side
        from bull     0.70      0.10      0.20
        from bear     0.15      0.65      0.20
        from side     0.30      0.25      0.45

  3. Read today's state, look up its row, and trade the odds.

The diagonal is the whole idea. Those numbers are "stickiness" — how often a
regime persists. If the diagonal were 1/3 everywhere the market would be
memoryless and no trend strategy could work at all. Trend following is a bet
that the diagonal exceeds chance.

THE LOOKAHEAD TRAP THIS METHOD INVITES
--------------------------------------
Building the matrix from the WHOLE history and then backtesting over that
same history means every trade was informed by counts that include its own
future. It is subtle, it looks like ordinary estimation, and it inflates
results substantially.

`expanding=True` (the default) rebuilds the matrix at each bar from data
strictly BEFORE that bar — the only honest version. `expanding=False` uses
the full-sample matrix and exists solely so `run_markov.py` can measure how
large the bias is, rather than asserting it.

A second, quieter trap: the state THRESHOLD. Choosing "bull = 20-day return
above +2%" by trying several and keeping the best fits the labels to the
data. Here the threshold is a multiple of trailing volatility, computed
causally, so it adapts per instrument without being fitted to outcomes.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .strategy import Strategy

BULL, SIDE, BEAR = 0, 1, 2
STATE_NAMES = {BULL: "bull", SIDE: "sideways", BEAR: "bear"}


@dataclass
class MarkovConfig:
    #: Bars over which the return defining the state is measured.
    lookback: int = 20
    #: State boundary, in trailing standard deviations of that return.
    #: Volatility-scaled rather than a fixed percentage, so one setting works
    #: on both the S&P and Bitcoin without being tuned per asset.
    threshold_sd: float = 0.5
    #: Bars of trailing volatility used to scale the threshold.
    vol_window: int = 252
    #: Minimum observations before the matrix is trusted.
    min_history: int = 252
    #: Honest (expanding) vs full-sample (lookahead) estimation.
    expanding: bool = True
    #: "argmax"  -> long if bull is the most likely next state, etc.
    #: "expected"-> weight = P(bull) - P(bear), a continuous tilt.
    mode: str = "expected"
    allow_short: bool = True
    #: Laplace smoothing, so an unseen transition is improbable not impossible.
    alpha: float = 1.0


def classify_states(close: pd.Series, cfg: MarkovConfig) -> np.ndarray:
    """Label each bar bull/sideways/bear. Causal — uses only past data.

    The state at bar t is defined by the return OVER the trailing `lookback`
    bars ending at t, compared to a threshold scaled by trailing volatility.
    Nothing after t is consulted.
    """
    ret = close.pct_change(cfg.lookback)
    vol = ret.rolling(cfg.vol_window, min_periods=cfg.vol_window // 4).std()
    thr = cfg.threshold_sd * vol

    states = np.full(len(close), -1, dtype=int)
    r = ret.to_numpy()
    t = thr.to_numpy()
    valid = ~(np.isnan(r) | np.isnan(t))
    states[valid & (r > t)] = BULL
    states[valid & (r < -t)] = BEAR
    states[valid & (np.abs(r) <= t)] = SIDE
    return states


def transition_matrix(states: np.ndarray, alpha: float = 1.0) -> np.ndarray:
    """Row-normalised 3x3 transition matrix with Laplace smoothing."""
    counts = np.full((3, 3), alpha, dtype=float)
    valid = states >= 0
    for a, b in zip(states[:-1], states[1:]):
        if a >= 0 and b >= 0:
            counts[a, b] += 1.0
    return counts / counts.sum(axis=1, keepdims=True)


class MarkovRegime(Strategy):
    """Trade the transition probabilities of a 3-state regime model."""

    def __init__(self, config: MarkovConfig | None = None, **kw):
        self.cfg = config or MarkovConfig(**kw)
        self.warmup = max(self.cfg.lookback + self.cfg.vol_window,
                          self.cfg.min_history) + 5
        self._states: np.ndarray | None = None
        self._full_matrix: np.ndarray | None = None
        # Incremental counts: rebuilding the matrix from scratch every bar is
        # O(n^2) over a 30-year series. Counts only ever grow, so they can be
        # updated in O(1) per bar without changing a single number.
        self._counts = np.full((3, 3), self.cfg.alpha, dtype=float)
        self._counted_upto = 0
        self._seen: list[int] = []
        self.history: list[dict] = []

    def prepare(self, bars: pd.DataFrame) -> None:
        """Precompute states over the FULL series.

        Required only for `expanding=False` (the deliberately biased mode),
        which needs a matrix built from data the strategy could not have seen.
        Requiring an explicit call keeps that bias visible in the calling code
        rather than buried in the strategy.
        """
        self._states = classify_states(bars["close"], self.cfg)
        if not self.cfg.expanding:
            self._full_matrix = transition_matrix(self._states, self.cfg.alpha)

    def _current_state(self, history: pd.DataFrame) -> int:
        """Classify the CURRENT bar from a bounded trailing window.

        Computed fresh each bar rather than cached. An earlier version
        precomputed the whole state array on the first call — when `history`
        was only `warmup` bars long — and never grew it, so every bar past
        the warmup fell off the end of the array and returned no position.
        The strategy silently took ZERO trades on a 4,348-bar series while
        reporting a clean 0.00% and no error.
        """
        need = self.cfg.vol_window + self.cfg.lookback + 2
        tail = history["close"].iloc[-need:] if len(history) > need else history["close"]
        st = classify_states(tail, self.cfg)
        return int(st[-1])

    def on_bar(self, history: pd.DataFrame) -> float:
        i = len(history) - 1
        if i < self.warmup:
            return 0.0

        if self._states is not None and i < len(self._states):
            cur = int(self._states[i])          # precomputed (biased mode)
        else:
            cur = self._current_state(history)  # incremental (honest mode)
        if cur < 0:
            return 0.0
        self._seen.append(cur)

        if self.cfg.expanding:
            # Count transitions strictly BEFORE the current bar. The last
            # observed pair is excluded: at decision time the move INTO
            # today's state is information, but the move OUT of it has not
            # happened yet, and counting it would leak the future.
            seen = self._seen
            while self._counted_upto < len(seen) - 2:
                a, b = seen[self._counted_upto], seen[self._counted_upto + 1]
                self._counts[a, b] += 1.0
                self._counted_upto += 1
            if self._counts.sum() < self.cfg.min_history:
                return 0.0
            P = self._counts / self._counts.sum(axis=1, keepdims=True)
        else:
            if self._full_matrix is None:
                raise RuntimeError(
                    "expanding=False requires prepare(full_bars) first — the "
                    "biased mode needs data the strategy cannot legitimately see")
            P = self._full_matrix  # LOOKAHEAD: includes the future

        row = P[cur]
        p_bull, p_side, p_bear = row[BULL], row[SIDE], row[BEAR]

        if self.cfg.mode == "argmax":
            nxt = int(np.argmax(row))
            w = 1.0 if nxt == BULL else (-1.0 if nxt == BEAR else 0.0)
        else:
            w = float(p_bull - p_bear)

        if not self.cfg.allow_short:
            w = max(w, 0.0)

        self.history.append({
            "timestamp": history["timestamp"].iloc[-1],
            "state": STATE_NAMES[cur],
            "p_bull": p_bull, "p_side": p_side, "p_bear": p_bear,
            "weight": w,
        })
        return w

    # ------------------------------------------------------------------
    def report(self) -> dict:
        if not self.history:
            return {"bars": 0}
        df = pd.DataFrame(self.history)
        counts = df["state"].value_counts(normalize=True).to_dict()
        P = self._counts / self._counts.sum(axis=1, keepdims=True)
        return {
            "bars_traded": len(df),
            "state_mix": {k: round(v, 3) for k, v in counts.items()},
            "mean_weight": float(df["weight"].mean()),
            "pct_long": float((df["weight"] > 0).mean()),
            "pct_short": float((df["weight"] < 0).mean()),
            # The diagonal IS the strategy's premise, so it is reported.
            "stickiness_bull": float(P[BULL, BULL]),
            "stickiness_side": float(P[SIDE, SIDE]),
            "stickiness_bear": float(P[BEAR, BEAR]),
            "matrix": np.round(P, 3).tolist(),
        }
