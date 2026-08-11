#!/usr/bin/env python
"""
Run the reference backtests.

    python run_backtest.py

Three lessons, in order of how much money they will save you:

  1. Costs. The same strategy, with and without realistic fees/slippage.
  2. Lookahead bias. The same strategy, filled correctly vs one bar early.
  3. Out-of-sample. Tune on the first 70%, judge on the last 30%.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from tradingbot import (
    BuyAndHold,
    Costs,
    MeanReversion,
    RiskLimits,
    RiskManager,
    SmaCrossover,
    Strategy,
    load_csv,
    run,
    train_test_split,
)


class LookaheadPeeker(Strategy):
    """DELIBERATELY BROKEN. Do not copy this into a real strategy.

    It is built the way real lookahead bugs are built: a feature is
    computed over the entire dataframe up front (here `.shift(-1)`, i.e.
    next bar's return) and then read back one bar at a time. Each
    individual `on_bar` call looks innocent — the poison was added before
    the loop ever started.

    This is why the rule is "no future data in the FEATURE", not merely
    "no future data in the loop".
    """

    def __init__(self, bars: pd.DataFrame):
        self._future = (
            bars.set_index("timestamp")["close"].pct_change().shift(-1).fillna(0.0)
        )
        self.warmup = 1

    def on_bar(self, history: pd.DataFrame) -> float:
        ts = history["timestamp"].iloc[-1]
        return 1.0 if self._future.get(ts, 0.0) > 0 else -1.0

DATA = Path(__file__).parent / "data" / "sample_5min.csv"
FREQ = "5min"


def header(title: str) -> None:
    print(f"\n{'=' * 72}\n{title}\n{'=' * 72}")


def table(rows: dict[str, dict]) -> None:
    """Print strategy stats side by side."""
    names = list(rows)
    keys = list(next(iter(rows.values())))
    width = max(len(k) for k in keys) + 2
    print(f"{'':<{width}}" + "".join(f"{n:>18}" for n in names))
    for k in keys:
        print(f"{k:<{width}}" + "".join(f"{rows[n][k]:>18}" for n in names))


def main() -> None:
    bars = load_csv(DATA)
    print(f"Loaded {len(bars):,} {FREQ} bars")
    print(f"  {bars['timestamp'].iloc[0]}  ->  {bars['timestamp'].iloc[-1]}")
    print(f"  close range: {bars['close'].min():.2f} - {bars['close'].max():.2f}")

    strategies = {
        "BuyAndHold": BuyAndHold(),
        "SmaCrossover": SmaCrossover(fast=20, slow=60),
        "MeanReversion": MeanReversion(lookback=50, entry_z=1.5, exit_z=0.3),
    }

    # ---------------------------------------------------------------- 1
    header("1. WITH REALISTIC COSTS  (4bp commission + 2bp slippage)")
    real = Costs(commission=0.0004, slippage=0.0002)
    with_costs = {
        name: run(bars, strat, costs=real, bar_freq=FREQ).stats
        for name, strat in strategies.items()
    }
    table(with_costs)

    header("1b. SAME STRATEGIES, ZERO COSTS  (the fantasy version)")
    free = Costs(commission=0.0, slippage=0.0)
    zero_costs = {
        name: run(bars, type(strat)(**_params(strat)), costs=free, bar_freq=FREQ).stats
        for name, strat in strategies.items()
    }
    table(zero_costs)
    print(
        "\n  Every strategy looks better for free. The gap is what your broker\n"
        "  earns from you — and it is the gap that kills high-turnover ideas."
    )

    # ---------------------------------------------------------------- 2
    header("2a. WHAT A LOOKAHEAD BUG ACTUALLY LOOKS LIKE")
    peeker = run(bars, LookaheadPeeker(bars), costs=real, bar_freq=FREQ)
    table({"BuyAndHold": with_costs["BuyAndHold"], "LOOKAHEAD BUG": peeker.stats})
    print(
        "\n  LookaheadPeeker precomputes next-bar return across the WHOLE\n"
        "  series, then reads it per bar — the single most common way real\n"
        "  backtests leak the future (a feature column built with .shift(-1),\n"
        "  or any indicator fitted on the full dataset before splitting).\n"
        "\n  It trades ~17,000 times and pays astronomically more in fees than\n"
        "  it started with, and STILL shows that. Sharpe ~36 is not a good\n"
        "  strategy; no such thing exists. A Sharpe above roughly 3 on retail\n"
        "  data is a bug report. Go and find which feature saw the future."
    )

    header("2b. THE SUBTLER ERROR: filling on the bar you decided on")
    for label, make in (
        ("MeanReversion", lambda: MeanReversion()),
        ("SmaCrossover", lambda: SmaCrossover(20, 60)),
    ):
        correct = run(bars, make(), costs=real, bar_freq=FREQ,
                      execution="next_open")
        cheating = run(bars, make(), costs=real, bar_freq=FREQ,
                       execution="same_close")
        print(f"\n  -- {label} --")
        table({"correct": correct.stats, "same-bar fill": cheating.stats})
    print(
        "\n  Note this one does NOT reliably flatter you: on this data it came\n"
        "  out slightly worse. The close->next-open gap is mostly noise, so it\n"
        "  biases whichever way the sample happens to fall. It is still wrong —\n"
        "  live, that close has already traded and you cannot have it — but be\n"
        "  honest about the mechanism: fixing it is about correctness, not\n"
        "  about deflating a number. Only 2a manufactures returns."
    )

    # ---------------------------------------------------------------- 3
    header("3. OUT-OF-SAMPLE  (fit on first 70%, judge on last 30%)")
    train, test = train_test_split(bars, test_frac=0.3)
    print(f"  train: {len(train):,} bars   test: {len(test):,} bars\n")

    best, best_sharpe = None, -1e9
    for fast in (10, 20, 40):
        for slow in (60, 120, 240):
            if fast >= slow:
                continue
            r = run(train, SmaCrossover(fast, slow), costs=real, bar_freq=FREQ)
            s = float(r.stats["sharpe"])
            if s > best_sharpe:
                best, best_sharpe = (fast, slow), s
    print(f"  best on TRAIN: fast={best[0]} slow={best[1]}  sharpe={best_sharpe:.2f}")

    oos = run(test, SmaCrossover(*best), costs=real, bar_freq=FREQ)
    bh_oos = run(test, BuyAndHold(), costs=real, bar_freq=FREQ)
    table({"tuned OOS": oos.stats, "BuyAndHold OOS": bh_oos.stats})
    print(
        "\n  In-sample Sharpe is a number you chose. Out-of-sample Sharpe is a\n"
        "  number the market gave you. Only the second one means anything, and\n"
        "  it is almost always much worse."
    )

    # ---------------------------------------------------------------- 4
    header("4. RISK KILL SWITCH  (halt at 10% drawdown)")
    strict = RiskManager(RiskLimits(max_position=1.0, max_drawdown=0.10,
                                    daily_loss_limit=None))
    halted = run(bars, BuyAndHold(), costs=real, risk=strict, bar_freq=FREQ)
    table({"BuyAndHold": with_costs["BuyAndHold"], "with kill switch": halted.stats})
    if halted.halt_reason:
        print(f"\n  Halted: {halted.halt_reason}")
        print(
            "  On THIS sample the switch happened to help — it went flat before\n"
            "  a further fall. Do not read that as proof it is free: the same\n"
            "  rule sells the bottom and misses the recovery just as often. Its\n"
            "  job is bounding the worst case, not improving the average one.\n"
            "  Decide which you want BEFORE you are down."
        )

    _plot(bars, real)


def _params(strat) -> dict:
    return {k: v for k, v in vars(strat).items()
            if not k.startswith("_") and k != "warmup"}


def _plot(bars: pd.DataFrame, costs: Costs) -> None:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return

    curves = {
        "BuyAndHold": run(bars, BuyAndHold(), costs=costs, bar_freq=FREQ).equity,
        "SmaCrossover": run(bars, SmaCrossover(20, 60), costs=costs, bar_freq=FREQ).equity,
        "MeanReversion": run(bars, MeanReversion(), costs=costs, bar_freq=FREQ).equity,
    }

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(11, 7), sharex=True,
                                   gridspec_kw={"height_ratios": [2, 1]})
    for name, eq in curves.items():
        ax1.plot(eq.index, eq.values, lw=1.3, label=name)
    ax1.set_ylabel("Equity")
    ax1.set_title("Equity curves — after 4bp commission + 2bp slippage")
    ax1.legend(fontsize=9)
    ax1.grid(alpha=0.3)

    for name, eq in curves.items():
        dd = (eq - eq.cummax()) / eq.cummax()
        ax2.fill_between(dd.index, dd.values * 100, 0, alpha=0.35, label=name)
    ax2.set_ylabel("Drawdown %")
    ax2.set_xlabel("Time")
    ax2.grid(alpha=0.3)

    plt.tight_layout()
    out = Path(__file__).parent / "backtest.png"
    plt.savefig(out, dpi=130)
    print(f"\n  chart -> {out}")


if __name__ == "__main__":
    main()
