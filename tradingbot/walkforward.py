"""
Walk-forward analysis.

A single train/test split answers "did this work once?". That is the minimum
honest test, and it is not a good one — you still chose where to cut, and one
test period can flatter a strategy by luck alone.

Walk-forward rolls the whole procedure through history:

    |--- train ---|- test -|
              |--- train ---|- test -|
                        |--- train ---|- test -|
                                  |--- train ---|- test -|

Each window re-tunes on data up to that point, then trades the next stretch
blind. Stitching those blind stretches end to end gives an out-of-sample
equity curve covering most of the history, produced by a procedure you could
actually have followed live — because at every point the parameters depend
only on the past.

WHAT TO LOOK AT, IN ORDER
-------------------------
1. **Consistency, not total return.** Nine losing windows and one enormous
   winner sums to a great headline and is not a strategy. The fraction of
   profitable windows matters more than their sum.
2. **Parameter stability.** If the best settings jump around every window —
   20/60, then 5/200, then 40/50 — the tuning is fitting noise, and next
   window's choice is a coin flip. Stable choices suggest a real effect.
3. **Only then, the return.** And compare it to buy-and-hold over the exact
   same span, or you are measuring the market rather than the strategy.

Walk-forward is harder to fool than a single split, but it is not proof. The
data is still one instrument over one history, and you still chose the window
sizes. Treat a good result as "worth paper trading", never as "verified".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import product

import numpy as np
import pandas as pd

from .backtest import Costs, run
from .risk import RiskLimits, RiskManager


@dataclass
class WindowResult:
    index: int
    train_start: pd.Timestamp
    test_start: pd.Timestamp
    test_end: pd.Timestamp
    params: dict
    train_sharpe: float
    test_return: float
    test_sharpe: float
    test_max_dd: float
    n_trades: int
    benchmark_return: float


@dataclass
class WalkForwardResult:
    windows: list[WindowResult] = field(default_factory=list)

    def frame(self) -> pd.DataFrame:
        return pd.DataFrame([vars(w) for w in self.windows])

    def summary(self) -> dict:
        if not self.windows:
            return {"n_windows": 0}
        df = self.frame()
        r = df["test_return"]
        b = df["benchmark_return"]
        # Chain window returns: this is the equity a live account would have
        # followed, since each window's parameters came only from its past.
        combined = float(np.prod(1 + r) - 1)
        bench = float(np.prod(1 + b) - 1)
        params = df["params"].map(lambda d: tuple(sorted(d.items())))
        return {
            "n_windows": len(df),
            "profitable_windows": int((r > 0).sum()),
            "win_rate": float((r > 0).mean()),
            "mean_window_return": float(r.mean()),
            "median_window_return": float(r.median()),
            "worst_window": float(r.min()),
            "best_window": float(r.max()),
            "combined_oos_return": combined,
            "benchmark_combined": bench,
            "excess_over_benchmark": combined - bench,
            "mean_test_sharpe": float(df["test_sharpe"].mean()),
            "worst_max_drawdown": float(df["test_max_dd"].min()),
            "distinct_param_sets": int(params.nunique()),
            "most_common_params": params.mode().iloc[0] if len(params) else None,
            "total_trades": int(df["n_trades"].sum()),
        }


def walk_forward(
    bars: pd.DataFrame,
    strategy_factory,
    param_grid: dict,
    train_size: int,
    test_size: int,
    warmup: int,
    step: int | None = None,
    costs: Costs | None = None,
    bar_freq: str = "1h",
    benchmark_factory=None,
    initial_equity: float = 10_000.0,
    risk_factory=None,
) -> WalkForwardResult:
    """Roll a tune-then-trade procedure through `bars`.

    strategy_factory : callable(**params) -> Strategy
    param_grid       : {"fast": [10, 20], "slow": [50, 100]} — searched fully
    warmup           : bars of history prepended to each test window so
                       indicators are warm at the first tradeable bar. Use the
                       LARGEST warmup in the grid so every window starts at the
                       same place regardless of which parameters win.
    risk_factory     : callable() -> RiskManager, applied identically to the
                       strategy AND the benchmark. Defaults to limits that
                       never fire.

    WHY RISK LIMITS DEFAULT TO OFF HERE. A `RiskManager()` with stock defaults
    halts at a 5% daily loss and stays halted for the rest of the window. That
    is correct behaviour for trading and ruinous for measurement: it silently
    converts buy-and-hold into "buy, panic once, sit in cash", so the
    benchmark understates the market and the strategy's excess is invented.
    This was a real bug in this file — a benchmark froze at a constant equity
    through a 14% decline and reported 0.00%. Evaluate the strategy first,
    then add risk limits deliberately, and always apply the same ones to both
    sides of a comparison.
    """
    costs = costs or Costs()
    step = step or test_size
    out = WalkForwardResult()

    if risk_factory is None:
        def risk_factory():
            return RiskManager(RiskLimits(max_position=1.0, max_drawdown=1.0,
                                          daily_loss_limit=None))

    keys = list(param_grid)
    combos = [dict(zip(keys, v)) for v in product(*(param_grid[k] for k in keys))]

    start = 0
    idx = 0
    while start + train_size + test_size <= len(bars):
        train = bars.iloc[start : start + train_size].reset_index(drop=True)

        # ---- tune on the training window only ----
        best, best_sharpe = None, -np.inf
        for combo in combos:
            try:
                r = run(train, strategy_factory(**combo), costs=costs,
                        bar_freq=bar_freq, risk=risk_factory(),
                        initial_equity=initial_equity)
                s = float(r.stats["sharpe"])
            except Exception:
                continue
            if s > best_sharpe:
                best, best_sharpe = combo, s
        if best is None:
            start += step
            idx += 1
            continue

        # ---- trade the next stretch blind ----
        # Prepend `warmup` bars so indicators are ready, then measure only
        # from the true test boundary. Without this the first trades of every
        # window are made on a half-formed indicator.
        t0 = start + train_size
        test_slice = bars.iloc[max(0, t0 - warmup) : t0 + test_size].reset_index(drop=True)
        test_start_ts = bars["timestamp"].iloc[t0]

        try:
            res = run(test_slice, strategy_factory(**best), costs=costs,
                      bar_freq=bar_freq, risk=risk_factory(),
                      initial_equity=initial_equity)
        except Exception:
            start += step
            idx += 1
            continue

        eq = res.equity[res.equity.index >= test_start_ts]
        if len(eq) < 2:
            start += step
            idx += 1
            continue
        test_ret = float(eq.iloc[-1] / eq.iloc[0] - 1)
        dd = float(((eq - eq.cummax()) / eq.cummax()).min())

        # Benchmark over the identical span, so the comparison is like-for-like.
        bench_ret = 0.0
        if benchmark_factory is not None:
            try:
                br = run(test_slice, benchmark_factory(), costs=costs,
                         bar_freq=bar_freq, risk=risk_factory(),
                         initial_equity=initial_equity)
                beq = br.equity[br.equity.index >= test_start_ts]
                bench_ret = float(beq.iloc[-1] / beq.iloc[0] - 1)
            except Exception:
                bench_ret = 0.0

        trades = res.trades
        n_tr = int((trades["timestamp"] >= test_start_ts).sum()) if not trades.empty else 0

        out.windows.append(
            WindowResult(
                index=idx,
                train_start=bars["timestamp"].iloc[start],
                test_start=test_start_ts,
                test_end=bars["timestamp"].iloc[min(t0 + test_size - 1, len(bars) - 1)],
                params=best,
                train_sharpe=best_sharpe,
                test_return=test_ret,
                test_sharpe=float(res.stats["sharpe"]),
                test_max_dd=dd,
                n_trades=n_tr,
                benchmark_return=bench_ret,
            )
        )
        start += step
        idx += 1

    return out
