#!/usr/bin/env python
"""
Does a slower timeframe escape the cost wall?

    python run_timeframes.py

The scalping run showed a real edge (+3.14bp/trade) losing to a fixed 12bp
round-trip cost. Cost per trade does not shrink when you slow down — but the
NUMBER of trades does, and the size of the move you are trying to capture
grows. This script measures whether that trade-off actually pays.

The same strategies, the same underlying data, resampled to five timeframes.
Only the bar size changes.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from tradingbot import (
    BuyAndHold,
    Costs,
    MeanReversion,
    SmaCrossover,
    load_csv,
    resample,
    run,
    train_test_split,
)
from tradingbot.scalping import ScalpConfig, Scalper

DATA = Path(__file__).parent / "data" / "sample_5min.csv"
RETAIL = Costs(commission=0.0004, slippage=0.0002)
TIMEFRAMES = ["5min", "15min", "1h", "4h", "1D"]


def header(t: str) -> None:
    print(f"\n{'=' * 78}\n{t}\n{'=' * 78}")


def main() -> None:
    base = load_csv(DATA)
    print(f"Base data: {len(base):,} 5min bars  "
          f"({base['timestamp'].iloc[0]} -> {base['timestamp'].iloc[-1]})")

    frames = {"5min": base}
    for tf in TIMEFRAMES[1:]:
        frames[tf] = resample(base, tf)

    print("\nAfter resampling:")
    for tf, d in frames.items():
        print(f"  {tf:>6}: {len(d):>6,} bars")

    # ---------------------------------------------------------------- 1
    header("1. TREND STRATEGY (SMA 20/60) ACROSS TIMEFRAMES — retail costs")
    print(f"{'timeframe':>10}{'bars':>8}{'trades':>8}{'return':>10}"
          f"{'sharpe':>9}{'max_dd':>9}{'fees%':>8}")
    print("-" * 60)
    for tf, d in frames.items():
        if len(d) < 200:
            print(f"{tf:>10}{len(d):>8,}   too few bars to test")
            continue
        r = run(d, SmaCrossover(20, 60), costs=RETAIL, bar_freq=tf)
        print(f"{tf:>10}{len(d):>8,}{r.stats['n_trades'].strip():>8}"
              f"{r.stats['total_return'].strip():>10}"
              f"{r.stats['sharpe'].strip():>9}"
              f"{r.stats['max_drawdown'].strip():>9}"
              f"{r.stats['fees_pct_of_start'].strip():>8}")

    # ---------------------------------------------------------------- 2
    header("2. MEAN REVERSION ACROSS TIMEFRAMES — retail costs")
    print(f"{'timeframe':>10}{'bars':>8}{'trades':>8}{'return':>10}"
          f"{'sharpe':>9}{'max_dd':>9}{'fees%':>8}")
    print("-" * 60)
    for tf, d in frames.items():
        if len(d) < 200:
            print(f"{tf:>10}{len(d):>8,}   too few bars to test")
            continue
        r = run(d, MeanReversion(lookback=50), costs=RETAIL, bar_freq=tf)
        print(f"{tf:>10}{len(d):>8,}{r.stats['n_trades'].strip():>8}"
              f"{r.stats['total_return'].strip():>10}"
              f"{r.stats['sharpe'].strip():>9}"
              f"{r.stats['max_drawdown'].strip():>9}"
              f"{r.stats['fees_pct_of_start'].strip():>8}")

    # ---------------------------------------------------------------- 3
    header("3. THE SCALPER'S ECONOMICS AS THE BAR GROWS")
    print("  Cost stays 12bp per round trip. Does the edge per trade grow\n"
          "  faster than that, once each bar covers a bigger move?\n")
    print(f"{'timeframe':>10}{'trades':>8}{'win%':>8}{'gross_bp':>10}"
          f"{'cost_bp':>9}{'net_bp':>9}{'return':>10}")
    print("-" * 64)
    for tf, d in frames.items():
        if len(d) < 200:
            continue
        s = Scalper(ScalpConfig(lookback=20, entry_z=1.5, take_profit=0.003,
                                stop_loss=0.002, max_hold=3, allow_short=True))
        r = run(d, s, costs=RETAIL, bar_freq=tf)
        rep = s.trade_report(RETAIL.commission, RETAIL.slippage)
        if rep["n_trades"] == 0:
            continue
        print(f"{tf:>10}{rep['n_trades']:>8}{rep['win_rate']:>7.1%}"
              f"{rep['gross_expectancy_bps']:>10.2f}"
              f"{rep['round_trip_cost_bps']:>9.1f}"
              f"{rep['net_expectancy_bps']:>9.2f}"
              f"{r.stats['total_return'].strip():>10}")

    # ---------------------------------------------------------------- 4
    header("4. H1 IN DETAIL — out-of-sample, vs buy-and-hold")
    h1 = frames["1h"]
    train, test = train_test_split(h1, test_frac=0.3)
    print(f"  train {len(train):,} bars   test {len(test):,} bars\n")

    best, best_sharpe = None, -1e9
    for fast in (5, 10, 20, 40):
        for slow in (20, 50, 100, 200):
            if fast >= slow:
                continue
            r = run(train, SmaCrossover(fast, slow), costs=RETAIL, bar_freq="1h")
            s = float(r.stats["sharpe"])
            if s > best_sharpe:
                best, best_sharpe = (fast, slow), s
    print(f"  best on TRAIN: fast={best[0]} slow={best[1]}  sharpe={best_sharpe:.2f}")

    oos = run(test, SmaCrossover(*best), costs=RETAIL, bar_freq="1h")
    bh = run(test, BuyAndHold(), costs=RETAIL, bar_freq="1h")
    keys = list(oos.stats)
    w = max(len(k) for k in keys) + 2
    print(f"\n{'':<{w}}{'tuned H1 OOS':>16}{'BuyAndHold OOS':>18}")
    for k in keys:
        print(f"{k:<{w}}{oos.stats[k]:>16}{bh.stats[k]:>18}")

    print(
        "\n  In-sample sharpe is a number you picked by searching. Out-of-sample\n"
        "  is the one the market handed you. Compare the two before believing\n"
        "  any of it, and remember a single split is the minimum honest test,\n"
        "  not a good one."
    )


if __name__ == "__main__":
    main()
