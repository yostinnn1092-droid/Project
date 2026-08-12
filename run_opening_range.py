#!/usr/bin/env python
"""
Backtest the "first 4H candle" opening-range fade.

    python fetch_stocks.py --m5 && python run_opening_range.py

The creator's evidence is 7 trades on Bitcoin, 6 on EUR/USD and 10 on gold —
23 trades total, hand-picked from charts. This runs the same rules
mechanically across 8 instruments and ~130,000 five-minute bars, which is
enough samples to say something.

Sample sizes matter more than win rates here. 5 wins from 7 trades is a 72%
win rate and also the single most likely outcome of flipping a slightly
biased coin seven times. The binomial spread on n=7 is enormous.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from tradingbot import Costs, load_csv, run
from tradingbot.opening_range_fade import ORFadeConfig, OpeningRangeFade

DATA = Path(__file__).parent / "data" / "m5"

# Per-instrument round-trip costs. Scalping economics are set by the venue,
# not the signal, so one cost number for everything would be meaningless.
COSTS = {
    "EURUSD": Costs(0.0, 0.00005), "GBPUSD": Costs(0.0, 0.00005),
    "USDJPY": Costs(0.0, 0.00005), "AUDUSD": Costs(0.0, 0.00006),
    "GC": Costs(0.0, 0.00015), "SI": Costs(0.0, 0.00030),
    "BTC": Costs(0.0005, 0.0002), "ETH": Costs(0.0005, 0.0002),
}


def header(t: str) -> None:
    print(f"\n{'=' * 80}\n{t}\n{'=' * 80}")


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson score interval for a win rate — honest at small n."""
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    s = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - s) / d, (c + s) / d)


def boot(x: np.ndarray) -> tuple[float, float, float]:
    rng = np.random.default_rng(0)
    bs = np.array([rng.choice(x, len(x), replace=True).mean() for _ in range(20_000)])
    lo, hi = np.percentile(bs, [2.5, 97.5])
    return lo, hi, float((bs > 0).mean())


def main() -> None:
    files = sorted(DATA.glob("*.csv"))
    if not files:
        print("No data. Run: python fetch_stocks.py --m5")
        return

    cfg = ORFadeConfig()
    total_bars = sum(len(load_csv(f)) for f in files)
    print(f"{len(files)} instruments, {total_bars:,} five-minute bars")
    print(f"rules: first {cfg.range_hours}H candle of the NY day, fade the "
          f"failed breakout, {cfg.risk_reward}R target, "
          f"{cfg.max_trades_per_day} trade/day max")

    # ---------------------------------------------------------------- 1
    header("1. THE STRATEGY, INSTRUMENT BY INSTRUMENT")
    print(f"{'symbol':<9}{'bars':>8}{'days':>7}{'signals':>9}{'trades':>8}"
          f"{'win%':>7}{'expect_R':>10}{'total_R':>9}{'return':>10}")
    print("-" * 77)

    rows, all_r = [], []
    for f in files:
        d = load_csv(f)
        sym = f.stem
        c = COSTS.get(sym, Costs(0.0, 0.0002))
        s = OpeningRangeFade(cfg)
        r = run(d, s, costs=c, bar_freq="5min")
        rep = s.report()
        if rep["n_trades"] == 0:
            print(f"{sym:<9}{len(d):>8,}{rep.get('days_seen',0):>7}    no trades")
            continue
        ret = float(r.stats["total_return"].strip().rstrip("%")) / 100
        rows.append({"sym": sym, **rep, "ret": ret})
        all_r.extend([t.r_multiple for t in s.trades])
        print(f"{sym:<9}{len(d):>8,}{rep['days_seen']:>7}"
              f"{rep['days_with_signal']:>9}{rep['n_trades']:>8}"
              f"{rep['win_rate']:>6.1%}{rep['expectancy_r']:>10.3f}"
              f"{rep['total_r']:>9.2f}{ret:>10.2%}")

    if not rows:
        print("\nNo trades anywhere — check the session-hour setting.")
        return

    df = pd.DataFrame(rows)
    R = np.array(all_r)
    n = len(R)
    k = int((R > 0).sum())

    # ---------------------------------------------------------------- 2
    header("2. POOLED — every trade, every instrument")
    lo_w, hi_w = wilson(k, n)
    lo_e, hi_e, p_e = boot(R)
    print(f"  trades                : {n}")
    print(f"  wins                  : {k}")
    print(f"  win rate              : {k / n:>8.1%}")
    print(f"  95% CI on win rate    : [{lo_w:.1%}, {hi_w:.1%}]")
    print(f"  breakeven win rate @{cfg.risk_reward:.0f}R : "
          f"{1 / (1 + cfg.risk_reward):>7.1%}   (before costs)")
    print()
    print(f"  expectancy            : {R.mean():>8.3f} R")
    print(f"  95% CI on expectancy  : [{lo_e:.3f}, {hi_e:.3f}] R")
    print(f"  P(expectancy > 0)     : {p_e:>8.1%}")
    print(f"  total R               : {R.sum():>8.2f}")
    verdict = ("SIGNIFICANTLY POSITIVE" if lo_e > 0 else
               "SIGNIFICANTLY NEGATIVE" if hi_e < 0 else
               "INCONCLUSIVE — CI includes zero")
    print(f"\n  VERDICT: {verdict}")

    # ---------------------------------------------------------------- 3
    header("3. THE CREATOR'S SAMPLE SIZES, PUT IN CONTEXT")
    print("  Reported in the video, and what those samples can actually support:\n")
    print(f"{'market':<12}{'record':>10}{'win rate':>10}{'95% CI on true win rate':>28}")
    print("-" * 60)
    for name, w, t in (("Bitcoin", 5, 7), ("EUR/USD", 5, 6), ("Gold", 6, 10)):
        a, b = wilson(w, t)
        print(f"{name:<12}{f'{w}/{t}':>10}{w / t:>9.0%}{f'[{a:.0%}, {b:.0%}]':>28}")
    ca, cb = wilson(16, 23)
    print(f"{'COMBINED':<12}{'16/23':>10}{16 / 23:>9.0%}{f'[{ca:.0%}, {cb:.0%}]':>28}")
    print(f"\n  Breakeven at 2R is {1 / 3:.0%}. Every interval above includes")
    print("  values near or below it, so none of those records can distinguish")
    print("  a profitable system from a marginal one. That is a property of")
    print("  n=6..10, not a criticism of the trades themselves.")

    # ---------------------------------------------------------------- 4
    header("4. SENSITIVITY — does the result depend on the exact session hour?")
    print("  'First 4H candle, New York time' fixes one hour. If the edge is\n"
          "  real it should not vanish an hour either side.\n")
    print(f"{'NY start hour':>14}{'trades':>9}{'win%':>8}{'expect_R':>11}{'total_R':>10}")
    print("-" * 52)
    for hour in (22, 23, 0, 1, 2):
        tr, wins, rs = 0, 0, []
        for f in files:
            d = load_csv(f)
            c = COSTS.get(f.stem, Costs(0.0, 0.0002))
            s = OpeningRangeFade(ORFadeConfig(session_start_hour=hour))
            run(d, s, costs=c, bar_freq="5min")
            for t in s.trades:
                tr += 1
                wins += t.r_multiple > 0
                rs.append(t.r_multiple)
        if tr:
            print(f"{hour:>14}{tr:>9}{wins / tr:>7.1%}"
                  f"{np.mean(rs):>11.3f}{np.sum(rs):>10.2f}")

    print(
        "\n  A result that only exists at one hour setting is a property of\n"
        "  that hour in this sample, not of the market. A robust edge should\n"
        "  degrade gracefully, not switch on and off."
    )


if __name__ == "__main__":
    main()
