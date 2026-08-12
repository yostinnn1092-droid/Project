#!/usr/bin/env python
"""
Test Open Range Breakout — the strategy sold by most "forex robot" channels.

    python run_orb.py

Claims attached to this strategy in marketing run to 451% in 7 months and
253% in 30 days. Those are checkable. This runs ORB over 10 forex pairs of
hourly data, out-of-sample, against two benchmarks:

  * buy-and-hold — the free alternative
  * random entries with IDENTICAL stops and targets — which isolates whether
    the breakout entry carries information, or the risk management is doing
    the work

Both London and New York sessions are reported. Picking whichever looked
better afterwards would be the data-snooping trap this repo exists to catch.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from tradingbot import BuyAndHold, Costs, load_csv, run
from tradingbot.ict import ICTConfig, RandomEntry
from tradingbot.orb import ORBConfig, ORBStrategy

DATA = Path(__file__).parent / "data" / "forex_h1"
COSTS = Costs(commission=0.0, slippage=0.00005)


def header(t: str) -> None:
    print(f"\n{'=' * 78}\n{t}\n{'=' * 78}")


def boot(x: np.ndarray) -> tuple[float, float, float]:
    rng = np.random.default_rng(0)
    bs = np.array([rng.choice(x, len(x), replace=True).mean() for _ in range(20_000)])
    lo, hi = np.percentile(bs, [2.5, 97.5])
    return lo, hi, float((bs > 0).mean())


def main() -> None:
    files = sorted(DATA.glob("*.csv"))
    if not files:
        print("No data. Run: python fetch_stocks.py --forex")
        return
    print(f"{len(files)} pairs, hourly bars")

    # ---------------------------------------------------------------- 1
    header("1. ORB BY SESSION — London (07 UTC) vs New York (12 UTC)")
    print("  Both reported. Choosing the better one afterwards would be\n"
          "  exactly the data-snooping this repo is about.\n")
    print(f"{'pair':<9}{'LON ret':>10}{'LON tr':>8}{'LON win':>9}"
          f"{'NY ret':>10}{'NY tr':>8}{'NY win':>9}{'B&H':>9}")
    print("-" * 72)

    lon_rets, ny_rets, rows = [], [], []
    for f in files:
        d = load_csv(f)
        out = {}
        for tag, hour in (("LON", 7), ("NY", 12)):
            s = ORBStrategy(ORBConfig(session_hour=hour))
            r = run(d, s, costs=COSTS, bar_freq="1h")
            rep = s.report()
            out[tag] = (
                float(r.stats["total_return"].strip().rstrip("%")) / 100,
                rep.get("n_trades", 0),
                rep.get("win_rate", 0.0),
            )
        b = run(d, BuyAndHold(), costs=COSTS, bar_freq="1h")
        bh = float(b.stats["total_return"].strip().rstrip("%")) / 100
        lon_rets.append(out["LON"][0])
        ny_rets.append(out["NY"][0])
        rows.append({"pair": f.stem, "lon": out["LON"], "ny": out["NY"], "bh": bh})
        print(f"{f.stem:<9}{out['LON'][0]:>10.2%}{out['LON'][1]:>8}"
              f"{out['LON'][2]:>8.1%}{out['NY'][0]:>10.2%}{out['NY'][1]:>8}"
              f"{out['NY'][2]:>8.1%}{bh:>9.2%}")

    lon = np.array(lon_rets)
    ny = np.array(ny_rets)
    print(f"\n  London mean : {lon.mean():>8.2%}   positive: {int((lon > 0).sum())}/{len(lon)}")
    print(f"  New York mean: {ny.mean():>8.2%}   positive: {int((ny > 0).sum())}/{len(ny)}")

    # ---------------------------------------------------------------- 2
    header("2. vs RANDOM ENTRIES WITH IDENTICAL STOPS AND TARGETS")
    print("  Does the breakout entry know anything, or is it the 2R stop-and-\n"
          "  target structure producing the shape? Averaged over 5 seeds.\n")
    print(f"{'pair':<9}{'ORB (LON)':>12}{'random':>10}{'edge':>10}")
    print("-" * 42)
    edges = []
    for row, f in zip(rows, files):
        d = load_csv(f)
        n_tr = max(row["lon"][1], 1)
        prob = min(n_tr / max(len(d), 1) * 3.0, 1.0)
        rr = []
        for seed in range(5):
            rs = RandomEntry(ICTConfig(killzone_only=False, risk_reward=2.0),
                             entry_prob=prob, seed=seed)
            r = run(d, rs, costs=COSTS, bar_freq="1h")
            rr.append(float(r.stats["total_return"].strip().rstrip("%")) / 100)
        mr = float(np.mean(rr))
        e = row["lon"][0] - mr
        edges.append(e)
        print(f"{row['pair']:<9}{row['lon'][0]:>12.2%}{mr:>10.2%}{e:>10.2%}")

    e = np.array(edges)
    lo, hi, p = boot(e)
    print(f"\n  ORB beat random on : {int((e > 0).sum())}/{len(e)}")
    print(f"  mean edge          : {e.mean():>8.2%}")
    print(f"  95% CI             : [{lo:.2%}, {hi:.2%}]")
    print(f"  P(edge > 0)        : {p:>8.1%}")

    # ---------------------------------------------------------------- 3
    header("3. THE MARKETED CLAIMS, AGAINST WHAT WE MEASURED")
    best = max(lon.mean(), ny.mean())
    print(f"  measured ORB, 10 pairs, 2 years : {best:>10.2%} total")
    print(f"  marketed: 451% over 7 months    : {'451.00%':>10}")
    print(f"  marketed: 253% over 30 days     : {'253.00%':>10}")
    print()
    print("  253%/month compounds to roughly 1,400,000x per year.")
    print("  451%/7 months annualises to roughly 21x per year.")
    print("  Renaissance Medallion, the best fund on record: ~66%/year.")

    print(
        "\n  Caveats that cut in ORB's favour, stated plainly:\n"
        "    * Hourly bars are coarse for ORB; it is normally run on 5-15min,\n"
        "      so this is an approximation and the error direction is unknown.\n"
        "    * Real products add news filters, trailing stops and per-pair\n"
        "      'set files' — i.e. per-market tuning this test does not do.\n"
        "  Neither closes a gap between single-digit percentages and 451%."
    )


if __name__ == "__main__":
    main()
