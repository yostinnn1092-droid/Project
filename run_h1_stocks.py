#!/usr/bin/env python
"""
Does the H1 trend result hold across many stocks?

    python fetch_stocks.py && python run_h1_stocks.py

The original H1 finding (+23.87%, Sharpe 1.08) came from ONE stock over 15
months. That cannot separate a real effect from that stock's particular
history. This runs the same idea over 21 instruments and ~73,000 hourly bars.

The metric that matters is EXCESS OVER BUY-AND-HOLD, not raw return. In a
rising market every long-biased strategy looks good; the only question is
whether the strategy beat simply owning the thing.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from tradingbot import BuyAndHold, Costs, SmaCrossover, load_csv, run
from tradingbot.walkforward import walk_forward

DATA = Path(__file__).parent / "data" / "stocks_h1"

# Modern US retail equities: zero commission, ~1bp spread per side on liquid
# large caps. Far cheaper than the 12bp used for the HK 5-min study, and the
# difference matters — costs are a property of the venue, not a constant.
COSTS = Costs(commission=0.0, slippage=0.0001)
GRID = {"fast": [5, 10, 20, 40], "slow": [50, 100, 200]}


def header(t: str) -> None:
    print(f"\n{'=' * 78}\n{t}\n{'=' * 78}")


def verdict(lo: float, hi: float) -> str:
    """Three outcomes, not two.

    A confidence interval lying entirely BELOW zero is not "inconclusive" —
    it is a confident negative finding, and reporting it as "not significant"
    throws away the strongest result the test can produce. Collapsing that
    case into the null is a real reporting bug; this function exists so it
    cannot happen silently.
    """
    if lo > 0:
        return "SIGNIFICANTLY POSITIVE — excess survives"
    if hi < 0:
        return "SIGNIFICANTLY NEGATIVE — reliably worse than buy-and-hold"
    return "INCONCLUSIVE — CI includes zero"


def boot(x: np.ndarray, n: int = 20_000) -> tuple[float, float, float]:
    rng = np.random.default_rng(0)
    bs = np.array([rng.choice(x, len(x), replace=True).mean() for _ in range(n)])
    lo, hi = np.percentile(bs, [2.5, 97.5])
    return lo, hi, float((bs > 0).mean())


def main() -> None:
    files = sorted(DATA.glob("*.csv"))
    if not files:
        print("No data. Run: python fetch_stocks.py")
        return
    print(f"{len(files)} instruments, hourly bars")

    # ---------------------------------------------------------------- 1
    header("1. FIXED PARAMETERS (20/50), NO TUNING — the least foolable test")
    print("  One setting for every stock. Nothing fitted, so nothing to overfit.\n")
    print(f"{'symbol':<8}{'bars':>7}{'trades':>8}{'strategy':>11}"
          f"{'buy&hold':>11}{'excess':>10}{'sharpe':>9}")
    print("-" * 64)
    rows = []
    for f in files:
        d = load_csv(f)
        r = run(d, SmaCrossover(20, 50), costs=COSTS, bar_freq="1h")
        b = run(d, BuyAndHold(), costs=COSTS, bar_freq="1h")
        sr = float(r.stats["total_return"].strip().rstrip("%")) / 100
        br = float(b.stats["total_return"].strip().rstrip("%")) / 100
        rows.append({"sym": f.stem, "strat": sr, "bh": br, "excess": sr - br,
                     "sharpe": float(r.stats["sharpe"])})
        print(f"{f.stem:<8}{len(d):>7,}{r.stats['n_trades'].strip():>8}"
              f"{sr:>10.2%}{br:>11.2%}{sr - br:>10.2%}{r.stats['sharpe'].strip():>9}")

    df = pd.DataFrame(rows)
    ex = df["excess"].to_numpy()
    lo, hi, p = boot(ex)
    print(f"\n  beat buy-and-hold : {int((ex > 0).sum())}/{len(ex)}")
    print(f"  mean excess       : {ex.mean():>8.2%}")
    print(f"  median excess     : {np.median(ex):>8.2%}")
    print(f"  95% CI            : [{lo:.2%}, {hi:.2%}]")
    print(f"  P(mean excess > 0): {p:>8.1%}")
    print(f"  verdict           : {verdict(lo, hi)}")

    # ---------------------------------------------------------------- 2
    header("2. WALK-FORWARD PER STOCK — re-tune on the past, trade blind")
    print("  Pooling every out-of-sample window across every stock.\n")
    print(f"{'symbol':<8}{'windows':>9}{'profit':>8}{'mean ret':>10}"
          f"{'mean B&H':>10}{'excess':>9}{'params':>8}")
    print("-" * 62)

    all_ex, all_ret, per_stock = [], [], []
    for f in files:
        d = load_csv(f)
        res = walk_forward(
            d,
            strategy_factory=lambda fast, slow: SmaCrossover(fast, slow),
            param_grid=GRID,
            train_size=500,
            test_size=250,
            warmup=max(GRID["slow"]) + 1,
            costs=COSTS,
            bar_freq="1h",
            benchmark_factory=BuyAndHold,
        )
        w = res.frame()
        if w.empty:
            continue
        r = w["test_return"].to_numpy()
        b = w["benchmark_return"].to_numpy()
        e = r - b
        all_ex.extend(e.tolist())
        all_ret.extend(r.tolist())
        s = res.summary()
        per_stock.append({"sym": f.stem, "mean_excess": e.mean()})
        print(f"{f.stem:<8}{len(w):>9}{int((r > 0).sum()):>8}"
              f"{r.mean():>9.2%}{b.mean():>10.2%}{e.mean():>9.2%}"
              f"{s['distinct_param_sets']:>4}/{len(w):<3}")

    ex = np.array(all_ex)
    rt = np.array(all_ret)
    lo, hi, p = boot(ex)
    ps = pd.DataFrame(per_stock)

    header("3. POOLED RESULT — every window, every stock")
    print(f"  total windows        : {len(ex)}")
    print(f"  stocks               : {len(ps)}")
    print(f"  mean window return   : {rt.mean():>8.2%}")
    print(f"  mean excess over B&H : {ex.mean():>8.2%}")
    print(f"  median excess        : {np.median(ex):>8.2%}")
    print(f"  windows beating B&H  : {int((ex > 0).sum())}/{len(ex)}  "
          f"({(ex > 0).mean():.0%})")
    print(f"  stocks with +excess  : {int((ps['mean_excess'] > 0).sum())}/{len(ps)}")
    print(f"  95% CI (mean excess) : [{lo:.2%}, {hi:.2%}]")
    print(f"  P(mean excess > 0)   : {p:>8.1%}")
    print(f"\n  VERDICT: {verdict(lo, hi)}")

    print(
        "\n  This is the test the original H1 result never had: many\n"
        "  instruments, many windows, judged on excess over simply owning the\n"
        "  asset. Whatever it says now, it says with far more power than 9\n"
        "  windows on a single stock could.\n"
        "\n  Standing caveat: these 21 tickers are all listed TODAY. Companies\n"
        "  that failed are absent, so the basket is pre-selected for survival\n"
        "  and buy-and-hold is flattered. See fetch_stocks.py."
    )


if __name__ == "__main__":
    main()
