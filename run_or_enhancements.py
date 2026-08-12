#!/usr/bin/env python
"""
Do the "enhancements" actually rescue the opening-range fade?

    python run_or_enhancements.py

The baseline measured 32.6% wins against a 33.3% breakeven — neutral. The
creator says it is "a baseline that can be enhanced by other price action
concepts". This tests that claim.

THE CORRECTION THAT MAKES THIS MEANINGFUL
-----------------------------------------
Testing N variants and reporting the best is guaranteed to produce a winner
even when every variant is worthless. With 20 variants at the usual 5%
threshold, you expect ONE false positive by construction.

So two corrections are applied:

  * BONFERRONI — a variant must clear p < 0.05/N, not p < 0.05, to count.
  * A NULL SEARCH — the same number of variants is run against shuffled
    trade outcomes, where no edge can exist by construction. The best of
    that search is the bar the real winner must beat.

Without both, "we found an enhancement that works" is just a description of
how many things were tried.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from tradingbot import Costs, load_csv, run
from tradingbot.opening_range_fade import ORFadeConfig, OpeningRangeFade

DATA = Path(__file__).parent / "data" / "m5"
COSTS = {
    "EURUSD": Costs(0.0, 0.00005), "GBPUSD": Costs(0.0, 0.00005),
    "USDJPY": Costs(0.0, 0.00005), "AUDUSD": Costs(0.0, 0.00006),
    "GC": Costs(0.0, 0.00015), "SI": Costs(0.0, 0.00030),
    "BTC": Costs(0.0005, 0.0002), "ETH": Costs(0.0005, 0.0002),
}


def header(t: str) -> None:
    print(f"\n{'=' * 80}\n{t}\n{'=' * 80}")


def boot_ci(x: np.ndarray, n: int = 20_000) -> tuple[float, float, float]:
    rng = np.random.default_rng(0)
    bs = np.array([rng.choice(x, len(x), replace=True).mean() for _ in range(n)])
    lo, hi = np.percentile(bs, [2.5, 97.5])
    return lo, hi, float((bs <= 0).mean())   # one-sided p for "expectancy > 0"


def variants() -> dict[str, ORFadeConfig]:
    """Enhancements a practitioner would actually reach for."""
    v: dict[str, ORFadeConfig] = {"baseline": ORFadeConfig()}
    # trend alignment — only fade WITH the larger trend
    for n in (50, 200, 500):
        v[f"trend EMA{n}"] = ORFadeConfig(trend_ema=n)
    # require a real sweep, not a graze
    for f in (0.05, 0.10, 0.25):
        v[f"sweep >{f:.0%}"] = ORFadeConfig(min_breakout_frac=f)
    # range-size regime filters
    v["range < 1.2x norm"] = ORFadeConfig(max_range_ratio=1.2)
    v["range > 0.8x norm"] = ORFadeConfig(min_range_ratio=0.8)
    v["range 0.8-1.2x"] = ORFadeConfig(min_range_ratio=0.8, max_range_ratio=1.2)
    # session windows (NY hours)
    v["entry 04-08 NY"] = ORFadeConfig(entry_hours=(4, 5, 6, 7))
    v["entry 08-12 NY"] = ORFadeConfig(entry_hours=(8, 9, 10, 11))
    v["entry 09-11 NY"] = ORFadeConfig(entry_hours=(9, 10))
    # payoff variations
    for rr in (1.0, 1.5, 3.0):
        v[f"{rr:.1f}R target"] = ORFadeConfig(risk_reward=rr)
    # direction-only
    v["longs only"] = ORFadeConfig(allow_short=False)
    v["shorts only"] = ORFadeConfig(allow_long=False)
    # combinations a real user would try
    v["trend200 + sweep10%"] = ORFadeConfig(trend_ema=200, min_breakout_frac=0.10)
    v["trend200 + 1.5R"] = ORFadeConfig(trend_ema=200, risk_reward=1.5)
    v["sweep10% + 1.5R"] = ORFadeConfig(min_breakout_frac=0.10, risk_reward=1.5)
    return v


def evaluate(cfg: ORFadeConfig, files) -> np.ndarray:
    rs: list[float] = []
    for f in files:
        d = load_csv(f)
        s = OpeningRangeFade(cfg)
        run(d, s, costs=COSTS.get(f.stem, Costs(0.0, 0.0002)), bar_freq="5min")
        rs.extend(t.r_multiple for t in s.trades)
    return np.array(rs)


def main() -> None:
    files = sorted(DATA.glob("*.csv"))
    if not files:
        print("No data. Run: python fetch_stocks.py --m5")
        return

    vs = variants()
    n_var = len(vs)
    alpha = 0.05 / n_var
    print(f"{len(files)} instruments | {n_var} variants tested")
    print(f"Bonferroni threshold: p < 0.05/{n_var} = {alpha:.4f}")

    header("1. EVERY VARIANT (sorted by expectancy)")
    rows = []
    for name, cfg in vs.items():
        R = evaluate(cfg, files)
        if len(R) < 20:
            continue
        lo, hi, p = boot_ci(R)
        rows.append({"variant": name, "n": len(R), "win": float((R > 0).mean()),
                     "exp": float(R.mean()), "total": float(R.sum()),
                     "lo": lo, "hi": hi, "p": p})

    df = pd.DataFrame(rows).sort_values("exp", ascending=False)
    print(f"{'variant':<22}{'trades':>8}{'win%':>7}{'expect':>9}"
          f"{'totalR':>9}{'95% CI':>20}{'p':>8}")
    print("-" * 83)
    for r in df.itertuples():
        ci = f"[{r.lo:+.3f}, {r.hi:+.3f}]"
        print(f"{r.variant:<22}{r.n:>8}{r.win:>6.1%}{r.exp:>9.3f}"
              f"{r.total:>9.1f}{ci:>20}{r.p:>8.3f}")

    best = df.iloc[0]

    header("2. DOES THE WINNER SURVIVE THE MULTIPLE-TESTING CORRECTION?")
    print(f"  best variant       : {best['variant']}")
    print(f"  expectancy         : {best['exp']:+.3f} R over {int(best['n'])} trades")
    print(f"  one-sided p        : {best['p']:.4f}")
    print(f"  Bonferroni alpha   : {alpha:.4f}   (0.05 / {n_var} variants)")
    print(f"  uncorrected pass   : {'YES' if best['p'] < 0.05 else 'NO'}")
    print(f"  CORRECTED pass     : {'YES' if best['p'] < alpha else 'NO'}")
    print(f"\n  variants with positive expectancy: "
          f"{int((df['exp'] > 0).sum())}/{len(df)}")
    print(f"  variants passing uncorrected p<0.05: {int((df['p'] < 0.05).sum())}")
    print(f"  variants passing corrected p<{alpha:.4f}: "
          f"{int((df['p'] < alpha).sum())}")

    header("3. NULL SEARCH — what does 'best of N' look like with NO edge?")
    print(f"  Re-running the same {n_var}-variant search on SHUFFLED outcomes,\n"
          f"  where any edge is destroyed by construction. 200 repeats.\n")
    base_R = evaluate(vs["baseline"], files)
    rng = np.random.default_rng(0)
    null_best = []
    for _ in range(200):
        best_exp = -np.inf
        for _ in range(n_var):
            # Same trade count as a typical variant, outcomes reshuffled.
            k = max(int(len(base_R) * rng.uniform(0.4, 1.0)), 20)
            samp = rng.choice(base_R, k, replace=True)
            samp = samp - samp.mean()          # force zero true edge
            best_exp = max(best_exp, samp.mean())
        null_best.append(best_exp)
    null_best = np.array(null_best)

    print(f"  best-of-{n_var} under the null : mean {null_best.mean():+.3f} R, "
          f"95th pct {np.percentile(null_best, 95):+.3f} R")
    print(f"  observed best                : {best['exp']:+.3f} R")
    beats = float((null_best >= best["exp"]).mean())
    print(f"  P(null search beats it)      : {beats:.1%}")

    header("VERDICT")
    passed = best["p"] < alpha and beats < 0.05 and best["exp"] > 0
    if passed:
        print("  An enhancement survived BOTH corrections. That is worth a\n"
              "  walk-forward on fresh data — not a live account.")
    else:
        print("  No enhancement survives correction for the number of things\n"
              "  tried. The best variant sits inside what a no-edge search of\n"
              "  this size produces by chance.\n")
        print("  This is the answer to 'can it be enhanced?': not by any of the\n"
              "  standard price-action filters, on this data. Layering more\n"
              "  filters on a neutral baseline mostly buys fewer trades and a\n"
              "  better-looking sample, not an edge.")


if __name__ == "__main__":
    main()
