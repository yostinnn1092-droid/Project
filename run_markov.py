#!/usr/bin/env python
"""
Test the Markov regime-switching strategy.

    python fetch_stocks.py --d1 && python run_markov.py

Claims under test: "the S&P 500 turns profitable across 30 years, and Bitcoin
shows closer to 60x", once lookahead bias is removed.

The number that decides it is EXCESS OVER BUY-AND-HOLD. Bitcoin rose roughly
60x over the period on its own, so a 60x strategy result may be the asset
rather than the strategy. Same for a rising S&P.

Section 3 measures the lookahead bias itself — the thing the video says it
fixed — by running the identical strategy with a full-sample matrix.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from tradingbot import BuyAndHold, Costs, load_csv, run
from tradingbot.markov_regime import MarkovConfig, MarkovRegime

DATA = Path(__file__).parent / "data" / "d1"
# Daily rebalancing on liquid index/crypto proxies. Generous but not free.
COSTS = Costs(commission=0.0, slippage=0.0002)


def header(t: str) -> None:
    print(f"\n{'=' * 80}\n{t}\n{'=' * 80}")


def pct(stats, key="total_return") -> float:
    return float(stats[key].strip().rstrip("%")) / 100


def main() -> None:
    files = [f for f in sorted(DATA.glob("*.csv")) if f.stem != "CL"]  # WTI went NEGATIVE in Apr 2020; returns are undefined
    if not files:
        print("No data. Run: python fetch_stocks.py --d1")
        return
    cfg = MarkovConfig()
    print(f"{len(files)} instruments, daily bars")
    print(f"states: {cfg.lookback}-bar return vs {cfg.threshold_sd} SD "
          f"| mode={cfg.mode} | expanding matrix (no lookahead)")

    # ---------------------------------------------------------------- 1
    header("1. THE STRATEGY vs BUY-AND-HOLD")
    print(f"{'symbol':<9}{'bars':>7}{'years':>7}{'strategy':>11}{'buy&hold':>11}"
          f"{'excess':>10}{'sharpe':>8}{'maxDD':>9}")
    print("-" * 72)
    rows = []
    for f in files:
        d = load_csv(f, repair=True)
        s = MarkovRegime(cfg)
        r = run(d, s, costs=COSTS, bar_freq="1D")
        b = run(d, BuyAndHold(), costs=COSTS, bar_freq="1D")
        sr, br = pct(r.stats), pct(b.stats)
        yrs = float(r.stats["span_years"])
        rows.append({"sym": f.stem, "strat": sr, "bh": br, "excess": sr - br,
                     "sharpe": float(r.stats["sharpe"]),
                     "bh_sharpe": float(b.stats["sharpe"]), "years": yrs,
                     "rep": s.report()})
        print(f"{f.stem:<9}{len(d):>7,}{yrs:>7.1f}{sr:>11.1%}{br:>11.1%}"
              f"{sr - br:>10.1%}{r.stats['sharpe'].strip():>8}"
              f"{r.stats['max_drawdown'].strip():>9}")

    df = pd.DataFrame(rows)
    ex = df["excess"].to_numpy()
    print(f"\n  beat buy-and-hold : {int((ex > 0).sum())}/{len(ex)}")
    print(f"  mean excess       : {ex.mean():>9.1%}")
    print(f"  median excess     : {np.median(ex):>9.1%}")
    print(f"  better Sharpe on  : "
          f"{int((df['sharpe'] > df['bh_sharpe']).sum())}/{len(df)}")
    print("\n  Total return flatters whichever asset went up most. Sharpe and\n"
          "  excess are the comparable columns.")

    # ---------------------------------------------------------------- 2
    header("2. IS THE PREMISE TRUE? (stickiness — does a regime persist?)")
    print("  A memoryless market gives 0.333 on every diagonal. Above that is\n"
          "  the entire justification for trend following.\n")
    print(f"{'symbol':<9}{'P(bull|bull)':>14}{'P(side|side)':>14}"
          f"{'P(bear|bear)':>14}{'avg':>8}")
    print("-" * 60)
    for r in rows:
        rep = r["rep"]
        if rep.get("bars", 1) == 0:
            continue
        a = (rep["stickiness_bull"] + rep["stickiness_side"] + rep["stickiness_bear"]) / 3
        print(f"{r['sym']:<9}{rep['stickiness_bull']:>14.3f}"
              f"{rep['stickiness_side']:>14.3f}{rep['stickiness_bear']:>14.3f}"
              f"{a:>8.3f}")
    print("\n  If these sit well above 0.333, regimes genuinely persist and the\n"
          "  method rests on something real — whether or not it pays after costs.")

    # ---------------------------------------------------------------- 3
    header("3. HOW BIG IS THE LOOKAHEAD BIAS THE VIDEO SAYS IT FIXED?")
    print("  Same strategy, same data. Only difference: the biased version\n"
          "  builds its transition matrix from the WHOLE history, including\n"
          "  each trade's own future.\n")
    print(f"{'symbol':<9}{'honest':>12}{'lookahead':>12}{'inflation':>12}")
    print("-" * 46)
    infl = []
    for f in files:
        d = load_csv(f, repair=True)
        h = run(d, MarkovRegime(MarkovConfig(expanding=True)), costs=COSTS, bar_freq="1D")
        kb = MarkovRegime(MarkovConfig(expanding=False)); kb.prepare(d)
        k = run(d, kb, costs=COSTS, bar_freq="1D")
        hr, kr = pct(h.stats), pct(k.stats)
        infl.append(kr - hr)
        print(f"{f.stem:<9}{hr:>12.1%}{kr:>12.1%}{kr - hr:>+12.1%}")
    ia = np.array(infl)
    print(f"\n  mean inflation from lookahead: {ia.mean():>+8.1%}")
    print("  This is what the video corrected. Positive means the biased\n"
          "  version reports better numbers than are achievable.")

    # ---------------------------------------------------------------- 4
    header("4. SENSITIVITY — does it depend on the exact state boundary?")
    print("  If the edge only exists at one threshold, the threshold was\n"
          "  fitted to this data rather than measured from it.\n")
    print(f"{'threshold':>11}{'lookback':>10}{'mean excess':>14}{'beat B&H':>11}")
    print("-" * 48)
    for thr in (0.25, 0.5, 1.0):
        for lb in (10, 20, 60):
            exs = []
            for f in files:
                d = load_csv(f, repair=True)
                c2 = MarkovConfig(threshold_sd=thr, lookback=lb)
                r = run(d, MarkovRegime(c2), costs=COSTS, bar_freq="1D")
                b = run(d, BuyAndHold(), costs=COSTS, bar_freq="1D")
                exs.append(pct(r.stats) - pct(b.stats))
            e = np.array(exs)
            print(f"{thr:>11.2f}{lb:>10}{e.mean():>14.1%}"
                  f"{int((e > 0).sum())}/{len(e):<11}")

    print("\n  Read down the 'beat B&H' column. A robust effect degrades\n"
          "  gracefully across settings; a fitted one switches on and off.")


if __name__ == "__main__":
    main()
