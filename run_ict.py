#!/usr/bin/env python
"""
Backtest ICT on forex.

    python fetch_stocks.py --forex && python run_ict.py

Tests a mechanical reading of the canonical ICT setup — liquidity sweep,
market structure shift, Fair Value Gap entry, fixed R target, killzones —
across 10 pairs of hourly data.

The headline number is NOT the return. It is ICT's edge over `RandomEntry`,
which runs identical risk management with uninformed entries. Any fixed-R
system produces a characteristic win/loss profile on its own; the comparison
is what separates "the setup sees something" from "the money management
shapes the curve".
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from tradingbot import Costs, load_csv, run
from tradingbot.ict import ICTConfig, ICTStrategy, RandomEntry

DATA = Path(__file__).parent / "data" / "forex_h1"
# Retail spot FX: no commission, ~0.5bp per side on majors.
COSTS = Costs(commission=0.0, slippage=0.00005)
CFG = ICTConfig()


def header(t: str) -> None:
    print(f"\n{'=' * 80}\n{t}\n{'=' * 80}")


def boot(x: np.ndarray, n: int = 20_000) -> tuple[float, float, float]:
    rng = np.random.default_rng(0)
    bs = np.array([rng.choice(x, len(x), replace=True).mean() for _ in range(n)])
    lo, hi = np.percentile(bs, [2.5, 97.5])
    return lo, hi, float((bs > 0).mean())


def verdict(lo: float, hi: float) -> str:
    if lo > 0:
        return "SIGNIFICANTLY POSITIVE"
    if hi < 0:
        return "SIGNIFICANTLY NEGATIVE"
    return "INCONCLUSIVE — CI includes zero"


def main() -> None:
    files = sorted(DATA.glob("*.csv"))
    if not files:
        print("No data. Run: python fetch_stocks.py --forex")
        return
    print(f"{len(files)} pairs, hourly bars, "
          f"{sum(len(load_csv(f)) for f in files):,} bars total")
    print(f"config: sweep->MSS->FVG entry, {CFG.risk_reward}R target, "
          f"killzones UTC {CFG.killzone_hours}")

    # ---------------------------------------------------------------- 1
    header("1. ICT SETUP, PAIR BY PAIR")
    print(f"{'pair':<9}{'bars':>8}{'trades':>8}{'win%':>7}{'expect_bp':>11}"
          f"{'return':>10}{'sharpe':>8}{'max_dd':>9}")
    print("-" * 70)
    ict_rows = []
    for f in files:
        d = load_csv(f)
        s = ICTStrategy(CFG)
        r = run(d, s, costs=COSTS, bar_freq="1h")
        rep = s.report()
        if rep["n_trades"] == 0:
            print(f"{f.stem:<9}{len(d):>8,}{0:>8}   no setups triggered")
            continue
        ret = float(r.stats["total_return"].strip().rstrip("%")) / 100
        ict_rows.append({
            "pair": f.stem, "trades": rep["n_trades"], "win": rep["win_rate"],
            "exp": rep["expectancy_bps"], "ret": ret,
            "sharpe": float(r.stats["sharpe"]),
        })
        print(f"{f.stem:<9}{len(d):>8,}{rep['n_trades']:>8}{rep['win_rate']:>6.1%}"
              f"{rep['expectancy_bps']:>11.2f}{ret:>10.2%}"
              f"{r.stats['sharpe'].strip():>8}{r.stats['max_drawdown'].strip():>9}")

    if not ict_rows:
        print("\nNo trades anywhere — the setup never triggered. Loosen the "
              "config before drawing conclusions.")
        return

    idf = pd.DataFrame(ict_rows)

    # ---------------------------------------------------------------- 2
    header("2. THE CONTROL — random entries, IDENTICAL risk management")
    print("  Same stop logic, same 2R target, same hold cap, same killzones.\n"
          "  Entry frequency matched to ICT's per pair. Averaged over 5 seeds.\n")
    print(f"{'pair':<9}{'ICT ret':>10}{'rand ret':>11}{'ICT win%':>10}"
          f"{'rand win%':>11}{'edge':>9}")
    print("-" * 62)
    edges = []
    for row in ict_rows:
        d = load_csv(DATA / f"{row['pair']}.csv")
        prob = row["trades"] / max(len(d), 1) * 6.0  # killzone is ~6/24 hours
        rand_rets, rand_wins = [], []
        for seed in range(5):
            rs = RandomEntry(CFG, entry_prob=min(prob, 1.0), seed=seed)
            rr = run(d, rs, costs=COSTS, bar_freq="1h")
            rrep = rs.report()
            rand_rets.append(float(rr.stats["total_return"].strip().rstrip("%")) / 100)
            rand_wins.append(rrep.get("win_rate", 0.0))
        mr, mw = float(np.mean(rand_rets)), float(np.mean(rand_wins))
        edge = row["ret"] - mr
        edges.append(edge)
        print(f"{row['pair']:<9}{row['ret']:>10.2%}{mr:>11.2%}"
              f"{row['win']:>10.1%}{mw:>11.1%}{edge:>9.2%}")

    e = np.array(edges)
    lo, hi, p = boot(e)
    header("3. DOES THE ICT SETUP BEAT RANDOM ENTRIES?")
    print(f"  pairs tested          : {len(e)}")
    print(f"  ICT beat random on    : {int((e > 0).sum())}/{len(e)}")
    print(f"  mean edge over random : {e.mean():>8.2%}")
    print(f"  median edge           : {np.median(e):>8.2%}")
    print(f"  95% CI                : [{lo:.2%}, {hi:.2%}]")
    print(f"  P(edge > 0)           : {p:>8.1%}")
    print(f"\n  VERDICT: {verdict(lo, hi)}")

    # ---------------------------------------------------------------- 4
    header("4. DO THE INDIVIDUAL CLAIMS SURVIVE ON THEIR OWN?")
    print("  Turning components off one at a time. If a component matters,\n"
          "  removing it should hurt.\n")
    variants = {
        "full setup": CFG,
        "no FVG requirement": ICTConfig(require_fvg=False),
        "no killzone filter": ICTConfig(killzone_only=False),
        "neither filter": ICTConfig(require_fvg=False, killzone_only=False),
        "1R target": ICTConfig(risk_reward=1.0),
        "3R target": ICTConfig(risk_reward=3.0),
    }
    print(f"{'variant':<22}{'trades':>8}{'win%':>8}{'expect_bp':>11}{'mean ret':>10}")
    print("-" * 59)
    for name, cfg in variants.items():
        tot_tr, wins, exps, rets = 0, [], [], []
        for f in files:
            d = load_csv(f)
            s = ICTStrategy(cfg)
            r = run(d, s, costs=COSTS, bar_freq="1h")
            rep = s.report()
            if rep["n_trades"] == 0:
                continue
            tot_tr += rep["n_trades"]
            wins.append(rep["win_rate"])
            exps.append(rep["expectancy_bps"])
            rets.append(float(r.stats["total_return"].strip().rstrip("%")) / 100)
        if not rets:
            print(f"{name:<22}{0:>8}   no trades")
            continue
        print(f"{name:<22}{tot_tr:>8}{np.mean(wins):>7.1%}"
              f"{np.mean(exps):>11.2f}{np.mean(rets):>10.2%}")

    print(
        "\n  Caveat that limits every number above: this is ONE mechanical\n"
        "  reading of ICT. Real practice adds higher-timeframe bias and\n"
        "  discretion about which liquidity matters. A fair reading of a\n"
        "  negative result is 'the mechanical core does not carry the edge',\n"
        "  not 'every ICT trader is wrong'. But note the converse: if the\n"
        "  edge lives entirely in unstated discretion, it cannot be verified\n"
        "  by anyone, including the person using it."
    )


if __name__ == "__main__":
    main()
