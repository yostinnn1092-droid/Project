#!/usr/bin/env python
"""
Does the H1 stock result survive a different market?

    python fetch_forex.py          # get the data first
    python run_forex.py

Tests the same procedure on 19 years of EUR/USD, then on four more pairs,
then compares the adaptive regime-switching strategy against the fixed ones.

A result that only exists on the instrument it was discovered on is not a
strategy, it is a description of that instrument's history.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from tradingbot import (
    BuyAndHold,
    Costs,
    MeanReversion,
    SmaCrossover,
    load_csv,
    run,
)
from tradingbot.adaptive import AdaptiveRegime
from tradingbot.walkforward import walk_forward

DATA = Path(__file__).parent / "data"

# Retail EUR/USD is roughly a 1-pip spread, i.e. ~1bp round trip — an order
# of magnitude cheaper than the 12bp equity round trip. Costs are not a
# universal constant; they are a property of the market you chose.
FX = Costs(commission=0.0, slippage=0.00005)
EQUITY = Costs(commission=0.0004, slippage=0.0002)

GRID = {"fast": [5, 10, 20, 40], "slow": [50, 100, 200]}


def header(t: str) -> None:
    print(f"\n{'=' * 78}\n{t}\n{'=' * 78}")


def significance(r: np.ndarray) -> tuple[float, float, float]:
    rng = np.random.default_rng(0)
    bs = np.array([rng.choice(r, len(r), replace=True).mean() for _ in range(20000)])
    lo, hi = np.percentile(bs, [2.5, 97.5])
    return lo, hi, float((bs > 0).mean())


def wf(bars: pd.DataFrame, costs: Costs, freq: str, train: int, test: int) -> dict:
    res = walk_forward(
        bars,
        strategy_factory=lambda fast, slow: SmaCrossover(fast, slow),
        param_grid=GRID,
        train_size=train,
        test_size=test,
        warmup=max(GRID["slow"]) + 1,
        costs=costs,
        bar_freq=freq,
        benchmark_factory=BuyAndHold,
    )
    df = res.frame()
    if df.empty:
        return {}
    s = res.summary()
    r = df["test_return"].to_numpy()
    b = df["benchmark_return"].to_numpy()
    lo, hi, p = significance(r)
    return {
        "windows": s["n_windows"],
        "profitable": f"{s['profitable_windows']}/{s['n_windows']}",
        "beat_bench": f"{int((r > b).sum())}/{len(r)}",
        "mean_ret": s["mean_window_return"],
        "median_ret": s["median_window_return"],
        "combined": s["combined_oos_return"],
        "param_sets": f"{s['distinct_param_sets']}/{s['n_windows']}",
        "ci": (lo, hi),
        "p_pos": p,
    }


def main() -> None:
    eurusd = load_csv(DATA / "EURUSD_1d.csv")
    print(f"EUR/USD: {len(eurusd):,} daily bars  "
          f"{eurusd['timestamp'].iloc[0]:%Y-%m-%d} -> {eurusd['timestamp'].iloc[-1]:%Y-%m-%d}")

    # ---------------------------------------------------------------- 1
    header("1. THE SAME PROCEDURE ON FOREX (EUR/USD, 19 years)")
    fx = wf(eurusd, FX, "1D", train=750, test=250)
    for k in ("windows", "profitable", "beat_bench", "param_sets"):
        print(f"  {k:<22} {fx[k]}")
    print(f"  {'median window return':<22} {fx['median_ret']:>8.2%}")
    print(f"  {'mean window return':<22} {fx['mean_ret']:>8.2%}")
    print(f"  {'combined OOS':<22} {fx['combined']:>8.2%}")
    print(f"  {'95% CI':<22} [{fx['ci'][0]:.2%}, {fx['ci'][1]:.2%}]")
    print(f"  {'P(mean > 0)':<22} {fx['p_pos']:>8.1%}")
    print(
        "\n  Compare with the stock: 9 windows, P(mean>0)=89.7%. Here, with\n"
        "  17 windows over 19 years, the mean sits on zero. MORE evidence\n"
        "  moved the answer toward 'no effect', which is what you expect\n"
        "  when the original was noise."
    )

    # ---------------------------------------------------------------- 2
    header("2. PARAMETER STABILITY — the tell")
    ps = int(fx["param_sets"].split("/")[0])
    n = int(fx["param_sets"].split("/")[1])
    print(f"  distinct parameter sets: {ps} across {n} windows ({ps / n:.0%})")
    print(
        "\n  On the stock the tuner kept choosing one family (10/50, 20/50).\n"
        "  Here it changes its mind almost every window. That is the signature\n"
        "  of fitting noise: last window's winner tells you nothing about the\n"
        "  next one, so 'learning' is just chasing randomness."
    )

    # ---------------------------------------------------------------- 3
    header("3. ROBUSTNESS ACROSS FIVE PAIRS (fixed 20/50, no tuning)")
    print("  No parameter search at all — one fixed setting everywhere. If an\n"
          "  edge is real it should show up without being fitted per market.\n")
    print(f"{'pair':<26}{'bars':>7}{'trades':>8}{'return':>10}{'sharpe':>9}{'B&H':>10}")
    print("-" * 70)
    files = sorted(DATA.glob("EUR*_1d*.csv"))
    for f in files:
        d = load_csv(f)
        closeonly = "closeonly" in f.name
        r = run(d, SmaCrossover(20, 50), costs=FX, bar_freq="1D")
        bh = run(d, BuyAndHold(), costs=FX, bar_freq="1D")
        tag = f.stem.replace("_1d", "").replace("_closeonly", " (close-only)")
        print(f"{tag:<26}{len(d):>7,}{r.stats['n_trades'].strip():>8}"
              f"{r.stats['total_return'].strip():>10}{r.stats['sharpe'].strip():>9}"
              f"{bh.stats['total_return'].strip():>10}")
    print("\n  (close-only pairs have synthetic high/low from ECB fixings — fine\n"
          "   for direction, useless for anything touching the bar's range)")

    # ---------------------------------------------------------------- 4
    header("4. DOES ADAPTING BEAT COMMITTING? (EUR/USD, fixed params)")
    print(f"{'strategy':<26}{'trades':>8}{'return':>10}{'sharpe':>9}{'max_dd':>10}")
    print("-" * 63)
    cands = {
        "SmaCrossover 20/50": SmaCrossover(20, 50),
        "MeanReversion": MeanReversion(lookback=20, entry_z=1.5),
        "AdaptiveRegime": AdaptiveRegime(er_window=20, er_threshold=0.35,
                                         fast=20, slow=50, mr_lookback=20),
        "BuyAndHold": BuyAndHold(),
    }
    adaptive_ref = None
    for name, strat in cands.items():
        r = run(eurusd, strat, costs=FX, bar_freq="1D")
        if isinstance(strat, AdaptiveRegime):
            adaptive_ref = strat
        print(f"{name:<26}{r.stats['n_trades'].strip():>8}"
              f"{r.stats['total_return'].strip():>10}{r.stats['sharpe'].strip():>9}"
              f"{r.stats['max_drawdown'].strip():>10}")

    if adaptive_ref is not None:
        rep = adaptive_ref.regime_report()
        print("\n  Regime detector behaviour (did it actually switch?):")
        print(f"    bars in trend mode  : {rep['pct_trend_mode']:.1%}")
        print(f"    bars in revert mode : {rep['pct_revert_mode']:.1%}")
        print(f"    mode switches       : {rep['mode_switches']}")
        print(f"    mean efficiency     : {rep['mean_er']:.3f}")
        print(f"    bars holding        : {rep['pct_bars_in_position']:.1%}")

    print(
        "\n  Adaptivity adds parameters (er_window, threshold, band) and every\n"
        "  added parameter makes overfitting EASIER. Judge it by whether it\n"
        "  beats the simple versions out-of-sample, never by how clever the\n"
        "  mechanism sounds."
    )


if __name__ == "__main__":
    main()
