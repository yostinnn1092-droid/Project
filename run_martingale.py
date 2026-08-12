#!/usr/bin/env python
"""
Can 72 days of live results tell you whether a bot works?

    python run_martingale.py

A reviewer ran a forex bot for 72 days and it made money. The vendor says it
is not martingale. Rather than argue, this measures the thing that decides
whether a 72-day test could settle the question at all:

  If a system that is GUARANTEED to fail still shows a profit in most 72-day
  windows, then 72 profitable days is not evidence of anything.

That is the whole experiment. It says nothing about any specific product —
it establishes what a 72-day observation is worth.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from tradingbot import Costs, RiskLimits, RiskManager, load_csv, run
from tradingbot.martingale import Martingale, MartingaleConfig

DATA = Path(__file__).parent / "data" / "forex_h1"
COSTS = Costs(commission=0.0, slippage=0.00005)
# Martingale needs leverage by construction: doubling from 5% reaches 160%
# of equity by step six. A 1.0 cap would silently disarm the strategy and
# make this test meaningless, so the cap is raised deliberately.
RISK = lambda: RiskManager(RiskLimits(max_position=8.0, max_drawdown=1.0,
                                      daily_loss_limit=None))
WINDOW = 1200  # ~72 days of hourly forex bars (24h x 5d/wk)


def header(t: str) -> None:
    print(f"\n{'=' * 78}\n{t}\n{'=' * 78}")


def main() -> None:
    files = sorted(DATA.glob("*.csv"))
    if not files:
        print("No data. Run: python fetch_stocks.py --forex")
        return
    cfg = MartingaleConfig()
    print(f"{len(files)} pairs, hourly")
    print(f"martingale: base {cfg.base_size:.0%}, x{cfg.multiplier:.0f} after "
          f"each loss, {cfg.max_steps} steps before ruin")
    print(f"position at final step: {cfg.base_size * cfg.multiplier ** (cfg.max_steps - 1):.0%} of equity")

    # ---------------------------------------------------------------- 1
    header("1. FULL PERIOD (2 years) — what actually happens")
    print(f"{'pair':<9}{'trades':>8}{'win%':>8}{'max step':>10}"
          f"{'blown up':>10}{'return':>11}")
    print("-" * 56)
    blown, rets = 0, []
    for f in files:
        d = load_csv(f)
        s = Martingale(cfg)
        r = run(d, s, costs=COSTS, risk=RISK(), bar_freq="1h")
        rep = s.report()
        ret = float(r.stats["total_return"].strip().rstrip("%")) / 100
        rets.append(ret)
        blown += bool(rep.get("blown_up"))
        print(f"{f.stem:<9}{rep['n_trades']:>8}{rep['win_rate']:>7.1%}"
              f"{rep['max_step_reached']:>10}"
              f"{'YES' if rep['blown_up'] else 'no':>10}{ret:>11.2%}")

    print(f"\n  pairs that hit the ruin step : {blown}/{len(files)}")
    print(f"  mean return over 2 years     : {np.mean(rets):>8.2%}")

    # ---------------------------------------------------------------- 2
    header("2. THE 72-DAY TEST — what a short live run would have shown")
    print(f"  Rolling {WINDOW}-bar (~72 day) windows, stepped by 120 bars.\n"
          f"  Each window is 'someone ran this bot for 72 days'.\n")
    print(f"{'pair':<9}{'windows':>9}{'profitable':>12}{'% green':>10}"
          f"{'median ret':>12}{'worst':>10}")
    print("-" * 62)

    all_green, all_rets = [], []
    for f in files:
        d = load_csv(f)
        greens, wrets = 0, []
        n = 0
        for start in range(0, len(d) - WINDOW, 120):
            w = d.iloc[start:start + WINDOW].reset_index(drop=True)
            s = Martingale(cfg)
            try:
                r = run(w, s, costs=COSTS, risk=RISK(), bar_freq="1h")
            except Exception:
                continue
            ret = float(r.stats["total_return"].strip().rstrip("%")) / 100
            wrets.append(ret)
            greens += ret > 0
            n += 1
        if not n:
            continue
        all_green.append(greens / n)
        all_rets.extend(wrets)
        print(f"{f.stem:<9}{n:>9}{greens:>12}{greens / n:>9.0%}"
              f"{np.median(wrets):>12.2%}{min(wrets):>10.2%}")

    g = np.array(all_green)
    ar = np.array(all_rets)
    print(f"\n  windows tested            : {len(ar)}")
    print(f"  showed a PROFIT           : {int((ar > 0).sum())}/{len(ar)}  "
          f"({(ar > 0).mean():.0%})")
    print(f"  median 72-day return      : {np.median(ar):>8.2%}")
    print(f"  worst 72-day return       : {ar.min():>8.2%}")

    # ---------------------------------------------------------------- 3
    # ---------------------------------------------------------------- 2b
    header("2b. THE CRUEL PART — gentler settings look BETTER for LONGER")
    print("  Real martingale EAs rarely use 2x/6 steps; that blows up fast\n"
          "  enough to be obvious. They use small multipliers and many steps,\n"
          "  which survives far longer — and is therefore far more dangerous,\n"
          "  because the track record looks clean right up to the end.\n")
    print(f"{'config':<26}{'ruin hit':>10}{'72d green':>11}"
          f"{'median 72d':>12}{'worst dd':>10}")
    print("-" * 69)

    variants = {
        "2.0x, 6 steps  (crude)": MartingaleConfig(base_size=0.05, multiplier=2.0,
                                                   max_steps=6),
        "1.5x, 10 steps": MartingaleConfig(base_size=0.02, multiplier=1.5,
                                           max_steps=10),
        "1.3x, 15 steps (typical)": MartingaleConfig(base_size=0.01, multiplier=1.3,
                                                     max_steps=15),
        "1.2x, 20 steps (sneaky)": MartingaleConfig(base_size=0.01, multiplier=1.2,
                                                    max_steps=20),
    }
    for name, vc in variants.items():
        ruin, greens, wrets, dds = 0, 0, [], []
        n = 0
        for f in files:
            d = load_csv(f)
            s = Martingale(vc)
            r = run(d, s, costs=COSTS, risk=RISK(), bar_freq="1h")
            ruin += bool(s.report().get("blown_up"))
            dds.append(float(r.stats["max_drawdown"].strip().rstrip("%")) / 100)
            for start in range(0, len(d) - WINDOW, 240):
                w = d.iloc[start:start + WINDOW].reset_index(drop=True)
                s2 = Martingale(vc)
                try:
                    r2 = run(w, s2, costs=COSTS, risk=RISK(), bar_freq="1h")
                except Exception:
                    continue
                ret = float(r2.stats["total_return"].strip().rstrip("%")) / 100
                wrets.append(ret)
                greens += ret > 0
                n += 1
        pct = greens / n if n else 0
        print(f"{name:<26}{ruin:>6}/{len(files):<3}{pct:>10.0%}"
              f"{np.median(wrets):>12.2%}{min(dds):>10.2%}")

    print(
        "\n  Read the columns together. The crude setting is caught quickly.\n"
        "  The gentle settings survive, show green in more short windows, and\n"
        "  carry the SAME terminal risk — the doubling has not gone away, it\n"
        "  has just been spread over more steps so it fires less often.\n"
        "  A longer clean track record is not reassurance here. It is the\n"
        "  mechanism working as designed."
    )

    header("3. WHAT THIS MEANS FOR A 72-DAY REVIEW")
    print(f"  A system that reaches its ruin step on {blown}/{len(files)} pairs")
    print(f"  over two years still showed a profit in {(ar > 0).mean():.0%} of")
    print(f"  72-day windows.\n")
    print("  So '72 days and it made money' is the EXPECTED observation for")
    print("  a doomed system, not evidence against one. The short window is")
    print("  not weak evidence — it is close to no evidence, because the")
    print("  failure mode is specifically designed to arrive rarely.")
    print()
    print("  What WOULD be evidence:")
    print("    * the full trade log, including position sizes per trade —")
    print("      martingale is visible instantly as doubling stakes")
    print("    * worst-case drawdown across YEARS, not months")
    print("    * whether losing positions are ever closed at a loss, or only")
    print("      averaged into until they come back")
    print("    * account survival across a genuine shock (a gap, a news spike)")
    print()
    print("  None of that requires trusting anyone. All of it is in the log.")

    print(
        "\n  LIMITATION OF THIS MODEL, stated so the numbers are not misread:\n"
        "  `Martingale` STOPS TRADING when it reaches the ruin step; it does\n"
        "  not simulate losing the account. So every return and drawdown above\n"
        "  is far gentler than the real failure, which is a margin call, not a\n"
        "  polite halt. Read 'blown up: YES' as the finding — the size of the\n"
        "  loss shown next to it is an artefact of the halt.\n"
        "\n  Also: entries here are near-random with symmetric stop and target,\n"
        "  so each completed sequence nets only one base unit. Real EAs tune\n"
        "  for a higher hit rate, which produces a smoother and more seductive\n"
        "  curve than anything above — and identical terminal risk."
    )


if __name__ == "__main__":
    main()
