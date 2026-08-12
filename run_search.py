#!/usr/bin/env python
"""
Search for the most profitable strategy — and then check whether the winner
means anything.

    python run_search.py

WHY THE SECOND HALF MATTERS MORE THAN THE FIRST
-----------------------------------------------
"Find the best strategy" is the single most dangerous request in
quantitative finance, because a search always returns a winner. Test 40
strategies with no edge whatsoever and one of them still comes first, with a
handsome equity curve and a plausible story. The winner's performance is
inflated by the *act of searching*, and the more you search, the more
inflated it gets.

This is the mechanism behind most published trading systems: someone tried
many things, reported the best, and never asked what "best of many" looks
like when nothing works.

So this script does two things:

  1. Ranks every strategy honestly, out-of-sample, on excess over
     buy-and-hold across many instruments.
  2. Asks the only question that makes the ranking meaningful: **is the
     winner better than the winner of an equally large search over
     strategies known to have no edge?**

Step 2 uses `RandomEntry` variants — same machinery, uninformed entries. The
best of N of those is the bar the real winner has to clear. Beating the
*average* random strategy is easy and meaningless; beating the *best* of an
equal-sized random search is the actual test.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from tradingbot import (
    Breakout,
    BuyAndHold,
    Costs,
    MeanReversion,
    SmaCrossover,
    load_csv,
    run,
)
from tradingbot.adaptive import AdaptiveRegime
from tradingbot.ict import ICTConfig, ICTStrategy, RandomEntry

FX = Path(__file__).parent / "data" / "forex_h1"
EQ = Path(__file__).parent / "data" / "stocks_h1"
FX_COSTS = Costs(commission=0.0, slippage=0.00005)
EQ_COSTS = Costs(commission=0.0, slippage=0.0001)
TEST_FRAC = 0.4  # judge only on the last 40% of each series


def header(t: str) -> None:
    print(f"\n{'=' * 80}\n{t}\n{'=' * 80}")


def build_candidates() -> dict:
    """Four structurally different families, not one idea re-parameterised."""
    c: dict = {}
    for f, s in [(10, 50), (20, 50), (20, 100), (40, 100), (50, 200)]:
        c[f"SMA {f}/{s}"] = lambda f=f, s=s: SmaCrossover(f, s)
    for e, x in [(20, 10), (40, 20), (55, 20), (100, 50)]:
        c[f"Breakout {e}/{x}"] = lambda e=e, x=x: Breakout(e, x)
    for lb, z in [(20, 1.5), (50, 1.5), (50, 2.0), (100, 2.0)]:
        c[f"MeanRev {lb}/{z}"] = lambda lb=lb, z=z: MeanReversion(lb, z)
    for thr in (0.25, 0.35, 0.45):
        c[f"Adaptive ER>{thr}"] = lambda t=thr: AdaptiveRegime(er_threshold=t)
    for rr in (1.5, 2.0, 3.0):
        c[f"ICT {rr}R"] = lambda rr=rr: ICTStrategy(ICTConfig(risk_reward=rr))
    c["ICT no-FVG"] = lambda: ICTStrategy(ICTConfig(require_fvg=False))
    return c


def evaluate(factory, files, costs, freq) -> float | None:
    """Mean excess over buy-and-hold on the held-out tail of each instrument."""
    ex = []
    for f in files:
        d = load_csv(f)
        cut = int(len(d) * (1 - TEST_FRAC))
        test = d.iloc[cut:].reset_index(drop=True)
        try:
            r = run(test, factory(), costs=costs, bar_freq=freq)
            b = run(test, BuyAndHold(), costs=costs, bar_freq=freq)
        except Exception:
            continue
        sr = float(r.stats["total_return"].strip().rstrip("%")) / 100
        br = float(b.stats["total_return"].strip().rstrip("%")) / 100
        ex.append(sr - br)
    return float(np.mean(ex)) if ex else None


def main() -> None:
    fxf = sorted(FX.glob("*.csv"))
    eqf = sorted(EQ.glob("*.csv"))
    if not fxf and not eqf:
        print("No data. Run: python fetch_stocks.py && python fetch_stocks.py --forex")
        return
    print(f"instruments: {len(fxf)} forex + {len(eqf)} stocks")
    print(f"judged on the last {TEST_FRAC:.0%} of each series, "
          f"excess over buy-and-hold")

    cands = build_candidates()
    print(f"candidates : {len(cands)}")

    # ---------------------------------------------------------------- 1
    header("1. THE RANKING")
    rows = []
    for name, fac in cands.items():
        fx = evaluate(fac, fxf, FX_COSTS, "1h")
        eq = evaluate(fac, eqf, EQ_COSTS, "1h")
        vals = [v for v in (fx, eq) if v is not None]
        if not vals:
            continue
        rows.append({"strategy": name, "forex": fx, "stocks": eq,
                     "combined": float(np.mean(vals))})

    df = pd.DataFrame(rows).sort_values("combined", ascending=False)
    print(f"{'rank':>5}  {'strategy':<20}{'forex':>10}{'stocks':>10}{'combined':>11}")
    print("-" * 58)
    for i, r in enumerate(df.itertuples(), 1):
        fx = f"{r.forex:>9.2%}" if r.forex is not None else "        -"
        eq = f"{r.stocks:>9.2%}" if r.stocks is not None else "        -"
        print(f"{i:>5}  {r.strategy:<20}{fx}{eq}{r.combined:>11.2%}")

    best = df.iloc[0]
    print(f"\n  WINNER: {best['strategy']}  ({best['combined']:.2%} excess)")

    # ---------------------------------------------------------------- 2
    header("2. THE REALITY CHECK — what does 'best of N' look like with no edge?")
    n = len(df)
    print(f"  Running {n} RANDOM strategies through the identical pipeline.\n"
          f"  None can possibly have an edge. The best of them is the bar the\n"
          f"  winner above must clear.\n")

    rnd = []
    for seed in range(n):
        fac = (lambda s=seed: RandomEntry(ICTConfig(), entry_prob=0.02, seed=s))
        fx = evaluate(fac, fxf, FX_COSTS, "1h")
        eq = evaluate(fac, eqf, EQ_COSTS, "1h")
        vals = [v for v in (fx, eq) if v is not None]
        if vals:
            rnd.append(float(np.mean(vals)))

    rnd = np.array(rnd)
    real = df["combined"].to_numpy()
    print(f"  random strategies run   : {len(rnd)}")
    print(f"  random   mean / best    : {rnd.mean():>8.2%} / {rnd.max():>8.2%}")
    print(f"  real     mean / best    : {real.mean():>8.2%} / {real.max():>8.2%}")
    print(f"  winner beats random best: "
          f"{'YES' if real.max() > rnd.max() else 'NO'}")
    print(f"  real strategies above random best: "
          f"{int((real > rnd.max()).sum())}/{len(real)}")

    # How extreme is the observed best against the random-search distribution?
    pct = float((rnd >= real.max()).mean())
    print(f"\n  P(a no-edge search produces a winner this good) : {pct:.1%}")
    if pct > 0.05:
        print("  -> The winner is INSIDE what pure search noise produces.\n"
              "     It is the luckiest of the candidates, not the best of them.")
    else:
        print("  -> The winner is outside what search noise alone explains.\n"
              "     Worth a proper out-of-sample and walk-forward follow-up.")

    # ---------------------------------------------------------------- 3
    header("3. THE HONEST SUMMARY")
    print(f"  strategies with positive excess : "
          f"{int((real > 0).sum())}/{len(real)}")
    print(f"  median strategy excess          : {np.median(real):>8.2%}")
    print(f"  buy-and-hold is the benchmark, so 0.00% means 'matched it'")
    print(
        "\n  Read the ranking as a ranking, never as a discovery. The number\n"
        "  attached to the top row is inflated by the search that produced it,\n"
        "  and the only cure is fresh data the search never touched."
    )


if __name__ == "__main__":
    main()
