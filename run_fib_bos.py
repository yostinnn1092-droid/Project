#!/usr/bin/env python
"""
Backtest the 1-minute BOS + Fibonacci gold-zone scalper.

    python fetch_stocks.py --m1 && python run_fib_bos.py

Section 1 is the one that matters, and it does not depend on the signal at
all: how big is 1R, in basis points, compared with the round-trip cost of
trading it? On 1-minute bars the swings are small, so the payoff structure
can be irrelevant before a single entry rule is evaluated.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from tradingbot import Costs, load_csv, run
from tradingbot.fib_bos import FibBosConfig, FibBosScalper
from tradingbot.scalping import round_trip_cost

DATA = Path(__file__).parent / "data" / "m1"
COSTS = {
    "EURUSD": Costs(0.0, 0.00005), "GBPUSD": Costs(0.0, 0.00005),
    "USDJPY": Costs(0.0, 0.00005), "AUDUSD": Costs(0.0, 0.00006),
    "GC": Costs(0.0, 0.00015),
    "BTC": Costs(0.0005, 0.0002), "ETH": Costs(0.0005, 0.0002),
}


def header(t: str) -> None:
    print(f"\n{'=' * 80}\n{t}\n{'=' * 80}")


def boot(x: np.ndarray) -> tuple[float, float, float]:
    rng = np.random.default_rng(0)
    bs = np.array([rng.choice(x, len(x), replace=True).mean() for _ in range(20_000)])
    lo, hi = np.percentile(bs, [2.5, 97.5])
    return lo, hi, float((bs > 0).mean())


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    s = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - s) / d, (c + s) / d)


def main() -> None:
    files = sorted(DATA.glob("*.csv"))
    if not files:
        print("No data. Run: python fetch_stocks.py --m1")
        return
    cfg = FibBosConfig()
    total = sum(len(load_csv(f)) for f in files)
    print(f"{len(files)} instruments, {total:,} one-minute bars (Yahoo caps 1m at 7 days)")
    print(f"rules: BOS -> retrace to {cfg.fib_low}-{cfg.fib_high} -> "
          f"{cfg.risk_reward}R target, stop beyond swing origin")

    # ---------------------------------------------------------------- 1
    header("1. RESULTS, AND THE SIZE OF 1R vs THE COST OF TRADING IT")
    print(f"{'symbol':<9}{'bars':>8}{'BOS':>6}{'trades':>7}{'fill%':>7}"
          f"{'win%':>7}{'1R (bps)':>10}{'cost(bps)':>10}{'expect':>9}{'return':>9}")
    print("-" * 82)

    rows, all_r = [], []
    for f in files:
        d = load_csv(f)
        c = COSTS.get(f.stem, Costs(0.0, 0.0002))
        s = FibBosScalper(cfg)
        r = run(d, s, costs=c, bar_freq="1min")
        rep = s.report()
        if rep["n_trades"] == 0:
            print(f"{f.stem:<9}{len(d):>8,}{rep['bos_detected']:>6}   no trades")
            continue
        rt = round_trip_cost(c.commission, c.slippage) * 1e4
        ret = float(r.stats["total_return"].strip().rstrip("%")) / 100
        all_r.extend(t.r_multiple for t in s.trades)
        rows.append({"sym": f.stem, "rt": rt, **rep, "ret": ret})
        print(f"{f.stem:<9}{len(d):>8,}{rep['bos_detected']:>6}{rep['n_trades']:>7}"
              f"{rep['fill_rate']:>6.0%}{rep['win_rate']:>7.1%}"
              f"{rep['median_risk_bps']:>10.1f}{rt:>10.1f}"
              f"{rep['expectancy_r']:>9.3f}{ret:>9.2%}")

    if not rows:
        print("\nNo trades on any instrument.")
        return

    df = pd.DataFrame(rows)
    R = np.array(all_r)

    # ---------------------------------------------------------------- 2
    header("2. THE COST WALL FOR THIS SPECIFIC STRATEGY")
    print("  A 1.5R winner earns 1.5 x (1R). Costs are paid twice per trade.\n"
          "  The question is what fraction of the payoff the toll takes.\n")
    print(f"{'symbol':<9}{'1R (bps)':>11}{'round trip':>12}{'cost as % of 1R':>18}"
          f"{'breakeven win%':>16}")
    print("-" * 68)
    for r in df.itertuples():
        frac = r.rt / r.median_risk_bps if r.median_risk_bps else np.inf
        # w*1.5R - (1-w)*1R - cost = 0  ->  w = (1R + cost) / 2.5R
        be = (1 + frac) / (1 + cfg.risk_reward)
        print(f"{r.sym:<9}{r.median_risk_bps:>11.1f}{r.rt:>12.1f}"
              f"{frac:>17.0%}{be:>16.1%}")
    print("\n  'breakeven win%' already includes the cost. Compare it with the\n"
          "  measured win rate in section 1 — that comparison is the strategy's\n"
          "  entire economics, before any judgement about the entry rule.")

    # ---------------------------------------------------------------- 3
    header("3. POOLED — every trade")
    n, k = len(R), int((R > 0).sum())
    lw, hw = wilson(k, n)
    lo, hi, p = boot(R)
    print(f"  trades                 : {n}")
    print(f"  win rate               : {k / n:>8.1%}   95% CI [{lw:.1%}, {hw:.1%}]")
    print(f"  breakeven @{cfg.risk_reward}R (no cost): "
          f"{1 / (1 + cfg.risk_reward):>7.1%}")
    print(f"  expectancy             : {R.mean():>8.3f} R")
    print(f"  95% CI                 : [{lo:.3f}, {hi:.3f}] R")
    print(f"  P(expectancy > 0)      : {p:>8.1%}")
    print(f"  total R                : {R.sum():>8.2f}")
    v = ("SIGNIFICANTLY POSITIVE" if lo > 0 else
         "SIGNIFICANTLY NEGATIVE" if hi < 0 else "INCONCLUSIVE — CI includes zero")
    print(f"\n  VERDICT (before costs): {v}")

    # ---------------------------------------------------------------- 4
    header("4. THE 'A STOP IS A REVERSAL SIGNAL' CLAIM")
    print("  Testing it rather than assuming it either way.\n")
    print(f"{'variant':<24}{'trades':>8}{'win%':>8}{'expect':>10}{'total R':>10}")
    print("-" * 60)
    for label, fc in (("as specified", FibBosConfig()),
                      ("flip after stop", FibBosConfig(flip_after_stop=True))):
        rs = []
        for f in files:
            d = load_csv(f)
            s = FibBosScalper(fc)
            run(d, s, costs=COSTS.get(f.stem, Costs(0.0, 0.0002)), bar_freq="1min")
            rs.extend(t.r_multiple for t in s.trades)
        a = np.array(rs)
        if len(a):
            print(f"{label:<24}{len(a):>8}{(a > 0).mean():>7.1%}"
                  f"{a.mean():>10.3f}{a.sum():>10.2f}")

    print(
        "\n  Caveat on all of the above: Yahoo serves only 7 days of 1-minute\n"
        "  data, so this is one week of market conditions. It is enough trades\n"
        "  to measure the COST arithmetic in section 2 — which does not depend\n"
        "  on the sample — but not enough weeks to settle the edge."
    )


if __name__ == "__main__":
    main()
