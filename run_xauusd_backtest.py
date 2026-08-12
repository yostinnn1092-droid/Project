#!/usr/bin/env python
"""
Backtest the XAUUSD trend-pullback system.

    python fetch_stocks.py --gold && python run_xauusd_backtest.py

Stage 1 of three. Nothing here justifies live trading; it justifies (or
rules out) paper trading.

    1. BACKTEST     -> catches logic errors. Cannot catch anything real.
    2. PAPER, weeks -> catches stale feeds, restarts, API errors, gaps.
    3. LIVE, small  -> compare real fills against what paper predicted.

The report deliberately leads with the no-trade reasons. A trend-pullback
system should be flat most of the time, and the distribution of *why* it
stayed flat tells you whether the filters are working or simply broken.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

from tradingbot import BuyAndHold, Costs, load_csv, run
from tradingbot.ict import ICTConfig, RandomEntry
from xauusd import BotConfig, Journal, TrendPullbackStrategy

DATA = Path(__file__).parent / "data" / "gold_h1" / "GC.csv"
# COMEX gold via a retail CFD desk: spread commonly 20-35 cents on a ~$3,000
# instrument, i.e. roughly 1bp per side. Verify against YOUR broker before
# reading anything below as meaningful.
COSTS = Costs(commission=0.0, slippage=0.0001)


def header(t: str) -> None:
    print(f"\n{'=' * 78}\n{t}\n{'=' * 78}")


def boot(x: np.ndarray) -> tuple[float, float, float]:
    rng = np.random.default_rng(0)
    bs = np.array([rng.choice(x, len(x), replace=True).mean() for _ in range(20_000)])
    lo, hi = np.percentile(bs, [2.5, 97.5])
    return lo, hi, float((bs > 0).mean())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", type=str, default=None)
    ap.add_argument("--journal", type=str, default="journal")
    ap.add_argument("--risk", type=float, default=None,
                    help="override risk_per_trade_pct")
    args = ap.parse_args()

    cfg = BotConfig.from_json(args.config) if args.config else BotConfig()
    if args.risk is not None:
        cfg.risk.risk_per_trade_pct = args.risk
    cfg.execution.mode = "backtest"

    problems = cfg.validate()
    if problems:
        print("CONFIG INVALID:")
        for p in problems:
            print("  -", p)
        return

    if not DATA.exists():
        print(f"No data at {DATA}. Run: python fetch_stocks.py --gold")
        return

    bars = load_csv(DATA)
    print(f"XAUUSD proxy (COMEX GC front month): {len(bars):,} H1 bars")
    print(f"  {bars['timestamp'].iloc[0]} -> {bars['timestamp'].iloc[-1]}")
    print(f"  price range: {bars['close'].min():.2f} - {bars['close'].max():.2f}")
    print(f"  config fingerprint: {cfg.fingerprint()}")
    print(f"  risk per trade: {cfg.risk.risk_per_trade_pct}% of equity")

    journal = Journal(args.journal, cfg.fingerprint(), echo=False)
    strat = TrendPullbackStrategy(cfg, journal=journal)

    result = run(bars, strat, costs=COSTS, bar_freq="1h")

    # ---------------------------------------------------------------- 1
    header("1. WHY THE BOT DID NOT TRADE (read this first)")
    s = journal.summary()
    print(f"  bars evaluated : {s['total_decisions']:,}")
    for action, n in sorted(s["by_action"].items(), key=lambda kv: -kv[1]):
        print(f"    {action:<14} {n:>7,}")
    print("\n  most common no-trade reasons:")
    for reason, n in s["top_no_trade_reasons"]:
        print(f"    {n:>6,}  {reason}")

    # ---------------------------------------------------------------- 2
    header("2. TRADE STATISTICS (every trade, nothing filtered)")
    perf = strat.performance()
    if perf.get("n_trades", 0) == 0:
        print("  No trades were taken. Either conditions never occurred, or a\n"
              "  filter is too strict. The reasons above say which.")
        return
    for k, v in perf.items():
        if k == "exit_reasons":
            print(f"  {'exit_reasons':<20} {v}")
        elif isinstance(v, float):
            print(f"  {k:<20} {v:>10.3f}")
        else:
            print(f"  {k:<20} {v:>10}")

    # ---------------------------------------------------------------- 3
    header("3. EQUITY PERFORMANCE vs BENCHMARKS")
    bh = run(bars, BuyAndHold(), costs=COSTS, bar_freq="1h")
    rows = {"strategy": result.stats, "buy & hold": bh.stats}
    keys = list(result.stats)
    w = max(len(k) for k in keys) + 2
    print(f"{'':<{w}}" + "".join(f"{n:>16}" for n in rows))
    for k in keys:
        print(f"{k:<{w}}" + "".join(f"{rows[n][k]:>16}" for n in rows))

    # ---------------------------------------------------------------- 4
    header("4. CONTROL: random entries with the SAME risk management")
    print("  Same stop distance, same R targets, same hold cap. Only the entry\n"
          "  differs. If the setup carries no information, this matches it.\n")
    rets = []
    for seed in range(10):
        rs = RandomEntry(
            ICTConfig(killzone_only=False,
                      risk_reward=cfg.risk.take_profit_2_r,
                      max_hold=cfg.risk.max_hold_bars),
            entry_prob=max(perf["n_trades"] / max(len(bars), 1), 1e-4),
            seed=seed)
        rr = run(bars, rs, costs=COSTS, bar_freq="1h")
        rets.append(float(rr.stats["total_return"].strip().rstrip("%")) / 100)
    strat_ret = float(result.stats["total_return"].strip().rstrip("%")) / 100
    rnd = np.array(rets)
    print(f"  strategy            : {strat_ret:>8.2%}")
    print(f"  random (mean of 10) : {rnd.mean():>8.2%}")
    print(f"  random best / worst : {rnd.max():>8.2%} / {rnd.min():.2%}")
    print(f"  edge over random    : {strat_ret - rnd.mean():>8.2%}")
    print(f"  beat random on      : {int((strat_ret > rnd).sum())}/10 seeds")

    header("5. WHAT THIS DOES AND DOES NOT ESTABLISH")
    print("  Establishes : the code runs, respects its risk budget, takes the")
    print("                trades it claims to, and logs every decision.")
    print("  Does NOT    : establish an edge. One instrument, one period, one")
    print("                parameter set, no walk-forward, no cost sensitivity.")
    print()
    print("  Before paper trading, run these against THIS strategy:")
    print("    run_walkforward.py   — does it survive re-tuning through time?")
    print("    run_search.py        — does it beat a no-edge search?")
    print("  Before live, paper trade for weeks and compare fills to forecasts.")
    print()
    print(f"  Full decision log: {s['journal_file']}")


if __name__ == "__main__":
    main()
