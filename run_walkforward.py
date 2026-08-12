#!/usr/bin/env python
"""
Walk-forward test of the H1 trend result.

    python run_walkforward.py

The single split said +14.02% out-of-sample. This asks whether that survives
being repeated: re-tune on the past, trade the next stretch blind, roll
forward, over and over.

Read consistency first, parameters second, return last.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from tradingbot import BuyAndHold, Costs, SmaCrossover, load_csv, resample
from tradingbot.walkforward import walk_forward

DATA = Path(__file__).parent / "data" / "sample_5min.csv"
RETAIL = Costs(commission=0.0004, slippage=0.0002)

TRAIN, TEST = 500, 200          # H1 bars: ~11 weeks train, ~4.5 weeks test
GRID = {"fast": [5, 10, 20, 40], "slow": [50, 100, 200]}
MAX_WARMUP = max(GRID["slow"]) + 1


def header(t: str) -> None:
    print(f"\n{'=' * 78}\n{t}\n{'=' * 78}")


def main() -> None:
    bars = resample(load_csv(DATA), "1h")
    print(f"H1 bars: {len(bars):,}  "
          f"({bars['timestamp'].iloc[0]} -> {bars['timestamp'].iloc[-1]})")
    print(f"train={TRAIN} bars  test={TEST} bars  grid={GRID}")

    res = walk_forward(
        bars,
        strategy_factory=lambda fast, slow: SmaCrossover(fast, slow),
        param_grid=GRID,
        train_size=TRAIN,
        test_size=TEST,
        warmup=MAX_WARMUP,
        costs=RETAIL,
        bar_freq="1h",
        benchmark_factory=BuyAndHold,
    )

    df = res.frame()
    if df.empty:
        print("\nNo complete windows — not enough data for these sizes.")
        return

    header("EVERY WINDOW (each one traded blind, tuned only on its past)")
    print(f"{'#':>3}{'test period':>26}{'params':>14}{'trainSR':>9}"
          f"{'return':>10}{'B&H':>10}{'trades':>8}")
    print("-" * 80)
    for w in res.windows:
        p = f"{w.params['fast']}/{w.params['slow']}"
        period = f"{w.test_start:%Y-%m-%d} - {w.test_end:%Y-%m-%d}"
        mark = " " if w.test_return > 0 else "*"
        print(f"{w.index:>3}{period:>26}{p:>14}{w.train_sharpe:>9.2f}"
              f"{w.test_return:>9.2%}{mark}{w.benchmark_return:>10.2%}"
              f"{w.n_trades:>8}")
    print("  (* = losing window)")

    s = res.summary()

    header("1. CONSISTENCY — the number that matters most")
    print(f"  windows tested        : {s['n_windows']}")
    print(f"  profitable            : {s['profitable_windows']}/{s['n_windows']}"
          f"  ({s['win_rate']:.0%})")
    print(f"  median window return  : {s['median_window_return']:>8.2%}")
    print(f"  mean window return    : {s['mean_window_return']:>8.2%}")
    print(f"  best / worst window   : {s['best_window']:>8.2%} / {s['worst_window']:.2%}")
    print(f"  worst drawdown seen   : {s['worst_max_drawdown']:>8.2%}")
    if s["win_rate"] < 0.5:
        print("\n  Under half the windows made money. Whatever the total says,\n"
              "  this is not a consistent edge.")

    header("2. PARAMETER STABILITY — is the tuner finding signal or noise?")
    counts = df["params"].map(lambda d: f"{d['fast']}/{d['slow']}").value_counts()
    print(f"  distinct parameter sets chosen: {s['distinct_param_sets']} "
          f"across {s['n_windows']} windows\n")
    for p, c in counts.items():
        print(f"    {p:<10} chosen {c}x")
    if s["distinct_param_sets"] > s["n_windows"] * 0.6:
        print("\n  The best parameters change almost every window. That is the\n"
              "  signature of fitting noise: last window's winner carries no\n"
              "  information about the next one.")
    else:
        print("\n  Reasonably stable choices — consistent with a real effect\n"
              "  rather than pure curve-fitting.")

    header("3. RETURN — read only after the two sections above")
    print(f"  combined out-of-sample : {s['combined_oos_return']:>9.2%}")
    print(f"  buy & hold, same span  : {s['benchmark_combined']:>9.2%}")
    print(f"  excess                 : {s['excess_over_benchmark']:>9.2%}")
    print(f"  total trades           : {s['total_trades']:>9}")

    # Is the mean window return distinguishable from zero?
    r = df["test_return"].to_numpy()
    if len(r) > 2:
        rng = np.random.default_rng(0)
        bs = np.array([rng.choice(r, len(r), replace=True).mean() for _ in range(20000)])
        lo, hi = np.percentile(bs, [2.5, 97.5])
        header("4. IS THE MEAN WINDOW RETURN DISTINGUISHABLE FROM ZERO?")
        print(f"  mean window return : {r.mean():>8.2%}")
        print(f"  95% CI (bootstrap) : [{lo:.2%}, {hi:.2%}]")
        print(f"  P(mean > 0)        : {(bs > 0).mean():>8.1%}")
        print(f"\n  verdict: {'SIGNIFICANT' if lo > 0 else 'NOT SIGNIFICANT — CI includes zero'}")
        if lo <= 0:
            print("  With this many windows the result is compatible with luck.\n"
                  "  That is not proof it does not work; it is proof this test\n"
                  "  cannot tell. More data or more windows would be needed.")


if __name__ == "__main__":
    main()
