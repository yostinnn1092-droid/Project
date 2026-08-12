#!/usr/bin/env python
"""
Scalping bot — run it, and read the cost wall before the equity curve.

    python run_scalper.py

Order matters here. Section 1 is arithmetic that does not depend on any
signal: given your costs, what win rate would a scalp need? If that number
is implausible, nothing in sections 2-4 can rescue it, and you have saved
yourself building a strategy that could not have worked.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from tradingbot import Costs, RiskLimits, RiskManager, load_csv, run
from tradingbot.scalping import (
    ScalpConfig,
    Scalper,
    breakeven_table,
    round_trip_cost,
)

DATA = Path(__file__).parent / "data" / "sample_5min.csv"
FREQ = "5min"

RETAIL = Costs(commission=0.0004, slippage=0.0002)   # typical retail taker
PRO = Costs(commission=0.00005, slippage=0.00005)    # rebate-tier / colocated
FREE = Costs(commission=0.0, slippage=0.0)           # fantasy


def header(t: str) -> None:
    print(f"\n{'=' * 74}\n{t}\n{'=' * 74}")


def show(stats: dict) -> None:
    for k, v in stats.items():
        if k == "exits":
            print(f"  {'exits':<24} {v}")
        elif isinstance(v, float):
            print(f"  {k:<24} {v:>10.2f}")
        else:
            print(f"  {k:<24} {v:>10}")


def main() -> None:
    bars = load_csv(DATA)
    print(f"Loaded {len(bars):,} {FREQ} bars  "
          f"({bars['timestamp'].iloc[0]} -> {bars['timestamp'].iloc[-1]})")

    # ---------------------------------------------------------------- 1
    header("1. THE COST WALL — read this before writing any signal")
    print(f"Round trip at retail costs (4bp fee + 2bp slippage, both sides): "
          f"{round_trip_cost(0.0004, 0.0002) * 10_000:.0f} bp\n")
    t = breakeven_table(commission=0.0004, slippage=0.0002)
    t["required_win_rate"] = t["required_win_rate"].map(lambda w: f"{w:.1%}")
    print(t.to_string(index=False))
    print(
        "\n  A 5bp scalp needs a win rate above 100% — it cannot be done at any\n"
        "  skill level, because costs exceed the entire profit target. Small\n"
        "  targets are not 'harder', they are arithmetically closed."
    )

    print("\nSame table at professional costs (0.5bp fee + 0.5bp slippage):\n")
    t2 = breakeven_table(commission=0.00005, slippage=0.00005)
    t2["required_win_rate"] = t2["required_win_rate"].map(lambda w: f"{w:.1%}")
    print(t2.to_string(index=False))
    print(
        "\n  Same signals, same targets, completely different game. This is why\n"
        "  scalping is a professional strategy: they are not smarter, they are\n"
        "  playing on a board where the tiles are 12x cheaper."
    )

    # ---------------------------------------------------------------- 2
    header("2. THE SCALPER, AT RETAIL COSTS")
    cfg = ScalpConfig(lookback=20, entry_z=1.5, take_profit=0.003,
                      stop_loss=0.002, max_hold=3, allow_short=True)
    print(f"  config: {cfg}\n")

    scalper = Scalper(cfg)
    res = run(bars, scalper, costs=RETAIL, bar_freq=FREQ,
              risk=RiskManager(RiskLimits(max_position=1.0, max_drawdown=0.25)))
    show(scalper.trade_report(RETAIL.commission, RETAIL.slippage))
    print(f"\n  equity: {res.stats['final_equity'].strip()}  "
          f"return: {res.stats['total_return'].strip()}  "
          f"sharpe: {res.stats['sharpe'].strip()}")
    if res.halt_reason:
        print(f"  HALTED: {res.halt_reason}")

    # ---------------------------------------------------------------- 3
    header("3. THE SAME SCALPER AT THREE COST LEVELS")
    rows = {}
    for name, c in (("retail", RETAIL), ("professional", PRO), ("zero (fantasy)", FREE)):
        s = Scalper(cfg)
        r = run(bars, s, costs=c, bar_freq=FREQ)
        rep = s.trade_report(c.commission, c.slippage)
        rows[name] = {
            "return": r.stats["total_return"].strip(),
            "sharpe": r.stats["sharpe"].strip(),
            "trades": rep["n_trades"],
            "win_rate": f"{rep['win_rate']:.1%}",
            "gross_exp_bps": f"{rep['gross_expectancy_bps']:.2f}",
            "cost_bps": f"{rep['round_trip_cost_bps']:.1f}",
            "net_exp_bps": f"{rep['net_expectancy_bps']:.2f}",
            "fees_paid": r.stats["fees_paid"].strip(),
        }
    keys = list(next(iter(rows.values())))
    w = max(len(k) for k in keys) + 2
    print(f"{'':<{w}}" + "".join(f"{n:>17}" for n in rows))
    for k in keys:
        print(f"{k:<{w}}" + "".join(f"{rows[n][k]:>17}" for n in rows))
    print(
        "\n  The signal is IDENTICAL in all three columns. Only the toll booth\n"
        "  changed. Whatever the strategy does or does not know about markets,\n"
        "  costs are what decide whether it survives."
    )

    # ---------------------------------------------------------------- 4
    header("4. DOES A WIDER TARGET ESCAPE THE WALL?")
    print("  Bigger targets clear costs more easily but fire less often and\n"
          "  hold longer — at some point it stops being scalping.\n")
    print(f"{'take_profit':>12}{'trades':>9}{'win%':>8}{'gross_bps':>11}"
          f"{'net_bps':>9}{'return':>10}")
    print("-" * 59)
    for tp in (0.001, 0.002, 0.003, 0.005, 0.010):
        c2 = ScalpConfig(lookback=20, entry_z=1.5, take_profit=tp,
                         stop_loss=tp * 0.67, max_hold=3, allow_short=True)
        s = Scalper(c2)
        r = run(bars, s, costs=RETAIL, bar_freq=FREQ)
        rep = s.trade_report(RETAIL.commission, RETAIL.slippage)
        if rep["n_trades"] == 0:
            continue
        print(f"{tp:>12.3%}{rep['n_trades']:>9}{rep['win_rate']:>7.1%}"
              f"{rep['gross_expectancy_bps']:>11.2f}"
              f"{rep['net_expectancy_bps']:>9.2f}"
              f"{r.stats['total_return'].strip():>10}")

    print(
        "\n  Net expectancy is the column that matters. Negative means every\n"
        "  trade loses money on average, so more activity means faster losses.\n"
        "  No position sizing, schedule or AI layer fixes a negative expectancy."
    )


if __name__ == "__main__":
    main()
